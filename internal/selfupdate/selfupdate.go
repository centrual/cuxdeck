// Package selfupdate checks GitHub for a newer cuxdeck release and, when
// asked, upgrades in place. It only ever *installs* through Homebrew —
// the same channel the app was shipped on — so a self-update is just
// `brew upgrade` plus a restart, never a hand-rolled binary swap. On a
// non-Homebrew install it reports the new version but leaves installing
// to the user.
package selfupdate

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

const repo = "centrual/cuxdeck"

// Latest returns the newest published release version (no leading "v").
func Latest(ctx context.Context) (string, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet,
		"https://api.github.com/repos/"+repo+"/releases/latest", nil)
	if err != nil {
		return "", err
	}
	req.Header.Set("Accept", "application/vnd.github+json")
	c := &http.Client{Timeout: 15 * time.Second}
	resp, err := c.Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return "", fmt.Errorf("github: %s", resp.Status)
	}
	var r struct {
		TagName string `json:"tag_name"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&r); err != nil {
		return "", err
	}
	return strings.TrimPrefix(r.TagName, "v"), nil
}

// Newer reports whether latest is a higher release than current. A
// non-release current ("dev", "") is never considered outdated — those
// are source builds, not something to auto-upgrade over.
func Newer(current, latest string) bool {
	if !isRelease(current) || !isRelease(latest) {
		return false
	}
	return cmpVer(latest, current) > 0
}

func isRelease(v string) bool {
	v = strings.TrimPrefix(strings.TrimSpace(v), "v")
	if v == "" || v == "dev" {
		return false
	}
	return v[0] >= '0' && v[0] <= '9'
}

func cmpVer(a, b string) int {
	pa, pb := parseVer(a), parseVer(b)
	for i := 0; i < 3; i++ {
		if pa[i] != pb[i] {
			if pa[i] > pb[i] {
				return 1
			}
			return -1
		}
	}
	return 0
}

func parseVer(v string) [3]int {
	var p [3]int
	core := strings.SplitN(strings.TrimPrefix(v, "v"), "-", 2)[0]
	for i, s := range strings.Split(core, ".") {
		if i > 2 {
			break
		}
		n, _ := strconv.Atoi(s)
		p[i] = n
	}
	return p
}

// brewPath returns the brew binary, or "" if none is found.
func brewPath() string {
	for _, p := range []string{"/opt/homebrew/bin/brew", "/usr/local/bin/brew"} {
		if _, err := os.Stat(p); err == nil {
			return p
		}
	}
	return ""
}

// BrewManaged reports whether this install came from the Homebrew cask
// (the only channel we can safely upgrade in place).
func BrewManaged() bool {
	for _, g := range []string{"/opt/homebrew/Caskroom/cuxdeck/*", "/usr/local/Caskroom/cuxdeck/*"} {
		if m, _ := filepath.Glob(g); len(m) > 0 {
			return true
		}
	}
	return false
}

// Method describes how an update would be applied on this install.
func Method() string {
	if BrewManaged() {
		return "homebrew"
	}
	return "manual"
}

// Upgrade runs `brew update` then `brew upgrade --cask cuxdeck`, and
// clears the quarantine flag off the freshly-installed app so launchd can
// exec the ad-hoc-signed binary. Only valid when BrewManaged. The caller
// restarts the process afterwards (launchd KeepAlive brings it back on a
// clean exit, now running the new binary).
func Upgrade(ctx context.Context) error {
	brew := brewPath()
	if brew == "" {
		return fmt.Errorf("selfupdate: brew not found")
	}
	// Refresh the tap so the newest cask is visible, then upgrade.
	if out, err := exec.CommandContext(ctx, brew, "update", "--quiet").CombinedOutput(); err != nil {
		return fmt.Errorf("brew update: %v: %s", err, out)
	}
	if out, err := exec.CommandContext(ctx, brew, "upgrade", "--cask", "cuxdeck").CombinedOutput(); err != nil {
		// Once the app has been launched, its quarantine flag was cleared
		// and its signature re-touched, so brew refuses to upgrade it
		// "as-is". A forced reinstall of the newest cask is the reliable
		// path in that (normal, post-first-run) state.
		if out2, err2 := exec.CommandContext(ctx, brew, "reinstall", "--cask", "--force", "cuxdeck").CombinedOutput(); err2 != nil {
			return fmt.Errorf("brew upgrade: %v: %s; reinstall: %v: %s", err, out, err2, out2)
		}
	}
	// Best-effort: strip quarantine so the LaunchAgent can relaunch it.
	_ = exec.CommandContext(ctx, "xattr", "-dr", "com.apple.quarantine", "/Applications/cuxdeck.app").Run()
	return nil
}
