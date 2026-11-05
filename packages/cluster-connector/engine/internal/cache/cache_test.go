package cache

import (
	"context"
	"sync"
	"testing"
	"time"

	"github.com/fluxcd/cli-utils/pkg/kstatus/polling/event"
	"github.com/fluxcd/cli-utils/pkg/kstatus/status"
	"github.com/fluxcd/cli-utils/pkg/kstatus/watcher"
	"github.com/fluxcd/cli-utils/pkg/object"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	"k8s.io/apimachinery/pkg/api/meta"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/runtime/schema"
	"k8s.io/apimachinery/pkg/types"
	dynamicfake "k8s.io/client-go/dynamic/fake"
	clienttesting "k8s.io/client-go/testing"
	"sigs.k8s.io/controller-runtime/pkg/client"
)

const selector = "applyset.kubernetes.io/part-of=set"

var (
	configMapGVK  = schema.GroupVersionKind{Version: "v1", Kind: "ConfigMap"}
	secretGVK     = schema.GroupVersionKind{Version: "v1", Kind: "Secret"}
	deploymentGVK = schema.GroupVersionKind{Group: "apps", Version: "v1", Kind: "Deployment"}
	namespaceGVK  = schema.GroupVersionKind{Version: "v1", Kind: "Namespace"}
)

func obj(gvk schema.GroupVersionKind, ns, name string, labels map[string]string, extra map[string]any) *unstructured.Unstructured {
	u := &unstructured.Unstructured{Object: map[string]any{}}
	for k, v := range extra {
		u.Object[k] = v
	}
	u.SetGroupVersionKind(gvk)
	u.SetNamespace(ns)
	u.SetName(name)
	u.SetLabels(labels)
	u.SetUID(types.UID("uid-" + name))
	return u
}

type fixture struct {
	cache *Cache
	mu    sync.Mutex
	lists []string // "<resource>/<namespace>?<labelSelector>"
}

func (f *fixture) listCalls() []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]string(nil), f.lists...)
}

func newFixture(t *testing.T, objects ...runtime.Object) *fixture {
	t.Helper()
	scheme := runtime.NewScheme()
	scheme.AddKnownTypes(metav1.SchemeGroupVersion, &metav1.Status{})
	client := dynamicfake.NewSimpleDynamicClientWithCustomListKinds(scheme, map[schema.GroupVersionResource]string{
		{Version: "v1", Resource: "configmaps"}:                 "ConfigMapList",
		{Version: "v1", Resource: "secrets"}:                    "SecretList",
		{Version: "v1", Resource: "namespaces"}:                 "NamespaceList",
		{Group: "apps", Version: "v1", Resource: "deployments"}: "DeploymentList",
		{Group: "apps", Version: "v1", Resource: "replicasets"}: "ReplicaSetList",
		{Version: "v1", Resource: "pods"}:                       "PodList",
	}, objects...)
	f := &fixture{}
	client.PrependReactor("list", "*", func(a clienttesting.Action) (bool, runtime.Object, error) {
		f.mu.Lock()
		defer f.mu.Unlock()
		f.lists = append(f.lists, a.GetResource().Resource+"/"+a.GetNamespace()+"?"+a.(clienttesting.ListAction).GetListRestrictions().Labels.String())
		return false, nil, nil
	})
	mapper := meta.NewDefaultRESTMapper([]schema.GroupVersion{{Version: "v1"}, {Group: "apps", Version: "v1"}})
	mapper.Add(configMapGVK, meta.RESTScopeNamespace)
	mapper.Add(secretGVK, meta.RESTScopeNamespace)
	mapper.Add(deploymentGVK, meta.RESTScopeNamespace)
	mapper.Add(schema.GroupVersionKind{Group: "apps", Version: "v1", Kind: "ReplicaSet"}, meta.RESTScopeNamespace)
	mapper.Add(schema.GroupVersionKind{Version: "v1", Kind: "Pod"}, meta.RESTScopeNamespace)
	mapper.Add(namespaceGVK, meta.RESTScopeRoot)
	f.cache = New(client, mapper, Options{})
	t.Cleanup(f.cache.Stop)
	return f
}

