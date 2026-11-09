package freebuffrt

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"
)

// launchHeader carries the launch id on every request. The orchestrator
// refuses /api/* calls without it, and refuses browser-origin requests, so a
// plain HTTP client from the same machine is the intended caller.
const launchHeader = "x-freebuff-launch-id"

// Client talks to one running orchestrator.
type Client struct {
	base     string
	launchID string
	pid      int
	http     *http.Client
}

// NewClient returns a client for the orchestrator that announced ready.
func NewClient(ready Ready, launchID string) *Client {
	return &Client{
		base:     fmt.Sprintf("http://127.0.0.1:%d", ready.Port),
		launchID: launchID,
		pid:      ready.PID,
		http:     &http.Client{Timeout: 30 * time.Second},
	}
}

// NewClientForURL is NewClient for an explicit base URL (tests).
// BaseURL returns the orchestrator's base URL (http://host:port).
func (c *Client) BaseURL() string { return c.base }

func NewClientForURL(base, launchID string) *Client {
	return &Client{base: strings.TrimRight(base, "/"), launchID: launchID, http: &http.Client{Timeout: 30 * time.Second}}
}

// LaunchID returns the process-local credential the bridge must send when it
// calls this orchestrator. Callers must keep it in memory and task-local env.
func (c *Client) LaunchID() string { return c.launchID }

// PID is the process identifier announced by the managed orchestrator.
func (c *Client) PID() int { return c.pid }

// APIError is a non-2xx answer from the orchestrator.
type APIError struct {
	Status  int
	Message string
}

func (e *APIError) Error() string {
	return fmt.Sprintf("freebuff orchestrator: HTTP %d: %s", e.Status, e.Message)
}

func (c *Client) do(ctx context.Context, method, path string, body any, out any) error {
	var rd io.Reader
	if body != nil {
		raw, err := json.Marshal(body)
		if err != nil {
			return err
		}
		rd = bytes.NewReader(raw)
	}
	req, err := http.NewRequestWithContext(ctx, method, c.base+path, rd)
	if err != nil {
		return err
	}
	req.Header.Set(launchHeader, c.launchID)
	if body != nil {
		req.Header.Set("content-type", "application/json")
	}
	resp, err := c.http.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	raw, err := io.ReadAll(io.LimitReader(resp.Body, 8<<20))
	if err != nil {
		return err
	}
	if resp.StatusCode < 200 || resp.StatusCode > 299 {
		return &APIError{Status: resp.StatusCode, Message: errorMessage(raw)}
	}
	if out == nil || len(bytes.TrimSpace(raw)) == 0 {
		return nil
	}
	return json.Unmarshal(raw, out)
}

func errorMessage(raw []byte) string {
	var e struct {
		Error string `json:"error"`
	}
	if json.Unmarshal(raw, &e) == nil && e.Error != "" {
		return e.Error
	}
	s := strings.TrimSpace(string(raw))
	if len(s) > 300 {
		s = s[:300]
	}
	return s
}

// Health checks the orchestrator is up and is the process we launched.
func (c *Client) Health(ctx context.Context) error {
	var out struct {
		OK       bool   `json:"ok"`
		LaunchID string `json:"launchId"`
	}
	if err := c.do(ctx, http.MethodGet, "/healthz", nil, &out); err != nil {
		return err
	}
	if !out.OK || (out.LaunchID != "" && out.LaunchID != c.launchID) {
		return errors.New("freebuff orchestrator health check failed")
	}
	return nil
}

// AuthStatus is the orchestrator's view of the signed-in account.
type AuthStatus struct {
	Authed bool            `json:"authed"`
	User   json.RawMessage `json:"user"`
	Login  LoginState      `json:"login"`
	Raw    json.RawMessage `json:"-"`
}

// LoginState is the browser-login handshake state.
type LoginState struct {
	Phase string `json:"phase"`
}

