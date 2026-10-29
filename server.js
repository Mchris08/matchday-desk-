'use strict';
process.env.TZ = process.env.TZ || 'Africa/Harare';
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { promisify } = require('util');
const { openStore } = require('./store');
const E = require('./engine');

const scrypt = promisify(crypto.scrypt);
const PORT = process.env.PORT || 8000;
const IS_PROD = process.env.NODE_ENV === 'production';
const ADMIN_EMAIL = (process.env.ADMIN_EMAIL || '').trim().toLowerCase();
const TRUST_PROXY = process.env.TRUST_PROXY === '1';
const FD_BASE = (process.env.FOOTBALL_DATA_BASE || 'https://api.football-data.org').replace(/\/$/, '');
const SESSION_MS = 30 * 864e5;
const PAGE = fs.readFileSync(path.join(__dirname, 'public', 'index.html'));

const clone = o => JSON.parse(JSON.stringify(o));
const sleep = ms => new Promise(r => setTimeout(r, ms));
const rid = n => crypto.randomBytes(n).toString('hex');
const sha = s => crypto.createHash('sha256').update(s).digest('hex');
const num = (v, lo, hi, d) => { v = parseFloat(v); return Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d; };
const str = (v, n) => String(v == null ? '' : v).slice(0, n);
function merge(a, b) { for (const k in b) { if (b[k] && typeof b[k] === 'object' && !Array.isArray(b[k])) a[k] = merge(a[k] || {}, b[k]); else a[k] = b[k]; } return a; }

/* ---------- passwords and rate limits ---------- */
async function hashPw(pw) { const salt = crypto.randomBytes(16); const h = await scrypt(pw, salt, 64); return salt.toString('hex') + ':' + h.toString('hex'); }
async function checkPw(pw, stored) {
  const [salt, h] = String(stored).split(':');
  const x = await scrypt(pw, Buffer.from(salt, 'hex'), 64);
  const y = Buffer.from(h, 'hex');
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}
const hits = new Map();
function limited(key, max, win) {
  const now = Date.now(), a = (hits.get(key) || []).filter(t => now - t < win);
  a.push(now); hits.set(key, a); return a.length > max;
}
setInterval(() => { const now = Date.now(); for (const [k, a] of hits) if (!a.some(t => now - t < 36e5)) hits.delete(k); }, 36e5).unref();

/* ---------- http helpers ---------- */
function send(res, code, obj, extra) {
  const body = JSON.stringify(obj);
  res.writeHead(code, Object.assign({ 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }, extra || {}));
  res.end(body);
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let n = 0; const chunks = [];
    req.on('data', c => { n += c.length; if (n > 200000) { reject(Object.assign(new Error('Body too large'), { code: 413 })); req.destroy(); } else chunks.push(c); });
    req.on('end', () => { if (!chunks.length) return resolve({}); try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch (e) { reject(Object.assign(new Error('Invalid JSON'), { code: 400 })); } });
    req.on('error', reject);
  });
}
const clientIp = req => (TRUST_PROXY && req.headers['x-forwarded-for'] ? String(req.headers['x-forwarded-for']).split(',')[0].trim() : req.socket.remoteAddress) || 'x';
const isHttps = req => IS_PROD || req.headers['x-forwarded-proto'] === 'https';
const parseCookies = req => Object.fromEntries(String(req.headers.cookie || '').split(';').map(s => s.trim().split('=')).filter(a => a[0]).map(a => [a[0], a.slice(1).join('=')]));
const cookie = (req, val, maxAge) => `sid=${val}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAge}${isHttps(req) ? '; Secure' : ''}`;

