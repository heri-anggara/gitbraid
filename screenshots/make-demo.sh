#!/bin/bash
# Build a demo repository for the store screenshots.
#
# The point is a history that looks like real work — several branches, merges,
# a tag, a stash, and a conflict — without a line of anything private in it.
# Everything here is invented.
#
#   ./screenshots/make-demo.sh [target-folder]
set -e
DIR=${1:-"$HOME/Documents/Project Pribadi/gitbraid-demo/inkwell"}
rm -rf "$DIR"
mkdir -p "$DIR"
cd "$DIR"

git init -q -b main
git config user.name  'Heri Anggara'
git config user.email 'herianggara2409@gmail.com'
git config commit.gpgsign false

# A second and third hand, so the Author column is not one name repeated.
as() { export GIT_AUTHOR_NAME="$1" GIT_AUTHOR_EMAIL="$2" \
              GIT_COMMITTER_NAME="$1" GIT_COMMITTER_EMAIL="$2"; }
me()  { as 'Heri Anggara'  'herianggara2409@gmail.com'; }
dev2(){ as 'Rina Kusuma'   'rina@inkwell.example'; }
dev3(){ as 'Tomas Weber'   'tomas@inkwell.example'; }

# Dates walk forward so the history reads like months of work, not one minute.
DAY=0
# Sets WHEN rather than printing it: called as $(stamp) the counter would
# advance inside a subshell and every commit would land on the same minute.
stamp() {
  DAY=$((DAY + 1))
  WHEN=$(date -u -d "2026-02-01 09:00 +0000 +$((DAY * 19)) hours" '+%Y-%m-%dT%H:%M:%S+0700')
}

commit() {           # commit <message>
  stamp
  GIT_AUTHOR_DATE="$WHEN" GIT_COMMITTER_DATE="$WHEN" git commit -q -m "$1"
}

# A merge dated today, sitting on top of commits from February, gives the whole
# history away as staged. Merges walk the same clock as everything else.
merge() {            # merge <branch> <message>
  stamp
  GIT_AUTHOR_DATE="$WHEN" GIT_COMMITTER_DATE="$WHEN" \
    git merge -q --no-ff "$1" -m "$2"
}

me
mkdir -p src/theme src/feed docs
cat > README.md <<'MD'
# Inkwell

A small static site generator: Markdown in, a fast site out.

- No configuration to start — point it at a folder of Markdown
- Themes are plain CSS, no build step
- Feeds and sitemaps generated from the same index
MD
cat > package.json <<'JSON'
{
  "name": "inkwell",
  "version": "0.1.0",
  "description": "A small static site generator",
  "license": "MIT",
  "bin": { "inkwell": "src/cli.js" }
}
JSON
git add . && commit "chore: start the project"

cat > src/cli.js <<'JS'
#!/usr/bin/env node
'use strict';

const { build } = require('./build');
const { parseArgs } = require('./args');

async function main(argv) {
  const opts = parseArgs(argv.slice(2));
  if (opts.help) {
    console.log('usage: inkwell <source> [--out dir] [--theme name]');
    return 0;
  }
  const pages = await build(opts.source, opts);
  console.log(`built ${pages.length} pages into ${opts.out}`);
  return 0;
}

main(process.argv).then((code) => process.exit(code));
JS
cat > src/args.js <<'JS'
'use strict';

const DEFAULTS = { out: 'public', theme: 'plain', drafts: false };

/** Read the flags we accept and leave everything else alone. */
function parseArgs(argv) {
  const opts = { ...DEFAULTS, source: '.', help: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') opts.help = true;
    else if (arg === '--out') opts.out = argv[++i];
    else if (arg === '--theme') opts.theme = argv[++i];
    else if (arg === '--drafts') opts.drafts = true;
    else if (!arg.startsWith('-')) opts.source = arg;
  }
  return opts;
}

module.exports = { parseArgs, DEFAULTS };
JS
git add . && commit "feat(cli): read a source folder and a few flags"

cat > src/build.js <<'JS'
'use strict';

const fs = require('fs/promises');
const path = require('path');
const { render } = require('./render');

async function build(source, opts) {
  const files = await collect(source);
  const pages = [];
  for (const file of files) {
    const raw = await fs.readFile(file, 'utf8');
    const page = render(raw, { path: file });
    if (page.draft && !opts.drafts) continue;
    pages.push(page);
  }
  await write(pages, opts.out);
  return pages;
}

