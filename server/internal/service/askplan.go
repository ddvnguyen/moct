// Package service — S1-A1 (M-118): ask/plan services.
//
// The server half of the ask/plan parity feature (plan v1, Architect-approved
// with amendments 1–3). Semantics ported from moct-dsh-team-room @ fefa9c3
// (plan-tools.ts / decision-tools.ts); storage and code are not.
//
// Lifecycle, one parked run each:
//
//	ask    : agent POSTs questions → card 'open' + inbox 'agent_question'
//	         + task running→blocked ("awaiting human"), returns immediately.
//	answer : human answers the open card (single answer, CAS) → resume task
//	         enqueued with rerun_of_task_id = the parked task; the daemon
//	         claim resolves prior_session_id from that named source, so the
//	         run resumes the parked session.
//	plan   : agent creates a draft (planning gate), writes revision-fenced
//	         sections, submits → plan 'in_review' + inbox 'plan_review' +
//	         task blocked. Verdicts: approve (plan rendered into the issue
//	         description), changes_requested (≥1 comment or note), cancel
//	         (frees the issue for a new plan) — each then resumes the run.
//
// The parked task is NOT terminal. It leaves blocked via human cancel (which
// withdraws the card / cancels the plan — amendment 3), issue/agent teardown,
// or — since M-131 — the ask/plan timeout sweeper, which reaps it only while
// its evidence is still open and only after the effective timeout: withdraw /
// cancel through the same settle, cancel the parked task, escalate to the
// project lead. An answered park is never a candidate (first answer wins), no
// run is ever cancelled outright, and no resume is ever written with a notice.
package service

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"strings"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/multica-ai/multica/server/internal/attribution"
	"github.com/multica-ai/multica/server/internal/util"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
	"github.com/multica-ai/multica/server/pkg/dbid"
	"github.com/multica-ai/multica/server/pkg/protocol"
)

// Evidence kinds stamped on the parked task and on the resume task, so the
// daemon prompt can render the answer/verdict block and the UI can jump from
// a task to its card. Free-text column (184 attribution) — no migration.
const (
	EvidenceQuestionAnswer = "question_answer"
	EvidencePlanVerdict    = "plan_verdict"
)

// Planning statuses: a plan may be proposed only while the issue is still
// being designed (team-room's assertPlanningPhase, mapped to Multica keys).
var planningStatuses = map[string]bool{
	"backlog":   true,
	"todo":      true,
	"planing_2": true,
}

// WaitReasonAskPlan is the short hint parked tasks carry next to their status.
const WaitReasonAskPlan = "awaiting human answer"

// ErrQuestionCardClosed / ErrPlanClosed / ErrPlanStaleRevision are business
// outcomes, never 500s: the card was already answered, the plan already final,
// or the caller fenced on an older revision (port of team-room's
// stale_doc_revision). Handlers map them to 409 with the current value.
var (
	ErrQuestionCardClosed = errors.New("question card is no longer open")
	ErrPlanClosed         = errors.New("plan is final and no longer changes")
	ErrPlanStaleRevision  = errors.New("plan changed since this revision")
	ErrPlanNotInReview    = errors.New("plan is not awaiting a verdict")
	ErrPlanNeedsComment   = errors.New("changes_requested needs at least one comment or a note")
	ErrPlanNotPlanning    = errors.New("a plan is proposed only while the issue is backlog, todo or planing_2 with no other active task")
	ErrTaskNotRunning     = errors.New("task is not running")
)

