// cuxdeck — mission control for your cux fleet.
//
// Running `cuxdeck` starts the local server, brings up the accountless
// tunnel, and shows a QR code that pairs a phone in one scan. Meant to
// live behind a menu-bar icon and a start-at-login service; the CLI is
// the same engine without the chrome.
package main

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"regexp"
	"runtime/debug"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/centrual/cuxdeck/internal/auth"
	"github.com/centrual/cuxdeck/internal/cuxcli"
	"github.com/centrual/cuxdeck/internal/i18n"
	"github.com/centrual/cuxdeck/internal/notify"
	"github.com/centrual/cuxdeck/internal/push"
	"github.com/centrual/cuxdeck/internal/selfupdate"
	"github.com/centrual/cuxdeck/internal/server"
	"github.com/centrual/cuxdeck/internal/telegram"
	"github.com/centrual/cuxdeck/internal/tray"
	"github.com/centrual/cuxdeck/internal/tunnel"
	"github.com/centrual/cuxdeck/internal/usagelog"
	"github.com/centrual/cuxdeck/internal/watch"
	qrcode "github.com/skip2/go-qrcode"
)

// version is stamped at release time via -ldflags "-X main.version=…".
// When that isn't set — notably `go install …@vX.Y.Z`, which can't inject
// ldflags — we fall back to the module version the toolchain records in
// the build info, so `cuxdeck version` still reports the real release.
var version = "dev"

// pseudoVersion matches Go's VCS pseudo-versions (…-YYYYMMDDHHMMSS-<hash>),
// which the toolchain stamps for a `go build` in a checkout or `go install
// @main`. Those aren't real releases, so we keep reporting "dev" for them.
var pseudoVersion = regexp.MustCompile(`\d{14}-[0-9a-f]{12}`)

func init() {
	if version != "dev" {
		return // an explicit -ldflags value always wins
	}
	if bi, ok := debug.ReadBuildInfo(); ok {
		v := bi.Main.Version
		if v != "" && v != "(devel)" && !strings.Contains(v, "+") && !pseudoVersion.MatchString(v) {
			version = strings.TrimPrefix(v, "v")
		}
	}
}

func home() string {
	h, _ := os.UserHomeDir()
	return filepath.Join(h, ".cuxdeck")
}

func main() {
	if len(os.Args) > 1 {
		switch os.Args[1] {
		case "install":
			if err := installService(); err != nil {
				fmt.Fprintln(os.Stderr, "cuxdeck:", err)
				os.Exit(1)
			}
			fmt.Println("cuxdeck now starts with this computer. Logs: " + filepath.Join(home(), "cuxdeck.log"))
			return
		case "uninstall":
			if err := uninstallService(); err != nil {
				fmt.Fprintln(os.Stderr, "cuxdeck:", err)
				os.Exit(1)
			}
			fmt.Println("cuxdeck will no longer start automatically.")
			return
		case "qr":
			cmdQR()
			return
		case "status":
			cmdStatus()
			return
		case "version", "--version":
			fmt.Println("cuxdeck", version)
			return
		case "help", "--help", "-h":
			printHelp()
			return
		}
	}

	port := flag.Int("port", 8447, "local port (127.0.0.1 only)")
	noTunnel := flag.Bool("no-tunnel", false, "serve locally without the public tunnel")
	noTray := flag.Bool("no-tray", false, "run headless, without the menu-bar icon")
	flag.Parse()

	st, err := auth.Open(home())
	if err != nil {
		fmt.Fprintln(os.Stderr, "cuxdeck:", err)
		os.Exit(1)
	}

	// The menu-bar icon owns the main thread, so the daemon runs inside
	// its ready callback. --no-tray (or a build without a GUI session)
	// falls back to a plain headless daemon.
	daemon := func() { runDaemon(st, *port, *noTunnel) }
	if *noTray {
		daemon()
		return
	}
	// "Open cuxdeck" points at the local panel, not the tunnel: the
	// pairing QR only renders on loopback (it's a live credential), so
	// this is where you see the QR to scan and can pair the computer
	// itself. The tunnel URL is for the phone, and rides in the QR /
	// the copied pairing link.
	local := fmt.Sprintf("http://127.0.0.1:%d", *port)
	tunnelBase := func() string {
		if b, err := os.ReadFile(filepath.Join(home(), "current-url")); err == nil && len(b) > 0 {
			return string(b)
		}
		return local
	}
	tray.Run(tray.Deps{
		CurrentURL:        func() string { return local },
		PairingLink:       func() string { return tunnelBase() + "/#p=" + st.NewPairingCode(auth.RoleControl) },
		StartAtLoginState: serviceInstalled,
		SetStartAtLogin: func(on bool) error {
			if on {
				return installService()
			}
			return uninstallService()
		},
		OnQuit: func() { os.Exit(0) },
	}, daemon)
}

