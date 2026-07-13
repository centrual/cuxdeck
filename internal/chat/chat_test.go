package chat

import "testing"

func first(evs []Event) Event {
	if len(evs) == 0 {
		return Event{}
	}
	return evs[0]
}

func TestUserStringPrompt(t *testing.T) {
	e := first(Parse([]byte(`{"type":"user","message":{"role":"user","content":"fix the bug please"}}`)))
	if e.Role != "user" || e.Kind != "text" || e.Text != "fix the bug please" {
		t.Errorf("got %+v", e)
	}
}

func TestSystemWrappersHidden(t *testing.T) {
	for _, c := range []string{
		`{"type":"user","message":{"role":"user","content":"<system-reminder>be good</system-reminder>"}}`,
		`{"type":"user","message":{"role":"user","content":"Caveat: local command output"}}`,
		`{"type":"user","message":{"role":"user","content":"<bash-input>ls</bash-input>"}}`,
		`{"type":"user","message":{"role":"user","content":"   "}}`,
		// Background-task notifications: a plain-text banner precedes the
		// <task-notification> block, so they don't start with "<".
		`{"type":"user","message":{"role":"user","content":"[SYSTEM NOTIFICATION - NOT USER INPUT]\nThis is an automated background-task event, NOT a message from the user.\n<task-notification>\n<task-id>abc123</task-id>\n<status>completed</status>\n<summary>Background command \"deploy\" completed (exit code 0)</summary>\n</task-notification>"}}`,
		`{"type":"user","message":{"role":"user","content":"<task-notification><task-id>x</task-id></task-notification>"}}`,
	} {
		if evs := Parse([]byte(c)); len(evs) != 0 {
			t.Errorf("wrapper should be hidden, got %+v for %s", evs, c)
		}
	}
}

// A real user message that merely arrives mid-turn must still show, even
// though the surrounding notification machinery is stripped.
func TestMidTurnUserMessageStillShows(t *testing.T) {
	c := `{"type":"user","message":{"role":"user","content":"The user sent a new message while you were working:\nplease also add tests\n\nThis is how Claude Code surfaces messages..."}}`
	e := first(Parse([]byte(c)))
	if e.Role != "user" || e.Kind != "text" || e.Text != "please also add tests" {
		t.Errorf("mid-turn user message should show, got %+v", e)
	}
}

func TestAssistantTextAndThinking(t *testing.T) {
	evs := Parse([]byte(`{"type":"assistant","message":{"role":"assistant","content":[{"type":"thinking","thinking":"let me plan"},{"type":"text","text":"Here is the answer"}]}}`))
	if len(evs) != 2 || evs[0].Kind != "thinking" || evs[1].Kind != "text" || evs[1].Role != "assistant" {
		t.Fatalf("got %+v", evs)
	}
}

func TestToolSummaries(t *testing.T) {
	cases := []struct{ in, wantTool, wantDetail string }{
		{`{"type":"assistant","message":{"role":"assistant","content":[{"type":"tool_use","name":"Bash","input":{"command":"git status\n"}}]}}`, "Bash", "git status"},
		{`{"type":"assistant","message":{"role":"assistant","content":[{"type":"tool_use","name":"Edit","input":{"file_path":"/a/b/main.go"}}]}}`, "Edit", "main.go"},
		{`{"type":"assistant","message":{"role":"assistant","content":[{"type":"tool_use","name":"mcp__playwright__browser_click","input":{}}]}}`, "mcp__playwright__browser_click", ""},
	}
	for _, c := range cases {
		e := first(Parse([]byte(c.in)))
		if e.Role != "tool" || e.Tool != c.wantTool || e.Detail != c.wantDetail {
			t.Errorf("in=%s got role=%s tool=%s detail=%q", c.in, e.Role, e.Tool, e.Detail)
		}
	}
}

func TestToolResultSummarized(t *testing.T) {
	// The CLI shows every result as a collapsed "⎿" line; so do we.
	evs := Parse([]byte(`{"type":"user","message":{"role":"user","content":[{"type":"tool_result","content":"ok"}]}}`))
	if len(evs) != 1 || evs[0].Role != "result" || evs[0].Text != "ok" || evs[0].Detail != "" {
		t.Errorf("expected one summary line, got %+v", evs)
	}
}

func TestModelSwitchDivider(t *testing.T) {
	e := first(Parse([]byte(`{"type":"assistant","message":{"role":"assistant","content":[{"type":"fallback","from":{"model":"claude-fable-5"},"to":{"model":"claude-opus-4-8"}}]}}`)))
	if e.Role != "divider" || e.Kind != "model-switch" || e.Detail != "fable-5 → opus-4-8" {
		t.Errorf("got %+v", e)
	}
}

func TestGarbageAndNonChatSkipped(t *testing.T) {
	for _, c := range []string{`not json`, `{"type":"system","x":1}`, `{"type":"file-history-snapshot"}`} {
		if evs := Parse([]byte(c)); evs != nil {
			t.Errorf("expected nil for %q, got %+v", c, evs)
		}
	}
}