// BlockTaskForAskPlan parks a running task: running → blocked, settling any
// pending supplements in the same transaction (the daemon interrupts the run,
// so a pending steer can never be delivered — same atomicity invariant the
// terminal paths hold), then reconciles the agent to idle and broadcasts
// task:blocked. The CAS on 'running' makes a double submit a no-op.
func (s *TaskService) BlockTaskForAskPlan(ctx context.Context, taskID pgtype.UUID, evidenceKind string, evidenceRefID pgtype.UUID, waitReason string) (*db.AgentTaskQueue, error) {
	var task *db.AgentTaskQueue
	err := s.runInTx(ctx, func(qtx *db.Queries) error {
		blocked, err := qtx.BlockAgentTask(ctx, db.BlockAgentTaskParams{
			ID:                   taskID,
			TriggerEvidenceKind:  pgtype.Text{String: evidenceKind, Valid: evidenceKind != ""},
			TriggerEvidenceRefID: evidenceRefID,
			WaitReason:           pgtype.Text{String: waitReason, Valid: waitReason != ""},
		})
		if errors.Is(err, pgx.ErrNoRows) {
			return ErrTaskNotRunning
		}
		if err != nil {
			return fmt.Errorf("block task: %w", err)
		}
		task = &blocked
		// Blocked is not terminal for GC, but the turn is over for supplements.
		if _, err := qtx.SettleTerminalTaskSupplements(ctx, []pgtype.UUID{taskID}); err != nil {
			return fmt.Errorf("settle supplements on block: %w", err)
		}
		return nil
	})
	if err != nil {
		return nil, err
	}
	s.ReconcileAgentStatus(ctx, task.AgentID)
	s.broadcastTaskEvent(ctx, protocol.EventTaskBlocked, *task)
	slog.Info("task blocked awaiting human",
		"task_id", util.UUIDToString(task.ID),
		"issue_id", util.UUIDToString(task.IssueID),
		"evidence_kind", evidenceKind,
	)
	return task, nil
}

// RecordBlockedTaskSession is the daemon's park report: the daemon observed
// the blocked status on its cancel poll, interrupted the local agent, and
// reports the session it had built so the answer's resume run can continue
// it. Idempotent — the status CAS means a late report after cancellation or a
// duplicate changes nothing.
func (s *TaskService) RecordBlockedTaskSession(ctx context.Context, taskID pgtype.UUID, sessionID, workDir string) (*db.AgentTaskQueue, error) {
	params := db.SetBlockedTaskSessionParams{
		ID:        taskID,
		SessionID: pgtype.Text{String: sessionID, Valid: sessionID != ""},
		WorkDir:   pgtype.Text{String: workDir, Valid: workDir != ""},
	}
	task, err := s.Queries.SetBlockedTaskSession(ctx, params)
	if errors.Is(err, pgx.ErrNoRows) {
		// Not blocked (cancelled/completed first, or never blocked): the park
		// report is advisory; dropping it preserves the documented degradation
		// (the answer run starts fresh).
		slog.Info("park report dropped: task not blocked", "task_id", util.UUIDToString(taskID))
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("record blocked task session: %w", err)
	}
	slog.Info("parked task session recorded",
		"task_id", util.UUIDToString(taskID),
		"session_recorded", task.SessionID.Valid,
	)
	return &task, nil
}

// SettleParkedAskPlanForTasks withdraws every open question card and cancels
// every open plan owned by the given task batch (Architect amendment 3). The
// cancel paths call it inside their transaction, next to
// SettleTerminalTaskState, so a cancelled parked task can never leave a card
// that looks answerable. No-op for tasks that never parked.
func SettleParkedAskPlanForTasks(ctx context.Context, q *db.Queries, tasks []db.AgentTaskQueue) error {
	if len(tasks) == 0 {
		return nil
	}
	ids := make([]pgtype.UUID, 0, len(tasks))
	for _, t := range tasks {
		ids = append(ids, t.ID)
	}
	if err := q.WithdrawQuestionCardsByTask(ctx, ids); err != nil {
		return fmt.Errorf("withdraw parked question cards: %w", err)
	}
	if err := q.CancelPlansByTask(ctx, ids); err != nil {
		return fmt.Errorf("cancel parked plans: %w", err)
	}
	return nil
}

// CreateQuestionCard inserts the open card for a running task's ask. The card
// is created before BlockTask so the evidence ref exists when the task parks;
// the handler orders the calls and rolls nothing back on block failure (a
// task that finished mid-ask keeps its card, which a human can still read —
// answering it then fails the CAS, which is honest).
func (s *TaskService) CreateQuestionCard(ctx context.Context, task db.AgentTaskQueue, workspaceID pgtype.UUID, contextText string, questions json.RawMessage) (db.AgentQuestionCard, error) {
	card, err := s.Queries.CreateAgentQuestionCard(ctx, db.CreateAgentQuestionCardParams{
		ID:          dbid.NewV7(),
		WorkspaceID: workspaceID,
		IssueID:     task.IssueID,
		TaskID:      task.ID,
		AgentID:     task.AgentID,
		Context:     pgtype.Text{String: contextText, Valid: contextText != ""},
		Questions:   questions,
	})
	if err != nil {
		return db.AgentQuestionCard{}, fmt.Errorf("create question card: %w", err)
	}
	return card, nil
}

