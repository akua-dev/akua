package protocol

import (
	"encoding/json"
	"fmt"
	"reflect"
)

type ChangeEntry struct {
	Key     string `json:"key"`
	Version string `json:"version"`
	Action  string `json:"action"`
}

type Survivor struct {
	Entry   InventoryEntry `json:"entry"`
	Message string         `json:"message"`
}

// ObjectStatus is one member's kstatus.
type ObjectStatus struct {
	Key     string `json:"key"`
	Status  string `json:"status"`
	Message string `json:"message"`
}

type Applied struct {
	ID             int64         `json:"id"`
	Changes        []ChangeEntry `json:"changes"`
	DriftCorrected []string      `json:"driftCorrected"`
	Failure        *Failure      `json:"failure"`
}

type Pruned struct {
	ID        int64            `json:"id"`
	Deleted   []InventoryEntry `json:"deleted"`
	Survivors []Survivor       `json:"survivors"`
}

type Waited struct {
	ID      int64          `json:"id"`
	Health  []ObjectStatus `json:"health"`
	Failure *Failure       `json:"failure"`
}

type Subscribed struct {
	ID             int64 `json:"id"`
	WatchedObjects int   `json:"watchedObjects"`
}

type Rejected struct {
	ID      int64   `json:"id"`
	Failure Failure `json:"failure"`
}

type Stopping struct {
	ID int64 `json:"id"`
}

type Ready struct {
	Version string `json:"version"`
}

// ContainerState mirrors cluster-agent.ts ContainerState; exactly one of
// Waiting, Running and Terminated is set.
type ContainerState struct {
	Name            string       `json:"name"`
	Init            bool         `json:"init"`
	Ready           bool         `json:"ready"`
	RestartCount    int32        `json:"restartCount"`
	State           StateValue   `json:"state"`
	LastTermination *Termination `json:"lastTermination"`
}

type StateValue struct {
	Waiting    *Waiting
	Running    *Running
	Terminated *Termination
}

type Waiting struct {
	Reason  string `json:"reason"`
	Message string `json:"message"`
}

type Running struct {
	StartedAt int64 `json:"startedAt"`
}

type Termination struct {
	Reason     string `json:"reason"`
	ExitCode   int32  `json:"exitCode"`
	FinishedAt int64  `json:"finishedAt"`
}

func (s StateValue) MarshalJSON() ([]byte, error) {
	switch {
	case s.Waiting != nil:
		return json.Marshal(struct {
			Tag string `json:"_tag"`
			Waiting
		}{"waiting", Waiting{Reason: s.Waiting.Reason, Message: Truncate(s.Waiting.Message, 512)}})
	case s.Running != nil:
		return json.Marshal(struct {
			Tag string `json:"_tag"`
			Running
		}{"running", *s.Running})
	case s.Terminated != nil:
		return json.Marshal(struct {
			Tag string `json:"_tag"`
			Termination
		}{"terminated", *s.Terminated})
	}
	return nil, fmt.Errorf("container state has no value")
}

type Scheduling struct {
	Reason  string `json:"reason"`
	Message string `json:"message"`
}

// ResourceNode mirrors cluster-agent.ts ResourceNode. Times are Unix
// milliseconds.
type ResourceNode struct {
	Key        string           `json:"key"`
	UID        string           `json:"uid"`
	Version    string           `json:"version"`
	Member     bool             `json:"member"`
	Parents    []string         `json:"parents"`
	Status     string           `json:"status"`
	Message    string           `json:"message"`
	Reasons    []string         `json:"reasons"`
	Containers []ContainerState `json:"containers"`
	Scheduling *Scheduling      `json:"scheduling"`
	ObservedAt int64            `json:"observedAt"`
}

// WarningEvent mirrors cluster-agent.ts WarningEvent. Times are Unix
// milliseconds.
type WarningEvent struct {
	Involved  string `json:"involved"`
	Reason    string `json:"reason"`
	Message   string `json:"message"`
	Count     int32  `json:"count"`
	FirstSeen int64  `json:"firstSeen"`
	LastSeen  int64  `json:"lastSeen"`
}

type Node struct {
	PlacementID string       `json:"placementId"`
	Node        ResourceNode `json:"node"`
}

type Removed struct {
	PlacementID string `json:"placementId"`
	Key         string `json:"key"`
}

type Warning struct {
	PlacementID string       `json:"placementId"`
	Event       WarningEvent `json:"event"`
}

type Synced struct {
	PlacementID string `json:"placementId"`
}

type Overloaded struct {
	WatchedObjects int `json:"watchedObjects"`
}

// EngineError is the `error` event; PlacementID is nil for engine-wide errors.
type EngineError struct {
	PlacementID *string `json:"placementId"`
	Reason      string  `json:"reason"`
	Message     string  `json:"message"`
}

