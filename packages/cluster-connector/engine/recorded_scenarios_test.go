package engine_test

import (
	"bufio"
	"bytes"
	"os"
	"path/filepath"
	"slices"
	"testing"

	"github.com/akua-dev/akua/packages/cluster-agent/engine/internal/live"
	"github.com/akua-dev/akua/packages/cluster-agent/engine/internal/protocol"
)

// ClusterAgent contract liveReasonFixtures.recorded: `akua-apply serve`
// stdout recorded once per scenario against a kind cluster (v1.34, the
// impersonated ServiceAccount bound to `admin` in the scenario namespace).
var recordedScenarios = map[string]string{
	"bad-image":           "ImagePullBackOff",
	"crash-loop-back-off": "CrashLoopBackOff",
	"oom-killed":          "OOMKilled",
	"unschedulable":       "Unschedulable",
	"failed-mount":        "FailedMount",
}

// liveHealth mirrors cluster-agent.ts LiveHealth.
type liveHealth struct {
	Status    string   `json:"status"`
	Reasons   []string `json:"reasons"`
	Restarts  int32    `json:"restarts"`
	ReadyPods int      `json:"readyPods"`
	Pods      int      `json:"pods"`
}

// fold is the agent's healthOf (live-status.ts) over the final tree:
// Flux AggregateStatus over members, the union of node reasons in
// LiveReason order, restarts and ready Pods.
func fold(nodes map[string]protocol.ResourceNode) liveHealth {
	h := liveHealth{Status: "Current", Reasons: []string{}}
	var statuses []string
	reasons := map[string]bool{}
	for _, n := range nodes {
		if n.Member {
			statuses = append(statuses, n.Status)
		}
		for _, r := range n.Reasons {
			reasons[r] = true
		}
		if len(n.Key) < 5 || n.Key[len(n.Key)-5:] != "__Pod" {
			continue
		}
		h.Pods++
		ready, running := true, 0
		for _, c := range n.Containers {
			h.Restarts += c.RestartCount
			if !c.Init {
				running++
				ready = ready && c.Ready
			}
		}
		if running > 0 && ready {
			h.ReadyPods++
		}
	}
	switch {
	case slices.Contains(statuses, "Failed"):
		h.Status = "Failed"
	case slices.Contains(statuses, "Unknown"):
		h.Status = "Unknown"
	case slices.ContainsFunc(statuses, func(s string) bool { return s != "Current" }):
		h.Status = "InProgress"
	}
	for _, r := range live.LiveReasons {
		if reasons[r] {
			h.Reasons = append(h.Reasons, r)
		}
	}
	return h
}

func TestRecordedScenarios(t *testing.T) {
	for scenario, reason := range recordedScenarios {
		t.Run(scenario, func(t *testing.T) {
			file, err := os.Open(filepath.Join("testdata/kind", scenario+".ndjson"))
			if err != nil {
				t.Fatal(err)
			}
			defer file.Close()
			nodes := map[string]protocol.ResourceNode{}
			synced, stopped := false, false
			scanner := bufio.NewScanner(file)
			scanner.Buffer(nil, 1<<20)
			for scanner.Scan() {
				line := scanner.Bytes()
				msg, err := protocol.DecodeMessage(line)
				if err != nil {
					t.Fatalf("%s: %v", line, err)
				}
				// Every recorded line is exactly what the engine writes today.
				encoded, err := protocol.Encode(msg)
				if err != nil {
					t.Fatal(err)
				}
				if !bytes.Equal(encoded, line) {
					t.Fatalf("protocol drifted from the recording:\nrecorded %s\nencodes  %s", line, encoded)
				}
				switch m := msg.(type) {
				case protocol.Node:
					nodes[m.Node.Key] = m.Node
				case protocol.Removed:
					delete(nodes, m.Key)
				case protocol.Synced:
					synced = true
				case protocol.Stopping:
					stopped = true
				}
			}
			if err := scanner.Err(); err != nil {
				t.Fatal(err)
			}
			if !synced || !stopped {
				t.Errorf("recording incomplete: synced %v, stopping %v", synced, stopped)
			}
			health := fold(nodes)
			if !slices.Contains(health.Reasons, reason) {
				t.Errorf("health reasons %v lack %s", health.Reasons, reason)
			}
			compareGolden(t, filepath.Join("testdata/kind", scenario+".health.json"), health)
		})
	}
}
