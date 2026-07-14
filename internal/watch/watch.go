// Package watch turns changes in cux's state into push notifications.
// It polls the same on-disk snapshot the panel reads, diffs it against
// the previous poll, and fires the handful of events worth waking a
// phone for — the ones a person actually wants to know about while
// away from the keyboard.
package watch

import (
	"time"

	"github.com/centrual/cuxdeck/internal/cuxdata"
	"github.com/centrual/cuxdeck/internal/i18n"
	"github.com/centrual/cuxdeck/internal/notify"
)

// prev is the slice of the previous snapshot we compare against.
type prev struct {
	sessions  map[int]sessState // pid -> last seen
	expired   map[string]bool   // seat cacheKey -> was token-expired
	exhausted bool              // were all seats at their ceiling last time
	seen      bool              // have we taken a first snapshot yet
}

type sessState struct {
	state string
	seat  string
	dir   string
	start time.Time
}

// fan delivers one event to several channels and reports whether any
// has a recipient, so the watcher does nothing when all are empty.
type fan []notify.Notifier

func (f fan) Notify(ev notify.Event) {
	for _, n := range f {
		if n != nil && n.Has() {
			n.Notify(ev)
		}
	}
}
func (f fan) Has() bool {
	for _, n := range f {
		if n != nil && n.Has() {
			return true
		}
	}
	return false
}

// Run polls every interval and notifies via every target. It never
// fires on the first snapshot (that would announce state that predates
// the phone) and does nothing while no channel has a recipient.
// lang, when non-nil, returns the language code (tr/fr/de/it/en) the
// user picked in the panel, so notifications go out in that language.
func Run(targets []notify.Notifier, interval time.Duration, lang func() string) {
	p := fan(targets)
	pr := prev{sessions: map[int]sessState{}, expired: map[string]bool{}}
	for {
		time.Sleep(interval)
		lg := ""
		if lang != nil {
			lg = lang()
		}
		if !p.Has() {
			// Nobody listening — keep the baseline current so we don't
			// dump a backlog of transitions when someone subscribes.
			pr = snapshotInto(pr, false, p, lg)
			continue
		}
		pr = snapshotInto(pr, pr.seen, p, lg)
	}
}

func snapshotInto(pr prev, emit bool, p notify.Notifier, lg string) prev {
	d := cuxdata.Snapshot("", time.Now)

	cur := map[int]sessState{}
	for _, s := range d.Sessions {
		cur[s.PID] = sessState{state: s.State, seat: shortSeat(s.Seat), dir: shortDir(s.CWD), start: s.StartedAt}
	}

	if emit {
		// per-session transitions
		for pid, now := range cur {
			was, existed := pr.sessions[pid]
			if !existed {
				continue // brand-new session isn't itself notable
			}
			if was.state != now.state {
				seat := i18n.T(lg, " · seat ") + now.seat
				switch now.state {
				case "retrying":
					p.Notify(notify.Event{Title: i18n.T(lg, "API trouble — retrying"), Body: now.dir + seat, Tag: "retry-" + itoa(pid)})
				case "waiting-reset":
					p.Notify(notify.Event{Title: i18n.T(lg, "All limits hit — waiting for reset"), Body: now.dir + seat, Tag: "wait-" + itoa(pid)})
				case "running":
					if was.state == "retrying" {
						p.Notify(notify.Event{Title: i18n.T(lg, "Recovered — back to work"), Body: now.dir + seat, Tag: "retry-" + itoa(pid)})
					} else if was.state == "waiting-reset" {
						p.Notify(notify.Event{Title: i18n.T(lg, "Limits reset — resumed"), Body: now.dir + seat, Tag: "wait-" + itoa(pid)})
					}
				}
			}
		}
		// finished sessions
		for pid, was := range pr.sessions {
			if _, still := cur[pid]; !still {
				p.Notify(notify.Event{Title: i18n.T(lg, "Session finished"), Body: was.dir + i18n.T(lg, " · ran ") + dur(time.Since(was.start)), Tag: "done-" + itoa(pid)})
			}
		}
		// seat needs re-login
		for key, u := range d.Usage {
			if u.TokenExpired && !pr.expired[key] {
				p.Notify(notify.Event{Title: i18n.T(lg, "A seat needs re-login"), Body: i18n.T(lg, "Sign in again on the computer to keep the pool full"), Tag: "relogin"})
			}
		}
		// all seats exhausted (edge-triggered)
		exh := allExhausted(d)
		if exh && !pr.exhausted {
			p.Notify(notify.Event{Title: i18n.T(lg, "Every seat is exhausted"), Body: resetHint(d, lg), Tag: "exhausted"})
		}
	}

	nx := prev{sessions: cur, expired: map[string]bool{}, exhausted: allExhausted(d), seen: true}
	for key, u := range d.Usage {
		nx.expired[key] = u.TokenExpired
	}
	return nx
}

// allExhausted is true when there is usage data and no account has any
// headroom in either window.
func allExhausted(d cuxdata.Deck) bool {
	if len(d.Usage) == 0 {
		return false
	}
	for _, u := range d.Usage {
		if !atCeiling(u) {
			return false
		}
	}
	return true
}

func atCeiling(u cuxdata.AccountUsage) bool {
	full := func(w *cuxdata.Window) bool { return w != nil && w.Utilization >= 100 }
	return full(u.FiveHour) || full(u.SevenDay)
}

// resetHint names the earliest window that will free up, if known.
func resetHint(d cuxdata.Deck, lg string) string {
	var earliest *time.Time
	for _, u := range d.Usage {
		for _, w := range []*cuxdata.Window{u.FiveHour, u.SevenDay} {
			if w != nil && w.ResetsAt != nil && (earliest == nil || w.ResetsAt.Before(*earliest)) {
				earliest = w.ResetsAt
			}
		}
	}
	if earliest == nil {
		return i18n.T(lg, "Waiting for a window to reset")
	}
	return i18n.T(lg, "Frees up in ") + dur(time.Until(*earliest))
}

/* ---------- tiny local helpers (no deps) ---------- */

func shortSeat(s string) string {
	for i := 0; i < len(s); i++ {
		if s[i] == '@' {
			return s[:i]
		}
	}
	return s
}

func shortDir(d string) string {
	n, last, prev := 0, len(d), -1
	for i := len(d) - 1; i >= 0; i-- {
		if d[i] == '/' {
			n++
			if n == 1 {
				last = i
			} else if n == 2 {
				prev = i
				break
			}
		}
	}
	if prev >= 0 {
		return "…" + d[prev:]
	}
	_ = last
	return d
}

func dur(d time.Duration) string {
	if d < time.Minute {
		return itoa(int(d.Seconds())) + "s"
	}
	if d < time.Hour {
		return itoa(int(d.Minutes())) + "m"
	}
	h := int(d.Hours())
	return itoa(h) + "h " + itoa(int(d.Minutes())-h*60) + "m"
}

func itoa(n int) string {
	if n == 0 {
		return "0"
	}
	neg := n < 0
	if neg {
		n = -n
	}
	var b [20]byte
	i := len(b)
	for n > 0 {
		i--
		b[i] = byte('0' + n%10)
		n /= 10
	}
	if neg {
		i--
		b[i] = '-'
	}
	return string(b[i:])
}
