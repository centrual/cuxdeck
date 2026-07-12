package cuxdata

import (
	"crypto/sha256"
	"encoding/hex"
	"runtime"
	"time"
)

// deckIDFile persists the deck's stable id under cux's data root so it
// survives restarts without a config of its own.
const deckIDFile = "cuxdeck-id"

// Snapshot reads everything the panel needs in one pass and stamps it
// with this machine's identity. The zero values of missing pieces
// (no projects, empty usage) are valid — a fresh cux install snapshots
// cleanly. version is the caller's build string.
//
// clock is injected so callers/tests control SnappedAt; pass time.Now.
func Snapshot(version string, clock func() time.Time) Deck {
	d := Deck{
		DeckID:    deckID(),
		Hostname:  hostname(),
		OS:        runtime.GOOS,
		Version:   version,
		SnappedAt: clock().UTC(),
		Sessions:  LoadSessions(),
		Usage:     LoadUsage(),
	}
	if st, err := LoadState(); err == nil {
		d.Accounts = st.Accounts
		d.Projects = st.Projects
		d.ActiveSlot = st.ActiveSlot
	}
	return d
}

// deckID derives a stable per-machine id. It is not a secret (auth is
// the device token); it only needs to be stable and collision-free
// across the handful of machines one person runs, so a hash of the
// hostname is enough and needs no persisted file.
func deckID() string {
	sum := sha256.Sum256([]byte("cuxdeck:" + hostname()))
	return hex.EncodeToString(sum[:])[:12]
}
