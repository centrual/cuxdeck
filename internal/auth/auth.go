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
)

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
	pairing  string    // active single-use code, "" when none
	pairRole string    // role the active code will grant
	pairExp  time.Time // when the active code dies
	failures int       // consecutive bad tokens → linear backoff
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

// NewPairingCode invalidates any previous code and returns a fresh
// one: 10 chars of crockford-ish base32, comfortable to type by hand
// when there is no camera, ~50 bits — plenty for a 10-minute window
// behind exponential backoff.
func (s *Store) NewPairingCode(role string) string {
	s.mu.Lock()
	defer s.mu.Unlock()
	raw := make([]byte, 7)
	_, _ = rand.Read(raw)
	code := base32.StdEncoding.WithPadding(base32.NoPadding).EncodeToString(raw)[:10]
	s.pairing = code
	s.pairRole = normRole(role)
	s.pairExp = time.Now().Add(pairingTTL)
	return code
}

// ErrBadPairing is returned for unknown, expired, or reused codes.
var ErrBadPairing = errors.New("auth: invalid or expired pairing code")

// Pair exchanges a valid pairing code for a device token. The code is
// consumed even on success — one scan, one device.
func (s *Store) Pair(code, name string) (token string, err error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.pairing == "" || time.Now().After(s.pairExp) ||
		subtle.ConstantTimeCompare([]byte(code), []byte(s.pairing)) != 1 {
		return "", ErrBadPairing
	}
	role := normRole(s.pairRole)
	s.pairing = "" // single use

	rawTok := make([]byte, 32)
	if _, err := rand.Read(rawTok); err != nil {
		return "", err
	}
	token = base64.RawURLEncoding.EncodeToString(rawTok)
	sum := sha256.Sum256([]byte(token))
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
