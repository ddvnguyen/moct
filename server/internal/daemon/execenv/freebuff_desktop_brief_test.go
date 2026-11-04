package execenv

import (
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
)

func TestDesktopPreservesIdentitySectionReference(t *testing.T) {
	const supplied = "Follow the Agent Identity section and preserve this text."
	var b strings.Builder
	writeAgentIdentity(&b, TaskContextForEnv{IsFreebuffDesktop: true, AgentInstructions: supplied})
	if !strings.Contains(b.String(), "## Agent Identity\n") || !strings.Contains(b.String(), supplied) || !strings.Contains(b.String(), "Task Identity refers to this section") {
		t.Fatalf("identity reference or alias lost: %s", b.String())
	}
}

func TestFreebuffDesktopUsesAndRestoresProjectInstructions(t *testing.T) {
	dir := t.TempDir()
	project := filepath.Join(dir, "AGENTS.md")
	const existing = "# Project guidance\nKeep agent and worker identifiers exactly: `multica agent list`.\n"
	if err := os.WriteFile(project, []byte(existing), 0o600); err != nil {
		t.Fatal(err)
	}
	ctx := TaskContextForEnv{IssueID: "issue-1", IsFreebuffDesktop: true}
	if _, err := InjectRuntimeConfig(dir, "codebuddy", ctx); err != nil {
		t.Fatal(err)
	}
	content, err := os.ReadFile(project)
	if err != nil || !strings.Contains(string(content), existing) || !strings.Contains(string(content), runtimeMarkerBegin) {
		t.Fatalf("project guidance or runtime block missing: %q, %v", content, err)
	}
	if !strings.Contains(string(content), "We are working with Multica workspace") {
		t.Fatal("Desktop introduction missing")
	}
	if _, err := os.Stat(filepath.Join(dir, "CODEBUDDY.md")); !os.IsNotExist(err) {
		t.Fatalf("unexpected separate runtime file: %v", err)
	}
	if err := CleanupRuntimeConfigForTask(dir, "codebuddy", ctx); err != nil {
		t.Fatal(err)
	}
	content, err = os.ReadFile(project)
	if err != nil || string(content) != existing {
		t.Fatalf("project guidance changed after cleanup: %q, %v", content, err)
	}
}

func TestDesktopCommandGuidanceUsesNaturalCopy(t *testing.T) {
	var desktop, ordinary strings.Builder
	writeAvailableCommands(&desktop, TaskContextForEnv{IsFreebuffDesktop: true})
	writeAvailableCommands(&ordinary, TaskContextForEnv{})
	if regexp.MustCompile(`(?i)\b(agent|worker)s?\b`).MatchString(desktop.String()) {
		t.Fatalf("unexpected wording in Desktop command guidance: %s", desktop.String())
	}
	if !strings.Contains(ordinary.String(), "agent-authored long descriptions") {
		t.Fatal("ordinary runtime guidance changed")
	}
	for _, command := range []string{"multica issue get", "multica issue comment list", "--content-file"} {
		if !strings.Contains(desktop.String(), command) {
			t.Errorf("Desktop guidance lost %q", command)
		}
	}
}

func TestDesktopCommentFormattingKeepsFileFirstRule(t *testing.T) {
	var desktop, ordinary strings.Builder
	writeCommentFormatting(&desktop, true)
	writeCommentFormatting(&ordinary, false)
	if regexp.MustCompile(`(?i)\b(agent|worker)s?\b`).MatchString(desktop.String()) {
		t.Fatalf("unexpected wording in Desktop comment guidance: %s", desktop.String())
	}
	if !strings.Contains(desktop.String(), "--content-file") || !strings.Contains(desktop.String(), "only after the post succeeded") {
		t.Fatal("Desktop comment guidance lost file-first or cleanup rule")
	}
	if !strings.Contains(ordinary.String(), "agent-authored comments") {
		t.Fatal("ordinary runtime guidance changed")
	}
}

func TestDesktopMentionGuidancePreservesRequiredSyntax(t *testing.T) {
	var desktop, ordinary strings.Builder
	writeMentions(&desktop, true)
	writeMentions(&ordinary, false)
	if !strings.Contains(desktop.String(), "mention://agent/<agent-id>") {
		t.Fatal("required mention syntax was changed")
	}
	prose := regexp.MustCompile("`[^`]*`").ReplaceAllString(desktop.String(), "")
	if regexp.MustCompile(`(?i)\b(agent|worker)s?\b`).MatchString(prose) {
		t.Fatalf("unexpected wording in Desktop mention guidance: %s", prose)
	}
	if !strings.Contains(ordinary.String(), "another agent a concrete new sub-task") {
		t.Fatal("ordinary runtime guidance changed")
	}
}

func TestDesktopWorkflowUsesTaskIdentityWithoutChangingUserContent(t *testing.T) {
	ctx := TaskContextForEnv{IssueID: "issue-1", IsFreebuffDesktop: true, AgentName: "Agent Worker", AgentInstructions: "Use `multica agent list`."}
	content := buildMetaSkillContent("codebuddy", ctx)
	if !strings.Contains(content, "Agent Worker") || !strings.Contains(content, "Use `multica agent list`.") {
		t.Fatal("user-supplied name or instructions changed")
	}
	if !strings.Contains(content, "## Task Identity") || !strings.Contains(content, "Task Identity instructions have priority") {
		t.Fatal("Desktop identity heading and precedence no longer agree")
	}
	var workflow strings.Builder
	writeWorkflowIssue(&workflow, ctx)
	if regexp.MustCompile(`(?i)\b(agent|worker)s?\b`).MatchString(workflow.String()) {
		t.Fatalf("unexpected wording in Desktop workflow: %s", workflow.String())
	}
}

func TestDesktopIssueBriefUsesNaturalGeneratedProse(t *testing.T) {
	for name, ctx := range map[string]TaskContextForEnv{
		"issue":        {IssueID: "issue-1"},
		"workflow":     {IssueID: "issue-1", HasProjectWorkflow: true},
		"leader":       {IssueID: "issue-1", IsSquadLeader: true},
		"chat":         {ChatSessionID: "chat-1"},
		"autopilot":    {AutopilotRunID: "run-1"},
		"quick-create": {QuickCreatePrompt: "new item"},
	} {
		t.Run(name, func(t *testing.T) {
			ctx.IsFreebuffDesktop, ctx.AgentName, ctx.AgentInstructions = true, "Ada", "Complete the assigned work."
			content := buildMetaSkillContent("codebuddy", ctx)
			prose := regexp.MustCompile("`[^`]*`").ReplaceAllString(content, "")
			if match := regexp.MustCompile(`(?im)^.*\b(agent|worker)s?\b.*$`).FindString(prose); match != "" {
				t.Fatalf("unexpected generated wording: %s", match)
			}
		})
	}
}
