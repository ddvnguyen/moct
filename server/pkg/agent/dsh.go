package agent

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/url"
	"os/exec"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"syscall"
	"time"
)

const (
	dshProfile = "multica"
	// DshProtocolVersion is the DSH stdio protocol this backend speaks. Exported
	// because the daemon's profile probe accepts or rejects a runtime profile on
	// this exact number, and a second copy of it there is a copy that can drift.
	DshProtocolVersion = 1
	dshCancelGrace     = 3 * time.Second
	dshTerminateGrace  = 2 * time.Second
	// dshForkReadyTimeout bounds how long a seeded run waits for the bridge's
	// ready frame before falling back to a plain resume (S3-B2/M-138). A
	// bridge emits ready before it reads anything, so the normal case is
	// milliseconds; the bound only protects a hung or ancient binary from
	// stalling the run.
	dshForkReadyTimeout = 15 * time.Second
	// dshInboxAckTimeout bounds how long a steer/queue waits for the bridge's
	// inbox_state answer. The bridge answers synchronously while dispatching
	// the command, so silence past this bound means it never took the message.
	dshInboxAckTimeout = 2 * time.Second
)

// ErrDshInboxUnconfirmed reports a steer/queue the bridge never answered with
// an inbox_state frame. The message may or may not have reached the agent, so
// the daemon settles it as failed (inbox_unconfirmed) and leaves the retry to
// the human rather than claiming a delivery nobody confirmed.
var ErrDshInboxUnconfirmed = errors.New("dsh bridge did not confirm the message with inbox_state")

// dshBackend drives the Multica DSH bundle over its versioned JSONL
// stdio protocol. The adapter is intentionally independent of ACP: DSH owns
// the agent loop, session store, model catalog, tools, and MCP clients, while
// this package only translates those events into Multica's Backend contract.
type dshBackend struct {
	cfg Config
}

type dshModelSelection struct {
	Provider        string `json:"provider"`
	ID              string `json:"id"`
	ReasoningEffort string `json:"reasoning_effort,omitempty"`
}

type dshMCPServer struct {
	Name              string            `json:"name"`
	Transport         string            `json:"transport"`
	Command           string            `json:"command,omitempty"`
	Args              []string          `json:"args,omitempty"`
	Env               map[string]string `json:"env,omitempty"`
	Cwd               string            `json:"cwd,omitempty"`
	URL               string            `json:"url,omitempty"`
	Headers           map[string]string `json:"headers,omitempty"`
	ToolCallTimeoutMS int               `json:"tool_call_timeout_ms,omitempty"`
}

type dshExecuteCommand struct {
	Version         int    `json:"v"`
	Type            string `json:"type"`
	RequestID       string `json:"request_id"`
	Cwd             string `json:"cwd"`
	Prompt          string `json:"prompt"`
	ResumeSessionID string `json:"resume_session_id,omitempty"`
	// ForkParent and Seed are the S3-B2 seeded start. Both are additive at
	// protocol v1 and sent only after the bridge advertises `fork` on its ready
	// frame; a bridge that does not gets the plain resume above instead.
	ForkParent      string             `json:"fork_parent,omitempty"`
	Seed            string             `json:"seed,omitempty"`
	Model           *dshModelSelection `json:"model,omitempty"`
	ReasoningEffort string             `json:"reasoning_effort,omitempty"`
	MCPServers      []dshMCPServer     `json:"mcp_servers"`
}

// dshDegradeForkToResume turns a seeded start into the plain resume every
// pre-S3-B2 run sent: the parent becomes the session to continue and the seed
// is dropped. Used wherever the fork cannot be gated on a ready frame.
func dshDegradeForkToResume(command *dshExecuteCommand) {
	command.ResumeSessionID = command.ForkParent
	command.ForkParent, command.Seed = "", ""
}

type dshCancelCommand struct {
	Version   int    `json:"v"`
	Type      string `json:"type"`
	RequestID string `json:"request_id"`
}

type dshSteerCommand struct {
	Version   int    `json:"v"`
	Type      string `json:"type"`
	RequestID string `json:"request_id"`
	Message   string `json:"message"`
}

type dshQueueCommand struct {
	Version   int    `json:"v"`
	Type      string `json:"type"`
	RequestID string `json:"request_id"`
	Message   string `json:"message"`
}

// dshSummarizeCommand asks the bridge to compact one idle session with dsh's
// own compaction seam and return the summary (S3-B1). It is a FIRST command —
// an alternative to `execute` on a fresh stdio process — because the session's
// run has already ended and its process with it; the daemon's per-session
// cache clock invokes this only when it fires. Additive at protocol v1: a
// bridge that predates it never advertises the `summarize` capability, and the
// daemon never sends the command without it.
type dshSummarizeCommand struct {
	Version   int                `json:"v"`
	Type      string             `json:"type"`
	RequestID string             `json:"request_id"`
	SessionID string             `json:"session_id"`
	Model     *dshModelSelection `json:"model,omitempty"`
	// MaxTokens asks the bridge to reject a summary above this size. Sent only
	// to a bridge that advertised `summarize_max_tokens`: its strict command
	// parser rejects fields it does not know.
	MaxTokens int64 `json:"max_tokens,omitempty"`
}

type dshWireError struct {
	Code    string `json:"code"`
	Message string `json:"message"`
}

// dshQuestionOption is one selectable answer offered by an ask/plan question.
type dshQuestionOption struct {
	Label       string `json:"label"`
	Description string `json:"description,omitempty"`
}

// dshQuestionIntent is the plan-review presentation intent the bridge passes
// through from dsh's user-questions seam: a question tagged `plan-review` IS
// a plan submission, `Approve` names the option that approves it, and the
// question's detail carries the plan markdown (M-109).
type dshQuestionIntent struct {
	Kind    string `json:"kind"`
	Approve string `json:"approve,omitempty"`
	CallID  string `json:"callId,omitempty"`
}

// dshQuestion is one question of an outbound `question` frame — the wire
// shape mirrors dsh's AskUserQuestionItem (deepseek-harness
// packages/interaction/user-questions).
type dshQuestion struct {
	ID          string              `json:"id"`
	Question    string              `json:"question"`
	Detail      string              `json:"detail,omitempty"`
	Header      string              `json:"header,omitempty"`
	Options     []dshQuestionOption `json:"options,omitempty"`
	MultiSelect bool                `json:"multiSelect,omitempty"`
	Intent      *dshQuestionIntent  `json:"intent,omitempty"`
}

