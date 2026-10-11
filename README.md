# muse-ai-local-bridge

Give Muse AI scoped access to a local project folder — over a plain GET tool API.

You run one small server inside your project folder. It exposes your files and git
through authenticated HTTPS endpoints. Paste one sentence in chat and the assistant
connects: it can read, search, edit, patch, and run allowlisted commands — always
inside the folder you chose, never outside it.

Zero runtime dependencies. One file you can audit in ten minutes.

## Quick start

1. **Install Node.js 18+.** Nothing else.
2. **Install the bridge** (or run it once with `npx muse-ai-local-bridge`):
   ```sh
   npm install -g muse-ai-local-bridge
   ```
3. **Run the server inside your project folder:**
   ```sh
   cd ~/projects/my-project
   mbridge
   ```
   It prints a one-time token. Keep that terminal open.
3. **Expose it** with a tunnel you control. Any tunnel works — cloudflared,
   ngrok, Tailscale, … — e.g.:
   ```sh
   cloudflared tunnel --url http://localhost:8787
   ```
   Note the public URL it gives you. (Quick tunnels are fine for trying;
   for daily use set up a named tunnel — see [TROUBLESHOOTING.md](TROUBLESHOOTING.md).)
4. **In chat, paste:**
   > connect to my local bridge at https://your-tunnel-url
5. The assistant reads the skill from your URL, asks for the token through a
   secure card (never paste the token as plain chat text), verifies, and
   reports the mode and project roots it can see. You only paste the sentence
   and enter the token — no explaining needed.
6. **Done.** Ask it to read, search, edit, or run your build. Writes and commands
   always ask for your approval first.

## CLI

```sh
npx muse-ai-local-bridge [options]

  --port <n>       listen port (default 8787)
  --read-only      read-only mode: read + git tools only, no writes or commands
  --allow <cmd>    add an exact command to the run_command allowlist
                   (repeatable; patterns with shell metacharacters are refused)
  --token-file <p> write the one-time token to a file (for scripting)
```

The server refuses to start from your home directory or a drive root — `cd` into
a project first. Every run generates a fresh 256-bit token; nothing is stored.

## Tools

| Tool | What it does |
|---|---|
| `list_projects` | List the allowed project roots |
| `list_files` | List files (respects `.gitignore`, hides secrets) |
| `read_file` | Read a file, paginated (max 1 MB) |
| `search_code` | Literal search with context lines |
| `git_status`, `git_diff`, `git_log` | Git read tools |
| `write_file` | Atomic write (temp + rename, max 1 MB) |
| `edit_file` | Exact-match string replacement (must match exactly once) |
| `apply_patch` | Unified diff, fuzz factor 0 |
| `run_command` | Allowlisted commands only, no shell, exact match |

Wire details: [PROTOCOL.md](PROTOCOL.md). Threat model: [SECURITY.md](SECURITY.md).
Stuck? [TROUBLESHOOTING.md](TROUBLESHOOTING.md).

## Multiple projects

Create `~/.muse-ai-local-bridge/config.json`:

```json
{ "roots": ["/home/you/projects/my-project", { "name": "blog", "path": "/home/you/projects/blog" }] }
```

One server then serves every root; each tool takes an optional `project`
(name or path) argument. See [config.example.json](config.example.json).
Without a config file, the server scopes itself to the folder you ran it in.

The config is re-read whenever the file changes — add or remove a project and
it takes effect on the next call, no restart needed.

Don't want to hand-edit JSON? Manage projects from the terminal
(`mbridge` is a short alias for `muse-ai-local-bridge`):

```sh
mbridge add ~/projects/my-project   # add a project
mbridge remove my-project           # remove by name or path
mbridge list                        # show registered projects
```

(With npx: `npx muse-ai-local-bridge add ~/projects/my-project`.)

## Revoking access

Kill the server (`Ctrl+C`). The token dies with the process — nothing is stored,
nothing survives a restart. Stop the tunnel too, to be thorough.

## Too lazy to set this up?

This bridge is deliberately DIY: you run the server, you run the tunnel, you
guard the token. If you'd rather skip all that, [AugentFlow](https://augentflow.com)
packages the same idea — local project access for Muse AI — as a desktop app
with the connection, approvals, and audit trail built in. Same people build both;
this bridge stays MIT-licensed and independent either way.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). MIT licensed — fork it, commercialize it,
strip the section above if you want. That's the deal.
