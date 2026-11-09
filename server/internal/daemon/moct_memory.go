package daemon

// MOCT seam wiring (M-101; the contract is docs/moct-seam.md, the client is
// server/internal/moct).
//
// Two halves, both on the daemon because the daemon is the only side that
// knows the two facts they need: this host's moct-be URL (loopback, so the
// server cannot know it) and the path of the running `multica` binary (the
// command of the stdio MCP server).
//
//  1. pre-run inject — on claim, fetch the memory block for this run's D2
//     refs and hand it to BuildPrompt, which prepends it to the task prompt.
//  2. on-demand tools — add a `moct` stdio MCP server (`multica moct-mcp`)
//     to the task's MCP config, refs passed as env so a tool call can only
//     reach this run's own scope.
//
// Failure contract, on both halves: moct-be down, unreachable, slow or
// answering 5xx degrades to a warning and a run WITHOUT memory. No error
// here is ever returned to the caller, because memory must never block a
// task. The client's own 10s timeout is the only delay a slow moct-be can
// add to a claim.

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"strings"

	"github.com/multica-ai/multica/server/internal/daemon/initctx"
	"github.com/multica-ai/multica/server/internal/moct"

)

// moctMemoryServerName is the name the `moct` MCP server gets in every task's
// MCP config. Fixed by the contract; also the name an agent will see on its
// tools. It is a bare TOML key, which Codex's config writer requires.
const moctMemoryServerName = "moct"

// moctInjectPrompt fetches and renders the pre-run memory block for task, and
// reports the memory part of the run's init-context row.
//
// Returns "" when the seam is off on this daemon, the workspace switched the
// pre-run block off (S2-C, M-123), or anything went wrong — the caller simply
// does not add the prompt option, and the task prompt is then byte-identical to
// what it was before this feature existed.
//
// The part report is returned on EVERY path, including the empty ones: a run
// with no memory is a legitimate outcome, but "no memory because the workspace
// turned it off" and "no memory because moct-be was down" are different facts
// and the run row has to say which one happened (M-140).
func moctInjectPrompt(ctx context.Context, baseURL string, task Task, logger *slog.Logger) (string, initctx.PartReport) {
	if strings.TrimSpace(baseURL) == "" {
		return "", initctx.PartReport{
			Part:     initctx.PartMemory,
			Measured: true,
			Note:     "MOCT seam is off on this daemon (no moct base URL); no memory was injected",
		}
	}
	// The switch only ever subtracts. A nil flag is a claim from a server that
	// predates it (or a workspace read that failed on the server side), and the
	// run then gets memory exactly as it did before the switch existed.
	if task.MoctMemoryInject != nil && !*task.MoctMemoryInject {
		return "", initctx.PartReport{
			Part:     initctx.PartMemory,
			Measured: true,
			Note:     "the workspace switched the pre-run memory block off (S2-C, M-123)",
		}
	}
	params, ok := moctScopeParams(task)
	if !ok {
		return "", initctx.PartReport{
			Part:     initctx.PartMemory,
			Measured: true,
			Note:     "task carries no workspace or agent identity, so there is no memory scope to read",
		}
	}
	// Cap the block at the memory part's budget instead of accepting whatever
	// moct-be's own configured inject budget happens to be: this is the number
	// the band is built from, and leaving it implicit is what let the first
	// request drift unpriced (M-140).
	params.LayerTokens = initctx.BudgetMemory
	client, err := moct.NewClient(moct.Config{BaseURL: baseURL})
	if err != nil {
		// A URL that cannot even be parsed is a configuration bug, not an
		// outage: say so loudly enough to find, then run without memory.
		if logger != nil {
			logger.Warn("moct: base URL invalid; running without memory",
				"base_url", baseURL, "error", err)
		}
		return "", initctx.PartReport{
			Part:     initctx.PartMemory,
			Measured: true,
			Note:     "this daemon's moct base URL does not parse; the run went without memory",
		}
	}
	injection, err := client.Inject(ctx, params)
	if err != nil {
		if logger != nil {
			logger.Warn("moct: pre-run inject failed; running without memory",
				"task_id", task.ID, "error", err)
		}
		return "", initctx.PartReport{
			Part:     initctx.PartMemory,
			Measured: true,
			Note:     "moct pre-run inject failed; the run went without memory",
		}
	}
	block := renderMoctInjectBlock(injection)
	return block, moctMemoryPart(block, injection)
}

