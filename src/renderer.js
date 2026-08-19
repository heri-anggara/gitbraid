'use strict';

/* ═════ helpers ═════════════════════════════════════════════════ */

const $ = (id) => document.getElementById(id);
const el = (sel, root = document) => root.querySelector(sel);
const esc = (s) => window.Diff.esc(String(s ?? ''));

/* Anything here has to change how the app behaves. Where git already owns a
   setting — the default branch for new repositories, the editor to open files
   in — GitBraid writes git's own config key so the command line agrees with it,
   rather than keeping a private copy. */
const PREF_DEFAULTS = {
  autoFetch: 0,               // minutes between background fetches, 0 = off
  autoPrune: true,
  commitLimit: 400,
  resumeLast: true,
  dateStyle: 'absolute',
  toolbarLabels: true,
  ghostBadge: true,
  hoverMessage: true,
  diffFont: '',               // '' keeps the theme's monospace stack
  diffFontSize: 12,
  tabSize: 4,
  lineNumbers: true,
  gravatar: false,          // off: nothing leaves the machine
  avatarPlace: 'graph',     // graph | author | both | none
};

const prefs = { ...PREF_DEFAULTS };
try {
  Object.assign(prefs, JSON.parse(localStorage.getItem('gitbraid-prefs') || '{}'));
} catch { /* private mode */ }

function savePrefs() {
  try { localStorage.setItem('gitbraid-prefs', JSON.stringify(prefs)); }
  catch { /* private mode */ }
}

/* Every tab owns one of these. `state` always points at the active tab's, so
   the rest of the renderer keeps reading `state.commits` and friends without
   knowing tabs exist at all. */
let tabSeq = 0;

function newTab(repo) {
  return {
    id: `t${++tabSeq}`,
    repo,
    status: null,
    commits: [],
    refs: { branches: [], remotes: [], tags: [] },
    remoteRefNames: new Set(),  // "origin/main", … — to tell remotes from locals
    stashes: [],
    limit: prefs.commitLimit,
    selection: null,     // {kind:'wip'} | {kind:'commit', hash}
    file: null,          // {path, staged, untracked}
    diffFiles: [],
    diffContext: null,   // 'staged' | 'unstaged' | 'commit'
    flow: null,          // gitflow.* config, read with the rest of the repo
    op: null,            // an interrupted merge/rebase/cherry-pick/revert
    mergeSide: 'in',     // which parent a merge commit's file list compares against
    containedBy: new Map(),   // hash -> nama cabang yang memuatnya
    find: { query: '', hits: [], hitSet: new Set(), index: 0 },
    layout: null,        // graph lanes for every loaded commit, rebuilt with them
    rowIndex: new Map(),      // hash -> row number, for scrolling to a commit
    rowsShown: { first: 0, last: 0 },
    // Carried across tab switches so nothing typed is lost.
    commitMsg: '',
    commitBody: '',
    amend: false,
    scrollTop: 0,
  };
}

let tabs = [];
let activeId = null;
let state = newTab(null);   // placeholder while no repository is open

let busy = 0;

function setStatus(text, kind = '') {
  const node = $('status-text');
  node.textContent = text;
  node.className = 'status-text ' + kind;
}

function startBusy() {
  busy++;
  $('status-spinner').hidden = false;
}
function endBusy() {
  busy = Math.max(0, busy - 1);
  if (!busy) $('status-spinner').hidden = true;
}

/* A clone is the one command that can run for minutes, so it gets a bar
   instead of a spinner that says nothing about how far along it is. */
function showProgress(percent) {
  $('status-progress').hidden = false;
  $('status-bar').style.width = `${Math.max(0, Math.min(100, percent || 0))}%`;
}
function hideProgress() {
  $('status-progress').hidden = true;
  $('status-bar').style.width = '0%';
}

/** Call the main process. Returns data, or null after showing the error. */
async function call(channel, ...args) {
  startBusy();
  try {
    const res = await window.gitbraid.invoke(channel, ...args);
    if (!res.ok) {
      setStatus(firstLine(res.error), 'error');
      return null;
    }
    return res.data;
  } catch (err) {
    // A missing handler rejects rather than answering {ok:false}. Swallow it
    // here so one bad channel cannot abort the caller's whole sequence.
    setStatus(firstLine(err?.message || err), 'error');
    return null;
  } finally {
    endBusy();
  }
}

/* git puts the useful sentence wherever it likes. A rejected push opens with
   "To <url>", which says nothing; the reason is two lines down. Pick the line
   that actually explains the failure rather than whichever came first. */
function firstLine(s) {
  const lines = String(s || '').split(/[\r\n]/).map((l) => l.trim()).filter(Boolean);
  if (!lines.length) return 'Something went wrong';
  const pick =
    lines.find((l) => /^fatal:/i.test(l)) ||
    lines.find((l) => /^!\s|\[rejected\]/i.test(l)) ||
    lines.find((l) => /^CONFLICT\b/.test(l)) ||
    lines.find((l) => /^error:/i.test(l)) ||
    lines.find((l) => !/^To\s|^remote:\s*$|^hint:/i.test(l)) ||
    lines[0];
  // "! [rejected]  main -> main (non-fast-forward)" reads better without the bang.
  return pick.replace(/^!\s*\[rejected\]\s*/i, 'Rejected: ').slice(0, 220);
}

