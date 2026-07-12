package cuxdata

import (
	"os"
	"time"
)

// Deck is the identity and full snapshot of one machine's cux state.
// Every API response carries a Deck so the phone can namespace it: the
// fleet view is assembled client-side by merging the snapshots from
// several decks, with no central server holding them. DeckID is stable
// per machine+install so a deck keeps its identity across restarts and
// tunnel-address changes.
type Deck struct {
	DeckID    string    `json:"deckId"`   // stable machine+install identifier
	Hostname  string    `json:"hostname"` // human label in the fleet view
	OS        string    `json:"os"`
	Version   string    `json:"version"` // cuxdeck version serving this deck
	SnappedAt time.Time `json:"snappedAt"`

	Sessions   []Session               `json:"sessions"`
	Accounts   map[string]Account      `json:"accounts"`
	Usage      map[string]AccountUsage `json:"usage"`
	Projects   map[string]Project      `json:"projects,omitempty"`
	ActiveSlot int                     `json:"activeSlot"`
}

// Hostname returns the machine's name, falling back to a constant so a
// deck is never anonymous in the fleet list.
func hostname() string {
	if h, err := os.Hostname(); err == nil && h != "" {
		return h
	}
	return "unknown-host"
}
