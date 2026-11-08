package daemon

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/multica-ai/multica/server/pkg/agent"
	"github.com/multica-ai/multica/server/pkg/freebuffrt"
)

// freebuffFixture stands up a Daemon whose Freebuff reports are captured.
type freebuffFixture struct {
	daemon *Daemon

	mu      sync.Mutex
	reports []map[string]any
	pending string // body served for the daemon's pending poll
}

func newFreebuffFixture(t *testing.T) *freebuffFixture {
	t.Helper()
	withFastLocalSkillReportBackoffs(t)

	fx := &freebuffFixture{}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		if r.Method == http.MethodGet {
			fx.mu.Lock()
			body := fx.pending
			fx.mu.Unlock()
			_, _ = w.Write([]byte(body))
			return
		}
		var body map[string]any
		_ = json.NewDecoder(r.Body).Decode(&body)
		fx.mu.Lock()
		fx.reports = append(fx.reports, body)
		fx.mu.Unlock()
		_, _ = w.Write([]byte(`{"status":"ok"}`))
	}))
	t.Cleanup(srv.Close)

	d := freshDaemon(srv.URL)
	fx.daemon = d
	return fx
}

func (fx *freebuffFixture) snapshot() []map[string]any {
	fx.mu.Lock()
	defer fx.mu.Unlock()
	return append([]map[string]any(nil), fx.reports...)
}

// fakeAccount is an orchestrator stand-in for the account flow.
type fakeAccount struct {
	mu         sync.Mutex
	statuses   []freebuffrt.AuthStatus
	authErr    error
	launchID   string
	catalogs   []freebuffrt.ModelCatalog
	catalogErr error
	login      freebuffrt.LoginStart
	loginErr   error
	canceled   bool
	noThreads  bool
}

func (f *fakeAccount) AuthStatus(context.Context) (freebuffrt.AuthStatus, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.authErr != nil {
		return freebuffrt.AuthStatus{}, f.authErr
	}
	st := f.statuses[0]
	if len(f.statuses) > 1 {
		f.statuses = f.statuses[1:]
	}
	return st, nil
}

// ThreadProbe reports whether the fake serves thread routes. Tests set
// noThreads to simulate an engine bundle without them (auth passes, every
// run would 404 on POST /api/threads).
func (f *fakeAccount) ThreadProbe(context.Context) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.noThreads {
		return errors.New("freebuff orchestrator does not serve thread routes")
	}
	return nil
}

func (f *fakeAccount) LaunchID() string { return f.launchID }
func (f *fakeAccount) PID() int         { return 123 }

func TestManagedFreebuffDesktopEnvOverridesUserValues(t *testing.T) {
	env := map[string]string{
		"FREEBUFF_DESKTOP_URL":            "https://untrusted.example",
		"FREEBUFF_DESKTOP_CREDENTIAL_REF": "/wrong-account",
		freebuffDesktopLaunchIDEnv:        "stale",
	}
	applyManagedFreebuffDesktopEnv(env, "http://127.0.0.1:4321", "/account", "fresh-launch")
	if env["FREEBUFF_DESKTOP_URL"] != "http://127.0.0.1:4321" || env["FREEBUFF_DESKTOP_CREDENTIAL_REF"] != "/account" || env[freebuffDesktopLaunchIDEnv] != "fresh-launch" {
		t.Fatalf("managed endpoint, directory, and launch credential must stay paired: %#v", env)
	}
}

func (f *fakeAccount) StartLogin(context.Context) (freebuffrt.LoginStart, error) {
	return f.login, f.loginErr
}

func (f *fakeAccount) ModelCatalog(context.Context) (freebuffrt.ModelCatalog, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.catalogErr != nil {
		return freebuffrt.ModelCatalog{}, f.catalogErr
	}
	if len(f.catalogs) == 0 {
		return freebuffrt.ModelCatalog{}, nil
	}
	cat := f.catalogs[0]
	if len(f.catalogs) > 1 {
		f.catalogs = f.catalogs[1:]
	}
	return cat, nil
}