function relativeTime(ms) {
  const secs = Math.round((Date.now() - ms) / 1000);
  if (secs < 60) return 'just now';
  const mins = Math.round(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.round(hrs / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(ms).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

/** Whichever of the two the reader picked in Preferences → UI customization. */
const stamp = (ms) => (prefs.dateStyle === 'relative' ? relativeTime(ms) : absoluteTime(ms));

/** GitKraken's history stamp: 08/14/2026 @ 2:59 PM. */
function absoluteTime(ms) {
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  const h = d.getHours();
  return (
    `${p(d.getMonth() + 1)}/${p(d.getDate())}/${d.getFullYear()} @ ` +
    `${h % 12 || 12}:${p(d.getMinutes())} ${h < 12 ? 'AM' : 'PM'}`
  );
}

/* ═════ theme ═══════════════════════════════════════════════════ */

function applyTheme(name) {
  document.documentElement.dataset.theme = name;
  try { localStorage.setItem('gitbraid-theme', name); } catch { /* private mode */ }
}

function storedTheme() {
  try { return localStorage.getItem('gitbraid-theme') || 'dark'; } catch { return 'dark'; }
}

/* ═════ zoom ════════════════════════════════════════════════════ */

/* 13px is right for a dense history on a laptop panel and too small on a big
   desktop screen. Rather than guess, let the whole frame be scaled. */
let zoomLevel = 0;

async function applyZoom(level, announce = true) {
  zoomLevel = await call('app:zoom', level) ?? 0;
  try { localStorage.setItem('gitbraid-zoom', String(zoomLevel)); } catch { /* private mode */ }
  renderZoomLevel();
  if (announce) setStatus(`Zoom ${Math.round(1.2 ** zoomLevel * 100)}%`);
}

function storedZoom() {
  try { return Number(localStorage.getItem('gitbraid-zoom')) || 0; } catch { return 0; }
}

/* ═════ panels ══════════════════════════════════════════════════ */

const panels = { sidebar: true, detail: true, detailCollapsed: false };

function applyPanels() {
  $('app').classList.toggle('no-sidebar', !panels.sidebar);
  $('app').classList.toggle('no-detail', !panels.detail);
  // Collapsed only means anything while the panel is shown at all; the View
  // menu's hide wins, and the collapsed state waits for it to come back.
  $('app').classList.toggle('detail-collapsed', panels.detail && panels.detailCollapsed);
}

function collapseDetail(yes) {
  panels.detailCollapsed = yes;
  applyPanels();
  try { localStorage.setItem('gitbraid-panels', JSON.stringify(panels)); } catch { /* private mode */ }
}

for (const id of ['detail-collapse-wip', 'detail-collapse-commit']) {
  $(id).addEventListener('click', () => collapseDetail(true));
}
$('detail-rail').addEventListener('click', () => collapseDetail(false));

function togglePanel(which) {
  panels[which] = !panels[which];
  applyPanels();
  try { localStorage.setItem('gitbraid-panels', JSON.stringify(panels)); } catch { /* private mode */ }
  syncMenu();
}

function loadPanels() {
  try { Object.assign(panels, JSON.parse(localStorage.getItem('gitbraid-panels') || '{}')); } catch { /* defaults */ }
  applyPanels();
}

/** Mirror the renderer's state into the application menu. */
const syncMenu = () =>
  call('app:menuState', {
    hasRepo: !!state.repo,
    hasTab: tabs.length > 0,     // an empty tab can still be closed
    manyTabs: tabs.length > 1,
    sidebar: panels.sidebar,
    detail: panels.detail,
  });

/* ═════ avatars ═════════════════════════════════════════════════ */

/* Gravatar takes a SHA-256 of the lowercased address — the only digest
   crypto.subtle offers, and MD5 is not available in the renderer. Hashing is
   async, so URLs are resolved into this cache before a render and read back
   synchronously while building the SVG. */
const avatarCache = new Map();

async function ensureAvatars(commits) {
  /* Off by default, and deliberately so. Drawing a Gravatar means asking
     gravatar.com for it, which tells a third party your address and the hashed
     email of everyone whose commits you are reading — including colleagues, on
     a private work repository. It also fails offline and delays every repo you
     open. The lane-coloured disc says the same thing without leaving the
     machine, so the network version is something you switch on. */
  if (!prefs.gravatar) return;

  const emails = new Set(commits.map((c) => (c.email || '').trim().toLowerCase()));
  const todo = [...emails].filter((e) => e && !avatarCache.has(e));

  await Promise.all(todo.map(async (email) => {
    try {
      const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(email));
      const hex = [...new Uint8Array(digest)]
        .map((b) => b.toString(16).padStart(2, '0'))
        .join('');
      avatarCache.set(email, `https://www.gravatar.com/avatar/${hex}?s=32&d=identicon`);
    } catch {
      avatarCache.set(email, null); // no SubtleCrypto: fall back to a plain dot
    }
  }));
}

/** Offline or unknown addresses simply leave the lane-coloured disc bare. */
/* A fetched Gravatar picture, or nothing. Separate from where it is allowed to
   appear, because the two questions are genuinely different: one is whether the
   network was asked, the other is where the answer is drawn. */
const gravatarFor = (commit) =>
  (prefs.gravatar
    ? avatarCache.get((commit.email || '').trim().toLowerCase())
    : null) || null;

const showsAvatar = (where) =>
  prefs.avatarPlace === where || prefs.avatarPlace === 'both';

/* The graph's dot is sixteen pixels across with thirteen inside it, which is
   room for a picture and no room for lettering — so a dot carries a Gravatar or
   stays a plain lane-coloured disc. The Author column, having a whole row's
   height, can fall back to initials. */
const avatarFor = (commit) => (showsAvatar('graph') ? gravatarFor(commit) : null);

/** The small round face beside a name in the Author column. */
function authorChip(c) {
  if (!showsAvatar('author')) return '';
  const url = gravatarFor(c);
  if (url) return `<img class="c-face" src="${esc(url)}" alt="" loading="lazy">`;
  // No network involved: the letters are the author's, the colour is the
  // address's, so the same person is the same colour every time.
  return `<span class="c-face c-face-ini" style="--hue:${avatarHue(c.email)}">` +
    `${esc(initials(c.author))}</span>`;
}

/* ═════ modal ═══════════════════════════════════════════════════ */

function fieldHtml(f) {
  /* A choice between two paths that each do something different to your history
     deserves its reasons spelled out, not a dropdown you have to already
     understand. */
  if (f.type === 'choice') {
    return (
      '<div class="modal-field modal-choices">' +
      f.options.map((o, i) =>
        `<label class="choice"><input type="radio" name="${f.name}" data-field="${f.name}" ` +
        `value="${esc(o.value)}"${(f.value ?? f.options[0].value) === o.value ? ' checked' : ''}>` +
        `<span><strong>${esc(o.label)}</strong>` +
        (o.help ? `<span class="choice-help">${esc(o.help)}</span>` : '') +
        '</span></label>').join('') +
      '</div>'
    );
  }
  if (f.type === 'checkbox') {
    return (
      `<div class="modal-field"><label class="check">` +
      `<input type="checkbox" data-field="${f.name}"${f.value ? ' checked' : ''}> ${esc(f.label)}` +
      `</label></div>`
    );
  }
  const input =
    `<input type="text" id="mf-${f.name}" data-field="${f.name}" ` +
    `value="${esc(f.value || '')}" placeholder="${esc(f.placeholder || '')}">`;
  // A folder is picked, not typed — but stays editable for anyone who'd rather paste.
  const body =
    f.type === 'directory'
      ? `<div class="with-button">${input}` +
        `<button type="button" class="btn" data-browse="${f.name}">Browse…</button></div>`
      : input;
  return `<div class="modal-field"><label for="mf-${f.name}">${esc(f.label)}</label>${body}</div>`;
}

/**
 * `onChange(values, api)` runs on every edit: use `api.set` to derive one field
 * from another, `api.note` for the line under the form, and `api.invalid` to
 * block the confirm button beyond the automatic `required` check.
 */
function modal({
  title, description = '', fields = [], confirmLabel = 'Confirm',
  danger = false, onChange = null, html = '', hideCancel = false,
}) {
  return new Promise((resolve) => {
    $('modal-title').textContent = title;
    $('modal-desc').textContent = description;
    $('modal-desc').hidden = !description;

    const wrap = $('modal-fields');
    wrap.innerHTML = html || fields.map(fieldHtml).join('');

    const ok = $('modal-ok');
    ok.textContent = confirmLabel;
    ok.classList.toggle('btn-danger', danger);
    $('modal-cancel').hidden = hideCancel;
    $('modal-note').hidden = true;
    $('modal-note').textContent = '';
    $('modal').hidden = false;

    const collect = () => {
      const out = {};
      wrap.querySelectorAll('[data-field]').forEach((i) => {
        if (i.type === 'radio') { if (i.checked) out[i.dataset.field] = i.value; return; }
        out[i.dataset.field] = i.type === 'checkbox' ? i.checked : i.value.trim();
      });
      return out;
    };

    let blocked = false;
    const api = {
      set(name, value) {
        const input = wrap.querySelector(`[data-field="${name}"]`);
        if (input && input.value !== value) input.value = value;
      },
      note(text, isError = false) {
        const n = $('modal-note');
        n.textContent = text || '';
        n.hidden = !text;
        n.classList.toggle('error', !!isError);
      },
      invalid(reason) {
        blocked = true;
        if (reason) api.note(reason, true);
      },
    };

    const validate = () => {
      blocked = false;
      if (onChange) onChange(collect(), api);
      const v = collect();
      const missing = fields.some((f) => f.required && !String(v[f.name] ?? '').trim());
      ok.disabled = missing || blocked;
    };

    const onEdit = () => validate();
    const onBrowse = async (e) => {
      const btn = e.target.closest('[data-browse]');
      if (!btn) return;
      const target = wrap.querySelector(`[data-field="${btn.dataset.browse}"]`);
      const dir = await call('repo:pickDirectory', target?.value || '');
      if (dir) { target.value = dir; validate(); }
    };

    wrap.addEventListener('input', onEdit);
    wrap.addEventListener('change', onEdit);
    wrap.addEventListener('click', onBrowse);
    validate();

    const firstEmpty =
      [...wrap.querySelectorAll('input[type="text"]')].find((i) => !i.value) ||
      el('input[type="text"]', wrap);
    if (firstEmpty) { firstEmpty.focus(); firstEmpty.select(); }

    const close = (value) => {
      $('modal').hidden = true;
      ok.disabled = false;
      $('modal-cancel').hidden = false;
      wrap.removeEventListener('input', onEdit);
      wrap.removeEventListener('change', onEdit);
      wrap.removeEventListener('click', onBrowse);
      ok.removeEventListener('click', onOk);
      $('modal-cancel').removeEventListener('click', onCancel);
      document.removeEventListener('keydown', onKey);
      resolve(value);
    };
    const onOk = () => { if (!ok.disabled) close(collect()); };
    const onCancel = () => close(null);
    const onKey = (e) => {
      if (e.key === 'Escape') onCancel();
      if (e.key === 'Enter' && e.target.tagName !== 'TEXTAREA') onOk();
    };

    ok.addEventListener('click', onOk);
    $('modal-cancel').addEventListener('click', onCancel);
    document.addEventListener('keydown', onKey);
  });
}

const confirmAction = (title, description, confirmLabel = 'Confirm', danger = true) =>
  modal({ title, description, confirmLabel, danger }).then((r) => r !== null);

/* ═════ tooltips ════════════════════════════════════════════════ */

/* The native tooltip is an OS box that ignores the theme and takes a second to
   appear. This one reads the `title` already on the element and then takes it
   away, so every control in the app is covered without touching its markup —
   and a control that rewrites its own `title` later is picked up again on the
   next hover. */
const tip = { el: null, timer: 0 };

function showTip(target) {
  const text = target.dataset.tip;
  if (!text) return;
  const node = $('tooltip');
  node.textContent = text;
  // Park it at the origin before measuring: measured at its previous spot, a
  // tooltip near the right edge reports a squeezed width.
  node.style.left = '0px';
  node.style.top = '0px';
  node.hidden = false;

  const EDGE = 6;   // breathing room against the window
  const GAP = 7;    // space between the control and its tooltip
  const r = target.getBoundingClientRect();
  const t = node.getBoundingClientRect();

  const left = Math.min(
    Math.max(EDGE, r.left + r.width / 2 - t.width / 2),
    Math.max(EDGE, window.innerWidth - t.width - EDGE)
  );

  /* Below by default, above when there is no room below — and pinned inside the
     window either way. Without that last clamp a tall tooltip flipped upwards
     ran straight off the top of the screen. */
  const roomBelow = window.innerHeight - r.bottom - GAP - EDGE;
  const roomAbove = r.top - GAP - EDGE;
  let top;
  if (t.height <= roomBelow) top = r.bottom + GAP;
  else if (t.height <= roomAbove) top = r.top - GAP - t.height;
  else top = roomBelow >= roomAbove ? r.bottom + GAP : r.top - GAP - t.height;
  top = Math.max(EDGE, Math.min(top, window.innerHeight - t.height - EDGE));

  node.style.left = `${Math.round(left)}px`;
  node.style.top = `${Math.round(top)}px`;
}

function hideTip() {
  clearTimeout(tip.timer);
  tip.el = null;
  $('tooltip').hidden = true;
}

document.addEventListener('mouseover', (e) => {
  const target = e.target.closest('[title], [data-tip]');
  if (!target || target === tip.el) return;
  hideTip();
  // A live `title` always wins, so labels that change stay truthful.
  if (target.title) {
    target.dataset.tip = target.title;
    target.removeAttribute('title');
  }
  tip.el = target;
  tip.timer = setTimeout(() => showTip(target), 380);
});

document.addEventListener('mouseout', (e) => {
  if (tip.el && !tip.el.contains(e.relatedTarget)) hideTip();
});
document.addEventListener('mousedown', hideTip, true);
window.addEventListener('blur', hideTip);

/** A tooltip is a hint, not a document. The whole message is in the panel. */
function clipForTip(text, maxLines = 9, maxChars = 420) {
  const lines = String(text).split('\n');
  let out = lines.slice(0, maxLines).join('\n');
  if (lines.length > maxLines) out += '\n…';
  if (out.length > maxChars) out = out.slice(0, maxChars).trimEnd() + '…';
  return out;
}

/* ═════ context menu ════════════════════════════════════════════ */

/* Set while a menu is open, so opening a second one takes the first one down
   first. Without this the old listener stays bound to the old items array and
   one click runs an entry from a menu that is no longer on screen. */
let dismissMenu = null;

function contextMenu(event, items) {
  event.preventDefault();
  if (dismissMenu) dismissMenu();
  const menu = $('ctxmenu');
  menu.innerHTML = items
    .map((it, i) => {
      if (it === '-') return '<li class="sep"></li>';
      // An entry that cannot run right now still shows, so the menu explains
      // what exists rather than quietly rearranging itself.
      const cls = [it.danger ? 'danger' : '', it.disabled ? 'off' : '',
                   it.checked !== undefined ? 'checkable' : '',
                   it.icon && it.checked ? 'on' : ''].filter(Boolean).join(' ');
      /* An icon takes the tick's place: a menu whose entries are pictures of
         what they do does not also need a tick to say which one is on — the
         chosen row is lit instead. A blank tick keeps unchecked labels on the
         same left edge as checked ones. */
      const tick = it.icon
        ? `<span class="ctx-tick ctx-icon">${it.icon}</span>`
        : it.checked === undefined ? ''
        : `<span class="ctx-tick">${it.checked ? '✓' : ''}</span>`;
      // A keyboard shortcut sits to the right, so the label column stays even.
      const accel = it.accel ? `<span class="ctx-accel">${esc(it.accel)}</span>` : '';
      return `<li${it.disabled ? '' : ` data-i="${i}"`}` +
        `${cls || accel ? ` class="${[cls, accel ? 'has-accel' : ''].filter(Boolean).join(' ')}"` : ''}` +
        `${it.hint ? ` title="${esc(it.hint)}"` : ''}>${tick}${esc(it.label)}${accel}</li>`;
    })
    .join('');
  menu.hidden = false;
  const { innerWidth: w, innerHeight: h } = window;
  const rect = menu.getBoundingClientRect();
  menu.style.left = Math.min(event.clientX, w - rect.width - 8) + 'px';
  menu.style.top = Math.min(event.clientY, h - rect.height - 8) + 'px';

  const onClick = (e) => {
    const li = e.target.closest('li[data-i]');
    if (li) items[Number(li.dataset.i)].run();
    dismiss();
  };
  const dismiss = () => {
    menu.hidden = true;
    menu.removeEventListener('click', onClick);
    document.removeEventListener('mousedown', onDoc, true);
    if (dismissMenu === dismiss) dismissMenu = null;
  };
  const onDoc = (e) => { if (!menu.contains(e.target)) dismiss(); };
  menu.addEventListener('click', onClick);
  dismissMenu = dismiss;
  setTimeout(() => document.addEventListener('mousedown', onDoc, true), 0);
}

/** Esc closes a menu, like every other layer in the window. */
const closeContextMenu = () => dismissMenu && dismissMenu();

/* ═════ repository loading ══════════════════════════════════════ */

/** A repository already open just gets focused — never a second tab for it. */
async function openRepoAt(dir) {
  const repo = dir ? await call('repo:open', dir) : await call('repo:pick');
  if (!repo) return;

  const open = tabs.find((t) => t.repo?.path === repo.path);
  if (open) {
    await activateTab(open.id);
    setStatus(`${repo.name} is already open`, 'ok');
    return;
  }

  // An empty tab is a tab waiting for exactly this: fill it in place rather
  // than leaving a stray "New Tab" behind.
  const here = tabs.find((t) => t.id === activeId && !t.repo);
  if (here) {
    here.repo = repo;
    await activateTab(here.id);
  } else {
    const tab = newTab(repo);
    tabs.push(tab);
    await activateTab(tab.id);
  }
  setStatus(`Opened ${repo.path}`, 'ok');
}

/* Which repositories were open, and which one you were looking at. Saved on
   every change rather than at exit: a crash or a kill should not cost you the
   set of tabs you had arranged. Blank New Tabs are not saved — there is nothing
   in them to bring back. */
function saveTabs() {
  const withRepo = tabs.filter((t) => t.repo);
  const paths = withRepo.map((t) => t.repo.path);
  const here = withRepo.find((t) => t.id === activeId);
  try {
    // The path, not the position: a repository deleted from ahead of it would
    // shift an index onto the wrong tab.
    localStorage.setItem('gitbraid-tabs',
      JSON.stringify({ paths, active: here ? here.repo.path : paths[paths.length - 1] || '' }));
  } catch { /* private mode */ }
}

function storedTabs() {
  try {
    const v = JSON.parse(localStorage.getItem('gitbraid-tabs') || '{}');
    return {
      paths: Array.isArray(v.paths) ? v.paths : [],
      active: typeof v.active === 'string' ? v.active : '',
    };
  } catch {
    return { paths: [], active: '' };
  }
}

/** The "+" button: a tab showing the start page, as GitKraken's New Tab does. */
async function newEmptyTab() {
  const tab = newTab(null);
  tabs.push(tab);
  await activateTab(tab.id);
}

/* Leaving a tab. The commit box and the scroll position belong to the tab, not
   to the DOM — otherwise switching tabs would hand your half-written message to
   another repository.

   The parsed diff goes the other way: it is the one thing here that can run to
   megabytes (a 30k-line commit costs about 3 MB), and coming back always
   re-reads it from git anyway. Holding it would be pure cost. Commits and refs
   stay — a few hundred kB, and keeping them means a failed refresh still shows
   the history you had. */
function parkTab() {
  if (!tabs.some((t) => t.id === activeId)) return;
  state.commitMsg = $('commit-msg').value;
  state.commitBody = $('commit-body').value;
  state.amend = $('chk-amend').checked;
  state.scrollTop = $('history-scroll').scrollTop;
  state.diffFiles = [];
  state.diffContext = null;
}

function restoreTabUi() {
  $('commit-msg').value = state.commitMsg;
  $('commit-body').value = state.commitBody;
  $('chk-amend').checked = state.amend;
  $('find-input').value = state.find.query;
  $('find').hidden = !state.find.query;
}

/** Dress the window for whatever the active tab holds — a repository, or the
    start page when the tab is still empty (and when no tab is open at all). */
function renderShell() {
  const repo = state.repo;
  $('app').classList.toggle('is-empty', !repo);
  $('main').hidden = !repo;
  $('repo-actions').hidden = !repo;
  $('side-repo-name').textContent = repo ? repo.name : '';
  $('side-repo-name').title = repo ? repo.path : '';
  if (!repo) $('side-branch-name').textContent = '';
  document.title = repo ? `${repo.name} — GitBraid` : 'GitBraid';
  renderTabs();
  syncMenu();
  loadIdentity();   // a repository may carry its own name and email
}

async function activateTab(id) {
  const tab = tabs.find((t) => t.id === id);
  if (!tab) return;
  if (activeId && activeId !== id) parkTab();

  activeId = id;
  state = tab;
  renderShell();
  syncTermCwd();

  if (!tab.repo) {              // a New Tab: the start page is its content
    await loadRecents();
    setStatus('Ready');
    saveTabs();
    return;
  }

  restoreTabUi();

  /* The tab still holds every commit it was showing, so put that back on screen
     before asking git anything. Re-reading ten thousand commits first made each
     switch feel like the repository was being opened again. */
  if (state.commits.length) {
    renderOpState();
    renderToolbar();
    renderSidebar();
    renderHistory();
    $('history-scroll').scrollTop = state.scrollTop;
    await renderDetail();
    saveTabs();
    // Catches up behind the reader; refresh() drops its result if they have
    // moved to another tab by the time it lands.
    refresh();
    return;
  }

  await refresh();
  $('history-scroll').scrollTop = state.scrollTop;
  saveTabs();
}

async function closeTab(id = activeId) {
  const i = tabs.findIndex((t) => t.id === id);
  if (i < 0) return;
  const [gone] = tabs.splice(i, 1);

  if (gone.id !== activeId) { renderTabs(); syncMenu(); saveTabs(); return; }
  activeId = null;                       // nothing left to capture UI into
  const next = tabs[i] || tabs[i - 1];
  if (next) await activateTab(next.id);
  else await showWelcome();
  saveTabs();
}

function stepTab(delta) {
  if (tabs.length < 2) return;
  const i = tabs.findIndex((t) => t.id === activeId);
  activateTab(tabs[(i + delta + tabs.length) % tabs.length].id);
}

/** No tabs left at all: the start page, without a tab strip above it. */
async function showWelcome() {
  activeId = null;
  state = newTab(null);
  renderShell();
  await loadRecents();
  setStatus('Ready');
}

function renderTabs() {
  // The strip stays even with no tabs: settings and identity live on its right
  // and must be reachable from the start page too.
  $('tabs').innerHTML = tabs
    .map((t) => {
      const name = t.repo ? t.repo.name : 'New Tab';
      return (
        `<div class="tab${t.id === activeId ? ' active' : ''}${t.repo ? '' : ' blank'}" ` +
        `data-tab="${t.id}" title="${esc(t.repo ? t.repo.path : 'No repository open yet')}">` +
        (t.repo ? SIDE_ICON.branch : SIDE_ICON.folder) +
        `<span class="tab-name">${esc(name)}</span>` +
        `<button class="tab-close" data-close="${t.id}" title="Close tab (Ctrl+W)">${CLOSE_ICON}</button></div>`
      );
    })
    .join('');
}

async function refresh({ keepSelection = true } = {}) {
  if (!state.repo) return;
  // Whichever tab asked. A refresh can now outlive the switch that started it,
  // so the answer has to go back to the tab that wanted it rather than to
  // whatever happens to be in front when git finishes.
  const tab = state;
  const repo = tab.repo.path;
  const [status, commits, refs, stashes, flow, op] = await Promise.all([
    call('repo:status', repo),
    call('repo:log', repo, { limit: tab.limit, all: true }),
    call('repo:refs', repo),
    call('repo:stashList', repo),
    call('flow:config', repo),
    call('repo:state', repo),
  ]);
  if (status) tab.status = status;
  tab.op = op || null;            // a merge or rebase git stopped part-way
  if (commits) tab.commits = commits;
  if (refs) tab.refs = refs;
  if (stashes) tab.stashes = stashes;
  if (flow) tab.flow = flow;
  tab.remoteRefNames = new Set(tab.refs.remotes.map((r) => r.name));

  if (tab !== state) return;      // the reader moved on: keep the data, draw nothing

  renderOpState();
  state.containedBy = computeContainment();
  // Resolve avatar URLs up front; renderHistory reads the cache synchronously.
  await ensureAvatars(state.commits);

  const dirty = hasChanges();
  if (!keepSelection || !state.selection) {
    state.selection = dirty
      ? { kind: 'wip' }
      : state.commits[0] ? { kind: 'commit', hash: state.commits[0].hash } : null;
  }
  if (state.selection?.kind === 'wip' && !dirty && state.commits[0]) {
    state.selection = { kind: 'commit', hash: state.commits[0].hash };
  }

  renderToolbar();
  renderSidebar();
  renderHistory();
  await renderDetail();
}

function hasChanges() {
  const s = state.status;
  if (!s) return false;
  return s.staged.length + s.unstaged.length + s.untracked.length + s.conflicted.length > 0;
}

/* ═════ toolbar ═════════════════════════════════════════════════ */

function renderToolbar() {
  const s = state.status;
  $('side-branch-name').textContent = s?.branch || 'detached HEAD';
  $('side-branch').classList.toggle('detached', !s?.branch);

  /* The number alone does not say what it counts, and it is the thing people
     point at, so it carries its own explanation. */
  const ahead = $('badge-ahead');
  ahead.hidden = !s?.ahead;
  ahead.textContent = s?.ahead || '';
  ahead.title = s?.ahead
    ? `${s.ahead} commit${s.ahead === 1 ? '' : 's'} of yours are not on ${s.upstream || 'the remote'} yet`
    : '';

  const behind = $('badge-behind');
  behind.hidden = !s?.behind;
  behind.textContent = s?.behind || '';
  behind.title = s?.behind
    ? `${s.behind} commit${s.behind === 1 ? '' : 's'} on ${s.upstream || 'the remote'} are not here yet`
    : '';

  /* `aria-disabled` rather than `disabled`: a disabled button dispatches no
     mouse events in Chromium, and this is exactly the button whose greyed-out
     state most needs explaining on hover. */
  const canPop = state.stashes.length > 0;
  $('btn-pop').setAttribute('aria-disabled', String(!canPop));
  $('btn-pop').title = canPop
    ? `Apply the newest stash and drop it — “${state.stashes[0].subject}”`
    : 'Nothing stashed yet, so there is nothing to pop';

  // The button says what one click would do next.
  const flow = currentFlow();
  $('flow-label').textContent = flow ? `Finish ${flow.kind}` : 'Git-Flow';
  $('btn-flow').title = !state.flow?.initialized
    ? 'Set up Git-Flow in this repository'
    : flow
      ? `On ${flow.branch} — finish it, or start another`
      : `Git-Flow: ${state.flow.master} / ${state.flow.develop}`;
}

/* ═════ sidebar ═════════════════════════════════════════════════ */

const SIDE_ICON = {
  folder:
    '<svg class="side-i" viewBox="0 0 12 12" aria-hidden="true">' +
    '<path d="M1.2 3.1c0-.4.3-.7.7-.7h2.3l.9 1h5c.4 0 .7.3.7.7v4.8c0 .4-.3.7-.7.7H1.9a.7.7 0 0 1-.7-.7z" ' +
    'fill="none" stroke="currentColor" stroke-width="1.1" stroke-linejoin="round"/></svg>',
  branch:
    '<svg class="side-i" viewBox="0 0 12 12" aria-hidden="true">' +
    '<circle cx="3.2" cy="2.6" r="1.3" fill="none" stroke="currentColor" stroke-width="1.1"/>' +
    '<circle cx="3.2" cy="9.4" r="1.3" fill="none" stroke="currentColor" stroke-width="1.1"/>' +
    '<circle cx="8.8" cy="2.6" r="1.3" fill="none" stroke="currentColor" stroke-width="1.1"/>' +
    '<path d="M3.2 3.9v4.2M8.8 3.9c0 2.2-2 2.1-3.4 2.6" fill="none" stroke="currentColor" ' +
    'stroke-width="1.1" stroke-linecap="round"/></svg>',
  check:
    '<svg class="side-i" viewBox="0 0 12 12" aria-hidden="true">' +
    '<path d="M2 6.3 4.6 8.9 10 3.1" fill="none" stroke="currentColor" stroke-width="1.8" ' +
    'stroke-linecap="round" stroke-linejoin="round"/></svg>',
  remote:
    '<svg class="side-i" viewBox="0 0 12 12" aria-hidden="true">' +
    '<path d="M3.5 9.3a2.15 2.15 0 0 1 .25-4.28 3 3 0 0 1 5.7.6A2.05 2.05 0 0 1 8.9 9.3z" ' +
    'fill="none" stroke="currentColor" stroke-width="1.1" stroke-linejoin="round"/></svg>',
  tag:
    '<svg class="side-i" viewBox="0 0 12 12" aria-hidden="true">' +
    '<path d="M1.6 5.7V1.6h4.1l4.7 4.7-4.1 4.1z" fill="none" stroke="currentColor" ' +
    'stroke-width="1.1" stroke-linejoin="round"/>' +
    '<circle cx="3.7" cy="3.7" r=".9" fill="currentColor"/></svg>',
};

/**
 * feat/a, feat/b and main become a nested Map, so `feature/buyback-perhiasan`
 * reads as a `feature` folder holding `buyback-perhiasan` — the way the refs
 * are actually namespaced, instead of one long flat line per branch.
 */
function buildTree(items) {
  const root = new Map();
  for (const item of items) {
    const parts = item.name.split('/');
    let node = root;
    parts.forEach((part, i) => {
      if (i === parts.length - 1) {
        node.set(part, { type: 'leaf', label: part, item });
        return;
      }
      if (node.get(part)?.type !== 'folder') {
        node.set(part, { type: 'folder', label: part, children: new Map() });
      }
      node = node.get(part).children;
    });
  }
  return compactTree(root);
}

/**
 * A folder whose only child is another folder tells you nothing on its own, and
 * a Next.js path spends five rows getting to one file: src ▸ app ▸ api ▸ orders
 * ▸ [id] ▸ route.ts. Fold those chains into a single row — src ▸ app/api ▸
 * orders/[id] ▸ route.ts — the way editors do. A folder holding one *file* is
 * left alone: that file is the content, not a step on the way to it.
 */
function compactTree(node) {
  const out = new Map();
  for (const [name, entry] of node) {
    if (entry.type !== 'folder') { out.set(name, entry); continue; }
    let label = name;
    let children = entry.children;
    while (children.size === 1) {
      const [only] = children.values();
      if (only.type !== 'folder') break;
      label += `/${only.label}`;
      children = only.children;
    }
    // The label doubles as the path segment, so a folded chain keeps the whole
    // path — collapse state and folder keys stay correct.
    out.set(label, { type: 'folder', label, children: compactTree(children) });
  }
  return out;
}

/* Which folders the user has shut, remembered per kind and path. */
let shutFolders = new Set();
try {
  shutFolders = new Set(JSON.parse(localStorage.getItem('gitbraid-folders') || '[]'));
} catch { /* private mode */ }

const folderKey = (kind, path) => `${kind}:${path}`;

/* The same folders appear in three places, so the toggle redraws whichever one
   asked. Without this a folder in a file list looked collapsible and was not. */
function toggleFolder(kind, path) {
  const key = folderKey(kind, path);
  if (!shutFolders.delete(key)) shutFolders.add(key);
  try { localStorage.setItem('gitbraid-folders', JSON.stringify([...shutFolders])); } catch { /* ignore */ }
  if (kind.startsWith('wip-')) renderWip();
  else if (kind === 'cfile') renderCommitFiles();
  else renderSidebar();
}

/** Folders and leaves interleave in one alphabetical run, as in GitKraken. */
function renderTree(node, kind, leafHtml, prefix = '', depth = 0) {
  return [...node.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([name, entry]) => {
      if (entry.type === 'leaf') return leafHtml(entry.item, entry.label, depth);
      const path = prefix ? `${prefix}/${name}` : name;
      const shut = shutFolders.has(folderKey(kind, path));
      return (
        `<li class="tree-folder${shut ? ' shut' : ''}" data-folder="${esc(path)}" ` +
        `data-kind="${kind}" style="--d:${depth}">` +
        `<span class="chev">▾</span>${SIDE_ICON.folder}` +
        `<span class="side-name">${esc(name)}</span></li>` +
        (shut ? '' : renderTree(entry.children, kind, leafHtml, path, depth + 1))
      );
    })
    .join('');
}

const treeOrEmpty = (items, kind, leafHtml, empty) =>
  items.length ? renderTree(buildTree(items), kind, leafHtml) : `<li class="empty-row">${empty}</li>`;

function renderSidebar() {
  const { branches, remotes, tags } = state.refs;

  const branchLeaf = (b, label, depth) => {
    const track = b.track ? esc(b.track.replace(/[[\]]/g, '')) : '';
    return (
      `<li class="tree-leaf${b.current ? ' current' : ''}" data-ref="${esc(b.name)}" ` +
      `data-kind="branch" style="--d:${depth}" title="${esc(b.name)}">` +
      (b.current ? SIDE_ICON.check : SIDE_ICON.branch) +
      `<span class="side-name">${esc(label)}</span>` +
      (track ? `<span class="side-track">${track}</span>` : '') +
      '</li>'
    );
  };

  const remoteLeaf = (r, label, depth) =>
    `<li class="tree-leaf" data-ref="${esc(r.name)}" data-kind="remote" ` +
    `style="--d:${depth}" title="${esc(r.name)}">${SIDE_ICON.remote}` +
    `<span class="side-name">${esc(label)}</span></li>`;

  const tagLeaf = (t, label, depth) =>
    `<li class="tree-leaf" data-ref="${esc(t.name)}" data-kind="tag" ` +
    `style="--d:${depth}" title="${esc(t.name)}">${SIDE_ICON.tag}` +
    `<span class="side-name">${esc(label)}</span></li>`;

  $('count-local').textContent = branches.length;
  $('list-local').innerHTML = treeOrEmpty(branches, 'branch', branchLeaf, 'No branches yet');

  $('count-remote').textContent = remotes.length;
  $('list-remote').innerHTML = treeOrEmpty(remotes, 'remote', remoteLeaf, 'No remote branches');

  $('count-tags').textContent = tags.length;
  $('list-tags').innerHTML = treeOrEmpty(tags, 'tag', tagLeaf, 'No tags');

  // Stash refs are stash@{0}, stash@{1} … — nothing to nest.
  $('count-stash').textContent = state.stashes.length;
  $('list-stash').innerHTML = state.stashes
    .map(
      (s) =>
        `<li class="tree-leaf" data-ref="${esc(s.ref)}" data-kind="stash" style="--d:0" ` +
        `title="${esc(s.subject)}"><span class="side-name">${esc(s.subject)}</span>` +
        `<span class="side-track">${relativeTime(s.date)}</span></li>`
    )
    .join('') || '<li class="empty-row">Nothing stashed</li>';
}

/* ═════ history columns ═════════════════════════════════════════ */

/* Graph and message are structural: the graph's width comes from the drawing
   itself, and the message absorbs whatever is left. Everything else the reader
   may widen, narrow, or switch off. */
const COLUMNS = [
  { key: 'refs',   label: 'Branch / Tag',       cls: 'c-refs',   width: 158, min: 70,  optional: true },
  /* The graph sizes itself to the lanes it has to draw until the reader drags
     it, and from then on keeps the width they chose — on a repository with
     forty branches the automatic width can take half the window. */
  { key: 'graph',  label: 'Graph',              cls: 'c-graph',  fixed: 'var(--graph-w, 90px)',
    min: 24, optional: true, resizable: true },
  { key: 'msg',    label: 'Commit Message',     cls: 'c-msg',    fixed: 'minmax(140px, 1fr)' },
  { key: 'author', label: 'Author',             cls: 'c-author', width: 130, min: 60,  optional: true },
  { key: 'adate',  label: 'Author Time',        cls: 'c-adate',  width: 172, min: 110, optional: true,
    offByDefault: true },
  { key: 'cdate',  label: 'Commit Date / Time', cls: 'c-date',   width: 172, min: 110, optional: true },
  { key: 'sha',    label: 'SHA',                cls: 'c-sha',    width: 74,  min: 50,  optional: true },
];

const cols = {
  widths: Object.fromEntries(COLUMNS.filter((c) => c.width).map((c) => [c.key, c.width])),
  hidden: new Set(COLUMNS.filter((c) => c.offByDefault).map((c) => c.key)),
};
try {
  const saved = JSON.parse(localStorage.getItem('gitbraid-columns') || '{}');
  if (saved.widths) Object.assign(cols.widths, saved.widths);
  if (Array.isArray(saved.hidden)) cols.hidden = new Set(saved.hidden);
} catch { /* private mode */ }

const saveColumns = () => {
  try {
    localStorage.setItem('gitbraid-columns',
      JSON.stringify({ widths: cols.widths, hidden: [...cols.hidden] }));
  } catch { /* ignore */ }
};

const visibleColumns = () => COLUMNS.filter((c) => !cols.hidden.has(c.key));

/** Back to the widths and the visibility a fresh install starts with. */
function resetColumns() {
  for (const c of COLUMNS) {
    // A column with no declared width sizes itself; forgetting the dragged
    // value is what puts the graph back to following its lanes.
    if (c.width) cols.widths[c.key] = c.width;
    else delete cols.widths[c.key];
  }
  cols.hidden = new Set(COLUMNS.filter((c) => c.offByDefault).map((c) => c.key));
  saveColumns();
  applyColumns();
  renderHistoryHead();
  if (state.repo) renderHistory();
}

/** One track list, written once and shared by the header and every row. */
/* A dragged width always wins; without one the column falls back to whatever it
   declared — the graph's measured lane width, or the message column's 1fr. */
const trackFor = (c) => (cols.widths[c.key] ? `${cols.widths[c.key]}px` : c.fixed);

function applyColumns() {
  const list = visibleColumns();
  document.documentElement.style.setProperty('--hist-cols', list.map(trackFor).join(' '));

  /* The graph layer is positioned absolutely, outside the grid, so nothing
     stops it painting over the message column once the reader drags its column
     narrower than the lanes need. It is given the column's own width to clip to. */
  const graphCol = list.find((c) => c.key === 'graph');
  document.documentElement.style.setProperty('--graph-col-w', graphCol ? trackFor(graphCol) : '0px');
  $('graph-layer').hidden = !graphCol;

  /* The narrowest the history may get before it scrolls sideways. It used to be
     a constant built from the old fixed widths; with columns that move and
     disappear it has to be recomputed alongside them. */
  const fixed = list.reduce((sum, c) => sum + (c.width ? cols.widths[c.key] : 0), 0);
  const graph = graphCol ? trackFor(graphCol) : '0px';
  document.documentElement.style.setProperty('--hist-min', `calc(${graph} + ${fixed + 140}px)`);

  /* The graph is drawn on its own layer, outside the grid, so it has to be told
     where its column begins. Hard-coding the branch column's width meant the
     drawing kept that offset even when the column was switched off, and slid
     into the message column. */
  let x = 0;
  for (const c of list) {
    if (c.key === 'graph') break;
    x += cols.widths[c.key] || 0;
  }
  document.documentElement.style.setProperty('--graph-x', `${x}px`);

  renderHistoryHead();
}

function renderHistoryHead() {
  const list = visibleColumns();
  $('history-head').innerHTML = list
    .map((c, i) => {
      // The handle belongs to the column it resizes, and the last one has
      // nothing to its right to trade width with.
      const grip = (c.width || c.resizable) && i < list.length - 1
        ? `<span class="col-grip" data-grip="${c.key}"></span>`
        : '';
      return `<span class="hh ${c.cls}">${esc(c.label)}${grip}</span>`;
    })
    .join('');
}

/** Cells for one row, in the order the header is showing. */
function rowCells(parts) {
  return visibleColumns().map((c) => parts[c.key] ?? `<span class="${c.cls}"></span>`).join('');
}

/* ── resizing ── */
$('history-head').addEventListener('mousedown', (e) => {
  const grip = e.target.closest('[data-grip]');
  if (!grip) return;
  e.preventDefault();
  const key = grip.dataset.grip;
  const col = COLUMNS.find((c) => c.key === key);
  const startX = e.clientX;
  // A column that has never been dragged has no stored width — the graph starts
  // out sized to its lanes — so the drag begins from what is on screen.
  const startW = cols.widths[key] ?? grip.parentElement.getBoundingClientRect().width;
  document.body.classList.add('col-resizing');

  const onMove = (m) => {
    cols.widths[key] = Math.max(col.min, Math.round(startW + m.clientX - startX));
    applyColumns();
  };
  const onUp = () => {
    document.body.classList.remove('col-resizing');
    document.removeEventListener('mousemove', onMove);
    document.removeEventListener('mouseup', onUp);
    saveColumns();
  };
  document.addEventListener('mousemove', onMove);
  document.addEventListener('mouseup', onUp);
});

/* ── show / hide ── */
$('history-head').addEventListener('contextmenu', (e) => {
  contextMenu(e, [
    { label: 'Show columns', disabled: true },
    ...COLUMNS.filter((c) => c.optional).map((c) => ({
      label: c.label,
      checked: !cols.hidden.has(c.key),
      run: () => {
        if (!cols.hidden.delete(c.key)) cols.hidden.add(c.key);
        saveColumns();
        applyColumns();
        renderHistory();
      },
    })),
    '-',
    { label: 'Reset columns', run: resetColumns },
  ]);
});

/* ═════ history ═════════════════════════════════════════════════ */

/**
 * Which local branches contain each commit, walked from every branch tip down
 * through its parents. Done here rather than with `git branch --contains` per
 * row: that would be one process per hover, and the parent links are already
 * in the log we just read.
 */
/** The branch whose tip is exactly this commit, if any — used to name a parent. */
function branchAt(hash) {
  const all = [...state.refs.branches, ...state.refs.remotes];
  const hit = all.find((b) => b.oid === hash);
  return hit ? hit.name : '';
}

function computeContainment() {
  const parents = new Map(state.commits.map((c) => [c.hash, c.parents || []]));
  const out = new Map();
  for (const b of state.refs.branches) {
    const stack = [b.oid];
    const seen = new Set();
    while (stack.length) {
      const h = stack.pop();
      if (!h || seen.has(h)) continue;
      seen.add(h);
      const list = out.get(h);
      if (list) { if (!list.includes(b.name)) list.push(b.name); }
      else out.set(h, [b.name]);
      for (const p of parents.get(h) || []) stack.push(p);
    }
  }
  return out;
}

/**
 * Is this ref's tip already an ancestor of the branch you are on? The answer is
 * already in `containedBy`, the same walk the ghost badge uses, so saying it
 * before you click costs nothing.
 *
 * Built from local tips over the commits loaded so far, so it is used to
 * explain, never to block. Returns null when there is no answer.
 */
function alreadyIn(refName) {
  const head = state.status?.branch;
  if (!head) return null;
  const tip = state.refs.branches.find((b) => b.name === refName)?.oid;
  if (!tip) return null;
  const holders = state.containedBy?.get(tip);
  if (!holders) return null;
  return holders.includes(head);
}

/** The one branch worth naming for a commit: the one you are on, if it has it. */
function ghostBranch(hash) {
  const list = state.containedBy?.get(hash);
  if (!list || !list.length) return null;
  const head = state.status?.branch;
  return head && list.includes(head) ? head : list[0];
}

const REF_ICON = {
  check:
    '<svg class="pill-i" viewBox="0 0 12 12" aria-hidden="true">' +
    '<path d="M2 6.3 4.6 8.9 10 3.1" fill="none" stroke="currentColor" ' +
    'stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  local:
    '<svg class="pill-i" viewBox="0 0 12 12" aria-hidden="true">' +
    '<rect x="1" y="2" width="10" height="6.6" rx="1.2" fill="none" ' +
    'stroke="currentColor" stroke-width="1.2"/>' +
    '<path d="M4.4 10.6h3.2" stroke="currentColor" stroke-width="1.2" ' +
    'stroke-linecap="round"/></svg>',
  remote:
    '<svg class="pill-i" viewBox="0 0 12 12" aria-hidden="true">' +
    '<path d="M3.5 9.3a2.15 2.15 0 0 1 .25-4.28 3 3 0 0 1 5.7.6A2.05 2.05 0 0 1 8.9 9.3z" ' +
    'fill="none" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/></svg>',
  tag:
    '<svg class="pill-i" viewBox="0 0 12 12" aria-hidden="true">' +
    '<path d="M1.6 5.7V1.6h4.1l4.7 4.7-4.1 4.1z" fill="none" stroke="currentColor" ' +
    'stroke-width="1.2" stroke-linejoin="round"/>' +
    '<circle cx="3.7" cy="3.7" r=".95" fill="currentColor"/></svg>',
};

/**
 * Turn a commit's decorations into the pills GitKraken puts in its left
 * column: one per local branch — carrying a cloud icon when the very same
 * branch also sits on a remote — then remote-only branches, then tags.
 * Pills borrow the commit's lane colour so the column reads with the graph.
 */
function refPills(commit, lane) {
  const locals = [], remotes = [], tags = [];
  let current = null;

  for (const ref of commit.refs) {
    if (ref === 'HEAD') continue;
    /* `origin/HEAD` is a pointer to the remote's default branch, not a branch of
       its own. git prints it as a decoration, and without this it was landing in
       the local-branch bucket and drawing a badge nobody asked for. */
    if (/(^|\/)HEAD$/.test(ref) || /\/HEAD -> /.test(ref)) continue;
    if (ref.startsWith('HEAD -> ')) { current = ref.slice(8); locals.push(current); }
    else if (ref.startsWith('tag: ')) tags.push(ref.slice(5));
    else if (state.remoteRefNames.has(ref)) remotes.push(ref);
    else locals.push(ref);
  }

  const pill = (label, lead, trail, isCurrent) =>
    `<span class="pill${isCurrent ? ' current' : ''}" style="--pc:${lane}" ` +
    `title="${esc(label)}">${lead}<span class="pill-name">${esc(label)}</span>${trail}</span>`;

  const out = [];
  const mirrored = new Set();
  for (const name of locals) {
    const mirror = remotes.find((r) => r.slice(r.indexOf('/') + 1) === name);
    if (mirror) mirrored.add(mirror);
    out.push(pill(
      name,
      name === current ? REF_ICON.check : '',
      REF_ICON.local + (mirror ? REF_ICON.remote : ''),
      name === current
    ));
  }
  for (const r of remotes) {
    if (!mirrored.has(r)) out.push(pill(r, '', REF_ICON.remote, false));
  }
  for (const t of tags) out.push(pill(t, REF_ICON.tag, '', false));
  return out.join('');
}

/* ═════ find in history ═════════════════════════════════════════ */

/** Escape first, then wrap — so a query full of &lt; cannot inject markup. */
function highlight(text, query) {
  const src = String(text ?? '');
  if (!query) return esc(src);
  const hay = src.toLowerCase();
  const needle = query.toLowerCase();
  let out = '';
  let i = 0;
  for (;;) {
    const at = hay.indexOf(needle, i);
    if (at < 0) return out + esc(src.slice(i));
    out += esc(src.slice(i, at)) + '<mark>' + esc(src.slice(at, at + needle.length)) + '</mark>';
    i = at + needle.length;
  }
}

const commitMatches = (c, q) =>
  c.subject.toLowerCase().includes(q) ||
  (c.body || '').toLowerCase().includes(q) ||
  c.author.toLowerCase().includes(q) ||
  (c.email || '').toLowerCase().includes(q) ||
  c.hash.startsWith(q);

function runFind(query) {
  const f = state.find;
  f.query = query;
  const q = query.trim().toLowerCase();
  f.hits = q ? state.commits.filter((c) => commitMatches(c, q)).map((c) => c.hash) : [];
  f.hitSet = new Set(f.hits);
  f.index = 0;
  renderHistory();
  renderFindCount();
  if (f.hits.length) gotoMatch(0);
}

function renderFindCount() {
  const f = state.find;
  $('find-count').textContent = !f.query.trim()
    ? ''
    : f.hits.length
      ? `${f.index + 1} of ${f.hits.length}`
      : 'no matches';
  $('find-count').classList.toggle('none', Boolean(f.query.trim()) && !f.hits.length);
}

/** Move the selection to a commit and bring it into view. */
/* Moving the selection used to redraw every row, so on a long history a click
   cost as much as opening the repository: 4,800 rows took 239 ms, 177 ms of it
   spent rebuilding a list whose only change was one class. Nothing else in a
   row depends on which row is selected, so the class is all that moves. */
function paintSelection() {
  const sel = state.selection;
  const list = $('commit-list');
  list.querySelector('.commit-row.selected')?.classList.remove('selected');
  const want = sel?.kind === 'wip'
    ? list.querySelector('.commit-row[data-wip]')
    : sel?.hash
      ? list.querySelector(`.commit-row[data-hash="${sel.hash}"]`)
      : null;
  want?.classList.add('selected');
}

async function selectCommit(hash) {
  state.file = null;
  state.mergeSide = 'in';        // a side chosen on one merge means nothing on another
  state.selection = { kind: 'commit', hash };
  paintSelection();
  scrollToCommit(hash);
  await renderDetail();
}

async function gotoMatch(index) {
  const f = state.find;
  if (!f.hits.length) return;
  f.index = (index + f.hits.length) % f.hits.length;
  const hash = f.hits[f.index];
  state.file = null;
  state.mergeSide = 'in';
  state.selection = { kind: 'commit', hash };
  paintSelection();
  renderFindCount();
  scrollToCommit(hash);
  await renderDetail();
}

function openFind() {
  if (!state.repo) return;
  $('find').hidden = false;
  $('find-input').focus();
  $('find-input').select();
}

function closeFind() {
  $('find').hidden = true;
  $('find-input').value = '';
  runFind('');
}

/* Rows drawn beyond each edge of the window. They are what lets scrolling skip
   the redraw entirely: as long as the reader stays inside this margin the
   markup already on the page still covers the view. */
const OVERSCAN = 24;

/* Exactly the rows the reader can see — no margin. The sticky header lives
   inside the scroller, so it eats the first --head-h pixels of scroll travel. */
function requiredRange(total) {
  const sc = $('history-scroll');
  const rowH = window.Graph.ROW_H;
  const top = Math.max(0, sc.scrollTop - $('history-head').offsetHeight);
  const first = Math.min(Math.floor(top / rowH), Math.max(0, total - 1));
  // clientHeight is 0 while the pane is hidden; guess high rather than draw nothing.
  const fits = Math.ceil((sc.clientHeight || 900) / rowH) + 1;
  return { first, last: Math.min(total, first + fits) };
}

/* Puts the row for a commit on screen without depending on the row existing —
   at any moment most of them do not. */
function scrollToCommit(hash) {
  const i = state.rowIndex?.get(hash);
  if (i === undefined) return;
  const sc = $('history-scroll');
  const rowH = window.Graph.ROW_H;
  const y = $('history-head').offsetHeight + i * rowH;
  sc.scrollTop = Math.max(0, y - (sc.clientHeight - rowH) / 2);
  renderRows();
}

function renderHistory() {
  const dirty = hasChanges();
  const rowsData = dirty
    ? [{
        hash: 'WORKDIR',
        parents: state.status?.oid ? [state.status.oid] : [],
        pending: true,
        subject: 'Uncommitted changes',
        author: '',
        refs: [],
        commitDate: Date.now(),
      }, ...state.commits]
    : state.commits;

  const layout = window.Graph.layout(rowsData);
  // Held on the tab so scrolling can re-slice the view without laying the
  // graph out again — the layout only changes when the commits do.
  state.layout = layout;
  state.rowIndex = new Map(rowsData.map((c, i) => [c.hash, i]));

  document.documentElement.style.setProperty('--graph-w', layout.width + 'px');
  renderRows();
  $('btn-more').hidden = state.commits.length < state.limit;
}

/* Builds the markup for the visible band only. A ten-thousand-commit history
   put over a hundred thousand nodes in the document, and the browser paid for
   every one of them on every scroll; this keeps it to about a screenful. */
function renderRows() {
  const layout = state.layout;
  if (!layout) return;
  const find = state.find;
  const rowH = window.Graph.ROW_H;
  const total = layout.rows.length;
  const need = requiredRange(total);
  const first = Math.max(0, need.first - OVERSCAN);
  const last = Math.min(total, need.last + OVERSCAN);
  state.rowsShown = { first, last };

  // Nothing to draw when the column is off, and the string is the expensive part.
  $('graph-layer').innerHTML = cols.hidden.has('graph')
    ? ''
    : window.Graph.render(layout, state.rowIndex, { avatarFor, first, last });

  const sel = state.selection;
  const list = $('commit-list');
  // The rows that were skipped still have to take up their space, or the
  // scrollbar would shrink and the graph behind would slide out of step.
  list.style.paddingTop = `${first * rowH}px`;
  list.style.paddingBottom = `${(total - last) * rowH}px`;
  // Walk the laid-out rows, not rowsData, so each row knows its lane colour.
  list.innerHTML = layout.rows
    .slice(first, last)
    .map((row) => {
      const c = row.commit;
      if (c.pending) {
        const n = state.status.staged.length + state.status.unstaged.length +
                  state.status.untracked.length + state.status.conflicted.length;
        return (
          `<li class="commit-row pending${sel?.kind === 'wip' ? ' selected' : ''}" ` +
          'data-wip="1" style="--lane:var(--pending)">' +
          rowCells({
            msg: '<span class="c-msg"><span class="c-msg-text">Uncommitted changes</span>' +
              `<span class="c-msg-body">${n} file${n === 1 ? '' : 's'}</span></span>`,
            cdate: '<span class="c-date">now</span>',
            sha: '<span class="c-sha">—</span>',
          }) + '</li>'
        );
      }
      const lane = window.Graph.laneColor(row.lane);
      const selected = sel?.kind === 'commit' && sel.hash === c.hash;
      // While a search is running, rows that miss it fade rather than vanish:
      // dropping them would tear holes in the graph beside them.
      const q = find.query.trim();
      const hit = find.hitSet.has(c.hash);
      const cls =
        (selected ? ' selected' : '') +
        (q && !hit ? ' faded' : '') +
        (q && hit && find.hits[find.index] === c.hash ? ' find-current' : '');
      const pills = refPills(c, lane);
      // Shown only while the row is hovered, and only when no real badge is
      // already there: it answers "which branch is this on?" without adding
      // permanent noise to every row.
      const ghost = pills || !prefs.ghostBadge ? '' : (() => {
        const b = ghostBranch(c.hash);
        return b
          ? `<span class="pill ghost" style="--pc:${lane}" title="${esc(c.hash.slice(0, 7))} is on ${esc(b)}">` +
            `${REF_ICON.local}<span class="pill-name">${esc(b)}</span></span>`
          : '';
      })();
      const full = prefs.hoverMessage
        ? clipForTip(c.body ? `${c.subject}\n\n${c.body}` : c.subject)
        : '';
      return (
        `<li class="commit-row${cls}" data-hash="${c.hash}" ` +
        `style="--lane:${lane}" title="${esc(full)}">` +
        rowCells({
          refs: `<span class="c-refs">${pills}${ghost}</span>`,
          msg: `<span class="c-msg"><span class="c-msg-text">${highlight(c.subject, q)}</span>` +
            (c.body ? `<span class="c-msg-body">${highlight(c.body.split('\n')[0], q)}</span>` : '') +
            '</span>',
          author: `<span class="c-author">${authorChip(c)}${highlight(c.author, q)}</span>`,
          adate: `<span class="c-adate">${stamp(c.authorDate)}</span>`,
          cdate: `<span class="c-date">${stamp(c.commitDate)}</span>`,
          sha: `<span class="c-sha">${c.hash.slice(0, 7)}</span>`,
        }) + '</li>'
      );
    })
    .join('');
}

/* ═════ detail panel ════════════════════════════════════════════ */

async function renderDetail() {
  const sel = state.selection;
  $('panel-wip').hidden = sel?.kind !== 'wip';
  $('panel-commit').hidden = sel?.kind !== 'commit';

  if (sel?.kind === 'wip') return renderWip();
  if (sel?.kind === 'commit') return renderCommitPanel(sel.hash);
}

const F_ICON = {
  // "ours" and "theirs" point at the two sides; the tick settles the file.
  ours: '<svg class="tb-i" viewBox="0 0 12 12" aria-hidden="true">' +
    '<path d="M7.4 2.6 4 6l3.4 3.4" fill="none" stroke="currentColor" ' +
    'stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  theirs: '<svg class="tb-i" viewBox="0 0 12 12" aria-hidden="true">' +
    '<path d="M4.6 2.6 8 6l-3.4 3.4" fill="none" stroke="currentColor" ' +
    'stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  mark: '<svg class="tb-i" viewBox="0 0 12 12" aria-hidden="true">' +
    '<path d="M2.6 6.4 5 8.8l4.4-5.2" fill="none" stroke="currentColor" ' +
    'stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  stage: '<svg class="tb-i" viewBox="0 0 12 12" aria-hidden="true">' +
    '<path d="M6 2.4v7.2M2.4 6h7.2" fill="none" stroke="currentColor" ' +
    'stroke-width="1.7" stroke-linecap="round"/></svg>',
  unstage: '<svg class="tb-i" viewBox="0 0 12 12" aria-hidden="true">' +
    '<path d="M2.4 6h7.2" fill="none" stroke="currentColor" ' +
    'stroke-width="1.7" stroke-linecap="round"/></svg>',
  discard: '<svg class="tb-i" viewBox="0 0 12 12" aria-hidden="true">' +
    '<path d="M2.4 3.8h7.2M4.8 3.8V2.8h2.4v1M3.6 3.8l.4 6h4l.4-6" fill="none" ' +
    'stroke="currentColor" stroke-width="1.3" stroke-linecap="round" ' +
    'stroke-linejoin="round"/></svg>',
};

function fileRow(f, kind, depth = 0, mode = 'path') {
  const selected =
    state.file &&
    state.file.path === f.path &&
    state.file.kind === kind;

  const act = (name, label, danger) =>
    `<button class="f-act${danger ? ' danger' : ''}" data-act="${name}" ` +
    `title="${label}">${F_ICON[name]}</button>`;
  const actions =
    kind === 'conflict'
      ? act('ours', 'Keep your version of this file') +
        act('theirs', 'Keep their version of this file') +
        act('mark', 'Mark resolved — keep the file as it is on disk now')
    : kind === 'staged' ? act('unstage', 'Unstage this file')
    : kind === 'unstaged'
      ? act('stage', 'Stage this file') + act('discard', 'Throw away these changes', true)
      : '';

  /* The folder is context and the file name is the point, so the two are
     weighted differently rather than run together as one grey string. Where
     they sit is what separates the two flat shapes: reading a path, the folder
     leads; reading a list of files, the name leads and the folder answers
     "which one?" beside it, without a hover. Tree hands in a leaf label and
     needs neither. */
  let name;
  if (mode === 'list') {
    const cut = f.path.lastIndexOf('/');
    name = `<span class="f-name">${esc(cut < 0 ? f.path : f.path.slice(cut + 1))}</span>` +
      (cut < 0 ? '' : `<span class="f-dir-after">${esc(f.path.slice(0, cut))}</span>`);
  } else {
    const shown = (f.label ?? f.path).replace(/\/$/, '');
    const cut = shown.lastIndexOf('/');
    name = cut < 0
      ? esc(shown)
      : `<span class="f-dir">${esc(shown.slice(0, cut + 1))}</span>${esc(shown.slice(cut + 1))}`;
  }

  return (
    `<li class="${depth || f.label ? 'tree-leaf ' : ''}${selected ? 'selected' : ''}" ` +
    `data-path="${esc(f.path)}" data-kind="${kind}" data-status="${esc(f.status)}" ` +
    `data-untracked="${f.status === '?' ? '1' : '0'}" style="--d:${depth}">` +
    `<span class="f-status s-${esc(f.status)}" title="${esc(STATUS_WORD[f.status] || f.status)}">` +
    `${esc(f.status)}</span>` +
    `<span class="f-path${mode === 'list' ? ' f-split' : ''}" ` +
    `title="${esc(f.path)}">${name}</span>${actions}</li>`
  );
}

/* How the uncommitted lists are drawn. Kept apart from the commit panel's own
   setting: one is a list you act on, the other is a record you read. */
let wipFilter = '';

/** Filtering flattens: a tree of folders whose files are all hidden tells you
    nothing, and hiding the folders too would leave the indentation lying. */
function wipRows(list, kind) {
  const q = wipFilter;
  const shown = q ? list.filter((f) => f.path.toLowerCase().includes(q)) : list;
  if (!shown.length) return { html: '', count: 0 };
  const html = fileView.mode === 'tree' && !q
    ? renderTree(buildTree(shown.map((f) => ({ ...f, name: f.path }))), `wip-${kind}`,
        (f, label, depth) => fileRow({ ...f, label }, kind, depth))
    : shown.map((f) => fileRow(f, kind, 0, flatShape())).join('');
  return { html, count: shown.length };
}

function renderWip() {
  const s = state.status;

  /* Conflicted files are pulled out of the working list into their own group:
     they are not "changes you might commit", they are work that has to happen
     before anything else in this panel means anything. */
  const conflicts = wipRows(s.conflicted, 'conflict');
  $('group-conflicts').hidden = !s.conflicted.length;
  $('count-conflicts').textContent = s.conflicted.length;
  $('list-conflicts').innerHTML = conflicts.html;

  const staged = wipRows(s.staged, 'staged');
  $('list-staged').innerHTML = staged.html ||
    `<li class="empty-row">${wipFilter ? 'No staged file matches' : 'Nothing staged yet'}</li>`;

  const working = [...s.unstaged, ...s.untracked];
  const unstaged = wipRows(working, 'unstaged');
  $('list-unstaged').innerHTML = unstaged.html ||
    `<li class="empty-row">${wipFilter ? 'No changed file matches' : 'Working tree is clean'}</li>`;

  paintViewAs('w-viewas');

  $('count-staged').textContent = s.staged.length;
  $('count-unstaged').textContent = working.length;
  const total = s.staged.length + working.length;
  $('wip-total').textContent = total
    ? `${total} file${total === 1 ? '' : 's'}`
    : '';
  renderCommitBox();

  // A file already open stays open, and follows what just changed on disk.
  if (state.file && state.file.kind !== 'commit') showFileDiff();
}

/* The button says what it will do, and the counter warns before a summary grows
   too long for `git log --oneline` to show it whole. */
function renderCommitBox() {
  const staged = state.status?.staged.length || 0;
  const text = $('commit-msg').value.trim();
  const n = $('commit-msg').value.length;
  const stuck = conflictCount();

  /* git refuses to commit with unmerged paths, so a button that invites it is
     just a trap. While a merge is suspended, finishing it is Continue's job. */
  $('btn-commit').disabled = Boolean(stuck) || !staged || !text;
  $('btn-commit').textContent = stuck
    ? `${stuck} conflict${stuck === 1 ? '' : 's'} left`
    : staged ? `Commit ${staged} file${staged === 1 ? '' : 's'}`
    : 'Commit';
  $('btn-commit').title = stuck
    ? 'Resolve every conflict first — git will not commit a half-merged tree'
    : !staged ? 'Stage something first'
    : !text ? 'A commit needs a summary line'
    : 'Commit the staged files (Ctrl+Enter)';

  const count = $('cb-count');
  count.textContent = n > 40 ? String(n) : '';
  count.className = 'cb-count' + (n > 72 ? ' over' : n > 50 ? ' near' : '');
  count.title = n > 72
    ? 'Longer than 72 characters — most tools will truncate this'
    : 'Summaries read best under 50 characters';
}

/* Bagaimana daftar berkas commit ditampilkan — kebiasaan pembaca, bukan milik repo. */
const fileView = { mode: 'path', byName: false };
try {
  Object.assign(fileView, JSON.parse(localStorage.getItem('gitbraid-fileview') || '{}'));
} catch { /* private mode */ }
const saveFileView = () => {
  try { localStorage.setItem('gitbraid-fileview', JSON.stringify(fileView)); } catch { /* ignore */ }
};

/* How a list of files is laid out. One setting, shared by the working-tree
   panel and the commit panel: the same three shapes mean the same thing in
   both, so keeping two answers only made them disagree. */
const VIEW_MODES = [
  { mode: 'path', label: 'Show as Path List',
    hint: 'One row per file, showing the whole path',
    icon: '<svg viewBox="0 0 14 14"><path d="M2 3.5h10M2 7h10M2 10.5h10" fill="none" '
      + 'stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>' },
  { mode: 'list', label: 'Show as File and Dir List',
    hint: 'The file name reads first, its folder alongside in grey',
    icon: '<svg viewBox="0 0 14 14"><path d="M2 3.5h3.5M7.5 3.5h4.5M2 7h3.5M7.5 7h4.5'
      + 'M2 10.5h3.5M7.5 10.5h4.5" fill="none" stroke="currentColor" stroke-width="1.4" '
      + 'stroke-linecap="round"/></svg>' },
  { mode: 'tree', label: 'Show as Filesystem Tree',
    hint: 'Group the files into the folders they live in',
    icon: '<svg viewBox="0 0 14 14"><path d="M2.5 2.5v8.5h3M2.5 6.5h3" fill="none" '
      + 'stroke="currentColor" stroke-width="1.3" stroke-linecap="round" '
      + 'stroke-linejoin="round"/><path d="M7 2.5h5M7 6.5h5M7 11h5" fill="none" '
      + 'stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>' },
];

const viewMode = () => VIEW_MODES.find((v) => v.mode === fileView.mode) || VIEW_MODES[0];

/* Which of the two flat shapes a row should take. Tree can reach a flat list —
   filtering always flattens — and there it reads as a path, not as a name with
   nothing beside it. */
const flatShape = () => (fileView.mode === 'list' ? 'list' : 'path');

/** Keeps a panel's button showing the shape the lists are actually in. */
function paintViewAs(id) {
  const v = viewMode();
  $(id).innerHTML = v.icon;
  $(id).title = `${v.label} — click to change how files are listed`;
}

function viewAsMenu(button) {
  const box = button.getBoundingClientRect();
  contextMenu(
    // contextMenu opens where the pointer is; a button's menu belongs under the
    // button, so it is handed the corner instead.
    { preventDefault() {}, clientX: box.left, clientY: box.bottom + 4 },
    VIEW_MODES.map((v) => ({
      label: v.label, icon: v.icon, hint: v.hint, checked: fileView.mode === v.mode,
      run: () => {
        fileView.mode = v.mode;
        saveFileView();
        renderCommitFiles();
        if (state.status) renderWip();
      },
    }))
  );
}

const STATUS_LABEL = { M: 'modified', A: 'added', D: 'deleted', R: 'renamed', C: 'copied' };

let commitFiles = [];

function renderCommitFiles() {
  const files = fileView.byName
    ? [...commitFiles].sort((a, b) => a.path.localeCompare(b.path))
    : commitFiles;

  if (!files.length) {
    $('list-commit-files').innerHTML = '<li class="empty-row">No file changes</li>';
    return;
  }

  if (fileView.mode === 'tree') {
    // Reuses the sidebar's tree, so folders behave the same in both places.
    const leaf = (f, label, depth) => fileRow({ ...f, label }, 'commit', depth);
    $('list-commit-files').innerHTML =
      renderTree(buildTree(files.map((f) => ({ ...f, name: f.path }))), 'cfile', leaf);
  } else {
    $('list-commit-files').innerHTML =
      files.map((f) => fileRow(f, 'commit', 0, flatShape())).join('');
  }

  $('c-sort').classList.toggle('on', fileView.byName);
  paintViewAs('c-viewas');
}

async function renderCommitPanel(hash) {
  const c = state.commits.find((x) => x.hash === hash);
  if (!c) return;

  $('c-hash').textContent = c.hash.slice(0, 7);
  $('c-hash').dataset.hash = c.hash;
  $('c-subject').textContent = c.subject;
  $('c-body').textContent = c.body;
  $('c-body').hidden = !c.body;

  $('c-author').textContent = c.author;
  $('c-date').textContent = `authored ${absoluteTime(c.commitDate)}`;
  const av = $('c-avatar');
  av.textContent = initials(c.author);
  av.style.setProperty('--hue', avatarHue(c.email));
  av.classList.remove('unset');

  /* A merge has two parents and they mean different things: the first is the
     branch you were on, the second is the branch that came in. Naming both,
     and letting you jump to either, is the only way the row explains itself. */
  const parents = c.parents || [];
  const isMergeCommit = parents.length > 1;
  $('c-parents').innerHTML = parents.map((h, i) => {
    const role = isMergeCommit ? (i === 0 ? 'onto' : 'from') : 'parent';
    const named = isMergeCommit ? branchAt(h) : '';
    return `<button class="hashbtn c-parent" data-hash="${esc(h)}" ` +
      `title="Go to this parent">` +
      `<span class="cp-role">${role}</span>` +
      (named ? `<span class="cp-name">${esc(named)}</span>` : '') +
      `<span class="cp-sha">${esc(h.slice(0, 7))}</span></button>`;
  }).join('');

  // Leaving reword mode open across commits would edit the wrong message.
  exitReword();

  /* For a merge the three sides answer three different questions, and the
     counts belong on the buttons: a side that turns out to be empty should say
     so before you click it, not after. */
  const side = isMergeCommit ? (state.mergeSide || 'in') : 'in';
  const sides = isMergeCommit
    ? await Promise.all(MERGE_SIDES.map((m) =>
        call('repo:commitFiles', state.repo.path, hash, m.key).then((r) => r || [])))
    : null;
  renderMergeBar(isMergeCommit ? sides : null, side, parents);

  const files = sides
    ? sides[MERGE_SIDES.findIndex((m) => m.key === side)]
    : (await call('repo:commitFiles', state.repo.path, hash)) || [];
  commitFiles = files;
  renderCommitFiles();

  const counts = files.reduce((acc, f) => {
    const key = STATUS_LABEL[f.status] || 'changed';
    acc[key] = (acc[key] || 0) + 1;
    return acc;
  }, {});
  $('c-stats').innerHTML = Object.entries(counts)
    .map(([word, n]) => `<span class="s-${word[0].toUpperCase()}"><b>${n}</b> ${word}</span>`)
    .join('') || `<span>${isMergeCommit && side === 'combined'
      ? 'nothing was resolved by hand' : 'no files'}</span>`;

  if (state.file?.kind === 'commit' && !files.some((f) => f.path === state.file.path)) {
    closeFile();
  } else if (state.file?.kind === 'commit') {
    showFileDiff();
  }
}

/* ── reword in place ── */

function exitReword() {
  $('c-msg-read').hidden = false;
  $('c-msg-edit').hidden = true;
}

async function enterReword() {
  const hash = state.selection?.hash;
  const c = state.commits.find((x) => x.hash === hash);
  if (!c) return;
  $('c-edit-subject').value = c.subject;
  $('c-edit-body').value = c.body || '';
  $('c-msg-read').hidden = true;
  $('c-msg-edit').hidden = false;
  $('c-edit-subject').focus();

  const n = await call('repo:descendantCount', repoPath(), hash);
  $('c-reword-note').textContent = !n
    ? 'This is the newest commit, so only it changes.'
    : `Rewording this will rebase the ${n} commit${n === 1 ? '' : 's'} after it, ` +
      'giving them new hashes.';
}

async function saveReword() {
  const hash = state.selection?.hash;
  const subject = $('c-edit-subject').value.trim();
  if (!subject) { setStatus('A commit needs a summary line', 'error'); return; }
  const body = $('c-edit-body').value.trim();
  const message = body ? `${subject}\n\n${body}` : subject;

  setStatus('Rewording…');
  const res = await call('repo:rewordCommit', repoPath(), { hash, message });
  if (res === null) return;          // reason already in the status bar
  state.selection = { kind: 'commit', hash: res.hash };
  exitReword();
  await refresh();
  setStatus(res.rebased
    ? `Message updated, ${res.rebased} later commit${res.rebased === 1 ? '' : 's'} rebased`
    : 'Message updated', 'ok');
}

$('c-edit').addEventListener('click', enterReword);
$('c-edit-cancel').addEventListener('click', exitReword);
$('c-edit-save').addEventListener('click', saveReword);
$('c-edit-subject').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); saveReword(); }
  if (e.key === 'Escape') exitReword();
});
$('c-edit-body').addEventListener('keydown', (e) => {
  if (e.key === 'Escape') exitReword();
  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) saveReword();
});

