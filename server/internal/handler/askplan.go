package handler

// S1-A1 (M-118): ask/plan HTTP surface.
//
// Agent side (task-token authenticated via the mat_ middleware, which stamps
// X-Task-ID authoritatively): submit an ask, create/write/submit a plan. The
// handlers refuse any task that is not the caller's own running issue task —
// an agent may only park itself.
//
// Human side (RequireHumanActor, like the supplement route): answer an open
// card, verdict an in_review plan, read the issue's open card/plan state for
// the island (M-120).
//
// Business outcomes (card closed, stale revision, plan final, gate refused)
// are 409s with the current value in the body, never 500s — the port of
// team-room's stale_doc_revision / assertDecisionOpen semantics.

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/multica-ai/multica/server/internal/inbox"
	"github.com/multica-ai/multica/server/internal/service"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
	"github.com/multica-ai/multica/server/pkg/dbid"
	"github.com/multica-ai/multica/server/pkg/protocol"
)

// Team-room limits, enforced at the edge (decision-tools.ts @ fefa9c3).
const (
	askMaxQuestions       = 6
	askMaxOptions         = 4
	askMinOptions         = 2
	askPromptLimit        = 300
	askContextLimit       = 1200
	askLabelLimit         = 40
	askDescriptionLimit   = 200
	askAnswerTextLimit    = 2000
	planMaxSections       = 40
	planSectionCharMax    = 20000
	planVerdictNoteMax    = 4000
	planCommentMax        = 4000
	planMaxComments       = 50
	planCommentQuoteMax   = 280 // team-room docQuote's DOC_QUOTE_LIMIT
	planSectionHeadingMax = 300
)

// ---- request/response shapes ----

type askOptionRequest struct {
	Label       string `json:"label"`
	Description string `json:"description"`
}

type askQuestionRequest struct {
	Prompt   string             `json:"prompt"`
	Multiple bool               `json:"multiple"`
	Options  []askOptionRequest `json:"options"`
}

type askRequest struct {
	Context   string               `json:"context"`
	Questions []askQuestionRequest `json:"questions"`
}

type askResponse struct {
	CardID  string `json:"card_id"`
	IssueID string `json:"issue_id"`
	Status  string `json:"status"`
}

type planCreateRequest struct {
	Title   string   `json:"title"`
	Outline []string `json:"outline"`
}

type planSectionRequest struct {
	SectionID string `json:"section_id"`
	Heading   string `json:"heading"`
	Markdown  string `json:"markdown"`
}

type planWriteRequest struct {
	BaseRevision int32              `json:"base_revision"`
	Section      planSectionRequest `json:"section"`
}

type planSubmitRequest struct {
	Revision int32  `json:"revision"`
	Note     string `json:"note"`
}

type planAnswerItem struct {
	Selected []int  `json:"selected"`
	Text     string `json:"text"`
}

type questionAnswerRequest struct {
	Answers []planAnswerItem `json:"answers"`
}

type planVerdictRequest struct {
	Revision int32    `json:"revision"`
	Verdict  string   `json:"verdict"`
	Comments []string `json:"comments"`
	Note     string   `json:"note"`
}

type planResponse struct {
	ID                string          `json:"id"`
	IssueID           string          `json:"issue_id"`
	TaskID            string          `json:"task_id"`
	Title             string          `json:"title"`
	Status            string          `json:"status"`
	Revision          int32           `json:"revision"`
	SubmittedRevision *int32          `json:"submitted_revision,omitempty"`
	Sections          json.RawMessage `json:"sections"`
	ApprovedBy        *string         `json:"approved_by,omitempty"`
	// M-275: the plan page's passage comments, oldest first. Always present (an
	// empty array, never null) so the page renders the same shape either way.
	Comments []planCommentResponse `json:"comments"`
}

// planCommentResponse is one anchored comment as the plan page reads it.
// `delivered_at` is the verdict that sent it; `resolved_at` is the human's
// resolve, which never rewrites the agent's text.
type planCommentResponse struct {
	ID               string  `json:"id"`
	PlanID           string  `json:"plan_id"`
	SectionID        string  `json:"section_id"`
	Quote            string  `json:"quote"`
	Body             string  `json:"body"`
	ParentCommentID  *string `json:"parent_comment_id,omitempty"`
	AuthorUserID     string  `json:"author_user_id"`
	ResolvedAt       *string `json:"resolved_at,omitempty"`
	ResolvedBy       *string `json:"resolved_by,omitempty"`
	DeliveredAt      *string `json:"delivered_at,omitempty"`
	DeliveredVerdict *string `json:"delivered_verdict,omitempty"`
	CreatedAt        string  `json:"created_at"`
}

// planSectionVersionResponse is one accepted write to a section.
type planSectionVersionResponse struct {
	ID         string  `json:"id"`
	SectionID  string  `json:"section_id"`
	Revision   int32   `json:"revision"`
	Heading    string  `json:"heading"`
	Markdown   string  `json:"markdown"`
	WriterType string  `json:"writer_type"`
	WriterID   *string `json:"writer_id,omitempty"`
	CreatedAt  string  `json:"created_at"`
}

func planCommentToResponse(c db.AgentPlanComment) planCommentResponse {
	resp := planCommentResponse{
		ID:           uuidToString(c.ID),
		PlanID:       uuidToString(c.PlanID),
		SectionID:    c.SectionID,
		Quote:        c.Quote,
		Body:         c.Body,
		AuthorUserID: uuidToString(c.AuthorUserID),
		CreatedAt:    c.CreatedAt.Time.UTC().Format(time.RFC3339Nano),
	}
	if c.ParentCommentID.Valid {
		s := uuidToString(c.ParentCommentID)
		resp.ParentCommentID = &s
	}
	if c.ResolvedAt.Valid {
		s := c.ResolvedAt.Time.UTC().Format(time.RFC3339Nano)
		resp.ResolvedAt = &s
	}
	if c.ResolvedBy.Valid {
		s := uuidToString(c.ResolvedBy)
		resp.ResolvedBy = &s
	}
	if c.DeliveredAt.Valid {
		s := c.DeliveredAt.Time.UTC().Format(time.RFC3339Nano)
		resp.DeliveredAt = &s
	}
	if c.DeliveredVerdict.Valid {
		s := c.DeliveredVerdict.String
		resp.DeliveredVerdict = &s
	}
	return resp
}

