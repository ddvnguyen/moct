package handler

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"
	"testing"

	"github.com/multica-ai/multica/server/internal/testutil"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
)

// interactionsFixture is a workspace with an owner member, plus a project in
// it. The requester is testUserID, the same actor `newRequest` stamps, so the
// handler-level admin checks pass unless a test deliberately demotes them.
type interactionsFixture struct {
	WorkspaceID string
	ProjectID   string
}

func setupInteractionsFixture(t *testing.T, slug string) interactionsFixture {
	t.Helper()
	ctx := context.Background()
	_, _ = testPool.Exec(ctx, `DELETE FROM workspace WHERE slug = $1`, slug)

	wsID := dbfx.Insert(t, "workspace", testutil.Cols{
		"name":        "Interactions " + slug,
		"slug":        slug,
		"description": "M-123 settings fixture",
	})
	dbfx.Exec(t, `
INSERT INTO member (workspace_id, user_id, role) VALUES ($1, $2, 'owner')
`, wsID, testUserID)
	projectID := dbfx.Insert(t, "project", testutil.Cols{
		"workspace_id": wsID,
		"title":        "Interactions project",
	})
	t.Cleanup(func() {
		_, _ = testPool.Exec(context.Background(), `DELETE FROM workspace WHERE id = $1`, wsID)
	})
	return interactionsFixture{WorkspaceID: wsID, ProjectID: projectID}
}

func interactionsRequest(t *testing.T, method, path, workspaceID string, body any) *http.Request {
	t.Helper()
	req := newRequest(method, path, body)
	req.Header.Set("X-Workspace-ID", workspaceID)
	return withURLParam(req, "id", workspaceID)
}

// storedSetting reads one key straight out of the table, so the assertions do
// not depend on the response shape they are checking.
func storedSetting(t *testing.T, table, key, workspaceID, projectID string) (any, bool) {
	t.Helper()
	query := `SELECT settings FROM ` + table + ` WHERE id = $1`
	id := workspaceID
	if table == "project" {
		id = projectID
	}
	var raw []byte
	dbfx.QueryRow(t, query, id).Scan(&raw)
	var object map[string]any
	if err := json.Unmarshal(raw, &object); err != nil {
		t.Fatalf("decode %s.settings: %v", table, err)
	}
	value, ok := object[key]
	return value, ok
}

// The card's headline value: ten minutes out of the box, editable at the
// workspace, and resettable to the built-in default rather than to whichever
// number happened to be stored.
func TestInteractions_WorkspaceTimeoutRoundTrip(t *testing.T) {
	if testHandler == nil {
		t.Skip("database not available")
	}
	fx := setupInteractionsFixture(t, "handler-tests-interactions-roundtrip")

	read := func() InteractionsResponse {
		t.Helper()
		w := testutil.Call(t, testHandler.GetInteractions,
			interactionsRequest(t, "GET", "/api/workspaces/"+fx.WorkspaceID+"/interactions", fx.WorkspaceID, nil)).
			Want(http.StatusOK)
		var body InteractionsResponse
		w.JSON(&body)
		return body
	}

	initial := read()
	if initial.TimeoutSeconds != interactionsDefaultTimeoutSeconds {
		t.Fatalf("default timeout = %d, want %d", initial.TimeoutSeconds, interactionsDefaultTimeoutSeconds)
	}
	if initial.TimeoutSecondsSet {
		t.Fatal("a workspace that never set a timeout must report timeout_seconds_set=false")
	}
	if initial.MinTimeoutSeconds != interactionsMinTimeoutSeconds || initial.MaxTimeoutSeconds != interactionsMaxTimeoutSeconds {
		t.Fatalf("bounds = %d..%d, want %d..%d",
			initial.MinTimeoutSeconds, initial.MaxTimeoutSeconds,
			interactionsMinTimeoutSeconds, interactionsMaxTimeoutSeconds)
	}
	if len(initial.Overrides) != 0 {
		t.Fatalf("overrides = %+v, want none", initial.Overrides)
	}
	// The reader is the workspace owner in this fixture, so the panel gets an
	// editor; a member gets editable=false (TestProjectInteractions_RequiresAdmin).
	if !initial.Editable {
		t.Fatal("a workspace owner must read editable=true")
	}

	updated := testutil.Call(t, testHandler.UpdateInteractions,
		interactionsRequest(t, "PUT", "/api/workspaces/"+fx.WorkspaceID+"/interactions", fx.WorkspaceID,
			map[string]any{"timeout_seconds": 900})).Want(http.StatusOK)
	var afterWrite InteractionsResponse
	updated.JSON(&afterWrite)
	if afterWrite.TimeoutSeconds != 900 || !afterWrite.TimeoutSecondsSet {
		t.Fatalf("after write: %+v, want 900/set", afterWrite)
	}
	if value, ok := storedSetting(t, "workspace", askPlanTimeoutSettingKey, fx.WorkspaceID, ""); !ok || value != float64(900) {
		t.Fatalf("stored timeout = %v (present=%v), want 900", value, ok)
	}
	if got := read(); got.TimeoutSeconds != 900 || !got.TimeoutSecondsSet {
		t.Fatalf("read back: %+v, want 900/set", got)
	}

	// null means "back to the built-in default", which must REMOVE the key:
	// pinning today's default into the row would freeze it across an upgrade.
	cleared := testutil.Call(t, testHandler.UpdateInteractions,
		interactionsRequest(t, "PUT", "/api/workspaces/"+fx.WorkspaceID+"/interactions", fx.WorkspaceID,
			map[string]any{"timeout_seconds": nil})).Want(http.StatusOK)
	var afterClear InteractionsResponse
	cleared.JSON(&afterClear)
	if afterClear.TimeoutSeconds != interactionsDefaultTimeoutSeconds || afterClear.TimeoutSecondsSet {
		t.Fatalf("after clear: %+v, want the default/unset", afterClear)
	}
	if _, ok := storedSetting(t, "workspace", askPlanTimeoutSettingKey, fx.WorkspaceID, ""); ok {
		t.Fatal("clearing the timeout must remove the key, not store the default")
	}
}

