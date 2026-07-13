package watch

import (
	"testing"
	"time"

	"github.com/centrual/cuxdeck/internal/cuxdata"
)

func win(u float64) *cuxdata.Window { return &cuxdata.Window{Utilization: u} }

func TestAllExhausted(t *testing.T) {
	// no usage data → never "exhausted" (we just don't know)
	if allExhausted(cuxdata.Deck{}) {
		t.Fatal("empty usage should not report exhausted")
	}
	// one seat with headroom → not exhausted
	d := cuxdata.Deck{Usage: map[string]cuxdata.AccountUsage{
		"a": {FiveHour: win(100)},
		"b": {FiveHour: win(40)},
	}}
	if allExhausted(d) {
		t.Fatal("a seat with headroom means not exhausted")
	}
	// every seat at a ceiling → exhausted
	d2 := cuxdata.Deck{Usage: map[string]cuxdata.AccountUsage{
		"a": {FiveHour: win(100)},
		"b": {SevenDay: win(100)},
	}}
	if !allExhausted(d2) {
		t.Fatal("all seats at ceiling should be exhausted")
	}
}

func TestResetHintPicksEarliest(t *testing.T) {
	soon := time.Now().Add(30 * time.Minute)
	late := time.Now().Add(5 * time.Hour)
	d := cuxdata.Deck{Usage: map[string]cuxdata.AccountUsage{
		"a": {FiveHour: &cuxdata.Window{Utilization: 100, ResetsAt: &late}},
		"b": {SevenDay: &cuxdata.Window{Utilization: 100, ResetsAt: &soon}},
	}}
	got := resetHint(d)
	if got == "Waiting for a window to reset" {
		t.Fatalf("expected a concrete hint, got %q", got)
	}
}

func TestShortHelpers(t *testing.T) {
	if shortSeat("oguz@vennyx.com") != "oguz" {
		t.Fatal("shortSeat")
	}
	if shortDir("/Users/oguz/code/proj") != "…/code/proj" {
		t.Fatalf("shortDir got %q", shortDir("/Users/oguz/code/proj"))
	}
	if dur(90*time.Second) != "1m" || dur(45*time.Second) != "45s" {
		t.Fatalf("dur got %q %q", dur(90*time.Second), dur(45*time.Second))
	}
}
