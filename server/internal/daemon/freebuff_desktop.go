package daemon

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/multica-ai/multica/server/pkg/agent"
	"github.com/multica-ai/multica/server/pkg/freebuffrt"
)

const freebuffDesktopConnectPollInterval = 5 * time.Second
const freebuffDesktopStatusInterval = 5 * time.Minute
const freebuffDesktopLaunchIDEnv = "FREEBUFF_DESKTOP_LAUNCH_ID"

// Managed credentials must be paired with their local endpoint and account
// directory, regardless of user-supplied environment overrides.
func applyManagedFreebuffDesktopEnv(env map[string]string, endpoint, dir, launchID string) {
	env["FREEBUFF_DESKTOP_URL"] = endpoint
	env["FREEBUFF_DESKTOP_CREDENTIAL_REF"] = dir
	env[freebuffDesktopLaunchIDEnv] = launchID
}

type freebuffDesktopInstance struct {
	client    freebuffAccount
	stop      func()
	connected bool
	label     string
	pin       string
}

func freebuffDesktopLoginKey(runtimeID, accountID string) string { return runtimeID + "/" + accountID }

func (d *Daemon) ensureFreebuffDesktopInstance(ctx context.Context, rt Runtime, accountID string) (freebuffAccount, error) {
	d.freebuffDesktopInstanceMu.Lock()
	defer d.freebuffDesktopInstanceMu.Unlock()
	key := freebuffDesktopLoginKey(rt.ID, accountID)
	if v, ok := d.freebuffDesktopInstances.Load(key); ok {
		inst := v.(*freebuffDesktopInstance)
		if desktopInstanceReady(ctx, inst.client) {
			return inst.client, nil
		}
		inst.stop()
		d.freebuffDesktopInstances.Delete(key)
		d.publishFreebuffDesktopLocked()
	}
	client, stop, err := startFreebuffAccount(d.daemonLifecycleCtx(), rt.ID, accountID)
	if err != nil {
		if d.freebuffDesktopFailedPins == nil {
			d.freebuffDesktopFailedPins = make(map[string]string)
		}
		d.freebuffDesktopFailedPins[key] = freebuffAccountEngineVersion(rt.ID, accountID)
		return nil, err
	}
	if !desktopInstanceReady(d.daemonLifecycleCtx(), client) {
		stop()
		if d.freebuffDesktopFailedPins == nil {
			d.freebuffDesktopFailedPins = make(map[string]string)
		}
		d.freebuffDesktopFailedPins[key] = freebuffAccountEngineVersion(rt.ID, accountID)
		return nil, fmt.Errorf("engine %s has no local thread API; pin <=0.0.190", freebuffAccountEngineVersion(rt.ID, accountID))
	}
	delete(d.freebuffDesktopFailedPins, key)
	d.freebuffDesktopInstances.Store(key, &freebuffDesktopInstance{client: client, stop: stop, pin: freebuffAccountEngineVersion(rt.ID, accountID)})
	return client, nil
}

// desktopInstanceReady reports whether a managed account instance can run
// tasks: it must answer auth status AND serve the thread routes the bridge
// drives (POST /api/threads). An engine bundle without local thread routes
// (e.g. a hosted-workspace-only build) passes auth but fails every run with
// POST /api/threads -> 404, so readiness must cover both.
func desktopInstanceReady(ctx context.Context, client freebuffAccount) bool {
	rctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	if _, err := client.AuthStatus(rctx); err != nil {
		return false
	}
	if probe, ok := client.(interface {
		ThreadProbe(ctx context.Context) error
	}); ok {
		return probe.ThreadProbe(rctx) == nil
	}
	return true
}

// Reservations span the entire task, including the interval after endpoint lookup.
func (d *Daemon) reserveFreebuffDesktopAccount(runtimeID, accountID string) func() {
	key := freebuffDesktopLoginKey(runtimeID, accountID)
	d.freebuffDesktopInstanceMu.Lock()
	if d.freebuffDesktopReservations == nil {
		d.freebuffDesktopReservations = make(map[string]int)
	}
	d.freebuffDesktopReservations[key]++
	d.freebuffDesktopInstanceMu.Unlock()
	return func() {
		d.freebuffDesktopInstanceMu.Lock()
		d.freebuffDesktopReservations[key]--
		if d.freebuffDesktopReservations[key] == 0 {
			delete(d.freebuffDesktopReservations, key)
		}
		d.freebuffDesktopInstanceMu.Unlock()
	}
}

