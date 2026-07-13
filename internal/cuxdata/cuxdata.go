// Package cuxdata reads cux's on-disk state. cuxdeck never links cux
// (its packages are internal); the JSON files under ~/.cux are the
// contract, and mutations go through the cux CLI so business rules
// stay in one place.
package cuxdata

import (
	"encoding/json"
	"os"
	"path/filepath"
	"sort"
	"time"
)

// Root returns cux's data directory (~/.cux on macOS/Windows,
// $XDG_DATA_HOME/cux on Linux).
func Root() string {
	if xdg := os.Getenv("XDG_DATA_HOME"); xdg != "" {
		if fi, err := os.Stat(filepath.Join(xdg, "cux")); err == nil && fi.IsDir() {
			return filepath.Join(xdg, "cux")
		}
	}
	home, _ := os.UserHomeDir()
	return filepath.Join(home, ".cux")
}

type Account struct {
	Slot    int    `json:"slot"`
	Email   string `json:"email"`
	UUID    string `json:"uuid"`
	OrgUUID string `json:"orgUuid,omitempty"`
	Alias   string `json:"alias,omitempty"`
}

// CacheKey mirrors cux's per-seat usage-cache key.
func (a Account) CacheKey() string {
	if a.UUID != "" && a.OrgUUID != "" {
		return a.UUID + "|" + a.OrgUUID
	}
	if a.OrgUUID != "" {
		return a.OrgUUID
	}
	return a.Email
}

type Project struct {
	Name  string `json:"name"`
	Dir   string `json:"dir"`
	Slots []int  `json:"slots,omitempty"`
}

type State struct {
	ActiveSlot int                `json:"activeSlot"`
	Accounts   map[string]Account `json:"accounts"`
	Projects   map[string]Project `json:"projects,omitempty"`
}

func LoadState() (State, error) {
	var s State
	b, err := os.ReadFile(filepath.Join(Root(), "state.json"))
	if err != nil {
		return s, err
	}
	return s, json.Unmarshal(b, &s)
}

type Window struct {
	Utilization float64    `json:"utilization"`
	ResetsAt    *time.Time `json:"resets_at,omitempty"`
}

type AccountUsage struct {
	FiveHour     *Window   `json:"five_hour,omitempty"`
	SevenDay     *Window   `json:"seven_day,omitempty"`
	PolledAt     time.Time `json:"polled_at"`
	TokenExpired bool      `json:"token_expired,omitempty"`
}

func LoadUsage() map[string]AccountUsage {
	out := map[string]AccountUsage{}
	b, err := os.ReadFile(filepath.Join(Root(), "runtime", "usage-cache.json"))
	if err != nil {
		return out
	}
	_ = json.Unmarshal(b, &out)
	return out
}

// Session is one running cux wrapper, from the heartbeat registry.
type Session struct {
	PID        int       `json:"pid"`
	CWD        string    `json:"cwd"`
	SessionID  string    `json:"sessionId,omitempty"`
	Seat       string    `json:"seat,omitempty"`
	State      string    `json:"state"`
	Attachable bool      `json:"attachable,omitempty"`
	Detail     string    `json:"detail,omitempty"`
	StartedAt  time.Time `json:"startedAt"`
	UpdatedAt  time.Time `json:"updatedAt"`
}

func LoadSessions() []Session {
	dir := filepath.Join(Root(), "runtime", "sessions")
	entries, err := os.ReadDir(dir)
	if err != nil {
		return nil
	}
	var out []Session
	for _, e := range entries {
		if e.IsDir() || filepath.Ext(e.Name()) != ".json" {
			continue
		}
		b, err := os.ReadFile(filepath.Join(dir, e.Name()))
		if err != nil {
			continue
		}
		var s Session
		if json.Unmarshal(b, &s) != nil || s.PID == 0 {
			continue
		}
		// A wrapper that dies hard (SIGKILL, closed terminal) never gets
		// to remove its own file, so reap entries whose PID is gone —
		// otherwise ghosts of long-dead sessions pile up in the panel.
		if !pidAlive(s.PID) {
			_ = os.Remove(filepath.Join(dir, e.Name()))
			continue
		}
		out = append(out, s)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].StartedAt.Before(out[j].StartedAt) })
	return out
}

// ClaudeProjectsDir is where Claude Code stores session transcripts.
func ClaudeProjectsDir() string {
	home, _ := os.UserHomeDir()
	return filepath.Join(home, ".claude", "projects")
}
