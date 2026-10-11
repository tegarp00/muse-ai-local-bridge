#!/usr/bin/env node
/**
 * muse-ai-local-bridge — server (V1, stage 2a: scaffold + read tools)
 *
 * Gives an AI client (e.g. Muse at muse.ai) scoped read access to the
 * folder this command runs in, over a GET-based tool API (see PROTOCOL.md).
 *
 * Zero runtime dependencies — only Node.js builtins. This is a security
 * feature: the whole server must stay auditable in minutes.
 *
 * Usage:
 *   cd your/project
 *   node server.js [--port N] [--read-only] [--allow "cmd"] [--token-file path]
 *
 * The server listens on 127.0.0.1 only. Expose it with your own tunnel
 * (Cloudflare Tunnel, ngrok, ...). Every request needs the X-Api-Key token
 * printed once at startup.
 */
'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function printHelp() {
  console.log(`muse-ai-local-bridge server (V1)

Usage: server.js [options]

  --port N          listen port (default 8787)
  --read-only       read-only mode ("baca"): write tools and run_command
                    are not listed and cannot be called
  --allow "cmd"     add a command pattern to the run_command allowlist
                    (repeatable; not used yet in stage 2a)
  --token-file p    persist the API token in file p (mode 0600) instead of
                    generating a fresh one on every start
  -h, --help        this text

The working directory where this command runs becomes the single access
root. The server refuses to start in a drive root or your home directory.
Listens on 127.0.0.1 only — publish it with your own tunnel.`);
}

function parseArgs(argv) {
  const opts = { port: 8787, readOnly: false, allow: [], tokenFile: null };
  const args = argv.slice(2);
  const needValue = (i, flag) => {
    if (i >= args.length) { console.error(`error: ${flag} needs a value`); process.exit(2); }
    return args[i];
  };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--port') {
      opts.port = parseInt(needValue(++i, a), 10);
      if (!Number.isInteger(opts.port) || opts.port < 1 || opts.port > 65535) {
        console.error('error: --port needs a number 1-65535');
        process.exit(2);
      }
    } else if (a === '--read-only') {
      opts.readOnly = true;
    } else if (a === '--allow') {
      opts.allow.push(needValue(++i, a));
    } else if (a === '--token-file') {
      opts.tokenFile = needValue(++i, a);
    } else if (a === '-h' || a === '--help') {
      printHelp();
      process.exit(0);
    } else {
      console.error(`error: unknown flag: ${a}`);
      process.exit(2);
    }
  }
  return opts;
}

// ---------------------------------------------------------------------------
// Startup: scope guard + token
// ---------------------------------------------------------------------------

const opts = parseArgs(process.argv);

const ROOT = fs.realpathSync(process.cwd());
{
  const parsed = path.parse(ROOT);
  const home = fs.realpathSync(os.homedir());
  if (ROOT === parsed.root || ROOT === home) {
    console.error(
      'Refusing to start: the working directory is a drive root or your home\n' +
      'directory, which is too broad a scope. cd into your project folder first.'
    );
    process.exit(2);
  }
}

function loadToken(tokenFile) {
  if (!tokenFile) return crypto.randomBytes(32).toString('hex'); // 256-bit
  const p = path.resolve(tokenFile);
  if (fs.existsSync(p)) {
    const t = fs.readFileSync(p, 'utf8').trim();
    if (t) return t;
  }
  const t = crypto.randomBytes(32).toString('hex');
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, t + '\n', { mode: 0o600 });
  return t;
}
const TOKEN = loadToken(opts.tokenFile);
const TOKEN_BUF = Buffer.from(TOKEN, 'utf8');

function authorized(req) {
  const got = req.headers['x-api-key'];
  if (typeof got !== 'string' || !got) return false;
  const buf = Buffer.from(got, 'utf8');
  return buf.length === TOKEN_BUF.length && crypto.timingSafeEqual(buf, TOKEN_BUF);
}

// ---------------------------------------------------------------------------
// HTTP helpers: envelopes
// ---------------------------------------------------------------------------

