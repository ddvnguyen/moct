package handler

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/multica-ai/multica/server/internal/testutil"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
)

// ── pure helpers ─────────────────────────────────────────────────────────────

func TestNormalizeAccountSelection(t *testing.T) {
	id := "11111111-1111-1111-1111-111111111111"
	cur, _ := parseUUIDStrict(id)
	cases := []struct {
		name     string
		modeSet  bool
		mode     string
		idSet    bool
		id       string
		curMode  string
		curID    pgtype.UUID
		wantMode string
		wantID   bool
		wantErr  string
	}{
		{name: "untouched keeps the setting", curMode: "specific", curID: cur, wantMode: "specific", wantID: true},
		{name: "untouched default", wantMode: "default"},
		{name: "empty mode means default", modeSet: true, mode: " ", wantMode: "default"},
		{name: "any carries no id", modeSet: true, mode: "any", wantMode: "any"},
		{name: "any clears a previous id", modeSet: true, mode: "any", curMode: "specific", curID: cur, wantMode: "any"},
		{name: "specific with id", modeSet: true, mode: "specific", idSet: true, id: id, wantMode: "specific", wantID: true},
		{name: "specific needs an id", modeSet: true, mode: "specific", wantErr: "account_id is required when account_mode is specific"},
		{name: "unknown mode", modeSet: true, mode: "round-robin", wantErr: "invalid account_mode"},
		{name: "bad uuid", modeSet: true, mode: "specific", idSet: true, id: "not-a-uuid", wantErr: "invalid account_id"},
		{name: "id with default mode", modeSet: true, mode: "default", idSet: true, id: id, wantErr: "account_id is only valid when account_mode is specific"},
		{name: "id alone on a default agent", idSet: true, id: id, wantErr: "account_id is only valid when account_mode is specific"},
		{name: "id alone swaps the account of a specific agent", idSet: true, id: id, curMode: "specific", curID: cur, wantMode: "specific", wantID: true},
		{name: "clearing the id of a specific agent", idSet: true, id: "", curMode: "specific", curID: cur, wantErr: "account_id is required when account_mode is specific"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got, err := normalizeAccountSelection(tc.modeSet, tc.mode, tc.idSet, tc.id, tc.curMode, tc.curID)
			if tc.wantErr != "" {
				if err == nil || err.Error() != tc.wantErr {
					t.Fatalf("err = %v, want %q", err, tc.wantErr)
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			if got.Mode != tc.wantMode || got.ID.Valid != tc.wantID {
				t.Fatalf("got mode=%q id.valid=%v, want mode=%q id.valid=%v", got.Mode, got.ID.Valid, tc.wantMode, tc.wantID)
			}
		})
	}
}

func decodeJSON(t *testing.T, rec *httptest.ResponseRecorder, dst any) {
	t.Helper()
	if err := json.Unmarshal(rec.Body.Bytes(), dst); err != nil {
		t.Fatalf("decode %q: %v", rec.Body.String(), err)
	}
}

func TestNormalizeModelAccountParam(t *testing.T) {
	id := "22222222-2222-2222-2222-222222222222"
	for in, want := range map[string]string{"": "default", " default ": "default", "all": "all", id: id, "  " + id + " ": id} {
		got, err := normalizeModelAccountParam(in)
		if err != nil || got != want {
			t.Errorf("normalizeModelAccountParam(%q) = %q, %v; want %q", in, got, err, want)
		}
	}
	for _, bad := range []string{"everything", "../etc", "1234"} {
		if _, err := normalizeModelAccountParam(bad); err == nil {
			t.Errorf("normalizeModelAccountParam(%q) should fail", bad)
		}
	}
}

func TestModelCatalogCacheKeyKeepsDefaultScopeBare(t *testing.T) {
	if got := modelCatalogCacheKey("rt", ""); got != "rt" {
		t.Fatalf("default scope key = %q, want the bare runtime id", got)
	}
	if got := modelCatalogCacheKey("rt", "default"); got != "rt" {
		t.Fatalf("default scope key = %q", got)
	}
	a, b := modelCatalogCacheKey("rt", "A"), modelCatalogCacheKey("rt", "B")
	if a == b || a == "rt" || b == "rt" {
		t.Fatalf("account scopes must not share a cache entry: %q %q", a, b)
	}
}

func TestValidateAccountEndpoint(t *testing.T) {
	for _, ok := range []string{"", "http://localhost:4320", "https://desk.example.com/x"} {
		if err := validateAccountEndpoint(ok); err != nil {
			t.Errorf("%q should be valid: %v", ok, err)
		}
	}
	for _, bad := range []string{"localhost:4320", "ftp://x", "http://", "javascript:alert(1)", "/relative"} {
		if err := validateAccountEndpoint(bad); err == nil {
			t.Errorf("%q should be rejected", bad)
		}
	}
}

// ── database-backed ──────────────────────────────────────────────────────────

type accountTestEnv struct {
	foreignWorkspaceID string
	foreignAccountID   string
	codebuddyRuntime   string
	codebuddyProfile   string
	memberUserID       string
}

func newAccountTestEnv(t *testing.T) accountTestEnv {
	t.Helper()
	if testHandler == nil || testPool == nil {
		t.Skip("database not available")
	}
	ctx := context.Background()
	suffix := fmt.Sprintf("%d", time.Now().UnixNano())
	var env accountTestEnv

	if err := testPool.QueryRow(ctx, `
		INSERT INTO workspace (name, slug, description, issue_prefix)
		VALUES ($1, $2, '', 'WAC') RETURNING id`, "acct-foreign-"+suffix, "acct-foreign-"+suffix).Scan(&env.foreignWorkspaceID); err != nil {
		t.Fatalf("create foreign workspace: %v", err)
	}
	t.Cleanup(func() {
		testPool.Exec(context.Background(), `DELETE FROM workspace WHERE id = $1`, env.foreignWorkspaceID)
	})

	if err := testPool.QueryRow(ctx, `
		INSERT INTO workspace_account (workspace_id, provider, label, endpoint, credential_ref)
		VALUES ($1, 'freebuff-desktop', 'foreign', 'http://foreign.test', 'foreign-ref') RETURNING id`,
		env.foreignWorkspaceID).Scan(&env.foreignAccountID); err != nil {
		t.Fatalf("create foreign account: %v", err)
	}

	if err := testPool.QueryRow(ctx, `
		INSERT INTO runtime_profile (workspace_id, display_name, protocol_family, command_name, runtime_type)
		VALUES ($1, $2, 'codebuddy', 'freebuff-desktop-bridge', 'codebuddy') RETURNING id`,
		testWorkspaceID, "acct-profile-"+suffix).Scan(&env.codebuddyProfile); err != nil {
		t.Fatalf("create freebuff-desktop profile: %v", err)
	}
	t.Cleanup(func() {
		testPool.Exec(context.Background(), `DELETE FROM runtime_profile WHERE id = $1`, env.codebuddyProfile)
	})

	if err := testPool.QueryRow(ctx, `
		INSERT INTO agent_runtime (workspace_id, daemon_id, name, runtime_mode, provider, status, device_info, metadata, last_seen_at, visibility, owner_id)
		VALUES ($1, 'acct-test-machine', $2, 'local', 'codebuddy', 'online', 'x', '{}'::jsonb, now(), 'public', $3)
		RETURNING id`, testWorkspaceID, "acct-runtime-"+suffix, testUserID).Scan(&env.codebuddyRuntime); err != nil {
		t.Fatalf("create codebuddy runtime: %v", err)
	}
	t.Cleanup(func() {
		testPool.Exec(context.Background(), `DELETE FROM agent_runtime WHERE id = $1`, env.codebuddyRuntime)
	})
	if _, err := testPool.Exec(ctx, `UPDATE agent_runtime SET profile_id=$1 WHERE id=$2`, env.codebuddyProfile, env.codebuddyRuntime); err != nil {
		t.Fatalf("bind freebuff-desktop profile: %v", err)
	}

	if err := testPool.QueryRow(ctx, `
		INSERT INTO "user" (name, email) VALUES ('Acct Member', $1) RETURNING id`, "acct-member-"+suffix+"@multica.test").Scan(&env.memberUserID); err != nil {
		t.Fatalf("create member user: %v", err)
	}
	t.Cleanup(func() { testPool.Exec(context.Background(), `DELETE FROM "user" WHERE id = $1`, env.memberUserID) })
	if _, err := testPool.Exec(ctx, `INSERT INTO member (workspace_id, user_id, role) VALUES ($1, $2, 'member')`, testWorkspaceID, env.memberUserID); err != nil {
		t.Fatalf("add member: %v", err)
	}
	t.Cleanup(func() {
		testPool.Exec(context.Background(), `DELETE FROM workspace_account WHERE workspace_id = $1`, testWorkspaceID)
	})
	return env
}

func createAccountAs(t *testing.T, userID string, body map[string]any) *httptest.ResponseRecorder {
	t.Helper()
	req := withURLParam(newRequestAs(userID, http.MethodPost, "/api/workspaces/"+testWorkspaceID+"/accounts", body), "id", testWorkspaceID)
	return testutil.Call(t, testHandler.CreateWorkspaceAccount, req).ResponseRecorder
}

func mustCreateAccount(t *testing.T, label string) WorkspaceAccountResponse {
	t.Helper()
	var acc WorkspaceAccountResponse
	testutil.Call(t, testHandler.CreateWorkspaceAccount, withURLParam(newRequest(http.MethodPost, "/api/workspaces/"+testWorkspaceID+"/accounts", map[string]any{
		"label": label, "endpoint": "http://" + label + ".test", "credential_ref": "ref-" + label,
	}), "id", testWorkspaceID)).Want(http.StatusCreated).JSON(&acc)
	return acc
}

func TestWorkspaceAccountCRUDAndAuthz(t *testing.T) {
	env := newAccountTestEnv(t)

	// Plain members cannot write.
	if rec := createAccountAs(t, env.memberUserID, map[string]any{"label": "nope"}); rec.Code != http.StatusForbidden {
		t.Fatalf("member create = %d, want 403: %s", rec.Code, rec.Body)
	}

	acc := mustCreateAccount(t, "alpha")
	if acc.Provider != "freebuff-desktop" || acc.CredentialRef != "ref-alpha" || !acc.Enabled {
		t.Fatalf("created account = %+v", acc)
	}

	// Validation.
	for name, body := range map[string]map[string]any{
		"empty label":      {"label": "  "},
		"bad endpoint":     {"label": "x", "endpoint": "not-a-url"},
		"unknown provider": {"label": "x", "provider": "other"},
	} {
		if rec := createAccountAs(t, testUserID, body); rec.Code != http.StatusBadRequest {
			t.Errorf("%s: status = %d, want 400: %s", name, rec.Code, rec.Body)
		}
	}
	if rec := createAccountAs(t, testUserID, map[string]any{"label": "alpha"}); rec.Code != http.StatusConflict {
		t.Fatalf("duplicate label = %d, want 409: %s", rec.Code, rec.Body)
	}

	// credential_ref is admin-only on reads.
	list := func(userID string) []WorkspaceAccountResponse {
		var out struct {
			Accounts []WorkspaceAccountResponse `json:"accounts"`
		}
		testutil.Call(t, testHandler.ListWorkspaceAccounts, withURLParam(
			newRequestAs(userID, http.MethodGet, "/api/workspaces/"+testWorkspaceID+"/accounts", nil), "id", testWorkspaceID)).
			Want(http.StatusOK).JSON(&out)
		return out.Accounts
	}
	if got := list(testUserID); len(got) != 1 || got[0].CredentialRef != "ref-alpha" {
		t.Fatalf("owner list = %+v", got)
	}
	if got := list(env.memberUserID); len(got) != 1 || got[0].CredentialRef != "" || got[0].Endpoint == "" {
		t.Fatalf("member list = %+v (credential_ref must be hidden, endpoint visible)", got)
	}

	// Update: partial, and an empty label is refused.
	patch := func(userID, accountID string, body map[string]any) *httptest.ResponseRecorder {
		req := withURLParams(newRequestAs(userID, http.MethodPatch, "/api/workspaces/"+testWorkspaceID+"/accounts/"+accountID, body),
			"id", testWorkspaceID, "accountId", accountID)
		return testutil.Call(t, testHandler.UpdateWorkspaceAccount, req).ResponseRecorder
	}
	if rec := patch(env.memberUserID, acc.ID, map[string]any{"enabled": false}); rec.Code != http.StatusForbidden {
		t.Fatalf("member update = %d, want 403", rec.Code)
	}
	if rec := patch(testUserID, acc.ID, map[string]any{"label": ""}); rec.Code != http.StatusBadRequest {
		t.Fatalf("empty label update = %d, want 400", rec.Code)
	}
	var updated WorkspaceAccountResponse
	testutil.Call(t, testHandler.UpdateWorkspaceAccount, withURLParams(
		newRequest(http.MethodPatch, "/x", map[string]any{"enabled": false}), "id", testWorkspaceID, "accountId", acc.ID)).
		Want(http.StatusOK).JSON(&updated)
	if updated.Enabled || updated.Label != "alpha" || updated.Endpoint != "http://alpha.test" {
		t.Fatalf("partial update changed other fields: %+v", updated)
	}

	// Cross-workspace: a foreign account is invisible to this workspace's admin.
	if rec := patch(testUserID, env.foreignAccountID, map[string]any{"label": "hijack"}); rec.Code != http.StatusNotFound {
		t.Fatalf("cross-workspace update = %d, want 404", rec.Code)
	}
	del := func(accountID string) *httptest.ResponseRecorder {
		req := withURLParams(newRequest(http.MethodDelete, "/x", nil), "id", testWorkspaceID, "accountId", accountID)
		return testutil.Call(t, testHandler.DeleteWorkspaceAccount, req).ResponseRecorder
	}
	if rec := del(env.foreignAccountID); rec.Code != http.StatusNotFound {
		t.Fatalf("cross-workspace delete = %d, want 404", rec.Code)
	}
	var stillThere int
	testPool.QueryRow(context.Background(), `SELECT count(*) FROM workspace_account WHERE id = $1`, env.foreignAccountID).Scan(&stillThere)
	if stillThere != 1 {
		t.Fatal("cross-workspace delete removed another workspace's account")
	}
	if rec := del(acc.ID); rec.Code != http.StatusOK {
		t.Fatalf("delete = %d: %s", rec.Code, rec.Body)
	}
}

func TestCreateManagedAccountsUseUniqueLabelsAndHideLocalDetails(t *testing.T) {
	env := newAccountTestEnv(t)
	createManaged := func(label string) WorkspaceAccountResponse {
		t.Helper()
		body := map[string]any{"managed": true, "runtime_id": env.codebuddyRuntime}
		if label != "" {
			body["label"] = label
		}
		rec := createAccountAs(t, testUserID, body)
		if rec.Code != http.StatusAccepted {
			t.Fatalf("managed create status=%d body=%s", rec.Code, rec.Body)
		}
		var account WorkspaceAccountResponse
		decodeJSON(t, rec, &account)
		return account
	}
	first := createManaged("")
	second := createManaged("")
	if first.ID == second.ID || first.Label == second.Label || first.State != "requested" || second.State != "requested" {
		t.Fatalf("managed accounts are not independently provisioned: first=%+v second=%+v", first, second)
	}
	if first.RuntimeID != env.codebuddyRuntime || second.RuntimeID != env.codebuddyRuntime || !first.Enabled || !second.Enabled {
		t.Fatalf("managed account ownership or initial enablement is wrong: first=%+v second=%+v", first, second)
	}
	if _, err := testPool.Exec(context.Background(), `UPDATE workspace_account SET login_url='https://freebuff.example/login', credential_ref='/local/path' WHERE id=$1`, parseUUID(first.ID)); err != nil {
		t.Fatal(err)
	}
	var memberRows struct {
		Accounts []map[string]any `json:"accounts"`
	}
	testutil.Call(t, testHandler.ListWorkspaceAccounts, withURLParam(
		newRequestAs(env.memberUserID, http.MethodGet, "/x", nil), "id", testWorkspaceID,
	)).Want(http.StatusOK).JSON(&memberRows)
	for _, row := range memberRows.Accounts {
		if row["id"] == first.ID {
			for _, privateField := range []string{"login_url", "credential_ref", "error", "status", "daemon_account_id"} {
				if _, exists := row[privateField]; exists {
					t.Fatalf("member response exposed %s: %#v", privateField, row)
				}
			}
			return
		}
	}
	t.Fatalf("member response omitted managed account %s", first.ID)
}

func TestManagedAccountRetryAndRemovalTransitions(t *testing.T) {
	env := newAccountTestEnv(t)
	rec := createAccountAs(t, testUserID, map[string]any{"managed": true, "runtime_id": env.codebuddyRuntime})
	if rec.Code != http.StatusAccepted {
		t.Fatalf("managed create = %d: %s", rec.Code, rec.Body)
	}
	var account WorkspaceAccountResponse
	decodeJSON(t, rec, &account)
	if _, err := testPool.Exec(context.Background(), `UPDATE workspace_account SET state='failed', enabled=FALSE, error='expired', login_url='https://old.example' WHERE id=$1`, parseUUID(account.ID)); err != nil {
		t.Fatal(err)
	}
	retry := testutil.Call(t, testHandler.UpdateWorkspaceAccount, withURLParams(
		newRequest(http.MethodPatch, "/x", map[string]any{"retry": true}), "id", testWorkspaceID, "accountId", account.ID,
	))
	retry.Want(http.StatusAccepted).JSON(&account)
	if account.State != "requested" || account.LoginURL != "" || account.Error != "" || account.Enabled {
		t.Fatalf("retry response did not reset sign-in state while preserving disabled choice: %+v", account)
	}
	report := testutil.Call(t, testHandler.ReportFreebuffDesktopAccount, withURLParam(
		newOwnerDaemonRequest(http.MethodPost, "/x", map[string]any{"accounts": []map[string]any{{
			"id": account.DaemonAccountID, "state": "connected", "endpoint": "http://127.0.0.1:4320",
		}}}), "runtimeId", env.codebuddyRuntime,
	))
	report.Want(http.StatusOK)
	var connectedEnabled bool
	var connectedState string
	if err := testPool.QueryRow(context.Background(), `SELECT state, enabled FROM workspace_account WHERE id=$1`, parseUUID(account.ID)).Scan(&connectedState, &connectedEnabled); err != nil {
		t.Fatal(err)
	}
	if connectedState != "connected" || connectedEnabled {
		t.Fatalf("status refresh changed disabled preference: state=%q enabled=%v", connectedState, connectedEnabled)
	}
	remove := testutil.Call(t, testHandler.DeleteWorkspaceAccount, withURLParams(
		newRequest(http.MethodDelete, "/x", nil), "id", testWorkspaceID, "accountId", account.ID,
	))
	remove.Want(http.StatusAccepted)
	var state string
	var enabled bool
	if err := testPool.QueryRow(context.Background(), `SELECT state, enabled FROM workspace_account WHERE id=$1`, parseUUID(account.ID)).Scan(&state, &enabled); err != nil {
		t.Fatalf("removing account row was deleted before daemon acknowledgement: %v", err)
	}
	if state != "removing" || enabled {
		t.Fatalf("removal transition state=%q enabled=%v", state, enabled)
	}
}

func TestDispatchScopesManagedAccountsToTheirRuntime(t *testing.T) {
	env := newAccountTestEnv(t)
	ctx := context.Background()
	var otherRuntime string
	if err := testPool.QueryRow(ctx, `
		INSERT INTO agent_runtime (workspace_id, daemon_id, name, runtime_mode, provider, status, device_info, metadata, last_seen_at, visibility, owner_id, profile_id)
		VALUES ($1, 'acct-other-machine', 'other-runtime', 'local', 'codebuddy', 'online', 'x', '{}'::jsonb, now(), 'public', $2, $3)
		RETURNING id`, testWorkspaceID, testUserID, env.codebuddyProfile).Scan(&otherRuntime); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { testPool.Exec(context.Background(), `DELETE FROM agent_runtime WHERE id=$1`, otherRuntime) })
	createManaged := func(runtimeID string) string {
		t.Helper()
		rec := createAccountAs(t, testUserID, map[string]any{"managed": true, "runtime_id": runtimeID})
		if rec.Code != http.StatusAccepted {
			t.Fatalf("managed create = %d: %s", rec.Code, rec.Body)
		}
		var account WorkspaceAccountResponse
		decodeJSON(t, rec, &account)
		if _, err := testPool.Exec(ctx, `UPDATE workspace_account SET state='connected', enabled=TRUE WHERE id=$1`, parseUUID(account.ID)); err != nil {
			t.Fatal(err)
		}
		return account.ID
	}
	owned := createManaged(env.codebuddyRuntime)
	foreign := createManaged(otherRuntime)
	manual := mustCreateAccount(t, "shared-manual")
	for runtimeID, wantManaged := range map[string]string{env.codebuddyRuntime: owned, otherRuntime: foreign} {
		rows, err := testHandler.Queries.ListAccountsForDispatch(ctx, db.ListAccountsForDispatchParams{
			WorkspaceID: parseUUID(testWorkspaceID), Provider: accountProviderFreebuffDesktop, RuntimeID: parseUUID(runtimeID),
		})
		if err != nil {
			t.Fatal(err)
		}
		foundManual, foundOwned, foundForeign := false, false, false
		for _, row := range rows {
			id := uuidToString(row.ID)
			foundManual = foundManual || id == manual.ID
			foundOwned = foundOwned || id == wantManaged
			foundForeign = foundForeign || (id == owned && id != wantManaged) || (id == foreign && id != wantManaged)
		}
		if !foundManual || !foundOwned || foundForeign {
			t.Fatalf("runtime %s dispatch rows=%+v; manual=%v owned=%v foreign=%v", runtimeID, rows, foundManual, foundOwned, foundForeign)
		}
	}
}

