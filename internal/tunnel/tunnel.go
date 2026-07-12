// Package tunnel gives cuxdeck its accountless public address. It
// downloads cloudflared once (kept under the cuxdeck home), spawns a
// Quick Tunnel pointed at the local server, extracts the random
// trycloudflare.com URL, and supervises the process: if the tunnel
// dies, it is rebuilt with backoff and the new URL is reported so the
// UI (and, later, Web Push) can tell paired devices where the panel
// moved.
package tunnel

import (
	"bufio"
	"context"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"runtime"
	"time"
)

var urlRE = regexp.MustCompile(`https://[a-z0-9-]+\.trycloudflare\.com`)

// Manager runs one supervised quick tunnel.
type Manager struct {
	LocalPort int
	Dir       string           // where cloudflared lives (e.g. ~/.cuxdeck/bin)
	OnURL     func(url string) // called on every (re)establishment
	Logf      func(format string, a ...any)
}

// binaryPath returns where the managed cloudflared lives.
func (m *Manager) binaryPath() string {
	name := "cloudflared"
	if runtime.GOOS == "windows" {
		name += ".exe"
	}
	return filepath.Join(m.Dir, name)
}

// downloadURL picks the official release asset for this platform.
func downloadURL() (string, error) {
	base := "https://github.com/cloudflare/cloudflared/releases/latest/download/"
	switch runtime.GOOS + "/" + runtime.GOARCH {
	case "darwin/arm64":
		return base + "cloudflared-darwin-arm64.tgz", nil
	case "darwin/amd64":
		return base + "cloudflared-darwin-amd64.tgz", nil
	case "linux/amd64":
		return base + "cloudflared-linux-amd64", nil
	case "linux/arm64":
		return base + "cloudflared-linux-arm64", nil
	case "windows/amd64":
		return base + "cloudflared-windows-amd64.exe", nil
	}
	return "", fmt.Errorf("tunnel: unsupported platform %s/%s", runtime.GOOS, runtime.GOARCH)
}

// EnsureBinary downloads cloudflared on first use. Downloads ride TLS
// from GitHub's official release; the binary is stored 0700 inside
// cuxdeck's own directory and never touches PATH.
func (m *Manager) EnsureBinary(ctx context.Context) error {
	if _, err := os.Stat(m.binaryPath()); err == nil {
		return nil
	}
	src, err := downloadURL()
	if err != nil {
		return err
	}
	m.logf("downloading cloudflared (first run only)…")
	if err := os.MkdirAll(m.Dir, 0o700); err != nil {
		return err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, src, nil)
	if err != nil {
		return err
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("tunnel: download failed: %s", resp.Status)
	}

	tmp := m.binaryPath() + ".download"
	defer os.Remove(tmp)
	if filepath.Ext(src) == ".tgz" {
		if err := extractTgzBinary(resp.Body, "cloudflared", tmp); err != nil {
			return err
		}
	} else {
		f, err := os.OpenFile(tmp, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o700)
		if err != nil {
			return err
		}
		if _, err := io.Copy(f, resp.Body); err != nil {
			f.Close()
			return err
		}
		f.Close()
	}
	if err := os.Chmod(tmp, 0o700); err != nil {
		return err
	}
	return os.Rename(tmp, m.binaryPath())
}

// Run supervises the tunnel until ctx is cancelled. Each successful
// (re)establishment invokes OnURL with the fresh address.
func (m *Manager) Run(ctx context.Context) {
	backoff := 2 * time.Second
	for ctx.Err() == nil {
		started := time.Now()
		err := m.runOnce(ctx)
		if ctx.Err() != nil {
			return
		}
		if time.Since(started) > time.Minute {
			backoff = 2 * time.Second // a healthy stretch resets the backoff
		}
		m.logf("tunnel dropped (%v) — rebuilding in %s", err, backoff)
		select {
		case <-ctx.Done():
			return
		case <-time.After(backoff):
		}
		if backoff < time.Minute {
			backoff *= 2
		}
	}
}

func (m *Manager) runOnce(ctx context.Context) error {
	cmd := exec.CommandContext(ctx, m.binaryPath(),
		"tunnel", "--url", fmt.Sprintf("http://127.0.0.1:%d", m.LocalPort),
		"--no-autoupdate")
	stderr, err := cmd.StderrPipe()
	if err != nil {
		return err
	}
	if err := cmd.Start(); err != nil {
		return err
	}
	// cloudflared prints the assigned URL on stderr as it connects.
	go func() {
		sc := bufio.NewScanner(stderr)
		sc.Buffer(make([]byte, 64*1024), 64*1024)
		for sc.Scan() {
			if u := urlRE.FindString(sc.Text()); u != "" && m.OnURL != nil {
				m.OnURL(u)
			}
		}
	}()
	return cmd.Wait()
}

func (m *Manager) logf(format string, a ...any) {
	if m.Logf != nil {
		m.Logf(format, a...)
	}
}
