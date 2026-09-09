/* EDIO Sales Geo — address intelligence engine.
 * Pure module: works in the browser (window.EdioEngine) and in Node (module.exports)
 * so the resolution logic can be unit-tested outside the UI.
 *
 * Pipeline per record:
 *   raw address -> clean -> extract PIN + mobile -> gather signals
 *   (PIN db, explicit state, district/city/locality gazetteer)
 *   -> vote -> conflict check -> {state, district, pin, confidence, method,
 *   reasons, needsVerification}
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.EdioEngine = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  let PIN = null, PLACES = null;      // injected via init()
  let STATES = [], DISTS = [];
  const stateAlias = new Map();       // normalised alias -> state index

  function norm(s) {
    return String(s == null ? '' : s).toLowerCase()
      .replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
  }

  const STATE_ALIASES = {
    'tamil nadu': 'Tamil Nadu', 'tamilnadu': 'Tamil Nadu', 'tamil nad': 'Tamil Nadu',
    'kerala': 'Kerala', 'keralam': 'Kerala',
    'karnataka': 'Karnataka', 'karnatka': 'Karnataka',
    'andhra pradesh': 'Andhra Pradesh', 'andhra': 'Andhra Pradesh', 'andra pradesh': 'Andhra Pradesh',
    'telangana': 'Telangana', 'telengana': 'Telangana',
    'maharashtra': 'Maharashtra', 'maharastra': 'Maharashtra',
    'gujarat': 'Gujarat', 'gujrat': 'Gujarat',
    'rajasthan': 'Rajasthan', 'rajastan': 'Rajasthan',
    'madhya pradesh': 'Madhya Pradesh', 'uttar pradesh': 'Uttar Pradesh',
    'uttarakhand': 'Uttarakhand', 'uttaranchal': 'Uttarakhand',
    'west bengal': 'West Bengal', 'bengal': 'West Bengal',
    'odisha': 'Odisha', 'orissa': 'Odisha',
    'bihar': 'Bihar', 'jharkhand': 'Jharkhand', 'chhattisgarh': 'Chhattisgarh',
    'chattisgarh': 'Chhattisgarh', 'punjab': 'Punjab', 'haryana': 'Haryana',
    'himachal pradesh': 'Himachal Pradesh', 'himachal': 'Himachal Pradesh',
    'jammu and kashmir': 'Jammu and Kashmir', 'jammu kashmir': 'Jammu and Kashmir',
    'kashmir': 'Jammu and Kashmir', 'ladakh': 'Ladakh',
    'assam': 'Assam', 'manipur': 'Manipur', 'meghalaya': 'Meghalaya', 'mizoram': 'Mizoram',
    'nagaland': 'Nagaland', 'tripura': 'Tripura', 'sikkim': 'Sikkim',
    'arunachal pradesh': 'Arunachal Pradesh', 'goa': 'Goa',
    'delhi': 'Delhi', 'new delhi': 'Delhi', 'nct of delhi': 'Delhi',
    'puducherry': 'Puducherry', 'pondicherry': 'Puducherry', 'pondy': 'Puducherry',
    'chandigarh': 'Chandigarh', 'lakshadweep': 'Lakshadweep',
    'andaman and nicobar islands': 'Andaman and Nicobar Islands',
    'andaman nicobar': 'Andaman and Nicobar Islands', 'andaman': 'Andaman and Nicobar Islands',
    'dadra and nagar haveli and daman and diu': 'Dadra and Nagar Haveli and Daman and Diu',
    'dadra nagar haveli': 'Dadra and Nagar Haveli and Daman and Diu',
    'daman diu': 'Dadra and Nagar Haveli and Daman and Diu'
  };

  function init(pinDb, placeDb) {
    PIN = pinDb; PLACES = placeDb;
    STATES = pinDb.states; DISTS = pinDb.districts;
    stateAlias.clear();
    Object.keys(STATE_ALIASES).forEach(k => {
      const i = STATES.indexOf(STATE_ALIASES[k]);
      if (i >= 0) stateAlias.set(k, i);
    });
    STATES.forEach((s, i) => stateAlias.set(norm(s), i));
  }

  // ---------- cleaning ----------
  function cleanAddress(raw) {
    let s = String(raw == null ? '' : raw);
    s = s.replace(/<br\s*\/?\s*>/gi, ', ').replace(/<[^>]+>/g, ' ');
    s = s.replace(/&amp;/gi, '&').replace(/&nbsp;/gi, ' ')
         .replace(/&lt;/gi, '<').replace(/&gt;/gi, '>').replace(/&#\d+;/g, ' ');
    s = s.replace(/\s+/g, ' ').replace(/\s*,\s*/g, ', ').replace(/,{2,}/g, ',')
         .replace(/^\s*[,\-–]+\s*/, '').trim();
    return s;
  }

  // ---------- extraction ----------
  const PIN_RE = /(?:^|[^0-9])([1-9][0-9]{5})(?![0-9])/g;
  const MOBILE_RE = /(?:^|[^0-9])((?:\+?91[\s-]?)?[6-9][0-9]{4}[\s-]?[0-9]{5})(?![0-9])/g;

  function extractMobiles(text) {
    const out = []; let m;
    MOBILE_RE.lastIndex = 0;
    while ((m = MOBILE_RE.exec(text))) {
      const digits = m[1].replace(/\D/g, '').slice(-10);
      if (digits.length === 10) out.push(digits);
    }
    return out;
  }

  function extractPins(text) {
    // remove mobile numbers first so their digit runs can't leak a fake PIN
    let scrub = text.replace(/(\+?91[\s-]?)?[6-9][0-9]{4}[\s-]?[0-9]{5}(?![0-9])/g, ' # ');
    const out = []; let m;
    PIN_RE.lastIndex = 0;
    while ((m = PIN_RE.exec(scrub))) out.push(m[1]);
    return out;
  }

  function lookupPin(pin) {
    if (!PIN) return null;
    const hit = PIN.pins[pin];
    if (hit) {
      const [si, di, approx] = hit;
      return { state: STATES[si], si, district: di >= 0 ? DISTS[si][di] : null, di,
               approx: !!approx, source: 'db' };
    }
    const pre = PIN.prefix[pin.slice(0, 3)];
    if (pre) {
      const [si, di] = pre;
      return { state: STATES[si], si, district: di >= 0 ? DISTS[si][di] : null, di,
               approx: false, source: 'prefix' };
    }
    return null;
  }

  // ---------- place matching ----------
  function tokenize(text) {
    return norm(text).split(' ').filter(t => t && !/^\d+$/.test(t));
  }

  function findPlaces(text) {
    const toks = tokenize(text);
    const found = [], ambig = [];
    const used = new Array(toks.length).fill(false);
    for (let len = 3; len >= 1; len--) {
      for (let i = 0; i + len <= toks.length; i++) {
        let skip = false;
        for (let k = i; k < i + len; k++) if (used[k]) { skip = true; break; }
        if (skip) continue;
        const gram = toks.slice(i, i + len).join(' ');
        if (gram.length < 4) continue;
        const hit = PLACES.g[gram];
        if (hit) {
          const [si, di, approx, strong] = hit;
          const district = di >= 0 ? DISTS[si][di] : null;
          found.push({ name: gram, si, state: STATES[si], di, district,
                       approx: !!approx, words: len, pos: i,
                       strong: !!strong,
                       isDistrict: district != null && norm(district) === gram });
          for (let k = i; k < i + len; k++) used[k] = true;
          continue;
        }
        const amb = PLACES.a[gram];
        if (amb) {
          ambig.push({ name: gram, candidates: amb.map(([si, di]) => ({
            si, state: STATES[si], di, district: di >= 0 ? DISTS[si][di] : null })), words: len });
          for (let k = i; k < i + len; k++) used[k] = true;
        }
      }
    }
    return { found, ambig };
  }

  function findExplicitStates(text) {
    const toks = tokenize(text);
    const hits = [];
    for (let len = 3; len >= 1; len--) {
      for (let i = 0; i + len <= toks.length; i++) {
        const gram = toks.slice(i, i + len).join(' ');
        if (stateAlias.has(gram)) {
          const si = stateAlias.get(gram);
          if (!hits.some(h => h.si === si)) hits.push({ si, state: STATES[si], name: gram, words: len });
        }
      }
    }
    // "andhra pradesh" also matches "andhra": keep longest per state only (dedup above)
    return hits;
  }

  // ---------- main resolver ----------
  function resolve(rawAddress) {
    const original = String(rawAddress == null ? '' : rawAddress);
    const cleaned = cleanAddress(original);
    const res = {
      original, cleaned, pin: null, state: null, district: null,
      confidence: 'UNKNOWN', method: 'None', reasons: [], signals: {},
      needsVerification: false, conflict: false, mobilesInAddress: extractMobiles(cleaned)
    };
    if (!cleaned) {
      res.reasons.push('Address is empty');
      res.needsVerification = true;
      return res;
    }

    const pins = extractPins(cleaned);
    const pinInfos = pins.map(p => ({ pin: p, info: lookupPin(p) }));
    const validPin = [...pinInfos].reverse().find(p => p.info); // last resolvable PIN wins
    const anyPin = pins.length ? pins[pins.length - 1] : null;

    const stateHits = findExplicitStates(cleaned);
    const { found: places, ambig } = findPlaces(cleaned);

    res.signals = {
      pins,
      pin: validPin ? { pin: validPin.pin, state: validPin.info.state,
                        district: validPin.info.district, approx: validPin.info.approx,
                        source: validPin.info.source } : null,
      explicitStates: stateHits.map(h => h.state),
      places: places.map(p => ({ name: p.name, state: p.state, district: p.district })),
      ambiguous: ambig.map(a => ({ name: a.name, candidates: a.candidates.map(c => c.state + ' / ' + (c.district || '?')) }))
    };
    if (anyPin && !validPin) {
      res.pin = anyPin;
      res.reasons.push('PIN ' + anyPin + ' not found in the postal database');
    }

    // ----- state votes -----
    const votes = new Map(); // si -> {score, srcs:Set}
    function vote(si, score, src) {
      if (si == null || si < 0) return;
      const v = votes.get(si) || { score: 0, srcs: new Set() };
      v.score += score; v.srcs.add(src); votes.set(si, v);
    }
    if (validPin) vote(validPin.info.si, validPin.info.source === 'db' ? 3.0 : 2.0, 'pin');
    stateHits.forEach(h => vote(h.si, 2.5, 'state'));
    places.forEach(p => vote(p.si, p.isDistrict ? 2.0 : p.strong ? 1.7 : Math.min(0.6 + 0.2 * p.words + 0.04 * p.name.length, 1.2), 'place'));
    ambig.forEach(a => {
      const per = 0.5 / a.candidates.length;
      a.candidates.forEach(c => vote(c.si, per, 'ambig'));
    });

    if (!votes.size) {
      res.confidence = 'UNKNOWN'; res.method = 'None';
      res.reasons.push('No usable geographic signal in the address');
      res.needsVerification = true;
      return res;
    }

    const ranked = [...votes.entries()].sort((a, b) => b[1].score - a[1].score);
    const [topSi, topV] = ranked[0];

    // ----- hard conflict: PIN state vs explicit state disagree -----
    const pinSi = validPin ? validPin.info.si : null;
    const explicitSis = stateHits.map(h => h.si);
    if (pinSi != null && explicitSis.length && !explicitSis.includes(pinSi)) {
      res.conflict = true; res.needsVerification = true;
      res.confidence = 'UNKNOWN'; res.method = 'Conflict';
      res.pin = validPin.pin;
      res.reasons.push('Conflicting signals: PIN ' + validPin.pin + ' → ' + validPin.info.state +
        ', but address states "' + stateHits.map(h => h.state).join(', ') + '"');
      return res;
    }
    if (explicitSis.length > 1) {
      res.conflict = true; res.needsVerification = true;
      res.confidence = 'UNKNOWN'; res.method = 'Conflict';
      res.reasons.push('Address mentions more than one state: ' + stateHits.map(h => h.state).join(', '));
      return res;
    }

    const state = STATES[topSi];
    res.state = state;
    if (validPin) res.pin = validPin.pin;
    else if (anyPin) res.pin = anyPin;

    // soft conflict: strong place points elsewhere than the PIN
    const strongForeignPlace = validPin && places.find(p => p.si !== pinSi && (p.words >= 2 || (p.isDistrict && p.name.length >= 6) || (p.strong && p.name.length >= 7)));
    if (strongForeignPlace && !explicitSis.length) {
      res.reasons.push('"' + strongForeignPlace.name + '" looks like ' + strongForeignPlace.state +
        ' but PIN says ' + validPin.info.state + ' — PIN taken as stronger');
      res.needsVerification = true;
    }

    // ----- district within the chosen state -----
    const srcs = topV.srcs;
    let district = null, distFrom = null, approxDist = false;

    if (validPin && validPin.info.si === topSi && validPin.info.district) {
      district = validPin.info.district; distFrom = 'pin'; approxDist = validPin.info.approx;
    }
    const inStatePlaces = places.filter(p => p.si === topSi && p.district);
    if (!district && inStatePlaces.length) {
      inStatePlaces.sort((a, b) => (b.isDistrict - a.isDistrict) || (b.strong - a.strong) ||
        (b.words - a.words) || (b.name.length - a.name.length));
      const counts = new Map();
      inStatePlaces.forEach(p => counts.set(p.district, (counts.get(p.district) || 0) + 1));
      if (counts.size === 1) {
        district = inStatePlaces[0].district; distFrom = 'place';
        approxDist = inStatePlaces.every(p => p.approx);
      } else {
        // several localities pointing at different districts of the same state
        const best = inStatePlaces[0];
        const rest = [...counts.keys()].filter(d => d !== best.district);
        if (best.isDistrict || best.strong || best.words >= 2 || counts.get(best.district) >= 2) {
          district = best.district; distFrom = 'place'; approxDist = best.approx;
          res.reasons.push('Localities also match: ' + rest.join(', ') + ' — "' + best.name + '" taken as primary');
          res.needsVerification = true;
        } else {
          res.reasons.push('Multiple possible districts: ' + [...counts.keys()].join(', '));
          res.needsVerification = true;
        }
      }
    }
    if (!district && ambig.length) {
      const cands = new Set();
      ambig.forEach(a => a.candidates.forEach(c => { if (c.si === topSi && c.district) cands.add(c.district); }));
      if (cands.size === 1) {
        district = [...cands][0]; distFrom = 'locality';
        res.reasons.push('District inferred from a shared locality name');
      } else if (cands.size > 1) {
        res.reasons.push('Ambiguous locality — possible districts: ' + [...cands].slice(0, 4).join(', '));
        res.needsVerification = true;
      }
    }
    res.district = district;

    // corroboration between independent signals
    const placeAgrees = inStatePlaces.some(p => p.district === district) && distFrom === 'pin';
    const hasState = srcs.has('state'), hasPin = srcs.has('pin') && validPin && validPin.info.source === 'db';
    const hasPrefixPin = srcs.has('pin') && validPin && validPin.info.source === 'prefix';
    const hasPlace = srcs.has('place');

    // ----- method + confidence -----
    const parts = [];
    if (hasPin) parts.push('PIN'); else if (hasPrefixPin) parts.push('PIN prefix');
    if (hasPlace) parts.push('City');
    if (hasState) parts.push('State');
    if (!parts.length && srcs.has('ambig')) parts.push('Locality');
    res.method = parts.join(' + ') || 'None';

    if (!district) {
      res.needsVerification = true;
      if (!res.reasons.some(r => /district/i.test(r)))
        res.reasons.push(hasState || hasPin || hasPlace ? 'District could not be identified' : 'No district signal');
    }
    if (approxDist) {
      res.needsVerification = true;
      res.reasons.push('District approximated — this PIN sits in a district that was split by a recent reorganisation');
    }

    if (hasPin && district && !approxDist) res.confidence = 'HIGH';
    else if (hasPin && !district) res.confidence = 'MEDIUM';
    else if (hasPin && approxDist) res.confidence = 'MEDIUM';
    else if (hasPlace && (hasState || inStatePlaces.length >= 1) && district) {
      // full city/town match without PIN
      const strong = inStatePlaces.some(p => p.words >= 2 || p.name.length >= 5);
      res.confidence = (hasState || strong) ? 'MEDIUM' : 'LOW';
    }
    else if (hasPrefixPin) res.confidence = district ? 'MEDIUM' : 'LOW';
    else if (hasState && !district) res.confidence = 'MEDIUM';
    else if (district) res.confidence = 'LOW';
    else res.confidence = 'LOW';

    if (res.confidence === 'LOW') res.needsVerification = true;
    if (res.needsVerification && !res.reasons.length)
      res.reasons.push('Low-confidence classification');
    return res;
  }

  // ---------- record hashing for manual overrides ----------
  function recordKey(r) {
    const s = [r.date || '', r.name || '', r.mobile || '', r.address || ''].join('|');
    let h = 5381;
    for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
    return 'r' + h.toString(36);
  }

  // ---------- date parsing (day-first) ----------
  const MONTHS = { jan:0,feb:1,mar:2,apr:3,may:4,jun:5,jul:6,aug:7,sep:8,sept:8,oct:9,nov:10,dec:11 };
  function parseDate(s) {
    if (s == null) return null;
    s = String(s).trim();
    if (!s) return null;
    let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
    if (m) return mk(+m[1], +m[2] - 1, +m[3]);
    m = s.match(/^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{2,4})/);
    if (m) {
      let y = +m[3]; if (y < 100) y += 2000;
      return mk(y, +m[2] - 1, +m[1]);
    }
    m = s.match(/^(\d{1,2})\s+([a-z]{3,})\s*,?\s*(\d{4})/i);
    if (m && MONTHS[m[2].slice(0, 4).toLowerCase().slice(0,3)] != null)
      return mk(+m[3], MONTHS[m[2].toLowerCase().slice(0, 3)], +m[1]);
    m = s.match(/^([a-z]{3,})\s+(\d{1,2})\s*,?\s*(\d{4})/i);
    if (m && MONTHS[m[1].toLowerCase().slice(0, 3)] != null)
      return mk(+m[3], MONTHS[m[1].toLowerCase().slice(0, 3)], +m[2]);
    const d = new Date(s);
    return isNaN(d) ? null : d;
    function mk(y, mo, da) {
      if (mo < 0 || mo > 11 || da < 1 || da > 31) return null;
      const d = new Date(y, mo, da);
      return isNaN(d) ? null : d;
    }
  }

  return { init, resolve, cleanAddress, extractPins, extractMobiles, lookupPin,
           recordKey, parseDate, norm };
});
