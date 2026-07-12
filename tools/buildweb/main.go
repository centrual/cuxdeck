// Command buildweb bundles the React panel with esbuild — which is a Go
// library, so the whole frontend toolchain is `go run`: no node, no npm,
// no lockfiles. React itself is vendored under web/vendor/node_modules
// (fetched once from the npm registry, committed to the repo).
//
// Run from the repo root:
//
//	go run ./tools/buildweb
//
// or via `go generate ./...`. The bundle lands in internal/server/web/
// and is committed too, so a plain `go build` always works.
package main

import (
	"fmt"
	"os"
	"path/filepath"

	"github.com/evanw/esbuild/pkg/api"
)

func main() {
	root, err := os.Getwd()
	if err != nil {
		fmt.Fprintln(os.Stderr, "buildweb:", err)
		os.Exit(1)
	}
	result := api.Build(api.BuildOptions{
		EntryPoints:       []string{filepath.Join(root, "web", "src", "main.tsx")},
		Bundle:            true,
		Outfile:           filepath.Join(root, "internal", "server", "web", "app.js"),
		Write:             true,
		MinifyWhitespace:  true,
		MinifyIdentifiers: true,
		MinifySyntax:      true,
		Target:            api.ES2019,
		Format:            api.FormatIIFE,
		JSX:               api.JSXAutomatic,
		NodePaths:         []string{filepath.Join(root, "web", "vendor", "node_modules")},
		Define:            map[string]string{"process.env.NODE_ENV": `"production"`},
		LogLevel:          api.LogLevelInfo,
	})
	if len(result.Errors) > 0 {
		os.Exit(1)
	}
	info, _ := os.Stat(filepath.Join(root, "internal", "server", "web", "app.js"))
	if info != nil {
		fmt.Printf("buildweb: app.js %.1f KB\n", float64(info.Size())/1024)
	}
}
