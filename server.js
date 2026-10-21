#!/usr/bin/env node
/**
 * muse-ai-local-bridge — server (V1)
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
       server.js add <folder> | remove <name-or-path> | list

  --port N          listen port (default 8787)
  --read-only       read-only mode: write tools and run_command
                    are not listed and cannot be called.
  --allow "cmd"     add a command pattern to the run_command allowlist
                    (repeatable; exact match, no shell metacharacters)
  --token-file p    persist the API token in file p (mode 0600) instead of
                    the default ~/.muse-ai-local-bridge/token
  --new-token       generate a fresh token, replacing the saved one
  -h, --help        this text

The working directory where this command runs becomes the single access
root. The server refuses to start in a drive root or your home directory.
Listens on 127.0.0.1 only — publish it with your own tunnel.`);
}

function parseArgs(argv) {
  const opts = { port: 8787, readOnly: false, allow: [], tokenFile: null, newToken: false };
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
    } else if (a === '--new-token') {
      opts.newToken = true;
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

const CONFIG_PATH = path.join(os.homedir(), '.muse-ai-local-bridge', 'config.json');

// ---------------------------------------------------------------------------
// Project management subcommands — no hand-editing JSON needed:
//
//   muse-ai-local-bridge add <folder>       add a project root
//   muse-ai-local-bridge remove <name|path> remove a project root
//   muse-ai-local-bridge list               show registered roots
//
// They only edit the config file; a running server picks it up via hot-reload.
// ---------------------------------------------------------------------------

function readConfigFile() {
  try {
    const cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    if (cfg && Array.isArray(cfg.roots)) return cfg;
  } catch { /* missing or broken: start fresh */ }
  return { roots: [] };
}

function writeConfigFile(cfg) {
  fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2) + '\n', { mode: 0o600 });
}

/** Same guards as server roots: must exist, be a directory, not home/drive root. */
function validateRootDir(p) {
  let real;
  try { real = fs.realpathSync(p); }
  catch { return { error: `not found: ${p}` }; }
  try {
    if (!fs.statSync(real).isDirectory()) return { error: `not a directory: ${p}` };
  } catch { return { error: `not found: ${p}` }; }
  const parsed = path.parse(real);
  if (real === parsed.root || real === fs.realpathSync(os.homedir())) {
    return { error: `too broad, refusing: ${p}` };
  }
  return { name: path.basename(real), path: real };
}

function cmdAdd(target) {
  if (!target) { console.error('usage: muse-ai-local-bridge add <folder>'); process.exit(2); }
  const v = validateRootDir(target);
  if (v.error) { console.error(`error: ${v.error}`); process.exit(1); }
  const cfg = readConfigFile();
  const hadConfig = cfg.roots.length > 0;
  // First add ever: the server was running in cwd-mode, so keep the current
  // folder as a root — otherwise the user's current project silently drops
  // out of the list the moment they add a second one.
  if (!hadConfig) {
    const cwdV = validateRootDir(process.cwd());
    if (!cwdV.error && cwdV.path !== v.path) cfg.roots.push(cwdV.path);
  }
  const dup = cfg.roots.some(e => {
    try { return fs.realpathSync(typeof e === 'string' ? e : e.path) === v.path; }
    catch { return false; }
  });
  if (dup) { console.log(`already registered: ${v.path}`); return; }
  cfg.roots.push(v.path);
  writeConfigFile(cfg);
  console.log(`added: ${v.path}`);
  if (!hadConfig && cfg.roots.length > 1) console.log(`kept: ${cfg.roots[0]} (current folder)`);
  console.log('A running server picks it up automatically — no restart needed.');
}

function cmdRemove(target) {
  if (!target) { console.error('usage: muse-ai-local-bridge remove <name-or-path>'); process.exit(2); }
  const cfg = readConfigFile();
  let real = null;
  try { real = fs.realpathSync(target); } catch { /* match by name then */ }
  const s = target.toLowerCase();
  const before = cfg.roots.length;
  cfg.roots = cfg.roots.filter(e => {
    const ep = typeof e === 'string' ? e : e.path;
    const nm = (typeof e === 'object' && e.name) || path.basename(ep);
    if (real) { try { if (fs.realpathSync(ep) === real) return false; } catch { /* keep */ } }
    return nm.toLowerCase() !== s;
  });
  if (cfg.roots.length === before) { console.error(`error: no such project: ${target}`); process.exit(1); }
  writeConfigFile(cfg);
  console.log(`removed: ${target}`);
}

function cmdList() {
  const cfg = readConfigFile();
  if (cfg.roots.length === 0) {
    // No config file: the server serves its start folder. Show what that is here.
    const cwd = fs.realpathSync(process.cwd());
    const parsed = path.parse(cwd);
    const home = fs.realpathSync(os.homedir());
    console.log(`* ${path.basename(cwd)}  ${cwd}`);
    if (cwd === parsed.root || cwd === home) {
      console.log('\nNote: this folder is too broad — the server would refuse to start here.');
    } else {
      console.log('\n* = current folder (no config file: the server serves its start folder)');
    }
    return;
  }
  cfg.roots.forEach((e, i) => {
    const ep = typeof e === 'string' ? e : e.path;
    const nm = (typeof e === 'object' && e.name) || path.basename(ep);
    console.log(`${i === 0 ? '*' : ' '} ${nm}  ${ep}`);
  });
  console.log('\n* = default project');
}