func planSectionVersionToResponse(v db.AgentPlanSectionVersion) planSectionVersionResponse {
	resp := planSectionVersionResponse{
		ID:         uuidToString(v.ID),
		SectionID:  v.SectionID,
		Revision:   v.Revision,
		Heading:    v.Heading,
		Markdown:   v.Markdown,
		WriterType: v.WriterType,
		CreatedAt:  v.CreatedAt.Time.UTC().Format(time.RFC3339Nano),
	}
	if v.WriterID.Valid {
		s := uuidToString(v.WriterID)
		resp.WriterID = &s
	}
	return resp
}

type cardQuestionOption struct {
	Label       string `json:"label"`
	Description string `json:"description,omitempty"`
}

type cardQuestion struct {
	Prompt   string               `json:"prompt"`
	Multiple bool                 `json:"multiple,omitempty"`
	Options  []cardQuestionOption `json:"options,omitempty"`
}

type cardResponse struct {
	ID        string          `json:"id"`
	IssueID   string          `json:"issue_id"`
	TaskID    string          `json:"task_id"`
	AgentID   string          `json:"agent_id"`
	Status    string          `json:"status"`
	Context   *string         `json:"context,omitempty"`
	Questions json.RawMessage `json:"questions"`
	Answers   json.RawMessage `json:"answers,omitempty"`
}

type askPlanStateResponse struct {
	QuestionCards []cardResponse `json:"question_cards"`
	Plan          *planResponse  `json:"plan,omitempty"`
}

func planToResponse(p db.AgentPlan) planResponse {
	return planToResponseWithComments(p, nil)
}

// planToResponseWithComments is the plan page's read: the plan plus its
// commented passages, oldest first.
func planToResponseWithComments(p db.AgentPlan, comments []db.AgentPlanComment) planResponse {
	resp := planResponse{
		ID:       uuidToString(p.ID),
		IssueID:  uuidToString(p.IssueID),
		TaskID:   uuidToString(p.TaskID),
		Title:    p.Title,
		Status:   p.Status,
		Revision: p.Revision,
		Sections: json.RawMessage(p.Sections),
		Comments: make([]planCommentResponse, 0, len(comments)),
	}
	for _, c := range comments {
		resp.Comments = append(resp.Comments, planCommentToResponse(c))
	}
	if p.SubmittedRevision.Valid {
		v := p.SubmittedRevision.Int32
		resp.SubmittedRevision = &v
	}
	if p.ApprovedBy.Valid {
		s := uuidToString(p.ApprovedBy)
		resp.ApprovedBy = &s
	}
	return resp
}

func cardToResponse(c db.AgentQuestionCard) cardResponse {
	resp := cardResponse{
		ID:        uuidToString(c.ID),
		IssueID:   uuidToString(c.IssueID),
		TaskID:    uuidToString(c.TaskID),
		AgentID:   uuidToString(c.AgentID),
		Status:    c.Status,
		Questions: json.RawMessage(c.Questions),
	}
	if c.Context.Valid {
		resp.Context = &c.Context.String
	}
	if len(c.Answers) > 0 {
		resp.Answers = json.RawMessage(c.Answers)
	}
	return resp
}

// ---- agent-side handlers ----

// callerRunningIssueTask resolves the task token's task and refuses anything
// that is not the caller's own RUNNING issue task in the URL workspace. An
// agent may only park itself, and only while it is executing.
func (h *Handler) callerRunningIssueTask(w http.ResponseWriter, r *http.Request, workspaceID pgtype.UUID) (db.AgentTaskQueue, bool) {
	task, ok := h.taskFromRequestHeader(r)
	if !ok {
		writeError(w, http.StatusForbidden, "ask/plan requires a running task token")
		return db.AgentTaskQueue{}, false
	}
	pathTaskID, ok := parseUUIDOrBadRequest(w, chi.URLParam(r, "taskId"), "task_id")
	if !ok {
		return db.AgentTaskQueue{}, false
	}
	if task.ID != pathTaskID {
		writeError(w, http.StatusForbidden, "task token does not match the path task")
		return db.AgentTaskQueue{}, false
	}
	if task.Status != "running" {
		writeError(w, http.StatusConflict, "task is not running")
		return db.AgentTaskQueue{}, false
	}
	if !task.IssueID.Valid {
		writeError(w, http.StatusConflict, "ask/plan is available on issue tasks only")
		return db.AgentTaskQueue{}, false
	}
	agent, err := h.Queries.GetAgent(r.Context(), task.AgentID)
	if err != nil || agent.WorkspaceID != workspaceID {
		writeError(w, http.StatusForbidden, "task does not belong to this workspace")
		return db.AgentTaskQueue{}, false
	}
	return task, true
}

// SubmitAsk handles POST /api/workspaces/{id}/tasks/{taskId}/ask.
// Creates the open card, delivers inbox items to workspace members, parks the
// task, and answers 202 immediately — the tool never waits on the human.
func (h *Handler) SubmitAsk(w http.ResponseWriter, r *http.Request) {
	workspaceID, ok := h.workspaceIDFromURL(w, r)
	if !ok {
		return
	}
	task, ok := h.callerRunningIssueTask(w, r, workspaceID)
	if !ok {
		return
	}
	var req askRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid JSON body")
		return
	}
	if err := validateAskRequest(req); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	questionsJSON, err := json.Marshal(req.Questions)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to encode questions")
		return
	}

	card, err := h.TaskService.CreateQuestionCard(r.Context(), task, workspaceID, req.Context, questionsJSON)
	if err != nil {
		slog.Warn("create question card failed", "error", err)
		writeError(w, http.StatusInternalServerError, "failed to create question card")
		return
	}
	if err := h.deliverAskPlanInbox(r, workspaceID, task.IssueID, "agent_question",
		"The agent asked you a question", "answer it from the issue page", map[string]any{"card_id": uuidToString(card.ID)}); err != nil {
		// Inbox delivery is best-effort: the card itself is the durable ask.
		slog.Warn("ask inbox delivery failed", "error", err)
	}
	if _, err := h.TaskService.BlockTaskForAskPlan(r.Context(), task.ID, service.EvidenceQuestionAnswer, card.ID, service.WaitReasonAskPlan); err != nil {
		if errors.Is(err, service.ErrTaskNotRunning) {
			writeError(w, http.StatusConflict, "task is no longer running")
			return
		}
		slog.Warn("block task for ask failed", "error", err)
		writeError(w, http.StatusInternalServerError, "failed to park the task")
		return
	}
	writeJSON(w, http.StatusAccepted, askResponse{
		CardID:  uuidToString(card.ID),
		IssueID: uuidToString(task.IssueID),
		Status:  "awaiting_human",
	})
}

