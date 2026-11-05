// Package ops runs the engine's apply, prune and wait requests with
// fluxcd/pkg/ssa: writes go to the API server through the impersonating
// client, every read for a wait goes through the shared informer cache.
package ops

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"regexp"
	"sort"
	"strings"
	"time"

	"github.com/fluxcd/cli-utils/pkg/kstatus/polling"
	"github.com/fluxcd/cli-utils/pkg/kstatus/status"
	"github.com/fluxcd/cli-utils/pkg/object"
	"github.com/fluxcd/pkg/ssa"
	ssautils "github.com/fluxcd/pkg/ssa/utils"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	"k8s.io/apimachinery/pkg/api/meta"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/util/wait"
	"sigs.k8s.io/controller-runtime/pkg/client"

	"github.com/akua-dev/akua/packages/cluster-agent/engine/internal/cache"
	"github.com/akua-dev/akua/packages/cluster-agent/engine/internal/protocol"
)

// Ops holds what every request shares: the impersonating client for
// writes, the informer cache for reads and the member-selector policy.
type Ops struct {
	Client client.Client
	Cache  *cache.Cache
	// MemberSelector returns the label selector member informers of an
	// ApplySet use: empty when a subscribed Placement owns its namespace.
	MemberSelector func(applySetID string) string
	// Concurrency of server-side apply requests within one stage.
	Concurrency int
}

func (o *Ops) owner() ssa.Owner { return ssa.Owner{Field: protocol.FieldManager} }

// manager builds a ResourceManager whose status poller reads the cache
// through lease.
func (o *Ops) manager(c client.Client, lease *cache.Lease) *ssa.ResourceManager {
	poller := polling.NewStatusPoller(lease, o.Cache.Mapper(), polling.Options{
		ClusterReaderFactory: lease.ClusterReaderFactory(),
	})
	m := ssa.NewResourceManager(c, poller, o.owner())
	m.SetConcurrency(o.Concurrency)
	return m
}

// DecodeManifests turns the request's manifests into objects and refuses
// any that is not a well-formed member of applySetID.
func DecodeManifests(applySetID string, manifests []json.RawMessage) ([]*unstructured.Unstructured, *protocol.Failure) {
	objects := make([]*unstructured.Unstructured, 0, len(manifests))
	for i, raw := range manifests {
		u := &unstructured.Unstructured{}
		if err := u.UnmarshalJSON(raw); err != nil {
			return nil, &protocol.Failure{Stage: "decode", Reason: "invalid", Message: fmt.Sprintf("manifests[%d]: %v", i, err)}
		}
		if u.GetName() == "" {
			return nil, &protocol.Failure{Stage: "decode", Reason: "invalid", Message: fmt.Sprintf("manifests[%d]: %s has no metadata.name", i, u.GetKind())}
		}
		key := protocol.KeyOf(object.UnstructuredToObjMetadata(u))
		if _, err := protocol.ParseKey(key); err != nil {
			return nil, &protocol.Failure{Stage: "decode", Reason: "invalid", Message: fmt.Sprintf("manifests[%d]: %v", i, err)}
		}
		if u.GetLabels()[protocol.PartOfLabel] != applySetID {
			return nil, &protocol.Failure{
				Stage: "decode", Reason: "invalid", Object: &key,
				Message: fmt.Sprintf("%s does not carry the label %s=%s", ssautils.FmtUnstructured(u), protocol.PartOfLabel, applySetID),
			}
		}
		objects = append(objects, u)
	}
	return objects, nil
}

// Apply is `ResourceManager.ApplyAllStaged` with field manager akua-agent.
func (o *Ops) Apply(ctx context.Context, r *protocol.Apply) protocol.Applied {
	out := protocol.Applied{ID: r.ID}
	objects, failure := DecodeManifests(r.ApplySetID, r.Manifests)
	if failure != nil {
		out.Failure = failure
		return out
	}
	timeout := time.Duration(r.TimeoutSeconds) * time.Second
	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()

	lease := o.Cache.Lease(object.UnstructuredSetToObjMetadataSet(objects), o.MemberSelector(r.ApplySetID))
	defer lease.Release()
	opts := ssa.DefaultApplyOptions()
	opts.ForceSelector = r.ForceSelector
	opts.ExclusionSelector = r.ExclusionSelector
	opts.WaitTimeout = timeout

	changeSet, err := o.manager(o.Client, lease).ApplyAllStaged(ctx, objects, opts)
	if changeSet != nil {
		out.Changes, out.DriftCorrected = Changes(changeSet, r.RevisionChanged)
	}
	if err != nil {
		out.Failure = ApplyFailure(objects, changeSet, err)
	}
	return out
}

