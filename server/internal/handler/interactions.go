package handler

// S2-C (M-123): the two settings surfaces the dsh panel's MOCT group owns.
//
// The Connection tab answers "does a run get memory at all"; the Interactions
// tab answers "how long may an ask or a plan wait for a human". Both are
// workspace settings that a project may override, and both are read-only for
// everyone except a workspace owner or admin.
//
// Three deliberate limits, all of them the card's:
//
//   - The interaction wait is stored, surfaced, and ENFORCED by the sweeper
//     M-131 adds: nothing in this file cancels a parked run or writes the
//     notice a reader would get — the sweeper reaps a park past
//     EffectiveAskPlanTimeoutSeconds and escalates to the project lead. The
//     resolver lives here (and is exported) because the settings surfaces and
//     the sweeper must agree on one number and one source.
//   - The values live in the existing `workspace.settings` / `project.settings`
//     objects under their own keys rather than in a new column: every existing
//     reader treats those objects as open sets, and an absent key falls back to
//     the compiled-in default instead of pinning whatever the default was the
//     day the row was written.
//   - One key is written per request, in SQL (SetWorkspaceSetting /
//     SetProjectSetting). Round-tripping the whole object through the handler
//     would let two admins editing different keys silently overwrite each
//     other.

import (
	"context"
	"encoding/json"
	"log/slog"
	"math"
	"net/http"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/multica-ai/multica/server/internal/logger"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
	"github.com/multica-ai/multica/server/pkg/protocol"
)

const (
	// interactionsDefaultTimeoutSeconds is the shipped ask/plan wait: ten
	// minutes, the value the card names.
	interactionsDefaultTimeoutSeconds = 600
	// The bounds are the validation the card asks for. A minute is below any
	// useful human answer; a day is above any run that still wants resuming.
	interactionsMinTimeoutSeconds = 60
	interactionsMaxTimeoutSeconds = 86400

	// askPlanTimeoutSettingKey is the settings key of the ask/plan wait, on
	// workspace (the default) and on project (the override).
	askPlanTimeoutSettingKey = "ask_plan_timeout_seconds"
	// moctMemoryInjectSettingKey is the workspace switch for the pre-run memory
	// block. Absent means on: the seam has injected since M-101, and an upgrade
	// must not silently turn memory off for every existing workspace.
	moctMemoryInjectSettingKey = "moct_memory_inject"
)

// ProjectInteractionOverride is one project that waits longer (or shorter) than
// its workspace for an ask or a plan.
type ProjectInteractionOverride struct {
	ProjectID      string `json:"project_id"`
	ProjectTitle   string `json:"project_title"`
	TimeoutSeconds int    `json:"timeout_seconds"`
}

// InteractionsResponse is both the read shape and the answer to a write, so a
// reader never needs a second request to see what it just set.
type InteractionsResponse struct {
	// TimeoutSeconds is the effective workspace value.
	TimeoutSeconds int `json:"timeout_seconds"`
	// TimeoutSecondsSet is false while the workspace default is still the
	// built-in one.
	TimeoutSecondsSet bool `json:"timeout_seconds_set"`
	// The bounds travel with the value so an editor validates against the
	// server's rule instead of a copy of it that can drift.
	MinTimeoutSeconds int `json:"min_timeout_seconds"`
	MaxTimeoutSeconds int `json:"max_timeout_seconds"`
	// Editable is whether THIS reader may write, from their workspace role.
	// The panel renders an editor or a value from this flag instead of
	// inferring a role from the browser's own state.
	Editable  bool                         `json:"editable"`
	Overrides []ProjectInteractionOverride `json:"overrides"`
}

// MoctSettingsResponse is the Connection tab's server state: whether a run gets
// the pre-run memory block.
type MoctSettingsResponse struct {
	MemoryInject bool `json:"memory_inject"`
	// MemoryInjectSet is false while the switch sits at its built-in default
	// (on), so an editor can say "default" instead of claiming the reader chose
	// it.
	MemoryInjectSet bool `json:"memory_inject_set"`
	// Editable is whether THIS reader may flip the switch; see
	// InteractionsResponse.Editable.
	Editable bool `json:"editable"`
}

// UpdateInteractionsRequest carries one setting and distinguishes the three
// states a JSON body can express: absent (malformed request), null (back to the
// default) and a value.
type UpdateInteractionsRequest struct {
	TimeoutSeconds json.RawMessage `json:"timeout_seconds"`
}

