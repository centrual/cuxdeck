package selfupdate

import "testing"

func TestNewer(t *testing.T) {
	cases := []struct {
		current, latest string
		want            bool
	}{
		{"0.1.2", "0.1.3", true},
		{"0.1.2", "0.2.0", true},
		{"0.1.9", "0.2.0", true},
		{"0.1.2", "1.0.0", true},
		{"0.1.3", "0.1.3", false}, // same
		{"0.1.3", "0.1.2", false}, // older
		{"0.2.0", "0.1.9", false},
		{"v0.1.2", "v0.1.3", true},      // tolerate leading v
		{"dev", "0.1.3", false},         // source build never "outdated"
		{"", "0.1.3", false},            // unknown current
		{"0.1.2", "dev", false},         // garbage latest
		{"0.1.2", "0.1.3-rc1", true},    // prerelease core compares
		{"0.1.2-dirty", "0.1.2", false}, // same core
	}
	for _, c := range cases {
		if got := Newer(c.current, c.latest); got != c.want {
			t.Errorf("Newer(%q, %q) = %v, want %v", c.current, c.latest, got, c.want)
		}
	}
}

func TestMethodIsStable(t *testing.T) {
	// Method must be one of the two known channels — never empty.
	if m := Method(); m != "homebrew" && m != "manual" {
		t.Fatalf("Method() = %q, want homebrew|manual", m)
	}
}
