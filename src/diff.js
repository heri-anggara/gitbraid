/* Unified diff parsing + rendering. Exposed as window.Diff. */
(function () {
  'use strict';

  /* Quotes are escaped too: git allows them in ref names and paths, and both
     end up inside double-quoted attributes (title=, data-path=). */
  const esc = (s) =>
    s.replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');

  /* A path git had to escape arrives as a C-style quoted string: the whole name
     in double quotes, with \t, \" and \\ spelled out and one octal escape per
     byte for anything outside ASCII —

       diff --git "a/beraksen-\303\251.txt" "b/beraksen-\303\251.txt"

     Every diff this application asks for now turns core.quotePath off, so the
     common case never gets here. This is for the rest, and the rest is real: a
     name holding a quote or a backslash is escaped whatever that setting says,
     and a diff pasted in from somewhere else never passed through it. Read
     wrong, the name comes out empty and the patch built to stage one of its
     hunks names no file at all.

     The octal escapes are bytes of UTF-8 rather than characters, so they only
     mean anything decoded together. TextDecoder would be the obvious way and is
     not available: this file is also run inside a bare vm context by the tests,
     where the Node globals are absent — a check broke on exactly that once
     already. decodeURIComponent is an ECMAScript builtin and is there, so the
     bytes are handed to it as percent escapes instead. */
  const C_ESCAPES = {
    a: '\x07', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t', v: '\v',
    '"': '"', '\\': '\\',
  };

  function unquotePath(raw) {
    const s = String(raw == null ? '' : raw);
    if (s.length < 2 || s[0] !== '"' || s[s.length - 1] !== '"') return s;
    const body = s.slice(1, -1);
    let enc = '';
    for (let i = 0; i < body.length; i += 1) {
      const c = body[i];
      if (c !== '\\') { enc += encodeURIComponent(c); continue; }
      const next = body[i + 1];
      if (next === undefined) { enc += encodeURIComponent(c); continue; }
      const oct = /^[0-7]{1,3}/.exec(body.slice(i + 1, i + 4));
      if (oct) {
        enc += `%${(parseInt(oct[0], 8) & 0xff).toString(16).padStart(2, '0')}`;
        i += oct[0].length;
        continue;
      }
      enc += encodeURIComponent(
        Object.prototype.hasOwnProperty.call(C_ESCAPES, next) ? C_ESCAPES[next] : next);
      i += 1;
    }
    /* Escapes that do not form valid UTF-8 would throw. A name shown as git
       wrote it is worth more than no name at all. */
    try { return decodeURIComponent(enc); } catch { return s; }
  }

  /** The quoted token at the head of a string, quotes included, or null. */
  function readQuoted(s) {
    if (s[0] !== '"') return null;
    for (let i = 1; i < s.length; i += 1) {
      if (s[i] === '\\') { i += 1; continue; }
      if (s[i] === '"') return s.slice(0, i + 1);
    }
    return null;
  }

  const stripSide = (p) => p.replace(/^[ab]\//, '');

  /* The two names a header carries. Either may be quoted and the other not — a
     rename where only one of the names needed escaping does exactly that — so
     the sides are read one at a time rather than with a single pattern. An
     unquoted name may hold spaces, which is why the split is the ` b/` that
     opens the second name and not the first space in the line. */
  function headerPaths(line, cc) {
    if (cc) {
      /* A combined hunk opens with @@@ and `git apply` cannot take one at all,
         so there is no token to hand back — only a name to show. */
      const one = unquotePath(line.slice(10).trim());
      return { oldPath: one, newPath: one, oldRaw: '', newRaw: '' };
    }
    const rest = line.slice(11).trim();
    let a;
    let after;
    const quoted = readQuoted(rest);
    if (quoted) {
      a = quoted;
      after = rest.slice(quoted.length);
    } else {
      const at = rest.search(/ "?b\//);
      if (at < 0) return null;
      a = rest.slice(0, at);
      after = rest.slice(at);
    }
    const tail = after.replace(/^\s+/, '');
    if (!tail) return null;
    const b = readQuoted(tail) || tail;
    return {
      oldPath: stripSide(unquotePath(a)),
      newPath: stripSide(unquotePath(b)),
      oldRaw: a,
      newRaw: b,
    };
  }

  /**
   * Parse raw `git diff` output into files -> hunks -> lines.
   * Each hunk keeps the exact source text so it can be re-applied verbatim.
   */
  /* `@@ -1,2 +1,2 @@` and `@@@ -1,2 -1,2 +1,2 @@@` both end with the "+" range,
     which is the only one the viewer numbers lines from. */
  function hunkRange(line) {
    const nums = line.match(/[-+]\d+(?:,\d+)?/g) || [];
    const first = nums[0] || '-0';
    const last = nums[nums.length - 1] || '+0';
    return { old: Number(first.slice(1).split(',')[0]) || 0,
             new: Number(last.slice(1).split(',')[0]) || 0 };
  }

  function parse(raw) {
    const files = [];
    if (!raw) return files;

    const lines = raw.split('\n');
    let file = null;
    let hunk = null;
    let oldNo = 0;
    let newNo = 0;
    /* A merge's combined diff (`--cc`) carries one prefix column per parent, so
       every line starts with two markers instead of one and hunks open with
       `@@@`. Nothing else in the format changes, so the same walk handles it
       once it knows how wide the prefix is. */
    let sides = 1;

    const closeHunk = () => {
      if (file && hunk) file.hunks.push(hunk);
      hunk = null;
    };

    for (const line of lines) {
      if (line.startsWith('diff --git ') || line.startsWith('diff --cc ')) {
        closeHunk();
        const cc = line.startsWith('diff --cc ');
        const names = headerPaths(line, cc);
        sides = cc ? 2 : 1;
        file = {
          header: [line],
          oldPath: names ? names.oldPath : '',
          newPath: names ? names.newPath : '',
          /* The header tokens as git wrote them, kept for the one job that
             cannot use the decoded name: building a patch to hand back. */
          oldRaw: names ? names.oldRaw : '',
          newRaw: names ? names.newRaw : '',
          binary: false,
          combined: cc,
          hunks: [],
          additions: 0,
          deletions: 0,
        };
        files.push(file);
        continue;
      }
      if (!file) continue;

      if (hunk === null) {
        if (line.startsWith('@@')) {
          const m = hunkRange(line);
          oldNo = m.old;
          newNo = m.new;
          hunk = { header: line, lines: [], raw: [line] };
          continue;
        }
        if (/^(Binary files|GIT binary patch)/.test(line)) file.binary = true;
        file.header.push(line);
        continue;
      }

      if (line.startsWith('@@')) {
        closeHunk();
        const m = hunkRange(line);
        oldNo = m.old;
        newNo = m.new;
        hunk = { header: line, lines: [], raw: [line] };
        continue;
      }

      if (sides > 1) {
        /* Two columns: "+" in either means the result gained the line, "-" in
           either means one of the parents had it and the result does not. */
        const marks = line.slice(0, sides);
        const text = line.slice(sides);
        if (/\+/.test(marks)) {
          hunk.lines.push({ type: 'add', old: null, new: newNo++, text, marks });
          hunk.raw.push(line);
          file.additions++;
        } else if (/-/.test(marks)) {
          hunk.lines.push({ type: 'del', old: oldNo++, new: null, text, marks });
          hunk.raw.push(line);
          file.deletions++;
        } else if (marks.trim() === '') {
          hunk.lines.push({ type: 'ctx', old: oldNo++, new: newNo++, text, marks });
          hunk.raw.push(line);
        } else {
          closeHunk();
          file.header.push(line);
        }
        continue;
      }

      const c = line[0];
      if (c === '+') {
        hunk.lines.push({ type: 'add', old: null, new: newNo++, text: line.slice(1) });
        hunk.raw.push(line);
        file.additions++;
      } else if (c === '-') {
        hunk.lines.push({ type: 'del', old: oldNo++, new: null, text: line.slice(1) });
        hunk.raw.push(line);
        file.deletions++;
      } else if (c === ' ' || line === '') {
        hunk.lines.push({ type: 'ctx', old: oldNo++, new: newNo++, text: line.slice(1) });
        hunk.raw.push(line === '' ? ' ' : line);
      } else if (c === '\\') {
        hunk.lines.push({ type: 'meta', old: null, new: null, text: line });
        hunk.raw.push(line);
      } else {
        closeHunk();
        file.header.push(line);
      }
    }
    closeHunk();
    return files;
  }

  /**
   * Rebuild a minimal patch containing a single hunk, ready for `git apply`.
   * `reverse` means the patch will be applied backwards, so the counts in the
   * header stay as-is and git handles the inversion via --reverse.
   */
  function hunkPatch(file, hunk) {
    /* The names go back to git exactly as git wrote them — quotes, escapes and
       the a/ b/ prefixes untouched. Decoding them and writing the result out
       plainly looks tidier and is wrong: `git apply` reads the --- and +++
       lines only as far as a tab, so a file whose name holds one resolves to
       the part in front of it. Measured on a file called `ada<TAB>tab.txt`:
       written raw, git answers `error: ada: does not exist in index`; written
       as the quoted token git itself emitted, the same patch is accepted.

       Handing the token straight back also means a name this parser decodes
       wrongly costs a wrong label in the header and never a failed stage. */
    if (file.oldRaw && file.newRaw) {
      return [
        `diff --git ${file.oldRaw} ${file.newRaw}`,
        `--- ${file.oldRaw}`,
        `+++ ${file.newRaw}`,
        ...hunk.raw,
        '',
      ].join('\n');
    }
    // Hand-built fixtures and combined diffs, which carry no tokens.
    const a = file.oldPath || file.newPath;
    const b = file.newPath || file.oldPath;
    return [
      `diff --git a/${a} b/${b}`,
      `--- ${file.oldPath ? 'a/' + file.oldPath : '/dev/null'}`,
      `+++ ${file.newPath ? 'b/' + file.newPath : '/dev/null'}`,
      ...hunk.raw,
      '',
    ].join('\n');
  }

  /* Colouring is optional and per-render: the viewer may have it switched off,
     and an unknown file type has no rules to apply. */
  let paint = esc;

  function setPaint(opts) {
    const lang = opts && opts.highlight && window.Hl ? window.Hl.langOf(opts.path) : null;
    paint = lang ? (t) => window.Hl.line(t, lang) : esc;
    return Boolean(lang);
  }

  /* How tall a line row and a hunk header are. Measured by the renderer from
     what is actually on screen and handed back in, because a window has to be
     cut in pixels and CSS owns those numbers. */
  let ROW_H = 20;
  let HEAD_H = 27;

  /** Every line row in the file, in order — what a window is cut out of. */
  function rowCount(files) {
    let n = 0;
    for (const f of files) for (const h of f.hunks || []) n += h.lines.length;
    return n;
  }

  const gapRow = (px) =>
    (px > 0 ? `<tr class="dl-gap" style="height:${px}px"><td colspan="4"></td></tr>` : '');

  /* How tall a run of rows is. Rows are one height each until they wrap, and
     then they are not — so when the caller has measured them it passes the
     offsets in and the spacers hold the true distance. Getting this wrong does
     not misdraw anything visible: it makes the page a different height from the
     model that decides what to draw, and the diff slides under the pointer. */
  /* Running totals of row heights alone — no hunk headers in them, so the
     distance between any two row numbers is exactly the rows between them. */
  let ROW_SUM = null;
  const spanPx = (from, to) =>
    (ROW_SUM ? Math.max(0, ROW_SUM[to] - ROW_SUM[from]) : Math.max(0, to - from) * ROW_H);

  function renderHunk(file, hunk, fileIndex, hunkIndex, actions, from = 0, to = Infinity,
                      base = 0) {
    // Which of this hunk's rows the window actually asks for.
    const lo = Math.max(0, from);
    const hi = Math.min(hunk.lines.length, to);
    const rows = hunk.lines
      .slice(lo, hi)
      .map((l) => {
        const cls =
          l.type === 'add' ? 'dl-add' :
          l.type === 'del' ? 'dl-del' :
          l.type === 'meta' ? 'dl-meta' : 'dl-ctx';
        const sign = l.type === 'add' ? '+' : l.type === 'del' ? '-' : ' ';
        return (
          `<tr class="${cls}">` +
          `<td class="dl-num">${l.old ?? ''}</td>` +
          `<td class="dl-num">${l.new ?? ''}</td>` +
          // In a combined diff the two columns say which parent the line came
          // from, which is the whole point of reading one.
          `<td class="dl-sign">${l.marks ? esc(l.marks) : sign}</td>` +
          `<td class="dl-text">${paint(l.text) || '&nbsp;'}</td>` +
          '</tr>'
        );
      })
      .join('');

    const buttons = actions
      .map(
        (a) =>
          `<button class="hunk-btn" data-hunk-action="${a.action}" ` +
          `data-file="${fileIndex}" data-hunk="${hunkIndex}">${a.label}</button>`
      )
      .join('');

    /* The rows left out still take their space, so the scrollbar keeps its
       length and nothing under the pointer moves as the window slides. */
    return (
      '<div class="hunk">' +
      `<div class="hunk-head"><span class="hunk-range">${esc(hunk.header)}</span>` +
      `<span class="hunk-actions">${buttons}</span></div>` +
      '<table class="difftable"><tbody>' +
      gapRow(spanPx(base, base + lo)) + rows +
      gapRow(spanPx(base + hi, base + hunk.lines.length)) +
      '</tbody></table>' +
      '</div>'
    );
  }

  /** Render a parsed diff. `actions` are the per-hunk buttons to show. */
  function render(files, actions = [], opts = null) {
    setPaint(opts);
    if (opts && opts.rowH) ROW_H = opts.rowH;
    if (opts && opts.headH) HEAD_H = opts.headH;
    ROW_SUM = (opts && opts.rowSum) || null;
    if (!files.length) {
      return '<div class="empty-note">No textual changes here.</div>';
    }
    /* The window, counted in line rows across the whole diff. Left out, every
       row is drawn — which is right for a short diff and ruinous for a long
       one: a file with thousands of changed lines put tens of thousands of
       elements in the document, and the browser laid out all of them on every
       scroll. */
    const first = opts && Number.isFinite(opts.first) ? opts.first : 0;
    const last = opts && Number.isFinite(opts.last) ? opts.last : Infinity;
    let seen = 0;

    return files
      .map((file, fi) => {
        const title =
          file.oldPath && file.newPath && file.oldPath !== file.newPath
            ? `${esc(file.oldPath)} → ${esc(file.newPath)}`
            : esc(file.newPath || file.oldPath);

        const body = file.binary
          ? '<div class="empty-note">Binary file — no preview available.</div>'
          : file.hunks
              .map((h, hi) => {
                const start = seen;
                seen += h.lines.length;
                // Wholly outside the window: kept as height, not as elements.
                if (seen <= first || start >= last) {
                  return `<div class="hunk hunk-gap" style="height:${
                    spanPx(start, seen) + HEAD_H}px"></div>`;
                }
                return renderHunk(file, h, fi, hi, actions, first - start, last - start, start);
              })
              .join('');

        return (
          '<section class="difffile">' +
          `<header class="difffile-head"><span class="difffile-name">${title}</span>` +
          `<span class="difffile-stat"><span class="stat-add">+${file.additions}</span>` +
          `<span class="stat-del">−${file.deletions}</span></span></header>` +
          body +
          '</section>'
        );
      })
      .join('');
  }

  /**
   * Pair a hunk's lines into before/after rows. A run of removals is matched
   * against the run of additions that follows it, which is what makes a
   * replaced line sit opposite the line it replaced instead of below it.
   */
  function pairHunk(hunk) {
    const rows = [];
    let dels = [];
    let adds = [];
    const flush = () => {
      const n = Math.max(dels.length, adds.length);
      for (let i = 0; i < n; i++) rows.push({ left: dels[i] || null, right: adds[i] || null });
      dels = [];
      adds = [];
    };
    for (const l of hunk.lines) {
      if (l.type === 'del') dels.push(l);
      else if (l.type === 'add') adds.push(l);
      else { flush(); rows.push({ left: l, right: l, ctx: true }); }
    }
    flush();
    return rows;
  }

  /* How many rows pairHunk will produce, without building them. Side-by-side
     was left undrawn-in-a-window because "rows are not countable there" — they
     are: a run of removals beside a run of additions is as many rows as the
     longer of the two, and everything else is one row for one line. */
  function pairCount(hunk) {
    let n = 0;
    let dels = 0;
    let adds = 0;
    for (const l of hunk.lines) {
      if (l.type === 'del') dels += 1;
      else if (l.type === 'add') adds += 1;
      else { n += Math.max(dels, adds) + 1; dels = 0; adds = 0; }
    }
    return n + Math.max(dels, adds);
  }

  function rowCountSplit(files) {
    let n = 0;
    for (const f of files) for (const h of f.hunks || []) n += pairCount(h);
    return n;
  }

  const SPLIT_COLS =
    '<colgroup><col class="c-num"><col class="c-text">' +
    '<col class="c-num"><col class="c-text"></colgroup>';

  function splitHunk(file, hunk, fileIndex, hunkIndex, actions, from = 0, to = Infinity,
                     base = 0) {
    const cell = (l, side, ctx) => {
      if (!l) return '<td class="dl-num dl-void"></td><td class="dl-text dl-void"></td>';
      const cls = ctx ? 'dl-ctx' : side === 'left' ? 'dl-del' : 'dl-add';
      return (
        `<td class="dl-num ${cls}">${(side === 'left' ? l.old : l.new) ?? ''}</td>` +
        `<td class="dl-text ${cls}">${paint(l.text) || '&nbsp;'}</td>`
      );
    };
    const all = pairHunk(hunk);
    const lo = Math.max(0, from);
    const hi = Math.min(all.length, to);
    const rows = all
      .slice(lo, hi)
      .map((r) => `<tr>${cell(r.left, 'left', r.ctx)}${cell(r.right, 'right', r.ctx)}</tr>`)
      .join('');

    const buttons = actions
      .map(
        (a) =>
          `<button class="hunk-btn" data-hunk-action="${a.action}" ` +
          `data-file="${fileIndex}" data-hunk="${hunkIndex}">${a.label}</button>`
      )
      .join('');

    return (
      '<div class="hunk">' +
      `<div class="hunk-head"><span class="hunk-range">${esc(hunk.header)}</span>` +
      `<span class="hunk-actions">${buttons}</span></div>` +
      /* The widths are declared here rather than left to the first row. A fixed
         table takes its columns from whatever row comes first, and once the
         window has scrolled that is a spacer spanning all four — which says
         nothing about any single column, so they collapsed to equal quarters
         and the left side slid into the middle of the pane. */
      '<table class="difftable split">' + SPLIT_COLS + '<tbody>' +
      gapRow(spanPx(base, base + lo)) + rows + gapRow(spanPx(base + hi, base + all.length)) +
      '</tbody></table>' +
      '</div>'
    );
  }

  /** Side-by-side counterpart of render(): before on the left, after on the right. */
  function renderSplit(files, actions = [], opts = null) {
    setPaint(opts);
    if (opts && opts.rowH) ROW_H = opts.rowH;
    if (opts && opts.headH) HEAD_H = opts.headH;
    ROW_SUM = (opts && opts.rowSum) || null;
    if (!files.length) return '<div class="empty-note">No textual changes here.</div>';
    const first = opts && Number.isFinite(opts.first) ? opts.first : 0;
    const last = opts && Number.isFinite(opts.last) ? opts.last : Infinity;
    let seen = 0;
    return files
      .map((file, fi) => {
        const title =
          file.oldPath && file.newPath && file.oldPath !== file.newPath
            ? `${esc(file.oldPath)} → ${esc(file.newPath)}`
            : esc(file.newPath || file.oldPath);
        const body = file.binary
          ? '<div class="empty-note">Binary file — no preview available.</div>'
          : file.hunks
              .map((h, hi) => {
                const start = seen;
                const n = pairCount(h);
                seen += n;
                if (seen <= first || start >= last) {
                  return `<div class="hunk hunk-gap" style="height:${
                    spanPx(start, seen) + HEAD_H}px"></div>`;
                }
                return splitHunk(file, h, fi, hi, actions, first - start, last - start, start);
              })
              .join('');
        return (
          '<section class="difffile">' +
          `<header class="difffile-head"><span class="difffile-name">${title}</span>` +
          `<span class="difffile-stat"><span class="stat-add">+${file.additions}</span>` +
          `<span class="stat-del">−${file.deletions}</span></span></header>` +
          body +
          '</section>'
        );
      })
      .join('');
  }

  window.Diff = { parse, render, renderSplit, hunkPatch, esc,
                  rowCount, rowCountSplit, pairCount, pairRows: pairHunk };
})();