// UpdateMoctSettingsRequest is the same contract for the toggle.
type UpdateMoctSettingsRequest struct {
	MemoryInject json.RawMessage `json:"memory_inject"`
}

// TurnEndRouterSettingsResponse exposes the workspace's turn-end routing mode.
type TurnEndRouterSettingsResponse struct {
	Mode                       string                        `json:"mode"`
	ModeSet                    bool                          `json:"mode_set"`
	Editable                   bool                          `json:"editable"`
	Runs24h                    int64                         `json:"runs_24h"`
	ProductiveRuns24h          int64                         `json:"productive_runs_24h"`
	ProductiveRatio24h         float64                       `json:"productive_ratio_24h"`
	ShadowWouldQueue24h        int64                         `json:"shadow_would_queue_24h"`
	RunsByReasonDestination24h []TurnEndRouterReasonMetric   `json:"runs_by_reason_destination_24h"`
	RunsPerIssue24h            []TurnEndRouterIssueRunBucket `json:"runs_per_issue_24h"`
	RunsPerIssue7d             []TurnEndRouterIssueRunBucket `json:"runs_per_issue_7d"`
}

type TurnEndRouterReasonMetric struct {
	Reason          string  `json:"reason"`
	Destination     string  `json:"destination"`
	Runs            int64   `json:"runs"`
	RunShare        float64 `json:"run_share"`
	ProductiveRuns  int64   `json:"productive_runs"`
	ProductiveRatio float64 `json:"productive_ratio"`
}

type TurnEndRouterIssueRunBucket struct {
	RunsPerIssue int64 `json:"runs_per_issue"`
	IssueCount   int64 `json:"issue_count"`
}

type UpdateTurnEndRouterSettingsRequest struct {
	Mode json.RawMessage `json:"mode"`
}

const turnEndRouterSettingKey = "turn_end_router_mode"

func turnEndRouterMode(settings []byte) (string, bool) {
	raw, ok := settingValue(settings, turnEndRouterSettingKey)
	if !ok {
		return "shadow", false
	}
	mode, ok := raw.(string)
	if !ok || (mode != "off" && mode != "shadow" && mode != "on") {
		return "shadow", false
	}
	return mode, true
}

func (h *Handler) GetTurnEndRouterSettings(w http.ResponseWriter, r *http.Request) {
	workspaceID := workspaceIDFromURL(r, "id")
	wsUUID, ok := parseUUIDOrBadRequest(w, workspaceID, "workspace id")
	if !ok {
		return
	}
	member, ok := h.requireWorkspaceMember(w, r, workspaceID, "workspace not found")
	if !ok {
		return
	}
	ws, err := h.Queries.GetWorkspace(r.Context(), wsUUID)
	if err != nil {
		writeError(w, http.StatusNotFound, "workspace not found")
		return
	}
	mode, set := turnEndRouterMode(ws.Settings)
	response, err := h.turnEndRouterMetrics(r.Context(), wsUUID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to load turn-end router metrics")
		return
	}
	response.Mode, response.ModeSet, response.Editable = mode, set, isWorkspaceAdmin(member)
	writeJSON(w, http.StatusOK, response)
}

func (h *Handler) UpdateTurnEndRouterSettings(w http.ResponseWriter, r *http.Request) {
	workspaceID := workspaceIDFromURL(r, "id")
	if _, ok := parseUUIDOrBadRequest(w, workspaceID, "workspace id"); !ok {
		return
	}
	var req UpdateTurnEndRouterSettingsRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	var mode string
	if len(req.Mode) == 0 || json.Unmarshal(req.Mode, &mode) != nil || (mode != "off" && mode != "shadow" && mode != "on") {
		writeError(w, http.StatusBadRequest, "mode must be off, shadow, or on")
		return
	}
	response, err := h.turnEndRouterMetrics(r.Context(), parseUUID(workspaceID))
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to load turn-end router metrics")
		return
	}
	updated, err := h.setWorkspaceSetting(r, workspaceID, turnEndRouterSettingKey, mode)
	if err != nil {
		slog.Error("update turn-end router settings failed", append(logger.RequestAttrs(r), "error", err)...)
		writeError(w, http.StatusInternalServerError, "failed to update turn-end router settings")
		return
	}
	h.publishWorkspaceSettingsChanged(r, updated)
	response.Mode, response.ModeSet, response.Editable = mode, true, true
	writeJSON(w, http.StatusOK, response)
}

