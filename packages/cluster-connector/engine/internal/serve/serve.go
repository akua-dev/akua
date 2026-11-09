// Package serve is the `akua-apply serve` loop: one request per stdin
// line, answers and events as stdout lines. Requests of one ApplySet run
// in arrival order, different ApplySets concurrently.
package serve

import (
	"bufio"
	"context"
	"fmt"
	"io"
	"sync"

	"k8s.io/klog/v2"

	"github.com/akua-dev/akua/packages/cluster-agent/engine/internal/protocol"
)

// A request line holds at most 5000 manifests; bounded well below the
// engine's memory limit.
const maxLine = 64 << 20

// Backend runs decoded requests.
type Backend interface {
	Apply(ctx context.Context, r *protocol.Apply) protocol.Applied
	Prune(ctx context.Context, r *protocol.Prune) protocol.Pruned
	Wait(ctx context.Context, r *protocol.Wait) protocol.Waited
	Subscribe(placements []protocol.WatchedPlacement) int
}

type Server struct {
	backend Backend
	version string
	// Mode is the identity mode the process runs in (protocol.Impersonation
	// or protocol.NoImpersonation); a request asking for another is
	// rejected. Empty accepts either, for tests.
	Mode string

	writeMu sync.Mutex
	out     io.Writer

	mu       sync.Mutex
	lanes    map[string][]func()
	stopping bool
	inFlight sync.WaitGroup
}

func New(backend Backend, out io.Writer, version string) *Server {
	return &Server{backend: backend, out: out, version: version, lanes: map[string][]func(){}}
}

// Emit writes one message as one stdout line; it is safe for concurrent
// use and is how live-status events reach the agent.
func (s *Server) Emit(msg any) {
	line, err := protocol.Encode(msg)
	if err != nil {
		klog.ErrorS(err, "cannot encode engine message")
		return
	}
	s.writeMu.Lock()
	defer s.writeMu.Unlock()
	if _, err := s.out.Write(append(line, '\n')); err != nil {
		klog.ErrorS(err, "cannot write to stdout")
	}
}

// Run announces `ready`, then serves stdin until `shutdown` (after which
// it waits for accepted requests and answers `stopping`) or the end of
// input (after which it cancels them).
func (s *Server) Run(ctx context.Context, in io.Reader) error {
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	s.Emit(protocol.Ready{Version: s.version})

	lines := make(chan []byte)
	readErr := make(chan error, 1)
	go func() {
		scanner := bufio.NewScanner(in)
		scanner.Buffer(make([]byte, 64<<10), maxLine)
		for scanner.Scan() {
			line := append([]byte(nil), scanner.Bytes()...)
			select {
			case lines <- line:
			case <-ctx.Done():
				return
			}
		}
		readErr <- scanner.Err()
	}()

	var stopID int64
	drained := make(chan struct{})
	for {
		select {
		case line := <-lines:
			if len(line) == 0 {
				continue
			}
			if shutdown := s.handle(ctx, line); shutdown != nil {
				// Keep reading, so later requests are rejected, until
				// every accepted request has answered.
				stopID = shutdown.ID
				go func() {
					s.inFlight.Wait()
					close(drained)
				}()
			}
		case <-drained:
			s.Emit(protocol.Stopping{ID: stopID})
			return nil
		case err := <-readErr:
			cancel()
			s.inFlight.Wait()
			if err != nil {
				return fmt.Errorf("reading stdin: %w", err)
			}
			return nil
		case <-ctx.Done():
			s.inFlight.Wait()
			return nil
		}
	}
}

func (s *Server) handle(ctx context.Context, line []byte) *protocol.Shutdown {
	req, rejected := protocol.DecodeRequest(line)
	if rejected != nil {
		if rejected.ID == 0 {
			s.Emit(protocol.EngineError{Reason: "invalid", Message: rejected.Failure.Message})
		} else {
			s.Emit(*rejected)
		}
		return nil
	}
	if mode := protocol.ImpersonateOf(req); s.Mode != "" && mode != "" && mode != s.Mode {
		s.Emit(protocol.Rejected{ID: req.RequestID(), Failure: protocol.Failure{
			Stage: "decode", Reason: "forbidden",
			Message: fmt.Sprintf("impersonate %q does not match this engine's mode %q", mode, s.Mode),
		}})
		return nil
	}
	s.mu.Lock()
	stopping := s.stopping
	if shutdown, ok := req.(*protocol.Shutdown); ok && !stopping {
		s.stopping = true
		s.mu.Unlock()
		return shutdown
	}
	s.mu.Unlock()
	if stopping {
		s.Emit(protocol.Rejected{ID: req.RequestID(), Failure: protocol.Failure{
			Stage: "decode", Reason: "unavailable", Message: "the engine is shutting down",
		}})
		return nil
	}

	switch r := req.(type) {
	case *protocol.Apply:
		s.enqueue(r.ApplySetID, func() { s.Emit(s.backend.Apply(ctx, r)) })
	case *protocol.Prune:
		s.enqueue(r.ApplySetID, func() { s.Emit(s.backend.Prune(ctx, r)) })
	case *protocol.Wait:
		s.enqueue(r.ApplySetID, func() { s.Emit(s.backend.Wait(ctx, r)) })
	case *protocol.Subscribe:
		// Its own lane: subscriptions replace each other in order.
		s.enqueue("", func() {
			s.Emit(protocol.Subscribed{ID: r.ID, WatchedObjects: s.backend.Subscribe(r.Placements)})
		})
	}
	return nil
}

// enqueue runs job after every earlier job of the same lane.
func (s *Server) enqueue(lane string, job func()) {
	s.inFlight.Add(1)
	s.mu.Lock()
	defer s.mu.Unlock()
	queue, running := s.lanes[lane]
	s.lanes[lane] = append(queue, job)
	if running {
		return
	}
	go s.drain(lane)
}

func (s *Server) drain(lane string) {
	for {
		s.mu.Lock()
		queue := s.lanes[lane]
		if len(queue) == 0 {
			delete(s.lanes, lane)
			s.mu.Unlock()
			return
		}
		job := queue[0]
		s.lanes[lane] = queue[1:]
		s.mu.Unlock()
		func() {
			defer s.inFlight.Done()
			job()
		}()
	}
}
