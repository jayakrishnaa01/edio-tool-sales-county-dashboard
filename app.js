/* EDIO Sales Geography — application layer.
 * Data flow: sheet/CSV -> parse -> engine.resolve per row -> overrides -> normalized
 * records -> filters -> aggregates -> maps/tables. Nothing on screen is hardcoded.
 */
(function () {
'use strict';
const E = window.EdioEngine;
E.init(window.EDIO_PIN, window.EDIO_PLACES);
const GEO = window.EDIO_GEO;
const STATES = window.EDIO_PIN.states;
const DISTS = window.EDIO_PIN.districts;

const $ = (s) => document.querySelector(s);
const el = (tag, cls, html) => { const n = document.createElement(tag); if (cls) n.className = cls; if (html != null) n.innerHTML = html; return n; };
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
const fmt = (n) => Number(n || 0).toLocaleString('en-IN');
const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} },
  del(k) { try { localStorage.removeItem(k); } catch (e) {} }
};

// ---------------- state ----------------
const S = {
  rawCsv: '', headers: [], colMap: {}, extraFilters: [],   // detected categorical columns
  records: [],            // normalized records
  view: { tab: 'overview', state: null, district: null },
  filters: { dateMode: 'all', from: null, to: null, dyn: {}, search: '' },
  includeLow: store.get('edio_includeLow', true),
  showMobiles: false,
  custPage: 0, custSort: { key: 'date', dir: -1 },
  verifyPage: 0,
  overrides: store.get('edio_overrides', {}),
  source: store.get('edio_source', { mode: 'demo', url: '' }),
  lastSync: store.get('edio_lastSync', null),
  pollSec: store.get('edio_poll', 300),
  pollTimer: null, syncing: false
};