// moctMemoryPart is the memory row for a run. An empty block is reported with
// the reason moct-be gave (or its silence), and a non-empty one names any
// records that were deferred so the row does not read as "this is all the
// memory there is".
func moctMemoryPart(block string, injection *moct.Injection) initctx.PartReport {
	part := initctx.PartReport{Part: initctx.PartMemory, Measured: true, Tokens: initctx.Estimate(block)}
	if injection == nil || len(injection.Entries) == 0 {
		part.Note = "moct returned no entries for this run's scope"
		return part
	}
	note := fmt.Sprintf("%d entries at moct-be's inject budget of %d tokens", len(injection.Entries), initctx.BudgetMemory)
	if injection.Omitted > 0 || len(injection.Index) > 0 {
		note += fmt.Sprintf("; %d records were deferred to the moct MCP tools", injection.Omitted)
	}
	part.Note = note
	return part
}

// moctScopeParams builds the D2 refs of one claimed task. A task with no
// workspace or agent has no identity to read memory as, so the caller skips
// the seam entirely rather than sending a ref moct-be will reject.
func moctScopeParams(task Task) (moct.InjectParams, bool) {
	if task.WorkspaceID == "" || task.AgentID == "" {
		return moct.InjectParams{}, false
	}
	params := moct.InjectParams{
		WorkspaceID: moct.WorkspaceRef(task.WorkspaceID),
		ExpertID:    moct.ExpertRef(task.AgentID),
	}
	// Both refs are optional buckets: empty means "skip it", and a task that
	// is not attached to an issue or project simply narrows to team + expert
	// memory (docs/moct-seam.md).
	if task.IssueID != "" {
		params.TaskRef = moct.IssueRef(task.IssueID)
	}
	if task.ProjectID != "" {
		params.ChannelRef = moct.ProjectRef(task.ProjectID)
	}
	return params, true
}

// moctHeadingMaxRunes bounds an entry title inside its markdown heading. A
// memory title is agent-written and may contain newlines, which would end the
// heading and let the rest of the title read as its own instruction line.
const moctHeadingMaxRunes = 200

// renderMoctInjectBlock turns inject entries into the prompt block, or "" when
// there is nothing to say — an empty block would only cost tokens and tell the
// agent that memory exists when it does not.
func renderMoctInjectBlock(injection *moct.Injection) string {
	if injection == nil || len(injection.Entries) == 0 {
		return ""
	}
	var b strings.Builder
	b.WriteString("## MOCT memory (pre-run inject)\n\n")
	for _, entry := range injection.Entries {
		fmt.Fprintf(&b, "#### [%s] %s\n\n", moctOneLine(entry.Type, 64), moctHeading(entry))
		if body := strings.TrimSpace(entry.Body); body != "" {
			b.WriteString(body)
			b.WriteString("\n\n")
		}
	}
	// Deferred records: too large or too low priority to inject. Name the way
	// out so the count is actionable rather than a shrug.
	if injection.Omitted > 0 || len(injection.Index) > 0 {
		b.WriteString("Some records did not fit above; read them with the `moct` MCP tools `memory_search` and `memory_get`.\n\n")
	}
	return b.String()
}

// moctHeading is an entry's title, single-line and bounded. The id stands in
// when a record has no title, so an entry is never an empty heading.
func moctHeading(entry moct.Entry) string {
	if title := moctOneLine(entry.Title, moctHeadingMaxRunes); title != "" {
		return title
	}
	return entry.ID
}

// moctOneLine collapses every whitespace run (newlines included) to one space
// and truncates to max runes, keeping hostile or sloppy memory text from
// breaking out of the line it was given.
func moctOneLine(s string, max int) string {
	s = strings.Join(strings.Fields(s), " ")
	if max <= 0 {
		return s
	}
	runes := []rune(s)
	if len(runes) > max {
		return string(runes[:max]) + "…"
	}
	return s
}

