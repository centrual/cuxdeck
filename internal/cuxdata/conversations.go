package cuxdata

import (
	"bufio"
	"encoding/json"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"github.com/centrual/cuxdeck/internal/chat"
)

// Conversation is one Claude Code transcript on disk. Unlike Session it
// does not depend on the cux registry at all — it is discovered straight
// from ~/.claude/projects, so conversations started outside cux (desktop
// app tabs, plain `claude`) show up too, and a dead wrapper can never
// leave a ghost behind.
type Conversation struct {
	ID        string    `json:"id"`
	CWD       string    `json:"cwd"`
	Title     string    `json:"title"`
	UpdatedAt time.Time `json:"updatedAt"`
	Active    bool      `json:"active"` // transcript written within the last 2 minutes
	Path      string    `json:"-"`
}

// activeWindow is how recently a transcript must have been written to
// count as a live conversation. Claude Code appends on every turn, so a
// couple of minutes of silence means the session is idle or gone.
const activeWindow = 2 * time.Minute

// LoadConversations returns the most recently touched transcripts across
// every project, newest first.
func LoadConversations(limit int) []Conversation {
	root := ClaudeProjectsDir()
	dirs, err := os.ReadDir(root)
	if err != nil {
		return nil
	}
	var out []Conversation
	for _, d := range dirs {
		if !d.IsDir() {
			continue
		}
		files, err := os.ReadDir(filepath.Join(root, d.Name()))
		if err != nil {
			continue
		}
		for _, f := range files {
			if f.IsDir() || filepath.Ext(f.Name()) != ".jsonl" {
				continue
			}
			info, err := f.Info()
			if err != nil || info.Size() == 0 {
				continue
			}
			out = append(out, Conversation{
				ID:        strings.TrimSuffix(f.Name(), ".jsonl"),
				Path:      filepath.Join(root, d.Name(), f.Name()),
				UpdatedAt: info.ModTime(),
			})
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].UpdatedAt.After(out[j].UpdatedAt) })
	if limit > 0 && len(out) > limit {
		out = out[:limit]
	}
	for i := range out {
		out[i].CWD, out[i].Title = peekTranscript(out[i].Path)
		out[i].Active = time.Since(out[i].UpdatedAt) < activeWindow
	}
	return out
}

// FindTranscript resolves a conversation id to its transcript path, or ""
// if no project holds it. IDs are validated by the caller.
func FindTranscript(id string) string {
	root := ClaudeProjectsDir()
	dirs, err := os.ReadDir(root)
	if err != nil {
		return ""
	}
	for _, d := range dirs {
		if !d.IsDir() {
			continue
		}
		p := filepath.Join(root, d.Name(), id+".jsonl")
		if _, err := os.Stat(p); err == nil {
			return p
		}
	}
	return ""
}

// peekTranscript reads the head of a transcript for its working directory
// and a human title (the first real user message). Bounded so a huge
// transcript costs nothing.
func peekTranscript(path string) (cwd, title string) {
	f, err := os.Open(path)
	if err != nil {
		return "", ""
	}
	defer f.Close()
	sc := bufio.NewScanner(f)
	sc.Buffer(make([]byte, 0, 256*1024), 1024*1024)
	for lines := 0; sc.Scan() && lines < 300 && (cwd == "" || title == ""); lines++ {
		line := sc.Bytes()
		if cwd == "" {
			var meta struct {
				CWD string `json:"cwd"`
			}
			if json.Unmarshal(line, &meta) == nil && meta.CWD != "" {
				cwd = meta.CWD
			}
		}
		if title == "" {
			for _, ev := range chat.Parse(line) {
				if ev.Role == "user" && ev.Kind == "text" {
					title = firstLine(ev.Text, 90)
					break
				}
			}
		}
	}
	return cwd, title
}

func firstLine(s string, max int) string {
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