// CreatePlan handles POST /api/workspaces/{id}/tasks/{taskId}/plans.
func (h *Handler) CreatePlan(w http.ResponseWriter, r *http.Request) {
	workspaceID, ok := h.workspaceIDFromURL(w, r)
	if !ok {
		return
	}
	task, ok := h.callerRunningIssueTask(w, r, workspaceID)
	if !ok {
		return
	}
	var req planCreateRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid JSON body")
		return
	}
	if req.Title == "" || len(req.Title) > 200 {
		writeError(w, http.StatusBadRequest, "title is required and must be at most 200 characters")
		return
	}
	if len(req.Outline) > planMaxSections {
		writeError(w, http.StatusBadRequest, "outline has too many sections")
		return
	}
	if gateErr := h.refuseUnlessPlanningPhase(r, task); gateErr != nil {
		writeError(w, http.StatusConflict, gateErr.Error())
		return
	}
	sections := make([]map[string]any, 0, len(req.Outline))
	for i, heading := range req.Outline {
		sections = append(sections, map[string]any{
			"sectionId": "s" + strconv.Itoa(i+1),
			"heading":   heading,
			"markdown":  "",
		})
	}
	sectionsJSON, err := json.Marshal(sections)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to encode sections")
		return
	}
	plan, err := h.Queries.CreateAgentPlan(r.Context(), db.CreateAgentPlanParams{
		ID:          dbid.NewV7(),
		WorkspaceID: workspaceID,
		IssueID:     task.IssueID,
		TaskID:      task.ID,
		AgentID:     task.AgentID,
		Title:       req.Title,
		Sections:    sectionsJSON,
	})
	if err != nil {
		// idx_ap_one_open: another open plan on this issue.
		var pgErr *pgconn.PgError
		if errors.As(err, &pgErr) && pgErr.Code == "23505" && pgErr.ConstraintName == "idx_ap_one_open" {
			writeError(w, http.StatusConflict, "the issue already has an open plan")
			return
		}
		slog.Warn("create plan failed", "error", err)
		writeError(w, http.StatusInternalServerError, "failed to create plan")
		return
	}
	writeJSON(w, http.StatusCreated, planToResponse(plan))
}

// WritePlanSection handles PUT /api/workspaces/{id}/plans/{planId}/sections.
func (h *Handler) WritePlanSection(w http.ResponseWriter, r *http.Request) {
	workspaceID, ok := h.workspaceIDFromURL(w, r)
	if !ok {
		return
	}
	task, ok := h.callerRunningIssueTask(w, r, workspaceID)
	if !ok {
		return
	}
	planID, ok := parseUUIDOrBadRequest(w, chi.URLParam(r, "planId"), "plan_id")
	if !ok {
		return
	}
	var req planWriteRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid JSON body")
		return
	}
	if req.Section.Heading == "" && req.Section.Markdown == "" {
		writeError(w, http.StatusBadRequest, "heading or markdown is required")
		return
	}
	if len(req.Section.Markdown) > planSectionCharMax {
		writeError(w, http.StatusBadRequest, "section body is too large")
		return
	}

	plan, err := h.Queries.GetAgentPlan(r.Context(), planID)
	if err != nil {
		writeError(w, http.StatusNotFound, "plan not found")
		return
	}
	if plan.WorkspaceID != workspaceID {
		writeError(w, http.StatusNotFound, "plan not found")
		return
	}
	// Only the proposing agent writes sections (team-room author-only rule).
	if plan.AgentID != task.AgentID {
		writeError(w, http.StatusForbidden, "this plan belongs to another agent")
		return
	}
	if isFinalPlanStatus(plan.Status) {
		writeErrorCode(w, http.StatusConflict, "plan_closed", "plan is final and no longer changes")
		return
	}
	if plan.Status != "draft" && plan.Status != "changes_requested" {
		writeErrorCode(w, http.StatusConflict, "plan_not_editable", "plan sections can be written only in draft or changes_requested")
		return
	}

	sectionID := req.Section.SectionID
	if sectionID == "" {
		sectionID = "s" + strconv.Itoa(len(currentPlanSections(plan.Sections))+1)
	}
	merged, mergeErr := mergePlanSection(plan.Sections, sectionID, req.Section.Heading, req.Section.Markdown)
	if mergeErr != nil {
		writeError(w, http.StatusBadRequest, mergeErr.Error())
		return
	}
	updated, err := h.Queries.WriteAgentPlanSection(r.Context(), db.WriteAgentPlanSectionParams{
		ID:           planID,
		Sections:     merged,
		BaseRevision: req.BaseRevision,
	})
	if errors.Is(err, pgx.ErrNoRows) {
		// Stale fence or a state the CAS excludes — report the current values.
		latest, loadErr := h.Queries.GetAgentPlan(r.Context(), planID)
		if loadErr != nil {
			writeError(w, http.StatusConflict, "plan changed; retry with the current revision")
			return
		}
		writeJSON(w, http.StatusConflict, map[string]any{
			"error":            "stale_plan_revision",
			"current_revision": latest.Revision,
			"current_status":   latest.Status,
		})
		return
	}
	if err != nil {
		slog.Warn("write plan section failed", "error", err)
		writeError(w, http.StatusInternalServerError, "failed to write plan section")
		return
	}
	// M-275: the agent's write lands in the same ledger a human edit uses, so a
	// section's history has no gap. Best-effort: the write itself is committed,
	// and a missing version costs history, not the plan.
	h.recordPlanSectionVersion(r.Context(), updated, sectionID, req.Section.Heading, req.Section.Markdown, "agent", task.AgentID)
	comments, _ := h.Queries.ListAgentPlanComments(r.Context(), planID)
	writeJSON(w, http.StatusOK, planToResponseWithComments(updated, comments))
}