func (h *Handler) turnEndRouterMetrics(ctx context.Context, workspaceID pgtype.UUID) (TurnEndRouterSettingsResponse, error) {
	response := TurnEndRouterSettingsResponse{
		RunsByReasonDestination24h: []TurnEndRouterReasonMetric{},
		RunsPerIssue24h:            []TurnEndRouterIssueRunBucket{},
		RunsPerIssue7d:             []TurnEndRouterIssueRunBucket{},
	}
	now := time.Now()
	dayAgo := pgtype.Timestamptz{Time: now.Add(-24 * time.Hour), Valid: true}
	weekAgo := pgtype.Timestamptz{Time: now.Add(-7 * 24 * time.Hour), Valid: true}
	stats, err := h.Queries.CountWorkspaceTurnEndRouterRunsSince(ctx, workspaceID)
	if err != nil {
		return response, err
	}
	response.Runs24h, response.ProductiveRuns24h = stats.RunCount, stats.ProductiveCount
	if stats.RunCount > 0 {
		response.ProductiveRatio24h = float64(stats.ProductiveCount) / float64(stats.RunCount)
	}
	response.ShadowWouldQueue24h, err = h.Queries.CountTurnEndRouterShadowWouldQueueSince(ctx, db.CountTurnEndRouterShadowWouldQueueSinceParams{WorkspaceID: workspaceID, Since: dayAgo})
	if err != nil {
		return response, err
	}
	reasons, err := h.Queries.ListTurnEndRouterReasonMetrics(ctx, db.ListTurnEndRouterReasonMetricsParams{WorkspaceID: workspaceID, Since: dayAgo})
	if err != nil {
		return response, err
	}
	for _, row := range reasons {
		metric := TurnEndRouterReasonMetric{Reason: row.Reason, Destination: row.Destination, Runs: row.RunCount, ProductiveRuns: row.ProductiveCount}
		if row.RunCount > 0 {
			metric.ProductiveRatio = float64(row.ProductiveCount) / float64(row.RunCount)
		}
		if stats.RunCount > 0 {
			metric.RunShare = float64(row.RunCount) / float64(stats.RunCount)
		}
		response.RunsByReasonDestination24h = append(response.RunsByReasonDestination24h, metric)
	}
	response.RunsPerIssue24h, err = h.turnEndRouterIssueHistogram(ctx, workspaceID, dayAgo)
	if err != nil {
		return response, err
	}
	response.RunsPerIssue7d, err = h.turnEndRouterIssueHistogram(ctx, workspaceID, weekAgo)
	return response, err
}

func (h *Handler) turnEndRouterIssueHistogram(ctx context.Context, workspaceID pgtype.UUID, since pgtype.Timestamptz) ([]TurnEndRouterIssueRunBucket, error) {
	rows, err := h.Queries.ListTurnEndRouterIssueRunHistogram(ctx, db.ListTurnEndRouterIssueRunHistogramParams{WorkspaceID: workspaceID, Since: since})
	if err != nil {
		return nil, err
	}
	result := make([]TurnEndRouterIssueRunBucket, 0, len(rows))
	for _, row := range rows {
		result = append(result, TurnEndRouterIssueRunBucket{RunsPerIssue: row.RunsPerIssue, IssueCount: row.IssueCount})
	}
	return result, nil
}

// settingNumber reads one numeric key out of a settings object. A value that is
// not a whole number counts as absent: a settings object can be written by
// clients this file does not control, and a malformed entry must read as "no
// opinion", never as a timeout of zero.
func settingNumber(settings []byte, key string) (int, bool) {
	raw, ok := settingValue(settings, key)
	if !ok {
		return 0, false
	}
	number, ok := raw.(float64)
	if !ok || math.IsNaN(number) || math.IsInf(number, 0) || number != math.Trunc(number) {
		return 0, false
	}
	return int(number), true
}

// settingBool reads one boolean key, with the same "malformed means absent"
// rule as settingNumber.
func settingBool(settings []byte, key string) (bool, bool) {
	raw, ok := settingValue(settings, key)
	if !ok {
		return false, false
	}
	value, ok := raw.(bool)
	return value, ok
}

