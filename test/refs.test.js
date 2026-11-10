/* Branches, remotes and the operations that move them: each check drives the
 * real handler against real git and then reads the repository — refs, upstream
 * config, what the remote holds — rather than the arguments that were built.
 * The few decisions the window makes before calling (which remote, which full
 * ref name, what lease) are lifted out of the renderer and checked as they are. */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const { execFileSync } = require('child_process');
const { loadMain, scratchRepo, reporter, ROOT } = require('./harness');

const { check, section, done } = reporter();
const m = loadMain();
const call = m.call;

const ENV = {
  ...process.env, LC_ALL: 'C', GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 'Tester', GIT_AUTHOR_EMAIL: 't@t.io',
  GIT_COMMITTER_NAME: 'Tester', GIT_COMMITTER_EMAIL: 't@t.io',
};
const gitIn = (cwd, args) => execFileSync('git', args, {
  cwd, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], env: ENV,
});
const tryGit = (cwd, args) => { try { return gitIn(cwd, args).trim(); } catch { return ''; } };
const made = [];
const tmp = (prefix) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix)); made.push(d); return d; };
const bare = (prefix = 'gitbraid-remote-') => {
  const d = tmp(prefix);
  gitIn(d, ['init', '-q', '--bare', '-b', 'main']);
  return d;
};
/* A second working copy of a remote, standing in for someone else pushing. */
const otherClone = (remote) => {
  const d = path.join(tmp('gitbraid-other-'), 'w');
  gitIn(path.dirname(d), ['clone', '-q', remote, d]);
  gitIn(d, ['config', 'user.name', 'Other']);
  gitIn(d, ['config', 'user.email', 'o@t.io']);
  return d;
};
const lsRemote = (remote) => Object.fromEntries(tryGit(remote, ['for-each-ref', '--format=%(refname) %(objectname)'])
  .split('\n').filter(Boolean).map((l) => l.split(' ').reverse()).map(([oid, ref]) => [ref, oid]));

/* ── the window's half, lifted from the renderer ── */
const rendererSrc = fs.readFileSync(path.join(ROOT, 'src/renderer.js'), 'utf8');
const lift = (start, end) => {
  const a = rendererSrc.indexOf(start);
  const b = rendererSrc.indexOf(end, a);
  return a < 0 || b < 0 ? '' : rendererSrc.slice(a, b + end.length);
};
const R = {};
try {
  vm.runInNewContext([
    lift('function fullRefName(', '\n}\n'),
    lift('const shortRefName =', ';\n'),
    lift('function pushPlan(b, refs) {', '\n}\n'),
    lift('const leaseExpect =', ";\n"),
    lift('async function askPushTarget(b, plan) {', '\n}\n'),
  ].join('\n') + '\nthis.fullRefName = fullRefName; this.shortRefName = shortRefName;'
    + ' this.pushPlan = pushPlan; this.leaseExpect = leaseExpect;'
    + ' this.askPushTarget = typeof askPushTarget === "function" ? askPushTarget : undefined;', R);
} catch (e) {
  console.log('  (renderer helpers could not be lifted: ' + e.message + ')');
}
const has = (fn) => typeof R[fn] === 'function';
/* The dialog, answered by the test: it records what it was asked and replies
   with whatever R.answer holds at the time. */
R.asked = [];
R.modal = async (opts) => { R.asked.push(opts); return R.answer; };