// SubmitPlan handles POST /api/workspaces/{id}/plans/{planId}/submit.
// in_review + inbox 'plan_review' + park the task, one transaction each in
// the same order as ask.
func (h *Handler) SubmitPlan(w http.ResponseWriter, r *http.Request) {
	workspaceID, ok := h.workspaceIDFromURL(w, r)
	if !ok {
		return
	}
	task, ok := h.callerRunningIssueTask(w, r, workspaceID)
	if !ok {
		return
	}
	planID, ok := parseUUIDOrBadRequest(w, chi.URLParam(r, "planId"), "plan_id")
	if !ok {
		return
	}
	var req planSubmitRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid JSON body")
		return
	}
	plan, err := h.Queries.GetAgentPlan(r.Context(), planID)
	if err != nil || plan.WorkspaceID != workspaceID {
		writeError(w, http.StatusNotFound, "plan not found")
		return
	}
	if plan.TaskID != task.ID {
		writeError(w, http.StatusForbidden, "this plan belongs to another task")
		return
	}
	if isFinalPlanStatus(plan.Status) {
		writeErrorCode(w, http.StatusConflict, "plan_closed", "plan is final and no longer changes")
		return
	}
	if gateErr := h.refuseUnlessPlanningPhase(r, task); gateErr != nil {
		writeError(w, http.StatusConflict, gateErr.Error())
		return
	}
	submitted, err := h.Queries.SubmitAgentPlan(r.Context(), db.SubmitAgentPlanParams{
		ID:       planID,
		Revision: pgtype.Int4{Int32: req.Revision, Valid: true},
		TaskID:   task.ID,
	})
	if errors.Is(err, pgx.ErrNoRows) {
		latest, loadErr := h.Queries.GetAgentPlan(r.Context(), planID)
		if loadErr != nil {
			writeError(w, http.StatusConflict, "plan changed; retry with the current revision")
			return
		}
		writeJSON(w, http.StatusConflict, map[string]any{
			"error":            "stale_plan_revision",
			"current_revision": latest.Revision,
			"current_status":   latest.Status,
		})
		return
	}
	if err != nil {
		slog.Warn("submit plan failed", "error", err)
		writeError(w, http.StatusInternalServerError, "failed to submit plan")
		return
	}
	issue, err := h.Queries.GetIssue(r.Context(), task.IssueID)
	if err != nil {
		slog.Warn("load issue for plan review inbox failed", "error", err)
	}
	if err := h.deliverAskPlanInbox(r, workspaceID, task.IssueID, "plan_review",
		"The agent submitted a plan for your review", submitted.Title,
		map[string]any{"plan_id": uuidToString(planID), "revision": int(submitted.Revision)}); err != nil {
		slog.Warn("plan inbox delivery failed", "error", err)
	}
	_ = issue
	if _, err := h.TaskService.BlockTaskForAskPlan(r.Context(), task.ID, service.EvidencePlanVerdict, planID, service.WaitReasonAskPlan); err != nil {
		if errors.Is(err, service.ErrTaskNotRunning) {
			writeError(w, http.StatusConflict, "task is no longer running")
			return
		}
		slog.Warn("block task for plan failed", "error", err)
		writeError(w, http.StatusInternalServerError, "failed to park the task")
		return
	}
	writeJSON(w, http.StatusAccepted, planToResponse(submitted))
}

// ---- human-side handlers ----

// AnswerQuestionCard handles POST /api/workspaces/{id}/question-cards/{cardId}/answer.
func (h *Handler) AnswerQuestionCard(w http.ResponseWriter, r *http.Request) {
	workspaceID, ok := h.workspaceIDFromURL(w, r)
	if !ok {
		return
	}
	cardID, ok := parseUUIDOrBadRequest(w, chi.URLParam(r, "cardId"), "card_id")
	if !ok {
		return
	}
	var req questionAnswerRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid JSON body")
		return
	}
	card, err := h.Queries.GetAgentQuestionCard(r.Context(), cardID)
	if err != nil || card.WorkspaceID != workspaceID {
		writeError(w, http.StatusNotFound, "question card not found")
		return
	}
	if err := validateCardAnswers(card.Questions, req.Answers); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	answersJSON, err := json.Marshal(req.Answers)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to encode answers")
		return
	}
	answeredBy := parseUUID(requestUserID(r))
	answered, resumeTask, err := h.TaskService.AnswerQuestionCard(r.Context(), cardID, workspaceID, answeredBy, answersJSON)
	if errors.Is(err, service.ErrQuestionCardClosed) {
		writeErrorCode(w, http.StatusConflict, "card_closed", "the question card is no longer open")
		return
	}
	if errors.Is(err, service.ErrDuplicatePendingTask) {
		writeErrorCode(w, http.StatusConflict, "run_already_queued", "a run is already queued for this issue; the answer was not recorded")
		return
	}
	if err != nil {
		slog.Warn("answer question card failed", "error", err)
		writeError(w, http.StatusInternalServerError, "failed to record the answer")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"card":        cardToResponse(answered),
		"resume_task": uuidToString(resumeTask.ID),
	})
}