// dshCapabilitiesFrame is the capability advertisement on the bridge's
// `ready` frame. Only `questions` is read today; the rest of the bridge's
// advertisement (resume, cancel, models, …) is implicit in protocol v1.
type dshCapabilitiesFrame struct {
	Questions bool `json:"questions,omitempty"`
	Steer     bool `json:"steer,omitempty"`
	Queue     bool `json:"queue,omitempty"`
	Summarize bool `json:"summarize,omitempty"`
	// SummarizeMaxTokens advertises summarize.max_tokens: the bridge enforces
	// the budget and answers DSH_SUMMARY_OVER_CAP instead of a summary.
	SummarizeMaxTokens bool `json:"summarize_max_tokens,omitempty"`
	// Fork advertises execute.fork_parent + seed (S3-B2/M-138). Absent on
	// every bridge that predates it, which keeps the daemon on the resume path.
	Fork bool `json:"fork,omitempty"`
}

// dshAnswerItem is one question's answer in an outbound `answer` command.
// `Selected` carries chosen option labels; `Custom` carries free text (the
// human's own words when they did not pick an offered option).
type dshAnswerItem struct {
	ID       string   `json:"id"`
	Selected []string `json:"selected"`
	Custom   string   `json:"custom,omitempty"`
}

// dshAnswerCommand is the daemon→bridge reply that resolves a parked ask.
// Additive at protocol v1: a bridge that predates it never emits `question`,
// so this is only ever written after the bridge advertised `questions`.
type dshAnswerCommand struct {
	Version   int             `json:"v"`
	Type      string          `json:"type"`
	RequestID string          `json:"request_id"`
	CallID    string          `json:"call_id"`
	Answers   []dshAnswerItem `json:"answers"`
}

type dshFrame struct {
	Version          int                   `json:"v"`
	Type             string                `json:"type"`
	Runtime          string                `json:"runtime,omitempty"`
	ProtocolVersion  int                   `json:"protocol_version,omitempty"`
	RequestID        string                `json:"request_id,omitempty"`
	SessionID        string                `json:"session_id,omitempty"`
	Resumed          bool                  `json:"resumed,omitempty"`
	Content          string                `json:"content,omitempty"`
	Summary          string                `json:"summary,omitempty"`
	SummaryTokens    int64                 `json:"summary_tokens,omitempty"`
	CallID           string                `json:"call_id,omitempty"`
	Name             string                `json:"name,omitempty"`
	Arguments        string                `json:"arguments,omitempty"`
	Output           string                `json:"output,omitempty"`
	IsError          bool                  `json:"is_error,omitempty"`
	Provider         string                `json:"provider,omitempty"`
	Model            string                `json:"model,omitempty"`
	InputTokens      int64                 `json:"input_tokens,omitempty"`
	OutputTokens     int64                 `json:"output_tokens,omitempty"`
	CacheReadTokens  int64                 `json:"cache_read_tokens,omitempty"`
	CacheWriteTokens int64                 `json:"cache_write_tokens,omitempty"`
	Status           string                `json:"status,omitempty"`
	StopReason       string                `json:"stop_reason,omitempty"`
	ResumeRejected   bool                  `json:"resume_rejected,omitempty"`
	Error            *dshWireError         `json:"error,omitempty"`
	Code             string                `json:"code,omitempty"`
	Message          string                `json:"message,omitempty"`
	Models           []dshModelFrame       `json:"models,omitempty"`
	Questions        []dshQuestion         `json:"questions,omitempty"`
	Capabilities     *dshCapabilitiesFrame `json:"capabilities,omitempty"`
	State            string                `json:"state,omitempty"`
	Command          string                `json:"command,omitempty"`
	Reason           string                `json:"reason,omitempty"`
}

type dshThinkingFrame struct {
	SupportedLevels []ThinkingLevel `json:"supported_levels"`
	DefaultLevel    string          `json:"default_level,omitempty"`
}

type dshModelFrame struct {
	ID       string            `json:"id"`
	Label    string            `json:"label"`
	Provider string            `json:"provider,omitempty"`
	Default  bool              `json:"default,omitempty"`
	Thinking *dshThinkingFrame `json:"thinking,omitempty"`
}

func dshLaunchArgs() []string {
	return []string{"--profile", dshProfile, "--stdio"}
}

func parseDshModelID(value string) (*dshModelSelection, error) {
	value = strings.TrimSpace(value)
	if value == "" {
		return nil, nil
	}
	providerPart, modelPart, ok := strings.Cut(value, "/")
	if !ok || providerPart == "" || modelPart == "" {
		return nil, fmt.Errorf("dsh model must use the provider/model ID advertised by DSH")
	}
	provider, err := url.PathUnescape(providerPart)
	if err != nil {
		return nil, fmt.Errorf("decode dsh model provider: %w", err)
	}
	if strings.TrimSpace(provider) == "" {
		return nil, errors.New("dsh model provider is empty")
	}
	model, err := url.PathUnescape(modelPart)
	if err != nil {
		return nil, fmt.Errorf("decode dsh model ID: %w", err)
	}
	if strings.TrimSpace(model) == "" {
		return nil, errors.New("dsh model ID is empty")
	}
	return &dshModelSelection{Provider: provider, ID: model}, nil
}

func buildDshMCPServers(raw json.RawMessage, logger interface {
	Warn(string, ...any)
}) ([]dshMCPServer, error) {
	servers, err := buildACPMcpServers(raw, nil)
	if err != nil {
		return nil, err
	}
	out := make([]dshMCPServer, 0, len(servers))
	for _, rawServer := range servers {
		server, ok := rawServer.(map[string]any)
		if !ok {
			continue
		}
		name, _ := server["name"].(string)
		if command, _ := server["command"].(string); command != "" {
			entry := dshMCPServer{Name: name, Transport: "stdio", Command: command, Args: []string{}, Env: map[string]string{}}
			if args, ok := server["args"].([]string); ok {
				entry.Args = args
			}
			if pairs, ok := server["env"].([]map[string]any); ok {
				for _, pair := range pairs {
					key, _ := pair["name"].(string)
					value, _ := pair["value"].(string)
					if key != "" {
						entry.Env[key] = value
					}
				}
			}
			out = append(out, entry)
			continue
		}

		transport, _ := server["type"].(string)
		if transport == "sse" {
			return nil, fmt.Errorf("dsh MCP server %q uses SSE, but the DSH runtime supports stdio and streamable HTTP only", name)
		}
		remoteURL, _ := server["url"].(string)
		if remoteURL == "" {
			if logger != nil {
				logger.Warn("skipping invalid DSH MCP server", "name", name)
			}
			continue
		}
		entry := dshMCPServer{Name: name, Transport: "streamable-http", URL: remoteURL, Headers: map[string]string{}}
		if pairs, ok := server["headers"].([]map[string]any); ok {
			for _, pair := range pairs {
				key, _ := pair["name"].(string)
				value, _ := pair["value"].(string)
				if key != "" {
					entry.Headers[key] = value
				}
			}
		}
		out = append(out, entry)
	}
	return out, nil
}

