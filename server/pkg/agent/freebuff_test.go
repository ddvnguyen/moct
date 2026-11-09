package agent

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/multica-ai/multica/server/pkg/freebuffrt"
)

// fakeFreebuff is an in-memory orchestrator client. Calling PostMessage
// starts a scripted turn: the events are delivered on the stream and the
// thread snapshot flips from running to idle.
type fakeFreebuff struct {
	mu          sync.Mutex
	authed      bool
	threads     map[string]*freebuffrt.Thread
	events      chan freebuffrt.Event
	script      []string
	outcome     string
	stopped     bool
	posted      string
	createCwd   string
	createModel string
	createErr   error
	holdTurn    bool
}

func newFakeFreebuff() *fakeFreebuff {
	return &fakeFreebuff{authed: true, threads: map[string]*freebuffrt.Thread{}, events: make(chan freebuffrt.Event, 32), outcome: "completed"}
}

func (f *fakeFreebuff) AuthStatus(context.Context) (freebuffrt.AuthStatus, error) {
	return freebuffrt.AuthStatus{Authed: f.authed}, nil
}

func (f *fakeFreebuff) Events(ctx context.Context) (<-chan freebuffrt.Event, func() error, error) {
	return f.events, func() error { return nil }, nil
}

func (f *fakeFreebuff) CreateThreadWithModel(_ context.Context, cwd, model string) (freebuffrt.Thread, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.createCwd = cwd
	f.createModel = model
	if f.createErr != nil {
		return freebuffrt.Thread{}, f.createErr
	}
	var modelPtr *string
	if model != "" {
		modelPtr = new(model)
	}
	t := &freebuffrt.Thread{ID: "t1", TurnState: "idle", Model: modelPtr}
	f.threads[t.ID] = t
	return *t, nil
}

func (f *fakeFreebuff) GetThread(_ context.Context, id string) (freebuffrt.Thread, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	t, ok := f.threads[id]
	if !ok {
		return freebuffrt.Thread{}, &freebuffrt.APIError{Status: 404, Message: "not found"}
	}
	return *t, nil
}

func (f *fakeFreebuff) PostMessage(_ context.Context, id, text string) error {
	f.mu.Lock()
	t := f.threads[id]
	f.posted = text
	t.TurnState = "running"
	script, hold := f.script, f.holdTurn
	f.mu.Unlock()
	go func() {
		for _, raw := range script {
			var head struct {
				Type string `json:"type"`
			}
			_ = json.Unmarshal([]byte(raw), &head)
			f.events <- freebuffrt.Event{Type: head.Type, Raw: json.RawMessage(raw)}
		}
		if hold {
			return
		}
		f.mu.Lock()
		t.TurnState = "idle"
		o := f.outcome
		t.LastTurnOutcome = &o
		f.mu.Unlock()
		f.events <- freebuffrt.Event{Type: "finish", Raw: json.RawMessage(`{"type":"finish"}`)}
	}()
	return nil
}

func (f *fakeFreebuff) StopTurn(context.Context, string) error {
	f.mu.Lock()
	f.stopped = true
	f.mu.Unlock()
	return nil
}

func runFake(t *testing.T, f *fakeFreebuff, opts ExecOptions) (Result, []Message) {
	t.Helper()
	b := &freebuffBackend{cfg: Config{}}
	msgCh := make(chan Message, 64)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	res := b.run(ctx, f, "do it", opts, msgCh)
	close(msgCh)
	var msgs []Message
	for m := range msgCh {
		msgs = append(msgs, m)
	}
	return res, msgs
}

func TestFreebuffRunCompletes(t *testing.T) {
	f := newFakeFreebuff()
	f.script = []string{
		`{"type":"reasoning_delta","text":"thinking"}`,
		`{"type":"text","text":"hel"}`,
		`{"type":"thread","threadId":"other","event":{"type":"text","text":"NOT MINE"}}`,
		`{"type":"thread","threadId":"t1","event":{"type":"text","text":"lo"}}`,
	}
	res, msgs := runFake(t, f, ExecOptions{Cwd: "/work"})
	if res.Status != "completed" || res.Output != "hello" || res.SessionID != "t1" {
		t.Fatalf("result = %+v", res)
	}
	if f.createCwd != "/work" || f.posted != "do it" {
		t.Fatalf("cwd=%q posted=%q", f.createCwd, f.posted)
	}
	var kinds []string
	for _, m := range msgs {
		kinds = append(kinds, string(m.Type))
	}
	if got := strings.Join(kinds, ","); got != "status,thinking,text,text" {
		t.Fatalf("message kinds = %s", got)
	}
	if msgs[0].SessionID != "t1" {
		t.Fatalf("status message must pin the session id: %+v", msgs[0])
	}
}