$('c-sort').addEventListener('click', () => {
  fileView.byName = !fileView.byName; saveFileView(); renderCommitFiles();
});
$('c-viewas').addEventListener('click', (e) => viewAsMenu(e.currentTarget));
$('w-viewas').addEventListener('click', (e) => viewAsMenu(e.currentTarget));

$('c-parents').addEventListener('click', (e) => {
  const b = e.target.closest('.c-parent');
  if (!b) return;
  const hash = b.dataset.hash;
  // Jumping is what people reach for; copying stays on the right-click menu.
  if (state.commits.some((c) => c.hash === hash)) {
    selectCommit(hash);
    return;
  }
  navigator.clipboard.writeText(hash || '');
  setStatus('Parent SHA copied', 'ok');
});

/* ── merges: which question the file list is answering ─────────── */

/* git will not guess what "changed" means for a commit with two parents, and
   neither should the panel. Each side is a real question with its own answer,
   so all three are offered with their counts already filled in. */
const MERGE_SIDES = [
  { key: 'in', label: 'Brought in',
    why: 'Everything this merge added to the branch — the usual reading of a merge.' },
  { key: 'other', label: 'Other side',
    why: 'What the branch already had that the merged branch did not.' },
  { key: 'combined', label: 'Resolved by hand',
    why: 'Only what differs from both parents: the lines a person decided during the merge. Empty when the merge went through cleanly.' },
];

function renderMergeBar(sides, active, parents) {
  const bar = $('c-mergebar');
  bar.hidden = !sides;
  if (!sides) return;

  const from = parents.length > 1 ? branchAt(parents[1]) : '';
  bar.innerHTML = MERGE_SIDES.map((m, i) => {
    const n = sides[i].length;
    const label = m.key === 'in' && from ? `From ${from}` : m.label;
    return `<button class="mb-side${m.key === active ? ' on' : ''}" data-side="${m.key}" ` +
      `title="${esc(m.why)}">${esc(label)}` +
      `<span class="mb-n${n ? '' : ' zero'}">${n}</span></button>`;
  }).join('');
}