func (b *dshBackend) Execute(ctx context.Context, prompt string, opts ExecOptions) (*Session, error) {
	execPath := b.cfg.ExecutablePath
	if execPath == "" {
		execPath = "dsh"
	}
	if _, err := exec.LookPath(execPath); err != nil {
		return nil, fmt.Errorf("dsh executable not found at %q: %w", execPath, err)
	}
	model, err := parseDshModelID(opts.Model)
	if err != nil {
		return nil, err
	}
	mcpServers, err := buildDshMCPServers(opts.McpConfig, b.cfg.Logger)
	if err != nil {
		return nil, fmt.Errorf("dsh: invalid mcp_config: %w", err)
	}

	runCtx, cancel := runContext(ctx, opts.Timeout)
	args := dshLaunchArgs()

	// S3-C (M-139): a detached run binds no daemon pipe — the pipes die with
	// the daemon and would SIGPIPE a surviving child. See dsh_detached.go. Off
	// by default; a host without systemd-run falls back to the direct launch.
	var detached *dshDetachedRun
	if DshDetachedAvailable() {
		plan, planErr := prepareDshDetachedRun(opts.Cwd, b.cfg.TaskID)
		if planErr != nil {
			cancel()
			return nil, fmt.Errorf("prepare detached dsh run: %w", planErr)
		}
		detached = plan
		defer detached.Close()
	}

	requestID := b.cfg.TaskID
	if requestID == "" {
		requestID = "multica-" + strconv.FormatInt(time.Now().UnixNano(), 10)
	}
	state := dshRunState{usage: make(map[string]TokenUsage), requestID: requestID, inboxStateCh: make(chan dshInboxState, 1), readyCh: make(chan struct{})}
	command := dshExecuteCommand{
		Version: DshProtocolVersion, Type: "execute", RequestID: requestID,
		Cwd: opts.Cwd, Prompt: prompt, ResumeSessionID: opts.ResumeSessionID,
		ForkParent: opts.ForkParent, Seed: opts.Seed,
		Model: model, ReasoningEffort: opts.ThinkingLevel, MCPServers: mcpServers,
	}
	if command.ForkParent != "" && detached != nil {
		// A detached run's command is written before the process starts (its
		// stdin is a file, not a pipe), so the ready frame cannot gate it. Fall
		// back to the resume the fork would have replaced: S3-C's detached mode
		// and S3-B2's seeded start do not combine, and a resume is what every
		// pre-S3-B2 run got anyway.
		b.cfg.Logger.Info("dsh detached run cannot gate a fork on the ready frame; resuming the candidate session",
			"session_id", command.ForkParent)
		dshDegradeForkToResume(&command)
	}
	// Read by the frame reader to tell the forked child's session frame from
	// the parent's; written once, before the reader goroutine starts.
	state.forkParent = command.ForkParent

	var (
		cmd        *exec.Cmd
		stdout     io.ReadCloser
		stdin      io.WriteCloser
		stderrTail func() string
		tailDone   chan struct{}
	)
	if detached != nil {
		b.cfg.Logger.Info("dsh launching in detached systemd scope", "unit", detached.unit, "dir", detached.dir)
		cmd = b.cfg.commandAt("systemd-run").exec(runCtx, detached.argv(execPath, args)...)
		stdinReader, openErr := detached.stdinReader()
		if openErr != nil {
			cancel()
			return nil, openErr
		}
		cmd.Stdin = stdinReader
		cmd.Stdout = detached.stdoutFile
		cmd.Stderr = detached.stderrFile
		if writeErr := detached.writeExecuteFrame(command); writeErr != nil {
			cancel()
			return nil, writeErr
		}
		tailDone = make(chan struct{})
		stdout = detached.stdoutReader(tailDone)
		stderrTail = detached.stderrTail
	} else {
		cmd = b.cfg.commandAt(execPath).exec(runCtx, args...)
	}
	hideAgentWindow(cmd)
	cmd.Cancel = func() error { return nil }
	cmd.WaitDelay = 10 * time.Second
	if opts.Cwd != "" {
		cmd.Dir = opts.Cwd
	}
	cmd.Env = buildEnv(b.cfg.Env)
	if b.cfg.TaskID != "" {
		cmd.Env = append(cmd.Env, "DSH_SESSION_OWNER=Multica run "+b.cfg.TaskID)
	}
	if detached != nil {
		// The wrapper records the exit status here; a daemon that restarts can
		// read it even though it never saw Wait return.
		cmd.Env = append(cmd.Env, "MULTICA_DETACHED_EXIT="+detached.exitPath)
	} else {
		stdout, err = cmd.StdoutPipe()
		if err != nil {
			cancel()
			return nil, fmt.Errorf("dsh stdout pipe: %w", err)
		}
		stdin, err = cmd.StdinPipe()
		if err != nil {
			cancel()
			return nil, fmt.Errorf("dsh stdin pipe: %w", err)
		}
		stderrBuf := newStderrTail(newLogWriter(b.cfg.Logger, "[dsh:stderr] "), agentStderrTailBytes)
		cmd.Stderr = stderrBuf
		stderrTail = stderrBuf.Tail
	}
	if err := startOwnedProcessTree(cmd, b.cfg.Logger); err != nil {
		cancel()
		return nil, fmt.Errorf("start dsh: %w", err)
	}
	if detached != nil {
		if opts.DetachedStarted != nil {
			opts.DetachedStarted()
		}
		// The child now holds its own descriptor on the frame file.
		detached.releaseStdin(b.cfg.Logger)
	}

	var writeFrame func(any) error
	if detached != nil {
		// stdin was the pre-written execute frame. A detached run takes no
		// further input: live re-attach across restarts is out of scope (S3-C).
		writeFrame = func(any) error { return errDshDetachedNoInput }
	} else {
		var writeMu sync.Mutex
		encoder := json.NewEncoder(stdin)
		writeFrame = func(value any) error {
			writeMu.Lock()
			defer writeMu.Unlock()
			return encoder.Encode(value)
		}
		// A fork command is deliberately NOT written here: it waits for the
		// ready frame below so a bridge without the capability never sees it.
		if command.ForkParent == "" {
			if err := writeFrame(command); err != nil {
				signalProcessGroup(cmd, syscall.SIGKILL)
				_ = cmd.Wait()
				releaseProcessGroup(cmd)
				cancel()
				return nil, fmt.Errorf("send dsh execute command: %w", err)
			}
		}
	}
	state.writeAnswer = func(command dshAnswerCommand) error { return writeFrame(command) }
	state.writeCommand = writeFrame

	b.cfg.Logger.Info("dsh started", "pid", cmd.Process.Pid, "cwd", opts.Cwd, "model", opts.Model)
	msgCh := make(chan Message, 256)
	resCh := make(chan Result, 1)
	procDone := make(chan struct{})

	go func() {
		select {
		case <-procDone:
			return
		case <-runCtx.Done():
		}
		if detached != nil && opts.PreserveDetached != nil && opts.PreserveDetached() {
			return
		}
		_ = writeFrame(dshCancelCommand{Version: DshProtocolVersion, Type: "cancel", RequestID: requestID})
		timer := time.NewTimer(dshCancelGrace)
		defer timer.Stop()
		select {
		case <-procDone:
			return
		case <-timer.C:
		}
		if detached != nil {
			// The scoped child is not in this process group, so systemd owns
			// the only signal that reaches it.
			detached.stopScope(b.cfg.Logger)
		}
		signalProcessGroup(cmd, syscall.SIGTERM)
		if !waitProcessGroupGone(cmd, dshTerminateGrace) {
			signalProcessGroup(cmd, syscall.SIGKILL)
		}
		_ = stdout.Close()
	}()

	go func() {
		defer cancel()
		defer close(msgCh)
		defer close(resCh)
		if stdin != nil {
			defer func() { _ = stdin.Close() }()
		}
		started := time.Now()
		var waitCh chan error
		if detached != nil {
			// The scanner can only finish once the tail reader is told the
			// process exited, so Wait has to run alongside it rather than after.
			waitCh = make(chan error, 1)
			go func() {
				waitErr := cmd.Wait()
				close(tailDone)
				waitCh <- waitErr
			}()
		}
		scanner := newAgentStreamScanner(stdout)
		for scanner.Scan() {
			line := strings.TrimSpace(scanner.Text())
			if line == "" {
				continue
			}
			var frame dshFrame
			if err := json.Unmarshal([]byte(line), &frame); err != nil {
				state.invalidFrames++
				continue
			}
			state.frameCount++
			if frame.Type == "session" && frame.Resumed && state.forkRequested.Load() {
				// S3-B2: the bridge refused the seed and resumed the parent. The
				// result must not claim a fork, or the run row would say "seeded"
				// for a conversation that was never seeded.
				b.cfg.Logger.Info("dsh bridge resumed the candidate session instead of forking it",
					"session_id", frame.SessionID)
			}
			handleDshFrame(frame, requestID, msgCh, &state)
		}
		scanErr := scanner.Err()
		if scanErr != nil {
			_ = stdout.Close()
		}
		var exitErr error
		if waitCh != nil {
			exitErr = <-waitCh
		} else {
			exitErr = cmd.Wait()
		}
		close(procDone)
		releaseProcessGroup(cmd)

		result := state.result
		if result == nil {
			result = &Result{Status: "failed", SessionID: state.sessionID, Usage: state.usage,
				FirstPromptTokens: state.firstPromptTokens, LastPromptTokens: state.lastPromptTokens}
			switch {
			case errors.Is(runCtx.Err(), context.DeadlineExceeded):
				result.Status = "timeout"
				result.Error = fmt.Sprintf("dsh timed out after %s", opts.Timeout)
			case errors.Is(runCtx.Err(), context.Canceled):
				result.Status = "cancelled"
				result.Error = "dsh execution cancelled"
			case scanErr != nil:
				result.Error = fmt.Sprintf("read dsh event stream: %v", scanErr)
			case state.protocolError != "":
				result.Error = state.protocolError
			case !state.ready:
				result.Error = "dsh exited before the runtime protocol became ready"
			case exitErr != nil:
				result.Error = fmt.Sprintf("dsh exited with error: %v", exitErr)
			default:
				result.Error = "dsh exited without a terminal result"
			}
		}
		if result.Error != "" {
			result.Error = withAgentStderr(result.Error, "dsh", stderrTail())
		}
		result.DshForkUsed = state.forkUsed.Load()
		result.DurationMs = time.Since(started).Milliseconds()
		b.cfg.Logger.Info("dsh finished", "pid", cmd.Process.Pid, "status", result.Status,
			"duration", time.Since(started).Round(time.Millisecond).String(), "frames", state.frameCount,
			"invalid_frames", state.invalidFrames)
		resCh <- *result
	}()

	// S3-B2 (M-138): the seeded start is capability-gated on the ready frame.
	// Waiting here rather than before the reader started is what lets an old
	// bridge keep working: it answers ready without `fork`, and the command
	// that goes out is the plain resume every pre-S3-B2 run sent.
	if command.ForkParent != "" {
		select {
		case <-state.readyCh:
		case <-time.After(dshForkReadyTimeout):
			b.cfg.Logger.Warn("dsh ready frame did not arrive before the fork gate timed out; resuming instead",
				"session_id", command.ForkParent, "timeout", dshForkReadyTimeout.String())
		case <-runCtx.Done():
		}
		if state.forkAdvertised() {
			// Only the request: forkUsed waits for the child's session frame.
			state.forkRequested.Store(true)
			b.cfg.Logger.Info("dsh forking a seeded session",
				"parent_session", command.ForkParent, "seed_bytes", len(command.Seed))
		} else {
			b.cfg.Logger.Info("dsh bridge does not advertise fork; resuming the candidate session instead",
				"session_id", command.ForkParent)
			dshDegradeForkToResume(&command)
		}
		if err := writeFrame(command); err != nil {
			// The reader goroutine owns Wait from here on; kill the group and
			// let it observe the exit so the process is still reaped.
			signalProcessGroup(cmd, syscall.SIGKILL)
			cancel()
			return nil, fmt.Errorf("send dsh execute command: %w", err)
		}
	}

	return &Session{
		Messages: msgCh,
		Result:   resCh,
		// Ask/plan parity (M-109) + steer/queue (M-135): the daemon's
		// supplement loop delivers the human's reply here. A parked question
		// is answered; otherwise the message is steered (next step) or queued
		// (next turn) per the supplement's mode. SupplementReady is true once
		// the bridge confirmed the agent session.
		Supplement: func(ctx context.Context, instruction string, mode string) error {
			return dshSupplement(&state, instruction, mode, ctx)
		},
		SupplementReady: state.live.Load,
	}, nil
}

