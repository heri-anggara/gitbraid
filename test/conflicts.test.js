/* Conflicts, stashes and file history, driven through the real handlers
 * against real repositories that git itself has stopped in a conflict.
 *
 * Every scenario builds its own repository, so one that fails cannot leave
 * another standing on its debris. A scenario that throws counts as a failure
 * and the rest still run: against a main.js without a handler, the check says
 * so rather than the whole file going quiet. */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { loadMain, scratchRepo, reporter, ROOT } = require('./harness');

const { check, section, done } = reporter();
const m = loadMain();
const call = m.call;

/* A command that is expected to stop in a conflict: git exits non-zero. */
const stops = (r, args) => { try { r.g(args); return false; } catch { return true; } };
const exists = (r, f) => fs.existsSync(path.join(r.dir, f));
const porcelain = (r) => r.g(['status', '--porcelain']);
const conflicted = async (r) => ((await call('repo:status', r.dir)).data || { conflicted: [] }).conflicted;

async function scenario(name, fn) {
  try { await fn(); } catch (e) { check(`${name} (threw)`, false, String(e && e.stack || e).split('\n').slice(0, 3).join(' | ')); }
}

/* The usual shape: base, then `mine` on main and `theirs` on a side branch,
   both rewriting the same line of f.txt. */
function forked({ mine = 'MINE\n', theirs = 'THEIRS\n', side = 'side' } = {}) {
  const r = scratchRepo('gitbraid-conf-');
  r.commit('f.txt', 'base\n', 'base');
  r.g(['checkout', '-q', '-b', side]);
  const theirsHash = r.commit('f.txt', theirs, 'their change');
  r.g(['checkout', '-q', 'main']);
  const mineHash = r.commit('f.txt', mine, 'my change');
  return { r, mineHash, theirsHash };
}

/* ── lifting renderer helpers, the way parsers.test.js does ───── */

