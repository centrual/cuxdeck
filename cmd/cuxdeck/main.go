// cuxdeck — mission control for your cux fleet.
//
// Running `cuxdeck` starts the local server, brings up the accountless
// tunnel, and shows a QR code that pairs a phone in one scan. Meant to
// live behind a menu-bar icon and a start-at-login service; the CLI is
// the same engine without the chrome.
package main

import (
	"context"
	"flag"
	"fmt"
	"net"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"syscall"

	"github.com/centrual/cuxdeck/internal/auth"
	"github.com/centrual/cuxdeck/internal/server"
	"github.com/centrual/cuxdeck/internal/tunnel"
	qrcode "github.com/skip2/go-qrcode"
)

var version = "0.1.0-dev"

func home() string {
	h, _ := os.UserHomeDir()
	return filepath.Join(h, ".cuxdeck")
}

func main() {
	port := flag.Int("port", 8447, "local port (127.0.0.1 only)")
	noTunnel := flag.Bool("no-tunnel", false, "serve locally without the public tunnel")
	flag.Parse()

	st, err := auth.Open(home())
	if err != nil {
		fmt.Fprintln(os.Stderr, "cuxdeck:", err)
		os.Exit(1)
	}

	srv := &server.Server{Auth: st, Version: version}
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
			showPairing(st, u)
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
	code := st.NewPairingCode()
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
