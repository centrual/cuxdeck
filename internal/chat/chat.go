// Package chat turns Claude Code's session transcript (the JSONL under
// ~/.claude/projects) into a clean, phone-friendly stream of chat
// events. cuxdeck collects nothing itself — Claude Code writes every
// line for --resume, so this is a pure read of data that already
// exists, live for the current session and complete for past ones.
//
// The parser is intentionally forgiving: unknown block types degrade
// to a labelled marker, malformed lines are skipped, and the shapes it
// does not recognise never crash the stream. The transcript format
// belongs to Claude Code and grows freely.
package chat

import (
	"encoding/json"
	"strings"
)

// Event is one item in the chat view.
type Event struct {
	Role   string `json:"role"`             // user | assistant | tool | system | divider
	Kind   string `json:"kind,omitempty"`   // text | thinking | tool | image | model-switch
	Text   string `json:"text,omitempty"`   // bubble body / one-line tool summary
	Tool   string `json:"tool,omitempty"`   // tool name, when Kind==tool
	Detail string `json:"detail,omitempty"` // secondary line (tool target, model names)
	TS     string `json:"ts,omitempty"`     // when Claude Code recorded the line (RFC3339)
	Tokens int    `json:"tokens,omitempty"` // output tokens of the assistant message (first event only)
}

// rawLine is the slice of a transcript entry we read.
type rawLine struct {
	Type      string          `json:"type"`
	Timestamp string          `json:"timestamp"`
	Message   json.RawMessage `json:"message"`
}

type rawMsg struct {
	Role    string          `json:"role"`
	Content json.RawMessage `json:"content"`
	Usage   struct {
		OutputTokens int `json:"output_tokens"`
	} `json:"usage"`
}

type block struct {
	Type     string          `json:"type"`
	Text     string          `json:"text"`
	Thinking string          `json:"thinking"`
	Name     string          `json:"name"`
	Input    json.RawMessage `json:"input"`
	From     modelRef        `json:"from"`
	To       modelRef        `json:"to"`
}

type modelRef struct {
	Model string `json:"model"`
}

// Parse converts one transcript line into zero or more chat events.
// Returns nil for lines that carry nothing worth showing (tool-result
// echoes, system-wrapper prompts, empty blocks).
func Parse(line []byte) []Event {
	var r rawLine
	if json.Unmarshal(line, &r) != nil {
		return nil
	}
	if r.Type != "user" && r.Type != "assistant" {
		return nil
	}
	var m rawMsg
	if json.Unmarshal(r.Message, &m) != nil {
		return nil
	}
	role := r.Type

	// Content may be a bare string (early user prompts) or a block list.
	var asString string
	if json.Unmarshal(m.Content, &asString) == nil {
		if role == "user" && isSystemWrapper(asString) {
			return nil
		}
		body := strings.TrimSpace(asString)
		if body == "" {
			return nil
		}
		return []Event{{Role: role, Kind: "text", Text: body, TS: r.Timestamp}}
	}

	var blocks []block
	if json.Unmarshal(m.Content, &blocks) != nil {
		return nil
	}
	var out []Event
	for _, b := range blocks {
		switch b.Type {
		case "text":
			if role == "user" && isSystemWrapper(b.Text) {
				continue // block-form user content carries injections too
			}
			if t := strings.TrimSpace(b.Text); t != "" {
				out = append(out, Event{Role: role, Kind: "text", Text: t})
			}
		case "thinking":
			if t := strings.TrimSpace(b.Thinking); t != "" {
				out = append(out, Event{Role: "assistant", Kind: "thinking", Text: t})
			}
		case "tool_use":
			summary, detail := toolSummary(b.Name, b.Input)
			out = append(out, Event{Role: "tool", Kind: "tool", Tool: b.Name, Text: summary, Detail: detail})
		case "image":
			out = append(out, Event{Role: role, Kind: "image", Text: "🖼 image"})
		case "fallback":
			if b.From.Model != "" && b.To.Model != "" {
				out = append(out, Event{Role: "divider", Kind: "model-switch",
					Text: "model switched", Detail: prettyModel(b.From.Model) + " → " + prettyModel(b.To.Model)})
			}
		}
		// tool_result blocks are the tool's output echoed back to the
		// model; the tool line already stands for that exchange, so we
		// drop them from the chat view.
	}
	for i := range out {
		out[i].TS = r.Timestamp
	}
	// Usage belongs to the whole assistant message; stamp it on the
	// first event only so a client summing tokens never double-counts.
	if len(out) > 0 && role == "assistant" && m.Usage.OutputTokens > 0 {
		out[0].Tokens = m.Usage.OutputTokens
	}
	return out
}

// isSystemWrapper spots the machinery Claude Code injects as "user"
// turns — reminders, caveats, command wrappers — so they stay out of
// the human conversation.
func isSystemWrapper(s string) bool {
	t := strings.TrimSpace(s)
	if t == "" {
		return true
	}
	if strings.HasPrefix(t, "<") { // <system-reminder>, <local-command…>, <bash-input>…
		return true
	}
	if strings.HasPrefix(t, "Caveat:") || strings.HasPrefix(t, "[Request interrupted") {
		return true
	}
	// Skill/plugin bodies are injected as "user" turns when loaded.
	if strings.HasPrefix(t, "Base directory for this skill:") {
		return true
	}
	return false
}

// toolSummary renders a tool call as one readable line plus an optional
// detail, pulling the meaningful argument per tool.
func toolSummary(name string, input json.RawMessage) (string, string) {
	var m map[string]any
	_ = json.Unmarshal(input, &m)
	str := func(k string) string {
		if v, ok := m[k].(string); ok {
			return v
		}
		return ""
	}
	short := prettyTool(name)
	switch {
	case name == "Bash":
		return short, oneLine(str("command"), 120)
	case name == "Edit" || name == "Write" || name == "Read" || name == "NotebookEdit":
		return short, baseName(str("file_path"))
	case name == "Grep":
		return short, str("pattern")
	case name == "Glob":
		return short, str("pattern")
	case strings.HasPrefix(name, "mcp__"):
		return short, ""
	case name == "Task":
		return short, str("description")
	}
	return short, ""
}

func prettyTool(name string) string {
	if strings.HasPrefix(name, "mcp__") {
		parts := strings.Split(name, "__")
		return "⚙ " + parts[len(parts)-1]
	}
	icon := map[string]string{
		"Bash": "⚡", "Edit": "✎", "Write": "✎", "Read": "📖",
		"Grep": "🔎", "Glob": "🔎", "Task": "🤖", "TodoWrite": "☑",
	}[name]
	if icon == "" {
		icon = "•"
	}
	return icon + " " + name
}

func prettyModel(id string) string {
	id = strings.TrimPrefix(id, "claude-")
	if i := strings.Index(id, "-2"); i > 0 { // strip date suffix
		id = id[:i]
	}
	return id
}

func baseName(p string) string {
	if p == "" {
		return ""
	}
	if i := strings.LastIndexByte(p, '/'); i >= 0 {
		return p[i+1:]
	}
	return p
}

func oneLine(s string, max int) string {
	s = strings.TrimSpace(strings.ReplaceAll(s, "\n", " "))
	if len(s) > max {
		return s[:max-1] + "…"
	}
	return s
}