async function main() {
  const store = await openStore();
  const cfg = merge(clone(E.DEF), (await store.get('config', 'main')) || {});
  const st = { busy: '', demo: false, updatedAt: 0, matches: [], board: null, lastError: '' };
  const DEFAULT_BANK = { cur: '$', bankroll: 100, sDaily: 1, sNormal: .5, sWeekly: .5, dayLoss: 3, weekLoss: 8, kelly: 25 };

  /* ----- data pipeline ----- */
  async function getKey() { return process.env.FOOTBALL_DATA_KEY || ((await store.get('config', 'secret')) || {}).footballKey || ''; }
  async function settleAll() {
    const open = await store.find('tickets', 'status', 'open');
    const byId = {}; for (const m of st.matches) byId[m.id] = m;
    for (const t of open) {
      if (!!t.demo !== st.demo) continue;
      let ch = false;
      for (const l of t.legs) {
        if (l.res) continue;
        const m = byId[l.mid];
        if (m && m.s === 'FINISHED' && m.hg != null) { l.res = E.legWon(l.code, m.hg, m.ag) ? 'won' : 'lost'; ch = true; }
      }
      if (t.legs.some(l => l.res === 'lost')) { t.status = 'lost'; ch = true; }
      else if (t.legs.every(l => l.res === 'won')) { t.status = 'won'; ch = true; }
      if (ch) await store.put('tickets', t.id, t);
    }
  }
  async function rebuild() {
    const b = E.buildBoard(st.matches, cfg); b.demo = st.demo;
    st.board = b; await store.put('cache', 'board', b); await settleAll();
  }
  async function loadCache() {
    const m = await store.get('cache', 'matches');
    if (m) { st.matches = m.list; st.updatedAt = m.at; st.demo = !!m.demo; }
    const b = await store.get('cache', 'board');
    if (b) st.board = b; else if (st.matches.length) await rebuild();
  }
  async function getComp(c, key) {
    for (let attempt = 0; attempt < 2; attempt++) {
      let r;
      try { r = await fetch(FD_BASE + '/v4/competitions/' + c + '/matches', { headers: { 'X-Auth-Token': key } }); }
      catch (e) { throw Object.assign(new Error('Network error reaching football-data.org'), { fatal: true }); }
      if (r.status === 429 && attempt === 0) { await sleep(30000); continue; }
      if (r.status === 400 || r.status === 401) throw Object.assign(new Error('API key rejected'), { fatal: true });
      if (r.status === 403) throw new Error('not in your plan');
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const j = await r.json(), cn = (j.competition && j.competition.name) || c;
      return (j.matches || []).map(m => ({
        id: m.id, c, cn, d: Date.parse(m.utcDate), h: m.homeTeam.shortName || m.homeTeam.name, a: m.awayTeam.shortName || m.awayTeam.name,
        hg: m.score && m.score.fullTime ? m.score.fullTime.home : null, ag: m.score && m.score.fullTime ? m.score.fullTime.away : null, s: m.status
      })).filter(m => m.h && m.a);
    }
    throw new Error('rate limited');
  }
  async function refreshLive() {
    if (st.busy) return;
    const key = await getKey();
    if (!key) { st.lastError = 'No football-data.org API key set.'; return; }
    const all = [], errs = []; let i = 0;
    try {
      for (const c of cfg.leagues) {
        i++; st.busy = `Loading ${(E.LEAGUES.find(x => x[0] === c) || [c, c])[1]} (${i} of ${cfg.leagues.length})`;
        try { all.push(...await getComp(c, key)); } catch (e) { errs.push(c + ': ' + e.message); if (e.fatal) break; }
        if (i < cfg.leagues.length) await sleep(6500);
      }
      if (all.length) {
        st.busy = 'Building slips';
        st.matches = all; st.demo = false; st.updatedAt = Date.now();
        await store.put('cache', 'matches', { at: st.updatedAt, demo: false, list: all });
        await rebuild();
      }
      st.lastError = errs.join('; ');
    } catch (e) { console.error(e); st.lastError = e.message; }
    st.busy = '';
  }
  async function loadDemo() {
    st.matches = E.genDemo(); st.demo = true; st.updatedAt = Date.now();
    await store.put('cache', 'matches', { at: st.updatedAt, demo: true, list: st.matches });
    await rebuild(); st.lastError = '';
  }

  /* ----- sessions and users ----- */
  const publicUser = u => ({ id: u.id, email: u.email, role: u.role, bank: u.bank });
  async function startSession(req, res, user, code) {
    const token = rid(32);
    await store.put('sessions', sha(token), { id: sha(token), uid: user.id, exp: Date.now() + SESSION_MS });
    user.lastLogin = Date.now(); await store.put('users', user.id, user);
    send(res, code || 200, { user: publicUser(user) }, { 'Set-Cookie': cookie(req, token, SESSION_MS / 1000) });
  }
  async function authUser(req) {
    const t = parseCookies(req).sid; if (!t) return null;
    const s = await store.get('sessions', sha(t));
    if (!s || s.exp < Date.now()) return null;
    const u = await store.get('users', s.uid);
    return u && !u.disabled ? u : null;
  }
  const validEmail = e => e.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(e);

  function boardForUser() {
    const b = st.board;
    return {
      meta: { updatedAt: st.updatedAt, demo: st.demo, busy: st.busy, minProb: cfg.minProb, leagues: cfg.leagues.length },
      fixtures: b ? b.fixtures.filter(f => f.d > Date.now()) : [],
      slips: b ? b.slips : {}
    };
  }
  function cleanTicketLegs(legs) {
    if (!Array.isArray(legs) || !legs.length || legs.length > 20) return null;
    const out = [];
    for (const l of legs) {
      const odds = num(l.odds, 1.01, 1000, NaN), p = num(l.p, 0, 1, NaN);
      if (!Number.isFinite(odds) || !Number.isFinite(p)) return null;
      out.push({ mid: str(l.mid, 40), code: str(l.code, 6), label: str(l.label, 90), match: str(l.home, 60) + ' v ' + str(l.away, 60), odds, p, res: null });
    }
    return out;
  }

  /* ----- routes ----- */
  async function api(req, res, url) {
    const method = req.method, p = url.pathname;
    if (method !== 'GET' && !req.headers['x-requested-with']) return send(res, 403, { error: 'Blocked request' });
    const body = method === 'GET' || method === 'DELETE' ? {} : await readBody(req);
    const ip = clientIp(req);

    if (p === '/api/signup' && method === 'POST') {
      if (limited('su:' + ip, 10, 36e5)) return send(res, 429, { error: 'Too many attempts. Try again later.' });
      const email = str(body.email, 254).trim().toLowerCase(), pw = str(body.password, 200);
      if (!validEmail(email)) return send(res, 400, { error: 'Enter a valid email address.' });
      if (pw.length < 8) return send(res, 400, { error: 'Password must be at least 8 characters.' });
      if ((await store.find('users', 'email', email)).length) return send(res, 409, { error: 'An account with that email already exists.' });
      const count = (await store.list('users')).length;
      const role = ADMIN_EMAIL ? (email === ADMIN_EMAIL ? 'admin' : 'user') : (count === 0 ? 'admin' : 'user');
      const user = { id: 'u_' + rid(8), email, pw: await hashPw(pw), role, disabled: false, createdAt: Date.now(), lastLogin: 0, bank: clone(DEFAULT_BANK) };
      await store.put('users', user.id, user);
      return startSession(req, res, user, 201);
    }
    if (p === '/api/login' && method === 'POST') {
      const email = str(body.email, 254).trim().toLowerCase();
      if (limited('li:' + ip, 30, 6e5) || limited('le:' + email, 8, 6e5)) return send(res, 429, { error: 'Too many attempts. Wait a few minutes.' });
      const u = (await store.find('users', 'email', email))[0];
      if (!u || !(await checkPw(str(body.password, 200), u.pw))) return send(res, 401, { error: 'Wrong email or password.' });
      if (u.disabled) return send(res, 403, { error: 'This account has been disabled.' });
      if (ADMIN_EMAIL && email === ADMIN_EMAIL && u.role !== 'admin') u.role = 'admin';
      return startSession(req, res, u);
    }
    const user = await authUser(req);
    if (p === '/api/logout' && method === 'POST') {
      const t = parseCookies(req).sid; if (t) await store.del('sessions', sha(t));
      return send(res, 200, { ok: true }, { 'Set-Cookie': cookie(req, '', 0) });
    }
    if (!user) return send(res, 401, { error: 'Please sign in.' });

    if (p === '/api/me' && method === 'GET') return send(res, 200, { user: publicUser(user) });
    if (p === '/api/me/password' && method === 'POST') {
      if (!(await checkPw(str(body.current, 200), user.pw))) return send(res, 400, { error: 'Current password is wrong.' });
      const np = str(body.next, 200); if (np.length < 8) return send(res, 400, { error: 'New password must be at least 8 characters.' });
      user.pw = await hashPw(np); await store.put('users', user.id, user);
      const keep = parseCookies(req).sid ? sha(parseCookies(req).sid) : '';
      for (const s of await store.find('sessions', 'uid', user.id)) if (s.id !== keep) await store.del('sessions', s.id);
      return send(res, 200, { ok: true });
    }
    if (p === '/api/me/delete' && method === 'POST') {
      if (!(await checkPw(str(body.password, 200), user.pw))) return send(res, 400, { error: 'Password is wrong.' });
      for (const t of await store.find('tickets', 'uid', user.id)) await store.del('tickets', t.id);
      for (const s of await store.find('sessions', 'uid', user.id)) await store.del('sessions', s.id);
      await store.del('users', user.id);
      return send(res, 200, { ok: true }, { 'Set-Cookie': cookie(req, '', 0) });
    }
    if (p === '/api/board' && method === 'GET') return send(res, 200, boardForUser());
    if (p === '/api/bank' && method === 'PUT') {
      const b = user.bank = Object.assign(clone(DEFAULT_BANK), user.bank);
      b.cur = str(body.cur, 3) || '$';
      b.bankroll = num(body.bankroll, 0, 1e9, b.bankroll);
      for (const k of ['sDaily', 'sNormal', 'sWeekly', 'dayLoss', 'weekLoss']) b[k] = num(body[k], 0, 100, b[k]);
      b.kelly = num(body.kelly, 0, 100, b.kelly);
      await store.put('users', user.id, user);
      return send(res, 200, { bank: b });
    }
    if (p === '/api/tickets' && method === 'GET') {
      const t = (await store.find('tickets', 'uid', user.id)).sort((a, b) => b.at - a.at);
      return send(res, 200, { tickets: t });
    }
    if (p === '/api/tickets' && method === 'POST') {
      const key = body.key;
      if (!E.SEC[key]) return send(res, 400, { error: 'Unknown slip.' });
      const legs = cleanTicketLegs(body.legs);
      if (!legs) return send(res, 400, { error: 'Invalid slip.' });
      if ((await store.find('tickets', 'uid', user.id)).length >= 500) return send(res, 400, { error: 'Tracker is full. Delete old slips first.' });
      const t = { id: 't_' + rid(8), uid: user.id, key, name: E.SEC[key].name + ' slip', at: Date.now(), status: 'open', demo: st.demo,
        odds: legs.reduce((a, l) => a * l.odds, 1), pj: legs.reduce((a, l) => a * l.p, 1), stake: num(body.stake, 0, 1e9, 0), legs };
      await store.put('tickets', t.id, t);
      return send(res, 201, { ticket: t });
    }
    const tm = p.match(/^\/api\/tickets\/(t_[a-f0-9]+)$/);
    if (tm) {
      const t = await store.get('tickets', tm[1]);
      if (!t || t.uid !== user.id) return send(res, 404, { error: 'Not found.' });
      if (method === 'PATCH') {
        if (!['won', 'lost'].includes(body.status)) return send(res, 400, { error: 'Invalid status.' });
        t.status = body.status; await store.put('tickets', t.id, t); return send(res, 200, { ticket: t });
      }
      if (method === 'DELETE') { await store.del('tickets', t.id); return send(res, 200, { ok: true }); }
    }

    /* ----- admin ----- */
    if (p.startsWith('/api/admin/')) {
      if (user.role !== 'admin') return send(res, 403, { error: 'Admins only.' });
      if (p === '/api/admin/overview' && method === 'GET') {
        const users = await store.list('users'), tickets = await store.list('tickets');
        const cnt = {}; for (const t of tickets) cnt[t.uid] = (cnt[t.uid] || 0) + 1;
        return send(res, 200, {
          users: users.sort((a, b) => b.createdAt - a.createdAt).map(u => ({ id: u.id, email: u.email, role: u.role, disabled: !!u.disabled, createdAt: u.createdAt, lastLogin: u.lastLogin, tickets: cnt[u.id] || 0 })),
          status: { busy: st.busy, demo: st.demo, updatedAt: st.updatedAt, matches: st.matches.length, fixtures: st.board ? st.board.fixtures.length : 0, lastError: st.lastError, hasKey: !!(await getKey()), keyFromEnv: !!process.env.FOOTBALL_DATA_KEY },
          config: cfg, leagues: E.LEAGUES
        });
      }
      if (p === '/api/admin/config' && method === 'PUT') {
        if (body.leagues) cfg.leagues = body.leagues.filter(c => E.LEAGUES.some(x => x[0] === c));
        cfg.minProb = num(body.minProb, 50, 90, cfg.minProb); cfg.minGames = num(body.minGames, 3, 15, cfg.minGames);
        cfg.haircut = num(body.haircut, 0, 10, cfg.haircut); cfg.margin = num(body.margin, 0, 12, cfg.margin);
        cfg.minOdds = num(body.minOdds, 1.01, 3, cfg.minOdds); cfg.refreshHours = num(body.refreshHours, 1, 48, cfg.refreshHours);
        if (typeof body.share === 'boolean') cfg.share = body.share;
        if (body.sec) for (const k of ['daily', 'normal', 'weekly']) if (body.sec[k]) {
          let lo = num(body.sec[k].lo, 1.5, 1000, cfg.sec[k].lo), hi = num(body.sec[k].hi, 2, 1000, cfg.sec[k].hi);
          if (k === 'weekly') hi = Math.min(100, hi);
          if (lo >= hi) lo = hi / 2;
          cfg.sec[k] = { lo, hi };
        }
        await store.put('config', 'main', cfg);
        if (typeof body.footballKey === 'string' && body.footballKey.trim()) await store.put('config', 'secret', { footballKey: body.footballKey.trim().slice(0, 100) });
        if (st.matches.length) await rebuild();
        return send(res, 200, { ok: true });
      }
      if (p === '/api/admin/refresh' && method === 'POST') {
        if (st.busy) return send(res, 409, { error: 'An update is already running.' });
        if (body.mode === 'demo') { await loadDemo(); return send(res, 200, { ok: true }); }
        if (body.mode === 'rebuild') { if (!st.matches.length) return send(res, 400, { error: 'No fixtures loaded yet.' }); await rebuild(); return send(res, 200, { ok: true }); }
        if (!(await getKey())) return send(res, 400, { error: 'Add your football-data.org key first.' });
        refreshLive(); return send(res, 202, { ok: true });
      }
      const um = p.match(/^\/api\/admin\/users\/(u_[a-f0-9]+)$/);
      if (um && method === 'POST') {
        const t = await store.get('users', um[1]);
        if (!t) return send(res, 404, { error: 'Not found.' });
        if (t.id === user.id) return send(res, 400, { error: 'You cannot change your own account here.' });
        if (typeof body.disabled === 'boolean') { t.disabled = body.disabled; if (t.disabled) for (const s of await store.find('sessions', 'uid', t.id)) await store.del('sessions', s.id); }
        if (['admin', 'user'].includes(body.role)) t.role = body.role;
        await store.put('users', t.id, t);
        return send(res, 200, { ok: true });
      }
    }
    return send(res, 404, { error: 'Not found.' });
  }

  const server = http.createServer(async (req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'same-origin');
    try {
      const url = new URL(req.url, 'http://x');
      if (url.pathname.startsWith('/api/')) return await api(req, res, url);
      if (url.pathname === '/healthz') { res.writeHead(200); return res.end('ok'); }
      if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache',
          'Content-Security-Policy': "default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'" });
        return res.end(PAGE);
      }
      res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('Not found');
    } catch (e) {
      if (e.code === 413 || e.code === 400) return send(res, e.code, { error: e.message });
      console.error(e); if (!res.headersSent) send(res, 500, { error: 'Server error.' });
    }
  });

  await loadCache();
  const tick = async () => { if (!st.demo && !st.busy && Date.now() - st.updatedAt > cfg.refreshHours * 36e5 && await getKey()) refreshLive(); };
  setTimeout(tick, 5000).unref(); setInterval(tick, 10 * 60 * 1000).unref();
  const stop = () => { try { store.flush(); } catch (e) { /* ignore */ } process.exit(0); };
  process.on('SIGTERM', stop); process.on('SIGINT', stop);
  server.listen(PORT, () => console.log('Matchday Desk running on port ' + PORT));
}
process.on('uncaughtException', e => console.error('Uncaught:', e));
process.on('unhandledRejection', e => console.error('Unhandled:', e));
main().catch(e => { console.error(e); process.exit(1); });