type dshRunState struct {
	ready         bool
	sessionID     string
	protocolError string
	frameCount    int
	invalidFrames int
	usage         map[string]TokenUsage
	// S3-B1 (M-137): first/last model-request prompt sizes in frame order
	// (input + cache read + cache write). Set by the usage case in
	// handleDshFrame from the bridge's per-request frames; exposed on the
	// Result for the daemon's summary clock.
	usageSeen         bool
	firstPromptTokens int64
	lastPromptTokens  int64
	result            *Result

	// Ask/plan parity state (M-109). The frame handler (scanner goroutine)
	// writes it; Session.Supplement reads and clears it from the daemon's
	// supplement goroutine, hence the mutex. `live` is set once the bridge
	// reports the agent session and backs SupplementReady.
	mu               sync.Mutex
	requestID        string
	questionsCapable bool
	steerCapable     bool
	queueCapable     bool
	pendingCallID    string
	pendingQuestions []dshQuestion
	writeAnswer      func(dshAnswerCommand) error
	writeCommand     func(any) error
	live             atomic.Bool
	// inbox_state correlation (M-134 amendment). A buffered channel carries the
	// most recent matching frame; pendingInbox names the command currently
	// awaiting an ack so stale frames are ignored.
	inboxStateCh   chan dshInboxState
	pendingInbox   string
	inboxStartedAt time.Time

	// S3-B2 (M-138): the ready frame gates the seeded start. readyCh is closed
	// the first time `ready` arrives so Execute can send a fork command only
	// after the capability is known; forkCapable carries that capability.
	// forkRequested records that the fork command went out; forkUsed is set
	// only once the bridge reports a session other than forkParent, so a fork
	// that fails before any session frame never claims a seed.
	readyCh       chan struct{}
	readyClosed   bool
	forkCapable   bool
	forkParent    string
	forkRequested atomic.Bool
	forkSettled   bool
	forkUsed      atomic.Bool
}