// AnswerQuestionCard stores the single answer and enqueues the resume run in
// ONE transaction: a half-committed answer (recorded, no resume) would strand
// the card as answered with no continuation, and a half-committed resume
// (enqueued, answer lost) would resurrect a session the human never steered.
// The CAS on 'open' makes a second answer ErrQuestionCardClosed → 409.
func (s *TaskService) AnswerQuestionCard(ctx context.Context, cardID, workspaceID, answeredBy pgtype.UUID, answers json.RawMessage) (db.AgentQuestionCard, *db.AgentTaskQueue, error) {
	var (
		card       db.AgentQuestionCard
		resumeTask *db.AgentTaskQueue
	)
	err := s.runInTx(ctx, func(qtx *db.Queries) error {
		answered, err := qtx.AnswerAgentQuestionCard(ctx, db.AnswerAgentQuestionCardParams{
			ID:         cardID,
			Answers:    answers,
			AnsweredBy: answeredBy,
		})
		if errors.Is(err, pgx.ErrNoRows) {
			return ErrQuestionCardClosed
		}
		if err != nil {
			return fmt.Errorf("answer question card: %w", err)
		}
		card = answered

		parked, err := qtx.GetAgentTask(ctx, card.TaskID)
		if err != nil {
			return fmt.Errorf("load parked task: %w", err)
		}
		issue, err := qtx.GetIssue(ctx, parked.IssueID)
		if err != nil {
			return fmt.Errorf("load issue: %w", err)
		}
		note := renderQuestionAnswerHandoff(card, answers)
		txService := &TaskService{Queries: qtx}
		task, err := txService.enqueueAskPlanResumeTask(ctx, issue, parked, EvidenceQuestionAnswer, card.ID, note, answeredBy)
		if err != nil {
			return err
		}
		resumeTask = &task
		return nil
	})
	if err != nil {
		if errors.Is(err, ErrQuestionCardClosed) {
			return db.AgentQuestionCard{}, nil, err
		}
		return db.AgentQuestionCard{}, nil, err
	}
	// Post-commit side effects mirror every other enqueue path.
	s.broadcastTaskEvent(ctx, protocol.EventTaskQueued, *resumeTask)
	s.NotifyTaskEnqueued(ctx, *resumeTask)
	return card, resumeTask, nil
}