// ---------------- CSV ----------------
function parseCSV(text) {
  const rows = []; let cur = '', row = [], q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"') { if (text[i + 1] === '"') { cur += '"'; i++; } else q = false; }
      else cur += c;
    } else if (c === '"') q = true;
    else if (c === ',') { row.push(cur); cur = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(cur); cur = '';
      if (row.length > 1 || row[0] !== '') rows.push(row);
      row = [];
    } else cur += c;
  }
  if (cur !== '' || row.length) { row.push(cur); if (row.length > 1 || row[0] !== '') rows.push(row); }
  return rows;
}
function toCSV(rows) {
  return rows.map(r => r.map(v => {
    v = String(v == null ? '' : v);
    return /[",\n\r]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v;
  }).join(',')).join('\r\n');
}

function detectColumns(headers) {
  const h = headers.map(x => E.norm(x));
  const find = (re, not) => h.findIndex(x => re.test(x) && !(not && not.test(x)));
  const map = {};
  map.date = find(/date|purchased on|dt of/);
  map.name = find(/customer|name/, /sales|shop col/);
  if (map.name === map.date) map.name = -1;
  map.address = find(/address|location|place/);
  map.mobile = find(/mobile|phone|contact|whatsapp|whats app/);
  map.qty = find(/qty|quantity|units|nos/);
  const extras = [];
  const tool = find(/tool|product|model|item/, /date|purchase/);
  if (tool >= 0 && tool !== map.date) extras.push({ idx: tool, key: 'tool', label: headers[tool] });
  const sp = find(/sales ?person|salesman|sales man|executive|sold by|seller|staff/);
  if (sp >= 0) extras.push({ idx: sp, key: 'salesperson', label: headers[sp] });
  const dealer = find(/dealer|distributor/);
  if (dealer >= 0) extras.push({ idx: dealer, key: 'dealer', label: headers[dealer] });
  const ctype = find(/customer type|cust type|type of customer/);
  if (ctype >= 0) extras.push({ idx: ctype, key: 'ctype', label: headers[ctype] });
  const pay = find(/payment/);
  if (pay >= 0) extras.push({ idx: pay, key: 'payment', label: headers[pay] });
  return { map, extras };
}

// ---------------- pipeline ----------------
function processCsv(text) {
  const rows = parseCSV(text);
  if (!rows.length) { S.records = []; S.headers = []; S.extraFilters = []; return; }
  S.headers = rows[0];
  const { map, extras } = detectColumns(rows[0]);
  S.colMap = map; S.extraFilters = extras;
  const out = [];
  for (let i = 1; i < rows.length; i++) {
    const c = rows[i];
    if (!c.some(v => String(v).trim() !== '')) continue;
    const rec = {
      idx: i,
      dateRaw: map.date >= 0 ? c[map.date] : '',
      name: (map.name >= 0 ? c[map.name] : '') || '—',
      address: map.address >= 0 ? (c[map.address] || '') : '',
      mobile: String(map.mobile >= 0 ? (c[map.mobile] || '') : '').replace(/\D/g, '').slice(-10),
      qty: 1
    };
    if (map.qty >= 0) {
      const q = parseFloat(c[map.qty]);
      rec.qty = isFinite(q) && q > 0 ? q : 1;
    }
    extras.forEach(x => rec[x.key] = String(c[x.idx] || '').trim());
    rec.date = E.parseDate(rec.dateRaw);
    if (rec.dateRaw && !rec.date) rec.dateInvalid = true;
    let g;
    try { g = E.resolve(rec.address); }
    catch (err) { g = { state: null, district: null, pin: null, confidence: 'UNKNOWN', method: 'Error', reasons: ['Could not parse this address'], needsVerification: true, conflict: false }; }
    Object.assign(rec, {
      cleaned: g.cleaned, pin: g.pin, state: g.state, district: g.district,
      confidence: g.confidence, method: g.method, reasons: g.reasons || [],
      conflict: !!g.conflict, needsVerification: !!g.needsVerification,
      verification: 'Auto'
    });
    if (!rec.mobile && g.mobilesInAddress && g.mobilesInAddress.length) rec.mobile = g.mobilesInAddress[0];
    rec.key = E.recordKey({ date: rec.dateRaw, name: rec.name, mobile: rec.mobile, address: rec.address });
    const ovr = S.overrides[rec.key];
    if (ovr) {
      rec.state = ovr.state || null;
      rec.district = ovr.district || null;
      rec.confidence = 'HIGH'; rec.verification = 'Manual';
      rec.needsVerification = false; rec.conflict = false;
      rec.method = 'Manual correction';
    }
    out.push(rec);
  }
  // duplicates: same mobile+date, or same name+address+date
  const seen = new Map();
  out.forEach(r => {
    const keys = [];
    if (r.mobile && r.dateRaw) keys.push('m|' + r.mobile + '|' + r.dateRaw);
    if (r.name !== '—' && r.address) keys.push('n|' + E.norm(r.name) + '|' + E.norm(r.address) + '|' + r.dateRaw);
    r.dup = false;
    for (const k of keys) {
      if (seen.has(k)) { r.dup = true; r.dupOf = seen.get(k); }
      else seen.set(k, r.idx);
    }
  });
  S.records = out;
}

// ---------------- filters & aggregates ----------------
function dateRange() {
  const now = new Date(); const d0 = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const M = S.filters.dateMode;
  if (M === 'today') return [d0, addD(d0, 1)];
  if (M === 'week') { const dow = (d0.getDay() + 6) % 7; const s = addD(d0, -dow); return [s, addD(s, 7)]; }
  if (M === 'month') return [new Date(d0.getFullYear(), d0.getMonth(), 1), new Date(d0.getFullYear(), d0.getMonth() + 1, 1)];
  if (M === 'lastmonth') return [new Date(d0.getFullYear(), d0.getMonth() - 1, 1), new Date(d0.getFullYear(), d0.getMonth(), 1)];
  if (M === 'year') return [new Date(d0.getFullYear(), 0, 1), new Date(d0.getFullYear() + 1, 0, 1)];
  if (M === 'custom') {
    const f = S.filters.from ? new Date(S.filters.from) : null;
    const t = S.filters.to ? addD(new Date(S.filters.to), 1) : null;
    return [f, t];
  }
  return [null, null];
  function addD(d, n) { const x = new Date(d); x.setDate(x.getDate() + n); return x; }
}

function baseFiltered() {   // date + dynamic facets (everything except search)
  const [from, to] = dateRange();
  return S.records.filter(r => {
    if (from || to) {
      if (!r.date) return false;
      if (from && r.date < from) return false;
      if (to && r.date >= to) return false;
    }
    for (const x of S.extraFilters) {
      const v = S.filters.dyn[x.key];
      if (v && r[x.key] !== v) return false;
    }
    return true;
  });
}
function mappable(r) {
  if (!r.state || r.conflict) return false;
  if (r.confidence === 'UNKNOWN') return false;
  if (!S.includeLow && r.confidence === 'LOW') return false;
  return true;
}

function aggregate(rows) {
  const st = new Map(), di = new Map();
  let tools = 0, customers = 0, unassigned = 0;
  const custSet = new Set();
  rows.forEach(r => {
    tools += r.qty;
    custSet.add(r.mobile ? 'm' + r.mobile : 'k' + r.key);
    if (!mappable(r)) { unassigned += r.qty; return; }
    const s = st.get(r.state) || { tools: 0, customers: new Set(), latest: null };
    s.tools += r.qty; s.customers.add(r.mobile || r.key);
    if (r.date && (!s.latest || r.date > s.latest)) s.latest = r.date;
    st.set(r.state, s);
    if (r.district) {
      const key = r.state + '||' + r.district;
      const d = di.get(key) || { state: r.state, district: r.district, tools: 0, customers: new Set(), latest: null };
      d.tools += r.qty; d.customers.add(r.mobile || r.key);
      if (r.date && (!d.latest || r.date > d.latest)) d.latest = r.date;
      di.set(key, d);
    }
  });
  customers = custSet.size;
  const states = [...st.entries()].map(([name, v]) => ({ name, tools: v.tools, customers: v.customers.size, latest: v.latest }))
    .sort((a, b) => b.tools - a.tools);
  const dists = [...di.values()].map(v => ({ state: v.state, name: v.district, tools: v.tools, customers: v.customers.size, latest: v.latest }))
    .sort((a, b) => b.tools - a.tools);
  const mappedTotal = states.reduce((a, s) => a + s.tools, 0);
  return { states, dists, tools, customers, unassigned, mappedTotal,
           stateMap: new Map(states.map(s => [s.name, s])),
           distMap: new Map(dists.map(d => [d.state + '||' + d.name, d])) };
}

function quality(rows) {
  const q = { total: rows.length, HIGH: 0, MEDIUM: 0, LOW: 0, UNKNOWN: 0,
              conflict: 0, verify: 0, dup: 0, manual: 0, auto: 0, noDistrict: 0 };
  rows.forEach(r => {
    q[r.confidence] = (q[r.confidence] || 0) + 1;
    if (r.conflict) q.conflict++;
    if (r.needsVerification) q.verify++;
    if (r.dup) q.dup++;
    if (r.verification === 'Manual') q.manual++; else if (r.state) q.auto++;
    if (r.state && !r.district) q.noDistrict++;
  });
  return q;
}

// ---------------- geographic SVG ----------------
const THRESH = [
  { min: 0, max: 0, label: '0' },
  { min: 1, max: 10, label: '1–10' },
  { min: 11, max: 50, label: '11–50' },
  { min: 51, max: 100, label: '51–100' },
  { min: 101, max: 250, label: '101–250' },
  { min: 251, max: 500, label: '251–500' },
  { min: 501, max: Infinity, label: '500+' }
];
const HEAT = ['var(--heat0)', 'var(--heat1)', 'var(--heat2)', 'var(--heat3)', 'var(--heat4)', 'var(--heat5)', 'var(--heat6)'];
const bucket = (n) => { for (let i = THRESH.length - 1; i >= 0; i--) if (n >= THRESH[i].min) return i; return 0; };

const pathCache = new Map();
function featurePaths(features, W, H, pad) {
  const key = features === GEO.states.features ? '__india' : features[0].properties.st + '|' + features.length;
  const ck = key + '|' + W + 'x' + H;
  if (pathCache.has(ck)) return pathCache.get(ck);
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  const midLat = (() => {
    let lo = 90, hi = -90;
    features.forEach(f => eachRing(f, ring => ring.forEach(([, la]) => { if (la < lo) lo = la; if (la > hi) hi = la; })));
    return (lo + hi) / 2;
  })();
  const kx = Math.cos(midLat * Math.PI / 180);
  features.forEach(f => eachRing(f, ring => ring.forEach(([lo, la]) => {
    const x = lo * kx, y = -la;
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (y < minY) minY = y; if (y > maxY) maxY = y;
  })));
  const sc = Math.min((W - pad * 2) / (maxX - minX), (H - pad * 2) / (maxY - minY));
  const ox = (W - (maxX - minX) * sc) / 2, oy = (H - (maxY - minY) * sc) / 2;
  const proj = ([lo, la]) => [((lo * kx - minX) * sc + ox), ((-la - minY) * sc + oy)];
  const out = features.map(f => {
    let d = '';
    eachRing(f, ring => {
      ring.forEach((pt, i) => {
        const [x, y] = proj(pt);
        d += (i ? 'L' : 'M') + x.toFixed(1) + ' ' + y.toFixed(1);
      });
      d += 'Z';
    });
    return { f, d };
  });
  pathCache.set(ck, out);
  return out;
  function eachRing(f, cb) {
    const g = f.geometry; if (!g) return;
    if (g.type === 'Polygon') g.coordinates.forEach(cb);
    else if (g.type === 'MultiPolygon') g.coordinates.forEach(p => p.forEach(cb));
  }
}

const tooltip = $('#tooltip');
function showTip(html, ev) {
  tooltip.innerHTML = html; tooltip.style.display = 'block';
  moveTip(ev);
}
function moveTip(ev) {
  const pad = 14; let x = ev.clientX + pad, y = ev.clientY + pad;
  const r = tooltip.getBoundingClientRect();
  if (x + r.width > innerWidth - 8) x = ev.clientX - r.width - pad;
  if (y + r.height > innerHeight - 8) y = ev.clientY - r.height - pad;
  tooltip.style.left = x + 'px'; tooltip.style.top = y + 'px';
}
const hideTip = () => tooltip.style.display = 'none';

function fmtDate(d) {
  return d ? d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }) : '—';
}