$('c-mergebar').addEventListener('click', async (e) => {
  const b = e.target.closest('.mb-side');
  if (!b || b.dataset.side === (state.mergeSide || 'in')) return;
  state.mergeSide = b.dataset.side;
  await renderDetail();
});

/* ═════ file viewer ═════════════════════════════════════════════ */

/* How the middle pane is showing a file. Kept out of the tab state on purpose:
   these are the reader's habits, not the repository's. */
const viewer = { split: false, ignoreWhitespace: false, wrap: false,
                 allLines: false, syntax: true };
try {
  Object.assign(viewer, JSON.parse(localStorage.getItem('gitbraid-viewer') || '{}'));
} catch { /* private mode */ }

const saveViewer = () => {
  try { localStorage.setItem('gitbraid-viewer', JSON.stringify(viewer)); } catch { /* ignore */ }
};

function syncViewerToggles() {
  $('fv-split').classList.toggle('on', viewer.split);
  $('fv-ws').classList.toggle('on', viewer.ignoreWhitespace);
  $('fv-wrap').classList.toggle('on', viewer.wrap);
  $('fv-all').classList.toggle('on', viewer.allLines);
  $('fv-syntax').classList.toggle('on', viewer.syntax);
  $('fv-body').classList.toggle('wrap', viewer.wrap);
}

/* ── jumping between changed blocks ──
   A "difference" is a run of touched rows: consecutive additions and removals
   count as one, which is what makes 1/5 mean five edits rather than five lines. */
const nav = { blocks: [], marks: [], at: -1 };

function indexBlocks() {
  nav.blocks = [];
  // One entry per block, aligned with nav.blocks: where it ends, and what it
  // did. The map needs the extent and the colour; the counter only needs the
  // count, which is why the two were never separated before.
  nav.marks = [];
  nav.at = -1;
  let mark = null;
  for (const tr of $('fv-body').querySelectorAll('.difftable tr')) {
    const added = tr.classList.contains('dl-add') || Boolean(tr.querySelector('td.dl-add'));
    const removed = tr.classList.contains('dl-del') || Boolean(tr.querySelector('td.dl-del'));
    if (added || removed) {
      if (!mark) {
        mark = { last: tr, add: 0, del: 0 };
        nav.blocks.push(tr);
        nav.marks.push(mark);
      }
      mark.last = tr;
      if (added) mark.add += 1;
      if (removed) mark.del += 1;
    } else {
      mark = null;
    }
  }
  renderNav();
  renderChangeMap();
}

/* The strip beside the scrollbar. It is drawn from the same blocks the counter
   counts, so the seventh mark down is difference seven, and clicking it goes
   there rather than somewhere approximately near it. */
function renderChangeMap() {
  const map = $('fv-marks');
  const body = $('fv-body');
  const total = body.scrollHeight;
  if (!nav.marks.length || total <= 0) { map.innerHTML = ''; paintViewport(); return; }

  /* Rows are measured against the body's own scroll origin rather than
     offsetTop, which answers relative to whichever ancestor happens to be
     positioned — inside a table that is not the one we mean. */
  const origin = body.getBoundingClientRect().top - body.scrollTop;
  map.innerHTML = nav.marks.map((m, i) => {
    const top = nav.blocks[i].getBoundingClientRect().top - origin;
    const bottom = m.last.getBoundingClientRect().bottom - origin;
    const kind = m.add && m.del ? 'both' : m.del ? 'del' : 'add';
    const lines = m.add + m.del;
    return `<button type="button" class="fv-mark m-${kind}" data-block="${i}" ` +
      `style="top:${(top / total * 100).toFixed(3)}%;` +
      `height:${Math.max((bottom - top) / total * 100, 0.25).toFixed(3)}%" ` +
      `title="Difference ${i + 1} of ${nav.marks.length} — ` +
      `${lines} line${lines === 1 ? '' : 's'}"></button>`;
  }).join('');
  paintCurrentMark();
  paintViewport();
}

/* Which slice of the file is on screen. Two style writes, so it can run on
   every scroll frame without competing with the diff for the frame. */
function paintViewport() {
  const body = $('fv-body');
  const view = $('fv-view');
  const total = body.scrollHeight;
  const seen = body.clientHeight;
  // Nothing to point at when the whole file already fits.
  if (!nav.marks.length || total <= seen + 1) { view.hidden = true; return; }
  view.hidden = false;
  view.style.top = `${(body.scrollTop / total * 100).toFixed(3)}%`;
  view.style.height = `${(seen / total * 100).toFixed(3)}%`;
}

function paintCurrentMark() {
  const map = $('fv-marks');
  map.querySelector('.fv-mark.here')?.classList.remove('here');
  if (nav.at >= 0) map.querySelector(`.fv-mark[data-block="${nav.at}"]`)?.classList.add('here');
}

function renderNav() {
  const n = nav.blocks.length;
  $('fv-counter').textContent = n ? `${nav.at + 1}/${n}` : '0/0';
  for (const id of ['fv-first', 'fv-prev', 'fv-next', 'fv-last']) $(id).disabled = n === 0;
}

function gotoBlock(index) {
  const n = nav.blocks.length;
  if (!n) return;
  nav.at = Math.max(0, Math.min(index, n - 1));
  for (const tr of $('fv-body').querySelectorAll('tr.dl-here')) tr.classList.remove('dl-here');
  const row = nav.blocks[nav.at];
  row.classList.add('dl-here');
  row.scrollIntoView({ block: 'center' });
  renderNav();
  paintCurrentMark();
}

let viewQueued = false;
$('fv-body').addEventListener('scroll', () => {
  if (viewQueued) return;
  viewQueued = true;
  requestAnimationFrame(() => { viewQueued = false; paintViewport(); });
}, { passive: true });

$('fv-map').addEventListener('click', (e) => {
  const mark = e.target.closest('.fv-mark');
  if (mark) { gotoBlock(Number(mark.dataset.block)); return; }
  // Bare strip: treat the click as a position in the file, the way a scrollbar
  // trough does, so the map is useful even where nothing changed.
  const body = $('fv-body');
  const box = $('fv-map').getBoundingClientRect();
  const at = (e.clientY - box.top) / box.height;
  body.scrollTop = at * body.scrollHeight - body.clientHeight / 2;
});

/* Every mark is a fraction of a height that changes whenever the pane does —
   dragging the divider, toggling wrap, resizing the window. One redraw per
   frame at most, and only while a file is open. */
let mapQueued = false;
new ResizeObserver(() => {
  if (mapQueued || !nav.marks.length) return;
  mapQueued = true;
  requestAnimationFrame(() => { mapQueued = false; renderChangeMap(); });
}).observe($('fv-body'));

$('fv-first').addEventListener('click', () => gotoBlock(0));
$('fv-prev').addEventListener('click', () => gotoBlock(nav.at <= 0 ? 0 : nav.at - 1));
$('fv-next').addEventListener('click', () => gotoBlock(nav.at + 1));
$('fv-last').addEventListener('click', () => gotoBlock(nav.blocks.length - 1));

const STATUS_WORD = {
  M: 'Modified', A: 'Added', D: 'Deleted', R: 'Renamed',
  C: 'Copied', U: 'Conflicted', '?': 'Untracked',
};

function closeFile() {
  state.file = null;
  state.compareRef = null;
  $('app').classList.remove('viewing-file');
  $('fileview').hidden = true;
  /* Hiding the viewer left everything in place: a diff of an 8,000-line file
     is ~118,000 DOM nodes, and they stayed in the document for the rest of the
     session along with the parsed hunks. Closing a file should cost nothing to
     keep, the way parking a tab already frees its diff. */
  $('fv-body').innerHTML = '';
  $('fv-marks').innerHTML = '';
  $('fv-view').hidden = true;
  state.diffFiles = [];
  nav.blocks = [];
  nav.marks = [];
  nav.at = -1;
  renderDetail();
}

/** Fetch and draw the open file. Called again whenever a toggle flips. */
async function showFileDiff() {
  const f = state.file;
  if (!f) return closeFile();

  const raw = f.kind === 'conflict'
    ? await call('repo:conflictFile', repoPath(), f.path)
    : f.kind === 'commit'
    ? await call('repo:diffCommitFile', repoPath(), {
        hash: state.selection?.hash, file: f.path,
        ignoreWhitespace: viewer.ignoreWhitespace,
        context: viewer.allLines ? 100000 : 3,
        side: state.mergeSide || 'in',
      })
    : await call('repo:diffFile', repoPath(), {
        file: f.path, staged: f.kind === 'staged', untracked: f.untracked,
        ignoreWhitespace: viewer.ignoreWhitespace,
        context: viewer.allLines ? 100000 : 3,
      });
  if (raw === null) return;

  state.diffFiles = window.Diff.parse(raw || '');
  state.diffContext = f.kind;

  $('app').classList.add('viewing-file');
  $('fileview').hidden = false;
  /* A conflicted file is shown whole, which git can only express as "every line
     added". Colouring it all green would claim something untrue, so that view
     drops the +/− language and reads as the file it is. */
  $('fv-body').classList.toggle('as-file', f.kind === 'conflict');

  const status = f.status || (f.untracked ? '?' : 'M');
  $('fv-status').textContent = status;
  $('fv-status').className = `fv-status s-${status}`;
  $('fv-path').textContent = f.path;
  $('fv-path').title = `${STATUS_WORD[status] || status} — ${f.path}`;

  const totals = state.diffFiles.reduce(
    (acc, d) => ({ add: acc.add + d.additions, del: acc.del + d.deletions }),
    { add: 0, del: 0 }
  );
  // "+7 −0" would count the whole file as new, which it is not.
  $('fv-stat').innerHTML = f.kind === 'conflict'
    ? '<span class="stat-conflict">both versions below</span>'
    : `<span class="stat-add">+${totals.add}</span> <span class="stat-del">−${totals.del}</span>`;

  // Hunk buttons only make sense on the working tree, never on a past commit.
  /* No hunk buttons on a conflicted file: staging half of it is not how a
     conflict is settled, and offering it invites a mess. The three resolution
     buttons in the panel are the way through. */
  const actions = f.kind === 'commit' || f.kind === 'conflict' || f.untracked
    ? []
    : f.kind === 'staged'
      ? [{ action: 'unstage', label: 'Unstage hunk' }]
      : [{ action: 'stage', label: 'Stage hunk' }, { action: 'discard', label: 'Discard hunk' }];

  $('fv-stage-tools').hidden = f.kind === 'commit' || f.kind === 'conflict';
  $('fv-stage').hidden = f.kind === 'staged';
  $('fv-unstage').hidden = f.kind !== 'staged';
  $('fv-discard').hidden = f.kind === 'staged';

  syncViewerToggles();
  const paintOpts = { path: f.path, highlight: viewer.syntax };
  $('fv-body').innerHTML = viewer.split
    ? window.Diff.renderSplit(state.diffFiles, actions, paintOpts)
    : window.Diff.render(state.diffFiles, actions, paintOpts);
  indexBlocks();
  $('fv-syntax').disabled = !window.Hl.langOf(f.path);
  $('fv-syntax').title = window.Hl.langOf(f.path)
    ? 'Colour the code by syntax'
    : 'No colouring rules for this file type';
}

/* toggles */
for (const [id, key] of [['fv-split', 'split'], ['fv-ws', 'ignoreWhitespace'],
                         ['fv-wrap', 'wrap'], ['fv-all', 'allLines'], ['fv-syntax', 'syntax']]) {
  $(id).addEventListener('click', () => {
    viewer[key] = !viewer[key];
    saveViewer();
    renderViewer();
  });
}

$('fv-close').addEventListener('click', closeFile);

/** Open a file for editing, saying which editor took it. */
async function openInEditor(relPath) {
  const where = await call('shell:openInEditor', repoPath(), `${repoPath()}/${relPath}`);
  if (where !== null) setStatus(`Opened ${relPath} in ${where}`, 'ok');
}

$('fv-copy').addEventListener('click', () => {
  if (!state.file) return;
  navigator.clipboard.writeText(state.file.path);
  setStatus('File path copied', 'ok');
});

$('fv-open').addEventListener('click', () => state.file && openInEditor(state.file.path));

$('fv-stage').addEventListener('click', () => state.file && stage([state.file.path]));
$('fv-unstage').addEventListener('click', () => state.file && unstage([state.file.path]));
$('fv-discard').addEventListener('click', () =>
  state.file && discard(state.file.path, state.file.untracked));

/* ═════ actions ═════════════════════════════════════════════════ */

const repoPath = () => state.repo.path;

async function stage(paths) {
  await call('repo:stage', repoPath(), paths);
  await refresh();
}
async function unstage(paths) {
  await call('repo:unstage', repoPath(), paths);
  await refresh();
}
async function discard(path, untracked) {
  const ok = await confirmAction(
    'Discard changes',
    `Changes to ${path} will be lost and cannot be recovered.`,
    'Discard'
  );
  if (!ok) return;
  await call('repo:discard', repoPath(), [path], untracked);
  state.file = null;
  await refresh();
}

async function applyHunk(fileIndex, hunkIndex, action) {
  const file = state.diffFiles[fileIndex];
  const hunk = file?.hunks[hunkIndex];
  if (!hunk) return;
  if (action === 'discard') {
    const ok = await confirmAction('Discard hunk', 'These lines will be removed from your working tree.', 'Discard');
    if (!ok) return;
  }
  const patch = window.Diff.hunkPatch(file, hunk);
  const res = await call('repo:applyPatch', repoPath(), patch, action);
  if (res === null) return;
  await refresh();
  await showFileDiff();
  setStatus(`Hunk ${action === 'stage' ? 'staged' : action === 'unstage' ? 'unstaged' : 'discarded'}`, 'ok');
}

async function doCommit() {
  const subject = $('commit-msg').value.trim();
  if (!subject) return;
  const body = $('commit-body').value.trim();
  const message = body ? `${subject}\n\n${body}` : subject;
  const amend = $('chk-amend').checked;
  const res = await call('repo:commit', repoPath(), { message, amend });
  if (res === null) return;
  $('commit-msg').value = '';
  $('commit-body').value = '';
  $('chk-amend').checked = false;
  state.file = null;
  state.selection = null;
  await refresh({ keepSelection: false });
  setStatus(amend ? 'Amended the last commit' : 'Committed', 'ok');
}

/* Untracked files survive any checkout untouched, so counting them here would
   turn the warning into noise on repositories that always carry build output. */
function trackedChanges() {
  const s = state.status;
  return s ? s.staged.length + s.unstaged.length + s.conflicted.length : 0;
}

/* Returns the chosen mode, or null if the switch was called off. */
async function askAboutLocalChanges(ref) {
  const n = trackedChanges();
  if (!n) return 'keep';
  const here = state.status.branch || 'the current branch';
  const r = await modal({
    title: `Switch to ${ref}?`,
    description:
      `${n} uncommitted change${n === 1 ? '' : 's'} on ${here} ` +
      `${n === 1 ? 'is' : 'are'} still in the working tree.`,
    fields: [{
      name: 'mode', type: 'choice', value: 'stash',
      options: [
        { value: 'stash', label: 'Stash and reapply',
          help: `Sets the work aside, switches, and puts it back on ${ref}. `
            + 'If it no longer applies you get conflicts to resolve, and the stash is kept.' },
        { value: 'keep', label: 'Bring the changes along',
          help: 'Carries the work across untouched. Git refuses the switch outright '
            + 'if a file on the other branch would be overwritten.' },
        { value: 'discard', label: 'Discard the changes',
          help: 'Throws away every change to tracked files. Files git does not '
            + 'track are left alone.' },
      ],
    }],
    confirmLabel: 'Switch branch',
    onChange: (v, api) => api.note(v.mode === 'discard'
      ? 'Discarded changes cannot be recovered — they were never committed.' : ''),
  });
  return r ? r.mode : null;
}

async function checkout(ref) {
  const mode = await askAboutLocalChanges(ref);
  if (mode === null) return;

  // gitAction hands nothing to its follow-up, so the outcome rides a closure.
  let res = null;
  await gitAction(null, `Checking out ${ref}`,
    async () => (res = await call('repo:checkoutWith', repoPath(), ref, mode)),
    async () => {
      await refresh({ keepSelection: false });
      if (res?.stash === 'conflict') {
        setStatus(`Checked out ${ref} — the stashed work conflicts; resolve it, `
          + 'then drop the stash', 'error');
      } else if (res?.stash === 'reapplied') {
        setStatus(`Checked out ${ref} — your changes came with it`, 'ok');
      } else {
        setStatus(`Checked out ${ref}`, 'ok');
      }
    });
}

/* One click on a ref moves the history to its tip instead of checking it out.
   Every tip is in an --all log, but only once enough of it is loaded, so this
   widens the window rather than giving up. */
async function revealRef(ref, kind) {
  const list = kind === 'tag' ? state.refs.tags
    : kind === 'remote' ? state.refs.remotes
      : state.refs.branches;
  const oid = list.find((r) => r.name === ref)?.oid;
  if (!oid) return;

  const loaded = () => state.commits.some((c) => c.hash === oid);
  // 50 pages is far past any history a person scrolls; it only stops a runaway.
  for (let page = 0; !loaded() && page < 50; page += 1) {
    if (state.commits.length < state.limit) {   // the whole history is here already
      setStatus(`${ref} is not in this view`, 'error');
      return;
    }
    state.limit += prefs.commitLimit;
    setStatus(`Looking for ${ref} — ${state.limit} commits loaded…`);
    await refresh();
  }
  if (!loaded()) {
    setStatus(`${ref} is further back than GitBraid will load`, 'error');
    return;
  }
  await selectCommit(oid);
  setStatus(`${ref} is at ${oid.slice(0, 7)}`, 'ok');
}

async function newBranch(startPoint) {
  const r = await modal({
    title: 'New branch',
    // A start point is either a commit hash, which is shortened, or a ref name,
    // which must be shown whole.
    description: startPoint
      ? `Starting from ${/^[0-9a-f]{7,40}$/.test(startPoint) ? startPoint.slice(0, 7) : startPoint}`
      : 'Starting from the current HEAD',
    fields: [
      { name: 'name', label: 'Branch name', placeholder: 'feature/rename-lanes' },
      { name: 'checkout', type: 'checkbox', label: 'Check out after creating', value: true },
    ],
    confirmLabel: 'Create branch',
  });
  if (!r || !r.name) return;
  await gitAction('btn-branch', 'Creating',
    () => call('repo:createBranch', repoPath(), r.name, startPoint, r.checkout),
    async () => { await refresh({ keepSelection: false }); setStatus(`Created ${r.name}`, 'ok'); });
}

/* Shared by the sidebar's context menu and the Repository menu. */

/* Merging the wrong way round is the mistake that actually happens, and no
   button label shows which way it goes. So the confirmation is not "are you
   sure" — it is the direction, the size, and the shape of the result. */
async function askAboutMerge(ref, info) {
  const n = info.incoming;
  const dirty = trackedChanges();
  const r = await modal({
    title: `Merge ${ref} into ${info.head}?`,
    description:
      `${n} commit${n === 1 ? '' : 's'} from ${ref} ${n === 1 ? 'is' : 'are'} not in ` +
      `${info.head} yet. ` +
      (info.fastForward
        ? `${info.head} has nothing of its own, so it can simply move forward.`
        : `${info.head} has ${info.outgoing} commit${info.outgoing === 1 ? '' : 's'} ` +
          'of its own, so the two lines have to be joined.'),
    fields: [{
      name: 'mode', type: 'choice', value: 'ff',
      options: [
        { value: 'ff', label: 'Fast-forward when possible',
          help: info.fastForward
            ? `Moves ${info.head} straight to ${ref}. No merge commit, and the ` +
              'history stays a straight line.'
            : 'A fast-forward is not possible here, so this makes a merge commit.' },
        { value: 'no-ff', label: 'Always create a merge commit',
          help: 'Records the merge as a commit of its own even when it could have '
            + 'moved forward, so the branch stays visible in the graph.' },
        { value: 'squash', label: 'Squash into one change',
          help: `Brings the work in without any of ${ref}'s commits and leaves it `
            + 'staged, for you to commit in one piece.' },
      ],
    }],
    confirmLabel: 'Merge',
    onChange: (v, api) => api.note(dirty
      ? `${dirty} uncommitted change${dirty === 1 ? '' : 's'} in the working tree. `
        + 'Git refuses the merge if it needs one of those files.'
      : ''),
  });
  return r ? r.mode : null;
}

async function mergeBranch(ref) {
  const info = await call('repo:mergeInfo', repoPath(), ref);
  if (info === null) return;
  /* git succeeds and changes nothing when the branch is already contained.
     Saying "Merged" there would claim something that did not happen — and
     asking about it first would be a dialog with nothing to decide. */
  if (!info.incoming) {
    setStatus(`${ref} is already in ${info.head} — nothing to merge`);
    return;
  }

  const mode = await askAboutMerge(ref, info);
  if (mode === null) return;

  let out = '';
  const ok = await gitAction(null, `Merging ${ref}`,
    async () => (out = await call('repo:merge', repoPath(), ref, mode)),
    async () => {
      await refresh({ keepSelection: false });
      setStatus(nothingHappened(out)
        ? `${ref} is already in ${info.head} — nothing to merge`
        : mode === 'squash'
          ? `Squashed ${ref} into the staged changes — write a message and commit`
          : `Merged ${ref} into ${info.head}`,
      nothingHappened(out) ? '' : 'ok');
    });
  // A conflict stops the merge half-done; the history has to show that state.
  if (!ok) await refresh({ keepSelection: false });
}

/** git's way of saying it did nothing, on merge, pull and rebase alike. */
const nothingHappened = (out) =>
  /already up to date|is up to date|current branch .* is up to date/i.test(String(out || ''));

async function rebaseOnto(ref) {
  let out = '';
  const ok = await gitAction(null, `Rebasing onto ${ref}`,
    async () => (out = await call('repo:rebase', repoPath(), ref)),
    async () => {
      await refresh({ keepSelection: false });
      setStatus(nothingHappened(out)
        ? `Already on top of ${ref} — nothing to rebase`
        : `Rebased onto ${ref}`, nothingHappened(out) ? '' : 'ok');
    });
  if (!ok) await refresh({ keepSelection: false });
}

async function applyStash(ref, drop) {
  // Pop reports on the Pop button, plain apply on Stash — whichever the reader
  // is most likely to be looking at.
  await gitAction(drop ? 'btn-pop' : 'btn-stash', drop ? 'Popping' : 'Applying',
    () => call('repo:stashApply', repoPath(), ref, drop),
    async () => {
      await refresh({ keepSelection: false });
      setStatus(drop ? 'Popped stash' : 'Applied stash', 'ok');
    });
}

async function push(force = false) {
  const s = state.status;
  if (!s?.branch) {
    setStatus('You are on a detached HEAD. Check out a branch before pushing.', 'error');
    return;
  }
  await gitAction('btn-push', force ? 'Force pushing' : 'Pushing',
    () => call('repo:push', repoPath(), {
      branch: s.branch,
      setUpstream: !s.upstream,
      force,
    }),
    async () => { await refresh(); setStatus(`Pushed ${s.branch}`, 'ok'); });
}

/* ═════ wiring ══════════════════════════════════════════════════ */

/* ═════ start screen ════════════════════════════════════════════ */

let appPaths = { home: '', documents: '' };
let recents = [];

/* Paths git reports *inside* a repository always use forward slashes, on every
   platform. Paths to the repository itself do not: Windows hands back
   C:\\Users\\me\\code\\app. These three only ever see the second kind, so they
   have to accept either separator. */
const lastSep = (p) => Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'));

/** "/home/me/code/app" → "/home/me/code". Tab repos carry no parent field. */
const parentOf = (p) => p.slice(0, Math.max(lastSep(p), 0)) || '/';

/** "/home/me/code/app" → "app", the name a restored tab shows. */
const baseName = (p) => p.slice(lastSep(p) + 1) || p;

/** `/home/me/code/app` reads better as `~/code/app`. */
const shortenHome = (p) =>
  appPaths.home && p.startsWith(appPaths.home) ? '~' + p.slice(appPaths.home.length) : p;


/** The folder `git clone <url>` would create by itself. */
const repoNameFromUrl = (url) =>
  String(url || '')
    .trim()
    .replace(/\/+$/, '')
    .replace(/\.git$/i, '')
    .split(/[/:]/)
    .pop() || '';

/** Where the last clone went — the next one almost always goes beside it. */
function lastCloneDir() {
  try { return localStorage.getItem('gitbraid-clone-dir') || ''; } catch { return ''; }
}
function rememberCloneDir(dir) {
  try { localStorage.setItem('gitbraid-clone-dir', dir); } catch { /* private mode */ }
}

function renderRecents() {
  $('btn-recents-clear').hidden = !recents.length;
  $('recent-list').innerHTML = recents.length
    ? recents
        .map(
          (r) =>
            `<li class="recent" data-path="${esc(r.path)}" title="${esc(r.path)}">` +
            `<span class="rc-text"><span class="rc-name">${esc(r.name)}</span>` +
            `<span class="rc-path">${esc(shortenHome(r.parent))}</span></span>` +
            `<span class="rc-time">${r.openedAt ? esc(relativeTime(r.openedAt)) : ''}</span>` +
            `<button class="rc-remove" data-remove="${esc(r.path)}" ` +
            `title="Remove from this list">×</button></li>`
        )
        .join('')
    : '<li class="empty-row">Nothing here yet — open, clone, or create a repository.</li>';
}

async function loadRecents() {
  recents = (await call('app:recents')) || [];
  renderRecents();
}

async function cloneRepo() {
  const start = lastCloneDir() || appPaths.documents || appPaths.home;
  const r = await modal({
    title: 'Clone a repository',
    description: 'GitBraid downloads the repository with git clone, then opens it.',
    fields: [
      {
        name: 'url',
        label: 'Repository URL',
        placeholder: 'https://github.com/owner/repo.git',
        required: true,
      },
      { name: 'parent', label: 'Clone into', type: 'directory', value: start, required: true },
      { name: 'name', label: 'Folder name', placeholder: 'repo', required: true },
    ],
    confirmLabel: 'Clone',
    onChange(v, api) {
      // Fill the folder name from the URL, but never fight a typed one.
      if (v.url && !v.name) api.set('name', repoNameFromUrl(v.url));
      const name = v.name || repoNameFromUrl(v.url);
      api.note(
        v.parent && name
          ? `Creates ${shortenHome(v.parent)}/${name}`
          : 'Paste an https:// or git@ URL, then pick where it should live.'
      );
    },
  });
  if (!r) return;

  const name = r.name || repoNameFromUrl(r.url);
  rememberCloneDir(r.parent);
  setStatus(`Cloning ${r.url}…`);
  showProgress(0);
  const repo = await call('repo:clone', r.url, r.parent, name);
  hideProgress();
  if (!repo) return;
  await openRepoAt(repo.path);
  setStatus(`Cloned into ${repo.path}`, 'ok');
}