func (d *Daemon) freebuffDesktopRuntimes() []Runtime {
	d.mu.Lock()
	defer d.mu.Unlock()
	var out []Runtime
	for _, rt := range d.runtimeIndex {
		if rt.Provider != "codebuddy" {
			continue
		}
		if rt.ProfileID == "" {
			continue
		}
		spec, ok := d.profileLaunchSpecs[rt.ProfileID]
		if !ok {
			continue
		}
		if !strings.HasPrefix(strings.ToLower(spec.commandName), "freebuff-desktop") {
			continue
		}
		out = append(out, rt)
	}
	return out
}

func (d *Daemon) freebuffDesktopLoop(ctx context.Context) {
	defer d.stopFreebuffDesktopInstances()
	d.freebuffDesktopInstanceMu.Lock()
	d.publishFreebuffDesktopLocked()
	d.freebuffDesktopInstanceMu.Unlock()
	pollTicker := time.NewTicker(freebuffDesktopConnectPollInterval)
	defer pollTicker.Stop()
	statusTicker := time.NewTicker(freebuffDesktopStatusInterval)
	defer statusTicker.Stop()

	for _, rt := range d.freebuffDesktopRuntimes() {
		go d.syncFreebuffDesktopRuntime(ctx, rt)
		go d.reportFreebuffDesktopAccounts(ctx, rt)
	}

	for {
		select {
		case <-ctx.Done():
			return
		case <-pollTicker.C:
			for _, rt := range d.freebuffDesktopRuntimes() {
				d.syncFreebuffDesktopRuntime(ctx, rt)
			}
		case <-statusTicker.C:
			for _, rt := range d.freebuffDesktopRuntimes() {
				go d.reportFreebuffDesktopAccounts(ctx, rt)
			}
		}
	}
}