// Changes renders a ChangeSet; with an unchanged revision every
// `configured` object is a drift correction.
func Changes(cs *ssa.ChangeSet, revisionChanged bool) ([]protocol.ChangeEntry, []string) {
	changes := make([]protocol.ChangeEntry, 0, len(cs.Entries))
	drift := []string{}
	for _, e := range cs.Entries {
		key := protocol.KeyOf(e.ObjMetadata)
		changes = append(changes, protocol.ChangeEntry{Key: key, Version: e.GroupVersion, Action: string(e.Action)})
		if !revisionChanged && e.Action == ssa.ConfiguredAction {
			drift = append(drift, key)
		}
	}
	return changes, drift
}

const (
	stageDefinitions = "definitions"
	stageClasses     = "classes"
	stageResources   = "resources"
)

// stageOf is ApplyAllStaged's partition (manager_apply.go): cluster
// definitions, then class definitions, then everything else.
func stageOf(u *unstructured.Unstructured) string {
	switch {
	case ssautils.IsClusterDefinition(u):
		return stageDefinitions
	case ssautils.IsClassDefinition(u):
		return stageClasses
	}
	return stageResources
}

// waitFailure maps the untyped errors of ssa's WaitForSet
// (manager_wait.go) to EngineFailure.reason; "" when err is no wait error.
func waitFailure(err error) string {
	switch {
	case strings.HasPrefix(err.Error(), "timeout waiting for"):
		return "timeout"
	case strings.HasPrefix(err.Error(), "failed early due to stalled resources"):
		return "unhealthy"
	}
	return ""
}

// ApplyFailure classifies an ApplyAllStaged error: the stage it stopped
// in, why, and the object it names.
func ApplyFailure(objects []*unstructured.Unstructured, cs *ssa.ChangeSet, err error) *protocol.Failure {
	applied := map[object.ObjMetadata]bool{}
	if cs != nil {
		for _, e := range cs.Entries {
			applied[e.ObjMetadata] = true
		}
	}
	stages := []string{stageDefinitions, stageClasses, stageResources}
	byStage := map[string][]*unstructured.Unstructured{}
	for _, u := range objects {
		byStage[stageOf(u)] = append(byStage[stageOf(u)], u)
	}
	failure := &protocol.Failure{Message: err.Error()}

	if reason := waitFailure(err); reason != "" {
		// A wait runs only after the definitions or classes stage it
		// belongs to was fully applied: the last such stage failed.
		failure.Reason = reason
		failure.Stage = stageDefinitions
		if len(byStage[stageClasses]) > 0 && allApplied(byStage[stageClasses], applied) {
			failure.Stage = stageClasses
		}
		failure.Object = namedObject(objects, err.Error())
		return failure
	}

	failure.Stage = stageResources
	for _, stage := range stages {
		if !allApplied(byStage[stage], applied) {
			failure.Stage = stage
			break
		}
	}
	failure.Reason = reasonOf(err)
	var dryRun interface {
		InvolvedObject() *unstructured.Unstructured
	}
	if errors.As(err, &dryRun) && dryRun.InvolvedObject() != nil {
		key := protocol.KeyOf(object.UnstructuredToObjMetadata(dryRun.InvolvedObject()))
		failure.Object = &key
	} else {
		failure.Object = namedObject(objects, err.Error())
	}
	return failure
}

func allApplied(objects []*unstructured.Unstructured, applied map[object.ObjMetadata]bool) bool {
	for _, u := range objects {
		if !applied[object.UnstructuredToObjMetadata(u)] {
			return false
		}
	}
	return true
}

