const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');

/* ── build a throwaway repo with a genuinely branchy history ───── */

const REPO = fs.mkdtempSync(path.join(os.tmpdir(), 'gitbraid-test-'));
const git = (args, opts = {}) =>
  execFileSync('git', args, {
    cwd: REPO, encoding: 'utf8', env: { ...process.env, LC_ALL: 'C' }, ...opts,
  });

const commit = (file, body, msg) => {
  fs.writeFileSync(path.join(REPO, file), body);
  git(['add', file]);
  git(['commit', '-qm', msg]);
};

git(['init', '-q', '-b', 'main']);
git(['config', 'user.email', 't@t.io']);
git(['config', 'user.name', 'Tester']);
commit('a.txt', 'one\n', 'add a');
commit('b.txt', 'two\n', 'add b');
git(['checkout', '-qb', 'feature']);
commit('c.txt', 'three\n', 'feature: add c');
commit('d.txt', 'four\n', 'feature: add d');
git(['checkout', '-q', 'main']);
commit('e.txt', 'five\n', 'main: add e');
git(['merge', '-q', '--no-ff', 'feature', '-m', 'merge feature']);
git(['checkout', '-qb', 'hotfix', 'HEAD~2']);
commit('f.txt', 'six\n', 'hotfix: patch');
git(['checkout', '-q', 'main']);
git(['merge', '-q', '--no-ff', 'hotfix', '-m', 'merge hotfix']);
commit('multi.txt', Array.from({ length: 40 }, (_, i) => `line ${i}`).join('\n') + '\n', 'add multi');
git(['tag', 'v1.0']);

// Dirty working tree: one unstaged edit, one staged edit, one untracked file.
fs.appendFileSync(path.join(REPO, 'a.txt'), 'modified\n');
fs.writeFileSync(path.join(REPO, 'untracked.txt'), 'new\n');
fs.appendFileSync(path.join(REPO, 'b.txt'), 'staged change\n');
git(['add', 'b.txt']);

const multiLines = fs.readFileSync(path.join(REPO, 'multi.txt'), 'utf8').split('\n');
multiLines[2] = 'CHANGED TOP';
multiLines[35] = 'CHANGED BOTTOM';
fs.writeFileSync(path.join(REPO, 'multi.txt'), multiLines.join('\n'));

const EXPECTED_COMMITS = 9;

/* ── load the app's browser modules and main-process parsers ───── */

const sandbox = { window: {}, console };
vm.createContext(sandbox);
for (const f of ['src/graph.js', 'src/diff.js']) {
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', f), 'utf8'), sandbox);
}
const { Graph, Diff } = sandbox.window;

const mainSrc = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
const parserSrc = mainSrc.slice(
  mainSrc.indexOf('const UNIT ='),
  mainSrc.indexOf('/* ------------------------------------------------------------------ */\n/* recent repositories')
);
const P = {};
vm.runInNewContext(parserSrc + '\nthis.parseStatus=parseStatus; this.parseLog=parseLog;', P);

/* The release-notes renderer, lifted out of the renderer the same way the
   parsers are lifted out of main.js. It turns text fetched from a web page into
   markup, so what it refuses to do matters as much as what it does. */
// Read once here; the path tests further down lift their own functions from it.
const rendererSrc = fs.readFileSync(path.join(__dirname, '..', 'src/renderer.js'), 'utf8');
const notesSrc = rendererSrc.slice(
  rendererSrc.indexOf('function notesHtml(text) {'),
  rendererSrc.indexOf('\n}\n', rendererSrc.indexOf('function notesHtml(text) {')) + 3
);
const N = { esc: (x) => Diff.esc(x) };
vm.runInNewContext(notesSrc + '\nthis.notesHtml = notesHtml;', N);

let pass = 0, fail = 0;
const check = (name, cond, extra) => {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name, extra === undefined ? '' : JSON.stringify(extra)); }
};

/* ── status ────────────────────────────────────────────────────── */
console.log('\nstatus parser');
const st = P.parseStatus(git(['status', '--porcelain=v2', '--branch', '-z']));
check('branch is main', st.branch === 'main', st.branch);
check('head oid parsed', /^[0-9a-f]{40}$/.test(st.oid), st.oid);
check('b.txt staged', st.staged.some((f) => f.path === 'b.txt'), st.staged);
check('a.txt unstaged', st.unstaged.some((f) => f.path === 'a.txt'), st.unstaged);
check('multi.txt unstaged', st.unstaged.some((f) => f.path === 'multi.txt'));
check('untracked.txt found', st.untracked.some((f) => f.path === 'untracked.txt'), st.untracked);
check('no false conflicts', st.conflicted.length === 0);

// Paths containing spaces must survive the -z parsing.
fs.writeFileSync(path.join(REPO, 'a file with spaces.txt'), 'x\n');
git(['add', 'a file with spaces.txt']);
const st2 = P.parseStatus(git(['status', '--porcelain=v2', '--branch', '-z']));
check('spaced filename intact',
  st2.staged.some((f) => f.path === 'a file with spaces.txt'),
  st2.staged.map((f) => f.path));
git(['rm', '-q', '--cached', 'a file with spaces.txt']);
fs.unlinkSync(path.join(REPO, 'a file with spaces.txt'));