// ReviewPlan applies one human verdict to an in_review plan and, on every
// verdict, enqueues the resume run. approve additionally renders the plan into
// the issue description (ExpectedRevision optimistic fence) in the same
// transaction as the verdict, so an approval can never record without its
// promotion or vice versa. promotedIssue is the post-promotion issue row on
// approve (nil otherwise) so the handler can publish issue:updated with the
// description_changed flag the activity listener reads.
func (s *TaskService) ReviewPlan(ctx context.Context, planID, workspaceID, reviewedBy pgtype.UUID, planRevision int32, verdict string, comments json.RawMessage, note string) (db.AgentPlan, *db.AgentTaskQueue, *db.Issue, error) {
	var (
		plan       db.AgentPlan
		resumeTask *db.AgentTaskQueue
		promoted   *db.Issue
	)
	err := s.runInTx(ctx, func(qtx *db.Queries) error {
		current, err := qtx.GetAgentPlan(ctx, planID)
		if err != nil {
			return fmt.Errorf("load plan: %w", err)
		}
		if isFinalPlanStatus(current.Status) {
			return ErrPlanClosed
		}
		if current.Status != "in_review" {
			return ErrPlanNotInReview
		}
		if !current.SubmittedRevision.Valid || current.SubmittedRevision.Int32 != planRevision {
			return ErrPlanStaleRevision
		}

		// M-275: every verdict sends the plan page's pending comments. They are
		// settled here, in the verdict's own transaction, and their bodies ride
		// the flat list agent_plan_review.comments still stores — the Answered
		// view and the S1-A1 Go tests keep their contract.
		pending, err := qtx.ListUndeliveredAgentPlanComments(ctx, planID)
		if err != nil {
			return fmt.Errorf("load pending plan comments: %w", err)
		}
		comments, err = mergeDeliveredPlanComments(comments, pending)
		if err != nil {
			return err
		}
		if verdict == "changes_requested" && !hasReviewComment(comments, note) {
			return ErrPlanNeedsComment
		}
		if len(pending) > 0 {
			ids := make([]pgtype.UUID, 0, len(pending))
			for _, comment := range pending {
				ids = append(ids, comment.ID)
			}
			if err := qtx.DeliverAgentPlanComments(ctx, db.DeliverAgentPlanCommentsParams{
				Ids:     ids,
				Verdict: pgtype.Text{String: verdict, Valid: true},
			}); err != nil {
				return fmt.Errorf("deliver plan comments: %w", err)
			}
		}

		if _, err := qtx.RecordAgentPlanReview(ctx, db.RecordAgentPlanReviewParams{
			ID:           dbid.NewV7(),
			PlanID:       planID,
			PlanRevision: planRevision,
			Verdict:      verdict,
			Comments:     comments,
			Note:         pgtype.Text{String: note, Valid: note != ""},
			ReviewedBy:   reviewedBy,
		}); err != nil {
			return fmt.Errorf("record plan review: %w", err)
		}

		switch verdict {
		case "approve":
			approved, err := qtx.ApproveAgentPlan(ctx, db.ApproveAgentPlanParams{
				ID:         planID,
				ReviewedBy: reviewedBy,
				Revision:   pgtype.Int4{Int32: planRevision, Valid: true},
			})
			if errors.Is(err, pgx.ErrNoRows) {
				return ErrPlanStaleRevision
			}
			if err != nil {
				return fmt.Errorf("approve plan: %w", err)
			}
			plan = approved
			if body := renderPlanBody(approved.Sections); body != "" {
				issue, err := qtx.GetIssue(ctx, approved.IssueID)
				if err != nil {
					return fmt.Errorf("load issue for promotion: %w", err)
				}
				updated, err := qtx.UpdateIssue(ctx, db.UpdateIssueParams{
					ID:               approved.IssueID,
					Description:      pgtype.Text{String: body, Valid: true},
					ExpectedRevision: pgtype.Int8{Int64: issue.Revision, Valid: true},
					AssigneeType:     issue.AssigneeType,
					AssigneeID:       issue.AssigneeID,
					StartDate:        issue.StartDate,
					DueDate:          issue.DueDate,
					ParentIssueID:    issue.ParentIssueID,
					ProjectID:        issue.ProjectID,
					Stage:            issue.Stage,
				})
				if errors.Is(err, pgx.ErrNoRows) {
					return ErrIssueRevisionConflict
				}
				if err != nil {
					return fmt.Errorf("promote plan into issue description: %w", err)
				}
				promoted = &updated
			}
		case "changes_requested":
			changed, err := qtx.RequestAgentPlanChanges(ctx, db.RequestAgentPlanChangesParams{
				ID:       planID,
				Revision: pgtype.Int4{Int32: planRevision, Valid: true},
			})
			if errors.Is(err, pgx.ErrNoRows) {
				return ErrPlanStaleRevision
			}
			if err != nil {
				return fmt.Errorf("request plan changes: %w", err)
			}
			plan = changed
		case "cancel":
			cancelled, err := qtx.CancelAgentPlan(ctx, planID)
			if errors.Is(err, pgx.ErrNoRows) {
				return ErrPlanClosed
			}
			if err != nil {
				return fmt.Errorf("cancel plan: %w", err)
			}
			plan = cancelled
		default:
			return fmt.Errorf("unknown plan verdict %q", verdict)
		}

		parked, err := qtx.GetAgentTask(ctx, plan.TaskID)
		if err != nil {
			return fmt.Errorf("load parked task: %w", err)
		}
		issue, err := qtx.GetIssue(ctx, parked.IssueID)
		if err != nil {
			return fmt.Errorf("load issue: %w", err)
		}
		handoff := renderPlanVerdictHandoffWithComments(plan, verdict, comments, note, pending)
		txService := &TaskService{Queries: qtx}
		task, err := txService.enqueueAskPlanResumeTask(ctx, issue, parked, EvidencePlanVerdict, plan.ID, handoff, reviewedBy)
		if err != nil {
			return err
		}
		resumeTask = &task
		return nil
	})
	if err != nil {
		return db.AgentPlan{}, nil, nil, err
	}
	s.broadcastTaskEvent(ctx, protocol.EventTaskQueued, *resumeTask)
	s.NotifyTaskEnqueued(ctx, *resumeTask)
	return plan, resumeTask, promoted, nil
}