const rendererSrc = fs.readFileSync(path.join(ROOT, 'src/renderer.js'), 'utf8');
function lift(name) {
  for (const head of [`async function ${name}(`, `function ${name}(`]) {
    const at = rendererSrc.indexOf(`\n${head}`);
    if (at >= 0) return rendererSrc.slice(at + 1, rendererSrc.indexOf('\n}\n', at) + 3);
  }
  throw new Error(`renderer has no function ${name}`);
}
function rendererBox(names, globals = {}) {
  const box = { plural: (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`, ...globals };
  vm.createContext(box);
  vm.runInContext(names.map(lift).join('\n')
    + `\n;Object.assign(this, { ${names.join(', ')} });`, box);
  return box;
}

(async () => {
  /* ═════ 1. whose side is whose ═════ */
  section('1. "Keep your version" is the reader\'s side in every operation');

  await scenario('merge', async () => {
    for (const side of ['mine', 'incoming']) {
      const { r } = forked();
      check(`merge stops in a conflict (${side})`, stops(r, ['merge', 'side']));
      const st = (await call('repo:state', r.dir)).data;
      check('merge: the state names the sides', st && st.sides && st.sides.mine.label === 'your version'
        && st.sides.incoming.label === 'the side version' && st.canSkip === false, st);
      const res = await call('repo:resolve', r.dir, 'f.txt', side);
      check(`merge: ${side} takes ${side === 'mine' ? 'HEAD' : 'the merged branch'}`,
        res.ok && r.read('f.txt') === (side === 'mine' ? 'MINE\n' : 'THEIRS\n'), { res, f: r.read('f.txt') });
      const cont = await call('repo:continue', r.dir, 'merge');
      check(`merge: continue makes the merge commit (${side})`, cont.ok
        && r.g(['rev-list', '--parents', '-n', '1', 'HEAD']).trim().split(' ').length === 3, cont);
      r.rm();
    }
  });

  await scenario('rebase', async () => {
    // The reader is on `feature`, rebasing it onto main.
    const r = scratchRepo('gitbraid-conf-');
    r.commit('f.txt', 'base\n', 'base');
    r.g(['checkout', '-q', '-b', 'feature']);
    r.commit('f.txt', 'FEATURE\n', 'my feature');
    r.g(['checkout', '-q', 'main']);
    r.commit('f.txt', 'UPSTREAM\n', 'upstream change');
    r.g(['checkout', '-q', 'feature']);
    check('rebase stops in a conflict', stops(r, ['rebase', 'main']));
    const st = (await call('repo:state', r.dir)).data;
    check('rebase: the labels say which side is the reader\'s commit and which is main',
      st && st.sides && st.sides.mine.label === 'your commit (being replayed)'
      && st.sides.incoming.label === 'the main version' && st.canSkip === true, st && st.sides);
    const res = await call('repo:resolve', r.dir, 'f.txt', 'mine');
    check('rebase: mine takes the commit being replayed, not the upstream', res.ok && r.read('f.txt') === 'FEATURE\n', r.read('f.txt'));
    const cont = await call('repo:continue', r.dir, 'rebase');
    const log = r.g(['log', '--format=%s', 'feature']).trim().split('\n');
    check('rebase: after continue the reader\'s commit and content survive',
      cont.ok && log[0] === 'my feature' && log[1] === 'upstream change' && r.read('f.txt') === 'FEATURE\n', { cont, log });
    r.rm();

    const r2 = scratchRepo('gitbraid-conf-');
    r2.commit('f.txt', 'base\n', 'base');
    r2.g(['checkout', '-q', '-b', 'feature']);
    r2.commit('f.txt', 'FEATURE\n', 'my feature');
    r2.g(['checkout', '-q', 'main']);
    r2.commit('f.txt', 'UPSTREAM\n', 'upstream change');
    r2.g(['checkout', '-q', 'feature']);
    stops(r2, ['rebase', 'main']);
    await call('repo:resolve', r2.dir, 'f.txt', 'incoming');
    check('rebase: incoming takes the branch being rebased onto', r2.read('f.txt') === 'UPSTREAM\n', r2.read('f.txt'));
    r2.rm();
  });

  await scenario('cherry-pick', async () => {
    for (const side of ['mine', 'incoming']) {
      const { r, theirsHash } = forked();
      check(`cherry-pick stops in a conflict (${side})`, stops(r, ['cherry-pick', theirsHash]));
      const st = (await call('repo:state', r.dir)).data;
      check('cherry-pick: the incoming label names the picked commit',
        st && st.sides.incoming.label === `the picked commit's version (${theirsHash.slice(0, 7)})`, st && st.sides);
      await call('repo:resolve', r.dir, 'f.txt', side);
      check(`cherry-pick: ${side} takes ${side === 'mine' ? 'HEAD' : 'the picked commit'}`,
        r.read('f.txt') === (side === 'mine' ? 'MINE\n' : 'THEIRS\n'), r.read('f.txt'));
      r.rm();
    }
  });

  await scenario('revert', async () => {
    for (const side of ['mine', 'incoming']) {
      const r = scratchRepo('gitbraid-conf-');
      r.commit('f.txt', 'v1\n', 'one');
      const two = r.commit('f.txt', 'v2\n', 'two');
      r.commit('f.txt', 'v3\n', 'three');
      check(`revert stops in a conflict (${side})`, stops(r, ['revert', '--no-edit', two]));
      const st = (await call('repo:state', r.dir)).data;
      check('revert: the state is a revert with sides', st && st.kind === 'revert' && st.sides && st.canSkip === true, st);
      await call('repo:resolve', r.dir, 'f.txt', side);
      check(`revert: ${side} takes ${side === 'mine' ? 'HEAD' : 'the reverted content'}`,
        r.read('f.txt') === (side === 'mine' ? 'v3\n' : 'v1\n'), r.read('f.txt'));
      r.rm();
    }
  });

  await scenario('stash pop', async () => {
    for (const side of ['mine', 'incoming']) {
      const r = scratchRepo('gitbraid-conf-');
      r.commit('f.txt', 'base\n', 'base');
      r.write('f.txt', 'STASHED\n');
      r.g(['stash', 'push', '-q']);
      r.commit('f.txt', 'COMMITTED\n', 'later');
      const list = (await call('repo:stashList', r.dir)).data;
      const pop = await call('repo:stashApply', r.dir, list[0].ref, true, list[0].hash);
      check(`stash pop that conflicts fails and keeps the stash (${side})`,
        pop.ok === false && r.g(['stash', 'list']).trim() !== '', pop);
      check('stash pop: there is no operation, and the file is conflicted',
        (await call('repo:state', r.dir)).data === null && (await conflicted(r)).length === 1);
      await call('repo:resolve', r.dir, 'f.txt', side);
      check(`stash pop: ${side} takes ${side === 'mine' ? 'the working tree' : 'the stash'}`,
        r.read('f.txt') === (side === 'mine' ? 'COMMITTED\n' : 'STASHED\n'), r.read('f.txt'));
      r.rm();
    }
  });

  await scenario('labels in the window', async () => {
    const box = rendererBox(['sideLabels']);
    const none = box.sideLabels(null);
    const reb = box.sideLabels({ sides: { mine: { label: 'your commit (being replayed)' }, incoming: { label: 'the main version' } } });
    check('the window shows main.js\'s labels, and plain words with no operation',
      none.mine === 'your version' && none.incoming === 'their version'
      && reb.mine === 'your commit (being replayed)' && reb.incoming === 'the main version', { none, reb });
    check('the window asks for "mine"/"incoming", never for a raw git side',
      !/repo:resolve', repoPath\(\), \w+, '(ours|theirs)'/.test(rendererSrc)
      && !/resolveMany\(paths, '(ours|theirs)'\)/.test(rendererSrc));
    const res = await call('repo:resolve', '/nonexistent', 'f', 'ours');
    check('repo:resolve refuses a raw "ours"', res.ok === false);
  });

  /* ═════ 2. bulk resolve counts its failures ═════ */
  section('2. resolving several files reports the ones git refused');

  await scenario('resolveMany', async () => {
    const said = [];
    const box = rendererBox(['resolveMany', 'resolveReport'], {
      lastFailure: '',
      firstLine: (s) => String(s).split('\n')[0],
      repoPath: () => '/r',
      clearPicked: () => {}, refresh: async () => {},
      confirmMarkers: async () => true,
      setStatus: (text, kind) => said.push({ text, kind }),
    });
    box.call = async (ch, repo, p) => {
      if (p === 'gone.txt') { box.lastFailure = "error: path 'gone.txt' does not have our version"; return null; }
      return { removed: false };
    };
    await box.resolveMany(['a.txt', 'gone.txt', 'b.txt'], 'mine');
    const last = said[said.length - 1];
    check('one refusal among three is reported as an error, naming the file and git\'s reason',
      last.kind === 'error' && /2 files resolved, 1 not/.test(last.text) && /gone\.txt/.test(last.text)
      && /does not have our version/.test(last.text), last);
    said.length = 0;
    await box.resolveMany(['gone.txt'], 'mine');
    check('a single refusal never says "resolved"', said[0].kind === 'error' && !/ resolved/.test(said[0].text), said[0]);
    said.length = 0;
    await box.resolveMany(['a.txt', 'b.txt'], 'mine');
    check('and all going through says so', said[0].kind === 'ok' && said[0].text === '2 files resolved', said[0]);
  });

  /* ═════ 3. the side that deleted the file ═════ */
  section('3. a side that deleted the file can be chosen');

  // DU: deleted on main (ours), modified on side (theirs).
  function deletedByUs() {
    const r = scratchRepo('gitbraid-conf-');
    r.commit('f.txt', 'base\n', 'base');
    r.g(['checkout', '-q', '-b', 'side']);
    r.commit('f.txt', 'changed\n', 'modify');
    r.g(['checkout', '-q', 'main']);
    r.g(['rm', '-q', 'f.txt']);
    r.g(['commit', '-qm', 'delete']);
    stops(r, ['merge', 'side']);
    return r;
  }
  // UD: modified on main (ours), deleted on side (theirs).
  function deletedByThem() {
    const r = scratchRepo('gitbraid-conf-');
    r.commit('f.txt', 'base\n', 'base');
    r.g(['checkout', '-q', '-b', 'side']);
    r.g(['rm', '-q', 'f.txt']);
    r.g(['commit', '-qm', 'delete']);
    r.g(['checkout', '-q', 'main']);
    r.commit('f.txt', 'changed\n', 'modify');
    stops(r, ['merge', 'side']);
    return r;
  }

  await scenario('DU', async () => {
    let r = deletedByUs();
    check('DU: git reports the file as deleted by us', (await conflicted(r))[0]?.xy === 'DU');
    let res = await call('repo:resolve', r.dir, 'f.txt', 'mine');
    check('DU: mine (the deletion) removes the file and settles the conflict',
      res.ok && res.data.removed === true && !exists(r, 'f.txt') && (await conflicted(r)).length === 0, res);
    const cont = await call('repo:continue', r.dir, 'merge');
    check('DU: and the merge then completes without the file',
      cont.ok && r.g(['ls-files', 'f.txt']).trim() === '', cont);
    r.rm();
    r = deletedByUs();
    res = await call('repo:resolve', r.dir, 'f.txt', 'incoming');
    // HEAD has no f.txt, so keeping it reads as adding it back.
    check('DU: incoming (the modification) keeps the file, staged',
      res.ok && res.data.removed === false && r.read('f.txt') === 'changed\n' && /^A  f\.txt$/m.test(porcelain(r)), { res, st: porcelain(r) });
    r.rm();
  });

  await scenario('UD', async () => {
    let r = deletedByThem();
    check('UD: git reports the file as deleted by them', (await conflicted(r))[0]?.xy === 'UD');
    let res = await call('repo:resolve', r.dir, 'f.txt', 'incoming');
    check('UD: incoming (the deletion) removes the file',
      res.ok && res.data.removed === true && !exists(r, 'f.txt') && /^D  f\.txt$/m.test(porcelain(r)), { res, st: porcelain(r) });
    r.rm();
    r = deletedByThem();
    res = await call('repo:resolve', r.dir, 'f.txt', 'mine');
    check('UD: mine (the modification) keeps the file',
      res.ok && r.read('f.txt') === 'changed\n' && (await conflicted(r)).length === 0, res);
    r.rm();
  });

  await scenario('deleted in a rebase', async () => {
    // The reader's commit deletes the file; upstream modified it.
    const r = scratchRepo('gitbraid-conf-');
    r.commit('f.txt', 'base\n', 'base');
    r.commit('keep.txt', 'k\n', 'keep');
    r.g(['checkout', '-q', '-b', 'feature']);
    r.g(['rm', '-q', 'f.txt']);
    r.g(['commit', '-qm', 'remove f']);
    r.g(['checkout', '-q', 'main']);
    r.commit('f.txt', 'upstream\n', 'touch f');
    r.g(['checkout', '-q', 'feature']);
    stops(r, ['rebase', 'main']);
    const res = await call('repo:resolve', r.dir, 'f.txt', 'mine');
    const cont = await call('repo:continue', r.dir, 'rebase');
    check('rebase: mine is the reader\'s deletion, and it survives the continue',
      res.ok && res.data.removed && cont.ok && !exists(r, 'f.txt')
      && r.g(['log', '-1', '--format=%s']).trim() === 'remove f', { res, cont });
    r.rm();
  });

  /* ═════ 4. markers left in a file ═════ */
  section('4. marking a file that still holds conflict markers is asked about');

  await scenario('markers', async () => {
    const { r } = forked();
    stops(r, ['merge', 'side']);
    r.write('clean.md', 'Title\n=======\n');
    let res = await call('repo:conflictMarkers', r.dir, ['f.txt', 'clean.md', 'missing.txt']);
    check('the file git wrote markers into is found; a heading underline and a missing file are not',
      res.ok && JSON.stringify(res.data) === '["f.txt"]', res);
    r.write('f.txt', 'settled by hand\n');
    res = await call('repo:conflictMarkers', r.dir, ['f.txt']);
    check('once edited out, nothing is reported', res.ok && res.data.length === 0, res);
    r.rm();

    const asked = [];
    const box = rendererBox(['confirmMarkers', 'markerWarning'], {
      repoPath: () => '/r',
      call: async () => ['a.txt', 'b.txt'],
      confirmAction: async (title, text) => { asked.push(text); return false; },
    });
    const go = await box.confirmMarkers(['a.txt', 'b.txt', 'c.txt']);
    check('the window asks once, naming the files, and stops when told no',
      go === false && asked.length === 1 && /2 files still hold/.test(asked[0]) && /a\.txt, b\.txt/.test(asked[0]), asked);
    box.call = async () => [];
    check('and does not ask when there are none', (await box.confirmMarkers(['c.txt'])) === true && asked.length === 1);
    const rm = rendererBox(['resolveMany', 'resolveReport'], {
      lastFailure: '', firstLine: String, repoPath: () => '/r', clearPicked() {}, async refresh() {},
      setStatus() {}, confirmMarkers: async () => false,
    });
    let resolved = 0;
    rm.call = async () => { resolved++; return {}; };
    await rm.resolveMany(['a.txt'], 'mark');
    check('bulk "Mark resolved" stages nothing when the reader says no', resolved === 0);
  });

  /* ═════ 5. a stash that did not apply is redrawn ═════ */
  section('5. a stash apply that fails still redraws the working tree');

  await scenario('applyStash', async () => {
    const seen = { refreshed: 0, args: null };
    const box = rendererBox(['applyStash'], {
      activeId: 1,
      repoPath: () => '/r',
      setStatus() {},
      refresh: async () => { seen.refreshed++; },
      call: async (...a) => { seen.args = a; return null; },
      gitAction: async (id, verb, fn) => { const res = await fn(); return res !== null; },
    });
    await box.applyStash('stash@{0}', true, 'f'.repeat(40));
    check('a pop that conflicts refreshes, the way a merge does', seen.refreshed === 1, seen);
    check('and the stash\'s hash goes with the ref', seen.args && seen.args[4] === 'f'.repeat(40), seen.args);
  });

  /* ═════ 6. a stash is named by its hash ═════ */
  section('6. stash drop and apply act on the stash that was clicked');

  await scenario('stash by hash', async () => {
    const r = scratchRepo('gitbraid-conf-');
    r.commit('f.txt', 'base\n', 'base');
    r.write('f.txt', 'OLD STASH\n');
    r.g(['stash', 'push', '-q', '-m', 'old']);
    const seen = (await call('repo:stashList', r.dir)).data;   // what the sidebar drew
    r.write('f.txt', 'NEW STASH\n');
    r.g(['stash', 'push', '-q', '-m', 'new']);                  // someone stashed in a terminal
    const res = await call('repo:stashDrop', r.dir, seen[0].ref, seen[0].hash);
    const left = r.g(['stash', 'list', '--format=%s']).trim();
    check('dropping the stale stash@{0} drops the stash that was clicked, found by hash',
      res.ok && /new$/.test(left) && !/old$/m.test(left), { res, left });
    const gone = await call('repo:stashDrop', r.dir, 'stash@{0}', seen[0].hash);
    check('a stash that is no longer there is refused, and nothing else is dropped',
      gone.ok === false && /no longer in the list/.test(gone.error) && /new$/.test(r.g(['stash', 'list', '--format=%s']).trim()), gone);
    const blind = await call('repo:stashDrop', r.dir, 'stash@{0}');
    check('a drop without a hash is refused', blind.ok === false && r.g(['stash', 'list']).trim() !== '', blind);

    // Apply: the stash that was clicked, after another was pushed on top.
    const now = (await call('repo:stashList', r.dir)).data;
    r.write('g.txt', 'other\n');
    r.g(['add', 'g.txt']);
    r.g(['stash', 'push', '-q', '-m', 'third']);
    const ap = await call('repo:stashApply', r.dir, now[0].ref, true, now[0].hash);
    check('pop of a moved stash pops that one and leaves the newer stash',
      ap.ok && r.read('f.txt') === 'NEW STASH\n' && r.g(['stash', 'list', '--format=%s']).trim().endsWith('third'), ap);
    r.rm();
  });

  /* ═════ 7–9. file history ═════ */
  section('7. file history reads names with quotes, backslashes, tabs and newlines');

  await scenario('awkward names', async () => {
    const r = scratchRepo('gitbraid-conf-');
    // Each with its own content: --follow would otherwise take an identical
    // earlier file for where this one came from.
    for (const name of ['say "hi".txt', 'back\\slash.txt', 'tab\there.txt', 'new\nline.txt']) {
      r.commit(name, `one ${name}\n`, `add ${JSON.stringify(name)}`);
      r.commit(name, `one ${name}\ntwo\n`, `edit ${JSON.stringify(name)}`);
      const out = await call('repo:fileLog', r.dir, name);
      const hashes = out.ok ? out.data.commits.map((c) => c.hash) : [];
      check(`${JSON.stringify(name)}: both commits, each named exactly`,
        hashes.length === 2 && hashes.every((h) => out.data.names[h] === name), out.ok ? out.data.names : out);
      const diff = out.ok && await call('repo:diffCommitFile', r.dir, { hash: hashes[0], file: out.data.names[hashes[0]] });
      check(`${JSON.stringify(name)}: and the diff at that name is not empty`, diff && diff.ok && /\+two/.test(diff.data), diff);
    }
    r.rm();
  });

  section('8. file history includes the merge that settled a conflict in the file');

  await scenario('merges', async () => {
    const { r } = forked();
    r.commit('other.txt', 'x\n', 'unrelated');
    stops(r, ['merge', 'side']);
    r.write('f.txt', 'RESOLVED BY HAND\n');
    r.g(['add', 'f.txt']);
    r.g(['commit', '-qm', 'merge side']);
    const evil = r.g(['rev-parse', 'HEAD']).trim();
    // A second merge that does not touch f.txt at all.
    r.g(['checkout', '-q', '-b', 'side2', 'HEAD~1']);
    r.commit('q.txt', 'q\n', 'side2 work');
    r.g(['checkout', '-q', 'main']);
    r.g(['merge', '-q', '--no-edit', 'side2']);
    const quiet = r.g(['rev-parse', 'HEAD']).trim();
    const out = await call('repo:fileLog', r.dir, 'f.txt');
    const list = out.ok ? out.data.commits.map((c) => c.subject) : [];
    check('the merge where f.txt was resolved is listed', out.ok && out.data.commits.some((c) => c.hash === evil), list);
    check('a merge that did nothing to f.txt is not', out.ok && !out.data.commits.some((c) => c.hash === quiet), list);
    check('and the other commits are all still there',
      list.length === 4 && list[0] === 'merge side' && list[3] === 'base'
      && list.includes('my change') && list.includes('their change'), list);
    const d = await call('repo:diffCommitFile', r.dir, { hash: evil, file: 'f.txt', side: 'in' });
    check('the merge row diffs: against its first parent it shows the resolution',
      d.ok && /\+RESOLVED BY HAND/.test(d.data) && /-MINE/.test(d.data), d);
    const cc = await call('repo:diffCommitFile', r.dir, { hash: evil, file: 'f.txt', side: 'combined' });
    check('and the combined view shows the hand-made lines', cc.ok && /RESOLVED BY HAND/.test(cc.data), cc);
    r.rm();
  });

  section('9. a rename commit in file history diffs as a rename');

  await scenario('rename', async () => {
    const r = scratchRepo('gitbraid-conf-');
    r.commit('old name.txt', 'a\nb\nc\nd\n', 'add');
    r.g(['mv', 'old name.txt', 'new name.txt']);
    r.g(['commit', '-qm', 'rename']);
    const ren = r.g(['rev-parse', 'HEAD']).trim();
    const out = await call('repo:fileLog', r.dir, 'new name.txt');
    check('the rename commit carries both names', out.ok && out.data.names[ren] === 'new name.txt'
      && out.data.origs[ren] === 'old name.txt', out.ok ? out.data : out);
    const d = await call('repo:diffCommitFile', r.dir, { hash: ren, file: 'new name.txt', orig: out.data.origs[ren] });
    check('and its diff, given the old name, is a rename — not the file added',
      d.ok && /rename from old name\.txt/.test(d.data) && !/new file mode/.test(d.data), d);
    check('the window passes the old name on', /orig: fhist\.origs\?\.\[c\.hash\]/.test(rendererSrc));
    r.rm();
  });

  /* ═════ 10. intent-to-add ═════ */
  section('10. discarding a file added with git add -N deletes it rather than emptying it');

  await scenario('intent to add', async () => {
    for (const asUntracked of [true, false]) {
      const r = scratchRepo('gitbraid-conf-');
      r.commit('a.txt', 'a\n', 'base');
      r.write('new.txt', 'precious\n');
      r.g(['add', '-N', 'new.txt']);
      const st = (await call('repo:status', r.dir)).data;
      const entry = st.unstaged.find((f) => f.path === 'new.txt');
      check(`status marks the file intent-to-add (${asUntracked ? 'row' : 'discard all'})`, entry && entry.intentToAdd === true, entry);
      const res = await call('repo:discard', r.dir, ['new.txt'], asUntracked);
      check(`discard leaves neither the file nor an index entry (${asUntracked ? 'row' : 'discard all'})`,
        res.ok && !exists(r, 'new.txt') && r.g(['ls-files', 'new.txt']).trim() === '' && porcelain(r).trim() === '', { res, st: porcelain(r) });
      r.rm();
    }
    const r = scratchRepo('gitbraid-conf-');
    r.commit('a.txt', 'a\n', 'base');
    r.write('a.txt', 'changed\n');
    r.write('new.txt', 'n\n');
    r.g(['add', '-N', 'new.txt']);
    await call('repo:discard', r.dir, ['a.txt', 'new.txt'], false);
    check('beside it, a tracked file still goes back to its committed state',
      r.read('a.txt') === 'a\n' && !exists(r, 'new.txt'), porcelain(r));
    r.rm();
  });

  /* ═════ 11. skip ═════ */
  section('11. a stopped cherry-pick, revert or rebase can skip the commit');

  await scenario('skip', async () => {
    // A cherry-pick resolved to nothing: continue cannot go on, skip can.
    const { r, theirsHash, mineHash } = forked();
    stops(r, ['cherry-pick', theirsHash]);
    await call('repo:resolve', r.dir, 'f.txt', 'mine');
    const cont = await call('repo:continue', r.dir, 'cherry-pick');
    check('cherry-pick resolved to nothing: continue is refused', cont.ok === false && /empty/.test(cont.error), cont);
    const skip = await call('repo:skip', r.dir, 'cherry-pick');
    check('and skip ends it, with HEAD where it was', skip.ok && (await call('repo:state', r.dir)).data === null
      && r.g(['rev-parse', 'HEAD']).trim() === mineHash, skip);
    r.rm();

    const v = scratchRepo('gitbraid-conf-');
    v.commit('f.txt', 'v1\n', 'one');
    const two = v.commit('f.txt', 'v2\n', 'two');
    const three = v.commit('f.txt', 'v3\n', 'three');
    stops(v, ['revert', '--no-edit', two]);
    const vs = await call('repo:skip', v.dir, 'revert');
    check('revert: skip ends it and leaves HEAD alone', vs.ok && (await call('repo:state', v.dir)).data === null
      && v.g(['rev-parse', 'HEAD']).trim() === three, vs);
    v.rm();

    const b = scratchRepo('gitbraid-conf-');
    b.commit('f.txt', 'base\n', 'base');
    b.g(['checkout', '-q', '-b', 'feature']);
    b.commit('f.txt', 'FEATURE\n', 'conflicting');
    b.commit('g.txt', 'g\n', 'clean one');
    b.g(['checkout', '-q', 'main']);
    b.commit('f.txt', 'UPSTREAM\n', 'upstream');
    b.g(['checkout', '-q', 'feature']);
    stops(b, ['rebase', 'main']);
    const bs = await call('repo:skip', b.dir, 'rebase');
    const log = b.g(['log', '--format=%s']).trim().split('\n');
    check('rebase: skip drops the conflicting commit and replays the rest',
      bs.ok && (await call('repo:state', b.dir)).data === null && log.join('|') === 'clean one|upstream|base', { bs, log });
    b.rm();

    const g = forked();
    stops(g.r, ['merge', 'side']);
    const ms = await call('repo:skip', g.r.dir, 'merge');
    check('a merge has nothing to skip, and is left as it was',
      ms.ok === false && fs.existsSync(path.join(g.r.dir, '.git', 'MERGE_HEAD')), ms);
    g.r.rm();
    check('the strip has a Skip button', /id="op-skip"/.test(fs.readFileSync(path.join(ROOT, 'src/index.html'), 'utf8')));
  });

  m.restoreEnv();
  done();
})().catch((e) => { console.error(e); process.exit(1); });
