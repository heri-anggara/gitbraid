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
        const m = cc
          ? [null, line.slice(10).trim(), line.slice(10).trim()]
          : line.match(/^diff --git a\/(.+?) b\/(.+)$/);
        sides = cc ? 2 : 1;
        file = {
          header: [line],
          oldPath: m ? m[1] : '',
          newPath: m ? m[2] : '',
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

  function renderHunk(file, hunk, fileIndex, hunkIndex, actions) {
    const rows = hunk.lines
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

    return (
      '<div class="hunk">' +
      `<div class="hunk-head"><span class="hunk-range">${esc(hunk.header)}</span>` +
      `<span class="hunk-actions">${buttons}</span></div>` +
      `<table class="difftable"><tbody>${rows}</tbody></table>` +
      '</div>'
    );
  }

  /** Render a parsed diff. `actions` are the per-hunk buttons to show. */
  function render(files, actions = [], opts = null) {
    setPaint(opts);
    if (!files.length) {
      return '<div class="empty-note">No textual changes here.</div>';
    }
    return files
      .map((file, fi) => {
        const title =
          file.oldPath && file.newPath && file.oldPath !== file.newPath
            ? `${esc(file.oldPath)} → ${esc(file.newPath)}`
            : esc(file.newPath || file.oldPath);

        const body = file.binary
          ? '<div class="empty-note">Binary file — no preview available.</div>'
          : file.hunks
              .map((h, hi) => renderHunk(file, h, fi, hi, actions))
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

  function splitHunk(file, hunk, fileIndex, hunkIndex, actions) {
    const cell = (l, side, ctx) => {
      if (!l) return '<td class="dl-num dl-void"></td><td class="dl-text dl-void"></td>';
      const cls = ctx ? 'dl-ctx' : side === 'left' ? 'dl-del' : 'dl-add';
      return (
        `<td class="dl-num ${cls}">${(side === 'left' ? l.old : l.new) ?? ''}</td>` +
        `<td class="dl-text ${cls}">${paint(l.text) || '&nbsp;'}</td>`
      );
    };
    const rows = pairHunk(hunk)
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
      `<table class="difftable split"><tbody>${rows}</tbody></table>` +
      '</div>'
    );
  }

  /** Side-by-side counterpart of render(): before on the left, after on the right. */
  function renderSplit(files, actions = [], opts = null) {
    setPaint(opts);
    if (!files.length) return '<div class="empty-note">No textual changes here.</div>';
    return files
      .map((file, fi) => {
        const title =
          file.oldPath && file.newPath && file.oldPath !== file.newPath
            ? `${esc(file.oldPath)} → ${esc(file.newPath)}`
            : esc(file.newPath || file.oldPath);
        const body = file.binary
          ? '<div class="empty-note">Binary file — no preview available.</div>'
          : file.hunks.map((h, hi) => splitHunk(file, h, fi, hi, actions)).join('');
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

  window.Diff = { parse, render, renderSplit, hunkPatch, esc };
})();