async function initRepo() {
  const start = lastCloneDir() || appPaths.documents || appPaths.home;
  const r = await modal({
    title: 'Create a new repository',
    description: 'Runs git init on the folder, so the first commit is up to you.',
    fields: [
      { name: 'parent', label: 'Location', type: 'directory', value: start, required: true },
      { name: 'name', label: 'Repository name', placeholder: 'my-project', required: true },
    ],
    confirmLabel: 'Create repository',
    onChange(v, api) {
      if (v.parent && v.name) api.note(`Creates ${shortenHome(v.parent)}/${v.name}`);
      else api.note('Pick a folder and name the repository.');
    },
  });
  if (!r) return;

  rememberCloneDir(r.parent);
  const repo = await call('repo:init', r.parent, r.name);
  if (!repo) return;
  await openRepoAt(repo.path);
  setStatus(`Created a repository in ${repo.path}`, 'ok');
}

applyTheme(storedTheme());
$('btn-theme').addEventListener('click', () =>
  applyTheme(document.documentElement.dataset.theme === 'light' ? 'dark' : 'light')
);

$('card-open').addEventListener('click', () => openRepoAt(null));
$('card-clone').addEventListener('click', cloneRepo);
$('card-init').addEventListener('click', initRepo);

$('recent-list').addEventListener('click', async (e) => {
  const remove = e.target.closest('[data-remove]');
  if (remove) {
    e.stopPropagation();
    recents = (await call('app:removeRecent', remove.dataset.remove)) || [];
    renderRecents();
    return;
  }
  const li = e.target.closest('li[data-path]');
  if (li) openRepoAt(li.dataset.path);
});

$('btn-recents-clear').addEventListener('click', async () => {
  recents = (await call('app:clearRecents')) || [];
  renderRecents();
});

/* ═════ tab bar ═════════════════════════════════════════════════ */

/* A drawn cross rather than the "×" character: its weight and size are ours to
   set, instead of whatever the UI font happens to give that glyph. */
const CLOSE_ICON =
  '<svg class="x-i" viewBox="0 0 12 12" aria-hidden="true">' +
  '<path d="M3 3 9 9M9 3 3 9" fill="none" stroke="currentColor" ' +
  'stroke-width="1.8" stroke-linecap="round"/></svg>';

$('tabs').addEventListener('click', (e) => {
  const close = e.target.closest('[data-close]');
  if (close) { e.stopPropagation(); closeTab(close.dataset.close); return; }
  const tab = e.target.closest('[data-tab]');
  if (tab && tab.dataset.tab !== activeId) activateTab(tab.dataset.tab);
});

/* Middle-click closes, the way every tabbed app does it. */
$('tabs').addEventListener('auxclick', (e) => {
  if (e.button !== 1) return;
  const tab = e.target.closest('[data-tab]');
  if (tab) { e.preventDefault(); closeTab(tab.dataset.tab); }
});

$('tabs').addEventListener('contextmenu', (e) => {
  const tab = e.target.closest('[data-tab]');
  if (!tab) return;
  const id = tab.dataset.tab;
  const t = tabs.find((x) => x.id === id);
  contextMenu(e, [
    { label: 'Close tab', run: () => closeTab(id) },
    { label: 'Close other tabs', run: () => tabs.filter((x) => x.id !== id).forEach((x) => closeTab(x.id)) },
    ...(t.repo
      ? [
          '-',
          { label: 'Copy repository path', run: () => navigator.clipboard.writeText(t.repo.path) },
          { label: 'Show in file manager', run: () => call('shell:openPath', t.repo.path) },
        ]
      : []),
  ]);
});

$('btn-newtab').addEventListener('click', newEmptyTab);

/* ── search tabs ── */

function renderTabMenu(query = '') {
  const q = query.trim().toLowerCase();
  const label = (t) => (t.repo ? t.repo.name : 'New Tab');
  const hits = tabs.filter(
    (t) => !q || label(t).toLowerCase().includes(q) || (t.repo?.path || '').toLowerCase().includes(q)
  );
  $('tabmenu-list').innerHTML = hits.length
    ? hits
        .map(
          (t) =>
            `<li data-tab="${t.id}"${t.id === activeId ? ' class="active"' : ''}>` +
            (t.repo ? SIDE_ICON.branch : SIDE_ICON.folder) +
            `<span class="tm-name">${highlight(label(t), q)}</span>` +
            `<span class="tm-path">${t.repo ? esc(shortenHome(parentOf(t.repo.path))) : 'no repository yet'}</span>` +
            `<button class="tm-close" data-close="${t.id}" title="Close tab">${CLOSE_ICON}</button></li>`
        )
        .join('')
    : '<li class="empty-row">No open tab matches that</li>';
}

function openTabMenu() {
  if (!tabs.length) return;
  const btn = $('btn-tabsearch').getBoundingClientRect();
  const menu = $('tabmenu');
  menu.hidden = false;
  menu.style.top = `${btn.bottom + 4}px`;
  menu.style.right = `${window.innerWidth - btn.right}px`;
  $('tabmenu-input').value = '';
  renderTabMenu('');
  $('tabmenu-input').focus();

  const dismiss = (e) => {
    if (menu.contains(e.target) || e.target.closest('#btn-tabsearch')) return;
    closeTabMenu();
  };
  setTimeout(() => document.addEventListener('mousedown', dismiss, true), 0);
  menu._dismiss = dismiss;
}

function closeTabMenu() {
  $('tabmenu').hidden = true;
  if ($('tabmenu')._dismiss) {
    document.removeEventListener('mousedown', $('tabmenu')._dismiss, true);
    $('tabmenu')._dismiss = null;
  }
}

$('btn-tabsearch').addEventListener('click', () =>
  ($('tabmenu').hidden ? openTabMenu() : closeTabMenu())
);
$('tabmenu-input').addEventListener('input', (e) => renderTabMenu(e.target.value));
$('tabmenu-input').addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeTabMenu();
  if (e.key === 'Enter') {
    const first = el('#tabmenu-list li[data-tab]');
    if (first) { closeTabMenu(); activateTab(first.dataset.tab); }
  }
});
$('tabmenu-list').addEventListener('click', (e) => {
  const close = e.target.closest('[data-close]');
  if (close) {
    e.stopPropagation();
    closeTab(close.dataset.close).then(() => renderTabMenu($('tabmenu-input').value));
    return;
  }
  const li = e.target.closest('li[data-tab]');
  if (li) { closeTabMenu(); activateTab(li.dataset.tab); }
});

/* ── settings ──
   Tombolnya sengaja belum dipasangi apa pun. Semua yang nantinya masuk ke
   sini — tema, zoom, panel, pintasan — untuk sekarang masih dijangkau lewat
   menu bar dan tombol tema di toolbar. */

/* ═════ git flow ════════════════════════════════════════════════ */

/** Which flow branch, if any, is checked out right now. */
function currentFlow() {
  const branch = state.status?.branch;
  const cfg = state.flow;
  if (!branch || !cfg?.initialized) return null;
  for (const kind of ['feature', 'release', 'hotfix']) {
    const prefix = cfg[kind];
    if (prefix && branch.startsWith(prefix)) {
      return { kind, branch, name: branch.slice(prefix.length) };
    }
  }
  return null;
}

async function initFlow() {
  const names = state.refs.branches.map((b) => b.name);
  const cfg = state.flow || {};
  const r = await modal({
    title: 'Initialize Git-Flow',
    description: 'Stored in this repository’s config, the same keys the git-flow ' +
      'command line uses. The development branch is created if it does not exist yet.',
    fields: [
      { name: 'master', label: 'Production branch', required: true,
        value: cfg.master && names.includes(cfg.master) ? cfg.master
             : names.includes('main') ? 'main' : names.includes('master') ? 'master' : (names[0] || 'master') },
      { name: 'develop', label: 'Development branch', value: cfg.develop || 'develop', required: true },
      { name: 'feature', label: 'Feature prefix', value: cfg.feature || 'feature/', required: true },
      { name: 'release', label: 'Release prefix', value: cfg.release || 'release/', required: true },
      { name: 'hotfix', label: 'Hotfix prefix', value: cfg.hotfix || 'hotfix/', required: true },
      { name: 'versiontag', label: 'Version tag prefix', value: cfg.versiontag || '',
        placeholder: 'optional, e.g. v' },
    ],
    confirmLabel: 'Initialize',
  });
  if (!r) return;
  const res = await call('flow:init', repoPath(), r);
  if (res === null) return;
  await refresh({ keepSelection: false });
  setStatus(`Git-Flow ready: ${r.master} / ${r.develop}`, 'ok');
}

async function startFlow(kind) {
  const cfg = state.flow;
  const r = await modal({
    title: `Start a ${kind}`,
    description: `Branches off ${kind === 'hotfix' ? cfg.master : cfg.develop}, ` +
      `named ${cfg[kind]}…`,
    fields: [{
      name: 'name', label: 'Name', required: true,
      placeholder: kind === 'feature' ? 'kiosk-member' : '1.4.0',
    }],
    confirmLabel: `Start ${kind}`,
  });
  if (!r) return;
  let branch = null;
  await gitAction('btn-flow', `Starting ${kind}`,
    async () => (branch = await call('flow:start', repoPath(), { kind, name: r.name, cfg })),
    async () => { await refresh({ keepSelection: false }); setStatus(`Started ${branch}`, 'ok'); });
}

async function finishFlow(flow) {
  const cfg = state.flow;
  const tagged = flow.kind !== 'feature';
  const b = state.refs.branches.find((x) => x.name === flow.branch);
  const remote = b?.upstream
    ? b.upstream.slice(0, b.upstream.indexOf('/'))
    : (state.refs.remotes[0]?.name.split('/')[0] || 'origin');
  const hasRemote = state.refs.remotes.length > 0;
  // Only worth offering when the branch was actually published; a feature that
  // never left this machine has nothing on the server to tidy up.
  const published = state.remoteRefNames.has(`${remote}/${flow.branch}`);
  const landing = tagged ? `${cfg.master} and ${cfg.develop}` : cfg.develop;

  const fields = tagged
    ? [
        { name: 'tag', label: 'Tag', value: `${cfg.versiontag || ''}${flow.name}`,
          placeholder: 'leave empty to skip tagging' },
        { name: 'message', label: 'Tag message', placeholder: flow.name },
      ]
    : [];
  if (hasRemote) {
    fields.push({
      name: 'push', type: 'checkbox', value: true,
      label: `Push ${landing}${tagged ? ' and the tag' : ''} to ${remote}`,
    });
    if (published) {
      fields.push({
        name: 'deleteRemote', type: 'checkbox', value: true,
        label: `Delete ${remote}/${flow.branch}`,
      });
    }
  }

  const r = await modal({
    title: `Finish ${flow.branch}`,
    description: (tagged
      ? `Merges into ${cfg.master}, tags it, merges into ${cfg.develop}, `
      : `Merges into ${cfg.develop}, `) +
      'then deletes the branch here.' +
      (published ? ` It is also on ${remote}.` : ''),
    fields,
    confirmLabel: 'Finish',
    /* Deleting the published branch without pushing the merge would take those
       commits off the server altogether — they would exist only on this
       machine. Allowed, because it is sometimes what you mean, but said out loud. */
    onChange: (v, api) => api.note(
      v.deleteRemote && !v.push
        ? `Without pushing ${cfg.develop}, deleting ${remote}/${flow.branch} leaves `
          + `that work nowhere on ${remote}.`
        : ''),
  });
  if (!r) return;
  let summary = null;
  const ok = await gitAction('btn-flow', `Finishing ${flow.kind}`,
    async () => (summary = await call('flow:finish', repoPath(), {
      kind: flow.kind, branch: flow.branch, cfg, tag: r.tag, message: r.message,
      remote, push: r.push === true, deleteRemote: r.deleteRemote === true,
    })),
    async () => { await refresh({ keepSelection: false }); setStatus(`${flow.branch}: ${summary}`, 'ok'); });
  // A conflict leaves the merge open on purpose — the history must show that.
  if (!ok) await refresh({ keepSelection: false });
}

$('btn-flow').addEventListener('click', () => {
  if (!state.repo || !$('modal').hidden) return;
  const cfg = state.flow;
  if (!cfg?.initialized) { initFlow(); return; }

  const flow = currentFlow();
  const items = [
    { label: 'Start a feature…', run: () => startFlow('feature') },
    { label: 'Start a release…', run: () => startFlow('release') },
    { label: 'Start a hotfix…', run: () => startFlow('hotfix') },
  ];
  if (flow) {
    items.push('-', { label: `Finish ${flow.branch}…`, run: () => finishFlow(flow) });
  }
  items.push('-', { label: 'Git-Flow settings…', run: initFlow });

  const r = $('btn-flow').getBoundingClientRect();
  contextMenu({ preventDefault() {}, clientX: r.left, clientY: r.bottom + 4 }, items);
});

/* ── git identity ── */

let identity = { globalName: '', globalEmail: '', localName: '', localEmail: '' };

/** What this repository would actually stamp on a commit. */
const activeIdentity = () => ({
  name: identity.localName || identity.globalName,
  email: identity.localEmail || identity.globalEmail,
  local: Boolean(identity.localName || identity.localEmail),
});

const initials = (name) =>
  (name || '')
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0].toUpperCase())
    .join('') || '?';

/** Same address, same colour, every time. */
function avatarHue(email) {
  let h = 0;
  for (const ch of String(email || '')) h = (h * 31 + ch.charCodeAt(0)) % 360;
  return h;
}

async function loadIdentity() {
  identity = (await call('git:identity', state.repo?.path || null)) || identity;
  renderIdentity();
}

function renderIdentity() {
  const who = activeIdentity();
  const av = $('profile-avatar');
  av.textContent = initials(who.name);
  av.style.setProperty('--hue', avatarHue(who.email));
  av.classList.toggle('unset', !who.name);
  $('profile-name').textContent = who.name || 'Set identity';
  $('btn-profile').title = who.name
    ? `${who.name} <${who.email || 'no email'}>` +
      (who.local ? ' — set for this repository only' : ' — global')
    : 'No Git identity set yet';
}

$('btn-profile').addEventListener('click', async () => {
  if (!$('modal').hidden) return;
  const who = activeIdentity();
  const hasRepo = Boolean(state.repo);
  const r = await modal({
    title: 'Git identity',
    description: hasRepo
      ? 'The name and email stamped on the commits you make.'
      : 'The name and email stamped on your commits. Open a repository to set one just for it.',
    fields: [
      { name: 'name', label: 'Name', value: who.name, placeholder: 'Heri Anggara', required: true },
      { name: 'email', label: 'Email', value: who.email, placeholder: 'you@example.com', required: true },
      ...(hasRepo
        ? [{ name: 'local', type: 'checkbox', value: who.local,
             label: `Use only in ${state.repo.name}, not everywhere` }]
        : []),
    ],
    confirmLabel: 'Save',
  });
  if (!r) return;
  const res = await call('git:setIdentity', state.repo?.path || null, {
    name: r.name, email: r.email, local: Boolean(r.local),
  });
  if (res === null) return;
  await loadIdentity();
  setStatus(`Identity saved as ${r.name} <${r.email}>`, 'ok');
});

/* ═════ find bar ════════════════════════════════════════════════ */

$('find-input').addEventListener('input', (e) => runFind(e.target.value));
$('find-input').addEventListener('keydown', (e) => {
  if (e.key === 'Escape') { e.preventDefault(); closeFind(); }
  else if (e.key === 'Enter') { e.preventDefault(); gotoMatch(state.find.index + (e.shiftKey ? -1 : 1)); }
});
$('find-prev').addEventListener('click', () => gotoMatch(state.find.index - 1));
$('find-next').addEventListener('click', () => gotoMatch(state.find.index + 1));
$('find-close').addEventListener('click', closeFind);

/* ═════ repo management ═════════════════════════════════════════ */

const STAR = (on) =>
  `<svg class="tb-i" viewBox="0 0 14 14" aria-hidden="true">` +
  `<path d="M7 1.8l1.6 3.3 3.6.5-2.6 2.5.6 3.6L7 10l-3.2 1.7.6-3.6L1.8 5.6l3.6-.5z" ` +
  `fill="${on ? 'currentColor' : 'none'}" stroke="currentColor" stroke-width="1.2" ` +
  `stroke-linejoin="round"/></svg>`;

const rm = {
  repos: [],
  recents: [],
  query: '',
  wip: false,
  wipData: {},
  shut: new Set(),
};
try {
  const saved = JSON.parse(localStorage.getItem('gitbraid-repomgr') || '{}');
  rm.wip = Boolean(saved.wip);
  rm.shut = new Set(saved.shut || []);
} catch { /* private mode */ }

const saveRm = () => {
  try {
    localStorage.setItem('gitbraid-repomgr', JSON.stringify({ wip: rm.wip, shut: [...rm.shut] }));
  } catch { /* ignore */ }
};

async function openRepoManager() {
  $('app').classList.add('managing');
  $('repomgr').hidden = false;
  $('rm-wip').checked = rm.wip;
  await loadRepoManager();
  $('rm-search').focus();
}

function closeRepoManager() {
  $('app').classList.remove('managing');
  $('repomgr').hidden = true;
}

async function loadRepoManager() {
  const data = await call('repos:list');
  if (data) { rm.repos = data.repos; rm.recents = data.recents; }
  renderRepoManager();
  if (rm.wip) await loadWip();
}

async function loadWip() {
  const paths = rm.repos.filter((r) => !r.missing).map((r) => r.path);
  if (!paths.length) return;
  const data = await call('repos:wip', paths);
  if (data) { rm.wipData = data; renderRepoManager(); }
}

function renderRepoManager() {
  const q = rm.query.trim().toLowerCase();
  const match = (r) =>
    !q || r.name.toLowerCase().includes(q) || r.path.toLowerCase().includes(q) ||
    (r.owner || '').toLowerCase().includes(q) || (r.branch || '').toLowerCase().includes(q);

  const openPaths = new Set(tabs.filter((t) => t.repo).map((t) => t.repo.path));
  const byPath = new Map(rm.repos.map((r) => [r.path, r]));

  const groups = [
    { key: 'open', title: 'Open repositories', empty: 'No repository is open',
      rows: [...openPaths].map((p) => byPath.get(p) || { path: p, name: p.split('/').pop() }) },
    { key: 'favorites', title: 'Favorites', empty: 'Star a repository to keep it here',
      rows: rm.repos.filter((r) => r.favorite) },
    { key: 'recent', title: 'Recent repositories', empty: 'Nothing opened yet',
      rows: rm.recents.map((p) => byPath.get(p)).filter(Boolean) },
    { key: 'all', title: 'All repositories', empty: 'Use Scan a folder to find some',
      rows: rm.repos },
  ];

  $('rm-total').textContent = rm.repos.length
    ? `${rm.repos.length} repositor${rm.repos.length === 1 ? 'y' : 'ies'}`
    : '';

  /* The header is a div holding a button, not a button holding a button: a
     nested button is invalid HTML, and the parser ejects the inner one — which
     is what threw "Remove all" onto its own line. */
  $('rm-groups').innerHTML = groups.map((g) => {
    const rows = g.rows.filter(match);
    const shut = rm.shut.has(g.key);
    const tools = g.key === 'recent' && rm.recents.length
      ? '<button class="linkbtn" data-rm-clear="recent">Remove all</button>'
      : '';
    return (
      `<section class="rm-group${shut ? ' shut' : ''}" data-group="${g.key}">` +
      '<div class="rm-group-head">' +
      `<button class="rm-toggle" data-toggle="${g.key}">` +
      `<span class="chev">▾</span><span class="rm-title">${esc(g.title)}</span>` +
      `<span class="rm-count">${rows.length}</span></button>` +
      `<span class="rm-group-tools">${tools}</span></div>` +
      (rows.length
        ? `<ul class="rm-list">${rows.map((r) => repoRow(r, openPaths)).join('')}</ul>`
        : `<p class="rm-empty">${q ? 'No matches' : esc(g.empty)}</p>`) +
      '</section>'
    );
  }).join('');
}

function repoRow(r, openPaths) {
  const w = rm.wip ? rm.wipData[r.path] : null;
  const chips = w
    ? [
        w.modified ? `<span class="w-chip w-mod">${w.modified} modified</span>` : '',
        w.added ? `<span class="w-chip w-add">${w.added} added</span>` : '',
        w.deleted ? `<span class="w-chip w-del">${w.deleted} deleted</span>` : '',
      ].join('') || '<span class="w-chip w-clean">clean</span>'
    : '';
  return (
    `<li class="rm-row${r.missing ? ' missing' : ''}" data-path="${esc(r.path)}" ` +
    `title="${esc(r.path)}">` +
    // The star sits outside the hover-only tools: a control you cannot see is a
    // control nobody finds.
    `<button class="rm-star${r.favorite ? ' on' : ''}" data-fav="${esc(r.path)}" ` +
    `title="${r.favorite ? 'Remove from favorites' : 'Add to favorites'}">${STAR(r.favorite)}</button>` +
    // Owner rides along with the name instead of claiming a column of its own:
    // a separate column leaves a gulf between the two on a wide window.
    '<span class="rm-main">' +
    `<span class="rm-name">${esc(r.name)}</span>` +
    (r.owner ? `<span class="rm-owner">${esc(r.owner)}</span>` : '') +
    (openPaths.has(r.path) ? '<span class="rm-openpill">open</span>' : '') +
    (r.missing ? '<span class="rm-openpill rm-gone">missing</span>' : '') +
    '</span>' +
    (r.branch
      ? `<span class="rm-branch" title="${esc(r.branch)}">${SIDE_ICON.branch}` +
        `<span class="rm-branch-name">${esc(r.branch)}</span></span>`
      : '<span></span>') +
    `<span class="rm-wip">${chips}</span>` +
    `<button class="rm-iconbtn rm-more" data-more="${esc(r.path)}" title="More actions">` +
    '<svg class="tb-i" viewBox="0 0 14 14" aria-hidden="true">' +
    '<circle cx="3" cy="7" r="1.1" fill="currentColor"/>' +
    '<circle cx="7" cy="7" r="1.1" fill="currentColor"/>' +
    '<circle cx="11" cy="7" r="1.1" fill="currentColor"/></svg></button>' +
    '</li>'
  );
}

/* wiring */
$('btn-repomgr').addEventListener('click', () =>
  ($('app').classList.contains('managing') ? closeRepoManager() : openRepoManager()));
$('rm-close').addEventListener('click', closeRepoManager);

$('rm-browse').addEventListener('click', () => { closeRepoManager(); openRepoAt(null); });
$('rm-clone').addEventListener('click', () => { closeRepoManager(); cloneRepo(); });
$('rm-init').addEventListener('click', () => { closeRepoManager(); initRepo(); });

$('rm-scan').addEventListener('click', async () => {
  const dir = await call('repo:pickDirectory');
  if (!dir) return;
  setStatus(`Looking through ${dir}…`);
  const res = await call('repos:scan', dir, 3);
  if (res === null) return;
  await loadRepoManager();
  setStatus(res.found
    ? `Found ${res.found} repositor${res.found === 1 ? 'y' : 'ies'}, ${res.added} new`
    : 'No repositories found in that folder', 'ok');
});

$('rm-search').addEventListener('input', (e) => { rm.query = e.target.value; renderRepoManager(); });

$('rm-wip').addEventListener('change', async (e) => {
  rm.wip = e.target.checked;
  saveRm();
  renderRepoManager();
  if (rm.wip) { setStatus('Reading uncommitted work…'); await loadWip(); setStatus('Ready'); }
});

$('rm-collapse').addEventListener('click', () => {
  rm.shut = new Set(['open', 'favorites', 'recent', 'all']);
  saveRm(); renderRepoManager();
});
$('rm-expand').addEventListener('click', () => {
  rm.shut = new Set(); saveRm(); renderRepoManager();
});

$('rm-groups').addEventListener('click', async (e) => {
  const head = e.target.closest('[data-toggle]');
  if (head) {
    const key = head.dataset.toggle;
    if (!rm.shut.delete(key)) rm.shut.add(key);
    saveRm(); renderRepoManager();
    return;
  }
  const clear = e.target.closest('[data-rm-clear]');
  if (clear) {
    e.stopPropagation();
    recents = (await call('app:clearRecents')) || [];
    await loadRepoManager();
    setStatus('Recent list cleared', 'ok');
    return;
  }
  const fav = e.target.closest('[data-fav]');
  if (fav) {
    e.stopPropagation();
    const p = fav.dataset.fav;
    const now = rm.repos.find((r) => r.path === p)?.favorite;
    const res = await call('repos:favorite', p, !now);
    if (res !== null) await loadRepoManager();
    return;
  }
  const more = e.target.closest('[data-more]');
  if (more) {
    e.stopPropagation();
    const p = more.dataset.more;
    contextMenu(e, [
      { label: 'Open', run: () => { closeRepoManager(); openRepoAt(p); } },
      { label: 'Open in editor', run: () => call('shell:openInEditor', p, p) },
      { label: 'Show in file manager', run: () => call('shell:openPath', p) },
      { label: 'Open a terminal here', run: () => call('repo:openTerminal', p) },
      '-',
      { label: 'Copy path', run: () => {
          navigator.clipboard.writeText(p); setStatus('Path copied', 'ok');
        } },
      '-',
      { label: 'Forget this repository', danger: true, run: async () => {
          const ok = await confirmAction('Forget repository',
            `${p} will be removed from these lists. Nothing on disk is touched.`, 'Forget');
          if (!ok) return;
          await call('repos:forget', p);
          await loadRepoManager();
          setStatus('Removed from the list', 'ok');
        } },
    ]);
    return;
  }
  const row = e.target.closest('.rm-row');
  if (row) { closeRepoManager(); openRepoAt(row.dataset.path); }
});

/* ═════ git actions: showing the work ═══════════════════════════ */

/* A git command that reaches the network takes long enough that silence reads
   as a dead button. These wrap every toolbar action so the button itself does
   the reporting: its icon spins, its label carries whatever phase git is in,
   and the toolbar grows a hairline of progress underneath. */

const GIT_BUTTONS = ['btn-fetch', 'btn-pull', 'btn-push', 'btn-stash', 'btn-pop',
  'btn-branch', 'btn-flow'];