func (d *Daemon) syncFreebuffDesktopRuntime(ctx context.Context, rt Runtime) {
	pending, err := d.client.GetFreebuffDesktopPending(ctx, rt.ID)
	if err != nil {
		d.logger.Debug("freebuff-desktop pending poll failed", "runtime_id", rt.ID, "error", err)
		return
	}
	// Update and reconcile under the same mutex used by task reservations.
	d.freebuffDesktopInstanceMu.Lock()
	if pending.Pins != nil {
		prefix := rt.ID + "/"
		freebuffAccountPins.Range(func(k, _ any) bool {
			key := k.(string)
			if strings.HasPrefix(key, prefix) {
				if _, ok := pending.Pins[strings.TrimPrefix(key, prefix)]; !ok {
					freebuffAccountPins.Delete(key)
					delete(d.freebuffDesktopFailedPins, key)
				}
			}
			return true
		})
	}
	for id, pin := range pending.Pins {
		if agent.ValidFreebuffAccountID(id) {
			freebuffAccountPins.Store(freebuffDesktopLoginKey(rt.ID, id), pin)
		}
	}
	busy := make(map[string]bool)
	for _, acc := range pending.Accounts {
		if acc.Active || acc.State == "awaiting_login" || acc.State == "requested" || acc.State == "removing" {
			busy[acc.ID] = true
		}
	}
	var reports []map[string]any
	for id := range pending.Pins {
		key := freebuffDesktopLoginKey(rt.ID, id)
		if !agent.ValidFreebuffAccountID(id) || busy[id] || d.freebuffDesktopReservations[key] > 0 {
			continue
		}
		if _, login := d.freebuffDesktopLogins.Load(key); login {
			continue
		}
		v, ok := d.freebuffDesktopInstances.Load(key)
		desired := freebuffAccountEngineVersion(rt.ID, id)
		if ok {
			inst := v.(*freebuffDesktopInstance)
			if inst.pin == desired {
				continue
			}
			inst.stop()
			d.freebuffDesktopInstances.Delete(key)
			d.publishFreebuffDesktopLocked()
		} else if failed, exists := d.freebuffDesktopFailedPins[key]; !exists || failed == desired {
			continue
		}
		client, stop, err := startFreebuffAccount(d.daemonLifecycleCtx(), rt.ID, id)
		if err != nil {
			if d.freebuffDesktopFailedPins == nil {
				d.freebuffDesktopFailedPins = make(map[string]string)
			}
			d.freebuffDesktopFailedPins[key] = desired
			reports = append(reports, map[string]any{"id": id, "state": "failed", "error": err.Error()})
			continue
		}
		// The new endpoint is published only after auth status confirms connectivity.
		statusCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
		st, err := client.AuthStatus(statusCtx)
		cancel()
		replacement := &freebuffDesktopInstance{client: client, stop: stop, pin: desired}
		threadless := false
		if err == nil && st.Authed {
			if probe, ok := client.(interface {
				ThreadProbe(ctx context.Context) error
			}); ok {
				probeCtx, probeCancel := context.WithTimeout(ctx, 5*time.Second)
				if perr := probe.ThreadProbe(probeCtx); perr != nil {
					threadless = true
				}
				probeCancel()
			}
		}
		if threadless {
			stop()
			if d.freebuffDesktopFailedPins == nil {
				d.freebuffDesktopFailedPins = make(map[string]string)
			}
			d.freebuffDesktopFailedPins[key] = desired
			d.publishFreebuffDesktopLocked()
			reports = append(reports, map[string]any{"id": id, "state": "failed", "error": fmt.Sprintf("engine %s has no local thread API; pin <=0.0.190", desired)})
			continue
		}
		if err == nil && st.Authed {
			replacement.connected = true
			replacement.label = freebuffAccountLabel(st.User)
		}
		d.freebuffDesktopInstances.Store(key, replacement)
		delete(d.freebuffDesktopFailedPins, key)
		d.publishFreebuffDesktopLocked()
		if err == nil {
			if dir, dirErr := freebuffDesktopAccountDir(rt, id); dirErr == nil {
				entry := map[string]any{"id": id, "state": "signed_out", "endpoint": client.BaseURL(), "credential_ref": dir}
				if st.Authed {
					entry["state"] = "connected"
					entry["label"] = replacement.label
				}
				reports = append(reports, entry)
			}
		}
	}
	d.freebuffDesktopInstanceMu.Unlock()
	if len(reports) > 0 {
		d.reportFreebuffDesktopEntries(ctx, rt, reports, false)
	}
	for _, acc := range pending.Accounts {
		if !agent.ValidFreebuffAccountID(acc.ID) {
			continue
		}
		key := freebuffDesktopLoginKey(rt.ID, acc.ID)
		switch acc.State {
		case "requested", "awaiting_login":
			if _, running := d.freebuffDesktopLogins.Load(key); running {
				continue
			}
			loginCtx, cancel := context.WithCancel(ctx)
			if _, loaded := d.freebuffDesktopLogins.LoadOrStore(key, context.CancelFunc(cancel)); loaded {
				cancel()
				continue
			}
			go func(accountID string) {
				defer d.freebuffDesktopLogins.Delete(key)
				defer cancel()
				d.handleFreebuffDesktopLogin(loginCtx, rt, accountID)
			}(acc.ID)
		case "removing":
			cancel, ok := d.freebuffDesktopLogins.Load(key)
			if ok {
				cancel.(context.CancelFunc)()
				for i := 0; i < 30; i++ {
					if _, running := d.freebuffDesktopLogins.Load(key); !running {
						break
					}
					time.Sleep(100 * time.Millisecond)
				}
				if _, running := d.freebuffDesktopLogins.Load(key); running {
					continue
				}
			}
			if acc.Active {
				continue
			}
			key := freebuffDesktopLoginKey(rt.ID, acc.ID)
			d.freebuffDesktopInstanceMu.Lock()
			if v, ok := d.freebuffDesktopInstances.Load(key); ok {
				v.(*freebuffDesktopInstance).stop()
				d.freebuffDesktopInstances.Delete(key)
				d.publishFreebuffDesktopLocked()
			}
			d.freebuffDesktopInstanceMu.Unlock()
			cfg := agent.Config{RuntimeID: rt.ID}
			if err := agent.RemoveFreebuffAccount(cfg, acc.ID); err != nil {
				d.logger.Warn("freebuff-desktop account removal failed; will retry", "runtime_id", rt.ID, "account_id", acc.ID, "error", err)
				continue
			}
			d.reportFreebuffDesktopRemoved(ctx, rt, acc.ID)
		}
	}
}