const subcommand = process.argv[2];
if (subcommand === 'add' || subcommand === 'remove' || subcommand === 'list') {
  if (subcommand === 'add') cmdAdd(process.argv[3]);
  else if (subcommand === 'remove') cmdRemove(process.argv[3]);
  else cmdList();
  process.exit(0);
}

const opts = parseArgs(process.argv);

/**
 * Explicit multi-root config. Returns [{name, path}] or null when absent.
 * Every root gets the same guards as the cwd root (must exist, must not be
 * a drive root or the home directory).
 */
function loadRoots() {
  if (!fs.existsSync(CONFIG_PATH)) return null;
  let cfg;
  try { cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')); }
  catch { console.error(`warning: ${CONFIG_PATH} is not valid JSON, ignoring`); return null; }
  const entries = cfg.roots;
  if (!Array.isArray(entries) || entries.length === 0) {
    console.error(`warning: ${CONFIG_PATH} has no "roots" array, ignoring`);
    return null;
  }
  const home = fs.realpathSync(os.homedir());
  const roots = [];
  for (const e of entries) {
    const p = typeof e === 'string' ? e : (e && e.path);
    if (typeof p !== 'string') continue;
    let real;
    try { real = fs.realpathSync(p); }
    catch { console.error(`warning: root not found, skipping: ${p}`); continue; }
    const parsed = path.parse(real);
    if (real === parsed.root || real === home) {
      console.error(`warning: root too broad, skipping: ${p}`);
      continue;
    }
    roots.push({ name: (typeof e === 'object' && e.name) || path.basename(real), path: real });
  }
  if (roots.length === 0) { console.error(`warning: no valid roots in ${CONFIG_PATH}, ignoring`); return null; }
  return roots;
}

const START_CWD = fs.realpathSync(process.cwd());

/**
 * Hot-reloadable roots. The config file is re-read whenever its mtime
 * changes, so adding a project never needs a server restart. Invalid edits
 * keep the previous roots (with a warning) instead of breaking the server.
 */
let rootsCache = { mtime: -1, roots: null };

function getRoots() {
  let mtime = 0;
  try { mtime = fs.statSync(CONFIG_PATH).mtimeMs; } catch { /* no config file */ }
  if (rootsCache.roots === null || mtime !== rootsCache.mtime) {
    const fromConfig = loadRoots();
    let roots;
    if (fromConfig) {
      roots = fromConfig; // explicit scope: cwd is irrelevant in config mode
    } else {
      const parsed = path.parse(START_CWD);
      const home = fs.realpathSync(os.homedir());
      if (START_CWD === parsed.root || START_CWD === home) {
        console.error(
          'Refusing to start: the working directory is a drive root or your home\n' +
          'directory, which is too broad a scope. cd into your project folder first.'
        );
        process.exit(2);
      }
      roots = [{ name: path.basename(START_CWD), path: START_CWD }];
    }
    rootsCache = { mtime, roots };
  }
  return rootsCache.roots;
}

// Resolve once at startup so a bad launch fails fast instead of serving nothing.
getRoots();

/** Pick the root for a call: args.project (name or path), else the default. */
function selectRoot(args) {
  const roots = getRoots();
  const sel = args.project;
  if (sel === undefined || sel === null || sel === '') return { root: roots[0] };
  const s = String(sel).toLowerCase();
  const found = roots.find(r => r.name.toLowerCase() === s || r.path.toLowerCase() === s);
  if (!found) return { error: 'BAD_ARGS', message: `unknown project: ${sel} (see list_projects)` };
  return { root: found };
}

function loadToken(tokenFile, forceNew) {
  // Default: a stable token saved under ~/.muse-ai-local-bridge/token, so a
  // layman user never has to think about it — restart keeps working.
  const p = path.resolve(tokenFile || path.join(os.homedir(), '.muse-ai-local-bridge', 'token'));
  if (!forceNew && fs.existsSync(p)) {
    const t = fs.readFileSync(p, 'utf8').trim();
    if (t) return { token: t, fresh: false, path: p };
  }
  const t = crypto.randomBytes(32).toString('hex'); // 256-bit
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, t + '\n', { mode: 0o600 });
  return { token: t, fresh: true, path: p };
}
const { token: TOKEN, fresh: TOKEN_FRESH, path: TOKEN_PATH } = loadToken(opts.tokenFile, opts.newToken);
const TOKEN_BUF = Buffer.from(TOKEN, 'utf8');

function tokenMatches(provided) {
  if (typeof provided !== 'string' || !provided) return false;
  const buf = Buffer.from(provided, 'utf8');
  return buf.length === TOKEN_BUF.length && crypto.timingSafeEqual(buf, TOKEN_BUF);
}