const STATE_ICON = {
  busy: '<svg class="tool-spin" viewBox="0 0 16 16" aria-hidden="true">' +
    '<circle cx="8" cy="8" r="6.2" fill="none" stroke="currentColor" stroke-width="1.7" ' +
    'opacity=".22"/><path d="M8 1.8a6.2 6.2 0 0 1 6.2 6.2" fill="none" stroke="currentColor" ' +
    'stroke-width="1.7" stroke-linecap="round"/></svg>',
  done: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3.4 8.6l3 3 6.2-7" fill="none" ' +
    'stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  failed: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4.4 4.4l7.2 7.2M11.6 4.4l-7.2 7.2" ' +
    'fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"/></svg>',
};

/** One at a time: two git commands in one repository fight over index.lock. */
let action = null;      // {id, tab, label}

/* Every toolbar button gets a slot the state glyph can live in, so the markup
   does not repeat it seven times. */
for (const id of GIT_BUTTONS) {
  const b = $(id);
  if (!b) continue;
  const slot = document.createElement('span');
  slot.className = 'tool-state';
  slot.setAttribute('aria-hidden', 'true');
  b.prepend(slot);
}

const toolLabel = (id) => (id ? $(id).querySelector('span:not(.tool-state)') : null);

/* `aria-disabled` and a class, never the `disabled` property: a disabled button
   dispatches no mouse events in Chromium, and these are exactly the buttons
   whose greyed-out state most needs explaining on hover. Clicks are refused by
   the guard in gitAction() instead. */
function lockToolbar(on, verb) {
  for (const id of GIT_BUTTONS) {
    const b = $(id);
    if (!b || (action?.id && id === action.id)) continue;
    b.classList.toggle('locked', on);
    if (on) {
      if (b.dataset.wasTitle === undefined) {
        b.dataset.wasTitle = b.title || b.dataset.tip || '';
      }
      const why = `Waiting for ${verb.toLowerCase()} to finish`;
      b.title = why;
      b.dataset.tip = why;         // the tooltip may already hold the old text
      b.setAttribute('aria-disabled', 'true');
    } else if (b.dataset.wasTitle !== undefined) {
      b.title = b.dataset.wasTitle;
      b.dataset.tip = b.dataset.wasTitle;
      delete b.dataset.wasTitle;
      b.removeAttribute('aria-disabled');
    }
  }
  if (!on && state.repo) renderToolbar();   // pop and Git-Flow go back to their real state
}

function setToolState(id, kind) {
  if (!id) return;
  const b = $(id);
  b.classList.remove('busy', 'done', 'failed');
  b.querySelector('.tool-state').innerHTML = kind ? STATE_ICON[kind] : '';
  if (kind) b.classList.add(kind);
}

/* `null` hides the bar, a number fills it, 'wait' sweeps it: a command that
   reports no percentage still has to look like it is running. */
function tbProgress(percent) {
  const bar = $('tb-progress');
  if (percent === null || percent === undefined) {
    bar.hidden = true;
    bar.classList.remove('wait');
    return;
  }
  bar.hidden = false;
  if (percent === 'wait') {
    bar.classList.add('wait');
    $('tb-progress-fill').style.width = '';
    return;
  }
  bar.classList.remove('wait');
  $('tb-progress-fill').style.width = `${Math.max(0, Math.min(100, percent))}%`;
}

/**
 * Runs one git action with the button as its progress display.
 * `fn` returns null when it failed — call() has already said why.
 */
async function gitAction(id, verb, fn, done) {
  if (action) { setStatus('Another Git command is still running', 'error'); return; }
  const label = toolLabel(id);
  const startedOn = activeId;
  action = { id, tab: startedOn, label: label ? label.textContent : '' };

  if (label) label.textContent = verb;
  setToolState(id, 'busy');
  lockToolbar(true, verb);
  // Without a button of its own, the hairline is the only thing that moves.
  if (!id) tbProgress('wait');
  setStatus(`${verb}…`);

  let ok = false;
  try {
    const res = await fn();
    ok = res !== null;
  } finally {
    const finished = action;
    action = null;
    tbProgress(null);
    hideProgress();          // in case anything left the status bar's bar showing
    if (finished.label && toolLabel(id)) toolLabel(id).textContent = finished.label;
    lockToolbar(false);
    setToolState(id, ok ? 'done' : 'failed');
    // Long enough to notice, short enough not to become part of the furniture.
    setTimeout(() => { if (!action || action.id !== id) setToolState(id, null); }, 1300);
  }
  // Switching tabs mid-command must not make the follow-up refresh land on
  // another repository — that tab refreshes itself when it is activated again.
  if (ok && done) {
    if (activeId === startedOn) await done();
    else setStatus(`${verb} finished in the other tab`, 'ok');
  }
  return ok;
}

/* git narrates on stderr; this turns that narration into the button's label. */
window.gitbraid.on('repo:progress', (p) => {
  /* A clone runs from the start page, before any tab or toolbar button exists,
     so it reports on the status bar instead. Everything else is owned by a
     button and reports there — one listener, so the two cannot both draw. */
  if (!action) {
    setStatus(firstLine(p.text));
    if (p.percent !== null && p.percent !== undefined) showProgress(p.percent);
    return;
  }
  tbProgress(p.percent);
  const label = toolLabel(action.id);
  if (!label) return;
  if (p.phase) label.textContent = p.percent === null ? p.phase : `${p.phase} ${p.percent}%`;
  setStatus(p.text);
});

/* ═════ an operation git stopped part-way through ═══════════════ */

/* A conflict does not end the command — it suspends it, and the repository
   stays suspended until you finish or abandon it. That state is invisible in
   git's own output once the message scrolls away, so it gets a strip of its
   own that cannot be missed. */
function renderOpState() {
  const op = state.op;
  const bar = $('opstate');
  bar.hidden = !op;
  if (!op) return;

  const left = conflictCount();
  $('op-what').innerHTML = op.target
    ? `${esc(op.label)} <b>${esc(op.target)}</b>`
    : esc(op.label);
  $('op-left').textContent = [
    op.total ? `step ${op.step} of ${op.total}` : '',
    left ? `${left} conflict${left === 1 ? '' : 's'} left` : 'all conflicts resolved',
  ].filter(Boolean).join(' · ');

  const done = left === 0;
  $('op-continue').disabled = !done;
  $('op-continue').title = done
    ? `Finish the ${op.kind} with what is staged`
    : `Resolve the remaining ${left} file${left === 1 ? '' : 's'} first`;
  $('op-abort').title = `Undo the ${op.kind} and put the repository back as it was`;
}

const conflictCount = () => state.status?.conflicted.length || 0;

$('op-abort').addEventListener('click', async () => {
  const op = state.op;
  if (!op) return;
  const ok = await confirmAction(`Abort the ${op.kind}`,
    `The repository goes back to how it was before the ${op.kind} started. ` +
    'Work you have already committed is untouched; changes made while resolving are lost.',
    'Abort', true);
  if (!ok) return;
  await gitAction(null, `Aborting the ${op.kind}`,
    () => call('repo:abort', repoPath(), op.kind),
    async () => { await refresh({ keepSelection: false }); setStatus(`${op.label} aborted`, 'ok'); });
});

$('op-continue').addEventListener('click', async () => {
  const op = state.op;
  if (!op) return;
  const ok = await gitAction(null, `Continuing the ${op.kind}`,
    () => call('repo:continue', repoPath(), op.kind),
    async () => {
      await refresh({ keepSelection: false });
      setStatus(state.op ? `${op.label} continues` : `${op.label} finished`, 'ok');
    });
  // A rebase stops again at the next conflicting commit; that is not a failure.
  if (!ok) await refresh({ keepSelection: false });
});

/** Take one side whole, or declare the file settled as it stands on disk. */
async function resolveConflict(filePath, side) {
  const what = side === 'ours' ? 'Taking your version'
    : side === 'theirs' ? 'Taking their version'
    : 'Marking resolved';
  await gitAction(null, `${what} of ${baseName(filePath)}`,
    () => call('repo:resolve', repoPath(), filePath, side),
    async () => {
      await refresh();
      setStatus(`${baseName(filePath)}: ${side === 'mark' ? 'marked resolved' : side} kept`, 'ok');
    });
}

/* ═════ preferences ═════════════════════════════════════════════ */

/* The stored values live at the top of this file, because a tab's commit limit
   is read from them while the first tab is being built. */

/** Push the stored preferences into the places that actually read them. */
function applyPrefs() {
  const root = document.documentElement;
  root.style.setProperty('--diff-size', `${prefs.diffFontSize}px`);
  root.style.setProperty('--diff-tab', String(prefs.tabSize));
  if (prefs.diffFont) root.style.setProperty('--diff-font', `"${prefs.diffFont}", var(--mono)`);
  else root.style.removeProperty('--diff-font');

  const app = $('app');
  app.classList.toggle('no-tool-labels', !prefs.toolbarLabels);
  app.classList.toggle('no-line-numbers', !prefs.lineNumbers);
  scheduleAutoFetch();
}

/* ── auto-fetch ──────────────────────────────────────────────────
   Runs against the active tab only. A fetch is skipped rather than queued if
   the app is already busy, so a slow remote cannot stack requests up. */
let autoFetchTimer = null;

function scheduleAutoFetch() {
  if (autoFetchTimer) { clearInterval(autoFetchTimer); autoFetchTimer = null; }
  const mins = Number(prefs.autoFetch) || 0;
  if (mins <= 0) return;
  autoFetchTimer = setInterval(autoFetchTick, mins * 60_000);
}

async function autoFetchTick() {
  if (!state.repo || busy) return;
  const res = await call('repo:fetch', repoPath(), { prune: prefs.autoPrune });
  if (res === null) return;                  // a failed fetch already reported itself
  await refresh();
  setStatus('Auto-fetched', 'ok');
}

/* ── the pages ─────────────────────────────────────────────────── */

const PF_ICONS = {
  general: '<circle cx="7" cy="7" r="2.4"/><path d="M7 1v1.8M7 11.2V13M1 7h1.8M11.2 7H13' +
    'M2.8 2.8l1.3 1.3M9.9 9.9l1.3 1.3M11.2 2.8L9.9 4.1M4.1 9.9L2.8 11.2"/>',
  profiles: '<circle cx="7" cy="4.6" r="2.5"/><path d="M2 12.6c.6-2.4 2.6-3.6 5-3.6s4.4 1.2 5 3.6"/>',
  ui: '<path d="M1.6 2.4h10.8v9.2H1.6zM1.6 5.2h10.8M4.9 5.2v6.4"/>',
  editor: '<path d="M5.2 4.3 2.4 7l2.8 2.7M8.8 4.3 11.6 7l-2.8 2.7"/>',
};

/* A field is {kind, label, help, warn, get, set} and nothing else — the page
   never reaches into the DOM to find out what a control currently means. */
function prefPages() {
  const col = (key) => COLUMNS.find((c) => c.key === key);
  return [
    {
      id: 'general',
      label: 'General',
      groups: [
        {
          title: 'Fetching',
          fields: [
            { kind: 'number', label: 'Auto-fetch interval', unit: 'minutes', min: 0, max: 60,
              help: 'Fetch every visible remote of the active tab this often. 0 turns it off.',
              warn: 'Each fetch reaches the network. On a metered connection keep it high or off.',
              get: () => prefs.autoFetch,
              set: (v) => { prefs.autoFetch = clampInt(v, 0, 60, 0); savePrefs(); scheduleAutoFetch(); } },
            { kind: 'toggle', label: 'Prune while fetching',
              help: 'Drop remote branches that no longer exist, so stale ones stop appearing in the graph.',
              get: () => prefs.autoPrune,
              set: (v) => { prefs.autoPrune = v; savePrefs(); } },
          ],
        },
        {
          title: 'History',
          fields: [
            { kind: 'number', label: 'Commits loaded at a time', min: 100, max: 5000, step: 100,
              help: 'How many commits each read of the history asks git for. ' +
                'Load more at the bottom of the list adds another batch of this size.',
              warn: 'GitBraid renders every loaded row, so very large numbers make scrolling heavy.',
              get: () => prefs.commitLimit,
              set: (v) => { prefs.commitLimit = clampInt(v, 100, 5000, 400); savePrefs(); } },
            { kind: 'toggle', label: 'Reopen last session’s tabs on launch',
              help: 'Restores every repository you had open, on the tab you were looking at. ' +
                'Off means GitBraid always starts on the New Tab page.',
              get: () => prefs.resumeLast,
              set: (v) => { prefs.resumeLast = v; savePrefs(); } },
          ],
        },
        {
          title: 'New repositories',
          fields: [
            { kind: 'gitconfig', key: 'init.defaultBranch', label: 'Default branch name',
              placeholder: 'git’s own default (master)',
              help: 'Written to init.defaultBranch in your global git config, so ' +
                '<code>git init</code> on the command line uses it too.' },
          ],
        },
        {
          title: 'Activity log',
          fields: [
            { kind: 'action', label: 'Git command log',
              button: 'Open activity log',
              help: 'The last 400 git commands GitBraid ran, with how long each took.',
              run: () => { closePrefs(); openLogs(); } },
          ],
        },
      ],
    },
    {
      id: 'profiles',
      label: 'Profiles',
      groups: [
        { kind: 'identity' },
      ],
    },
    {
      id: 'ui',
      label: 'UI customization',
      groups: [
        {
          title: 'Appearance',
          fields: [
            { kind: 'select', label: 'Theme',
              options: [['dark', 'GitBraid Dark'], ['light', 'GitBraid Light']],
              get: () => storedTheme(),
              set: (v) => { applyTheme(v); renderPrefs(); } },
            { kind: 'zoom', label: 'Zoom',
              help: 'Scales the whole window. Ctrl+= and Ctrl+- do the same thing.' },
            { kind: 'toggle', label: 'Labels under the toolbar icons',
              help: 'Off leaves just the icons, which makes the toolbar shorter.',
              get: () => prefs.toolbarLabels,
              set: (v) => { prefs.toolbarLabels = v; savePrefs(); applyPrefs(); } },
          ],
        },
        {
          title: 'History rows',
          fields: [
            { kind: 'select', label: 'Date and time',
              options: [['absolute', '08/17/2026 @ 10:55 PM'], ['relative', '2h ago']],
              help: 'How the Commit Date and Author Time columns are written.',
              get: () => prefs.dateStyle,
              set: (v) => { prefs.dateStyle = v; savePrefs(); if (state.repo) renderHistory(); } },
            { kind: 'select', label: 'Author picture',
              options: [['graph', 'On the graph dot'], ['author', 'In the Author column'],
                        ['both', 'Both places'], ['none', 'Nowhere']],
              help: 'Where an author is shown as a face. In the Author column a commit '
                + 'without a Gravatar still gets a coloured disc of initials, drawn here '
                + 'with no network involved; the graph dot is too small for lettering, so '
                + 'there it only ever carries a Gravatar picture.',
              get: () => prefs.avatarPlace,
              set: (v) => { prefs.avatarPlace = v; savePrefs(); if (state.repo) renderHistory(); } },
            { kind: 'toggle', label: 'Author photos from Gravatar',
              help: 'Off, the graph draws a plain lane-coloured dot and nothing leaves ' +
                'this machine. On, GitBraid asks gravatar.com for a picture of every ' +
                'commit author, which tells that service your address and the hashed ' +
                'email of everyone whose commits you read.',
              get: () => prefs.gravatar,
              set: async (v) => {
                prefs.gravatar = v; savePrefs();
                if (state.repo) { await ensureAvatars(state.commits); renderHistory(); }
              } },
            { kind: 'toggle', label: 'Ghost branch badge while hovering',
              help: 'Shows which branch contains the row you are pointing at, in the Branch / Tag column.',
              get: () => prefs.ghostBadge,
              set: (v) => { prefs.ghostBadge = v; savePrefs(); if (state.repo) renderHistory(); } },
            { kind: 'toggle', label: 'Commit description while hovering',
              help: 'Shows the rest of a commit message next to its subject.',
              get: () => prefs.hoverMessage,
              set: (v) => { prefs.hoverMessage = v; savePrefs(); if (state.repo) renderHistory(); } },
          ],
        },
        {
          title: 'Columns',
          note: 'The same list as right-clicking the history header. Drag a header edge to resize.',
          fields: COLUMNS.filter((c) => c.optional).map((c) => ({
            kind: 'toggle', label: c.label,
            get: () => !cols.hidden.has(c.key),
            set: (v) => {
              if (v) cols.hidden.delete(c.key); else cols.hidden.add(c.key);
              saveColumns(); applyColumns(); renderHistoryHead();
              if (state.repo) renderHistory();
            },
          })),
          reset: { label: 'Reset widths and visibility', run: () => { resetColumns(); renderPrefs(); } },
        },
      ],
    },
    {
      id: 'editor',
      label: 'Editor',
      groups: [
        {
          title: 'Diff viewer',
          note: 'How the file viewer in the middle of the window draws a diff.',
          fields: [
            { kind: 'select', label: 'Font',
              options: [['', 'Theme default'], ...MONO_FONTS.map((f) => [f, f])],
              help: 'Only fonts installed on this machine will apply; the theme stack catches the rest.',
              get: () => prefs.diffFont,
              set: (v) => { prefs.diffFont = v; savePrefs(); applyPrefs(); } },
            { kind: 'number', label: 'Font size', unit: 'px', min: 9, max: 20,
              get: () => prefs.diffFontSize,
              set: (v) => { prefs.diffFontSize = clampInt(v, 9, 20, 12); savePrefs(); applyPrefs(); } },
            { kind: 'number', label: 'Tab width', unit: 'spaces', min: 1, max: 8,
              get: () => prefs.tabSize,
              set: (v) => { prefs.tabSize = clampInt(v, 1, 8, 4); savePrefs(); applyPrefs(); } },
            { kind: 'toggle', label: 'Line numbers',
              get: () => prefs.lineNumbers,
              set: (v) => { prefs.lineNumbers = v; savePrefs(); applyPrefs(); } },
            { kind: 'toggle', label: 'Syntax highlighting',
              help: `Coloured by GitBraid's own tokenizer for ${Hl.languages()} languages.`,
              get: () => viewer.syntax,
              set: (v) => { viewer.syntax = v; saveViewer(); syncViewerToggles(); renderViewer(); } },
          ],
        },
        {
          title: 'How a diff opens',
          note: 'Starting state for every file you open. The buttons above the diff still change one file at a time.',
          fields: [
            { kind: 'toggle', label: 'Side-by-side',
              get: () => viewer.split,
              set: (v) => { viewer.split = v; saveViewer(); syncViewerToggles(); renderViewer(); } },
            { kind: 'toggle', label: 'Wrap long lines',
              get: () => viewer.wrap,
              set: (v) => { viewer.wrap = v; saveViewer(); syncViewerToggles(); renderViewer(); } },
            { kind: 'toggle', label: 'Ignore whitespace',
              help: 'Hides changes that are only indentation or trailing spaces.',
              get: () => viewer.ignoreWhitespace,
              set: (v) => { viewer.ignoreWhitespace = v; saveViewer(); syncViewerToggles(); renderViewer(); } },
            { kind: 'toggle', label: 'Show the whole file',
              help: 'Off shows three lines of context around each change.',
              get: () => viewer.allLines,
              set: (v) => { viewer.allLines = v; saveViewer(); syncViewerToggles(); renderViewer(); } },
          ],
        },
        {
          title: 'External editor',
          fields: [
            { kind: 'gitconfig', key: 'gitbraid.editor', label: 'Command to open files with',
              placeholder: 'detected automatically',
              help: 'Used by Open in the diff viewer. Leave empty and GitBraid looks for ' +
                'an installed editor itself. Written to gitbraid.editor in your global git config.' },
          ],
        },
      ],
    },
  ];
}

const MONO_FONTS = ['JetBrains Mono', 'IBM Plex Mono', 'Fira Code', 'Source Code Pro',
  'Ubuntu Mono', 'DejaVu Sans Mono', 'Liberation Mono', 'Noto Sans Mono', 'monospace'];

const clampInt = (v, lo, hi, fallback) => {
  const n = Math.round(Number(v));
  if (!Number.isFinite(n)) return fallback;
  return Math.min(hi, Math.max(lo, n));
};

/* ── rendering ─────────────────────────────────────────────────── */

const pf = { page: 'general', fields: [] };

function openPrefs(page) {
  if (page) pf.page = page;
  $('app').classList.add('prefs-open');
  $('prefs').hidden = false;
  call('app:about').then((i) => { if (i) $('pf-version').textContent = i.version; });
  renderPrefs();
}

function closePrefs() {
  $('prefs').hidden = true;
  $('app').classList.remove('prefs-open');
}

function renderPrefs() {
  const pages = prefPages();
  $('pf-tabs').innerHTML = pages.map((p) =>
    `<button class="pf-tab${p.id === pf.page ? ' on' : ''}" data-page="${p.id}">` +
    `<svg class="pf-i" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.3"` +
    ` stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${PF_ICONS[p.id]}</svg>` +
    `${esc(p.label)}</button>`).join('');

  const page = pages.find((p) => p.id === pf.page) || pages[0];
  pf.fields = [];
  $('pf-body').innerHTML =
    `<h1 class="pf-title">${esc(page.label)}</h1>` +
    page.groups.map(renderPrefGroup).join('');
  bindPrefs();
}

function renderPrefGroup(g) {
  if (g.kind === 'identity') return identityGroup();
  const rows = g.fields.map((f) => {
    const i = pf.fields.push(f) - 1;
    return prefRow(f, i);
  }).join('');
  return (
    '<section class="pf-group">' +
    `<h2>${esc(g.title)}</h2>` +
    (g.note ? `<p class="pf-note">${esc(g.note)}</p>` : '') +
    rows +
    (g.reset ? `<div class="pf-row"><span class="pf-label"></span>` +
      `<button class="btn pf-reset">${esc(g.reset.label)}</button></div>` : '') +
    '</section>'
  );
}

function prefRow(f, i) {
  let control = '';
  if (f.kind === 'toggle') {
    control = `<label class="pf-switch"><input type="checkbox" data-f="${i}"` +
      `${f.get() ? ' checked' : ''}><span class="pf-track"></span></label>`;
  } else if (f.kind === 'number') {
    control = `<span class="pf-numwrap"><input class="pf-num" type="number" data-f="${i}"` +
      ` min="${f.min}" max="${f.max}"${f.step ? ` step="${f.step}"` : ''}` +
      ` value="${esc(String(f.get()))}">` +
      (f.unit ? `<span class="pf-unit">${esc(f.unit)}</span>` : '') + '</span>';
  } else if (f.kind === 'select') {
    const now = String(f.get());
    control = `<select class="pf-select" data-f="${i}">` + f.options.map(([v, label]) =>
      `<option value="${esc(v)}"${v === now ? ' selected' : ''}>${esc(label)}</option>`).join('') +
      '</select>';
  } else if (f.kind === 'gitconfig') {
    control = `<input class="pf-text" type="text" data-f="${i}" data-key="${esc(f.key)}"` +
      ` spellcheck="false" placeholder="${esc(f.placeholder || '')}" value="">`;
  } else if (f.kind === 'action') {
    control = `<button class="btn" data-f="${i}">${esc(f.button)}</button>`;
  } else if (f.kind === 'zoom') {
    control = '<span class="pf-zoom">' +
      '<button class="btn btn-icon" data-zoom="-1" title="Zoom out">−</button>' +
      `<span class="pf-zoom-now">${Math.round(1.2 ** zoomLevel * 100)}%</span>` +
      '<button class="btn btn-icon" data-zoom="1" title="Zoom in">+</button>' +
      '<button class="btn" data-zoom="0">Reset</button></span>';
  }
  return (
    '<div class="pf-row">' +
    `<span class="pf-label">${esc(f.label)}</span>` +
    `<span class="pf-control">${control}</span>` +
    (f.help ? `<p class="pf-help">${f.help}</p>` : '') +
    (f.warn ? `<p class="pf-warn">${esc(f.warn)}</p>` : '') +
    '</div>'
  );
}

/** Profiles is the one page whose values live in git, so it reads them on open. */
function identityGroup() {
  return (
    '<section class="pf-group pf-identity">' +
    '<h2>Git identity</h2>' +
    '<p class="pf-note">The name and email that go on every commit you make. ' +
    'GitBraid writes them with <code>git config</code>, so this is the same ' +
    'identity the command line uses.</p>' +
    '<div class="pf-card" id="pf-global">' +
    '<header class="pf-card-head"><span class="pf-avatar" id="pf-avatar">?</span>' +
    '<span><strong>Global</strong><span class="pf-where">~/.gitconfig — used by every repository</span></span>' +
    '</header>' +
    '<div class="pf-fields">' +
    '<label class="pf-field"><span>Name</span>' +
    '<input id="pf-gname" type="text" spellcheck="false" placeholder="Your name"></label>' +
    '<label class="pf-field"><span>Email</span>' +
    '<input id="pf-gemail" type="text" spellcheck="false" placeholder="you@example.com"></label>' +
    '</div>' +
    '<div class="pf-card-foot"><button class="btn btn-primary" id="pf-gsave">Save global identity</button>' +
    '<span class="pf-said" id="pf-gsaid"></span></div>' +
    '</div>' +
    '<div class="pf-card" id="pf-localcard">' +
    '<header class="pf-card-head"><span class="pf-avatar pf-avatar-alt" id="pf-lavatar">?</span>' +
    `<span><strong>This repository</strong><span class="pf-where" id="pf-lwhere"></span></span>` +
    '</header>' +
    '<div class="pf-fields">' +
    '<label class="pf-field"><span>Name</span>' +
    '<input id="pf-lname" type="text" spellcheck="false" placeholder="leave empty to use the global name"></label>' +
    '<label class="pf-field"><span>Email</span>' +
    '<input id="pf-lemail" type="text" spellcheck="false" placeholder="leave empty to use the global email"></label>' +
    '</div>' +
    '<div class="pf-card-foot"><button class="btn" id="pf-lsave">Save for this repository</button>' +
    '<span class="pf-said" id="pf-lsaid"></span></div>' +
    '</div>' +
    '</section>'
  );
}