func (f *fakeAccount) BaseURL() string { return "http://127.0.0.1:4320" }

func (f *fakeAccount) CancelLogin(context.Context) error {
	f.mu.Lock()
	f.canceled = true
	f.mu.Unlock()
	return nil
}

func useFakeAccount(t *testing.T, acct freebuffAccount, startErr error) {
	t.Helper()
	prev := startFreebuffAccount
	startFreebuffAccount = func(context.Context, string, string) (freebuffAccount, func(), error) {
		if startErr != nil {
			return nil, nil, startErr
		}
		return acct, func() {}, nil
	}
	t.Cleanup(func() { startFreebuffAccount = prev })
}

// useProfiles points the Freebuff profile root at a fresh directory.
func useProfiles(t *testing.T) string {
	t.Helper()
	root := t.TempDir()
	t.Setenv(agent.FreebuffEnvProfilesDir, root)
	return root
}

func freebuffRuntime() Runtime {
	return Runtime{ID: "rt-fb", Name: "Freebuff", Provider: freebuffProvider, Status: "online"}
}

func signedIn(email string) freebuffrt.AuthStatus {
	return freebuffrt.AuthStatus{Authed: true, User: json.RawMessage(`{"email":"` + email + `"}`)}
}

// accountReports flattens the account entries of every captured report.
func (fx *freebuffFixture) accountReports() []map[string]any {
	var out []map[string]any
	for _, r := range fx.snapshot() {
		entries, _ := r["accounts"].([]any)
		for _, e := range entries {
			if m, ok := e.(map[string]any); ok {
				out = append(out, m)
			}
		}
	}
	return out
}

func fastLogin(t *testing.T) {
	t.Helper()
	prev := freebuffLoginPollInterval
	freebuffLoginPollInterval = 10 * time.Millisecond
	t.Cleanup(func() { freebuffLoginPollInterval = prev })
}

// The sign-in URL goes out as soon as the orchestrator has it, the outcome
// when the account appears. The account host's page is preferred over the
// loopback one: it is the one that opens from another machine.
func TestHandleFreebuffLogin_ReportsRemoteURLThenOutcome(t *testing.T) {
	fx := newFreebuffFixture(t)
	fastLogin(t)
	useFakeAccount(t, &fakeAccount{
		statuses: []freebuffrt.AuthStatus{{}, {}, signedIn("owner@example.com")},
		login: freebuffrt.LoginStart{
			URL:       "http://127.0.0.1:1234/auth/login/launch/x",
			RemoteURL: "https://freebuff.com/login?auth_code=abc",
		},
	}, nil)
	useProfiles(t)

	fx.daemon.handleFreebuffLogin(context.Background(), freebuffRuntime(), "a1")

	reports := fx.accountReports()
	if len(reports) != 2 {
		t.Fatalf("reports = %#v", reports)
	}
	if reports[0]["state"] != "awaiting_login" || reports[0]["login_url"] != "https://freebuff.com/login?auth_code=abc" {
		t.Fatalf("first report = %#v", reports[0])
	}
	if reports[0]["expires_at"] == nil {
		t.Fatalf("the link's expiry was not reported: %#v", reports[0])
	}
	if reports[1]["state"] != "connected" || reports[1]["label"] != "owner@example.com" || reports[1]["id"] != "a1" {
		t.Fatalf("second report = %#v", reports[1])
	}
}

func TestHandleFreebuffLogin_FallsBackToTheLoopbackURL(t *testing.T) {
	fx := newFreebuffFixture(t)
	fastLogin(t)
	useFakeAccount(t, &fakeAccount{
		statuses: []freebuffrt.AuthStatus{{}, signedIn("a@b.c")},
		login:    freebuffrt.LoginStart{URL: "http://127.0.0.1:1234/auth/login/launch/x"},
	}, nil)
	useProfiles(t)

	fx.daemon.handleFreebuffLogin(context.Background(), freebuffRuntime(), "a1")

	if got := fx.accountReports()[0]["login_url"]; got != "http://127.0.0.1:1234/auth/login/launch/x" {
		t.Fatalf("login_url = %v", got)
	}
}

