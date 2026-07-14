// Package auth implements cuxdeck's device pairing and request
// authentication. The model is deliberately small:
//
//   - Pairing codes are short-lived, single-use, and only ever shown on
//     the machine itself (QR or terminal). Scanning one is the single
//     mandatory security step of the whole product.
//   - A successful pairing mints a long random per-device token. Only
//     its SHA-256 lands on disk; the token itself lives on the device.
//   - Any device can be revoked from the panel at any time.
//
// The tunnel URL is never the secret — this package is why a leaked
// URL is a dead end.
package auth

import (
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base32"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"sync"
	"time"
)

const (
	pairingTTL      = 10 * time.Minute
	maxFailureDelay = 8 * time.Second
	pairCodeLen     = 16 // base32 chars → 80 bits of entropy
)

// newCode returns a fresh random pairing code: pairCodeLen chars of
// crockford-ish base32, ~80 bits — infeasible to guess inside the
// 10-minute, single-use window.
func newCode() string {
	raw := make([]byte, 10) // 10 bytes = 80 bits = 16 base32 chars
	_, _ = rand.Read(raw)
	return base32.StdEncoding.WithPadding(base32.NoPadding).EncodeToString(raw)[:pairCodeLen]
}

// Device is one paired client (a phone, a tablet, a browser).
type Device struct {
	ID        string    `json:"id"`
	Name      string    `json:"name"`
	TokenHash string    `json:"tokenHash"`      // sha256 hex; the token never touches disk
	Role      string    `json:"role,omitempty"` // "view" | "control"; "" == control (pre-roles devices)
	CreatedAt time.Time `json:"createdAt"`
	LastSeen  time.Time `json:"lastSeen"`
}

// RoleControl is full access; RoleView is read-only (watch, but no
// switch/spawn/terminal/invite). A blank role means control, so
// devices paired before roles existed keep full access.
const (
	RoleControl = "control"
	RoleView    = "view"
)

func normRole(r string) string {
	if r == RoleView {
		return RoleView
	}
	return RoleControl
}

// Store holds paired devices on disk and pairing state in memory.
type Store struct {
	mu       sync.Mutex
	path     string
	devices  []Device
	pairings map[string]pairEntry // active single-use codes, keyed by code
	failures int                  // consecutive bad tokens → linear backoff
}

// pairEntry is one outstanding pairing code: the role it grants and when
// it expires. Codes live only in memory — short-lived secrets never
// touch disk — so a daemon restart naturally clears them. When device is
// non-empty the code re-pairs THAT device (renews its token) instead of
// creating a new one.
type pairEntry struct {
	role   string
	exp    time.Time
	device string
}

// DeviceInfo is the token-free view of a paired device.
type DeviceInfo struct {
	ID   string
	Name string
	Role string
}

// Open loads (or initialises) the device store at dir/devices.json.
func Open(dir string) (*Store, error) {
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return nil, err
	}
	s := &Store{path: filepath.Join(dir, "devices.json")}
	b, err := os.ReadFile(s.path)
	if err == nil {
		_ = json.Unmarshal(b, &s.devices)
	}
	return s, nil
}

func (s *Store) save() {
	b, err := json.MarshalIndent(s.devices, "", "  ")
	if err != nil {
		return
	}
	tmp := s.path + ".tmp"
	if err := os.WriteFile(tmp, b, 0o600); err != nil {
		return
	}
	_ = os.Rename(tmp, s.path)
}

// NewPairingCode returns a fresh single-use code (~80 bits, mostly used
// via QR/link but still typable by hand). Multiple codes can be
// outstanding at once: the menu bar, the panel's "add a phone" card, and
// the tunnel banner each mint their own, and a fresh mint must NOT
// invalidate a code a phone is mid-scan on.
func (s *Store) NewPairingCode(role string) string {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.prunePairings()
	code := newCode()
	if s.pairings == nil {
		s.pairings = make(map[string]pairEntry)
	}
	s.pairings[code] = pairEntry{role: normRole(role), exp: time.Now().Add(pairingTTL)}
	return code
}

// NewRepairCode mints a single-use code bound to an existing device:
// using it renews that device's token (same id/name/role) rather than
// creating a new one. Returns "" if the device is unknown. Used to hand
// each paired device its own reconnect link when the tunnel address
// changes.
func (s *Store) NewRepairCode(deviceID string) string {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.prunePairings()
	role, found := "", false
	for _, d := range s.devices {
		if d.ID == deviceID {
			role, found = normRole(d.Role), true
			break
		}
	}
	if !found {
		return ""
	}
	code := newCode()
	if s.pairings == nil {
		s.pairings = make(map[string]pairEntry)
	}
	s.pairings[code] = pairEntry{role: role, exp: time.Now().Add(pairingTTL), device: deviceID}
	return code
}