// Encode renders one message as a single JSON line without the newline:
// it adds `_tag`, writes empty lists as [] and enforces the contract's
// message length limits.
func Encode(msg any) ([]byte, error) {
	var tag string
	var body any
	switch m := msg.(type) {
	case Applied:
		tag, m.Changes, m.DriftCorrected, m.Failure = "applied", nonNil(m.Changes), nonNil(m.DriftCorrected), limitFailure(m.Failure)
		body = m
	case Pruned:
		m.Deleted = nonNil(m.Deleted)
		m.Survivors = append([]Survivor{}, m.Survivors...)
		for i := range m.Survivors {
			m.Survivors[i].Message = Truncate(m.Survivors[i].Message, 1024)
		}
		tag, body = "pruned", m
	case Waited:
		m.Health = nonNil(m.Health)
		for i := range m.Health {
			m.Health[i].Message = Truncate(m.Health[i].Message, 512)
		}
		tag, m.Failure = "waited", limitFailure(m.Failure)
		body = m
	case Subscribed:
		tag, body = "subscribed", m
	case Rejected:
		m.Failure = *limitFailure(&m.Failure)
		tag, body = "rejected", m
	case Stopping:
		tag, body = "stopping", m
	case Ready:
		tag, body = "ready", struct {
			Protocol int    `json:"protocol"`
			Version  string `json:"version"`
			SSA      string `json:"ssa"`
			CLIUtils string `json:"cliUtils"`
		}{Version, m.Version, SSAVersion, CLIUtilsVersion}
	case Node:
		m.Node = limitNode(m.Node)
		tag, body = "node", m
	case Removed:
		tag, body = "removed", m
	case Warning:
		m.Event.Reason = Truncate(m.Event.Reason, 128)
		m.Event.Message = Truncate(m.Event.Message, 1024)
		if m.Event.Count < 1 {
			m.Event.Count = 1
		}
		tag, body = "warning", m
	case Synced:
		tag, body = "synced", m
	case Overloaded:
		tag, body = "overloaded", m
	case EngineError:
		m.Message = Truncate(m.Message, 1024)
		tag, body = "error", m
	default:
		return nil, fmt.Errorf("protocol: cannot encode %T", msg)
	}
	fields, err := json.Marshal(body)
	if err != nil {
		return nil, err
	}
	out := []byte(`{"_tag":"` + tag + `"`)
	if len(fields) > 2 {
		out = append(out, ',')
		out = append(out, fields[1:]...)
	} else {
		out = append(out, '}')
	}
	return out, nil
}

func nonNil[T any](s []T) []T {
	if s == nil {
		return []T{}
	}
	return s
}

func limitFailure(f *Failure) *Failure {
	if f == nil {
		return nil
	}
	limited := *f
	limited.Message = Truncate(limited.Message, 4096)
	return &limited
}

func limitNode(n ResourceNode) ResourceNode {
	n.UID = Truncate(n.UID, 64)
	n.Version = Truncate(n.Version, 64)
	n.Message = Truncate(n.Message, 512)
	n.Parents = nonNil(n.Parents)
	if len(n.Parents) > 8 {
		n.Parents = n.Parents[:8]
	}
	n.Reasons = nonNil(n.Reasons)
	if len(n.Reasons) > 8 {
		n.Reasons = n.Reasons[:8]
	}
	n.Containers = nonNil(n.Containers)
	if len(n.Containers) > 32 {
		n.Containers = n.Containers[:32]
	}
	if n.Scheduling != nil {
		s := *n.Scheduling
		s.Message = Truncate(s.Message, 512)
		n.Scheduling = &s
	}
	return n
}

func (s *StateValue) UnmarshalJSON(b []byte) error {
	var head struct {
		Tag string `json:"_tag"`
	}
	if err := json.Unmarshal(b, &head); err != nil {
		return err
	}
	*s = StateValue{}
	switch head.Tag {
	case "waiting":
		s.Waiting = &Waiting{}
		return json.Unmarshal(b, s.Waiting)
	case "running":
		s.Running = &Running{}
		return json.Unmarshal(b, s.Running)
	case "terminated":
		s.Terminated = &Termination{}
		return json.Unmarshal(b, s.Terminated)
	}
	return fmt.Errorf("unknown container state %q", head.Tag)
}

// DecodeMessage reads one stdout line back into the value Encode wrote, so
// recorded streams can be checked against the current wire shapes.
func DecodeMessage(line []byte) (any, error) {
	var head struct {
		Tag string `json:"_tag"`
	}
	if err := json.Unmarshal(line, &head); err != nil {
		return nil, err
	}
	decode := func(into any) (any, error) {
		if err := json.Unmarshal(line, into); err != nil {
			return nil, fmt.Errorf("%s: %w", head.Tag, err)
		}
		return into, nil
	}
	var msg any
	var err error
	switch head.Tag {
	case "applied":
		msg, err = decode(&Applied{})
	case "pruned":
		msg, err = decode(&Pruned{})
	case "waited":
		msg, err = decode(&Waited{})
	case "subscribed":
		msg, err = decode(&Subscribed{})
	case "rejected":
		msg, err = decode(&Rejected{})
	case "stopping":
		msg, err = decode(&Stopping{})
	case "ready":
		msg, err = decode(&Ready{})
	case "node":
		msg, err = decode(&Node{})
	case "removed":
		msg, err = decode(&Removed{})
	case "warning":
		msg, err = decode(&Warning{})
	case "synced":
		msg, err = decode(&Synced{})
	case "overloaded":
		msg, err = decode(&Overloaded{})
	case "error":
		msg, err = decode(&EngineError{})
	default:
		return nil, fmt.Errorf("unknown message %q", head.Tag)
	}
	if err != nil {
		return nil, err
	}
	// Encode takes values, not pointers.
	return reflect.ValueOf(msg).Elem().Interface(), nil
}