/* ── log ───────────────────────────────────────────────────────── */
console.log('\nlog parser');
const LOG_FORMAT = ['%H','%P','%an','%ae','%at','%cn','%ct','%D','%s','%b'].join('%x1f');
const commits = P.parseLog(
  git(['log', '--all', '--date-order', '-z', `--pretty=format:${LOG_FORMAT}`, '--max-count=100'])
);
check(`${EXPECTED_COMMITS} commits parsed`, commits.length === EXPECTED_COMMITS, commits.length);
check('all hashes valid', commits.every((c) => /^[0-9a-f]{40}$/.test(c.hash)));
check('no subject bleeds into the next record', commits.every((c) => !c.subject.includes('\0')));
check('subjects non-empty', commits.every((c) => c.subject.length > 0));
check('author parsed', commits.every((c) => c.author === 'Tester'));
check('two merge commits', commits.filter((c) => c.parents.length === 2).length === 2);
check('one root commit', commits.filter((c) => c.parents.length === 0).length === 1);
check('tag v1.0 present', commits.some((c) => c.refs.some((r) => r.includes('v1.0'))));
check('HEAD ref present', commits.some((c) => c.refs.some((r) => r.startsWith('HEAD ->'))));
check('dates are sane', commits.every((c) => c.commitDate > 1e12 && c.commitDate <= Date.now() + 5000));

/* ── graph layout ──────────────────────────────────────────────── */
console.log('\ngraph layout');
const rowsData = [
  { hash: 'WORKDIR', parents: [st.oid], pending: true, subject: 'wip', refs: [] },
  ...commits,
];
const layout = Graph.layout(rowsData);
const idx = new Map(rowsData.map((c, i) => [c.hash, i]));
const { LANE_W, PAD_X, ROW_H } = Graph;

check('one row per commit', layout.rows.length === rowsData.length);
check('every row has a lane', layout.rows.every((r) => r.lane >= 0));
check('width covers widest lane',
  layout.width >= (Math.max(...layout.rows.map((r) => r.lane)) + 1) * LANE_W);
check('branchy history uses several lanes',
  new Set(layout.rows.map((r) => r.lane)).size >= 3,
  [...new Set(layout.rows.map((r) => r.lane))]);
check('WORKDIR sits at the top', layout.rows[0].commit.hash === 'WORKDIR');
check('WORKDIR points at HEAD', layout.rows[0].edges[0].parent === st.oid);
check('edge count matches parent count',
  layout.rows.every((r) => r.edges.length === r.commit.parents.length));

let ordering = true, badPair = null;
for (const row of layout.rows) {
  const ci = idx.get(row.commit.hash);
  for (const e of row.edges) {
    const pi = idx.get(e.parent);
    if (pi !== undefined && pi <= ci) { ordering = false; badPair = [row.commit.subject, e.parent.slice(0, 7)]; }
  }
}
check('parents always sit below their children', ordering, badPair);

// A lane may only hold one hash at a time.
let laneClash = null;
layout.rows.forEach((row, i) => {
  row.active.forEach((h, l) => {
    if (h && row.active.filter((x, j) => x === h && j !== l).length && false) laneClash = i;
  });
  const filled = row.active.filter(Boolean).length;
  if (filled > row.active.length) laneClash = i;
});
check('lane array is well formed', laneClash === null, laneClash);

/* ── graph rendering: every edge must terminate on its parent dot ─ */
console.log('\ngraph rendering');
const svg = Graph.render(layout, idx);
check('svg well formed', svg.startsWith('<svg') && svg.endsWith('</svg>'));
check('two circles per row', (svg.match(/<circle/g) || []).length === rowsData.length * 2);
check('pending row is styled apart', svg.includes('var(--pending)'));

const dotAt = (rowIndex) => ({
  x: PAD_X + layout.rows[rowIndex].lane * LANE_W,
  y: rowIndex * ROW_H + ROW_H / 2,
});

// Pull the start and end coordinates out of every emitted <path>.
// Every command graph.js emits (M, L, A) ends on an explicit "x y" pair, so
// the final two numbers of a `d` string are always that path's endpoint.
const drawn = [...svg.matchAll(/<path d="M([\d.]+) ([\d.]+)(.*?)"/g)].map((m) => {
  const nums = m[3].match(/-?[\d.]+/g) || [];
  return {
    start: { x: Number(m[1]), y: Number(m[2]) },
    end: nums.length >= 2
      ? { x: Number(nums[nums.length - 2]), y: Number(nums[nums.length - 1]) }
      : null,
    dashed: m[0].includes('dasharray'),
  };
});

let allLand = true, missed = null;
layout.rows.forEach((row, ci) => {
  const from = dotAt(ci);
  for (const e of row.edges) {
    const pi = idx.get(e.parent);
    if (pi === undefined) continue;
    const to = dotAt(pi);
    const found = drawn.some(
      (p) => p.start.x === from.x && p.start.y === from.y &&
             p.end && p.end.x === to.x && p.end.y === to.y
    );
    if (!found) { allLand = false; missed = [row.commit.subject, e.parent.slice(0, 7), from, to]; }
  }
});
check('every edge lands exactly on its parent dot', allLand, missed);

