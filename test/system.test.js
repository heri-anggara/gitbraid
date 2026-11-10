/* Everything around the git commands rather than the commands themselves: the
 * environment children inherit, restarting, the second launch, the update
 * check, the terminal panel, cloning, the Flatpak, the files GitBraid keeps,
 * Windows quoting and the askpass dialog. Each check drives the real main.js
 * through its handlers, and runs real processes wherever one can be run. */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const cp = require('child_process');
const { EventEmitter } = require('events');
const { loadMain, scratchRepo, reporter, ROOT } = require('./harness');

const { check, section, done } = reporter();

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const scratch = (prefix) => fs.mkdtempSync(path.join(os.tmpdir(), prefix));
const exe = (file, body) => { fs.writeFileSync(file, body, { mode: 0o755 }); return file; };
const until = async (fn, ms = 3000) => {
  const t = Date.now();
  while (Date.now() - t < ms) {
    const v = fn();
    if (v) return v;
    await wait(20);
  }
  return null;
};
const sh = JSON.stringify;   // a path quoted well enough for /bin/sh

/* What the window was sent on one channel, from `from` on. */
const sentOn = (m, channel, from = 0) => m.sent.slice(from).filter((s) => s.channel === channel);
/* Run one terminal-panel command to its end and hand back what it printed. */
async function termOutput(m, cwd, command, ms = 5000) {
  const from = m.sent.length;
  const res = await m.call('term:run', cwd, command);
  if (!res.ok) return { error: res.error };
  const exit = await until(() => sentOn(m, 'term:exit', from)[0], ms);
  const text = sentOn(m, 'term:out', from).map((s) => s.payload.text).join('');
  return { text, exit: exit && exit.payload };
}

