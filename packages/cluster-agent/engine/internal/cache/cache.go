// Package cache is the engine's one informer cache. Every informer is
// built by the patched cli-utils DynamicInformerFactory with Strip as its
// transform, keyed by (resource, namespace, label selector, field
// selector), started lazily by the first reader and stopped when the last
// lease releases it. The ssa status poller, the kstatus watcher and the
// live-status tree all read through it, so no object is listed twice.
package cache

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"sync"
	"time"

	"github.com/fluxcd/cli-utils/pkg/kstatus/polling/clusterreader"
	"github.com/fluxcd/cli-utils/pkg/kstatus/polling/engine"
	"github.com/fluxcd/cli-utils/pkg/kstatus/watcher"
	"github.com/fluxcd/cli-utils/pkg/object"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	"k8s.io/apimachinery/pkg/api/meta"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/labels"
	"k8s.io/apimachinery/pkg/runtime/schema"
	"k8s.io/client-go/dynamic"
	toolscache "k8s.io/client-go/tools/cache"
	"k8s.io/klog/v2"
	"sigs.k8s.io/controller-runtime/pkg/client"
)

const lastApplied = "kubectl.kubernetes.io/last-applied-configuration"

// Strip is the informer transform: it removes ClusterAgent.ts
// `informerCache.stripped` before an object is cached. kstatus reads none
// of these fields.
func Strip(in any) (any, error) {
	u, ok := in.(*unstructured.Unstructured)
	if !ok {
		return in, nil
	}
	unstructured.RemoveNestedField(u.Object, "metadata", "managedFields")
	if annotations := u.GetAnnotations(); annotations != nil {
		if _, found := annotations[lastApplied]; found {
			delete(annotations, lastApplied)
			u.SetAnnotations(annotations)
		}
	}
	gvk := u.GroupVersionKind()
	if gvk.Group == "" {
		switch gvk.Kind {
		case "Secret":
			delete(u.Object, "data")
			delete(u.Object, "stringData")
		case "ConfigMap":
			delete(u.Object, "data")
			delete(u.Object, "binaryData")
		}
	}
	return u, nil
}

// Selector narrows one informer's list and watch calls.
type Selector struct {
	Label string
	Field string
}

type entryKey struct {
	resource  schema.GroupVersionResource
	namespace string
	selector  Selector
}

type entry struct {
	key      entryKey
	informer toolscache.SharedIndexInformer
	cancel   context.CancelFunc
	refs     int

	mu          sync.Mutex
	lastErr     error
	errHandlers map[*view]toolscache.WatchErrorHandler
}

func (e *entry) watchError(r *toolscache.Reflector, err error) {
	e.mu.Lock()
	e.lastErr = err
	handlers := make([]toolscache.WatchErrorHandler, 0, len(e.errHandlers))
	for _, h := range e.errHandlers {
		handlers = append(handlers, h)
	}
	e.mu.Unlock()
	klog.V(2).InfoS("informer watch error", "resource", e.key.resource, "namespace", e.key.namespace, "err", err)
	for _, h := range handlers {
		h(r, err)
	}
}

func (e *entry) err() error {
	e.mu.Lock()
	defer e.mu.Unlock()
	return e.lastErr
}

type Options struct {
	// ResyncPeriod of every informer; 0 disables resync.
	ResyncPeriod time.Duration
}

type Cache struct {
	client  dynamic.Interface
	mapper  meta.RESTMapper
	options Options

	mu      sync.Mutex
	entries map[entryKey]*entry
	stopped bool
}

func New(client dynamic.Interface, mapper meta.RESTMapper, options Options) *Cache {
	return &Cache{client: client, mapper: mapper, options: options, entries: map[entryKey]*entry{}}
}

// Mapper is the RESTMapper every reader of the cache resolves kinds with.
func (c *Cache) Mapper() meta.RESTMapper { return c.mapper }

// Informers is the number of running informers.
func (c *Cache) Informers() int {
	c.mu.Lock()
	defer c.mu.Unlock()
	return len(c.entries)
}

// Objects is the number of cached objects across all informers.
func (c *Cache) Objects() int {
	c.mu.Lock()
	entries := make([]*entry, 0, len(c.entries))
	for _, e := range c.entries {
		entries = append(entries, e)
	}
	c.mu.Unlock()
	total := 0
	for _, e := range entries {
		total += len(e.informer.GetStore().ListKeys())
	}
	return total
}

// Stop stops every informer; leases released afterwards are no-ops.
func (c *Cache) Stop() {
	c.mu.Lock()
	defer c.mu.Unlock()
	for key, e := range c.entries {
		e.cancel()
		delete(c.entries, key)
	}
	c.stopped = true
}