func TestStripRemovesExactlyTheDeclaredFields(t *testing.T) {
	secret := obj(secretGVK, "ns", "s", nil, map[string]any{
		"data":       map[string]any{"password": "c2VjcmV0"},
		"stringData": map[string]any{"token": "plain"},
		"type":       "Opaque",
	})
	secret.SetManagedFields([]metav1.ManagedFieldsEntry{{Manager: "kubectl"}})
	secret.SetAnnotations(map[string]string{
		"kubectl.kubernetes.io/last-applied-configuration": "{}",
		"keep": "me",
	})
	configMap := obj(configMapGVK, "ns", "c", nil, map[string]any{
		"data":       map[string]any{"k": "v"},
		"binaryData": map[string]any{"b": "AA=="},
	})
	deployment := obj(deploymentGVK, "ns", "d", nil, map[string]any{
		"data": map[string]any{"not": "a secret"},
	})

	for _, in := range []*unstructured.Unstructured{secret, configMap, deployment} {
		if _, err := Strip(in); err != nil {
			t.Fatal(err)
		}
	}
	if _, found := secret.Object["data"]; found {
		t.Error("Secret data kept")
	}
	if _, found := secret.Object["stringData"]; found {
		t.Error("Secret stringData kept")
	}
	if secret.Object["type"] != "Opaque" {
		t.Error("Secret type removed")
	}
	if len(secret.GetManagedFields()) != 0 {
		t.Error("managedFields kept")
	}
	if got := secret.GetAnnotations(); len(got) != 1 || got["keep"] != "me" {
		t.Errorf("annotations = %v", got)
	}
	if _, found := configMap.Object["data"]; found {
		t.Error("ConfigMap data kept")
	}
	if _, found := configMap.Object["binaryData"]; found {
		t.Error("ConfigMap binaryData kept")
	}
	if _, found := deployment.Object["data"]; !found {
		t.Error("a Deployment field named data was removed")
	}
}

func TestLeaseReadsMembersThroughTheMemberSelectorAndChildrenWithout(t *testing.T) {
	member := obj(configMapGVK, "ns", "member", map[string]string{"applyset.kubernetes.io/part-of": "set"}, map[string]any{"data": map[string]any{"k": "v"}})
	other := obj(configMapGVK, "ns", "other", nil, nil)
	f := newFixture(t, member, other)
	memberID := object.UnstructuredToObjMetadata(member)

	lease := f.cache.Lease(object.ObjMetadataSet{memberID}, selector)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	got := &unstructured.Unstructured{}
	got.SetGroupVersionKind(configMapGVK)
	if err := lease.Get(ctx, client.ObjectKey{Namespace: "ns", Name: "member"}, got); err != nil {
		t.Fatal(err)
	}
	if got.GetUID() != "uid-member" {
		t.Errorf("got %v", got.Object)
	}
	if _, found := got.Object["data"]; found {
		t.Error("cached ConfigMap kept its data")
	}

	list := &unstructured.UnstructuredList{}
	list.SetGroupVersionKind(schema.GroupVersionKind{Version: "v1", Kind: "ConfigMapList"})
	if err := lease.List(ctx, list, client.InNamespace("ns")); err != nil {
		t.Fatal(err)
	}
	if len(list.Items) != 2 {
		t.Errorf("unselected list has %d items, want 2", len(list.Items))
	}

	calls := f.listCalls()
	if len(calls) != 2 || calls[0] != "configmaps/ns?"+selector || calls[1] != "configmaps/ns?" {
		t.Errorf("list calls = %v", calls)
	}
	if f.cache.Informers() != 2 {
		t.Errorf("informers = %d, want 2", f.cache.Informers())
	}
	lease.Release()
	if f.cache.Informers() != 0 {
		t.Errorf("informers after release = %d, want 0", f.cache.Informers())
	}
}

func TestLeaseGetMissingIsNotFound(t *testing.T) {
	f := newFixture(t)
	lease := f.cache.Lease(nil, "")
	defer lease.Release()
	got := &unstructured.Unstructured{}
	got.SetGroupVersionKind(namespaceGVK)
	err := lease.Get(context.Background(), client.ObjectKey{Name: "gone"}, got)
	if !apierrors.IsNotFound(err) {
		t.Errorf("err = %v, want NotFound", err)
	}
	if calls := f.listCalls(); len(calls) != 1 || calls[0] != "namespaces/?" {
		t.Errorf("list calls = %v", calls)
	}
}

