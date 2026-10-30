/* CCUsageX - Plan value card: what the plan gives (measured API-$ per 1% weekly) vs what was spent.
 * Data: GET /api/plan-value (same numbers as the Claude Pulse widget card). Renders into `[data-plan]`; hides itself when the
 * endpoint is missing or has nothing measured yet. Accounts come from the local CCSwitcherX folder when it exists. */
(function () {
  'use strict';

  var POLL_MS = 60000, RETRY_MS = 15000;
  var host = document.querySelector('[data-plan]');
  if (!host) return;
  var REDUCED = false;
  try { REDUCED = window.matchMedia('(prefers-reduced-motion: reduce)').matches; } catch (e) { /* ignore */ }

  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function money(v) { v = Math.round(Number(v) || 0); return (v < 0 ? '-$' : '$') + String(Math.abs(v)).replace(/\B(?=(\d{3})+(?!\d))/g, ','); }
  // n > 1: the yardstick is one day of all the accounts, so the words drop "plan"
  function days(pd, n) {
    if (pd == null) return '';
    var unit = n > 1 ? 'day' : 'plan-day';
    if (pd < 1) return Math.round(pd * 100) + '% of a ' + unit;
    var t = pd.toFixed(1);
    return t + ' ' + unit + (t === '1.0' ? '' : 's');
  }
  function perHour(v) { return '$' + (v >= 10 ? Math.round(v) : v.toFixed(2)) + '/h'; }
  var atDtf = new Intl.DateTimeFormat(undefined, { weekday: 'short', hour: 'numeric', minute: '2-digit' });
  var mdDtf = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' });
  function at(ms) { return ms ? atDtf.format(ms) : ''; }
  function st(p) { return p >= 100 ? 'limit' : p >= 90 ? 'high' : p >= 70 ? 'watch' : 'ok'; }

  // will the accounts carry the week? one answer line plus the numbers behind it (same wording as the widget)
  function verdict(d) {
    var fc = d.forecast;
    if (!fc) return '';
    var n = d.accounts && d.accounts.count > 1 ? d.accounts.count : 1;
    var title, sub = 'You use ' + money(fc.usualDay) + '/day · ' + (fc.safeDay == null ? 'any pace is safe' : 'safe up to <b>' + money(fc.safeDay) + '/day</b>'), sub2 = '';
    if (fc.verdict === 'enough') {
      title = (n > 1 ? 'Your ' + n + ' accounts are' : 'Your account is') + ' enough this week';
      if (fc.headroom) sub2 = 'Room for ' + fc.headroom.toFixed(1) + '× your usual pace; a heavy ' + money(fc.heavyDay) + ' day still fits';
    } else if (fc.verdict === 'tight') {
      title = 'Enough, but tight on heavy days';
      sub2 = 'Heavy days (' + money(fc.heavyDay) + ') run dry ' + esc(at(fc.heavyDryAt));
    } else {
      title = 'Runs dry ' + esc(at(fc.dryAt));
      sub2 = (fc.safeDay != null ? 'Cut ≈ ' + money(fc.usualDay - fc.safeDay) + '/day to last' : '') + (fc.backAt ? ' · back ' + esc(at(fc.backAt)) : '');
    }
    return '<div class="pvd-v" data-v="' + fc.verdict + '"><i></i><div><b>' + title + '</b><span>' + sub + (sub2 ? ' · ' + sub2 : '') + '</span></div></div>';
  }

  var sig = '', drawn = false;
  function render(d) {
    if (!d || !d.ok || !d.plan) { host.hidden = true; host.innerHTML = ''; sig = ''; return; }
    var p = d.plan, td = d.today || {}, yd = d.yesterday || {}, acc = d.accounts && d.accounts.list && d.accounts.list.length ? d.accounts : null;
    var n = acc && acc.count > 1 ? acc.count : 1, lv = d.live;
    var wk = p.range ? money(p.range.lo) + '–' + money(p.range.hi).slice(1) : money(p.perWeek);
    var note = p.stale && p.measuredAt ? '<span class="pvd-old">last measured ' + esc(mdDtf.format(p.measuredAt)) + '</span>'
      : p.range ? '<span class="pvd-old">still measuring</span>' : '<span>from ' + p.chunks + ' measured stretches</span>';
    var top = Math.max(1.25, (td.planDays || 0) * 1.08, (yd.planDays || 0) * 1.08);
    var h = '<div class="lim-top"><div class="lim-title"><h3><span class="sq"></span>Plan value</h3></div>' +
      '<div class="lim-meta">' + note + '</div></div><div class="pvd-body">' + verdict(d);
    // several accounts each have their own $ per 1%, so the headline is the week of all of them
    h += '<div class="pvd-kpis"><div class="pvd-k"><small>' + (n > 1 ? 'All ' + n + ' accounts ≈' : 'Your plan ≈') + '</small><b>' + wk + '</b><span>a week of API work</span></div>' +
      '<div class="pvd-k"><small>Per day</small><b>' + money(p.perDay) + '</b><span>' + (p.perPct != null ? money(p.perPct) + ' per 1% weekly' : 'each account at its own rate') + '</span></div>';
    if (acc) h += '<div class="pvd-k"><small>Left this week</small><b>≈ ' + money(acc.spare) + '</b><span>across ' + acc.count + (acc.count === 1 ? ' account' : ' accounts') + '</span></div>';
    // right now: the last hour's $/h and what still fits today at the pace that lasts the week (the widget's coach)
    if (lv && d.forecast) h += '<div class="pvd-k"><small>Right now</small><b>' + perHour(lv.lastHour || 0) + '</b><span>' +
      (lv.restSafe != null ? '≈ ' + money(lv.restSafe) + ' more fits today' : 'any pace fits this week') + '</span></div>';
    h += '</div><div class="pvd-days">';
    [['Today', td], ['Yesterday', yd]].forEach(function (x) {
      var v = x[1], frac = Math.min(1, (v.planDays || 0) / top);
      var split = v.split && v.split.length > 1 ? v.split.map(function (s) { return esc(s.label) + ' ' + money(s.cost); }).join(' · ') : '';
      h += '<div class="pvd-d" data-st="' + ((v.planDays || 0) > 1 ? 'watch' : 'ok') + '"><b>' + x[0] + '</b>' +
        '<div class="pvd-bar"><i style="--f:' + frac.toFixed(4) + '"></i><span style="left:' + (100 / top).toFixed(1) + '%" title="one plan-day"></span></div>' +
        '<em>' + money(v.cost) + ' <small>· ' + days(v.planDays, n) + '</small></em>' + (split ? '<p>' + split + '</p>' : '') + '</div>';
    });
    h += '</div>';
    if (acc) {
      h += '<div class="pvd-acc">';
      acc.list.forEach(function (a) {
        var pct = Math.max(0, Math.min(100, a.pct || 0));
        h += '<div class="pvd-a' + (a.active ? ' on' : '') + '" data-st="' + st(pct) + '"><b><i></i>' + esc(a.label) + (a.active ? ' <small>active</small>' : '') + '</b>' +
          '<div class="pvd-bar"><i style="--f:' + (pct / 100).toFixed(4) + '"></i></div><em>' + Math.round(pct) + '%</em>' +
          '<span>' + (a.fullAt ? 'full ≈ ' + esc(at(a.fullAt)) : 'resets ' + esc(at(a.resetsAt))) + '</span><span>' + (a.spare != null ? '≈ ' + money(a.spare) + ' left' : '') +
          (a.perPct ? ' · ' + money(a.perPct) + ' per 1%' : '') + '</span></div>';
      });
      h += '</div>';
    }
    var rw = d.runway;
    if (rw && !d.forecast) {
      var many = n > 1, who = many ? 'All ' + n + ' accounts' : 'This account';
      var rate = rw.perHour > 0 ? ' at ' + money(rw.perHour) + '/h' : '';
      h += '<p class="pvd-run">' + (rw.outlasts ? who + (many ? ' outlast' : ' outlasts') + ' <b>the week</b>' + rate
        : who + (many ? ' last' : ' lasts') + ' until <b>' + esc(at(rw.until)) + '</b>' + rate + (rw.dryUntil ? ' · first reset ' + esc(at(rw.dryUntil)) : '')) + '</p>';
    }
    if (d.effort && d.effort.length) {
      h += '<p class="pvd-run">Cost per prompt by effort, last ' + (d.pace && d.pace.days || 7) + ' days: ' + d.effort.map(function (e) {
        return '<b>' + esc(e.effort) + '</b> $' + e.perPrompt.toFixed(2) + ' <small>(' + e.prompts + ')</small>';
      }).join(' · ') + '</p>';
    }
    (d.tips || []).slice(0, 3).forEach(function (t) {
      h += '<p class="pvd-tip" data-save="' + (t.savePerDay > 0 ? 1 : 0) + '"><b>' + (t.savePerDay > 0 ? 'Save' : 'Tip') + '</b>' + esc(t.text) + '</p>';
    });
    h += '</div>';
    host.hidden = false;
    if (h === sig) return;
    sig = h;
    host.innerHTML = h;
    if (!drawn && !REDUCED) {               // bars grow in once; later updates move without replaying
      host.classList.add('pvd-in');
      requestAnimationFrame(function () { requestAnimationFrame(function () { host.classList.remove('pvd-in'); }); });
    }
    drawn = true;
  }

  var timer = 0;
  function load() {
    clearTimeout(timer);
    var delay = POLL_MS;
    fetch('/api/plan-value', { cache: 'no-store' })
      .then(function (r) { if (r.status === 404) return null; if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
      .then(render)
      .catch(function () { delay = RETRY_MS; })
      .finally(function () { timer = setTimeout(load, delay); });
  }
  document.addEventListener('visibilitychange', function () { if (!document.hidden) load(); });
  load();
})();
