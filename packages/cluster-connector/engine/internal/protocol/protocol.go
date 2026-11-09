// Package protocol is the NDJSON wire of `akua-apply serve`: EngineRequest
// lines on stdin, EngineResponse and EngineEvent lines on stdout. The
// shapes mirror packages/domains/clusters ClusterAgent.ts (EngineRequest,
// EngineResponse, EngineEvent) and packages/api-contract cluster-agent.ts
// (ResourceNode, WarningEvent, ObjectStatus), which the agent decodes with
// Effect Schema: tagged by `_tag`, nullable fields written as null, lists
// written as [] and never omitted.
package protocol

import (
	"bytes"
	"encoding/json"
	"fmt"
	"regexp"
	"unicode/utf16"
)

const (
	// Version is the wire protocol the `ready` event announces.
	Version = 1
	// FieldManager is the only server-side apply field manager.
	FieldManager = "akua-agent"
	// Impersonation is the service account an in-cluster engine acts as.
	Impersonation = "system:serviceaccount:akua-system:akua-apply"
	// NoImpersonation is the mode of an engine whose credential is its own
	// (the control-plane-side connector's client certificate): it acts as
	// that credential and sends no Impersonate-User.
	NoImpersonation = "none"
	// PartOfLabel marks an ApplySet member (kubectl applyset.go spelling).
	PartOfLabel = "applyset.kubernetes.io/part-of"
	// SSAVersion and CLIUtilsVersion are the pinned upstream modules the
	// `ready` event reports; a test keeps them equal to go.mod.
	SSAVersion      = "v0.83.0"
	CLIUtilsVersion = "v1.4.0"
)

var (
	applySetIDPattern  = regexp.MustCompile(`^applyset-[A-Za-z0-9_-]{43}-v1$`)
	placementIDPattern = regexp.MustCompile(`^plc_[A-Za-z0-9]+$`)
)

// InventoryEntry is one ApplySet member: its ObjectKey and API version.
type InventoryEntry struct {
	Key     string `json:"key"`
	Version string `json:"version"`
}

type Failure struct {
	Stage   string  `json:"stage"`
	Reason  string  `json:"reason"`
	Object  *string `json:"object"`
	Message string  `json:"message"`
}

// Request is one decoded EngineRequest.
type Request interface{ RequestID() int64 }

type Apply struct {
	ID                int64             `json:"id"`
	ApplySetID        string            `json:"applySetId"`
	FieldManager      string            `json:"fieldManager"`
	Impersonate       string            `json:"impersonate"`
	Manifests         []json.RawMessage `json:"manifests"`
	RevisionChanged   bool              `json:"revisionChanged"`
	ForceSelector     map[string]string `json:"forceSelector"`
	ExclusionSelector map[string]string `json:"exclusionSelector"`
	// TakeOwnership allows the apply to take fields and objects over from
	// other field managers and ApplySets; without it only unowned objects
	// and this ApplySet's members are adopted.
	TakeOwnership  bool  `json:"takeOwnership"`
	TimeoutSeconds int64 `json:"timeoutSeconds"`
}

type Prune struct {
	ID                int64             `json:"id"`
	ApplySetID        string            `json:"applySetId"`
	Impersonate       string            `json:"impersonate"`
	Stale             []InventoryEntry  `json:"stale"`
	ExclusionSelector map[string]string `json:"exclusionSelector"`
	TimeoutSeconds    int64             `json:"timeoutSeconds"`
}

type Wait struct {
	ID              int64            `json:"id"`
	ApplySetID      string           `json:"applySetId"`
	Members         []InventoryEntry `json:"members"`
	Until           string           `json:"until"`
	IntervalSeconds int64            `json:"intervalSeconds"`
	TimeoutSeconds  int64            `json:"timeoutSeconds"`
	FailFast        bool             `json:"failFast"`
}