func settingValue(settings []byte, key string) (any, bool) {
	if len(settings) == 0 {
		return nil, false
	}
	var object map[string]any
	if err := json.Unmarshal(settings, &object); err != nil {
		return nil, false
	}
	value, ok := object[key]
	return value, ok
}

// workspaceTimeoutSeconds is the workspace's ask/plan wait and whether it was
// chosen. An unset or malformed key is the built-in default.
func workspaceTimeoutSeconds(ws db.Workspace) (int, bool) {
	if seconds, ok := settingNumber(ws.Settings, askPlanTimeoutSettingKey); ok && validTimeoutSeconds(seconds) {
		return seconds, true
	}
	return interactionsDefaultTimeoutSeconds, false
}

func validTimeoutSeconds(seconds int) bool {
	return seconds >= interactionsMinTimeoutSeconds && seconds <= interactionsMaxTimeoutSeconds
}

// TimeoutSource names which setting supplied the effective ask/plan wait.
// M-131 amendment 1: the resolver answers the source alongside the seconds —
// the sweep's durable escalation comment names it, and the settings response
// derives `timeout_seconds_set` from it, so one resolution serves both
// instead of a second pass that could disagree.
type TimeoutSource int

const (
	// TimeoutSourceDefault: neither object carries a valid key; the
	// compiled-in default won.
	TimeoutSourceDefault TimeoutSource = iota
	// TimeoutSourceWorkspace: the workspace default won (no project override).
	TimeoutSourceWorkspace
	// TimeoutSourceProject: this project's override won.
	TimeoutSourceProject
)

// String is the source's name in logs and on the escalation comment.
func (s TimeoutSource) String() string {
	switch s {
	case TimeoutSourceProject:
		return "project override"
	case TimeoutSourceWorkspace:
		return "workspace default"
	default:
		return "built-in default"
	}
}

// EffectiveAskPlanTimeoutSeconds resolves the ask/plan wait for a project:
// a valid project override, else a valid workspace value, else the compiled-in
// default — the resolution order M-123's Architect answer fixed (Q2), and the
// only place that order lives. projectSettings/workspaceSettings are the raw
// JSONB bytes; a missing or malformed key reads as "no opinion".
//
// Both the Interactions surfaces and M-131's timeout sweeper call this, so a
// park expires against exactly the number the settings page shows.
func EffectiveAskPlanTimeoutSeconds(projectSettings, workspaceSettings []byte) (int, TimeoutSource) {
	if seconds, ok := settingNumber(projectSettings, askPlanTimeoutSettingKey); ok && validTimeoutSeconds(seconds) {
		return seconds, TimeoutSourceProject
	}
	if seconds, ok := settingNumber(workspaceSettings, askPlanTimeoutSettingKey); ok && validTimeoutSeconds(seconds) {
		return seconds, TimeoutSourceWorkspace
	}
	return interactionsDefaultTimeoutSeconds, TimeoutSourceDefault
}

// moctInjectEnabled is the one reader of the memory switch, and it is
// deliberately generous: an absent or malformed value means ON, which is the
// behavior every run had before the switch existed (M-101).
func moctInjectEnabled(ws db.Workspace) bool {
	enabled, ok := settingBool(ws.Settings, moctMemoryInjectSettingKey)
	if !ok {
		return true
	}
	return enabled
}

// parseTimeoutSeconds turns the body's raw value into one of the three
// outcomes. `clear` means the caller asked for the default back.
//
// A JSON string is rejected on its first byte before any decoding: json.Number
// is a string type, so `"600"` would otherwise decode to the number 600 and a
// client that quotes its integers would be silently accepted here and nowhere
// else in this API.
func parseTimeoutSeconds(raw json.RawMessage) (seconds int, clear bool, message string) {
	const malformed = "timeout_seconds must be a whole number of seconds or null"
	if len(raw) == 0 {
		return 0, false, "timeout_seconds is required"
	}
	trimmed := strings.TrimSpace(string(raw))
	if trimmed == "null" {
		return 0, true, ""
	}
	if trimmed == "" || !(trimmed[0] == '-' || (trimmed[0] >= '0' && trimmed[0] <= '9')) {
		return 0, false, malformed
	}
	var number json.Number
	if err := json.Unmarshal([]byte(trimmed), &number); err != nil {
		return 0, false, malformed
	}
	parsed, err := number.Float64()
	if err != nil || math.IsNaN(parsed) || math.IsInf(parsed, 0) || parsed != math.Trunc(parsed) {
		return 0, false, malformed
	}
	if parsed > math.MaxInt32 {
		return 0, false, "timeout_seconds must be between 60 and 86400 seconds"
	}
	if !validTimeoutSeconds(int(parsed)) {
		return 0, false, "timeout_seconds must be between 60 and 86400 seconds"
	}
	return int(parsed), false, ""
}

