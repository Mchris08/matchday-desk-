'use strict';
// Integration test: starts the server on a temp database and exercises the main flows.
const { spawn } = require('child_process');
const os = require('os'), path = require('path'), fs = require('fs');
const PORT = 3100 + Math.floor(Math.random() * 500);
const DB = path.join(os.tmpdir(), 'mdd-test-' + Date.now() + '.json');
const base = 'http://127.0.0.1:' + PORT;
let fails = 0;
const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) fails++; };

async function call(method, p, body, cookie, headers) {
  const r = await fetch(base + p, { method, headers: Object.assign({ 'Content-Type': 'application/json', 'X-Requested-With': 'test', Cookie: cookie || '' }, headers || {}), body: body ? JSON.stringify(body) : undefined });
  let j = {}; try { j = await r.json(); } catch (e) { /* non-json */ }
  const sc = r.headers.get('set-cookie');
  return { s: r.status, j, cookie: sc ? sc.split(';')[0] : null };
}
(async () => {
  const srv = spawn(process.execPath, ['server.js'], { env: Object.assign({}, process.env, { PORT, DATA_FILE: DB, NODE_ENV: '' }), stdio: 'inherit' });
  await new Promise(r => setTimeout(r, 900));
  try {
    const home = await fetch(base + '/'); ok(home.status === 200 && (await home.text()).includes('Matchday Desk'), 'serves the page');
    let r = await call('POST', '/api/signup', { email: 'admin@test.com', password: 'short' }); ok(r.s === 400, 'rejects short password');
    r = await call('POST', '/api/signup', { email: 'admin@test.com', password: 'longenough1' }); ok(r.s === 201 && r.j.user.role === 'admin', 'first user becomes admin');
    const A = r.cookie;
    r = await call('POST', '/api/signup', { email: 'admin@test.com', password: 'longenough1' }); ok(r.s === 409, 'blocks duplicate email');
    r = await call('POST', '/api/signup', { email: 'bob@test.com', password: 'longenough2' }); ok(r.s === 201 && r.j.user.role === 'user', 'second user is a normal user');
    const B = r.cookie;
    r = await call('GET', '/api/board'); ok(r.s === 401, 'board needs login');
    r = await call('POST', '/api/login', { email: 'bob@test.com', password: 'wrongpass' }); ok(r.s === 401, 'rejects wrong password');
    r = await call('POST', '/api/login', { email: 'bob@test.com', password: 'longenough2' }); ok(r.s === 200 && r.cookie, 'login works');
    r = await call('POST', '/api/tickets', {}, B, { 'X-Requested-With': '' }); ok(r.s === 403, 'blocks requests without the CSRF header');
    r = await call('GET', '/api/admin/overview', null, B); ok(r.s === 403, 'normal user cannot open admin');
    r = await call('POST', '/api/admin/refresh', { mode: 'demo' }, B); ok(r.s === 403, 'normal user cannot load data');
    r = await call('POST', '/api/admin/refresh', { mode: 'demo' }, A); ok(r.s === 200, 'admin loads demo data');
    r = await call('GET', '/api/board', null, B);
    const slips = r.j.slips; ok(r.s === 200 && r.j.fixtures.length > 50, 'user sees shared fixtures (' + r.j.fixtures.length + ')');
    ok(slips.daily.ok && slips.normal.ok, 'daily and normal slips built');
    const teams = []; let dup = false;
    for (const k in slips) if (slips[k].ok) slips[k].legs.forEach(l => [l.home, l.away].forEach(n => { if (teams.includes(n)) dup = true; teams.push(n); }));
    ok(!dup, 'no team repeated across slips');
    if (slips.weekly.ok) { const per = {}; slips.weekly.legs.forEach(l => per[l.day] = (per[l.day] || 0) + 1); ok(Math.max(...Object.values(per)) <= 2, 'weekly has at most 2 games a day'); ok(slips.weekly.legs.reduce((a, l) => a * l.odds, 1) <= 100, 'weekly odds stay at or under 100'); }
    r = await call('POST', '/api/tickets', { key: 'daily', legs: slips.daily.legs, stake: 1 }, B); ok(r.s === 201 && r.j.ticket.status === 'open', 'user tracks a slip');
    const tid = r.j.ticket.id;
    r = await call('GET', '/api/tickets', null, A); ok(r.j.tickets.length === 0, "other users cannot see Bob's slips");
    r = await call('PATCH', '/api/tickets/' + tid, { status: 'won' }, A); ok(r.s === 404, "other users cannot edit Bob's slips");
    r = await call('PATCH', '/api/tickets/' + tid, { status: 'lost' }, B); ok(r.s === 200 && r.j.ticket.status === 'lost', 'owner can settle the slip');
    r = await call('PUT', '/api/bank', { cur: 'USD', bankroll: 250, sDaily: 2 }, B); ok(r.j.bank.bankroll === 250 && r.j.bank.cur === 'USD', 'bankroll saved per user');
    r = await call('PUT', '/api/admin/config', { sec: { weekly: { lo: 80, hi: 500 } }, minProb: 60 }, A);
    r = await call('GET', '/api/admin/overview', null, A); ok(r.j.config.sec.weekly.hi === 100, 'weekly cap of 100 is enforced');
    ok(r.j.users.length === 2, 'admin sees both users');
    const bobId = r.j.users.find(u => u.email === 'bob@test.com').id;
    r = await call('POST', '/api/admin/users/' + bobId, { disabled: true }, A); ok(r.s === 200, 'admin disables a user');
    r = await call('GET', '/api/me', null, B); ok(r.s === 401, 'disabled user is signed out');
    r = await call('POST', '/api/logout', {}, A); ok(r.s === 200, 'logout works');
    r = await call('GET', '/api/me', null, A); ok(r.s === 401, 'session ends after logout');
    let limited = false; for (let i = 0; i < 12; i++) { r = await call('POST', '/api/login', { email: 'x@test.com', password: 'nopenope1' }); if (r.s === 429) limited = true; }
    ok(limited, 'login attempts are rate limited');
  } catch (e) { console.error(e); fails++; }
  srv.kill('SIGTERM');
  try { fs.unlinkSync(DB); } catch (e) { /* ignore */ }
  console.log(fails ? fails + ' check(s) failed' : 'All checks passed');
  process.exit(fails ? 1 : 0);
})();
