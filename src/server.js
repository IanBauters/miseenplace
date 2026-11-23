'use strict';
// Mise en Place server: static app + JSON API + live updates (Server-Sent Events).
// No external dependencies. Data lives in DATA_DIR/db.json with daily backups.
const http = require('http');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');
const E = require('./engine');

const PORT = Number(process.env.PORT || 8080);
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const PUBLIC = path.join(__dirname, '..', 'public');
const DB_FILE = path.join(DATA_DIR, 'db.json');
const BACKUPS = path.join(DATA_DIR, 'backups');
const VERSION = require('../package.json').version;
// Extra host names the app may be reached on (comma separated), e.g. a reverse-proxy domain.
const EXTRA_HOSTS = (process.env.ALLOWED_HOSTS || '').split(',').map(h => h.trim().toLowerCase()).filter(Boolean);

/* ---------- storage ---------- */
fs.mkdirSync(BACKUPS, { recursive: true });
let db;
try { db = JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); } catch { db = E.freshDb(); }
db = Object.assign(E.freshDb(), db);
db.settings = Object.assign(E.freshDb().settings, db.settings);

let rev = Date.now(); // unique across restarts, so phones always notice a fresh server
function persist() {
  const tmp = DB_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(db));
  fs.renameSync(tmp, DB_FILE);
  const bk = path.join(BACKUPS, `db-${E.todayISO()}.json`);
  if (!fs.existsSync(bk)) {
    fs.copyFileSync(DB_FILE, bk);
    fs.readdirSync(BACKUPS).filter(f => f.startsWith('db-')).sort().slice(0, -30).forEach(f => fs.unlinkSync(path.join(BACKUPS, f)));
  }
}

// Bring time-dependent state up to date (carry-over, automatic shopping items) and compute derived data once.
let derived = null;
function refresh(dirty) {
  const today = E.todayISO();
  if (E.carryOver(db, today)) dirty = true;
  E.ensureWeek(db, E.addDays(E.monday(today), 7));
  derived = E.compute(db, today);
  if (E.syncAuto(db, today, derived)) { dirty = true; derived = E.compute(db, today); }
  if (dirty) { rev++; persist(); }
  return dirty;
}

/* ---------- live updates ---------- */
const clients = new Set();
function broadcast() { for (const res of clients) res.write(`event: change\ndata: ${rev}\n\n`); }

/* ---------- actions ---------- */
class Bad extends Error {}
const need = (c, msg) => { if (!c) throw new Bad(msg); };
const find = (arr, id, what) => { const x = arr.find(o => o.id === id); need(x, `${what} not found`); return x; };
const num = (v, d = 0) => { const n = Number(v); return v !== '' && v !== null && Number.isFinite(n) ? n : d; };
const str = (v, max = 200) => String(v ?? '').trim().slice(0, max);
const date = v => (/^\d{4}-\d{2}-\d{2}$/.test(v || '') ? v : '');
const UNITS = ['pcs', 'g', 'kg', 'ml', 'l', 'pack', 'tin', 'jar', 'bag', 'bottle'];
const REASONS = ['off', 'past', 'mould', 'forgot', 'other'];
const now = () => new Date().toISOString();
function log(entry, userId) {
  db.log.push({ id: E.uid(), ts: now(), date: E.todayISO(), userId: userId || null, ...entry });
  if (db.log.length > 5000) db.log.splice(0, db.log.length - 5000);
}
function cleanProduct(a, p = {}) {
  return {
    ...p,
    name: str(a.name ?? p.name, 80),
    unit: UNITS.includes(a.unit) ? a.unit : (p.unit || 'pcs'),
    packSize: Math.max(0.001, num(a.packSize ?? p.packSize, 1)),
    min: Math.max(0, num(a.min ?? p.min, 0)),
    emergencyQty: Math.max(0, num(a.emergencyQty ?? p.emergencyQty, 0)),
    water: a.water !== undefined ? !!a.water : !!p.water,
    locationId: db.locations.some(l => l.id === a.locationId) ? a.locationId : (p.locationId || ''),
    barcodes: Array.isArray(a.barcodes) ? [...new Set(a.barcodes.map(b => str(b, 40)).filter(Boolean))].slice(0, 20) : (p.barcodes || [])
  };
}
function cleanRecipe(a, r = {}) {
  return {
    ...r,
    name: str(a.name, 100),
    servings: Math.max(1, num(a.servings, 3)),
    ingredients: (Array.isArray(a.ingredients) ? a.ingredients : []).filter(i => i && db.products.some(p => p.id === i.productId) && num(i.qty) > 0)
      .slice(0, 60).map(i => ({ productId: i.productId, qty: num(i.qty) })),
    tags: (Array.isArray(a.tags) ? a.tags : []).map(t => str(t, 30)).filter(Boolean).slice(0, 10),
    steps: str(a.steps, 5000),
    emergency: !!a.emergency,
    stove: !!a.stove,
    fav: !!a.fav
  };
}
function addLot(a, userId) {
  const p = find(db.products, a.productId, 'Product');
  const qty = num(a.qty, p.packSize || 1); need(qty > 0, 'Amount must be more than 0');
  const loc = db.locations.some(l => l.id === a.locationId) ? a.locationId : (p.locationId || db.locations[0].id);
  db.lots.push({ id: E.uid(), productId: p.id, qty, bb: date(a.bb), locationId: loc, addedAt: now(), addedBy: userId || null });
  const code = str(a.barcode, 40);
  if (code && !p.barcodes.includes(code)) p.barcodes.push(code);
  log({ action: 'add', productId: p.id, qty }, userId);
}
function takeFromLot(lot, qty) {
  lot.qty = E.round(lot.qty - qty);
  if (lot.qty <= 0) db.lots = db.lots.filter(l => l.id !== lot.id);
}

