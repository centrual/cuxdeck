package main

// Start-at-login integration, cross-platform:
//
//	macOS   → ~/Library/LaunchAgents/com.centrual.cuxdeck.plist
//	Linux   → ~/.config/systemd/user/cuxdeck.service
//	Windows → HKCU\...\Run registry value (no admin required)
//
// `cuxdeck install` registers the running binary's own path, so a
// downloaded release works from wherever the user dropped it.

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
)

const serviceID = "com.centrual.cuxdeck"

// serviceInstalled reports whether start-at-login is currently
// registered, for the tray checkbox and the panel toggle.
func serviceInstalled() bool {
	switch runtime.GOOS {
	case "darwin":
		_, err := os.Stat(filepath.Join(os.Getenv("HOME"), "Library", "LaunchAgents", serviceID+".plist"))
		return err == nil
	case "linux":
		_, err := os.Stat(filepath.Join(os.Getenv("HOME"), ".config", "systemd", "user", "cuxdeck.service"))
		return err == nil
	case "windows":
		return exec.Command("reg", "query",
			`HKCU\Software\Microsoft\Windows\CurrentVersion\Run`, "/v", "cuxdeck").Run() == nil
	}
	return false
}

func installService() error {
	bin, err := os.Executable()
	if err != nil {
		return err
	}
	bin, _ = filepath.EvalSymlinks(bin)
	logPath := filepath.Join(home(), "cuxdeck.log")

	switch runtime.GOOS {
	case "darwin":
		dir := filepath.Join(os.Getenv("HOME"), "Library", "LaunchAgents")
		if err := os.MkdirAll(dir, 0o755); err != nil {
			return err
		}
		plist := filepath.Join(dir, serviceID+".plist")
		body := `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>` + serviceID + `</string>
  <key>ProgramArguments</key><array><string>` + bin + `</string></array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>` + logPath + `</string>
  <key>StandardErrorPath</key><string>` + logPath + `</string>
</dict></plist>
`
		if err := os.WriteFile(plist, []byte(body), 0o644); err != nil {
			return err
		}
		_ = exec.Command("launchctl", "unload", plist).Run() // refresh if present
		if out, err := exec.Command("launchctl", "load", plist).CombinedOutput(); err != nil {
			return fmt.Errorf("launchctl load: %v (%s)", err, out)
		}
		return nil

	case "linux":
		dir := filepath.Join(os.Getenv("HOME"), ".config", "systemd", "user")
		if err := os.MkdirAll(dir, 0o755); err != nil {
			return err
		}
		unit := filepath.Join(dir, "cuxdeck.service")
		body := `[Unit]
Description=cuxdeck — mission control for your cux fleet

[Service]
ExecStart=` + bin + `
Restart=on-failure
StandardOutput=append:` + logPath + `
StandardError=append:` + logPath + `

[Install]
WantedBy=default.target
`
		if err := os.WriteFile(unit, []byte(body), 0o644); err != nil {
			return err
		}
		if out, err := exec.Command("systemctl", "--user", "enable", "--now", "cuxdeck.service").CombinedOutput(); err != nil {
			return fmt.Errorf("systemctl: %v (%s)", err, out)
		}
		return nil

	case "windows":
		if out, err := exec.Command("reg", "add",
			`HKCU\Software\Microsoft\Windows\CurrentVersion\Run`,
			"/v", "cuxdeck", "/t", "REG_SZ", "/d", `"`+bin+`"`, "/f").CombinedOutput(); err != nil {
			return fmt.Errorf("reg add: %v (%s)", err, out)
		}
		return nil
	}
	return fmt.Errorf("start-at-login is not supported on %s yet", runtime.GOOS)
}

func uninstallService() error {
	switch runtime.GOOS {
	case "darwin":
		plist := filepath.Join(os.Getenv("HOME"), "Library", "LaunchAgents", serviceID+".plist")
		_ = exec.Command("launchctl", "unload", plist).Run()
		return os.Remove(plist)
	case "linux":
		_ = exec.Command("systemctl", "--user", "disable", "--now", "cuxdeck.service").Run()
		return os.Remove(filepath.Join(os.Getenv("HOME"), ".config", "systemd", "user", "cuxdeck.service"))
	case "windows":
		return exec.Command("reg", "delete",
			`HKCU\Software\Microsoft\Windows\CurrentVersion\Run`,
			"/v", "cuxdeck", "/f").Run()
	}
	return fmt.Errorf("unsupported platform %s", runtime.GOOS)
}