func TestLeasesShareOneInformer(t *testing.T) {
	f := newFixture(t, obj(configMapGVK, "ns", "a", nil, nil))
	first := f.cache.Lease(nil, "")
	second := f.cache.Lease(nil, "")
	for _, lease := range []*Lease{first, second} {
		got := &unstructured.Unstructured{}
		got.SetGroupVersionKind(configMapGVK)
		if err := lease.Get(context.Background(), client.ObjectKey{Namespace: "ns", Name: "a"}, got); err != nil {
			t.Fatal(err)
		}
	}
	if calls := f.listCalls(); len(calls) != 1 {
		t.Errorf("list calls = %v, want one shared list", calls)
	}
	first.Release()
	if f.cache.Informers() != 1 {
		t.Errorf("informer stopped while still leased")
	}
	second.Release()
	if f.cache.Informers() != 0 {
		t.Errorf("informer kept after the last release")
	}
}

func TestStatusWatcherUsesTheSharedCache(t *testing.T) {
	deployment := obj(deploymentGVK, "ns", "web", map[string]string{"applyset.kubernetes.io/part-of": "set"}, map[string]any{
		"spec": map[string]any{"replicas": int64(1), "selector": map[string]any{"matchLabels": map[string]any{"app": "web"}}},
		"status": map[string]any{
			"observedGeneration": int64(0), "replicas": int64(1), "updatedReplicas": int64(1),
			"readyReplicas": int64(1), "availableReplicas": int64(1),
			"conditions": []any{map[string]any{"type": "Available", "status": "True"}},
		},
	})
	f := newFixture(t, deployment)
	id := object.UnstructuredToObjMetadata(deployment)
	lease := f.cache.Lease(object.ObjMetadataSet{id}, selector)
	defer lease.Release()

	w := watcher.NewDefaultStatusWatcher(nil, f.cache.mapper)
	w.InformerFactory = lease.InformerFactory()
	w.ClusterReader = lease.ClusterReader()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	events := w.Watch(ctx, object.ObjMetadataSet{id}, watcher.Options{RESTScopeStrategy: watcher.RESTScopeNamespace})

	var update *event.ResourceStatus
	synced := false
	for e := range events {
		switch e.Type {
		case event.ResourceUpdateEvent:
			update = e.Resource
		case event.SyncEvent:
			synced = true
		case event.ErrorEvent:
			t.Fatal(e.Error)
		}
		if update != nil && synced {
			cancel()
		}
	}
	if update == nil || update.Status != status.CurrentStatus {
		t.Fatalf("update = %+v", update)
	}
	deploymentLists := 0
	for _, call := range f.listCalls() {
		if call == "deployments/ns?"+selector {
			deploymentLists++
		} else if call[:len("deployments")] == "deployments" {
			t.Errorf("unexpected deployment list %s", call)
		}
	}
	if deploymentLists != 1 {
		t.Errorf("deployment lists = %d, want 1 (calls %v)", deploymentLists, f.listCalls())
	}

	// The watcher's view releases its reference when the watch stops; a
	// second reader of the same scope reuses the informer while it lives.
	reader := f.cache.Lease(object.ObjMetadataSet{id}, selector)
	defer reader.Release()
	got := &unstructured.Unstructured{}
	got.SetGroupVersionKind(deploymentGVK)
	if err := reader.Get(context.Background(), client.ObjectKey{Namespace: "ns", Name: "web"}, got); err != nil {
		t.Fatal(err)
	}
}

// The patched cli-utils factory applies Strip before objects are cached:
// a Secret read back from the cache has no values.
func TestCachedSecretHasNoValues(t *testing.T) {
	secret := obj(secretGVK, "ns", "creds", nil, map[string]any{
		"data":       map[string]any{"password": "c2VjcmV0"},
		"stringData": map[string]any{"token": "plain"},
	})
	secret.SetManagedFields([]metav1.ManagedFieldsEntry{{Manager: "kubectl"}})
	f := newFixture(t, secret)
	lease := f.cache.Lease(nil, "")
	defer lease.Release()
	got := &unstructured.Unstructured{}
	got.SetGroupVersionKind(secretGVK)
	if err := lease.Get(context.Background(), client.ObjectKey{Namespace: "ns", Name: "creds"}, got); err != nil {
		t.Fatal(err)
	}
	for _, field := range []string{"data", "stringData"} {
		if _, found := got.Object[field]; found {
			t.Errorf("cached Secret kept %s: %v", field, got.Object[field])
		}
	}
	if len(got.GetManagedFields()) != 0 {
		t.Error("cached Secret kept managedFields")
	}
}
