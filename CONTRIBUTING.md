# Contributing

Welcome. This project is MIT-licensed and built to be forked — contributions
that keep it small, readable, and honest are gladly accepted.

## Ground rules

1. **Follow open-source standards.** English in code, comments, docs, and
   commits. Conventional commits (`feat:`, `fix:`, `docs:`, …).
2. **Comments must be clear and easy to understand.** Explain *why*, not *what*.
   No redundant comments on self-explanatory code.
3. **No redundant code.** If two paths do the same thing, keep one. If a helper
   is used once, inline it.
4. **Keep it easy to fork and contribute.** Small surface, zero runtime
   dependencies, one file for the server. Don't add a dependency to save
   twenty lines.

## What to be careful with

These are the security-critical parts — changes here need extra review and a
smoke test proving the guards still hold:

- `authorized()` — token check on every request
- `resolveInRoot()` / `selectRoot()` — the root boundary, including symlinks
- `isBlocked()` — the secret blocklist
- `METACHAR` + allowlist logic in `run_command()` — no shell, exact match
- `atomicWrite()` and the write tools — no partial writes, no silent corruption

## Testing

There is no test framework (zero dependencies is a feature). Before a PR that
touches the server, run a smoke test against a scratch folder and show that:

- auth still rejects missing/wrong tokens,
- `../../` traversal and symlink escapes are rejected,
- secret files stay blocked,
- `run_command` still rejects metacharacters and non-allowlisted commands.

## Design discussions

`DESIGN.md` is internal and not in this repo. Propose design changes as GitHub
issues so the reasoning stays public.