// DeviceList returns the paired devices without their token hashes, for
// callers that need to enumerate them (e.g. to address each by name).
func (s *Store) DeviceList() []DeviceInfo {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := make([]DeviceInfo, 0, len(s.devices))
	for _, d := range s.devices {
		out = append(out, DeviceInfo{ID: d.ID, Name: d.Name, Role: normRole(d.Role)})
	}
	return out
}

// prunePairings drops expired codes so the map can't grow without bound.
// Callers must hold s.mu.
func (s *Store) prunePairings() {
	now := time.Now()
	for c, e := range s.pairings {
		if now.After(e.exp) {
			delete(s.pairings, c)
		}
	}
}

// ErrBadPairing is returned for unknown, expired, or reused codes.
var ErrBadPairing = errors.New("auth: invalid or expired pairing code")

// Pair exchanges a valid pairing code for a device token. The code is
// consumed even on success — one scan, one device.
func (s *Store) Pair(code, name string) (token string, err error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.prunePairings()
	entry, ok := s.pairings[code]
	if !ok || time.Now().After(entry.exp) {
		return "", ErrBadPairing
	}
	role := normRole(entry.role)
	delete(s.pairings, code) // single use

	rawTok := make([]byte, 32)
	if _, err := rand.Read(rawTok); err != nil {
		return "", err
	}
	token = base64.RawURLEncoding.EncodeToString(rawTok)
	sum := sha256.Sum256([]byte(token))

	// Re-pair: a code bound to an existing device renews its token in
	// place (same id, name and role) instead of adding a duplicate. This
	// is what the "tunnel moved" links do — each device gets back onto
	// the new address as itself.
	if entry.device != "" {
		for i := range s.devices {
			if s.devices[i].ID == entry.device {
				s.devices[i].TokenHash = hex.EncodeToString(sum[:])
				s.devices[i].LastSeen = time.Now().UTC()
				s.save()
				return token, nil
			}
		}
		// The device was forgotten in the meantime — fall through and
		// create a fresh one so the code still works.
	}

	rawID := make([]byte, 6)
	_, _ = rand.Read(rawID)
	if name == "" {
		name = "device"
	}
	s.devices = append(s.devices, Device{
		ID:        hex.EncodeToString(rawID),
		Name:      name,
		TokenHash: hex.EncodeToString(sum[:]),
		Role:      role,
		CreatedAt: time.Now().UTC(),
		LastSeen:  time.Now().UTC(),
	})
	s.save()
	return token, nil
}

// Authenticate reports whether token belongs to a paired device, and
// applies a linear backoff to consecutive failures so brute force is
// pointless. It updates the device's LastSeen on success.
func (s *Store) Authenticate(token string) bool {
	sum := sha256.Sum256([]byte(token))
	want := hex.EncodeToString(sum[:])

	s.mu.Lock()
	for i := range s.devices {
		if subtle.ConstantTimeCompare([]byte(s.devices[i].TokenHash), []byte(want)) == 1 {
			s.failures = 0
			s.devices[i].LastSeen = time.Now().UTC()
			s.save()
			s.mu.Unlock()
			return true
		}
	}
	s.failures++
	delay := time.Duration(s.failures) * time.Second
	if delay > maxFailureDelay {
		delay = maxFailureDelay
	}
	// Sleep OUTSIDE the lock: the punishment is for the failing caller
	// only. Holding the mutex here would let a stale token's polling
	// serialize every other request — including the pairing attempt
	// that would fix the situation.
	s.mu.Unlock()
	time.Sleep(delay)
	return false
}

// Role returns the role of the device holding token, or "" if the
// token is unknown. A recognised device with a blank stored role is
// reported as control.
func (s *Store) Role(token string) string {
	sum := sha256.Sum256([]byte(token))
	want := hex.EncodeToString(sum[:])
	s.mu.Lock()
	defer s.mu.Unlock()
	for i := range s.devices {
		if subtle.ConstantTimeCompare([]byte(s.devices[i].TokenHash), []byte(want)) == 1 {
			return normRole(s.devices[i].Role)
		}
	}
	return ""
}

// Devices returns a copy of the paired-device list for the panel.
func (s *Store) Devices() []Device {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := make([]Device, len(s.devices))
	copy(out, s.devices)
	return out
}

// Revoke removes a device by id. Idempotent.
func (s *Store) Revoke(id string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := s.devices[:0]
	for _, d := range s.devices {
		if d.ID != id {
			out = append(out, d)
		}
	}
	s.devices = out
	s.save()
}
