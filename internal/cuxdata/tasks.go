package cuxdata

import (
	"encoding/json"
	"os"
	"path/filepath"
	"sort"
	"strconv"
)

// Task is one entry in Claude Code's on-disk task store
// (~/.claude/tasks/<session-id>/<n>.json). This store is the live,
// authoritative state: every session that resumes the conversation —
// including under a different account after a cux seat swap — updates
// these files. Reconstructing task state from a single transcript goes
// stale the moment another session touches the list; this never does.
type Task struct {
	ID      string `json:"id"`
	Subject string `json:"subject"`
	Status  string `json:"status"`
}

// TasksDir is where Claude Code keeps per-conversation task files.
func TasksDir() string {
	home, _ := os.UserHomeDir()
	return filepath.Join(home, ".claude", "tasks")
}

// LoadTasks reads the current task list for a conversation. ok reports
// whether the store exists for this id at all — an existing-but-empty
// dir means "no open tasks" (show nothing), while a missing dir means
// the CLI never wrote one (callers may fall back to transcript data).
func LoadTasks(id string) (tasks []Task, ok bool) {
	dir := filepath.Join(TasksDir(), id)
	entries, err := os.ReadDir(dir)
	if err != nil {
		return nil, false
	}
	for _, e := range entries {
		if e.IsDir() || filepath.Ext(e.Name()) != ".json" {
			continue
		}
		b, err := os.ReadFile(filepath.Join(dir, e.Name()))
		if err != nil {
			continue
		}
		var t Task
		if json.Unmarshal(b, &t) == nil && t.ID != "" {
			tasks = append(tasks, t)
		}
	}
	sort.Slice(tasks, func(i, j int) bool {
		a, errA := strconv.Atoi(tasks[i].ID)
		b, errB := strconv.Atoi(tasks[j].ID)
		if errA == nil && errB == nil {
			return a < b
		}
		return tasks[i].ID < tasks[j].ID
	})
	return tasks, true
}