// runDaemon is the server + tunnel loop, extracted so the tray can own
// the main goroutine and start it in its ready callback.
func runDaemon(st *auth.Store, port int, noTunnel bool) {
	// cuxdeck mirrors sessions over the PTY socket cux exposes only when
	// its `attach` setting is on — and as of cux 0.3.2 that's opt-in (off
	// by default, since the always-on PTY taxed every session). Turn it on
	// so cuxdeck works out of the box. It only affects cux sessions
	// started afterwards, so already-running sessions need a restart.
	switch st, detail := cuxcli.EnsureAttach(); st {
	case cuxcli.AttachEnabled:
		fmt.Fprintln(os.Stderr, "cuxdeck: enabled cux attach — restart any already-running cux sessions to make them attachable")
	case cuxcli.AttachFailed:
		fmt.Fprintln(os.Stderr, "cuxdeck: could not enable cux attach (needs cux >= 0.3.2, or run `cux config set attach true` yourself):", detail)
	case cuxcli.AttachAlreadyOn:
		// already attachable — nothing to announce
	}

	// Alerts: Web Push (VAPID keypair + local subs) and Telegram (bot
	// token + chat id). A single watcher fans cux state changes out to
	// whichever channels are enabled. All best-effort — if a channel
	// can't initialise, the panel still runs.
	pushStore, perr := push.Open(home())
	if perr != nil {
		fmt.Fprintln(os.Stderr, "cuxdeck: push disabled:", perr)
	}
	tgStore := telegram.Open(home())
	usageStore := usagelog.Open(home())
	go usageStore.Run(5 * time.Minute)
	var notifiers []notify.Notifier
	if pushStore != nil {
		notifiers = append(notifiers, pushStore)
	}
	notifiers = append(notifiers, tgStore)

	// The notification language, chosen in the panel and stored in
	// ~/.cuxdeck/lang. Empty = English. Read fresh each time so a change
	// takes effect without a restart.
	langOf := func() string {
		b, _ := os.ReadFile(filepath.Join(home(), "lang"))
		return strings.TrimSpace(string(b))
	}
	go watch.Run(notifiers, 5*time.Second, langOf)

	curURL := func() string {
		if b, err := os.ReadFile(filepath.Join(home(), "current-url")); err == nil && len(b) > 0 {
			return string(b)
		}
		return ""
	}

	// Software update. Mode lives in ~/.cuxdeck/autoupdate (off|notify|
	// auto), defaulting to notify. The checker below keeps latestVer
	// fresh; the server reads it and can trigger runUpdate.
	updateMode := func() string {
		b, _ := os.ReadFile(filepath.Join(home(), "autoupdate"))
		if m := strings.TrimSpace(string(b)); m == "off" || m == "auto" {
			return m
		}
		return "notify"
	}
	setUpdateMode := func(m string) error {
		if m != "off" && m != "notify" && m != "auto" {
			return fmt.Errorf("invalid mode %q", m)
		}
		return os.WriteFile(filepath.Join(home(), "autoupdate"), []byte(m), 0o600)
	}
	var latestMu sync.Mutex
	var latestVer string
	getLatest := func() string {
		latestMu.Lock()
		defer latestMu.Unlock()
		return latestVer
	}
	// runUpdate upgrades in place (Homebrew only) and lets launchd's
	// KeepAlive relaunch the new binary. It returns immediately; the
	// upgrade runs in the background so the HTTP caller isn't held open.
	runUpdate := func() error {
		if !selfupdate.BrewManaged() {
			return fmt.Errorf("not a Homebrew install — download the latest release from GitHub")
		}
		go func() {
			if err := selfupdate.Upgrade(context.Background()); err != nil {
				fmt.Fprintln(os.Stderr, "cuxdeck: update failed:", err)
				return
			}
			fmt.Println("cuxdeck: updated — restarting")
			os.Exit(0)
		}()
		return nil
	}

	srv := &server.Server{Auth: st, Push: pushStore, TG: tgStore, Usage: usageStore, Version: version,
		StartAtLoginState: serviceInstalled,
		SetStartAtLogin: func(on bool) error {
			if on {
				return installService()
			}
			return uninstallService()
		},
		CurrentURL: curURL,
		Name: func() string {
			b, _ := os.ReadFile(filepath.Join(home(), "name"))
			return strings.TrimSpace(string(b))
		},
		SetName: func(n string) error {
			if n == "" {
				return os.Remove(filepath.Join(home(), "name"))
			}
			return os.WriteFile(filepath.Join(home(), "name"), []byte(n), 0o600)
		},
		LatestVersion: getLatest,
		UpdateMode:    updateMode,
		SetUpdateMode: setUpdateMode,
		RunUpdate:     runUpdate,
		Lang:          langOf,
		SetLang: func(l string) error {
			switch l {
			case "", "en":
				if err := os.Remove(filepath.Join(home(), "lang")); err != nil && !os.IsNotExist(err) {
					return err
				}
				return nil
			case "tr", "fr", "de", "it":
				return os.WriteFile(filepath.Join(home(), "lang"), []byte(l), 0o600)
			}
			return fmt.Errorf("unsupported language %q", l)
		},
	}

	// Update checker: shortly after boot, then every 6 hours. It records
	// the newest release, notifies once per new version (Web Push +
	// Telegram), and — in auto mode on a Homebrew install — upgrades.
	go func() {
		var notified string
		check := func() {
			if updateMode() == "off" {
				return
			}
			ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
			defer cancel()
			v, err := selfupdate.Latest(ctx)
			if err != nil || v == "" {
				return
			}
			latestMu.Lock()
			latestVer = v
			latestMu.Unlock()
			if !selfupdate.Newer(version, v) {
				return
			}
			if updateMode() == "auto" && selfupdate.BrewManaged() {
				_ = runUpdate()
				return
			}
			if notified != v {
				notified = v
				lg := langOf()
				ev := notify.Event{Title: i18n.T(lg, "cuxdeck update available"), Body: "v" + v + i18n.T(lg, " — open cuxdeck to install"), Tag: "update"}
				if pushStore != nil {
					pushStore.Notify(ev)
				}
				tgStore.Notify(ev)
			}
		}
		time.Sleep(30 * time.Second)
		check()
		t := time.NewTicker(6 * time.Hour)
		defer t.Stop()
		for range t.C {
			check()
		}
	}()
	ln, err := net.Listen("tcp", fmt.Sprintf("127.0.0.1:%d", port))
	if err != nil {
		fmt.Fprintln(os.Stderr, "cuxdeck:", err)
		os.Exit(1)
	}
	go func() {
		if err := http.Serve(ln, srv.Handler()); err != nil {
			fmt.Fprintln(os.Stderr, "cuxdeck: server:", err)
			os.Exit(1)
		}
	}()
	fmt.Printf("⌁ cuxdeck %s — serving on http://127.0.0.1:%d\n", version, port)

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	if noTunnel {
		showPairing(st, fmt.Sprintf("http://127.0.0.1:%d", port))
		<-ctx.Done()
		return
	}

	tm := &tunnel.Manager{
		LocalPort: port,
		Dir:       filepath.Join(home(), "bin"),
		Logf: func(f string, a ...any) {
			fmt.Printf("cuxdeck: "+f+"\n", a...)
		},
		OnURL: func(u string) {
			fmt.Printf("\ncuxdeck: tunnel up — %s\n", u)
			prev, _ := os.ReadFile(filepath.Join(home(), "current-url"))
			_ = os.WriteFile(filepath.Join(home(), "current-url"), []byte(u), 0o600)
			showPairing(st, u)
			// The accountless Quick Tunnel picks a new address every time
			// the daemon (re)starts, so a device left on the old URL 404s.
			// The new URL is also a new browser origin, so the phone's
			// stored token doesn't carry over — it has to pair again.
			// Announce a full pairing LINK (URL + single-use code), not just
			// the bare URL, so one tap re-pairs. Telegram is the channel
			// that matters here: its chat is independent of the tunnel
			// origin, so it lands even though the Web Push subscription is
			// tied to the old (now-dead) origin.
			if len(prev) > 0 && string(prev) != u {
				lg := langOf()
				title := i18n.T(lg, "cuxdeck moved — new address")
				devs := st.DeviceList()
				// Telegram (origin-independent, so it actually arrives):
				// one reconnect link per device, labelled by name, each
				// renewing that device in place. Fall back to a single
				// generic pairing link when nothing is paired yet.
				tgBody := u
				if len(devs) == 0 {
					tgBody = u + "/#p=" + st.NewPairingCode(auth.RoleControl)
				} else {
					for _, d := range devs {
						if c := st.NewRepairCode(d.ID); c != "" {
							tgBody += "\n\n" + d.Name + ": " + u + "/#p=" + c
						}
					}
				}
				tgStore.Notify(notify.Event{Title: title, Body: tgBody, Tag: "tunnel-url"})
				// Web Push rides the old (now-dead) origin's subscription,
				// so it rarely lands; send a short generic link, not the
				// full per-device list.
				if pushStore != nil {
					pushStore.Notify(notify.Event{Title: title, Body: u + "/#p=" + st.NewPairingCode(auth.RoleControl), Tag: "tunnel-url"})
				}
			}
		},
	}
	if err := tm.EnsureBinary(ctx); err != nil {
		fmt.Fprintln(os.Stderr, "cuxdeck: tunnel unavailable:", err)
		fmt.Println("cuxdeck: continuing local-only; pair on this machine's browser:")
		showPairing(st, fmt.Sprintf("http://127.0.0.1:%d", port))
		<-ctx.Done()
		return
	}
	tm.Run(ctx)
}

