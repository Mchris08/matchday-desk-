'use strict';
// Prediction engine: Poisson goals + Elo + recent form, then slip builder.

const pad = n => String(n).padStart(2, '0');
const dayKey = d => d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());

const LEAGUES = [['PL', 'Premier League'], ['PD', 'La Liga'], ['SA', 'Serie A'], ['BL1', 'Bundesliga'], ['FL1', 'Ligue 1'],
  ['DED', 'Eredivisie'], ['PPL', 'Primeira Liga'], ['ELC', 'Championship'], ['BSA', 'Brasileirao'], ['CL', 'Champions League']];

const DEF = {
  leagues: ['PL', 'PD', 'SA', 'BL1', 'FL1', 'DED', 'PPL', 'ELC'],
  minProb: 62, minGames: 6, haircut: 3, margin: 6, minOdds: 1.15, share: false, refreshHours: 6, adUrl: '',
  sec: { daily: { lo: 5, hi: 10 }, normal: { lo: 20, hi: 30 }, weekly: { lo: 80, hi: 100 } }
};
const SEC = {
  weekly: { name: 'Weekly', windows: [[0, 7]], perDay: 2 },
  normal: { name: 'Normal', windows: [[0, 4], [1, 4], [2, 4], [3, 4]], perDay: 4 },
  daily: { name: 'Daily', windows: [[0, 1], [1, 1], [0, 2]], perDay: 6 }
};

const pois = (l, n) => { const a = [Math.exp(-l)]; for (let k = 1; k <= n; k++) a[k] = a[k - 1] * l / k; return a; };

function buildModel(ms) {
  if (ms.length < 20) return null;
  ms.sort((a, b) => a.d - b.d);
  const now = Date.now(), HL = 100 * 864e5, K = 4;
  let sh = 0, sa = 0, sw = 0; const T = {};
  const get = n => T[n] || (T[n] = { n: 0, elo: 1500, hgf: 0, hga: 0, hw: 0, agf: 0, aga: 0, aw: 0, res: [] });
  for (const m of ms) {
    const w = Math.pow(.5, (now - m.d) / HL), H = get(m.h), A = get(m.a);
    sh += w * m.hg; sa += w * m.ag; sw += w;
    H.hgf += w * m.hg; H.hga += w * m.ag; H.hw += w;
    A.agf += w * m.ag; A.aga += w * m.hg; A.aw += w;
    H.n++; A.n++;
    const e = 1 / (1 + Math.pow(10, -(H.elo + 60 - A.elo) / 400));
    const s = m.hg > m.ag ? 1 : m.hg === m.ag ? .5 : 0;
    const k = 20 * (1 + Math.log(1 + Math.abs(m.hg - m.ag)) * .6);
    H.elo += k * (s - e); A.elo -= k * (s - e);
    H.res.push(s === 1 ? 'W' : s === .5 ? 'D' : 'L'); A.res.push(s === 0 ? 'W' : s === .5 ? 'D' : 'L');
  }
  const avgH = sh / sw, avgA = sa / sw;
  for (const n in T) {
    const t = T[n];
    t.attH = (t.hgf + K * avgH) / (t.hw + K) / avgH; t.defH = (t.hga + K * avgA) / (t.hw + K) / avgA;
    t.attA = (t.agf + K * avgA) / (t.aw + K) / avgA; t.defA = (t.aga + K * avgH) / (t.aw + K) / avgH;
  }
  return { T, avgH, avgA };
}
const formScore = t => { const r = t.res.slice(-6); return r.reduce((s, x) => s + (x === 'W' ? 3 : x === 'D' ? 1 : 0), 0) / (3 * Math.max(r.length, 1)); };