// ThreadProbe verifies the orchestrator serves the local thread routes the
// task bridge drives. GET /api/projects answers 200 with the project list on
// builds that serve threads, and 404 {"error":"not found"} on builds whose
// router dropped those routes (e.g. a hosted-workspace-only build passes
// /api/auth/status but 404s POST /api/threads on every run). Only 404 fails
// the probe; any other outcome (200 stream, 401 without a launch token, 403
// forbidden origin) means the route exists.
func (c *Client) ThreadProbe(ctx context.Context) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, c.base+"/api/projects", nil)
	if err != nil {
		return err
	}
	req.Header.Set(launchHeader, c.launchID)
	resp, err := c.http.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, 4<<10))
	if resp.StatusCode == http.StatusNotFound {
		return errors.New("freebuff orchestrator does not serve thread routes")
	}
	return nil
}

// AuthStatus reads GET /api/auth/status.
func (c *Client) AuthStatus(ctx context.Context) (AuthStatus, error) {
	var raw json.RawMessage
	if err := c.do(ctx, http.MethodGet, "/api/auth/status", nil, &raw); err != nil {
		return AuthStatus{}, err
	}
	var st AuthStatus
	if err := json.Unmarshal(raw, &st); err != nil {
		return AuthStatus{}, err
	}
	st.Raw = raw
	return st, nil
}

type LoginStart struct {
	URL       string `json:"url"`
	AttemptID string `json:"attemptId"`
	// RemoteURL is the account host's own sign-in page, which the loopback
	// launch page redirects to. Unlike URL it opens in a browser on any
	// machine. Empty when the redirect could not be read.
	RemoteURL string `json:"-"`
}

// StartLogin begins a browser login. The returned URL is a loopback launch
// page on the orchestrator that redirects to the account host; it only works
// from the machine the orchestrator runs on.
func (c *Client) StartLogin(ctx context.Context) (LoginStart, error) {
	var out LoginStart
	if err := c.do(ctx, http.MethodPost, "/api/auth/login/start", map[string]any{}, &out); err != nil {
		return out, err
	}
	out.RemoteURL = c.resolveLaunchURL(ctx, out.URL)
	return out, nil
}

// resolveLaunchURL reads where the loopback launch page redirects to without
// following it. The redirect target is the account host's sign-in page; the
// orchestrator keeps waiting on its own side for the sign-in to complete, so
// the user can open the target from any machine. Any failure yields "" and
// the caller falls back to the loopback URL.
func (c *Client) resolveLaunchURL(ctx context.Context, launch string) string {
	u, err := url.Parse(launch)
	base, baseErr := url.Parse(c.base)
	if err != nil || baseErr != nil || u.Host != base.Host {
		return ""
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, launch, nil)
	if err != nil {
		return ""
	}
	req.Header.Set(launchHeader, c.launchID)
	noFollow := &http.Client{
		Timeout:       c.http.Timeout,
		CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
	}
	resp, err := noFollow.Do(req)
	if err != nil {
		return ""
	}
	defer resp.Body.Close()
	if resp.StatusCode < 300 || resp.StatusCode > 399 {
		return ""
	}
	loc, err := resp.Location()
	if err != nil || (loc.Scheme != "https" && loc.Scheme != "http") || loc.Hostname() == "127.0.0.1" || loc.Hostname() == "localhost" {
		return ""
	}
	return loc.String()
}

// CancelLogin abandons a pending browser login.
func (c *Client) CancelLogin(ctx context.Context) error {
	return c.do(ctx, http.MethodPost, "/api/auth/login/cancel", map[string]any{}, nil)
}

// Thread is the subset of the orchestrator's thread record this package reads.
type Thread struct {
	ID                 string  `json:"id"`
	Status             string  `json:"status"`
	TurnState          string  `json:"turnState"`
	LastTurnOutcome    *string `json:"lastTurnOutcome"`
	LastTurnFinishedAt any     `json:"lastTurnFinishedAt"`
	Model              *string `json:"model"`
}

