package live

import (
	"context"
	"errors"
	"reflect"
	"sort"
	"sync"
	"time"

	"github.com/fluxcd/cli-utils/pkg/kstatus/polling/event"
	"github.com/fluxcd/cli-utils/pkg/kstatus/status"
	"github.com/fluxcd/cli-utils/pkg/kstatus/watcher"
	"github.com/fluxcd/cli-utils/pkg/object"
	corev1 "k8s.io/api/core/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	"k8s.io/apimachinery/pkg/api/meta"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/runtime/schema"
	"k8s.io/apimachinery/pkg/types"
	toolscache "k8s.io/client-go/tools/cache"
	"k8s.io/klog/v2"
	"sigs.k8s.io/controller-runtime/pkg/client"

	"github.com/akua-dev/akua/packages/cluster-agent/engine/internal/cache"
	"github.com/akua-dev/akua/packages/cluster-agent/engine/internal/protocol"
)

var (
	podGVK        = schema.GroupVersionKind{Version: "v1", Kind: "Pod"}
	replicaSetGVK = schema.GroupVersionKind{Group: "apps", Version: "v1", Kind: "ReplicaSet"}
	jobGVK        = schema.GroupVersionKind{Group: "batch", Version: "v1", Kind: "Job"}
	eventGVK      = schema.GroupVersionKind{Version: "v1", Kind: "Event"}
	pvGVK         = schema.GroupVersionKind{Version: "v1", Kind: "PersistentVolume"}
	cronJobGK     = schema.GroupKind{Group: "batch", Kind: "CronJob"}
	pvcGK         = schema.GroupKind{Kind: "PersistentVolumeClaim"}
)

// Options of a Tracker.
type Options struct {
	// MaxWatchedObjects is the safety net: past it the engine reports
	// `overloaded` and stops live status.
	MaxWatchedObjects int
	// Debounce between an informer change and the rebuild of the tree.
	Debounce time.Duration
	// Now is the clock of observedAt (Unix milliseconds).
	Now func() int64
}

// Tracker owns the live-status set of one engine: one tracked Placement
// per WatchedPlacement of the latest subscribe.
type Tracker struct {
	cache   *cache.Cache
	direct  client.Reader
	emit    func(any)
	options Options

	mu         sync.Mutex
	placements map[string]*placement
	exclusive  map[string]bool
	overloaded bool
}

// NewTracker reads the tree through c and PersistentVolumes through
// direct, and reports every event through emit.
func NewTracker(c *cache.Cache, direct client.Reader, emit func(any), options Options) *Tracker {
	if options.Debounce == 0 {
		options.Debounce = 200 * time.Millisecond
	}
	if options.Now == nil {
		options.Now = func() int64 { return time.Now().UnixMilli() }
	}
	return &Tracker{cache: c, direct: direct, emit: emit, options: options, placements: map[string]*placement{}, exclusive: map[string]bool{}}
}

// WatchLoad runs CheckLoad every interval until ctx ends.
func (t *Tracker) WatchLoad(ctx context.Context, interval time.Duration) {
	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			t.CheckLoad()
		}
	}
}

// MemberSelector is the label selector member informers of an ApplySet
// use: none when a subscribed Placement owns its namespace, the ApplySet
// part-of label otherwise.
func (t *Tracker) MemberSelector(applySetID string) string {
	t.mu.Lock()
	defer t.mu.Unlock()
	if t.exclusive[applySetID] {
		return ""
	}
	return protocol.PartOfLabel + "=" + applySetID
}