// enqueueAskPlanResumeTask builds the resume run: a normal issue task for the
// PARKED task's agent, carrying rerun_of_task_id (the claim handler resolves
// prior_session_id from that named source — the only path that can see a
// blocked row's session) and the evidence kind naming the card/plan. Runs in
// the caller's transaction via the tx-scoped service.
func (s *TaskService) enqueueAskPlanResumeTask(ctx context.Context, issue db.Issue, parked db.AgentTaskQueue, evidenceKind string, evidenceRefID pgtype.UUID, handoffNote string, actorUserID pgtype.UUID) (db.AgentTaskQueue, error) {
	agent, err := s.Queries.GetAgent(ctx, parked.AgentID)
	if err != nil {
		return db.AgentTaskQueue{}, fmt.Errorf("load parked agent: %w", err)
	}
	if agent.ArchivedAt.Valid {
		return db.AgentTaskQueue{}, fmt.Errorf("parked agent %s is archived; resume run cannot be enqueued", agent.Name)
	}
	if !agent.RuntimeID.Valid {
		return db.AgentTaskQueue{}, fmt.Errorf("parked agent %s has no runtime; resume run cannot be enqueued", agent.Name)
	}
	attr := s.attributionForIssueTask(ctx, issue, pgtype.UUID{}, attribution.SourceCommentSource, actorUserID)
	attr, err = s.applyAttributionFallback(ctx, attr, agent)
	if err != nil {
		return db.AgentTaskQueue{}, err
	}
	overlay := s.buildRuntimeMCPOverlay(ctx, attr.UserID, agent)
	attrSource, attrDelegatedFrom, _, _ := attributionCreateParams(attr)
	task, err := s.Queries.CreateAgentTask(ctx, db.CreateAgentTaskParams{
		ID:          dbid.NewV7(),
		AgentID:     parked.AgentID,
		RuntimeID:   agent.RuntimeID,
		IssueID:     parked.IssueID,
		Priority:    priorityToInt(issue.Priority),
		HandoffNote: pgtype.Text{String: handoffNote, Valid: handoffNote != ""},
		// forceFreshSession stays false: the whole point is resuming the parked
		// session through the named rerun source.
		OriginatorUserID:     attr.UserID,
		AccountableUserID:    attr.AccountableUserID,
		RuleVersionID:        attr.RuleVersionID,
		RerunOfTaskID:        parked.ID,
		RuntimeMcpOverlay:    overlay.Overlay,
		RuntimeConnectedApps: overlay.ConnectedApps,
		OriginatorSource:     attrSource,
		DelegatedFromTaskID:  attrDelegatedFrom,
		TriggerEvidenceKind:  pgtype.Text{String: evidenceKind, Valid: true},
		TriggerEvidenceRefID: evidenceRefID,
		HeadSha:              headShaText(s.ResolveIssueReviewSHA(ctx, issue.ID)),
	})
	if err != nil {
		if isDuplicatePendingTaskErr(err) {
			return db.AgentTaskQueue{}, ErrDuplicatePendingTask
		}
		return db.AgentTaskQueue{}, fmt.Errorf("create resume task: %w", err)
	}
	slog.Info("ask/plan resume task enqueued",
		"task_id", util.UUIDToString(task.ID),
		"parked_task_id", util.UUIDToString(parked.ID),
		"evidence_kind", evidenceKind,
	)
	return task, nil
}

func isFinalPlanStatus(status string) bool {
	return status == "approved" || status == "cancelled"
}

func hasReviewComment(comments json.RawMessage, note string) bool {
	if strings.TrimSpace(note) != "" {
		return true
	}
	var list []string
	if err := json.Unmarshal(comments, &list); err != nil {
		return false
	}
	for _, c := range list {
		if strings.TrimSpace(c) != "" {
			return true
		}
	}
	return false
}