func createAgentWithAccount(t *testing.T, runtimeID string, extra map[string]any) *httptest.ResponseRecorder {
	t.Helper()
	body := map[string]any{"name": fmt.Sprintf("acct-agent-%d", time.Now().UnixNano()), "runtime_id": runtimeID}
	for k, v := range extra {
		body[k] = v
	}
	return testutil.Call(t, testHandler.CreateAgent, newRequest(http.MethodPost, "/api/agents", body)).ResponseRecorder
}

func TestAgentAccountSelectionValidationAndDemotion(t *testing.T) {
	env := newAccountTestEnv(t)
	acc := mustCreateAccount(t, "beta")

	// Bad input is a 400, never a 500 or a panic.
	for name, extra := range map[string]map[string]any{
		"specific without id": {"account_mode": "specific"},
		"bad uuid":            {"account_mode": "specific", "account_id": "nope"},
		"unknown mode":        {"account_mode": "sometimes"},
		"id with default":     {"account_mode": "default", "account_id": acc.ID},
		"foreign account":     {"account_mode": "specific", "account_id": env.foreignAccountID},
	} {
		if rec := createAgentWithAccount(t, env.codebuddyRuntime, extra); rec.Code != http.StatusBadRequest {
			t.Errorf("%s: status = %d, want 400: %s", name, rec.Code, rec.Body)
		}
	}
	// A runtime that cannot run accounts refuses them.
	if rec := createAgentWithAccount(t, handlerTestRuntimeID(t), map[string]any{"account_mode": "any"}); rec.Code != http.StatusBadRequest {
		// handlerTestRuntimeID may itself be a codebuddy runtime in some fixtures.
		var provider string
		testPool.QueryRow(context.Background(), `SELECT provider FROM agent_runtime WHERE id = $1`, handlerTestRuntimeID(t)).Scan(&provider)
		if provider != "codebuddy" {
			t.Fatalf("account on %s runtime = %d, want 400", provider, rec.Code)
		}
	}

	// A disabled account cannot be selected.
	testutil.Call(t, testHandler.UpdateWorkspaceAccount, withURLParams(
		newRequest(http.MethodPatch, "/x", map[string]any{"enabled": false}), "id", testWorkspaceID, "accountId", acc.ID)).Want(http.StatusOK)
	if rec := createAgentWithAccount(t, env.codebuddyRuntime, map[string]any{"account_mode": "specific", "account_id": acc.ID}); rec.Code != http.StatusBadRequest {
		t.Fatalf("disabled account = %d, want 400", rec.Code)
	}
	testutil.Call(t, testHandler.UpdateWorkspaceAccount, withURLParams(
		newRequest(http.MethodPatch, "/x", map[string]any{"enabled": true}), "id", testWorkspaceID, "accountId", acc.ID)).Want(http.StatusOK)

	var created AgentResponse
	rec := createAgentWithAccount(t, env.codebuddyRuntime, map[string]any{"account_mode": "specific", "account_id": acc.ID})
	if rec.Code != http.StatusCreated {
		t.Fatalf("create with account = %d: %s", rec.Code, rec.Body)
	}
	decodeJSON(t, rec, &created)
	t.Cleanup(func() { testPool.Exec(context.Background(), `DELETE FROM agent WHERE id = $1`, created.ID) })
	if created.AccountMode != "specific" || created.AccountID != acc.ID {
		t.Fatalf("created agent account = %q/%q", created.AccountMode, created.AccountID)
	}

	update := func(body map[string]any) (*httptest.ResponseRecorder, AgentResponse) {
		rec := testutil.Call(t, testHandler.UpdateAgent, withURLParam(newRequest(http.MethodPut, "/api/agents/"+created.ID, body), "id", created.ID)).ResponseRecorder
		var out AgentResponse
		if rec.Code == http.StatusOK {
			decodeJSON(t, rec, &out)
		}
		return rec, out
	}
	// An unrelated update leaves the account alone.
	if rec, out := update(map[string]any{"description": "still bound"}); rec.Code != http.StatusOK || out.AccountMode != "specific" || out.AccountID != acc.ID {
		t.Fatalf("unrelated update changed the account: %d %+v", rec.Code, out)
	}
	// specific -> any clears the id in one step.
	if rec, out := update(map[string]any{"account_mode": "any"}); rec.Code != http.StatusOK || out.AccountMode != "any" || out.AccountID != "" {
		t.Fatalf("to any: %d %+v", rec.Code, out)
	}
	// An id alone on a non-specific agent is rejected, not stored.
	if rec, _ := update(map[string]any{"account_id": acc.ID}); rec.Code != http.StatusBadRequest {
		t.Fatalf("id on an any agent = %d, want 400", rec.Code)
	}
	if rec, out := update(map[string]any{"account_mode": "specific", "account_id": acc.ID}); rec.Code != http.StatusOK || out.AccountID != acc.ID {
		t.Fatalf("back to specific: %d %+v", rec.Code, out)
	}

	// Deleting the account demotes the agent in the same step.
	testutil.Call(t, testHandler.DeleteWorkspaceAccount, withURLParams(newRequest(http.MethodDelete, "/x", nil),
		"id", testWorkspaceID, "accountId", acc.ID)).Want(http.StatusOK)
	var mode string
	var accountID pgtype.UUID
	if err := testPool.QueryRow(context.Background(), `SELECT account_mode, account_id FROM agent WHERE id = $1`, created.ID).Scan(&mode, &accountID); err != nil {
		t.Fatal(err)
	}
	if mode != "default" || accountID.Valid {
		t.Fatalf("agent after account delete = %q / valid=%v, want default / none", mode, accountID.Valid)
	}
}