func TestHandleFreebuffLogin_AlreadySignedIn(t *testing.T) {
	fx := newFreebuffFixture(t)
	useFakeAccount(t, &fakeAccount{statuses: []freebuffrt.AuthStatus{signedIn("a@b.c")}}, nil)
	useProfiles(t)

	fx.daemon.handleFreebuffLogin(context.Background(), freebuffRuntime(), "a1")

	reports := fx.accountReports()
	if len(reports) != 1 || reports[0]["state"] != "connected" {
		t.Fatalf("reports = %#v", reports)
	}
}

func TestHandleFreebuffDesktopLogin_KeepsInstanceUntilDaemonShutdown(t *testing.T) {
	fx := newFreebuffFixture(t)
	fastLogin(t)
	useProfiles(t)
	account := &fakeAccount{statuses: []freebuffrt.AuthStatus{{}, signedIn("owner@example.com")}, login: freebuffrt.LoginStart{RemoteURL: "https://freebuff.example/login"}}
	stopped := false
	prev := startFreebuffAccount
	startFreebuffAccount = func(context.Context, string, string) (freebuffAccount, func(), error) {
		return account, func() { stopped = true }, nil
	}
	t.Cleanup(func() { startFreebuffAccount = prev })

	rt := Runtime{ID: "rt-managed", Provider: "codebuddy", Status: "online"}
	fx.daemon.handleFreebuffDesktopLogin(context.Background(), rt, "a1")
	if stopped {
		t.Fatal("desktop instance stopped when the browser-login request returned")
	}
	if _, ok := fx.daemon.freebuffDesktopInstances.Load(freebuffDesktopLoginKey(rt.ID, "a1")); !ok {
		t.Fatal("desktop instance was not retained by the daemon")
	}
	fx.daemon.stopFreebuffDesktopInstances()
	if !stopped {
		t.Fatal("daemon shutdown did not stop the retained desktop instance")
	}
}

func TestFreebuffDesktopPending_DuplicateRequestsStartOneLogin(t *testing.T) {
	fx := newFreebuffFixture(t)
	useProfiles(t)
	fastLogin(t)
	fx.pending = `{"accounts":[{"id":"a1","state":"requested"}]}`
	prevTimeout := freebuffLoginTimeout
	freebuffLoginTimeout = 35 * time.Millisecond
	t.Cleanup(func() { freebuffLoginTimeout = prevTimeout })
	account := &fakeAccount{statuses: []freebuffrt.AuthStatus{{}}, login: freebuffrt.LoginStart{RemoteURL: "https://freebuff.example/login"}}
	var mu sync.Mutex
	starts := 0
	prev := startFreebuffAccount
	startFreebuffAccount = func(context.Context, string, string) (freebuffAccount, func(), error) {
		mu.Lock()
		starts++
		mu.Unlock()
		return account, func() {}, nil
	}
	t.Cleanup(func() { startFreebuffAccount = prev })
	rt := Runtime{ID: "rt-managed", Provider: "codebuddy", Status: "online"}
	fx.daemon.syncFreebuffDesktopRuntime(context.Background(), rt)
	fx.daemon.syncFreebuffDesktopRuntime(context.Background(), rt)
	time.Sleep(120 * time.Millisecond)
	mu.Lock()
	gotStarts := starts
	mu.Unlock()
	if gotStarts != 1 {
		t.Fatalf("duplicate pending request started %d orchestrators, want 1", gotStarts)
	}
	account.mu.Lock()
	canceled := account.canceled
	account.mu.Unlock()
	if !canceled {
		t.Fatal("timed out desktop login did not cancel the provider login")
	}
}