(async () => {
  const runtime = scratch('gitbraid-sys-run-');   // askpass sockets for ready instances
  const origPath = process.env.PATH;

  /* ── 1. the AppImage's environment ─────────────────────────────── */
  section('the AppImage launcher\'s additions do not reach the programs GitBraid starts');
  {
    const APPDIR = '/tmp/.mount_GitBrTEST';
    const bin = scratch('gitbraid-sys-bin-');
    fs.writeFileSync(path.join(bin, 'gitconfig'), '');
    const envLog = path.join(bin, 'editor-env.txt');
    // An editor that writes down the environment it was started with.
    exe(path.join(bin, 'code'),
      `#!/bin/sh\nprintf '%s\\n%s\\n%s\\n' "$LD_LIBRARY_PATH" "$XDG_DATA_DIRS" "$PATH" > ${sh(envLog)}\n`);
    const image = path.join(scratch('gitbraid-sys-img-'), 'GitBraid.AppImage');
    fs.writeFileSync(image, 'old');
    // Exactly what electron-builder's AppRun leaves when the variables were unset before.
    const m = loadMain({
      ready: true,
      env: {
        XDG_RUNTIME_DIR: runtime,
        APPIMAGE: image,
        APPDIR,
        PATH: `${APPDIR}:${APPDIR}/usr/sbin:${bin}:${origPath}:`,
        LD_LIBRARY_PATH: `${APPDIR}/usr/lib:`,
        XDG_DATA_DIRS: `${APPDIR}/usr/share/:./share/:/usr/share/gnome:/usr/local/share/:/usr/share/:`
          + ':/usr/share/gnome/:/usr/local/share/:/usr/share/',
        GSETTINGS_SCHEMA_DIR: `${APPDIR}/usr/share/glib-2.0/schemas:`,
        FLATPAK_ID: undefined,
        // No gitbraid.editor of the reader's may decide which editor runs here.
        GIT_CONFIG_GLOBAL: path.join(bin, 'gitconfig'),
      },
    });
    await wait(50);
    check('LD_LIBRARY_PATH loses the mount and the empty entry that means "here"',
      process.env.LD_LIBRARY_PATH === undefined, process.env.LD_LIBRARY_PATH);
    check('XDG_DATA_DIRS loses ./share/ and the mount, and keeps the system folders once',
      process.env.XDG_DATA_DIRS === '/usr/share/gnome:/usr/local/share/:/usr/share/',
      process.env.XDG_DATA_DIRS);
    check('PATH loses the mount and keeps everything else in order',
      process.env.PATH === `${bin}:${origPath.split(':').filter(Boolean).join(':')}`, process.env.PATH);
    check('GSETTINGS_SCHEMA_DIR, only ever the mount, is gone',
      process.env.GSETTINGS_SCHEMA_DIR === undefined, process.env.GSETTINGS_SCHEMA_DIR);

    const r = scratchRepo();
    r.commit('a.txt', 'one\n', 'first');
    const out = await termOutput(m, r.dir,
      'printf "[%s]|[%s]" "$LD_LIBRARY_PATH" "$XDG_DATA_DIRS"; '
      + `case ":$PATH:" in *:${APPDIR}:*) echo " mount-in-path";; esac`);
    check('a terminal-panel command sees the cleaned environment',
      out.text === '[]|[/usr/share/gnome:/usr/local/share/:/usr/share/]', out);

    const ed = await m.call('shell:openInEditor', r.dir, path.join(r.dir, 'a.txt'));
    await until(() => fs.existsSync(envLog));
    await wait(50);
    const [ld, xdg, p] = fs.existsSync(envLog) ? fs.readFileSync(envLog, 'utf8').split('\n') : [];
    check('an editor GitBraid starts sees it too', ed.ok && ld === '' && !xdg.includes('./share')
      && !p.split(':').some((e) => !e || e.startsWith(APPDIR)), { ed, ld, xdg, p });

    // A hook is the simplest way to ask git what it was started with.
    const hookLog = path.join(bin, 'hook-env.txt');
    exe(path.join(r.dir, '.git', 'hooks', 'pre-commit'),
      `#!/bin/sh\nprintf '%s|%s' "$LD_LIBRARY_PATH" "$XDG_DATA_DIRS" > ${sh(hookLog)}\n`);
    r.write('b.txt', 'two\n');
    r.g(['add', 'b.txt']);
    await m.call('repo:commit', r.dir, { message: 'second' });
    const hook = fs.existsSync(hookLog) ? fs.readFileSync(hookLog, 'utf8') : null;
    check('and so does git, and what git runs in the repository',
      hook === '|/usr/share/gnome:/usr/local/share/:/usr/share/', hook);

    /* ── 2 and 9. restarting ─────────────────────────────────────── */
    section('restarting starts the AppImage on disk, and Relaunch quits properly');
    const fresh = path.join(path.dirname(image), 'GitBraid-new.AppImage');
    fs.writeFileSync(fresh, 'new');
    const from = m.calls.length;
    const inst = await m.call('update:install', { path: fresh, kind: 'appimage' });
    const rel = m.calls.slice(from).find((c) => c.what === 'relaunch');
    check('the swap puts the new file where the AppImage is', inst.ok && fs.readFileSync(image, 'utf8') === 'new', inst);
    check('Restart now relaunches $APPIMAGE, not the old mount',
      rel && rel.args[0] && rel.args[0].execPath === image
      && Array.isArray(rel.args[0].args), rel);

    fs.writeFileSync(fresh, 'newer');
    await m.call('update:later', { path: fresh, kind: 'appimage' });
    await m.call('app:menuState', { hasRepo: true });   // builds the menu
    const item = m.menuItem('Relaunch GitBraid');
    const mark = m.calls.length;
    item.click();
    const after = m.calls.slice(mark).map((c) => c.what);
    const rel2 = m.calls.slice(mark).find((c) => c.what === 'relaunch');
    check('the Relaunch menu item relaunches $APPIMAGE too', rel2 && rel2.args[0]
      && rel2.args[0].execPath === image, rel2);
    check('and quits rather than exits, so will-quit runs', after.includes('quit') && !after.includes('exit'), after);
    m.emit('will-quit');
    check('which applies the update that was put off', fs.readFileSync(image, 'utf8') === 'newer',
      fs.readFileSync(image, 'utf8'));
    m.restoreEnv();
    r.rm();
  }

  /* ── 3. a second launch ────────────────────────────────────────── */
  section('a second launch resolves its paths where it was typed');
  {
    const typedIn = scratch('gitbraid-sys-cwd-');
    const r = scratchRepo();
    fs.mkdirSync(path.join(typedIn, 'proj'));
    check('(this process is somewhere else)', process.cwd() !== typedIn);

    const m = loadMain();
    m.emit('second-instance', {}, ['/opt/GitBraid/gitbraid', '--no-sandbox', 'proj'], typedIn);
    const pending = await m.call('app:launchRepo');
    check('`gitbraid proj` before the window is up opens <where it was typed>/proj',
      pending.ok && pending.data === path.join(typedIn, 'proj'), pending);

    const w = loadMain({ ready: true, env: { XDG_RUNTIME_DIR: runtime } });
    await wait(50);
    const from = w.sent.length;
    w.emit('second-instance', {}, ['/opt/GitBraid/gitbraid', '.'], r.dir);
    const opened = sentOn(w, 'menu:action', from).find((s) => s.payload.action === 'open-recent');
    check('`gitbraid .` with the window open opens the folder it was typed in',
      opened && opened.payload.path === r.dir, opened);
    w.restoreEnv();
    r.rm();
  }

  /* ── 4. version order ──────────────────────────────────────────── */
  section('which release is newer, prerelease tags included');
  {
    const src = fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8');
    const code = src.match(/\/\* "0\.10\.0" is newer[\s\S]*?^}/m)[0];
    const ctx = {};
    vm.createContext(ctx);
    vm.runInContext(`${code}\nglobalThis.__isNewer = isNewer;`, ctx);
    const isNewer = ctx.__isNewer;
    const table = [
      ['0.12.0', '0.12.0-beta.1', true],
      ['0.12.0-beta.1', '0.12.0', false],
      ['0.12.0-beta.2', '0.12.0-beta.1', true],
      ['0.12.0-beta.11', '0.12.0-beta.2', true],
      ['0.12.0-rc.1', '0.12.0-beta.3', true],
      ['0.12.0-beta.3', '0.12.0-rc.1', false],
      ['0.12.0-beta', '0.12.0-alpha.9', true],
      ['0.12.0-alpha.1', '0.12.0-alpha', true],
      ['0.12.0-alpha', '0.12.0-alpha.1', false],
      ['0.12.0-alpha.beta', '0.12.0-alpha.1', true],
      ['0.12.0-beta.1', '0.11.1', true],
      ['0.11.1', '0.12.0-beta.1', false],
      ['v0.12.0', '0.11.1', true],
      ['0.12.0+build.7', '0.12.0', false],
      ['0.12.0', '0.12.0', false],
      ['0.10.0', '0.9.0', true],
      ['0.2', '0.2.0', false],
      ['1.0.0', '0.99.99', true],
    ];
    const wrong = table.filter(([a, b, want]) => isNewer(a, b) !== want);
    check(`isNewer agrees with semver on ${table.length} pairs`, wrong.length === 0, wrong);
  }

  /* ── 5 and 6. the terminal panel ───────────────────────────────── */
  section('Stop ends the whole command at once, and output keeps its characters');
  {
    const m = loadMain({ ready: true, env: { XDG_RUNTIME_DIR: runtime } });
    await wait(50);
    const dir = scratch('gitbraid-sys-term-');

    let from = m.sent.length;
    const run = await m.call('term:run', dir, 'sleep 5; echo done');
    await wait(300);
    const t0 = Date.now();
    await m.call('term:kill');
    const exit = await until(() => sentOn(m, 'term:exit', from)[0], 3000);
    const took = Date.now() - t0;
    check('Stop on `sleep 5; echo done` ends it within a second', run.ok && exit && took < 1000, { took, exit });
    await wait(100);
    let groupAlive = true;
    try { process.kill(-run.data.pid, 0); } catch { groupAlive = false; }
    check('and nothing it started is left running', !groupAlive);
    const again = await termOutput(m, dir, 'echo again');
    check('the panel takes the next command straight away', again.text === 'again\n' && again.exit.code === 0, again);

    // The shell is gone already; a job it left behind holds the pipes.
    from = m.sent.length;
    const bg = await m.call('term:run', dir, 'sleep 5 & echo started');
    await wait(300);
    const t1 = Date.now();
    await m.call('term:kill');
    const exit2 = await until(() => sentOn(m, 'term:exit', from)[0], 3000);
    check('Stop also frees the panel from a job the shell left behind',
      bg.ok && exit2 && Date.now() - t1 < 1000, { took: Date.now() - t1 });

    // One byte first, so that every 64 KiB chunk boundary falls inside a character.
    fs.writeFileSync(path.join(dir, 'wide.txt'), `a${'é'.repeat(400000)}`);
    const many = await termOutput(m, dir, 'cat wide.txt');
    check('400,000 two-byte characters arrive whole in the panel',
      many.text.length === 400001 && !many.text.includes('\uFFFD'),
      { length: many.text.length, broken: (many.text.match(/\uFFFD/g) || []).length });

    /* The same for git's own streaming paths: a hook speaks through git's
       stderr on a commit, and upload-pack through it on a fetch. */
    const r = scratchRepo();
    r.commit('a.txt', 'one\n', 'first');
    /* cat, not node -e: node exiting straight after a large write to a pipe
       can drop the end of it, which would look like the bug being tested. */
    const payload = path.join(scratch('gitbraid-sys-payload-'), 'noise.txt');
    fs.writeFileSync(payload, `a${'é'.repeat(200000)}`);
    const noisy = (file) => exe(file, `#!/bin/sh\ncat ${sh(payload)} >&2\nexit 1\n`);
    noisy(path.join(r.dir, '.git', 'hooks', 'pre-commit'));
    r.write('b.txt', 'two\n');
    r.g(['add', 'b.txt']);
    from = m.sent.length;
    const commit = await m.call('repo:commit', r.dir, { message: 'second' });
    const said = sentOn(m, 'repo:output', from).map((s) => s.payload.text).join('\n');
    check('a commit\'s failure reads back whole',
      !commit.ok && commit.error.length >= 200001 && !commit.error.includes('\uFFFD'),
      { ok: commit.ok, length: (commit.error || '').length, broken: ((commit.error || '').match(/\uFFFD/g) || []).length });
    check('and so does the transcript the output window shows',
      said.includes('éééé') && !said.includes('\uFFFD'), (said.match(/\uFFFD/g) || []).length);

    const pack = noisy(path.join(scratch('gitbraid-sys-pack-'), 'upload-pack'));
    r.g(['init', '-q', '--bare', path.join(r.dir, '..', `${path.basename(r.dir)}-remote.git`)]);
    r.g(['remote', 'add', 'origin', path.join(r.dir, '..', `${path.basename(r.dir)}-remote.git`)]);
    r.g(['config', 'remote.origin.uploadpack', pack]);
    const fetch = await m.call('repo:fetch', r.dir, {});
    check('a fetch\'s failure, through the progress path, reads back whole',
      !fetch.ok && (fetch.error.match(/é/g) || []).length === 200000 && !fetch.error.includes('\uFFFD'),
      { ok: fetch.ok, length: (fetch.error || '').length, broken: ((fetch.error || '').match(/\uFFFD/g) || []).length });
    m.restoreEnv();
    r.rm();
  }

  /* ── 7. cloning ────────────────────────────────────────────────── */
  section('a clone URL cannot be an option');
  {
    const m = loadMain();
    const parent = scratch('gitbraid-sys-clone-');
    const marker = path.join(parent, 'PWNED');
    const hostile = await m.call('repo:clone', `--config=core.sshCommand=touch ${marker}; false`, parent, 'h:repo');
    await wait(200);
    check('`--config=core.sshCommand=…` as the URL is refused', !hostile.ok, hostile);
    check('and runs nothing', !fs.existsSync(marker));
    check('and makes no folder', fs.readdirSync(parent).length === 0, fs.readdirSync(parent));

    const src = scratchRepo();
    src.commit('a.txt', 'one\n', 'first');
    const dashed = await m.call('repo:clone', src.dir, parent, '-dashed');
    check('a folder name starting with a dash is a folder name',
      dashed.ok && fs.existsSync(path.join(parent, '-dashed', 'a.txt')), dashed);
    src.rm();
  }

  /* ── 8. the Flatpak ────────────────────────────────────────────── */
  section('the Flatpak says what it can and cannot do');
  {
    const m = loadMain({ env: { FLATPAK_ID: 'io.github.heri_anggara.GitBraid', APPIMAGE: undefined } });
    const dl = await m.call('update:download', { assets: [] });
    check('an update is pointed at the software centre and flatpak update',
      !dl.ok && /software centre/.test(dl.error) && /flatpak update io\.github\.heri_anggara\.GitBraid/.test(dl.error), dl);
    m.restoreEnv();

    // A sandbox that may not run host commands: flatpak-spawn refuses every time.
    const bin = scratch('gitbraid-sys-fp-');
    const log = path.join(bin, 'spawned.txt');
    exe(path.join(bin, 'flatpak-spawn'), `#!/bin/sh\necho "$*" >> ${sh(log)}\nexit 1\n`);
    const t = loadMain({ env: { FLATPAK_ID: 'io.github.heri_anggara.GitBraid', PATH: `${bin}:/usr/bin:/bin` } });
    const dir = scratch('gitbraid-sys-fpdir-');
    const term = await t.call('repo:openTerminal', dir);
    const tried = fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n') : [];
    check('"Open in terminal" asks the host, through flatpak-spawn, in the right folder',
      tried.length >= 10 && tried.every((l) => l.startsWith(`--host --directory=${dir} `)), tried);
    check('and when the sandbox may not, says so and how to allow it',
      !term.ok && /Flatpak sandbox/.test(term.error)
      && /flatpak override --user --talk-name=org\.freedesktop\.Flatpak io\.github\.heri_anggara\.GitBraid/.test(term.error),
      term);
    t.restoreEnv();
  }

  /* ── 10. the files GitBraid keeps ──────────────────────────────── */
  section('repos.json and recent-repos.json are never left half written');
  {
    const m = loadMain();
    await m.call('repos:favorite', '/somewhere/a', true);
    const file = path.join(m.userData, 'repos.json');
    const ok1 = JSON.parse(fs.readFileSync(file, 'utf8'));
    check('a write lands whole', ok1.favorites.length === 1 && ok1.favorites[0] === '/somewhere/a', ok1);

    // A write that dies half way, as a crash or a full disk would leave it.
    const realWrite = fs.writeFileSync;
    fs.writeFileSync = function cut(target, data, ...rest) {
      const into = typeof target === 'number' || String(target).startsWith(m.userData);
      if (!into) return realWrite.call(fs, target, data, ...rest);
      const text = String(data);
      realWrite.call(fs, target, text.slice(0, Math.floor(text.length / 2)), ...rest);
      throw Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' });
    };
    try { await m.call('repos:favorite', '/somewhere/b', true); }
    finally { fs.writeFileSync = realWrite; }
    let kept = null;
    try { kept = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* half a file */ }
    check('a write cut short leaves the previous file whole',
      kept && kept.favorites.length === 1 && kept.favorites[0] === '/somewhere/a', fs.readFileSync(file, 'utf8').slice(0, 80));
    check('and no temporary file behind', fs.readdirSync(m.userData).every((f) => !f.endsWith('.tmp')),
      fs.readdirSync(m.userData));

    const r = scratchRepo();
    r.commit('a.txt', 'one\n', 'first');
    await m.call('repo:open', r.dir);
    const recents = JSON.parse(fs.readFileSync(path.join(m.userData, 'recent-repos.json'), 'utf8'));
    check('recent repositories are written the same way',
      recents[0].path === r.dir && fs.readdirSync(m.userData).every((f) => !f.endsWith('.tmp')), recents);
    r.rm();
  }

  /* ── 11. Windows ───────────────────────────────────────────────── */
  section('the terminal panel on Windows hands cmd the line as typed');
  {
    const spawned = [];
    const realSpawn = cp.spawn;
    const realPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
    cp.spawn = (cmd, args, opts) => {
      const child = new EventEmitter();
      const stream = () => Object.assign(new EventEmitter(), { setEncoding() {}, destroy() {} });
      Object.assign(child, {
        pid: 4242, exitCode: null, signalCode: null, stdout: stream(), stderr: stream(), kill() {},
      });
      spawned.push({ cmd, args, opts });
      return child;
    };
    Object.defineProperty(process, 'platform', { value: 'win32' });
    let m;
    try {
      m = loadMain({ env: { ComSpec: 'C:\\Windows\\System32\\cmd.exe' } });
    } finally {
      Object.defineProperty(process, 'platform', realPlatform);
    }
    try {
      const line = 'git commit -m "two words"';
      await m.call('term:run', 'C:\\repo', line);
      const run = spawned.find((s) => /cmd\.exe$/.test(s.cmd));
      check('cmd gets /d /s /c and the command untouched',
        run && JSON.stringify(run.args) === JSON.stringify(['/d', '/s', '/c', line]), run && run.args);
      check('with windowsVerbatimArguments, so Node does not escape its quotes',
        run && run.opts.windowsVerbatimArguments === true && !run.opts.detached,
        run && { windowsVerbatimArguments: run.opts.windowsVerbatimArguments, detached: run.opts.detached });
      await m.call('term:kill');
      const kill = spawned.find((s) => s.cmd === 'taskkill');
      check('Stop ends the tree with taskkill /T /F',
        kill && JSON.stringify(kill.args) === JSON.stringify(['/pid', '4242', '/T', '/F']), kill);
    } finally {
      cp.spawn = realSpawn;
      m.restoreEnv();
    }
  }

  /* ── 12. askpass ───────────────────────────────────────────────── */
  section('a question nobody can answer any more is answered "cancelled"');
  {
    const run = scratch('gitbraid-sys-ask-');
    const m = loadMain({ ready: true, env: { XDG_RUNTIME_DIR: run } });
    const stub = await until(() => {
      const d = fs.readdirSync(run).find((n) => n.startsWith(`gitbraid-${process.pid}-`));
      const f = d && path.join(run, d, 'askpass.sh');
      return f && fs.existsSync(path.join(run, d, 'ask.sock')) ? f : null;
    });
    check('(askpass is listening)', Boolean(stub), fs.readdirSync(run));

    let op = 900;
    const ask = async () => {
      const from = m.sent.length;
      const child = cp.spawn(stub, ["Password for 'https://u@example.invalid': "],
        { env: { ...process.env, GITBRAID_ASKPASS_OP: String(++op) } });
      let out = '';
      child.stdout.on('data', (d) => { out += d; });
      const ended = new Promise((resolve) => child.on('exit', (code) => resolve({ code, out })));
      const q = await until(() => sentOn(m, 'askpass:ask', from)[0]);
      return { q: q && q.payload, ended, child };
    };
    const within = (p, ms) => Promise.race([p, wait(ms).then(() => null)]);

    const ok = await ask();
    await m.call('askpass:answer', ok.q.id, 'sesame', false);
    const okEnd = await within(ok.ended, 2000);
    check('an answered question reaches the asker', okEnd && okEnd.code === 0 && okEnd.out === 'sesame\n', okEnd);

    for (const [what, raise] of [
      ['the renderer is gone', () => m.windows[0].webContents.emit('render-process-gone', {}, { reason: 'crashed' })],
      ['the window reloads', () => m.windows[0].webContents.emit('did-start-loading')],
      ['the window closes', () => m.windows[0].close()],
    ]) {
      const a = await ask();
      raise();
      const end = await within(a.ended, 1000);
      if (!end) a.child.kill();
      check(`when ${what}, the asker gives up at once with nothing typed`,
        a.q && end && end.code === 1 && end.out === '', { asked: Boolean(a.q), end });
    }
    m.emit('will-quit');
    m.restoreEnv();
  }

  done();
})().catch((e) => { console.error(e); process.exit(1); });