func (c *Cache) acquire(mapping *meta.RESTMapping, namespace string, selector Selector) (*entry, error) {
	if mapping.Scope.Name() == meta.RESTScopeNameRoot {
		namespace = ""
	}
	key := entryKey{resource: mapping.Resource, namespace: namespace, selector: selector}
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.stopped {
		return nil, errors.New("cache is stopped")
	}
	if e, found := c.entries[key]; found {
		e.refs++
		return e, nil
	}
	factory := &watcher.DynamicInformerFactory{
		Client:       c.client,
		ResyncPeriod: c.options.ResyncPeriod,
		Indexers:     toolscache.Indexers{toolscache.NamespaceIndex: toolscache.MetaNamespaceIndexFunc},
		Transform:    Strip,
		TweakListOptions: func(o *metav1.ListOptions) {
			if selector.Label != "" {
				o.LabelSelector = selector.Label
			}
			if selector.Field != "" {
				o.FieldSelector = selector.Field
			}
		},
	}
	ctx, cancel := context.WithCancel(context.Background())
	e := &entry{key: key, cancel: cancel, refs: 1, errHandlers: map[*view]toolscache.WatchErrorHandler{}}
	e.informer = factory.NewInformer(ctx, mapping, namespace)
	if err := e.informer.SetWatchErrorHandler(e.watchError); err != nil {
		cancel()
		return nil, err
	}
	c.entries[key] = e
	go e.informer.Run(ctx.Done())
	return e, nil
}

func (c *Cache) release(e *entry) {
	c.mu.Lock()
	defer c.mu.Unlock()
	e.refs--
	if e.refs > 0 {
		return
	}
	e.cancel()
	if c.entries[e.key] == e {
		delete(c.entries, e.key)
	}
}

// waitSynced blocks until the informer has listed once. A watch error that
// retrying cannot fix (forbidden, unknown resource) ends the wait early.
func waitSynced(ctx context.Context, e *entry) error {
	if e.informer.HasSynced() {
		return nil
	}
	ticker := time.NewTicker(20 * time.Millisecond)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			if err := e.err(); err != nil {
				return err
			}
			return ctx.Err()
		case <-ticker.C:
			if e.informer.HasSynced() {
				return nil
			}
			if err := e.err(); apierrors.IsForbidden(err) || apierrors.IsNotFound(err) || apierrors.IsUnauthorized(err) {
				return err
			}
		}
	}
}

// Lease holds the informers one request or one Placement reads, and
// releases them together. Members are read through memberSelector (empty:
// unselected); every other object, the generated children, unselected.
type Lease struct {
	cache          *Cache
	members        map[object.ObjMetadata]struct{}
	memberSelector string

	mu       sync.Mutex
	held     []*entry
	views    []*view
	handlers []registration
	released bool
}

type registration struct {
	informer toolscache.SharedIndexInformer
	handle   toolscache.ResourceEventHandlerRegistration
}

func (c *Cache) Lease(members object.ObjMetadataSet, memberSelector string) *Lease {
	set := make(map[object.ObjMetadata]struct{}, len(members))
	for _, id := range members {
		set[id] = struct{}{}
	}
	return &Lease{cache: c, members: set, memberSelector: memberSelector}
}

// Release drops every informer reference and event handler of the lease.
func (l *Lease) Release() {
	l.mu.Lock()
	if l.released {
		l.mu.Unlock()
		return
	}
	l.released = true
	held, views, handlers := l.held, l.views, l.handlers
	l.held, l.views, l.handlers = nil, nil, nil
	l.mu.Unlock()
	for _, r := range handlers {
		_ = r.informer.RemoveEventHandler(r.handle)
	}
	for _, v := range views {
		v.stop()
	}
	for _, e := range held {
		l.cache.release(e)
	}
}

// entry returns the informer for one scope, acquiring it once per lease.
func (l *Lease) entry(mapping *meta.RESTMapping, namespace string, selector Selector) (*entry, error) {
	if mapping.Scope.Name() == meta.RESTScopeNameRoot {
		namespace = ""
	}
	key := entryKey{resource: mapping.Resource, namespace: namespace, selector: selector}
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.released {
		return nil, errors.New("lease is released")
	}
	for _, e := range l.held {
		if e.key == key {
			return e, nil
		}
	}
	e, err := l.cache.acquire(mapping, namespace, selector)
	if err != nil {
		return nil, err
	}
	l.held = append(l.held, e)
	return e, nil
}

func (l *Lease) selectorFor(id object.ObjMetadata) Selector {
	if _, member := l.members[id]; member && l.memberSelector != "" {
		return Selector{Label: l.memberSelector}
	}
	return Selector{}
}

var _ client.Reader = &Lease{}

