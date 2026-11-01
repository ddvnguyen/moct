package daemon

// S3-B2 (M-138): the seeded-session start decision.
//
// Every dsh run that has a related prior session now has three possible
// starts, and the choice is deterministic — no model judge:
//
//	related + cache still warm              → resume the same session
//	related + cold + a fresh summary beside  → fork a new session seeded with
//	  the prior session                        that summary, parentSession linked
//	related + cold + no usable summary       → fresh
//	not related                             → fresh
//
// "Related" is v1-deterministic: the same issue, or an issue explicitly
// linked to it (its parent or one of its children). The server resolves the
// candidates and applies the resume guards; this file only ranks them and
// chooses. Everything the decision reads is injected — the clock, the config,
// the summary reader — so the table above is testable without a dsh process.

import (
	"encoding/json"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/multica-ai/multica/server/internal/daemon/execenv"
	"github.com/multica-ai/multica/server/pkg/dshsession"
)

// dshSessionStartVerdicts are the three strings recorded on the run row.
// Exactly one lands per dsh run (agent_task_queue.result.session_start), so a
// reader can count starts without parsing prose.
const (
	// dshSessionStartResumed means the run continued an existing session. It
	// also covers the one fallback that keeps an old bridge working: a seed
	// plan the bridge could not honour degrades to today's resume.
	dshSessionStartResumed = "resumed warm"
	// dshSessionStartSeededPrefix prefixes the seeded verdict; the session id
	// follows it verbatim.
	dshSessionStartSeededPrefix = "seeded from summary of "
	// dshSessionStartFresh means the run started with no prior conversation:
	// nothing related, nothing usable to seed from, or a seed the runtime
	// rejected.
	dshSessionStartFresh = "fresh"
	// dshSessionStartReasonEndUnknown is the plan reason for a candidate with
	// no known end time: it is never judged warm, resumed or seeded, because
	// without an end time we cannot tell whether the cache is warm or whether a
	// summary is newer than the session's end.
	dshSessionStartReasonEndUnknown = "fresh: session end time unknown"
)

// dshSeedTokenCap is the ceiling on the whole seed — summary plus trigger —
// expressed in estimated tokens with initctx's (bytes+3)/4 rule (32K, the
// team-room A7b convention). B1's summaries are 1–2K tokens, so the cap only
// bites on a pathological summary or a very large trigger.
const dshSeedTokenCap = 32768

// dshSeedTriggerFloorTokens is the share of the cap the trigger keeps when a
// summary would otherwise consume all of it. A seed with no trigger leaves
// the agent with context but no task, which is worse than a shorter summary.
const dshSeedTriggerFloorTokens = 512

// dshSeedHeader introduces the summary inside the seed. The seed becomes the
// inherited first user message of the forked session, so it has to read as a
// hand-over rather than as the human's own words.
const dshSeedHeader = "Summary of the earlier conversation on this work (compacted by dsh):\n\n"

// dshSeedTriggerHeader separates the summary from the new trigger.
const dshSeedTriggerHeader = "\n\nNew trigger:\n\n"

// dshSessionCandidate is one related session the decision may resume or seed
// from. The server supplies it: the same issue's newest terminal session, and
// the newest terminal session on a linked issue.
type dshSessionCandidate struct {
	SessionID string
	// IssueID names the issue the session belongs to, so a run row says
	// WHICH linked issue the seed came from. Empty for the same-issue
	// candidate on servers that predate the field.
	IssueID string
	// EndedAt is when that session's run reached a terminal state. Zero when
	// the server could not say — an old server, or a row with no timestamp.
	EndedAt time.Time
	// WorkDir is the directory the session ran in; the summary sidecar is
	// stored under the project key derived from it.
	WorkDir string
}

// dshSessionStartInput is every fact the decision reads. All of it is
// injected so a test can drive the table with a fake clock and a fake summary
// store, and so the decision itself never touches the filesystem or the
// network.
type dshSessionStartInput struct {
	Now       time.Time
	Cfg       DshSummaryConfig
	Model     string
	StoreRoot string
	// Prior* is the same-issue candidate, straight off the claim payload.
	PriorSessionID string
	PriorEndedAt   string
	PriorWorkDir   string
	// Linked* is the newest terminal session on an issue explicitly linked to
	// this one, also off the claim payload.
	LinkedSessionID string
	LinkedIssueID   string
	LinkedEndedAt   string
	LinkedWorkDir   string
	// Trigger is the text that started this run (the triggering comment, else
	// the handoff note). It rides the seed so the forked child knows what it
	// was asked to do.
	Trigger string
	// Reachable reports whether this run can actually continue a candidate's
	// session. Injected so the decision is pure AND so it asks the same
	// question the resume gate does: a warm candidate whose session store this
	// run cannot reach is not a resume, it is a fresh or seeded start (F3).
	// Nil means "assume reachable", which is the pre-F3 behaviour.
	Reachable func(candidate dshSessionCandidate) bool
	// ReadSummary loads the summary sidecar beside one candidate. Injected so
	// the decision is pure; production passes readDshSummarySidecar.
	ReadSummary func(candidate dshSessionCandidate) (dshSessionSummaryRecord, bool)
}

