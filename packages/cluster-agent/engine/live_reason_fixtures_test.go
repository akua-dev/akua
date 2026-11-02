package engine_test

import (
	"os"
	"path/filepath"
	"sort"
	"strings"
	"testing"

	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"sigs.k8s.io/yaml"

	"github.com/akua-dev/akua/packages/cluster-agent/engine/internal/live"
)

const (
	argoCD             = "testdata/argo-cd"
	coreFixtures       = argoCD + "/gitops-engine/pkg/health/testdata"
	coreExpectations   = "testdata/live_reason_expectations.json"
	kstatusDifferences = "testdata/argo_cd_kstatus_differences.json"
)

type verdict struct {
	KStatus string   `json:"kstatus"`
	Reasons []string `json:"reasons"`
}

func loadObject(t *testing.T, path string) *unstructured.Unstructured {
	t.Helper()
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	// Through JSON, as the API server sends objects, so numbers are int64.
	encoded, err := yaml.YAMLToJSON(raw)
	if err != nil {
		t.Fatalf("%s: %v", path, err)
	}
	u := &unstructured.Unstructured{}
	if err := u.UnmarshalJSON(encoded); err != nil {
		t.Fatalf("%s: %v", path, err)
	}
	return u
}

// Every core Argo CD fixture (Pod, Deployment, Job, PVC, ...) must produce
// the stated kstatus and LiveReasons.
func TestLiveReasonFixtures(t *testing.T) {
	files, err := filepath.Glob(coreFixtures + "/*.yaml")
	if err != nil {
		t.Fatal(err)
	}
	if len(files) != 46 {
		t.Fatalf("found %d core fixtures, the UPSTREAM file states 46", len(files))
	}
	got := map[string]verdict{}
	for _, file := range files {
		d := live.Describe(loadObject(t, file), nil)
		reasons := d.Reasons
		if reasons == nil {
			reasons = []string{}
		}
		got[filepath.Base(file)] = verdict{KStatus: d.Status, Reasons: reasons}
	}
	compareGolden(t, coreExpectations, got)
}

type healthTests struct {
	Tests []struct {
		HealthStatus struct {
			Status string `json:"status"`
		} `json:"healthStatus"`
		InputPath string `json:"inputPath"`
	} `json:"tests"`
}

// Argo CD's health statuses as kstatus would state them; Suspended has no
// kstatus counterpart and is compared as Current.
var argoToKStatus = map[string]string{
	"Healthy":     "Current",
	"Suspended":   "Current",
	"Progressing": "InProgress",
	"Degraded":    "Failed",
	"Missing":     "NotFound",
	"Unknown":     "Unknown",
}

// Every CRD fixture with a Lua verdict: the engine must not report a
// LiveReason where Argo CD finds nothing wrong, and where kstatus disagrees
// with Argo CD the difference must be in the reviewed list.
func TestCustomResourceFixturesAgainstArgoVerdicts(t *testing.T) {
	suites, err := filepath.Glob(argoCD + "/resource_customizations/*/*/health_test.yaml")
	if err != nil {
		t.Fatal(err)
	}
	if len(suites) != 238 {
		t.Fatalf("found %d health_test.yaml files, the UPSTREAM file states 238", len(suites))
	}
	fixtures := 0
	differences := map[string]string{}
	for _, suite := range suites {
		raw, err := os.ReadFile(suite)
		if err != nil {
			t.Fatal(err)
		}
		var tests healthTests
		if err := yaml.Unmarshal(raw, &tests); err != nil {
			t.Fatalf("%s: %v", suite, err)
		}
		for _, tc := range tests.Tests {
			input := filepath.Join(filepath.Dir(suite), tc.InputPath)
			fixtures++
			d := live.Describe(loadObject(t, input), nil)
			name := strings.TrimPrefix(input, argoCD+"/resource_customizations/")
			if tc.HealthStatus.Status != "Degraded" && len(d.Reasons) > 0 {
				t.Errorf("%s: Argo CD says %s, the engine reports %v", name, tc.HealthStatus.Status, d.Reasons)
			}
			want, known := argoToKStatus[tc.HealthStatus.Status]
			if !known {
				t.Errorf("%s: unknown Argo CD status %q", name, tc.HealthStatus.Status)
			}
			if d.Status != want {
				differences[name] = tc.HealthStatus.Status + " -> " + d.Status
			}
		}
	}
	if fixtures < 1000 {
		t.Errorf("only %d fixtures had verdicts", fixtures)
	}
	keys := make([]string, 0, len(differences))
	for k := range differences {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	compareGolden(t, kstatusDifferences, differences)
}