func TestFreebuffRunRequiresSignedInAccount(t *testing.T) {
	f := newFakeFreebuff()
	f.authed = false
	res, _ := runFake(t, f, ExecOptions{Cwd: "/work"})
	if res.Status != "failed" || !strings.Contains(res.Error, "not signed in") {
		t.Fatalf("result = %+v", res)
	}
}

func TestFreebuffRunReportsThreadlessEngine(t *testing.T) {
	f := newFakeFreebuff()
	f.createErr = &freebuffrt.APIError{Status: 404, Message: "not found"}
	res, _ := runFake(t, f, ExecOptions{Cwd: "/work", Model: "m"})
	if res.Status != "failed" || !strings.Contains(res.Error, "no local thread API") {
		t.Fatalf("result = %+v", res)
	}
}

func TestFreebuffRunFailedOutcome(t *testing.T) {
	f := newFakeFreebuff()
	f.outcome = "errored"
	res, _ := runFake(t, f, ExecOptions{Cwd: "/work"})
	if res.Status != "failed" || !strings.Contains(res.Error, "errored") {
		t.Fatalf("result = %+v", res)
	}
}

func TestFreebuffResumeRejectedWhenThreadMissing(t *testing.T) {
	f := newFakeFreebuff()
	res, _ := runFake(t, f, ExecOptions{Cwd: "/work", ResumeSessionID: "gone"})
	if !res.ResumeRejected || res.Status != "failed" {
		t.Fatalf("result = %+v", res)
	}
}

func TestFreebuffResumeUsesExistingThread(t *testing.T) {
	f := newFakeFreebuff()
	f.threads["old"] = &freebuffrt.Thread{ID: "old", TurnState: "idle"}
	res, _ := runFake(t, f, ExecOptions{Cwd: "/work", ResumeSessionID: "old"})
	if res.Status != "completed" || res.SessionID != "old" || f.createCwd != "" {
		t.Fatalf("result = %+v createCwd=%q", res, f.createCwd)
	}
}

func TestFreebuffRunPinsTheModelOnThreadCreation(t *testing.T) {
	f := newFakeFreebuff()
	res, _ := runFake(t, f, ExecOptions{Cwd: "/work", Model: "luna"})
	if res.Status != "completed" {
		t.Fatalf("result = %+v", res)
	}
	if f.createModel != "luna" || f.createCwd != "/work" {
		t.Fatalf("createModel=%q createCwd=%q", f.createModel, f.createCwd)
	}
}

func TestFreebuffRunWithoutModelUsesDefaultThread(t *testing.T) {
	f := newFakeFreebuff()
	res, _ := runFake(t, f, ExecOptions{Cwd: "/work"})
	if res.Status != "completed" {
		t.Fatalf("result = %+v", res)
	}
	if f.createModel != "" {
		t.Fatalf("createModel=%q, want empty", f.createModel)
	}
}

func TestFreebuffResumeKeepsThreadOnModelMatch(t *testing.T) {
	f := newFakeFreebuff()
	f.threads["old"] = &freebuffrt.Thread{ID: "old", TurnState: "idle", Model: new("luna")}
	res, _ := runFake(t, f, ExecOptions{Cwd: "/work", ResumeSessionID: "old", Model: "luna"})
	if res.Status != "completed" || res.SessionID != "old" || f.createCwd != "" {
		t.Fatalf("result = %+v createCwd=%q", res, f.createCwd)
	}
}

func TestFreebuffResumeForksThreadOnModelChange(t *testing.T) {
	f := newFakeFreebuff()
	f.threads["old"] = &freebuffrt.Thread{ID: "old", TurnState: "idle", Model: new("luna")}
	res, _ := runFake(t, f, ExecOptions{Cwd: "/work", ResumeSessionID: "old", Model: "solar"})
	if res.Status != "completed" || res.SessionID != "t1" {
		t.Fatalf("result = %+v", res)
	}
	if f.createModel != "solar" || f.createCwd != "/work" {
		t.Fatalf("createModel=%q createCwd=%q", f.createModel, f.createCwd)
	}
}

