/* CCUsageX - the week-ahead and the last-days charts of the plan value cards, shared by the Claude Pulse widget and the
 * dashboard. Each chart is an SVG string plus one hover layer (crosshair + tooltip on the forecast, one tooltip per bar
 * on the days); colours come from the page's CSS through the pvc-* classes. Times are drawn in the viewer's own zone.
 * The pure helpers are exported for the tests. */
(function (root) {
  'use strict';

  function money(v) { v = Math.round(Number(v) || 0); return (v < 0 ? '-$' : '$') + String(Math.abs(v)).replace(/\B(?=(\d{3})+(?!\d))/g, ','); }
  function short$(v) {
    v = Math.round(Number(v) || 0);
    if (v >= 10000) return '$' + Math.round(v / 1000) + 'k';
    if (v >= 1000) return '$' + (v / 1000).toFixed(1).replace(/\.0$/, '') + 'k';
    return '$' + v;
  }
  // the $ left at time t: the track is exact at its points and falls in straight lines between them (a reset is two
  // points at the same time, before and after the refill: the later one wins)
  function valueAt(track, t) {
    if (!track || !track.length) return null;
    if (t < track[0][0]) return track[0][1];
    var i = 0;
    while (i + 1 < track.length && track[i + 1][0] <= t) i++;
    if (i + 1 >= track.length) return track[i][1];
    var a = track[i], b = track[i + 1];
    return a[1] + (b[1] - a[1]) * (t - a[0]) / (b[0] - a[0]);
  }
  function lowOf(track) {
    var lo = null;
    for (var i = 0; track && i < track.length; i++) if (!lo || track[i][1] < lo.v) lo = { t: track[i][0], v: track[i][1] };
    return lo;
  }
  function niceMax(v) {
    if (!(v > 0)) return 100;
    var e = Math.pow(10, Math.floor(Math.log(v) / Math.LN10)), m = v / e, steps = [1, 1.2, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10];
    for (var i = 0; i < steps.length; i++) if (m <= steps[i] + 1e-9) return steps[i] * e;
    return 10 * e;
  }
  function midnights(from, to) {
    var out = [], d = new Date(from);
    d.setHours(24, 0, 0, 0);
    for (var g = 0; g < 40 && d.getTime() < to; g++) { out.push(d.getTime()); d.setDate(d.getDate() + 1); d.setHours(0, 0, 0, 0); }
    return out;
  }
  function inSpan(spans, t) {
    for (var i = 0; spans && i < spans.length; i++) if (t >= spans[i][0] && t < spans[i][1]) return spans[i];
    return null;
  }
  var wdDtf = null;
  function wd(ms) { if (!wdDtf) wdDtf = new Intl.DateTimeFormat(undefined, { weekday: 'short' }); return wdDtf.format(ms); }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
  function n1(v) { return Math.round(v * 10) / 10; }
  function pathOf(track, X, Y) {
    var s = '';
    for (var i = 0; i < track.length; i++) s += (i ? 'L' : 'M') + n1(X(track[i][0])) + ' ' + n1(Y(track[i][1]));
    return s;
  }

  // the tooltip sits beside the hovered x (right of it in the left half, left of it in the right half), inside the box
  function place(box, tip, px) {
    var bw = box.clientWidth, tw = tip.offsetWidth, x = px < bw / 2 ? px + 10 : px - tw - 10;
    tip.style.left = Math.max(0, Math.min(bw - tw, x)) + 'px';
  }

  /* ---------- the week ahead: $ left across the accounts at the usual and the heavy pace ---------- */
  // f: plan-value .future; o: { w, h, padL, padR, padT, padB, uid }
  function futureModel(f, o) {
    var pl = o.padL, pr = o.padR, pt = o.padT, pb = o.padB, pw = o.w - pl - pr, ph = o.h - pt - pb;
    var top = 0, tracks = [f.usual, f.heavy];
    for (var k = 0; k < 2; k++) for (var i = 0; tracks[k] && i < tracks[k].length; i++) top = Math.max(top, tracks[k][i][1]);
    var ymax = niceMax(top * 1.06);
    return {
      f: f, o: o, pw: pw, ph: ph, ymax: ymax,
      X: function (t) { return pl + Math.max(0, Math.min(1, (t - f.from) / (f.to - f.from))) * pw; },
      T: function (x) { return f.from + Math.max(0, Math.min(1, (x - pl) / pw)) * (f.to - f.from); },
      Y: function (v) { return pt + ph - Math.max(0, Math.min(1, v / ymax)) * ph; },
    };
  }
  function futureSvg(f, o) {
    var m = futureModel(f, o), X = m.X, Y = m.Y, pl = o.padL, pt = o.padT, x2 = o.w - o.padR, y0 = Y(0), uid = o.uid || 'pvc';
    var s = '<svg class="pvc" viewBox="0 0 ' + o.w + ' ' + o.h + '" width="' + o.w + '" height="' + o.h + '" role="img" aria-label="' + esc(o.label || '') + '">';
    s += '<defs><linearGradient id="' + uid + 'g" x1="0" y1="0" x2="0" y2="1"><stop class="pvc-g0" offset="0"/><stop class="pvc-g1" offset="1"/></linearGradient>' +
      '<pattern id="' + uid + 'p" width="5" height="5" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><rect class="pvc-hatch" width="2" height="5"/></pattern></defs>';
    // grid: $0, half, top; the y labels sit in the left gutter
    [0, m.ymax / 2, m.ymax].forEach(function (v) {
      var y = n1(Y(v));
      s += '<line class="pvc-grid" x1="' + pl + '" x2="' + x2 + '" y1="' + y + '" y2="' + y + '"/><text class="pvc-ax" x="' + (pl - 5) + '" y="' + y + '" text-anchor="end" dominant-baseline="central">' + short$(v) + '</text>';
    });
    // days: a hairline at each local midnight, the weekday under the middle of each day
    var ms = midnights(f.from, f.to), edges = [f.from].concat(ms, [f.to]);
    ms.forEach(function (t) { var x = n1(X(t)); s += '<line class="pvc-day" x1="' + x + '" x2="' + x + '" y1="' + pt + '" y2="' + y0 + '"/>'; });
    for (var i = 0; i + 1 < edges.length; i++) {
      var a = X(edges[i]), b = X(edges[i + 1]);
      if (b - a < (o.minDayPx || 18)) continue;
      s += '<text class="pvc-ax" x="' + n1((a + b) / 2) + '" y="' + (o.h - 2) + '" text-anchor="middle">' + esc(i === 0 && o.nowLabel ? o.nowLabel : wd(edges[i] + 36e5)) + '</text>';
    }
    // every account full: solid band at the usual pace, hatched at the heavy pace
    (f.heavyDry || []).forEach(function (d) { s += '<rect class="pvc-dryh" fill="url(#' + uid + 'p)" x="' + n1(X(d[0])) + '" y="' + pt + '" width="' + n1(Math.max(1, X(d[1]) - X(d[0]))) + '" height="' + n1(y0 - pt) + '"/>'; });
    (f.dry || []).forEach(function (d) { s += '<rect class="pvc-dry" x="' + n1(X(d[0])) + '" y="' + pt + '" width="' + n1(Math.max(1, X(d[1]) - X(d[0]))) + '" height="' + n1(y0 - pt) + '"/>'; });
    if (f.usual && f.usual.length) {
      var up = pathOf(f.usual, X, Y);
      s += '<path class="pvc-area" fill="url(#' + uid + 'g)" d="' + up + 'L' + n1(X(f.usual[f.usual.length - 1][0])) + ' ' + n1(y0) + 'L' + n1(X(f.usual[0][0])) + ' ' + n1(y0) + 'Z"/>';
      if (f.heavy && f.heavy.length) s += '<path class="pvc-h" d="' + pathOf(f.heavy, X, Y) + '"/>';
      s += '<path class="pvc-u" d="' + up + '"/>';
      // one direct label: the lowest $ left at the usual pace
      var lo = lowOf(f.usual);
      if (lo && o.lowLabel !== false) {
        var lx = X(lo.t), ly = Y(lo.v), right = lx > o.w - 46;
        s += '<circle class="pvc-dot" cx="' + n1(lx) + '" cy="' + n1(ly) + '" r="3"/>' +
          '<text class="pvc-lbl" x="' + n1(right ? lx - 5 : lx + 5) + '" y="' + n1(Math.max(pt + 7, ly - 6)) + '" text-anchor="' + (right ? 'end' : 'start') + '">' + (lo.v > 0 ? 'low ' + money(lo.v) : 'all full') + '</text>';
      }
    }
    // the hover layer (moved by attachFuture)
    s += '<g class="pvc-hover" visibility="hidden"><line class="pvc-x" y1="' + pt + '" y2="' + n1(y0) + '"/><circle class="pvc-hd" r="3.5"/><circle class="pvc-ud" r="3.5"/></g>';
    s += '<rect class="pvc-hit" x="' + pl + '" y="0" width="' + m.pw + '" height="' + o.h + '" fill="transparent"/></svg>';
    return s;
  }
  // the tooltip text at time t (pure: the tests read it)
  function futureTip(f, t, fmtAt) {
    var u = valueAt(f.usual, t), h = f.heavy ? valueAt(f.heavy, t) : null, du = inSpan(f.dry, t), dh = inSpan(f.heavyDry, t);
    var lines = [{ k: 'u', text: du ? 'usual: all full, back ' + fmtAt(du[1]) : 'usual ' + money(u) + ' left' }];
    if (f.heavy) lines.push({ k: 'h', text: dh ? 'heavy: all full, back ' + fmtAt(dh[1]) : 'heavy ' + money(h) + ' left' });
    var near = (f.to - f.from) / 60, resets = (f.expires || []).filter(function (e) { return Math.abs(e.at - t) <= near; });
    if (resets.length) lines.push({ k: 'r', text: resets.map(function (e) { return e.label; }).join(', ') + ' reset' + (resets.length > 1 ? '' : 's') + (resets.some(function (e) { return e.usd > 0; }) ? ' · ' + money(resets.reduce(function (x, e) { return x + e.usd; }, 0)) + ' unused' : '') });
    return { title: fmtAt(t), lines: lines, usual: u, heavy: h };
  }
  function attachFuture(box, f, o, fmtAt) {
    box._pvc = { f: f, o: o, m: futureModel(f, o), fmtAt: fmtAt };
    if (box._pvcOn) return;
    box._pvcOn = true;
    var tip = box.querySelector('.pvc-tip');
    if (!tip) { tip = document.createElement('div'); tip.className = 'pvc-tip'; tip.hidden = true; box.appendChild(tip); }
    function move(ev) {
      var st = box._pvc, svg = box.querySelector('svg.pvc');
      if (!st || !svg) return;
      var r = svg.getBoundingClientRect(), sx = st.o.w / (r.width || st.o.w), x = (ev.clientX - r.left) * sx;
      if (x < st.o.padL - 2 || x > st.o.w - st.o.padR + 2) { hide(); return; }
      var t = st.m.T(x), tp = futureTip(st.f, t, st.fmtAt), cx = st.m.X(t);
      var g = svg.querySelector('.pvc-hover'), ln = g.querySelector('.pvc-x'), ud = g.querySelector('.pvc-ud'), hd = g.querySelector('.pvc-hd');
      ln.setAttribute('x1', cx); ln.setAttribute('x2', cx);
      ud.setAttribute('cx', cx); ud.setAttribute('cy', st.m.Y(tp.usual || 0));
      if (tp.heavy != null) { hd.setAttribute('cx', cx); hd.setAttribute('cy', st.m.Y(tp.heavy)); hd.setAttribute('visibility', 'visible'); } else hd.setAttribute('visibility', 'hidden');
      g.setAttribute('visibility', 'visible');
      tip.innerHTML = '<b>' + esc(tp.title) + '</b>' + tp.lines.map(function (l) { return '<span data-k="' + l.k + '"><i></i>' + esc(l.text) + '</span>'; }).join('');
      tip.hidden = false;
      place(box, tip, cx / sx);
    }
    function hide() { var svg = box.querySelector('svg.pvc'), g = svg && svg.querySelector('.pvc-hover'); if (g) g.setAttribute('visibility', 'hidden'); tip.hidden = true; }
    box.addEventListener('pointermove', move);
    box.addEventListener('pointerleave', hide);
  }

  /* ---------- the last days: $ of work per day, the days before this week fainter, today so far outlined ---------- */
  // series: [{ from, cost }] oldest first; today: { from, cost } | null; ref: $ of one day of the accounts (or null)
  function daysModel(series, today, ref, o) {
    var bars = series.map(function (d, i) { return { from: d.from, cost: d.cost, prev: i < series.length - 7 }; });
    if (today) bars.push({ from: today.from, cost: today.cost, today: true });
    var top = ref || 0;
    bars.forEach(function (b) { top = Math.max(top, b.cost); });
    var ymax = niceMax(top * 1.08), pw = o.w - o.padL - o.padR, ph = o.h - o.padT - o.padB, n = Math.max(1, bars.length), step = pw / n;
    var bw = Math.max(3, Math.min(o.maxBar || 18, step - (o.gap || 2)));
    return { bars: bars, ymax: ymax, step: step, bw: bw, ph: ph, Y: function (v) { return o.padT + ph - Math.max(0, Math.min(1, v / ymax)) * ph; } };
  }
  function daysSvg(series, today, ref, o) {
    var m = daysModel(series, today, ref, o), y0 = m.Y(0), x2 = o.w - o.padR;
    var s = '<svg class="pvc" viewBox="0 0 ' + o.w + ' ' + o.h + '" width="' + o.w + '" height="' + o.h + '" role="img" aria-label="' + esc(o.label || '') + '">';
    [0, m.ymax / 2, m.ymax].forEach(function (v) {
      var y = n1(m.Y(v));
      s += '<line class="pvc-grid" x1="' + o.padL + '" x2="' + x2 + '" y1="' + y + '" y2="' + y + '"/><text class="pvc-ax" x="' + (o.padL - 5) + '" y="' + y + '" text-anchor="end" dominant-baseline="central">' + short$(v) + '</text>';
    });
    m.bars.forEach(function (b, i) {
      var x = o.padL + i * m.step + (m.step - m.bw) / 2, y = m.Y(b.cost), hgt = Math.max(0, y0 - y), r = Math.min(3, m.bw / 2, hgt);
      var cls = 'pvc-bar' + (b.prev ? ' prev' : '') + (b.today ? ' today' : '');
      if (hgt > 0.5) {
        // rounded at the data end, square on the baseline
        s += '<path class="' + cls + '" data-i="' + i + '" d="M' + n1(x) + ' ' + n1(y0) + 'V' + n1(y + r) + 'Q' + n1(x) + ' ' + n1(y) + ' ' + n1(x + r) + ' ' + n1(y) + 'H' + n1(x + m.bw - r) +
          'Q' + n1(x + m.bw) + ' ' + n1(y) + ' ' + n1(x + m.bw) + ' ' + n1(y + r) + 'V' + n1(y0) + 'Z"/>';
      }
      if (o.dayLabels !== false && (m.step >= 14 || i % 2 === 0 || b.today)) {
        s += '<text class="pvc-ax' + (b.today ? ' now' : '') + '" x="' + n1(x + m.bw / 2) + '" y="' + (o.h - 2) + '" text-anchor="middle">' + esc(b.today ? (o.todayLabel || 'now') : (m.step >= 26 ? wd(b.from + 36e5) : wd(b.from + 36e5).slice(0, 1))) + '</text>';
      }
    });
    if (ref > 0) {
      var ry = n1(m.Y(ref));
      s += '<line class="pvc-ref" x1="' + o.padL + '" x2="' + x2 + '" y1="' + ry + '" y2="' + ry + '"/>';
      if (o.refLabel) s += '<text class="pvc-lbl ref" x="' + (x2 - 1) + '" y="' + n1(ry - 4) + '" text-anchor="end">' + esc(o.refLabel) + '</text>';
    }
    s += '<rect class="pvc-hit" x="' + o.padL + '" y="0" width="' + n1(o.w - o.padL - o.padR) + '" height="' + o.h + '" fill="transparent"/></svg>';
    return s;
  }
  function attachDays(box, series, today, ref, o, fmtDay) {
    box._pvd = { m: daysModel(series, today, ref, o), o: o, ref: ref, fmtDay: fmtDay };
    if (box._pvdOn) return;
    box._pvdOn = true;
    var tip = box.querySelector('.pvc-tip');
    if (!tip) { tip = document.createElement('div'); tip.className = 'pvc-tip'; tip.hidden = true; box.appendChild(tip); }
    var lit = null;
    function move(ev) {
      var st = box._pvd, svg = box.querySelector('svg.pvc');
      if (!st || !svg) return;
      var r = svg.getBoundingClientRect(), sx = st.o.w / (r.width || st.o.w), x = (ev.clientX - r.left) * sx;
      var i = Math.floor((x - st.o.padL) / st.m.step), b = st.m.bars[i];
      if (!b) { hide(); return; }
      if (lit) lit.classList.remove('on');
      lit = svg.querySelector('.pvc-bar[data-i="' + i + '"]');
      if (lit) lit.classList.add('on');
      var days = st.ref > 0 ? b.cost / st.ref : null;
      tip.innerHTML = '<b>' + esc(st.fmtDay(b.from) + (b.today ? ', so far' : '')) + '</b><span><i></i>' + money(b.cost) + (days != null ? ' · ' + (days < 1 ? Math.round(days * 100) + '% of a day' : days.toFixed(2) + ' days') : '') + '</span>';
      tip.hidden = false;
      place(box, tip, (st.o.padL + (i + 0.5) * st.m.step) / sx);
    }
    function hide() { if (lit) lit.classList.remove('on'); lit = null; tip.hidden = true; }
    box.addEventListener('pointermove', move);
    box.addEventListener('pointerleave', hide);
  }

  /* ---------- bar strips: today hour by hour against your usual day, the last two hours in 5-minute steps ---------- */
  // o: { w, h, padL, padR, padT, padB, gap, axis (a $ label on the top line), now (index of the bar still filling),
  //      nowAt (bars from the left edge to the moment now), bands [{ from, to, k }] in bars, ticks [{ at, text }] in bars }
  function stripModel(vals, ghost, o) {
    var n = vals.length, top = 0;
    for (var i = 0; i < n; i++) top = Math.max(top, vals[i] || 0, ghost ? ghost[i] || 0 : 0);
    var pw = o.w - o.padL - o.padR, ph = o.h - o.padT - o.padB, step = pw / n, ymax = niceMax(top * 1.05);
    return { n: n, step: step, bw: Math.max(1.5, step - (o.gap == null ? 2 : o.gap)), ymax: ymax,
      X: function (i) { return o.padL + i * step; },
      Y: function (v) { return o.padT + ph - Math.max(0, Math.min(1, v / ymax)) * ph; } };
  }
  // rounded at the data end, square on the baseline
  function barD(x, y, w, y0) {
    var r = Math.min(2, w / 2, y0 - y);
    return 'M' + n1(x) + ' ' + n1(y0) + 'V' + n1(y + r) + 'Q' + n1(x) + ' ' + n1(y) + ' ' + n1(x + r) + ' ' + n1(y) + 'H' + n1(x + w - r) +
      'Q' + n1(x + w) + ' ' + n1(y) + ' ' + n1(x + w) + ' ' + n1(y + r) + 'V' + n1(y0) + 'Z';
  }
  function stripSvg(vals, ghost, o) {
    var m = stripModel(vals, ghost, o), y0 = m.Y(0), x2 = o.w - o.padR, off = (m.step - m.bw) / 2;
    var s = '<svg class="pvc pvs" viewBox="0 0 ' + o.w + ' ' + o.h + '" width="' + o.w + '" height="' + o.h + '" role="img" aria-label="' + esc(o.label || '') + '">';
    (o.bands || []).forEach(function (b) {
      s += '<rect class="pvs-band ' + b.k + '" x="' + n1(m.X(b.from)) + '" y="' + o.padT + '" width="' + n1(Math.max(1, (b.to - b.from) * m.step)) + '" height="' + n1(y0 - o.padT) + '"/>';
    });
    if (o.axis) {
      var yt = n1(m.Y(m.ymax));
      s += '<line class="pvc-grid" x1="' + o.padL + '" x2="' + x2 + '" y1="' + yt + '" y2="' + yt + '"/><text class="pvc-ax" x="' + (o.padL - 4) + '" y="' + yt + '" text-anchor="end" dominant-baseline="central">' + short$(m.ymax) + '</text>';
    }
    s += '<line class="pvc-grid" x1="' + o.padL + '" x2="' + x2 + '" y1="' + n1(y0) + '" y2="' + n1(y0) + '"/>';
    for (var i = 0; i < m.n; i++) {
      var x = m.X(i) + off, g = ghost ? ghost[i] || 0 : 0, v = vals[i] || 0;
      if (g > 0 && y0 - m.Y(g) > 0.5) s += '<path class="pvs-g" d="' + barD(x, m.Y(g), m.bw, y0) + '"/>';
      if (v > 0 && y0 - m.Y(v) > 0.5 && (o.now == null || i <= o.now)) s += '<path class="pvs-v' + (i === o.now ? ' now' : '') + '" data-i="' + i + '" d="' + barD(x, m.Y(v), m.bw, y0) + '"/>';
    }
    if (o.nowAt != null) { var xn = n1(m.X(o.nowAt)); s += '<line class="pvs-now" x1="' + xn + '" x2="' + xn + '" y1="' + (o.padT - 2) + '" y2="' + n1(y0 + 2) + '"/>'; }
    (o.ticks || []).forEach(function (t) {
      var xt = n1(m.X(t.at));
      s += '<text class="pvc-ax" x="' + xt + '" y="' + (o.h - 1) + '" text-anchor="' + (t.at === 0 ? 'start' : t.at >= m.n ? 'end' : 'middle') + '">' + esc(t.text) + '</text>';
    });
    s += '<rect class="pvc-hit" x="' + o.padL + '" y="0" width="' + n1(o.w - o.padL - o.padR) + '" height="' + o.h + '" fill="transparent"/></svg>';
    return s;
  }
  // tip(i) -> { title, lines: [{ k, text }] } or null for no tooltip on that bar
  function attachStrip(box, vals, ghost, o, tip) {
    box._pvs = { m: stripModel(vals, ghost, o), o: o, tip: tip };
    if (box._pvsOn) return;
    box._pvsOn = true;
    var el = box.querySelector('.pvc-tip');
    if (!el) { el = document.createElement('div'); el.className = 'pvc-tip'; el.hidden = true; box.appendChild(el); }
    var lit = null;
    function move(ev) {
      var st = box._pvs, svg = box.querySelector('svg.pvc');
      if (!st || !svg) return;
      var r = svg.getBoundingClientRect(), sx = st.o.w / (r.width || st.o.w), x = (ev.clientX - r.left) * sx;
      var i = Math.floor((x - st.o.padL) / st.m.step), tp = i >= 0 && i < st.m.n ? st.tip(i) : null;
      if (!tp) { hide(); return; }
      if (lit) lit.classList.remove('on');
      lit = svg.querySelector('.pvs-v[data-i="' + i + '"]');
      if (lit) lit.classList.add('on');
      el.innerHTML = '<b>' + esc(tp.title) + '</b>' + tp.lines.map(function (l) { return '<span data-k="' + l.k + '"><i></i>' + esc(l.text) + '</span>'; }).join('');
      el.hidden = false;
      place(box, el, (st.o.padL + (i + 0.5) * st.m.step) / sx);
    }
    function hide() { if (lit) lit.classList.remove('on'); lit = null; el.hidden = true; }
    box.addEventListener('pointermove', move);
    box.addEventListener('pointerleave', hide);
  }

  // big counts short: 801857437 -> 802M
  function count(v) {
    v = Number(v) || 0;
    if (v >= 1e9) return (v / 1e9).toFixed(v >= 1e10 ? 0 : 1).replace(/\.0$/, '') + 'B';
    if (v >= 1e6) return (v / 1e6).toFixed(v >= 1e7 ? 0 : 1).replace(/\.0$/, '') + 'M';
    if (v >= 1e3) return (v / 1e3).toFixed(v >= 1e4 ? 0 : 1).replace(/\.0$/, '') + 'k';
    return String(Math.round(v));
  }

  var api = { money: money, short$: short$, count: count, valueAt: valueAt, lowOf: lowOf, niceMax: niceMax, midnights: midnights, inSpan: inSpan,
    futureSvg: futureSvg, futureTip: futureTip, attachFuture: attachFuture, daysSvg: daysSvg, attachDays: attachDays, daysModel: daysModel,
    stripModel: stripModel, stripSvg: stripSvg, attachStrip: attachStrip };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.PVCharts = api;
})(this);
