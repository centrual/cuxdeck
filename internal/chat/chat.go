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
	Role   string `json:"role"`             // user | assistant | tool | task | ask | system | divider
	Kind   string `json:"kind,omitempty"`   // text | thinking | tool | image | model-switch | task-create | task-update | todos | question | answer | denied | interrupt
	Text   string `json:"text,omitempty"`   // bubble body / one-line tool summary
	Tool   string `json:"tool,omitempty"`   // tool name (Kind==tool) or task id (task events)
	Detail string `json:"detail,omitempty"` // secondary line (tool target, model names, options)
	Full   string `json:"full,omitempty"`   // expandable body (whole command, task prompt, result)
	ID     string `json:"id,omitempty"`     // tool_use id — pairs a result line with its call
	TS     string `json:"ts,omitempty"`     // when Claude Code recorded the line (RFC3339)
	Tokens int    `json:"tokens,omitempty"` // output tokens of the assistant message (first event only)
}

// rawLine is the slice of a transcript entry we read.
type rawLine struct {
	Type      string          `json:"type"`
	Timestamp string          `json:"timestamp"`
	Message   json.RawMessage `json:"message"`
	Operation string          `json:"operation"` // queue-operation lines
	Content   string          `json:"content"`   // queue-operation payload
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
	Content  json.RawMessage `json:"content"`     // tool_result payload
	ID       string          `json:"id"`          // tool_use id on the call
	ToolID   string          `json:"tool_use_id"` // tool_use id on the result
	IsError  bool            `json:"is_error"`
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
	// A message typed while Claude is busy is journaled as a queue
	// operation: enqueue when typed, remove when delivered. Rendering
	// both lets the panel show the pending state the CLI shows.
	if r.Type == "queue-operation" {
		text := strings.TrimSpace(r.Content)
		if text == "" {
			return nil
		}
		switch r.Operation {
		case "enqueue":
			return []Event{{Role: "user", Kind: "text", Text: text, Detail: "queued", TS: r.Timestamp}}
		case "remove", "dequeue":
			return []Event{{Role: "system", Kind: "queue-remove", Text: text, TS: r.Timestamp}}
		}
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
		out := textEvents(role, asString)
		for i := range out {
			out[i].TS = r.Timestamp
		}
		return out
	}

	var blocks []block
	if json.Unmarshal(m.Content, &blocks) != nil {
		return nil
	}
	var out []Event
	for _, b := range blocks {
		switch b.Type {
		case "text":
			out = append(out, textEvents(role, b.Text)...)
		case "thinking":
			if t := strings.TrimSpace(b.Thinking); t != "" {
				out = append(out, Event{Role: "assistant", Kind: "thinking", Text: t})
			}
		case "tool_use":
			out = append(out, toolEvents(b.Name, b.ID, b.Input)...)
		case "tool_result":
			out = append(out, resultEvents(b.Content, b.ToolID, b.IsError)...)
		case "image":
			out = append(out, Event{Role: role, Kind: "image", Text: "🖼 image"})
		case "fallback":
			if b.From.Model != "" && b.To.Model != "" {
				out = append(out, Event{Role: "divider", Kind: "model-switch",
					Text: "model switched", Detail: prettyModel(b.From.Model) + " → " + prettyModel(b.To.Model)})
			}
		}
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

// textEvents renders one text body. For assistant text that's just a
// bubble; user text is where Claude Code hides its machinery, so this
// recovers what a human actually did — mid-turn messages, slash
// commands, interrupts — and drops the rest of the wrapping.
func textEvents(role, s string) []Event {
	t := strings.TrimSpace(s)
	if t == "" {
		return nil
	}
	if role != "user" {
		return []Event{{Role: role, Kind: "text", Text: t}}
	}
	if strings.HasPrefix(t, "[Request interrupted") {
		return []Event{{Role: "divider", Kind: "interrupt", Text: "interrupted by user"}}
	}
	// A message typed while Claude was working arrives wrapped in a
	// system-reminder; surface it as the user bubble it really is.
	if strings.Contains(t, midTurnMarker) {
		if ev, ok := midTurnEvent(t); ok {
			return []Event{ev}
		}
		return nil
	}
	// Slash commands show up as caveat-wrapped XML; render the bar the
	// CLI shows ("> /model") instead of hiding the action entirely.
	if name := xmlField(t, "command-name"); name != "" {
		args := xmlField(t, "command-args")
		if args != "" {
			name += " " + args
		}
		return []Event{{Role: "divider", Kind: "command", Text: name}}
	}
	if isSystemWrapper(t) {
		return nil
	}
	return []Event{{Role: "user", Kind: "text", Text: t}}
}

// xmlField pulls <tag>value</tag> out of a wrapper blob, "" if absent.
func xmlField(s, tag string) string {
	open, close := "<"+tag+">", "</"+tag+">"
	i := strings.Index(s, open)
	if i < 0 {
		return ""
	}
	rest := s[i+len(open):]
	j := strings.Index(rest, close)
	if j < 0 {
		return ""
	}
	return strings.TrimSpace(rest[:j])
}

// toolEvents renders a tool_use block. Task-list and question tools get
// structured events so the panel can show live checklists and question
// cards; everything else becomes a one-line tool call with an optional
// expandable body.
func toolEvents(name, id string, input json.RawMessage) []Event {
	switch name {
	case "TaskCreate":
		// The canonical create event comes from the tool result, which
		// carries the assigned id; emitting here too would duplicate.
		return nil
	case "TaskUpdate":
		var in struct {
			TaskID  string `json:"taskId"`
			Status  string `json:"status"`
			Subject string `json:"subject"`
		}
		if json.Unmarshal(input, &in) != nil || in.TaskID == "" {
			return nil
		}
		return []Event{{Role: "task", Kind: "task-update", Tool: in.TaskID, Text: in.Status, Detail: in.Subject}}
	case "TodoWrite":
		var in struct {
			Todos []struct {
				Content string `json:"content"`
				Status  string `json:"status"`
			} `json:"todos"`
		}
		if json.Unmarshal(input, &in) != nil || len(in.Todos) == 0 {
			return nil
		}
		b, _ := json.Marshal(in.Todos)
		return []Event{{Role: "task", Kind: "todos", Text: string(b)}}
	case "AskUserQuestion":
		var in struct {
			Questions []struct {
				Question string `json:"question"`
				Header   string `json:"header"`
				Options  []struct {
					Label string `json:"label"`
				} `json:"options"`
			} `json:"questions"`
		}
		if json.Unmarshal(input, &in) != nil {
			return nil
		}
		var out []Event
		for _, q := range in.Questions {
			var labels []string
			for _, o := range q.Options {
				labels = append(labels, o.Label)
			}
			out = append(out, Event{Role: "ask", Kind: "question", Text: q.Question,
				Tool: q.Header, Detail: strings.Join(labels, " · ")})
		}
		return out
	}
	summary, detail, full := toolSummary(name, input)
	return []Event{{Role: "tool", Kind: "tool", Tool: name, Text: summary, Detail: detail, Full: full, ID: id}}
}

const midTurnMarker = "The user sent a new message while you were working:"

// midTurnEvent extracts the human message from a mid-turn wrapper —
// found either as its own user turn or appended to a tool result.
func midTurnEvent(t string) (Event, bool) {
	i := strings.Index(t, midTurnMarker)
	if i < 0 {
		return Event{}, false
	}
	msg := t[i+len(midTurnMarker):]
	if j := strings.Index(msg, "This is how Claude Code surfaces"); j >= 0 {
		msg = msg[:j]
	}
	if j := strings.Index(msg, "</system-reminder>"); j >= 0 {
		msg = msg[:j]
	}
	if msg = strings.TrimSpace(msg); msg != "" {
		return Event{Role: "user", Kind: "text", Text: msg, Detail: "sent mid-turn"}, true
	}
	return Event{}, false
}

// resultEvents renders a tool_result the way the CLI does: a one-line
// "⎿" summary attached (by tool_use id) under its call, expandable to
// the head of the real output. Results that mean something more —
// task creation, answered questions, permission denials, mid-turn user
// messages appended to an output — additionally emit their structured
// events.
func resultEvents(content json.RawMessage, toolID string, isError bool) []Event {
	t := resultText(content)
	var out []Event
	if ev, ok := midTurnEvent(t); ok {
		out = append(out, ev)
		// The reminder is bookkeeping appended to the real output; strip
		// it so the summary below shows only what the tool returned.
		if i := strings.Index(t, "<system-reminder>"); i >= 0 {
			t = t[:i]
		}
	}
	switch {
	case strings.HasPrefix(t, "Task #") && strings.Contains(t, " created successfully: "):
		rest := t[len("Task #"):]
		i := strings.Index(rest, " created successfully: ")
		id, subject := rest[:i], strings.TrimSpace(rest[i+len(" created successfully: "):])
		if j := strings.IndexByte(subject, '\n'); j >= 0 {
			subject = subject[:j]
		}
		out = append(out, Event{Role: "task", Kind: "task-create", Tool: id, Text: subject})
	case strings.HasPrefix(t, "Your questions have been answered:"):
		out = append(out, Event{Role: "ask", Kind: "answer", Text: askAnswers(t)})
		return out
	case strings.Contains(t, "doesn't want to proceed with this tool use"):
		out = append(out, Event{Role: "result", Kind: "denied", ID: toolID,
			Text: "No — user declined this action"})
		return out
	}
	if sum, full, more := resultSummary(t); sum != "" {
		kind := "result"
		if isError {
			kind = "error"
		}
		out = append(out, Event{Role: "result", Kind: kind, ID: toolID, Text: sum, Detail: more, Full: full})
	}
	return out
}

// resultSummary condenses an output to its first meaningful line plus a
// "+N lines" note, and keeps a bounded body for the expanded view.
func resultSummary(t string) (sum, full, more string) {
	t = strings.TrimSpace(t)
	if t == "" {
		return "", "", ""
	}
	lines := strings.Split(t, "\n")
	sum = oneLine(lines[0], 110)
	if n := len(lines) - 1; n > 0 {
		more = "+" + itoa(n) + " lines"
	}
	return sum, clip(t, 3000), more
}

func itoa(n int) string {
	if n == 0 {
		return "0"
	}
	var b [20]byte
	i := len(b)
	for n > 0 {
		i--
		b[i] = byte('0' + n%10)
		n /= 10
	}
	return string(b[i:])
}

// resultText flattens a tool_result content payload (bare string or a
// list of text blocks) to plain text.
func resultText(content json.RawMessage) string {
	var s string
	if json.Unmarshal(content, &s) == nil {
		return s
	}
	var blocks []struct {
		Type string `json:"type"`
		Text string `json:"text"`
	}
	if json.Unmarshal(content, &blocks) != nil {
		return ""
	}
	var sb strings.Builder
	for _, b := range blocks {
		if b.Type == "text" {
			sb.WriteString(b.Text)
			sb.WriteByte('\n')
		}
	}
	return sb.String()
}

// askAnswers extracts the chosen answers from an AskUserQuestion result
// ('"question"="answer". ...' pairs), falling back to the raw text.
func askAnswers(t string) string {
	var answers []string
	rest := t
	for {
		i := strings.Index(rest, `="`)
		if i < 0 {
			break
		}
		rest = rest[i+2:]
		j := strings.IndexByte(rest, '"')
		if j < 0 {
			break
		}
		answers = append(answers, rest[:j])
		rest = rest[j+1:]
	}
	if len(answers) == 0 {
		return firstLineOf(strings.TrimPrefix(t, "Your questions have been answered:"), 160)
	}
	return strings.Join(answers, " · ")
}

func firstLineOf(s string, max int) string {
	s = strings.TrimSpace(s)
	if i := strings.IndexByte(s, '\n'); i >= 0 {
		s = s[:i]
	}
	r := []rune(s)
	if len(r) > max {
		return string(r[:max]) + "…"
	}
	return s
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
// detail, pulling the meaningful argument per tool. full, when set, is
// the expandable body behind the one-liner (the whole command, the
// subagent prompt) so the panel can show what the CLI shows.
func toolSummary(name string, input json.RawMessage) (summary, detail, full string) {
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
		cmd := str("command")
		return short, oneLine(cmd, 120), clip(cmd, 2000)
	case name == "Edit" || name == "Write" || name == "Read" || name == "NotebookEdit":
		return short, baseName(str("file_path")), str("file_path")
	case name == "Grep":
		return short, str("pattern"), ""
	case name == "Glob":
		return short, str("pattern"), ""
	case strings.HasPrefix(name, "mcp__"):
		b, _ := json.Marshal(m)
		return short, "", clip(string(b), 600)
	case name == "Task" || name == "Agent":
		return short, str("description"), clip(str("prompt"), 800)
	case name == "Skill":
		return short, str("skill"), ""
	}
	return short, "", ""
}

// clip bounds an expandable body without losing its shape.
func clip(s string, max int) string {
	s = strings.TrimSpace(s)
	r := []rune(s)
	if len(r) > max {
		return string(r[:max]) + "\n…"
	}
	return s
}

func prettyTool(name string) string {
	if strings.HasPrefix(name, "mcp__") {
		parts := strings.Split(name, "__")
		return "⚙ " + parts[len(parts)-1]
	}
	icon := map[string]string{
		"Bash": "⚡", "Edit": "✎", "Write": "✎", "Read": "📖",
		"Grep": "🔎", "Glob": "🔎", "Task": "🤖", "Agent": "🤖",
		"Skill": "✦", "WebFetch": "🌐", "WebSearch": "🌐", "TodoWrite": "☑",
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
