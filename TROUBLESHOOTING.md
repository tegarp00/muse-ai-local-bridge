# Troubleshooting

## `error 1033` — tunnel can't reach your machine

Cloudflare can't reach the origin. Almost always one of these:

1. **The laptop is asleep.** Wake it. Tunnels die quietly when the machine sleeps.
2. **`cloudflared` isn't running.** Start it; better, install it as a service so it
   survives reboots.
3. **No network** on the machine running the tunnel.

Fix the cause, wait ~30 seconds, retry. The bridge server itself is probably fine.

## `502 Bad Gateway` — tunnel is up, bridge isn't

The tunnel reaches your machine but nothing answers on the port. Check:

- Is the bridge server still running? (The terminal where you ran `npx …`.)
- Right port? Default is `8787`; the tunnel must forward to the same port you
  passed via `--port`.

## `401 Unauthorized`

The token doesn't match. Tokens are generated fresh on **every run** — if you
restarted the server, the old token is dead. Copy the new one from the terminal
(or `--token-file`) and reconnect.

## `403` on a write or command

You're in **baca mode** (`--read-only`): only read and git tools are available.
Restart without the flag for kerja mode.

## The tunnel URL changed

Quick tunnels (e.g. `*.trycloudflare.com`) get a new URL on every restart.
Reconnect in chat with the new URL. For a stable address, use a
**named tunnel** instead.

## Calls fail or hang on large payloads

Tool arguments travel in the URL query string. Keep each call under ~7 KB;
a single ~22 KB write has been observed to kill the connection. Split large
writes into sequential chunks — the server never silently truncates.

## `EADDRINUSE` — port already in use

Something else is on the port. Pick another: `--port 8788`, and point your
tunnel at it.

## `node: command not found` / old Node

The bridge needs **Node.js 18+** and nothing else. `node --version` to check.
