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

  /* Whitespace a reader cannot see, made visible.
   *
   * A line that gained three spaces at its end, or had its indent swapped from
   * spaces to a tab, draws identically to the line it replaced: two rows marked
   * changed whose contents look the same. The marks are backgrounds laid over
   * the characters that are already there — no glyph is substituted and nothing
   * is inserted, so the text a reader copies is the text that was in the file.
   *
   * That is also what keeps the pane's windowing honest. It cuts in pixels, and
   * the height model is built from a shadow copy rendered without any of this
   * markup (see measureWrapHeights in the renderer). Inline spans around escaped
   * text are already proven neutral on that path — the highlighter has been
   * wrapping the same cells all along, and the probe agreed with the table on
   * every one of 5,848 rows. Anything that took up space would not.
   *
   * Splitting on tags is exact rather than a guess at parsing HTML: everything
   * painted here has been through esc, so a `<` in the text is `&lt;` and the
   * only `<` left opens a span of ours. Entities end in `;`, never in a space
   * or a tab, so neither pattern below can cut one in half.
   *
   * Carriage returns are left alone on purpose. Under `white-space: pre` a CR
   * is a segment break, so a span around one would be a span around a line
   * ending — and there is nothing to show either way. */
  const TRAILING_TAGS = /(?:<[^>]*>)*$/;

  function markWs(html) {
    if (!html) return html;
    /* "Ends in whitespace" has to mean after the last tag: a trailing run that
       fell inside a highlight span is the case a cheaper test would miss. */
    if (!html.includes('\t') && !/[ \t]$/.test(html.replace(TRAILING_TAGS, ''))) return html;

    const parts = html.split(/(<[^>]*>)/);   // even: text, odd: tag
    let inTail = true;                       // still walking the run at the end
    for (let i = parts.length - 1; i >= 0; i -= 1) {
      const text = parts[i];
      if (i % 2 === 1 || !text) continue;
      let head = text;
      let tail = '';
      if (inTail) {
        tail = /[ \t]*$/.exec(text)[0];
        head = text.slice(0, text.length - tail.length);
        if (head) inTail = false;
      }
      /* Inside the run at the end the kind stops mattering — what a reader
         needs to know there is that something invisible is present. */
      parts[i] = head.replace(/\t+/g, (run) => `<span class="ws-tab">${run}</span>`)
        + (tail ? `<span class="ws-eol">${tail}</span>` : '');
    }
    return parts.join('');
  }

  /* Only the lines that changed. A context line full of tabs is the shape of
     the file, not the shape of the edit, and marking it would be noise on every
     row of an indented block. */
  const painted = (l) => {
    const html = paint(l.text);
    return (l.type === 'add' || l.type === 'del' ? markWs(html) : html) || '&nbsp;';
  };

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
          `<td class="dl-text">${painted(l)}</td>` +
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

  /* One file's hunks, with those wholly outside the window kept as height
     rather than as elements. Consecutive ones fold into a single spacer: a
     200-file diff put ten thousand of them in the document on every paint,
     each an element the browser had to lay out, for scroll arithmetic that
     only ever reads their sum. The height is that same sum of the same
     per-hunk terms — the rows' span plus one header height each — so the
     renderer's model of the page is untouched. The fold stops at the file:
     its header is a real element whose height the renderer measures off the
     page, so a file cannot be reduced to a number here. `pos.seen` is the row
     count so far across the whole diff, which is what the window is cut in. */
  function hunkBodies(file, fi, actions, first, last, pos, count, draw) {
    let out = '';
    let gap = 0;
    let folded = 0;
    const flush = () => {
      if (folded) out += `<div class="hunk hunk-gap" style="height:${gap}px"></div>`;
      gap = 0;
      folded = 0;
    };
    file.hunks.forEach((h, hi) => {
      const start = pos.seen;
      pos.seen += count(h);
      if (pos.seen <= first || start >= last) {
        gap += spanPx(start, pos.seen) + HEAD_H;
        folded += 1;
        return;
      }
      flush();
      out += draw(file, h, fi, hi, actions, first - start, last - start, start);
    });
    flush();
    return out;
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
    const pos = { seen: 0 };

    return files
      .map((file, fi) => {
        const title =
          file.oldPath && file.newPath && file.oldPath !== file.newPath
            ? `${esc(file.oldPath)} → ${esc(file.newPath)}`
            : esc(file.newPath || file.oldPath);

        const body = file.binary
          ? '<div class="empty-note">Binary file — no preview available.</div>'
          : hunkBodies(file, fi, actions, first, last, pos, (h) => h.lines.length, renderHunk);

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
  function countPairs(hunk) {
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

  /* Both are asked for on every paint and every scroll frame: renderSplit
     counts every hunk to find the window and then pairs the whole of the one
     it draws, and the renderer counts them all again for its height model. On
     a single 50,000-line hunk that was 15 ms a paint for sixty drawn rows, all
     of it spent rebuilding the same answer. Kept beside the hunk in a WeakMap
     rather than on it, so a hunk still deep-compares to what parse() produced
     and hunkPatch() never sees a field it did not write. parse() builds fresh
     hunk objects, so nothing here can go stale. The rows are handed out shared
     and every reader only walks them. */
  const PAIRS = new WeakMap();
  const PAIR_COUNTS = new WeakMap();

  function pairRows(hunk) {
    let rows = PAIRS.get(hunk);
    if (!rows) {
      rows = pairHunk(hunk);
      PAIRS.set(hunk, rows);
      PAIR_COUNTS.set(hunk, rows.length);
    }
    return rows;
  }

  function pairCount(hunk) {
    let n = PAIR_COUNTS.get(hunk);
    if (n === undefined) {
      n = countPairs(hunk);
      PAIR_COUNTS.set(hunk, n);
    }
    return n;
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
        `<td class="dl-text ${cls}">${painted(l)}</td>`
      );
    };
    const all = pairRows(hunk);
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
    const pos = { seen: 0 };
    return files
      .map((file, fi) => {
        const title =
          file.oldPath && file.newPath && file.oldPath !== file.newPath
            ? `${esc(file.oldPath)} → ${esc(file.newPath)}`
            : esc(file.newPath || file.oldPath);
        const body = file.binary
          ? '<div class="empty-note">Binary file — no preview available.</div>'
          : hunkBodies(file, fi, actions, first, last, pos, pairCount, splitHunk);
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

  window.Diff = { parse, render, renderSplit, hunkPatch, esc, markWs,
                  rowCount, rowCountSplit, pairCount, pairRows };
})();
