package agent

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/multica-ai/multica/server/pkg/freebuffrt"
)

// freebuffBackend implements Backend by running Freebuff's own orchestrator
// (the process behind the Desktop app) headless and driving it over its local
// HTTP/SSE API. The Freebuff CLI is a TUI with no machine interface, so the
// orchestrator is the reusable core; this file only wraps it.
//
// One orchestrator process is started per task and torn down with it. Its
// state directory (the profile) holds the account login and the threads, so a
// profile is an account, and ResumeSessionID is an orchestrator thread id.
type freebuffBackend struct {
	cfg Config
	// start launches an orchestrator. Tests replace it; production uses
	// StartFreebuffOrchestrator.
	start func(ctx context.Context, cfg Config, profileDir string) (*FreebuffOrchestrator, error)
}

// Environment knobs read from Config.Env (the runtime profile's env).
const (
	// FreebuffEnvProfilesDir is the root under which each runtime's account
	// profile (the orchestrator state dir) lives, one subdirectory per runtime.
	FreebuffEnvProfilesDir = "FREEBUFF_PROFILES_DIR"
	// FreebuffEnvBunPath overrides the Bun executable the orchestrator runs on.
	FreebuffEnvBunPath = "FREEBUFF_BUN_PATH"
	// FreebuffEnvAppVersion pins which installed orchestrator bundle version
	// runs (see freebuffrt.EnvAppVersion). Empty means the legacy resolution
	// order.
	FreebuffEnvAppVersion = freebuffrt.EnvAppVersion
)

const (
	freebuffReadyTimeout     = 30 * time.Second
	freebuffPollInterval     = time.Second
	freebuffTurnStartTimeout = 90 * time.Second
	freebuffStopGrace        = 5 * time.Second
	freebuffDrainQuiet       = 150 * time.Millisecond
)

// FreebuffOrchestrator is a running headless orchestrator and a client for it.
type FreebuffOrchestrator struct {
	Client *freebuffrt.Client

	cmd    *exec.Cmd
	cancel context.CancelFunc
	done   chan struct{}
	once   sync.Once
}

// Stop terminates the orchestrator and its process group. Safe to call twice.
func (o *FreebuffOrchestrator) Stop() {
	o.once.Do(func() {
		o.cancel()
		select {
		case <-o.done:
		case <-time.After(freebuffStopGrace):
		}
	})
}

// freebuffSetting reads a Freebuff setting from the runtime env, then from the
// daemon's own environment, so a host can configure it either way.
func freebuffSetting(cfg Config, key string) string {
	if v := strings.TrimSpace(cfg.Env[key]); v != "" {
		return v
	}
	return strings.TrimSpace(os.Getenv(key))
}

