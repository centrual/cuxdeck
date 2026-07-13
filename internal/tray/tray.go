// Package tray puts cuxdeck in the menu bar: the mascot icon, and a
// menu to open the panel, copy a pairing link, toggle start-at-login,
// and quit. It's the "it's a real app, not a terminal command" layer.
//
// systray owns the main thread, so Run blocks; the daemon runs in the
// callback. Everything the menu needs from the daemon comes through the
// Deps struct, so this package stays free of the server/service code.
package tray

import (
	_ "embed"
	"os/exec"
	"runtime"

	"fyne.io/systray"
)

//go:generate go run ../../tools/buildicon

//go:embed icon.png
var iconPNG []byte

// Deps is what the menu needs from the rest of the app.
type Deps struct {
	// CurrentURL returns the address to open — the tunnel URL if up,
	// else the local one.
	CurrentURL func() string
	// PairingLink mints a fresh single-use pairing link to share.
	PairingLink func() string
	// StartAtLoginState / SetStartAtLogin read and flip the OS
	// start-at-login registration.
	StartAtLoginState func() bool
	SetStartAtLogin   func(on bool) error
	// OnQuit runs before the process exits (graceful shutdown).
	OnQuit func()
}

// Run shows the menu-bar icon and blocks until Quit. daemon is started
// once the tray is ready (systray must own the main goroutine).
func Run(d Deps, daemon func()) {
	started := false
	onReady := func() {
		systray.SetIcon(iconPNG)
		systray.SetTooltip("cuxdeck — mission control for your cux fleet")

		mOpen := systray.AddMenuItem("Open panel · pair a phone", "Open the panel here — scan the QR with your phone")
		mPair := systray.AddMenuItem("Copy pairing link", "Copy a fresh one-time link to add a device")
		systray.AddSeparator()
		mLogin := systray.AddMenuItemCheckbox("Start at login", "Launch cuxdeck when this computer starts", false)
		systray.AddSeparator()
		mQuit := systray.AddMenuItem("Quit cuxdeck", "Stop the deck")

		if d.StartAtLoginState != nil && d.StartAtLoginState() {
			mLogin.Check()
		}

		if !started {
			started = true
			go daemon()
		}

		go func() {
			for {
				select {
				case <-mOpen.ClickedCh:
					if d.CurrentURL != nil {
						openURL(d.CurrentURL())
					}
				case <-mPair.ClickedCh:
					if d.PairingLink != nil {
						copyToClipboard(d.PairingLink())
					}
				case <-mLogin.ClickedCh:
					if d.SetStartAtLogin == nil {
						break
					}
					on := !mLogin.Checked()
					if err := d.SetStartAtLogin(on); err == nil {
						if on {
							mLogin.Check()
						} else {
							mLogin.Uncheck()
						}
					}
				case <-mQuit.ClickedCh:
					systray.Quit()
				}
			}
		}()
	}
	onExit := func() {
		if d.OnQuit != nil {
			d.OnQuit()
		}
	}
	systray.Run(onReady, onExit)
}

func openURL(url string) {
	if url == "" {
		return
	}
	switch runtime.GOOS {
	case "darwin":
		_ = exec.Command("open", url).Start()
	case "windows":
		_ = exec.Command("rundll32", "url.dll,FileProtocolHandler", url).Start()
	default:
		_ = exec.Command("xdg-open", url).Start()
	}
}

func copyToClipboard(text string) {
	if text == "" {
		return
	}
	var cmd *exec.Cmd
	switch runtime.GOOS {
	case "darwin":
		cmd = exec.Command("pbcopy")
	case "windows":
		cmd = exec.Command("clip")
	default:
		cmd = exec.Command("xclip", "-selection", "clipboard")
	}
	in, err := cmd.StdinPipe()
	if err != nil {
		return
	}
	if err := cmd.Start(); err != nil {
		return
	}
	_, _ = in.Write([]byte(text))
	_ = in.Close()
	_ = cmd.Wait()
}
