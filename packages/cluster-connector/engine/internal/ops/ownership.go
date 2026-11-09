package ops

import (
	"context"
	"fmt"
	"sync"

	"github.com/fluxcd/cli-utils/pkg/object"
	ssautils "github.com/fluxcd/pkg/ssa/utils"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	"k8s.io/apimachinery/pkg/api/meta"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/types"
	"sigs.k8s.io/controller-runtime/pkg/client"

	"github.com/akua-dev/akua/packages/cluster-agent/engine/internal/protocol"
)

// An apply adopts only objects nobody owns and the ApplySet's own members.
// fluxcd/pkg/ssa always sends `force=true`, which would take any field from
// any other manager, so the engine reads each object first and sends the
// patch without force unless taking the object over is allowed:
//
//   - absent object: created.
//   - member of this ApplySet: forced, so drift edits made by others are
//     corrected.
//   - no ApplySet label: adopted without force; a field another manager owns
//     with a different value fails as `conflict` instead of being overwritten.
//   - member of another ApplySet: `applyset-conflict`, nothing is written.
//
// Taking over is allowed for the whole request (`takeOwnership`, the
// updater's adoption of its Helm-installed bundle) or for one object that
// carries the force selector (`akua.dev/force=enabled`), the same opt-in
// that already allows recreating it on immutable-field changes.

// ownership is what the engine found on the cluster for one desired object.
type ownership struct {
	// force: the apply may take fields from other managers.
	force bool
	// other: the ApplySet that owns the object when it is not this one.
	other string
}

// ownershipOf classifies a desired object against its live copy (nil: absent).
func ownershipOf(r *protocol.Apply, desired, live *unstructured.Unstructured) ownership {
	allowed := r.TakeOwnership ||
		ssautils.AnyInMetadata(desired, r.ForceSelector) ||
		(live != nil && ssautils.AnyInMetadata(live, r.ForceSelector))
	if live == nil {
		return ownership{force: true}
	}
	owner := live.GetLabels()[protocol.PartOfLabel]
	switch {
	case owner == r.ApplySetID:
		return ownership{force: true}
	case owner == "":
		return ownership{force: allowed}
	}
	return ownership{force: allowed, other: owner}
}

// checkOwnership reads every desired object and returns the per-object apply
// mode, or the first (in manifest order) failure. Nothing is written.
func (o *Ops) checkOwnership(ctx context.Context, r *protocol.Apply, objects []*unstructured.Unstructured) (map[object.ObjMetadata]bool, *protocol.Failure) {
	live := make([]*unstructured.Unstructured, len(objects))
	errs := make([]error, len(objects))
	workers := o.Concurrency
	if workers < 1 {
		workers = 1
	}
	slots := make(chan struct{}, workers)
	var wg sync.WaitGroup
	for i, desired := range objects {
		wg.Add(1)
		slots <- struct{}{}
		go func() {
			defer wg.Done()
			defer func() { <-slots }()
			existing := &unstructured.Unstructured{}
			existing.SetGroupVersionKind(desired.GroupVersionKind())
			err := o.Client.Get(ctx, client.ObjectKeyFromObject(desired), existing)
			switch {
			case err == nil:
				live[i] = existing
			case apierrors.IsNotFound(err), meta.IsNoMatchError(err):
				// Absent, or its CRD arrives earlier in this same request.
			default:
				errs[i] = err
			}
		}()
	}
	wg.Wait()

	force := make(map[object.ObjMetadata]bool, len(objects))
	for i, desired := range objects {
		key := protocol.KeyOf(object.UnstructuredToObjMetadata(desired))
		if errs[i] != nil {
			return nil, &protocol.Failure{
				Stage: stageOf(desired), Reason: reasonOf(errs[i]), Object: &key,
				Message: fmt.Sprintf("%s: reading the object before applying it: %v", ssautils.FmtUnstructured(desired), errs[i]),
			}
		}
		found := ownershipOf(r, desired, live[i])
		if found.other != "" && !found.force {
			return nil, &protocol.Failure{
				Stage: stageOf(desired), Reason: "applyset-conflict", Object: &key,
				Message: fmt.Sprintf("%s belongs to ApplySet %s, not this Placement's %s; remove it or label it %s to take it over",
					ssautils.FmtUnstructured(desired), found.other, r.ApplySetID, forceLabel(r.ForceSelector)),
			}
		}
		force[object.UnstructuredToObjMetadata(desired)] = found.force
	}
	return force, nil
}

func forceLabel(selector map[string]string) string {
	for k, v := range selector {
		return k + "=" + v
	}
	return "the force selector"
}

// ownershipClient sends server-side apply patches without force for the
// objects `force` marks false; every other call passes through.
type ownershipClient struct {
	client.Client
	force map[object.ObjMetadata]bool
}

func (c ownershipClient) Patch(ctx context.Context, obj client.Object, patch client.Patch, opts ...client.PatchOption) error {
	if patch.Type() == types.ApplyPatchType {
		if u, ok := obj.(*unstructured.Unstructured); ok && !c.force[object.UnstructuredToObjMetadata(u)] {
			kept := make([]client.PatchOption, 0, len(opts))
			for _, opt := range opts {
				if opt != client.PatchOption(client.ForceOwnership) {
					kept = append(kept, opt)
				}
			}
			opts = kept
		}
	}
	return c.Client.Patch(ctx, obj, patch, opts...)
}