// namedObject finds the object an ssa error message starts with
// (utils.FmtUnstructured: Kind/namespace/name).
func namedObject(objects []*unstructured.Unstructured, message string) *string {
	best := ""
	var match *unstructured.Unstructured
	for _, u := range objects {
		subject := ssautils.FmtUnstructured(u)
		if (strings.HasPrefix(message, subject+" ") || strings.Contains(message, "["+subject+" ")) && len(subject) > len(best) {
			best, match = subject, u
		}
	}
	if match == nil {
		return nil
	}
	key := protocol.KeyOf(object.UnstructuredToObjMetadata(match))
	return &key
}

var immutablePattern = regexp.MustCompile(`is\simmutable|immutable\sfield`)

// reasonOf maps a Kubernetes or transport error to EngineFailure.reason.
func reasonOf(err error) string {
	switch {
	case errors.Is(err, context.DeadlineExceeded), apierrors.IsTimeout(err), apierrors.IsServerTimeout(err):
		return "timeout"
	case apierrors.IsForbidden(err), apierrors.IsUnauthorized(err):
		return "forbidden"
	case immutablePattern.MatchString(err.Error()):
		return "immutable"
	case apierrors.IsConflict(err), apierrors.IsAlreadyExists(err):
		return "conflict"
	case apierrors.IsInvalid(err), apierrors.IsBadRequest(err), apierrors.IsNotFound(err),
		apierrors.IsMethodNotSupported(err), meta.IsNoMatchError(err):
		return "invalid"
	}
	return "unavailable"
}

func entryObject(e protocol.InventoryEntry) (*unstructured.Unstructured, object.ObjMetadata, error) {
	gvk, id, err := e.GroupVersionKind()
	if err != nil {
		return nil, id, err
	}
	u := &unstructured.Unstructured{}
	u.SetGroupVersionKind(gvk)
	u.SetNamespace(id.Namespace)
	u.SetName(id.Name)
	return u, id, nil
}

// Prune deletes the stale inventory entries the way
// `ResourceManager.DeleteAll` does, one by one in its order so each
// failure keeps its own message. The inventory decides membership, so a
// member that lost its part-of label is still pruned; only the customer's
// exclusion selector skips an object, and a skipped object is neither
// deleted nor a survivor.
func (o *Ops) Prune(ctx context.Context, r *protocol.Prune) protocol.Pruned {
	out := protocol.Pruned{ID: r.ID}
	ctx, cancel := context.WithTimeout(ctx, time.Duration(r.TimeoutSeconds)*time.Second)
	defer cancel()

	entries := map[object.ObjMetadata]protocol.InventoryEntry{}
	objects := make([]*unstructured.Unstructured, 0, len(r.Stale))
	for _, e := range r.Stale {
		u, id, err := entryObject(e)
		if err != nil {
			out.Survivors = append(out.Survivors, protocol.Survivor{Entry: e, Message: err.Error()})
			continue
		}
		entries[id] = e
		objects = append(objects, u)
	}
	sort.Sort(sort.Reverse(ssa.SortableUnstructureds(objects)))

	m := ssa.NewResourceManager(o.Client, nil, o.owner())
	opts := ssa.DeleteOptions{
		PropagationPolicy: metav1.DeletePropagationBackground,
		Exclusions:        r.ExclusionSelector,
	}
	for _, u := range objects {
		entry := entries[object.UnstructuredToObjMetadata(u)]
		if ctx.Err() != nil {
			out.Survivors = append(out.Survivors, protocol.Survivor{Entry: entry, Message: "prune timed out before deleting this object"})
			continue
		}
		cse, err := m.Delete(ctx, u, opts)
		switch {
		case err != nil:
			out.Survivors = append(out.Survivors, protocol.Survivor{Entry: entry, Message: err.Error()})
		case cse != nil && cse.Action == ssa.DeletedAction:
			out.Deleted = append(out.Deleted, entry)
		}
	}
	return out
}

