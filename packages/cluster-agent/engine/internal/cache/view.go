package cache

import (
	"context"
	"errors"
	"sync"
	"time"

	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/watch"
	toolscache "k8s.io/client-go/tools/cache"
)

// view is what a kstatus ObjectStatusReporter gets from leaseFactory: a
// shared informer it may add handlers to and "run". Run only waits for the
// stop signal; the cache runs the real informer. Stopping removes the
// view's handlers; the lease keeps the informer until it is released.
type view struct {
	toolscache.SharedIndexInformer
	entry *entry

	mu         sync.Mutex
	handles    []toolscache.ResourceEventHandlerRegistration
	errHandler toolscache.WatchErrorHandler
	stopped    bool
}

func (v *view) AddEventHandler(handler toolscache.ResourceEventHandler) (toolscache.ResourceEventHandlerRegistration, error) {
	return v.add(v.SharedIndexInformer.AddEventHandler(handler))
}

func (v *view) AddEventHandlerWithResyncPeriod(handler toolscache.ResourceEventHandler, period time.Duration) (toolscache.ResourceEventHandlerRegistration, error) {
	return v.add(v.SharedIndexInformer.AddEventHandlerWithResyncPeriod(handler, period))
}

func (v *view) AddEventHandlerWithOptions(handler toolscache.ResourceEventHandler, options toolscache.HandlerOptions) (toolscache.ResourceEventHandlerRegistration, error) {
	return v.add(v.SharedIndexInformer.AddEventHandlerWithOptions(handler, options))
}

func (v *view) add(handle toolscache.ResourceEventHandlerRegistration, err error) (toolscache.ResourceEventHandlerRegistration, error) {
	if err != nil {
		return nil, err
	}
	v.mu.Lock()
	defer v.mu.Unlock()
	v.handles = append(v.handles, handle)
	return handle, nil
}

func (v *view) SetWatchErrorHandler(handler toolscache.WatchErrorHandler) error {
	if v.entry == nil {
		return v.SharedIndexInformer.SetWatchErrorHandler(handler)
	}
	v.entry.mu.Lock()
	defer v.entry.mu.Unlock()
	v.entry.errHandlers[v] = handler
	return nil
}

func (v *view) SetWatchErrorHandlerWithContext(handler toolscache.WatchErrorHandlerWithContext) error {
	return v.SetWatchErrorHandler(func(r *toolscache.Reflector, err error) {
		handler(context.Background(), r, err)
	})
}

func (v *view) SetTransform(toolscache.TransformFunc) error {
	return errors.New("cache: the shared cache sets the transform")
}

// HasSynced is true once the shared informer has listed and the view's
// handlers have received that initial list.
func (v *view) HasSynced() bool {
	if !v.SharedIndexInformer.HasSynced() {
		return false
	}
	v.mu.Lock()
	defer v.mu.Unlock()
	for _, h := range v.handles {
		if !h.HasSynced() {
			return false
		}
	}
	return true
}

func (v *view) Run(stop <-chan struct{}) {
	if v.entry == nil {
		v.SharedIndexInformer.Run(stop)
		return
	}
	<-stop
	v.stop()
}

func (v *view) RunWithContext(ctx context.Context) { v.Run(ctx.Done()) }

func (v *view) isStopped() bool {
	v.mu.Lock()
	defer v.mu.Unlock()
	return v.stopped
}

func (v *view) stop() {
	v.mu.Lock()
	if v.stopped {
		v.mu.Unlock()
		return
	}
	v.stopped = true
	handles := v.handles
	v.handles = nil
	v.mu.Unlock()
	for _, h := range handles {
		_ = v.SharedIndexInformer.RemoveEventHandler(h)
	}
	if v.entry != nil {
		v.entry.mu.Lock()
		delete(v.entry.errHandlers, v)
		v.entry.mu.Unlock()
	}
}

// failedInformer reports err through the informer's own watch error path,
// so a reporter that asked for an informer the lease cannot give learns it
// the same way it learns a failed list.
func failedInformer(err error) toolscache.SharedIndexInformer {
	lw := &toolscache.ListWatch{
		ListWithContextFunc: func(context.Context, metav1.ListOptions) (runtime.Object, error) {
			return nil, err
		},
		WatchFuncWithContext: func(context.Context, metav1.ListOptions) (watch.Interface, error) {
			return nil, err
		},
	}
	return toolscache.NewSharedIndexInformer(lw, &unstructured.Unstructured{}, 0, toolscache.Indexers{})
}