type WatchedPlacement struct {
	PlacementID        string           `json:"placementId"`
	Generation         int64            `json:"generation"`
	ApplySetID         string           `json:"applySetId"`
	Namespaces         []string         `json:"namespaces"`
	NamespaceExclusive bool             `json:"namespaceExclusive"`
	Inventory          []InventoryEntry `json:"inventory"`
}

type Subscribe struct {
	ID          int64              `json:"id"`
	Impersonate string             `json:"impersonate"`
	Placements  []WatchedPlacement `json:"placements"`
}

type Shutdown struct {
	ID int64 `json:"id"`
}

func (r *Apply) RequestID() int64     { return r.ID }
func (r *Prune) RequestID() int64     { return r.ID }
func (r *Wait) RequestID() int64      { return r.ID }
func (r *Subscribe) RequestID() int64 { return r.ID }
func (r *Shutdown) RequestID() int64  { return r.ID }

// DecodeRequest decodes and validates one stdin line. A request that
// cannot be run comes back as a Rejected answer; its ID is 0 when the line
// carries no usable id, and such a line gets no answer.
func DecodeRequest(line []byte) (Request, *Rejected) {
	var head struct {
		Tag string `json:"_tag"`
		ID  int64  `json:"id"`
	}
	if err := json.Unmarshal(line, &head); err != nil {
		return nil, reject(0, "invalid", "undecodable request: "+err.Error())
	}
	if head.ID < 1 {
		return nil, reject(0, "invalid", "request id must be an integer >= 1")
	}
	var req Request
	switch head.Tag {
	case "apply":
		req = &Apply{}
	case "prune":
		req = &Prune{}
	case "wait":
		req = &Wait{}
	case "subscribe":
		req = &Subscribe{}
	case "shutdown":
		req = &Shutdown{}
	default:
		return nil, reject(head.ID, "invalid", fmt.Sprintf("unknown request %q", head.Tag))
	}
	if err := decodeStrict(line, req); err != nil {
		return nil, reject(head.ID, "invalid", "undecodable "+head.Tag+" request: "+err.Error())
	}
	if reason, err := validate(req); err != nil {
		return nil, reject(head.ID, reason, err.Error())
	}
	return req, nil
}

func decodeStrict(line []byte, into Request) error {
	var withoutTag map[string]json.RawMessage
	if err := json.Unmarshal(line, &withoutTag); err != nil {
		return err
	}
	delete(withoutTag, "_tag")
	rest, err := json.Marshal(withoutTag)
	if err != nil {
		return err
	}
	decoder := json.NewDecoder(bytes.NewReader(rest))
	decoder.DisallowUnknownFields()
	return decoder.Decode(into)
}

func reject(id int64, reason, message string) *Rejected {
	return &Rejected{ID: id, Failure: Failure{Stage: "decode", Reason: reason, Message: message}}
}

// ImpersonateOf is the identity mode a request asks for; "" for a request
// that carries none (shutdown).
func ImpersonateOf(req Request) string {
	switch r := req.(type) {
	case *Apply:
		return r.Impersonate
	case *Prune:
		return r.Impersonate
	case *Subscribe:
		return r.Impersonate
	}
	return ""
}

func checkIdentity(impersonate string) error {
	if impersonate != Impersonation && impersonate != NoImpersonation {
		return fmt.Errorf("impersonate must be %s or %s", Impersonation, NoImpersonation)
	}
	return nil
}