// dshSessionStartPlan is the decision's whole output: the verdict for the run
// row plus the fields the execute command needs.
type dshSessionStartPlan struct {
	// Verdict is exactly one of the three run-row strings.
	Verdict string
	// Candidate is the session the verdict is about. Zero for fresh.
	Candidate dshSessionCandidate
	// ResumeSessionID is what to resume. Empty for a seeded or fresh start;
	// set for a resumed one — and set as the FALLBACK for a seeded one, so a
	// bridge that cannot fork still continues the conversation instead of
	// starting cold.
	ResumeSessionID string
	// ForkParent is the session to fork from when the bridge advertises the
	// fork capability. Empty unless the verdict is seeded.
	ForkParent string
	// Seed is the composed summary+trigger text. Empty unless seeded.
	Seed string
	// SeedTokens is the seed's estimated size, for the init-context report.
	SeedTokens  int
	SeedTrimmed bool
	SeedDropped []string
	// Age, TTL and Margin are the numbers behind a warm/cold call, kept for
	// the log line and for the tests.
	Age    time.Duration
	TTL    time.Duration
	Margin time.Duration
	// Reason explains the verdict in one phrase. It goes to the daemon log,
	// never to the run row (the run row carries the verdict alone).
	Reason string
}

// decideDshSessionStart runs the decision table. It is pure: the clock, the
// config and the summary reader all arrive in the input.
func decideDshSessionStart(in dshSessionStartInput) dshSessionStartPlan {
	candidate, ok := dshPickSessionCandidate(in)
	if !ok {
		return dshSessionStartPlan{Verdict: dshSessionStartFresh, Reason: "no related session"}
	}

	ttl := in.Cfg.ttlForModel(in.Model)
	plan := dshSessionStartPlan{
		Verdict:         dshSessionStartResumed,
		Candidate:       candidate,
		ResumeSessionID: candidate.SessionID,
		TTL:             ttl,
		Margin:          in.Cfg.Margin,
	}

	// Without an end time the cache cannot be judged warm and a summary's age
	// cannot be compared to the session's end, so nothing is resumed or seeded.
	// The candidate stays on the plan so the log line names the skipped session.
	if candidate.EndedAt.IsZero() {
		plan.ResumeSessionID = ""
		plan.Verdict = dshSessionStartFresh
		plan.Reason = dshSessionStartReasonEndUnknown
		return plan
	}

	reachable := true
	if in.Reachable != nil {
		reachable = in.Reachable(candidate)
	}

	plan.Age = in.Now.Sub(candidate.EndedAt)
	if plan.Age < 0 {
		// A clock that disagrees with the server's is not evidence of warmth;
		// treat it as just-ended rather than as a negative age.
		plan.Age = 0
	}
	warmWindow := ttl - in.Cfg.Margin
	switch {
	case warmWindow > 0 && plan.Age < warmWindow && reachable:
		plan.Reason = fmt.Sprintf("warm: idle %s < %s", plan.Age.Round(time.Second), warmWindow)
		return plan
	case warmWindow > 0 && plan.Age < warmWindow:
		// Warm by the clock, but unreachable from here: never "resumed".
		plan.Reason = fmt.Sprintf("cold: session store not reachable (idle %s < %s)", plan.Age.Round(time.Second), warmWindow)
	case warmWindow <= 0:
		plan.Reason = "cold: no positive warm window configured"
	default:
		plan.Reason = fmt.Sprintf("cold: idle %s >= %s", plan.Age.Round(time.Second), warmWindow)
	}

	// Cold from here on: the only way to keep the conversation is a summary
	// written while it was still warm (B1's clock).
	plan.ResumeSessionID = ""
	plan.Verdict = dshSessionStartFresh
	if !in.Cfg.Enabled {
		plan.Reason += "; summaries disabled"
		return plan
	}
	if in.ReadSummary == nil {
		plan.Reason += "; no summary reader"
		return plan
	}
	record, found := in.ReadSummary(candidate)
	if !found || strings.TrimSpace(record.Summary) == "" {
		plan.Reason += "; no summary beside the session"
		return plan
	}
	// A summary is only usable for THIS session if it was built after the run
	// ended. A stale sidecar (the run was resumed and ended again without the
	// clock firing) describes history the session has already moved past.
	if record.MadeAt.Before(candidate.EndedAt) {
		plan.Reason += "; summary is older than the session's end"
		return plan
	}
	seed, trimmed, dropped := composeDshSeed(record.Summary, in.Trigger)
	if seed == "" {
		plan.Reason += "; summary produced an empty seed"
		return plan
	}
	plan.Verdict = dshSessionStartSeededPrefix + candidate.SessionID
	plan.ForkParent = candidate.SessionID
	plan.Seed = seed
	plan.SeedTokens = estimateDshSeedTokens(seed)
	plan.SeedTrimmed = trimmed
	plan.SeedDropped = dropped
	plan.Reason += "; summary is fresh"
	return plan
}