(async () => {
  /* ── 1 ── */
  section('renaming a branch cannot be turned into an option');
  {
    const r = scratchRepo();
    const base = r.commit('a.txt', '1\n', 'one');
    r.g(['checkout', '-qb', 'other']);
    const own = r.commit('o.txt', 'o\n', 'only on other');
    r.g(['checkout', '-q', 'main']);
    const res = await call('repo:renameBranch', r.dir, 'other', '-M');
    check('a new name of "-M" is refused', res.ok === false, res);
    check('and both branches are exactly where they were',
      tryGit(r.dir, ['rev-parse', 'refs/heads/main']) === base
      && tryGit(r.dir, ['rev-parse', 'refs/heads/other']) === own,
      tryGit(r.dir, ['branch', '-v']));
    const bad = await call('repo:renameBranch', r.dir, '-D', 'x');
    check('an old name that starts with a dash is refused too', bad.ok === false, bad);
    const ok = await call('repo:renameBranch', r.dir, 'other', 'feature/other');
    check('an ordinary rename still renames',
      ok.ok && tryGit(r.dir, ['rev-parse', 'refs/heads/feature/other']) === own
      && !tryGit(r.dir, ['rev-parse', '-q', '--verify', 'refs/heads/other']), ok);
    r.rm();
  }

  /* ── 2 ── */
  section('a branch and a tag with the same name stay two things');
  {
    const remote = bare();
    const r = scratchRepo();
    const base = r.commit('a.txt', '1\n', 'base');
    r.g(['checkout', '-qb', 'x']);
    const onX = r.commit('x.txt', 'x\n', 'on branch x');
    r.g(['checkout', '-q', 'main']);
    r.g(['tag', 'x', base]);
    r.g(['remote', 'add', 'origin', remote]);
    r.g(['push', '-q', 'origin', 'main']);
    r.g(['fetch', '-q', 'origin']);

    const refs = (await call('repo:refs', r.dir)).data;
    check('the renderer sends the branch\'s full name', has('fullRefName')
      && R.fullRefName('branch', 'x', refs) === 'refs/heads/x'
      && R.fullRefName('tag', 'x', refs) === 'refs/tags/x'
      && R.fullRefName('remote', 'origin/main', refs) === 'refs/remotes/origin/main');
    check('and shows the short one', has('shortRefName')
      && R.shortRefName('refs/heads/feature/a') === 'feature/a'
      && R.shortRefName('refs/remotes/origin/a') === 'origin/a'
      && R.shortRefName('abc1234') === 'abc1234');

    const info = await call('repo:mergeInfo', r.dir, 'refs/heads/x');
    check('merge info counts the branch, not the tag',
      info.ok && info.data.incoming === 1 && info.data.head === 'main', info);
    const cmp = await call('repo:compare', r.dir, 'HEAD', 'refs/heads/x', false, 3);
    check('compare shows what the branch has', cmp.ok && /x\.txt/.test(cmp.data), cmp);
    const tag = await call('repo:tag', r.dir, 'at-x', 'refs/heads/x', '');
    check('a tag made at the branch lands on the branch',
      tag.ok && tryGit(r.dir, ['rev-parse', 'refs/tags/at-x']) === onX, tag);
    const nb = await call('repo:createBranch', r.dir, 'from-x', 'refs/heads/x', false);
    check('a branch started from it starts at the branch',
      nb.ok && tryGit(r.dir, ['rev-parse', 'refs/heads/from-x']) === onX, nb);

    const merged = await call('repo:merge', r.dir, 'refs/heads/x', 'no-ff');
    check('merging the branch brings in the branch\'s commit',
      merged.ok && tryGit(r.dir, ['rev-parse', 'HEAD^2']) === onX, merged);
    check('and the message names it without spelling out refs/heads',
      /^Merge branch '(heads\/)?x'/.test(tryGit(r.dir, ['log', '-1', '--format=%s'])),
      tryGit(r.dir, ['log', '-1', '--format=%s']));

    r.g(['checkout', '-qb', 'plain', base]);
    const onPlain = r.commit('p.txt', 'p\n', 'on plain');
    r.g(['checkout', '-q', 'main']);
    await call('repo:merge', r.dir, 'refs/heads/plain', 'no-ff');
    check('an unambiguous branch merges with git\'s usual message',
      tryGit(r.dir, ['log', '-1', '--format=%s']) === "Merge branch 'plain'"
      && tryGit(r.dir, ['rev-parse', 'HEAD^2']) === onPlain,
      tryGit(r.dir, ['log', '-1', '--format=%s']));

    r.g(['checkout', '-qb', 'side', base]);
    r.commit('s.txt', 's\n', 'on side');
    const rb = await call('repo:rebase', r.dir, 'refs/heads/x');
    check('rebasing onto the branch puts its commit underneath',
      rb.ok && tryGit(r.dir, ['merge-base', '--is-ancestor', onX, 'HEAD']) === ''
      && tryGit(r.dir, ['rev-parse', 'HEAD~1']) === onX, rb);

    const co = await call('repo:checkoutWith', r.dir, 'refs/heads/x', 'keep');
    check('checking out the branch leaves you on the branch, not detached, and not on the tag',
      co.ok && tryGit(r.dir, ['symbolic-ref', '-q', 'HEAD']) === 'refs/heads/x'
      && tryGit(r.dir, ['rev-parse', 'HEAD']) === onX, co);
    const ct = await call('repo:checkoutWith', r.dir, 'refs/tags/x', 'keep');
    check('checking out the tag detaches at the tag',
      ct.ok && tryGit(r.dir, ['symbolic-ref', '-q', 'HEAD']) === ''
      && tryGit(r.dir, ['rev-parse', 'HEAD']) === base, ct);
    r.g(['checkout', '-q', 'x']);

    const pushed = await call('repo:pushBranch', r.dir,
      { branch: 'x', remote: 'origin', remoteRef: 'refs/heads/x', setUpstream: true });
    check('a branch that shares its name with a tag can be pushed',
      pushed.ok && lsRemote(remote)['refs/heads/x'] === onX && !lsRemote(remote)['refs/tags/x'], pushed);

    // A local branch spelled like a remote-tracking one.
    r.g(['checkout', '-q', 'main']);
    r.g(['branch', 'origin/main', base]);
    const viaRemote = await call('repo:mergeInfo', r.dir, 'refs/remotes/origin/main');
    const remoteMain = tryGit(r.dir, ['rev-parse', 'refs/remotes/origin/main']);
    const expectOut = Number(tryGit(r.dir, ['rev-list', '--count', `${remoteMain}..HEAD`]));
    check('origin/main means the remote branch even beside a local branch of that name',
      viaRemote.ok && viaRemote.data.outgoing === expectOut && viaRemote.data.incoming === 0, { viaRemote, expectOut });
    r.rm();
  }

  /* ── 3 ── */
  section('a push goes to the branch it tracks, by that branch\'s name');
  {
    const remote = bare();
    const r = scratchRepo();
    r.commit('a.txt', '1\n', 'one');
    r.g(['remote', 'add', 'origin', remote]);
    r.g(['push', '-q', 'origin', 'main:main', 'main:feature-x']);
    r.g(['fetch', '-q', 'origin']);
    r.g(['checkout', '-qb', 'feat', '--track', 'origin/feature-x']);
    const two = r.commit('b.txt', '2\n', 'two');

    const refs = (await call('repo:refs', r.dir)).data;
    const feat = refs.branches.find((b) => b.name === 'feat');
    check('the refs say where the upstream really is',
      feat && feat.upstreamRemote === 'origin' && feat.upstreamMerge === 'refs/heads/feature-x'
      && feat.upstreamRef === 'refs/remotes/origin/feature-x', feat);
    const asked = has('pushPlan') ? R.pushPlan(feat, refs) : {};
    check('a branch tracking one of another name is not pushed anywhere without asking',
      asked.remote === 'origin' && asked.remoteRef === null && asked.renamed
      && asked.renamed.tracked === 'refs/heads/feature-x', asked);
    R.answer = { to: 'tracked' };
    const plan = has('askPushTarget') ? await R.askPushTarget(feat, asked) : {};
    check('the question names both branches, its own first',
      /origin\/feature-x/.test(R.asked.at(-1)?.description || '')
      && R.asked.at(-1)?.fields?.[0]?.value === 'own', R.asked.at(-1));
    check('answered "the branch it tracks", the plan pushes to feature-x',
      plan.remote === 'origin' && plan.remoteRef === 'refs/heads/feature-x' && plan.setUpstream === false, plan);

    const res = await call('repo:push', r.dir, { branch: 'feat', ...plan });
    const there = lsRemote(remote);
    check('the toolbar push updates feature-x on the remote',
      res.ok && there['refs/heads/feature-x'] === two, { res, there });
    check('and creates no second branch called feat', !there['refs/heads/feat'], there);

    // fetchInto, with someone else moving feature-x on.
    const o = otherClone(remote);
    gitIn(o, ['checkout', '-q', 'feature-x']);
    fs.writeFileSync(path.join(o, 'c.txt'), '3\n');
    gitIn(o, ['add', 'c.txt']);
    gitIn(o, ['commit', '-qm', 'three']);
    gitIn(o, ['push', '-q', 'origin', 'feature-x']);
    const three = tryGit(o, ['rev-parse', 'HEAD']);
    r.g(['checkout', '-q', 'main']);
    const fi = await call('repo:fetchInto', r.dir, {
      remote: feat.upstreamRemote, remoteRef: feat.upstreamMerge,
      branch: 'feat', upstream: feat.upstreamRef, current: false,
    });
    check('fetching into feat asks the server for feature-x and moves feat along',
      fi.ok && /fast-forwarded/.test(fi.data) && tryGit(r.dir, ['rev-parse', 'refs/heads/feat']) === three, fi);
    r.rm();
  }

  section('a branch made from origin/main is not pushed onto main');
  {
    /* git sets the new branch to track origin/main by itself (autoSetupMerge),
       so following the upstream blindly put a feature's commits on main, and a
       forced push leased against main's commit and replaced it. */
    const remote = bare();
    const r = scratchRepo();
    const one = r.commit('a.txt', '1\n', 'one');
    r.g(['remote', 'add', 'origin', remote]);
    r.g(['push', '-q', 'origin', 'main']);
    r.g(['fetch', '-q', 'origin']);
    r.g(['checkout', '-q', '-b', 'feature', 'origin/main']);
    const wip = r.commit('w.txt', 'w\n', 'wip on feature');
    const refs = (await call('repo:refs', r.dir)).data;
    const feature = refs.branches.find((b) => b.name === 'feature');
    check('git has made it track origin/main', feature?.upstreamMerge === 'refs/heads/main', feature);
    const asked = has('pushPlan') ? R.pushPlan(feature, refs) : {};
    check('the plan does not aim at main', asked.remoteRef !== 'refs/heads/main' && Boolean(asked.renamed), asked);
    check('and a forced push has nothing of main to lease against',
      has('leaseExpect') && R.leaseExpect(asked, refs) === '', has('leaseExpect') && R.leaseExpect(asked, refs));

    R.answer = { to: 'own' };
    const plan = has('askPushTarget') ? await R.askPushTarget(feature, asked) : {};
    check('answered "its own branch", it goes to origin/feature and tracks it from then on',
      plan.remoteRef === 'refs/heads/feature' && plan.setUpstream === true
      && plan.tracking === 'refs/remotes/origin/feature', plan);
    const res = await call('repo:push', r.dir, { branch: 'feature', ...plan });
    const there = lsRemote(remote);
    check('main on the remote is untouched', res.ok && there['refs/heads/main'] === one, { res, there });
    check('and origin/feature holds the work', there['refs/heads/feature'] === wip, there);
    check('and the branch now tracks origin/feature',
      tryGit(r.dir, ['config', 'branch.feature.merge']) === 'refs/heads/feature',
      tryGit(r.dir, ['config', 'branch.feature.merge']));

    R.answer = null;
    const none = has('askPushTarget') ? await R.askPushTarget(feature, asked) : 'missing';
    check('cancelling the question pushes nothing', none === null, none);

    r.g(['config', 'push.default', 'upstream']);
    const refs2 = (await call('repo:refs', r.dir)).data;
    r.g(['checkout', '-q', '-b', 'second', 'origin/main']);
    const refs3 = (await call('repo:refs', r.dir)).data;
    const second = refs3.branches.find((b) => b.name === 'second');
    const follow = has('pushPlan') ? R.pushPlan(second, refs3) : {};
    check('with push.default=upstream the reader asked for exactly that, and it is followed',
      refs2.pushDefault === 'upstream' && follow.remoteRef === 'refs/heads/main' && !follow.renamed, follow);
    r.rm();
  }

  /* ── 4 ── */
  section('with no upstream the remote is origin, the only one, or asked for');
  {
    const ref = (name, oid = 'a'.repeat(40)) => ({ refname: `refs/remotes/${name}`, name, oid });
    const newer = { remotes: [ref('upstream/main'), ref('origin/main')], remoteNames: ['origin', 'upstream'] };
    const p1 = has('pushPlan') ? R.pushPlan({ name: 'topic' }, newer) : {};
    check('origin wins over a remote that merely has the newest commit',
      p1.remote === 'origin' && p1.setUpstream === true && p1.remoteRef === 'refs/heads/topic', p1);
    const p2 = has('pushPlan') ? R.pushPlan({ name: 'topic' }, { remotes: [], remoteNames: ['github'] }) : {};
    check('the only remote there is is used', p2.remote === 'github' && !p2.choices, p2);
    const p3 = has('pushPlan') ? R.pushPlan({ name: 'topic' }, { remotes: [], remoteNames: ['fork', 'upstream'] }) : {};
    check('several remotes and no origin: the reader is asked',
      p3.remote === null && Array.isArray(p3.choices) && p3.choices.join() === 'fork,upstream', p3);
    const p4 = has('pushPlan') ? R.pushPlan({ name: 'main', upstreamRemote: 'github',
      upstreamMerge: 'refs/heads/main', upstreamRef: 'refs/remotes/github/main' }, { remotes: [], remoteNames: ['github'] }) : {};
    check('a branch tracking a remote other than origin pushes there', p4.remote === 'github' && !p4.setUpstream, p4);
    const p5 = has('pushPlan') ? R.pushPlan({ name: 'loc', upstreamRemote: '.', upstreamMerge: 'refs/heads/master',
      upstreamRef: 'refs/heads/master' }, { remotes: [], remoteNames: ['origin'] }) : {};
    check('a branch following a local branch is pushed to origin and keeps following it',
      p5.remote === 'origin' && p5.setUpstream === false && p5.remoteRef === 'refs/heads/loc', p5);

    // And for real: a repository whose only remote is not called origin.
    const remote = bare();
    const r = scratchRepo();
    const one = r.commit('a.txt', '1\n', 'one');
    r.g(['remote', 'add', 'github', remote]);
    const refs = (await call('repo:refs', r.dir)).data;
    check('the refs list remotes by name, even before anything is fetched',
      JSON.stringify(refs.remoteNames) === '["github"]', refs.remoteNames);
    const plan = has('pushPlan') ? R.pushPlan(refs.branches.find((b) => b.name === 'main'), refs) : {};
    const res = await call('repo:push', r.dir, { branch: 'main', ...plan });
    check('the first push goes to github and sets it as the upstream',
      res.ok && lsRemote(remote)['refs/heads/main'] === one
      && tryGit(r.dir, ['config', 'branch.main.remote']) === 'github'
      && tryGit(r.dir, ['config', 'branch.main.merge']) === 'refs/heads/main', res);
    const noRemote = await call('repo:push', r.dir, { branch: 'main' });
    check('a push with no remote named is refused rather than sent to origin', noRemote.ok === false, noRemote);
    r.rm();
  }

  /* ── 5 ── */
  section('a remote with a slash in its name, and an upstream that is local');
  {
    const remote = bare();
    const r = scratchRepo();
    const one = r.commit('a.txt', '1\n', 'one');
    r.g(['remote', 'add', 'team/fork', remote]);
    r.g(['push', '-q', 'team/fork', 'main:main', 'main:side', 'main:gone']);
    r.g(['fetch', '-q', 'team/fork']);
    r.g(['branch', '-q', '--track', 'tf', 'team/fork/main']);
    r.g(['branch', '-q', '--track', 'loc', 'main']);
    const refs = (await call('repo:refs', r.dir)).data;
    const tr = refs.remotes.find((x) => x.name === 'team/fork/side');
    check('a remote-tracking ref knows its remote is team/fork', tr && tr.remote === 'team/fork' && tr.branch === 'side', tr);
    const tf = refs.branches.find((b) => b.name === 'tf');
    check('and a branch tracking it says so', tf && tf.upstreamRemote === 'team/fork' && tf.upstreamMerge === 'refs/heads/main', tf);
    const loc = refs.branches.find((b) => b.name === 'loc');
    check('a local upstream has remote "."', loc && loc.upstreamRemote === '.' && loc.upstreamRef === 'refs/heads/main', loc);

    const del = await call('repo:deleteRemoteBranch', r.dir, tr.remote, 'gone');
    check('a branch on team/fork can be deleted there', del.ok && !lsRemote(remote)['refs/heads/gone'], del);
    const co = await call('repo:checkoutWith', r.dir, 'refs/remotes/team/fork/side', 'keep');
    check('checking out team/fork/side makes a local side that tracks it',
      co.ok && tryGit(r.dir, ['symbolic-ref', '-q', 'HEAD']) === 'refs/heads/side'
      && tryGit(r.dir, ['config', 'branch.side.remote']) === 'team/fork', co);

    r.g(['checkout', '-q', 'main']);
    const two = r.commit('b.txt', '2\n', 'two');
    const fi = await call('repo:fetchInto', r.dir, {
      remote: loc.upstreamRemote, remoteRef: loc.upstreamMerge, branch: 'loc', upstream: loc.upstreamRef, current: false,
    });
    check('fetching into a branch that follows main fast-forwards it from main',
      fi.ok && tryGit(r.dir, ['rev-parse', 'refs/heads/loc']) === two, { fi, one });
    r.rm();
  }

  /* ── 6 ── */
  section('a forced push leases against the commit the reader saw');
  {
    const remote = bare();
    const r = scratchRepo();
    r.commit('a.txt', '1\n', 'one');
    r.g(['remote', 'add', 'origin', remote]);
    r.g(['push', '-q', '-u', 'origin', 'main']);
    const seen = tryGit(r.dir, ['rev-parse', 'refs/remotes/origin/main']);
    const refsSeen = (await call('repo:refs', r.dir)).data;
    const mainSeen = refsSeen.branches.find((b) => b.name === 'main');
    const plan = has('pushPlan') ? R.pushPlan(mainSeen, refsSeen) : {};
    const expect = has('leaseExpect') ? R.leaseExpect(plan, refsSeen) : undefined;
    check('the lease is the remote commit on screen', expect === seen, { expect, seen });

    // Someone else pushes; a background fetch brings it in unseen.
    const o = otherClone(remote);
    fs.writeFileSync(path.join(o, 'theirs.txt'), 't\n');
    gitIn(o, ['add', 'theirs.txt']);
    gitIn(o, ['commit', '-qm', 'theirs']);
    gitIn(o, ['push', '-q', 'origin', 'main']);
    const theirs = tryGit(o, ['rev-parse', 'HEAD']);
    r.g(['fetch', '-q', 'origin']);
    r.g(['commit', '-q', '--amend', '-m', 'one, amended']);

    const bareLease = await call('repo:push', r.dir, { branch: 'main', remote: 'origin', force: true });
    check('a forced push without a lease value is refused', bareLease.ok === false
      && lsRemote(remote)['refs/heads/main'] === theirs, bareLease);
    const stale = await call('repo:push', r.dir, { ...plan, branch: 'main', force: true, expect });
    check('after an unseen fetch the lease fails and their commit survives',
      stale.ok === false && lsRemote(remote)['refs/heads/main'] === theirs, stale);
    const fresh = await call('repo:push', r.dir, { ...plan, branch: 'main', force: true, expect: theirs });
    check('leasing against what is really there goes through',
      fresh.ok && lsRemote(remote)['refs/heads/main'] === tryGit(r.dir, ['rev-parse', 'HEAD']), fresh);

    const pushFn = lift('async function push(force = false) {', '\n}\n');
    check('the toolbar push goes through the sidebar\'s push, which confirms a force',
      /pushBranch\(b, force/.test(pushFn) && !/call\('repo:push'/.test(pushFn)
      && /if \(force\) \{\s*const ok = await confirmAction\('Force push'/.test(lift('async function pushBranch(', '\n}\n')));
    r.rm();
  }

  /* ── 7 ── */
  section('a refused pull reads the counts again before deciding');
  {
    const pullFn = lift('async function pull(', '\n}\n');
    const at = (re) => { const x = pullFn.search(re); return x < 0 ? Infinity : x; };
    check('refresh comes before the diverged test',
      at(/await refresh\(\);\s*\n\s*if \(activeId !== startedOn\) return;\s*\n\s*if \(!diverged\(\)\)/) < Infinity, pullFn.slice(-500));

    // The situation itself: before the pull the branch reads only ahead.
    const remote = bare();
    const r = scratchRepo();
    r.commit('a.txt', '1\n', 'base');
    r.g(['remote', 'add', 'origin', remote]);
    r.g(['push', '-q', '-u', 'origin', 'main']);
    const o = otherClone(remote);
    fs.writeFileSync(path.join(o, 't.txt'), 't\n');
    gitIn(o, ['add', 't.txt']);
    gitIn(o, ['commit', '-qm', 'theirs']);
    gitIn(o, ['push', '-q', 'origin', 'main']);
    r.commit('m.txt', 'm\n', 'mine');
    const before = (await call('repo:status', r.dir)).data;
    const res = await call('repo:pull', r.dir, { mode: 'ff' });
    const after = (await call('repo:status', r.dir)).data;
    check('the counts before the pull say only ahead', before.ahead === 1 && before.behind === 0, before);
    check('the pull refuses, and only the counts after it show the divergence',
      res.ok === false && after.ahead === 1 && after.behind === 1, { res, after });
    r.rm();
  }

  /* ── 8 ── */
  section('a branch named like a folder in the work tree');
  {
    const remote = bare();
    const r = scratchRepo();
    r.commit('docs/index.md', 'd\n', 'docs');
    r.g(['remote', 'add', 'origin', remote]);
    r.g(['push', '-q', 'origin', 'main:main', 'main:docs']);
    r.g(['fetch', '-q', 'origin']);
    const co = await call('repo:checkoutWith', r.dir, 'refs/remotes/origin/docs', 'keep');
    check('checking out origin/docs beside a docs/ folder makes the branch and switches to it',
      co.ok && tryGit(r.dir, ['symbolic-ref', '-q', 'HEAD']) === 'refs/heads/docs'
      && tryGit(r.dir, ['config', 'branch.docs.merge']) === 'refs/heads/docs', co);
    r.g(['checkout', '-q', 'main']);
    const again = await call('repo:checkoutWith', r.dir, 'refs/remotes/origin/docs', 'stash');
    check('and once it exists the same click switches to it rather than making another',
      again.ok && tryGit(r.dir, ['symbolic-ref', '-q', 'HEAD']) === 'refs/heads/docs', again);
    r.g(['checkout', '-q', 'main']);
    const local = await call('repo:checkoutWith', r.dir, 'refs/heads/docs', 'discard');
    check('the local branch checks out with discard too',
      local.ok && tryGit(r.dir, ['symbolic-ref', '-q', 'HEAD']) === 'refs/heads/docs', local);
    r.rm();
  }

  /* ── 9 ── */
  section('fetching into a branch says "diverged" only when it has');
  {
    const remote = bare();
    const r = scratchRepo();
    r.commit('f.txt', '1\n', 'base');
    r.g(['remote', 'add', 'origin', remote]);
    r.g(['push', '-q', '-u', 'origin', 'main']);
    const o = otherClone(remote);
    fs.writeFileSync(path.join(o, 'f.txt'), '2\n');
    gitIn(o, ['commit', '-qam', 'up']);
    gitIn(o, ['push', '-q', 'origin', 'main']);
    r.write('f.txt', 'local edit\n');
    const opts = { remote: 'origin', remoteRef: 'refs/heads/main', branch: 'main',
      upstream: 'refs/remotes/origin/main', current: true };
    const dirty = await call('repo:fetchInto', r.dir, opts);
    check('blocked by a local change, it fails with git\'s reason',
      dirty.ok === false && /local changes|overwritten/i.test(dirty.error) && !/diverged/.test(dirty.error), dirty);
    r.g(['checkout', '--', 'f.txt']);
    r.commit('g.txt', 'g\n', 'mine');
    const div = await call('repo:fetchInto', r.dir, opts);
    check('really diverged, it says so', div.ok && /diverged/.test(div.data), div);
    r.rm();
  }

  /* ── 10 ── */
  section('a remote whose path has a space in it');
  {
    const remote = bare('gitbraid remote with space ');
    const r = scratchRepo();
    r.g(['remote', 'add', 'origin', remote]);
    r.g(['remote', 'add', 'second', 'https://example.com/x.git']);
    const res = await call('repo:remotes', r.dir);
    check('it is listed, with its whole path',
      res.ok && res.data.length === 2 && res.data[0].name === 'origin' && res.data[0].url === remote
      && res.data[1].url === 'https://example.com/x.git', res);
    r.rm();
  }

  /* ── 11 ── */
  section('Git-Flow in a repository with no commit yet');
  {
    const r = scratchRepo();
    const cfg = { master: 'main', develop: 'develop', feature: 'feature/', release: 'release/', hotfix: 'hotfix/', versiontag: '' };
    const res = await call('flow:init', r.dir, cfg);
    check('is refused, saying why', res.ok === false && /no commits yet/.test(res.error), res);
    check('and leaves no gitflow config behind', tryGit(r.dir, ['config', '--get-regexp', '^gitflow\\.']) === '');
    const after = await call('flow:config', r.dir);
    check('so it does not read as set up', after.ok && after.data.initialized === false, after);
    r.commit('a.txt', '1\n', 'first');
    const ok = await call('flow:init', r.dir, cfg);
    check('once there is a commit it sets up, with develop',
      ok.ok && tryGit(r.dir, ['rev-parse', '-q', '--verify', 'refs/heads/develop']) !== '', ok);

    // Finishing a release still lands, tags and publishes, by full names.
    const remote = bare();
    r.g(['remote', 'add', 'origin', remote]);
    r.g(['checkout', '-qb', 'release/1.0', 'develop']);
    r.commit('r.txt', 'r\n', 'release work');
    const fin = await call('flow:finish', r.dir, { kind: 'release', branch: 'release/1.0', cfg,
      tag: '1.0', message: 'one oh', remote: 'origin', push: true, deleteRemote: true });
    const there = lsRemote(remote);
    check('a release finish merges, tags and pushes both branches and the tag',
      fin.ok && there['refs/heads/main'] && there['refs/heads/develop'] && there['refs/tags/1.0']
      && /already gone/.test(fin.data), { fin, there });
    check('with --no-ff merges named the usual way',
      tryGit(r.dir, ['log', '-1', '--format=%s', 'main']) === "Merge branch 'release/1.0'",
      tryGit(r.dir, ['log', '-1', '--format=%s', 'main']));
    r.rm();
  }

  section('a full ref name is shortened only when it is that ref');
  {
    /* for-each-ref refs/heads/release lists refs/heads/release/1.0 as well, so
       a merge of a branch that had gone merged a different one. */
    const r = scratchRepo();
    const base = r.commit('a.txt', '1\n', 'one');
    r.g(['checkout', '-q', '-b', 'release/1.0']);
    r.commit('b.txt', '2\n', 'release work');
    r.g(['checkout', '-q', 'main']);
    const res = await m.call('repo:merge', r.dir, 'refs/heads/release', 'ff');
    check('merging a branch that is not there fails, rather than merging release/1.0',
      res.ok === false && r.g(['rev-parse', 'HEAD']).trim() === base, { res });
    r.rm();
  }

  section('a tag whose name begins with a dash');
  {
    /* git refuses such a name for a branch, but a tag can arrive with one —
       fetched, or written with update-ref — and the sidebar lists it. */
    const r = scratchRepo();
    r.commit('a.txt', 'one\n', 'one');
    r.g(['update-ref', 'refs/tags/-q', 'HEAD']);
    const res = await m.call('repo:deleteTag', r.dir, '-q');
    check('deleting it deletes it rather than reading it as an option',
      res.ok && r.g(['tag', '-l']).trim() === '', { res, left: r.g(['tag', '-l']) });
    r.rm();
  }

  for (const d of made) fs.rmSync(d, { recursive: true, force: true });
  done();
})().catch((e) => { console.error(e); process.exit(1); });
