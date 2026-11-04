package handler

import (
	"encoding/base64"
	"encoding/json"
	"errors"
	"strings"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5"
	"net/http"
	"strconv"
	"time"

	"github.com/jackc/pgx/v5/pgtype"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
)

type decisionCursor struct {
	Time time.Time `json:"time"`
	Kind string    `json:"kind"`
	ID   string    `json:"id"`
}

type decisionItem struct {
	Kind          string    `json:"kind"`
	SourceID      string    `json:"source_id"`
	IssueID       string    `json:"issue_id"`
	IssueTitle    string    `json:"issue_title"`
	ProjectID     *string   `json:"project_id"`
	IssueRevision int64     `json:"issue_revision"`
	AgentID       *string   `json:"agent_id"`
	TaskID        *string   `json:"task_id"`
	QuestionSeq   *int      `json:"question_seq"`
	SortAt        time.Time `json:"sort_at"`
	Status        string    `json:"status"`
	ResponseID    *string   `json:"response_id"`
	ActorID       *string   `json:"actor_id"`
	RequestedAt   time.Time `json:"requested_at"`
	// A native row's answer receipt: queued or failed carry the answer
	// comment in ResponseID (the retry handle), and failed explains itself.
	ReceiptReason *string `json:"receipt_reason,omitempty"`
}

type decisionsResult struct {
	Items        []decisionItem `json:"items"`
	PendingCount int64          `json:"pending_count"`
	NextCursor   *string        `json:"next_cursor"`
}

// ListDecisions returns the source-owned queue, independent of notifications.
func (h *Handler) ListDecisions(w http.ResponseWriter, r *http.Request) {
	ws, ok := h.workspaceIDFromURL(w, r)
	if !ok {
		return
	}
	state := r.URL.Query().Get("state")
	if state == "" {
		state = "pending"
	}
	if state != "pending" && state != "answered" {
		writeError(w, http.StatusBadRequest, "invalid state")
		return
	}
	limit := 50
	if raw := r.URL.Query().Get("limit"); raw != "" {
		n, err := strconv.Atoi(raw)
		if err != nil || n < 1 || n > 100 {
			writeError(w, http.StatusBadRequest, "invalid limit")
			return
		}
		limit = n
	}
	var project pgtype.UUID
	if raw := r.URL.Query().Get("project_id"); raw != "" {
		project, ok = parseUUIDOrBadRequest(w, raw, "project_id")
		if !ok {
			return
		}
	}
	var cursor decisionCursor
	if raw := r.URL.Query().Get("cursor"); raw != "" {
		b, err := base64.RawURLEncoding.DecodeString(raw)
		if err != nil || json.Unmarshal(b, &cursor) != nil || cursor.Time.IsZero() || cursor.Kind == "" || cursor.ID == "" {
			writeError(w, http.StatusBadRequest, "invalid cursor")
			return
		}
	}
	visible, err := h.decisionAgents(r, ws)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to load decisions")
		return
	}
	params := db.ListDecisionsParams{WorkspaceID: ws, ProjectID: project, VisibleAgents: visible, State: state, CursorKind: cursor.Kind, CursorID: cursor.ID, PageLimit: int32(limit + 1)}
	if !cursor.Time.IsZero() {
		params.CursorTime = pgtype.Timestamptz{Time: cursor.Time, Valid: true}
	}
	raw, err := h.Queries.ListDecisions(r.Context(), params)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to load decisions")
		return
	}
	var result decisionsResult
	if err = json.Unmarshal(raw, &result); err != nil {
		writeError(w, http.StatusInternalServerError, "failed to load decisions")
		return
	}
	if len(result.Items) > limit {
		result.Items = result.Items[:limit]
		last := result.Items[len(result.Items)-1]
		encoded, _ := json.Marshal(decisionCursor{Time: last.SortAt, Kind: last.Kind, ID: last.SourceID})
		next := base64.RawURLEncoding.EncodeToString(encoded)
		result.NextCursor = &next
	}
	writeJSON(w, http.StatusOK, result)
}

func (h *Handler) decisionAgents(r *http.Request, ws pgtype.UUID) ([]pgtype.UUID, error) {
	agents, err := h.Queries.ListAllAgents(r.Context(), ws)
	if err != nil {
		return nil, err
	}
	userID := requestUserID(r)
	actorType, actorID := h.resolveActor(r, userID, uuidToString(ws))
	originator := h.invokeOriginatorFromRequest(r, actorType, actorID)
	if actorType == "member" {
		originator = userID
	}
	targets, ok := h.loadInvocationTargetsByAgent(r.Context(), agents)
	if !ok {
		return nil, errors.New("load agent invocation targets")
	}
	effectiveUser := originator
	if actorType == "member" {
		effectiveUser = actorID
	}
	visible := make([]pgtype.UUID, 0, len(agents))
	for _, agent := range agents {
		if actorType == "agent" && (actorID == "" || uuidToString(agent.ID) == actorID) {
			continue
		}
		if effectiveUser != "" && uuidToString(agent.OwnerID) == effectiveUser {
			visible = append(visible, agent.ID)
			continue
		}
		if agent.PermissionMode == "public_to" && memberHitsInvocationTargets(targets[uuidToString(agent.ID)], effectiveUser) {
			visible = append(visible, agent.ID)
		}
	}
	return visible, nil
}

func (h *Handler) GetDecisionDetail(w http.ResponseWriter, r *http.Request) {
	ws, ok := h.workspaceIDFromURL(w, r)
	if !ok {
		return
	}
	kind := chi.URLParam(r, "kind")
	if kind != "question" && kind != "plan" && kind != "native" && kind != "status" {
		writeError(w, http.StatusBadRequest, "invalid decision kind")
		return
	}
	parts := strings.Split(chi.URLParam(r, "sourceId"), ":")
	if len(parts) < 1 || len(parts) > 2 || (kind == "native" && len(parts) != 2) || (kind == "question" && len(parts) != 1) {
		writeError(w, http.StatusBadRequest, "invalid source id")
		return
	}
	id, ok := parseUUIDOrBadRequest(w, parts[0], "source_id")
	if !ok {
		return
	}
	var response pgtype.UUID
	var seq int32
	if len(parts) == 2 {
		if kind == "plan" || kind == "status" {
			response, ok = parseUUIDOrBadRequest(w, parts[1], "response_id")
			if !ok {
				return
			}
		} else if kind == "native" {
			n, err := strconv.ParseInt(parts[1], 10, 32)
			if err != nil || n < 0 {
				writeError(w, http.StatusBadRequest, "invalid question sequence")
				return
			}
			seq = int32(n)
		}
	}
	visible, err := h.decisionAgents(r, ws)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to load decision")
		return
	}
	raw, err := h.Queries.GetDecisionDetail(r.Context(), db.GetDecisionDetailParams{Kind: kind, WorkspaceID: ws, SourceID: id, ResponseID: response, QuestionSeq: seq, VisibleAgents: visible})
	if errors.Is(err, pgx.ErrNoRows) {
		writeError(w, http.StatusNotFound, "decision not found")
		return
	}
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to load decision")
		return
	}
	writeJSON(w, http.StatusOK, json.RawMessage(raw))
}
