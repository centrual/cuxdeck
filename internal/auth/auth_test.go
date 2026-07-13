package auth

import (
	"testing"
	"time"
)

func newTestStore(t *testing.T) *Store {
	t.Helper()
	s, err := Open(t.TempDir())
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	return s
}

func TestPairRoundTrip(t *testing.T) {
	s := newTestStore(t)
	tok, err := s.Pair(s.NewPairingCode(RoleControl), "phone")
	if err != nil {
		t.Fatalf("Pair: %v", err)
	}
	if tok == "" {
		t.Fatal("expected a non-empty token")
	}
	if got := s.Role(tok); got != RoleControl {
		t.Fatalf("role = %q, want %q", got, RoleControl)
	}
}

// TestConcurrentCodesDoNotEvictEachOther is the regression guard for the
// bug where minting a second code invalidated the first — so a phone
// mid-scan on one QR got "invalid or expired" the moment the menu bar,
// the panel card, or a tunnel reconnect minted another code.
func TestConcurrentCodesDoNotEvictEachOther(t *testing.T) {
	s := newTestStore(t)
	c1 := s.NewPairingCode(RoleControl)
	c2 := s.NewPairingCode(RoleView)
	c3 := s.NewPairingCode(RoleControl)
	if c1 == c2 || c2 == c3 || c1 == c3 {
		t.Fatal("distinct mints must produce distinct codes")
	}
	for i, c := range []string{c1, c2, c3} {
		if _, err := s.Pair(c, "device"); err != nil {
			t.Fatalf("code %d was invalidated by a later mint: %v", i+1, err)
		}
	}
}

func TestPairIsSingleUse(t *testing.T) {
	s := newTestStore(t)
	code := s.NewPairingCode(RoleControl)
	if _, err := s.Pair(code, "a"); err != nil {
		t.Fatalf("first pair: %v", err)
	}
	if _, err := s.Pair(code, "b"); err != ErrBadPairing {
		t.Fatalf("reuse: got %v, want ErrBadPairing", err)
	}
}

func TestPairRejectsUnknownCode(t *testing.T) {
	s := newTestStore(t)
	if _, err := s.Pair("NOTAREALCODE", "x"); err != ErrBadPairing {
		t.Fatalf("unknown code: got %v, want ErrBadPairing", err)
	}
}

func TestPairRejectsExpiredCode(t *testing.T) {
	s := newTestStore(t)
	code := s.NewPairingCode(RoleControl)
	s.mu.Lock()
	e := s.pairings[code]
	e.exp = time.Now().Add(-time.Second)
	s.pairings[code] = e
	s.mu.Unlock()
	if _, err := s.Pair(code, "x"); err != ErrBadPairing {
		t.Fatalf("expired code: got %v, want ErrBadPairing", err)
	}
}

func TestPairPreservesViewRole(t *testing.T) {
	s := newTestStore(t)
	tok, err := s.Pair(s.NewPairingCode(RoleView), "viewer")
	if err != nil {
		t.Fatalf("pair: %v", err)
	}
	if got := s.Role(tok); got != RoleView {
		t.Fatalf("role = %q, want %q", got, RoleView)
	}
}

// TestExpiredCodesArePruned checks the map can't grow without bound:
// expired codes are dropped on the next mint.
func TestExpiredCodesArePruned(t *testing.T) {
	s := newTestStore(t)
	old := s.NewPairingCode(RoleControl)
	s.mu.Lock()
	e := s.pairings[old]
	e.exp = time.Now().Add(-time.Second)
	s.pairings[old] = e
	s.mu.Unlock()

	s.NewPairingCode(RoleControl) // triggers prune

	s.mu.Lock()
	_, stillThere := s.pairings[old]
	n := len(s.pairings)
	s.mu.Unlock()
	if stillThere {
		t.Fatal("expired code should have been pruned")
	}
	if n != 1 {
		t.Fatalf("expected only the fresh code to remain, got %d", n)
	}
}
