# muse-ai-local-bridge skill

You are connected to a local bridge server: a scoped window into the owner's
project folder(s). This file teaches you how to behave behind that window.

## Connecting

The owner pastes: `connect to my local bridge at <url>`.

1. Ask for the token through the secure card — never ask for it as plain chat text.
2. `GET <url>/skill.md` with header `X-Api-Key: <token>` (you are reading this).
3. `GET <url>/api/tools/list` — verify the mode (`kerja`/`baca`) and project
   roots, then report them to the owner in one line.

## Rules

- **Reads are free.** `list_files`, `read_file`, `search_code`, `git_*` need no approval.
- **Writes and commands ALWAYS need the owner's explicit approval first.**
  Show the exact path and full content (or the exact command), then wait for a
  clear "yes". Never bundle approvals for multiple writes into one ask.
- **Never read, write, or work around the secret blocklist** (`.env`, `*.key`,
  …). The server rejects these — don't try alternative paths.
- **Never attempt path traversal.** Stay inside the project root.
- **Never put secrets in tool arguments** — they travel in URL query strings.
- **Keep each call under ~7 KB.** Split large writes into sequential chunks.
- **Multiple roots:** pass `project` (name or path from `list_projects`).
  Default is the first root.
- If the owner revokes access (server stopped), say so plainly and stop.
  Don't retry in a loop.

## Tool semantics

- `list_files(path, max_depth, recursive, include_hidden)` — respects `.gitignore`.
- `read_file(path, offset, limit)` — paginated; 200 lines default, 1 MB max.
- `search_code(pattern, path, file_glob, context_lines)` — literal match, not regex.
- `write_file(path, content)` — atomic; creates parent dirs; 1 MB max.
- `edit_file(path, old_text, new_text)` — literal, must match **exactly once**.
- `apply_patch(path, patch)` — unified diff, fuzz 0: hunks must match at their
  exact positions or the whole patch is rejected.
- `run_command(command, timeout_s)` — the command must match the allowlist
  **exactly**; shell metacharacters are rejected. No shell is involved, so no
  pipes, redirects, or variable expansion — request `--allow` additions from the
  owner instead of working around it.

## Errors

`ok:false` with a `code` is normal — report it plainly:
`PATH_OUTSIDE_ROOT`, `FILE_BLOCKED`, `COMMAND_NOT_ALLOWED`,
`COMMAND_REJECTED_METACHAR`, `BAD_ARGS` (read the message; often a fixable
detail like an ambiguous `old_text`).