// forkAdvertised reports whether the ready frame advertised execute.fork_parent.
func (s *dshRunState) forkAdvertised() bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.forkCapable
}

type dshInboxState struct {
	Command string
	State   string
	Reason  string
}

func handleDshFrame(frame dshFrame, requestID string, ch chan<- Message, state *dshRunState) {
	if frame.Version != DshProtocolVersion {
		state.protocolError = fmt.Sprintf("dsh returned unsupported protocol version %d", frame.Version)
		return
	}
	if frame.RequestID != "" && frame.RequestID != requestID {
		return
	}
	switch frame.Type {
	case "ready":
		state.ready = frame.Runtime == "dsh"
		state.mu.Lock()
		if frame.Capabilities != nil {
			state.questionsCapable = frame.Capabilities.Questions
			state.steerCapable = frame.Capabilities.Steer
			state.queueCapable = frame.Capabilities.Queue
			state.forkCapable = frame.Capabilities.Fork
		} else {
			state.questionsCapable = false
			state.steerCapable = false
			state.queueCapable = false
			state.forkCapable = false
		}
		if state.readyCh != nil && !state.readyClosed {
			state.readyClosed = true
			close(state.readyCh)
		}
		state.mu.Unlock()
	case "inbox_state":
		state.mu.Lock()
		pending := state.pendingInbox
		started := state.inboxStartedAt
		ch := state.inboxStateCh
		state.mu.Unlock()
		if pending != "" && ch != nil && frame.Command == pending && !time.Now().Before(started) {
			select {
			case ch <- dshInboxState{Command: frame.Command, State: frame.State, Reason: frame.Reason}:
			default:
			}
		}
	case "session":
		state.sessionID = frame.SessionID
		state.live.Store(true)
		// S3-B2: the first session frame after a fork request settles it. A
		// new id that is not the parent's is the forked child; `resumed: true`
		// or the parent's own id means the bridge refused the seed and resumed
		// the parent, so the run row says "resumed warm", never "seeded".
		if state.forkRequested.Load() && !state.forkSettled {
			state.forkSettled = true
			state.forkUsed.Store(!frame.Resumed && frame.SessionID != "" && frame.SessionID != state.forkParent)
		}
		trySend(ch, Message{Type: MessageStatus, Status: "running", SessionID: frame.SessionID})
	case "text":
		if frame.Content != "" {
			trySend(ch, Message{Type: MessageText, Content: frame.Content})
		}
	case "thinking":
		if frame.Content != "" {
			trySend(ch, Message{Type: MessageThinking, Content: frame.Content})
		}
	case "tool_call":
		input := map[string]any{}
		if frame.Arguments != "" && json.Unmarshal([]byte(frame.Arguments), &input) != nil {
			input = map[string]any{"raw": frame.Arguments}
		}
		trySend(ch, Message{Type: MessageToolUse, Tool: frame.Name, CallID: frame.CallID, Input: input})
	case "tool_result":
		trySend(ch, Message{Type: MessageToolResult, Tool: frame.Name, CallID: frame.CallID, Output: frame.Output})
	case "question":
		// Ask/plan parity (M-109): the bridge parked the run on a user
		// question (ask_user_question, or exit_plan_mode's plan review).
		// Record it so Supplement can correlate the human's answer, and
		// surface the rendered questions on the transcript.
		if len(frame.Questions) == 0 {
			break
		}
		callID := frame.CallID
		if callID == "" {
			callID = "question-" + strconv.Itoa(state.frameCount)
		}
		state.mu.Lock()
		state.pendingCallID = callID
		state.pendingQuestions = append([]dshQuestion(nil), frame.Questions...)
		state.mu.Unlock()
		trySend(ch, Message{
			Type:    MessageQuestion,
			CallID:  callID,
			Content: renderDshQuestions(frame.Questions),
			Input:   dshQuestionInput(frame.Questions),
		})
	case "usage":
		key := frame.Model
		if frame.Provider != "" {
			key = frame.Provider + "/" + frame.Model
		}
		if key != "" {
			usage := state.usage[key]
			usage.InputTokens += frame.InputTokens
			usage.OutputTokens += frame.OutputTokens
			usage.CacheReadTokens += frame.CacheReadTokens
			usage.CacheWriteTokens += frame.CacheWriteTokens
			state.usage[key] = usage
		}
		// S3-B1 (M-137): the bridge emits one usage frame per model request
		// (per assistant message), so frame order gives the run's first and
		// last request prompt sizes. The usage map above accumulates billed
		// volume per model — the wrong measure for the summary clock's
		// trigger, which is conversation growth, not billed tokens.
		promptTokens := frame.InputTokens + frame.CacheReadTokens + frame.CacheWriteTokens
		if !state.usageSeen {
			state.usageSeen = true
			state.firstPromptTokens = promptTokens
		}
		state.lastPromptTokens = promptTokens
	case "protocol_error":
		state.protocolError = strings.TrimSpace(frame.Code + ": " + frame.Message)
	case "result":
		errorText := ""
		if frame.Error != nil {
			errorText = strings.TrimSpace(frame.Error.Code + ": " + frame.Error.Message)
		}
		state.result = &Result{
			Status: frame.Status, Output: frame.Output, Error: errorText,
			SessionID: frame.SessionID, Usage: state.usage, ResumeRejected: frame.ResumeRejected,
			FirstPromptTokens: state.firstPromptTokens, LastPromptTokens: state.lastPromptTokens,
		}
		if state.result.SessionID == "" {
			state.result.SessionID = state.sessionID
		}
	}
}