// setWorkspaceSetting stores one key of the workspace's settings object.
func (h *Handler) setWorkspaceSetting(r *http.Request, workspaceUUID, key string, value any) (db.Workspace, error) {
	encoded, err := json.Marshal(value)
	if err != nil {
		return db.Workspace{}, err
	}
	return h.Queries.SetWorkspaceSetting(r.Context(), db.SetWorkspaceSettingParams{
		ID:    parseUUID(workspaceUUID),
		Key:   key,
		Value: encoded,
	})
}

// clearWorkspaceSetting removes one key, restoring the code's default.
func (h *Handler) clearWorkspaceSetting(r *http.Request, workspaceUUID, key string) (db.Workspace, error) {
	return h.Queries.RemoveWorkspaceSetting(r.Context(), db.RemoveWorkspaceSettingParams{
		ID:  parseUUID(workspaceUUID),
		Key: key,
	})
}

// GetInteractions reads the workspace's ask/plan wait along with every project
// that overrides it. Member-visible: neither value says anything about a person.
func (h *Handler) GetInteractions(w http.ResponseWriter, r *http.Request) {
	workspaceID := workspaceIDFromURL(r, "id")
	wsUUID, ok := parseUUIDOrBadRequest(w, workspaceID, "workspace id")
	if !ok {
		return
	}
	member, ok := h.requireWorkspaceMember(w, r, workspaceID, "workspace not found")
	if !ok {
		return
	}
	ws, err := h.Queries.GetWorkspace(r.Context(), wsUUID)
	if err != nil {
		writeError(w, http.StatusNotFound, "workspace not found")
		return
	}
	h.writeInteractionsResponse(w, r, ws, isWorkspaceAdmin(member))
}

// writeInteractionsResponse assembles the interactions payload for one
// workspace row. Split out so a write answers with exactly what a read would;
// `editable` is the reader's own permission, not the value's.
func (h *Handler) writeInteractionsResponse(w http.ResponseWriter, r *http.Request, ws db.Workspace, editable bool) {
	seconds, set := workspaceTimeoutSeconds(ws)
	overrides, err := h.projectInteractionOverrides(r, ws)
	if err != nil {
		slog.Error("list project interaction overrides failed", append(logger.RequestAttrs(r), "error", err)...)
		writeError(w, http.StatusInternalServerError, "failed to read project overrides")
		return
	}
	writeJSON(w, http.StatusOK, InteractionsResponse{
		TimeoutSeconds:    seconds,
		TimeoutSecondsSet: set,
		MinTimeoutSeconds: interactionsMinTimeoutSeconds,
		MaxTimeoutSeconds: interactionsMaxTimeoutSeconds,
		Editable:          editable,
		Overrides:         overrides,
	})
}

// projectInteractionOverrides lists the projects whose settings carry the key.
// It reuses the project list the app already has rather than adding a
// settings-shaped query: the test is key presence, and a workspace's projects
// are a short list.
func (h *Handler) projectInteractionOverrides(r *http.Request, ws db.Workspace) ([]ProjectInteractionOverride, error) {
	projects, err := h.Queries.ListProjects(r.Context(), db.ListProjectsParams{WorkspaceID: ws.ID})
	if err != nil {
		return nil, err
	}
	out := make([]ProjectInteractionOverride, 0, len(projects))
	for _, project := range projects {
		seconds, ok := settingNumber(project.Settings, askPlanTimeoutSettingKey)
		if !ok || !validTimeoutSeconds(seconds) {
			continue
		}
		out = append(out, ProjectInteractionOverride{
			ProjectID:      uuidToString(project.ID),
			ProjectTitle:   project.Title,
			TimeoutSeconds: seconds,
		})
	}
	return out, nil
}

