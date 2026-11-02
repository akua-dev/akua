package live

import (
	"reflect"
	"testing"

	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"sigs.k8s.io/yaml"

	"github.com/akua-dev/akua/packages/cluster-agent/engine/internal/protocol"
)

func parse(t *testing.T, manifest string) *unstructured.Unstructured {
	t.Helper()
	encoded, err := yaml.YAMLToJSON([]byte(manifest))
	if err != nil {
		t.Fatal(err)
	}
	u := &unstructured.Unstructured{}
	if err := u.UnmarshalJSON(encoded); err != nil {
		t.Fatal(err)
	}
	return u
}

const crashLoopingPod = `
apiVersion: v1
kind: Pod
metadata: {name: web-1, namespace: shop, uid: p1, creationTimestamp: "2026-01-01T00:00:00Z"}
spec:
  restartPolicy: Always
  initContainers: [{name: migrate, image: m}]
  containers: [{name: app, image: a}, {name: sidecar, image: s}]
status:
  phase: Running
  conditions: [{type: Ready, status: "False"}]
  initContainerStatuses:
  - name: migrate
    ready: true
    restartCount: 0
    state: {terminated: {reason: Completed, exitCode: 0, finishedAt: "2026-01-01T00:00:10Z"}}
  containerStatuses:
  - name: app
    ready: false
    restartCount: 7
    state: {waiting: {reason: CrashLoopBackOff, message: "back-off 5m0s restarting failed container"}}
    lastState: {terminated: {reason: OOMKilled, exitCode: 137, finishedAt: "2026-01-01T00:05:00Z"}}
  - name: sidecar
    ready: true
    restartCount: 0
    state: {running: {startedAt: "2026-01-01T00:00:11Z"}}
`

func TestDescribeCrashLoopingPod(t *testing.T) {
	d := Describe(parse(t, crashLoopingPod), nil)
	if d.Status != "Failed" {
		t.Errorf("status = %s (%s)", d.Status, d.Message)
	}
	if want := []string{"CrashLoopBackOff", "OOMKilled"}; !reflect.DeepEqual(d.Reasons, want) {
		t.Errorf("reasons = %v, want %v", d.Reasons, want)
	}
	want := []protocol.ContainerState{
		{
			Name: "migrate", Init: true, Ready: true,
			State: protocol.StateValue{Terminated: &protocol.Termination{Reason: "Other", ExitCode: 0, FinishedAt: 1767225610000}},
		},
		{
			Name: "app", RestartCount: 7,
			State:           protocol.StateValue{Waiting: &protocol.Waiting{Reason: "CrashLoopBackOff", Message: "back-off 5m0s restarting failed container"}},
			LastTermination: &protocol.Termination{Reason: "OOMKilled", ExitCode: 137, FinishedAt: 1767225900000},
		},
		{
			Name: "sidecar", Ready: true,
			State: protocol.StateValue{Running: &protocol.Running{StartedAt: 1767225611000}},
		},
	}
	if !reflect.DeepEqual(d.Containers, want) {
		t.Errorf("containers =\n%+v\nwant\n%+v", d.Containers, want)
	}
	if d.Scheduling != nil {
		t.Errorf("scheduling = %+v", d.Scheduling)
	}
}

func TestDescribeUnschedulablePod(t *testing.T) {
	d := Describe(parse(t, `
apiVersion: v1
kind: Pod
metadata: {name: big, namespace: shop, creationTimestamp: "2026-01-01T00:00:00Z"}
spec: {containers: [{name: app, image: a}]}
status:
  phase: Pending
  conditions:
  - {type: PodScheduled, status: "False", reason: Unschedulable, message: "0/1 nodes are available: 1 Insufficient memory."}
`), nil)
	if d.Status != "Failed" || !reflect.DeepEqual(d.Reasons, []string{"Unschedulable"}) {
		t.Errorf("got %s %v", d.Status, d.Reasons)
	}
	if d.Scheduling == nil || d.Scheduling.Reason != "Unschedulable" || d.Scheduling.Message != "0/1 nodes are available: 1 Insufficient memory." {
		t.Errorf("scheduling = %+v", d.Scheduling)
	}
	if len(d.Containers) != 0 {
		t.Errorf("containers without status reported: %+v", d.Containers)
	}
}