// Subscribe replaces the live-status set. Unchanged Placements keep
// running; changed ones restart and report `synced` again. It returns the
// number of distinct members now watched.
func (t *Tracker) Subscribe(placements []protocol.WatchedPlacement) int {
	members := map[string]bool{}
	for _, p := range placements {
		for _, e := range p.Inventory {
			members[e.Key] = true
		}
	}
	t.mu.Lock()
	var stopped []*placement
	if !t.overloaded && t.options.MaxWatchedObjects > 0 && len(members) > t.options.MaxWatchedObjects {
		stopped = t.overloadLocked(len(members))
	}
	if t.overloaded {
		t.mu.Unlock()
		stopAll(stopped)
		t.emit(protocol.Overloaded{WatchedObjects: len(members)})
		return len(members)
	}

	wanted := map[string]protocol.WatchedPlacement{}
	exclusive := map[string]bool{}
	for _, p := range placements {
		wanted[p.PlacementID] = p
		exclusive[p.ApplySetID] = p.NamespaceExclusive
	}
	t.exclusive = exclusive
	type replacement struct{ old, next *placement }
	var removed []*placement
	var replaced []replacement
	var started []*placement
	for id, running := range t.placements {
		spec, keep := wanted[id]
		if keep && reflect.DeepEqual(spec, running.spec) {
			delete(wanted, id)
			continue
		}
		delete(t.placements, id)
		if !keep {
			removed = append(removed, running)
			continue
		}
		next := t.newPlacement(spec)
		t.placements[id] = next
		delete(wanted, id)
		replaced = append(replaced, replacement{running, next})
	}
	for id, spec := range wanted {
		p := t.newPlacement(spec)
		t.placements[id] = p
		started = append(started, p)
	}
	t.mu.Unlock()

	// Stopping waits for each placement's goroutines; do it without t.mu,
	// which every apply and wait takes for MemberSelector.
	stopAll(removed)
	for _, r := range replaced {
		r.old.stop()
		// Continue from what the old one emitted, so the first flush
		// reports only what changed.
		r.next.emitted, r.next.warned = r.old.emitted, r.old.warned
		go r.next.run()
	}
	for _, p := range started {
		go p.run()
	}
	return len(members)
}

// CheckLoad reports `overloaded` and stops live status once the cache
// holds more objects than the safety net allows.
func (t *Tracker) CheckLoad() {
	if t.options.MaxWatchedObjects <= 0 {
		return
	}
	n := t.cache.Objects()
	if n <= t.options.MaxWatchedObjects {
		return
	}
	t.mu.Lock()
	if t.overloaded {
		t.mu.Unlock()
		return
	}
	stopped := t.overloadLocked(n)
	t.mu.Unlock()
	stopAll(stopped)
	t.emit(protocol.Overloaded{WatchedObjects: n})
}

// overloadLocked latches overload for the process lifetime and returns
// the placements the caller stops once it released t.mu.
func (t *Tracker) overloadLocked(n int) []*placement {
	klog.InfoS("live status stopped: too many watched objects", "objects", n, "max", t.options.MaxWatchedObjects)
	t.overloaded = true
	return t.takeAllLocked()
}

func (t *Tracker) takeAllLocked() []*placement {
	out := make([]*placement, 0, len(t.placements))
	for id, p := range t.placements {
		out = append(out, p)
		delete(t.placements, id)
	}
	return out
}

func stopAll(placements []*placement) {
	for _, p := range placements {
		p.stop()
	}
}

// Stop ends live status.
func (t *Tracker) Stop() {
	t.mu.Lock()
	stopped := t.takeAllLocked()
	t.mu.Unlock()
	stopAll(stopped)
}

type warnKey struct {
	involved string
	reason   string
}

type placement struct {
	tracker *Tracker
	spec    protocol.WatchedPlacement
	ctx     context.Context
	cancel  context.CancelFunc
	lease   *cache.Lease
	members map[object.ObjMetadata]protocol.InventoryEntry
	dirty   chan struct{}
	done    chan struct{}

	mu            sync.Mutex
	memberStatus  map[object.ObjMetadata]*event.ResourceStatus
	membersSynced bool
	pods          []toolscache.Store
	replicaSets   []toolscache.Store
	jobs          []toolscache.Store
	events        []toolscache.Store
	childrenReady bool
	volumes       map[string]volume

	// Owned by run's goroutine.
	emitted map[string]protocol.ResourceNode
	warned  map[warnKey]protocol.WarningEvent
	synced  bool
}

type volume struct {
	object *unstructured.Unstructured // nil: the volume does not exist
}