// Wait is `WaitForSetWithContext` then kstatus per member (`current`), or
// ssa's WaitForTermination loop (`terminated`); both read only the cache.
func (o *Ops) Wait(ctx context.Context, r *protocol.Wait) protocol.Waited {
	out := protocol.Waited{ID: r.ID}
	set := make(object.ObjMetadataSet, 0, len(r.Members))
	objects := make([]*unstructured.Unstructured, 0, len(r.Members))
	for _, e := range r.Members {
		u, id, err := entryObject(e)
		if err != nil {
			out.Failure = &protocol.Failure{Stage: "decode", Reason: "invalid", Message: err.Error()}
			return out
		}
		set = append(set, id)
		objects = append(objects, u)
	}
	lease := o.Cache.Lease(set, o.MemberSelector(r.ApplySetID))
	defer lease.Release()
	m := o.manager(o.Client, lease)
	opts := ssa.WaitOptions{
		Interval: time.Duration(r.IntervalSeconds) * time.Second,
		Timeout:  time.Duration(r.TimeoutSeconds) * time.Second,
		FailFast: r.FailFast,
	}

	var err error
	stage := "health"
	if r.Until == "terminated" {
		stage = "prune"
		err = waitTerminated(ctx, lease, objects, opts)
	} else {
		err = m.WaitForSetWithContext(ctx, set, opts)
	}
	out.Health = o.health(ctx, lease, objects)
	if err != nil {
		reason := waitFailure(err)
		switch {
		case reason != "":
		case errors.Is(err, context.DeadlineExceeded):
			reason = "timeout"
		case ctx.Err() != nil:
			reason = "unavailable"
		default:
			reason = reasonOf(err)
		}
		out.Failure = &protocol.Failure{Stage: stage, Reason: reason, Object: namedObject(objects, err.Error()), Message: err.Error()}
		if out.Failure.Object == nil {
			out.Failure.Object = firstNotCurrent(out.Health, r.Until)
		}
	}
	return out
}

// waitTerminated is ssa's WaitForTermination (manager_wait.go) over the
// cache and bounded by ctx: that function polls with its own background
// context, which an engine shutdown could not end.
func waitTerminated(ctx context.Context, reader client.Reader, objects []*unstructured.Unstructured, opts ssa.WaitOptions) error {
	ctx, cancel := context.WithTimeout(ctx, opts.Timeout)
	defer cancel()
	for _, obj := range objects {
		err := wait.PollUntilContextCancel(ctx, opts.Interval, true, func(ctx context.Context) (bool, error) {
			u := obj.DeepCopy()
			err := reader.Get(ctx, client.ObjectKeyFromObject(u), u)
			if apierrors.IsNotFound(err) {
				return true, nil
			}
			return false, err
		})
		if err != nil {
			return fmt.Errorf("%s termination timeout: %w", ssautils.FmtUnstructured(obj), err)
		}
	}
	return nil
}

func firstNotCurrent(health []protocol.ObjectStatus, until string) *string {
	want := string(status.CurrentStatus)
	if until == "terminated" {
		want = string(status.NotFoundStatus)
	}
	for _, h := range health {
		if h.Status != want {
			key := h.Key
			return &key
		}
	}
	return nil
}

// health is kstatus of every member as the cache holds it now.
func (o *Ops) health(ctx context.Context, reader client.Reader, objects []*unstructured.Unstructured) []protocol.ObjectStatus {
	out := make([]protocol.ObjectStatus, 0, len(objects))
	readCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 10*time.Second)
	defer cancel()
	for _, want := range objects {
		key := protocol.KeyOf(object.UnstructuredToObjMetadata(want))
		u := &unstructured.Unstructured{}
		u.SetGroupVersionKind(want.GroupVersionKind())
		err := reader.Get(readCtx, client.ObjectKeyFromObject(want), u)
		switch {
		case apierrors.IsNotFound(err):
			out = append(out, protocol.ObjectStatus{Key: key, Status: string(status.NotFoundStatus), Message: "Resource not found"})
		case err != nil:
			out = append(out, protocol.ObjectStatus{Key: key, Status: string(status.UnknownStatus), Message: err.Error()})
		default:
			result, err := status.Compute(u)
			if err != nil {
				out = append(out, protocol.ObjectStatus{Key: key, Status: string(status.UnknownStatus), Message: err.Error()})
				continue
			}
			out = append(out, protocol.ObjectStatus{Key: key, Status: string(result.Status), Message: result.Message})
		}
	}
	return out
}
