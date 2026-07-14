package i18n

import "testing"

func TestT(t *testing.T) {
	cases := []struct{ lang, in, want string }{
		{"tr", "Session finished", "Oturum bitti"},
		{"fr", "Session finished", "Session terminée"},
		{"de", "Session finished", "Sitzung beendet"},
		{"it", "Session finished", "Sessione terminata"},
		{"en", "Session finished", "Session finished"}, // English passes through
		{"", "Session finished", "Session finished"},    // no language = English
		{"tr", "a string with no translation", "a string with no translation"}, // missing key falls back
		{"xx", "Session finished", "Session finished"},   // unknown language falls back
		{"tr", " · seat ", " · koltuk "},                 // leading/trailing spaces preserved
	}
	for _, c := range cases {
		if got := T(c.lang, c.in); got != c.want {
			t.Errorf("T(%q, %q) = %q, want %q", c.lang, c.in, got, c.want)
		}
	}
}