func TestFreebuffCancelStopsTurn(t *testing.T) {
	f := newFakeFreebuff()
	f.holdTurn = true
	f.script = []string{`{"type":"text","text":"working"}`}
	b := &freebuffBackend{cfg: Config{}}
	msgCh := make(chan Message, 64)
	ctx, cancel := context.WithCancel(context.Background())
	go func() {
		time.Sleep(200 * time.Millisecond)
		cancel()
	}()
	res := b.run(ctx, f, "go", ExecOptions{Cwd: "/work"}, msgCh)
	if res.Status != "cancelled" || res.Output != "working" {
		t.Fatalf("result = %+v", res)
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	if !f.stopped {
		t.Fatal("StopTurn was not called")
	}
}

func TestFreebuffExecuteStartFailure(t *testing.T) {
	cfg := Config{RuntimeID: "rt1", Env: map[string]string{FreebuffEnvProfilesDir: t.TempDir()}}
	if _, err := EnsureFreebuffAccountDir(cfg, "a1"); err != nil {
		t.Fatal(err)
	}
	b := &freebuffBackend{cfg: cfg,
		start: func(context.Context, Config, string) (*FreebuffOrchestrator, error) {
			return nil, errors.New("no bundle")
		}}
	if _, err := b.Execute(context.Background(), "x", ExecOptions{Cwd: "/w"}); err == nil || !strings.Contains(err.Error(), "no bundle") {
		t.Fatalf("err = %v", err)
	}
	if _, err := b.Execute(context.Background(), "x", ExecOptions{}); err == nil {
		t.Fatal("missing cwd must fail")
	}
}

func TestFreebuffProfileDir(t *testing.T) {
	got, err := FreebuffProfileDir(Config{RuntimeID: "rt1", Env: map[string]string{FreebuffEnvProfilesDir: "/acct"}})
	if err != nil || got != "/acct/rt1" {
		t.Fatalf("got %q %v", got, err)
	}
	if _, err := FreebuffProfileDir(Config{RuntimeID: "rt1", Env: map[string]string{FreebuffEnvProfilesDir: "rel"}}); err == nil {
		t.Fatal("relative root must fail")
	}
	for _, id := range []string{"../x", "a/b", ".."} {
		if _, err := FreebuffProfileDir(Config{RuntimeID: id, Env: map[string]string{FreebuffEnvProfilesDir: "/acct"}}); err == nil {
			t.Errorf("runtime id %q accepted", id)
		}
	}
	if got, _ := FreebuffProfileDir(Config{Env: map[string]string{FreebuffEnvProfilesDir: "/acct"}}); got != "/acct/default" {
		t.Errorf("default runtime dir = %q", got)
	}
}

func TestFreebuffExecuteNeedsAnAccount(t *testing.T) {
	b := &freebuffBackend{cfg: Config{RuntimeID: "rt1", Env: map[string]string{FreebuffEnvProfilesDir: t.TempDir()}}}
	if _, err := b.Execute(context.Background(), "x", ExecOptions{Cwd: "/w"}); !errors.Is(err, ErrNoFreebuffAccount) {
		t.Fatalf("err = %v, want ErrNoFreebuffAccount", err)
	}
}

func TestFreebuffAccountForRun(t *testing.T) {
	cfg := Config{RuntimeID: "rt1", Env: map[string]string{FreebuffEnvProfilesDir: t.TempDir()}}
	mk := func(ids ...string) {
		for _, id := range ids {
			if _, err := EnsureFreebuffAccountDir(cfg, id); err != nil {
				t.Fatal(err)
			}
		}
	}

	if _, err := FreebuffAccountForRun(cfg); !errors.Is(err, ErrNoFreebuffAccount) {
		t.Fatalf("no accounts: err = %v", err)
	}
	mk("only")
	if got, err := FreebuffAccountForRun(cfg); err != nil || got != "only" {
		t.Fatalf("a single account is the default: %q %v", got, err)
	}
	mk("second")
	if _, err := FreebuffAccountForRun(cfg); !errors.Is(err, ErrNoFreebuffAccount) {
		t.Fatalf("two accounts and no default must not guess: err = %v", err)
	}
	if err := SetFreebuffDefaultAccount(cfg, "second"); err != nil {
		t.Fatal(err)
	}
	if got, _ := FreebuffAccountForRun(cfg); got != "second" {
		t.Fatalf("default = %q", got)
	}
	// The agent's env wins over the runtime default.
	cfg.Env[FreebuffEnvAccount] = "only"
	if got, _ := FreebuffAccountForRun(cfg); got != "only" {
		t.Fatalf("env override = %q", got)
	}
	cfg.Env[FreebuffEnvAccount] = "ghost"
	if _, err := FreebuffAccountForRun(cfg); err == nil {
		t.Fatal("an account that is not on disk must fail")
	}
	delete(cfg.Env, FreebuffEnvAccount)

	// A default that was removed from disk must not be followed.
	if err := RemoveFreebuffAccount(cfg, "second"); err != nil {
		t.Fatal(err)
	}
	if _, err := FreebuffAccountForRun(cfg); err == nil {
		t.Fatal("a removed default account must fail, not fall back silently")
	}
}

func TestFreebuffAccountIDs(t *testing.T) {
	for _, ok := range []string{"a1", "a1b2c3d4", "work-2"} {
		if !ValidFreebuffAccountID(ok) {
			t.Errorf("%q rejected", ok)
		}
	}
	for _, bad := range []string{"", "../x", "a/b", "A1", "-x", ".", strings.Repeat("a", 33)} {
		if ValidFreebuffAccountID(bad) {
			t.Errorf("%q accepted", bad)
		}
	}
	if id := NewFreebuffAccountID(); !ValidFreebuffAccountID(id) {
		t.Errorf("generated id %q is invalid", id)
	}
}