// FreebuffProfileDir resolves the directory that holds a runtime's accounts
// (see freebuff_accounts.go).
func FreebuffProfileDir(cfg Config) (string, error) {
	root := freebuffSetting(cfg, FreebuffEnvProfilesDir)
	if root == "" {
		home, err := os.UserHomeDir()
		if err != nil {
			return "", fmt.Errorf("resolve freebuff profile dir: %w", err)
		}
		root = filepath.Join(home, ".config", "multica", "freebuff")
	}
	if err := freebuffrt.ValidateProfileDir(root); err != nil {
		return "", err
	}
	name := cfg.RuntimeID
	if name == "" {
		name = "default"
	}
	if name != filepath.Base(name) || strings.ContainsAny(name, `/\`) || name == "." || name == ".." {
		return "", fmt.Errorf("invalid freebuff runtime id %q", name)
	}
	return filepath.Join(root, name), nil
}

// FreebuffBundleDir returns the bundle root the runtime env (or the daemon's
// own environment) points at, or "" when neither does. The version store
// lives under it (see freebuffrt.VersionsDir).
func FreebuffBundleDir(cfg Config) string {
	return freebuffSetting(cfg, freebuffrt.EnvRuntimeDir)
}

func freebuffBunPath(cfg Config) (string, error) {
	if p := freebuffSetting(cfg, FreebuffEnvBunPath); p != "" {
		return p, nil
	}
	if p, err := exec.LookPath("bun"); err == nil {
		return p, nil
	}
	if home, err := os.UserHomeDir(); err == nil {
		p := filepath.Join(home, ".bun", "bin", "bun")
		if fi, err := os.Stat(p); err == nil && !fi.IsDir() {
			return p, nil
		}
	}
	return "", errors.New("bun not found: install Bun (>=1.4) or set " + FreebuffEnvBunPath)
}

// StartFreebuffOrchestrator launches the orchestrator for profileDir and waits
// until it announces readiness and answers its health check. It is shared by
// the task backend and the daemon's account probe so both launch it the same
// way.
func StartFreebuffOrchestrator(ctx context.Context, cfg Config, profileDir string) (*FreebuffOrchestrator, error) {
	if cfg.Logger == nil {
		cfg.Logger = defaultLogger()
	}
	home, _ := os.UserHomeDir()
	bundle, err := freebuffrt.ResolveBundle(map[string]string{
		freebuffrt.EnvRuntimeDir: freebuffSetting(cfg, freebuffrt.EnvRuntimeDir),
		freebuffrt.EnvAppPath:    freebuffSetting(cfg, freebuffrt.EnvAppPath),
		freebuffrt.EnvAppVersion: freebuffSetting(cfg, freebuffrt.EnvAppVersion),
	}, home)
	if err != nil {
		return nil, err
	}
	// Record which bundle version serves the run: the manifest's version and
	// build commit when the bundle carries one, else its directory name.
	version, commit := bundle.Version()
	if version != "" {
		cfg.Logger.Info("freebuff orchestrator bundle",
			"bundle_dir", bundle.ResourcesDir, "version", version, "commit", commit,
			"pinned", freebuffSetting(cfg, freebuffrt.EnvAppVersion) != "")
	}
	bun, err := freebuffBunPath(cfg)
	if err != nil {
		return nil, err
	}
	if err := os.MkdirAll(profileDir, 0o700); err != nil {
		return nil, fmt.Errorf("create freebuff profile: %w", err)
	}

	launchID := freebuffrt.NewLaunchID()
	env := map[string]string{}
	for k, v := range cfg.Env {
		env[k] = v
	}
	for k, v := range freebuffrt.LaunchEnv(bundle, profileDir, launchID) {
		env[k] = v
	}

	runCtx, cancel := context.WithCancel(context.Background())
	cmd := cfg.commandAt(bun).exec(runCtx, bundle.OrchestratorPath())
	hideAgentWindow(cmd)
	cfg.logAgentCommand(cmd, newAgentCommandLogArgs([]string{bundle.OrchestratorPath()}))
	cmd.Dir = filepath.Dir(bundle.OrchestratorPath())
	cmd.Env = buildEnv(env)
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		cancel()
		return nil, err
	}
	stderr, err := cmd.StderrPipe()
	if err != nil {
		cancel()
		return nil, err
	}
	if err := startOwnedProcessTree(cmd, cfg.Logger); err != nil {
		cancel()
		return nil, fmt.Errorf("start freebuff orchestrator: %w", err)
	}

	o := &FreebuffOrchestrator{cmd: cmd, cancel: cancel, done: make(chan struct{})}
	readyCh := make(chan freebuffrt.Ready, 1)
	go func() {
		sc := bufio.NewScanner(stdout)
		sc.Buffer(make([]byte, 0, 64*1024), 4<<20)
		sent := false
		for sc.Scan() {
			line := sc.Text()
			if r, ok := freebuffrt.ParseReady(line); ok && !sent {
				sent = true
				readyCh <- r
				continue
			}
			cfg.Logger.Debug("[freebuff:stdout] " + line)
		}
	}()
	go func() {
		sc := bufio.NewScanner(stderr)
		sc.Buffer(make([]byte, 0, 64*1024), 4<<20)
		for sc.Scan() {
			cfg.Logger.Debug("[freebuff:stderr] " + sc.Text())
		}
	}()
	go func() {
		defer close(o.done)
		_ = cmd.Wait()
	}()

	select {
	case r := <-readyCh:
		o.Client = freebuffrt.NewClient(r, launchID)
	case <-o.done:
		cancel()
		return nil, errors.New("freebuff orchestrator exited before it was ready (is another orchestrator using this profile?)")
	case <-time.After(freebuffReadyTimeout):
		o.Stop()
		return nil, fmt.Errorf("freebuff orchestrator not ready within %s", freebuffReadyTimeout)
	case <-ctx.Done():
		o.Stop()
		return nil, ctx.Err()
	}
	if err := o.Client.Health(ctx); err != nil {
		o.Stop()
		return nil, err
	}
	return o, nil
}

func (b *freebuffBackend) Execute(ctx context.Context, prompt string, opts ExecOptions) (*Session, error) {
	if opts.Cwd == "" {
		return nil, errors.New("freebuff requires a working directory")
	}
	accountID, err := FreebuffAccountForRun(b.cfg)
	if err != nil {
		return nil, err
	}
	profileDir, err := FreebuffAccountDir(b.cfg, accountID)
	if err != nil {
		return nil, err
	}
	start := b.start
	if start == nil {
		start = StartFreebuffOrchestrator
	}

	runCtx, cancel := runContext(ctx, opts.Timeout)
	orch, err := start(runCtx, b.cfg, profileDir)
	if err != nil {
		cancel()
		return nil, err
	}

	msgCh := make(chan Message, 256)
	resCh := make(chan Result, 1)
	go func() {
		defer cancel()
		defer orch.Stop()
		started := time.Now()
		res := b.run(runCtx, orch.Client, prompt, opts, msgCh)
		res.DurationMs = time.Since(started).Milliseconds()
		close(msgCh)
		resCh <- res
		close(resCh)
	}()
	return &Session{Messages: msgCh, Result: resCh}, nil
}

// run drives one turn and returns its outcome. It never blocks on msgCh.
func (b *freebuffBackend) run(ctx context.Context, c freebuffClient, prompt string, opts ExecOptions, msgCh chan<- Message) Result {
	fail := func(status, format string, args ...any) Result {
		return Result{Status: status, Error: fmt.Sprintf(format, args...)}
	}

	st, err := c.AuthStatus(ctx)
	if err != nil {
		return fail("failed", "freebuff auth status: %v", err)
	}
	if !st.Authed {
		return fail("failed", "Freebuff account is not signed in: connect it from the runtime page, then retry")
	}

	// Subscribe before sending so no early event is missed.
	events, streamErr, err := c.Events(ctx)
	if err != nil {
		return fail("failed", "freebuff event stream: %v", err)
	}

	threadID := opts.ResumeSessionID
	resumed := threadID != ""
	if resumed {
		t, err := c.GetThread(ctx, threadID)
		if err != nil {
			var apiErr *freebuffAPIError
			if errors.As(err, &apiErr) && apiErr.Status == 404 {
				return Result{Status: "failed", Error: "freebuff thread not found", SessionID: threadID, ResumeRejected: true}
			}
			return fail("failed", "freebuff thread %s: %v", threadID, err)
		}
		// A thread's model is fixed when it is created, so the resumed thread
		// and a newly pinned model can disagree. The turn must honour the
		// pinned model, so the task starts on a fresh thread instead of
		// silently running on the old one's model. A thread snapshot without
		// a model (older orchestrator) can't disagree, so it resumes.
		if opts.Model != "" && t.Model != nil && *t.Model != opts.Model {
			resumed = false
		}
	}
	if !resumed {
		t, err := c.CreateThreadWithModel(ctx, opts.Cwd, opts.Model)
		if err != nil {
			var apiErr *freebuffAPIError
			if errors.As(err, &apiErr) && apiErr.Status == 404 {
				return fail("failed", "freebuff orchestrator has no local thread API (engine too new); pin engine <=0.0.190")
			}
			return fail("failed", "freebuff create thread: %v", err)
		}
		threadID = t.ID
	}
	trySend(msgCh, Message{Type: MessageStatus, Status: "running", SessionID: threadID})

	if err := c.PostMessage(ctx, threadID, prompt); err != nil {
		return Result{Status: "failed", Error: fmt.Sprintf("freebuff send message: %v", err), SessionID: threadID}
	}

	var out strings.Builder
	sawStart := false
	sentAt := time.Now()
	ticker := time.NewTicker(freebuffPollInterval)
	defer ticker.Stop()

	check := func() (done bool, res Result) {
		t, err := c.GetThread(ctx, threadID)
		if err != nil {
			return false, Result{}
		}
		if t.TurnState != "" && t.TurnState != "idle" {
			sawStart = true
			return false, Result{}
		}
		if !sawStart && t.LastTurnOutcome == nil {
			return false, Result{}
		}
		if !sawStart && t.LastTurnOutcome != nil && !sentAtBefore(t, sentAt) {
			// An outcome that predates this message belongs to an earlier turn.
			return false, Result{}
		}
		return true, freebuffResult(t, threadID, out.String())
	}

	// The thread snapshot can flip to idle before the stream has delivered
	// the turn's last text. Once the turn is done, keep reading until the
	// stream has been quiet for freebuffDrainQuiet so no trailing output is lost.
	drain := func() {
		for {
			select {
			case ev, ok := <-events:
				if !ok {
					return
				}
				if m, ok := freebuffMessage(ev, threadID); ok {
					if m.Type == MessageText {
						out.WriteString(m.Content)
					}
					trySend(msgCh, m)
				}
			case <-time.After(freebuffDrainQuiet):
				return
			}
		}
	}

	for {
		select {
		case <-ctx.Done():
			stopCtx, stop := context.WithTimeout(context.Background(), freebuffStopGrace)
			_ = c.StopTurn(stopCtx, threadID)
			stop()
			status := "cancelled"
			if errors.Is(ctx.Err(), context.DeadlineExceeded) {
				status = "timeout"
			}
			return Result{Status: status, Output: out.String(), SessionID: threadID, Error: ctx.Err().Error()}
		case ev, ok := <-events:
			if !ok {
				err := streamErr()
				return Result{Status: "failed", Output: out.String(), SessionID: threadID,
					Error: fmt.Sprintf("freebuff event stream closed: %v", err)}
			}
			if m, ok := freebuffMessage(ev, threadID); ok {
				sawStart = true
				if m.Type == MessageText {
					out.WriteString(m.Content)
				}
				trySend(msgCh, m)
			}
			if ev.Type == "finish" || ev.Type == "thread" {
				if done, res := check(); done {
					drain()
					res.Output = out.String()
					return res
				}
			}
		case <-ticker.C:
			if done, res := check(); done {
				drain()
				res.Output = out.String()
				return res
			}
			if !sawStart && time.Since(sentAt) > freebuffTurnStartTimeout {
				return Result{Status: "failed", SessionID: threadID,
					Error: "freebuff turn did not start (unsupported orchestrator version?)"}
			}
		}
	}
}

// sentAtBefore reports whether the thread's last finished turn is no older
// than the message we sent. Timestamps the orchestrator does not provide are
// treated as current, so a missing field cannot hang a finished turn.
func sentAtBefore(t freebuffThread, sentAt time.Time) bool {
	ms, ok := t.LastTurnFinishedAt.(float64)
	if !ok {
		return true
	}
	return !time.UnixMilli(int64(ms)).Before(sentAt.Add(-2 * time.Second))
}

func freebuffResult(t freebuffThread, threadID, output string) Result {
	res := Result{Status: "completed", Output: output, SessionID: threadID}
	if t.LastTurnOutcome != nil {
		switch o := strings.ToLower(*t.LastTurnOutcome); {
		case o == "completed" || o == "complete" || o == "ok" || o == "success":
		case strings.Contains(o, "stop") || strings.Contains(o, "cancel") || strings.Contains(o, "abort"):
			res.Status = "cancelled"
		default:
			res.Status = "failed"
			res.Error = "freebuff turn ended with outcome " + *t.LastTurnOutcome
		}
	}
	if t.Model != nil && *t.Model != "" {
		res.Usage = map[string]TokenUsage{*t.Model: {}}
	}
	return res
}

// freebuffMessage maps one orchestrator event for threadID to a Message.
//
// Only `text` and `reasoning_delta` are mapped: they are the response events
// the engine emits (the same names the Desktop UI folds into a transcript).
// Events may arrive bare or wrapped in an `event` field with a `threadId`;
// both are accepted. Everything else is ignored here and still serves as a
// liveness signal through the event stream.
func freebuffMessage(ev freebuffEvent, threadID string) (Message, bool) {
	var env struct {
		Type     string          `json:"type"`
		ThreadID string          `json:"threadId"`
		Text     string          `json:"text"`
		Event    json.RawMessage `json:"event"`
	}
	if json.Unmarshal(ev.Raw, &env) != nil {
		return Message{}, false
	}
	if env.ThreadID != "" && env.ThreadID != threadID {
		return Message{}, false
	}
	typ, text := env.Type, env.Text
	if len(env.Event) > 0 {
		var inner struct {
			Type string `json:"type"`
			Text string `json:"text"`
		}
		if json.Unmarshal(env.Event, &inner) == nil && inner.Type != "" {
			typ, text = inner.Type, inner.Text
		}
	}
	switch typ {
	case "text":
		if text == "" {
			return Message{}, false
		}
		return Message{Type: MessageText, Content: text}, true
	case "reasoning_delta":
		if text == "" {
			return Message{}, false
		}
		return Message{Type: MessageThinking, Content: text}, true
	}
	return Message{}, false
}