func TestHandleFreebuffDesktopLogin_CancellationKeepsDaemonOwnedInstance(t *testing.T) {
	fx := newFreebuffFixture(t)
	fastLogin(t)
	useProfiles(t)
	account := &fakeAccount{statuses: []freebuffrt.AuthStatus{{}}, login: freebuffrt.LoginStart{RemoteURL: "https://freebuff.example/login"}}
	stopped := false
	prev := startFreebuffAccount
	startFreebuffAccount = func(context.Context, string, string) (freebuffAccount, func(), error) {
		return account, func() { stopped = true }, nil
	}
	t.Cleanup(func() { startFreebuffAccount = prev })
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() {
		defer close(done)
		fx.daemon.handleFreebuffDesktopLogin(ctx, Runtime{ID: "rt-managed", Provider: "codebuddy"}, "a1")
	}()
	deadline := time.Now().Add(time.Second)
	for len(fx.accountReports()) == 0 && time.Now().Before(deadline) {
		time.Sleep(time.Millisecond)
	}
	cancel()
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("cancelled sign-in did not stop waiting")
	}
	account.mu.Lock()
	canceled := account.canceled
	account.mu.Unlock()
	if !canceled || stopped {
		t.Fatalf("cancelled=%v stopped=%v; cancellation should close sign-in but retain the daemon-owned instance", canceled, stopped)
	}
	fx.daemon.stopFreebuffDesktopInstances()
	if !stopped {
		t.Fatal("daemon shutdown did not stop the retained instance")
	}
}

func TestFreebuffDesktopRemovalWaitsForActiveTaskAndAcknowledgesRemoval(t *testing.T) {
	fx := newFreebuffFixture(t)
	profiles := useProfiles(t)
	rt := Runtime{ID: "rt-managed", Provider: "codebuddy", Status: "online"}
	cfg := agent.Config{RuntimeID: rt.ID}
	dir, err := agent.EnsureFreebuffAccountDir(cfg, "a1")
	if err != nil {
		t.Fatal(err)
	}
	stopped := false
	fx.daemon.freebuffDesktopInstances.Store(freebuffDesktopLoginKey(rt.ID, "a1"), &freebuffDesktopInstance{
		client: &fakeAccount{statuses: []freebuffrt.AuthStatus{{}}, launchID: "test-launch"}, stop: func() { stopped = true }, connected: true,
	})
	if err := fx.daemon.writeFreebuffDesktopRegistryLocked(); err != nil {
		t.Fatal(err)
	}
	fx.pending = `{"accounts":[{"id":"a1","state":"removing","active":true}]}`
	fx.daemon.syncFreebuffDesktopRuntime(context.Background(), rt)
	if stopped {
		t.Fatal("active task's orchestrator was stopped during removal")
	}
	if _, err := os.Stat(dir); err != nil {
		t.Fatalf("active account state was removed: %v", err)
	}
	fx.pending = `{"accounts":[{"id":"a1","state":"removing","active":false}]}`
	fx.daemon.syncFreebuffDesktopRuntime(context.Background(), rt)
	if !stopped {
		t.Fatal("account orchestrator was not stopped on removal")
	}
	registry, err := os.ReadFile(filepath.Join(profiles, "registry.json"))
	if err != nil || strings.TrimSpace(string(registry)) != "[]" {
		t.Fatalf("registry after removal: %s (%v)", registry, err)
	}
	if _, err := os.Stat(dir); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("account state still exists, stat error=%v", err)
	}
	reports := fx.snapshot()
	if len(reports) == 0 || len(reports[len(reports)-1]["removed"].([]any)) != 1 {
		t.Fatalf("removal acknowledgement missing: %#v", reports)
	}
	if _, err := os.Stat(profiles); err != nil {
		t.Fatalf("profile root unexpectedly disappeared: %v", err)
	}
}

