//go:build ignore

// render-icns rasterizes assets/onion.svg into a macOS .icns via a
// temporary .iconset and `iconutil`. Run by make-macos-app.sh; kept
// out of the module build with the ignore tag.
//
//	go run ./packaging/render-icns.go <svg> <out.icns>
package main

import (
	"fmt"
	"image"
	"image/png"
	"os"
	"os/exec"
	"path/filepath"

	"github.com/srwiley/oksvg"
	"github.com/srwiley/rasterx"
	"golang.org/x/image/draw"
)

func main() {
	if len(os.Args) != 3 {
		fmt.Fprintln(os.Stderr, "usage: render-icns <svg> <out.icns>")
		os.Exit(2)
	}
	svgPath, out := os.Args[1], os.Args[2]

	f, err := os.Open(svgPath)
	must(err)
	icon, err := oksvg.ReadIconStream(f)
	_ = f.Close()
	must(err)

	nw, nh := int(icon.ViewBox.W), int(icon.ViewBox.H)
	native := image.NewRGBA(image.Rect(0, 0, nw, nh))
	icon.SetTarget(0, 0, float64(nw), float64(nh))
	icon.Draw(rasterx.NewDasher(nw, nh, rasterx.NewScannerGV(nw, nh, native, native.Bounds())), 1)

	iconset, err := os.MkdirTemp("", "cuxdeck-iconset-*.iconset")
	must(err)
	defer os.RemoveAll(iconset)

	// App icons are square; centre the mascot on a transparent canvas
	// and scale (nearest-neighbour keeps the pixel art crisp) to each
	// size macOS expects.
	for _, s := range []struct {
		px   int
		name string
	}{
		{16, "icon_16x16.png"}, {32, "icon_16x16@2x.png"},
		{32, "icon_32x32.png"}, {64, "icon_32x32@2x.png"},
		{128, "icon_128x128.png"}, {256, "icon_128x128@2x.png"},
		{256, "icon_256x256.png"}, {512, "icon_256x256@2x.png"},
		{512, "icon_512x512.png"}, {1024, "icon_512x512@2x.png"},
	} {
		writeSquare(native, s.px, filepath.Join(iconset, s.name))
	}

	if err := exec.Command("iconutil", "-c", "icns", iconset, "-o", out).Run(); err != nil {
		// No iconutil (non-macOS) — leave a 512 PNG beside the target so
		// the build still produces something usable.
		writeSquare(native, 512, out+".png")
		fmt.Fprintln(os.Stderr, "render-icns: iconutil unavailable, wrote PNG fallback")
		os.Exit(1)
	}
}

func writeSquare(src image.Image, px int, path string) {
	b := src.Bounds()
	side := b.Dx()
	if b.Dy() > side {
		side = b.Dy()
	}
	// scale factor to fit the mascot's long edge into px, with a little
	// padding so it isn't edge-to-edge
	target := int(float64(px) * 0.86)
	sw := target * b.Dx() / side
	sh := target * b.Dy() / side
	canvas := image.NewRGBA(image.Rect(0, 0, px, px))
	dst := image.Rect((px-sw)/2, (px-sh)/2, (px-sw)/2+sw, (px-sh)/2+sh)
	draw.NearestNeighbor.Scale(canvas, dst, src, b, draw.Over, nil)
	f, err := os.Create(path)
	must(err)
	must(png.Encode(f, canvas))
	_ = f.Close()
}

func must(err error) {
	if err != nil {
		fmt.Fprintln(os.Stderr, "render-icns:", err)
		os.Exit(1)
	}
}
