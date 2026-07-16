// Package tray puts cuxdeck in the menu bar: the mascot icon, a live
// status header (what's running, whether the phone can reach it), a
// sessions submenu, and actions whose labels say exactly what they do.
// It's the "it's a real app, not a terminal command" layer.
//
// systray owns the main thread, so Run blocks; the daemon runs in the
// callback. Everything the menu needs from the daemon comes through the
// Deps struct, so this package stays free of the server/service code.
package tray

import (
	_ "embed"
	"fmt"
	"os/exec"
	"runtime"
	"time"

	"fyne.io/systray"
)

//go:generate go run ../../tools/buildicon

//go:embed icon.png
var iconPNG []byte

// Status is one refresh of what the menu's header shows. Produced by
// the daemon side (it owns the data files); the tray only renders it.
type Status struct {
	Machine  string   // display name of this machine
	TunnelUp bool     // phone-reachable public tunnel is live
	Sessions []string // one preformatted line per live session, oldest first
}

// Deps is what the menu needs from the rest of the app.
type Deps struct {
	// CurrentURL returns the address to open — the tunnel URL if up,
	// else the local one.
	CurrentURL func() string
	// PairingLink mints a fresh single-use pairing link to share.
	PairingLink func() string
	// Status reports the live header state; polled every few seconds.
	// nil hides the status rows entirely.
	Status func() Status
	// StartAtLoginState / SetStartAtLogin read and flip the OS
	// start-at-login registration.
	StartAtLoginState func() bool
	SetStartAtLogin   func(on bool) error
	// OnQuit runs before the process exits (graceful shutdown).
	OnQuit func()
}

// maxSessionRows bounds the submenu: systray can't remove items, only
// hide them, so slots are pre-created and retitled on every refresh.
const maxSessionRows = 8

// Run shows the menu-bar icon and blocks until Quit. daemon is started
// once the tray is ready (systray must own the main goroutine).
func Run(d Deps, daemon func()) {
	started := false
	onReady := func() {
		systray.SetIcon(iconPNG)
		systray.SetTooltip("cuxdeck — mission control for your cux fleet")

		// Live header: two disabled rows the poller keeps current, so a
		// glance at the menu answers "is anything running, and can my
		// phone reach it" without opening the panel.
		mStatus := systray.AddMenuItem("cuxdeck — starting…", "")
		mStatus.Disable()
		mTunnel := systray.AddMenuItem("Remote access: checking…", "")
		mTunnel.Disable()
		systray.AddSeparator()

		mOpen := systray.AddMenuItem("Open control panel",
			"Opens the panel in your browser — watch and drive every session; the phone-pairing QR lives there too")
		mSess := systray.AddMenuItem("Live sessions", "Every Claude Code session cux is running right now")
		mSessNone := mSess.AddSubMenuItem("No live sessions", "")
		mSessNone.Disable()
		sessSlots := make([]*systray.MenuItem, maxSessionRows)
		for i := range sessSlots {
			sessSlots[i] = mSess.AddSubMenuItem("", "Opens this session in the panel")
			sessSlots[i].Hide()
		}
		systray.AddSeparator()
		mPair := systray.AddMenuItem("Copy phone pairing link",
			"Puts a one-time link on the clipboard — open it on the phone (or send it to a teammate) to add that device")
		systray.AddSeparator()
		mLogin := systray.AddMenuItemCheckbox("Start at login",
			"Launch cuxdeck when this computer starts", false)
		systray.AddSeparator()
		mQuit := systray.AddMenuItem("Quit cuxdeck",
			"Stops the panel and the tunnel — cux sessions themselves keep running")

		if d.StartAtLoginState != nil && d.StartAtLoginState() {
			mLogin.Check()
		}

		if !started {
			started = true
			go daemon()
		}

		// Any session row opens the panel — the row's job is telling you
		// what's running; the panel is where you act on it.
		for _, slot := range sessSlots {
			go func(ch <-chan struct{}) {
				for range ch {
					if d.CurrentURL != nil {
						openURL(d.CurrentURL())
					}
				}
			}(slot.ClickedCh)
		}

		if d.Status != nil {
			apply := func(st Status) {
				n := len(st.Sessions)
				switch {
				case n == 0:
					mStatus.SetTitle(st.Machine + " — idle")
				case n == 1:
					mStatus.SetTitle(st.Machine + " — 1 live session")
				default:
					mStatus.SetTitle(fmt.Sprintf("%s — %d live sessions", st.Machine, n))
				}
				if st.TunnelUp {
					mTunnel.SetTitle("Remote access: online — phone links work anywhere")
				} else {
					mTunnel.SetTitle("Remote access: this computer only (tunnel starting…)")
				}
				for i, slot := range sessSlots {
					if i < n {
						slot.SetTitle(st.Sessions[i])
						slot.Show()
					} else {
						slot.Hide()
					}
				}
				if n == 0 {
					mSessNone.Show()
				} else {
					mSessNone.Hide()
				}
			}
			go func() {
				apply(d.Status())
				t := time.NewTicker(5 * time.Second)
				defer t.Stop()
				for range t.C {
					apply(d.Status())
				}
			}()
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