// showPairing mints a fresh single-use code and renders the pairing QR
// plus a hand-typable fallback.
func showPairing(st *auth.Store, baseURL string) {
	code := st.NewPairingCode(auth.RoleControl)
	link := baseURL + "/#p=" + code
	fmt.Println("\nScan to pair a phone (code is single-use, valid 10 minutes):")
	printQR(link)
	fmt.Printf("or open  %s\n   code:  %s\n\n", baseURL, code)
}

// printQR renders a scannable QR in the terminal using half-block
// characters (two modules per character row).
func printQR(content string) {
	q, err := qrcode.New(content, qrcode.Medium)
	if err != nil {
		return
	}
	grid := q.Bitmap()
	for y := 0; y < len(grid); y += 2 {
		line := ""
		for x := 0; x < len(grid[y]); x++ {
			top := grid[y][x]
			bottom := y+1 < len(grid) && grid[y+1][x]
			switch {
			case top && bottom:
				line += "█"
			case top:
				line += "▀"
			case bottom:
				line += "▄"
			default:
				line += " "
			}
		}
		fmt.Println(line)
	}
}

// cmdQR asks the running daemon for a fresh single-use code and
// renders the pairing QR against the current public address.
func cmdQR() {
	port := 8447
	resp, err := http.Post(fmt.Sprintf("http://127.0.0.1:%d/local/pairing", port), "application/json", nil)
	if err != nil {
		fmt.Fprintln(os.Stderr, "cuxdeck: daemon not running — start it with `cuxdeck` or `cuxdeck install`")
		os.Exit(1)
	}
	defer resp.Body.Close()
	var out struct {
		Code string `json:"code"`
	}
	if err := jsonDecode(resp.Body, &out); err != nil || out.Code == "" {
		fmt.Fprintln(os.Stderr, "cuxdeck: unexpected daemon response")
		os.Exit(1)
	}
	base := fmt.Sprintf("http://127.0.0.1:%d", port)
	if b, err := os.ReadFile(filepath.Join(home(), "current-url")); err == nil && len(b) > 0 {
		base = string(b)
	}
	fmt.Println("Scan to pair a phone (code is single-use, valid 10 minutes):")
	printQR(base + "/#p=" + out.Code)
	fmt.Printf("or open  %s\n   code:  %s\n", base, out.Code)
}