// applyDshSessionStartPlan carries the decision onto the task the rest of the
// run reads. The task's prior-session fields are the only input to the resume
// gate, to the brief and to `agent.ExecOptions.ResumeSessionID` (daemon.go,
// `ResumeSessionID: task.PriorSessionID`), so a verdict that is not applied
// here is recorded on the run row and then never happens — which is what F2
// was: a warm LINKED session decided `resumed`, with the run starting fresh
// because nothing copied the plan's candidate onto the task.
//
// A non-resumed verdict clears the same-issue pointer: neither a seeded nor a
// fresh start continues the prior session, and nothing on disk may claim
// continuity the run does not have. The seed, when there is one, carries the
// conversation instead.
func applyDshSessionStartPlan(task *Task, taskCtx *execenv.TaskContextForEnv, plan dshSessionStartPlan) {
	if plan.Verdict != dshSessionStartResumed {
		task.PriorSessionID = ""
		taskCtx.PriorSessionResumed = false
		// A same-issue candidate the run cannot continue is the user's own
		// prior conversation, and starting fresh over it must disclose the
		// loss — which is what the resume gate said until F3 moved the
		// reachability question ahead of it. A linked candidate is another
		// issue's conversation: a fresh start here loses nothing the user was
		// continuing, and a seeded one carries it in the seed.
		if plan.Verdict == dshSessionStartFresh && plan.Candidate.SessionID != "" && plan.Candidate.IssueID == "" {
			task.PriorSessionResumeUnavailable = true
		}
		return
	}
	// Only overwrite with values the plan actually has: an empty workdir in the
	// claim is "the server did not say", not "run nowhere". Leaving the old
	// value lets the gate below judge the resume on the facts it has.
	if plan.ResumeSessionID != "" {
		task.PriorSessionID = plan.ResumeSessionID
	}
	if plan.Candidate.WorkDir != "" {
		task.PriorWorkDir = plan.Candidate.WorkDir
	}
	taskCtx.PriorSessionResumed = task.PriorSessionID != ""
}

// dshPickSessionCandidate ranks the two related candidates: newest end time
// wins, and a candidate with a known end time always beats one without. When
// neither end time is known the same-issue session wins — it is the more
// relevant of the two; either way the verdict is fresh.
func dshPickSessionCandidate(in dshSessionStartInput) (dshSessionCandidate, bool) {
	var (
		same, linked     dshSessionCandidate
		haveSame, haveLk bool
	)
	if strings.TrimSpace(in.PriorSessionID) != "" {
		same = dshSessionCandidate{
			SessionID: in.PriorSessionID,
			EndedAt:   parseDshSessionEndedAt(in.PriorEndedAt),
			WorkDir:   in.PriorWorkDir,
		}
		haveSame = true
	}
	if strings.TrimSpace(in.LinkedSessionID) != "" {
		linked = dshSessionCandidate{
			SessionID: in.LinkedSessionID,
			IssueID:   in.LinkedIssueID,
			EndedAt:   parseDshSessionEndedAt(in.LinkedEndedAt),
			WorkDir:   in.LinkedWorkDir,
		}
		haveLk = true
	}
	switch {
	case haveSame && haveLk:
		if linked.EndedAt.After(same.EndedAt) {
			return linked, true
		}
		return same, true
	case haveSame:
		return same, true
	case haveLk:
		return linked, true
	default:
		return dshSessionCandidate{}, false
	}
}

// parseDshSessionEndedAt reads the claim payload's RFC3339 end time. An
// unparseable or empty value is a zero time, which the decision reads as
// "unknown" rather than as "ended at the epoch".
func parseDshSessionEndedAt(value string) time.Time {
	value = strings.TrimSpace(value)
	if value == "" {
		return time.Time{}
	}
	parsed, err := time.Parse(time.RFC3339, value)
	if err != nil {
		return time.Time{}
	}
	return parsed
}

