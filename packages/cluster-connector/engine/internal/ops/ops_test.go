package ops

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"reflect"
	"testing"

	"github.com/fluxcd/cli-utils/pkg/object"
	"github.com/fluxcd/pkg/ssa"
	ssaerrors "github.com/fluxcd/pkg/ssa/errors"
	corev1 "k8s.io/api/core/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	"k8s.io/apimachinery/pkg/api/meta"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/runtime/schema"
	dynamicfake "k8s.io/client-go/dynamic/fake"
	clientgoscheme "k8s.io/client-go/kubernetes/scheme"
	"sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/controller-runtime/pkg/client/fake"
	"sigs.k8s.io/controller-runtime/pkg/client/interceptor"

	"github.com/akua-dev/akua/packages/cluster-agent/engine/internal/cache"
	"github.com/akua-dev/akua/packages/cluster-agent/engine/internal/protocol"
)

const applySet = "applyset-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA-v1"

func manifest(apiVersion, kind, ns, name string, labelled bool) *unstructured.Unstructured {
	u := &unstructured.Unstructured{}
	u.SetAPIVersion(apiVersion)
	u.SetKind(kind)
	u.SetNamespace(ns)
	u.SetName(name)
	if labelled {
		u.SetLabels(map[string]string{protocol.PartOfLabel: applySet})
	}
	return u
}

func raw(t *testing.T, objects ...*unstructured.Unstructured) []json.RawMessage {
	t.Helper()
	out := make([]json.RawMessage, 0, len(objects))
	for _, u := range objects {
		b, err := u.MarshalJSON()
		if err != nil {
			t.Fatal(err)
		}
		out = append(out, b)
	}
	return out
}

func TestDecodeManifestsRefusesNonMembers(t *testing.T) {
	_, failure := DecodeManifests(applySet, raw(t,
		manifest("v1", "ConfigMap", "shop", "ok", true),
		manifest("v1", "ConfigMap", "shop", "stray", false),
	))
	if failure == nil || failure.Stage != "decode" || failure.Reason != "invalid" || failure.Object == nil || *failure.Object != "shop_stray__ConfigMap" {
		t.Fatalf("failure = %+v", failure)
	}
	objects, failure := DecodeManifests(applySet, raw(t, manifest("v1", "Namespace", "", "shop", true)))
	if failure != nil || len(objects) != 1 {
		t.Fatalf("labelled manifest refused: %+v", failure)
	}
	if _, failure := DecodeManifests(applySet, []json.RawMessage{json.RawMessage(`{"kind":"ConfigMap"}`)}); failure == nil {
		t.Error("manifest without apiVersion and name accepted")
	}
}

func TestChangesMarkDriftOnlyForAnUnchangedRevision(t *testing.T) {
	cs := ssa.NewChangeSet()
	id := object.ObjMetadata{Namespace: "shop", Name: "web", GroupKind: schema.GroupKind{Group: "apps", Kind: "Deployment"}}
	cs.Add(ssa.ChangeSetEntry{ObjMetadata: id, GroupVersion: "v1", Action: ssa.ConfiguredAction})
	cs.Add(ssa.ChangeSetEntry{ObjMetadata: object.ObjMetadata{Name: "shop", GroupKind: schema.GroupKind{Kind: "Namespace"}}, GroupVersion: "v1", Action: ssa.UnchangedAction})

	changes, drift := Changes(cs, false)
	want := []protocol.ChangeEntry{
		{Key: "shop_web_apps_Deployment", Version: "v1", Action: "configured"},
		{Key: "_shop__Namespace", Version: "v1", Action: "unchanged"},
	}
	if !reflect.DeepEqual(changes, want) || !reflect.DeepEqual(drift, []string{"shop_web_apps_Deployment"}) {
		t.Errorf("changes %+v drift %v", changes, drift)
	}
	if _, drift := Changes(cs, true); len(drift) != 0 {
		t.Errorf("a new revision reported drift %v", drift)
	}
}