const totalEdges = layout.rows.reduce(
  (n, r) => n + r.edges.filter((e) => idx.has(e.parent)).length, 0);
check('no stray paths drawn', drawn.length === totalEdges, [drawn.length, totalEdges]);

/* ── diff parser ───────────────────────────────────────────────── */
console.log('\ndiff parser');
const files = Diff.parse(git(['diff', '--no-color']));
check('two changed files', files.length === 2, files.map((f) => f.newPath));

const aFile = files.find((f) => f.newPath === 'a.txt');
check('a.txt parsed', !!aFile);
check('a.txt has one hunk', aFile.hunks.length === 1);
check('a.txt counts one addition', aFile.additions === 1 && aFile.deletions === 0,
  [aFile.additions, aFile.deletions]);

const mFile = files.find((f) => f.newPath === 'multi.txt');
check('multi.txt split into two hunks', mFile.hunks.length === 2, mFile.hunks.length);
check('multi.txt counts 2 add / 2 del',
  mFile.additions === 2 && mFile.deletions === 2, [mFile.additions, mFile.deletions]);
check('line numbers advance correctly',
  mFile.hunks[0].lines.some((l) => l.type === 'add' && l.new === 3),
  mFile.hunks[0].lines.filter((l) => l.type === 'add'));

/* ── hunk patches must be accepted by git itself ───────────────── */
console.log('\nhunk patches');
const tryApply = (patch, extraArgs = []) => {
  try {
    git(['apply', '--check', ...extraArgs, '-'], { input: patch });
    return null;
  } catch (e) {
    return String(e.stderr || e.message).trim();
  }
};

check('a.txt hunk applies to the index',
  tryApply(Diff.hunkPatch(aFile, aFile.hunks[0]), ['--cached']) === null,
  tryApply(Diff.hunkPatch(aFile, aFile.hunks[0]), ['--cached']));

mFile.hunks.forEach((h, i) => {
  const err = tryApply(Diff.hunkPatch(mFile, h), ['--cached']);
  check(`multi.txt hunk ${i + 1} applies on its own`, err === null, err);
});

// Actually stage one hunk and confirm only that hunk moved to the index.
git(['apply', '--cached', '-'], { input: Diff.hunkPatch(mFile, mFile.hunks[0]) });
const afterStage = P.parseStatus(git(['status', '--porcelain=v2', '--branch', '-z']));
check('multi.txt now appears staged AND unstaged',
  afterStage.staged.some((f) => f.path === 'multi.txt') &&
  afterStage.unstaged.some((f) => f.path === 'multi.txt'));
const stagedDiff = Diff.parse(git(['diff', '--cached', '--no-color', '--', 'multi.txt']));
check('only the first hunk was staged',
  stagedDiff[0].hunks.length === 1 &&
  stagedDiff[0].hunks[0].lines.some((l) => l.text === 'CHANGED TOP'),
  stagedDiff[0].hunks.length);

/* Side-by-side draws only the rows in the window, and where it cuts comes from
   pairCount rather than from the rows themselves. If the two ever disagree the
   pane scrolls to offsets its content does not have, so they are checked
   against each other on every hunk of a real diff — including the awkward ones:
   a removal with no partner, an addition with no partner, and an uneven run. */
{
  let hunks = 0;
  let agree = 0;
  let paired = 0;
  const seen = new Set();
  for (const f of files.concat(stagedDiff)) {
    for (const h of f.hunks || []) {
      hunks += 1;
      const rows = Diff.pairRows(h);
      if (Diff.pairCount(h) === rows.length) agree += 1;
      for (const r of rows) {
        if (r.left && r.right && !r.ctx) paired += 1;
        seen.add(r.left && r.right ? 'both' : r.left ? 'left' : 'right');
      }
    }
  }
  check('pairCount agrees with the rows pairRows builds, on every hunk',
    hunks > 0 && agree === hunks, `${agree}/${hunks}`);
  check('the fixture exercises additions and pairs',
    seen.has('right') && seen.has('both'), [...seen].join(','));

  /* Constructed rather than found: an uneven run is where a miscount hides, and
     the fixture happens not to contain one. Four removals against one addition
     is four rows, three of them with an empty right half. */
  const uneven = Diff.parse(
    'diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1,6 +1,3 @@\n' +
    ' keep\n-one\n-two\n-three\n-four\n+ONE\n keep2');
  const un = uneven[0].hunks[0];
  check('four removals against one addition is four rows, not five',
    Diff.pairCount(un) === 6 && Diff.pairRows(un).length === 6,
    Diff.pairCount(un));
  check('the three unpartnered removals leave the right half empty',
    Diff.pairRows(un).filter((r) => r.left && !r.right).length === 3,
    Diff.pairRows(un).filter((r) => r.left && !r.right).length);
  check('side-by-side and unified count different totals for the same diff',
    Diff.rowCountSplit(files) < Diff.rowCount(files) || paired === 0,
    `${Diff.rowCountSplit(files)} vs ${Diff.rowCount(files)}`);

  // A window has to name the same rows the renderer draws.
  const html = Diff.renderSplit(files, [], { first: 0, last: 3, rowH: 20, headH: 27 });
  const drawn = (html.match(/<tr>/g) || []).length;
  check('a three-row window draws at most three rows', drawn <= 3 && drawn > 0, drawn);
  check('the rows left out keep their height', html.includes('class="dl-gap"') ||
    html.includes('hunk-gap'));
}

