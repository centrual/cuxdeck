// Package usagelog records each seat's utilization over time so the
// panel can show a trend, not just the current number. cux exposes the
// live five-hour and seven-day percentages; nobody stores their
// history, so cuxdeck samples them on an interval into a small on-disk
// ring per seat (bounded, so it never grows without limit).
//
// It records utilization only — cux/Claude expose no dollar figure, so
// there is deliberately no "cost" here to invent.
package usagelog

import (
	"encoding/json"
	"os"
	"path/filepath"
	"sync"
	"time"

	"github.com/centrual/cuxdeck/internal/cuxdata"
)

// Point is one sample: unix seconds and the two window utilizations.
type Point struct {
	T     int64   `json:"t"`
	Five  float64 `json:"five"`
	Seven float64 `json:"seven"`
}

const maxPoints = 288 // 24h at a 5-minute sample; oldest fall off the front

// Store is the per-seat history, keyed by cux's usage cache key.
type Store struct {
	path string
	mu   sync.Mutex
	data map[string][]Point
}

func Open(dir string) *Store {
	s := &Store{path: filepath.Join(dir, "usage-history.json"), data: map[string][]Point{}}
	if b, err := os.ReadFile(s.path); err == nil {
		_ = json.Unmarshal(b, &s.data)
	}
	return s
}

// History returns a copy of every seat's samples for the API.
func (s *Store) History() map[string][]Point {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := make(map[string][]Point, len(s.data))
	for k, v := range s.data {
		cp := make([]Point, len(v))
		copy(cp, v)
		out[k] = cp
	}
	return out
}

// sample appends the current utilization for every seat that has data,
// coalescing samples closer together than half the interval (so a
// restart or a jittery clock can't double-log a moment).
func (s *Store) sample(now time.Time) {
	d := cuxdata.Snapshot("", time.Now)
	if len(d.Usage) == 0 {
		return
	}
	ts := now.Unix()
	s.mu.Lock()
	defer s.mu.Unlock()
	for key, u := range d.Usage {
		p := Point{T: ts}
		if u.FiveHour != nil {
			p.Five = u.FiveHour.Utilization
		}
		if u.SevenDay != nil {
			p.Seven = u.SevenDay.Utilization
		}
		series := s.data[key]
		series = append(series, p)
		if len(series) > maxPoints {
			series = series[len(series)-maxPoints:]
		}
		s.data[key] = series
	}
	s.save()
}

func (s *Store) save() {
	b, _ := json.Marshal(s.data)
	tmp := s.path + ".tmp"
	if os.WriteFile(tmp, b, 0o600) == nil {
		_ = os.Rename(tmp, s.path)
	}
}

// Run samples once per interval for the life of the process.
func (s *Store) Run(interval time.Duration) {
	for {
		time.Sleep(interval)
		s.sample(time.Now())
	}
}
