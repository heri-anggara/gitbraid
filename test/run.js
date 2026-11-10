/* Runs every test file in this folder, one process each so a file's repos,
 * stubs and environment cannot leak into the next, and fails if any did. */
'use strict';

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const files = fs.readdirSync(__dirname).filter((f) => f.endsWith('.test.js')).sort();
let pass = 0;
let fail = 0;
const broken = [];
for (const f of files) {
  console.log(`\n━━ ${f}`);
  const r = spawnSync(process.execPath, [path.join(__dirname, f)], { encoding: 'utf8' });
  process.stdout.write(r.stdout);
  if (r.stderr) process.stderr.write(r.stderr);
  const m = /(\d+) passed, (\d+) failed\s*$/.exec(r.stdout);
  if (m) { pass += Number(m[1]); fail += Number(m[2]); }
  if (r.status !== 0 || !m) broken.push(f);
}
console.log(`\n${pass} passed, ${fail} failed across ${files.length} files`);
if (broken.length) console.log(`failing: ${broken.join(', ')}`);
process.exit(broken.length ? 1 : 0);
