# Troubleshooting

## `error 1033` — tunnel can't reach your machine

Cloudflare can't reach the origin. Almost always one of these:

1. **The laptop is asleep.** Wake it. Tunnels die quietly when the machine sleeps.
2. **`cloudflared` isn't running.** Start it; better, install it as a service so it
   survives reboots.
3. **No network** on the machine running the tunnel.

Fix the cause, wait ~30 seconds, retry. The bridge server itself is probably fine.

**Flapping between working and 1033?** Check the `cloudflared` log for
`QUIC connection failed` / `proceed using 'http2'`. That means your network
blocks outbound UDP, so the tunnel runs on degraded transport and reconnects
more often. Allow outbound UDP on port 7844 if you can; otherwise keep the
laptop awake and expect occasional hiccups.

## `502 Bad Gateway` — tunnel is up, bridge isn't

The tunnel reaches your machine but nothing answers on the port. Check:

- Is the bridge server still running? (The terminal where you ran `npx …`.)
- Right port? Default is `8787`; the tunnel must forward to the same port you
  passed via `--port`.

## `401 Unauthorized`

The token doesn't match. The token persists across restarts, so a restart alone
never causes this — a mismatch means the client holds a different token than
the one saved at `~/.muse-ai-local-bridge/token`: it was rotated with
`--new-token`, the file was deleted, or this server was started with a different
`--token-file`. Copy the current token from the terminal and reconnect.

## `403` on a write or command

You're in **read-only mode** (`--read-only`): only read and git tools are available.
Restart without the flag for read-write mode.

## The tunnel URL changed — or Cloudflare starts blocking you

Quick tunnels (e.g. `*.trycloudflare.com`) get a new URL on every restart.
Worse: creating them over and over can get you throttled or blocked —
quick tunnels are meant for short tests, not daily use. If your tunnel
suddenly stops connecting after working fine, this is likely why.

Use a **named tunnel** instead (free, one-time setup with a Cloudflare account):
stable URL, no rotation, no block.

```sh
cloudflared tunnel login
cloudflared tunnel create mybridge
cloudflared tunnel route dns mybridge bridge.yourdomain.com
cloudflared tunnel run --url http://localhost:8787 mybridge
```

Then connect in chat with the stable `https://bridge.yourdomain.com` once,
and never again.

Using ngrok instead? Its free URLs also rotate on every restart — set a
static domain for daily use, same idea.

## Calls fail or hang on large payloads

Tool arguments travel in the URL query string. Keep each call under ~7 KB;
a single ~22 KB write has been observed to kill the connection. Split large
writes into sequential chunks — the server never silently truncates.

## `EADDRINUSE` — port already in use

Something else is on the port. Pick another: `--port 8788`, and point your
tunnel at it.

## `node: command not found` / old Node

The bridge needs **Node.js 18+** and nothing else. `node --version` to check.
