/* Renderer pieces that can be judged without a window: the search highlight,
 * the syntax tables, the live git-output pane and the avatar colours. Each is
 * lifted out of the file that ships, the way parsers.test.js lifts notesHtml,
 * so what passes here is the code the window runs. The keyboard, the dialog
 * and the commit list need a real window and are driven in Electron instead. */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { reporter, ROOT } = require('./harness');

const { check, section, done } = reporter();

const rendererSrc = fs.readFileSync(path.join(ROOT, 'src/renderer.js'), 'utf8');
const styleSrc = fs.readFileSync(path.join(ROOT, 'src/styles.css'), 'utf8');
const hlSrc = fs.readFileSync(path.join(ROOT, 'src/highlight.js'), 'utf8');

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ESC[c]);

/* The source between two markers, run in a fresh context. A marker that is not
   there answers null, so a missing function is a failed check, not a crash. */
function lift(from, to, names, ctx = {}) {
  const a = rendererSrc.indexOf(from);
  const b = rendererSrc.indexOf(to, a + 1);
  if (a < 0 || b < 0) return null;
  const out = {};
  const exports = names.map((n) => `try { __out.${n} = ${n}; } catch {}`).join('\n');
  vm.runInNewContext(`${rendererSrc.slice(a, b)}\n${exports}`, { ...ctx, esc, __out: out });
  return out;
}

/* ── search highlight ───────────────────────────────────────── */

section('the search highlight');
{
  const { highlight } = lift('function highlight(text, query) {', '/* What a search reads', ['highlight']);
  check('İ, which lowers to two characters, does not push the mark along',
    highlight('İİİ fix the bug', 'fix') === 'İİİ <mark>fix</mark> the bug',
    highlight('İİİ fix the bug', 'fix'));
  check('a mark on the İ itself takes the whole letter',
    highlight('Ünİversite', 'i') === 'Ün<mark>İ</mark>vers<mark>i</mark>te',
    highlight('Ünİversite', 'i'));
  check('every hit after several İ is still where it is',
    highlight('İzmir İzmir zmir', 'zmir') === 'İ<mark>zmir</mark> İ<mark>zmir</mark> <mark>zmir</mark>',
    highlight('İzmir İzmir zmir', 'zmir'));
  check('the text around a mark stays escaped',
    highlight('İ <b> & "fix"', 'fix') === 'İ &lt;b&gt; &amp; &quot;<mark>fix</mark>&quot;',
    highlight('İ <b> & "fix"', 'fix'));
  // Where lowering keeps every length, the answer is the one it always was.
  const plain = (text, q) => {
    const hay = text.toLowerCase();
    const needle = q.toLowerCase();
    let out = '';
    let i = 0;
    for (;;) {
      const at = hay.indexOf(needle, i);
      if (at < 0) return out + esc(text.slice(i));
      out += esc(text.slice(i, at)) + '<mark>' + esc(text.slice(at, at + needle.length)) + '</mark>';
      i = at + needle.length;
    }
  };
  let seed = 7;
  const rnd = (n) => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % n; };
  const ABC = 'aAbB <&>"\'éÉxX';
  let differ = null;
  for (let k = 0; k < 3000 && !differ; k++) {
    const t = Array.from({ length: 1 + rnd(30) }, () => ABC[rnd(ABC.length)]).join('');
    const q = Array.from({ length: 1 + rnd(3) }, () => ABC[rnd(ABC.length)]).join('');
    if (highlight(t, q) !== plain(t, q)) differ = { t, q };
  }
  check('on text whose lowercase keeps its length nothing changed (3,000 random cases)', !differ, differ);
}

/* ── syntax tables ──────────────────────────────────────────── */