// CreateThread opens a thread rooted at projectPath.
func (c *Client) CreateThread(ctx context.Context, projectPath string) (Thread, error) {
	return c.CreateThreadWithModel(ctx, projectPath, "")
}

// CreateThreadWithModel opens a thread rooted at projectPath, pinned to
// model. A thread's model is fixed when the thread is created — the
// orchestrator offers no way to change it afterwards — so a model change
// means a new thread (the Freebuff fork's own desktop bridge uses the same
// contract: one reusable thread per model, POST /api/threads carrying
// {projectPath, harnessId: "codebuff", model}).
//
// An empty model keeps the default: the body omits the model field and the
// orchestrator picks its own (the same body CreateThread used to send).
func (c *Client) CreateThreadWithModel(ctx context.Context, projectPath, model string) (Thread, error) {
	body := map[string]any{"projectPath": projectPath}
	if model != "" {
		// harnessId "codebuff" is the same value the bridge sends; without it
		// the orchestrator treats the model field differently (verified against
		// the bridge in the freebuff fork, freebuff-desktop-bridge.mjs).
		body["harnessId"] = "codebuff"
		body["model"] = model
	}
	var t Thread
	err := c.do(ctx, http.MethodPost, "/api/threads", body, &t)
	return t, err
}

// GetThread reads a thread snapshot.
func (c *Client) GetThread(ctx context.Context, id string) (Thread, error) {
	var t Thread
	err := c.do(ctx, http.MethodGet, "/api/thread/"+url.PathEscape(id), nil, &t)
	return t, err
}

// PostMessage sends a user message, starting a turn.
func (c *Client) PostMessage(ctx context.Context, threadID, text string) error {
	return c.do(ctx, http.MethodPost, "/api/thread/"+url.PathEscape(threadID)+"/message", map[string]any{"text": text}, nil)
}

// ModelCatalogEntry is one model of an account's picker catalog, and
// Catalog is the flattened read: Default marks the account's recommended
// head, exactly one entry at most.
type ModelCatalogEntry struct {
	ID          string `json:"id"`
	DisplayName string `json:"displayName"`
	Tagline     string `json:"tagline"`
}

type ModelCatalog struct {
	Models      []ModelCatalogEntry
	Default     string // id of the recommended model, empty when none
	Recommended []string
}

// freebuffSnapshot is the freebuff slot of the orchestrator's state event,
// where the account's picker catalog is published. The desktop bridge reads
// exactly this shape from the first `state` event of GET /api/events.
type freebuffSnapshot struct {
	Models            []ModelCatalogEntry `json:"models"`
	RecommendedModels []string            `json:"recommendedModels"`
}

