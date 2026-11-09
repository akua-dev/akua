package ops

import (
	"context"
	"strings"
	"testing"

	"github.com/fluxcd/cli-utils/pkg/object"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	clientgoscheme "k8s.io/client-go/kubernetes/scheme"
	"sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/controller-runtime/pkg/client/fake"
	"sigs.k8s.io/controller-runtime/pkg/client/interceptor"

	"github.com/akua-dev/akua/packages/cluster-agent/engine/internal/protocol"
)

const otherApplySet = "applyset-BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB-v1"

func configMap(name string, labels map[string]string) *unstructured.Unstructured {
	u := manifest("v1", "ConfigMap", "shop", name, false)
	u.SetLabels(labels)
	return u
}

func TestApplyAdoptsOnlyUnownedObjectsAndThisApplySet(t *testing.T) {
	ours := map[string]string{protocol.PartOfLabel: applySet}
	foreign := map[string]string{protocol.PartOfLabel: otherApplySet}
	forceSelector := map[string]string{"akua.dev/force": "enabled"}
	forced := map[string]string{protocol.PartOfLabel: otherApplySet, "akua.dev/force": "enabled"}

	cases := []struct {
		name     string
		live     *unstructured.Unstructured
		take     bool
		desired  *unstructured.Unstructured
		force    bool
		conflict bool
	}{
		{"absent object is created", nil, false, configMap("a", ours), true, false},
		{"member of this ApplySet is forced", configMap("a", ours), false, configMap("a", ours), true, false},
		{"unowned object is adopted without force", configMap("a", nil), false, configMap("a", ours), false, false},
		{"another ApplySet is a conflict", configMap("a", foreign), false, configMap("a", ours), false, true},
		{"explicit force takes another ApplySet", configMap("a", forced), false, configMap("a", ours), true, false},
		{"takeOwnership takes another ApplySet", configMap("a", foreign), true, configMap("a", ours), true, false},
		{"takeOwnership forces an unowned object", configMap("a", nil), true, configMap("a", ours), true, false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			builder := fake.NewClientBuilder().WithScheme(clientgoscheme.Scheme)
			if tc.live != nil {
				builder = builder.WithObjects(tc.live)
			}
			o := &Ops{Client: builder.Build(), Concurrency: 2}
			r := &protocol.Apply{ApplySetID: applySet, ForceSelector: forceSelector, TakeOwnership: tc.take}
			got, failure := o.checkOwnership(context.Background(), r, []*unstructured.Unstructured{tc.desired})
			if tc.conflict {
				if failure == nil || failure.Reason != "applyset-conflict" || failure.Object == nil || *failure.Object != "shop_a__ConfigMap" {
					t.Fatalf("failure = %+v, want applyset-conflict naming the ConfigMap", failure)
				}
				if !strings.Contains(failure.Message, otherApplySet) {
					t.Errorf("message does not name the owner: %s", failure.Message)
				}
				return
			}
			if failure != nil {
				t.Fatalf("unexpected failure %+v", failure)
			}
			if got[object.UnstructuredToObjMetadata(tc.desired)] != tc.force {
				t.Errorf("force = %v, want %v", !tc.force, tc.force)
			}
		})
	}
}

func TestOwnershipClientDropsForceOnlyWhereNotAllowed(t *testing.T) {
	var forcedByName = map[string]bool{}
	base := fake.NewClientBuilder().
		WithScheme(clientgoscheme.Scheme).
		WithInterceptorFuncs(interceptor.Funcs{
			Patch: func(ctx context.Context, c client.WithWatch, obj client.Object, patch client.Patch, opts ...client.PatchOption) error {
				forcedByName[obj.GetName()] = false
				for _, opt := range opts {
					if opt == client.PatchOption(client.ForceOwnership) {
						forcedByName[obj.GetName()] = true
					}
				}
				return nil
			},
		}).
		Build()
	adopted, forced := configMap("adopted", nil), configMap("forced", nil)
	c := ownershipClient{Client: base, force: map[object.ObjMetadata]bool{
		object.UnstructuredToObjMetadata(adopted): false,
		object.UnstructuredToObjMetadata(forced):  true,
	}}
	for _, u := range []*unstructured.Unstructured{adopted, forced} {
		if err := c.Patch(context.Background(), u, client.Apply, client.ForceOwnership, client.FieldOwner(protocol.FieldManager)); err != nil {
			t.Fatal(err)
		}
	}
	if forcedByName["adopted"] || !forcedByName["forced"] {
		t.Errorf("force sent per object = %v, want only forced", forcedByName)
	}
}