// ReviewPlan handles POST /api/workspaces/{id}/plans/{planId}/verdict.
func (h *Handler) ReviewPlan(w http.ResponseWriter, r *http.Request) {
	workspaceID, ok := h.workspaceIDFromURL(w, r)
	if !ok {
		return
	}
	planID, ok := parseUUIDOrBadRequest(w, chi.URLParam(r, "planId"), "plan_id")
	if !ok {
		return
	}
	var req planVerdictRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid JSON body")
		return
	}
	if req.Verdict != "approve" && req.Verdict != "changes_requested" && req.Verdict != "cancel" {
		writeError(w, http.StatusBadRequest, "verdict must be approve, changes_requested or cancel")
		return
	}
	if len(req.Comments) > planMaxComments {
		writeError(w, http.StatusBadRequest, "too many comments")
		return
	}
	for _, c := range req.Comments {
		if len(c) > planCommentMax {
			writeError(w, http.StatusBadRequest, "comment is too long")
			return
		}
	}
	if len(req.Note) > planVerdictNoteMax {
		writeError(w, http.StatusBadRequest, "note is too long")
		return
	}
	plan, err := h.Queries.GetAgentPlan(r.Context(), planID)
	if err != nil || plan.WorkspaceID != workspaceID {
		writeError(w, http.StatusNotFound, "plan not found")
		return
	}
	commentsJSON, err := json.Marshal(req.Comments)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to encode comments")
		return
	}
	reviewedBy := parseUUID(requestUserID(r))
	reviewed, resumeTask, promoted, err := h.TaskService.ReviewPlan(r.Context(), planID, workspaceID, reviewedBy, req.Revision, req.Verdict, commentsJSON, req.Note)
	switch {
	case errors.Is(err, service.ErrPlanClosed):
		writeErrorCode(w, http.StatusConflict, "plan_closed", "the plan is final and no longer changes")
		return
	case errors.Is(err, service.ErrPlanNotInReview):
		writeErrorCode(w, http.StatusConflict, "plan_not_in_review", "the plan is not awaiting a verdict")
		return
	case errors.Is(err, service.ErrPlanStaleRevision):
		latest, loadErr := h.Queries.GetAgentPlan(r.Context(), planID)
		body := map[string]any{"error": "stale_plan_revision"}
		if loadErr == nil {
			body["current_revision"] = latest.Revision
			body["current_status"] = latest.Status
			if latest.SubmittedRevision.Valid {
				body["submitted_revision"] = latest.SubmittedRevision.Int32
			}
		}
		writeJSON(w, http.StatusConflict, body)
		return
	case errors.Is(err, service.ErrPlanNeedsComment):
		writeErrorCode(w, http.StatusBadRequest, "review_needs_comment", "changes_requested needs at least one comment or a note")
		return
	case errors.Is(err, service.ErrIssueRevisionConflict):
		writeErrorCode(w, http.StatusConflict, "issue_revision_conflict", "the issue changed while reviewing; retry the verdict")
		return
	case errors.Is(err, service.ErrDuplicatePendingTask):
		writeErrorCode(w, http.StatusConflict, "run_already_queued", "a run is already queued for this issue; the verdict was not recorded")
		return
	case err != nil:
		slog.Warn("review plan failed", "error", err)
		writeError(w, http.StatusInternalServerError, "failed to record the verdict")
		return
	}
	if promoted != nil {
		// The description write went through the service transaction; publish
		// the same issue:updated shape the UpdateIssue handler publishes so the
		// activity listener records description_updated and clients refresh.
		prefix := ""
		if ws, wsErr := h.Queries.GetWorkspace(r.Context(), workspaceID); wsErr == nil {
			prefix = issuePrefixForWorkspace(ws)
		}
		h.publish(protocol.EventIssueUpdated, uuidToString(workspaceID), "member", requestUserID(r), map[string]any{
			"issue":               issueToResponse(*promoted, prefix),
			"description_changed": true,
		})
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"plan":        planToResponse(reviewed),
		"resume_task": uuidToString(resumeTask.ID),
	})
}

// ---- plan review threads (M-275) ----

type planCommentRequest struct {
	BaseRevision    int32   `json:"base_revision"`
	SectionID       string  `json:"section_id"`
	Quote           string  `json:"quote"`
	Body            string  `json:"body"`
	ParentCommentID *string `json:"parent_comment_id"`
}

type planSectionEditRequest struct {
	BaseRevision int32  `json:"base_revision"`
	Heading      string `json:"heading"`
	Markdown     string `json:"markdown"`
}

// CreatePlanComment handles POST /api/workspaces/{id}/plans/{planId}/comments.
//
// Human-only. The base_revision is the page's revision at the moment the human
// selected the passage: a comment that arrives after the plan moved is refused
// with the current revision rather than anchored to text it never saw (the
// same fence every section write and verdict uses).
func (h *Handler) CreatePlanComment(w http.ResponseWriter, r *http.Request) {
	workspaceID, ok := h.workspaceIDFromURL(w, r)
	if !ok {
		return
	}
	planID, ok := parseUUIDOrBadRequest(w, chi.URLParam(r, "planId"), "plan_id")
	if !ok {
		return
	}
	var req planCommentRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid JSON body")
		return
	}
	body := strings.TrimSpace(req.Body)
	if body == "" {
		writeError(w, http.StatusBadRequest, "comment text is required")
		return
	}
	if len(body) > planCommentMax {
		writeError(w, http.StatusBadRequest, "comment is too long")
		return
	}
	if len(req.Quote) > planCommentQuoteMax {
		writeError(w, http.StatusBadRequest, "quote is too long")
		return
	}
	plan, err := h.Queries.GetAgentPlan(r.Context(), planID)
	if err != nil || plan.WorkspaceID != workspaceID {
		writeError(w, http.StatusNotFound, "plan not found")
		return
	}
	if isFinalPlanStatus(plan.Status) {
		writeErrorCode(w, http.StatusConflict, "plan_closed", "plan is final and no longer changes")
		return
	}
	if plan.Revision != req.BaseRevision {
		h.writeStalePlanRevision(w, r, planID)
		return
	}
	if req.SectionID != "" {
		if !planHasSection(plan.Sections, req.SectionID) {
			writeError(w, http.StatusBadRequest, "unknown section")
			return
		}
	}
	parent := pgtype.UUID{}
	if req.ParentCommentID != nil && *req.ParentCommentID != "" {
		parsed, parsedOK := parseUUIDOrBadRequest(w, *req.ParentCommentID, "parent_comment_id")
		if !parsedOK {
			return
		}
		parent = parsed
		// A reply must name a comment on THIS plan, or the thread would point
		// outside the plan it renders under.
		parentComment, err := h.Queries.GetAgentPlanComment(r.Context(), parent)
		if err != nil || parentComment.PlanID != planID {
			writeError(w, http.StatusBadRequest, "parent comment not found")
			return
		}
	}
	comment, err := h.Queries.CreateAgentPlanComment(r.Context(), db.CreateAgentPlanCommentParams{
		ID:              dbid.NewV7(),
		WorkspaceID:     workspaceID,
		PlanID:          planID,
		SectionID:       req.SectionID,
		Quote:           req.Quote,
		Body:            body,
		ParentCommentID: parent,
		AuthorUserID:    parseUUID(requestUserID(r)),
	})
	if err != nil {
		slog.Warn("create plan comment failed", "error", err)
		writeError(w, http.StatusInternalServerError, "failed to record the comment")
		return
	}
	writeJSON(w, http.StatusCreated, map[string]any{"comment": planCommentToResponse(comment)})
}

