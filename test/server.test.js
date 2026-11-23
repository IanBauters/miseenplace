'use strict';
// Starts the real server on a temporary data folder and checks the API, security rules and a full menu flow.
const assert = require('assert');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const PORT = 18000 + Math.floor(Math.random() * 1000);
const BASE = `http://127.0.0.1:${PORT}`;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mep-'));
const srv = spawn(process.execPath, [path.join(__dirname, '..', 'src', 'server.js')], { env: { ...process.env, PORT, DATA_DIR: dir }, stdio: 'inherit' });
const sleep = ms => new Promise(r => setTimeout(r, ms));
const post = (p, body, headers = { 'Content-Type': 'application/json' }) => fetch(BASE + p, { method: 'POST', headers, body: typeof body === 'string' ? body : JSON.stringify(body) });
const hostStatus = host => new Promise((ok, fail) => require('http').get({ host: '127.0.0.1', port: PORT, path: '/api/health', headers: { Host: host } }, res => { res.resume(); ok(res.statusCode); }).on('error', fail));
async function act(type, data = {}) {
  const r = await post('/api/action', { type, ...data }); const j = await r.json();
  assert.ok(r.ok, `${type}: ${j.error}`); return j;
}

(async () => {
  for (let i = 0; i < 50; i++) { try { if ((await fetch(BASE + '/api/health')).ok) break; } catch {} await sleep(100); }

  // security
  assert.strictEqual((await post('/api/action', '{"type":"user.add","name":"x"}', { 'Content-Type': 'text/plain' })).status, 403, 'text/plain POST must be refused (cross-site request)');
  assert.strictEqual((await post('/api/action', { type: 'user.add', name: 'x' }, { 'Content-Type': 'application/json', Origin: 'https://evil.example' })).status, 403, 'foreign Origin refused');
  assert.strictEqual(await hostStatus('evil.example.com'), 421, 'unknown host refused (DNS rebinding)');
  assert.strictEqual(await hostStatus('nas.tail1234.ts.net:8443'), 200, 'Tailscale name allowed');
  assert.strictEqual(await hostStatus('10.0.0.105:8380'), 200, 'LAN IP allowed');
  assert.strictEqual(await hostStatus('diskstation'), 200, 'NAS name allowed');
  assert.strictEqual((await post('/api/action', { type: 'constructor' })).status, 400);
  assert.strictEqual((await post('/api/action', { type: '__proto__' })).status, 400);
  const idx = await fetch(BASE + '/', { headers: { 'Accept-Encoding': 'gzip' } });
  assert.match(idx.headers.get('content-security-policy'), /script-src 'self'/);
  assert.strictEqual(idx.headers.get('x-content-type-options'), 'nosniff');
  const etag = idx.headers.get('etag');
  assert.strictEqual((await fetch(BASE + '/', { headers: { 'If-None-Match': etag } })).status, 304, 'ETag caching');
  assert.ok((await (await fetch(BASE + '/%2e%2e/package.json')).text()).startsWith('<!DOCTYPE html>'), 'no files outside public/');

  // flow
  const u = (await act('user.add', { name: 'Ian', lang: 'nl' })).result.user;
  const pasta = (await act('product.add', { name: 'Pasta', unit: 'g', packSize: 500, min: 500 })).result.product;
  const sauce = (await act('product.add', { name: 'Passata', unit: 'jar' })).result.product;
  await act('stock.add', { productId: pasta.id, qty: 400, bb: '2030-01-01', locationId: 'pantry1', userId: u.id });
  const r = (await act('recipe.add', { name: 'Pomodoro', servings: 3, ingredients: [{ productId: pasta.id, qty: 300 }, { productId: sauce.id, qty: 1 }] })).result.recipe;
  let s = (await (await fetch(BASE + '/api/state')).json());
  const wk = s.derived.week;
  assert.ok(!('rem' in s.derived), 'internal data not sent to phones');
  await act('plan.add', { week: wk, recipeId: r.id });
  s = await act('week.confirm', { week: wk });
  const shop = s.db.shopping.filter(x => x.auto).map(x => x.productId).sort();
  assert.deepStrictEqual(shop, [pasta.id, sauce.id].sort(), 'missing passata and below-minimum pasta on the list');
  const e = s.db.plan[0];
  assert.strictEqual((await post('/api/action', { type: 'plan.remove', id: e.id })).status, 400, 'confirmed meals cannot be removed');
  s = await act('plan.cook', { id: e.id, userId: u.id });
  assert.strictEqual(s.db.lots[0].qty, 100, '300 g taken out of stock');
  s = await act('stock.bin', { id: s.db.lots[0].id, reason: '<img src=x onerror=alert(1)>' });
  assert.strictEqual(s.db.log.find(x => x.action === 'bin').reason, 'other', 'unknown reasons are normalised');
  const sug = await (await post('/api/suggest', { week: wk })).json();
  assert.ok(Array.isArray(sug.picks));
  assert.ok(fs.existsSync(path.join(dir, 'db.json')) && fs.readdirSync(path.join(dir, 'backups')).length === 1, 'data and daily backup written');

  console.log('server tests passed');
  srv.kill(); fs.rmSync(dir, { recursive: true, force: true });
})().catch(err => { console.error(err); srv.kill(); process.exit(1); });