func TestReportFreebuffDesktopAccountsRestartsOwnedInstance(t *testing.T) {
	fx := newFreebuffFixture(t)
	useProfiles(t)
	account := &fakeAccount{statuses: []freebuffrt.AuthStatus{signedIn("owner@example.com")}}
	prev := startFreebuffAccount
	startFreebuffAccount = func(context.Context, string, string) (freebuffAccount, func(), error) {
		return account, func() {}, nil
	}
	t.Cleanup(func() { startFreebuffAccount = prev })
	cfg := agent.Config{RuntimeID: "rt-managed"}
	if _, err := agent.EnsureFreebuffAccountDir(cfg, "a1"); err != nil {
		t.Fatal(err)
	}
	rt := Runtime{ID: cfg.RuntimeID, Provider: "codebuddy", Status: "online"}
	fx.daemon.reportFreebuffDesktopAccounts(context.Background(), rt)
	reports := fx.snapshot()
	if len(reports) != 2 || reports[0]["snapshot"] != true || reports[1]["complete"] != true {
		t.Fatalf("startup status report = %#v", reports)
	}
	entries := reports[0]["accounts"].([]any)
	entry := entries[0].(map[string]any)
	if entry["state"] != "connected" || entry["endpoint"] != account.BaseURL() || entry["credential_ref"] == "a1" {
		t.Fatalf("restarted managed account report = %#v", entry)
	}
	if _, ok := fx.daemon.freebuffDesktopInstances.Load(freebuffDesktopLoginKey(rt.ID, "a1")); !ok {
		t.Fatal("startup did not retain the rehydrated account instance")
	}
	fx.daemon.stopFreebuffDesktopInstances()
}

func TestFreebuffDesktopStatusRestartsCrashedInstanceWithFreshLaunchID(t *testing.T) {
	fx := newFreebuffFixture(t)
	useProfiles(t)
	rt := Runtime{ID: "rt-managed", Provider: "codebuddy", Status: "online"}
	if _, err := agent.EnsureFreebuffAccountDir(agent.Config{RuntimeID: rt.ID}, "a1"); err != nil {
		t.Fatal(err)
	}
	dead := &fakeAccount{authErr: errors.New("connection refused"), launchID: "old-launch"}
	live := &fakeAccount{statuses: []freebuffrt.AuthStatus{signedIn("owner@example.com")}, launchID: "new-launch"}
	starts := 0
	stops := 0
	prev := startFreebuffAccount
	startFreebuffAccount = func(context.Context, string, string) (freebuffAccount, func(), error) {
		starts++
		if starts == 1 {
			return dead, func() { stops++ }, nil
		}
		return live, func() {}, nil
	}
	t.Cleanup(func() { startFreebuffAccount = prev })

	fx.daemon.reportFreebuffDesktopAccounts(context.Background(), rt)
	first := fx.snapshot()
	firstAccounts := first[0]["accounts"].([]any)
	if firstAccounts[0].(map[string]any)["state"] != "failed" {
		t.Fatalf("dead instance was reported ready: %#v", firstAccounts[0])
	}

	client, err := fx.daemon.ensureFreebuffDesktopInstance(context.Background(), rt, "a1")
	if err != nil {
		t.Fatal(err)
	}
	if starts != 2 || stops != 1 || client.LaunchID() != "new-launch" {
		t.Fatalf("recovery starts=%d stops=%d launch_id=%q", starts, stops, client.LaunchID())
	}
	fx.daemon.reportFreebuffDesktopAccounts(context.Background(), rt)
	reports := fx.snapshot()
	last := reports[len(reports)-2]
	lastAccounts := last["accounts"].([]any)
	if lastAccounts[0].(map[string]any)["state"] != "connected" {
		t.Fatalf("recovered instance status = %#v", lastAccounts[0])
	}
}

func TestHandleFreebuffLogin_FailuresAreReported(t *testing.T) {
	fx := newFreebuffFixture(t)
	useFakeAccount(t, nil, errors.New("bun not found"))
	useProfiles(t)

	fx.daemon.handleFreebuffLogin(context.Background(), freebuffRuntime(), "a1")

	r := fx.accountReports()[0]
	if r["state"] != "failed" || r["error"] != "bun not found" {
		t.Fatalf("report = %#v", r)
	}
}