function predict(m, model, cfg) {
  const H = model.T[m.h], A = model.T[m.a];
  if (!H || !A || H.n < cfg.minGames || A.n < cfg.minGames) return null;
  let lh = model.avgH * H.attH * A.defA, la = model.avgA * A.attA * H.defH;
  const d = (H.elo + 60 - A.elo) / 100;
  lh *= Math.exp(.05 * d); la *= Math.exp(-.05 * d);
  lh *= 1 + .12 * (formScore(H) - .5); la *= 1 + .12 * (formScore(A) - .5);
  lh = Math.min(Math.max(lh, .25), 4); la = Math.min(Math.max(la, .2), 3.5);
  const N = 10, ph = pois(lh, N), pa = pois(la, N);
  let pH = 0, pD = 0, pA = 0, o15 = 0, o25 = 0, u35 = 0, bt = 0, tot = 0;
  for (let i = 0; i <= N; i++) for (let j = 0; j <= N; j++) {
    const p = ph[i] * pa[j]; tot += p;
    if (i > j) pH += p; else if (i === j) pD += p; else pA += p;
    if (i + j > 1) o15 += p; if (i + j > 2) o25 += p; if (i + j < 4) u35 += p; if (i > 0 && j > 0) bt += p;
  }
  return { pH: pH / tot, pD: pD / tot, pA: pA / tot, o15: o15 / tot, o25: o25 / tot, u35: u35 / tot, bt: bt / tot,
    fh: H.res.slice(-5).join(''), fa: A.res.slice(-5).join('') };
}

function legWon(code, hg, ag) {
  switch (code) {
    case 'H': return hg > ag; case 'A': return ag > hg; case '1X': return hg >= ag; case 'X2': return ag >= hg;
    case 'O15': return hg + ag > 1; case 'O25': return hg + ag > 2; case 'U35': return hg + ag < 4; case 'BTTS': return hg > 0 && ag > 0;
  }
  return false;
}

function legsFor(m, p, cfg) {
  const defs = [['H', m.h + ' to win', p.pH], ['A', m.a + ' to win', p.pA], ['1X', m.h + ' or draw', p.pH + p.pD], ['X2', m.a + ' or draw', p.pA + p.pD],
    ['O15', 'Over 1.5 goals', p.o15], ['O25', 'Over 2.5 goals', p.o25], ['U35', 'Under 3.5 goals', p.u35], ['BTTS', 'Both teams score', p.bt]];
  return defs.map(([code, label, raw]) => ({
    id: m.id + ':' + code, mid: m.id, code, label, home: m.h, away: m.a, comp: m.cn, ts: m.d, day: dayKey(new Date(m.d)),
    p: raw * (1 - cfg.haircut / 100),
    odds: Math.max(1.01, Math.round((1 / raw) * (1 - cfg.margin / 100) * 100) / 100)
  }));
}

function analyze(matches, cfg) {
  const by = {}; for (const m of matches) (by[m.c] = by[m.c] || []).push(m);
  const now = Date.now(), preds = [], legs = [];
  for (const c in by) {
    const model = buildModel(by[c].filter(m => m.s === 'FINISHED' && m.hg != null));
    if (!model) continue;
    for (const m of by[c]) {
      if (!['SCHEDULED', 'TIMED'].includes(m.s) || m.d <= now + 10 * 6e4 || m.d > now + 8 * 864e5) continue;
      const p = predict(m, model, cfg); if (!p) continue;
      preds.push({ m, p }); legs.push(...legsFor(m, p, cfg));
    }
  }
  preds.sort((a, b) => a.m.d - b.m.d);
  return { preds, legs };
}

function windowKeys(s, len) {
  const base = new Date(); base.setHours(0, 0, 0, 0); const keys = new Set();
  for (let o = s; o < s + len; o++) { const d = new Date(base); d.setDate(base.getDate() + o); keys.add(dayKey(d)); }
  return keys;
}

function search(cands, sec, lo, hi) {
  if (cands.length < 2) return null;
  const wts = cands.map(l => Math.pow(l.p, 4));
  let best = null;
  for (let it = 0; it < 1500; it++) {
    const order = cands.map((l, i) => [-Math.log(Math.random()) / wts[i], i]).sort((a, b) => a[0] - b[0]);
    let prod = 1, pj = 1; const legs = [], ut = new Set(), dc = {};
    for (const [, i] of order) {
      const l = cands[i];
      if (ut.has(l.home) || ut.has(l.away)) continue;
      if ((dc[l.day] || 0) >= sec.perDay) continue;
      if (prod * l.odds > hi) continue;
      legs.push(l); prod *= l.odds; pj *= l.p; ut.add(l.home); ut.add(l.away); dc[l.day] = (dc[l.day] || 0) + 1;
      if (prod >= lo) break;
    }
    if (prod >= lo && prod <= hi && (!best || pj > best.pj)) best = { legs: legs.slice(), pj };
  }
  return best;
}