func insertAccountTask(t *testing.T, agentID, runtimeID string, accountID pgtype.UUID, status string) {
	t.Helper()
	var id string
	if err := testPool.QueryRow(context.Background(), `
		INSERT INTO agent_task_queue (agent_id, runtime_id, status, priority, account_id)
		VALUES ($1, $2, $3, 0, $4) RETURNING id`, agentID, runtimeID, status, accountID).Scan(&id); err != nil {
		t.Fatalf("insert task: %v", err)
	}
	t.Cleanup(func() { testPool.Exec(context.Background(), `DELETE FROM agent_task_queue WHERE id = $1`, id) })
}

// The lease: an agent waits while its account (or, for `any`, every account) is
// running a task, and `any` hands out the least busy account.
func TestAccountLeaseBlocksAndBalances(t *testing.T) {
	env := newAccountTestEnv(t)
	ctx := context.Background()
	a, b := mustCreateAccount(t, "lease-a"), mustCreateAccount(t, "lease-b")
	aID, bID := parseUUID(a.ID), parseUUID(b.ID)

	mkAgent := func(mode string, accountID string) string {
		extra := map[string]any{"account_mode": mode}
		if accountID != "" {
			extra["account_id"] = accountID
		}
		rec := createAgentWithAccount(t, env.codebuddyRuntime, extra)
		if rec.Code != http.StatusCreated {
			t.Fatalf("create %s agent = %d: %s", mode, rec.Code, rec.Body)
		}
		var out AgentResponse
		decodeJSON(t, rec, &out)
		t.Cleanup(func() { testPool.Exec(context.Background(), `DELETE FROM agent WHERE id = $1`, out.ID) })
		return out.ID
	}
	onA, onB, onAny := mkAgent("specific", a.ID), mkAgent("specific", b.ID), mkAgent("any", "")
	blocked := func(agentID string) bool {
		got, err := testHandler.Queries.AgentAccountBlocked(ctx, db.AgentAccountBlockedParams{ID: parseUUID(agentID), RuntimeID: parseUUID(env.codebuddyRuntime)})
		if err != nil {
			t.Fatal(err)
		}
		return got
	}

	if blocked(onA) || blocked(onB) || blocked(onAny) {
		t.Fatal("nothing is running: no agent may be blocked")
	}

	insertAccountTask(t, onAny, env.codebuddyRuntime, aID, "running")
	if !blocked(onA) {
		t.Fatal("agent on account A must wait while A is running a task")
	}
	if blocked(onB) {
		t.Fatal("agent on account B must not wait for A")
	}
	if blocked(onAny) {
		t.Fatal("an `any` agent must not wait while account B is free")
	}
	rows, err := testHandler.Queries.ListAccountsForDispatch(ctx, db.ListAccountsForDispatchParams{
		WorkspaceID: parseUUID(testWorkspaceID), Provider: "freebuff-desktop"})
	if err != nil || len(rows) != 2 || uuidToString(rows[0].ID) != b.ID {
		t.Fatalf("least busy account should be B first, got %+v (err %v)", rows, err)
	}

	insertAccountTask(t, onB, env.codebuddyRuntime, bID, "dispatched")
	if !blocked(onAny) {
		t.Fatal("an `any` agent must wait when every account is busy")
	}

	// A finished task releases the account.
	if _, err := testPool.Exec(ctx, `UPDATE agent_task_queue SET status = 'completed', completed_at = now() WHERE account_id = $1`, aID); err != nil {
		t.Fatal(err)
	}
	if blocked(onA) || blocked(onAny) {
		t.Fatal("a completed task must release its account")
	}
}