function send(res, status, obj, contentType = 'application/json; charset=utf-8') {
  const body = typeof obj === 'string' ? obj : JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': contentType, 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}

const ok = (res, data) => send(res, 200, { ok: true, data });
const fail = (res, status, code, message) => send(res, status, { ok: false, error: { code, message } });

// ---------------------------------------------------------------------------
// Path rules (PROTOCOL.md section 5)
// ---------------------------------------------------------------------------

/** Resolve p inside ROOT (symlinks resolved). Returns {path} or {error}. */
function resolveInRoot(p) {
  const abs = path.resolve(ROOT, p || '.');
  let real;
  try {
    real = fs.realpathSync(abs);
  } catch {
    return { error: 'PATH_NOT_FOUND', message: `no such file or directory: ${p}` };
  }
  const rel = path.relative(ROOT, real);
  if (rel === '..' || rel.startsWith('..' + path.sep)) {
    return { error: 'PATH_OUTSIDE_ROOT', message: 'path is outside the allowed root' };
  }
  return { path: real };
}

/** Permanent secret blocklist — enforced even inside the root. */
function isBlocked(absPath) {
  const rel = path.relative(ROOT, absPath);
  const parts = rel.split(path.sep);
  for (const part of parts) {
    if (part === '.ssh' || part === '.aws' || part === '.gnupg') return true;
    if (/^\.env(\..+)?$/.test(part) && part !== '.env.example' && part !== '.env.sample') return true;
    if (part.endsWith('.key') || part.endsWith('.pem')) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// .gitignore support (small subset, no dependencies)
// ---------------------------------------------------------------------------

function gitignoreToRegExp(pattern) {
  // Returns {re, dirOnly} or null for blank/comment lines.
  let p = pattern.trim();
  if (!p || p.startsWith('#')) return null;
  let dirOnly = false;
  if (p.endsWith('/')) { dirOnly = true; p = p.slice(0, -1); }
  const anchored = p.startsWith('/');
  if (anchored) p = p.slice(1);
  // Escape regex chars, then restore glob wildcards.
  let re = p.replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*\//g, '\u0000')   // **/ -> placeholder
    .replace(/\*\*/g, '.*')
    .replace(/\u0000/g, '(.*/)?')
    .replace(/\*/g, '[^/]*')
    .replace(/\?/g, '[^/]');
  re = anchored ? `^${re}(/.*)?$` : `(^|/)${re}(/.*)?$`;
  return { re: new RegExp(re), dirOnly };
}

function loadIgnoreRules() {
  const rules = [{ re: /(^|\/)\.git(\/.*)?$/, dirOnly: false }]; // .git holds full history: noise for clients, never listed
  const fp = path.join(ROOT, '.gitignore');
  if (!fs.existsSync(fp)) return rules;
  for (const line of fs.readFileSync(fp, 'utf8').split('\n')) {
    if (line.trim().startsWith('!')) continue; // negations not supported in V1
    const r = gitignoreToRegExp(line);
    if (r) rules.push(r);
  }
  return rules;
}
const IGNORE_RULES = loadIgnoreRules();

function isIgnored(relPath, isDir) {
  const rel = relPath.split(path.sep).join('/');
  return IGNORE_RULES.some(r => (!r.dirOnly || isDir) && r.re.test(rel));
}

function isBinary(buf) {
  return buf.includes(0);
}

// ---------------------------------------------------------------------------
// Read tools (PROTOCOL.md section 6)
// ---------------------------------------------------------------------------

function tool_list_projects() {
  return { projects: [{ name: path.basename(ROOT), path: ROOT, is_default: true }] };
}

function tool_list_files(args) {
  const r = resolveInRoot(args.path || '.');
  if (r.error) return { error: r.error, message: r.message };
  if (isBlocked(r.path)) return { error: 'FILE_BLOCKED', message: 'path is on the secret blocklist' };
  let st;
  try { st = fs.statSync(r.path); } catch { return { error: 'PATH_NOT_FOUND', message: 'no such file or directory' }; }
  if (!st.isDirectory()) return { error: 'BAD_ARGS', message: 'path is not a directory' };

  const maxDepth = Math.min(Math.max(parseInt(args.max_depth ?? 3, 10) || 3, 0), 10);
  const recursive = args.recursive !== false;
  const includeHidden = args.include_hidden === true;
  const out = [];
  const CAP = 2000;

  function walk(dir, depth) {
    if (out.length >= CAP) return;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
    catch { return; }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const e of entries) {
      if (out.length >= CAP) return;
      if (!includeHidden && e.name.startsWith('.')) continue;
      const abs = path.join(dir, e.name);
      const rel = path.relative(ROOT, abs);
      const isDir = e.isDirectory();
      if (isIgnored(rel, isDir) || isBlocked(abs)) continue;
      out.push({ path: rel.split(path.sep).join('/'), type: isDir ? 'dir' : 'file' });
      if (recursive && isDir && depth < maxDepth) walk(abs, depth + 1);
    }
  }
  walk(r.path, 0);
  return { path: path.relative(ROOT, r.path).split(path.sep).join('/') || '.', files: out, truncated: out.length >= CAP };
}

function tool_read_file(args) {
  if (!args.path || typeof args.path !== 'string') {
    return { error: 'BAD_ARGS', message: 'path is required' };
  }
  const r = resolveInRoot(args.path);
  if (r.error) return { error: r.error, message: r.message };
  if (isBlocked(r.path)) return { error: 'FILE_BLOCKED', message: 'path is on the secret blocklist' };
  let st;
  try { st = fs.statSync(r.path); } catch { return { error: 'PATH_NOT_FOUND', message: 'no such file or directory' }; }
  if (st.isDirectory()) return { error: 'BAD_ARGS', message: 'path is a directory' };
  const MAX_BYTES = 1024 * 1024; // ~1 MB per call
  if (st.size > MAX_BYTES) return { error: 'BAD_ARGS', message: `file too large (${st.size} bytes, max ${MAX_BYTES})` };
  const buf = fs.readFileSync(r.path);
  if (isBinary(buf.subarray(0, 8000))) return { error: 'BAD_ARGS', message: 'file looks binary' };
  const lines = buf.toString('utf8').split('\n');
  const offset = Math.max(parseInt(args.offset ?? 0, 10) || 0, 0);
  const limit = Math.min(Math.max(parseInt(args.limit ?? 200, 10) || 200, 1), 2000);
  const slice = lines.slice(offset, offset + limit);
  return {
    path: path.relative(ROOT, r.path).split(path.sep).join('/'),
    total_lines: lines.length,
    offset,
    content: slice.join('\n'),
    truncated: offset + limit < lines.length,
  };
}

function tool_search_code(args) {
  if (!args.pattern || typeof args.pattern !== 'string') {
    return { error: 'BAD_ARGS', message: 'pattern is required' };
  }
  const r = resolveInRoot(args.path || '.');
  if (r.error) return { error: r.error, message: r.message };
  if (isBlocked(r.path)) return { error: 'FILE_BLOCKED', message: 'path is on the secret blocklist' };

  const pattern = args.pattern;
  const fileGlob = args.file_glob || null;
  const contextLines = Math.min(Math.max(parseInt(args.context_lines ?? 2, 10) || 0, 0), 5);
  const globRe = fileGlob ? new RegExp('^' + fileGlob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$') : null;
  const matches = [];
  const CAP_FILES = 5000, CAP_MATCHES = 200;
  let filesSeen = 0;

  function walk(dir) {
    if (matches.length >= CAP_MATCHES || filesSeen >= CAP_FILES) return;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
    catch { return; }
    for (const e of entries) {
      if (matches.length >= CAP_MATCHES || filesSeen >= CAP_FILES) return;
      if (e.name.startsWith('.') && e.name !== '.') {
        // still descend into non-ignored dot dirs? No — keep it simple, skip hidden.
        continue;
      }
      const abs = path.join(dir, e.name);
      const rel = path.relative(ROOT, abs);
      const isDir = e.isDirectory();
      if (isIgnored(rel, isDir) || isBlocked(abs)) continue;
      if (isDir) { walk(abs); continue; }
      if (globRe && !globRe.test(e.name)) continue;
      filesSeen++;
      let buf;
      try {
        const st = fs.statSync(abs);
        if (st.size > 1024 * 1024) continue;
        buf = fs.readFileSync(abs);
      } catch { continue; }
      if (isBinary(buf.subarray(0, 8000))) continue;
      const lines = buf.toString('utf8').split('\n');
      for (let i = 0; i < lines.length && matches.length < CAP_MATCHES; i++) {
        if (lines[i].includes(pattern)) {
          const start = Math.max(0, i - contextLines);
          const end = Math.min(lines.length, i + contextLines + 1);
          matches.push({
            path: rel.split(path.sep).join('/'),
            line: i + 1,
            context: lines.slice(start, end).join('\n'),
          });
        }
      }
    }
  }

  const startStat = fs.statSync(r.path);
  if (startStat.isDirectory()) walk(r.path);
  else {
    // single file search
    const rel = path.relative(ROOT, r.path);
    if (!isIgnored(rel, false)) {
      const lines = fs.readFileSync(r.path, 'utf8').split('\n');
      for (let i = 0; i < lines.length && matches.length < CAP_MATCHES; i++) {
        if (lines[i].includes(pattern)) matches.push({ path: rel.split(path.sep).join('/'), line: i + 1, context: lines[i] });
      }
    }
  }
  return { pattern, matches, truncated: matches.length >= CAP_MATCHES };
}

// ---------------------------------------------------------------------------
// git helpers — spawned with argv arrays, never through a shell
// ---------------------------------------------------------------------------

function gitIsRepo() {
  const r = spawnSync('git', ['rev-parse', '--is-inside-work-tree'], { cwd: ROOT, encoding: 'utf8', timeout: 10000 });
  return r.status === 0;
}

function gitRun(gitArgs, timeoutMs = 15000) {
  const r = spawnSync('git', gitArgs, { cwd: ROOT, encoding: 'utf8', timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 });
  return r;
}

function tool_git_status() {
  if (!gitIsRepo()) return { error: 'BAD_ARGS', message: 'not a git repository' };
  const r = gitRun(['status', '--porcelain=v1', '--untracked-files=normal']);
  if (r.status !== 0) return { error: 'INTERNAL_ERROR', message: (r.stderr || 'git status failed').trim() };
  const files = r.stdout.split('\n').filter(Boolean).map(line => ({
    status: line.slice(0, 2).trim() || '?',
    path: line.slice(3).trim(),
  }));
  const branch = gitRun(['rev-parse', '--abbrev-ref', 'HEAD']);
  return { branch: branch.status === 0 ? branch.stdout.trim() : null, files };
}

function tool_git_diff(args) {
  if (!gitIsRepo()) return { error: 'BAD_ARGS', message: 'not a git repository' };
  const gitArgs = ['diff', '--no-color'];
  if (args.staged) gitArgs.push('--cached');
  if (args.path) {
    const r = resolveInRoot(args.path);
    if (r.error) return { error: r.error, message: r.message };
    gitArgs.push('--', r.path);
  }
  const r = gitRun(gitArgs, 30000);
  if (r.status !== 0) return { error: 'INTERNAL_ERROR', message: (r.stderr || 'git diff failed').trim() };
  const MAX = 200000;
  return { diff: r.stdout.slice(0, MAX), truncated: r.stdout.length > MAX };
}

function tool_git_log(args) {
  if (!gitIsRepo()) return { error: 'BAD_ARGS', message: 'not a git repository' };
  const limit = Math.min(Math.max(parseInt(args.limit ?? 20, 10) || 20, 1), 100);
  const r = gitRun(['log', `-n${limit}`, '--pretty=format:%H%x1f%an%x1f%ad%x1f%s', '--date=iso']);
  if (r.status !== 0) return { error: 'INTERNAL_ERROR', message: (r.stderr || 'git log failed').trim() };
  const commits = r.stdout.split('\n').filter(Boolean).map(line => {
    const [hash, author, date, subject] = line.split('\x1f');
    return { hash, author, date, subject };
  });
  return { commits };
}

// ---------------------------------------------------------------------------
// Tool registry (names frozen per PROTOCOL.md — do not rename)
// ---------------------------------------------------------------------------

const READ_TOOLS = {
  list_projects: { fn: tool_list_projects, description: 'List allowed project roots.', parameters: {} },
  list_files: {
    fn: tool_list_files,
    description: 'List files and directories under a path relative to the exposed root.',
    parameters: { path: 'string (default ".")', max_depth: 'integer 0-10 (default 3)', recursive: 'bool (default true)', include_hidden: 'bool (default false)' },
  },
  read_file: {
    fn: tool_read_file,
    description: 'Read a text file with line pagination (max ~1 MB per call).',
    parameters: { path: 'string (required)', offset: 'integer (default 0)', limit: 'integer (default 200, max 2000)' },
  },
  search_code: {
    fn: tool_search_code,
    description: 'Literal text search under a path.',
    parameters: { pattern: 'string (required)', path: 'string (default ".")', file_glob: 'string like "*.go"', context_lines: 'integer 0-5 (default 2)' },
  },
  git_status: { fn: tool_git_status, description: 'Per-file git status.', parameters: {} },
  git_diff: {
    fn: tool_git_diff,
    description: 'Unified git diff.',
    parameters: { staged: 'bool (default false)', path: 'string (optional)' },
  },
  git_log: {
    fn: tool_git_log,
    description: 'Recent commits.',
    parameters: { limit: 'integer 1-100 (default 20)' },
  },
};

// Stage 2a ships read tools only. Write tools + run_command land in stage 2b.
const WRITE_TOOLS = {};
const ALL_TOOLS = opts.readOnly ? READ_TOOLS : { ...READ_TOOLS, ...WRITE_TOOLS };

function serveToolsList(res) {
  ok(res, {
    mode: opts.readOnly ? 'baca' : 'kerja',
    project_roots: [ROOT],
    tools: Object.entries(ALL_TOOLS).map(([name, t]) => ({
      name,
      description: t.description,
      parameters: t.parameters,
    })),
  });
}

function handleCall(url, res) {
  const name = url.searchParams.get('tool');
  const rawArgs = url.searchParams.get('args') || '{}';
  if (!name) return fail(res, 400, 'BAD_ARGS', 'missing tool parameter');
  const tool = ALL_TOOLS[name];
  if (!tool) {
    const known = Object.keys(READ_TOOLS).includes(name);
    return fail(res, 404, known ? 'MODE_READ_ONLY' : 'UNKNOWN_TOOL',
      known ? `tool "${name}" is not available in read-only mode` : `unknown tool: ${name}`);
  }
  let args;
  try {
    args = JSON.parse(rawArgs);
    if (typeof args !== 'object' || args === null || Array.isArray(args)) throw new Error('not an object');
  } catch {
    return fail(res, 400, 'BAD_ARGS', 'args is not a valid JSON object');
  }
  let result;
  try {
    result = tool.fn(args);
  } catch (e) {
    return fail(res, 500, 'INTERNAL_ERROR', `tool crashed: ${e.message}`);
  }
  if (result && result.error) {
    const status = result.error === 'PATH_OUTSIDE_ROOT' || result.error === 'FILE_BLOCKED' ? 403
      : result.error === 'PATH_NOT_FOUND' ? 404
      : 400;
    return fail(res, status, result.error, result.message || result.error);
  }
  ok(res, result);
}

// ---------------------------------------------------------------------------
// /skill.md — the server serves its own skill doc (zero-install bootstrap)
// ---------------------------------------------------------------------------

const EMBEDDED_SKILL = `# muse-ai-local-bridge skill (embedded fallback)

This bridge exposes a GET tool API (see PROTOCOL.md in the repo):

- GET /api/tools/list — tool list for the current mode
- GET /api/tools/call?tool=<name>&args=<json> — call a tool

Auth: X-Api-Key header on every request (token from the secure connection card).

Discipline:
- Read tools are free to use.
- Write tools / run_command (kerja mode): ALWAYS obtain explicit owner approval
  in chat first, showing the exact path/command and what will change.
- Never write secrets into files. Never attempt path traversal.
`;

function serveSkill(res) {
  const repoSkill = path.join(__dirname, 'skills', 'muse-ai-local-bridge', 'SKILL.md');
  const doc = fs.existsSync(repoSkill) ? fs.readFileSync(repoSkill, 'utf8') : EMBEDDED_SKILL;
  send(res, 200, doc, 'text/markdown; charset=utf-8');
}

// ---------------------------------------------------------------------------
// HTTP server — localhost only, GET only, token on every request
// ---------------------------------------------------------------------------

const server = http.createServer((req, res) => {
  let url;
  try {
    url = new URL(req.url, 'http://localhost');
  } catch {
    return fail(res, 400, 'BAD_ARGS', 'malformed URL');
  }
  if (req.method !== 'GET') return fail(res, 405, 'METHOD_NOT_ALLOWED', 'only GET is supported');
  if (!authorized(req)) return fail(res, 401, 'INVALID_TOKEN', 'missing or invalid token');
  if (url.pathname === '/skill.md') return serveSkill(res);
  if (url.pathname === '/api/tools/list') return serveToolsList(res);
  if (url.pathname === '/api/tools/call') return handleCall(url, res);
  return fail(res, 404, 'UNKNOWN_ENDPOINT', `unknown endpoint: ${url.pathname}`);
});

server.listen(opts.port, '127.0.0.1', () => {
  const addr = server.address();
  const port = typeof addr === 'object' ? addr.port : opts.port;
  console.log('');
  console.log('muse-ai-local-bridge server running (V1, stage 2a: read tools)');
  console.log(`  root : ${ROOT}`);
  console.log(`  mode : ${opts.readOnly ? 'baca (read-only)' : 'kerja (read + write + commands)'}`);
  console.log(`  local: http://127.0.0.1:${port}`);
  console.log('');
  console.log('  TOKEN (shown once — keep it secret, never paste into chat):');
  console.log(`  ${TOKEN}`);
  console.log('');
  console.log('  Next steps:');
  console.log(`  1. Publish localhost with your tunnel, e.g.: cloudflared tunnel --url http://127.0.0.1:${port}`);
  console.log('  2. In Muse chat, paste:  connect bridge: <your-tunnel-url>');
  console.log('  3. Enter the token above in the connection card when asked.');
  console.log('');
});
