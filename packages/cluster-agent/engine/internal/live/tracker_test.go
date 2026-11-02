package live

import (
	"context"
	"reflect"
	"sync"
	"testing"
	"time"

	"k8s.io/apimachinery/pkg/api/meta"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/runtime/schema"
	dynamicfake "k8s.io/client-go/dynamic/fake"
	clientgoscheme "k8s.io/client-go/kubernetes/scheme"
	"sigs.k8s.io/controller-runtime/pkg/client/fake"

	"github.com/akua-dev/akua/packages/cluster-agent/engine/internal/cache"
	"github.com/akua-dev/akua/packages/cluster-agent/engine/internal/protocol"
)

const applySet = "applyset-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA-v1"

type recorder struct {
	mu   sync.Mutex
	msgs []any
}

func (r *recorder) emit(msg any) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.msgs = append(r.msgs, msg)
}

func (r *recorder) waitFor(t *testing.T, what string, match func(any) bool) any {
	t.Helper()
	deadline := time.Now().Add(10 * time.Second)
	for time.Now().Before(deadline) {
		r.mu.Lock()
		for _, m := range r.msgs {
			if match(m) {
				r.mu.Unlock()
				return m
			}
		}
		r.mu.Unlock()
		time.Sleep(10 * time.Millisecond)
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	t.Fatalf("no %s among %d messages: %+v", what, len(r.msgs), r.msgs)
	return nil
}

func (r *recorder) nodes() map[string]protocol.ResourceNode {
	r.mu.Lock()
	defer r.mu.Unlock()
	out := map[string]protocol.ResourceNode{}
	for _, m := range r.msgs {
		switch v := m.(type) {
		case protocol.Node:
			out[v.Node.Key] = v.Node
		case protocol.Removed:
			delete(out, v.Key)
		}
	}
	return out
}

func yamlObject(t *testing.T, manifest string) *unstructured.Unstructured {
	t.Helper()
	return parse(t, manifest)
}

func TestTrackerBuildsTheTree(t *testing.T) {
	objects := []*unstructured.Unstructured{
		yamlObject(t, `
apiVersion: apps/v1
kind: Deployment
metadata: {name: web, namespace: shop, uid: d1, generation: 1, labels: {applyset.kubernetes.io/part-of: `+applySet+`}}
spec: {replicas: 1, selector: {matchLabels: {app: web}}}
status: {observedGeneration: 1, replicas: 1, updatedReplicas: 1, readyReplicas: 0, availableReplicas: 0}
`),
		yamlObject(t, `
apiVersion: apps/v1
kind: ReplicaSet
metadata: {name: web-1, namespace: shop, uid: r1, labels: {app: web}, ownerReferences: [{apiVersion: apps/v1, kind: Deployment, name: web, uid: d1}]}
spec: {replicas: 1, selector: {matchLabels: {app: web}}}
status: {replicas: 1}
`),
		yamlObject(t, `
apiVersion: v1
kind: Pod
metadata: {name: web-1-a, namespace: shop, uid: p1, labels: {app: web}, ownerReferences: [{apiVersion: apps/v1, kind: ReplicaSet, name: web-1, uid: r1}]}
spec: {containers: [{name: app, image: a}]}
status:
  phase: Running
  containerStatuses:
  - {name: app, ready: false, restartCount: 3, state: {waiting: {reason: CrashLoopBackOff, message: back-off}}}
`),
		yamlObject(t, `
apiVersion: v1
kind: Pod
metadata: {name: stranger, namespace: shop, uid: p2}
spec: {containers: [{name: app, image: a}]}
status: {phase: Running}
`),
		yamlObject(t, `
apiVersion: v1
kind: PersistentVolumeClaim
metadata: {name: data, namespace: shop, uid: c1, labels: {applyset.kubernetes.io/part-of: `+applySet+`}}
spec: {volumeName: pv-1}
status: {phase: Bound}
`),
		yamlObject(t, `
apiVersion: v1
kind: Event
metadata: {name: web-1-a.1, namespace: shop}
type: Warning
reason: BackOff
message: Back-off restarting failed container
count: 4
firstTimestamp: "2026-01-01T00:00:00Z"
lastTimestamp: "2026-01-01T00:03:00Z"
involvedObject: {apiVersion: v1, kind: Pod, name: web-1-a, namespace: shop}
`),
	}
	runtimeObjects := make([]runtime.Object, 0, len(objects))
	for _, u := range objects {
		runtimeObjects = append(runtimeObjects, u)
	}
	dyn := dynamicfake.NewSimpleDynamicClientWithCustomListKinds(runtime.NewScheme(), map[schema.GroupVersionResource]string{
		{Group: "apps", Version: "v1", Resource: "deployments"}: "DeploymentList",
		{Group: "apps", Version: "v1", Resource: "replicasets"}: "ReplicaSetList",
		{Group: "batch", Version: "v1", Resource: "jobs"}:       "JobList",
		{Version: "v1", Resource: "pods"}:                       "PodList",
		{Version: "v1", Resource: "persistentvolumeclaims"}:     "PersistentVolumeClaimList",
		{Version: "v1", Resource: "events"}:                     "EventList",
	}, runtimeObjects...)
	mapper := meta.NewDefaultRESTMapper([]schema.GroupVersion{{Version: "v1"}, {Group: "apps", Version: "v1"}, {Group: "batch", Version: "v1"}})
	for _, gvk := range []schema.GroupVersionKind{
		{Group: "apps", Version: "v1", Kind: "Deployment"},
		{Group: "apps", Version: "v1", Kind: "ReplicaSet"},
		{Group: "batch", Version: "v1", Kind: "Job"},
		{Version: "v1", Kind: "Pod"},
		{Version: "v1", Kind: "PersistentVolumeClaim"},
		{Version: "v1", Kind: "Event"},
	} {
		mapper.Add(gvk, meta.RESTScopeNamespace)
	}
	mapper.Add(schema.GroupVersionKind{Version: "v1", Kind: "PersistentVolume"}, meta.RESTScopeRoot)

	pv := yamlObject(t, `
apiVersion: v1
kind: PersistentVolume
metadata: {name: pv-1, uid: v1}
spec: {capacity: {storage: 1Gi}, claimRef: {name: data, namespace: shop}}
status: {phase: Bound}
`)
	direct := fake.NewClientBuilder().WithScheme(clientgoscheme.Scheme).WithObjects(pv).Build()

	c := cache.New(dyn, mapper, cache.Options{})
	defer c.Stop()
	rec := &recorder{}
	tracker := NewTracker(c, direct, rec.emit, Options{MaxWatchedObjects: 2000, Debounce: 10 * time.Millisecond, Now: func() int64 { return 42 }})
	defer tracker.Stop()

	placement := protocol.WatchedPlacement{
		PlacementID: "plc_web", Generation: 1, ApplySetID: applySet, Namespaces: []string{"shop"},
		Inventory: []protocol.InventoryEntry{
			{Key: "shop_web_apps_Deployment", Version: "v1"},
			{Key: "shop_data__PersistentVolumeClaim", Version: "v1"},
		},
	}
	if n := tracker.Subscribe([]protocol.WatchedPlacement{placement}); n != 2 {
		t.Errorf("watched = %d", n)
	}
	if got := tracker.MemberSelector(applySet); got != protocol.PartOfLabel+"="+applySet {
		t.Errorf("member selector = %q", got)
	}
	rec.waitFor(t, "synced", func(m any) bool { return m == protocol.Synced{PlacementID: "plc_web"} })
	rec.waitFor(t, "pod node", func(m any) bool { n, ok := m.(protocol.Node); return ok && n.Node.Key == "shop_web-1-a__Pod" })

	nodes := rec.nodes()
	keys := map[string][]string{}
	for k, n := range nodes {
		keys[k] = n.Parents
	}
	want := map[string][]string{
		"shop_web_apps_Deployment":         nil,
		"shop_web-1_apps_ReplicaSet":       {"shop_web_apps_Deployment"},
		"shop_web-1-a__Pod":                {"shop_web-1_apps_ReplicaSet"},
		"shop_data__PersistentVolumeClaim": nil,
		"_pv-1__PersistentVolume":          {"shop_data__PersistentVolumeClaim"},
	}
	if !reflect.DeepEqual(keys, want) {
		t.Errorf("tree = %v, want %v", keys, want)
	}
	pod := nodes["shop_web-1-a__Pod"]
	if pod.Member || pod.UID != "p1" || pod.Version != "v1" || !reflect.DeepEqual(pod.Reasons, []string{"CrashLoopBackOff"}) || len(pod.Containers) != 1 || pod.ObservedAt != 42 {
		t.Errorf("pod node = %+v", pod)
	}
	if d := nodes["shop_web_apps_Deployment"]; !d.Member || d.Status != "InProgress" {
		t.Errorf("deployment node = %+v", d)
	}
	warning := rec.waitFor(t, "warning", func(m any) bool { _, ok := m.(protocol.Warning); return ok }).(protocol.Warning)
	if warning.Event != (protocol.WarningEvent{Involved: "shop_web-1-a__Pod", Reason: "BackOff", Message: "Back-off restarting failed container", Count: 4, FirstSeen: 1767225600000, LastSeen: 1767225780000}) {
		t.Errorf("warning = %+v", warning.Event)
	}

	// A deleted child is removed from the tree.
	if err := dyn.Resource(schema.GroupVersionResource{Version: "v1", Resource: "pods"}).Namespace("shop").Delete(context.Background(), "web-1-a", metav1.DeleteOptions{}); err != nil {
		t.Fatal(err)
	}
	rec.waitFor(t, "removed pod", func(m any) bool { return m == protocol.Removed{PlacementID: "plc_web", Key: "shop_web-1-a__Pod"} })

	// A deleted member is removed too (prune between reconciles).
	if err := dyn.Resource(schema.GroupVersionResource{Version: "v1", Resource: "persistentvolumeclaims"}).Namespace("shop").Delete(context.Background(), "data", metav1.DeleteOptions{}); err != nil {
		t.Fatal(err)
	}
	rec.waitFor(t, "removed member", func(m any) bool {
		return m == protocol.Removed{PlacementID: "plc_web", Key: "shop_data__PersistentVolumeClaim"}
	})
	rec.waitFor(t, "removed volume", func(m any) bool { return m == protocol.Removed{PlacementID: "plc_web", Key: "_pv-1__PersistentVolume"} })

	// The same subscription again changes nothing and does not re-sync.
	before := len(rec.msgs)
	tracker.Subscribe([]protocol.WatchedPlacement{placement})
	time.Sleep(100 * time.Millisecond)
	rec.mu.Lock()
	after := len(rec.msgs)
	rec.mu.Unlock()
	if after != before {
		t.Errorf("an unchanged subscribe emitted %d messages", after-before)
	}

	// An empty subscription stops every informer.
	tracker.Subscribe(nil)
	if n := c.Informers(); n != 0 {
		t.Errorf("informers after unsubscribing = %d", n)
	}
}

func TestTrackerOverloadsPastTheSafetyNet(t *testing.T) {
	dyn := dynamicfake.NewSimpleDynamicClient(runtime.NewScheme())
	c := cache.New(dyn, meta.NewDefaultRESTMapper(nil), cache.Options{})
	defer c.Stop()
	rec := &recorder{}
	tracker := NewTracker(c, nil, rec.emit, Options{MaxWatchedObjects: 1})
	inventory := []protocol.InventoryEntry{{Key: "ns_a__ConfigMap", Version: "v1"}, {Key: "ns_b__ConfigMap", Version: "v1"}}
	tracker.Subscribe([]protocol.WatchedPlacement{{PlacementID: "plc_a", Generation: 1, ApplySetID: applySet, Namespaces: []string{}, Inventory: inventory}})
	rec.waitFor(t, "overloaded", func(m any) bool { return m == protocol.Overloaded{WatchedObjects: 2} })
	if c.Informers() != 0 {
		t.Errorf("an overloaded engine started informers")
	}
}
