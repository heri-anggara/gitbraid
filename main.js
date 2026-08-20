'use strict';

const { app, BrowserWindow, Menu, ipcMain, dialog, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');

/* ── the three platforms ──────────────────────────────────────────── */

const IS_WIN = process.platform === 'win32';
const IS_MAC = process.platform === 'darwin';

/** `git diff --no-index` needs an empty file to compare a new one against. */
const NULL_DEVICE = IS_WIN ? 'NUL' : '/dev/null';

/* git runs GIT_EDITOR and GIT_SEQUENCE_EDITOR through a shell, and the tools
 * those commands would normally reach for — sed, cp, true — are not on a
 * Windows PATH. Rather than depend on them, GitBraid hands git a tiny script
 * and runs it with its own Electron binary in Node mode: the one interpreter
 * every installation is guaranteed to have. */
let editorSeq = 0;

function nodeEditor(body, ...args) {
  // A counter, not a timestamp: two of these are written in the same
  // millisecond, and a shared name means one silently overwrites the other.
  const file = path.join(os.tmpdir(), `gitbraid-editor-${process.pid}-${++editorSeq}.js`);
  fs.writeFileSync(file, body);
  const parts = [process.execPath, file, ...args].map((p) => JSON.stringify(p));
  return { command: parts.join(' '), file };
}

/* argv[2] is the script's own extra argument, argv[3] the file git passes. */
const REWORD_SEQUENCE = `
const fs = require('fs');
const todo = process.argv[2];
const lines = fs.readFileSync(todo, 'utf8').split('\\n');
for (let i = 0; i < lines.length; i++) {
  if (lines[i].startsWith('pick ')) { lines[i] = 'reword ' + lines[i].slice(5); break; }
}
fs.writeFileSync(todo, lines.join('\\n'));
`;

const REWORD_MESSAGE = `
const fs = require('fs');
fs.copyFileSync(process.argv[2], process.argv[3]);
`;
const { execFile, spawn } = require('child_process');

const MAX_BUFFER = 1024 * 1024 * 128;

/* Under a Wayland session Electron still defaults to X11, so it runs through
   XWayland — where Chromium cannot query vsync timing and spams
   "GetVSyncParametersIfAvailable() failed" at startup. Asking for the native
   backend also gets us sharp scaling on HiDPI screens. `auto` falls back to
   X11 by itself on an X11 session, so this is safe to set unconditionally.
   Must run before the app is ready. */
if (process.platform === 'linux') {
  app.commandLine.appendSwitch('ozone-platform-hint', 'auto');
}

/* ------------------------------------------------------------------ */
/* git runner                                                          */
/* ------------------------------------------------------------------ */

function gitEnv() {
  return {
    ...process.env,
    LC_ALL: 'C',
    GIT_OPTIONAL_LOCKS: '0',
    // Never let git block on an invisible credential prompt.
    GIT_TERMINAL_PROMPT: '0',
  };
}

/* Every git command GitBraid runs, newest last. This is what the activity log
   shows: not a paraphrase of what the app did, but the commands themselves. */
const gitLog = [];
const LOG_MAX = 400;

/* `code` without `error` is a command that failed quietly — `git config
 * --get-regexp` exits 1 when it simply matched nothing. Recording the two apart
 * keeps the log from shouting about a question that just had no answer. */
/* git buries the reason: a rejected push opens with "To <url>", which explains
   nothing. Same choice the status bar makes, so the log and the bar agree. */
function reasonLine(text) {
  const lines = String(text || '').split(/[\r\n]/).map((l) => l.trim()).filter(Boolean);
  if (!lines.length) return '';
  return (
    lines.find((l) => /^fatal:/i.test(l)) ||
    lines.find((l) => /^!\s|\[rejected\]/i.test(l)) ||
    lines.find((l) => /^CONFLICT\b/.test(l)) ||
    lines.find((l) => /^error:/i.test(l)) ||
    lines.find((l) => !/^To\s|^remote:\s*$|^hint:/i.test(l)) ||
    lines[0]
  );
}

function recordGit(cwd, args, ms, stderr, code) {
  const first = reasonLine(stderr);
  gitLog.push({
    at: Date.now(),
    cwd,
    command: `git ${args.join(' ')}`,
    ms,
    error: first ? first.slice(0, 200) : null,
    code: code || null,
  });
  if (gitLog.length > LOG_MAX) gitLog.splice(0, gitLog.length - LOG_MAX);
}

handle('app:log', async () => gitLog.slice().reverse());
handle('app:clearLog', async () => { gitLog.length = 0; return true; });

/** `extraEnv` is for the few commands that need to drive git's editors. */
function git(cwd, args, extraEnv = null) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      args,
      { cwd, maxBuffer: MAX_BUFFER, encoding: 'utf8',
        env: extraEnv ? { ...gitEnv(), ...extraEnv } : gitEnv() },
      (err, stdout, stderr) => {
        if (err) {
          /* A merge that conflicts says so on stdout — "CONFLICT (content):
             Merge conflict in a.txt" — and leaves stderr empty, so stderr
             alone would reduce the most important failure git has to a bare
             "Command failed". Take whichever stream actually spoke. */
          const said = (stderr || '').trim() || (stdout || '').trim();
          const e = new Error(said || (err.message || '').trim());
          e.stderr = stderr;
          e.stdout = stdout;
          recordGit(cwd, args, Date.now() - started, said, err.code ?? 1);
          reject(e);
          return;
        }
        recordGit(cwd, args, Date.now() - started, null, 0);
        resolve(stdout);
      }
    );
  });
}

/** Run git with a patch (or any text) piped to stdin. */
function gitStdin(cwd, args, input) {
  return new Promise((resolve, reject) => {
    const child = spawn('git', args, { cwd, env: gitEnv() });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) reject(new Error(err.trim() || `git exited with ${code}`));
      else resolve(out);
    });
    child.stdin.end(input);
  });
}

/**
 * Run git while reporting its stderr chatter as it arrives. `git clone` writes
 * its progress there, and a clone is the one command slow enough that the user
 * needs to see it move.
 */
function gitProgress(cwd, args, onLine) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const child = spawn('git', args, { cwd, env: gitEnv() });
    let out = '';
    let err = '';
    let pending = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => {
      err += d;
      // Progress overwrites itself with \r; only \n ends a real line.
      pending += d;
      const parts = pending.split(/[\r\n]/);
      pending = parts.pop();
      for (const line of parts) if (line.trim()) onLine(line.trim());
    });
    child.on('error', (e) => {
      recordGit(cwd, args, Date.now() - started, e.message, 1);
      reject(e);
    });
    child.on('close', (code) => {
      if (pending.trim()) onLine(pending.trim());
      // These commands belong in the activity log as much as any other; the
      // progress chatter is on stderr, so only a failure's tail is the reason.
      recordGit(cwd, args, Date.now() - started, code === 0 ? null : (err.trim() || out.trim()), code);
      if (code !== 0) reject(new Error(err.trim() || out.trim() || `git exited with ${code}`));
      else resolve(out);
    });
  });
}

/* ------------------------------------------------------------------ */
/* parsers                                                             */
/* ------------------------------------------------------------------ */

const UNIT = '\x1f';

function addEntry(res, xy, filePath, orig) {
  const staged = xy[0];
  const worktree = xy[1];
  if (staged !== '.') res.staged.push({ path: filePath, orig, status: staged });
  if (worktree !== '.') res.unstaged.push({ path: filePath, orig, status: worktree });
}

/** Parse `git status --porcelain=v2 --branch -z`. */
function parseStatus(raw) {
  const res = {
    branch: null,
    upstream: null,
    oid: null,
    ahead: 0,
    behind: 0,
    staged: [],
    unstaged: [],
    untracked: [],
    conflicted: [],
  };
  const parts = raw.split('\0');

  for (let i = 0; i < parts.length; i++) {
    const line = parts[i];
    if (!line) continue;

    if (line.startsWith('# branch.head ')) {
      const v = line.slice('# branch.head '.length);
      res.branch = v === '(detached)' ? null : v;
    } else if (line.startsWith('# branch.upstream ')) {
      res.upstream = line.slice('# branch.upstream '.length);
    } else if (line.startsWith('# branch.oid ')) {
      res.oid = line.slice('# branch.oid '.length);
    } else if (line.startsWith('# branch.ab ')) {
      const m = line.slice('# branch.ab '.length).match(/\+(\d+)\s+-(\d+)/);
      if (m) {
        res.ahead = Number(m[1]);
        res.behind = Number(m[2]);
      }
    } else if (line[0] === '1') {
      const f = line.split(' ');
      addEntry(res, f[1], f.slice(8).join(' '));
    } else if (line[0] === '2') {
      const f = line.split(' ');
      const p = f.slice(9).join(' ');
      const orig = parts[++i];
      addEntry(res, f[1], p, orig);
    } else if (line[0] === 'u') {
      const f = line.split(' ');
      res.conflicted.push({ path: f.slice(10).join(' '), status: 'U', xy: f[1] });
    } else if (line[0] === '?') {
      res.untracked.push({ path: line.slice(2), status: '?' });
    }
  }
  return res;
}

const LOG_FORMAT = [
  '%H', '%P', '%an', '%ae', '%at', '%cn', '%ct', '%D', '%s', '%b',
].join('%x1f');

function parseLog(raw) {
  if (!raw.trim()) return [];
  return raw
    .split('\0')
    .filter((c) => c.trim())
    .map((chunk) => {
      const f = chunk.replace(/^\n/, '').split(UNIT);
      return {
        hash: f[0],
        parents: f[1] ? f[1].split(' ').filter(Boolean) : [],
        author: f[2],
        email: f[3],
        authorDate: Number(f[4]) * 1000,
        committer: f[5],
        commitDate: Number(f[6]) * 1000,
        refs: f[7] ? f[7].split(', ').filter(Boolean) : [],
        subject: f[8] || '',
        body: (f[9] || '').trim(),
      };
    });
}

/* ------------------------------------------------------------------ */
/* recent repositories                                                 */
/* ------------------------------------------------------------------ */

function recentsFile() {
  return path.join(app.getPath('userData'), 'recent-repos.json');
}

/** Entries on disk. Older builds stored bare path strings — read those too. */
function readRecentsRaw() {
  try {
    const raw = JSON.parse(fs.readFileSync(recentsFile(), 'utf8'));
    if (!Array.isArray(raw)) return [];
    return raw
      .map((e) => (typeof e === 'string' ? { path: e, openedAt: 0 } : e))
      .filter((e) => e && typeof e.path === 'string');
  } catch {
    return [];
  }
}