func TestInteractions_RejectsInvalidTimeout(t *testing.T) {
	if testHandler == nil {
		t.Skip("database not available")
	}
	fx := setupInteractionsFixture(t, "handler-tests-interactions-validation")
	path := "/api/workspaces/" + fx.WorkspaceID + "/interactions"

	cases := []struct {
		name string
		body any
	}{
		{"below the floor", map[string]any{"timeout_seconds": 30}},
		{"above the ceiling", map[string]any{"timeout_seconds": 86401}},
		{"fractional", map[string]any{"timeout_seconds": 600.5}},
		{"a string", map[string]any{"timeout_seconds": "600"}},
		{"absent", map[string]any{}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			testutil.Call(t, testHandler.UpdateInteractions,
				interactionsRequest(t, "PUT", path, fx.WorkspaceID, tc.body)).Want(http.StatusBadRequest)
		})
	}

	// Nothing above may have been written.
	if _, ok := storedSetting(t, "workspace", askPlanTimeoutSettingKey, fx.WorkspaceID, ""); ok {
		t.Fatal("a rejected write must not persist a value")
	}
}

// A project's own wait wins over the workspace's, and clearing it returns the
// project to the workspace default instead of to a copy of it.
func TestInteractions_ProjectOverride(t *testing.T) {
	if testHandler == nil {
		t.Skip("database not available")
	}
	fx := setupInteractionsFixture(t, "handler-tests-interactions-project")

	testutil.Call(t, testHandler.UpdateInteractions,
		interactionsRequest(t, "PUT", "/api/workspaces/"+fx.WorkspaceID+"/interactions", fx.WorkspaceID,
			map[string]any{"timeout_seconds": 600})).Want(http.StatusOK)

	projectReq := func(body any) *http.Request {
		req := newRequest("PUT", "/api/projects/"+fx.ProjectID+"/interactions", body)
		req.Header.Set("X-Workspace-ID", fx.WorkspaceID)
		return withURLParam(req, "id", fx.ProjectID)
	}

	w := testutil.Call(t, testHandler.SetProjectInteractions, projectReq(map[string]any{"timeout_seconds": 1800})).
		Want(http.StatusOK)
	var written map[string]any
	w.JSON(&written)
	if written["timeout_seconds"] != float64(1800) || written["timeout_seconds_set"] != true {
		t.Fatalf("project write answered %+v, want 1800/set", written)
	}
	if value, ok := storedSetting(t, "project", askPlanTimeoutSettingKey, fx.WorkspaceID, fx.ProjectID); !ok || value != float64(1800) {
		t.Fatalf("stored project timeout = %v (present=%v), want 1800", value, ok)
	}

	// The workspace read lists it, which is what the Interactions tab shows.
	var listed InteractionsResponse
	testutil.Call(t, testHandler.GetInteractions,
		interactionsRequest(t, "GET", "/api/workspaces/"+fx.WorkspaceID+"/interactions", fx.WorkspaceID, nil)).
		Want(http.StatusOK).JSON(&listed)
	if len(listed.Overrides) != 1 || listed.Overrides[0].ProjectID != fx.ProjectID || listed.Overrides[0].TimeoutSeconds != 1800 {
		t.Fatalf("overrides = %+v, want the project at 1800", listed.Overrides)
	}
	if listed.Overrides[0].ProjectTitle != "Interactions project" {
		t.Fatalf("override title = %q, want the project's title", listed.Overrides[0].ProjectTitle)
	}

	// Clearing it falls back to the workspace value, not to the built-in one.
	var cleared map[string]any
	testutil.Call(t, testHandler.SetProjectInteractions, projectReq(map[string]any{"timeout_seconds": nil})).
		Want(http.StatusOK).JSON(&cleared)
	if cleared["timeout_seconds"] != float64(600) || cleared["timeout_seconds_set"] != true {
		t.Fatalf("after clearing the override: %+v, want the workspace 600", cleared)
	}
	if _, ok := storedSetting(t, "project", askPlanTimeoutSettingKey, fx.WorkspaceID, fx.ProjectID); ok {
		t.Fatal("clearing an override must remove the key")
	}
}