// UpdateInteractions writes the workspace's ask/plan wait. A null value clears
// the key, which restores the built-in default rather than freezing today's.
func (h *Handler) UpdateInteractions(w http.ResponseWriter, r *http.Request) {
	workspaceID := workspaceIDFromURL(r, "id")
	if _, ok := parseUUIDOrBadRequest(w, workspaceID, "workspace id"); !ok {
		return
	}
	var req UpdateInteractionsRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	seconds, clear, message := parseTimeoutSeconds(req.TimeoutSeconds)
	if message != "" {
		writeError(w, http.StatusBadRequest, message)
		return
	}
	var (
		updated db.Workspace
		err     error
	)
	if clear {
		updated, err = h.clearWorkspaceSetting(r, workspaceID, askPlanTimeoutSettingKey)
	} else {
		updated, err = h.setWorkspaceSetting(r, workspaceID, askPlanTimeoutSettingKey, seconds)
	}
	if err != nil {
		slog.Error("update interactions failed", append(logger.RequestAttrs(r), "error", err)...)
		writeError(w, http.StatusInternalServerError, "failed to update interactions")
		return
	}
	slog.Info("ask/plan timeout updated",
		append(logger.RequestAttrs(r), "workspace_id", workspaceID, "cleared", clear)...)
	h.publishWorkspaceSettingsChanged(r, updated)
	// The write just succeeded through the admin-gated route, so this reader is
	// an owner or admin by construction.
	h.writeInteractionsResponse(w, r, updated, true)
}

// GetMoctSettings reads the pre-run memory switch. Member-visible: it is a
// workspace policy, not a secret, and an agent's owner wants to know whether
// runs get memory.
func (h *Handler) GetMoctSettings(w http.ResponseWriter, r *http.Request) {
	workspaceID := workspaceIDFromURL(r, "id")
	wsUUID, ok := parseUUIDOrBadRequest(w, workspaceID, "workspace id")
	if !ok {
		return
	}
	member, ok := h.requireWorkspaceMember(w, r, workspaceID, "workspace not found")
	if !ok {
		return
	}
	ws, err := h.Queries.GetWorkspace(r.Context(), wsUUID)
	if err != nil {
		writeError(w, http.StatusNotFound, "workspace not found")
		return
	}
	_, set := settingBool(ws.Settings, moctMemoryInjectSettingKey)
	writeJSON(w, http.StatusOK, MoctSettingsResponse{
		MemoryInject:    moctInjectEnabled(ws),
		MemoryInjectSet: set,
		Editable:        isWorkspaceAdmin(member),
	})
}

// UpdateMoctSettings writes the pre-run memory switch. It takes effect on the
// next claim: moct_memory_inject travels on the claim response, and the daemon
// reads it there rather than from a settings object it would have to cache.
func (h *Handler) UpdateMoctSettings(w http.ResponseWriter, r *http.Request) {
	workspaceID := workspaceIDFromURL(r, "id")
	if _, ok := parseUUIDOrBadRequest(w, workspaceID, "workspace id"); !ok {
		return
	}
	var req UpdateMoctSettingsRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	if len(req.MemoryInject) == 0 {
		writeError(w, http.StatusBadRequest, "memory_inject is required")
		return
	}
	var enabled bool
	if err := json.Unmarshal(req.MemoryInject, &enabled); err != nil {
		writeError(w, http.StatusBadRequest, "memory_inject must be true or false")
		return
	}
	updated, err := h.setWorkspaceSetting(r, workspaceID, moctMemoryInjectSettingKey, enabled)
	if err != nil {
		slog.Error("update moct settings failed", append(logger.RequestAttrs(r), "error", err)...)
		writeError(w, http.StatusInternalServerError, "failed to update moct settings")
		return
	}
	slog.Info("moct memory inject updated",
		append(logger.RequestAttrs(r), "workspace_id", workspaceID, "memory_inject", enabled)...)
	h.publishWorkspaceSettingsChanged(r, updated)
	_, set := settingBool(updated.Settings, moctMemoryInjectSettingKey)
	writeJSON(w, http.StatusOK, MoctSettingsResponse{MemoryInject: enabled, MemoryInjectSet: set, Editable: true})
}