// ModelCatalog returns the picker catalog of the account signed in on this
// orchestrator. There is no plain-GET endpoint for it: the orchestrator
// publishes it as the first `state` event of GET /api/events
// (snapshot.freebuff.models), so one short read of that stream collects it.
// The function returns as soon as a state event carries a model list.
//
// An error means the orchestrator or its event stream is unusable. Whether
// the account is signed in is the caller's check (AuthStatus), not this read.
func (c *Client) ModelCatalog(ctx context.Context) (ModelCatalog, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, c.base+"/api/events", nil)
	if err != nil {
		return ModelCatalog{}, err
	}
	req.Header.Set(launchHeader, c.launchID)
	req.Header.Set("accept", "text/event-stream")
	// The catalog usually lands in the first frame or two, but a busy
	// orchestrator may take a moment to publish its state; the caller's ctx
	// is the deadline. The stream may idle otherwise, so the per-request
	// timeout of c.http must not cut it — a fresh client, like Events.
	resp, err := (&http.Client{}).Do(req)
	if err != nil {
		return ModelCatalog{}, err
	}
	if resp.StatusCode != http.StatusOK {
		raw, _ := io.ReadAll(io.LimitReader(resp.Body, 4096))
		resp.Body.Close()
		return ModelCatalog{}, &APIError{Status: resp.StatusCode, Message: errorMessage(raw)}
	}
	defer resp.Body.Close()

	sc := bufio.NewScanner(resp.Body)
	sc.Buffer(make([]byte, 0, 64*1024), 16<<20)
	for sc.Scan() {
		payload, ok := strings.CutPrefix(sc.Text(), "data:")
		if !ok {
			continue
		}
		payload = strings.TrimSpace(payload)
		var head struct {
			Type     string `json:"type"`
			Snapshot *struct {
				Freebuff *freebuffSnapshot `json:"freebuff"`
			} `json:"snapshot"`
		}
		if json.Unmarshal([]byte(payload), &head) != nil || head.Snapshot == nil || head.Snapshot.Freebuff == nil {
			continue
		}
		fb := head.Snapshot.Freebuff
		if len(fb.Models) == 0 {
			continue
		}
		out := ModelCatalog{Recommended: fb.RecommendedModels}
		recommended := make(map[string]bool, len(fb.RecommendedModels))
		for _, id := range fb.RecommendedModels {
			recommended[id] = true
		}
		for _, m := range fb.Models {
			if strings.TrimSpace(m.ID) == "" {
				continue
			}
			if recommended[m.ID] && out.Default == "" {
				out.Default = m.ID
			}
			out.Models = append(out.Models, m)
		}
		return out, nil
	}
	if err := sc.Err(); err != nil {
		return ModelCatalog{}, err
	}
	return ModelCatalog{}, errors.New("freebuff model catalog unavailable: the event stream closed without publishing one")
}

// StopTurn interrupts the running turn.
func (c *Client) StopTurn(ctx context.Context, threadID string) error {
	return c.do(ctx, http.MethodPost, "/api/thread/"+url.PathEscape(threadID)+"/stop", map[string]any{}, nil)
}

// Event is one server-sent event, decoded only as far as its type.
type Event struct {
	Type string
	Raw  json.RawMessage
}

// Events opens GET /api/events and delivers decoded events until ctx ends or
// the stream closes. The channel is closed when the stream ends; err (read
// after the close) reports why.
func (c *Client) Events(ctx context.Context) (<-chan Event, func() error, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, c.base+"/api/events", nil)
	if err != nil {
		return nil, nil, err
	}
	req.Header.Set(launchHeader, c.launchID)
	req.Header.Set("accept", "text/event-stream")
	// The stream is long-lived; the per-request timeout of c.http would cut it.
	resp, err := (&http.Client{}).Do(req)
	if err != nil {
		return nil, nil, err
	}
	if resp.StatusCode != http.StatusOK {
		raw, _ := io.ReadAll(io.LimitReader(resp.Body, 4096))
		resp.Body.Close()
		return nil, nil, &APIError{Status: resp.StatusCode, Message: errorMessage(raw)}
	}
	ch := make(chan Event, 64)
	var streamErr error
	done := make(chan struct{})
	go func() {
		defer close(done)
		defer close(ch)
		defer resp.Body.Close()
		sc := bufio.NewScanner(resp.Body)
		sc.Buffer(make([]byte, 0, 64*1024), 16<<20)
		for sc.Scan() {
			line := sc.Text()
			payload, ok := strings.CutPrefix(line, "data:")
			if !ok {
				continue
			}
			payload = strings.TrimSpace(payload)
			var head struct {
				Type string `json:"type"`
			}
			if json.Unmarshal([]byte(payload), &head) != nil {
				continue
			}
			select {
			case ch <- Event{Type: head.Type, Raw: json.RawMessage(payload)}:
			case <-ctx.Done():
				streamErr = ctx.Err()
				return
			}
		}
		streamErr = sc.Err()
	}()
	return ch, func() error { <-done; return streamErr }, nil
}