const actions = {
  'user.add'(a) { const u = { id: E.uid(), name: str(a.name, 40), lang: a.lang === 'en' ? 'en' : 'nl' }; need(u.name, 'Name required'); db.users.push(u); return { user: u }; },
  'user.update'(a) { const u = find(db.users, a.id, 'User'); if (a.name) u.name = str(a.name, 40); if (a.lang) u.lang = a.lang === 'en' ? 'en' : 'nl'; },

  'loc.add'(a) { const name = str(a.name, 40); need(name, 'Name required'); db.locations.push({ id: E.uid(), name, emergency: !!a.emergency }); },
  'loc.update'(a) { const l = find(db.locations, a.id, 'Location'); const name = str(a.name, 40); if (name) l.name = name; if (a.emergency !== undefined) l.emergency = !!a.emergency; },
  'loc.delete'(a) { need(!db.lots.some(l => l.locationId === a.id), 'Move the items out of this location first'); need(db.locations.length > 1, 'Keep at least one location'); db.locations = db.locations.filter(l => l.id !== a.id); },

  'product.add'(a) { const p = { id: E.uid(), ...cleanProduct(a) }; need(p.name, 'Name required'); db.products.push(p); return { product: p }; },
  'product.update'(a) { const p = find(db.products, a.id, 'Product'); const c = cleanProduct(a, p); need(c.name, 'Name required'); Object.assign(p, c); },
  'product.delete'(a) {
    need(!db.lots.some(l => l.productId === a.id), 'This product is still in stock');
    need(!db.recipes.some(r => r.ingredients.some(i => i.productId === a.id)), 'This product is used in a recipe');
    db.products = db.products.filter(p => p.id !== a.id); db.shopping = db.shopping.filter(s => s.productId !== a.id);
  },

  'stock.add'(a, u) { addLot(a, u); },
  'stock.update'(a) {
    const l = find(db.lots, a.id, 'Item');
    if (a.qty !== undefined) l.qty = Math.max(0, num(a.qty, l.qty));
    if (a.bb !== undefined) l.bb = date(a.bb);
    if (db.locations.some(x => x.id === a.locationId)) l.locationId = a.locationId;
    if (l.qty <= 0) db.lots = db.lots.filter(x => x.id !== l.id);
  },
  'stock.use'(a, u) { const l = find(db.lots, a.id, 'Item'); const q = Math.min(l.qty, Math.max(0, num(a.qty, 1))); takeFromLot(l, q); log({ action: 'use', productId: l.productId, qty: q }, u); },
  'stock.empty'(a, u) { const l = find(db.lots, a.id, 'Item'); log({ action: 'empty', productId: l.productId, qty: l.qty }, u); takeFromLot(l, l.qty); },
  'stock.bin'(a, u) {
    const l = find(db.lots, a.id, 'Item'); const q = Math.min(l.qty, Math.max(0, num(a.qty, l.qty)));
    log({ action: 'bin', productId: l.productId, qty: q, reason: REASONS.includes(a.reason) ? a.reason : 'other', bb: l.bb }, u); takeFromLot(l, q);
  },

  'recipe.add'(a) { const r = { id: E.uid(), ...cleanRecipe(a) }; need(r.name, 'Name required'); db.recipes.push(r); return { recipe: r }; },
  'recipe.update'(a) { const r = find(db.recipes, a.id, 'Recipe'); const c = cleanRecipe(a, r); need(c.name, 'Name required'); Object.assign(r, c); },
  'recipe.delete'(a) { need(!db.plan.some(e => e.recipeId === a.id && e.status === 'planned'), 'This recipe is on the menu'); db.recipes = db.recipes.filter(r => r.id !== a.id); },

  'week.setDay'(a) { const wk = date(a.week); need(wk, 'Bad week'); const i = num(a.index, -1); need(Number.isInteger(i) && i >= 0 && i < 7 && E.DAY_TYPES.includes(a.type), 'Bad day'); E.ensureWeek(db, wk).days[i] = a.type; },
  'week.confirm'(a, u) {
    const wk = date(a.week); need(wk, 'Bad week'); const w = E.ensureWeek(db, wk);
    need(db.plan.some(e => e.week === wk), 'Add meals before confirming');
    w.confirmed = true; w.confirmedAt = now(); w.confirmedBy = u || null;
  },
  'plan.add'(a) {
    const wk = date(a.week); need(wk && wk === E.monday(wk), 'Bad week'); E.ensureWeek(db, wk);
    const r = find(db.recipes, a.recipeId, 'Recipe');
    const order = Math.max(-1, ...db.plan.filter(e => e.week === wk).map(e => e.order)) + 1;
    db.plan.push({ id: E.uid(), week: wk, recipeId: r.id, servings: Math.max(1, num(a.servings, r.servings)), status: 'planned', order });
  },
  'plan.addMany'(a) { for (const id of (Array.isArray(a.recipeIds) ? a.recipeIds : []).slice(0, 14)) actions['plan.add']({ week: a.week, recipeId: id }); if (a.sort) actions['plan.sort']({ week: a.week }); },
  'plan.remove'(a) {
    const e = find(db.plan, a.id, 'Meal'); need(!(db.weeks[e.week] || {}).confirmed, 'This week is confirmed: meals can be moved, not removed');
    db.plan = db.plan.filter(x => x.id !== e.id); E.renumber(db, e.week);
  },
  'plan.move'(a) {
    const e = find(db.plan, a.id, 'Meal');
    const list = db.plan.filter(x => x.week === e.week).sort((x, y) => x.order - y.order);
    const i = list.indexOf(e), j = i + (a.dir < 0 ? -1 : 1);
    if (j >= 0 && j < list.length) [list[i].order, list[j].order] = [list[j].order, list[i].order];
  },
  'plan.sort'(a) {
    const wk = date(a.week); const d = E.compute(db, E.todayISO());
    const dl = e => (d.entries[e.id] || {}).deadline || '9999';
    const rank = e => e.status === 'cooked' ? '0' + (e.cookedAt || '') : (e.carried ? '1' : '2') + dl(e);
    db.plan.filter(x => x.week === wk).sort((x, y) => rank(x).localeCompare(rank(y)) || x.order - y.order).forEach((e, i) => { e.order = i; });
  },
  'plan.cook'(a, u) {
    const e = find(db.plan, a.id, 'Meal'); need(e.status === 'planned', 'Already cooked');
    const info = derived.entries[e.id] || {};
    for (const al of info.alloc || []) { const l = db.lots.find(x => x.id === al.lotId); if (l) takeFromLot(l, al.qty); }
    e.status = 'cooked'; e.cookedAt = E.todayISO(); e.cookedBy = u || null;
    log({ action: 'cook', recipeId: e.recipeId }, u);
  },

  'shop.add'(a) {
    const p = a.productId ? find(db.products, a.productId, 'Product') : null;
    const name = p ? '' : str(a.name, 80); need(p || name, 'Name required');
    db.shopping.push({ id: E.uid(), productId: p ? p.id : null, name, qty: p ? Math.max(0.001, num(a.qty, p.packSize || 1)) : str(a.qty, 30), auto: false, done: false, addedAt: now() });
  },
  'shop.toggle'(a) { const s = find(db.shopping, a.id, 'Item'); s.done = a.done !== undefined ? !!a.done : !s.done; },
  'shop.delete'(a) { db.shopping = db.shopping.filter(s => s.id !== a.id); },
  'shop.store'(a, u) {
    for (const it of (Array.isArray(a.items) ? a.items : []).slice(0, 200)) {
      const s = db.shopping.find(x => x.id === it.id);
      let pid = db.products.some(p => p.id === it.productId) ? it.productId : s && s.productId;
      if (!pid && it.newProduct) pid = actions['product.add'](it.newProduct).product.id;
      if (pid && num(it.qty) > 0) addLot({ productId: pid, qty: it.qty, bb: it.bb, locationId: it.locationId }, u);
      if (s) db.shopping = db.shopping.filter(x => x.id !== s.id);
    }
  },
  'shop.clearDone'() { db.shopping = db.shopping.filter(s => !s.done); },

  'kit.add'(a) { const name = str(a.name, 80); need(name, 'Name required'); db.kit.push({ id: E.uid(), name, qty: str(a.qty, 30), have: false, bb: date(a.bb) }); },
  'kit.update'(a) {
    const k = find(db.kit, a.id, 'Item');
    const name = str(a.name, 80); if (name) k.name = name;
    if (a.qty !== undefined) k.qty = str(a.qty, 30);
    if (a.bb !== undefined) k.bb = date(a.bb);
    if (a.have !== undefined) k.have = !!a.have;
  },
  'kit.delete'(a) { db.kit = db.kit.filter(k => k.id !== a.id); },

  'settings.update'(a) {
    const s = db.settings;
    for (const k of ['people', 'days', 'mealsPerDay', 'rotationDays', 'waterPerPersonDay']) if (a[k] !== undefined) s[k] = Math.min(365, Math.max(k === 'rotationDays' ? 7 : 1, num(a[k], s[k])));
  }
};