func TestHandleFreebuffLogin_TimeoutCancelsLogin(t *testing.T) {
	fx := newFreebuffFixture(t)
	prevTimeout, prevPoll := freebuffLoginTimeout, freebuffLoginPollInterval
	freebuffLoginTimeout, freebuffLoginPollInterval = 80*time.Millisecond, 10*time.Millisecond
	t.Cleanup(func() { freebuffLoginTimeout, freebuffLoginPollInterval = prevTimeout, prevPoll })
	acct := &fakeAccount{statuses: []freebuffrt.AuthStatus{{}}, login: freebuffrt.LoginStart{URL: "http://127.0.0.1:1/x"}}
	useFakeAccount(t, acct, nil)
	useProfiles(t)

	fx.daemon.handleFreebuffLogin(context.Background(), freebuffRuntime(), "a1")

	reports := fx.accountReports()
	if last := reports[len(reports)-1]; last["state"] != "failed" {
		t.Fatalf("last report = %#v", last)
	}
	acct.mu.Lock()
	defer acct.mu.Unlock()
	if !acct.canceled {
		t.Fatal("pending login was not cancelled")
	}
}

// A sign-in cancelled because the user removed the account reports nothing:
// nobody is left to read it, and a "failed" would resurrect the entry.
func TestHandleFreebuffLogin_CancelledByRemovalIsSilent(t *testing.T) {
	fx := newFreebuffFixture(t)
	fastLogin(t)
	acct := &fakeAccount{statuses: []freebuffrt.AuthStatus{{}}, login: freebuffrt.LoginStart{URL: "http://127.0.0.1:1/x"}}
	useFakeAccount(t, acct, nil)
	useProfiles(t)

	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() {
		fx.daemon.handleFreebuffLogin(ctx, freebuffRuntime(), "a1")
		close(done)
	}()
	time.Sleep(60 * time.Millisecond)
	cancel()
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("login did not stop")
	}
	for _, r := range fx.accountReports() {
		if r["state"] == "failed" {
			t.Fatalf("cancellation reported as failure: %#v", r)
		}
	}
}

// Each account on disk is asked; an account that cannot be asked is reported
// as present with no state, and the report is complete so the server can drop
// accounts that are gone.
func TestReportFreebuffAccounts_CompleteSnapshot(t *testing.T) {
	fx := newFreebuffFixture(t)
	root := useProfiles(t)
	for _, id := range []string{"a1", "a2"} {
		if err := os.MkdirAll(filepath.Join(root, "rt-fb", "accounts", id), 0o700); err != nil {
			t.Fatal(err)
		}
	}
	prev := startFreebuffAccount
	t.Cleanup(func() { startFreebuffAccount = prev })
	startFreebuffAccount = func(_ context.Context, _, accountID string) (freebuffAccount, func(), error) {
		if accountID == "a2" {
			return nil, nil, errors.New("profile busy")
		}
		return &fakeAccount{statuses: []freebuffrt.AuthStatus{signedIn("owner@example.com")}}, func() {}, nil
	}

	fx.daemon.reportFreebuffAccounts(context.Background(), freebuffRuntime())

	reports := fx.snapshot()
	if len(reports) != 1 || reports[0]["complete"] != true {
		t.Fatalf("reports = %#v", reports)
	}
	entries := fx.accountReports()
	if len(entries) != 2 {
		t.Fatalf("entries = %#v", entries)
	}
	if entries[0]["id"] != "a1" || entries[0]["state"] != "connected" || entries[0]["label"] != "owner@example.com" {
		t.Fatalf("a1 = %#v", entries[0])
	}
	if entries[1]["id"] != "a2" || entries[1]["state"] != nil {
		t.Fatalf("a busy account must be reported present, state unchanged: %#v", entries[1])
	}
}

func TestReportFreebuffAccounts_SignedOut(t *testing.T) {
	fx := newFreebuffFixture(t)
	root := useProfiles(t)
	if err := os.MkdirAll(filepath.Join(root, "rt-fb", "accounts", "a1"), 0o700); err != nil {
		t.Fatal(err)
	}
	useFakeAccount(t, &fakeAccount{statuses: []freebuffrt.AuthStatus{{}}}, nil)

	fx.daemon.reportFreebuffAccounts(context.Background(), freebuffRuntime())

	if got := fx.accountReports()[0]["state"]; got != "signed_out" {
		t.Fatalf("state = %v", got)
	}
}

