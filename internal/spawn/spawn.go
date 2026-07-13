//go:build !windows

// Package spawn launches a fresh cux session from the panel. cuxdeck
// starts `cux` on a pseudo-terminal it owns, in the chosen directory —
// which is exactly what makes cux open its own attach socket, so the
// new session immediately shows up in the registry as attachable and
// the existing terminal bridge can drive it.
//
// The PTY here is only there to make cux believe it has a terminal (it
// checks isatty); cuxdeck drains it and never reads it for content —
// the real mirror is cux's own attach socket. We size it large so a
// phone attaching later always wins the min-size negotiation and the
// terminal isn't clamped to 80x24.
//
// The spawned cux is a child of the long-lived cuxdeck daemon, so it
// outlives the phone that started it — close the tab, the session keeps
// running, exactly like starting cux in a terminal and walking away.
package spawn

import (
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"strings"
	"syscall"

	"github.com/creack/pty"
)

// Start launches `cux argv...` in dir on a fresh PTY and returns the
// child PID. dir must be an existing absolute directory. argv defaults
// to the flags a typical unattended run uses.
func Start(dir string, argv []string) (int, error) {
	if !strings.HasPrefix(dir, "/") {
		return 0, errors.New("spawn: directory must be an absolute path")
	}
	info, err := os.Stat(dir)
	if err != nil || !info.IsDir() {
		return 0, fmt.Errorf("spawn: not a directory: %s", dir)
	}
	bin, err := cuxPath()
	if err != nil {
		return 0, err
	}
	if len(argv) == 0 {
		argv = []string{"--dangerously-skip-permissions"}
	}

	cmd := exec.Command(bin, argv...)
	cmd.Dir = dir
	// A login-ish env so cux/claude find their config and PATH the same
	// way they would in a real terminal.
	cmd.Env = append(os.Environ(), "TERM=xterm-256color")

	ptmx, tty, err := pty.Open()
	if err != nil {
		return 0, fmt.Errorf("spawn: open pty: %w", err)
	}
	_ = pty.Setsize(ptmx, &pty.Winsize{Rows: 50, Cols: 200})
	cmd.Stdin, cmd.Stdout, cmd.Stderr = tty, tty, tty
	cmd.SysProcAttr = &syscall.SysProcAttr{Setsid: true, Setctty: true}

	if err := cmd.Start(); err != nil {
		_ = ptmx.Close()
		_ = tty.Close()
		return 0, fmt.Errorf("spawn: start cux: %w", err)
	}
	_ = tty.Close() // the child holds its own copy now

	// Drain the master so the child never blocks on a full PTY buffer;
	// we discard it because cux's attach socket is the real mirror.
	go func() { _, _ = io.Copy(io.Discard, ptmx) }()
	// Reap the child when it exits, and close the master then, so a
	// finished session doesn't linger as a zombie.
	go func() { _ = cmd.Wait(); _ = ptmx.Close() }()

	return cmd.Process.Pid, nil
}

func cuxPath() (string, error) {
	if p := os.Getenv("CUX_BIN"); p != "" {
		return p, nil
	}
	p, err := exec.LookPath("cux")
	if err != nil {
		return "", errors.New("spawn: `cux` not found on PATH (set CUX_BIN to point at it)")
	}
	return p, nil
}