// What phones receive: everything they render, nothing more.
function state() {
  const cutoff = E.addDays(E.todayISO(), -400);
  const others = db.log.filter(x => x.action !== 'bin').slice(-60);
  const bins = db.log.filter(x => x.action === 'bin' && x.date >= cutoff);
  const log = [...bins, ...others].sort((a, b) => a.ts.localeCompare(b.ts));
  const { rem, ...d } = derived;
  return { rev, version: VERSION, db: { ...db, log }, derived: d };
}

/* ---------- http ---------- */
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.webmanifest': 'application/manifest+json', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.txt': 'text/plain; charset=utf-8' };
const SECURITY = {
  'Content-Security-Policy': "default-src 'self'; img-src 'self' data: blob:; media-src 'self' blob:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Permissions-Policy': 'camera=(self), microphone=(), geolocation=()'
};

// Static files are read once, gzipped once and served from memory with ETags.
const files = new Map();
(function walk(dir) {
  for (const f of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, f.name);
    if (f.isDirectory()) { walk(full); continue; }
    const body = fs.readFileSync(full);
    const type = TYPES[path.extname(full)] || 'application/octet-stream';
    files.set('/' + path.relative(PUBLIC, full).split(path.sep).join('/'), {
      body, type, gz: /^(text|application\/(json|manifest)|image\/svg)/.test(type) ? zlib.gzipSync(body, { level: 9 }) : null,
      etag: '"' + crypto.createHash('sha1').update(body).digest('base64url').slice(0, 16) + '"'
    });
  }
})(PUBLIC);

