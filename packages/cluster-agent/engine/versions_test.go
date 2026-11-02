package engine_test

import (
	"os"
	"regexp"
	"testing"

	"github.com/akua-dev/akua/packages/cluster-agent/engine/internal/protocol"
)

// The `ready` event reports the pinned upstream versions; they must be the
// ones go.mod resolves.
func TestReadyVersionsMatchGoMod(t *testing.T) {
	goMod, err := os.ReadFile("go.mod")
	if err != nil {
		t.Fatal(err)
	}
	for module, want := range map[string]string{
		"github.com/fluxcd/pkg/ssa":   protocol.SSAVersion,
		"github.com/fluxcd/cli-utils": protocol.CLIUtilsVersion,
	} {
		match := regexp.MustCompile(`(?m)^\s+` + regexp.QuoteMeta(module) + `\s+(\S+)`).FindSubmatch(goMod)
		if match == nil {
			t.Errorf("go.mod does not require %s", module)
			continue
		}
		if got := string(match[1]); got != want {
			t.Errorf("go.mod pins %s %s, ready reports %s", module, got, want)
		}
	}
}
