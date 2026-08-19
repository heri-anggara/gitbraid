/* Take the screenshots the README and the store listing use.
 *
 *   ./screenshots/make-demo.sh /tmp/inkwell
 *   npx electron screenshots/shoot.js /tmp/inkwell
 *
 * Everything it photographs comes from the invented demo repository, so no
 * real project, path or address ever appears in a published image.
 */
const { app, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');
const { execFileSync } = require('child_process');

const REPO = process.argv[2] || '/tmp/inkwell';
const OUT = path.join(__dirname);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
require(path.join(__dirname, '..', 'main.js'));

const git = (...a) => { try { return execFileSync('git', a, { cwd: REPO }).toString(); } catch { return ''; } };

app.whenReady().then(async () => {
  await wait(2600);
  const win = BrowserWindow.getAllWindows()[0];
  win.setSize(1600, 940);
  const js = (s) => win.webContents.executeJavaScript(s, true);
  const shot = async (name) => {
    await wait(900);
    fs.writeFileSync(path.join(OUT, name), (await win.webContents.capturePage()).toPNG());
    console.log('  wrote ' + name);
  };

  /* Both themes, because the store listing shows both and a missing file there
     is a broken image on the page. Dark keeps the plain names it has always
     had; light is suffixed. */
  for (const theme of ['dark', 'light']) {
    const name = (base) => base + (theme === 'light' ? '-light' : '') + '.png';
    console.log('  --- ' + theme);
    await js('applyTheme(' + JSON.stringify(theme) + ')');
    // The pointer sits wherever the window opened, and a row under it grows a
    // tooltip that has no business in a published picture.
    await js("(function(){ prefs.hoverMessage = false; savePrefs(); })()");
    await js('openRepoAt(' + JSON.stringify(REPO) + ')');
    await wait(3200);

    /* A published picture must show the application, not the machine it was taken
       on: no other tabs, no drawer, and no status line quoting a local path. */
    await js("hideTerm()");
    /* Matched on the whole path, not its last segment: a tab left open on another
       folder of the same name is a different repository, and photographing it
       while changing this one produced a picture of neither. */
    await js([
      "(async function () {",
      "  var want = " + JSON.stringify(REPO) + ";",
      "  var keep = tabs.find(function (t) { return t.repo && t.repo.path === want; });",
      "  for (const t of tabs.slice()) if (t !== keep) await closeTab(t.id);",
      "  if (keep) await activateTab(keep.id);",
      "  return keep ? keep.repo.path : 'NO TAB FOR ' + want;",
      "})()"].join('\n')).then(function (p) { console.log('    photographing ' + p); });
    await wait(1800);
    await js("(async function(){ await selectCommit(state.commits.find(function (c) { return c.parents.length > 1; }).hash); })()");
    await js("setStatus('')");
    await shot(name('history'));

    /* A commit with enough in it to show the viewer doing its work: syntax
       colouring, both kinds of change, the block counter, and the change map
       down the right-hand edge. Whole file rather than three lines of context,
       so the picture is of code rather than of empty pane. */
    await js([
      "(async function () {",
      "  var c = state.commits.find(function (x) { return /generate an RSS feed/.test(x.subject); });",
      "  if (!c) return;",
      "  viewer.allLines = true; viewer.split = false; saveViewer();",
      "  await selectCommit(c.hash);",
      "  var f = (commitFiles || [])[0];",
      "  if (f) { state.file = { path: f.path, kind: 'commit', status: f.status }; await showFileDiff(); }",
      "})()"].join('\n'));
    await js("setStatus('')");
    await shot(name('diff'));
    await js("(function(){ viewer.allLines = false; saveViewer(); })()");
    await js("closeFile()");

    console.log('  merging develop to make a conflict…');
    // The demo carries uncommitted work on purpose, which a merge refuses to
    // walk over; set it aside for the length of one picture.
    console.log('    stash: ' + git('stash', 'push', '--include-untracked', '-m', 'shoot').trim());
    console.log('    merge: ' + (git('merge', 'develop').trim() || '(exited non-zero, as a conflict does)'));
    console.log('    unmerged on disk: ' + (git('diff', '--name-only', '--diff-filter=U').trim() || 'none'));
    await js("(async function(){ await refresh({ keepSelection: false }); })()");
    await wait(1600);
    console.log('    app sees conflicted: ' + await js("String(state.status.conflicted.length)"));
    await js("(async function(){ var c = state.status.conflicted[0]; if (c) { state.file = { path: c.path, kind: 'conflict', status: c.status }; await showFileDiff(); } })()");
    await js("setStatus('')");
    await shot(name('conflict'));
    git('merge', '--abort');
    git('stash', 'pop');
  }

  app.quit();
});