func TestMidTurnMessageSurfaced(t *testing.T) {
	line := `{"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"t1","content":"File created.\n\n<system-reminder>\nThe user sent a new message while you were working:\nhemen dur\n\nThis is how Claude Code surfaces messages...\n</system-reminder>"}]}}`
	evs := Parse([]byte(line))
	var mid *Event
	for i := range evs {
		if evs[i].Detail == "sent mid-turn" {
			mid = &evs[i]
		}
	}
	if mid == nil || mid.Role != "user" || mid.Text != "hemen dur" {
		t.Fatalf("got %+v", evs)
	}
	// the tool's own output still summarizes, without the reminder text
	if len(evs) != 2 || evs[1].Role != "result" || evs[1].Text != "File created." {
		t.Fatalf("summary: got %+v", evs)
	}
}

func TestTaskCreateFromResult(t *testing.T) {
	line := `{"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"t1","content":"Task #3 created successfully: Deploy the app"}]}}`
	evs := Parse([]byte(line))
	if len(evs) < 1 || evs[0].Role != "task" || evs[0].Kind != "task-create" || evs[0].Tool != "3" || evs[0].Text != "Deploy the app" {
		t.Fatalf("got %+v", evs)
	}
}

func TestTaskUpdateFromToolUse(t *testing.T) {
	line := `{"type":"assistant","message":{"role":"assistant","content":[{"type":"tool_use","name":"TaskUpdate","input":{"taskId":"3","status":"completed"}}]}}`
	evs := Parse([]byte(line))
	if len(evs) != 1 || evs[0].Kind != "task-update" || evs[0].Tool != "3" || evs[0].Text != "completed" {
		t.Fatalf("got %+v", evs)
	}
}

func TestAskQuestionAndAnswer(t *testing.T) {
	q := `{"type":"assistant","message":{"role":"assistant","content":[{"type":"tool_use","name":"AskUserQuestion","input":{"questions":[{"question":"Which db?","header":"DB","options":[{"label":"Postgres"},{"label":"SQLite"}]}]}}]}}`
	evs := Parse([]byte(q))
	if len(evs) != 1 || evs[0].Role != "ask" || evs[0].Kind != "question" || evs[0].Detail != "Postgres · SQLite" {
		t.Fatalf("question: got %+v", evs)
	}
	a := `{"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"t1","content":"Your questions have been answered: \"Which db?\"=\"Postgres\". You can now continue."}]}}`
	evs = Parse([]byte(a))
	if len(evs) != 1 || evs[0].Kind != "answer" || evs[0].Text != "Postgres" {
		t.Fatalf("answer: got %+v", evs)
	}
}

func TestDeniedAndInterrupt(t *testing.T) {
	d := `{"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"t1","content":"The user doesn't want to proceed with this tool use. The tool use was rejected."}]}}`
	evs := Parse([]byte(d))
	if len(evs) != 1 || evs[0].Kind != "denied" || evs[0].Role != "result" || evs[0].ID != "t1" {
		t.Fatalf("denied: got %+v", evs)
	}
	i := `{"type":"user","message":{"role":"user","content":"[Request interrupted by user]"}}`
	evs = Parse([]byte(i))
	if len(evs) != 1 || evs[0].Kind != "interrupt" {
		t.Fatalf("interrupt: got %+v", evs)
	}
}

func TestSlashCommandDivider(t *testing.T) {
	c := `{"type":"user","message":{"role":"user","content":"<command-name>/model</command-name>\n<command-message>model</command-message>\n<command-args>opus</command-args>"}}`
	evs := Parse([]byte(c))
	if len(evs) != 1 || evs[0].Kind != "command" || evs[0].Text != "/model opus" {
		t.Fatalf("got %+v", evs)
	}
}

func TestBashFullBody(t *testing.T) {
	line := `{"type":"assistant","message":{"role":"assistant","content":[{"type":"tool_use","name":"Bash","input":{"command":"echo a\necho b"}}]}}`
	evs := Parse([]byte(line))
	if len(evs) != 1 || evs[0].Full != "echo a\necho b" {
		t.Fatalf("got %+v", evs)
	}
}

func TestResultSummaryPairsWithCall(t *testing.T) {
	line := `{"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"tu9","content":"line one\nline two\nline three"}]}}`
	evs := Parse([]byte(line))
	if len(evs) != 1 || evs[0].Role != "result" || evs[0].ID != "tu9" || evs[0].Text != "line one" || evs[0].Detail != "+2 lines" {
		t.Fatalf("got %+v", evs)
	}
	errLine := `{"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"tu9","is_error":true,"content":"boom"}]}}`
	evs = Parse([]byte(errLine))
	if len(evs) != 1 || evs[0].Kind != "error" {
		t.Fatalf("error: got %+v", evs)
	}
}