async function collect(dir) {
  const out = [];
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...await collect(full));
    else if (full.endsWith('.md')) out.push(full);
  }
  return out;
}

module.exports = { build, collect };
JS
git add . && commit "feat(build): walk the source folder and render each page"

dev2
cat > src/render.js <<'JS'
'use strict';

const FRONT = /^---\n([\s\S]*?)\n---\n/;

/** Split the front matter off, then turn the body into HTML. */
function render(raw, meta) {
  const found = FRONT.exec(raw);
  const head = found ? parseFront(found[1]) : {};
  const body = found ? raw.slice(found[0].length) : raw;
  return {
    ...head,
    path: meta.path,
    slug: head.slug || slugify(head.title || 'untitled'),
    html: toHtml(body),
  };
}

function parseFront(text) {
  const out = {};
  for (const line of text.split('\n')) {
    const at = line.indexOf(':');
    if (at > 0) out[line.slice(0, at).trim()] = line.slice(at + 1).trim();
  }
  return out;
}

const slugify = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

module.exports = { render, slugify, parseFront };
JS
git add . && commit "feat(render): front matter and a first pass at HTML"
me
stamp; GIT_COMMITTER_DATE="$WHEN" git tag -a v0.1.0 -m "First release"

git checkout -q -b develop
dev3
cat > docs/themes.md <<'MD'
# Themes

A theme is a folder with `page.html` and `style.css`. Nothing is compiled:
whatever you write is what ships.

| File | Required | Notes |
|---|---|---|
| `page.html` | yes | `{{ title }}`, `{{ body }}` and `{{ site }}` are replaced |
| `style.css` | no | copied as-is |
| `head.html` | no | appended inside `<head>` |
MD
git add . && commit "docs(themes): describe what a theme actually needs"

# ── a feature branch that merges cleanly ──────────────────────────
git checkout -q -b feature/rss-feed
dev2
cat > src/feed/rss.js <<'JS'
'use strict';

const esc = (s) => String(s).replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]));

function rss(pages, site) {
  const items = pages
    .filter((p) => p.date)
    .sort((a, b) => new Date(b.date) - new Date(a.date))
    .slice(0, 20)
    .map((p) => `  <item>
    <title>${esc(p.title)}</title>
    <link>${site.url}/${p.slug}/</link>
    <pubDate>${new Date(p.date).toUTCString()}</pubDate>
  </item>`)
    .join('\n');

  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"><channel>
  <title>${esc(site.title)}</title>
  <link>${site.url}</link>
${items}
</channel></rss>`;
}

module.exports = { rss };
JS
git add . && commit "feat(feed): generate an RSS feed from the page index"
cat > src/feed/sitemap.js <<'JS'
'use strict';

function sitemap(pages, site) {
  const urls = pages
    .map((p) => `  <url><loc>${site.url}/${p.slug}/</loc></url>`)
    .join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls}
</urlset>`;
}

module.exports = { sitemap };
JS
git add . && commit "feat(feed): sitemap.xml alongside the feed"
git checkout -q develop
me
merge feature/rss-feed "Merge branch 'feature/rss-feed' into develop"

# ── a fix branch off main, merged back ────────────────────────────
git checkout -q -b fix/slug-collision main
dev3
python3 - <<'PY'
import re, pathlib
p = pathlib.Path('src/render.js')
s = p.read_text()
s = s.replace("""const slugify = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');""",
"""/* Two posts called "Notes" used to overwrite each other, silently. The index
   remembers what it has handed out and adds a suffix rather than collide. */
function slugify(title, seen) {
  const base = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  if (!seen || !seen.has(base)) return base;
  let n = 2;
  while (seen.has(`${base}-${n}`)) n++;
  return `${base}-${n}`;
}""")
p.write_text(s)
PY
git add . && commit "fix(render): two posts with the same title no longer overwrite"
git checkout -q main
me
merge fix/slug-collision "Merge branch 'fix/slug-collision'"
stamp; GIT_COMMITTER_DATE="$WHEN" git tag -a v0.1.1 -m "Fix slug collisions"

git checkout -q develop
merge main "Merge branch 'main' into develop"