// A plain member cannot widen (or narrow) a project's wait; the write is an
// admin decision, unlike the member-visible read.
func TestProjectInteractions_RequiresAdmin(t *testing.T) {
	if testHandler == nil {
		t.Skip("database not available")
	}
	fx := setupInteractionsFixture(t, "handler-tests-interactions-admin")
	dbfx.Exec(t, `UPDATE member SET role = 'member' WHERE workspace_id = $1 AND user_id = $2`,
		fx.WorkspaceID, testUserID)

	req := newRequest("PUT", "/api/projects/"+fx.ProjectID+"/interactions",
		map[string]any{"timeout_seconds": 1800})
	req.Header.Set("X-Workspace-ID", fx.WorkspaceID)
	req = withURLParam(req, "id", fx.ProjectID)
	testutil.Call(t, testHandler.SetProjectInteractions, req).Want(http.StatusForbidden)

	if _, ok := storedSetting(t, "project", askPlanTimeoutSettingKey, fx.WorkspaceID, fx.ProjectID); ok {
		t.Fatal("a refused project write must not persist a value")
	}

	// The read stays available to that same member — read-only.
	var visible InteractionsResponse
	testutil.Call(t, testHandler.GetInteractions,
		interactionsRequest(t, "GET", "/api/workspaces/"+fx.WorkspaceID+"/interactions", fx.WorkspaceID, nil)).
		Want(http.StatusOK).JSON(&visible)
	if visible.Editable {
		t.Fatal("a plain member must read editable=false")
	}

	var memory MoctSettingsResponse
	testutil.Call(t, testHandler.GetMoctSettings,
		interactionsRequest(t, "GET", "/api/workspaces/"+fx.WorkspaceID+"/moct", fx.WorkspaceID, nil)).
		Want(http.StatusOK).JSON(&memory)
	if memory.Editable {
		t.Fatal("a plain member must read editable=false for the memory switch")
	}
}