section('the syntax tables');
{
  const ctx = { window: {} };
  vm.createContext(ctx);
  vm.runInContext(hlSrc, ctx);
  const H = ctx.window.Hl;
  const cls = (lang, code) =>
    [...H.line(code, lang).matchAll(/class="hl-(\w+)">([^<]*)</g)].map((m) => m[1] + ':' + m[2]).join('|');

  const life = cls('rust', 'fn foo<\'a>(x: &\'a str) -> &\'a str { "hi" }');
  check('a Rust lifetime is a lifetime, not the start of a string',
    life === 'key:fn|op:&lt;|attr:&#39;a|op:&gt;|op::|op:&amp;|attr:&#39;a|op:-&gt;|op:&amp;|attr:&#39;a|str:&quot;hi&quot;',
    life);
  const chars = cls('rust', 'let c = \'a\'; let n = \'\\n\'; \'outer: loop {}');
  check('and a char literal is still a string, a loop label a lifetime',
    chars === 'key:let|op:=|str:&#39;a&#39;|key:let|op:=|str:&#39;\\n&#39;|attr:&#39;outer|op::|key:loop',
    chars);
  check("'static is one token",
    cls('rust', "const S: &'static str = \"x\";") === 'key:const|op::|op:&amp;|attr:&#39;static|op:=|str:&quot;x&quot;',
    cls('rust', "const S: &'static str = \"x\";"));

  const rb = cls('ruby', 'return x if defined?(x) && list.empty? || save!(y)');
  check('Ruby: defined? is a keyword, with or without its bracket, and ?/! end a method name',
    rb === 'key:return|key:if|key:defined?|op:&amp;&amp;|op:|||fn:save!',
    rb);
  check('Ruby: a != right after a name is still the operator',
    cls('ruby', 'a!=b') === 'op:!=' && cls('ruby', 'x.nil? ? 1 : 2') === 'op:?|num:1|op::|num:2',
    [cls('ruby', 'a!=b'), cls('ruby', 'x.nil? ? 1 : 2')]);
  check('the other C-like tables still call a keyword before a bracket a call, as they did',
    cls('js', 'if (x) foo(1)') === 'fn:if|fn:foo|num:1', cls('js', 'if (x) foo(1)'));
}

/* ── the live git-output pane ───────────────────────────────── */

section('the live git-output pane');
{
  /* A stand-in for the few DOM calls the pane makes. A template's markup comes
     back as one node holding that markup; a string appended is a text node.
     The pane's markup is the nodes' markup in order — what innerHTML would
     serialise, without a parser. */
  class Raw {
    constructor(html) { this.html = html; this.parent = null; }
    remove() {
      if (!this.parent) return;
      this.parent.kids.splice(this.parent.kids.indexOf(this), 1);
      this.parent = null;
    }
  }
  const document = {
    createElement: () => {
      const t = { content: { childNodes: [] } };
      Object.defineProperty(t, 'innerHTML', { set(h) { t.content.childNodes = h ? [new Raw(h)] : []; } });
      return t;
    },
  };
  const pane = () => ({
    kids: [],
    append(...ns) {
      for (let n of ns) {
        if (typeof n === 'string') n = new Raw(esc(n));
        n.parent = this;
        this.kids.push(n);
      }
    },
    get html() { return this.kids.map((k) => k.html).join(''); },
  });

  const L = lift('const OUT_RULES = [', 'function appendGitOutputLine(text) {',
    ['outLineHtml', 'counterHead', 'paintLiveLine'], { document });
  const { outLineHtml, counterHead, paintLiveLine } = L || {};

  /* What the pane did before, kept here as the reference: read the pane back
     as text, change the last line or add one, and draw every line again. */
  const OLD_HEAD = (line) => line.replace(/\s*\d+%.*$/, '').trim();
  const oldRun = (lines) => {
    let text = '';
    let head = null;
    let html = '';
    for (const t of lines) {
      const h = OLD_HEAD(t);
      const all = text ? text.split('\n') : [];
      if (h && h !== t && h === head && all.length) all[all.length - 1] = t;
      else all.push(t);
      head = h;
      html = all.map(outLineHtml).join('\n');
      text = all.join('\n');
    }
    return html;
  };
  const newRun = (lines) => {
    const live = pane();
    let head = null;
    for (const t of lines) head = paintLiveLine(live, t, head);
    return live.html;
  };

  const counters = (label, n) => Array.from({ length: n + 1 }, (_, i) =>
    `${label}: ${String(Math.round((i / n) * 100)).padStart(3)}% (${i}/${n})`);
  const transcript = [
    'remote: Enumerating objects: 12, done.',
    ...counters('remote: Counting objects', 12),
    ...counters('Receiving objects', 40),
    'Receiving objects: 100% (40/40), 9.1 KiB | 9.1 MiB/s, done.',
    ...Array.from({ length: 300 }, (_, i) => ` * [new tag]         v${i}.0.0      -> v${i}.0.0`),
    ' src/app.js | 24 ++++++++----------',
    ' src/gone.js | 3 ---',
    'warning: <redirecting> & "quoting" \'this\'',
    'fatal: the remote end hung up unexpectedly',
    'Already on \'main\'',
    '50% of nothing',
    ...counters('Resolving deltas', 7),
  ];
  check('the lifted pane code is there', typeof paintLiveLine === 'function' && typeof counterHead === 'function',
    Object.keys(L || {}));
  if (typeof paintLiveLine === 'function') {
    check('a real transcript: the pane holds exactly the markup the full redraw drew',
      newRun(transcript) === oldRun(transcript), { new: newRun(transcript).slice(-200), old: oldRun(transcript).slice(-200) });

    let seed = 11;
    const rnd = (n) => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % n; };
    const ABC = ['a', 'b', ' ', '  ', '%', '1', '42', '<', '&', '|', '+', '-', 'x:', 'fatal', 'remote:'];
    let differ = null;
    for (let k = 0; k < 2000 && !differ; k++) {
      const lines = Array.from({ length: 1 + rnd(12) }, () =>
        Array.from({ length: 1 + rnd(8) }, () => ABC[rnd(ABC.length)]).join('').trim() || 'x');
      if (newRun(lines) !== oldRun(lines)) differ = lines;
    }
    check('and the same on 2,000 random transcripts of counters, bars and markup', !differ, differ);
  }

  if (typeof counterHead === 'function') {
    const CH = ['a', ' ', '\t', '%', '1', '9', '0', ':', '(', ')', 'x'];
    let seed = 5;
    const rnd = (n) => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % n; };
    let differ = null;
    for (let k = 0; k < 20000 && !differ; k++) {
      const s = Array.from({ length: rnd(16) }, () => CH[rnd(CH.length)]).join('');
      if (counterHead(s) !== OLD_HEAD(s)) differ = s;
    }
    check('the counter test answers what the pattern answered (20,000 random lines)', !differ, JSON.stringify(differ));

    const time = (line) => {
      const t = process.hrtime.bigint();
      counterHead(line);
      return Number(process.hrtime.bigint() - t) / 1e6;
    };
    const spaces = time(`remote: ${' '.repeat(40000)}x`);
    const digits = time(`remote: ${'1'.repeat(40000)}x`);
    const both = time(`remote: ${'1 '.repeat(20000)}%`);
    check(`a 40,000-space line costs nothing: ${spaces.toFixed(2)} ms`, spaces < 20, spaces);
    check(`nor do 40,000 digits without a percent sign: ${digits.toFixed(2)} ms`, digits < 20, digits);
    check(`nor 20,000 numbers before one: ${both.toFixed(2)} ms`, both < 20, both);
  }

  if (typeof paintLiveLine === 'function') {
    const lines = Array.from({ length: 5000 }, (_, i) => ` * [new tag]         v${i}.0.0      -> v${i}.0.0`);
    const t = process.hrtime.bigint();
    newRun(lines);
    const ms = Number(process.hrtime.bigint() - t) / 1e6;
    check(`5,000 lines go onto the pane in linear time: ${ms.toFixed(0)} ms (the redraw took seconds)`, ms < 500, ms);
  }
}

