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
	"syscall"
	"time"

	"github.com/centrual/cuxdeck/internal/auth"
	"github.com/centrual/cuxdeck/internal/notify"
	"github.com/centrual/cuxdeck/internal/push"
	"github.com/centrual/cuxdeck/internal/server"
	"github.com/centrual/cuxdeck/internal/telegram"
	"github.com/centrual/cuxdeck/internal/tunnel"
	"github.com/centrual/cuxdeck/internal/usagelog"
	"github.com/centrual/cuxdeck/internal/watch"
	qrcode "github.com/skip2/go-qrcode"
)

var version = "0.1.0-dev"

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
	flag.Parse()

	st, err := auth.Open(home())
	if err != nil {
		fmt.Fprintln(os.Stderr, "cuxdeck:", err)
		os.Exit(1)
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
	go watch.Run(notifiers, 5*time.Second)

	srv := &server.Server{Auth: st, Push: pushStore, TG: tgStore, Usage: usageStore, Version: version}
	ln, err := net.Listen("tcp", fmt.Sprintf("127.0.0.1:%d", *port))
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
	fmt.Printf("⌁ cuxdeck %s — serving on http://127.0.0.1:%d\n", version, *port)

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	if *noTunnel {
		showPairing(st, fmt.Sprintf("http://127.0.0.1:%d", *port))
		<-ctx.Done()
		return
	}

	tm := &tunnel.Manager{
		LocalPort: *port,
		Dir:       filepath.Join(home(), "bin"),
		Logf: func(f string, a ...any) {
			fmt.Printf("cuxdeck: "+f+"\n", a...)
		},
		OnURL: func(u string) {
			fmt.Printf("\ncuxdeck: tunnel up — %s\n", u)
			prev, _ := os.ReadFile(filepath.Join(home(), "current-url"))
			_ = os.WriteFile(filepath.Join(home(), "current-url"), []byte(u), 0o600)
			showPairing(st, u)
			// A rotated tunnel address is exactly the "panel moved — tap
			// to reopen" case Web Push exists for: the old service worker
			// still receives it even though its origin just changed.
			if pushStore != nil && len(prev) > 0 && string(prev) != u {
				pushStore.Notify(push.Event{Title: "cuxdeck moved", Body: "New address — tap to reopen the panel", Tag: "tunnel-url"})
			}
		},
	}
	if err := tm.EnsureBinary(ctx); err != nil {
		fmt.Fprintln(os.Stderr, "cuxdeck: tunnel unavailable:", err)
		fmt.Println("cuxdeck: continuing local-only; pair on this machine's browser:")
		showPairing(st, fmt.Sprintf("http://127.0.0.1:%d", *port))
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