// cmdStatus reports whether the daemon and its tunnel are up.
func cmdStatus() {
	resp, err := http.Get("http://127.0.0.1:8447/")
	if err != nil {
		fmt.Println("daemon   : not running (start with `cuxdeck` or `cuxdeck install`)")
		return
	}
	resp.Body.Close()
	fmt.Println("daemon   : running on 127.0.0.1:8447")
	if b, err := os.ReadFile(filepath.Join(home(), "current-url")); err == nil && len(b) > 0 {
		fmt.Println("tunnel   :", string(b))
	} else {
		fmt.Println("tunnel   : not established")
	}
	fmt.Println("pair     : run `cuxdeck qr`")
}

func printHelp() {
	fmt.Println(`cuxdeck — mission control for your cux fleet

USAGE
  cuxdeck                 run the deck (server + tunnel + pairing QR)
  cuxdeck install         start automatically with this computer
  cuxdeck uninstall       stop starting automatically
  cuxdeck qr              show a fresh pairing QR (daemon must be running)
  cuxdeck status          daemon and tunnel state
  cuxdeck version         print version

FLAGS (for the run mode)
  --port N                local port (default 8447)
  --no-tunnel             local-only, skip the public tunnel`)
}

func jsonDecode(r io.Reader, v any) error {
	return json.NewDecoder(r).Decode(v)
}