function authorized(req) {
  // Canonical: X-Api-Key. Fallback: Authorization: Bearer — many client
  // frameworks default to it, and guessing wrong costs the owner an
  // explanation round-trip. Same token, same secrecy, no weaker.
  if (tokenMatches(req.headers['x-api-key'])) return true;
  const authz = req.headers['authorization'];
  if (typeof authz === 'string' && authz.startsWith('Bearer ')) {
    return tokenMatches(authz.slice(7));
  }
  return false;
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

/** Resolve p inside root (symlinks resolved). Returns {path} or {error}. */
function resolveInRoot(p, root) {
  const abs = path.resolve(root.path, p || '.');
  let real;
  try {
    real = fs.realpathSync(abs);
  } catch {
    return { error: 'PATH_NOT_FOUND', message: `no such file or directory: ${p}` };
  }
  const rel = path.relative(root.path, real);
  if (rel === '..' || rel.startsWith('..' + path.sep)) {
    return { error: 'PATH_OUTSIDE_ROOT', message: 'path is outside the allowed root' };
  }
  return { path: real };
}

/** Permanent secret blocklist — enforced even inside the root. */
function isBlocked(absPath, root) {
  const rel = path.relative(root.path, absPath);
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

const ignoreCache = new Map(); // root.path -> rules (.gitignore is per root)

function getIgnoreRules(root) {
  if (!ignoreCache.has(root.path)) {
    const rules = [{ re: /(^|\/)\.git(\/.*)?$/, dirOnly: false }]; // .git holds full history: noise for clients, never listed
    const fp = path.join(root.path, '.gitignore');
    if (fs.existsSync(fp)) {
      for (const line of fs.readFileSync(fp, 'utf8').split('\n')) {
        if (line.trim().startsWith('!')) continue; // negations not supported in V1
        const r = gitignoreToRegExp(line);
        if (r) rules.push(r);
      }
    }
    ignoreCache.set(root.path, rules);
  }
  return ignoreCache.get(root.path);
}

function isIgnored(relPath, isDir, root) {
  const rel = relPath.split(path.sep).join('/');
  return getIgnoreRules(root).some(r => (!r.dirOnly || isDir) && r.re.test(rel));
}

function isBinary(buf) {
  return buf.includes(0);
}

// ---------------------------------------------------------------------------
// Read tools (PROTOCOL.md section 6)
// ---------------------------------------------------------------------------

function tool_list_projects() {
  const roots = getRoots();
  return { projects: roots.map((r, i) => ({ name: r.name, path: r.path, is_default: i === 0 })) };
}

function tool_list_files(args) {
  const sel = selectRoot(args);
  if (sel.error) return sel;
  const root = sel.root;
  const r = resolveInRoot(args.path || '.', root);
  if (r.error) return { error: r.error, message: r.message };
  if (isBlocked(r.path, root)) return { error: 'FILE_BLOCKED', message: 'path is on the secret blocklist' };
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
      const rel = path.relative(root.path, abs);
      const isDir = e.isDirectory();
      if (isIgnored(rel, isDir, root) || isBlocked(abs, root)) continue;
      out.push({ path: rel.split(path.sep).join('/'), type: isDir ? 'dir' : 'file' });
      if (recursive && isDir && depth < maxDepth) walk(abs, depth + 1);
    }
  }
  walk(r.path, 0);
  return { path: path.relative(root.path, r.path).split(path.sep).join('/') || '.', files: out, truncated: out.length >= CAP };
}

function tool_read_file(args) {
  if (!args.path || typeof args.path !== 'string') {
    return { error: 'BAD_ARGS', message: 'path is required (e.g. ?tool=read_file&path=README.md)' };
  }
  const sel = selectRoot(args);
  if (sel.error) return sel;
  const root = sel.root;
  const r = resolveInRoot(args.path, root);
  if (r.error) return { error: r.error, message: r.message };
  if (isBlocked(r.path, root)) return { error: 'FILE_BLOCKED', message: 'path is on the secret blocklist' };
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
    path: path.relative(root.path, r.path).split(path.sep).join('/'),
    total_lines: lines.length,
    offset,
    content: slice.join('\n'),
    truncated: offset + limit < lines.length,
  };
}