function bindPrefs() {
  $('pf-body').querySelectorAll('[data-f]').forEach((el) => {
    const f = pf.fields[Number(el.dataset.f)];
    if (f.kind === 'toggle') el.addEventListener('change', () => f.set(el.checked));
    else if (f.kind === 'select') el.addEventListener('change', () => f.set(el.value));
    else if (f.kind === 'action') el.addEventListener('click', f.run);
    else if (f.kind === 'number') {
      // Commit on blur or Enter, not per keystroke: a half-typed 5 would apply as 5.
      const commit = () => { f.set(el.value); el.value = String(f.get()); };
      el.addEventListener('change', commit);
      el.addEventListener('keydown', (e) => { if (e.key === 'Enter') commit(); });
    } else if (f.kind === 'gitconfig') {
      call('git:option', f.key).then((v) => { if (v !== null) el.value = v || ''; });
      const commit = async () => {
        const saved = await call('git:setOption', f.key, el.value);
        if (saved === null) return;
        el.value = saved;
        setStatus(saved ? `${f.key} set to ${saved}` : `${f.key} cleared`, 'ok');
      };
      el.addEventListener('change', commit);
      el.addEventListener('keydown', (e) => { if (e.key === 'Enter') el.blur(); });
    }
  });

  $('pf-body').querySelectorAll('[data-zoom]').forEach((b) =>
    b.addEventListener('click', () => {
      const d = Number(b.dataset.zoom);
      applyZoom(d === 0 ? 0 : zoomLevel + d);
      const now = $('pf-body').querySelector('.pf-zoom-now');
      if (now) now.textContent = `${Math.round(1.2 ** zoomLevel * 100)}%`;
    }));

  const reset = $('pf-body').querySelector('.pf-reset');
  if (reset) {
    const group = prefPages().find((p) => p.id === pf.page).groups.find((g) => g.reset);
    reset.addEventListener('click', group.reset.run);
  }

  if (pf.page === 'profiles') loadIdentityPage();
}

async function loadIdentityPage() {
  const id = await call('git:identity', state.repo ? repoPath() : null);
  if (id === null) return;
  $('pf-gname').value = id.globalName || '';
  $('pf-gemail').value = id.globalEmail || '';
  $('pf-avatar').textContent = initialsOf(id.globalName || id.globalEmail || '?');

  const hasRepo = !!state.repo;
  $('pf-localcard').classList.toggle('off', !hasRepo);
  $('pf-lwhere').textContent = hasRepo
    ? `${shortenHome(state.repo.path)}/.git/config — only this repository`
    : 'No repository is open, so there is nothing to override';
  ['pf-lname', 'pf-lemail', 'pf-lsave'].forEach((k) => { $(k).disabled = !hasRepo; });
  $('pf-lname').value = id.localName || '';
  $('pf-lemail').value = id.localEmail || '';
  $('pf-lavatar').textContent = initialsOf(id.localName || id.localEmail || id.globalName || '?');

  const save = async (local) => {
    const name = $(local ? 'pf-lname' : 'pf-gname').value.trim();
    const email = $(local ? 'pf-lemail' : 'pf-gemail').value.trim();
    if (!local && (!name || !email)) {
      setStatus('A global identity needs both a name and an email', 'err');
      return;
    }
    const ok = await call('git:setIdentity', repoPath(), { name, email, local });
    if (ok === null) return;
    const said = $(local ? 'pf-lsaid' : 'pf-gsaid');
    said.textContent = 'Saved';
    setTimeout(() => { said.textContent = ''; }, 2200);
    loadIdentityPage();
    if (typeof renderIdentityChip === 'function') renderIdentityChip();
  };
  $('pf-gsave').onclick = () => save(false);
  $('pf-lsave').onclick = () => save(true);
}

const initialsOf = (s) => (s.trim().split(/[\s@._-]+/).filter(Boolean).slice(0, 2)
  .map((w) => w[0].toUpperCase()).join('') || '?');

$('pf-tabs').addEventListener('click', (e) => {
  const b = e.target.closest('.pf-tab');
  if (!b) return;
  pf.page = b.dataset.page;
  renderPrefs();
});
$('pf-close').addEventListener('click', closePrefs);
$('btn-settings').addEventListener('click', () => openPrefs());

/* ═════ terminal ════════════════════════════════════════════════ */

/* A command runner rather than a pseudo-terminal — see the note in main.js.
   History is kept per session so ↑ works the way a shell trains you to expect. */
const term = { history: [], at: -1, busy: false, height: 220, open: false };
try {
  const saved = JSON.parse(localStorage.getItem('gitbraid-term') || '{}');
  if (saved.height) term.height = saved.height;
  term.open = !!saved.open;
} catch { /* private mode */ }

function saveTerm() {
  try { localStorage.setItem('gitbraid-term', JSON.stringify({ height: term.height, open: term.open })); }
  catch { /* private mode */ }
}

const termOpen = () => !$('term').hidden;

/* A build or a test run prints thousands of lines, and they were kept for the
   rest of the session — the panel grew without limit. Older lines are dropped
   the way a terminal's scrollback does. */
const TERM_MAX_LINES = 5000;

/* Whether the reader is following the tail. Kept up to date from the scroll
   event instead of measured on every line: reading scrollHeight forces a layout
   of the whole panel, and doing that per line made 2,000 lines take 2.7
   seconds where appending them costs 3 ms. */
let termAtBottom = true;
let termScrollQueued = false;

$('term-out').addEventListener('scroll', () => {
  const out = $('term-out');
  termAtBottom = out.scrollHeight - out.scrollTop - out.clientHeight < 24;
});

function termWrite(text, cls) {
  const out = $('term-out');
  const line = document.createElement('div');
  if (cls) line.className = cls;
  line.textContent = text;
  out.appendChild(line);
  while (out.childElementCount > TERM_MAX_LINES) out.removeChild(out.firstChild);

  // One scroll per frame however many lines arrived in it.
  if (termAtBottom && !termScrollQueued) {
    termScrollQueued = true;
    requestAnimationFrame(() => {
      termScrollQueued = false;
      out.scrollTop = out.scrollHeight;
    });
  }
}

/** The panel titles itself with the repository its commands will run in. */
function syncTermCwd() {
  $('term-cwd').textContent = state.repo ? shortenHome(state.repo.path) : 'no repository open';
}

function showTerm() {
  $('term').hidden = false;
  $('app').classList.add('term-open');
  term.open = true;
  saveTerm();
  document.documentElement.style.setProperty('--term-h', `${term.height}px`);
  syncTermCwd();
  if (!$('term-out').childElementCount) {
    termWrite('GitBraid runs commands here in the open repository.', 'term-hint');
    termWrite('Output is captured, not a terminal screen: git, npm and ls work; ' +
      'vim, top and other full-screen programs do not.', 'term-hint');
  }
  $('term-cmd').focus();
}

function hideTerm() {
  $('term').hidden = true;
  $('app').classList.remove('term-open');
  term.open = false;
  saveTerm();
}

const toggleTerm = () => (termOpen() ? hideTerm() : showTerm());

async function termRun(cmd) {
  if (!state.repo) { termWrite('Open a repository first.', 'term-err'); return; }
  if (term.busy) return;
  termWrite(`$ ${cmd}`, 'term-cmd-echo');
  term.busy = true;
  $('term-stop').disabled = false;
  const res = await call('term:run', repoPath(), cmd);
  if (res === null) { term.busy = false; $('term-stop').disabled = true; }
}

window.gitbraid.on('term:out', (m) => termWrite(m.text.replace(/\n$/, ''), m.stream === 'err' ? 'term-err' : ''));
window.gitbraid.on('term:exit', (m) => {
  term.busy = false;
  $('term-stop').disabled = true;
  termWrite(m.signal ? `— stopped (${m.signal})` : `— exit ${m.code}`,
    m.code === 0 ? 'term-ok' : 'term-err');
});

$('term-cmd').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    const cmd = e.target.value.trim();
    if (!cmd) return;
    term.history.push(cmd);
    term.at = term.history.length;
    e.target.value = '';
    termRun(cmd);
    return;
  }
  if (e.key === 'ArrowUp') {
    e.preventDefault();
    if (!term.history.length) return;
    term.at = Math.max(0, term.at - 1);
    e.target.value = term.history[term.at] || '';
    return;
  }
  if (e.key === 'ArrowDown') {
    e.preventDefault();
    term.at = Math.min(term.history.length, term.at + 1);
    e.target.value = term.history[term.at] || '';
  }
});

$('term-stop').addEventListener('click', () => call('term:kill'));
$('term-clear').addEventListener('click', () => { $('term-out').innerHTML = ''; });
$('term-external').addEventListener('click', () =>
  state.repo && call('repo:openTerminal', repoPath()));
$('term-close').addEventListener('click', hideTerm);

/* drag the top edge to resize */
$('term-grip').addEventListener('mousedown', (down) => {
  down.preventDefault();
  const startY = down.clientY;
  const startH = term.height;
  const onMove = (m) => {
    term.height = Math.max(120, Math.min(window.innerHeight - 300, startH + startY - m.clientY));
    document.documentElement.style.setProperty('--term-h', `${term.height}px`);
  };
  const onUp = () => {
    document.removeEventListener('mousemove', onMove);
    document.removeEventListener('mouseup', onUp);
    saveTerm();
  };
  document.addEventListener('mousemove', onMove);
  document.addEventListener('mouseup', onUp);
});

/* ═════ activity log ════════════════════════════════════════════ */

async function openLogs() {
  const rows = await call('app:log');
  if (rows === null) return;
  $('logs-count').textContent = rows.length
    ? `${rows.length} command${rows.length === 1 ? '' : 's'}`
    : '';
  $('logs-list').innerHTML = rows.length
    ? rows.map((r) => {
        const t = new Date(r.at);
        const clock = `${String(t.getHours()).padStart(2, '0')}:` +
          `${String(t.getMinutes()).padStart(2, '0')}:${String(t.getSeconds()).padStart(2, '0')}`;
        // A non-zero exit with nothing on stderr gets a quiet marker, not a red line.
        const cls = r.error ? 'failed' : r.code ? 'quiet' : '';
        return (
          `<li${cls ? ` class="${cls}"` : ''}>` +
          `<span class="lg-time">${clock}</span>` +
          `<span class="lg-cmd">${esc(r.command)}` +
          (!r.error && r.code ? `<span class="lg-code">exit ${r.code}</span>` : '') +
          '</span>' +
          `<span class="lg-ms">${r.ms} ms</span>` +
          (r.error ? `<span class="lg-err">${esc(r.error)}</span>` : '') +
          '</li>'
        );
      }).join('')
    : '<li class="empty-row">Nothing has run yet</li>';
  $('logs').hidden = false;
}

const closeLogs = () => { $('logs').hidden = true; };

$('logs-close').addEventListener('click', closeLogs);
$('logs').addEventListener('click', (e) => { if (e.target === $('logs')) closeLogs(); });
$('logs-clear').addEventListener('click', async () => {
  await call('app:clearLog');
  openLogs();
});
$('logs-copy').addEventListener('click', async () => {
  const rows = await call('app:log');
  if (!rows) return;
  // The pasted log carries the same three states the screen shows.
  navigator.clipboard.writeText(rows.map((r) => {
    const tail = r.error ? `  !! ${r.error}` : r.code ? `  (exit ${r.code})` : '';
    return `${new Date(r.at).toISOString()}  ${r.ms}ms  ${r.command}${tail}`;
  }).join('\n'));
  setStatus('Activity log copied', 'ok');
});

/* ═════ status bar ══════════════════════════════════════════════ */

function renderZoomLevel() {
  $('sb-zoom-level').textContent = `${Math.round(1.2 ** zoomLevel * 100)}%`;
}

$('sb-term').addEventListener('click', toggleTerm);
$('sb-logs').addEventListener('click', openLogs);
$('sb-zoom-in').addEventListener('click', () => applyZoom(zoomLevel + 1));
$('sb-zoom-out').addEventListener('click', () => applyZoom(zoomLevel - 1));
$('sb-zoom-level').addEventListener('click', () => applyZoom(0));

$('sb-brand').addEventListener('click', async (e) => {
  const info = await call('app:about');
  const home = info?.homepage;
  const r = $('sb-brand').getBoundingClientRect();
  contextMenu({ preventDefault() {}, clientX: r.left, clientY: r.top - 6 }, [
    { label: home ? `Open ${home}` : 'Project page',
      disabled: !home,
      hint: home ? '' : 'Set "homepage" in package.json to link this',
      run: () => call('shell:openExternal', home) },
    '-',
    { label: 'Release notes', run: openNotes },
    { label: 'About GitBraid', run: openAbout },
  ]);
});

/* ═════ about ═══════════════════════════════════════════════════ */

async function openAbout() {
  const info = await call('app:about');
  if (!info) return;
  $('about-version').textContent = `Version ${info.version}`;
  $('about-specs').innerHTML = [
    ['Git', info.git || 'not found on PATH'],
    ['Electron', info.electron],
    ['Chromium', info.chrome],
    ['Node', info.node],
    ['Platform', info.platform],
  ].map(([k, v]) =>
    `<div><dt>${esc(k)}</dt><dd${info.git || k !== 'Git' ? '' : ' class="missing"'}>${esc(v)}</dd></div>`
  ).join('');
  $('about-foot').textContent =
    `MIT licensed · built on the git command line · ${new Date().getFullYear()}`;
  $('about').hidden = false;
  $('about-close').focus();
}

const closeAbout = () => { $('about').hidden = true; };

$('about-close').addEventListener('click', closeAbout);
$('about').addEventListener('click', (e) => { if (e.target === $('about')) closeAbout(); });
$('about-notes').addEventListener('click', () => { closeAbout(); openNotes(); });
$('about-copy').addEventListener('click', async () => {
  const lines = [...$('about-specs').querySelectorAll('div')]
    .map((d) => `${d.querySelector('dt').textContent}: ${d.querySelector('dd').textContent}`);
  navigator.clipboard.writeText([`GitBraid ${$('about-version').textContent}`, ...lines].join('\n'));
  setStatus('Version info copied', 'ok');
});

/* ═════ release notes ═══════════════════════════════════════════ */

function renderNotes() {
  const list = window.Releases || [];
  $('nt-count').textContent = list.length
    ? `${list.length} release${list.length === 1 ? '' : 's'}`
    : '';

  $('nt-body').innerHTML = list.map((r) => {
    const stamp = r.state === 'development'
      ? '<span class="nt-pill nt-dev">in development</span>'
      : `<span class="nt-date">${esc(r.date || '')}</span>`;
    const sections = (r.sections || []).map((sec) =>
      `<section class="nt-sec"><h3>${esc(sec.heading)}</h3><ul>` +
      sec.items.map((i) => `<li>${esc(i)}</li>`).join('') +
      '</ul></section>'
    ).join('');
    const known = (r.known || []).length
      ? '<section class="nt-sec nt-known"><h3>Known limitations</h3><ul>' +
        r.known.map((i) => `<li>${esc(i)}</li>`).join('') + '</ul></section>'
      : '';
    return (
      '<article class="nt-rel">' +
      '<header class="nt-relhead">' +
      `<span class="nt-ver">${esc(r.version)}</span>${stamp}` +
      `<h2>${esc(r.title || '')}</h2>` +
      (r.summary ? `<p class="nt-summary">${esc(r.summary)}</p>` : '') +
      '</header>' +
      sections + known +
      '</article>'
    );
  }).join('') || '<p class="nt-empty">No release notes yet.</p>';
}

function openNotes() {
  renderNotes();
  $('app').classList.add('reading-notes');
  $('notes').hidden = false;
  $('nt-body').scrollTop = 0;
}

const closeNotes = () => {
  $('app').classList.remove('reading-notes');
  $('notes').hidden = true;
};

$('nt-close').addEventListener('click', closeNotes);

/* ═════ application menu ════════════════════════════════════════ */

const SHORTCUTS = [
  ['Repository', [
    ['Ctrl O', 'Open a repository in a new tab'],
    ['Ctrl N', 'Clone from a URL'],
    ['Ctrl I', 'Create a new repository'],
    ['F5 / Ctrl R', 'Refresh'],
  ]],
  ['Tabs and search', [
    ['Ctrl W', 'Close the current tab'],
    ['Ctrl Tab', 'Next tab'],
    ['Ctrl Shift Tab', 'Previous tab'],
    ['Ctrl F', 'Search commits'],
    ['Enter', 'Next match (Shift+Enter for previous)'],
  ]],
  ['Current repository', [
    ['F', 'Fetch all remotes'],
    ['P', 'Pull the current branch'],
    ['Shift P', 'Push the current branch'],
    ['B', 'New branch'],
    ['Ctrl Enter', 'Commit (from the message box)'],
    ['Ctrl /', 'This list'],
    ['Alt O', 'Open in file manager'],
    ['Alt T', 'Open an external terminal'],
  ]],
  ['View', [
    ['Ctrl J', 'Show or hide the left panel'],
    ['Ctrl K', 'Show or hide the commit details panel'],
    ['Ctrl =', 'Increase zoom'],
    ['Ctrl -', 'Decrease zoom'],
    ['Ctrl 0', 'Reset zoom'],
    ['Ctrl Shift F', 'Toggle full screen'],
  ]],
];

/** "Ctrl Enter" → two keys; "F5 / Ctrl R" → two alternatives, ` or ` between. */
const keyCaps = (keys) =>
  keys
    .split(' / ')
    .map((combo) => combo.split(' ').map((k) => `<kbd>${esc(k)}</kbd>`).join(''))
    .join('<span class="sc-or">or</span>');

function showShortcuts() {
  const html = SHORTCUTS.map(
    ([group, rows]) =>
      `<h4 class="sc-group">${esc(group)}</h4><dl class="sc-list">` +
      rows.map(([keys, what]) =>
        `<dt>${keyCaps(keys)}</dt><dd>${esc(what)}</dd>`).join('') +
      '</dl>'
  ).join('');
  return modal({ title: 'Keyboard shortcuts', html, confirmLabel: 'Close', hideCancel: true });
}

/* Menu items do not act on their own: main sends the intent here, where the
   state and the dialogs already live. */
const MENU_ACTIONS = {
  open: () => openRepoAt(null),
  clone: cloneRepo,
  init: initRepo,
  'open-recent': (m) => openRepoAt(m.path),
  'clear-recents': async () => {
    recents = (await call('app:clearRecents')) || [];
    renderRecents();
  },
  'file-manager': () => state.repo && call('shell:openPath', state.repo.path),
  terminal: async () => {           // the desktop's own terminal application
    if (!state.repo) return;
    const term = await call('repo:openTerminal', state.repo.path);
    if (term) setStatus(`Opened ${term} in ${state.repo.path}`, 'ok');
  },
  'new-tab': newEmptyTab,
  'close-tab': () => closeTab(),
  'next-tab': () => stepTab(1),
  'prev-tab': () => stepTab(-1),
  'search-tabs': openTabMenu,
  find: openFind,
  'repo-manager': () => ($('app').classList.contains('managing')
    ? closeRepoManager() : openRepoManager()),
  about: openAbout,
  'release-notes': () => ($('app').classList.contains('reading-notes')
    ? closeNotes() : openNotes()),
  'terminal-panel': toggleTerm,     // the panel inside the window
  'activity-log': openLogs,
  preferences: () => ($('prefs').hidden ? openPrefs() : closePrefs()),
  'zoom-in': () => applyZoom(zoomLevel + 1),
  'zoom-out': () => applyZoom(zoomLevel - 1),
  'zoom-reset': () => applyZoom(0),
  'toggle-sidebar': () => togglePanel('sidebar'),
  'toggle-detail': () => togglePanel('detail'),
  refresh: () => refresh(),
  shortcuts: showShortcuts,
};

/* Anything that opens a dialog is skipped while one is already up — the
   modal is a single shared element. */
const DIALOG_ACTIONS = new Set(['clone', 'init', 'shortcuts']);

window.gitbraid.on('menu:action', (msg) => {
  if (DIALOG_ACTIONS.has(msg.action) && !$('modal').hidden) return;
  MENU_ACTIONS[msg.action]?.(msg);
});

/* Which group headers are shut. Tags and stashes ship shut (see index.html);
   anything the user changes afterwards wins. */
function saveGroups() {
  const shut = [...document.querySelectorAll('.side-group')]
    .filter((g) => g.classList.contains('collapsed'))
    .map((g) => g.dataset.group);
  try { localStorage.setItem('gitbraid-groups', JSON.stringify(shut)); } catch { /* ignore */ }
}

function loadGroups() {
  let shut;
  try { shut = JSON.parse(localStorage.getItem('gitbraid-groups')); } catch { /* ignore */ }
  if (!Array.isArray(shut)) return;   // never touched: keep the markup defaults
  document.querySelectorAll('.side-group').forEach((g) => {
    g.classList.toggle('collapsed', shut.includes(g.dataset.group));
  });
}

/* Everything here is about the repository already open. Opening another one,
   cloning, and the list of recent repositories all live in the New Tab page and
   the repository manager already — a fourth doorway to them here only made the
   menu longer without making anything reachable that was not. */
$('side-repo').addEventListener('click', async (e) => {
  if (!state.repo) return;
  const path = state.repo.path;
  const remotes = (await call('repo:remotes', path)) || [];
  // origin by convention, but a repository that renamed it still gets an entry.
  const remote = remotes.find((r) => r.name === 'origin') || remotes[0] || null;
  const favorites = (await call('repos:list'))?.favorites || [];
  const isFavorite = favorites.includes(path);

  contextMenu(e, [
    { label: 'Repository management…', accel: 'Ctrl+Shift+O', run: openRepoManager },
    '-',
    { label: 'Copy repository path', run: () => copyText(path, 'Repository path copied') },
    { label: remote ? `Copy ${remote.name} URL` : 'Copy remote URL',
      disabled: !remote,
      hint: remote ? remote.url : 'This repository has no remote yet',
      run: () => copyText(remote.url, `${remote.name} URL copied`) },
    '-',
    { label: 'Show in file manager', accel: 'Alt+O',
      run: () => call('shell:openPath', path) },
    { label: 'Open in terminal', accel: 'Alt+T', run: MENU_ACTIONS.terminal },
    { label: 'Open in code editor', run: openRepoInEditor },
    '-',
    { label: 'Favorite this repository', checked: isFavorite,
      hint: 'Favorites sit at the top of the repository manager',
      run: async () => {
        await call('repos:favorite', path, !isFavorite);
        setStatus(isFavorite ? `${state.repo.name} unfavorited` : `${state.repo.name} favorited`, 'ok');
      } },
    '-',
    { label: 'Close tab', accel: 'Ctrl+W', run: () => closeTab() },
  ]);
});

const copyText = (text, said) => {
  navigator.clipboard.writeText(text);
  setStatus(said, 'ok');
};

/** Hands the repository folder — not a file — to whichever editor is installed. */
async function openRepoInEditor() {
  const where = await call('shell:openInEditor', state.repo.path, state.repo.path);
  if (where !== null) setStatus(`Opened ${state.repo.name} in ${where}`, 'ok');
}

$('btn-fetch').addEventListener('click', () =>
  gitAction('btn-fetch', 'Fetching',
    () => call('repo:fetch', repoPath(), { prune: prefs.autoPrune }),
    async () => { await refresh(); setStatus('Fetched all remotes', 'ok'); }));

$('btn-pull').addEventListener('click', () => pull());

/* Fast-forward first: it is the only outcome that neither merges nor rewrites
   anything. Only when that is impossible is there a decision to make, and it is
   yours — the shape of your history is not something to settle silently. */
async function pull(mode = 'ff') {
  let out = '';
  const ok = await gitAction('btn-pull', 'Pulling',
    async () => (out = await call('repo:pull', repoPath(), { mode })),
    async () => {
      await refresh();
      setStatus(nothingHappened(out)
        ? 'Already up to date — nothing to pull'
        : (mode === 'ff' ? 'Pulled' : `Pulled with ${mode}`),
        nothingHappened(out) ? '' : 'ok');
    });
  if (ok || mode !== 'ff') {
    // A merge pull can stop on a conflict; the banner takes over from here.
    if (!ok) await refresh({ keepSelection: false });
    return;
  }
  if (!diverged()) return;         // it failed for some other reason, already reported
  await askHowToPull();
}

/** True when the branch has commits of its own as well as commits to collect. */
function diverged() {
  const s = state.status;
  return Boolean(s?.ahead && s?.behind);
}

async function askHowToPull() {
  const s = state.status;
  const r = await modal({
    title: 'The histories have diverged',
    description:
      `${s.branch} has ${s.ahead} commit${s.ahead === 1 ? '' : 's'} of its own, and ` +
      `${s.upstream || 'the remote'} has ${s.behind} you do not have. ` +
      'Fast-forward is impossible, so the two lines have to be joined somehow.',
    fields: [{
      name: 'mode', type: 'choice', value: 'merge',
      options: [
        { value: 'merge', label: 'Merge',
          help: 'Keeps both histories as they are and ties them together with a merge commit.' },
        { value: 'rebase', label: 'Rebase',
          help: 'Replays your commits on top of theirs. A straight line, but your commits are rewritten.' },
      ],
    }],
    confirmLabel: 'Pull',
  });
  if (!r) return;
  await pull(r.mode);
}

$('btn-push').addEventListener('click', () => push(false));

$('btn-push').addEventListener('contextmenu', (e) =>
  contextMenu(e, [
    { label: 'Push', run: () => push(false) },
    { label: 'Force push (with lease)', danger: true, run: () => push(true) },
  ])
);

$('btn-branch').addEventListener('click', () => newBranch(null));

$('btn-pop').addEventListener('click', () => {
  if (!state.stashes[0]) return;   // aria-disabled does not block clicks by itself
  applyStash(state.stashes[0].ref, true);
});

$('btn-stash').addEventListener('click', async () => {
  const r = await modal({
    title: 'Stash changes',
    fields: [
      { name: 'message', label: 'Description', placeholder: 'work in progress' },
      { name: 'untracked', type: 'checkbox', label: 'Include untracked files', value: true },
    ],
    confirmLabel: 'Stash',
  });
  if (!r) return;
  await gitAction('btn-stash', 'Stashing',
    () => call('repo:stashSave', repoPath(), r.message, r.untracked),
    async () => { await refresh({ keepSelection: false }); setStatus('Stashed your changes', 'ok'); });
});

/* sidebar interactions */
$('sidebar').addEventListener('click', (e) => {
  const head = e.target.closest('.side-head');
  if (head) {
    const group = head.closest('.side-group');
    group.classList.toggle('collapsed');
    saveGroups();
    return;
  }
  const folder = e.target.closest('li[data-folder]');
  if (folder) {
    toggleFolder(folder.dataset.kind, folder.dataset.folder);
    return;
  }
  const li = e.target.closest('li[data-ref]');
  if (!li) return;
  const { ref, kind } = li.dataset;
  // One click looks, two clicks act. Checking out on a single click meant
  // browsing the sidebar changed the repository under you.
  if (kind === 'branch' || kind === 'tag' || kind === 'remote') revealRef(ref, kind);
});

$('sidebar').addEventListener('dblclick', (e) => {
  const li = e.target.closest('li[data-ref]');
  if (!li) return;
  const { ref, kind } = li.dataset;
  if (kind === 'branch' || kind === 'tag') checkout(ref);
  else if (kind === 'remote') {
    // Checking out a remote branch means working on the local one that follows
    // it; git creates that branch on the spot if it does not exist yet.
    checkout(ref.split('/').slice(1).join('/'));
  }
});

/* ═════ branch commands ═════════════════════════════════════════ */

