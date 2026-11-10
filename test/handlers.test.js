/* The harness itself: the real main.js loads under node, registers every
 * channel the preload exposes, and a handler answers the way the window sees. */
'use strict';

const fs = require('fs');
const path = require('path');
const { loadMain, scratchRepo, reporter, ROOT } = require('./harness');

const { check, section, done } = reporter();

(async () => {
  section('the handler harness');
  const m = loadMain();
  const preload = fs.readFileSync(path.join(ROOT, 'preload.js'), 'utf8');
  const list = preload.slice(preload.indexOf('const CHANNELS = new Set(['), preload.indexOf(']);'));
  const exposed = [...list.matchAll(/'([a-z]+:[A-Za-z]+)'/g)].map((x) => x[1]);
  const missing = exposed.filter((ch) => !m.handlers.has(ch));
  check('main.js loads under the stand-in and registers its handlers', m.handlers.size > 90, m.handlers.size);
  check('every invokable channel in the preload has a handler', exposed.length > 90 && missing.length === 0, { n: exposed.length, missing });

  const r = scratchRepo();
  r.commit('a.txt', 'one\n', 'first');
  const st = await m.call('repo:status', r.dir);
  check('a handler answers { ok, data } against a real repository', st.ok && st.data.branch === 'main', st);
  const bad = await m.call('repo:status', path.join(r.dir, 'nope'));
  check('a failing handler answers { ok: false, error }', bad.ok === false && typeof bad.error === 'string', bad);
  r.rm();
  done();
})().catch((e) => { console.error(e); process.exit(1); });