func TestResolveModelAccountsScopesToTheWorkspace(t *testing.T) {
	env := newAccountTestEnv(t)
	ctx := context.Background()
	a := mustCreateAccount(t, "scope-a")
	b := mustCreateAccount(t, "scope-b")
	testutil.Call(t, testHandler.UpdateWorkspaceAccount, withURLParams(
		newRequest(http.MethodPatch, "/x", map[string]any{"enabled": false}), "id", testWorkspaceID, "accountId", b.ID)).Want(http.StatusOK)

	q := testHandler.Queries
	if got := resolveModelAccounts(ctx, q, env.codebuddyRuntime, "default"); got != nil {
		t.Fatalf("default scope = %+v", got)
	}
	all := resolveModelAccounts(ctx, q, env.codebuddyRuntime, "all")
	if len(all) != 1 || all[0].ID != a.ID || all[0].CredentialRef != "ref-scope-a" {
		t.Fatalf("all = %+v, want only the enabled account", all)
	}
	if got := resolveModelAccounts(ctx, q, env.codebuddyRuntime, a.ID); len(got) != 1 || got[0].ID != a.ID {
		t.Fatalf("specific = %+v", got)
	}
	if got := resolveModelAccounts(ctx, q, env.codebuddyRuntime, b.ID); len(got) != 0 {
		t.Fatalf("a disabled account must not be enumerated: %+v", got)
	}
	if got := resolveModelAccounts(ctx, q, env.codebuddyRuntime, env.foreignAccountID); len(got) != 0 {
		t.Fatalf("another workspace's account must not be enumerated: %+v", got)
	}
}