/* A fixed table takes its column widths from whichever row comes first. Once a
   side-by-side window has scrolled that row is a spacer spanning all four
   columns, which says nothing about any one of them — so the columns collapsed
   to equal quarters and the left side slid into the middle of the pane. The
   widths are declared on the table now, and this is what says so. */
{
  const many = ['diff --git a/y b/y', '--- a/y', '+++ b/y', '@@ -1,100 +1,100 @@'];
  for (let i = 0; i < 100; i++) many.push((i % 5 === 0 ? '-old ' : ' ctx ') + i);
  const wide = Diff.parse(many.join('\n'));
  const win = Diff.renderSplit(wide, [], { first: 40, last: 60, rowH: 20, headH: 27 });
  check('side-by-side declares its columns instead of inferring them',
    win.includes('<colgroup>') && win.indexOf('<colgroup>') < win.indexOf('<tbody>'));
  check('four columns are declared, two numbers and two texts',
    (win.match(/<col class="c-num">/g) || []).length === 2 &&
    (win.match(/<col class="c-text">/g) || []).length === 2);
  // The row that used to dictate the widths: a spacer, first inside the body.
  const body = win.slice(win.indexOf('<tbody>'));
  check('a scrolled window really does open with a spacer row',
    body.indexOf('dl-gap') < body.indexOf('<tr>') && body.includes('colspan="4"'));
}

/* A wrapped row is not the same height as its neighbour, so the spacers that
   stand in for the rows outside the window cannot be a row count times one
   height. They are measured, and passed in as running totals. If the spacers
   and the model disagree, the page is a different height from the map that
   decides what to draw, and the diff slides under the pointer as it scrolls. */
{
  const src = ['diff --git a/z b/z', '--- a/z', '+++ b/z', '@@ -1,10 +1,10 @@'];
  for (let i = 0; i < 10; i++) src.push((i === 3 ? '-row ' : ' row ') + i);
  const one = Diff.parse(src.join('\n'));
  const n = one[0].hunks[0].lines.length;

  // Rows 0-2 are 20px, rows 3-9 are 60px: a run that is nothing like uniform.
  const rowSum = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) rowSum[i + 1] = rowSum[i] + (i < 3 ? 20 : 60);

  const html = Diff.render(one, [], { first: 5, last: 7, rowH: 20, headH: 27, rowSum });
  const gaps = [...html.matchAll(/class="dl-gap" style="height:(\d+(?:\.\d+)?)px"/g)]
    .map((m) => Number(m[1]));
  check('the spacer above the window is as tall as the rows it replaces',
    gaps[0] === rowSum[5], `${gaps[0]} vs ${rowSum[5]}`);
  check('the spacer below it covers the rest of the hunk',
    gaps[1] === rowSum[n] - rowSum[7], `${gaps[1]} vs ${rowSum[n] - rowSum[7]}`);
  check('the two spacers plus the window account for the whole hunk',
    gaps[0] + gaps[1] + (rowSum[7] - rowSum[5]) === rowSum[n]);

  // Without measurements it must still fall back to one height per row.
  const plain = Diff.render(one, [], { first: 5, last: 7, rowH: 20, headH: 27 });
  const flat = [...plain.matchAll(/class="dl-gap" style="height:(\d+)px"/g)].map((m) => Number(m[1]));
  check('with nothing measured, spacers go back to a row count times one height',
    flat[0] === 5 * 20 && flat[1] === (n - 7) * 20, flat.join('/'));

  // Side-by-side takes the same offsets.
  const sp = Diff.renderSplit(one, [], { first: 5, last: 7, rowH: 20, headH: 27, rowSum });
  const spGaps = [...sp.matchAll(/class="dl-gap" style="height:(\d+(?:\.\d+)?)px"/g)]
    .map((m) => Number(m[1]));
  check('side-by-side spacers use the measured heights too',
    spGaps.length === 2 && spGaps[0] === rowSum[5], spGaps.join('/'));
}