func (t *Tracker) newPlacement(spec protocol.WatchedPlacement) *placement {
	ctx, cancel := context.WithCancel(context.Background())
	members := map[object.ObjMetadata]protocol.InventoryEntry{}
	ids := object.ObjMetadataSet{}
	for _, e := range spec.Inventory {
		if _, id, err := e.GroupVersionKind(); err == nil {
			members[id] = e
			ids = append(ids, id)
		}
	}
	selector := protocol.PartOfLabel + "=" + spec.ApplySetID
	if spec.NamespaceExclusive {
		selector = ""
	}
	return &placement{
		tracker:      t,
		spec:         spec,
		ctx:          ctx,
		cancel:       cancel,
		lease:        t.cache.Lease(ids, selector),
		members:      members,
		dirty:        make(chan struct{}, 1),
		done:         make(chan struct{}),
		memberStatus: map[object.ObjMetadata]*event.ResourceStatus{},
		volumes:      map[string]volume{},
		emitted:      map[string]protocol.ResourceNode{},
		warned:       map[warnKey]protocol.WarningEvent{},
	}
}

func (p *placement) stop() {
	p.cancel()
	<-p.done
	p.lease.Release()
}

func (p *placement) markDirty() {
	select {
	case p.dirty <- struct{}{}:
	default:
	}
}

func (p *placement) reportError(err error) {
	if p.ctx.Err() != nil || errors.Is(err, context.Canceled) {
		return
	}
	reason := "unavailable"
	switch {
	case apierrors.IsForbidden(err), apierrors.IsUnauthorized(err):
		reason = "forbidden"
	case meta.IsNoMatchError(err), apierrors.IsInvalid(err), apierrors.IsBadRequest(err):
		reason = "invalid"
	}
	id := p.spec.PlacementID
	p.tracker.emit(protocol.EngineError{PlacementID: &id, Reason: reason, Message: err.Error()})
}

func (p *placement) run() {
	defer close(p.done)
	var wg sync.WaitGroup
	wg.Add(2)
	go func() { defer wg.Done(); p.watchMembers() }()
	go func() { defer wg.Done(); p.watchChildren() }()
	p.flushLoop()
	wg.Wait()
}

// watchMembers runs the kstatus DefaultStatusWatcher over the inventory,
// on the shared cache; a fatal watcher error is reported and the watch
// restarted with backoff.
func (p *placement) watchMembers() {
	ids := make(object.ObjMetadataSet, 0, len(p.members))
	for id := range p.members {
		ids = append(ids, id)
	}
	if len(ids) == 0 {
		p.mu.Lock()
		p.membersSynced = true
		p.mu.Unlock()
		p.markDirty()
		return
	}
	backoff := time.Second
	for p.ctx.Err() == nil {
		w := watcher.NewDefaultStatusWatcher(nil, p.tracker.cache.Mapper())
		w.InformerFactory = p.lease.InformerFactory()
		w.ClusterReader = p.lease.ClusterReader()
		ctx, cancel := context.WithCancel(p.ctx)
		failed := false
		for e := range w.Watch(ctx, ids, watcher.Options{RESTScopeStrategy: watcher.RESTScopeNamespace}) {
			switch e.Type {
			case event.ResourceUpdateEvent:
				p.mu.Lock()
				p.memberStatus[e.Resource.Identifier] = e.Resource
				p.mu.Unlock()
				p.markDirty()
			case event.SyncEvent:
				p.seedMissing(ctx)
				p.mu.Lock()
				p.membersSynced = true
				p.mu.Unlock()
				p.markDirty()
				backoff = time.Second
			case event.ErrorEvent:
				p.reportError(e.Error)
				failed = true
				cancel()
			}
		}
		cancel()
		if !failed {
			return
		}
		select {
		case <-p.ctx.Done():
		case <-time.After(backoff):
		}
		backoff = min(backoff*2, time.Minute)
	}
}