function renderMap(agg) {
  const box = $('#mapbox'); box.innerHTML = ''; hideTip();
  const mobile = innerWidth < 700;
  const W = 760, H = S.view.state ? 560 : 620, pad = 10;
  const inState = !!S.view.state;
  const features = inState
    ? GEO.districts.features.filter(f => f.properties.st === S.view.state)
    : GEO.states.features;
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  svg.setAttribute('role', 'img');
  const paths = featurePaths(features, W, H, pad);
  paths.forEach(({ f, d }) => {
    const name = inState ? f.properties.dt : f.properties.st;
    const p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    p.setAttribute('d', d);
    p.setAttribute('class', 'shape' + (S.view.district === name ? ' sel' : ''));
    let count = 0, entry = null;
    if (inState) { entry = agg.distMap.get(S.view.state + '||' + name); count = entry ? entry.tools : 0; }
    else { entry = agg.stateMap.get(name); count = entry ? entry.tools : 0; }
    p.setAttribute('fill', HEAT[bucket(count)]);
    p.addEventListener('mousemove', (ev) => {
      const cust = entry ? entry.customers : 0;
      let html = `<div class="tt-name">${esc(name)}</div>
        <div class="row"><span>Tools sold</span><b class="num">${fmt(count)}</b></div>
        <div class="row"><span>Customers</span><b class="num">${fmt(cust)}</b></div>`;
      if (inState) {
        const pct = agg.stateMap.get(S.view.state) && agg.stateMap.get(S.view.state).tools
          ? (count / agg.stateMap.get(S.view.state).tools * 100).toFixed(1) : '0.0';
        html += `<div class="row"><span>Share of ${esc(S.view.state)}</span><b class="num">${pct}%</b></div>
                 <div class="row"><span>Latest sale</span><b class="num">${entry ? fmtDate(entry.latest) : '—'}</b></div>`;
      } else {
        const pct = agg.mappedTotal ? (count / agg.mappedTotal * 100).toFixed(1) : '0.0';
        html += `<div class="row"><span>Share of India</span><b class="num">${pct}%</b></div>`;
      }
      showTip(html, ev);
    });
    p.addEventListener('mouseleave', hideTip);
    p.addEventListener('click', () => {
      hideTip();
      if (inState) selectDistrict(name);
      else drillState(name);
    });
    svg.appendChild(p);
    if (mobile) p.addEventListener('touchstart', () => {}, { passive: true });
  });
  box.appendChild(svg);
  box.classList.remove('fade'); void box.offsetWidth; box.classList.add('fade');

  // legend
  const lg = $('#legend'); lg.innerHTML = '';
  THRESH.forEach((t, i) => {
    const c = el('div', 'cell');
    const sw = el('div', 'sw'); sw.style.background = HEAT[i];
    c.appendChild(sw); c.appendChild(el('span', '', t.label));
    lg.appendChild(c);
  });
  lg.appendChild(el('span', 'cap', 'tools sold — fixed scale on every view'));

  const note = $('#mapNote');
  if (inState) {
    const stEntry = agg.stateMap.get(S.view.state);
    const distTotal = agg.dists.filter(d => d.state === S.view.state).reduce((a, d) => a + d.tools, 0);
    const pending = (stEntry ? stEntry.tools : 0) - distTotal;
    note.textContent = pending > 0
      ? pending + ' sale' + (pending === 1 ? '' : 's') + ' in ' + S.view.state + ' still need district identification — see Data quality.'
      : '';
  } else {
    note.textContent = agg.unassigned > 0
      ? fmt(agg.unassigned) + ' sale' + (agg.unassigned === 1 ? '' : 's') + ' could not be placed on the map (unknown / conflicting / excluded) — see Data quality.'
      : '';
  }
}

// ---------------- overview rendering ----------------
function renderCrumbs() {
  const c = $('#crumbs'); c.innerHTML = '';
  const mk = (label, cb, here) => {
    if (here) return el('span', 'here', esc(label));
    const b = el('button', '', esc(label)); b.addEventListener('click', cb); return b;
  };
  c.appendChild(mk('India sales map', () => { S.view.state = null; S.view.district = null; render(); }, !S.view.state));
  if (S.view.state) {
    c.appendChild(el('span', 'sep', '›'));
    c.appendChild(mk(S.view.state, () => { S.view.district = null; render(); }, !S.view.district));
  }
  if (S.view.district) {
    c.appendChild(el('span', 'sep', '›'));
    c.appendChild(el('span', 'here', esc(S.view.district)));
  }
  $('#backBtn').style.display = S.view.state ? '' : 'none';
  $('#backBtn').textContent = S.view.district ? '← Back to ' + S.view.state : '← Back to India';
}

function renderMapSub(agg) {
  const sub = $('#mapSub');
  if (!S.view.state) {
    sub.innerHTML = `<span><b class="num">${fmt(agg.mappedTotal)}</b> tools on the map</span>
      <span><b class="num">${agg.states.length}</b> states / UTs</span>
      <span><b class="num">${agg.dists.length}</b> districts</span>`;
  } else {
    const s = agg.stateMap.get(S.view.state) || { tools: 0, customers: 0 };
    const nd = agg.dists.filter(d => d.state === S.view.state).length;
    sub.innerHTML = `<span><b class="num">${fmt(s.tools)}</b> tools sold in ${esc(S.view.state)}</span>
      <span><b class="num">${fmt(s.customers || 0)}</b> customers</span>
      <span><b class="num">${nd}</b> districts reached</span>`;
  }
}