/** Tag anything that resolves: a commit hash, a branch, another tag. */
async function tagAt(target) {
  const short = /^[0-9a-f]{7,40}$/.test(target) ? target.slice(0, 7) : target;
  const r = await modal({
    title: 'New tag',
    description: `Tagging ${short}`,
    fields: [
      { name: 'name', label: 'Tag name', placeholder: 'v1.2.0', required: true },
      { name: 'message', label: 'Message (optional)', placeholder: 'Release notes' },
    ],
    confirmLabel: 'Create tag',
  });
  if (!r || !r.name) return;
  const res = await call('repo:tag', repoPath(), r.name, target, r.message);
  if (res !== null) { await refresh(); setStatus(`Tagged ${r.name}`, 'ok'); }
}

async function deleteBranch(ref) {
  const ok = await confirmAction(
    'Delete branch', `${ref} will be removed from this repository.`, 'Delete');
  if (!ok) return;
  let res = await call('repo:deleteBranch', repoPath(), ref, false);
  if (res === null) {
    const force = await confirmAction('Not fully merged',
      `${ref} has commits that are not merged anywhere. Delete it anyway?`, 'Force delete');
    if (!force) return;
    res = await call('repo:deleteBranch', repoPath(), ref, true);
  }
  if (res !== null) { await refresh({ keepSelection: false }); setStatus(`Deleted ${ref}`, 'ok'); }
}

async function renameBranch(ref) {
  const r = await modal({
    title: `Rename ${ref}`,
    fields: [{ name: 'name', label: 'New name', value: ref, required: true }],
    confirmLabel: 'Rename',
  });
  if (!r || r.name === ref) return;
  const res = await call('repo:renameBranch', repoPath(), ref, r.name);
  if (res === null) return;
  await refresh({ keepSelection: false });
  setStatus(`Renamed to ${r.name}`, 'ok');
}

async function setUpstream(ref, current) {
  const r = await modal({
    title: `Tracking branch for ${ref}`,
    description: 'Which remote branch this one is compared against, pulled from and pushed to.',
    fields: [{
      name: 'upstream', label: 'Upstream', value: current || '',
      placeholder: 'origin/' + ref + ' — leave empty to untrack',
    }],
    confirmLabel: 'Save',
  });
  if (!r) return;
  const res = await call('repo:setUpstream', repoPath(), ref, r.upstream);
  if (res === null) return;
  await refresh();
  setStatus(r.upstream ? `${ref} now tracks ${r.upstream}` : `${ref} no longer tracks anything`, 'ok');
}

async function editDescription(ref) {
  const now = await call('repo:description', repoPath(), ref);
  if (now === null) return;
  const r = await modal({
    title: `Description for ${ref}`,
    description: 'Kept in this repository’s config, and shown by git itself in merge messages.',
    fields: [{ name: 'text', label: 'Description', value: now, placeholder: 'What this branch is for' }],
    confirmLabel: 'Save',
  });
  if (!r) return;
  const res = await call('repo:setDescription', repoPath(), ref, r.text);
  if (res !== null) setStatus(r.text ? `Description saved for ${ref}` : 'Description cleared', 'ok');
}

/** Show what a ref carries that HEAD does not, in the middle pane. */
async function compareWithHead(ref) {
  state.file = null;
  state.compareRef = ref;
  await renderViewer();
}

/** Whichever of the two things the middle pane can show, drawn afresh. */
async function renderViewer() {
  if (state.compareRef) return showCompare();
  if (state.file) return showFileDiff();
  closeFile();
}

async function showCompare() {
  const ref = state.compareRef;
  const raw = await call('repo:compare', repoPath(), 'HEAD', ref,
    viewer.ignoreWhitespace, viewer.allLines ? 100000 : 3);
  if (raw === null) return;
  state.diffFiles = window.Diff.parse(raw || '');
  state.diffContext = 'compare';

  $('app').classList.add('viewing-file');
  $('fileview').hidden = false;
  $('fv-status').textContent = '↔';
  $('fv-status').className = 'fv-status';
  $('fv-path').textContent = `HEAD → ${ref}`;
  $('fv-path').title = `What ${ref} has that HEAD does not`;

  const totals = state.diffFiles.reduce(
    (a, d) => ({ add: a.add + d.additions, del: a.del + d.deletions }), { add: 0, del: 0 });
  $('fv-stat').innerHTML =
    `<span class="stat-add">+${totals.add}</span> <span class="stat-del">−${totals.del}</span>`;

  $('fv-stage-tools').hidden = true;
  syncViewerToggles();
  const opts = { path: '', highlight: false };   // a comparison spans many files
  $('fv-body').innerHTML = state.diffFiles.length
    ? (viewer.split ? window.Diff.renderSplit(state.diffFiles, [], opts)
                    : window.Diff.render(state.diffFiles, [], opts))
    : `<div class="empty-note">${esc(ref)} has nothing that HEAD does not already have.</div>`;
  indexBlocks();
  setStatus(`Comparing HEAD with ${ref}`, 'ok');
}

async function fastForward(b) {
  await gitAction(null, `Fast-forwarding ${b.name}`,
    () => call('repo:fastForward', repoPath(),
      { branch: b.name, upstream: b.upstream, current: b.current }),
    async () => { await refresh(); setStatus(`${b.name} fast-forwarded to ${b.upstream}`, 'ok'); });
}

async function fetchInto(b) {
  let out = '';
  await gitAction('btn-fetch', `Fetching ${b.upstream}`,
    async () => (out = await call('repo:fetchInto', repoPath(), {
      remote: b.upstream.slice(0, b.upstream.indexOf('/')),
      branch: b.name, upstream: b.upstream, current: b.current,
    })),
    async () => { await refresh(); setStatus(`${b.name}: ${out}`, 'ok'); });
}

async function pushBranch(b, force = false) {
  const remote = b.upstream
    ? b.upstream.slice(0, b.upstream.indexOf('/'))
    : (state.refs.remotes[0]?.name.split('/')[0] || 'origin');
  if (force) {
    const ok = await confirmAction('Force push',
      `${b.name} will overwrite ${remote}/${b.name}. Commits on the remote that you do ` +
      'not have will be lost.', 'Force push');
    if (!ok) return;
  }
  await gitAction('btn-push', force ? `Force pushing ${b.name}` : `Pushing ${b.name}`,
    () => call('repo:pushBranch', repoPath(),
      { branch: b.name, remote, setUpstream: !b.upstream, force }),
    async () => { await refresh(); setStatus(`Pushed ${b.name} to ${remote}`, 'ok'); });
}

$('sidebar').addEventListener('contextmenu', (e) => {
  const li = e.target.closest('li[data-ref]');
  if (!li) return;
  const { ref, kind } = li.dataset;

  if (kind === 'branch') {
    const b = state.refs.branches.find((x) => x.name === ref) || { name: ref };
    const head = state.status?.branch;
    const behind = /behind/.test(b.track || '');
    const hasRemote = state.refs.remotes.length > 0;

    contextMenu(e, [
      { label: `Check out ${ref}`, disabled: b.current,
        hint: b.current ? 'Already checked out' : '', run: () => checkout(ref) },
      { label: b.upstream ? `Fast-forward to ${b.upstream}` : 'Fast-forward to upstream',
        disabled: !b.upstream || !behind,
        hint: !b.upstream ? 'This branch tracks nothing'
            : !behind ? 'Already up to date with its upstream' : '',
        run: () => fastForward(b) },
      { label: b.upstream ? `Fetch ${b.upstream} into ${ref}` : 'Fetch into this branch',
        disabled: !b.upstream, hint: b.upstream ? '' : 'This branch tracks nothing',
        run: () => fetchInto(b) },
      { label: `Push ${ref}…`, disabled: !hasRemote,
        hint: hasRemote ? '' : 'This repository has no remote', run: () => pushBranch(b) },
      '-',
      /* Merging a branch that is already contained succeeds and changes
         nothing, which only becomes clear afterwards. Say it beforehand — but
         still allow it, since the answer comes from the commits loaded so far
         and must not turn into a wall. */
      { label: `Merge ${ref} into ${head || 'current'}`
          + (alreadyIn(ref) ? ' — already merged' : ''), disabled: b.current,
        hint: b.current ? 'A branch cannot be merged into itself'
          : alreadyIn(ref) ? `${head} already contains every commit of ${ref}` : '',
        run: () => mergeBranch(ref) },
      { label: `Rebase ${head || 'current'} onto ${ref}`, disabled: b.current,
        hint: b.current ? 'A branch cannot be rebased onto itself'
          : alreadyIn(ref) ? `${head} is already on top of ${ref}` : '',
        run: () => rebaseOnto(ref) },
      { label: 'Compare with HEAD', disabled: b.current,
        hint: b.current ? 'This is HEAD' : '', run: () => compareWithHead(ref) },
      '-',
      { label: `New branch from ${ref}…`, run: () => newBranch(ref) },
      { label: `New tag at ${ref}…`, run: () => tagAt(ref) },
      { label: 'Set tracking branch…', run: () => setUpstream(ref, b.upstream) },
      { label: 'Edit description…', run: () => editDescription(ref) },
      '-',
      { label: `Rename ${ref}…`, run: () => renameBranch(ref) },
      { label: `Delete ${ref}`, danger: true, disabled: b.current,
        hint: b.current ? 'You cannot delete the branch you are on' : '',
        run: () => deleteBranch(ref) },
      '-',
      { label: 'Copy branch name', run: () => {
          navigator.clipboard.writeText(ref);
          setStatus('Branch name copied', 'ok');
        } },
    ]);
  } else if (kind === 'stash') {
    contextMenu(e, [
      { label: 'Apply and keep', run: () => applyStash(ref, false) },
      { label: 'Apply and drop', run: () => applyStash(ref, true) },
      '-',
      { label: 'Drop stash', danger: true, run: async () => {
          const ok = await confirmAction('Drop stash', 'This stash cannot be recovered.', 'Drop');
          if (!ok) return;
          const res = await call('repo:stashDrop', repoPath(), ref);
          if (res !== null) { await refresh(); setStatus('Dropped stash', 'ok'); }
        } },
    ]);
  } else if (kind === 'remote') {
    const remote = ref.slice(0, ref.indexOf('/'));
    const local = ref.slice(ref.indexOf('/') + 1);
    const head = state.status?.branch;
    contextMenu(e, [
      { label: `Check out ${local}`, run: () => checkout(local) },
      '-',
      { label: `Merge ${ref} into ${head || 'current'}`, run: () => mergeBranch(ref) },
      { label: `Rebase ${head || 'current'} onto ${ref}`, run: () => rebaseOnto(ref) },
      { label: 'Compare with HEAD', run: () => compareWithHead(ref) },
      '-',
      { label: `New branch from ${ref}…`, run: () => newBranch(ref) },
      { label: `New tag at ${ref}…`, run: () => tagAt(ref) },
      '-',
      { label: `Delete ${ref} on ${remote}`, danger: true, run: async () => {
          const ok = await confirmAction('Delete remote branch',
            `${local} will be deleted on ${remote}. Everyone fetching from it will lose the branch.`,
            'Delete on remote');
          if (!ok) return;
          setStatus(`Deleting ${ref}…`);
          const res = await call('repo:deleteRemoteBranch', repoPath(), remote, local);
          if (res !== null) { await refresh(); setStatus(`Deleted ${ref}`, 'ok'); }
        } },
      '-',
      { label: 'Copy branch name', run: () => {
          navigator.clipboard.writeText(ref);
          setStatus('Branch name copied', 'ok');
        } },
    ]);
  } else if (kind === 'tag') {
    contextMenu(e, [
      { label: `Check out ${ref}`, run: () => checkout(ref) },
      { label: 'Compare with HEAD', run: () => compareWithHead(ref) },
      '-',
      { label: `New branch from ${ref}…`, run: () => newBranch(ref) },
      '-',
      { label: `Delete tag ${ref}`, danger: true, run: async () => {
          const ok = await confirmAction('Delete tag',
            `${ref} will be removed from this repository. Any copy already pushed stays on the remote.`,
            'Delete');
          if (!ok) return;
          const res = await call('repo:deleteTag', repoPath(), ref);
          if (res !== null) { await refresh(); setStatus(`Deleted tag ${ref}`, 'ok'); }
        } },
      '-',
      { label: 'Copy tag name', run: () => {
          navigator.clipboard.writeText(ref);
          setStatus('Tag name copied', 'ok');
        } },
    ]);
  }
});

/* commit list */
$('commit-list').addEventListener('click', (e) => {
  const row = e.target.closest('.commit-row');
  if (!row) return;
  state.file = null;
  state.mergeSide = 'in';   // the side chosen on another merge does not carry over
  state.selection = row.dataset.wip ? { kind: 'wip' } : { kind: 'commit', hash: row.dataset.hash };
  paintSelection();
  renderDetail();
});

$('commit-list').addEventListener('contextmenu', (e) => {
  const row = e.target.closest('.commit-row[data-hash]');
  if (!row) return;
  const hash = row.dataset.hash;
  const short = hash.slice(0, 7);
  contextMenu(e, [
    { label: 'Copy SHA', run: () => navigator.clipboard.writeText(hash) },
    { label: `Check out ${short}`, run: () => checkout(hash) },
    { label: 'Branch from here', run: () => newBranch(hash) },
    '-',
    { label: 'Cherry-pick onto current', run: async () => {
        const res = await call('repo:cherryPick', repoPath(), hash);
        if (res !== null) { await refresh({ keepSelection: false }); setStatus(`Cherry-picked ${short}`, 'ok'); }
      } },
    { label: 'Revert this commit', run: async () => {
        const res = await call('repo:revert', repoPath(), hash);
        if (res !== null) { await refresh({ keepSelection: false }); setStatus(`Reverted ${short}`, 'ok'); }
      } },
    '-',
    { label: 'Reset branch to here (keep changes)', run: () => resetTo(hash, 'mixed') },
    { label: 'Reset branch to here (discard changes)', danger: true, run: () => resetTo(hash, 'hard') },
  ]);
});

async function resetTo(hash, mode) {
  const ok = await confirmAction(
    'Reset branch',
    mode === 'hard'
      ? `Your branch will point at ${hash.slice(0, 7)} and every uncommitted change will be destroyed.`
      : `Your branch will point at ${hash.slice(0, 7)}. Your files stay as they are.`,
    'Reset',
    mode === 'hard'
  );
  if (!ok) return;
  const res = await call('repo:reset', repoPath(), hash, mode);
  if (res !== null) { await refresh({ keepSelection: false }); setStatus('Branch reset', 'ok'); }
}

/* Scrolling changes which rows exist, so it has to redraw — but only once per
   frame, and only when the band has actually moved off what is on screen. */
let rowsQueued = false;
$('history-scroll').addEventListener('scroll', () => {
  if (!state.layout || rowsQueued) return;
  rowsQueued = true;
  requestAnimationFrame(() => {
    rowsQueued = false;
    const shown = state.rowsShown;
    const need = requiredRange(state.layout.rows.length);
    // Still covered by what is on the page: the cheapest frame is the one that
    // does nothing at all.
    if (need.first >= shown.first && need.last <= shown.last) return;
    renderRows();
  });
}, { passive: true });

$('btn-more').addEventListener('click', async () => {
  state.limit += prefs.commitLimit;
  await refresh();
});

/* Tombol aksi commit (checkout, cherry-pick, revert, reset) tidak lagi di
   panel ini — semuanya tetap tersedia lewat klik kanan pada baris commit. */
$('c-hash').addEventListener('click', () => {
  navigator.clipboard.writeText($('c-hash').dataset.hash || '');
  setStatus('Full SHA copied', 'ok');
});

/* file lists */
function wireFileList(id) {
  $(id).addEventListener('click', async (e) => {
    const folder = e.target.closest('li[data-folder]');
    if (folder) { toggleFolder(folder.dataset.kind, folder.dataset.folder); return; }
    const li = e.target.closest('li[data-path]');
    if (!li) return;
    const act = e.target.closest('.f-act');
    const path = li.dataset.path;
    if (act) {
      e.stopPropagation();
      const what = act.dataset.act;
      if (what === 'stage') return stage([path]);
      if (what === 'unstage') return unstage([path]);
      if (what === 'discard') return discard(path, li.dataset.untracked === '1');
      if (what === 'ours' || what === 'theirs' || what === 'mark') {
        return resolveConflict(path, what);
      }
    }
    state.file = { path, kind: li.dataset.kind, status: li.dataset.status,
                   untracked: li.dataset.untracked === '1' };
    $(id).querySelectorAll('li').forEach((n) => n.classList.remove('selected'));
    li.classList.add('selected');
    await showFileDiff();
  });
}
['list-conflicts', 'list-staged', 'list-unstaged', 'list-commit-files'].forEach(wireFileList);

/* ── file filter ── */
$('file-filter').addEventListener('input', (e) => {
  wipFilter = e.target.value.trim().toLowerCase();
  $('btn-filter-clear').hidden = !wipFilter;
  if (!state.status) return;
  renderWip();
  if (wipFilter) {
    const shown = document.querySelectorAll(
      '#list-staged li[data-path], #list-unstaged li[data-path]').length;
    setStatus(`${shown} file${shown === 1 ? '' : 's'} match “${wipFilter}”`);
  }
});

$('btn-filter-clear').addEventListener('click', () => {
  $('file-filter').value = '';
  $('file-filter').dispatchEvent(new Event('input'));
  setStatus('Ready');
});

$('btn-discard-all').addEventListener('click', async () => {
  const s = state.status;
  const paths = [...s.conflicted, ...s.unstaged, ...s.untracked];
  if (!paths.length) { setStatus('Nothing to discard', 'ok'); return; }
  const ok = await confirmAction(
    'Discard all changes',
    `${paths.length} file${paths.length === 1 ? '' : 's'} will go back to their last committed ` +
    'state, and untracked files will be deleted. This cannot be undone.',
    'Discard everything'
  );
  if (!ok) return;
  for (const f of paths) {
    await call('repo:discard', repoPath(), [f.path], f.status === '?');
  }
  closeFile();
  await refresh();
  setStatus(`Discarded ${paths.length} file${paths.length === 1 ? '' : 's'}`, 'ok');
});

/* ── per-file context menu ── */
for (const id of ['list-conflicts', 'list-staged', 'list-unstaged', 'list-commit-files']) {
  $(id).addEventListener('contextmenu', (e) => {
    const li = e.target.closest('li[data-path]');
    if (!li) return;
    const { path, kind } = li.dataset;
    const untracked = li.dataset.untracked === '1';
    const items = [];
    if (kind === 'conflict') {
      items.push({ label: 'Keep your version', run: () => resolveConflict(path, 'ours') });
      items.push({ label: 'Keep their version', run: () => resolveConflict(path, 'theirs') });
      items.push({ label: 'Mark resolved', run: () => resolveConflict(path, 'mark') });
      items.push('-');
    }
    if (kind === 'unstaged') items.push({ label: 'Stage this file', run: () => stage([path]) });
    if (kind === 'staged') items.push({ label: 'Unstage this file', run: () => unstage([path]) });
    if (kind !== 'commit') {
      items.push({ label: 'Discard changes', danger: true, run: () => discard(path, untracked) });
      items.push('-');
    }
    items.push(
      { label: 'Open in editor', run: () => openInEditor(path) },
      { label: 'Show in file manager',
        run: () => call('shell:openPath', `${repoPath()}/${path}`.replace(/\/[^/]*$/, '')) },
      '-',
      { label: 'Copy path', run: () => {
          navigator.clipboard.writeText(path);
          setStatus('File path copied', 'ok');
        } },
    );
    contextMenu(e, items);
  });
}

$('btn-stage-all').addEventListener('click', async () => {
  await call('repo:stageAll', repoPath());
  await refresh();
});
$('btn-unstage-all').addEventListener('click', async () => {
  await call('repo:unstageAll', repoPath());
  await refresh();
});

/* hunk buttons */
$('fv-body').addEventListener('click', (e) => {
  const btn = e.target.closest('[data-hunk-action]');
  if (!btn) return;
  applyHunk(Number(btn.dataset.file), Number(btn.dataset.hunk), btn.dataset.hunkAction);
});

/* commit box */
$('commit-msg').addEventListener('input', renderCommitBox);
$('commit-body').addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') doCommit();
});
$('commit-msg').addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') doCommit();
});
$('btn-commit').addEventListener('click', doCommit);
$('chk-amend').addEventListener('change', async () => {
  if ($('chk-amend').checked && !$('commit-msg').value.trim()) {
    const last = await call('repo:lastMessage', repoPath());
    if (last) {
      // Split on the blank line git itself uses between subject and body.
      const at = last.indexOf('\n\n');
      $('commit-msg').value = at < 0 ? last.trim() : last.slice(0, at).trim();
      $('commit-body').value = at < 0 ? '' : last.slice(at + 2).trim();
      renderCommitBox();
    }
  }
});

/* keyboard — Ctrl+O/N/I, the zoom keys, F5 and the panel toggles are all
   menu accelerators now, handled in the main process. */
document.addEventListener('keydown', (e) => {
  // Esc backs out of whatever is covering the history, in front-to-back order.
  if (e.key === 'Escape' && $('modal').hidden) {
    if (!$('ctxmenu').hidden) { closeContextMenu(); return; }
    if (!$('logs').hidden) { closeLogs(); return; }
    if (!$('prefs').hidden) { closePrefs(); return; }
    if (!$('about').hidden) { closeAbout(); return; }
    if (!$('notes').hidden) { closeNotes(); return; }
    if ($('app').classList.contains('managing')) { closeRepoManager(); return; }
    if ($('app').classList.contains('viewing-file')) { closeFile(); return; }
  }
  if ((e.ctrlKey || e.metaKey) && (e.key === '`' || e.key === '~')) {
    e.preventDefault(); toggleTerm(); return;
  }
  if (e.altKey && !$('fileview').hidden) {
    if (e.key === 'ArrowDown') { e.preventDefault(); gotoBlock(nav.at + 1); return; }
    if (e.key === 'ArrowUp') { e.preventDefault(); gotoBlock(nav.at <= 0 ? 0 : nav.at - 1); return; }
    if (e.key === 'Home') { e.preventDefault(); gotoBlock(0); return; }
    if (e.key === 'End') { e.preventDefault(); gotoBlock(nav.blocks.length - 1); return; }
  }
  if (e.target.matches('input, textarea')) return;
  if (!state.repo) return;
  if (e.key === 'r' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); refresh(); }
  else if (e.key === 'f') $('btn-fetch').click();
  else if (e.key === 'p') $('btn-pull').click();
  else if (e.key === 'P') $('btn-push').click();
  else if (e.key === 'b') newBranch(null);
});

/* pane resizing */
document.querySelectorAll('.drag-handle').forEach((handle) => {
  handle.addEventListener('mousedown', (down) => {
    down.preventDefault();
    const which = handle.dataset.resize;
    const startX = down.clientX;
    const root = document.documentElement;
    // Measure the pane itself: the widths default to clamp(), which
    // getPropertyValue hands back unresolved.
    const pane = el(which === 'sidebar' ? '.sidebar' : '.detail');
    const startW = pane.getBoundingClientRect().width;

    const onMove = (move) => {
      const delta = which === 'sidebar' ? move.clientX - startX : startX - move.clientX;
      const next = Math.min(700, Math.max(160, startW + delta));
      root.style.setProperty(which === 'sidebar' ? '--sidebar-w' : '--detail-w', next + 'px');
    };
    const onUp = () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  });
});

/* auto-refresh when the window regains focus */
let lastFocusRefresh = 0;
window.addEventListener('focus', () => {
  if (state.repo && Date.now() - lastFocusRefresh > 1500) {
    lastFocusRefresh = Date.now();
    refresh();
  }
});

/* ═════ drag a folder onto the window ═══════════════════════════ */

/* dragenter/dragleave fire for every child element, so nesting is counted
   rather than toggled — otherwise the overlay flickers as the cursor moves. */
let dragDepth = 0;

const hasFiles = (e) => [...(e.dataTransfer?.types || [])].includes('Files');

function setDropping(on) {
  $('dropzone').hidden = !on;
  $('app').classList.toggle('drop-active', on);
}

window.addEventListener('dragenter', (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  if (++dragDepth === 1) setDropping(true);
});
window.addEventListener('dragover', (e) => {
  if (hasFiles(e)) e.preventDefault();
});
window.addEventListener('dragleave', () => {
  if (dragDepth && --dragDepth === 0) setDropping(false);
});
window.addEventListener('drop', async (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  dragDepth = 0;
  setDropping(false);
  const file = e.dataTransfer.files[0];
  if (!file) return;
  // Dropping a file inside a repository still means "open that repository":
  // repo:open resolves whatever path it gets to the work tree root.
  const dropped = window.gitbraid.pathForFile(file);
  if (dropped) await openRepoAt(dropped);
});

/* ═════ startup ═════════════════════════════════════════════════ */

(async () => {
  applyColumns();
  applyPrefs();
  renderZoomLevel();
  if (term.open) showTerm();
  call('app:about').then((i) => { if (i) $('sb-version').textContent = i.version; });
  loadPanels();
  loadGroups();
  await applyZoom(storedZoom(), false);
  await syncMenu();
  appPaths = (await call('app:paths')) || appPaths;
  // renderShell() refreshes this later, but on a first boot with no repository
  // to resume it never runs — and the chip would sit empty.
  await loadIdentity();
  await loadRecents();

  /* Pick up where you left off: the whole set of tabs, not just one of them.
     Folders that have since been deleted are dropped rather than restored as
     tabs that break the moment they are clicked. The start page is for a
     genuinely fresh install. */
  const endBooting = () => $('app').classList.remove('is-booting');
  const saved = storedTabs();
  let restore = [];
  if (prefs.resumeLast && saved.paths.length) {
    restore = (await call('repos:existing', saved.paths)) || [];
  }
  // Nothing saved yet — an install that predates tab restoring still lands in
  // the repository it used last.
  const single = !restore.length && prefs.resumeLast && recents[0] ? recents[0] : null;

  if (restore.length) {
    $('booting-text').textContent = restore.length === 1
      ? `Opening ${baseName(restore[0])}…`
      : `Opening ${restore.length} repositories…`;
  } else if (single) {
    $('booting-text').textContent = `Opening ${single.name}…`;
  } else {
    endBooting();
  }

  // Only now may the window appear: whichever page it shows is the right one.
  call('app:ready');

  if (restore.length) {
    /* Every tab exists straight away, but only the active one loads its
       history: an inactive tab holds a path and nothing else until you click
       it, which is what keeps ten open repositories cheap. */
    for (const p of restore) tabs.push(newTab({ path: p, name: baseName(p) }));
    renderTabs();
    const at = Math.max(0, restore.indexOf(saved.active));
    await activateTab(tabs[at].id);
    endBooting();
  } else if (single) {
    await openRepoAt(single.path);
    endBooting();               // also on failure — the start page is the fallback
  }
})();