function tool_search_code(args) {
  if (!args.pattern || typeof args.pattern !== 'string') {
    return { error: 'BAD_ARGS', message: 'pattern is required (e.g. ?tool=search_code&pattern=TODO)' };
  }
  const sel = selectRoot(args);
  if (sel.error) return sel;
  const root = sel.root;
  const r = resolveInRoot(args.path || '.', root);
  if (r.error) return { error: r.error, message: r.message };
  if (isBlocked(r.path, root)) return { error: 'FILE_BLOCKED', message: 'path is on the secret blocklist' };

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
      const rel = path.relative(root.path, abs);
      const isDir = e.isDirectory();
      if (isIgnored(rel, isDir, root) || isBlocked(abs, root)) continue;
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
    const rel = path.relative(root.path, r.path);
    if (!isIgnored(rel, false, root)) {
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

function gitIsRepo(root) {
  const r = spawnSync('git', ['rev-parse', '--is-inside-work-tree'], { cwd: root.path, encoding: 'utf8', timeout: 10000 });
  return r.status === 0;
}

function gitRun(gitArgs, root, timeoutMs = 15000) {
  const r = spawnSync('git', gitArgs, { cwd: root.path, encoding: 'utf8', timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 });
  return r;
}

function tool_git_status(args) {
  const sel = selectRoot(args);
  if (sel.error) return sel;
  const root = sel.root;
  if (!gitIsRepo(root)) return { error: 'BAD_ARGS', message: 'not a git repository' };
  const r = gitRun(['status', '--porcelain=v1', '--untracked-files=normal'], root);
  if (r.status !== 0) return { error: 'INTERNAL_ERROR', message: (r.stderr || 'git status failed').trim() };
  const files = r.stdout.split('\n').filter(Boolean).map(line => ({
    status: line.slice(0, 2).trim() || '?',
    path: line.slice(3).trim(),
  }));
  const branch = gitRun(['rev-parse', '--abbrev-ref', 'HEAD'], root);
  return { branch: branch.status === 0 ? branch.stdout.trim() : null, files };
}

function tool_git_diff(args) {
  const sel = selectRoot(args);
  if (sel.error) return sel;
  const root = sel.root;
  if (!gitIsRepo(root)) return { error: 'BAD_ARGS', message: 'not a git repository' };
  const gitArgs = ['diff', '--no-color'];
  if (args.staged) gitArgs.push('--cached');
  if (args.path) {
    const r = resolveInRoot(args.path, root);
    if (r.error) return { error: r.error, message: r.message };
    gitArgs.push('--', r.path);
  }
  const r = gitRun(gitArgs, root, 30000);
  if (r.status !== 0) return { error: 'INTERNAL_ERROR', message: (r.stderr || 'git diff failed').trim() };
  const MAX = 200000;
  return { diff: r.stdout.slice(0, MAX), truncated: r.stdout.length > MAX };
}

function tool_git_log(args) {
  const sel = selectRoot(args);
  if (sel.error) return sel;
  const root = sel.root;
  if (!gitIsRepo(root)) return { error: 'BAD_ARGS', message: 'not a git repository' };
  const limit = Math.min(Math.max(parseInt(args.limit ?? 20, 10) || 20, 1), 100);
  const r = gitRun(['log', `-n${limit}`, '--pretty=format:%H%x1f%an%x1f%ad%x1f%s', '--date=iso'], root);
  if (r.status !== 0) return { error: 'INTERNAL_ERROR', message: (r.stderr || 'git log failed').trim() };
  const commits = r.stdout.split('\n').filter(Boolean).map(line => {
    const [hash, author, date, subject] = line.split('\x1f');
    return { hash, author, date, subject };
  });
  return { commits };
}

// ---------------------------------------------------------------------------
// Audit log — append-only record of every write and command (PROTOCOL.md 8)
// ---------------------------------------------------------------------------

function auditLog(tool, target, result) {
  try {
    const dir = path.join(os.homedir(), '.muse-ai-local-bridge');
    fs.mkdirSync(dir, { recursive: true });
    const line = `${new Date().toISOString()}\t${tool}\t${target}\t${result}\n`;
    fs.appendFileSync(path.join(dir, 'audit.log'), line);
  } catch {
    // Audit must never break the tool it records.
  }
}

/** Atomic write: temp file in the same directory, then rename. */
function atomicWrite(absPath, content) {
  const dir = path.dirname(absPath);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `.${path.basename(absPath)}.tmp-${crypto.randomBytes(8).toString('hex')}`);
  fs.writeFileSync(tmp, content, 'utf8');
  fs.renameSync(tmp, absPath);
}

// ---------------------------------------------------------------------------
// Write tools (PROTOCOL.md section 6) — read-write mode only
// ---------------------------------------------------------------------------

const MAX_WRITE_BYTES = 1024 * 1024; // 1 MB

function tool_write_file(args) {
  if (!args.path || typeof args.path !== 'string') return { error: 'BAD_ARGS', message: 'path is required (e.g. ?tool=write_file&path=notes.txt&content=...)' };
  if (typeof args.content !== 'string') return { error: 'BAD_ARGS', message: 'content must be a string' };
  if (Buffer.byteLength(args.content, 'utf8') > MAX_WRITE_BYTES) {
    return { error: 'BAD_ARGS', message: `content too large (max ${MAX_WRITE_BYTES} bytes)` };
  }
  const sel = selectRoot(args);
  if (sel.error) return sel;
  const root = sel.root;
  const r = resolveInRoot(args.path, root);
  if (r.error && r.error !== 'PATH_NOT_FOUND') return { error: r.error, message: r.message };
  // resolveInRoot fails on missing paths; for writes, resolve the nearest
  // existing ancestor instead and let atomicWrite create the missing folders.
  // Only the ancestor goes through realpath, so symlink escapes stay rejected;
  // the segments appended below it are plain names, re-checked in-root below.
  let abs;
  if (r.error === 'PATH_NOT_FOUND') {
    const dir = path.dirname(args.path);
    const parts = dir === '.' ? [] : dir.split(path.sep).filter((s) => s && s !== '.');
    let ancestor = null;
    let missing = [];
    for (let i = parts.length; i >= 0; i--) {
      const res = resolveInRoot(i === 0 ? '.' : parts.slice(0, i).join(path.sep), root);
      if (!res.error) {
        ancestor = res.path;
        missing = parts.slice(i);
        break;
      }
      if (res.error !== 'PATH_NOT_FOUND') return { error: res.error, message: res.message };
    }
    if (!ancestor) return { error: 'PATH_NOT_FOUND', message: `no existing ancestor for: ${args.path}` };
    abs = path.join(ancestor, ...missing, path.basename(args.path));
    const rel = path.relative(root.path, abs);
    if (rel === '..' || rel.startsWith('..' + path.sep)) return { error: 'PATH_OUTSIDE_ROOT', message: 'path is outside the allowed root' };
  } else {
    abs = r.path;
  }
  if (isBlocked(abs, root)) return { error: 'FILE_BLOCKED', message: 'path is on the secret blocklist' };
  try {
    if (fs.existsSync(abs) && fs.statSync(abs).isDirectory()) {
      return { error: 'BAD_ARGS', message: 'path is a directory' };
    }
    atomicWrite(abs, args.content);
  } catch (e) {
    return { error: 'WRITE_ATOMIC_FAILED', message: `write failed: ${e.message}` };
  }
  const relPath = path.relative(root.path, abs).split(path.sep).join('/');
  auditLog('write_file', relPath, 'ok');
  return { path: relPath, bytes_written: Buffer.byteLength(args.content, 'utf8') };
}

function tool_edit_file(args) {
  for (const k of ['path', 'old_text', 'new_text']) {
    if (typeof args[k] !== 'string') return { error: 'BAD_ARGS', message: `${k} is required and must be a string (e.g. ?tool=edit_file&path=f.txt&old_text=..&new_text=..)` };
  }
  const sel = selectRoot(args);
  if (sel.error) return sel;
  const root = sel.root;
  const r = resolveInRoot(args.path, root);
  if (r.error) return { error: r.error, message: r.message };
  if (isBlocked(r.path, root)) return { error: 'FILE_BLOCKED', message: 'path is on the secret blocklist' };
  let content;
  try { content = fs.readFileSync(r.path, 'utf8'); }
  catch { return { error: 'PATH_NOT_FOUND', message: 'no such file or directory' }; }
  // Literal match — never regex. Exactly one occurrence, or refuse.
  const first = content.indexOf(args.old_text);
  if (first === -1) return { error: 'BAD_ARGS', message: 'old_text not found' };
  if (content.indexOf(args.old_text, first + 1) !== -1) {
    return { error: 'BAD_ARGS', message: 'old_text matches more than once; make it unique' };
  }
  const next = content.slice(0, first) + args.new_text + content.slice(first + args.old_text.length);
  if (Buffer.byteLength(next, 'utf8') > MAX_WRITE_BYTES) {
    return { error: 'BAD_ARGS', message: `result too large (max ${MAX_WRITE_BYTES} bytes)` };
  }
  try { atomicWrite(r.path, next); }
  catch (e) { return { error: 'WRITE_ATOMIC_FAILED', message: `write failed: ${e.message}` }; }
  const relPath = path.relative(root.path, r.path).split(path.sep).join('/');
  auditLog('edit_file', relPath, 'ok');
  return { path: relPath, bytes_written: Buffer.byteLength(next, 'utf8') };
}

function tool_apply_patch(args) {
  if (typeof args.path !== 'string' || typeof args.patch !== 'string') {
    return { error: 'BAD_ARGS', message: 'path and patch are required strings' };
  }
  const sel = selectRoot(args);
  if (sel.error) return sel;
  const root = sel.root;
  const r = resolveInRoot(args.path, root);
  if (r.error) return { error: r.error, message: r.message };
  if (isBlocked(r.path, root)) return { error: 'FILE_BLOCKED', message: 'path is on the secret blocklist' };
  let lines;
  try { lines = fs.readFileSync(r.path, 'utf8').split('\n'); }
  catch { return { error: 'PATH_NOT_FOUND', message: 'no such file or directory' }; }

  // Parse hunks. Fuzz factor 0: every hunk must match at its exact position.
  // Body length is driven by the header counts (an empty line = empty
  // context line), so a trailing newline never becomes a phantom hunk line.
  const hunks = [];
  const patchLines = args.patch.split('\n');
  let i = 0;
  while (i < patchLines.length) {
    const m = patchLines[i].match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
    if (!m) { i++; continue; }
    const oldStart = parseInt(m[1], 10);
    let needOld = m[2] !== undefined ? parseInt(m[2], 10) : 1;
    let needNew = m[4] !== undefined ? parseInt(m[4], 10) : 1;
    i++;
    const oldLines = [], newLines = [];
    while (i < patchLines.length && (needOld > 0 || needNew > 0)) {
      const pl = patchLines[i];
      if (pl.startsWith('\\')) { i++; continue; } // "\ No newline at end of file"
      let tag, body;
      if (pl === '') { tag = ' '; body = ''; }
      else { tag = pl[0]; body = pl.slice(1); }
      if (tag === ' ') {
        if (needOld === 0 || needNew === 0) {
          return { error: 'BAD_ARGS', message: 'hunk body does not match header counts' };
        }
        oldLines.push(body); newLines.push(body); needOld--; needNew--;
      } else if (tag === '-') {
        if (needOld === 0) return { error: 'BAD_ARGS', message: 'hunk body does not match header counts' };
        oldLines.push(body); needOld--;
      } else if (tag === '+') {
        if (needNew === 0) return { error: 'BAD_ARGS', message: 'hunk body does not match header counts' };
        newLines.push(body); needNew--;
      } else {
        return { error: 'BAD_ARGS', message: `malformed patch line: ${pl.slice(0, 40)}` };
      }
      i++;
    }
    if (needOld !== 0 || needNew !== 0) {
      return { error: 'BAD_ARGS', message: 'hunk body truncated' };
    }
    hunks.push({ oldStart, oldLines, newLines });
  }
  if (hunks.length === 0) return { error: 'BAD_ARGS', message: 'no hunks found in patch' };

  // Apply back-to-front so earlier positions stay valid.
  const out = lines.slice();
  for (let h = hunks.length - 1; h >= 0; h--) {
    const { oldStart, oldLines, newLines } = hunks[h];
    const at = oldStart - 1;
    for (let k = 0; k < oldLines.length; k++) {
      if (out[at + k] !== oldLines[k]) {
        return { error: 'BAD_ARGS', message: `hunk ${hunks.length - h} does not match at line ${oldStart + k} (fuzz 0)` };
      }
    }
    out.splice(at, oldLines.length, ...newLines);
  }
  const next = out.join('\n');
  if (Buffer.byteLength(next, 'utf8') > MAX_WRITE_BYTES) {
    return { error: 'BAD_ARGS', message: `result too large (max ${MAX_WRITE_BYTES} bytes)` };
  }
  try { atomicWrite(r.path, next); }
  catch (e) { return { error: 'WRITE_ATOMIC_FAILED', message: `write failed: ${e.message}` }; }
  const relPath = path.relative(root.path, r.path).split(path.sep).join('/');
  auditLog('apply_patch', relPath, `${hunks.length} hunks ok`);
  return { path: relPath, hunks_applied: hunks.length };
}

// ---------------------------------------------------------------------------
// run_command — allowlisted commands only, never a shell (PROTOCOL.md 6)
// ---------------------------------------------------------------------------

const DEFAULT_ALLOW = ['npm run build', 'npm run typecheck', 'git status', 'git diff', 'git log'];
// Shell metacharacters: rejected before pattern matching, no exceptions.
// Rationale: with prefix matching, "git diff" would also allow
// "git diff --no-index /etc/passwd ..." — so matching is EXACT only.
const METACHAR = /[;&|$`\n<>*(){}[\]!#~]/;

function validateAllowlist(patterns) {
  for (const p of patterns) {
    if (METACHAR.test(p)) {
      console.error(`Refusing to start: --allow pattern contains shell metacharacters: ${p}`);
      process.exit(2);
    }
  }
}
const ALLOWLIST = [...DEFAULT_ALLOW, ...opts.allow];
validateAllowlist(ALLOWLIST);

function tool_run_command(args) {
  if (!args.command || typeof args.command !== 'string') {
    return { error: 'BAD_ARGS', message: 'command is required (e.g. ?tool=run_command&command=npm%20test)' };
  }
  const sel = selectRoot(args);
  if (sel.error) return sel;
  const root = sel.root;
  const cmd = args.command.trim();
  if (METACHAR.test(cmd)) {
    auditLog('run_command', cmd.slice(0, 80), 'rejected: metacharacter');
    return { error: 'COMMAND_REJECTED_METACHAR', message: 'command contains shell metacharacters' };
  }
  if (!ALLOWLIST.includes(cmd)) {
    auditLog('run_command', cmd.slice(0, 80), 'rejected: not allowlisted');
    return { error: 'COMMAND_NOT_ALLOWED', message: `command not on the allowlist: ${cmd}` };
  }
  // Exact match only (see METACHAR rationale above). Split the matched
  // pattern — which is metacharacter-free by construction — into argv.
  // No shell is ever involved.
  const argv = cmd.split(/\s+/);
  const timeoutMs = Math.min(Math.max((parseInt(args.timeout_s ?? 600, 10) || 600), 1), 1800) * 1000;
  let r;
  try {
    r = spawnSync(argv[0], argv.slice(1), { cwd: root.path, encoding: 'utf8', timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 });
  } catch (e) {
    auditLog('run_command', cmd, `error: ${e.message}`);
    return { error: 'INTERNAL_ERROR', message: `command failed to spawn: ${e.message}` };
  }
  const output = ((r.stdout || '') + (r.stderr || '')).slice(0, 200000);
  if (r.error && r.error.code === 'ETIMEDOUT') {
    auditLog('run_command', cmd, 'timeout');
    return { error: 'COMMAND_TIMEOUT', message: `timed out after ${timeoutMs / 1000}s`, partial_output: output };
  }
  auditLog('run_command', cmd, `exit ${r.status}`);
  return { command: cmd, exit_code: r.status, output, truncated: output.length >= 200000 };
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

// Write tools and run_command are only registered in read-write mode
// (see ALL_TOOLS below); in read-only mode they are not listed and not callable.
const WRITE_TOOLS = {
  write_file: {
    fn: tool_write_file,
    description: 'Write a file atomically (temp + rename). Max 1 MB.',
    parameters: { path: 'string (required)', content: 'string (required)' },
  },
  edit_file: {
    fn: tool_edit_file,
    description: 'Exact-match string replacement. old_text must match exactly once; written literally.',
    parameters: { path: 'string (required)', old_text: 'string (required)', new_text: 'string (required)' },
  },
  apply_patch: {
    fn: tool_apply_patch,
    description: 'Apply a unified diff with fuzz factor 0 (hunks must match at exact positions).',
    parameters: { path: 'string (required)', patch: 'string (required, unified diff)' },
  },
  run_command: {
    fn: tool_run_command,
    description: 'Run an allowlisted command without a shell. Exact match only; metacharacters rejected.',
    parameters: { command: 'string (required)', timeout_s: 'integer 1-1800 (default 600)' },
  },
};
const ALL_TOOLS = opts.readOnly ? READ_TOOLS : { ...READ_TOOLS, ...WRITE_TOOLS };

function serveToolsList(res) {
  ok(res, {
    mode: opts.readOnly ? 'read-only' : 'read-write',
    project_roots: getRoots().map(r => r.path),
    // How to call a tool — shown here because this is the response every
    // client reads before calling anything. Do NOT invent other URL shapes.
    call: 'GET /api/tools/call?tool=<name>&<param>=<value>...',
    call_example: 'GET /api/tools/call?tool=read_file&path=package.json',
    auth: 'X-Api-Key: <token> header (Authorization: Bearer <token> also accepted)',
    tools: Object.entries(ALL_TOOLS).map(([name, t]) => ({
      name,
      description: t.description,
      parameters: t.parameters,
    })),
  });
}

/** Query params arrive as strings; restore the scalar types tools expect. */
function coerceFlatValue(v) {
  if (v === 'true') return true;
  if (v === 'false') return false;
  if (v === 'null') return null;
  if (v !== '' && !Number.isNaN(Number(v))) return Number(v);
  return v;
}

function handleCall(url, res) {
  const name = url.searchParams.get('tool');
  const rawArgs = url.searchParams.get('args') || '{}';
  if (!name) return fail(res, 400, 'BAD_ARGS', 'missing tool parameter');
  const tool = ALL_TOOLS[name];
  if (!tool) {
    const known = Object.keys(READ_TOOLS).includes(name);
    return fail(res, 404, known ? 'MODE_READ_ONLY' : 'UNKNOWN_TOOL',
      known ? `tool "${name}" is not available in read-only mode` : `unknown tool: ${name} (see /api/tools/list)`);
  }
  let args;
  try {
    args = JSON.parse(rawArgs);
    if (typeof args !== 'object' || args === null || Array.isArray(args)) throw new Error('not an object');
  } catch {
    return fail(res, 400, 'BAD_ARGS', 'args is not a valid JSON object');
  }
  // Compatibility: some client frameworks flatten parameters into individual
  // query params (?tool=read_file&path=x&limit=50) instead of the args JSON
  // object. Merge them in; the args JSON wins on key conflicts.
  const flat = {};
  for (const [k, v] of url.searchParams) {
    if (k === 'tool' || k === 'args') continue;
    flat[k] = coerceFlatValue(v);
  }
  args = { ...flat, ...args };
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
- Write tools / run_command (read-write mode): ALWAYS obtain explicit owner approval
  in chat first, showing the exact path/command and what will change.
- Never write secrets into files. Never attempt path traversal.
`;

function serveSkill(res) {
  const repoSkill = path.join(__dirname, 'skills', 'muse-ai-local-bridge', 'SKILL.md');
  const doc = fs.existsSync(repoSkill) ? fs.readFileSync(repoSkill, 'utf8') : EMBEDDED_SKILL;
  send(res, 200, doc, 'text/markdown; charset=utf-8');
}

// ---------------------------------------------------------------------------
// HTTP server — localhost only, GET + POST, token on every request
// ---------------------------------------------------------------------------

/** Read a JSON body (for POST tool calls). Returns {} on empty/invalid. */
function readJsonBody(req) {
  return new Promise((resolve) => {
    let raw = '';
    req.on('data', (c) => { raw += c; if (raw.length > 2 * 1024 * 1024) req.destroy(); });
    req.on('end', () => {
      if (!raw) return resolve({});
      try { resolve(JSON.parse(raw)); } catch { resolve({}); }
    });
    req.on('error', () => resolve({}));
  });
}

const server = http.createServer(async (req, res) => {
  let url;
  try {
    url = new URL(req.url, 'http://localhost');
  } catch {
    return fail(res, 400, 'BAD_ARGS', 'malformed URL');
  }
  if (req.method !== 'GET' && req.method !== 'POST') {
    return fail(res, 405, 'METHOD_NOT_ALLOWED', 'only GET and POST are supported');
  }
  // POST: tool name + args come from the JSON body. Merge into the URL query
  // so the rest of the pipeline (auth, handleCall) works unchanged.
  if (req.method === 'POST') {
    const body = await readJsonBody(req);
    if (typeof body === 'object' && body !== null) {
      for (const [k, v] of Object.entries(body)) {
        if (k === 'args' && typeof v === 'object' && v !== null) {
          url.searchParams.set('args', JSON.stringify(v));
        } else if (typeof v !== 'object') {
          url.searchParams.set(k, String(v));
        }
      }
    }
  }
  // Public bootstrap: an assistant that has never seen a bridge must learn
  // how to connect from the URL alone — no token, no explaining. These two
  // routes carry no secrets; everything else stays behind the token.
  if (url.pathname === '/' || url.pathname === '/index.html') {
    return send(res, 200,
      'muse-ai-local-bridge\n\n' +
      'This is a local bridge server. To connect as an AI assistant:\n' +
      '1. Read /skill.md (no token needed).\n' +
      '2. Ask the owner for the token via secure input — never as chat text.\n' +
      '3. Send it as the X-Api-Key header on /api/tools/*.\n\n' +
      'To call a tool, GET (do not invent other URL shapes):\n' +
      '  /api/tools/call?tool=<name>&<param>=<value>...\n' +
      'Example:\n' +
      '  /api/tools/call?tool=read_file&path=package.json\n\n' +
      'Humans: https://github.com/tegarp00/muse-ai-local-bridge\n',
      'text/plain; charset=utf-8');
  }
  if (url.pathname === '/skill.md') return serveSkill(res);
  if (!authorized(req)) {
    // Self-describing: a client that guessed the wrong transport (e.g. a
    // connector defaulting to Authorization: Bearer) learns the right one
    // here instead of asking the owner.
    return fail(res, 401, 'INVALID_TOKEN',
      'missing or invalid token — send it in the X-Api-Key header (Authorization: Bearer <token> also accepted)');
  }
  if (url.pathname === '/api/tools/list') return serveToolsList(res);
  if (url.pathname === '/api/tools/call') return handleCall(url, res);
  // REST-style guess: some clients call /tools/<name>, /api/tools/<name>,
  // /v1/tools/<name> or /api/v1/tools/<name> instead of /api/tools/call.
  // Accept the shape; the query params are merged as args by handleCall.
  const restTool = url.pathname.match(/^\/(?:api\/)?(?:v1\/)?tools\/([a-z_]+)$/);
  if (restTool) {
    url.searchParams.set('tool', restTool[1]);
    return handleCall(url, res);
  }
  return fail(res, 404, 'UNKNOWN_ENDPOINT',
    `unknown endpoint: ${url.pathname} (tools live at GET /api/tools/call?tool=<name>&... — see /skill.md)`);
});

server.listen(opts.port, '127.0.0.1', () => {
  const addr = server.address();
  const port = typeof addr === 'object' ? addr.port : opts.port;
  console.log('');
  console.log('muse-ai-local-bridge server running (V1)');
  console.log(`  roots: ${getRoots().map(r => r.path).join(', ')}`);
  console.log(`  mode : ${opts.readOnly ? 'read-only' : 'read-write (read + write + commands)'}`);
  console.log(`  local: http://127.0.0.1:${port}`);
  console.log('');
  console.log('  TOKEN (keep it secret, never paste into chat):');
  console.log(`  ${TOKEN}`);
  console.log(TOKEN_FRESH
    ? `  (saved to ${TOKEN_PATH} — reused on next start; use --new-token to rotate)`
    : `  (reused from ${TOKEN_PATH} — use --new-token to rotate)`);
  console.log('');
  console.log('  Next steps:');
  console.log(`  1. Publish localhost with your tunnel, e.g.: cloudflared tunnel --url http://127.0.0.1:${port}`);
  console.log('  2. In chat, paste:  connect to my local bridge at <your-tunnel-url>');
  console.log('  3. Enter the token above in the connection card when asked.');
  console.log('');
});