// seedMissing reads members the watcher has not reported yet from the
// synced cache: its sync event and its update events travel on different
// channels, so `synced` must not wait for their order.
func (p *placement) seedMissing(ctx context.Context) {
	p.mu.Lock()
	var missing []object.ObjMetadata
	for id := range p.members {
		if _, found := p.memberStatus[id]; !found {
			missing = append(missing, id)
		}
	}
	p.mu.Unlock()
	for _, id := range missing {
		e := p.members[id]
		u := &unstructured.Unstructured{}
		u.SetGroupVersionKind(id.GroupKind.WithVersion(e.Version))
		rs := &event.ResourceStatus{Identifier: id, Status: status.NotFoundStatus, Message: "Resource not found"}
		err := p.lease.Get(ctx, client.ObjectKey{Namespace: id.Namespace, Name: id.Name}, u)
		switch {
		case err == nil:
			rs.Resource = u
			if result, err := status.Compute(u); err == nil {
				rs.Status, rs.Message = result.Status, result.Message
			} else {
				rs.Status, rs.Message = status.UnknownStatus, err.Error()
			}
		case !apierrors.IsNotFound(err):
			rs.Status, rs.Message = status.UnknownStatus, err.Error()
		}
		p.mu.Lock()
		if _, found := p.memberStatus[id]; !found {
			p.memberStatus[id] = rs
		}
		p.mu.Unlock()
	}
}

// watchChildren starts the namespace-scoped informers of the tree: Pods,
// ReplicaSets, Jobs where a CronJob is a member, and Warning events.
func (p *placement) watchChildren() {
	namespaces := map[string]bool{}
	cronJobs := map[string]bool{}
	for _, ns := range p.spec.Namespaces {
		namespaces[ns] = true
	}
	for id := range p.members {
		if id.Namespace != "" {
			namespaces[id.Namespace] = true
		}
		if id.GroupKind == cronJobGK {
			cronJobs[id.Namespace] = true
		}
	}
	handler := toolscache.ResourceEventHandlerFuncs{
		AddFunc:    func(any) { p.markDirty() },
		UpdateFunc: func(any, any) { p.markDirty() },
		DeleteFunc: func(any) { p.markDirty() },
	}
	type target struct {
		gvk       schema.GroupVersionKind
		namespace string
		selector  cache.Selector
		into      *[]toolscache.Store
	}
	var targets []target
	for ns := range namespaces {
		targets = append(targets,
			target{podGVK, ns, cache.Selector{}, &p.pods},
			target{replicaSetGVK, ns, cache.Selector{}, &p.replicaSets},
			target{eventGVK, ns, cache.Selector{Field: "type=Warning"}, &p.events},
		)
		if cronJobs[ns] {
			targets = append(targets, target{jobGVK, ns, cache.Selector{}, &p.jobs})
		}
	}
	var wg sync.WaitGroup
	for _, tg := range targets {
		wg.Add(1)
		go func() {
			defer wg.Done()
			store, _, err := p.lease.Watch(p.ctx, tg.gvk, tg.namespace, tg.selector, handler)
			if err != nil {
				p.reportError(err)
				return
			}
			p.mu.Lock()
			*tg.into = append(*tg.into, store)
			p.mu.Unlock()
		}()
	}
	wg.Wait()
	p.mu.Lock()
	p.childrenReady = true
	p.mu.Unlock()
	p.markDirty()
}

func (p *placement) flushLoop() {
	for {
		select {
		case <-p.ctx.Done():
			return
		case <-p.dirty:
		}
		select {
		case <-p.ctx.Done():
			return
		case <-time.After(p.tracker.options.Debounce):
		}
		p.flush()
	}
}