console.log('\ndragging a tab into place');
{
  /* The order lives in `tabs` and the strip is drawn from it, so a drag moves
     the element and the array is read back from the document afterwards. One
     direction only — the two cannot disagree halfway. */
  const reorder = (arr, domOrder) =>
    [...arr].sort((a, b) => domOrder.indexOf(a.id) - domOrder.indexOf(b.id)).map((t) => t.id);
  const four = [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }];
  check('the array follows the strip', reorder(four, ['b', 'c', 'a', 'd']).join('') === 'bcad');
  check('a tab dragged to the front lands at the front',
    reorder(four, ['d', 'a', 'b', 'c']).join('') === 'dabc');
  check('an unchanged strip leaves the order alone',
    reorder(four, ['a', 'b', 'c', 'd']).join('') === 'abcd');

  /* The faults this cost, both of which stopped the strip answering at all. */
  check('a stale "just dragged" mark cannot outlive its click',
    /if \(tabDrag === 'dropped'\) tabDrag = null;/.test(rendererSrc));
  check('the drag is let go of before anything that can fail',
    /tabDrag = moved \? 'dropped' : null;[\s\S]{0,200}releasePointerCapture/.test(rendererSrc));
  check('taking and releasing the pointer are both allowed to fail',
    (rendererSrc.match(/try \{ tabsStrip\(\)\.(set|release)PointerCapture/g) || []).length === 2);
  check('redrawing stands aside for a live drag, not for a leftover',
    /tabDrag !== 'dropped' && tabDrag\.moved/.test(rendererSrc));
  check('the close button is a button, not a drag handle',
    /if \(e\.target\.closest\('\[data-close\]'\)\) return;/.test(rendererSrc));
  check('a click that wanders a few pixels is still a click',
    /Math\.abs\(dx\) < 5/.test(rendererSrc));
  check('the new order is written down, not only shown',
    /const order = \[\.\.\.tabsStrip\(\)[\s\S]{0,200}saveTabs\(\)/.test(rendererSrc));
}

console.log('\nfinishing an update');
{
  /* Downloading used to end in app.quit(). Whatever was typed into a commit
     message went with it, since nothing wrote that down — so the update had to
     stop restarting on its own, and the draft had to start surviving. */
  // Sliced to the one function: installing on request is still right, and the
  // .deb path below does exactly that. What must be gone is installing unasked.
  const offerSrc = rendererSrc.slice(
    rendererSrc.indexOf('async function offerUpdate()'),
    rendererSrc.indexOf('async function offerRestart(')
  );
  check('the download no longer ends in an install',
    offerSrc.length > 0 && !offerSrc.includes("update:install"), offerSrc.length);
  check('it offers a restart instead', /offerRestart\(file\)/.test(rendererSrc));
  check('"Later" is a named choice, not a cancel',
    /cancelLabel: 'Later'/.test(rendererSrc));
  check('putting it off stages it for quitting time',
    /update:later/.test(rendererSrc) && /will-quit/.test(mainSrc));
  check('and the swap is the same one an immediate install does',
    (mainSrc.match(/swapAppImage/g) || []).length >= 3);
  check('a .deb cannot be staged — it needs an installer, not a rename',
    /kind !== 'appimage'\) return \{ staged: false \}/.test(mainSrc));
  check('quitting is never blocked by a failed swap',
    /try \{ swapAppImage\(file\); \} catch/.test(mainSrc));

  /* The draft, kept per repository. */
  const drafts = {};
  const put = (repo, msg, body, amend) => {
    if (!msg.trim() && !body.trim() && !amend) delete drafts[repo];
    else drafts[repo] = { msg, body, amend };
  };
  put('/a', 'fix: half written', '', false);
  check('a draft is stored under its repository', drafts['/a'].msg === 'fix: half written');
  put('/b', 'other repo', '', false);
  check('two repositories keep two drafts',
    drafts['/a'].msg !== drafts['/b'].msg && Object.keys(drafts).length === 2);
  put('/a', '', '', false);
  check('clearing the box clears the draft rather than storing an empty one',
    !('/a' in drafts) && Object.keys(drafts).length === 1);
  put('/b', '  ', '  ', false);
  check('whitespace alone is not a draft', !('/b' in drafts));
  put('/c', '', '', true);
  check('but a ticked amend box is worth remembering on its own', drafts['/c'].amend === true);

  check('the draft is written as it is typed, not only at closing time',
    /addEventListener\('input', noteDraft\)/.test(rendererSrc));
  check('and once more on the way out, for the last few keystrokes',
    /beforeunload[\s\S]{0,80}saveDraft\(\)/.test(rendererSrc));
  check('committing clears it, so it cannot come back later',
    /clearDraft\(repoPath\(\)\)/.test(rendererSrc));
}

console.log('\nthe desktop entry');
{
  /* The dock matches a window to its launcher by the window's WM_CLASS, and the
     match is case-sensitive. Electron takes WM_CLASS from the name of the
     executable, so StartupWMClass has to be that name exactly — it said
     "GitBraid" while every window reported "gitbraid", and the shell fell back
     to guessing, which is why the icon arrived late. */
  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
  const exe = pkg.build.executableName || pkg.name;
  const desktop = pkg.build.linux.desktop;
  check('StartupWMClass is exactly the executable name',
    desktop.StartupWMClass === exe, `${desktop.StartupWMClass} vs ${exe}`);
  check('and it is spelled the way a window would report it',
    desktop.StartupWMClass === desktop.StartupWMClass.toLowerCase(),
    desktop.StartupWMClass);
  check('the launcher still announces itself as starting',
    desktop.StartupNotify === 'true');
  check('the icon is named, so the theme has something to look up',
    Boolean(pkg.build.linux.icon));
}

