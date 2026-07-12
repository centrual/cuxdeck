//go:build !windows

package cuxdata

import "syscall"

// pidAlive reports whether a process with this PID still exists. Signal 0
// performs the existence check without touching the process; EPERM still
// means "alive, just not ours".
func pidAlive(pid int) bool {
	err := syscall.Kill(pid, 0)
	return err == nil || err == syscall.EPERM
}