function renderKpis(agg, rows) {
  const k = $('#kpis'); k.innerHTML = '';
  const scope = S.view.state ? agg.dists.filter(d => d.state === S.view.state) : null;
  const topState = agg.states[0], topDist = agg.dists[0];
  const cells = [
    { v: fmt(agg.tools), l: 'Tools sold' },
    { v: fmt(agg.customers), l: 'Customers' },
    { v: fmt(agg.states.length), l: 'States reached' },
    { v: fmt(agg.dists.length), l: 'Districts reached' },
    { v: topState ? topState.name : '—', l: topState ? 'Top state · ' + fmt(topState.tools) : 'Top state' },
    { v: topDist ? topDist.name : '—', l: topDist ? 'Top district · ' + fmt(topDist.tools) : 'Top district' }
  ];
  cells.forEach(c => {
    const d = el('div', 'kpi');
    d.appendChild(el('div', 'v num', esc(c.v)));
    d.appendChild(el('div', 'l', esc(c.l)));
    k.appendChild(d);
  });
}

function renderRank(agg) {
  const inState = !!S.view.state;
  $('#rankTitle').textContent = inState ? 'Sales by district — ' + S.view.state : 'Sales by state';
  const t = $('#rankTable'); t.innerHTML = '';
  const rowsData = inState ? agg.dists.filter(d => d.state === S.view.state) : agg.states;
  const total = inState
    ? (agg.stateMap.get(S.view.state) ? agg.stateMap.get(S.view.state).tools : 0)
    : agg.mappedTotal;
  t.appendChild(el('thead', '', `<tr><th>#</th><th>${inState ? 'District' : 'State'}</th>
    <th class="r">Tools</th><th class="r">Share</th><th class="r">Customers</th></tr>`));
  const tb = el('tbody');
  if (!rowsData.length) tb.appendChild(el('tr', '', '<td colspan="5" style="color:var(--faint)">No sales in this view yet — widen the date filter or sync new rows.</td>'));
  rowsData.forEach((r, i) => {
    const pct = total ? (r.tools / total * 100) : 0;
    const tr = el('tr', 'rowlink', `<td class="num">${i + 1}</td><td>${esc(r.name)}</td>
      <td class="r num">${fmt(r.tools)}</td>
      <td class="r num">${pct.toFixed(1)}%<span class="pctbar"><i style="width:${Math.min(100, pct)}%"></i></span></td>
      <td class="r num">${fmt(r.customers)}</td>`);
    tr.addEventListener('click', () => inState ? selectDistrict(r.name) : drillState(r.name));
    tb.appendChild(tr);
  });
  t.appendChild(tb);

  // top areas panel: top districts (India view) or top localities note (state view)
  $('#topTitle').textContent = inState ? 'Top districts across India' : 'Top districts';
  const tt = $('#topTable'); tt.innerHTML = '';
  tt.appendChild(el('thead', '', '<tr><th>#</th><th>District</th><th>State</th><th class="r">Tools</th></tr>'));
  const tb2 = el('tbody');
  agg.dists.slice(0, 10).forEach((d, i) => {
    const tr = el('tr', 'rowlink', `<td class="num">${i + 1}</td><td>${esc(d.name)}</td>
      <td style="color:var(--muted)">${esc(d.state)}</td><td class="r num">${fmt(d.tools)}</td>`);
    tr.addEventListener('click', () => { drillState(d.state); selectDistrict(d.name); });
    tb2.appendChild(tr);
  });
  if (!agg.dists.length) tb2.appendChild(el('tr', '', '<td colspan="4" style="color:var(--faint)">No district-level data yet.</td>'));
  tt.appendChild(tb2);
}

function renderDistDetail(agg) {
  const d = $('#distDetail');
  if (!S.view.state || !S.view.district) { d.style.display = 'none'; return; }
  const e = agg.distMap.get(S.view.state + '||' + S.view.district);
  const st = agg.stateMap.get(S.view.state);
  const pct = e && st && st.tools ? (e.tools / st.tools * 100).toFixed(1) : '0.0';
  d.style.display = '';
  d.innerHTML = `<button class="closex" title="Close">×</button>
    <h3>${esc(S.view.district)} <span style="color:var(--muted);font-weight:400;font-size:.85rem">· ${esc(S.view.state)}</span></h3>
    <div class="facts">
      <div><b class="num">${fmt(e ? e.tools : 0)}</b><span>Tools sold</span></div>
      <div><b class="num">${fmt(e ? e.customers : 0)}</b><span>Customers</span></div>
      <div><b class="num">${pct}%</b><span>Share of ${esc(S.view.state)}</span></div>
      <div><b class="num">${e ? fmtDate(e.latest) : '—'}</b><span>Latest sale</span></div>
    </div>
    <div style="margin-top:12px" id="distCustWrap">
      <div class="panel-h" style="padding:8px 0"><h3 style="font-size:.9rem">Customers in ${esc(S.view.district)}</h3></div>
      <div class="scrollbox"><table class="data" id="distCustTable"></table></div>
    </div>`;
  d.querySelector('.closex').addEventListener('click', () => { S.view.district = null; render(); });
  const rows = baseFiltered().filter(r => mappable(r) && r.state === S.view.state && r.district === S.view.district)
    .sort((a, b) => (b.date || 0) - (a.date || 0)).slice(0, 50);
  const t = d.querySelector('#distCustTable');
  t.appendChild(el('thead', '', '<tr><th>Date</th><th>Customer</th><th>Address</th><th>Mobile</th></tr>'));
  const tb = el('tbody');
  rows.forEach(r => tb.appendChild(el('tr', '', `<td class="num">${esc(r.dateRaw || '—')}</td>
    <td>${esc(r.name)}</td><td class="addr">${esc(r.address || '—')}</td>
    <td class="num">${maskMobile(r.mobile)}</td>`)));
  if (!rows.length) tb.appendChild(el('tr', '', '<td colspan="4" style="color:var(--faint)">No customers in this district for the selected period.</td>'));
  t.appendChild(tb);
}

