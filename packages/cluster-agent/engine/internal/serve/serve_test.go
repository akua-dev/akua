package serve

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/akua-dev/akua/packages/cluster-agent/engine/internal/protocol"
)

const (
	setA = "applyset-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA-v1"
	setB = "applyset-BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB-v1"
)

// backend blocks every wait until its id is released, and records the
// order requests started in.
type backend struct {
	mu      sync.Mutex
	started []int64
	release map[int64]chan struct{}
}

func newBackend() *backend { return &backend{release: map[int64]chan struct{}{}} }

func (b *backend) gate(id int64) chan struct{} {
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.release[id] == nil {
		b.release[id] = make(chan struct{})
	}
	return b.release[id]
}

func (b *backend) start(id int64) {
	b.mu.Lock()
	b.started = append(b.started, id)
	b.mu.Unlock()
}

func (b *backend) startedIDs() []int64 {
	b.mu.Lock()
	defer b.mu.Unlock()
	return append([]int64(nil), b.started...)
}

func (b *backend) Apply(_ context.Context, r *protocol.Apply) protocol.Applied {
	b.start(r.ID)
	return protocol.Applied{ID: r.ID}
}

func (b *backend) Prune(_ context.Context, r *protocol.Prune) protocol.Pruned {
	b.start(r.ID)
	return protocol.Pruned{ID: r.ID}
}

func (b *backend) Wait(ctx context.Context, r *protocol.Wait) protocol.Waited {
	b.start(r.ID)
	select {
	case <-b.gate(r.ID):
	case <-ctx.Done():
	}
	return protocol.Waited{ID: r.ID}
}

func (b *backend) Subscribe(placements []protocol.WatchedPlacement) int { return len(placements) }

type session struct {
	t      *testing.T
	in     *io.PipeWriter
	lines  chan map[string]any
	done   chan error
	cancel context.CancelFunc
}

func start(t *testing.T, b Backend) *session {
	t.Helper()
	inR, inW := io.Pipe()
	outR, outW := io.Pipe()
	ctx, cancel := context.WithCancel(context.Background())
	s := &session{t: t, in: inW, lines: make(chan map[string]any, 100), done: make(chan error, 1), cancel: cancel}
	server := New(b, outW, "1.2.3")
	go func() {
		s.done <- server.Run(ctx, inR)
		outW.Close()
	}()
	go func() {
		scanner := bufio.NewScanner(outR)
		for scanner.Scan() {
			var m map[string]any
			if err := json.Unmarshal(scanner.Bytes(), &m); err != nil {
				t.Errorf("invalid output line %q: %v", scanner.Text(), err)
				continue
			}
			s.lines <- m
		}
		close(s.lines)
	}()
	t.Cleanup(func() { cancel(); inW.Close() })
	return s
}

func (s *session) send(line string) {
	s.t.Helper()
	if _, err := io.WriteString(s.in, line+"\n"); err != nil {
		s.t.Fatal(err)
	}
}

func (s *session) next() map[string]any {
	s.t.Helper()
	select {
	case m, ok := <-s.lines:
		if !ok {
			s.t.Fatal("output closed")
		}
		return m
	case <-time.After(5 * time.Second):
		s.t.Fatal("no output line")
	}
	return nil
}

func (s *session) quiet() {
	s.t.Helper()
	select {
	case m := <-s.lines:
		s.t.Fatalf("unexpected output %v", m)
	case <-time.After(100 * time.Millisecond):
	}
}

func wait(id int64, set string) string {
	return fmt.Sprintf(`{"_tag":"wait","id":%d,"applySetId":"%s","members":[],"until":"current","intervalSeconds":1,"timeoutSeconds":30,"failFast":true}`, id, set)
}

func TestReadyIsTheFirstLine(t *testing.T) {
	s := start(t, newBackend())
	ready := s.next()
	if ready["_tag"] != "ready" || ready["version"] != "1.2.3" || ready["protocol"] != float64(1) {
		t.Errorf("first line = %v", ready)
	}
}

func TestRequestsOfOneApplySetRunInOrderOthersConcurrently(t *testing.T) {
	b := newBackend()
	s := start(t, b)
	s.next() // ready
	s.send(wait(1, setA))
	s.send(wait(2, setA))
	s.send(wait(3, setB))

	// 3 answers while 1 still blocks set A; 2 has not started.
	deadline := time.Now().Add(5 * time.Second)
	for len(b.startedIDs()) < 2 && time.Now().Before(deadline) {
		time.Sleep(5 * time.Millisecond)
	}
	close(b.gate(3))
	if got := s.next(); got["_tag"] != "waited" || got["id"] != float64(3) {
		t.Fatalf("got %v", got)
	}
	if started := b.startedIDs(); len(started) != 2 || started[0] == 2 || started[1] == 2 {
		t.Fatalf("started %v: request 2 ran before 1 finished", started)
	}
	close(b.gate(1))
	if got := s.next(); got["id"] != float64(1) {
		t.Fatalf("got %v", got)
	}
	close(b.gate(2))
	if got := s.next(); got["id"] != float64(2) {
		t.Fatalf("got %v", got)
	}
}

func TestRejectionsAndUnaddressableLines(t *testing.T) {
	s := start(t, newBackend())
	s.next()
	s.send(`{"_tag":"subscribe","id":4,"impersonate":"system:admin","placements":[]}`)
	got := s.next()
	failure, _ := got["failure"].(map[string]any)
	if got["_tag"] != "rejected" || got["id"] != float64(4) || failure["reason"] != "forbidden" || failure["stage"] != "decode" {
		t.Errorf("got %v", got)
	}
	s.send(`garbage`)
	got = s.next()
	if got["_tag"] != "error" || got["placementId"] != nil || got["reason"] != "invalid" {
		t.Errorf("got %v", got)
	}
	s.send(`{"_tag":"subscribe","id":5,"impersonate":"` + protocol.Impersonation + `","placements":[]}`)
	if got := s.next(); got["_tag"] != "subscribed" || got["id"] != float64(5) || got["watchedObjects"] != float64(0) {
		t.Errorf("got %v", got)
	}
}

func TestShutdownFinishesInFlightThenStops(t *testing.T) {
	b := newBackend()
	s := start(t, b)
	s.next()
	s.send(wait(1, setA))
	for len(b.startedIDs()) < 1 {
		time.Sleep(5 * time.Millisecond)
	}
	s.send(`{"_tag":"shutdown","id":2}`)
	s.send(wait(3, setB))
	got := s.next()
	if got["_tag"] != "rejected" || got["id"] != float64(3) {
		t.Fatalf("request after shutdown: %v", got)
	}
	if !strings.Contains(got["failure"].(map[string]any)["message"].(string), "shutting down") {
		t.Errorf("got %v", got)
	}
	s.quiet()
	close(b.gate(1))
	if got := s.next(); got["_tag"] != "waited" || got["id"] != float64(1) {
		t.Fatalf("got %v", got)
	}
	if got := s.next(); got["_tag"] != "stopping" || got["id"] != float64(2) {
		t.Fatalf("got %v", got)
	}
	select {
	case err := <-s.done:
		if err != nil {
			t.Errorf("Run = %v", err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("Run did not return after stopping")
	}
}

func TestEndOfInputCancelsInFlightRequests(t *testing.T) {
	b := newBackend()
	s := start(t, b)
	s.next()
	s.send(wait(1, setA))
	for len(b.startedIDs()) < 1 {
		time.Sleep(5 * time.Millisecond)
	}
	s.in.Close()
	select {
	case err := <-s.done:
		if err != nil {
			t.Errorf("Run = %v", err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("Run did not return at end of input")
	}
}