console.log('\nfile history and ignoring');
{
  /* The name a file had at each commit is read out of --name-status. Asking a
     commit made before a rename for today's path returns nothing, which reads
     as "this commit changed nothing" when what it changed was a file under
     another name. A rename line names both; everything else names one. */
  const nameAt = (record) => {
    const parts = record.split('\t');
    return parts.length >= 3 ? parts[2] : parts[1];
  };
  check('a modification names the file', nameAt('M\tsrc/app.js') === 'src/app.js');
  check('an addition names the file', nameAt('A\tsrc/new.js') === 'src/new.js');
  check('a deletion names the file', nameAt('D\tsrc/gone.js') === 'src/gone.js');
  check('a rename names the file it became, not the one it was',
    nameAt('R100\told-name.txt\tnew-name.txt') === 'new-name.txt');
  check('a partial rename is still a rename',
    nameAt('R087\tsrc/a.js\tsrc/b.js') === 'src/b.js');

  /* Appending to .gitignore. A file that does not end in a newline would have
     the next pattern joined onto its last line. */
  const append = (text, add) => text + (text && !text.endsWith('\n') ? '\n' : '') + add + '\n';
  check('a pattern is added on its own line', append('*.log\n', 'build/') === '*.log\nbuild/\n');
  check('a file with no trailing newline gets one first',
    append('*.log', 'build/') === '*.log\nbuild/\n');
  check('an empty .gitignore needs no leading newline', append('', 'build/') === 'build/\n');

  const seen = (text) => new Set(text.split(/\r?\n/).map((l) => l.trim()));
  check('a pattern already there is not written twice', seen('*.log\nbuild/\n').has('build/'));
  check('and one that is not there is recognised as new', !seen('*.log\n').has('build/'));

  // The same guard as the other list-taking commands.
  for (const name of ['ignore', 'stop tracking']) {
    check(`the ${name} handler refuses an empty list`,
      new RegExp(`Nothing was named to ${name}`).test(mainSrc));
  }
  check('file history refuses to run without a file',
    /No file was named/.test(mainSrc));
  check('file history follows renames', /'--follow'/.test(mainSrc));
  check('and asks git not to escape unusual paths',
    /core\.quotePath=false/.test(mainSrc));
}