func (d *Daemon) stopFreebuffDesktopInstances() {
	d.freebuffDesktopInstanceMu.Lock()
	defer d.freebuffDesktopInstanceMu.Unlock()
	d.freebuffDesktopInstances.Range(func(key, value any) bool {
		value.(*freebuffDesktopInstance).stop()
		d.freebuffDesktopInstances.Delete(key)
		return true
	})
	d.publishFreebuffDesktopLocked()
}

func freebuffDesktopAccountDir(rt Runtime, accountID string) (string, error) {
	return agent.FreebuffAccountDir(agent.Config{RuntimeID: rt.ID}, accountID)
}

func (d *Daemon) handleFreebuffDesktopLogin(ctx context.Context, rt Runtime, accountID string) {
	report := func(entry map[string]any) {
		d.reportFreebuffDesktopEntries(ctx, rt, []map[string]any{entry}, false)
	}
	fail := func(message string) {
		report(map[string]any{"id": accountID, "state": "failed", "error": message})
	}

	runCtx, cancel := context.WithTimeout(ctx, freebuffLoginTimeout)
	defer cancel()

	client, err := d.ensureFreebuffDesktopInstance(ctx, rt, accountID)
	if err != nil {
		fail(err.Error())
		return
	}

	if st, err := client.AuthStatus(runCtx); err == nil && st.Authed {
		d.setFreebuffDesktopConnected(rt, accountID, client, true, freebuffAccountLabel(st.User))
		dir, err := freebuffDesktopAccountDir(rt, accountID)
		if err != nil {
			fail(err.Error())
			return
		}
		report(map[string]any{
			"id":             accountID,
			"state":          "connected",
			"label":          freebuffAccountLabel(st.User),
			"endpoint":       client.BaseURL(),
			"credential_ref": dir,
			"status":         map[string]any{"message": "Signed in to Freebuff"},
		})
		return
	}
	d.setFreebuffDesktopConnected(rt, accountID, client, false, "")

	login, err := client.StartLogin(runCtx)
	if err != nil {
		fail(err.Error())
		return
	}
	url := login.RemoteURL
	if url == "" {
		url = login.URL
	}
	if url == "" {
		fail("the Freebuff orchestrator did not return a login URL")
		return
	}
	dir, err := freebuffDesktopAccountDir(rt, accountID)
	if err != nil {
		fail(err.Error())
		return
	}
	report(map[string]any{
		"id":             accountID,
		"state":          "awaiting_login",
		"login_url":      url,
		"expires_at":     time.Now().Add(freebuffLoginTimeout).UTC().Format(time.RFC3339),
		"endpoint":       client.BaseURL(),
		"credential_ref": dir,
	})

	ticker := time.NewTicker(freebuffLoginPollInterval)
	defer ticker.Stop()
	for {
		select {
		case <-runCtx.Done():
			cancelCtx, c := context.WithTimeout(context.Background(), 5*time.Second)
			_ = client.CancelLogin(cancelCtx)
			c()
			if errors.Is(runCtx.Err(), context.DeadlineExceeded) {
				fail("the sign-in was not completed in time; try again for a new link")
			}
			return
		case <-ticker.C:
			st, err := client.AuthStatus(runCtx)
			if err != nil {
				continue
			}
			if st.Authed {
				d.setFreebuffDesktopConnected(rt, accountID, client, true, freebuffAccountLabel(st.User))
				dir, err := freebuffDesktopAccountDir(rt, accountID)
				if err != nil {
					fail(err.Error())
					return
				}
				label := freebuffAccountLabel(st.User)
				msg := "Signed in to Freebuff"
				if label != "" {
					msg = "Signed in as " + label
				}
				report(map[string]any{
					"id":             accountID,
					"state":          "connected",
					"label":          label,
					"endpoint":       client.BaseURL(),
					"credential_ref": dir,
					"status":         map[string]any{"message": msg},
				})
				return
			}
			if st.Login.Phase == "failed" || st.Login.Phase == "error" || st.Login.Phase == "cancelled" {
				fail("the sign-in " + st.Login.Phase)
				return
			}
		}
	}
}