// flush rebuilds the tree from the cache and emits what changed since
// the previous flush, then `synced` once members and children have listed.
func (p *placement) flush() {
	nodes, warnings := p.build()
	now := p.tracker.options.Now()
	id := p.spec.PlacementID

	keys := make([]string, 0, len(nodes))
	for key := range nodes {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	for _, key := range keys {
		node := nodes[key]
		if previous, found := p.emitted[key]; found {
			node.ObservedAt = previous.ObservedAt
			if reflect.DeepEqual(previous, node) {
				continue
			}
		}
		node.ObservedAt = now
		p.emitted[key] = node
		p.tracker.emit(protocol.Node{PlacementID: id, Node: node})
	}
	removed := []string{}
	for key := range p.emitted {
		if _, found := nodes[key]; !found {
			removed = append(removed, key)
		}
	}
	sort.Strings(removed)
	for _, key := range removed {
		delete(p.emitted, key)
		p.tracker.emit(protocol.Removed{PlacementID: id, Key: key})
	}
	for wk, w := range warnings {
		if previous, found := p.warned[wk]; found && previous == w {
			continue
		}
		p.warned[wk] = w
		p.tracker.emit(protocol.Warning{PlacementID: id, Event: w})
	}
	for wk := range p.warned {
		if _, found := warnings[wk]; !found {
			delete(p.warned, wk)
		}
	}

	p.mu.Lock()
	ready := p.membersSynced && p.childrenReady
	p.mu.Unlock()
	if ready && !p.synced {
		p.synced = true
		p.tracker.emit(protocol.Synced{PlacementID: id})
	}
}

type treeEntry struct {
	key     string
	object  *unstructured.Unstructured
	member  bool
	parents []string
	status  *event.ResourceStatus
}

// build computes the current tree: members from the kstatus watcher,
// children by ownerReferences (ReplicaSets and Jobs before Pods, so
// Deployment -> ReplicaSet -> Pod and CronJob -> Job -> Pod resolve),
// PersistentVolumes of bound member claims, and Warning events involving
// any node.
func (p *placement) build() (map[string]protocol.ResourceNode, map[warnKey]protocol.WarningEvent) {
	p.mu.Lock()
	statuses := make([]*event.ResourceStatus, 0, len(p.memberStatus))
	for id, rs := range p.memberStatus {
		if _, member := p.members[id]; member {
			statuses = append(statuses, rs)
		}
	}
	replicaSets, jobs, pods, events := listAll(p.replicaSets), listAll(p.jobs), listAll(p.pods), listAll(p.events)
	p.mu.Unlock()

	tree := map[string]*treeEntry{}
	byUID := map[types.UID]string{}
	add := func(e *treeEntry) {
		tree[e.key] = e
		byUID[e.object.GetUID()] = e.key
	}
	var claims []*treeEntry
	for _, rs := range statuses {
		if rs.Resource == nil || rs.Status == status.NotFoundStatus {
			continue
		}
		e := &treeEntry{key: protocol.KeyOf(rs.Identifier), object: rs.Resource, member: true, status: rs}
		add(e)
		if rs.Identifier.GroupKind == pvcGK {
			claims = append(claims, e)
		}
	}
	for _, generation := range [][]*unstructured.Unstructured{replicaSets, jobs, pods} {
		for _, u := range generation {
			key := protocol.KeyOf(object.UnstructuredToObjMetadata(u))
			if _, member := tree[key]; member {
				continue
			}
			var parents []string
			for _, ref := range u.GetOwnerReferences() {
				if parent, found := byUID[ref.UID]; found {
					parents = append(parents, parent)
				}
			}
			if len(parents) > 0 {
				add(&treeEntry{key: key, object: u, parents: parents})
			}
		}
	}
	referenced := map[string]bool{}
	for _, claim := range claims {
		name, _, _ := unstructured.NestedString(claim.object.Object, "spec", "volumeName")
		referenced[name] = true
		if pv := p.volumeOf(claim.object); pv != nil {
			add(&treeEntry{key: protocol.KeyOf(object.UnstructuredToObjMetadata(pv)), object: pv, parents: []string{claim.key}})
		}
	}

	p.mu.Lock()
	for name := range p.volumes {
		if !referenced[name] {
			delete(p.volumes, name)
		}
	}
	p.mu.Unlock()

	warnings := map[warnKey]protocol.WarningEvent{}
	reasonsOf := map[string][]string{}
	for _, u := range events {
		ev := &corev1.Event{}
		if runtime.DefaultUnstructuredConverter.FromUnstructured(u.Object, ev) != nil || ev.Type != corev1.EventTypeWarning {
			continue
		}
		involved := involvedKey(ev.InvolvedObject)
		if _, inTree := tree[involved]; !inTree || ev.Reason == "" {
			continue
		}
		w := warningOf(involved, ev)
		wk := warnKey{involved: involved, reason: ev.Reason}
		if previous, found := warnings[wk]; found {
			w = merge(previous, w)
		} else {
			reasonsOf[involved] = append(reasonsOf[involved], ev.Reason)
		}
		warnings[wk] = w
	}

	nodes := make(map[string]protocol.ResourceNode, len(tree))
	for key, e := range tree {
		d := Describe(e.object, reasonsOf[key])
		if e.status != nil {
			d.Status, d.Message = string(e.status.Status), e.status.Message
		}
		nodes[key] = protocol.ResourceNode{
			Key:        key,
			UID:        string(e.object.GetUID()),
			Version:    e.object.GroupVersionKind().Version,
			Member:     e.member,
			Parents:    e.parents,
			Status:     d.Status,
			Message:    d.Message,
			Reasons:    d.Reasons,
			Containers: d.Containers,
			Scheduling: d.Scheduling,
		}
	}
	return nodes, warnings
}

func listAll(stores []toolscache.Store) []*unstructured.Unstructured {
	var out []*unstructured.Unstructured
	for _, s := range stores {
		for _, item := range s.List() {
			if u, ok := item.(*unstructured.Unstructured); ok {
				out = append(out, u)
			}
		}
	}
	sort.Slice(out, func(i, j int) bool {
		return out[i].GetNamespace()+"/"+out[i].GetName() < out[j].GetNamespace()+"/"+out[j].GetName()
	})
	return out
}

func involvedKey(ref corev1.ObjectReference) string {
	gv, _ := schema.ParseGroupVersion(ref.APIVersion)
	return protocol.KeyOf(object.ObjMetadata{Namespace: ref.Namespace, Name: ref.Name, GroupKind: schema.GroupKind{Group: gv.Group, Kind: ref.Kind}})
}

func warningOf(involved string, ev *corev1.Event) protocol.WarningEvent {
	first, last := millis(ev.FirstTimestamp), millis(ev.LastTimestamp)
	count := ev.Count
	if ev.Series != nil {
		count = max(count, ev.Series.Count)
		last = max(last, ev.Series.LastObservedTime.UnixMilli())
	}
	if !ev.EventTime.IsZero() {
		if first == 0 {
			first = ev.EventTime.UnixMilli()
		}
		last = max(last, ev.EventTime.UnixMilli())
	}
	if first == 0 {
		first = millis(ev.CreationTimestamp)
	}
	if last < first {
		last = first
	}
	return protocol.WarningEvent{Involved: involved, Reason: ev.Reason, Message: ev.Message, Count: max(count, 1), FirstSeen: first, LastSeen: last}
}

func merge(a, b protocol.WarningEvent) protocol.WarningEvent {
	out := a
	out.Count = a.Count + b.Count
	out.FirstSeen = min(a.FirstSeen, b.FirstSeen)
	if b.LastSeen >= a.LastSeen {
		out.LastSeen, out.Message = b.LastSeen, b.Message
	}
	return out
}

// volumeOf GETs the PersistentVolume a bound claim names, once per
// volume; a failed lookup other than NotFound is retried next flush.
func (p *placement) volumeOf(claim *unstructured.Unstructured) *unstructured.Unstructured {
	name, _, _ := unstructured.NestedString(claim.Object, "spec", "volumeName")
	phase, _, _ := unstructured.NestedString(claim.Object, "status", "phase")
	if name == "" || phase != string(corev1.ClaimBound) || p.tracker.direct == nil {
		return nil
	}
	p.mu.Lock()
	cached, found := p.volumes[name]
	p.mu.Unlock()
	if found {
		return cached.object
	}
	pv := &unstructured.Unstructured{}
	pv.SetGroupVersionKind(pvGVK)
	ctx, cancel := context.WithTimeout(p.ctx, 10*time.Second)
	defer cancel()
	err := p.tracker.direct.Get(ctx, client.ObjectKey{Name: name}, pv)
	switch {
	case apierrors.IsNotFound(err):
		pv = nil
	case err != nil:
		klog.V(2).InfoS("PersistentVolume lookup failed", "volume", name, "err", err)
		return nil
	default:
		_, _ = cache.Strip(pv)
	}
	p.mu.Lock()
	p.volumes[name] = volume{object: pv}
	p.mu.Unlock()
	return pv
}