// composeDshSeed builds the inherited text of a forked session: B1's summary
// plus the trigger that started this run, capped at dshSeedTokenCap.
//
// Truncation order is the brief's: the trigger gives way first, then the
// summary's tail — the summary is the part the agent cannot reconstruct. The
// trigger keeps dshSeedTriggerFloorTokens so a summary at the cap can never
// leave the child with context and no task.
func composeDshSeed(summary, trigger string) (seed string, trimmed bool, dropped []string) {
	summary = strings.TrimSpace(summary)
	if summary == "" {
		return "", false, nil
	}
	trigger = strings.TrimSpace(trigger)

	maxBytes := dshSeedTokenCap * 4
	reserve := len(dshSeedHeader)
	triggerFloor := 0
	if trigger != "" {
		reserve += len(dshSeedTriggerHeader)
		triggerFloor = dshSeedTriggerFloorTokens * 4
	}

	summaryPart, cut := truncateDshSeedPart(summary, maxBytes-reserve-triggerFloor, "\n…[summary truncated]")
	if cut {
		trimmed = true
		dropped = append(dropped, "summary tail")
	}
	var b strings.Builder
	b.WriteString(dshSeedHeader)
	b.WriteString(summaryPart)

	if trigger != "" {
		triggerPart, cut := truncateDshSeedPart(trigger, maxBytes-b.Len()-len(dshSeedTriggerHeader), "\n…[trigger truncated]")
		if cut {
			trimmed = true
			dropped = append(dropped, "trigger tail")
		}
		b.WriteString(dshSeedTriggerHeader)
		b.WriteString(triggerPart)
	}
	return b.String(), trimmed, dropped
}

// truncateDshSeedPart cuts s to at most max bytes without splitting a UTF-8
// rune, appending marker when it had to cut. max <= 0 yields the empty string.
func truncateDshSeedPart(s string, max int, marker string) (string, bool) {
	if max <= 0 {
		return "", true
	}
	if len(s) <= max {
		return s, false
	}
	cut := max - len(marker)
	if cut < 0 {
		cut = max
		marker = ""
	}
	for cut > 0 && !utf8StartByte(s[cut]) {
		cut--
	}
	return s[:cut] + marker, true
}

// utf8StartByte reports whether b begins a UTF-8 sequence, so a byte cut never
// leaves half a rune at the end of a truncated part.
func utf8StartByte(b byte) bool { return b&0xC0 != 0x80 }

// estimateDshSeedTokens prices the seed with the same rule the init-context
// report uses, so the seed row and the composed text never disagree.
func estimateDshSeedTokens(seed string) int { return (len(seed) + 3) / 4 }

// dshSessionTrigger is the text that started this run, as the seed carries
// it: the triggering comment when there is one, else the assignment handoff.
// Empty when the run was started by something neither carries — the seed then
// holds the summary alone.
func dshSessionTrigger(task Task) string {
	if text := strings.TrimSpace(task.TriggerCommentContent); text != "" {
		return text
	}
	return strings.TrimSpace(task.HandoffNote)
}

// prepareDshStoreRoot resolves the dsh session store root this task's
// sessions live in (S3-B1) and returns "" for every other provider. Split out
// of the environment block because the seeded-session decision (S3-B2) needs
// the root before the brief is written, while the environment variable that
// points the bridge at it is set later, once the env overlay exists.
func (d *Daemon) prepareDshStoreRoot(task Task, provider string, taskLog *slog.Logger) (string, error) {
	if provider != "dsh" {
		return "", nil
	}
	if d.cfg.MessageSink == "dsh" {
		taskLog.Info("dsh message sink enabled; session goes to the shared dsh store",
			"dsh_home", os.Getenv("DSH_HOME"))
		return dshSharedSessionStoreRoot(), nil
	}
	root, err := prepareDshTaskSessionRoot(d.cfg.Profile, task.RuntimeID, task.AgentID)
	if err != nil {
		return "", fmt.Errorf("prepare dsh session root: %w", err)
	}
	return root, nil
}

// readDshSummarySidecar loads the summary B1's clock wrote beside a session:
// <storeRoot>/<projectKey(cwd)>/<sessionID>/summary.json. Any failure —
// missing file, unreadable, malformed, or a sidecar naming a different
// session — reads as "no summary": a seed is never built from a guess.
func readDshSummarySidecar(storeRoot, cwd, sessionID string) (dshSessionSummaryRecord, bool) {
	if strings.TrimSpace(storeRoot) == "" || strings.TrimSpace(cwd) == "" {
		return dshSessionSummaryRecord{}, false
	}
	if !dshsession.ValidateSessionID(sessionID) {
		return dshSessionSummaryRecord{}, false
	}
	path := filepath.Join(storeRoot, dshsession.ProjectKey(cwd), sessionID, dshSummarySidecarName)
	data, err := os.ReadFile(path)
	if err != nil {
		return dshSessionSummaryRecord{}, false
	}
	var record dshSessionSummaryRecord
	if err := json.Unmarshal(data, &record); err != nil {
		return dshSessionSummaryRecord{}, false
	}
	if record.ParentSession != "" && record.ParentSession != sessionID {
		return dshSessionSummaryRecord{}, false
	}
	return record, true
}