// Get reads one object from the cache, starting its informer if needed.
func (l *Lease) Get(ctx context.Context, key client.ObjectKey, obj client.Object, _ ...client.GetOption) error {
	u, ok := obj.(*unstructured.Unstructured)
	if !ok {
		return fmt.Errorf("cache: Get supports only unstructured objects, not %T", obj)
	}
	gvk := u.GroupVersionKind()
	mapping, err := l.cache.mapper.RESTMapping(gvk.GroupKind(), gvk.Version)
	if err != nil {
		return err
	}
	id := object.ObjMetadata{Namespace: key.Namespace, Name: key.Name, GroupKind: gvk.GroupKind()}
	if mapping.Scope.Name() == meta.RESTScopeNameRoot {
		id.Namespace = ""
	}
	e, err := l.entry(mapping, id.Namespace, l.selectorFor(id))
	if err != nil {
		return err
	}
	if err := waitSynced(ctx, e); err != nil {
		return err
	}
	item, exists, err := e.informer.GetStore().GetByKey(toolscache.NewObjectName(id.Namespace, id.Name).String())
	if err != nil {
		return err
	}
	if !exists {
		return apierrors.NewNotFound(mapping.Resource.GroupResource(), id.Name)
	}
	cached, ok := item.(*unstructured.Unstructured)
	if !ok {
		return fmt.Errorf("cache: unexpected %T in the %s informer", item, mapping.Resource)
	}
	u.Object = cached.DeepCopy().Object
	return nil
}

// List reads unselected objects of one kind from the cache.
func (l *Lease) List(ctx context.Context, list client.ObjectList, opts ...client.ListOption) error {
	ul, ok := list.(*unstructured.UnstructuredList)
	if !ok {
		return fmt.Errorf("cache: List supports only unstructured lists, not %T", list)
	}
	options := &client.ListOptions{}
	options.ApplyOptions(opts)
	if options.FieldSelector != nil && !options.FieldSelector.Empty() {
		return errors.New("cache: List does not support field selectors")
	}
	gvk := ul.GroupVersionKind()
	gvk.Kind = strings.TrimSuffix(gvk.Kind, "List")
	mapping, err := l.cache.mapper.RESTMapping(gvk.GroupKind(), gvk.Version)
	if err != nil {
		return err
	}
	e, err := l.entry(mapping, options.Namespace, Selector{})
	if err != nil {
		return err
	}
	if err := waitSynced(ctx, e); err != nil {
		return err
	}
	selector := options.LabelSelector
	if selector == nil {
		selector = labels.Everything()
	}
	ul.Items = nil
	for _, item := range e.informer.GetStore().List() {
		u, ok := item.(*unstructured.Unstructured)
		if !ok || !selector.Matches(labels.Set(u.GetLabels())) {
			continue
		}
		ul.Items = append(ul.Items, *u.DeepCopy())
	}
	return nil
}

// ClusterReader serves kstatus generated-children lookups (Deployment ->
// ReplicaSet -> Pod, StatefulSet -> Pod) from the cache.
func (l *Lease) ClusterReader() engine.ClusterReader {
	return &clusterreader.DirectClusterReader{Reader: l}
}

// ClusterReaderFactory hands the ssa status poller this lease as its
// ClusterReader.
func (l *Lease) ClusterReaderFactory() engine.ClusterReaderFactory {
	return engine.ClusterReaderFactoryFunc(func(client.Reader, meta.RESTMapper, object.ObjMetadataSet) (engine.ClusterReader, error) {
		return l.ClusterReader(), nil
	})
}

// Watch adds handler to the informer of one scope and returns its store,
// after the informer has listed once. The lease removes the handler on
// Release.
func (l *Lease) Watch(ctx context.Context, gvk schema.GroupVersionKind, namespace string, selector Selector, handler toolscache.ResourceEventHandler) (toolscache.Store, toolscache.ResourceEventHandlerRegistration, error) {
	mapping, err := l.cache.mapper.RESTMapping(gvk.GroupKind(), gvk.Version)
	if err != nil {
		return nil, nil, err
	}
	e, err := l.entry(mapping, namespace, selector)
	if err != nil {
		return nil, nil, err
	}
	handle, err := e.informer.AddEventHandler(handler)
	if err != nil {
		return nil, nil, err
	}
	l.mu.Lock()
	l.handlers = append(l.handlers, registration{informer: e.informer, handle: handle})
	l.mu.Unlock()
	if err := waitSynced(ctx, e); err != nil {
		return nil, nil, err
	}
	return e.informer.GetStore(), handle, nil
}

// InformerFactory gives a kstatus DefaultStatusWatcher views of this
// lease's member informers instead of informers of its own.
func (l *Lease) InformerFactory() watcher.InformerFactory { return leaseFactory{l} }

type leaseFactory struct{ lease *Lease }

func (f leaseFactory) NewInformer(_ context.Context, mapping *meta.RESTMapping, namespace string) toolscache.SharedIndexInformer {
	e, err := f.lease.entry(mapping, namespace, Selector{Label: f.lease.memberSelector})
	if err != nil {
		return &view{SharedIndexInformer: failedInformer(err)}
	}
	v := &view{SharedIndexInformer: e.informer, entry: e}
	f.lease.mu.Lock()
	defer f.lease.mu.Unlock()
	// A restarted watcher asks again; views it stopped hold nothing.
	live := f.lease.views[:0]
	for _, old := range f.lease.views {
		if !old.isStopped() {
			live = append(live, old)
		}
	}
	f.lease.views = append(live, v)
	return v
}