func validate(req Request) (string, error) {
	switch r := req.(type) {
	case *Apply:
		if err := checkIdentity(r.Impersonate); err != nil {
			return "forbidden", err
		}
		if r.FieldManager != FieldManager {
			return "invalid", fmt.Errorf("fieldManager must be %s", FieldManager)
		}
		return "invalid", firstError(
			checkApplySet(r.ApplySetID),
			checkRange("timeoutSeconds", r.TimeoutSeconds, 10, 600),
			checkMax("manifests", len(r.Manifests), 5000),
			checkPresent("forceSelector", r.ForceSelector),
			checkPresent("exclusionSelector", r.ExclusionSelector),
		)
	case *Prune:
		if err := checkIdentity(r.Impersonate); err != nil {
			return "forbidden", err
		}
		return "invalid", firstError(
			checkApplySet(r.ApplySetID),
			checkRange("timeoutSeconds", r.TimeoutSeconds, 10, 600),
			checkInventory("stale", r.Stale),
			checkPresent("exclusionSelector", r.ExclusionSelector),
		)
	case *Wait:
		var until error
		if r.Until != "current" && r.Until != "terminated" {
			until = fmt.Errorf("until must be current or terminated")
		}
		return "invalid", firstError(
			checkApplySet(r.ApplySetID),
			until,
			checkRange("intervalSeconds", r.IntervalSeconds, 1, 60),
			checkRange("timeoutSeconds", r.TimeoutSeconds, 30, 3600),
			checkInventory("members", r.Members),
		)
	case *Subscribe:
		if err := checkIdentity(r.Impersonate); err != nil {
			return "forbidden", err
		}
		if err := checkMax("placements", len(r.Placements), 500); err != nil {
			return "invalid", err
		}
		for i, p := range r.Placements {
			if err := checkPlacement(p); err != nil {
				return "invalid", fmt.Errorf("placements[%d]: %w", i, err)
			}
		}
	}
	return "", nil
}

func checkPlacement(p WatchedPlacement) error {
	if !placementIDPattern.MatchString(p.PlacementID) {
		return fmt.Errorf("placementId %q is not a placement id", p.PlacementID)
	}
	if p.Generation < 1 {
		return fmt.Errorf("generation must be >= 1")
	}
	if p.Namespaces == nil {
		return fmt.Errorf("namespaces is required")
	}
	if err := checkMax("namespaces", len(p.Namespaces), 16); err != nil {
		return err
	}
	for _, ns := range p.Namespaces {
		if len(ns) > 63 {
			return fmt.Errorf("namespace %q is longer than 63 characters", ns)
		}
	}
	return firstError(checkApplySet(p.ApplySetID), checkInventory("inventory", p.Inventory))
}

func checkApplySet(id string) error {
	if !applySetIDPattern.MatchString(id) {
		return fmt.Errorf("applySetId %q is not an ApplySet id", id)
	}
	return nil
}

func checkRange(field string, value, lo, hi int64) error {
	if value < lo || value > hi {
		return fmt.Errorf("%s must be between %d and %d", field, lo, hi)
	}
	return nil
}

func checkMax(field string, n, max int) error {
	if n > max {
		return fmt.Errorf("%s has %d entries, at most %d", field, n, max)
	}
	return nil
}

func checkPresent(field string, m map[string]string) error {
	if m == nil {
		return fmt.Errorf("%s is required", field)
	}
	return nil
}

func checkInventory(field string, entries []InventoryEntry) error {
	if entries == nil {
		return fmt.Errorf("%s is required", field)
	}
	if err := checkMax(field, len(entries), 5000); err != nil {
		return err
	}
	for _, e := range entries {
		if _, err := ParseKey(e.Key); err != nil {
			return fmt.Errorf("%s: %w", field, err)
		}
		if e.Version == "" {
			return fmt.Errorf("%s: %s has no version", field, e.Key)
		}
	}
	return nil
}

func firstError(errs ...error) error {
	for _, err := range errs {
		if err != nil {
			return err
		}
	}
	return nil
}

// Truncate shortens s to at most max UTF-16 code units, the unit Effect
// Schema's isMaxLength counts, without splitting a character.
func Truncate(s string, max int) string {
	units := 0
	for i, r := range s {
		n := utf16.RuneLen(r)
		if n < 0 {
			n = 1
		}
		if units+n > max {
			return s[:i]
		}
		units += n
	}
	return s
}
