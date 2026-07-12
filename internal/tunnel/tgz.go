package tunnel

import (
	"archive/tar"
	"compress/gzip"
	"fmt"
	"io"
	"os"
	"path/filepath"
)

// extractTgzBinary pulls a single named file out of a .tgz stream —
// cloudflared's macOS releases ship the binary inside one.
func extractTgzBinary(r io.Reader, name, dest string) error {
	gz, err := gzip.NewReader(r)
	if err != nil {
		return err
	}
	defer gz.Close()
	tr := tar.NewReader(gz)
	for {
		hdr, err := tr.Next()
		if err == io.EOF {
			break
		}
		if err != nil {
			return err
		}
		if filepath.Base(hdr.Name) != name || hdr.Typeflag != tar.TypeReg {
			continue
		}
		f, err := os.OpenFile(dest, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o700)
		if err != nil {
			return err
		}
		// Bounded copy: a release binary is tens of MB; anything past
		// 200MB is not the file we think it is.
		if _, err := io.Copy(f, io.LimitReader(tr, 200<<20)); err != nil {
			f.Close()
			return err
		}
		return f.Close()
	}
	return fmt.Errorf("tunnel: %q not found in archive", name)
}