// The memory switch: on when nothing says otherwise, off only when an admin
// says so, and always reported to the reader as a decision or a default.
func TestMoctSettings_InjectSwitch(t *testing.T) {
	if testHandler == nil {
		t.Skip("database not available")
	}
	fx := setupInteractionsFixture(t, "handler-tests-moct-inject")
	path := "/api/workspaces/" + fx.WorkspaceID + "/moct"

	var initial MoctSettingsResponse
	testutil.Call(t, testHandler.GetMoctSettings,
		interactionsRequest(t, "GET", path, fx.WorkspaceID, nil)).Want(http.StatusOK).JSON(&initial)
	if !initial.MemoryInject || initial.MemoryInjectSet {
		t.Fatalf("initial state = %+v, want inject on and unset", initial)
	}

	var stored MoctSettingsResponse
	testutil.Call(t, testHandler.UpdateMoctSettings,
		interactionsRequest(t, "PUT", path, fx.WorkspaceID, map[string]any{"memory_inject": false})).
		Want(http.StatusOK).JSON(&stored)
	if stored.MemoryInject || !stored.MemoryInjectSet {
		t.Fatalf("after switching off: %+v, want off and set", stored)
	}
	if value, ok := storedSetting(t, "workspace", moctMemoryInjectSettingKey, fx.WorkspaceID, ""); !ok || value != false {
		t.Fatalf("stored memory_inject = %v (present=%v), want false", value, ok)
	}

	var back MoctSettingsResponse
	testutil.Call(t, testHandler.GetMoctSettings,
		interactionsRequest(t, "GET", path, fx.WorkspaceID, nil)).Want(http.StatusOK).JSON(&back)
	if back.MemoryInject || !back.MemoryInjectSet {
		t.Fatalf("read back = %+v, want off and set", back)
	}

	testutil.Call(t, testHandler.UpdateMoctSettings,
		interactionsRequest(t, "PUT", path, fx.WorkspaceID, map[string]any{"memory_inject": true})).
		Want(http.StatusOK)

	for _, body := range []any{
		map[string]any{"memory_inject": "yes"},
		map[string]any{"memory_inject": 1},
		map[string]any{},
	} {
		testutil.Call(t, testHandler.UpdateMoctSettings,
			interactionsRequest(t, "PUT", path, fx.WorkspaceID, body)).Want(http.StatusBadRequest)
	}
}

func TestTurnEndRouterSettings_Mode(t *testing.T) {
	if testHandler == nil {
		t.Skip("database not available")
	}
	fx := setupInteractionsFixture(t, "handler-tests-turn-end-router")
	path := "/api/workspaces/" + fx.WorkspaceID + "/turn-end-router"

	var initial TurnEndRouterSettingsResponse
	testutil.Call(t, testHandler.GetTurnEndRouterSettings,
		interactionsRequest(t, "GET", path, fx.WorkspaceID, nil)).Want(http.StatusOK).JSON(&initial)
	if initial.Mode != "shadow" || initial.ModeSet {
		t.Fatalf("initial setting = %+v, want default shadow and unset", initial)
	}
	if initial.ShadowWouldQueue24h != 0 || len(initial.RunsByReasonDestination24h) != 0 || len(initial.RunsPerIssue24h) != 0 || len(initial.RunsPerIssue7d) != 0 {
		t.Fatalf("initial router metrics = %+v, want zero counts and initialized histograms", initial)
	}
	if _, err := testPool.Exec(context.Background(), `INSERT INTO activity_log(workspace_id,actor_type,action,details)
		VALUES($1,'system','turn_end_router_shadow','{"reason":"run_failed","destination":"orchestrator"}')`, fx.WorkspaceID); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_, _ = testPool.Exec(context.Background(), `DELETE FROM activity_log WHERE workspace_id=$1 AND action='turn_end_router_shadow'`, fx.WorkspaceID)
	})
	var shadow TurnEndRouterSettingsResponse
	testutil.Call(t, testHandler.GetTurnEndRouterSettings,
		interactionsRequest(t, "GET", path, fx.WorkspaceID, nil)).Want(http.StatusOK).JSON(&shadow)
	if shadow.ShadowWouldQueue24h != 1 {
		t.Fatalf("shadow decisions = %d, want 1", shadow.ShadowWouldQueue24h)
	}

	var enabled TurnEndRouterSettingsResponse
	testutil.Call(t, testHandler.UpdateTurnEndRouterSettings,
		interactionsRequest(t, "PUT", path, fx.WorkspaceID, map[string]any{"mode": "on"})).
		Want(http.StatusOK).JSON(&enabled)
	if enabled.Mode != "on" || !enabled.ModeSet {
		t.Fatalf("after setting on = %+v", enabled)
	}
	if value, ok := storedSetting(t, "workspace", turnEndRouterSettingKey, fx.WorkspaceID, ""); !ok || value != "on" {
		t.Fatalf("stored mode = %v (present=%v), want on", value, ok)
	}
	for _, body := range []any{
		map[string]any{"mode": "enabled"},
		map[string]any{"mode": false},
		map[string]any{},
	} {
		testutil.Call(t, testHandler.UpdateTurnEndRouterSettings,
			interactionsRequest(t, "PUT", path, fx.WorkspaceID, body)).Want(http.StatusBadRequest)
	}
}