// Lease eligibility must match dispatch eligibility for the claiming runtime,
// while manual accounts remain available to both runtimes.
func TestAccountLeaseScopesManagedAccountsToClaimingRuntime(t *testing.T) {
	env := newAccountTestEnv(t)
	ctx := context.Background()
	var otherRuntime string
	if err := testPool.QueryRow(ctx, `INSERT INTO agent_runtime (workspace_id, daemon_id, name, runtime_mode, provider, status, device_info, metadata, last_seen_at, visibility, owner_id, profile_id)
		VALUES ($1, 'lease-other-machine', 'lease-other', 'local', 'codebuddy', 'online', 'x', '{}'::jsonb, now(), 'public', $2, $3) RETURNING id`, testWorkspaceID, testUserID, env.codebuddyProfile).Scan(&otherRuntime); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { testPool.Exec(context.Background(), `DELETE FROM agent_runtime WHERE id=$1`, otherRuntime) })
	createManaged := func(runtimeID string) string {
		t.Helper()
		rec := createAccountAs(t, testUserID, map[string]any{"managed": true, "runtime_id": runtimeID})
		if rec.Code != http.StatusAccepted {
			t.Fatalf("managed create: %d %s", rec.Code, rec.Body)
		}
		var acc WorkspaceAccountResponse
		decodeJSON(t, rec, &acc)
		if _, err := testPool.Exec(ctx, `UPDATE workspace_account SET state='connected' WHERE id=$1`, acc.ID); err != nil {
			t.Fatal(err)
		}
		return acc.ID
	}
	a, b := createManaged(env.codebuddyRuntime), createManaged(otherRuntime)
	rec := createAgentWithAccount(t, env.codebuddyRuntime, map[string]any{"account_mode": "any"})
	if rec.Code != http.StatusCreated {
		t.Fatalf("agent create: %d %s", rec.Code, rec.Body)
	}
	var ag AgentResponse
	decodeJSON(t, rec, &ag)
	t.Cleanup(func() { testPool.Exec(context.Background(), `DELETE FROM agent WHERE id=$1`, ag.ID) })
	blocked := func(runtimeID string) bool {
		t.Helper()
		got, err := testHandler.Queries.AgentAccountBlocked(ctx, db.AgentAccountBlockedParams{ID: parseUUID(ag.ID), RuntimeID: parseUUID(runtimeID)})
		if err != nil {
			t.Fatal(err)
		}
		return got
	}
	insertAccountTask(t, ag.ID, env.codebuddyRuntime, parseUUID(a), "running")
	if !blocked(env.codebuddyRuntime) || blocked(otherRuntime) {
		t.Fatal("busy A must block A but not idle B")
	}
	insertAccountTask(t, ag.ID, otherRuntime, parseUUID(b), "dispatched")
	if _, err := testPool.Exec(ctx, `UPDATE agent_task_queue SET status='completed', completed_at=now() WHERE account_id=$1`, a); err != nil {
		t.Fatal(err)
	}
	if blocked(env.codebuddyRuntime) || !blocked(otherRuntime) {
		t.Fatal("idle A must not block A or unblock busy B")
	}
	manual := mustCreateAccount(t, "lease-shared")
	if blocked(otherRuntime) {
		t.Fatal("idle shared manual account must unblock B")
	}
	insertAccountTask(t, ag.ID, otherRuntime, parseUUID(manual.ID), "running")
	if !blocked(otherRuntime) || blocked(env.codebuddyRuntime) {
		t.Fatal("busy shared manual and B must block B, while idle A remains usable")
	}
	if _, err := testPool.Exec(ctx, `UPDATE workspace_account SET state='signed_out' WHERE id=$1`, b); err != nil {
		t.Fatal(err)
	}
	if !blocked(otherRuntime) {
		t.Fatal("signed-out B must not unblock a busy shared account")
	}
}

