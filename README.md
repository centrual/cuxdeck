# cuxdeck

**Watch and manage your [cux](https://github.com/inulute/cux) sessions from your phone.**

cux runs multiple Claude Code accounts as one and keeps overnight runs alive
across rate limits. cuxdeck is its control deck: a background app on the
machine that serves a mobile-friendly panel — sessions, seats, projects —
reachable from anywhere, secured by device pairing, with zero accounts and
zero configuration.

> Status: early development. The design below is the contract we are building
> toward; expect rough edges until v1 ships.

## The experience we are building

1. Install cuxdeck (dmg / brew / one-line installer).
2. Open it once — an icon appears in your menu bar, and it starts with your
   computer from then on.
3. Click **Pair a phone** → a QR code fills the screen.
4. Scan it. Your phone now shows the live panel: every running cux session
   (which directory, which seat, running / waiting-for-reset / retrying),
   every seat's usage bars, every project. Switch seats, manage projects,
   check overnight runs from bed.

No sign-ups. No tokens to copy. No VPN app on the phone. If a step can be
removed, it will be.

## How it works

```
phone browser ──HTTPS──► trycloudflare.com ──tunnel──► cuxdeck (127.0.0.1)
                                                        │  reads ~/.cux
                                                        │  (state, usage,
                                                        │   session registry)
                                                        └─ executes `cux` CLI
                                                           for every action
```

- **Server**: a single Go binary bound to `127.0.0.1`. It reads cux's on-disk
  state (accounts, usage cache, project pools, and the per-wrapper session
  heartbeat registry) and shells out to the `cux` CLI for mutations, so all
  business rules stay in cux.
- **Remote access**: cuxdeck downloads and supervises `cloudflared`
  (checksum-verified, stored under `~/.cuxdeck/bin`) and opens an accountless
  [Quick Tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/do-more-with-tunnels/trycloudflare/).
  If the tunnel drops, cuxdeck re-establishes it and notifies your phone of
  the new address.
- **Pairing & auth**: the QR encodes the current URL plus a long random
  per-device token. The URL is never the secret — every request is
  authenticated, failed attempts back off exponentially, and devices can be
  revoked from the panel. A short manual pairing code exists for cameraless
  setups.
- **Notifications (Web Push, no third parties)**: push subscriptions live
  with your browser's push service, not with our URL — so even when the
  tunnel address rotates, the old service worker still receives the "panel
  moved, tap to open" push and the chain continues. Planned events: tunnel
  address changed · all seats exhausted (with the reset countdown) ·
  wait-for-reset resumed · API-outage retry started/recovered · run finished
  (duration + tokens) · a seat needs re-login. Per-event toggles in the panel.
- **Telegram (optional, first-class)**: a guided connect flow — create a bot
  via BotFather with one tap, paste the token, send `/start`; cuxdeck catches
  the chat id and sends a test message. Same events, delivered to a channel
  that survives phone/browser changes. Never required.

## Design principles

- **Zero-step by default.** Anything that asks the user for an account, a
  token, or a config file must justify itself or die. Mandatory security
  (device pairing) is the only exception.
- **cux owns the rules.** cuxdeck is a window and a remote control; every
  mutation goes through the `cux` CLI, every read through cux's documented
  on-disk files.
- **No cuxdeck servers.** Your data flows through an encrypted tunnel you
  spawn; we never see it, relay it, or store it. Nothing to trust but the
  code in this repo.
- **A browser is the only client.** Phones, tablets, another laptop — if it
  renders HTML, it is a cuxdeck client. PWA install for a home-screen icon.

## Roadmap

| Phase | Scope |
|---|---|
| v1 | daemon + mobile panel (sessions / seats / projects, view + manage) · QR device pairing · tunnel supervisor · `cuxdeck install` (start at login) · menu bar icon |
| v2 | Web Push event notifications · Telegram connect wizard |
| v3 | usage/stat charts, multi-machine decks |

## Requirements

- [cux](https://github.com/inulute/cux) ≥ 0.2.12 (session registry)
- macOS or Linux (Windows: planned)

## License

MIT
