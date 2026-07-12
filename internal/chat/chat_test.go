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
	} {
		if evs := Parse([]byte(c)); len(evs) != 0 {
			t.Errorf("wrapper should be hidden, got %+v for %s", evs, c)
		}
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

func TestToolResultDropped(t *testing.T) {
	evs := Parse([]byte(`{"type":"user","message":{"role":"user","content":[{"type":"tool_result","content":"ok"}]}}`))
	if len(evs) != 0 {
		t.Errorf("tool_result should be dropped, got %+v", evs)
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
