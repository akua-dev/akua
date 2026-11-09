package protocol

import (
	"encoding/json"
	"strings"
	"testing"

	"github.com/fluxcd/cli-utils/pkg/object"
	"k8s.io/apimachinery/pkg/runtime/schema"
)

const applySet = "applyset-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA-v1"

func TestObjectKeyRoundTrip(t *testing.T) {
	cases := map[string]object.ObjMetadata{
		"default_web_apps_Deployment": {Namespace: "default", Name: "web", GroupKind: schema.GroupKind{Group: "apps", Kind: "Deployment"}},
		"__Namespace":                 {}, // placeholder, replaced below
		"_system:auth_rbac.authorization.k8s.io_ClusterRole": {
			Name: "system:auth", GroupKind: schema.GroupKind{Group: "rbac.authorization.k8s.io", Kind: "ClusterRole"},
		},
		"_shop__Namespace": {Name: "shop", GroupKind: schema.GroupKind{Kind: "Namespace"}},
	}
	delete(cases, "__Namespace")
	for key, id := range cases {
		if got := KeyOf(id); got != key {
			t.Errorf("KeyOf(%v) = %q, want %q", id, got, key)
		}
		parsed, err := ParseKey(key)
		if err != nil {
			t.Fatalf("ParseKey(%q): %v", key, err)
		}
		if parsed != id {
			t.Errorf("ParseKey(%q) = %v, want %v", key, parsed, id)
		}
	}
}

func TestParseKeyRejectsMalformed(t *testing.T) {
	for _, key := range []string{"", "a_b_c", "ns_name_group_", "ns__group_Kind", "NS_name_g_Kind", "a_b_c_d_e"} {
		if _, err := ParseKey(key); err == nil {
			t.Errorf("ParseKey(%q) accepted a malformed key", key)
		}
	}
}

func decode(t *testing.T, line string) (Request, *Rejected) {
	t.Helper()
	return DecodeRequest([]byte(line))
}

func TestDecodeApply(t *testing.T) {
	req, rej := decode(t, `{"_tag":"apply","id":3,"applySetId":"`+applySet+`","fieldManager":"akua-agent","impersonate":"system:serviceaccount:akua-system:akua-apply","manifests":[{"apiVersion":"v1","kind":"ConfigMap","metadata":{"name":"a","namespace":"ns"}}],"revisionChanged":false,"forceSelector":{},"exclusionSelector":{"akua.dev/reconcile":"disabled"},"timeoutSeconds":60}`)
	if rej != nil {
		t.Fatalf("rejected: %+v", rej)
	}
	apply, ok := req.(*Apply)
	if !ok {
		t.Fatalf("got %T", req)
	}
	if apply.ID != 3 || apply.ApplySetID != applySet || len(apply.Manifests) != 1 || apply.TimeoutSeconds != 60 || apply.ExclusionSelector["akua.dev/reconcile"] != "disabled" {
		t.Errorf("unexpected decode: %+v", apply)
	}
}

func TestDecodeApplyWithoutImpersonation(t *testing.T) {
	req, rej := decode(t, `{"_tag":"prune","id":6,"applySetId":"`+applySet+`","impersonate":"none","stale":[],"exclusionSelector":{},"timeoutSeconds":60}`)
	if rej != nil {
		t.Fatalf("rejected: %+v", rej)
	}
	if prune, ok := req.(*Prune); !ok || prune.Impersonate != NoImpersonation {
		t.Errorf("unexpected decode: %+v", req)
	}
}