const gzipOk = req => /\bgzip\b/.test(req.headers['accept-encoding'] || '');
function send(req, res, code, obj) {
  const body = Buffer.from(JSON.stringify(obj));
  const h = { ...SECURITY, 'Content-Type': 'application/json', 'Cache-Control': 'no-store', Vary: 'Accept-Encoding' };
  if (body.length > 1024 && gzipOk(req)) { h['Content-Encoding'] = 'gzip'; res.writeHead(code, h); return res.end(zlib.gzipSync(body)); }
  res.writeHead(code, h); res.end(body);
}
function sendFile(req, res, p) {
  const f = files.get(p) || files.get('/index.html');
  const h = { ...SECURITY, 'Content-Type': f.type, ETag: f.etag, Vary: 'Accept-Encoding',
    'Cache-Control': p.startsWith('/vendor/') || p.startsWith('/icons/') ? 'public, max-age=604800' : 'no-cache' };
  if (req.headers['if-none-match'] === f.etag) { res.writeHead(304, h); return res.end(); }
  if (f.gz && gzipOk(req)) { h['Content-Encoding'] = 'gzip'; res.writeHead(200, h); return res.end(f.gz); }
  res.writeHead(200, h); res.end(f.body);
}
function body(req) {
  return new Promise((ok, fail) => {
    const chunks = []; let size = 0;
    req.on('data', c => { size += c.length; if (size > 1e6) { fail(new Bad('Too large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => { try { ok(chunks.length ? JSON.parse(Buffer.concat(chunks)) : {}); } catch { fail(new Bad('Bad JSON')); } });
    req.on('error', fail);
  });
}

// Only answer on home-network or Tailscale names (stops DNS-rebinding attacks from web pages).
function hostOk(req) {
  const h = String(req.headers.host || '').toLowerCase().replace(/:\d+$/, '').replace(/^\[|\]$/g, '');
  return !h || EXTRA_HOSTS.includes(h) || /^[\d.]+$/.test(h) || h.includes(':') || !h.includes('.') ||
    /\.(local|lan|home|internal|home\.arpa|ts\.net)$/.test(h);
}
// Writes must come from the app itself: JSON body (forces a CORS preflight) and, if sent, our own Origin.
function sameOrigin(req) {
  if (!/^application\/json\b/.test(req.headers['content-type'] || '')) return false;
  const o = req.headers.origin; if (!o) return true;
  try { return new URL(o).host === req.headers.host; } catch { return false; }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  try {
    if (!hostOk(req)) return send(req, res, 421, { error: 'Unknown host. Add it to ALLOWED_HOSTS.' });
    if (url.pathname === '/api/health') return send(req, res, 200, { ok: true, version: VERSION });
    if (url.pathname === '/api/state' && req.method === 'GET') { refresh(); return send(req, res, 200, state()); }
    if (url.pathname === '/api/events') {
      res.writeHead(200, { ...SECURITY, 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
      res.write(`retry: 3000\nevent: change\ndata: ${rev}\n\n`);
      clients.add(res);
      const ping = setInterval(() => res.write(': ping\n\n'), 25000);
      req.on('close', () => { clearInterval(ping); clients.delete(res); });
      return;
    }
    if (req.method === 'POST' && (url.pathname === '/api/action' || url.pathname === '/api/suggest')) {
      if (!sameOrigin(req)) return send(req, res, 403, { error: 'Forbidden' });
      const a = await body(req);
      if (url.pathname === '/api/suggest') {
        const wk = date(a.week);
        return send(req, res, 200, { picks: E.suggest(db, E.todayISO(), wk && wk === E.monday(wk) ? wk : E.monday(E.todayISO())) });
      }
      need(a && typeof a.type === 'string' && Object.hasOwn(actions, a.type), 'Unknown action');
      refresh(); // make sure derived data matches the current day before acting
      const userId = db.users.some(u => u.id === a.userId) ? a.userId : null;
      const result = actions[a.type](a, userId) || {};
      refresh(true);
      broadcast();
      return send(req, res, 200, { ok: true, result, ...state() });
    }
    if (url.pathname === '/api/export' && req.method === 'GET') {
      res.writeHead(200, { ...SECURITY, 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'Content-Disposition': `attachment; filename="miseenplace-${E.todayISO()}.json"` });
      return res.end(JSON.stringify(db, null, 1));
    }
    if (url.pathname.startsWith('/api/')) return send(req, res, 404, { error: 'Not found' });
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(req, res, 405, { error: 'Method not allowed' });
    return sendFile(req, res, url.pathname === '/' ? '/index.html' : url.pathname);
  } catch (err) {
    if (err instanceof Bad) return send(req, res, 400, { error: err.message });
    console.error(err); send(req, res, 500, { error: 'Server error' });
  }
});

refresh(true);
// Re-check once an hour so carry-over and expiry-driven shopping items happen even when nobody is using the app.
setInterval(() => { if (refresh()) broadcast(); }, 3600e3).unref();
for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => { for (const r of clients) r.end(); server.close(() => process.exit(0)); setTimeout(() => process.exit(0), 2000).unref(); });
server.listen(PORT, () => console.log(`Mise en Place ${VERSION} on :${PORT}, data in ${DATA_DIR}`));