// dshQuestionInput is the structured half of a question row: the same list the
// bridge sent, in a shape a client can build a form from.
//
// The row carries both halves and needs them both. `content` stays the human
// rendering, so a client that does not know this payload — or a mirror that
// stores nothing but text — still shows the member the question and its
// options. `input.questions` is what lets the fork's Inbox render the ask as
// the card the member answers in place instead of retyping a reply. Lives
// under the same `input` key tool calls use, so the transcript row needs no new
// column.
//
// Keys are snake_case (multi_select) to match the server-side JSON conventions
// the client parses; the bridge's camelCase is flattened here, at the one
// boundary that owns the translation.
func dshQuestionInput(questions []dshQuestion) map[string]any {
	list := make([]any, 0, len(questions))
	for _, question := range questions {
		options := make([]any, 0, len(question.Options))
		for _, option := range question.Options {
			entry := map[string]any{"label": option.Label}
			if option.Description != "" {
				entry["description"] = option.Description
			}
			options = append(options, entry)
		}
		item := map[string]any{
			"id":       question.ID,
			"question": question.Question,
			"options":  options,
		}
		if question.Header != "" {
			item["header"] = question.Header
		}
		if question.Detail != "" {
			item["detail"] = question.Detail
		}
		if question.MultiSelect {
			item["multi_select"] = true
		}
		if question.Intent != nil {
			intent := map[string]any{"kind": question.Intent.Kind}
			if question.Intent.Approve != "" {
				intent["approve"] = question.Intent.Approve
			}
			item["intent"] = intent
		}
		list = append(list, item)
	}
	return map[string]any{"questions": list}
}

// renderDshQuestions renders parked questions for the transcript line the
// daemon posts — the member answers by commenting on the issue addressed to
// the agent, and the daemon steers that reply back through Supplement.
func renderDshQuestions(questions []dshQuestion) string {
	var b strings.Builder
	b.WriteString("❓ The agent needs your answer — reply to this issue mentioning the agent.\n")
	for i, question := range questions {
		fmt.Fprintf(&b, "\n**Q%d**", i+1)
		if header := strings.TrimSpace(question.Header); header != "" {
			fmt.Fprintf(&b, " (%s)", header)
		}
		fmt.Fprintf(&b, ": %s\n", strings.TrimSpace(question.Question))
		if detail := strings.TrimSpace(question.Detail); detail != "" {
			b.WriteString(detail)
			b.WriteByte('\n')
		}
		for _, option := range question.Options {
			if description := strings.TrimSpace(option.Description); description != "" {
				fmt.Fprintf(&b, "- %s — %s\n", option.Label, description)
			} else {
				fmt.Fprintf(&b, "- %s\n", option.Label)
			}
		}
		if intent := question.Intent; intent != nil && intent.Kind == "plan-review" && intent.Approve != "" {
			fmt.Fprintf(&b, "📋 Plan review — reply *%s* to approve the plan above, or reply with your feedback to keep planning.\n", intent.Approve)
		}
	}
	return strings.TrimRight(b.String(), "\n")
}

// dshSupplementMessageMarkers precede the author's own words in the framed
// instruction formatTaskSupplementInstruction builds: one per author kind. The
// framing exists for ordinary steering; an answer must carry the author's
// words, not the frame.
var dshSupplementMessageMarkers = []string{"Human message:\n", "Agent message:\n"}

func dshSupplementContent(instruction string) string {
	// The frame's own marker comes first; a marker inside the author's words must not win.
	cut, markerLen := -1, 0
	for _, marker := range dshSupplementMessageMarkers {
		if i := strings.Index(instruction, marker); i >= 0 && (cut < 0 || i < cut) {
			cut, markerLen = i, len(marker)
		}
	}
	if cut < 0 {
		return strings.TrimSpace(instruction)
	}
	return strings.TrimSpace(instruction[cut+markerLen:])
}

// dshSupplement delivers a human message to the bridge as an answer (when a
// question is parked), a steer (next step) or a queue (next turn), per mode.
func dshSupplement(state *dshRunState, instruction, mode string, ctx context.Context) error {
	if mode == "" {
		mode = "steer"
	}
	state.mu.Lock()
	if state.pendingCallID != "" {
		state.mu.Unlock()
		return answerDshQuestion(state, instruction)
	}
	var capable bool
	if mode == "queue" {
		capable = state.queueCapable
	} else {
		mode = "steer"
		capable = state.steerCapable
	}
	if !capable {
		questionsCapable := state.questionsCapable
		state.mu.Unlock()
		return dshSupplementUnsupported(mode, questionsCapable)
	}
	state.inboxStartedAt = time.Now()
	// Drain stale frames from any previous command.
	for len(state.inboxStateCh) > 0 {
		<-state.inboxStateCh
	}
	state.pendingInbox = mode
	state.mu.Unlock()

	content := dshSupplementContent(instruction)
	var cmd any
	if mode == "queue" {
		cmd = dshQueueCommand{Version: DshProtocolVersion, Type: "queue", RequestID: state.requestID, Message: content}
	} else {
		cmd = dshSteerCommand{Version: DshProtocolVersion, Type: "steer", RequestID: state.requestID, Message: content}
	}
	if state.writeCommand == nil {
		state.mu.Lock()
		state.pendingInbox = ""
		state.mu.Unlock()
		return errors.New("dsh command writer is unavailable")
	}
	if err := state.writeCommand(cmd); err != nil {
		state.mu.Lock()
		state.pendingInbox = ""
		state.mu.Unlock()
		return err
	}
	err := waitForDshInboxState(state, mode, ctx)
	state.mu.Lock()
	state.pendingInbox = ""
	state.mu.Unlock()
	return err
}

// dshSupplementUnsupported names the capability the bridge is missing for a
// steer/queue that found no parked question to answer instead.
func dshSupplementUnsupported(mode string, questionsCapable bool) error {
	if !questionsCapable {
		return fmt.Errorf("dsh runtime bridge cannot take a %s: its ready frame advertises neither `%s` nor `questions`", mode, mode)
	}
	return fmt.Errorf("dsh runtime bridge cannot take a %s: its ready frame does not advertise `%s`, and no question is pending to answer instead", mode, mode)
}