function generate(legsAll, cfg) {
  const used = new Set(), out = {};
  for (const key of ['daily', 'normal', 'weekly']) {
    const sec = SEC[key], { lo, hi } = cfg.sec[key];
    let best = null, floor = cfg.minProb;
    for (const f of [cfg.minProb, cfg.minProb - 4, cfg.minProb - 7]) {
      if (f < 52) break;
      const base = legsAll.filter(l => l.p >= f / 100 && l.odds >= cfg.minOdds && (cfg.share || (!used.has(l.home) && !used.has(l.away))));
      for (const [s, len] of sec.windows) {
        const keys = windowKeys(s, len);
        const r = search(base.filter(l => keys.has(l.day)), sec, lo, hi);
        if (r && (!best || r.pj > best.pj)) best = r;
      }
      if (best) { floor = f; break; }
    }
    if (best) {
      const legs = best.legs.map(l => ({ ...l })).sort((a, b) => a.ts - b.ts);
      out[key] = { key, ok: true, lo, hi, floor, legs };
      if (!cfg.share) legs.forEach(l => { used.add(l.home); used.add(l.away); });
    } else {
      out[key] = { key, ok: false, lo, hi, why: `Not enough qualifying picks to reach odds of ${lo} to ${hi} within the rules right now. New fixtures are added at each update.` };
    }
  }
  return out;
}

function buildBoard(matches, cfg) {
  const { preds, legs } = analyze(matches, cfg);
  const top = {};
  for (const l of legs) if (!top[l.mid] || l.p > top[l.mid].p) top[l.mid] = { label: l.label, p: l.p };
  const fixtures = preds.map(({ m, p }) => ({ id: m.id, d: m.d, h: m.h, a: m.a, cn: m.cn, pH: p.pH, pD: p.pD, pA: p.pA, fh: p.fh, fa: p.fa, top: top[m.id] }));
  return { fixtures, slips: generate(legs, cfg), builtAt: Date.now() };
}

function genDemo() {
  const pre = ['Northgate', 'Riverside', 'Hillcrest', 'Eastbury', 'Kingsford', 'Lakeside', 'Stonebridge', 'Westfield', 'Oakridge', 'Marlow', 'Ashworth', 'Brookvale'];
  const suf = ['Rovers', 'United', 'Athletic', 'Town', 'City', 'Wanderers'];
  const rnd = Math.random, gauss = () => { let u = 0; for (let i = 0; i < 6; i++) u += rnd(); return (u - 3) / Math.sqrt(.5); };
  const poiss = l => { const L = Math.exp(-l); let k = 0, p = 1; do { k++; p *= rnd(); } while (p > L); return k - 1; };
  const shuffle = a => { a = a.slice(); for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };
  const comps = suf.map((s, i) => ({ c: 'D' + (i + 1), n: 'Demo league ' + 'ABCDEF'[i], t: pre.map(p => ({ n: p + ' ' + s, att: Math.exp(.28 * gauss()), def: Math.exp(.28 * gauss()) })) }));
  const ms = []; let id = 1; const now = Date.now();
  const t0 = new Date(); t0.setHours(0, 0, 0, 0);
  for (const c of comps) {
    for (let r = 0; r < 22; r++) {
      const sh = shuffle(c.t), d = now - (22 - r) * 4.5 * 864e5;
      for (let k = 0; k < sh.length; k += 2) {
        const h = sh[k], a = sh[k + 1];
        ms.push({ id: id++, c: c.c, cn: c.n, d: d + k * 36e5, h: h.n, a: a.n, hg: poiss(1.4 * h.att * a.def * 1.1), ag: poiss(1.1 * a.att * h.def), s: 'FINISHED' });
      }
    }
    for (const off of [0, 1, 2, 3, 4, 5, 6]) {
      const sh = shuffle(c.t);
      for (let k = 0; k < sh.length; k += 2) {
        const d = t0.getTime() + off * 864e5 + (13 + Math.floor(rnd() * 8)) * 36e5 + (rnd() < .5 ? 0 : 18e5);
        if (d < now + 30 * 6e4) continue;
        ms.push({ id: id++, c: c.c, cn: c.n, d, h: sh[k].n, a: sh[k + 1].n, hg: null, ag: null, s: 'TIMED' });
      }
    }
  }
  return ms;
}

module.exports = { LEAGUES, DEF, SEC, legWon, buildBoard, genDemo, analyze, generate };
