// Command buildicon rasterizes the brand mascot (assets/onion.svg) to
// the PNG the menu-bar tray uses. Kept as a generate step so the tray
// icon always matches the panel's onion — one source of truth — and
// the committed PNG means `go build` needs no SVG toolchain.
//
//	go run ./tools/buildicon
package main

import (
	"bytes"
	"fmt"
	"image"
	"image/png"
	"os"
	"path/filepath"

	"github.com/srwiley/oksvg"
	"github.com/srwiley/rasterx"
	"golang.org/x/image/draw"
)

func main() {
	root, _ := os.Getwd()
	svgPath := filepath.Join(root, "assets", "onion.svg")
	f, err := os.Open(svgPath)
	if err != nil {
		fmt.Fprintln(os.Stderr, "buildicon:", err)
		os.Exit(1)
	}
	icon, err := oksvg.ReadIconStream(f)
	_ = f.Close()
	if err != nil {
		fmt.Fprintln(os.Stderr, "buildicon: parse:", err)
		os.Exit(1)
	}

	// Render at the SVG's native pixel-art resolution first, then scale
	// up with nearest-neighbour so the pixels stay crisp instead of the
	// blur a direct large render would give.
	nw, nh := int(icon.ViewBox.W), int(icon.ViewBox.H) // 46 x 40
	native := image.NewRGBA(image.Rect(0, 0, nw, nh))
	icon.SetTarget(0, 0, float64(nw), float64(nh))
	icon.Draw(rasterx.NewDasher(nw, nh, rasterx.NewScannerGV(nw, nh, native, native.Bounds())), 1)

	// Menu-bar target: 44px tall (22pt @2x), width proportional, on a
	// transparent square so macOS centres it.
	const H = 44
	w := nw * H / nh
	scaled := image.NewRGBA(image.Rect(0, 0, w, H))
	draw.NearestNeighbor.Scale(scaled, scaled.Bounds(), native, native.Bounds(), draw.Over, nil)

	side := w
	if H > side {
		side = H
	}
	sq := image.NewRGBA(image.Rect(0, 0, side, side))
	off := image.Pt((side-w)/2, (side-H)/2)
	draw.Draw(sq, image.Rect(off.X, off.Y, off.X+w, off.Y+H), scaled, image.Point{}, draw.Over)

	var buf bytes.Buffer
	if err := png.Encode(&buf, sq); err != nil {
		fmt.Fprintln(os.Stderr, "buildicon: encode:", err)
		os.Exit(1)
	}
	out := filepath.Join(root, "internal", "tray", "icon.png")
	_ = os.MkdirAll(filepath.Dir(out), 0o755)
	if err := os.WriteFile(out, buf.Bytes(), 0o644); err != nil {
		fmt.Fprintln(os.Stderr, "buildicon: write:", err)
		os.Exit(1)
	}
	fmt.Printf("buildicon: %s (%dx%d, %.1f KB)\n", out, side, side, float64(buf.Len())/1024)
}
