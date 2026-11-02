// Package live builds the live-status tree of subscribed Placements:
// ResourceNode, WarningEvent and synced events from the shared informer
// cache.
package live

import (
	"sort"

	"github.com/fluxcd/cli-utils/pkg/kstatus/status"
	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime"

	"github.com/akua-dev/akua/packages/cluster-agent/engine/internal/protocol"
)

// LiveReasons in the order of cluster-agent.ts LiveReason, which is also
// the order a node lists them in.
var LiveReasons = []string{
	"CrashLoopBackOff",
	"ImagePullBackOff",
	"ErrImagePull",
	"CreateContainerConfigError",
	"CreateContainerError",
	"OOMKilled",
	"ContainerError",
	"Unschedulable",
	"FailedMount",
	"Evicted",
	"ProgressDeadlineExceeded",
	"BackoffLimitExceeded",
	"Other",
}

var reasonRank = func() map[string]int {
	m := map[string]int{}
	for i, r := range LiveReasons {
		m[r] = i
	}
	return m
}()

// Waiting reasons of a container on its normal way to running; they are
// shown in the container's state but are not a reason to act.
var benignWaiting = map[string]bool{"ContainerCreating": true, "PodInitializing": true}

// Description is what one object contributes to its ResourceNode besides
// identity and tree position.
type Description struct {
	Status     string
	Message    string
	Reasons    []string
	Containers []protocol.ContainerState
	Scheduling *protocol.Scheduling
}

// Describe computes kstatus and the LiveReasons of one object. warnings
// are the reasons of live Warning events involving it.
func Describe(u *unstructured.Unstructured, warnings []string) Description {
	d := Description{Status: string(status.UnknownStatus)}
	if result, err := status.Compute(u); err != nil {
		d.Message = err.Error()
	} else {
		d.Status, d.Message = string(result.Status), result.Message
	}
	reasons := map[string]bool{}
	gvk := u.GroupVersionKind()
	switch {
	case gvk.Group == "" && gvk.Kind == "Pod":
		describePod(u, warnings, &d, reasons)
	case gvk.Group == "apps" && gvk.Kind == "Deployment":
		if c := condition(u, "Progressing"); c != nil && c.Status == corev1.ConditionFalse {
			reasons[mapCondition(c.Reason, "ProgressDeadlineExceeded")] = true
		}
	case gvk.Group == "apps" && gvk.Kind == "ReplicaSet":
		if c := condition(u, "ReplicaFailure"); c != nil && c.Status == corev1.ConditionTrue {
			reasons["Other"] = true
		}
	case gvk.Group == "batch" && gvk.Kind == "Job":
		if c := condition(u, "Failed"); c != nil && c.Status == corev1.ConditionTrue {
			reasons[mapCondition(c.Reason, "BackoffLimitExceeded")] = true
		}
	}
	d.Reasons = ordered(reasons)
	return d
}

func mapCondition(reason, known string) string {
	if reason == known {
		return known
	}
	return "Other"
}

func ordered(set map[string]bool) []string {
	var out []string
	for r := range set {
		out = append(out, r)
	}
	sort.Slice(out, func(i, j int) bool { return reasonRank[out[i]] < reasonRank[out[j]] })
	return out
}

func condition(u *unstructured.Unstructured, conditionType string) *status.BasicCondition {
	obj, err := status.GetObjectWithConditions(u.Object)
	if err != nil {
		return nil
	}
	for i := range obj.Status.Conditions {
		if string(obj.Status.Conditions[i].Type) == conditionType {
			return &obj.Status.Conditions[i]
		}
	}
	return nil
}