// renderPlanBody is the port of team-room's renderPlanBody (ledger.ts
// @ fefa9c3): each non-empty section as "## heading\n\nbody", sections joined
// by blank lines, empty sections skipped, empty body → "" (never promoted).
func renderPlanBody(sectionsJSON json.RawMessage) string {
	var sections []planSection
	if err := json.Unmarshal(sectionsJSON, &sections); err != nil {
		return ""
	}
	var parts []string
	for _, s := range sections {
		heading := strings.TrimSpace(s.Heading)
		body := strings.TrimSpace(s.Markdown)
		if heading == "" && body == "" {
			continue
		}
		if heading == "" {
			parts = append(parts, body)
			continue
		}
		parts = append(parts, fmt.Sprintf("## %s\n\n%s", heading, body))
	}
	return strings.Join(parts, "\n\n")
}

type planSection struct {
	SectionID string `json:"sectionId"`
	Heading   string `json:"heading"`
	Markdown  string `json:"markdown"`
}

// renderQuestionAnswerHandoff is what the resumed run reads: the member's
// answers, one line per question, in question order (the port of team-room's
// decisionAnswersText — labels plus quoted free text).
func renderQuestionAnswerHandoff(card db.AgentQuestionCard, answers json.RawMessage) string {
	var qs []askPlanQuestion
	var as []askPlanAnswer
	_ = json.Unmarshal(card.Questions, &qs)
	_ = json.Unmarshal(answers, &as)
	var b strings.Builder
	b.WriteString("Your question was answered by a human. This run resumes the session that asked it; treat the answers below as the human's reply and continue the task accordingly.\n\n")
	if card.Context.Valid && strings.TrimSpace(card.Context.String) != "" {
		b.WriteString("Context you provided: ")
		b.WriteString(strings.TrimSpace(card.Context.String))
		b.WriteString("\n\n")
	}
	for i, q := range qs {
		fmt.Fprintf(&b, "Q%d: %s\n", i+1, strings.TrimSpace(q.Prompt))
		if i < len(as) {
			a := as[i]
			for _, idx := range a.Selected {
				if idx >= 0 && idx < len(q.Options) {
					fmt.Fprintf(&b, "  - %s\n", strings.TrimSpace(q.Options[idx].Label))
				}
			}
			if text := strings.TrimSpace(a.Text); text != "" {
				fmt.Fprintf(&b, "  Answer text: %s\n", text)
			}
		}
		b.WriteString("\n")
	}
	return strings.TrimRight(b.String(), "\n")
}

// mergeDeliveredPlanComments folds the plan page's pending comment bodies into
// the verdict's flat comment list, so agent_plan_review.comments keeps meaning
// "what the human sent" for callers on either shape. The request's own list
// stays first: it is the legacy note box, and a body already present is not
// written twice.
func mergeDeliveredPlanComments(comments json.RawMessage, pending []db.AgentPlanComment) (json.RawMessage, error) {
	var list []string
	if len(comments) > 0 {
		_ = json.Unmarshal(comments, &list)
	}
	seen := make(map[string]bool, len(list))
	for _, c := range list {
		seen[strings.TrimSpace(c)] = true
	}
	for _, comment := range pending {
		body := strings.TrimSpace(comment.Body)
		if body == "" || seen[body] {
			continue
		}
		seen[body] = true
		list = append(list, body)
	}
	if list == nil {
		list = []string{}
	}
	merged, err := json.Marshal(list)
	if err != nil {
		return nil, fmt.Errorf("encode plan comments: %w", err)
	}
	return merged, nil
}

// renderPlanVerdictHandoff is the resumed run's instruction for a plan verdict.
//
// M-275: the plan page's comments carry an anchor, so they are rendered the way
// the human wrote them — the section heading, the quoted passage, the body, and
// its replies indented under the root — instead of a flat bullet list.
// renderPlanVerdictHandoff is the flat-list form every pre-M-275 caller and
// test still uses: no anchored comments to render.
func renderPlanVerdictHandoff(plan db.AgentPlan, verdict string, comments json.RawMessage, note string) string {
	return renderPlanVerdictHandoffWithComments(plan, verdict, comments, note, nil)
}

