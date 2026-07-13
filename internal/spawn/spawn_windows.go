//go:build windows

package spawn

import "errors"

// Launching a session needs a PTY; unsupported on Windows for now
// (same story as attach).
func Start(dir string, argv []string) (int, error) {
	return 0, errors.New("spawn: not supported on Windows yet")
}