func describePod(u *unstructured.Unstructured, warnings []string, d *Description, reasons map[string]bool) {
	pod := &corev1.Pod{}
	if err := runtime.DefaultUnstructuredConverter.FromUnstructured(u.Object, pod); err != nil {
		reasons["Other"] = true
		d.Message = "undecodable Pod: " + err.Error()
		return
	}
	ready := false
	for _, c := range pod.Status.Conditions {
		switch {
		case c.Type == corev1.PodReady && c.Status == corev1.ConditionTrue:
			ready = true
		case c.Type == corev1.PodScheduled && c.Status == corev1.ConditionFalse:
			reason := "Other"
			message := c.Message
			if c.Reason == "Unschedulable" {
				reason = "Unschedulable"
			} else if c.Reason != "" {
				message = c.Reason + ": " + c.Message
			}
			d.Scheduling = &protocol.Scheduling{Reason: reason, Message: message}
			reasons[reason] = true
		}
	}
	if pod.Status.Phase == corev1.PodFailed {
		if pod.Status.Reason == "Evicted" {
			reasons["Evicted"] = true
		} else if pod.Status.Reason != "" {
			reasons["Other"] = true
		}
	}
	for _, s := range pod.Status.InitContainerStatuses {
		d.Containers = append(d.Containers, containerState(s, true, reasons))
	}
	for _, s := range pod.Status.ContainerStatuses {
		d.Containers = append(d.Containers, containerState(s, false, reasons))
	}
	if !ready && pod.Status.Phase != corev1.PodSucceeded {
		for _, w := range warnings {
			if w == "FailedMount" || w == "FailedAttachVolume" {
				reasons["FailedMount"] = true
			}
		}
	}
}

func containerState(s corev1.ContainerStatus, init bool, reasons map[string]bool) protocol.ContainerState {
	out := protocol.ContainerState{Name: s.Name, Init: init, Ready: s.Ready, RestartCount: s.RestartCount}
	switch {
	case s.State.Waiting != nil:
		w := s.State.Waiting
		reason, message := waitingReason(w.Reason), w.Message
		if reason == "Other" && w.Reason != "" {
			message = w.Reason + ": " + w.Message
		}
		out.State.Waiting = &protocol.Waiting{Reason: reason, Message: message}
		if !benignWaiting[w.Reason] {
			reasons[reason] = true
		}
		if w.Reason == "CrashLoopBackOff" && s.LastTerminationState.Terminated != nil {
			if last := terminationReason(s.LastTerminationState.Terminated); last != "Completed" {
				reasons[last] = true
			}
		}
	case s.State.Running != nil:
		out.State.Running = &protocol.Running{StartedAt: millis(s.State.Running.StartedAt)}
	case s.State.Terminated != nil:
		t := termination(s.State.Terminated)
		out.State.Terminated = &t
		if t.Reason != "Completed" {
			reasons[t.Reason] = true
		}
	default:
		// The kubelet always reports one state; treat an empty one as not
		// started yet.
		out.State.Waiting = &protocol.Waiting{Reason: "Other", Message: "no container state reported"}
	}
	if s.LastTerminationState.Terminated != nil {
		t := termination(s.LastTerminationState.Terminated)
		out.LastTermination = &t
	}
	return out
}

func waitingReason(reason string) string {
	switch reason {
	case "CrashLoopBackOff", "ImagePullBackOff", "ErrImagePull", "CreateContainerConfigError", "CreateContainerError":
		return reason
	}
	return "Other"
}

// terminationReason is a LiveReason, or the benign `Completed` of
// cluster-agent.ts ContainerExitReason for a container that exited 0.
func terminationReason(t *corev1.ContainerStateTerminated) string {
	switch {
	case t.Reason == "OOMKilled":
		return "OOMKilled"
	case t.ExitCode != 0:
		return "ContainerError"
	}
	return "Completed"
}

func termination(t *corev1.ContainerStateTerminated) protocol.Termination {
	return protocol.Termination{Reason: terminationReason(t), ExitCode: t.ExitCode, FinishedAt: millis(t.FinishedAt)}
}

func millis(t metav1.Time) int64 {
	if t.IsZero() {
		return 0
	}
	return t.UnixMilli()
}