# ── more of develop, so the graph fills a window ──────────────────
dev2
mkdir -p src/theme/plain
cat > src/theme/plain/page.html <<'HTML'
<!doctype html>
<html lang="{{ lang }}">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>{{ title }} — {{ site }}</title>
    <link rel="stylesheet" href="/style.css">
    <link rel="alternate" type="application/rss+xml" href="/feed.xml">
  </head>
  <body>
    <main>{{ body }}</main>
  </body>
</html>
HTML
git add . && commit "feat(theme): the plain theme, as a starting point"

dev3
cat > docs/cli.md <<'MD'
# Command line

```
inkwell <source> [--out dir] [--theme name] [--drafts]
```

| Flag | Default | Meaning |
|---|---|---|
| `--out` | `public` | Where the built site is written |
| `--theme` | `plain` | Theme folder to use |
| `--drafts` | off | Include pages marked `draft: true` |
MD
git add . && commit "docs(cli): write down the flags before they drift"

me
sed -i \
  -e 's|  const files = await collect(source);|  const started = Date.now();\n  const files = await collect(source);|' \
  -e 's|  await write(pages, opts.out);|  await write(pages, opts.out);\n  pages.took = Date.now() - started;|' \
  src/build.js
git add . && commit "perf(build): report how long a build took"

dev2
cat > src/theme/plain/style.css <<'CSS'
@import url('../tokens.css');

body {
  max-width: 42rem;
  margin: 0 auto;
  padding: 3rem 1.25rem;
  background: var(--bg);
  color: var(--text);
  font: 16px/1.65 system-ui, sans-serif;
}

a { color: var(--accent); }

pre {
  padding: 1rem;
  overflow-x: auto;
  background: var(--surface);
  border-radius: var(--radius);
}
CSS
git add . && commit "feat(theme): plain stylesheet, one screen of CSS"

# ── the branch that is still open, and the conflict it will cause ─
git checkout -q -b feature/dark-theme
dev2
mkdir -p src/theme
cat > src/theme/tokens.css <<'CSS'
:root {
  --bg:      #ffffff;
  --surface: #f4f5f7;
  --text:    #1f2430;
  --muted:   #5b6474;
  --accent:  #2b6cb0;
  --radius:  6px;
}

@media (prefers-color-scheme: dark) {
  :root {
    --bg:      #12141c;
    --surface: #191d28;
    --text:    #dfe4f0;
    --muted:   #99a1b8;
    --accent:  #7c8cff;
  }
}
CSS
git add . && commit "feat(theme): colour tokens with a dark variant"
python3 - <<'PY'
import pathlib
p = pathlib.Path('src/args.js')
s = p.read_text()
s = s.replace("const DEFAULTS = { out: 'public', theme: 'plain', drafts: false };",
              "const DEFAULTS = { out: 'public', theme: 'ink-dark', drafts: false };")
p.write_text(s)
PY
git add . && commit "feat(theme): ship ink-dark as the default theme"

# develop moves too, on the same line — this is what will conflict
git checkout -q develop
dev3
python3 - <<'PY'
import pathlib
p = pathlib.Path('src/args.js')
s = p.read_text()
s = s.replace("const DEFAULTS = { out: 'public', theme: 'plain', drafts: false };",
              "const DEFAULTS = { out: 'dist', theme: 'plain', drafts: false };")
p.write_text(s)
PY
git add . && commit "chore(cli): build into dist/ to match the other tools"

# ── things left in progress, so the panels are not empty ──────────
me
git checkout -q feature/dark-theme
cat > docs/writing.md <<'MD'
# Writing a post

Every post is a Markdown file with front matter at the top:

```
---
title: A quiet week
date: 2026-04-18
tags: notes
---
```

`title` is the only field that must be there.
MD
git add docs/writing.md
python3 - <<'PY'
import pathlib
p = pathlib.Path('README.md')
p.write_text(p.read_text().replace(
  "- Feeds and sitemaps generated from the same index",
  "- Feeds and sitemaps generated from the same index\n- Dark theme included, following the reader's system setting"))
PY

echo
echo "Demo repository ready: $DIR"
echo "  branches : main, develop, feature/dark-theme, feature/rss-feed, fix/slug-collision"
echo "  tags     : v0.1.0, v0.1.1"
echo "  staged   : docs/writing.md      unstaged: README.md"
echo
echo "For the conflict screenshot, run this inside the demo repo:"
echo "  git merge develop        # conflicts in src/args.js, on purpose"
echo "and afterwards:"
echo "  git merge --abort"