// moctMCPConfig builds the MCP overlay entry that gives a run the `moct`
// tools, or ok=false when the seam must stay out of this run's config: the
// seam is off, the task carries no identity, this host's moct-be URL does not
// parse, or the running multica binary cannot be located.
//
// Refs travel as ENV, never as tool arguments (docs/moct-seam.md): the tool
// schemas then cannot even express a request outside this run's scope.
func moctMCPConfig(baseURL string, task Task) (json.RawMessage, bool) {
	if strings.TrimSpace(baseURL) == "" {
		return nil, false
	}
	params, ok := moctScopeParams(task)
	if !ok {
		return nil, false
	}
	// Validate once here rather than letting a malformed URL fail the child's
	// handshake: an MCP server that cannot start takes an ACP/dsh session down
	// with it (see server/pkg/agent/acp_session.go), which would be exactly the
	// "memory blocks a task" failure the seam contract forbids.
	if _, err := moct.NewClient(moct.Config{BaseURL: baseURL}); err != nil {
		return nil, false
	}
	executable, err := resolveSelfExecutable()
	if err != nil || strings.TrimSpace(executable) == "" {
		return nil, false
	}
	env := map[string]string{
		"MOCT_BASE_URL":     strings.TrimSpace(baseURL),
		"MOCT_WORKSPACE_ID": params.WorkspaceID,
		"MOCT_EXPERT_ID":    params.ExpertID,
		// The stdio server reads the task home from here when a note does not
		// name one, so every write a run makes lands on its own issue.
		"MOCT_TASK_REF": params.TaskRef,
	}
	if params.ChannelRef != "" {
		env["MOCT_CHANNEL_REF"] = params.ChannelRef
	}
	raw, err := json.Marshal(map[string]any{"mcpServers": map[string]any{
		moctMemoryServerName: map[string]any{
			"command": strings.TrimSpace(executable),
			"args":    []string{"moct-mcp"},
			"env":     env,
		},
	}})
	if err != nil {
		// Unreachable for this shape (a map of strings), kept so the function
		// has no error return to forget at the callsite.
		return nil, false
	}
	return raw, true
}

// moctRecordUsage writes the per-task usage summary and session_ref back to
// moct-be as a decision record keyed on the D2 refs. It never blocks the
// task: a missing seam, a down moct-be or any error is logged as a warning
// and the caller continues.
func moctRecordUsage(ctx context.Context, baseURL string, task Task, sessionID string, usage []TaskUsageEntry, logger *slog.Logger) {
	if strings.TrimSpace(baseURL) == "" {
		return
	}
	if task.WorkspaceID == "" || task.AgentID == "" || task.IssueID == "" {
		return
	}
	if sessionID == "" && len(usage) == 0 {
		return
	}
	client, err := moct.NewClient(moct.Config{BaseURL: baseURL})
	if err != nil {
		if logger != nil {
			logger.Warn("moct: usage write-back skipped; bad base URL", "base_url", baseURL, "error", err)
		}
		return
	}
	// Build a stable, machine-readable usage payload.
	usagePayload := make(map[string]any, len(usage))
	var totalInput, totalOutput, totalCacheRead, totalCacheWrite int64
	for _, u := range usage {
		key := u.Model
		if u.Provider != "" {
			key = u.Provider + "/" + u.Model
		}
		if key == "" {
			key = "unknown"
		}
		usagePayload[key] = map[string]any{
			"input_tokens":       u.InputTokens,
			"output_tokens":      u.OutputTokens,
			"cache_read_tokens":  u.CacheReadTokens,
			"cache_write_tokens": u.CacheWriteTokens,
		}
		totalInput += u.InputTokens
		totalOutput += u.OutputTokens
		totalCacheRead += u.CacheReadTokens
		totalCacheWrite += u.CacheWriteTokens
	}
	var b strings.Builder
	fmt.Fprintf(&b, "session_ref: %s\n", sessionID)
	fmt.Fprintf(&b, "task_id: %s\n", task.ID)
	fmt.Fprintf(&b, "issue: %s\n", moct.IssueRef(task.IssueID))
	fmt.Fprintf(&b, "totals: input=%d output=%d cache_read=%d cache_write=%d\n", totalInput, totalOutput, totalCacheRead, totalCacheWrite)
	for _, u := range usage {
		model := u.Model
		if u.Provider != "" {
			model = u.Provider + "/" + u.Model
		}
		fmt.Fprintf(&b, "- %s: input=%d output=%d cache_read=%d cache_write=%d\n", model, u.InputTokens, u.OutputTokens, u.CacheReadTokens, u.CacheWriteTokens)
	}
	// moct-be whitelists decision attrs to decidedBy/sourceRef/date
	// (moct src/team-room/memory.ts checkAttrs) and 400s anything else, so
	// the machine-readable payload lives in the body above — attrs carry
	// only the two refs moct-be requires.
	attrs := map[string]any{
		"decidedBy": moct.ExpertRef(task.AgentID),
		"sourceRef": moct.IssueRef(task.IssueID),
	}
	params := moct.NoteParams{
		Type:        "decision",
		Title:       "Usage summary " + task.ID,
		Body:        b.String(),
		Attrs:       attrs,
		Home:        moct.Home{Kind: "task", Ref: moct.IssueRef(task.IssueID)},
		WorkspaceID: moct.WorkspaceRef(task.WorkspaceID),
		Actor:       moct.Actor{Kind: "member", ID: moct.ExpertRef(task.AgentID)},
		ConfirmNew:  true,
	}
	if _, err := client.Note(ctx, params); err != nil {
		if logger != nil {
			logger.Warn("moct: usage write-back failed", "task_id", task.ID, "error", err)
		}
	}
}
