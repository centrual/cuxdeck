//go:build windows

package cuxdata

import "os"

// pidAlive reports whether a process with this PID still exists. On
// Windows FindProcess actually opens a handle, so an error means gone.
func pidAlive(pid int) bool {
	_, err := os.FindProcess(pid)
	return err == nil
}
