// Command akua-apply is the cluster agent's embedded engine. `akua-apply
// serve` is its only mode: a long-running process without a network
// listener that reads EngineRequest lines on stdin and writes
// EngineResponse and EngineEvent lines on stdout (see
// packages/domains/clusters ClusterAgent.ts), logging to stderr.
package main

import (
	"context"
	"flag"
	"fmt"
	"os"
	"os/signal"
	"runtime/debug"
	"syscall"
	"time"

	"k8s.io/client-go/dynamic"
	"k8s.io/client-go/rest"
	"k8s.io/client-go/tools/clientcmd"
	"k8s.io/klog/v2"
	"sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/controller-runtime/pkg/client/apiutil"
	ctrllog "sigs.k8s.io/controller-runtime/pkg/log"

	"github.com/akua-dev/akua/packages/cluster-agent/engine/internal/cache"
	"github.com/akua-dev/akua/packages/cluster-agent/engine/internal/live"
	"github.com/akua-dev/akua/packages/cluster-agent/engine/internal/ops"
	"github.com/akua-dev/akua/packages/cluster-agent/engine/internal/protocol"
	"github.com/akua-dev/akua/packages/cluster-agent/engine/internal/serve"
)

// version is the agent release the engine ships in, set at link time; the
// agent's /readyz compares it with its own.
var version = "dev"

// ClusterAgent.ts informerCache.safetyNet.
const (
	goMemLimit        = 96 << 20
	maxWatchedObjects = 2000
)

func main() {
	if len(os.Args) < 2 || os.Args[1] != "serve" {
		fmt.Fprintln(os.Stderr, "usage: akua-apply serve --user-agent <agent user agent> [--kubeconfig <path>]")
		os.Exit(2)
	}
	flags := flag.NewFlagSet("serve", flag.ExitOnError)
	userAgent := flags.String("user-agent", "", "User-Agent of every kube-apiserver request; the agent passes its own")
	kubeconfig := flags.String("kubeconfig", "", "kubeconfig to use instead of the in-cluster ServiceAccount (development only)")
	klog.InitFlags(flags)
	_ = flags.Parse(os.Args[2:])

	if err := run(*userAgent, *kubeconfig); err != nil {
		klog.ErrorS(err, "akua-apply serve failed")
		klog.Flush()
		os.Exit(1)
	}
	klog.Flush()
}

func run(userAgent, kubeconfig string) error {
	if os.Getenv("GOMEMLIMIT") == "" {
		debug.SetMemoryLimit(goMemLimit)
	}
	ctrllog.SetLogger(klog.NewKlogr())

	config, err := restConfig(kubeconfig)
	if err != nil {
		return err
	}
	if userAgent == "" {
		userAgent = "akua-apply/" + version
	}
	config.UserAgent = userAgent
	// Every request acts as the apply ServiceAccount: the customer's
	// RoleBindings to it, not the agent's own account, are the authority.
	config.Impersonate = rest.ImpersonationConfig{UserName: protocol.Impersonation}
	config.QPS, config.Burst = 50, 100

	httpClient, err := rest.HTTPClientFor(config)
	if err != nil {
		return err
	}
	mapper, err := apiutil.NewDynamicRESTMapper(config, httpClient)
	if err != nil {
		return err
	}
	kube, err := client.New(config, client.Options{HTTPClient: httpClient, Mapper: mapper})
	if err != nil {
		return err
	}
	dyn, err := dynamic.NewForConfigAndClient(config, httpClient)
	if err != nil {
		return err
	}

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGTERM, syscall.SIGINT)
	defer stop()

	informers := cache.New(dyn, mapper, cache.Options{})
	defer informers.Stop()
	b := &backend{}
	server := serve.New(b, os.Stdout, version)
	b.tracker = live.NewTracker(informers, kube, server.Emit, live.Options{MaxWatchedObjects: maxWatchedObjects})
	defer b.tracker.Stop()
	go b.tracker.WatchLoad(ctx, 2*time.Second)
	b.ops = &ops.Ops{Client: kube, Cache: informers, MemberSelector: b.tracker.MemberSelector, Concurrency: 4}
	return server.Run(ctx, os.Stdin)
}

func restConfig(kubeconfig string) (*rest.Config, error) {
	if kubeconfig != "" {
		return clientcmd.BuildConfigFromFlags("", kubeconfig)
	}
	return rest.InClusterConfig()
}

type backend struct {
	ops     *ops.Ops
	tracker *live.Tracker
}

func (b *backend) Apply(ctx context.Context, r *protocol.Apply) protocol.Applied {
	return b.ops.Apply(ctx, r)
}
func (b *backend) Prune(ctx context.Context, r *protocol.Prune) protocol.Pruned {
	return b.ops.Prune(ctx, r)
}
func (b *backend) Wait(ctx context.Context, r *protocol.Wait) protocol.Waited {
	return b.ops.Wait(ctx, r)
}
func (b *backend) Subscribe(placements []protocol.WatchedPlacement) int {
	return b.tracker.Subscribe(placements)
}
