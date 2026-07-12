// Package cuxcli is cuxdeck's only write path into cux: a thin,
// allowlisted bridge to the `cux` command-line tool. Every mutation the
// panel offers maps to exactly one CLI invocation, so cux's own
// validation, locking, and business rules apply unchanged — cuxdeck
// forks no logic.
package cuxcli

import (
	"context"
	"errors"
	"fmt"
	"os/exec"
	"regexp"
	"time"
)

const timeout = 60 * time.Second

// identRE bounds every user-supplied argument we pass to cux: slot
// numbers, aliases, emails, project names. exec.Command never goes
// through a shell, so this is defense in depth against surprising
// flags (leading '-') rather than injection.
var identRE = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9.@_-]{0,80}$`)

// Result carries one invocation's outcome back to the panel.
type Result struct {
	OK     bool   `json:"ok"`
	Output string `json:"output"`
}

func run(args ...string) Result {
	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()
	out, err := exec.CommandContext(ctx, "cux", args...).CombinedOutput()
	return Result{OK: err == nil, Output: string(out)}
}

func ident(s string) (string, error) {
	if !identRE.MatchString(s) {
		return "", fmt.Errorf("cuxcli: refusing argument %q", s)
	}
	return s, nil
}

// ErrUnknownAction is returned for actions outside the allowlist.
var ErrUnknownAction = errors.New("cuxcli: unknown action")

// Do executes one allowlisted action. Unknown actions and malformed
// arguments fail before anything runs.
func Do(action string, args map[string]string) (Result, error) {
	switch action {
	case "switch":
		t, err := ident(args["target"])
		if err != nil {
			return Result{}, err
		}
		return run("switch", t), nil
	case "usage-refresh":
		return run("usage", "refresh"), nil
	case "project-create":
		name, err := ident(args["name"])
		if err != nil {
			return Result{}, err
		}
		dir := args["dir"]
		if dir == "" {
			return Result{}, fmt.Errorf("cuxcli: project-create needs dir")
		}
		return run("project", "create", name, "--dir", dir), nil
	case "project-assign", "project-unassign":
		name, err := ident(args["name"])
		if err != nil {
			return Result{}, err
		}
		seat, err := ident(args["seat"])
		if err != nil {
			return Result{}, err
		}
		verb := "assign"
		if action == "project-unassign" {
			verb = "unassign"
		}
		return run("project", verb, name, seat), nil
	case "project-remove":
		name, err := ident(args["name"])
		if err != nil {
			return Result{}, err
		}
		return run("project", "remove", name), nil
	}
	return Result{}, ErrUnknownAction
}