console.log('\ncommands that take a list of files');
{
  /* Every one of these builds a git command ending in `-- <paths>`. Handed an
     empty list, that pathspec disappears and the command takes the whole
     working tree instead of the files a menu entry named. The guard is the
     same shape in each, so it is checked in each. */
  const guardSrc = mainSrc.match(
    /const list = \(Array\.isArray\(files\)[\s\S]*?\.filter\(\(f\) => typeof f === 'string' && f\.trim\(\)\);/g
  ) || [];
  check('every list-taking command filters its input the same way',
    guardSrc.length >= 3, guardSrc.length);

  const clean = (files) => (Array.isArray(files) ? files : [files])
    .filter((f) => typeof f === 'string' && f.trim());
  check('an empty list stays empty', clean([]).length === 0);
  check('blank names are not paths', clean(['', '  ', '\t']).length === 0);
  check('a bare string is not spread into letters',
    clean('file.txt').length === 1 && clean('file.txt')[0] === 'file.txt');
  check('anything that is not a string is dropped',
    clean(['ok.txt', null, 7, {}, undefined]).join(',') === 'ok.txt');

  // And the callers refuse rather than run with nothing named.
  for (const name of ['discard', 'stash', 'save']) {
    check(`the ${name} handler refuses an empty list`,
      new RegExp(`Nothing was named to ${name}`).test(mainSrc));
  }
}

console.log('\nrelease notes shown in the update dialog');
{
  const h = (t) => N.notesHtml(t);

  // What went wrong: the dialog printed the body raw, so this arrived as pipes.
  const table = h('| diff | before | after |\n|---|---|---|\n| unified | 93 ms | **7 ms** |');
  check('a markdown table becomes a table',
    table.includes('<table') && table.includes('<th>diff</th>') &&
    table.includes('<td>unified</td>'), table.slice(0, 80));
  check('nothing of the pipes survives into the text',
    !table.replace(/<[^>]*>/g, '').includes('|'), table.replace(/<[^>]*>/g, ''));
  check('emphasis inside a cell is emphasis, not asterisks',
    table.includes('<strong>7 ms</strong>') &&
    !table.replace(/<[^>]*>/g, '').includes('*'));

  check('a heading becomes a heading', h('### When it fails').includes('<h4>When it fails</h4>'));
  check('a bullet list becomes a list',
    h('- one\n- two').includes('<ul><li>one</li><li>two</li></ul>'));
  check('a wrapped bullet is still one bullet',
    h('- one that runs\n  over two lines\n- two')
      .includes('<li>one that runs over two lines</li>'));
  check('inline code keeps its own face',
    h('run `git push` first').includes('<code>git push</code>'));
  check('a link keeps its words and loses its address',
    h('see [the page](https://example.com/x)') === '<p>see the page</p>',
    h('see [the page](https://example.com/x)'));
  check('an empty body says so rather than showing nothing',
    h('').includes('No notes were written'));

  /* The body comes from a release page, which is not something the app decides
     the contents of. It must never be able to put markup into the window. */
  const hostile = h('<img src=x onerror="boom()">\n\n| a | <b>b</b> |\n|---|---|\n| 1 | 2 |');
  check('markup in a release body is shown, never run',
    !/<img|<b>|onerror=/.test(hostile.replace(/&lt;|&gt;|&quot;/g, '')) ||
    hostile.includes('&lt;img'), hostile.slice(0, 90));
  check('and the table beside it still renders', hostile.includes('<table'));
}

// And unstage it again with the reverse patch, the way the UI does.
git(['apply', '--cached', '--reverse', '-'], { input: Diff.hunkPatch(mFile, mFile.hunks[0]) });
const afterUnstage = P.parseStatus(git(['status', '--porcelain=v2', '--branch', '-z']));
check('reverse patch unstages cleanly',
  !afterUnstage.staged.some((f) => f.path === 'multi.txt'),
  afterUnstage.staged.map((f) => f.path));

/* ── rendering + escaping ──────────────────────────────────────── */
console.log('\ndiff rendering');
const html = Diff.render(files, [{ action: 'stage', label: 'Stage hunk' }]);
check('one button per hunk', (html.match(/data-hunk-action="stage"/g) || []).length === 3,
  (html.match(/data-hunk-action="stage"/g) || []).length);
check('hunk indices are per file',
  html.includes('data-file="1" data-hunk="1"'));
check('html is escaped', Diff.render(
  Diff.parse('diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n+<img onerror=x>\n')
).includes('&lt;img onerror=x&gt;'));

/* ── empty and edge cases ──────────────────────────────────────── */
console.log('\nedge cases');
check('empty diff yields no files', Diff.parse('').length === 0);
check('empty log yields no commits', P.parseLog('').length === 0);
check('clean status has no entries', (() => {
  const s = P.parseStatus('# branch.head main\0');
  return s.staged.length === 0 && s.unstaged.length === 0 && s.branch === 'main';
})());
check('layout survives an empty history', Graph.layout([]).rows.length === 0);
check('single root commit renders', (() => {
  const l = Graph.layout([{ hash: 'x', parents: [] }]);
  return l.rows.length === 1 && l.rows[0].lane === 0;
})());
check('detached HEAD reported as null branch', (() => {
  const s = P.parseStatus('# branch.head (detached)\0');
  return s.branch === null;
})());
check('ahead/behind parsed', (() => {
  const s = P.parseStatus('# branch.ab +3 -5\0');
  return s.ahead === 3 && s.behind === 5;
})());

/* ── the parts that behave differently on each platform ────────
   These cannot be exercised by running the app here, so they are tested as
   pure functions instead: the source is read and evaluated with the platform
   pinned, which is the only honest way to check Windows behaviour on Linux. */

/** Pull one declaration out of a source file and evaluate it in isolation. */
function lift(src, pattern, names, platform) {
  const code = src.match(pattern)[0];
  const ctx = {
    process: { platform, env: { PATH: '', PATHEXT: '.EXE;.CMD' } },
    require, module: {}, console, JSON, Math, Number, String, Object, Array,
  };
  vm.createContext(ctx);
  vm.runInContext(`${code}\nglobalThis.__out = { ${names.join(', ')} };`, ctx);
  return ctx.__out;
}

const nullDevice = (platform) => lift(
  mainSrc,
  /const IS_WIN = process\.platform === 'win32';[\s\S]*?const NULL_DEVICE = .*?;/,
  ['NULL_DEVICE'], platform).NULL_DEVICE;

check('empty-file placeholder is /dev/null on Linux', nullDevice('linux') === '/dev/null');
check('empty-file placeholder is /dev/null on macOS', nullDevice('darwin') === '/dev/null');
check('empty-file placeholder is NUL on Windows', nullDevice('win32') === 'NUL');

const pathHelpers = (() => {
  const code = rendererSrc.match(/const lastSep = [\s\S]*?const baseName = .*?;/)[0];
  const ctx = { Math };
  vm.createContext(ctx);
  vm.runInContext(`${code}\nglobalThis.__out = { parentOf, baseName };`, ctx);
  return ctx.__out;
})();

/* ── preferences that changed name ─────────────────────────────── */
/* Renaming a stored setting is the kind of change nobody notices until someone
   upgrades and quietly loses what they had switched on. */
const loadPrefs = (stored) => {
  const code = rendererSrc.match(
    /const PREF_DEFAULTS = \{[\s\S]*?\n\};\n\nconst prefs = \{ \.\.\.PREF_DEFAULTS \};\ntry \{[\s\S]*?\n\} catch \{ \/\* private mode \*\/ \}/)[0];
  const ctx = { JSON, Object, localStorage: { getItem: () => JSON.stringify(stored) } };
  vm.createContext(ctx);
  vm.runInContext(`${code}\nglobalThis.__out = prefs;`, ctx);
  return ctx.__out;
};

check('a reader who had Gravatar on keeps author photos on',
  loadPrefs({ gravatar: true }).authorPhotos === true);
check('a reader who had it off keeps it off',
  loadPrefs({ gravatar: false }).authorPhotos === false);
check('a fresh install has author photos off',
  loadPrefs({}).authorPhotos === false);
check('the newer key wins when both are stored',
  loadPrefs({ gravatar: false, authorPhotos: true }).authorPhotos === true);
check('the old key is not carried forward',
  loadPrefs({ gravatar: true }).gravatar === undefined);
check('settings either side of it survive the rename', (() => {
  const p = loadPrefs({ gravatar: true, commitLimit: 1200, dateStyle: 'relative' });
  return p.commitLimit === 1200 && p.dateStyle === 'relative';
})());

/* ── updates ───────────────────────────────────────────────────── */

const updateBits = lift(
  mainSrc,
  /\/\* "0\.10\.0" is newer[\s\S]*?^}/m,
  ['isNewer'], 'linux');

