# Security

This document is deliberately honest about what the bridge enforces and what it
doesn't. Read it before exposing a server.

## What the server enforces

- **Authentication on every request.** A 256-bit token — generated once and
  stored at `~/.muse-ai-local-bridge/token` (mode `0600`) — is compared in
  constant time. No token, no access — every endpoint, every time.
  Persistence is deliberate: behind a tunnel (e.g. Cloudflare Zero Trust), a
  per-run token would force a full reconnect in your assistant after every
  local restart. The trade-off: a leaked token stays valid until rotated —
  treat that file like a password.
- **Localhost only.** The server binds to `127.0.0.1`. The internet can only
  reach it through *your* tunnel.
- **Scoped root.** The working directory (or each configured root) is the
  boundary. `..` traversal and symlinks escaping the root are rejected.
- **Secret blocklist.** `.env*`, `*.key`, `*.pem`, `.ssh/`, `.aws/`, `.gnupg/`
  and friends can never be read, listed, searched, or written — even inside the root.
- **No shell, ever.** Git helpers and `run_command` use argv arrays. There is no
  shell to inject into.
- **Allowlist, exact match.** `run_command` first rejects shell metacharacters,
  then requires the command to match the allowlist *exactly*. Prefix matching is
  deliberately not used: a prefix rule for `git diff` would also allow
  `git diff --no-index /etc/passwd ...`.
- **Atomic writes.** `write_file` / `edit_file` / `apply_patch` write to a temp
  file and rename. A crash mid-write never leaves a half-written file.
- **No silent corruption.** `edit_file` requires exactly one match; `apply_patch`
  requires every hunk to match at its exact position (fuzz 0). Ambiguity is an error.
- **Audit log.** Every write and command is appended to
  `~/.muse-ai-local-bridge/audit.log` on the machine running the server.

## What the server does NOT enforce — read this

- **Approvals live in the chat client, not here.** When you ask the assistant to
  write or run something, it is the *assistant's* job to ask your approval first.
  This server cannot tell whether the assistant asked. A client that skips
  approvals can write and run anything the allowlist permits.
- **`/` and `/skill.md` are public by design.** A fresh assistant must learn how
  to connect from the URL alone, so these two routes need no token. They carry
  no secrets — only connection instructions. Everything else requires the token.
- **Your tunnel is your perimeter.** Anyone holding your tunnel URL *and* the
  token has the same access you have in chat. Use a tunnel you trust, keep the
  URL private, and rotate the token with `--new-token` if it may have leaked —
  a plain restart does not rotate it; the token persists across restarts by
  design, so your assistant stays connected without re-entering it.
- **Tool arguments travel in URL query strings.** They can land in tunnel access
  logs. Never send passwords, API keys, or tokens through the tools — put secrets
  into files by hand, on the machine itself.
- **`.gitignore` support is a subset.** Negation (`!`) patterns are ignored.
  Treat listing/search as a convenience, not a guarantee that something is hidden.
- **No rate limiting.** The token is the only gate. Don't expose the tunnel URL
  publicly.

## Reporting a vulnerability

Open a GitHub issue, or email the maintainer privately if it's actively
exploitable. Please include the commit hash you're running and steps to reproduce.