// Removing deletes the login from disk, tells the server what remains, and
// the default follows the server's choice.
func TestSyncFreebuffRuntime_RemovesAccountsAndFollowsDefault(t *testing.T) {
	fx := newFreebuffFixture(t)
	root := useProfiles(t)
	for _, id := range []string{"keep", "bye"} {
		if err := os.MkdirAll(filepath.Join(root, "rt-fb", "accounts", id), 0o700); err != nil {
			t.Fatal(err)
		}
	}
	fx.mu.Lock()
	fx.pending = `{"accounts":[{"id":"bye","state":"removing"}],"default_account_id":"keep"}`
	fx.mu.Unlock()

	fx.daemon.syncFreebuffRuntime(context.Background(), freebuffRuntime())

	if _, err := os.Stat(filepath.Join(root, "rt-fb", "accounts", "bye")); !os.IsNotExist(err) {
		t.Fatalf("removed account still on disk: %v", err)
	}
	if _, err := os.Stat(filepath.Join(root, "rt-fb", "accounts", "keep")); err != nil {
		t.Fatalf("other account was touched: %v", err)
	}
	id, err := agent.FreebuffAccountForRun(agent.Config{RuntimeID: "rt-fb"})
	if err != nil || id != "keep" {
		t.Fatalf("default account = %q, %v", id, err)
	}
	reports := fx.snapshot()
	if len(reports) != 1 || reports[0]["complete"] != true {
		t.Fatalf("reports = %#v", reports)
	}
	entries := fx.accountReports()
	if len(entries) != 1 || entries[0]["id"] != "keep" {
		t.Fatalf("the report must list what remains: %#v", entries)
	}
}

func TestFreebuffRuntimes_SelectsByProvider(t *testing.T) {
	fx := newFreebuffFixture(t)
	d := fx.daemon
	d.runtimeIndex["rt-fb"] = freebuffRuntime()
	d.runtimeIndex["rt-other"] = Runtime{ID: "rt-other", Provider: "codebuddy"}

	got := d.freebuffRuntimes()
	if len(got) != 1 || got[0].ID != "rt-fb" {
		t.Fatalf("freebuffRuntimes = %#v", got)
	}
}

func TestFreebuffDesktopRemovalRetriesAfterFilesystemFailure(t *testing.T) {
	fx := newFreebuffFixture(t)
	useProfiles(t)
	rt := Runtime{ID: "rt-managed", Provider: "codebuddy", Status: "online"}
	cfg := agent.Config{RuntimeID: rt.ID}
	dir, err := agent.EnsureFreebuffAccountDir(cfg, "a1")
	if err != nil {
		t.Fatal(err)
	}
	parent := filepath.Dir(dir)
	if err := os.Rename(parent, parent+"-preserved"); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(parent, []byte("filesystem failure fixture"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := agent.RemoveFreebuffAccount(cfg, "a1"); err == nil {
		t.Fatal("fixture must cause removal to fail")
	}
	fx.pending = `{"accounts":[{"id":"a1","state":"removing","active":false}]}`
	fx.daemon.syncFreebuffDesktopRuntime(context.Background(), rt)
	for _, report := range fx.snapshot() {
		if report["removed"] != nil {
			t.Fatalf("acknowledged failed removal: %#v", report)
		}
	}
	if err := os.Remove(parent); err != nil {
		t.Fatal(err)
	}
	if err := os.Rename(parent+"-preserved", parent); err != nil {
		t.Fatal(err)
	}
	fx.daemon.syncFreebuffDesktopRuntime(context.Background(), rt)
	if _, err := os.Stat(dir); !os.IsNotExist(err) {
		t.Fatalf("account state still exists after retry: %v", err)
	}
	reports := fx.snapshot()
	if len(reports) != 1 {
		t.Fatalf("expected one successful removal acknowledgement, got %#v", reports)
	}
	removed, ok := reports[0]["removed"].([]any)
	if !ok || len(removed) != 1 || removed[0] != "a1" {
		t.Fatalf("unexpected acknowledgement: %#v", reports[0])
	}
}