// ResolvePlanComment handles
// POST /api/workspaces/{id}/plans/{planId}/comments/{commentId}/resolve.
//
// Human-only and idempotent in the honest direction: a second resolve matches
// no row (the CAS is `resolved_at IS NULL`) and answers 409, so the page knows
// the thread already moved instead of pretending it just resolved it.
func (h *Handler) ResolvePlanComment(w http.ResponseWriter, r *http.Request) {
	workspaceID, ok := h.workspaceIDFromURL(w, r)
	if !ok {
		return
	}
	planID, ok := parseUUIDOrBadRequest(w, chi.URLParam(r, "planId"), "plan_id")
	if !ok {
		return
	}
	commentID, ok := parseUUIDOrBadRequest(w, chi.URLParam(r, "commentId"), "comment_id")
	if !ok {
		return
	}
	plan, err := h.Queries.GetAgentPlan(r.Context(), planID)
	if err != nil || plan.WorkspaceID != workspaceID {
		writeError(w, http.StatusNotFound, "plan not found")
		return
	}
	resolved, err := h.Queries.ResolveAgentPlanComment(r.Context(), db.ResolveAgentPlanCommentParams{
		ID:         commentID,
		PlanID:     planID,
		ResolvedBy: parseUUID(requestUserID(r)),
	})
	if errors.Is(err, pgx.ErrNoRows) {
		writeErrorCode(w, http.StatusConflict, "comment_resolved", "the comment is already resolved")
		return
	}
	if err != nil {
		slog.Warn("resolve plan comment failed", "error", err)
		writeError(w, http.StatusInternalServerError, "failed to resolve the comment")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"comment": planCommentToResponse(resolved)})
}

// UpdatePlanSection handles
// PUT /api/workspaces/{id}/plans/{planId}/sections/{sectionId}: the human's
// edit of one section.
//
// Fenced on the page's revision. While the plan is in_review the edit also
// advances submitted_revision (M-275 decision 1), so the reviewer's verdict
// rides their own edit instead of 409-ing against a revision their save made.
// The agent's own PUT (no section id in the path) keeps its draft /
// changes_requested restriction: a human owns the review, the agent does not
// edit under it.
func (h *Handler) UpdatePlanSection(w http.ResponseWriter, r *http.Request) {
	workspaceID, ok := h.workspaceIDFromURL(w, r)
	if !ok {
		return
	}
	planID, ok := parseUUIDOrBadRequest(w, chi.URLParam(r, "planId"), "plan_id")
	if !ok {
		return
	}
	sectionID := chi.URLParam(r, "sectionId")
	if sectionID == "" {
		writeError(w, http.StatusBadRequest, "section_id is required")
		return
	}
	var req planSectionEditRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid JSON body")
		return
	}
	heading := strings.TrimSpace(req.Heading)
	if heading == "" {
		writeError(w, http.StatusBadRequest, "heading is required")
		return
	}
	if len(heading) > planSectionHeadingMax {
		writeError(w, http.StatusBadRequest, "heading is too long")
		return
	}
	if len(req.Markdown) > planSectionCharMax {
		writeError(w, http.StatusBadRequest, "section body is too large")
		return
	}
	plan, err := h.Queries.GetAgentPlan(r.Context(), planID)
	if err != nil || plan.WorkspaceID != workspaceID {
		writeError(w, http.StatusNotFound, "plan not found")
		return
	}
	if isFinalPlanStatus(plan.Status) {
		writeErrorCode(w, http.StatusConflict, "plan_closed", "plan is final and no longer changes")
		return
	}
	if plan.Revision != req.BaseRevision {
		h.writeStalePlanRevision(w, r, planID)
		return
	}
	if !planHasSection(plan.Sections, sectionID) {
		writeError(w, http.StatusBadRequest, "unknown section")
		return
	}
	merged, mergeErr := mergePlanSection(plan.Sections, sectionID, heading, req.Markdown)
	if mergeErr != nil {
		writeError(w, http.StatusBadRequest, mergeErr.Error())
		return
	}
	updated, err := h.Queries.UpdateAgentPlanSection(r.Context(), db.UpdateAgentPlanSectionParams{
		ID:           planID,
		Sections:     merged,
		BaseRevision: req.BaseRevision,
	})
	if errors.Is(err, pgx.ErrNoRows) {
		h.writeStalePlanRevision(w, r, planID)
		return
	}
	if err != nil {
		slog.Warn("edit plan section failed", "error", err)
		writeError(w, http.StatusInternalServerError, "failed to save the section")
		return
	}
	h.recordPlanSectionVersion(r.Context(), updated, sectionID, heading, req.Markdown, "member", parseUUID(requestUserID(r)))
	comments, _ := h.Queries.ListAgentPlanComments(r.Context(), planID)
	writeJSON(w, http.StatusOK, planToResponseWithComments(updated, comments))
}

// ListPlanSectionHistory handles
// GET /api/workspaces/{id}/plans/{planId}/sections/{sectionId}/history.
//
// The ledger only holds writes made after this migration, so a section that
// predates it has no history: the first read seeds the current text as its one
// version, which is what stops the panel from claiming a section was never
// written.
func (h *Handler) ListPlanSectionHistory(w http.ResponseWriter, r *http.Request) {
	workspaceID, ok := h.workspaceIDFromURL(w, r)
	if !ok {
		return
	}
	planID, ok := parseUUIDOrBadRequest(w, chi.URLParam(r, "planId"), "plan_id")
	if !ok {
		return
	}
	sectionID := chi.URLParam(r, "sectionId")
	plan, err := h.Queries.GetAgentPlan(r.Context(), planID)
	if err != nil || plan.WorkspaceID != workspaceID {
		writeError(w, http.StatusNotFound, "plan not found")
		return
	}
	versions, err := h.Queries.ListAgentPlanSectionVersions(r.Context(), db.ListAgentPlanSectionVersionsParams{
		PlanID:    planID,
		SectionID: sectionID,
	})
	if err != nil {
		slog.Warn("list plan section versions failed", "error", err)
		writeError(w, http.StatusInternalServerError, "failed to load the section history")
		return
	}
	if len(versions) == 0 {
		if section, found := planSectionByID(plan.Sections, sectionID); found {
			h.recordPlanSectionVersion(r.Context(), plan, sectionID, section.Heading, section.Markdown, "agent", plan.AgentID)
			versions, err = h.Queries.ListAgentPlanSectionVersions(r.Context(), db.ListAgentPlanSectionVersionsParams{
				PlanID:    planID,
				SectionID: sectionID,
			})
			if err != nil {
				slog.Warn("relist plan section versions failed", "error", err)
			}
		}
	}
	items := make([]planSectionVersionResponse, 0, len(versions))
	for _, v := range versions {
		items = append(items, planSectionVersionToResponse(v))
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"section_id": sectionID,
		"revision":   plan.Revision,
		"versions":   items,
	})
}