check('0.10.0 is newer than 0.9.0', updateBits.isNewer('0.10.0', '0.9.0'));
check('0.2.1 is newer than 0.2.0', updateBits.isNewer('0.2.1', '0.2.0'));
check('1.0.0 is newer than 0.99.99', updateBits.isNewer('1.0.0', '0.99.99'));
check('a leading v is ignored', updateBits.isNewer('v0.3.0', '0.2.0'));
check('the same version is not newer', !updateBits.isNewer('0.2.0', '0.2.0'));
check('an older version is not newer', !updateBits.isNewer('0.1.2', '0.2.0'));
check('0.2 counts as 0.2.0', !updateBits.isNewer('0.2', '0.2.0'));

const checksumBits = lift(
  mainSrc,
  /\/\* The yml is small and regular[\s\S]*?^}/m,
  ['matchChecksum'], 'linux');

const SAMPLE_YML = [
  'version: 0.2.0',
  'files:',
  '  - url: GitBraid-0.2.0.AppImage',
  '    sha512: AAAAbbbbCCCC==',
  '    size: 107420679',
  '  - url: gitbraid_0.2.0_amd64.deb',
  '    sha512: DDDDeeeeFFFF==',
  '    size: 74393848',
  'path: GitBraid-0.2.0.AppImage',
].join('\n');

check('the AppImage checksum is read from latest-linux.yml',
  checksumBits.matchChecksum(SAMPLE_YML, 'GitBraid-0.2.0.AppImage') === 'AAAAbbbbCCCC==');
check('the deb checksum is read from the same file',
  checksumBits.matchChecksum(SAMPLE_YML, 'gitbraid_0.2.0_amd64.deb') === 'DDDDeeeeFFFF==');
check('a file the yml does not mention has no checksum',
  checksumBits.matchChecksum(SAMPLE_YML, 'GitBraid-9.9.9.AppImage') === '');

/* The one that matters: the checksum this reads out of a real latest-linux.yml
   has to be the checksum of the real artifact beside it, or an update would be
   refused every time. */
(() => {
  const yml = path.join(__dirname, '..', 'dist', 'latest-linux.yml');
  if (!fs.existsSync(yml)) return;                 // nothing built yet
  const text = fs.readFileSync(yml, 'utf8');
  const names = [...text.matchAll(/url: (\S+)/g)].map((m) => m[1]);
  /* electron-builder writes this file last, so an artifact newer than it means
     a build is in flight and dist holds one from each. Comparing then fails on
     nothing the code did — and a suite that goes red for reasons outside itself
     is worse than one check fewer. */
  const stamp = fs.statSync(yml).mtimeMs;
  const midBuild = names.some((n) => {
    const f = path.join(__dirname, '..', 'dist', n);
    return fs.existsSync(f) && fs.statSync(f).mtimeMs > stamp + 1000;
  });
  if (midBuild) {
    console.log('  skip dist checksums — a build is part-way through');
    return;
  }
  for (const name of names) {
    const file = path.join(__dirname, '..', 'dist', name);
    if (!fs.existsSync(file)) continue;
    const want = checksumBits.matchChecksum(text, name);
    const got = require('crypto').createHash('sha512')
      .update(fs.readFileSync(file)).digest('base64');
    check(`${name} matches the checksum published for it`, want === got,
      `read ${want.slice(0, 16)}… computed ${got.slice(0, 16)}…`);
  }
})();

check('repository name read from a POSIX path',
  pathHelpers.baseName('/home/me/code/app') === 'app');
check('repository name read from a Windows path',
  pathHelpers.baseName('C:\\Users\\me\\code\\app') === 'app');
check('parent folder of a POSIX path',
  pathHelpers.parentOf('/home/me/code/app') === '/home/me/code');
check('parent folder of a Windows path',
  pathHelpers.parentOf('C:\\Users\\me\\code\\app') === 'C:\\Users\\me\\code');
check('a path with no separator is its own name',
  pathHelpers.baseName('app') === 'app');

/* The terminal tables: each entry must put the folder in the arguments, not
   rely on the spawned process's cwd — the GNOME family ignores it. */
function terminals(platform) {
  // The tables sit far from the platform flags they read, so both are lifted.
  const flags = mainSrc.match(/const IS_WIN = .*?;\nconst IS_MAC = .*?;/)[0];
  const tables = mainSrc.match(/const TERMINALS = \[[\s\S]*?const terminalsForPlatform = [\s\S]*?;/)[0];
  const ctx = { process: { platform }, JSON };
  vm.createContext(ctx);
  vm.runInContext(`${flags}\n${tables}\nglobalThis.__out = terminalsForPlatform();`, ctx);
  return ctx.__out;
}

for (const [name, platform, expect] of [
  ['Linux', 'linux', 'ptyxis'], ['macOS', 'darwin', 'open'], ['Windows', 'win32', 'wt.exe'],
]) {
  const list = terminals(platform);
  check(`${name} has terminals to try`, list.length > 0 && list[0].cmd === expect);
  check(`${name} terminals carry the folder in their arguments`,
    list.every((t) =>
      // A terminal may only rely on the spawn cwd if it says so in the table:
      // the GNOME family ignores cwd entirely, so silence there is a bug.
      t.usesCwd === true || t.dir('/tmp/x').join(' ').includes('/tmp/x')));
}

fs.rmSync(REPO, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