function drillState(name) {
  if (!GEO.districts.features.some(f => f.properties.st === name)) return;
  S.view.state = name; S.view.district = null; render();
}
function selectDistrict(name) { S.view.district = name; render(); }

// ---------------- customers tab ----------------
function maskMobile(m) {
  if (!m) return '—';
  if (S.showMobiles) return m;
  return m.slice(0, 2) + '•••••' + m.slice(-3);
}
function custRows() {
  let rows = baseFiltered();
  if (S.view.state) rows = rows.filter(r => r.state === S.view.state);
  if (S.view.district) rows = rows.filter(r => r.district === S.view.district);
  const q = E.norm(S.filters.search);
  if (q) rows = rows.filter(r =>
    E.norm(r.name).includes(q) || (r.mobile && r.mobile.includes(S.filters.search.replace(/\D/g, '') || '\u0000')) ||
    E.norm(r.address).includes(q) || E.norm(r.state || '').includes(q) || E.norm(r.district || '').includes(q));
  const { key, dir } = S.custSort;
  rows = rows.slice().sort((a, b) => {
    let va, vb;
    if (key === 'date') { va = a.date ? a.date.getTime() : 0; vb = b.date ? b.date.getTime() : 0; }
    else { va = E.norm(a[key] || ''); vb = E.norm(b[key] || ''); }
    return (va < vb ? -1 : va > vb ? 1 : 0) * dir;
  });
  return rows;
}
const PAGE = 25;
function renderCustomers() {
  const rows = custRows();
  const t = $('#custTable'); t.innerHTML = '';
  const heads = [['date', 'Date'], ['name', 'Customer'], ['state', 'State'], ['district', 'District'], ['', 'Address'], ['', 'Mobile'], ['', 'Status']];
  const thr = el('tr');
  heads.forEach(([k, label]) => {
    const th = el('th', k ? 'sortable' : '', esc(label) + (k === S.custSort.key ? (S.custSort.dir > 0 ? ' ↑' : ' ↓') : ''));
    if (k) th.addEventListener('click', () => {
      if (S.custSort.key === k) S.custSort.dir *= -1; else S.custSort = { key: k, dir: 1 };
      renderCustomers();
    });
    thr.appendChild(th);
  });
  const thead = el('thead'); thead.appendChild(thr); t.appendChild(thead);
  const pages = Math.max(1, Math.ceil(rows.length / PAGE));
  if (S.custPage >= pages) S.custPage = pages - 1;
  const tb = el('tbody');
  rows.slice(S.custPage * PAGE, S.custPage * PAGE + PAGE).forEach(r => {
    const badges = [`<span class="badge ${r.confidence}">${r.confidence.toLowerCase()}</span>`];
    if (r.verification === 'Manual') badges.push('<span class="badge man">manual</span>');
    if (r.conflict) badges.push('<span class="badge conf">conflict</span>');
    if (r.dup) badges.push('<span class="badge dup">duplicate?</span>');
    tb.appendChild(el('tr', '', `<td class="num" style="white-space:nowrap">${esc(r.dateRaw || '—')}</td>
      <td>${esc(r.name)}</td>
      <td>${esc(r.state || 'Unknown')}</td>
      <td>${esc(r.district || (r.state ? 'Unknown' : '—'))}</td>
      <td class="addr">${esc(r.address || '—')}</td>
      <td class="num">${maskMobile(r.mobile)}</td>
      <td>${badges.join(' ')}</td>`));
  });
  if (!rows.length) tb.appendChild(el('tr', '', '<td colspan="7" style="color:var(--faint)">No records match this view. Adjust the search or filters.</td>'));
  t.appendChild(tb);
  $('#custCount').textContent = fmt(rows.length) + ' record' + (rows.length === 1 ? '' : 's') +
    (S.view.state ? ' · ' + (S.view.district || S.view.state) : '');
  const pg = $('#custPager'); pg.innerHTML = '';
  if (pages > 1) {
    const prev = el('button', 'btn small', '‹ Prev'); prev.disabled = S.custPage === 0;
    const next = el('button', 'btn small', 'Next ›'); next.disabled = S.custPage >= pages - 1;
    prev.addEventListener('click', () => { S.custPage--; renderCustomers(); });
    next.addEventListener('click', () => { S.custPage++; renderCustomers(); });
    pg.appendChild(prev);
    pg.appendChild(el('span', 'num', 'Page ' + (S.custPage + 1) + ' of ' + pages));
    pg.appendChild(next);
  }
}