// recordPlanSectionVersion appends one accepted section write to the ledger.
// Best-effort by design: the write it records is already committed, and the
// ON CONFLICT in the query makes a replay a no-op.
func (h *Handler) recordPlanSectionVersion(ctx context.Context, plan db.AgentPlan, sectionID, heading, markdown, writerType string, writerID pgtype.UUID) {
	if sectionID == "" {
		return
	}
	if err := h.Queries.CreateAgentPlanSectionVersion(ctx, db.CreateAgentPlanSectionVersionParams{
		ID:          dbid.NewV7(),
		WorkspaceID: plan.WorkspaceID,
		PlanID:      plan.ID,
		SectionID:   sectionID,
		Revision:    plan.Revision,
		Heading:     heading,
		Markdown:    markdown,
		WriterType:  writerType,
		WriterID:    writerID,
	}); err != nil {
		slog.Warn("record plan section version failed", "error", err, "plan_id", uuidToString(plan.ID))
	}
}

// planSectionJSON is a stored section as the agent's tool wrote it (camelCase
// keys inside an otherwise snake_case response).
type planSectionJSON struct {
	SectionID string `json:"sectionId"`
	Heading   string `json:"heading"`
	Markdown  string `json:"markdown"`
}

func planSectionByID(sectionsJSON []byte, sectionID string) (planSectionJSON, bool) {
	var sections []planSectionJSON
	if err := json.Unmarshal(sectionsJSON, &sections); err != nil {
		return planSectionJSON{}, false
	}
	for _, section := range sections {
		if section.SectionID == sectionID {
			return section, true
		}
	}
	return planSectionJSON{}, false
}

func planHasSection(sectionsJSON []byte, sectionID string) bool {
	_, found := planSectionByID(sectionsJSON, sectionID)
	return found
}

// writeStalePlanRevision is the 409 every fenced plan write answers with: the
// current revision and status, so the page re-renders instead of retrying blind.
func (h *Handler) writeStalePlanRevision(w http.ResponseWriter, r *http.Request, planID pgtype.UUID) {
	latest, err := h.Queries.GetAgentPlan(r.Context(), planID)
	if err != nil {
		writeError(w, http.StatusConflict, "plan changed; retry with the current revision")
		return
	}
	body := map[string]any{
		"error":            "stale_plan_revision",
		"current_revision": latest.Revision,
		"current_status":   latest.Status,
	}
	if latest.SubmittedRevision.Valid {
		body["submitted_revision"] = latest.SubmittedRevision.Int32
	}
	writeJSON(w, http.StatusConflict, body)
}

// GetIssueAskPlan handles GET /api/workspaces/{id}/issues/{issueId}/ask-plan:
// the open cards and open plan the island renders (one read for M-120).
func (h *Handler) GetIssueAskPlan(w http.ResponseWriter, r *http.Request) {
	workspaceID, ok := h.workspaceIDFromURL(w, r)
	if !ok {
		return
	}
	issueID, ok := parseUUIDOrBadRequest(w, chi.URLParam(r, "issueId"), "issue_id")
	if !ok {
		return
	}
	issue, err := h.Queries.GetIssueInWorkspace(r.Context(), db.GetIssueInWorkspaceParams{
		ID:          issueID,
		WorkspaceID: workspaceID,
	})
	if err != nil {
		writeError(w, http.StatusNotFound, "issue not found")
		return
	}
	cards, err := h.Queries.ListOpenQuestionCardsByIssue(r.Context(), issue.ID)
	if err != nil {
		slog.Warn("list open question cards failed", "error", err)
		writeError(w, http.StatusInternalServerError, "failed to load question cards")
		return
	}
	resp := askPlanStateResponse{QuestionCards: make([]cardResponse, 0, len(cards))}
	for _, c := range cards {
		resp.QuestionCards = append(resp.QuestionCards, cardToResponse(c))
	}
	plan, err := h.Queries.GetOpenAgentPlanByIssue(r.Context(), issue.ID)
	if err == nil {
		comments, commentsErr := h.Queries.ListAgentPlanComments(r.Context(), plan.ID)
		if commentsErr != nil {
			slog.Warn("load plan comments failed", "error", commentsErr)
		}
		p := planToResponseWithComments(plan, comments)
		resp.Plan = &p
	} else if !errors.Is(err, pgx.ErrNoRows) {
		slog.Warn("load open plan failed", "error", err)
	}
	writeJSON(w, http.StatusOK, resp)
}

// ---- daemon park report ----

// TaskBlockedRequest is the daemon's park report body.
type TaskBlockedRequest struct {
	SessionID string `json:"session_id,omitempty"`
	WorkDir   string `json:"work_dir,omitempty"`
}

// BlockTask handles POST /api/daemon/tasks/{taskId}/blocked: the daemon
// observed the blocked status on its cancel poll, interrupted the local agent,
// and reports the session so the answer's resume run can continue it.
func (h *Handler) BlockTask(w http.ResponseWriter, r *http.Request) {
	task, _, ok := h.requireDaemonTaskAccessWithWorkspace(w, r, chi.URLParam(r, "taskId"))
	if !ok {
		return
	}
	var req TaskBlockedRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid JSON body")
		return
	}
	recorded, err := h.TaskService.RecordBlockedTaskSession(r.Context(), task.ID, req.SessionID, req.WorkDir)
	if err != nil {
		slog.Warn("record blocked task session failed", "error", err)
		writeError(w, http.StatusInternalServerError, "failed to record parked session")
		return
	}
	if recorded == nil {
		// Not blocked anymore — advisory no-op, same contract as a late ack.
		writeJSON(w, http.StatusOK, map[string]string{"status": "ignored"})
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}