// waitForDshInboxState waits for the bridge's answer to one steer/queue.
// `accepted` (or `applied`, if it arrives first) means the bridge took the
// message: delivered. `rejected` is a failure carrying the bridge's reason.
// No answer within dshInboxAckTimeout is ErrDshInboxUnconfirmed, never a
// silent success; `applied` is not awaited.
func waitForDshInboxState(state *dshRunState, command string, ctx context.Context) error {
	state.mu.Lock()
	ch := state.inboxStateCh
	state.mu.Unlock()
	if ch == nil {
		return ErrDshInboxUnconfirmed
	}
	timer := time.NewTimer(dshInboxAckTimeout)
	defer timer.Stop()
	for {
		select {
		case <-ctx.Done():
			return ctx.Err()
		case is := <-ch:
			if is.Command != "" && is.Command != command {
				continue
			}
			switch is.State {
			case "accepted", "applied":
				return nil
			case "rejected":
				if strings.TrimSpace(is.Reason) != "" {
					return errors.New(strings.TrimSpace(is.Reason))
				}
				return errors.New("dsh rejected the supplement")
			default:
				// A state this daemon does not know confirms nothing; keep
				// waiting for one it does, up to the same deadline.
				continue
			}
		case <-timer.C:
			return ErrDshInboxUnconfirmed
		}
	}
}

// answerDshQuestion turns one steered human comment into the `answer` command
// that resolves the bridge's parked ask. Free text answers every question as
// custom text — the one deliberate mapping is a plan review answered with
// exactly its approve label, which dsh treats as the approval selection.
func answerDshQuestion(state *dshRunState, instruction string) error {
	state.mu.Lock()
	defer state.mu.Unlock()
	if !state.questionsCapable {
		return errors.New("dsh runtime bridge predates question answers (no `questions` capability in its ready frame)")
	}
	if state.pendingCallID == "" {
		return errors.New("no question is pending on this dsh run")
	}
	if state.writeAnswer == nil {
		return errors.New("dsh answer writer is unavailable")
	}
	content := dshSupplementContent(instruction)
	answers := make([]dshAnswerItem, 0, len(state.pendingQuestions))
	for _, question := range state.pendingQuestions {
		item := dshAnswerItem{ID: question.ID, Selected: []string{}, Custom: content}
		if intent := question.Intent; intent != nil && intent.Kind == "plan-review" && intent.Approve != "" &&
			strings.EqualFold(content, intent.Approve) {
			item = dshAnswerItem{ID: question.ID, Selected: []string{intent.Approve}}
		}
		answers = append(answers, item)
	}
	err := state.writeAnswer(dshAnswerCommand{
		Version: DshProtocolVersion, Type: "answer", RequestID: state.requestID,
		CallID: state.pendingCallID, Answers: answers,
	})
	if err != nil {
		return fmt.Errorf("send dsh answer command: %w", err)
	}
	state.pendingCallID = ""
	state.pendingQuestions = nil
	return nil
}

// DshSessionSummary is one bridge-produced session summary (S3-B1): dsh's own
// compaction seam reduced the session's useful idle history to Summary,
// estimated at Tokens tokens by the bridge.
type DshSessionSummary struct {
	SessionID string
	Summary   string
	Tokens    int64
	Model     string
}

// ErrDshSummarizeUnsupported reports that the bridge predates the summarize
// command — its ready frame carried no `summarize` capability. The cache clock
// treats this as a skip decision, never as a failure of the session's own run.
var ErrDshSummarizeUnsupported = errors.New("dsh runtime bridge predates the summarize command (no `summarize` capability in its ready frame)")

// ErrDshSummaryOverCap reports that the bridge refused to return a summary
// above the requested token budget (error code DSH_SUMMARY_OVER_CAP).
var ErrDshSummaryOverCap = errors.New("dsh summary exceeds the requested token budget")

const dshSummaryOverCapCode = "DSH_SUMMARY_OVER_CAP"

// dshSummarizeTimeout bounds the whole summarize process: a fresh dsh boots,
// resumes the idle session, and makes one model-backed compaction call. It is
// a ceiling, not an expectation — a summary of a ~20K-token conversation is a
// single short completion.
const dshSummarizeTimeout = 15 * time.Minute

