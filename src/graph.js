/* Commit graph: lane assignment + SVG rendering, shaped after GitKraken.
   Exposed as window.Graph (no bundler, no ES modules over file://). */
(function () {
  'use strict';

  /* Every one of these is a dial rather than a constant: the three styles below
     are the same layout drawn with different numbers, and the row height is
     shared with the commit list, which sizes its rows from --row-h. */
  let ROW_H = 31;
  let LANE_W = 22;
  const PAD_X = 16;
  let DOT_R = 8;      // the coloured disc a commit sits on
  let AVATAR_R = 6.5; // avatar clipped inside that disc
  let CORNER = 9;     // radius of a lane-change bend
  let STROKE = 2.5;
  let JOIN = 'curve'; // how a line crosses from one lane to the next

  /* Named for their shape rather than for another application. Calling one
     "SourceTree" would promise a likeness this does not attempt, and would
     become a lie the moment that application changed. */
  const STYLES = {
    curved:   { CORNER: 9, DOT_R: 8,   AVATAR_R: 6.5, STROKE: 2.5, LANE_W: 22, JOIN: 'curve' },
    angular:  { CORNER: 9, DOT_R: 6,   AVATAR_R: 5,   STROKE: 1.8, LANE_W: 18, JOIN: 'angle' },
    diagonal: { CORNER: 9, DOT_R: 5.5, AVATAR_R: 4.5, STROKE: 1.6, LANE_W: 16, JOIN: 'diagonal' },
  };

  function setStyle(name) {
    const st = STYLES[name] || STYLES.curved;
    ({ CORNER, DOT_R, AVATAR_R, STROKE, LANE_W, JOIN } = st);
  }

  /* What a preset overrides after choosing a join shape: the numbers that make
     one application's history recognisable are the sizes, not the curve. The
     avatar radius follows the dot rather than being set on its own — a face
     drawn larger than the disc holding it is a bug waiting to be filed. */
  function setMetrics(m) {
    if (m.rowH) ROW_H = m.rowH;
    if (m.laneW) LANE_W = m.laneW;
    if (m.stroke) STROKE = m.stroke;
    /* How far a lane change reaches down the column before it is vertical
       again. GitKraken sweeps; SourceTree turns a tight corner and gets back to
       a straight line, which is what makes its lanes read as columns rather
       than as ribbons. */
    if (m.corner) CORNER = m.corner;
    if (m.dotR) {
      DOT_R = m.dotR;
      AVATAR_R = Math.max(3, DOT_R - 1.5);
    }
  }

  // Lane colours, picked to stay legible on both the light and dark ground.
  const LANE_COLORS = [
    '#3b7fe0', // blue
    '#c93f9b', // magenta
    '#1fa67f', // jade
    '#e0912b', // amber
    '#8a63d2', // violet
    '#2fb0d9', // cyan
    '#d2604a', // clay
    '#7fa63a', // olive
  ];

  const laneColor = (i) => LANE_COLORS[i % LANE_COLORS.length];

  /**
   * Assign each commit a lane and record the edges to its parents.
   * `commits` must be in --date-order (children before parents).
   */
  function layout(commits) {
    const lanes = []; // active lanes: hash each lane is waiting for, or null
    const rows = [];
    let maxLane = 0;

    const alloc = (hash) => {
      const free = lanes.indexOf(null);
      if (free !== -1) {
        lanes[free] = hash;
        return free;
      }
      lanes.push(hash);
      return lanes.length - 1;
    };

    for (const commit of commits) {
      let lane = lanes.indexOf(commit.hash);
      if (lane === -1) lane = alloc(commit.hash);

      // Other lanes waiting for this same commit converge here.
      for (let i = 0; i < lanes.length; i++) {
        if (i !== lane && lanes[i] === commit.hash) lanes[i] = null;
      }

      const edges = [];
      if (commit.parents.length === 0) {
        lanes[lane] = null;
      } else {
        lanes[lane] = commit.parents[0];
        edges.push({ parent: commit.parents[0], lane });
        for (let k = 1; k < commit.parents.length; k++) {
          const p = commit.parents[k];
          let pl = lanes.indexOf(p);
          if (pl === -1) pl = alloc(p);
          edges.push({ parent: p, lane: pl });
        }
      }

      while (lanes.length && lanes[lanes.length - 1] === null) lanes.pop();

      maxLane = Math.max(maxLane, lane, ...edges.map((e) => e.lane));
      rows.push({ commit, lane, edges, active: lanes.slice() });
    }

    return { rows, width: (maxLane + 1) * LANE_W + PAD_X * 2 };
  }

  const x = (lane) => PAD_X + lane * LANE_W;
  const y = (row) => row * ROW_H + ROW_H / 2;

  /**
   * One lane change: quarter-turn out, optional straight run, quarter-turn
   * back to vertical — GitKraken's tight elbow rather than a long S-curve.
   * Consumes exactly 2r of vertical space and ends at (x2, y1 + 2r).
   *
   * Only M / L / A are ever emitted, and every one of them ends on an
   * explicit "x y" pair, so the last two numbers of a `d` string are always
   * that path's endpoint. The test suite leans on this.
   */
  function bend(x1, y1, x2, drop) {
    /* All three shapes eat the same `drop` of vertical space and finish at
       (x2, y1 + drop), so the geometry around them never has to know which one
       is in use — only the middle looks different. */
    if (JOIN === 'diagonal') return ` L${x2} ${y1 + drop}`;
    if (JOIN === 'angle') return ` L${x1} ${y1 + drop} L${x2} ${y1 + drop}`;

    const r = drop / 2;
    const dir = x2 > x1 ? 1 : -1;
    // Turning down->across is counter-clockwise to the right, clockwise to
    // the left; the second corner turns the other way.
    const sweepOut = dir > 0 ? 0 : 1;
    const sweepIn = dir > 0 ? 1 : 0;

    let d = ` A${r} ${r} 0 0 ${sweepOut} ${x1 + dir * r} ${y1 + r}`;
    if (Math.abs(x2 - x1) > 2 * r) d += ` L${x2 - dir * r} ${y1 + r}`;
    d += ` A${r} ${r} 0 0 ${sweepIn} ${x2} ${y1 + drop}`;
    return d;
  }

  /**
   * A line leaves the child dot, travels down inside its own lane (mx), then
   * lands on the parent's dot (px) — which may sit in a different lane when
   * several branches converge on the same commit.
   */
  function edgePath(cx, cy, mx, px, py) {
    const span = py - cy;
    const bends = (mx !== cx ? 1 : 0) + (px !== mx ? 1 : 0);
    // Nothing to bend around, or a parent that sorted above its child.
    if (bends === 0 || span <= 0) return `M${cx} ${cy} L${px} ${py}`;

    const drop = 2 * Math.max(2, Math.min(CORNER, LANE_W / 2, span / (2 * bends)));
    let d = `M${cx} ${cy}`;
    let cursor = cy;

    if (mx !== cx) {
      d += bend(cx, cursor, mx, drop);
      cursor += drop;
    }
    if (px !== mx) {
      const start = Math.max(cursor, py - drop);
      if (start > cursor) d += ` L${mx} ${start}`;
      d += bend(mx, start, px, drop);
    } else if (py > cursor) {
      d += ` L${px} ${py}`;
    }
    return d;
  }

  /* Edges that reach past their immediate neighbour — merges, and lanes that
     run for a long stretch. They are the only ones that can cross the visible
     band with neither end inside it, and there are few enough of them to scan
     on every frame instead of walking all the rows. Cached on the layout,
     which is rebuilt whenever the commits change. */
  function longEdges(layoutResult, indexByHash) {
    if (layoutResult.longEdgeCache) return layoutResult.longEdgeCache;
    const out = [];
    layoutResult.rows.forEach((row, i) => {
      for (const edge of row.edges) {
        const pi = indexByHash.get(edge.parent);
        if (pi !== undefined && Math.abs(pi - i) > 1) out.push({ i, pi, edge });
      }
    });
    layoutResult.longEdgeCache = out;
    return out;
  }

  /**
   * Build the SVG that sits behind the commit rows.
   * `options.avatarFor(commit)` may return an image URL for the dot; when it
   * returns nothing the dot stays a plain lane-coloured disc.
   * `options.first`/`options.last` limit the drawing to the rows on screen; the
   * SVG keeps its full height either way, so every coordinate stays absolute
   * and scrolling needs no translation.
   */
  function render(layoutResult, indexByHash, options = {}) {
    const { rows, width } = layoutResult;
    const offset = options.offsetRows || 0;
    const avatarFor = options.avatarFor || (() => null);
    const height = (rows.length + offset) * ROW_H;
    const first = Math.max(0, options.first ?? 0);
    const last = Math.min(rows.length, options.last ?? rows.length);

    const paths = [];
    const dots = [];

    /* An edge occupies the rows between its own and its parent's; a stub with no
       loaded parent occupies only its own. Drawn when that reaches the band. */
    const reaches = (i, pi) => (pi === undefined
      ? i >= first && i < last
      : Math.max(i, pi) >= first && Math.min(i, pi) < last);

    const drawEdge = (i, row, edge, pi) => {
      const cx = x(row.lane);
      const cy = y(i + offset);
      const mx = x(edge.lane);
      const pending = row.commit.pending === true;
      const stroke = pending ? 'var(--pending)' : laneColor(edge.lane);
      if (pi === undefined) {
        // Parent not loaded: stub the line off the bottom of the row.
        paths.push(
          `<path d="M${cx} ${cy} L${mx} ${cy + ROW_H * 0.9}" stroke="${stroke}" ` +
          `stroke-width="${STROKE}" fill="none" stroke-dasharray="2 3" opacity=".55"/>`
        );
        return;
      }
      const dash = pending ? ' stroke-dasharray="3 3"' : '';
      paths.push(
        `<path d="${edgePath(cx, cy, mx, x(rows[pi].lane), y(pi + offset))}" ` +
        `stroke="${stroke}"${dash} stroke-width="${STROKE}" fill="none" ` +
        `stroke-linecap="round" stroke-linejoin="round"/>`
      );
    };

    /* Edges are drawn one row wider than the band at each end: a line from the
       row just above reaches into the band, and with skewed commit dates one
       from just below can too. Beyond that neighbourhood a short edge cannot
       touch the band at all, which is what lets the long-edge list stay small. */
    const edgeFirst = Math.max(0, first - 1);
    const edgeLast = Math.min(rows.length, last + 1);
    for (let i = edgeFirst; i < edgeLast; i += 1) {
      const row = rows[i];
      for (const edge of row.edges) {
        const pi = indexByHash.get(edge.parent);
        if (reaches(i, pi)) drawEdge(i, row, edge, pi);
      }
    }

    for (let i = first; i < last; i += 1) {
      const row = rows[i];
      const cx = x(row.lane);
      const cy = y(i + offset);
      const pending = row.commit.pending === true;
      /* A stash is work set aside, not a commit on the branch, and its dot says
         so the way the uncommitted row does: a ring rather than a disc, drawn
         with a broken line. It keeps the lane's colour, because where it was
         taken from is the useful part. No face on it either — the dot is not
         reporting who wrote something, it is marking something parked. */
      const stash = row.commit.stash === true;
      const color = pending ? 'var(--pending)' : laneColor(row.lane);
      /* Below about six pixels the disc is smaller than the smallest legible
         face, and what lands there is a smear the same colour as everyone
         else's. The preference stays what the reader set; this is the drawing
         declining to draw something that cannot be seen. */
      const avatar = pending || stash || DOT_R < 6 ? null : avatarFor(row.commit);
      // A knocked-out ring keeps lines from running visibly under the dot.
      dots.push(
        `<circle cx="${cx}" cy="${cy}" r="${DOT_R + 1.5}" fill="var(--bg-graph)"/>` +
        `<circle cx="${cx}" cy="${cy}" r="${DOT_R}" fill="${color}"` +
        (pending
          ? ' fill-opacity=".2" stroke="var(--pending)" stroke-width="2" stroke-dasharray="2 2"'
          : stash
            ? ` fill-opacity=".14" stroke="${color}" stroke-width="1.8" stroke-dasharray="2.5 2.5"`
            : '') +
        '/>' +
        (avatar
          ? `<image href="${avatar}" x="${cx - AVATAR_R}" y="${cy - AVATAR_R}" ` +
            `width="${AVATAR_R * 2}" height="${AVATAR_R * 2}" ` +
            `clip-path="circle(50%)" preserveAspectRatio="xMidYMid slice"/>`
          : '')
      );
    }

    // Whatever crosses the band from outside it. Skewed commit dates can put a
    // parent above its child, so the span is bounded from both ends.
    if (first > 0 || last < rows.length) {
      for (const { i, pi, edge } of longEdges(layoutResult, indexByHash)) {
        if (i >= edgeFirst && i < edgeLast) continue;       // already drawn above
        if (reaches(i, pi)) drawEdge(i, rows[i], edge, pi);
      }
    }

    return (
      `<svg class="graph-svg" width="${width}" height="${height}" ` +
      `viewBox="0 0 ${width} ${height}" xmlns="http://www.w3.org/2000/svg">` +
      paths.join('') + dots.join('') + '</svg>'
    );
  }

  /* Getters rather than copies: the renderer reads Graph.ROW_H on every scroll
     and would keep the value it was given at load otherwise. */
  window.Graph = {
    layout, render, laneColor, setStyle, setMetrics, PAD_X,
    styles: Object.keys(STYLES),
    get ROW_H() { return ROW_H; },
    get LANE_W() { return LANE_W; },
    get DOT_R() { return DOT_R; },
  };
})();