// ---------------- data quality tab ----------------
function renderQuality() {
  const rows = baseFiltered();
  const q = quality(rows);
  const tiles = [
    { v: q.total, l: 'Total records' },
    { v: q.auto + q.manual, l: 'Classified', cls: 'ok' },
    { v: q.HIGH, l: 'High confidence' },
    { v: q.MEDIUM, l: 'Medium confidence' },
    { v: q.LOW, l: 'Low confidence', cls: q.LOW ? 'warn' : '' },
    { v: q.UNKNOWN, l: 'Unknown', cls: q.UNKNOWN ? 'bad' : '' },
    { v: q.conflict, l: 'Conflicting', cls: q.conflict ? 'bad' : '' },
    { v: q.verify, l: 'Needs verification', cls: q.verify ? 'warn' : '' },
    { v: q.dup, l: 'Possible duplicates', cls: q.dup ? 'warn' : '' },
    { v: q.manual, l: 'Manually corrected' }
  ];
  const g = $('#qTiles'); g.innerHTML = '';
  tiles.forEach(t => {
    const d = el('div', 'q-tile' + (t.cls ? ' ' + t.cls : ''));
    d.appendChild(el('div', 'v num', fmt(t.v)));
    d.appendChild(el('div', 'l', esc(t.l)));
    g.appendChild(d);
  });
  $('#qBadge').textContent = fmt(q.verify);

  // needs verification table
  const need = rows.filter(r => r.needsVerification).sort((a, b) => (b.date || 0) - (a.date || 0));
  const t = $('#verifyTable'); t.innerHTML = '';
  t.appendChild(el('thead', '', `<tr><th>Customer</th><th>Original address</th><th>Detected</th>
    <th>PIN</th><th>Confidence</th><th>Reason</th><th>Correct to</th><th></th></tr>`));
  const tb = el('tbody');
  const pages = Math.max(1, Math.ceil(need.length / PAGE));
  if (S.verifyPage >= pages) S.verifyPage = pages - 1;
  need.slice(S.verifyPage * PAGE, S.verifyPage * PAGE + PAGE).forEach(r => {
    const tr = el('tr', 'fixrow');
    tr.innerHTML = `<td>${esc(r.name)}<div class="addr num">${esc(r.dateRaw || '')}</div></td>
      <td class="addr">${esc(r.address || '—')}</td>
      <td>${esc(r.state || 'Unknown')}<div class="addr">${esc(r.district || 'Unknown')}</div></td>
      <td class="num">${esc(r.pin || '—')}</td>
      <td><span class="badge ${r.confidence}">${r.confidence.toLowerCase()}</span>${r.conflict ? ' <span class="badge conf">conflict</span>' : ''}</td>
      <td class="addr">${esc((r.reasons && r.reasons[0]) || '—')}</td>`;
    const td = el('td');
    const sSel = document.createElement('select');
    sSel.appendChild(new Option('State…', ''));
    STATES.forEach(st => sSel.appendChild(new Option(st, st)));
    const dSel = document.createElement('select');
    dSel.appendChild(new Option('District…', ''));
    const fillD = (st) => {
      dSel.innerHTML = ''; dSel.appendChild(new Option('District…', ''));
      if (st) DISTS[STATES.indexOf(st)].forEach(d => dSel.appendChild(new Option(d, d)));
    };
    if (r.state) { sSel.value = r.state; fillD(r.state); if (r.district) dSel.value = r.district; }
    sSel.addEventListener('change', () => fillD(sSel.value));
    td.appendChild(sSel); td.appendChild(document.createTextNode(' ')); td.appendChild(dSel);
    tr.appendChild(td);
    const act = el('td');
    const save = el('button', 'btn small primary', 'Save');
    save.addEventListener('click', () => {
      if (!sSel.value) { flash('Pick a state before saving.'); return; }
      S.overrides[r.key] = { state: sSel.value, district: dSel.value || null, ts: Date.now() };
      store.set('edio_overrides', S.overrides);
      reapplyOverrides(); render();
      flash('Saved — ' + esc(r.name) + ' → ' + sSel.value + (dSel.value ? ' / ' + dSel.value : ''), false);
    });
    act.appendChild(save);
    if (S.overrides[r.key]) {
      const undo = el('button', 'btn small', 'Undo');
      undo.style.marginLeft = '6px';
      undo.addEventListener('click', () => {
        delete S.overrides[r.key]; store.set('edio_overrides', S.overrides);
        reprocess(); render();
      });
      act.appendChild(undo);
    }
    tr.appendChild(act);
    tb.appendChild(tr);
  });
  if (!need.length) tb.appendChild(el('tr', '', '<td colspan="8" style="color:var(--ok)">Everything in this period is classified with acceptable confidence. Nothing to verify.</td>'));
  t.appendChild(tb);
  const pg = $('#verifyPager'); pg.innerHTML = '';
  if (pages > 1) {
    const prev = el('button', 'btn small', '‹ Prev'); prev.disabled = S.verifyPage === 0;
    const next = el('button', 'btn small', 'Next ›'); next.disabled = S.verifyPage >= pages - 1;
    prev.addEventListener('click', () => { S.verifyPage--; renderQuality(); });
    next.addEventListener('click', () => { S.verifyPage++; renderQuality(); });
    pg.appendChild(prev); pg.appendChild(el('span', 'num', 'Page ' + (S.verifyPage + 1) + ' of ' + pages)); pg.appendChild(next);
  }

  // duplicates
  const dups = rows.filter(r => r.dup);
  const dt = $('#dupTable'); dt.innerHTML = '';
  dt.appendChild(el('thead', '', '<tr><th>Date</th><th>Customer</th><th>Mobile</th><th>Address</th><th>Detected</th></tr>'));
  const dtb = el('tbody');
  dups.slice(0, 100).forEach(r => dtb.appendChild(el('tr', '', `<td class="num">${esc(r.dateRaw || '—')}</td>
    <td>${esc(r.name)}</td><td class="num">${maskMobile(r.mobile)}</td>
    <td class="addr">${esc(r.address || '—')}</td>
    <td>${esc(r.state || 'Unknown')}${r.district ? ' / ' + esc(r.district) : ''}</td>`)));
  if (!dups.length) dtb.appendChild(el('tr', '', '<td colspan="5" style="color:var(--ok)">No duplicate candidates in this period.</td>'));
  dt.appendChild(dtb);

  $('#ovrCount').textContent = Object.keys(S.overrides).length + ' correction(s) stored on this device';
  $('#includeLow').checked = S.includeLow;
  $('#sheetUrl').value = S.source.url || '';
  $('#pollSel').value = String(S.pollSec);
}

function reapplyOverrides() { reprocess(); }
function reprocess() { processCsv(S.rawCsv); }