function writeRecents(list) {
  try {
    fs.mkdirSync(path.dirname(recentsFile()), { recursive: true });
    fs.writeFileSync(recentsFile(), JSON.stringify(list, null, 2));
  } catch {
    /* non-fatal */
  }
  return list;
}

/** Entries the welcome screen can render: still on disk, still a repository. */
function readRecents() {
  return readRecentsRaw()
    .filter((e) => fs.existsSync(path.join(e.path, '.git')))
    .map((e) => ({
      path: e.path,
      name: path.basename(e.path),
      parent: path.dirname(e.path),
      openedAt: e.openedAt || 0,
    }));
}

function pushRecent(repo) {
  const rest = readRecentsRaw().filter((e) => e.path !== repo);
  writeRecents([{ path: repo, openedAt: Date.now() }, ...rest].slice(0, 12));
  buildMenu();   // keep File ▸ Open Recent in step
  return readRecents();
}

/* ------------------------------------------------------------------ */
/* external terminal                                                   */
/* ------------------------------------------------------------------ */

/* No portable "open a terminal here" exists on Linux, so walk the usual
   suspects. Every one of them inherits the working directory from cwd. */
/* Setting `cwd` on the spawned process is not enough for most of these. The
 * GNOME family — ptyxis, gnome-terminal — is DBusActivatable: the process we
 * start only hands a request to an instance that is already running, and that
 * instance builds the window with its own working directory. The folder has to
 * travel as an argument, and every emulator spells that argument differently. */
const TERMINALS = [
  { cmd: 'ptyxis',         dir: (d) => ['--new-window', `--working-directory=${d}`] },
  { cmd: 'gnome-terminal', dir: (d) => [`--working-directory=${d}`] },
  { cmd: 'konsole',        dir: (d) => ['--workdir', d] },
  { cmd: 'xfce4-terminal', dir: (d) => [`--working-directory=${d}`] },
  { cmd: 'mate-terminal',  dir: (d) => [`--working-directory=${d}`] },
  { cmd: 'tilix',          dir: (d) => [`--working-directory=${d}`] },
  { cmd: 'alacritty',      dir: (d) => ['--working-directory', d] },
  { cmd: 'kitty',          dir: (d) => ['--directory', d] },
  { cmd: 'wezterm',        dir: (d) => ['start', '--cwd', d] },
  { cmd: 'foot',           dir: (d) => [`--working-directory=${d}`] },
  { cmd: 'xterm',          dir: () => [], usesCwd: true },   // not activated; honours cwd
];

/* macOS and Windows each have one obvious answer, so there is no list to walk:
 * `open -a Terminal <dir>` and Windows Terminal, falling back to cmd. */
const MAC_TERMINALS = [
  { cmd: 'open', dir: (d) => ['-a', 'Terminal', d] },
];
const WIN_TERMINALS = [
  { cmd: 'wt.exe', dir: (d) => ['-d', d] },
  { cmd: 'powershell.exe', dir: (d) => ['-NoExit', '-Command', `Set-Location -LiteralPath ${JSON.stringify(d)}`] },
  { cmd: 'cmd.exe', dir: () => ['/K'], usesCwd: true },
];

const terminalsForPlatform = () =>
  IS_MAC ? MAC_TERMINALS : IS_WIN ? WIN_TERMINALS : TERMINALS;

/** Debian's generic name is a symlink chain to one of the above. */
function preferredTerminal() {
  if (IS_MAC || IS_WIN) return null;
  try {
    const real = fs.realpathSync('/usr/bin/x-terminal-emulator');
    const name = path.basename(real);
    return TERMINALS.find((t) => t.cmd === name) || { cmd: real, dir: () => [] };
  } catch {
    return null;
  }
}

function openTerminal(cwd) {
  const list = terminalsForPlatform();
  const preferred = preferredTerminal();
  // The system's own choice first, then the rest, with no duplicate of it.
  const order = preferred
    ? [preferred, ...list.filter((t) => t.cmd !== preferred.cmd)]
    : list;

  return new Promise((resolve, reject) => {
    const tryNext = (i) => {
      if (i >= order.length) {
        reject(new Error('No terminal emulator found. Install one, or open the folder manually.'));
        return;
      }
      const term = order[i];
      const child = spawn(term.cmd, term.dir(cwd), { cwd, detached: true, stdio: 'ignore' });
      let settled = false;
      const next = () => { if (!settled) { settled = true; tryNext(i + 1); } };

      child.once('error', next);
      // An emulator that rejects its arguments exits straight away. Spawning is
      // therefore not proof it opened anything — give it a moment to fail, so
      // the fallback chain is real rather than stopping at the first program
      // that merely exists on the system.
      child.once('exit', (code) => { if (code) next(); });
      child.once('spawn', () => {
        setTimeout(() => {
          if (settled) return;
          settled = true;
          child.unref();
          resolve(path.basename(term.cmd));
        }, 400);
      });
    };
    tryNext(0);
  });
}

/* ------------------------------------------------------------------ */
/* terminal panel                                                      */
/* ------------------------------------------------------------------ */

/* A command runner, not a pseudo-terminal. A real PTY means node-pty, a native
   module rebuilt for every Electron release; GitBraid carries no runtime
   dependencies, so commands run detached from any tty. Everything that reads
   and writes plainly works — git, npm, ls; anything that wants a screen —
   vim, top — does not, and the panel says so. */

let running = null;   // one command at a time per window

function termSend(channel, payload) {
  win?.webContents.send(channel, payload);
}

handle('term:run', async (cwd, command) => {
  if (running) throw new Error('A command is still running — stop it first.');
  if (!command || !command.trim()) return { pid: null };

  const shell = IS_WIN
    ? (process.env.ComSpec || 'cmd.exe')
    : (process.env.SHELL && fs.existsSync(process.env.SHELL) ? process.env.SHELL : '/bin/sh');
  const child = spawn(shell, IS_WIN ? ['/d', '/s', '/c', command] : ['-c', command], {
    cwd,
    env: { ...process.env, GIT_PAGER: 'cat', PAGER: 'cat', TERM: 'dumb', NO_COLOR: '1' },
  });
  running = child;

  child.stdout.on('data', (d) => termSend('term:out', { text: d.toString(), stream: 'out' }));
  child.stderr.on('data', (d) => termSend('term:out', { text: d.toString(), stream: 'err' }));
  child.on('error', (err) => {
    termSend('term:out', { text: `${err.message}\n`, stream: 'err' });
  });
  child.on('close', (code, signal) => {
    running = null;
    termSend('term:exit', { code, signal });
  });
  return { pid: child.pid, shell };
});

handle('term:kill', async () => {
  if (!running) return false;
  running.kill('SIGTERM');
  return true;
});

/* ------------------------------------------------------------------ */
/* opening a file in an editor                                         */
/* ------------------------------------------------------------------ */

/* `shell.openPath` hands the file to whatever the desktop registered for its
   type, and for source files that is often a browser — which downloads it
   instead of opening it. So look for a real editor first, and only fall back
   to the desktop's choice when there is none. */

/* The editors people actually have, per platform. The command-line launchers
 * are the same on macOS and Windows for the cross-platform editors; only the
 * fallback plain-text editors differ, since every desktop ships its own. */
const CODE_EDITORS = [
  'code', 'codium', 'code-insiders', 'cursor', 'zed', 'zeditor',
  'subl', 'sublime_text', 'idea', 'webstorm', 'phpstorm', 'pycharm',
  ...(IS_WIN ? ['notepad++'] : IS_MAC ? ['mate', 'bbedit'] : ['geany', 'gvim', 'nvim-qt']),
];
const TEXT_EDITORS = IS_WIN
  ? ['notepad']
  : IS_MAC
    ? ['open']            // handed the file, the desktop picks its default
    : ['gnome-text-editor', 'gedit', 'kate', 'kwrite', 'xed', 'mousepad', 'pluma'];

/** Look up an executable on PATH without spawning anything. */
function which(cmd) {
  /* On Windows an executable is `code.cmd` or `wt.exe`, never a bare name, and
     the extensions that count live in PATHEXT. The X_OK bit means nothing
     there, so existence is the only check that applies. */
  const suffixes = IS_WIN
    ? ['', ...(process.env.PATHEXT || '.EXE;.CMD;.BAT;.COM').split(';').filter(Boolean)]
    : [''];
  const mode = IS_WIN ? fs.constants.F_OK : fs.constants.X_OK;
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    if (!dir) continue;
    for (const ext of suffixes) {
      const full = path.join(dir, cmd + ext);
      try {
        fs.accessSync(full, mode);
        return full;
      } catch { /* keep looking */ }
    }
  }
  return null;
}

let editorCache = null;

async function resolveEditor(repo) {
  // An explicit choice always wins: git config gitbraid.editor "code -w"
  const configured = repo ? await readConfig(repo, '--get', 'gitbraid.editor') : '';
  if (configured) {
    const [cmd, ...args] = configured.split(/\s+/);
    if (which(cmd)) return { cmd, args, label: configured, configured: true };
  }
  if (editorCache) return editorCache;
  for (const cmd of [...CODE_EDITORS, ...TEXT_EDITORS]) {
    if (which(cmd)) {
      editorCache = { cmd, args: [], label: cmd };
      return editorCache;
    }
  }
  return null;
}

handle('shell:openInEditor', async (repo, file) => {
  const editor = await resolveEditor(repo);
  if (editor) {
    const child = spawn(editor.cmd, [...editor.args, file], {
      cwd: repo || undefined, detached: true, stdio: 'ignore',
    });
    child.unref();
    return editor.label;
  }
  // Nothing editor-shaped installed: let the desktop try after all.
  const err = await shell.openPath(file);
  if (err) throw new Error(`No editor found, and the system could not open it: ${err}`);
  return 'the system default application';
});

/* ------------------------------------------------------------------ */
/* application menu                                                    */
/* ------------------------------------------------------------------ */

/* The renderer owns this state; the menu only mirrors it, so checkboxes and
   greyed-out entries stay honest. Updated over `app:menuState`. */
const menuState = {
  hasRepo: false, hasTab: false, manyTabs: false, sidebar: true, detail: true,
};

const shortenHome = (p) => {
  const home = app.getPath('home');
  return p.startsWith(home) ? '~' + p.slice(home.length) : p;
};