func TestDescribeWaitingReasons(t *testing.T) {
	cases := map[string]struct {
		reason  string
		state   string
		reasons []string
	}{
		"ImagePullBackOff":           {"ImagePullBackOff", "ImagePullBackOff", []string{"ImagePullBackOff"}},
		"ErrImagePull":               {"ErrImagePull", "ErrImagePull", []string{"ErrImagePull"}},
		"CreateContainerConfigError": {"CreateContainerConfigError", "CreateContainerConfigError", []string{"CreateContainerConfigError"}},
		"InvalidImageName":           {"InvalidImageName", "Other", []string{"Other"}},
		"ContainerCreating":          {"ContainerCreating", "Other", nil},
	}
	for name, tc := range cases {
		t.Run(name, func(t *testing.T) {
			d := Describe(parse(t, `
apiVersion: v1
kind: Pod
metadata: {name: p, namespace: ns}
spec: {containers: [{name: app, image: a}]}
status:
  phase: Pending
  containerStatuses:
  - {name: app, ready: false, restartCount: 0, state: {waiting: {reason: `+tc.reason+`, message: m}}}
`), nil)
			w := d.Containers[0].State.Waiting
			if w == nil || w.Reason != tc.state {
				t.Fatalf("state = %+v", d.Containers[0].State)
			}
			if tc.state == "Other" && w.Message != tc.reason+": m" {
				t.Errorf("Other keeps the raw reason in the message, got %q", w.Message)
			}
			if !reflect.DeepEqual(d.Reasons, tc.reasons) {
				t.Errorf("reasons = %v, want %v", d.Reasons, tc.reasons)
			}
		})
	}
}

func TestDescribeFailedMountFromWarnings(t *testing.T) {
	pod := parse(t, `
apiVersion: v1
kind: Pod
metadata: {name: p, namespace: ns}
spec: {containers: [{name: app, image: a}]}
status:
  phase: Pending
  conditions: [{type: PodScheduled, status: "True"}]
  containerStatuses:
  - {name: app, ready: false, restartCount: 0, state: {waiting: {reason: ContainerCreating}}}
`)
	if d := Describe(pod, []string{"FailedMount"}); !reflect.DeepEqual(d.Reasons, []string{"FailedMount"}) {
		t.Errorf("reasons = %v", d.Reasons)
	}
	if d := Describe(pod, []string{"BackOff"}); len(d.Reasons) != 0 {
		t.Errorf("unrelated warning became a reason: %v", d.Reasons)
	}
}

func TestDescribeEvictedPod(t *testing.T) {
	d := Describe(parse(t, `
apiVersion: v1
kind: Pod
metadata: {name: p, namespace: ns}
spec: {containers: [{name: app, image: a}]}
status: {phase: Failed, reason: Evicted, message: "The node was low on resource: memory."}
`), nil)
	if !reflect.DeepEqual(d.Reasons, []string{"Evicted"}) {
		t.Errorf("reasons = %v", d.Reasons)
	}
}

func TestDescribeWorkloadConditions(t *testing.T) {
	deployment := Describe(parse(t, `
apiVersion: apps/v1
kind: Deployment
metadata: {name: d, namespace: ns, generation: 2}
spec: {replicas: 1}
status:
  observedGeneration: 2
  conditions:
  - {type: Progressing, status: "False", reason: ProgressDeadlineExceeded, message: "ReplicaSet has timed out progressing."}
`), nil)
	if !reflect.DeepEqual(deployment.Reasons, []string{"ProgressDeadlineExceeded"}) {
		t.Errorf("deployment reasons = %v", deployment.Reasons)
	}
	job := Describe(parse(t, `
apiVersion: batch/v1
kind: Job
metadata: {name: j, namespace: ns}
spec: {}
status:
  conditions:
  - {type: Failed, status: "True", reason: BackoffLimitExceeded, message: "Job has reached the specified backoff limit"}
`), nil)
	if job.Status != "Failed" || !reflect.DeepEqual(job.Reasons, []string{"BackoffLimitExceeded"}) {
		t.Errorf("job = %s %v", job.Status, job.Reasons)
	}
	other := Describe(parse(t, `
apiVersion: batch/v1
kind: Job
metadata: {name: j, namespace: ns}
spec: {}
status:
  conditions:
  - {type: Failed, status: "True", reason: DeadlineExceeded}
`), nil)
	if !reflect.DeepEqual(other.Reasons, []string{"Other"}) {
		t.Errorf("job reasons = %v", other.Reasons)
	}
}

func TestDescribeCustomResourceHasNoReasons(t *testing.T) {
	d := Describe(parse(t, `
apiVersion: example.com/v1
kind: Widget
metadata: {name: w, namespace: ns}
status:
  conditions: [{type: Ready, status: "False", reason: CrashLoopBackOff}]
`), []string{"FailedMount"})
	if len(d.Reasons) != 0 || len(d.Containers) != 0 || d.Scheduling != nil {
		t.Errorf("got %+v", d)
	}
}