/* ── avatar colours ─────────────────────────────────────────── */

section('the avatar colours');
{
  const css = styleSrc.replace(/\/\*[\s\S]*?\*\//g, '');
  const lin = (v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
  const lum = ([r, g, b]) => 0.2126 * lin(r / 255) + 0.7152 * lin(g / 255) + 0.0722 * lin(b / 255);
  const ratio = (a, b) => {
    const x = lum(a);
    const y = lum(b);
    return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
  };
  const hex = (h) => {
    let s = h.replace('#', '');
    if (s.length === 3) s = [...s].map((c) => c + c).join('');
    return [0, 2, 4].map((i) => parseInt(s.slice(i, i + 2), 16));
  };
  // CSS Color 4's hsl(), to the eight bits the screen gets.
  const hsl = (h, s, l) => {
    s /= 100; l /= 100;
    const k = (n) => (n + h / 30) % 12;
    const a = s * Math.min(l, 1 - l);
    const f = (n) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
    return [f(0), f(8), f(4)].map((v) => Math.round(v * 255));
  };
  const WHITE = [255, 255, 255];

  /* Every rule that paints a disc from the address's hue. Found, not listed:
     a third one added later is measured the day it appears. */
  const rules = [...css.matchAll(/([^{}]+)\{([^}]*hsl\(var\(--hue[^}]*)\}/g)].map((m) => ({
    sel: m[1].trim(),
    body: m[2],
  }));
  check('both initials discs are found (the Author column and the commit panel)',
    rules.some((r) => r.sel === '.avatar') && rules.some((r) => r.sel === '.c-face-ini'),
    rules.map((r) => r.sel));
  for (const r of rules) {
    const [, s, l] = /hsl\(var\(--hue[^)]*\)\s+([\d.]+)%\s+([\d.]+)%\)/.exec(r.body) || [];
    const ink = /(?:^|;)\s*color:\s*(#[0-9a-fA-F]{3,6})/.exec(r.body);
    let worst = { ratio: Infinity, hue: -1 };
    for (let h = 0; h < 360; h++) {
      const c = ratio(hsl(h, Number(s), Number(l)), ink ? hex(ink[1]) : WHITE);
      if (c < worst.ratio) worst = { ratio: c, hue: h };
    }
    check(`${r.sel}: initials clear 4.5:1 on all 360 hues (worst ${worst.ratio.toFixed(2)}:1 at ${worst.hue})`,
      worst.ratio >= 4.5, worst);
  }
  // No theme re-colours them, so one measurement covers every theme.
  const themed = [...css.matchAll(/([^{}]+)\{([^}]*)\}/g)]
    .filter((m) => /\[data-theme/.test(m[1]) && /\.(avatar|c-face)/.test(m[1]));
  check('no theme overrides the hue discs', themed.length === 0, themed.map((m) => m[1].trim()));

  /* The profile discs in Preferences take their colours from the theme, so
     they are measured theme by theme. */
  const roots = [...css.matchAll(/:root(?:\[data-theme="(\w+)"\])?\s*\{([^}]*)\}/g)];
  const base = {};
  const theme = {};
  for (const [, name, body] of roots) {
    const into = name ? (theme[name] = theme[name] || {}) : base;
    for (const d of body.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) into[d[1]] = d[2].trim();
  }
  // A theme-scoped rule for one disc, its value read through the theme's tokens.
  const override = (name, sel, prop, v) => {
    const m = [...css.matchAll(/([^{}]+)\{([^}]*)\}/g)]
      .find((x) => x[1].trim() === `:root[data-theme="${name}"] ${sel}`);
    const d = m && new RegExp(`(?:^|;)\\s*${prop}:\\s*([^;]+)`).exec(m[2]);
    if (!d) return null;
    const val = d[1].trim();
    const ref = /^var\((--[\w-]+)\)$/.exec(val);
    return ref ? v[ref[1]] : val;
  };
  const names = ['dark', ...Object.keys(theme)];
  check('five themes are measured', names.length === 5, names);
  for (const name of names) {
    const v = { ...base, ...(theme[name] || {}) };
    const main = ratio(hex(override(name, '.pf-avatar:not(.pf-avatar-alt)', 'background', v) || v['--accent']),
      hex(v['--accent-ink']));
    const alt = ratio(hex(v['--surface-3']), hex(override(name, '.pf-avatar-alt', 'color', v) || v['--text-dim']));
    check(`${name}: the Preferences discs clear 4.5:1 (${main.toFixed(2)} and ${alt.toFixed(2)})`,
      main >= 4.5 && alt >= 4.5, { main, alt });
  }

  /* Text in --accent-ink sits on --accent-fill: primary buttons, count badges,
     the version pill, the action icons. Resolved through var() the way the
     browser does, theme by theme, at rest and on hover. */
  const resolve = (v, val, depth = 0) => {
    const ref = /^var\((--[\w-]+)\)$/.exec(String(val || '').trim());
    return ref && depth < 5 ? resolve(v, v[ref[1]], depth + 1) : val;
  };
  for (const name of names) {
    const v = { ...base, ...(theme[name] || {}) };
    // A token the theme never defines measures as no contrast at all.
    const of = (t) => { const x = resolve(v, v[t]); return /^#[0-9a-fA-F]{3,6}$/.test(x || '') ? hex(x) : null; };
    const ink = of('--accent-ink');
    const rest = ink && of('--accent-fill') ? ratio(of('--accent-fill'), ink) : 0;
    const hover = ink && of('--accent-fill-hi') ? ratio(of('--accent-fill-hi'), ink) : 0;
    check(`${name}: accent ink on the accent fill clears 4.5:1 (${rest.toFixed(2)}, hover ${hover.toFixed(2)})`,
      rest >= 4.5 && hover >= 4.5, { rest, hover });
  }
  const bare = [...css.matchAll(/([^{}]+)\{([^}]*)\}/g)]
    .filter((m) => /color:\s*var\(--accent-ink\)/.test(m[2]) && /background:\s*var\(--accent\)/.test(m[2]))
    .map((m) => m[1].trim());
  check('nothing writes the accent ink straight on the bare accent', bare.length === 0, bare);
}

done();