// SummarizeSession resumes sessionID in a fresh bridge process and asks dsh's
// own compaction seam for a summary of its idle history (S3-B1). The process
// exists only while this call runs: the daemon's cache clock never keeps an
// idle dsh alive, and this is the one bridge invocation it makes when it
// fires. The bridge must have advertised the `summarize` capability on its
// ready frame; anything older fails with ErrDshSummarizeUnsupported before any
// command is written.
//
// cwd is the directory the bridge process runs in: the bridge keys sessions by
// cwd, so a summarize from another directory would not find the session. The
// bridge also needs the backend's env (e.g. MULTICA_DSH_SESSION_ROOT) to find
// the session store. A positive maxTokens is forwarded only to a bridge that
// advertised `summarize_max_tokens`; an older bridge gets the command without
// it and the caller must enforce the budget on the returned summary.
func (b *dshBackend) SummarizeSession(ctx context.Context, sessionID, model, cwd string, maxTokens int64) (*DshSessionSummary, error) {
	if strings.TrimSpace(sessionID) == "" {
		return nil, errors.New("dsh summarize: session id is empty")
	}
	execPath := b.cfg.ExecutablePath
	if execPath == "" {
		execPath = "dsh"
	}
	if _, err := exec.LookPath(execPath); err != nil {
		return nil, fmt.Errorf("dsh executable not found at %q: %w", execPath, err)
	}
	selection, err := parseDshModelID(model)
	if err != nil {
		return nil, err
	}

	runCtx, cancel := runContext(ctx, dshSummarizeTimeout)
	defer cancel()
	cmd := b.cfg.commandAt(execPath).exec(runCtx, dshLaunchArgs()...)
	hideAgentWindow(cmd)
	cmd.Cancel = func() error { return nil }
	cmd.WaitDelay = 10 * time.Second
	if cwd != "" {
		cmd.Dir = cwd
	}
	cmd.Env = buildEnv(b.cfg.Env)

	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return nil, fmt.Errorf("dsh stdout pipe: %w", err)
	}
	stdin, err := cmd.StdinPipe()
	if err != nil {
		return nil, fmt.Errorf("dsh stdin pipe: %w", err)
	}
	stderrBuf := newStderrTail(newLogWriter(b.cfg.Logger, "[dsh:stderr] "), agentStderrTailBytes)
	cmd.Stderr = stderrBuf
	if err := startOwnedProcessTree(cmd, b.cfg.Logger); err != nil {
		return nil, fmt.Errorf("start dsh: %w", err)
	}

	requestID := b.cfg.TaskID
	if requestID == "" {
		requestID = "multica-summarize-" + strconv.FormatInt(time.Now().UnixNano(), 10)
	}
	var writeMu sync.Mutex
	encoder := json.NewEncoder(stdin)
	writeFrame := func(value any) error {
		writeMu.Lock()
		defer writeMu.Unlock()
		return encoder.Encode(value)
	}

	procDone := make(chan struct{})
	go func() {
		select {
		case <-procDone:
			return
		case <-runCtx.Done():
		}
		_ = writeFrame(dshCancelCommand{Version: DshProtocolVersion, Type: "cancel", RequestID: requestID})
		timer := time.NewTimer(dshCancelGrace)
		defer timer.Stop()
		select {
		case <-procDone:
			return
		case <-timer.C:
		}
		signalProcessGroup(cmd, syscall.SIGTERM)
		if !waitProcessGroupGone(cmd, dshTerminateGrace) {
			signalProcessGroup(cmd, syscall.SIGKILL)
		}
		_ = stdout.Close()
	}()

	var (
		summary      *DshSessionSummary
		reportedID   string
		protocolErr  error
		terminalSeen bool
	)
	command := dshSummarizeCommand{
		Version: DshProtocolVersion, Type: "summarize", RequestID: requestID,
		SessionID: sessionID, Model: selection,
	}
	scanner := newAgentStreamScanner(stdout)
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if line == "" {
			continue
		}
		var frame dshFrame
		if err := json.Unmarshal([]byte(line), &frame); err != nil {
			continue
		}
		if frame.Version != DshProtocolVersion {
			protocolErr = fmt.Errorf("dsh returned unsupported protocol version %d", frame.Version)
			break
		}
		if frame.RequestID != "" && frame.RequestID != requestID {
			continue
		}
		switch frame.Type {
		case "ready":
			if frame.Capabilities == nil || !frame.Capabilities.Summarize {
				protocolErr = ErrDshSummarizeUnsupported
				signalProcessGroup(cmd, syscall.SIGKILL)
				break
			}
			// The command goes out only after the capability check: a bridge
			// that predates summarize never even sees the request.
			if maxTokens > 0 && frame.Capabilities.SummarizeMaxTokens {
				command.MaxTokens = maxTokens
			}
			if err := writeFrame(command); err != nil {
				protocolErr = fmt.Errorf("send dsh summarize command: %w", err)
			}
		case "session":
			if frame.SessionID != "" {
				reportedID = frame.SessionID
			}
		case "summary":
			summary = &DshSessionSummary{Summary: frame.Summary, Tokens: frame.SummaryTokens, Model: frame.Model}
		case "protocol_error":
			protocolErr = fmt.Errorf("dsh summarize protocol error: %s", strings.TrimSpace(frame.Code+": "+frame.Message))
		case "result":
			terminalSeen = true
			if frame.Status != "completed" {
				message := strings.TrimSpace(frame.Code + ": " + frame.Message)
				if frame.Error != nil {
					message = strings.TrimSpace(frame.Error.Code + ": " + frame.Error.Message)
				}
				if message == "" {
					message = "dsh ended the summarize request without a usable result"
				}
				if frame.Error != nil && frame.Error.Code == dshSummaryOverCapCode {
					protocolErr = fmt.Errorf("dsh summarize failed: %s: %w", message, ErrDshSummaryOverCap)
				} else {
					protocolErr = fmt.Errorf("dsh summarize failed: %s", message)
				}
			}
			if frame.SessionID != "" {
				reportedID = frame.SessionID
			}
		}
		if terminalSeen || protocolErr != nil {
			break
		}
	}
	scanErr := scanner.Err()
	exitErr := cmd.Wait()
	releaseProcessGroup(cmd)

	if protocolErr != nil {
		if errors.Is(protocolErr, ErrDshSummarizeUnsupported) {
			b.cfg.Logger.Info("dsh summarize skipped: bridge lacks the summarize capability", "session_id", sessionID)
			return nil, ErrDshSummarizeUnsupported
		}
		return nil, protocolErr
	}
	if scanErr != nil {
		return nil, fmt.Errorf("read dsh summarize stream: %w", scanErr)
	}
	if !terminalSeen {
		message := fmt.Sprintf("dsh exited without a summarize result (exit: %v)", exitErr)
		return nil, errors.New(withAgentStderr(message, "dsh", stderrBuf.Tail()))
	}
	if summary == nil {
		return nil, errors.New("dsh summarize completed without a summary frame")
	}
	if reportedID == "" {
		reportedID = sessionID
	}
	if reportedID != sessionID {
		return nil, fmt.Errorf("dsh summarized session %q, expected %q", reportedID, sessionID)
	}
	summary.SessionID = reportedID
	if summary.Model == "" {
		summary.Model = model
	}
	return summary, nil
}

func discoverDshModels(ctx context.Context, runtimeCmd Command) ([]Model, error) {
	if runtimeCmd.Path == "" {
		runtimeCmd.Path = "dsh"
	}
	cmd := runtimeCmd.exec(ctx, "--profile", dshProfile, "--list-models")
	hideAgentWindow(cmd)
	cmd.WaitDelay = time.Second
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return nil, err
	}
	cmd.Stderr = io.Discard
	if err := startOwnedProcessTree(cmd, runtimeCmd.logger); err != nil {
		return nil, err
	}
	var models []Model
	scanner := newAgentStreamScanner(stdout)
	for scanner.Scan() {
		var frame dshFrame
		if json.Unmarshal(scanner.Bytes(), &frame) != nil || frame.Version != DshProtocolVersion || frame.Type != "models" {
			continue
		}
		for _, item := range frame.Models {
			model := Model{ID: item.ID, Label: item.Label, Provider: item.Provider, Default: item.Default}
			if item.Thinking != nil && len(item.Thinking.SupportedLevels) > 0 {
				model.Thinking = &ModelThinking{SupportedLevels: item.Thinking.SupportedLevels, DefaultLevel: item.Thinking.DefaultLevel}
			}
			models = append(models, model)
		}
	}
	scanErr := scanner.Err()
	exitErr := cmd.Wait()
	releaseProcessGroup(cmd)
	if scanErr != nil {
		return nil, scanErr
	}
	if exitErr != nil {
		return nil, exitErr
	}
	if len(models) == 0 {
		return nil, errors.New("dsh returned an empty model catalog")
	}
	return models, nil
}