func TestManagedAccountEngineVersion(t *testing.T) {
	env := newAccountTestEnv(t)
	rec := createAccountAs(t, testUserID, map[string]any{"managed": true, "runtime_id": env.codebuddyRuntime})
	if rec.Code != http.StatusAccepted {
		t.Fatalf("create: %d %s", rec.Code, rec.Body)
	}
	var account WorkspaceAccountResponse
	decodeJSON(t, rec, &account)
	update := func(user, id, version string) *testutil.Response {
		return testutil.Call(t, testHandler.UpdateWorkspaceAccount, withURLParams(newRequestAs(user, http.MethodPatch, "/x", map[string]any{"engine_version": version}), "id", testWorkspaceID, "accountId", id))
	}
	if got := update(env.memberUserID, account.ID, "0.0.196"); got.Code != http.StatusForbidden {
		t.Fatalf("member: %d %s", got.Code, got.Body)
	}
	manual := mustCreateAccount(t, "engine-manual")
	if got := update(testUserID, manual.ID, "0.0.196"); got.Code != http.StatusBadRequest {
		t.Fatalf("unmanaged: %d %s", got.Code, got.Body)
	}
	if got := update(testUserID, account.ID, "../bad"); got.Code != http.StatusBadRequest {
		t.Fatalf("invalid: %d %s", got.Code, got.Body)
	}
	// Before any versions have been reported, a valid pin is accepted.
	update(testUserID, account.ID, "0.0.196").Want(http.StatusOK)
	report := func(body map[string]any) {
		testutil.Call(t, testHandler.ReportFreebuffDesktopAccount, withURLParam(newOwnerDaemonRequest(http.MethodPost, "/x", body), "runtimeId", env.codebuddyRuntime)).Want(http.StatusOK)
	}
	report(map[string]any{"versions": []map[string]string{{"version": "0.0.196", "commit": "abc"}}})
	if got := update(testUserID, account.ID, "0.0.197"); got.Code != http.StatusConflict {
		t.Fatalf("unknown: %d %s", got.Code, got.Body)
	}
	update(testUserID, account.ID, "0.0.196").Want(http.StatusOK)
	// The list carries the runtime's installed versions for managed accounts only.
	var listed struct {
		Accounts []WorkspaceAccountResponse `json:"accounts"`
	}
	testutil.Call(t, testHandler.ListWorkspaceAccounts, withURLParam(
		newRequestAs(testUserID, http.MethodGet, "/x", nil), "id", testWorkspaceID,
	)).Want(http.StatusOK).JSON(&listed)
	sawManaged, sawManual := false, false
	for _, row := range listed.Accounts {
		switch row.ID {
		case account.ID:
			sawManaged = true
			if len(row.InstalledVersions) != 1 || row.InstalledVersions[0].Version != "0.0.196" || row.InstalledVersions[0].Commit != "abc" {
				t.Fatalf("managed account installed_versions: %#v", row.InstalledVersions)
			}
		case manual.ID:
			sawManual = true
			if len(row.InstalledVersions) != 0 {
				t.Fatalf("unmanaged account exposed installed_versions: %#v", row.InstalledVersions)
			}
		}
	}
	if !sawManaged || !sawManual {
		t.Fatalf("list omitted accounts: managed=%v manual=%v", sawManaged, sawManual)
	}
	if _, err := testPool.Exec(context.Background(), `UPDATE workspace_account SET state='connected' WHERE id=$1`, account.ID); err != nil {
		t.Fatal(err)
	}
	var pending struct {
		Accounts []map[string]any  `json:"accounts"`
		Pins     map[string]string `json:"pins"`
	}
	testutil.Call(t, testHandler.GetFreebuffDesktopPending, withURLParam(newOwnerDaemonRequest(http.MethodGet, "/x", nil), "runtimeId", env.codebuddyRuntime)).Want(http.StatusOK).JSON(&pending)
	if pending.Pins[account.DaemonAccountID] != "0.0.196" {
		t.Fatalf("connected account pin: %#v", pending.Pins)
	}
	for _, row := range pending.Accounts {
		if row["id"] == account.DaemonAccountID {
			t.Fatalf("connected account included in lifecycle queue: %#v", row)
		}
	}
	var metadata []byte
	if err := testPool.QueryRow(context.Background(), `SELECT metadata FROM agent_runtime WHERE id=$1`, env.codebuddyRuntime).Scan(&metadata); err != nil {
		t.Fatal(err)
	}
	versions := freebuffBlockFromMetadata(metadata).InstalledVersions
	if len(versions) != 1 || versions[0].Commit != "abc" {
		t.Fatalf("reported versions: %#v", versions)
	}
	report(map[string]any{"accounts": []any{}}) // older reports must not erase the versions
	if err := testPool.QueryRow(context.Background(), `SELECT metadata FROM agent_runtime WHERE id=$1`, env.codebuddyRuntime).Scan(&metadata); err != nil {
		t.Fatal(err)
	}
	if len(freebuffBlockFromMetadata(metadata).InstalledVersions) != 1 {
		t.Fatal("omitted versions erased report")
	}
	update(testUserID, account.ID, "").Want(http.StatusOK).JSON(&account)
	if account.EngineVersion != "" {
		t.Fatalf("pin not cleared: %+v", account)
	}
	report(map[string]any{"versions": []any{}})
	if got := update(testUserID, account.ID, "0.0.196"); got.Code != http.StatusConflict {
		t.Fatalf("empty installed list: %d %s", got.Code, got.Body)
	}
}