func TestApplyFailureNamesStageReasonAndObject(t *testing.T) {
	ns := manifest("v1", "Namespace", "", "shop", true)
	crd := manifest("apiextensions.k8s.io/v1", "CustomResourceDefinition", "", "widgets.example.com", true)
	class := manifest("storage.k8s.io/v1", "StorageClass", "", "fast", true)
	deploy := manifest("apps/v1", "Deployment", "shop", "web", true)
	objects := []*unstructured.Unstructured{ns, crd, class, deploy}
	gr := schema.GroupResource{Group: "apps", Resource: "deployments"}

	appliedDefinitions := ssa.NewChangeSet()
	for _, u := range []*unstructured.Unstructured{ns, crd} {
		appliedDefinitions.Add(ssa.ChangeSetEntry{ObjMetadata: object.UnstructuredToObjMetadata(u), GroupVersion: "v1", Action: ssa.CreatedAction})
	}
	appliedClasses := ssa.NewChangeSet()
	appliedClasses.Append(appliedDefinitions.Entries)
	appliedClasses.Add(ssa.ChangeSetEntry{ObjMetadata: object.UnstructuredToObjMetadata(class), GroupVersion: "v1", Action: ssa.CreatedAction})

	cases := []struct {
		name string
		cs   *ssa.ChangeSet
		err  error
		want protocol.Failure
	}{
		{
			"immutable dry run",
			appliedClasses,
			ssaerrors.NewDryRunErr(apierrors.NewInvalid(schema.GroupKind{Group: "apps", Kind: "Deployment"}, "web", nil), deploy),
			protocol.Failure{Stage: "resources", Reason: "invalid", Object: ptr("shop_web_apps_Deployment")},
		},
		{
			"field is immutable",
			appliedClasses,
			ssaerrors.NewDryRunErr(errors.New(`Deployment.apps "web" is invalid: spec.selector: Invalid value: field is immutable`), deploy),
			protocol.Failure{Stage: "resources", Reason: "immutable", Object: ptr("shop_web_apps_Deployment")},
		},
		{
			"another manager owns a field",
			appliedClasses,
			ssaerrors.NewDryRunErr(apierrors.NewConflict(gr, "web", errors.New(`Apply failed with 1 conflict: conflict with "helm": .spec.replicas`)), deploy),
			protocol.Failure{Stage: "resources", Reason: "conflict", Object: ptr("shop_web_apps_Deployment")},
		},
		{
			"forbidden apply",
			appliedClasses,
			fmt.Errorf("%s apply failed: %w", "Deployment/shop/web", apierrors.NewForbidden(gr, "web", errors.New("denied"))),
			protocol.Failure{Stage: "resources", Reason: "forbidden", Object: ptr("shop_web_apps_Deployment")},
		},
		{
			"definitions wait timeout",
			appliedDefinitions,
			errors.New("timeout waiting for: [CustomResourceDefinition/widgets.example.com status: 'InProgress']"),
			protocol.Failure{Stage: "definitions", Reason: "timeout", Object: ptr("_widgets.example.com_apiextensions.k8s.io_CustomResourceDefinition")},
		},
		{
			"classes stalled",
			appliedClasses,
			errors.New("failed early due to stalled resources: [StorageClass/fast status: 'Failed']"),
			protocol.Failure{Stage: "classes", Reason: "unhealthy", Object: ptr("_fast_storage.k8s.io_StorageClass")},
		},
		{
			"definitions apply unavailable",
			ssa.NewChangeSet(),
			errors.New("Namespace/shop apply failed: connection refused"),
			protocol.Failure{Stage: "definitions", Reason: "unavailable", Object: ptr("_shop__Namespace")},
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := ApplyFailure(objects, tc.cs, tc.err)
			got.Message = ""
			if got.Stage != tc.want.Stage || got.Reason != tc.want.Reason || !reflect.DeepEqual(got.Object, tc.want.Object) {
				t.Errorf("got %+v (object %v), want %+v (object %v)", got, deref(got.Object), tc.want, deref(tc.want.Object))
			}
		})
	}
}

func ptr(s string) *string { return &s }

func deref(s *string) string {
	if s == nil {
		return "<nil>"
	}
	return *s
}