func (d *Daemon) reportFreebuffDesktopEntries(ctx context.Context, rt Runtime, entries []map[string]any, complete bool) {
	payload := map[string]any{"accounts": entries, "complete": complete}
	installed := freebuffrt.InstalledVersions(agent.FreebuffBundleDir(agent.Config{RuntimeID: rt.ID}))
	versions := make([]map[string]string, 0, len(installed))
	for _, v := range installed {
		versions = append(versions, map[string]string{"version": v.Version, "commit": v.Commit})
	}
	payload["versions"] = versions
	d.reportRuntimeResultWithRetry(ctx, "freebuff_desktop_account", rt.ID, "", func(ctx context.Context) error {
		return d.client.ReportFreebuffDesktopAccount(ctx, rt.ID, payload)
	})
}

func (d *Daemon) reportFreebuffDesktopSnapshot(ctx context.Context, rt Runtime, entries []map[string]any) {
	d.reportRuntimeResultWithRetry(ctx, "freebuff_desktop_account", rt.ID, "", func(ctx context.Context) error {
		return d.client.ReportFreebuffDesktopAccount(ctx, rt.ID, map[string]any{"accounts": entries, "snapshot": true})
	})
}

func (d *Daemon) reportFreebuffDesktopPresence(ctx context.Context, rt Runtime, ids []string) {
	entries := make([]map[string]any, 0, len(ids))
	for _, id := range ids {
		entries = append(entries, map[string]any{"id": id})
	}
	d.reportFreebuffDesktopEntries(ctx, rt, entries, true)
}

func (d *Daemon) reportFreebuffDesktopRemoved(ctx context.Context, rt Runtime, id string) {
	d.reportRuntimeResultWithRetry(ctx, "freebuff_desktop_account", rt.ID, "", func(ctx context.Context) error {
		return d.client.ReportFreebuffDesktopAccount(ctx, rt.ID, map[string]any{"removed": []string{id}})
	})
}

func (d *Daemon) reportFreebuffDesktopAccounts(ctx context.Context, rt Runtime) {
	cfg := agent.Config{RuntimeID: rt.ID}
	ids, err := agent.ListFreebuffAccounts(cfg)
	if err != nil {
		d.logger.Debug("freebuff-desktop accounts unavailable", "runtime_id", rt.ID, "error", err)
		return
	}
	entries := make([]map[string]any, 0, len(ids))
	presentIDs := make([]string, 0, len(ids))
	for _, id := range ids {
		presentIDs = append(presentIDs, id)
		entries = append(entries, map[string]any{"id": id})
		key := freebuffDesktopLoginKey(rt.ID, id)
		if _, loggingIn := d.freebuffDesktopLogins.Load(key); loggingIn {
			continue
		}
		client, err := d.ensureFreebuffDesktopInstance(ctx, rt, id)
		if err != nil {
			d.logger.Debug("freebuff-desktop instance unavailable", "runtime_id", rt.ID, "account_id", id, "error", err)
			entries[len(entries)-1] = map[string]any{"id": id, "state": "failed", "error": err.Error()}
			continue
		}
		statusCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
		st, err := client.AuthStatus(statusCtx)
		cancel()
		if err != nil {
			d.setFreebuffDesktopConnected(rt, id, client, false, "")
			d.logger.Debug("freebuff-desktop auth status failed", "runtime_id", rt.ID, "account_id", id, "error", err)
			entries[len(entries)-1] = map[string]any{"id": id, "state": "failed", "error": "Freebuff Desktop instance unavailable"}
			continue
		}
		dir, err := freebuffDesktopAccountDir(rt, id)
		if err != nil {
			continue
		}
		entry := map[string]any{"id": id, "state": "signed_out", "endpoint": client.BaseURL(), "credential_ref": dir}
		if st.Authed {
			entry["state"] = "connected"
			entry["label"] = freebuffAccountLabel(st.User)
		}
		d.setFreebuffDesktopConnected(rt, id, client, st.Authed, freebuffAccountLabel(st.User))
		entries[len(entries)-1] = entry
	}
	d.reportFreebuffDesktopSnapshot(ctx, rt, entries)
	d.reportFreebuffDesktopPresence(ctx, rt, presentIDs)
}
