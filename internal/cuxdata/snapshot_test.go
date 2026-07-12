package cuxdata

import (
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestSnapshotStampsIdentityAndIsStable(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	fixed := time.Date(2026, 7, 12, 4, 0, 0, 0, time.UTC)

	d := Snapshot("test", func() time.Time { return fixed })

	if d.DeckID == "" || len(d.DeckID) != 12 {
		t.Errorf("DeckID = %q, want a stable 12-char id", d.DeckID)
	}
	if d.Hostname == "" {
		t.Error("Hostname must never be empty")
	}
	if !d.SnappedAt.Equal(fixed) {
		t.Errorf("SnappedAt = %v, want injected clock %v", d.SnappedAt, fixed)
	}
	// Stable across calls on the same machine.
	if again := Snapshot("test", func() time.Time { return fixed }); again.DeckID != d.DeckID {
		t.Errorf("DeckID not stable: %q vs %q", d.DeckID, again.DeckID)
	}
}

func TestSnapshotToleratesEmptyCux(t *testing.T) {
	t.Setenv("HOME", t.TempDir()) // no ~/.cux at all
	d := Snapshot("test", time.Now)
	if len(d.Sessions) != 0 || len(d.Accounts) != 0 {
		t.Errorf("fresh machine should snapshot empty, got %+v", d)
	}
}

func TestSnapshotReadsState(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	cuxDir := filepath.Join(home, ".cux")
	if err := os.MkdirAll(cuxDir, 0o700); err != nil {
		t.Fatal(err)
	}
	state := `{"activeSlot":2,"accounts":{"2":{"slot":2,"email":"a@x.test"}},"projects":{"p":{"name":"p","dir":"/work","slots":[2]}}}`
	if err := os.WriteFile(filepath.Join(cuxDir, "state.json"), []byte(state), 0o600); err != nil {
		t.Fatal(err)
	}
	d := Snapshot("test", time.Now)
	if d.ActiveSlot != 2 || d.Accounts["2"].Email != "a@x.test" || d.Projects["p"].Dir != "/work" {
		t.Errorf("state not read into snapshot: %+v", d)
	}
}