// An absent or malformed setting must read as ON. The switch exists to turn
// memory OFF; nothing about a settings object this file does not control may
// silently strip memory from every run in a workspace.
func TestMoctInjectEnabled_DefaultsOn(t *testing.T) {
	cases := []struct {
		name     string
		settings []byte
		want     bool
	}{
		{"no settings object", nil, true},
		{"empty object", []byte(`{}`), true},
		{"cannot be decoded", []byte(`[]`), true},
		{"explicitly on", []byte(`{"moct_memory_inject": true}`), true},
		{"explicitly off", []byte(`{"moct_memory_inject": false}`), false},
		{"malformed value", []byte(`{"moct_memory_inject": "false"}`), true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			ws := db.Workspace{Settings: tc.settings}
			if got := moctInjectEnabled(ws); got != tc.want {
				t.Fatalf("moctInjectEnabled(%s) = %v, want %v", tc.settings, got, tc.want)
			}
		})
	}
}

// The claim field's name and its three states are the daemon's contract:
// absent (a server predating the switch) keeps injecting, false suppresses the
// block, true injects. Pinned here because the daemon reads it by JSON name.
func TestAgentTaskResponse_MoctMemoryInjectWireName(t *testing.T) {
	encoder := func(value *bool) string {
		encoded, err := json.Marshal(AgentTaskResponse{MoctMemoryInject: value})
		if err != nil {
			t.Fatalf("marshal response: %v", err)
		}
		return string(encoded)
	}

	off := false
	if got := encoder(&off); !strings.Contains(got, `"moct_memory_inject":false`) {
		t.Fatalf("disabled claim = %s, want moct_memory_inject:false", got)
	}
	on := true
	if got := encoder(&on); !strings.Contains(got, `"moct_memory_inject":true`) {
		t.Fatalf("enabled claim = %s, want moct_memory_inject:true", got)
	}
	if got := encoder(nil); strings.Contains(got, "moct_memory_inject") {
		t.Fatalf("a server without the switch must omit the field, got %s", got)
	}
}

// TestEffectiveAskPlanTimeoutSeconds pins the one resolution order (M-123 Q2,
// M-131 amendment 1): project override, then workspace value, then the
// compiled-in default — with the source the sweep's escalation comment reads
// and `projectInteractionsResponse` derives `timeout_seconds_set` from. A key
// that is absent, malformed, a string, or out of the 60–86400 bounds counts as
// no opinion at all.
func TestEffectiveAskPlanTimeoutSeconds(t *testing.T) {
	cases := []struct {
		name        string
		project     string
		workspace   string
		wantSeconds int
		wantSource  TimeoutSource
	}{
		{"project override beats workspace", `{"ask_plan_timeout_seconds":120}`, `{"ask_plan_timeout_seconds":86400}`, 120, TimeoutSourceProject},
		{"project override beats default", `{"ask_plan_timeout_seconds":60}`, `{}`, 60, TimeoutSourceProject},
		{"workspace value when no project key", `{}`, `{"ask_plan_timeout_seconds":900}`, 900, TimeoutSourceWorkspace},
		{"out-of-bounds project falls through to workspace", `{"ask_plan_timeout_seconds":59}`, `{"ask_plan_timeout_seconds":900}`, 900, TimeoutSourceWorkspace},
		{"above-bounds workspace falls through to default", `{}`, `{"ask_plan_timeout_seconds":86401}`, 600, TimeoutSourceDefault},
		{"JSON string is not a number", `{"ask_plan_timeout_seconds":"600"}`, `{}`, 600, TimeoutSourceDefault},
		{"malformed workspace object reads as absent", `{}`, `not-json`, 600, TimeoutSourceDefault},
		{"both empty -> built-in default", `{}`, `{}`, 600, TimeoutSourceDefault},
		{"nil settings -> built-in default", ``, ``, 600, TimeoutSourceDefault},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got, source := EffectiveAskPlanTimeoutSeconds([]byte(tc.project), []byte(tc.workspace))
			if got != tc.wantSeconds || source != tc.wantSource {
				t.Fatalf("got (%d, %v), want (%d, %v)", got, source, tc.wantSeconds, tc.wantSource)
			}
			// The response's set flag is exactly "not the compiled-in default".
			if set := source != TimeoutSourceDefault; set != (tc.wantSource != TimeoutSourceDefault) {
				t.Fatalf("set flag mismatch for source %v", source)
			}
		})
	}
}