/** Menu items never act directly: they ask the renderer, which owns the UI. */
const send = (action, extra) => win?.webContents.send('menu:action', { action, ...extra });

/* The About box is drawn by the renderer so it can carry the logo and follow
   the theme; main only supplies the numbers. */
/* Read from our own package.json rather than app.getVersion(): that call falls
   back to Electron's own version whenever the app is not started as a package,
   and then the About box reports the wrong product. */
/** Where the status-bar logo points. Empty until it is set in package.json. */
function ownHomepage() {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, 'package.json'), 'utf8'));
    const url = pkg.homepage || (typeof pkg.repository === 'string' ? pkg.repository : pkg.repository?.url);
    return /^https?:\/\//.test(url || '') ? url : '';
  } catch {
    return '';
  }
}

function ownVersion() {
  try {
    return JSON.parse(fs.readFileSync(path.join(__dirname, 'package.json'), 'utf8')).version;
  } catch {
    return app.getVersion();
  }
}

/* ------------------------------------------------------------------ */
/* updates                                                             */
/* ------------------------------------------------------------------ */

const https = require('https');
const crypto = require('crypto');

/** owner/repo, read from the project URL already in package.json. */
function githubSlug() {
  const m = /^https?:\/\/github\.com\/([^/]+)\/([^/.]+)/.exec(ownHomepage());
  return m ? `${m[1]}/${m[2]}` : '';
}

/* Node's own https, deliberately: an updater is exactly the kind of thing one
   reaches for a library to do, and reaching would end this project's habit of
   shipping no runtime dependencies at all. */
function getUrl(url, { onProgress = null, hops = 5 } = {}) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      headers: {
        // GitHub refuses anonymous API calls without one.
        'User-Agent': `GitBraid/${ownVersion()}`,
        Accept: 'application/vnd.github+json, application/octet-stream, */*',
      },
    }, (res) => {
      const { statusCode, headers } = res;
      if (statusCode >= 300 && statusCode < 400 && headers.location) {
        res.resume();
        if (!hops) return reject(new Error('Too many redirects.'));
        return resolve(getUrl(new URL(headers.location, url).href, { onProgress, hops: hops - 1 }));
      }
      if (statusCode !== 200) {
        res.resume();
        return reject(new Error(`${url.replace(/\?.*/, '')} answered ${statusCode}.`));
      }
      const total = Number(headers['content-length']) || 0;
      const chunks = [];
      let read = 0;
      res.on('data', (c) => {
        chunks.push(c);
        read += c.length;
        if (onProgress) onProgress(read, total);
      });
      res.on('end', () => resolve(Buffer.concat(chunks)));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.setTimeout(30000, () => req.destroy(new Error('The update server did not answer.')));
  });
}

/* "0.10.0" is newer than "0.9.0"; comparing the two as text says otherwise. */
function isNewer(candidate, current) {
  const parts = (v) => String(v).replace(/^v/, '').split('.').map((n) => parseInt(n, 10) || 0);
  const a = parts(candidate);
  const b = parts(current);
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    if ((a[i] || 0) !== (b[i] || 0)) return (a[i] || 0) > (b[i] || 0);
  }
  return false;
}

/* What this copy of GitBraid is, which decides what an update can do to it: an
   AppImage is one file and can be replaced in place, a .deb is a system package
   and cannot be installed without rights this process does not have. */
function installKind() {
  if (process.env.APPIMAGE) return 'appimage';
  if (process.platform === 'linux' && process.execPath.startsWith('/opt/')) return 'deb';
  return 'other';
}

handle('update:check', async () => {
  const slug = githubSlug();
  if (!slug) throw new Error('No GitHub project is named in package.json.');
  const raw = await getUrl(`https://api.github.com/repos/${slug}/releases/latest`);
  const rel = JSON.parse(raw.toString('utf8'));
  const latest = String(rel.tag_name || '').replace(/^v/, '');
  return {
    current: ownVersion(),
    latest,
    newer: Boolean(latest) && isNewer(latest, ownVersion()),
    title: rel.name || '',
    notes: rel.body || '',
    page: rel.html_url || '',
    kind: installKind(),
    assets: (rel.assets || []).map((a) => ({
      name: a.name, url: a.browser_download_url, size: a.size,
    })),
  };
});

/** The file this copy of GitBraid would install, out of what a release holds. */
const assetFor = (assets, kind) => assets.find((a) => (kind === 'appimage'
  ? /\.AppImage$/i.test(a.name)
  : /\.deb$/i.test(a.name)));

handle('update:download', async (info) => {
  const kind = installKind();
  if (kind === 'other') throw new Error('This build cannot update itself.');
  const asset = assetFor(info.assets || [], kind);
  if (!asset) throw new Error(`That release has no ${kind === 'appimage' ? 'AppImage' : '.deb'}.`);

  /* electron-builder writes latest-linux.yml beside the artifacts, holding a
     SHA-512 for each. Without it there is nothing to check a download against,
     and this one replaces a program you run — so it is refused rather than
     taken on trust. */
  const meta = (info.assets || []).find((a) => a.name === 'latest-linux.yml');
  if (!meta) {
    throw new Error('That release has no latest-linux.yml, so the download cannot be '
      + 'checked. Attach it to the release, or update by hand from the release page.');
  }
  const yml = (await getUrl(meta.url)).toString('utf8');
  const want = matchChecksum(yml, asset.name);
  if (!want) throw new Error(`latest-linux.yml carries no checksum for ${asset.name}.`);

  const file = await getUrl(asset.url, {
    onProgress: (read, total) => sendUpdateProgress(read, total),
  });
  const got = crypto.createHash('sha512').update(file).digest('base64');
  if (got !== want) {
    throw new Error('The download does not match its published checksum. Nothing was '
      + 'installed.');
  }

  const target = path.join(os.tmpdir(), asset.name);
  fs.writeFileSync(target, file, { mode: kind === 'appimage' ? 0o755 : 0o644 });
  return { path: target, name: asset.name, kind };
});

/* The yml is small and regular; a parser for the two lines that matter beats a
   dependency for reading the whole format. */
function matchChecksum(yml, name) {
  const lines = yml.split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    if (lines[i].includes(`url: ${name}`)) {
      const m = /sha512:\s*(\S+)/.exec(lines[i + 1] || '');
      if (m) return m[1];
    }
  }
  return '';
}

function sendUpdateProgress(read, total) {
  for (const w of BrowserWindow.getAllWindows()) {
    w.webContents.send('update:progress', { read, total });
  }
}

handle('update:install', async ({ path: file, kind }) => {
  if (kind === 'appimage') {
    const here = process.env.APPIMAGE;
    if (!here) throw new Error('This is not an AppImage.');
    // Replaced by rename so the swap is atomic: a half-written program is worse
    // than an old one.
    fs.copyFileSync(file, `${here}.new`);
    fs.chmodSync(`${here}.new`, 0o755);
    fs.renameSync(`${here}.new`, here);
    app.relaunch();
    app.quit();
    return { restarted: true };
  }
  /* A .deb needs rights this process does not have and should not ask for, so
     it goes to whatever the desktop uses to install packages, which asks for
     the password itself. */
  const err = await shell.openPath(file);
  if (err) throw new Error(err);
  return { restarted: false, handedOff: true };
});

handle('app:about', async () => {
  let gitVersion = '';
  try { gitVersion = (await git(app.getPath('home'), ['--version'])).trim().replace(/^git version /, ''); }
  catch { /* git missing is itself worth showing */ }
  return {
    version: ownVersion(),
    git: gitVersion,
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
    platform: `${process.platform} ${process.arch}`,
    homepage: ownHomepage(),
  };
});

function buildMenu() {
  const recents = readRecents();
  const needsRepo = (label, action, accelerator) =>
    ({ label, accelerator, enabled: menuState.hasRepo, click: () => send(action) });

  /* macOS expects an application menu first, carrying About, Hide and Quit —
     without it those live nowhere the platform's users would look. */
  const appMenu = IS_MAC ? [{
    label: app.name,
    submenu: [
      { label: 'About GitBraid', click: () => send('about') },
      { type: 'separator' },
      { label: 'Preferences…', accelerator: 'Cmd+,', click: () => send('preferences') },
      { type: 'separator' },
      { role: 'services' },
      { type: 'separator' },
      { role: 'hide', label: 'Hide GitBraid' },
      { role: 'hideOthers' },
      { role: 'unhide' },
      { type: 'separator' },
      { role: 'quit', label: 'Quit GitBraid' },
    ],
  }] : [];

  Menu.setApplicationMenu(Menu.buildFromTemplate([
    ...appMenu,
    {
      label: 'File',
      submenu: [
        { label: 'New Tab', accelerator: 'CmdOrCtrl+T', click: () => send('new-tab') },
        { label: 'Close Tab', accelerator: 'CmdOrCtrl+W', enabled: menuState.hasTab,
          click: () => send('close-tab') },
        { label: 'Next Tab', accelerator: 'Ctrl+Tab', enabled: menuState.manyTabs,
          click: () => send('next-tab') },
        { label: 'Previous Tab', accelerator: 'Ctrl+Shift+Tab', enabled: menuState.manyTabs,
          click: () => send('prev-tab') },
        { label: 'Search Tabs…', enabled: menuState.hasTab, click: () => send('search-tabs') },
        { type: 'separator' },
        { label: 'Open Repo…', accelerator: 'CmdOrCtrl+O', click: () => send('open') },
        { label: 'Clone Repo…', accelerator: 'CmdOrCtrl+N', click: () => send('clone') },
        { label: 'Init Repo…', accelerator: 'CmdOrCtrl+I', click: () => send('init') },
        { type: 'separator' },
        {
          label: 'Open Recent',
          submenu: recents.length
            ? [
                ...recents.slice(0, 10).map((r) => ({
                  label: `${r.name}  —  ${shortenHome(r.parent)}`,
                  click: () => send('open-recent', { path: r.path }),
                })),
                { type: 'separator' },
                { label: 'Clear Recent', click: () => send('clear-recents') },
              ]
            : [{ label: 'Nothing yet', enabled: false }],
        },
        { type: 'separator' },
        needsRepo('Open in File Manager', 'file-manager', 'Alt+O'),
        needsRepo('Open External Terminal', 'terminal', 'Alt+T'),
        { type: 'separator' },
        ...(IS_MAC ? [] : [{ role: 'quit', label: 'Quit GitBraid', accelerator: 'CmdOrCtrl+Q' }]),
      ],
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' },
        { type: 'separator' },
        needsRepo('Find Commit…', 'find', 'CmdOrCtrl+F'),
      ],
    },
    {
      label: 'View',
      submenu: [
        { label: 'Relaunch GitBraid', accelerator: 'CmdOrCtrl+Shift+R',
          click: () => { app.relaunch(); app.exit(0); } },
        { role: 'togglefullscreen', label: 'Toggle Full Screen', accelerator: 'CmdOrCtrl+Shift+F' },
        // Hidden twins: still bind the key most Linux users reach for first.
        { role: 'togglefullscreen', accelerator: 'F11', visible: false },
        { type: 'separator' },
        { label: 'Increase Zoom', accelerator: 'CmdOrCtrl+=', click: () => send('zoom-in') },
        { label: 'Increase Zoom', accelerator: 'CmdOrCtrl+Plus', visible: false, click: () => send('zoom-in') },
        { label: 'Decrease Zoom', accelerator: 'CmdOrCtrl+-', click: () => send('zoom-out') },
        { label: 'Reset Zoom', accelerator: 'CmdOrCtrl+0', click: () => send('zoom-reset') },
        { type: 'separator' },
        { label: 'Show Left Panel', type: 'checkbox', accelerator: 'CmdOrCtrl+J',
          checked: menuState.sidebar, enabled: menuState.hasRepo, click: () => send('toggle-sidebar') },
        { label: 'Show Commit Details Panel', type: 'checkbox', accelerator: 'CmdOrCtrl+K',
          checked: menuState.detail, enabled: menuState.hasRepo, click: () => send('toggle-detail') },
        { type: 'separator' },
        { label: 'Terminal', accelerator: 'CmdOrCtrl+`', click: () => send('terminal-panel') },
        { label: 'Preferences', accelerator: 'CmdOrCtrl+,', click: () => send('preferences') },
        { label: 'Activity Log', click: () => send('activity-log') },
        { type: 'separator' },
        needsRepo('Refresh', 'refresh', 'F5'),
        { role: 'toggleDevTools' },
      ],
    },
    {
      label: 'Help',
      submenu: [
        { label: 'Keyboard Shortcuts', accelerator: 'CmdOrCtrl+/', click: () => send('shortcuts') },
        { type: 'separator' },
        // Next to the release notes, since both answer a question about versions.
        { label: 'Check for Updates…', click: () => send('check-updates') },
        { label: 'View Release Notes', click: () => send('release-notes') },
        ...(IS_MAC ? [] : [{ label: 'About GitBraid', click: () => send('about') }]),
      ],
    },
  ]));
}