func renderPlanVerdictHandoffWithComments(plan db.AgentPlan, verdict string, comments json.RawMessage, note string, planComments []db.AgentPlanComment) string {
	var b strings.Builder
	revision := int32(0)
	if plan.SubmittedRevision.Valid {
		revision = plan.SubmittedRevision.Int32
	}
	switch verdict {
	case "approve":
		fmt.Fprintf(&b, "Your plan %q (revision %d) was APPROVED by a human. The plan has been written into the issue description — go ahead with it.\n", plan.Title, revision)
	case "changes_requested":
		fmt.Fprintf(&b, "Your plan %q (revision %d) was sent back with CHANGES REQUESTED. Read the comments below, revise the plan sections, and submit it again.\n", plan.Title, revision)
	case "cancel":
		fmt.Fprintf(&b, "Your plan %q was CANCELLED by a human. Do not act on it; stop planning and await further instruction.\n", plan.Title)
	}
	if block := renderPlanComments(plan, planComments); block != "" {
		b.WriteString("\n")
		b.WriteString(block)
		b.WriteString("\n")
	}
	var list []string
	_ = json.Unmarshal(comments, &list)
	// The verdict's own note box list, minus the bodies already rendered above
	// with their anchors.
	anchored := make(map[string]bool, len(planComments))
	for _, comment := range planComments {
		anchored[strings.TrimSpace(comment.Body)] = true
	}
	var flat []string
	for _, c := range list {
		if t := strings.TrimSpace(c); t != "" && !anchored[t] {
			flat = append(flat, t)
		}
	}
	if len(flat) > 0 {
		b.WriteString("\nAlso noted:\n")
		for _, c := range flat {
			fmt.Fprintf(&b, "  - %s\n", c)
		}
	}
	if t := strings.TrimSpace(note); t != "" {
		fmt.Fprintf(&b, "\nNote: %s\n", t)
	}
	return strings.TrimRight(b.String(), "\n")
}

// renderPlanComments writes the plan page's threads: each root under its
// section heading and quoted passage, its replies indented beneath it. A
// comment whose section no longer exists keeps its quote and says so, which is
// the same fallback the plan page renders (M-275 risk a).
func renderPlanComments(plan db.AgentPlan, comments []db.AgentPlanComment) string {
	if len(comments) == 0 {
		return ""
	}
	headings := make(map[string]string)
	var sections []planSection
	if err := json.Unmarshal(plan.Sections, &sections); err == nil {
		for _, section := range sections {
			headings[section.SectionID] = section.Heading
		}
	}
	roots := make(map[pgtype.UUID]bool, len(comments))
	for _, comment := range comments {
		if !comment.ParentCommentID.Valid {
			roots[comment.ID] = true
		}
	}
	var b strings.Builder
	for _, comment := range comments {
		body := strings.TrimSpace(comment.Body)
		if body == "" {
			continue
		}
		reply := comment.ParentCommentID.Valid
		if !reply {
			switch {
			case comment.SectionID == "":
				b.WriteString("### General\n")
			case headings[comment.SectionID] != "":
				fmt.Fprintf(&b, "### %s\n", headings[comment.SectionID])
			default:
				fmt.Fprintf(&b, "### (section %s, since rewritten)\n", comment.SectionID)
			}
			if quote := strings.TrimSpace(comment.Quote); quote != "" {
				fmt.Fprintf(&b, "> %s\n", quote)
			}
			fmt.Fprintf(&b, "%s\n", body)
			continue
		}
		if !roots[comment.ParentCommentID] {
			// A reply whose root is outside this batch (already delivered): keep
			// its text rather than dropping it.
			fmt.Fprintf(&b, "  - reply: %s\n", body)
			continue
		}
		fmt.Fprintf(&b, "  - reply: %s\n", body)
	}
	return strings.TrimRight(b.String(), "\n")
}

// askPlanQuestion / askPlanAnswer mirror the tool contract's JSON shapes.
type askPlanQuestion struct {
	Prompt  string          `json:"prompt"`
	Options []askPlanOption `json:"options"`
}

type askPlanOption struct {
	Label       string `json:"label"`
	Description string `json:"description"`
}

type askPlanAnswer struct {
	Selected []int  `json:"selected"`
	Text     string `json:"text"`
}
