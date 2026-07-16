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

// TestRepairRenewsDeviceInPlace covers the per-device reconnect links:
// a repair code renews one device's token without creating a duplicate,
// preserving its id/name/role, and invalidating the old token.
func TestRepairRenewsDeviceInPlace(t *testing.T) {
	s := newTestStore(t)
	tok1, err := s.Pair(s.NewPairingCode(RoleView), "phone")
	if err != nil {
		t.Fatalf("initial pair: %v", err)
	}
	devs := s.DeviceList()
	if len(devs) != 1 {
		t.Fatalf("want 1 device, got %d", len(devs))
	}
	id := devs[0].ID

	code := s.NewRepairCode(id)
	if code == "" {
		t.Fatal("expected a repair code for a known device")
	}
	tok2, err := s.Pair(code, "some-other-name")
	if err != nil {
		t.Fatalf("re-pair: %v", err)
	}
	devs = s.DeviceList()
	if len(devs) != 1 {
		t.Fatalf("re-pair should not duplicate: got %d devices", len(devs))
	}
	if devs[0].ID != id || devs[0].Name != "phone" || devs[0].Role != RoleView {
		t.Fatalf("re-pair changed identity: %+v", devs[0])
	}
	if !s.Authenticate(tok2) {
		t.Fatal("new token should authenticate")
	}
	if s.Authenticate(tok1) {
		t.Fatal("old token should be invalid after re-pair")
	}
	if s.NewRepairCode("nope") != "" {
		t.Fatal("repair code for an unknown device should be empty")
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

// TestRevokeInvitePreventsUse is the core of the "cancel a link I
// haven't sent yet, or sent to the wrong person" feature: revoking a
// pending invite by its (non-secret) id kills the code it was issued
// under, before it's ever scanned.
func TestRevokeInvitePreventsUse(t *testing.T) {
	s := newTestStore(t)
	code, _ := s.NewInvite(RoleView)
	pending := s.PendingInvites()
	if len(pending) != 1 {
		t.Fatalf("want 1 pending invite, got %d", len(pending))
	}
	if pending[0].Role != RoleView {
		t.Fatalf("role = %q, want %q", pending[0].Role, RoleView)
	}
	s.RevokeInvite(pending[0].ID)
	if _, err := s.Pair(code, "late"); err != ErrBadPairing {
		t.Fatalf("revoked invite: got %v, want ErrBadPairing", err)
	}
	if got := s.PendingInvites(); len(got) != 0 {
		t.Fatalf("want 0 pending invites after revoke, got %d", len(got))
	}
}

// TestRevokeInviteIsIdempotent: revoking an unknown/already-used id must
// not panic or touch other outstanding invites.
func TestRevokeInviteIsIdempotent(t *testing.T) {
	s := newTestStore(t)
	code := s.NewPairingCode(RoleControl)
	s.RevokeInvite("not-a-real-id")
	if _, err := s.Pair(code, "still-good"); err != nil {
		t.Fatalf("unrelated invite should be unaffected: %v", err)
	}
}

// TestPendingInvitesExcludesRepairLinks: a per-device reconnect link
// isn't a user-facing "invite" and shouldn't show up (or be revocable)
// alongside ones minted from the Share sheet.
func TestPendingInvitesExcludesRepairLinks(t *testing.T) {
	s := newTestStore(t)
	_, err := s.Pair(s.NewPairingCode(RoleControl), "phone")
	if err != nil {
		t.Fatalf("pair: %v", err)
	}
	id := s.DeviceList()[0].ID
	if s.NewRepairCode(id) == "" {
		t.Fatal("expected a repair code")
	}
	if got := s.PendingInvites(); len(got) != 0 {
		t.Fatalf("repair links should not appear as pending invites, got %d", len(got))
	}
}

// TestPendingInvitesExcludesPlainPairingCodes: the menu bar, the panel's
// "add a phone" card, and tunnel-moved reconnect nudges all mint codes
// via NewPairingCode, not NewInvite. None of those are the user-facing
// invite links the Share sheet creates, so they must never show up (or
// be revocable) in PendingInvites — otherwise revoking one could kill a
// QR code a phone is mid-scan on.
func TestPendingInvitesExcludesPlainPairingCodes(t *testing.T) {
	s := newTestStore(t)
	s.NewPairingCode(RoleControl)
	s.NewPairingCode(RoleView)
	if got := s.PendingInvites(); len(got) != 0 {
		t.Fatalf("plain pairing codes should not appear as pending invites, got %d", len(got))
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