/* ------------------------------------------------------------------ */
/* repository management                                               */
/* ------------------------------------------------------------------ */

function reposFile() {
  return path.join(app.getPath('userData'), 'repos.json');
}

function readReposStore() {
  try {
    const d = JSON.parse(fs.readFileSync(reposFile(), 'utf8'));
    return { favorites: d.favorites || [], known: d.known || [] };
  } catch {
    return { favorites: [], known: [] };
  }
}

function writeReposStore(store) {
  try {
    fs.mkdirSync(path.dirname(reposFile()), { recursive: true });
    fs.writeFileSync(reposFile(), JSON.stringify(store, null, 2));
  } catch { /* non-fatal */ }
}

/** Where a repository keeps its metadata — `.git` is a file inside a worktree. */
function gitDirOf(repo) {
  const dot = path.join(repo, '.git');
  try {
    const st = fs.statSync(dot);
    if (st.isDirectory()) return dot;
    const m = fs.readFileSync(dot, 'utf8').match(/^gitdir:\s*(.+)$/m);
    if (m) return path.resolve(repo, m[1].trim());
  } catch { /* not a repository */ }
  return null;
}

const ownerFromUrl = (url) => {
  // git@host:owner/name.git · https://host/owner/name.git · ssh://host/owner/name
  const m = String(url).replace(/\.git$/, '').match(/[:/]([^/:]+)\/[^/]+$/);
  return m ? m[1] : '';
};

/**
 * Everything shown for one row, read straight from files. Spawning git for
 * each repository would make a list of thirty a visible wait; HEAD and the
 * config are plain text.
 */
function repoBrief(repo) {
  const out = {
    path: repo, name: path.basename(repo), parent: path.dirname(repo),
    branch: '', owner: '', missing: false,
  };
  const gitDir = gitDirOf(repo);
  if (!gitDir) { out.missing = true; return out; }
  try {
    const head = fs.readFileSync(path.join(gitDir, 'HEAD'), 'utf8').trim();
    out.branch = head.startsWith('ref: refs/heads/')
      ? head.slice('ref: refs/heads/'.length)
      : `${head.slice(0, 7)} (detached)`;
  } catch { /* fresh repository with no HEAD yet */ }
  try {
    const cfg = fs.readFileSync(path.join(gitDir, 'config'), 'utf8');
    const m = cfg.match(/^\s*url\s*=\s*(.+)$/m);
    if (m) out.owner = ownerFromUrl(m[1].trim());
  } catch { /* no remote */ }
  return out;
}

handle('repos:list', async () => {
  const store = readReposStore();
  const recents = readRecents().map((r) => r.path);
  const seen = new Set();
  const all = [];
  for (const p of [...store.known, ...recents, ...store.favorites]) {
    if (seen.has(p)) continue;
    seen.add(p);
    all.push({ ...repoBrief(p), favorite: store.favorites.includes(p) });
  }
  return { repos: all, recents, favorites: store.favorites };
});

handle('repos:favorite', async (repo, on) => {
  const store = readReposStore();
  store.favorites = store.favorites.filter((p) => p !== repo);
  if (on) store.favorites.push(repo);
  if (!store.known.includes(repo)) store.known.push(repo);
  writeReposStore(store);
  return store.favorites;
});

handle('repos:forget', async (repo) => {
  const store = readReposStore();
  store.favorites = store.favorites.filter((p) => p !== repo);
  store.known = store.known.filter((p) => p !== repo);
  writeReposStore(store);
  writeRecents(readRecentsRaw().filter((e) => e.path !== repo));
  buildMenu();
  return true;
});

/** Walk a folder looking for repositories. Shallow on purpose: a deep scan of
    a home directory would crawl through every node_modules on the disk. */
handle('repos:scan', async (root, depth = 3) => {
  const skip = new Set(['node_modules', '.git', 'vendor', 'dist', 'build', '.cache', 'target']);
  const found = [];
  const walk = (dir, left) => {
    if (found.length >= 300) return;
    if (gitDirOf(dir)) { found.push(dir); return; }   // do not descend into a repo
    if (left <= 0) return;
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (!e.isDirectory() || e.name.startsWith('.') || skip.has(e.name)) continue;
      walk(path.join(dir, e.name), left - 1);
    }
  };
  walk(root, depth);

  const store = readReposStore();
  const added = found.filter((p) => !store.known.includes(p));
  store.known.push(...added);
  writeReposStore(store);
  return { found: found.length, added: added.length };
});

/** Uncommitted-work counts, asked for separately because this one does spawn
    git — once per repository. */
handle('repos:wip', async (paths) => {
  const out = {};
  const jobs = paths.slice(0, 60).map(async (repo) => {
    try {
      const raw = await git(repo, ['status', '--porcelain']);
      let modified = 0, added = 0, deleted = 0;
      for (const line of raw.split('\n')) {
        if (!line.trim()) continue;
        const code = line.slice(0, 2);
        if (code.includes('?') || code.includes('A')) added++;
        else if (code.includes('D')) deleted++;
        else modified++;
      }
      out[repo] = { modified, added, deleted };
    } catch {
      out[repo] = null;
    }
  });
  await Promise.all(jobs);
  return out;
});

/* ------------------------------------------------------------------ */
/* window                                                              */
/* ------------------------------------------------------------------ */

let win = null;

function createWindow() {
  win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 960,
    minHeight: 600,
    backgroundColor: '#0f1118',
    title: 'GitBraid',
    icon: path.join(__dirname, 'build', 'icons', '256x256.png'),
    show: false,   // revealed once the renderer knows which page to draw
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  win.loadFile(path.join(__dirname, 'src', 'index.html'));

  /* A renderer that never reports in must not cost the user their window. */
  showTimer = setTimeout(revealWindow, 3000);
  win.on('closed', () => { clearTimeout(showTimer); showTimer = null; win = null; });
}

let showTimer = null;

function revealWindow() {
  clearTimeout(showTimer);
  showTimer = null;
  if (win && !win.isVisible()) win.show();
}

