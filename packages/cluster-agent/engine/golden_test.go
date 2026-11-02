package engine_test

import (
	"encoding/json"
	"flag"
	"os"
	"testing"
)

// Reviewed golden files under testdata. Regenerate with `go test -update`
// and review the diff: a changed line is a changed verdict.
var update = flag.Bool("update", false, "rewrite the reviewed expectation files")

func compareGolden(t *testing.T, path string, got any) {
	t.Helper()
	encoded, err := json.MarshalIndent(got, "", "  ")
	if err != nil {
		t.Fatal(err)
	}
	encoded = append(encoded, '\n')
	if *update {
		if err := os.WriteFile(path, encoded, 0o644); err != nil {
			t.Fatal(err)
		}
		return
	}
	want, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if string(want) != string(encoded) {
		t.Errorf("%s does not match the engine; rerun with -update and review the diff.\n got:\n%s", path, encoded)
	}
}
