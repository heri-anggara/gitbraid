/* Loads the real main.js under plain node with a stand-in for Electron, so a
 * test can call an IPC handler exactly as the window does and look at what git
 * did to a real repository afterwards. Nothing in main.js is copied or lifted:
 * the handler that runs is the one that ships.
 *
 * The stand-in records what main.js asks of Electron (relaunch, quit, shell
 * opens, messages to the window) so a test can check those too. A window is
 * never created: `whenReady` does not resolve.
 *
 * With `ready: true` it does resolve, so main.js starts askpass, opens its
 * window and builds its menu. The window is a stand-in too: what main.js sends
 * it lands in `sent`, and `windows[0]` can raise the events a real one would
 * (`emit('closed')`, `webContents.emit('render-process-gone')`). `emit` raises
 * app events — 'second-instance', 'will-quit' — and `menus` holds every menu
 * template main.js built, so a test can click an item.
 */
'use strict';

const Module = require('module');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { EventEmitter } = require('events');

const ROOT = path.join(__dirname, '..');

function loadMain({ env = {}, home, ready = false } = {}) {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'gitbraid-userdata-'));
  const handlers = new Map();
  const calls = [];                       // what main.js asked Electron to do
  const note = (what, ...args) => calls.push({ what, args });
  const listeners = new Map();            // app event -> handlers
  const listen = (event, fn) => {
    if (!listeners.has(event)) listeners.set(event, []);
    listeners.get(event).push(fn);
    return app;
  };
  const emit = (event, ...args) => (listeners.get(event) || []).map((fn) => fn(...args));
  const sent = [];                        // { channel, payload } sent to a window
  const windows = [];
  const menus = [];

  /* Enough of a BrowserWindow for createWindow and everything that talks to
     the window afterwards. */
  function FakeWindow() {
    const w = new EventEmitter();
    let visible = false;
    let destroyed = false;
    w.webContents = Object.assign(new EventEmitter(), {
      send: (channel, payload) => sent.push({ channel, payload }),
      setWindowOpenHandler: () => {},
      getURL: () => 'file:///index.html',
      setZoomLevel: () => {},
      executeJavaScript: async () => undefined,
    });
    Object.assign(w, {
      loadFile: () => {},
      isDestroyed: () => destroyed,
      isVisible: () => visible,
      isMinimized: () => false,
      show: () => { visible = true; },
      focus: () => {},
      restore: () => {},
      close: () => { destroyed = true; w.emit('closed'); },
    });
    windows.push(w);
    return w;
  }

  const app = {
    on: listen,
    once: listen,
    whenReady: () => (ready ? Promise.resolve() : new Promise(() => {})),
    requestSingleInstanceLock: () => true,
    commandLine: { appendSwitch: () => {} },
    getPath: (name) => (name === 'home' ? (home || os.homedir())
      : name === 'userData' ? userData
      : path.join(userData, name)),
    getVersion: () => require(path.join(ROOT, 'package.json')).version,
    getAppPath: () => ROOT,
    isPackaged: false,
    name: 'GitBraid',
    relaunch: (opts) => note('relaunch', opts),
    quit: () => note('quit'),
    exit: (code) => note('exit', code),
    setAppUserModelId: () => {},
    dock: { setIcon: () => {} },
  };
  const electron = {
    app,
    BrowserWindow: Object.assign(function BrowserWindow() {
      if (!ready) throw new Error('no windows under test');
      return FakeWindow();
    }, {
      getAllWindows: () => windows.filter((w) => !w.isDestroyed()),
      getFocusedWindow: () => null,
    }),
    Menu: {
      buildFromTemplate: (template) => { menus.push(template); return {}; },
      setApplicationMenu: () => {},
    },
    ipcMain: { handle: (ch, fn) => handlers.set(ch, fn), on: () => {} },
    dialog: {
      showOpenDialog: async () => ({ canceled: true, filePaths: [] }),
      showSaveDialog: async () => ({ canceled: true }),
      showMessageBox: async () => ({ response: 0 }),
    },
    shell: {
      openPath: async (p) => { note('openPath', p); return ''; },
      openExternal: async (u) => { note('openExternal', u); },
      showItemInFolder: (p) => note('showItemInFolder', p),
    },
    nativeImage: { createFromPath: () => ({ isEmpty: () => true }) },
  };

  const saved = {};
  for (const [k, v] of Object.entries(env)) {
    saved[k] = process.env[k];
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
  const realLoad = Module._load;
  Module._load = function load(request, ...rest) {
    if (request === 'electron') return electron;
    return realLoad.call(this, request, ...rest);
  };
  const file = path.join(ROOT, 'main.js');
  delete require.cache[require.resolve(file)];
  try {
    require(file);
  } finally {
    Module._load = realLoad;
  }
  const restoreEnv = () => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  };

  /** Call a handler the way the window does: `{ ok, data }` or `{ ok, error }`. */
  const call = async (channel, ...args) => {
    const fn = handlers.get(channel);
    if (!fn) throw new Error(`no handler for ${channel}`);
    return fn({ sender: { send: () => {} } }, ...args);
  };
  /* The newest menu's item with this label, wherever it sits. */
  const menuItem = (label) => {
    const walk = (items) => {
      for (const item of items || []) {
        if (item && item.label === label) return item;
        const inner = item && walk(item.submenu);
        if (inner) return inner;
      }
      return null;
    };
    return walk(menus[menus.length - 1]);
  };
  return {
    handlers, call, calls, userData, restoreEnv,
    emit, sent, windows, menus, menuItem,
  };
}

/* A scratch repository with a fixed identity and fixed dates, so a test reads
 * as a short script of git commands. */
function scratchRepo(prefix = 'gitbraid-h-') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const env = {
    ...process.env, LC_ALL: 'C', GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'Tester', GIT_AUTHOR_EMAIL: 't@t.io',
    GIT_COMMITTER_NAME: 'Tester', GIT_COMMITTER_EMAIL: 't@t.io',
  };
  const g = (args, opts = {}) => execFileSync('git', args, {
    cwd: opts.cwd || dir, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], env: { ...env, ...opts.env },
  });
  const write = (file, body) => {
    const p = path.join(dir, file);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, body);
  };
  const commit = (file, body, msg) => {
    write(file, body);
    g(['add', '--', file]);
    g(['commit', '-qm', msg]);
    return g(['rev-parse', 'HEAD']).trim();
  };
  const read = (file) => fs.readFileSync(path.join(dir, file), 'utf8');
  g(['init', '-q', '-b', 'main']);
  g(['config', 'user.name', 'Tester']);
  g(['config', 'user.email', 't@t.io']);
  g(['config', 'commit.gpgsign', 'false']);
  return { dir, g, write, commit, read, rm: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

/* The tiny check/section reporter every test file shares. */
function reporter() {
  let pass = 0;
  let fail = 0;
  const check = (name, cond, extra) => {
    if (cond) { pass++; console.log('  ok   ' + name); }
    else { fail++; console.log('  FAIL ' + name, extra === undefined ? '' : JSON.stringify(extra)); }
  };
  const section = (title) => console.log('\n' + title);
  const done = () => {
    console.log(`\n${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
  };
  return { check, section, done, counts: () => ({ pass, fail }) };
}

module.exports = { loadMain, scratchRepo, reporter, ROOT };