func TestDecodeRejections(t *testing.T) {
	cases := []struct {
		name   string
		line   string
		id     int64
		reason string
	}{
		{"wrong impersonation", `{"_tag":"prune","id":4,"applySetId":"` + applySet + `","impersonate":"system:serviceaccount:kube-system:admin","stale":[],"exclusionSelector":{},"timeoutSeconds":60}`, 4, "forbidden"},
		{"wrong field manager", `{"_tag":"apply","id":5,"applySetId":"` + applySet + `","fieldManager":"kubectl","impersonate":"system:serviceaccount:akua-system:akua-apply","manifests":[],"revisionChanged":true,"forceSelector":{},"exclusionSelector":{},"timeoutSeconds":60}`, 5, "invalid"},
		{"timeout out of range", `{"_tag":"wait","id":6,"applySetId":"` + applySet + `","members":[],"until":"current","intervalSeconds":1,"timeoutSeconds":5,"failFast":true}`, 6, "invalid"},
		{"bad applyset id", `{"_tag":"wait","id":7,"applySetId":"applyset-x-v1","members":[],"until":"current","intervalSeconds":1,"timeoutSeconds":30,"failFast":true}`, 7, "invalid"},
		{"unknown tag", `{"_tag":"explode","id":8}`, 8, "invalid"},
		{"unknown field", `{"_tag":"shutdown","id":9,"force":true}`, 9, "invalid"},
		{"bad member key", `{"_tag":"wait","id":10,"applySetId":"` + applySet + `","members":[{"key":"nope","version":"v1"}],"until":"current","intervalSeconds":1,"timeoutSeconds":30,"failFast":true}`, 10, "invalid"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			req, rej := decode(t, tc.line)
			if rej == nil {
				t.Fatalf("accepted: %+v", req)
			}
			if rej.ID != tc.id || rej.Failure.Stage != "decode" || rej.Failure.Reason != tc.reason || rej.Failure.Object != nil {
				t.Errorf("got %+v / %+v", rej, rej.Failure)
			}
		})
	}
}

func TestDecodeWithoutUsableIDHasNoRejection(t *testing.T) {
	for _, line := range []string{`not json`, `{"_tag":"shutdown"}`, `{"_tag":"shutdown","id":0}`} {
		req, rej := decode(t, line)
		if req != nil || rej == nil || rej.ID != 0 {
			t.Errorf("%q: got %v %+v", line, req, rej)
		}
	}
}

func TestEncodeShapes(t *testing.T) {
	cases := []struct {
		msg  any
		want string
	}{
		{Applied{ID: 1}, `{"_tag":"applied","id":1,"changes":[],"driftCorrected":[],"failure":null}`},
		{Pruned{ID: 2}, `{"_tag":"pruned","id":2,"deleted":[],"survivors":[]}`},
		{Waited{ID: 3}, `{"_tag":"waited","id":3,"health":[],"failure":null}`},
		{Subscribed{ID: 4, WatchedObjects: 7}, `{"_tag":"subscribed","id":4,"watchedObjects":7}`},
		{Stopping{ID: 5}, `{"_tag":"stopping","id":5}`},
		{Ready{Version: "0.14.0"}, `{"_tag":"ready","protocol":1,"version":"0.14.0","ssa":"v0.83.0","cliUtils":"v1.4.0"}`},
		{Removed{PlacementID: "plc_a", Key: "ns_a__ConfigMap"}, `{"_tag":"removed","placementId":"plc_a","key":"ns_a__ConfigMap"}`},
		{Synced{PlacementID: "plc_a"}, `{"_tag":"synced","placementId":"plc_a"}`},
		{Overloaded{WatchedObjects: 2001}, `{"_tag":"overloaded","watchedObjects":2001}`},
		{EngineError{Reason: "invalid", Message: "x"}, `{"_tag":"error","placementId":null,"reason":"invalid","message":"x"}`},
		{
			Node{PlacementID: "plc_a", Node: ResourceNode{Key: "ns_p__Pod", UID: "u", Version: "v1", Status: "Current"}},
			`{"_tag":"node","placementId":"plc_a","node":{"key":"ns_p__Pod","uid":"u","version":"v1","member":false,"parents":[],"status":"Current","message":"","reasons":[],"containers":[],"scheduling":null,"observedAt":0}}`,
		},
	}
	for _, tc := range cases {
		got, err := Encode(tc.msg)
		if err != nil {
			t.Fatal(err)
		}
		if string(got) != tc.want {
			t.Errorf("Encode(%T)\n got %s\nwant %s", tc.msg, got, tc.want)
		}
	}
}

func TestEncodeTruncatesMessages(t *testing.T) {
	long := strings.Repeat("é", 5000)
	got, err := Encode(Rejected{ID: 1, Failure: Failure{Stage: "decode", Reason: "invalid", Message: long}})
	if err != nil {
		t.Fatal(err)
	}
	var decoded struct {
		Failure struct{ Message string } `json:"failure"`
	}
	if err := json.Unmarshal(got, &decoded); err != nil {
		t.Fatal(err)
	}
	if n := len([]rune(decoded.Failure.Message)); n != 4096 {
		t.Errorf("message has %d characters, want 4096", n)
	}
}