// ---------------- export ----------------
function exportCsv(rows, name) {
  const head = ['Date', 'Customer Name', 'State', 'District', 'PIN', 'Address', 'Mobile Number',
                'Confidence', 'Detection Method', 'Verification', 'Possible Duplicate'];
  S.extraFilters.forEach(x => head.push(x.label));
  const data = [head];
  rows.forEach(r => {
    const row = [r.dateRaw, r.name, r.state || 'Unknown', r.district || 'Unknown', r.pin || '',
                 r.address, r.mobile || '', r.confidence, r.method, r.verification, r.dup ? 'Yes' : ''];
    S.extraFilters.forEach(x => row.push(r[x.key] || ''));
    data.push(row);
  });
  const blob = new Blob(['\ufeff' + toCSV(data)], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}
function exportScope() {
  let rows = custRows();
  const bits = ['edio-sales'];
  if (S.view.state) bits.push(E.norm(S.view.state).replace(/ /g, '-'));
  if (S.view.district) bits.push(E.norm(S.view.district).replace(/ /g, '-'));
  if (S.filters.dateMode !== 'all') bits.push(S.filters.dateMode);
  exportCsv(rows, bits.join('-') + '.csv');
}

// ---------------- Google Sheets sync ----------------
function csvUrlFrom(input) {
  const u = String(input || '').trim();
  if (!u) return null;
  if (/output=csv/.test(u) || /\.csv(\?|$)/.test(u)) return u;
  let m = u.match(/\/spreadsheets\/d\/e\/([^/]+)\/pub/);
  if (m) return 'https://docs.google.com/spreadsheets/d/e/' + m[1] + '/pub?output=csv';
  m = u.match(/\/spreadsheets\/(?:u\/\d+\/)?d\/([a-zA-Z0-9-_]+)/);
  if (m) {
    let url = 'https://docs.google.com/spreadsheets/d/' + m[1] + '/gviz/tq?tqx=out:csv';
    const g = u.match(/[#?&]gid=(\d+)/);
    if (g) url += '&gid=' + g[1];
    return url;
  }
  return u;
}
function candidateUrls(input) {
  const list = [];
  const add = (u) => { if (u && !list.includes(u)) list.push(u); };
  add(csvUrlFrom(input));
  const pub = String(input).match(/\/spreadsheets\/d\/e\/([^/?#]+)/);
  if (pub) {
    add('https://docs.google.com/spreadsheets/d/e/' + pub[1] + '/pub?output=csv');
    const g = String(input).match(/[#?&]gid=(\d+)/);
    add('https://docs.google.com/spreadsheets/d/e/' + pub[1] + '/pub?' + (g ? 'gid=' + g[1] + '&single=true&' : '') + 'output=csv');
  }
  const doc = String(input).match(/\/spreadsheets\/(?:u\/\d+\/)?d\/(?!e\/)([a-zA-Z0-9-_]+)/);
  if (doc) {
    const g = String(input).match(/[#?&]gid=(\d+)/);
    add('https://docs.google.com/spreadsheets/d/' + doc[1] + '/export?format=csv' + (g ? '&gid=' + g[1] : ''));
    add('https://docs.google.com/spreadsheets/d/' + doc[1] + '/gviz/tq?tqx=out:csv' + (g ? '&gid=' + g[1] : ''));
  }
  return list;
}
async function syncNow(manual) {
  if (S.source.mode === 'file') {
    if (manual) $('#csvFile').click();
    return;
  }
  if (S.source.mode !== 'sheet' || !S.source.url) {
    if (manual) flash('No sheet connected yet — paste your Google Sheet link under Data quality → Data source.', false);
    return;
  }
  if (S.syncing) return;
  S.syncing = true; $('#syncBtn').disabled = true; $('#syncBtn').textContent = 'Syncing…';
  let lastErr = null, text = null;
  const tried = candidateUrls(S.source.url);
  for (const base of tried) {
    try {
      const url = base + (base.includes('?') ? '&' : '?') + '_ts=' + Date.now();
      const res = await fetch(url, { cache: 'no-store', redirect: 'follow' });
      if (!res.ok) throw new Error('HTTP ' + res.status + (res.status === 401 || res.status === 403 ? ' — the sheet is not shared publicly' : res.status === 404 ? ' — link not found (was it unpublished?)' : ''));
      const t = await res.text();
      if (/<html|<!doctype/i.test(t.slice(0, 300))) throw new Error('got a sign-in page instead of CSV — sharing is off');
      if (!t.trim()) throw new Error('the sheet returned no rows');
      text = t; break;
    } catch (err) { lastErr = err; }
  }
  if (text != null) {
    S.rawCsv = text;
    store.set('edio_csv', text);
    S.lastSync = Date.now(); store.set('edio_lastSync', S.lastSync);
    processCsv(text);
    render();
    setPill('live', 'Google Sheet');
    setConnStatus('✓ Connected — ' + fmt(S.records.length) + ' rows synced at ' + new Date().toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' }) + '. The maps and KPIs above are now built from your sheet.', 'ok');
    flash('Synced ' + fmt(S.records.length) + ' rows from the sheet.', false);
  } else {
    setPill('err', 'Sheet unreachable');
    const netHint = lastErr && /failed to fetch|load failed|networkerror|typeerror/i.test(String(lastErr)) ?
      ' Your browser blocked the request — this happens on some browsers when the dashboard is opened as a local file, or if you are offline. Easiest fix: in Google Sheets do File → Download → CSV, then use “Upload a CSV file…” below.' : '';
    const emsg = esc(lastErr ? lastErr.message : 'unknown error');
    setConnStatus('✗ Could not read the sheet — ' + emsg + '.' + (netHint ? ' Use “Upload a CSV file…” below instead (File → Download → CSV in Google Sheets).' : ' Check that sharing / publishing is on.'), 'err');
    flash('Could not read the Google Sheet (' + emsg + ').' + netHint + ' Keeping the currently loaded data.', true);
  }
  S.syncing = false; $('#syncBtn').disabled = false; $('#syncBtn').textContent = '↻ Sync data';
  renderSyncStamp();
}
function schedulePoll() {
  if (S.pollTimer) clearInterval(S.pollTimer);
  S.pollTimer = null;
  if (S.pollSec > 0 && S.source.mode === 'sheet') {
    S.pollTimer = setInterval(() => syncNow(false), S.pollSec * 1000);
  }
}
function renderSyncStamp() {
  const n = $('#lastSync');
  if (S.source.mode === 'demo') { n.textContent = ''; return; }
  if (S.source.mode === 'file') {
    n.textContent = S.lastSync ? 'File loaded ' + new Date(S.lastSync).toLocaleString('en-IN', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) : '';
    return;
  }
  n.textContent = S.lastSync
    ? 'Last synced ' + new Date(S.lastSync).toLocaleString('en-IN', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })
    : 'Not synced yet';
}
function setPill(cls, text) {
  const p = $('#srcPill');
  p.className = 'src-pill' + (cls ? ' ' + cls : '');
  $('#srcText').textContent = text;
}
function setConnStatus(msg, cls) {
  const n = $('#connStatus');
  if (!n) return;
  n.className = 'conn-status' + (cls ? ' ' + cls : '');
  n.innerHTML = msg || '';
}
function flash(msg, isError) {
  const b = $('#banner');
  b.className = 'on' + (isError ? ' error' : '');
  $('#bannerMsg').innerHTML = msg;
  clearTimeout(flash.t);
  if (!isError) flash.t = setTimeout(() => b.className = '', 6000);
}

// ---------------- dynamic facet filters ----------------
function renderDynFilters() {
  const holder = $('#dynFilters'); holder.innerHTML = '';
  S.extraFilters.forEach(x => renderSel(x));
  function renderSel(x) {
    if (holder.querySelector('[data-key="' + x.key + '"]')) return;
    const vals = [...new Set(S.records.map(r => r[x.key]).filter(Boolean))].sort();
    if (vals.length < 2) return;
    const sel = document.createElement('select');
    sel.dataset.key = x.key;
    sel.appendChild(new Option('All — ' + x.label, ''));
    vals.forEach(v => sel.appendChild(new Option(v, v)));
    sel.value = S.filters.dyn[x.key] || '';
    sel.addEventListener('change', () => { S.filters.dyn[x.key] = sel.value; S.custPage = 0; render(); });
    holder.appendChild(sel);
  }
}

// ---------------- render root ----------------
function render() {
  const rows = baseFiltered();
  const agg = aggregate(rows);
  renderKpis(agg, rows);
  renderCrumbs();
  renderMapSub(agg);
  renderMap(agg);
  renderRank(agg);
  renderDistDetail(agg);
  renderCustomers();
  renderQuality();
  renderDynFilters();
  renderSyncStamp();
}

// ---------------- events ----------------
$('#dateChips').addEventListener('click', (e) => {
  const b = e.target.closest('button'); if (!b) return;
  [...$('#dateChips').children].forEach(x => x.classList.toggle('on', x === b));
  S.filters.dateMode = b.dataset.d;
  $('#customRange').classList.toggle('on', b.dataset.d === 'custom');
  S.custPage = 0; render();
});
$('#fromDate').addEventListener('change', e => { S.filters.from = e.target.value; render(); });
$('#toDate').addEventListener('change', e => { S.filters.to = e.target.value; render(); });
$('#tabs').addEventListener('click', (e) => {
  const b = e.target.closest('button'); if (!b) return;
  S.view.tab = b.dataset.tab;
  [...$('#tabs').children].forEach(x => x.classList.toggle('on', x === b));
  document.querySelectorAll('.tab-view').forEach(v => v.classList.toggle('on', v.id === 'view-' + b.dataset.tab));
});
$('#backBtn').addEventListener('click', () => {
  if (S.view.district) S.view.district = null; else S.view.state = null;
  render();
});
$('#custSearch').addEventListener('input', (e) => { S.filters.search = e.target.value; S.custPage = 0; renderCustomers(); });
$('#showMobiles').addEventListener('change', (e) => { S.showMobiles = e.target.checked; renderCustomers(); renderQuality(); renderDistDetail(aggregate(baseFiltered())); });
$('#exportBtn').addEventListener('click', exportScope);
$('#exportVerifyBtn').addEventListener('click', () => {
  exportCsv(baseFiltered().filter(r => r.needsVerification), 'edio-needs-verification.csv');
});
$('#syncBtn').addEventListener('click', () => {
  if (S.source.mode === 'demo') { flash('Demo data is loaded. Connect your Google Sheet (or upload a CSV) under Data quality → Data source & settings.', false); return; }
  syncNow(true);
});
function connectSheet() {
  const url = $('#sheetUrl').value.trim();
  if (!url) { flash('Paste the Google Sheet link first.', true); return; }
  if (!/docs\.google\.com\/spreadsheets|\.csv|output=csv/i.test(url)) {
    flash('That does not look like a Google Sheet link. It should start with https://docs.google.com/spreadsheets/…', true); return;
  }
  S.source = { mode: 'sheet', url };
  store.set('edio_source', S.source);
  setPill('', 'Connecting…');
  setConnStatus('Connecting to the sheet…', 'busy');
  syncNow(true);
  schedulePoll();
}
$('#connectBtn').addEventListener('click', connectSheet);
$('#sheetUrl').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); connectSheet(); } });
$('#csvFile').addEventListener('change', (e) => {
  const f = e.target.files && e.target.files[0];
  if (!f) return;
  const rd = new FileReader();
  rd.onload = () => {
    const text = String(rd.result || '');
    if (!text.trim()) { flash('That file is empty.', true); return; }
    S.source = { mode: 'file', url: S.source.url || '', fileName: f.name };
    store.set('edio_source', S.source);
    S.rawCsv = text;
    store.set('edio_csv', text);
    S.lastSync = Date.now(); store.set('edio_lastSync', S.lastSync);
    processCsv(text); render();
    setPill('live', 'CSV file: ' + f.name);
    setConnStatus('✓ Loaded ' + fmt(S.records.length) + ' rows from ' + esc(f.name) + '.', 'ok');
    schedulePoll();
    flash('Loaded ' + fmt(S.records.length) + ' rows from ' + esc(f.name) + '. Use ↻ Sync data to pick a newer file any time.', false);
  };
  rd.onerror = () => flash('Could not read that file.', true);
  rd.readAsText(f);
  e.target.value = '';
});
$('#demoBtn').addEventListener('click', () => {
  S.source = { mode: 'demo', url: S.source.url };
  store.set('edio_source', S.source);
  S.rawCsv = window.EDIO_DEMO_CSV;
  processCsv(S.rawCsv);
  setPill('', 'Demo data');
  schedulePoll(); render();
  flash('Demo dataset loaded (' + fmt(S.records.length) + ' rows).', false);
});
$('#pollSel').addEventListener('change', (e) => {
  S.pollSec = parseInt(e.target.value, 10) || 0;
  store.set('edio_poll', S.pollSec);
  schedulePoll();
});
$('#includeLow').addEventListener('change', (e) => { S.includeLow = e.target.checked; store.set('edio_includeLow', S.includeLow); render(); });
$('#clearOvr').addEventListener('click', () => {
  if (!Object.keys(S.overrides).length) return;
  S.overrides = {}; store.set('edio_overrides', {});
  reprocess(); render();
  flash('All manual corrections cleared.', false);
});
$('#bannerClose').addEventListener('click', () => $('#banner').className = '');
window.addEventListener('resize', (() => { let t; return () => { clearTimeout(t); t = setTimeout(() => renderMap(aggregate(baseFiltered())), 200); }; })());

// ---------------- boot ----------------
(function boot() {
  const cached = store.get('edio_csv', null);
  if (S.source.mode === 'sheet') {
    S.rawCsv = cached || window.EDIO_DEMO_CSV;
    setPill(cached ? 'live' : '', cached ? 'Google Sheet' : 'Connecting sheet…');
  } else if (S.source.mode === 'file' && cached) {
    S.rawCsv = cached; setPill('live', 'CSV file' + (S.source.fileName ? ': ' + S.source.fileName : ''));
  } else {
    S.source.mode = 'demo';
    S.rawCsv = window.EDIO_DEMO_CSV; setPill('', 'Demo data');
  }
  processCsv(S.rawCsv);
  render();
  if (location.protocol === 'file:' && S.source.mode !== 'file') {
    setConnStatus('Tip: the dashboard is running from a local file. If Connect fails here, your browser is blocking web requests — use “Upload a CSV file…” below, it always works.', 'busy');
  }
  if (S.source.mode === 'sheet') { syncNow(false); schedulePoll(); }
})();

// expose for tests
window.__EDIO = { S, render, aggregate, baseFiltered, processCsv, csvUrlFrom, quality };
})();