func TestPruneDeletesTheInventoryAndKeepsFailures(t *testing.T) {
	labelled := manifest("v1", "ConfigMap", "shop", "old", true)
	unlabelled := manifest("v1", "ConfigMap", "shop", "adopted", false)
	excluded := manifest("v1", "ConfigMap", "shop", "kept", true)
	excluded.SetAnnotations(map[string]string{"akua.dev/prune": "disabled"})
	locked := manifest("v1", "Secret", "shop", "locked", true)
	c := fake.NewClientBuilder().
		WithScheme(clientgoscheme.Scheme).
		WithObjects(labelled, unlabelled, excluded, locked).
		WithInterceptorFuncs(interceptor.Funcs{
			Delete: func(ctx context.Context, c client.WithWatch, obj client.Object, opts ...client.DeleteOption) error {
				if obj.GetName() == "locked" {
					return apierrors.NewForbidden(schema.GroupResource{Resource: "secrets"}, "locked", errors.New("no"))
				}
				return c.Delete(ctx, obj, opts...)
			},
		}).
		Build()
	o := &Ops{Client: c}
	entry := func(kind, name string) protocol.InventoryEntry {
		return protocol.InventoryEntry{Key: "shop_" + name + "__" + kind, Version: "v1"}
	}
	got := o.Prune(context.Background(), &protocol.Prune{
		ID: 1, ApplySetID: applySet, TimeoutSeconds: 30,
		Stale: []protocol.InventoryEntry{
			entry("ConfigMap", "old"), entry("ConfigMap", "adopted"), entry("ConfigMap", "kept"),
			entry("Secret", "locked"), entry("ConfigMap", "gone"),
		},
		ExclusionSelector: map[string]string{"akua.dev/prune": "disabled"},
	})
	deleted := map[string]bool{}
	for _, e := range got.Deleted {
		deleted[e.Key] = true
	}
	// The inventory wins: a member that lost its part-of label is pruned too.
	if !reflect.DeepEqual(deleted, map[string]bool{"shop_old__ConfigMap": true, "shop_adopted__ConfigMap": true, "shop_gone__ConfigMap": true}) {
		t.Errorf("deleted = %v", got.Deleted)
	}
	if len(got.Survivors) != 1 || got.Survivors[0].Entry.Key != "shop_locked__Secret" {
		t.Errorf("survivors = %+v", got.Survivors)
	}
	remaining := &unstructured.UnstructuredList{}
	remaining.SetGroupVersionKind(schema.GroupVersionKind{Version: "v1", Kind: "ConfigMapList"})
	if err := c.List(context.Background(), remaining); err != nil {
		t.Fatal(err)
	}
	if len(remaining.Items) != 1 || remaining.Items[0].GetName() != "kept" {
		t.Errorf("remaining ConfigMaps = %v, want only the excluded one", remaining.Items)
	}
}

func TestWaitReadsTheCache(t *testing.T) {
	ready := &corev1.Pod{
		TypeMeta:   metav1.TypeMeta{APIVersion: "v1", Kind: "Pod"},
		ObjectMeta: metav1.ObjectMeta{Namespace: "shop", Name: "ready", Labels: map[string]string{protocol.PartOfLabel: applySet}},
		Status: corev1.PodStatus{Phase: corev1.PodRunning, Conditions: []corev1.PodCondition{
			{Type: corev1.PodReady, Status: corev1.ConditionTrue},
		}},
	}
	content, err := runtime.DefaultUnstructuredConverter.ToUnstructured(ready)
	if err != nil {
		t.Fatal(err)
	}
	scheme := runtime.NewScheme()
	dyn := dynamicfake.NewSimpleDynamicClientWithCustomListKinds(scheme,
		map[schema.GroupVersionResource]string{{Version: "v1", Resource: "pods"}: "PodList"},
		&unstructured.Unstructured{Object: content})
	mapper := meta.NewDefaultRESTMapper([]schema.GroupVersion{{Version: "v1"}})
	mapper.Add(schema.GroupVersionKind{Version: "v1", Kind: "Pod"}, meta.RESTScopeNamespace)
	c := cache.New(dyn, mapper, cache.Options{})
	defer c.Stop()
	o := &Ops{
		Client:         fake.NewClientBuilder().Build(),
		Cache:          c,
		MemberSelector: func(string) string { return protocol.PartOfLabel + "=" + applySet },
	}

	current := o.Wait(context.Background(), &protocol.Wait{
		ID: 2, ApplySetID: applySet, Until: "current", IntervalSeconds: 1, TimeoutSeconds: 30,
		Members: []protocol.InventoryEntry{{Key: "shop_ready__Pod", Version: "v1"}},
	})
	if current.Failure != nil || len(current.Health) != 1 || current.Health[0].Status != "Current" {
		t.Errorf("current = %+v (%+v)", current, current.Failure)
	}

	terminated := o.Wait(context.Background(), &protocol.Wait{
		ID: 3, ApplySetID: applySet, Until: "terminated", IntervalSeconds: 1, TimeoutSeconds: 30,
		Members: []protocol.InventoryEntry{{Key: "shop_gone__Pod", Version: "v1"}},
	})
	if terminated.Failure != nil || terminated.Health[0].Status != "NotFound" {
		t.Errorf("terminated = %+v (%+v)", terminated, terminated.Failure)
	}
	if c.Informers() != 0 {
		t.Errorf("informers left after the waits: %d", c.Informers())
	}
}