// SetProjectInteractions writes or clears one project's ask/plan override.
//
// Gated on workspace owner/admin rather than on the project lead: the value
// lives in the project's settings object, which is not a project field a lead
// edits. A null value clears the key and returns the project to the workspace
// default.
func (h *Handler) SetProjectInteractions(w http.ResponseWriter, r *http.Request) {
	workspaceID := h.resolveWorkspaceID(r)
	wsUUID, ok := parseUUIDOrBadRequest(w, workspaceID, "workspace id")
	if !ok {
		return
	}
	member, ok := h.requireWorkspaceMember(w, r, workspaceID, "workspace not found")
	if !ok {
		return
	}
	if !isWorkspaceAdmin(member) {
		writeError(w, http.StatusForbidden, "only workspace owners and admins can change a project's interaction timeout")
		return
	}
	projectUUID, ok := parseUUIDOrBadRequest(w, chi.URLParam(r, "id"), "project id")
	if !ok {
		return
	}
	project, err := h.Queries.GetProjectInWorkspace(r.Context(), db.GetProjectInWorkspaceParams{ID: projectUUID, WorkspaceID: wsUUID})
	if err != nil {
		writeError(w, http.StatusNotFound, "project not found")
		return
	}
	var req UpdateInteractionsRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	seconds, clear, message := parseTimeoutSeconds(req.TimeoutSeconds)
	if message != "" {
		writeError(w, http.StatusBadRequest, message)
		return
	}
	updated := project
	if clear {
		updated, err = h.Queries.RemoveProjectSetting(r.Context(), db.RemoveProjectSettingParams{
			ID:          project.ID,
			WorkspaceID: project.WorkspaceID,
			Key:         askPlanTimeoutSettingKey,
		})
	} else {
		encoded, marshalErr := json.Marshal(seconds)
		if marshalErr != nil {
			writeError(w, http.StatusInternalServerError, "failed to update project interactions")
			return
		}
		updated, err = h.Queries.SetProjectSetting(r.Context(), db.SetProjectSettingParams{
			ID:          project.ID,
			WorkspaceID: project.WorkspaceID,
			Key:         askPlanTimeoutSettingKey,
			Value:       encoded,
		})
	}
	if err != nil {
		slog.Error("update project interactions failed", append(logger.RequestAttrs(r), "error", err)...)
		writeError(w, http.StatusInternalServerError, "failed to update project interactions")
		return
	}
	slog.Info("project ask/plan timeout updated",
		append(logger.RequestAttrs(r), "workspace_id", workspaceID, "project_id", uuidToString(updated.ID), "cleared", clear)...)
	h.publish(protocol.EventProjectUpdated, workspaceID, "member", requestUserID(r), map[string]any{
		"project": h.projectResponseWithCounts(r, updated),
	})
	writeJSON(w, http.StatusOK, h.projectInteractionsResponse(r, updated))
}

// projectResponseWithCounts is the project wire shape a broadcast carries. The
// counts are part of it because a client replaces the project it holds with the
// event payload; sending zeros would blank a row the reader is looking at.
func (h *Handler) projectResponseWithCounts(r *http.Request, project db.Project) ProjectResponse {
	resp := projectToResponse(project)
	resp.IssueCount, resp.DoneCount = h.loadProjectIssueStats(r.Context(), project.WorkspaceID, project.ID)
	resp.ResourceCount = h.loadProjectResourceCount(r.Context(), project.ID)
	return resp
}

// projectInteractionsResponse is the project's effective wait: its own override
// when it has one, otherwise the workspace default. One resolver with the
// sweeper (M-131 amendment 1), so the panel can never show a number the sweep
// would not enforce.
func (h *Handler) projectInteractionsResponse(r *http.Request, project db.Project) map[string]any {
	var workspaceSettings []byte
	if ws, err := h.Queries.GetWorkspace(r.Context(), project.WorkspaceID); err == nil {
		workspaceSettings = ws.Settings
	}
	seconds, source := EffectiveAskPlanTimeoutSeconds(project.Settings, workspaceSettings)
	return map[string]any{
		"project_id":          uuidToString(project.ID),
		"timeout_seconds":     seconds,
		"timeout_seconds_set": source != TimeoutSourceDefault,
	}
}

// publishWorkspaceSettingsChanged tells open clients to re-read the workspace.
// Daemons are deliberately NOT woken: neither key here is read by a daemon from
// the settings object — the memory switch reaches it on the claim response.
func (h *Handler) publishWorkspaceSettingsChanged(r *http.Request, ws db.Workspace) {
	h.publish(protocol.EventWorkspaceUpdated, uuidToString(ws.ID), "member", requestUserID(r), map[string]any{
		"workspace": h.workspaceToResponse(ws),
	})
}