app.whenReady().then(() => {
  createWindow();
  buildMenu();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

/* ------------------------------------------------------------------ */
/* IPC                                                                 */
/* ------------------------------------------------------------------ */

/** Wrap a handler so renderer always gets {ok, data} | {ok:false, error}. */
function handle(channel, fn) {
  ipcMain.handle(channel, async (_evt, ...args) => {
    try {
      return { ok: true, data: await fn(...args) };
    } catch (err) {
      return { ok: false, error: err.message || String(err) };
    }
  });
}

/* Chromium zoom levels: each step is 1.2×, so -3…+4 spans 58%–207%. Scaling
   the whole frame beats a font-size knob — the px-based panels scale too. */
handle('app:zoom', async (level) => {
  const next = Math.max(-3, Math.min(4, Number(level) || 0));
  win?.webContents.setZoomLevel(next);
  return next;
});

handle('app:ready', async () => { revealWindow(); return true; });

/* ------------------------------------------------------------------ */
/* git identity                                                        */
/* ------------------------------------------------------------------ */

/** `git config <key>` exits 1 when the key is unset — that is an answer, not
    an error, so it must not travel back as one. */
async function readConfig(dir, scope, key) {
  try {
    return (await git(dir, ['config', scope, key])).trim();
  } catch {
    return '';
  }
}

/* Settings that belong in git's own config rather than in GitBraid's, so the
 * command line and any other client see the same answer. Allowlisted: a
 * renderer must never be able to write an arbitrary config key. */
const GLOBAL_KEYS = new Set(['init.defaultBranch', 'gitbraid.editor']);

handle('git:option', async (key) => {
  if (!GLOBAL_KEYS.has(key)) throw new Error(`${key} is not a setting GitBraid manages.`);
  return readConfig(app.getPath('home'), '--global', key);
});

handle('git:setOption', async (key, value) => {
  if (!GLOBAL_KEYS.has(key)) throw new Error(`${key} is not a setting GitBraid manages.`);
  const home = app.getPath('home');
  const v = String(value || '').trim();
  if (!v) {
    // Removing the key hands the decision back to git's own default.
    try { await git(home, ['config', '--global', '--unset', key]); } catch { /* was not set */ }
    return '';
  }
  await git(home, ['config', '--global', key, v]);
  return v;
});

handle('git:identity', async (repo) => {
  const home = app.getPath('home');
  const out = {
    globalName: await readConfig(home, '--global', 'user.name'),
    globalEmail: await readConfig(home, '--global', 'user.email'),
    localName: '',
    localEmail: '',
  };
  if (repo) {
    out.localName = await readConfig(repo, '--local', 'user.name');
    out.localEmail = await readConfig(repo, '--local', 'user.email');
  }
  return out;
});

handle('git:setIdentity', async (repo, { name, email, local }) => {
  if (local && !repo) throw new Error('No repository is open to set an identity on.');
  const scope = local ? '--local' : '--global';
  const dir = local ? repo : app.getPath('home');
  if (name) await git(dir, ['config', scope, 'user.name', name]);
  if (email) await git(dir, ['config', scope, 'user.email', email]);
  return true;
});

/** Renderer tells the menu what to show enabled, checked, or greyed out. */
handle('app:menuState', async (patch) => {
  Object.assign(menuState, patch);
  buildMenu();
  return menuState;
});

handle('repo:openTerminal', async (dir) => openTerminal(dir));

handle('app:recents', async () => readRecents());

handle('app:removeRecent', async (repo) => {
  writeRecents(readRecentsRaw().filter((e) => e.path !== repo));
  buildMenu();
  return readRecents();
});

handle('app:clearRecents', async () => {
  writeRecents([]);
  buildMenu();
  return [];
});

/** Sensible starting folders for the clone / create dialogs. */
handle('app:paths', async () => ({
  home: app.getPath('home'),
  documents: safePath('documents') || app.getPath('home'),
}));

function safePath(name) {
  try { return app.getPath(name); } catch { return null; }
}

handle('repo:pick', async () => {
  const r = await dialog.showOpenDialog(win, {
    title: 'Open repository',
    properties: ['openDirectory'],
    buttonLabel: 'Open',
  });
  if (r.canceled || !r.filePaths[0]) return null;
  return openRepo(r.filePaths[0]);
});

handle('repo:open', async (dir) => openRepo(dir));

/* Which of last session's tabs still point at something. Checked by looking for
 * .git directly rather than by running git once per tab: a folder that a repo
 * was deleted from must not come back as a tab that fails the moment it is
 * clicked. `.git` is a directory in a normal clone and a file in a worktree,
 * so existsSync covers both. */
handle('repos:existing', async (paths) =>
  (Array.isArray(paths) ? paths : []).filter((p) =>
    typeof p === 'string' && fs.existsSync(path.join(p, '.git'))));

async function openRepo(target) {
  if (!fs.existsSync(target)) {
    throw new Error(`That folder no longer exists: ${target}`);
  }
  // A dropped file still identifies the repository it sits in.
  const dir = fs.statSync(target).isDirectory() ? target : path.dirname(target);
  let top;
  try {
    top = (await git(dir, ['rev-parse', '--show-toplevel'])).trim();
  } catch (err) {
    // git's own wording ("fatal: not a git repository (or any of the parent…")
    // says nothing about what to do next.
    if (/not a git repository/i.test(err.message)) {
      throw new Error(`${path.basename(dir)} is not a Git repository — pick a folder that contains .git, or create one.`);
    }
    throw err;
  }
  pushRecent(top);
  return { path: top, name: path.basename(top) };
}

handle('repo:clone', async (url, parentDir, name) => {
  if (!url) throw new Error('Enter a repository URL to clone.');
  if (!parentDir) throw new Error('Choose a folder to clone into.');
  if (!name || /[/\\]/.test(name)) throw new Error('Enter a valid folder name.');
  if (!fs.existsSync(parentDir)) throw new Error(`No such folder: ${parentDir}`);

  const target = path.join(parentDir, name);
  if (fs.existsSync(target)) {
    throw new Error(`${target} already exists — choose a different folder name.`);
  }

  await withProgress('clone', parentDir, ['clone', '--progress', url, name]);
  pushRecent(target);
  return { path: target, name };
});

handle('repo:init', async (parentDir, name) => {
  if (!parentDir) throw new Error('Choose where the repository should live.');
  const target = name ? path.join(parentDir, name) : parentDir;
  if (name && /[/\\]/.test(name)) throw new Error('Enter a valid folder name.');
  if (fs.existsSync(path.join(target, '.git'))) {
    throw new Error(`${target} is already a Git repository — open it instead.`);
  }
  fs.mkdirSync(target, { recursive: true });
  await git(target, ['init']);
  pushRecent(target);
  return { path: target, name: path.basename(target) };
});

handle('repo:pickDirectory', async (startIn) => {
  const r = await dialog.showOpenDialog(win, {
    title: 'Choose a folder',
    properties: ['openDirectory', 'createDirectory'],
    ...(startIn && fs.existsSync(startIn) ? { defaultPath: startIn } : {}),
  });
  return r.canceled ? null : r.filePaths[0];
});

/* ------------------------------------------------------------------ */
/* git flow                                                            */
/* ------------------------------------------------------------------ */

/* Implemented on plain git rather than by shelling out to the `git flow`
   binary, which is often not installed — but the settings are written to the
   very same `gitflow.*` keys, so a repository set up here also works with the
   command line tool, and one already set up there is picked up here. */

const FLOW_DEFAULTS = {
  master: 'master',
  develop: 'develop',
  feature: 'feature/',
  release: 'release/',
  hotfix: 'hotfix/',
  versiontag: '',
};

const FLOW_KEYS = {
  'gitflow.branch.master': 'master',
  'gitflow.branch.develop': 'develop',
  'gitflow.prefix.feature': 'feature',
  'gitflow.prefix.release': 'release',
  'gitflow.prefix.hotfix': 'hotfix',
  'gitflow.prefix.versiontag': 'versiontag',
};

/** One spawn for the whole block, not one per key. */
handle('flow:config', async (repo) => {
  let raw = '';
  try {
    raw = await git(repo, ['config', '--local', '--get-regexp', '^gitflow\\.']);
  } catch {
    return { initialized: false, ...FLOW_DEFAULTS };
  }
  const cfg = { ...FLOW_DEFAULTS };
  let seen = false;
  for (const line of raw.split('\n')) {
    const at = line.indexOf(' ');
    const key = at < 0 ? line.trim() : line.slice(0, at);
    const field = FLOW_KEYS[key];
    if (!field) continue;
    cfg[field] = at < 0 ? '' : line.slice(at + 1).trim();
    seen = true;
  }
  return { initialized: seen, ...cfg };
});

handle('flow:init', async (repo, cfg) => {
  for (const [key, field] of Object.entries(FLOW_KEYS)) {
    await git(repo, ['config', '--local', key, cfg[field] ?? '']);
  }
  // The development branch has to exist before anything can branch off it.
  const branches = (await git(repo, ['branch', '--format=%(refname:short)']))
    .split('\n').map((b) => b.trim()).filter(Boolean);
  if (!branches.includes(cfg.develop)) {
    const base = branches.includes(cfg.master) ? cfg.master : 'HEAD';
    await git(repo, ['branch', cfg.develop, base]);
  }
  return true;
});

handle('flow:start', async (repo, { kind, name, cfg }) => {
  const branch = `${cfg[kind]}${name}`;
  // Features and releases grow out of development; a hotfix patches production.
  const base = kind === 'hotfix' ? cfg.master : cfg.develop;
  await git(repo, ['checkout', '-b', branch, base]);
  return branch;
});

/** Each step names itself, so a conflict says which merge stopped. */
async function step(repo, what, args) {
  try {
    return await git(repo, args);
  } catch (err) {
    /* The first line is rarely the reason — a refused push opens with "To
       <url>", which explains nothing. reasonLine picks the line that does. */
    const why = reasonLine(err.message || String(err));
    throw new Error(`${what} failed: ${why}`);
  }
}

handle('flow:finish', async (repo, { kind, branch, cfg, tag, message,
                                     remote, push, deleteRemote }) => {
  const done = [];

  /* Checked before anything is touched. A tag whose name is already taken fails
     at the tagging step — after production has been merged — leaving the branch
     merged there, untagged, and not carried back to development: a half-finished
     release, from a mistake as ordinary as reusing a version number. Refusing
     here costs one command and leaves the repository exactly as it was. */
  if (tag) {
    const taken = await git(repo, ['tag', '-l', tag]).catch(() => '');
    if (taken.trim()) {
      throw new Error(`The tag ${tag} already exists. Nothing has been merged — `
        + 'choose another name, or delete that tag first.');
    }
  }

  if (kind === 'feature') {
    await step(repo, `Checking out ${cfg.develop}`, ['checkout', cfg.develop]);
    await step(repo, `Merging ${branch} into ${cfg.develop}`, ['merge', '--no-ff', '--no-edit', branch]);
    done.push(`merged into ${cfg.develop}`);
  } else {
    // A release or hotfix lands on production first, is tagged there, and is
    // then carried back so development keeps the fix.
    await step(repo, `Checking out ${cfg.master}`, ['checkout', cfg.master]);
    await step(repo, `Merging ${branch} into ${cfg.master}`, ['merge', '--no-ff', '--no-edit', branch]);
    done.push(`merged into ${cfg.master}`);
    if (tag) {
      await step(repo, `Tagging ${tag}`, ['tag', '-a', tag, '-m', message || tag]);
      done.push(`tagged ${tag}`);
    }
    await step(repo, `Checking out ${cfg.develop}`, ['checkout', cfg.develop]);
    await step(repo, `Merging ${branch} into ${cfg.develop}`, ['merge', '--no-ff', '--no-edit', branch]);
    done.push(`merged into ${cfg.develop}`);
  }
  await step(repo, `Deleting ${branch}`, ['branch', '-d', branch]);
  done.push('branch deleted');

  /* Publishing comes before removing anything from the server. If the push is
     refused — someone else moved the branch on — this throws, and the delete
     below never runs: the feature stays on the remote as the only copy of that
     work there, which is exactly what you want when the merge has not landed. */
  if (push && remote) {
    const branches = kind === 'feature' ? [cfg.develop] : [cfg.master, cfg.develop];
    await step(repo, `Pushing ${branches.join(' and ')}`, ['push', remote, ...branches]);
    done.push(`pushed ${branches.join(' and ')}`);
    if (tag) {
      // A release tag that exists only on one machine is not a release.
      await step(repo, `Pushing ${tag}`, ['push', remote, tag]);
      done.push(`pushed ${tag}`);
    }
  }

  if (deleteRemote && remote) {
    try {
      await step(repo, `Deleting ${remote}/${branch}`, ['push', remote, '--delete', branch]);
      done.push(`${remote}/${branch} deleted`);
    } catch (e) {
      /* Somebody else removed it first. That is the outcome asked for, so it is
         not a failure — and failing here would leave a finish that merged,
         tagged and pushed looking like it went wrong. */
      if (!/remote ref does not exist/i.test(e.message)) throw e;
      done.push(`${remote}/${branch} was already gone`);
    }
  }

  return done.join(', ');
});

/* `--untracked-files=all` matters: without it git reports a folder whose every
   file is new as one entry, so you cannot stage the new files individually. */
handle('repo:status', async (repo) =>
  parseStatus(await git(repo, [
    'status', '--porcelain=v2', '--branch', '--untracked-files=all', '-z',
  ]))
);

handle('repo:log', async (repo, { limit = 400, all = true, skip = 0 } = {}) => {
  const args = ['log', '--date-order', '-z', `--pretty=format:${LOG_FORMAT}`,
    `--max-count=${limit}`, `--skip=${skip}`];
  if (all) args.push('--all');
  try {
    return parseLog(await git(repo, args));
  } catch (e) {
    // Fresh repo with no commits yet.
    if (/does not have any commits|unknown revision/i.test(e.message)) return [];
    throw e;
  }
});

handle('repo:refs', async (repo) => {
  /* An annotated tag is an object in its own right, so %(objectname) is the tag
     rather than the commit it marks, and %(committerdate) is empty because a tag
     is tagged, not committed. The starred fields are those same fields after the
     tag has been peeled; they are empty for every other kind of ref, which is
     exactly when the plain ones are already right. */
  const fmt = ['%(refname)', '%(objectname)', '%(upstream:short)',
    '%(upstream:track)', '%(HEAD)', '%(committerdate:unix)',
    '%(*objectname)', '%(*committerdate:unix)'].join('%1f');
  const raw = await git(repo, ['for-each-ref', `--format=${fmt}`]);
  const branches = [], remotes = [], tags = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    const [refname, oid, upstream, track, head, date, peeledOid, peeledDate] =
      line.split(UNIT);
    const item = {
      refname,
      // What the ref means to the history: the commit a reader can point at.
      oid: peeledOid || oid,
      upstream,
      track,
      current: head === '*',
      date: Number(peeledDate || date) * 1000,
    };
    if (refname.startsWith('refs/heads/')) {
      branches.push({ ...item, name: refname.slice(11) });
    } else if (refname.startsWith('refs/remotes/')) {
      const name = refname.slice(13);
      if (!name.endsWith('/HEAD')) remotes.push({ ...item, name });
    } else if (refname.startsWith('refs/tags/')) {
      tags.push({ ...item, name: refname.slice(10) });
    }
  }
  const sortByDate = (a, b) => b.date - a.date;
  return {
    branches: branches.sort(sortByDate),
    remotes: remotes.sort(sortByDate),
    tags: tags.sort(sortByDate),
  };
});

/* ------------------------------------------------------------------ */
/* branch level commands                                               */
/* ------------------------------------------------------------------ */

handle('repo:renameBranch', async (repo, from, to) => {
  await git(repo, ['branch', '-m', from, to]);
  return to;
});

handle('repo:setUpstream', async (repo, branch, upstream) => {
  if (upstream) await git(repo, ['branch', `--set-upstream-to=${upstream}`, branch]);
  else await git(repo, ['branch', '--unset-upstream', branch]);
  return true;
});

/** A branch you are standing on is advanced by merging; one you are not on can
    be moved with a fetch whose source is this same repository. */
handle('repo:fastForward', async (repo, { branch, upstream, current }) => {
  if (current) return git(repo, ['merge', '--ff-only', upstream]);
  return git(repo, ['fetch', '.', `${upstream}:${branch}`]);
});

handle('repo:fetchInto', async (repo, { remote, branch, upstream, current }) => {
  await withProgress('fetch', repo, ['fetch', '--progress', remote, branch]);
  // Then carry what arrived into the local branch, if it can go without a merge.
  try {
    if (current) await git(repo, ['merge', '--ff-only', upstream]);
    else await git(repo, ['fetch', '.', `${upstream}:${branch}`]);
    return 'fetched and fast-forwarded';
  } catch {
    return 'fetched — the branch has diverged, so it was left alone';
  }
});

handle('repo:pushBranch', async (repo, { branch, remote, setUpstream, force }) => {
  const args = ['push', '--progress'];
  if (force) args.push('--force-with-lease');
  if (setUpstream) args.push('--set-upstream');
  args.push(remote, branch);
  return withProgress('push', repo, args);
});

handle('repo:deleteRemoteBranch', async (repo, remote, branch) =>
  git(repo, ['push', remote, '--delete', branch]));

handle('repo:deleteTag', async (repo, tag) => git(repo, ['tag', '-d', tag]));

/** What is on `b` that is not yet on `a`. */
handle('repo:compare', async (repo, a, b) => git(repo, ['diff', `${a}...${b}`]));

handle('repo:description', async (repo, branch) =>
  readConfig(repo, '--local', `branch.${branch}.description`));

handle('repo:setDescription', async (repo, branch, text) => {
  const key = `branch.${branch}.description`;
  if (text) return git(repo, ['config', '--local', key, text]);
  try { await git(repo, ['config', '--local', '--unset', key]); } catch { /* already absent */ }
  return true;
});

/* Where a remote points is a note in .git/config, not part of any commit, so
   changing it rewrites nothing and cannot lose work: moving host, or swapping
   HTTPS for SSH, leaves every commit, branch and tag exactly as it was.
   A repository that has no such remote yet gets one, since `set-url` on a name
   that does not exist is an error rather than the obvious thing. */
handle('repo:setRemoteUrl', async (repo, name, url) => {
  const remote = String(name || '').trim();
  const target = String(url || '').trim();
  if (!remote) throw new Error('No remote was named.');
  if (!target) throw new Error('A remote needs a URL.');

  const existing = (await git(repo, ['remote'])).split('\n').map((l) => l.trim());
  await git(repo, existing.includes(remote)
    ? ['remote', 'set-url', remote, target]
    : ['remote', 'add', remote, target]);
  // Read it back rather than reporting the argument: this is the answer git
  // actually holds now, which is the thing worth showing.
  return (await git(repo, ['remote', 'get-url', remote])).trim();
});

/* Whether the server actually has this branch, asked of the server rather than
   of the copy of its answer we happen to hold. Remote tracking refs are only as
   fresh as the last fetch: a branch pushed from another machine, or one whose
   tracking ref has been pruned, leaves them saying no when the answer is yes.

   Three outcomes, and the third matters: ls-remote --exit-code leaves 0 for
   found, 2 for genuinely absent, and 128 for could-not-ask. Reporting the last
   as "absent" would quietly hide the option whenever someone is offline.

   Bounded, because this runs while a dialog waits to open. A remote wanting a
   password would otherwise hang there with nothing on screen to explain it —
   and ssh has prompts of its own that GIT_TERMINAL_PROMPT does not cover. */
handle('repo:remoteHasBranch', (repo, remote, branch) => new Promise((resolve, reject) => {
  if (!remote || !branch) return resolve(null);
  const args = ['ls-remote', '--heads', '--exit-code', remote, `refs/heads/${branch}`];
  const started = Date.now();
  execFile('git', args, {
    cwd: repo,
    encoding: 'utf8',
    timeout: 8000,
    env: {
      ...gitEnv(),
      GIT_SSH_COMMAND: `${process.env.GIT_SSH_COMMAND || 'ssh'} -oBatchMode=yes`,
    },
  }, (err, stdout) => {
    const code = err ? (err.code ?? 1) : 0;
    recordGit(repo, args, Date.now() - started, null, code);
    if (!err) return resolve(Boolean(String(stdout).trim()));
    resolve(code === 2 ? false : null);
  });
}));

handle('repo:remotes', async (repo) => {
  const raw = await git(repo, ['remote', '-v']);
  const map = new Map();
  for (const line of raw.split('\n')) {
    const m = line.match(/^(\S+)\s+(\S+)\s+\((fetch|push)\)$/);
    if (m && !map.has(m[1])) map.set(m[1], { name: m[1], url: m[2] });
  }
  return [...map.values()];
});

/* --- diffs --- */

/* `context` is the number of unchanged lines around each change. A very large
   value turns the diff into the whole file, which is what "show all lines"
   means; leaving it out keeps git's default of three. */
const contextArg = (context) =>
  Number.isFinite(context) && context > 3 ? [`-U${Math.min(context, 100000)}`] : [];

handle('repo:diffFile', async (repo, { file, staged, untracked, ignoreWhitespace, context }) => {
  if (untracked) {
    // Show the whole new file as additions. The flags belong here too: this
    // branch used to return early and quietly drop them.
    const args = ['diff', '--no-index', '--no-color'];
    if (ignoreWhitespace) args.push('-w');
    args.push(...contextArg(context), '--', NULL_DEVICE, file);
    try {
      return await git(repo, args);
    } catch (e) {
      // --no-index exits 1 when files differ, which is the normal case.
      return e.stderr && !e.stderr.includes('diff') ? '' : String(e.message);
    }
  }
  const args = ['diff', '--no-color', '--find-renames'];
  if (staged) args.push('--cached');
  if (ignoreWhitespace) args.push('-w');
  args.push(...contextArg(context), '--', file);
  return git(repo, args);
});

/* A conflicted file is not a diff against anything — it is a file with both
 * versions written into it between markers, and those markers are the thing
 * you have to read. Show it whole, as additions, the way an untracked file is
 * shown. `git diff` on an unmerged path returns a combined diff instead, which
 * hides exactly the lines that matter. */
handle('repo:conflictFile', async (repo, file) => {
  const args = ['diff', '--no-index', '--no-color', '-U100000', '--', NULL_DEVICE, file];
  try {
    return await git(repo, args);
  } catch (e) {
    return e.stdout || String(e.message);
  }
});

handle('repo:diffCommit', async (repo, hash) =>
  git(repo, ['show', '--no-color', '--find-renames', '--format=', hash])
);

/** One file's changes inside one commit, rather than the whole commit. */
/** How many parents a commit has, without loading its whole log entry. */
async function isMerge(repo, hash) {
  const parents = (await git(repo, ['rev-list', '--parents', '-n', '1', hash])).trim().split(' ');
  return parents.length > 2;   // the commit's own hash, then its parents
}

handle('repo:diffCommitFile', async (repo, { hash, file, ignoreWhitespace, context, side = 'in' }) => {
  const merge = await isMerge(repo, hash);
  const args = ['diff', '--no-color', '--find-renames'];
  if (ignoreWhitespace) args.push('-w');
  args.push(...contextArg(context));

  if (merge && side === 'combined') {
    // `git show --cc` is the only form that lays both parents against the result.
    const show = ['show', '--no-color', '--format=', '--cc'];
    if (ignoreWhitespace) show.push('-w');
    show.push(...contextArg(context), hash, '--', file);
    return git(repo, show);
  }
  if (merge) {
    args.push(`${hash}${MERGE_SIDES[side] || '^1'}`, hash, '--', file);
    return git(repo, args);
  }
  const show = ['show', '--no-color', '--find-renames', '--format='];
  if (ignoreWhitespace) show.push('-w');
  show.push(...contextArg(context), hash, '--', file);
  return git(repo, show);
});

/** How many commits sit between this one and HEAD — the ones a reword would
    have to rewrite. Zero means it is HEAD itself. */
handle('repo:descendantCount', async (repo, hash) =>
  Number((await git(repo, ['rev-list', '--count', `${hash}..HEAD`])).trim()) || 0);

/**
 * Reword a commit. HEAD is simply amended, which touches nothing else and
 * leaves the index alone. An older commit has to be rewritten, and so does
 * every commit after it, which needs a clean working tree — and if any step
 * fails the rebase is abandoned so the repository is left as it was found.
 */
handle('repo:rewordCommit', async (repo, { hash, message }) => {
  const head = (await git(repo, ['rev-parse', 'HEAD'])).trim();
  if (hash === head) {
    await git(repo, ['commit', '--amend', '--only', '-m', message]);
    return { hash: (await git(repo, ['rev-parse', 'HEAD'])).trim(), rebased: 0 };
  }

  const dirty = (await git(repo, ['status', '--porcelain'])).trim();
  if (dirty) {
    throw new Error(
      'Rewording an older commit rewrites the ones after it, which needs a clean ' +
      'working tree. Commit or stash your changes first.');
  }
  const count = Number((await git(repo, ['rev-list', '--count', `${hash}..HEAD`])).trim()) || 0;

  const msgFile = path.join(os.tmpdir(), `gitbraid-reword-${process.pid}-${count}.txt`);
  fs.writeFileSync(msgFile, message.endsWith('\n') ? message : message + '\n');
  // Turn the first `pick` into `reword`, then hand git the new message.
  const seq = nodeEditor(REWORD_SEQUENCE);
  const msg = nodeEditor(REWORD_MESSAGE, msgFile);
  try {
    await git(repo, ['rebase', '-i', `${hash}^`], {
      ELECTRON_RUN_AS_NODE: '1',
      GIT_SEQUENCE_EDITOR: seq.command,
      GIT_EDITOR: msg.command,
    });
  } catch (err) {
    try { await git(repo, ['rebase', '--abort']); } catch { /* nothing to abort */ }
    throw new Error(`Reword failed, nothing was changed: ${(err.message || '').split('\n')[0]}`);
  } finally {
    for (const f of [msgFile, seq.file, msg.file]) {
      try { fs.unlinkSync(f); } catch { /* already gone */ }
    }
  }
  return { hash: (await git(repo, ['rev-parse', `${hash}^`])).trim(), rebased: count };
});

/* A merge has two parents, so "what changed" has no single answer and git
 * refuses to guess: plain `diff-tree <merge>` prints nothing at all, which is
 * why merge commits used to look empty. Each side is a different question:
 *
 *   in        <hash>^1..<hash>   what this merge brought into the branch
 *   other     <hash>^2..<hash>   what the branch already had that the other did not
 *   combined  --cc               only what differs from BOTH parents, i.e. the
 *                                lines a person resolved by hand — empty when
 *                                the merge went through cleanly
 */
const MERGE_SIDES = { in: '^1', other: '^2' };

handle('repo:commitFiles', async (repo, hash, side = 'in') => {
  const args = ['diff-tree', '--no-commit-id', '--name-status', '-r', '-z', '--find-renames'];
  if (side === 'combined') {
    args.push('--cc', hash);
  } else if (MERGE_SIDES[side] && await isMerge(repo, hash)) {
    args.push(`${hash}${MERGE_SIDES[side]}`, hash);
  } else {
    /* `--root` matters for the very first commit of a repository: without it
       diff-tree has nothing to compare against and reports no files at all, so
       the commit that created the project looked empty. */
    args.push('--root', hash);
  }
  const raw = await git(repo, args);
  const parts = raw.split('\0').filter(Boolean);
  const files = [];
  for (let i = 0; i < parts.length; i++) {
    const status = parts[i];
    if (status[0] === 'R' || status[0] === 'C') {
      files.push({ status: status[0], orig: parts[++i], path: parts[++i] });
    } else {
      files.push({ status: status[0], path: parts[++i] });
    }
  }
  return files;
});

/* --- staging --- */

handle('repo:stage', async (repo, files) =>
  git(repo, ['add', '--', ...files])
);

handle('repo:unstage', async (repo, files) => {
  try {
    return await git(repo, ['restore', '--staged', '--', ...files]);
  } catch {
    return git(repo, ['reset', '-q', 'HEAD', '--', ...files]);
  }
});

handle('repo:stageAll', async (repo) => git(repo, ['add', '-A']));

handle('repo:unstageAll', async (repo) => {
  try {
    return await git(repo, ['restore', '--staged', '--', '.']);
  } catch {
    return git(repo, ['reset', '-q', 'HEAD']);
  }
});

handle('repo:discard', async (repo, files, untracked) => {
  /* The one command here that destroys work outright, so it checks what it was
     handed. A bare string would spread into single letters, and an empty list
     would leave `git clean -fd --` with no pathspec at all — which cleans the
     entire working tree. Neither is reachable from the UI today; both would be
     unrecoverable if it ever changed. */
  const list = (Array.isArray(files) ? files : [files])
    .filter((f) => typeof f === 'string' && f.trim());
  if (!list.length) throw new Error('Nothing was named to discard.');
  files = list;

  if (untracked) return git(repo, ['clean', '-fd', '--', ...files]);
  try {
    return await git(repo, ['restore', '--worktree', '--', ...files]);
  } catch {
    return git(repo, ['checkout', '--', ...files]);
  }
});

/** Apply a single hunk patch. action: stage | unstage | discard */
handle('repo:applyPatch', async (repo, patch, action) => {
  const args = ['apply', '--whitespace=nowarn', '--unidiff-zero'];
  if (action === 'stage') args.push('--cached');
  if (action === 'unstage') args.push('--cached', '--reverse');
  if (action === 'discard') args.push('--reverse');
  return gitStdin(repo, args, patch.endsWith('\n') ? patch : patch + '\n');
});

/* --- commit --- */

handle('repo:commit', async (repo, { message, amend, signoff }) => {
  const args = ['commit', '-m', message];
  if (amend) args.push('--amend');
  if (signoff) args.push('--signoff');
  return git(repo, args);
});

handle('repo:lastMessage', async (repo) =>
  (await git(repo, ['log', '-1', '--pretty=%B'])).trim()
);

/* --- branches --- */

handle('repo:checkout', async (repo, ref) => git(repo, ['checkout', ref]));

/* Switching branch with uncommitted work is the one routine action that can
   quietly cost you something, so the renderer asks first and passes the answer
   here. The whole sequence lives in one place because the interesting part is
   what happens when a step half-fails.

   - keep    plain checkout. Git carries the changes across, or refuses.
   - stash   set the work aside, switch, put it back.
   - discard throw away modifications to tracked files. Untracked files are
             left alone: nothing in git can bring those back. */
const CHECKOUT_MODES = new Set(['keep', 'stash', 'discard']);

const stashTop = (repo) =>
  git(repo, ['rev-parse', '--verify', '-q', 'refs/stash']).catch(() => '');

handle('repo:checkoutWith', async (repo, ref, mode) => {
  if (!CHECKOUT_MODES.has(mode)) throw new Error(`Unknown checkout mode: ${mode}`);

  if (mode !== 'stash') {
    const args = mode === 'discard' ? ['checkout', '--force', ref] : ['checkout', ref];
    await git(repo, args);
    return { stash: 'none' };
  }

  const before = await stashTop(repo);
  await git(repo, ['stash', 'push', '--include-untracked', '-m', `GitBraid: switching to ${ref}`]);
  // `stash push` with nothing to save is a success that stashes nothing, so the
  // ref itself is the only trustworthy evidence that anything was set aside.
  const stashed = (await stashTop(repo)) !== before;

  try {
    await git(repo, ['checkout', ref]);
  } catch (e) {
    // A refused switch must cost nothing: put the work back where it was.
    if (stashed) await git(repo, ['stash', 'pop']).catch(() => {});
    throw e;
  }

  if (!stashed) return { stash: 'none' };
  try {
    await git(repo, ['stash', 'pop']);
    return { stash: 'reapplied' };
  } catch (e) {
    // The stash is still there — it only pops on success — so say so rather
    // than pretending the switch was clean.
    return { stash: 'conflict', message: e.message };
  }
});

handle('repo:createBranch', async (repo, name, startPoint, checkout) => {
  if (checkout) return git(repo, ['checkout', '-b', name, ...(startPoint ? [startPoint] : [])]);
  return git(repo, ['branch', name, ...(startPoint ? [startPoint] : [])]);
});

handle('repo:deleteBranch', async (repo, name, force) =>
  git(repo, ['branch', force ? '-D' : '-d', name])
);

/* What the reader is about to do, in the terms they would check it in: which
   way round it goes, how much is coming, and whether the history will stay a
   straight line. Merging the wrong way round is the easy mistake, and no button
   label can show it. */
handle('repo:mergeInfo', async (repo, ref) => {
  const head = (await git(repo, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim();
  const counts = await git(repo, ['rev-list', '--left-right', '--count', `HEAD...${ref}`]);
  const [outgoing, incoming] = counts.trim().split(/\s+/).map(Number);
  /* A fast-forward is possible exactly when HEAD is already an ancestor of the
     other ref — that is, when nothing here is missing from there. The counts
     above already say so, which beats asking `merge-base --is-ancestor`: that
     one answers by exit status, and this helper does not carry exit codes. */
  return { head, incoming, outgoing, fastForward: outgoing === 0 };
});

const MERGE_MODES = new Set(['ff', 'no-ff', 'squash']);

handle('repo:merge', async (repo, ref, mode = 'ff') => {
  if (!MERGE_MODES.has(mode)) throw new Error(`Unknown merge mode: ${mode}`);
  const args = ['merge', '--no-edit'];
  if (mode === 'no-ff') args.push('--no-ff');
  // --squash brings the changes in and stages them; it deliberately does not
  // commit, so the reader writes the message themselves.
  if (mode === 'squash') args.push('--squash');
  args.push(ref);
  return git(repo, args);
});

handle('repo:rebase', async (repo, ref) => git(repo, ['rebase', ref]));

handle('repo:reset', async (repo, hash, mode) =>
  git(repo, ['reset', `--${mode}`, hash])
);

handle('repo:revert', async (repo, hash) =>
  git(repo, ['revert', '--no-edit', hash])
);

handle('repo:cherryPick', async (repo, hash) => git(repo, ['cherry-pick', hash]));

handle('repo:tag', async (repo, name, hash, message) =>
  git(repo, message ? ['tag', '-a', name, hash, '-m', message] : ['tag', name, hash])
);

/* --- remote ops --- */

/* git narrates a transfer on stderr — "Receiving objects:  62% (15/24)" — and
 * that narration is the only honest source of progress there is. Anything else
 * would be an animation pretending to know something it does not. */
const PHASES = [
  [/remote: *Enumerating objects/i, 'Enumerating'],
  [/remote: *Counting objects/i, 'Counting'],
  [/remote: *Compressing objects/i, 'Compressing'],
  [/^Receiving objects/i, 'Receiving'],
  [/^Writing objects/i, 'Writing'],
  [/^Resolving deltas/i, 'Resolving'],
  [/^Updating files|^Checking out files/i, 'Checking out'],
  [/^Unpacking objects/i, 'Unpacking'],
];

function sendProgress(op, line) {
  const pct = /(\d{1,3})%/.exec(line);
  const found = PHASES.find(([re]) => re.test(line));
  win?.webContents.send('repo:progress', {
    op,
    text: line,
    phase: found ? found[1] : null,
    percent: pct ? Number(pct[1]) : null,
  });
}

/** The same wrapper for every command whose progress is worth watching. */
const withProgress = (op, cwd, args) =>
  gitProgress(cwd, args, (line) => sendProgress(op, line));

handle('repo:fetch', async (repo, { prune = true } = {}) => {
  const args = ['fetch', '--all', '--progress'];
  if (prune) args.push('--prune');
  return withProgress('fetch', repo, args);
});

/* `mode` decides what happens when the histories have diverged. Fast-forward is
 * the default because it is the only one that cannot rewrite or merge anything
 * behind your back; the renderer asks before using either of the others. */
handle('repo:pull', async (repo, { mode = 'ff' } = {}) => {
  const how = mode === 'rebase' ? ['--rebase']
    : mode === 'merge' ? ['--no-rebase', '--no-edit']
    : ['--ff-only'];
  return withProgress('pull', repo, ['pull', ...how, '--progress']);
});

handle('repo:push', async (repo, { branch, remote = 'origin', setUpstream, force }) => {
  const args = ['push', '--progress'];
  if (force) args.push('--force-with-lease');
  if (setUpstream) args.push('-u');
  args.push(remote, branch);
  return withProgress('push', repo, args);
});


/* ------------------------------------------------------------------ */
/* an operation left half-finished                                     */
/* ------------------------------------------------------------------ */

/* A conflict stops git in the middle of something, and that half-finished state
 * is a fact about the repository, not about this window: close GitBraid during
 * a conflicted merge and the merge is still there tomorrow. Read straight from
 * .git rather than by running git — this is checked on every refresh. */
function readGitFile(repo, ...parts) {
  try {
    return fs.readFileSync(path.join(repo, '.git', ...parts), 'utf8').trim();
  } catch {
    return '';
  }
}

const gitPathExists = (repo, ...parts) => fs.existsSync(path.join(repo, '.git', ...parts));

handle('repo:state', async (repo) => {
  if (gitPathExists(repo, 'MERGE_HEAD')) {
    // MERGE_MSG's first line names what is being merged, e.g. "Merge branch 'sisi'".
    const msg = readGitFile(repo, 'MERGE_MSG').split('\n')[0];
    const named = /Merge (?:remote-tracking )?branch '([^']+)'/.exec(msg);
    return { kind: 'merge', label: 'Merging', target: named ? named[1] : '', step: 0, total: 0 };
  }

  for (const dir of ['rebase-merge', 'rebase-apply']) {
    if (!gitPathExists(repo, dir)) continue;
    const step = Number(readGitFile(repo, dir, 'msgnum')) || 0;
    const total = Number(readGitFile(repo, dir, 'end')) || 0;
    // head-name is "refs/heads/feature/x"; onto is a bare hash.
    const head = readGitFile(repo, dir, 'head-name').replace(/^refs\/heads\//, '');
    return { kind: 'rebase', label: 'Rebasing', target: head, step, total };
  }

  if (gitPathExists(repo, 'CHERRY_PICK_HEAD')) {
    return { kind: 'cherry-pick', label: 'Cherry-picking',
      target: readGitFile(repo, 'CHERRY_PICK_HEAD').slice(0, 7), step: 0, total: 0 };
  }
  if (gitPathExists(repo, 'REVERT_HEAD')) {
    return { kind: 'revert', label: 'Reverting',
      target: readGitFile(repo, 'REVERT_HEAD').slice(0, 7), step: 0, total: 0 };
  }
  return null;
});

const ABORTABLE = {
  merge: 'merge', rebase: 'rebase', 'cherry-pick': 'cherry-pick', revert: 'revert',
};

handle('repo:abort', async (repo, kind) => {
  const cmd = ABORTABLE[kind];
  if (!cmd) throw new Error(`Nothing called "${kind}" can be aborted.`);
  await git(repo, [cmd, '--abort']);
  return true;
});

handle('repo:continue', async (repo, kind) => {
  const cmd = ABORTABLE[kind];
  if (!cmd) throw new Error(`Nothing called "${kind}" can be continued.`);
  // Every one of these opens an editor for the message it already has; `true`
  // as the editor accepts it unchanged, which is what carrying on means here.
  return git(repo, [cmd, '--continue'], { GIT_EDITOR: 'true' });
});

/** Take one side of a conflict wholesale, or accept the file as it now stands. */
handle('repo:resolve', async (repo, filePath, side) => {
  if (side === 'ours' || side === 'theirs') {
    await git(repo, ['checkout', `--${side}`, '--', filePath]);
  } else if (side !== 'mark') {
    throw new Error(`Unknown resolution "${side}".`);
  }
  // Staging a conflicted path is what tells git the conflict is settled.
  await git(repo, ['add', '--', filePath]);
  return true;
});

/* --- stash --- */

handle('repo:stashList', async (repo) => {
  const raw = await git(repo, [
    'stash', 'list', '-z', `--pretty=format:%gd%x1f%s%x1f%at`,
  ]);
  return raw
    .split('\0')
    .filter((s) => s.trim())
    .map((s) => {
      const [ref, subject, at] = s.replace(/^\n/, '').split(UNIT);
      return { ref, subject, date: Number(at) * 1000 };
    });
});

handle('repo:stashSave', async (repo, message, includeUntracked) => {
  const args = ['stash', 'push'];
  if (includeUntracked) args.push('-u');
  if (message) args.push('-m', message);
  return git(repo, args);
});

/* Stashing a few files rather than everything. Same guard as discard: an empty
   pathspec here would take the whole working tree, which is not what a menu
   entry naming three files may ever do. */
handle('repo:stashPaths', async (repo, files, message, includeUntracked) => {
  const list = (Array.isArray(files) ? files : [files])
    .filter((f) => typeof f === 'string' && f.trim());
  if (!list.length) throw new Error('Nothing was named to stash.');
  const args = ['stash', 'push'];
  if (includeUntracked) args.push('-u');
  if (message) args.push('-m', message);
  args.push('--', ...list);
  return git(repo, args);
});

/* A patch of whichever files were picked, written where the user says.

   git diff shows tracked changes only, so an untracked file has nothing to
   report — the caller is told how many were left out rather than the file
   being written as though it held everything asked for. */
handle('repo:savePatch', async (repo, files, opts) => {
  const list = (Array.isArray(files) ? files : [files])
    .filter((f) => typeof f === 'string' && f.trim());
  if (!list.length) throw new Error('Nothing was named to save.');
  const { staged = false, skipped = 0, name = 'changes' } = opts || {};
  const patch = await git(repo, ['diff', ...(staged ? ['--cached'] : []), '--', ...list]);
  if (!patch.trim()) return { empty: true, skipped };

  const win = BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0];
  const { canceled, filePath } = await dialog.showSaveDialog(win, {
    title: 'Save as patch',
    defaultPath: path.join(app.getPath('downloads'), `${name}.patch`),
    filters: [{ name: 'Patch', extensions: ['patch', 'diff'] }, { name: 'All files', extensions: ['*'] }],
  });
  if (canceled || !filePath) return null;
  fs.writeFileSync(filePath, patch);
  return { path: filePath, bytes: Buffer.byteLength(patch), skipped };
});

handle('repo:stashApply', async (repo, ref, pop) =>
  git(repo, ['stash', pop ? 'pop' : 'apply', ref])
);

handle('repo:stashDrop', async (repo, ref) => git(repo, ['stash', 'drop', ref]));

/* --- misc --- */

handle('repo:raw', async (repo, args) => git(repo, args));

handle('shell:openPath', async (p) => shell.openPath(p));

handle('shell:openExternal', async (url) => {
  if (/^https?:\/\//i.test(url)) return shell.openExternal(url);
  throw new Error('Only http and https links can be opened.');
});