// ---- shared helpers ----

func (h *Handler) workspaceIDFromURL(w http.ResponseWriter, r *http.Request) (pgtype.UUID, bool) {
	return parseUUIDOrBadRequest(w, chi.URLParam(r, "id"), "workspace_id")
}

func validateAskRequest(req askRequest) error {
	if len(req.Context) > askContextLimit {
		return errors.New("context is too long (max " + strconv.Itoa(askContextLimit) + ")")
	}
	if len(req.Questions) == 0 || len(req.Questions) > askMaxQuestions {
		return errors.New("questions must be 1 to " + strconv.Itoa(askMaxQuestions))
	}
	for i, q := range req.Questions {
		if q.Prompt == "" || len(q.Prompt) > askPromptLimit {
			return errors.New("question " + strconv.Itoa(i+1) + " prompt must be 1 to " + strconv.Itoa(askPromptLimit) + " characters")
		}
		if len(q.Options) < askMinOptions || len(q.Options) > askMaxOptions {
			return errors.New("question " + strconv.Itoa(i+1) + " must have " + strconv.Itoa(askMinOptions) + " to " + strconv.Itoa(askMaxOptions) + " options")
		}
		for _, o := range q.Options {
			if o.Label == "" || len(o.Label) > askLabelLimit {
				return errors.New("option labels must be 1 to " + strconv.Itoa(askLabelLimit) + " characters")
			}
			if len(o.Description) > askDescriptionLimit {
				return errors.New("option descriptions must be at most " + strconv.Itoa(askDescriptionLimit) + " characters")
			}
		}
	}
	return nil
}

// validateCardAnswers enforces one answer per question in order, with the
// selected indexes inside the option range (team-room normalizeDecisionAnswers).
func validateCardAnswers(questionsJSON []byte, answers []planAnswerItem) error {
	var questions []cardQuestion
	if err := json.Unmarshal(questionsJSON, &questions); err != nil {
		return errors.New("card questions are unreadable")
	}
	if len(answers) != len(questions) {
		return errors.New("one answer per question is required, in question order")
	}
	for i, a := range answers {
		q := questions[i]
		if len(a.Selected) == 0 && a.Text == "" {
			return errors.New("question " + strconv.Itoa(i+1) + " needs a selected option or an answer text")
		}
		if !q.Multiple && len(a.Selected) > 1 {
			return errors.New("question " + strconv.Itoa(i+1) + " allows only one selection")
		}
		for _, idx := range a.Selected {
			if idx < 0 || idx >= len(q.Options) {
				return errors.New("question " + strconv.Itoa(i+1) + " has an out-of-range option index")
			}
		}
		if len(a.Text) > askAnswerTextLimit {
			return errors.New("answer text for question " + strconv.Itoa(i+1) + " is too long")
		}
	}
	return nil
}

// refuseUnlessPlanningPhase enforces the plan gate: the issue must still be
// backlog/todo/planing_2 and no OTHER task may be active for it (the caller
// is excluded — it is running by construction). blocked is not active.
func (h *Handler) refuseUnlessPlanningPhase(r *http.Request, task db.AgentTaskQueue) error {
	issue, err := h.Queries.GetIssue(r.Context(), task.IssueID)
	if err != nil {
		return errors.New("failed to load issue")
	}
	if !isPlanningStatus(issue.Status) {
		return errors.New("a plan is proposed only while the issue is backlog, todo or planing_2")
	}
	active, err := h.Queries.CountActiveTasksForIssueExcluding(r.Context(), db.CountActiveTasksForIssueExcludingParams{
		IssueID:        issue.ID,
		ExcludedTaskID: task.ID,
	})
	if err != nil {
		return errors.New("failed to check active tasks")
	}
	if active > 0 {
		return errors.New("the issue has another active task; wait for it to finish before proposing a plan")
	}
	return nil
}

func isPlanningStatus(status string) bool {
	switch status {
	case "backlog", "todo", "planing_2":
		return true
	default:
		return false
	}
}

func isFinalPlanStatus(status string) bool {
	return status == "approved" || status == "cancelled"
}

func currentPlanSections(sectionsJSON []byte) []map[string]any {
	var sections []map[string]any
	_ = json.Unmarshal(sectionsJSON, &sections)
	return sections
}

func mergePlanSection(sectionsJSON []byte, sectionID, heading, markdown string) ([]byte, error) {
	var sections []map[string]any
	if err := json.Unmarshal(sectionsJSON, &sections); err != nil {
		sections = nil
	}
	merged := map[string]any{"sectionId": sectionID, "heading": heading, "markdown": markdown}
	for i, s := range sections {
		if id, _ := s["sectionId"].(string); id == sectionID {
			sections[i] = merged
			return json.Marshal(sections)
		}
	}
	sections = append(sections, merged)
	return json.Marshal(sections)
}

// deliverAskPlanInbox inserts one inbox item per workspace member.
// CreateIfEligible quietly skips recipients who are not workspace members.
func (h *Handler) deliverAskPlanInbox(r *http.Request, workspaceID, issueID pgtype.UUID, notifType, title, preview string, details map[string]any) error {
	members, err := h.Queries.ListMembers(r.Context(), workspaceID)
	if err != nil {
		return err
	}
	detailsJSON, err := json.Marshal(details)
	if err != nil {
		return err
	}
	body := pgtype.Text{String: preview, Valid: preview != ""}
	for _, m := range members {
		item, inserted, err := inbox.CreateIfEligible(r.Context(), h.Queries, db.CreateInboxItemParams{
			ID:            dbid.NewV7(),
			WorkspaceID:   workspaceID,
			RecipientType: "member",
			RecipientID:   m.UserID,
			Type:          notifType,
			Severity:      "action_required",
			IssueID:       issueID,
			Title:         title,
			Body:          body,
			ActorType:     pgtype.Text{String: "agent", Valid: true},
			ActorID:       pgtype.UUID{},
			Details:       detailsJSON,
		})
		if err != nil {
			return err
		}
		if inserted {
			h.publish(protocol.EventInboxNew, uuidToString(workspaceID), "system", "", map[string]any{
				"item": inboxToResponse(item),
				"user": uuidToString(m.UserID),
			})
		}
	}
	return nil
}
