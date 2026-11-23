'use strict';
{
/* ---------- basics ---------- */
const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const LS = { get(k) { try { return JSON.parse(localStorage.getItem('mep.' + k)); } catch { return null; } }, set(k, v) { try { localStorage.setItem('mep.' + k, JSON.stringify(v)); } catch {} } };
let ST = LS.get('state');           // last known server state (also used offline)
let me = LS.get('user');            // this phone's user id
let lang = LS.get('lang') || ((navigator.language || 'nl').startsWith('en') ? 'en' : 'nl');
const UI = { week: null, pantryFilter: 'all', pantryQ: '', recipeQ: '', picks: null, wasteMonth: null };

const t = (s, v) => { let o = (window.I18N[lang] || {})[s] ?? (lang === 'en' ? (window.I18N.en_[s] ?? s) : s); if (v) for (const k in v) o = o.split('{' + k + '}').join(v[k]); return o; };
const locale = () => lang === 'nl' ? 'nl-BE' : 'en-GB';
const nf = n => new Intl.NumberFormat(locale(), { maximumFractionDigits: 2 }).format(n);

/* ---------- dates ---------- */
const parse = s => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };
const isoD = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const addDays = (s, n) => { const d = parse(s); d.setDate(d.getDate() + n); return isoD(d); };
const diff = (a, b) => Math.round((parse(b) - parse(a)) / 864e5);
const today = () => ST ? ST.derived.today : isoD(new Date());
const fmtD = (s, o) => parse(s).toLocaleDateString(locale(), o || { day: 'numeric', month: 'short' });
function rel(bb) {
  if (!bb) return '';
  const d = diff(today(), bb);
  if (d < 0) return d === -1 ? t('yesterday') : t('{n} days ago', { n: -d });
  if (d === 0) return t('today'); if (d === 1) return t('tomorrow');
  if (d < 7) return fmtD(bb, { weekday: 'long' });
  return fmtD(bb, d > 300 ? { day: 'numeric', month: 'short', year: 'numeric' } : undefined);
}
const bbState = bb => { if (!bb) return 'none'; const d = diff(today(), bb); return d < 0 ? 'past' : d <= 3 ? 'soon' : 'ok'; };

/* ---------- lookups & formatting ---------- */
let IX = { p: new Map(), r: new Map(), l: new Map(), u: new Map() };
const index = () => { IX = { p: new Map(ST.db.products.map(x => [x.id, x])), r: new Map(ST.db.recipes.map(x => [x.id, x])), l: new Map(ST.db.locations.map(x => [x.id, x])), u: new Map(ST.db.users.map(x => [x.id, x])) }; };
const P = id => IX.p.get(id);
const R = id => IX.r.get(id);
const Lc = id => IX.l.get(id);
const locName = l => l ? (l.name || t(l.key)) : '?';
const pName = id => (P(id) || {}).name || '?';
const UNITS = ['pcs', 'g', 'kg', 'ml', 'l', 'pack', 'tin', 'jar', 'bag', 'bottle'];
const uLabel = (u, q) => t('u.' + u + (q !== undefined && q !== 1 && Engine.SUB_UNITS.includes(u) ? '.pl' : ''));
function fq(q, u) {
  q = Number(q) || 0;
  if (Engine.SUB_UNITS.includes(u)) return nf(q) + ' ' + uLabel(u, q);
  if (u === 'g' && q >= 1000) return nf(q / 1000) + ' kg';
  if (u === 'ml' && q >= 1000) return nf(q / 1000) + ' l';
  return nf(q) + ' ' + uLabel(u);
}
// Stock amounts: a part-used garlic bulb shows as "1 pcs + 7 cloves" instead of "1.7 pcs".
function fqP(qty, p) {
  if (!p || !p.subUnit || !(p.subCount > 0) || Number.isInteger(qty)) return fq(qty, p ? p.unit : 'pcs');
  const whole = Math.floor(qty + 1e-9), rest = Math.round((qty - whole) * p.subCount);
  return (whole ? fq(whole, p.unit) + ' + ' : '') + fq(rest, p.subUnit);
}
// Shopping amounts in whole packs: "2 × 500 g"; plain amount when the pack size is 1.
function packs(p, qty) {
  const ps = p.packSize || 1;
  if (ps === 1) return fq(Engine.COUNTED.includes(p.unit) ? Math.ceil(qty - 1e-9) : qty, p.unit); // you can't buy 0.3 of a bulb
  return `${Math.ceil(qty / ps - 1e-9)} × ${fq(ps, p.unit)}`;
}
const userName = id => (IX.u.get(id) || {}).name || '';

/* ---------- server ---------- */
// Actions run one after another, so quick taps are queued instead of lost.
let queue = Promise.resolve();
function act(type, data = {}) { const run = queue.then(() => send(type, data)); queue = run.catch(() => {}); return run; }
async function send(type, data) {
  try {
    const r = await fetch('/api/action', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ type, userId: me, ...data }) });
    const j = await r.json().catch(() => ({ error: 'Server error' }));
    if (!r.ok) { toast(t(j.error || 'Server error')); return null; }
    apply(j); return j.result || {};
  } catch { toast(t("Can't reach the server")); return null; }
}
function apply(j) { ST = { rev: j.rev, version: j.version, db: j.db, derived: j.derived }; index(); LS.set('state', ST); setOffline(false); render(); }
async function load() {
  try { const r = await fetch('/api/state', { cache: 'no-store' }); if (!r.ok) throw 0; apply(await r.json()); }
  catch { setOffline(true); if (ST) render(); }
}
function setOffline(off) { const o = $('#offline'); o.hidden = !off; o.textContent = t('Offline — showing the last known state. Changes need a connection.'); }
let es;
function live() {
  try { es && es.close(); } catch {}
  es = new EventSource('/api/events');
  es.addEventListener('change', e => { if (!ST || String(ST.rev) !== e.data) load(); });
  // onopen also reloads: covers changes made while this phone was disconnected
  es.onerror = () => setOffline(true);
  es.onopen = () => { setOffline(false); load(); };
}
document.addEventListener('visibilitychange', () => { if (!document.hidden) load(); });

/* ---------- ui helpers ---------- */
let tT;
function toast(msg) { const el = $('#toast'); el.textContent = msg; el.classList.add('on'); clearTimeout(tT); tT = setTimeout(() => el.classList.remove('on'), 3500); }
const dlg = $('#dlg');
function openDlg(html, onSave, ok = t('Save'), extraBtn = '', cls = '') {
  dlg.className = cls;
  dlg.innerHTML = `<form id="dlgF" novalidate>${html}<div class="row end">${extraBtn}<button type="button" class="ghost" data-close>${t('Cancel')}</button>${ok ? `<button class="btn" type="submit">${esc(ok)}</button>` : ''}</div></form>`;
  const f = $('#dlgF');
  f.addEventListener('submit', async e => { e.preventDefault(); const keep = await onSave(new FormData(f), f); if (keep !== false) closeDlg(); });
  f.querySelector('[data-close]').onclick = closeDlg;
  try { dlg.showModal(); } catch { dlg.setAttribute('open', ''); }
  const first = f.querySelector('input:not([type=hidden]):not([type=checkbox]),select,textarea'); if (first && !('ontouchstart' in window)) first.focus();
  return f;
}
function closeDlg() { stopScan(); try { dlg.close(); } catch {} dlg.removeAttribute('open'); dlg.className = ''; }
dlg.addEventListener('close', stopScan);
const opts = (arr, v, label = x => x) => arr.map(x => `<option value="${esc(x)}" ${x === v ? 'selected' : ''}>${esc(label(x))}</option>`).join('');
const locOpts = v => ST.db.locations.map(l => `<option value="${l.id}" ${l.id === v ? 'selected' : ''}>${esc(locName(l))}${l.emergency ? ' ★' : ''}</option>`).join('');
const productList = () => `<datalist id="plist">${ST.db.products.map(p => `<option value="${esc(p.name)}">`).join('')}</datalist>`;
const byName = n => { const k = String(n || '').trim().toLowerCase(); return ST.db.products.find(p => p.name.toLowerCase() === k); };

/* ---------- render ---------- */
const VIEWS = ['menu', 'pantry', 'shop', 'recipes', 'reserve', 'more'];
const view = () => VIEWS.includes(location.hash.slice(1)) ? location.hash.slice(1) : 'menu';
function render() {
  document.documentElement.lang = lang;
  document.querySelectorAll('[data-t]').forEach(el => { el.textContent = t(el.dataset.t); });
  $('#langBtn').textContent = lang === 'nl' ? 'EN' : 'NL';
  if (!ST) { $('#view').innerHTML = `<div class="empty"><span class="spin"></span> ${t('Loading…')}</div>`; return; }
  if (!me || !ST.db.users.some(u => u.id === me)) return renderWho();
  $('#who').textContent = userName(me);
  const v = view();
  document.querySelectorAll('.tabs a').forEach(a => a.classList.toggle('on', a.dataset.tab === v));
  const D = ST.derived;
  $('#nPantry').textContent = D.soon || '';
  $('#nShop').textContent = ST.db.shopping.filter(s => !s.done).length || '';
  const em = D.emergency;
  $('#nReserve').textContent = (em.daysCovered < ST.db.settings.days || em.rotation.length || em.water < em.waterNeeded) ? '!' : '';
  ({ menu: vMenu, pantry: vPantry, shop: vShop, recipes: vRecipes, reserve: vReserve, more: vMore })[v]();
}
window.addEventListener('hashchange', () => { UI.picks = null; render(); window.scrollTo(0, 0); });

function renderWho() {
  const users = ST.db.users;
  $('#who').textContent = '';
  $('#view').innerHTML = `<h2>${t("Who's using this phone?")}</h2>
  ${users.length ? `<div class="picklist">${users.map(u => `<button data-a="pickme" data-id="${u.id}"><b>${esc(u.name)}</b><span class="meta">${u.lang.toUpperCase()}</span></button>`).join('')}</div>` : ''}
  <form id="newUser" class="card"><h3>${t('Add a person')}</h3>
  <div class="row"><input name="name" required placeholder="${t('Name')}" class="grow" style="width:auto"><select name="lang" style="width:auto">${opts(['nl', 'en'], lang, x => x === 'nl' ? 'Nederlands' : 'English')}</select><button class="btn">${t('Add')}</button></div></form>`;
  $('#newUser').onsubmit = async e => {
    e.preventDefault(); const fd = new FormData(e.target);
    const r = await act('user.add', { name: fd.get('name'), lang: fd.get('lang') });
    if (r && r.user) { me = r.user.id; lang = r.user.lang; LS.set('user', me); LS.set('lang', lang); render(); }
  };
}

/* ---------- MENU ---------- */
function weekEntries(wk) { return ST.db.plan.filter(e => e.week === wk).sort((a, b) => a.order - b.order); }
function vMenu() {
  const D = ST.derived;
  const wk = UI.week || D.week;
  const w = ST.db.weeks[wk] || { days: Array(7).fill('home'), confirmed: false };
  const ents = weekEntries(wk);
  const byDate = {}; const overflow = [];
  for (const e of ents) { const d = (D.entries[e.id] || {}).date; if (d) byDate[d] = e; else overflow.push(e); }
  const isPast = wk < D.week;
  const homeDays = w.days.filter(x => x === 'home').length;
  const missing = {};
  for (const e of ents) for (const m of (D.entries[e.id] || {}).missing || []) missing[m.productId] = (missing[m.productId] || 0) + m.qty;
  const rot = D.emergency.rotation;
  const label = wk === D.week ? t('This week') : wk === addDays(D.week, 7) ? t('Next week') : isPast ? t('Past week') : t('Week');
  let html = `<div class="weeknav"><button class="mini icon" data-a="wk" data-d="-7" aria-label="${t('Previous week')}">‹</button>
    <div class="t"><b>${label}</b><span class="meta">${fmtD(wk)} – ${fmtD(addDays(wk, 6))}</span></div>
    <button class="mini icon" data-a="wk" data-d="7" aria-label="${t('Next week')}">›</button></div>
    <div class="row tight" style="justify-content:center">${w.confirmed ? `<span class="badge b-ok">🔒 ${t('Confirmed — meals can be moved, not removed')}</span>` : `<span class="badge b-soon">${t('Draft')}</span>`}</div>`;
  if (rot.length && !isPast) html += `<div class="note sky">${t('{n} emergency items expire within {d} days. Suggestions put them on the menu so you can restock in time.', { n: rot.length, d: ST.db.settings.rotationDays })}</div>`;
  html += '<div>';
  for (let i = 0; i < 7; i++) {
    const date = addDays(wk, i), type = w.days[i];
    const e = byDate[date];
    html += `<div class="day ${date === today() ? 'today' : ''}"><div class="d"><b>${parse(date).getDate()}</b><span>${fmtD(date, { weekday: 'short' })}</span></div><div>
      <select class="type" data-a="daytype" data-i="${i}" aria-label="${t('Day type')}" ${isPast ? 'disabled' : ''}>${opts(['home', 'out', 'invited', 'leftovers'], type, x => t('day.' + x))}</select>
      ${type !== 'home' ? `<div class="nothome">${t('daynote.' + type)}</div>` : e ? mealCard(e, w) : `<div class="slot">${t('Nothing planned')}${!isPast ? `<button class="mini" data-a="addmeal">+ ${t('Meal')}</button>` : ''}</div>`}
    </div></div>`;
  }
  html += '</div>';
  if (overflow.length) html += `<div class="note bad">${t("{n} meal(s) don't fit in this week's home days. Set a day back to 'Cook at home', or they move to next week.", { n: overflow.length })}</div>${overflow.map(e => mealCard(e, w)).join('')}`;
  const mk = Object.keys(missing);
  if (mk.length) html += `<div class="note ${w.confirmed ? 'warn' : ''}"><b>${t('Missing for this week')}:</b> ${mk.map(pid => esc(pName(pid)) + (missing[pid] > 0 ? ' (' + fqP(missing[pid], P(pid)) + ')' : '')).join(', ')}<br>${w.confirmed ? t('These are on the shopping list.') : t('They go on the shopping list when you confirm the week.')}</div>`;
  if (!isPast) {
    const free = homeDays - ents.length;
    html += `<div class="row">${free > 0 ? `<button class="btn alt" data-a="suggest">${t('Suggest {n} meals', { n: free })}</button>` : ''}
      <button class="ghost" data-a="addmeal">+ ${t('Meal')}</button>
      ${ents.length > 1 ? `<button class="ghost" data-a="sortweek">${t('Sort by best-before')}</button>` : ''}
      ${!w.confirmed && ents.length ? `<button class="btn" data-a="confirm">${t('Confirm week')}</button>` : ''}</div>`;
  }
  if (UI.picks) html += picksHtml();
  $('#view').innerHTML = html;
}
function mealCard(e, w) {
  const D = ST.derived, r = R(e.recipeId) || { name: '?' }, info = D.entries[e.id] || {};
  const miss = info.missing || [], warn = info.warn || [];
  const cls = e.status === 'cooked' ? 'done' : miss.length ? 'miss' : warn.length ? 'warnm' : '';
  const rotate = (info.alloc || []).some(a => a.rotating);
  return `<div class="meal ${cls}"><div class="row tight" style="justify-content:space-between;flex-wrap:nowrap"><h3>${esc(r.name)}</h3>${e.status === 'cooked' ? `<span class="badge b-ok">✓ ${t('Cooked')}</span>` : ''}</div>
    <div>${e.carried && e.status !== 'cooked' ? `<span class="badge b-no">${t('Carried over — cook first')}</span>` : ''}${rotate ? `<span class="badge b-sky">${t('Emergency rotation')}</span>` : ''}
    ${miss.map(m => `<span class="badge b-no">${t('missing')}: ${esc(pName(m.productId))}</span>`).join('')}
    ${warn.map(x => `<span class="badge b-soon">${esc(pName(x.productId))} ${x.type === 'past' ? t('past date') : t('due {d}', { d: rel(x.bb) })}</span>`).join('')}
    ${r.mode === 'ratio' ? `<button class="mini" data-a="base" data-id="${e.id}" ${e.status !== 'planned' ? 'disabled' : ''}>${esc(fq(e.base || r.baseQty, r.baseUnit) + ' ' + pName(r.baseProductId))}</button> ` : ''}<span class="meta small">${t('{n} servings', { n: nf(Math.round(mealServings(r, e) * 10) / 10) })}</span></div>
    ${e.status === 'planned' && ST.derived.week <= e.week ? `<div class="row tight"><button class="mini icon" data-a="mv" data-id="${e.id}" data-d="-1" aria-label="${t('Earlier')}">↑</button><button class="mini icon" data-a="mv" data-id="${e.id}" data-d="1" aria-label="${t('Later')}">↓</button>
      <button class="mini" data-a="cookm" data-id="${e.id}">▶ ${t('Cook')}</button><button class="mini" data-a="cook" data-id="${e.id}">✓ ${t('Cooked')}</button>${!w.confirmed ? `<button class="mini danger" data-a="rmmeal" data-id="${e.id}">${t('Remove')}</button>` : ''}</div>` : ''}</div>`;
}
function picksHtml() {
  if (UI.picks === 'busy') return `<div class="note"><span class="spin"></span> ${t('Looking at what needs using first…')}</div>`;
  if (!UI.picks.length) return `<div class="note">${t('No suggestions: add recipes with ingredients first.')}</div>`;
  return `<form id="picks" class="card"><h3>${t('Suggestions')}</h3><p class="meta small">${t('Most urgent first. Untick what you don\'t want.')}</p>
  ${UI.picks.map((p, i) => `<label class="check" style="align-items:flex-start;padding:6px 0;border-bottom:1px solid var(--line)"><input type="checkbox" name="pick" value="${i}" checked style="margin-top:2px"><span><b>${esc((R(p.recipeId) || {}).name)}</b><br>
  <span class="small">${p.rotate ? `<span class="badge b-sky">${t('Emergency rotation')}</span>` : ''}${p.urgent.slice(0, 3).map(u => `<span class="badge b-soon">${esc(pName(u.productId))} ${rel(u.bb)}</span>`).join('')}${p.missing.length ? p.missing.map(m => `<span class="badge b-no">${t('missing')}: ${esc(pName(m))}</span>`).join('') : `<span class="badge b-ok">${t('all in stock')}</span>`}</span></span></label>`).join('')}
  <div class="row end"><button type="button" class="ghost" data-a="nopicks">${t('Close')}</button><button class="btn">${t('Add to the menu')}</button></div></form>`;
}
function addMealDlg() {
  const wk = UI.week || ST.derived.week;
  const rs = [...ST.db.recipes].sort((a, b) => a.name.localeCompare(b.name));
  if (!rs.length) { toast(t('Add a recipe first')); location.hash = 'recipes'; return; }
  const f = openDlg(`<h2>${t('Add a meal')}</h2><input type="search" id="rq" placeholder="${t('Search recipes')}">
    <div class="picklist" id="rl">${rs.map(r => `<button type="button" data-rid="${r.id}"><span>${esc(r.name)}${r.emergency ? ' <span class="badge b-sky">' + t('Emergency') + '</span>' : ''}</span><span class="meta">${nf(r.servings)}</span></button>`).join('')}</div>`, null, '');
  f.querySelector('#rq').oninput = e => { const q = e.target.value.toLowerCase(); f.querySelectorAll('#rl button').forEach(b => { b.hidden = !b.textContent.toLowerCase().includes(q); }); };
  f.querySelector('#rl').onclick = async e => { const b = e.target.closest('[data-rid]'); if (!b) return; closeDlg(); await act('plan.add', { week: wk, recipeId: b.dataset.rid }); };
}
function cookDlg(id) {
  const e = ST.db.plan.find(x => x.id === id); const info = ST.derived.entries[id] || {};
  const r = R(e.recipeId) || { name: '?', ingredients: [] };
  openDlg(`<h2>${esc(r.name)}</h2><b class="small">${t('Recipe for this meal')}</b>${linesHtml(recipeLines(r, e))}
  <p>${t('Mark as cooked? This takes these ingredients out of stock:')}</p>
  <ul>${(info.alloc || []).map(a => `<li>${esc(pName(a.productId))} — ${fqP(a.qty, P(a.productId))}</li>`).join('') || `<li class="meta">${t('nothing')}</li>`}</ul>
  ${(info.missing || []).length ? `<div class="note warn">${t('Not in stock (you used something else?)')}: ${info.missing.map(m => esc(pName(m.productId))).join(', ')}</div>` : ''}`,
  async () => { await act('plan.cook', { id }); }, t('Cooked'));
}

/* ---------- PANTRY ---------- */
function vPantry() {
  const D = ST.derived, f = UI.pantryFilter, q = UI.pantryQ.toLowerCase();
  let lots = ST.db.lots.filter(l => !q || pName(l.productId).toLowerCase().includes(q));
  const chips = [['all', t('All')], ['soon', t('Use soon')], ...ST.db.locations.map(l => [l.id, locName(l)])];
  let html = `<h2>${t('Pantry')}</h2><div class="row"><button class="btn" data-a="addstock">+ ${t('Add')}</button><button class="ghost" data-a="scan">${t('Scan barcode')}</button>
    <input type="search" id="pq" class="grow" style="width:auto" placeholder="${t('Search')}" value="${esc(UI.pantryQ)}"></div>
    <div class="chips">${chips.map(([k, l]) => `<button class="chip ${f === k ? 'on' : ''}" data-a="pf" data-k="${k}">${esc(l)}</button>`).join('')}</div>`;
  if (f === 'soon') lots = lots.filter(l => ['past', 'soon'].includes(bbState(l.bb)) && !(Lc(l.locationId) || {}).emergency);
  else if (f !== 'all') lots = lots.filter(l => l.locationId === f);
  const reservedBy = {};
  for (const [eid, info] of Object.entries(D.entries)) for (const a of info.alloc || []) (reservedBy[a.lotId] ||= []).push(eid);
  const row = l => {
    const p = P(l.productId) || { unit: 'pcs' }; const st = bbState(l.bb);
    const res = reservedBy[l.id] ? `<span class="badge b-soft">${t('planned')}</span>` : '';
    return `<div class="item st-${st}"><div><b>${esc(p.name)}</b> <span class="meta">${fqP(l.qty, p)}${f === 'all' || f === 'soon' ? ' · ' + esc(locName(Lc(l.locationId))) : ''}</span> ${res}</div>
    <div class="when">${l.bb ? (st === 'past' ? t('past') + ' · ' : '') + rel(l.bb) : `<button class="mini" data-a="editlot" data-id="${l.id}">${t('Add date')}</button>`}</div>
    <div class="acts"><button class="mini" data-a="use" data-id="${l.id}">${t('Use')}</button><button class="mini" data-a="empty" data-id="${l.id}">${t('Empty')}</button><button class="mini danger" data-a="bin" data-id="${l.id}">${t('Bin')}</button><button class="mini" data-a="editlot" data-id="${l.id}">${t('Edit')}</button></div></div>`;
  };
  if (!lots.length) html += `<div class="empty">${ST.db.lots.length ? t('Nothing here.') : t('Nothing in stock yet. Add what you buy with its best-before date and where it goes.')}</div>`;
  else if (f === 'all') {
    for (const loc of ST.db.locations) {
      const g = lots.filter(l => l.locationId === loc.id).sort(sortLots); if (!g.length) continue;
      html += `<div class="group"><span>${esc(locName(loc))}${loc.emergency ? ' ★' : ''}</span><span>${g.length}</span></div>` + g.map(row).join('');
    }
  } else html += lots.sort(sortLots).map(row).join('');
  $('#view').innerHTML = html;
  const pq = $('#pq'); pq.oninput = e => { UI.pantryQ = e.target.value; const pos = e.target.selectionStart; vPantry(); const n = $('#pq'); n.focus(); n.setSelectionRange(pos, pos); };
}
const sortLots = (a, b) => (a.bb || '9999').localeCompare(b.bb || '9999') || pName(a.productId).localeCompare(pName(b.productId));

function productFields(p = {}, prefix = '') {
  return `<div class="grid3"><label>${t('Unit')}<select name="${prefix}unit">${opts(UNITS, p.unit || 'pcs', uLabel)}</select></label>
  <label>${t('Pack size')}<input name="${prefix}packSize" type="number" step="any" min="0" inputmode="decimal" value="${esc(p.packSize ?? 1)}"></label>
  <label class="wide">${t('Minimum stock')}<input name="${prefix}min" type="number" step="any" min="0" inputmode="decimal" value="${esc(p.min ?? 0)}"></label></div>
  <div class="grid2"><label>${t('Usual place')}<select name="${prefix}locationId">${locOpts(p.locationId)}</select></label>
  <label>${t('Keep in emergency stock')}<input name="${prefix}emergencyQty" type="number" step="any" min="0" inputmode="decimal" value="${esc(p.emergencyQty ?? 0)}"></label></div>
  <div class="grid2 fields"><label>${t('Weight per piece, tin or jar (g)')}<input name="${prefix}pieceG" type="number" step="any" min="0" inputmode="decimal" value="${esc(p.pieceG || '')}" placeholder="—"></label>
  <label>${t('Grams per tablespoon')}<input name="${prefix}spoonG" type="number" step="any" min="0" inputmode="decimal" value="${esc(p.spoonG || '')}" placeholder="15"></label></div>
  <div class="grid2 fields"><label>${t('One piece splits into')}<select name="${prefix}subUnit"><option value="">—</option>${opts(Engine.SUB_UNITS, p.subUnit, u => uLabel(u, 2))}</select></label>
  <label>${t('How many in one piece')}<input name="${prefix}subCount" type="number" step="any" min="0" inputmode="decimal" value="${esc(p.subCount || '')}" placeholder="10"></label></div>
  <label class="check"><input type="checkbox" name="${prefix}water" ${p.water ? 'checked' : ''}> ${t('This is drinking water')}</label>`;
}
const readProduct = (fd, prefix = '') => ({ unit: fd.get(prefix + 'unit'), packSize: fd.get(prefix + 'packSize'), min: fd.get(prefix + 'min'), locationId: fd.get(prefix + 'locationId'), emergencyQty: fd.get(prefix + 'emergencyQty'), water: !!fd.get(prefix + 'water'), pieceG: fd.get(prefix + 'pieceG'), spoonG: fd.get(prefix + 'spoonG'), subUnit: fd.get(prefix + 'subUnit') || '', subCount: fd.get(prefix + 'subCount') });

function addStockDlg(pre = {}) {
  const p0 = pre.productId ? P(pre.productId) : null;
  const f = openDlg(`<h2>${t('Add to stock')}</h2>${productList()}
    <label>${t('Product')}<input name="name" list="plist" required autocomplete="off" value="${esc(p0 ? p0.name : '')}" placeholder="${t('e.g. Pasta')}"></label>
    <div id="newp" hidden><div class="note sky small">${t('New product — set it up once:')}</div>${productFields({ locationId: pre.locationId }, 'p_')}</div>
    <div class="grid3"><label>${t('Amount')}<input name="qty" type="number" step="any" min="0" inputmode="decimal" value="${esc(p0 ? p0.packSize || 1 : 1)}"></label>
    <label class="wide">${t('Where')}<select name="locationId">${locOpts(p0 ? p0.locationId : pre.locationId)}</select></label></div>
    <label>${t('Best before')}<input name="bb" type="date"></label>
    <input type="hidden" name="barcode" value="${esc(pre.barcode || '')}">
    ${pre.barcode ? `<p class="meta small">${t('Barcode')}: ${esc(pre.barcode)}</p>` : ''}
    <label class="check"><input type="checkbox" name="again" checked> ${t('Add another after saving')}</label>`, async fd => {
    let p = byName(fd.get('name'));
    if (!fd.get('name').trim()) { toast(t('Name required')); return false; }
    if (!p) {
      const r = await act('product.add', { name: fd.get('name'), ...readProduct(fd, 'p_'), barcodes: fd.get('barcode') ? [fd.get('barcode')] : [] });
      if (!r || !r.product) return false; p = r.product;
    }
    const ok = await act('stock.add', { productId: p.id, qty: fd.get('qty'), locationId: fd.get('locationId'), bb: fd.get('bb'), barcode: fd.get('barcode') });
    if (!ok) return false;
    toast(t('Added {x}', { x: p.name }));
    if (fd.get('again')) { setTimeout(() => addStockDlg({ locationId: fd.get('locationId') }), 50); }
  });
  const nameI = f.elements.name, newp = f.querySelector('#newp');
  const sync = () => {
    const p = byName(nameI.value); newp.hidden = !nameI.value.trim() || !!p;
    if (p) { f.elements.locationId.value = p.locationId || f.elements.locationId.value; if (!f.dataset.touched) f.elements.qty.value = p.packSize || 1; }
  };
  nameI.addEventListener('input', sync); f.elements.qty.addEventListener('input', () => { f.dataset.touched = 1; }); sync();
}
function lotDlg(id, mode) {
  const l = ST.db.lots.find(x => x.id === id); if (!l) return;
  const p = P(l.productId) || { unit: 'pcs', name: '?' };
  if (mode === 'use') {
    const sub = p.subUnit && p.subCount > 0;
    return openDlg(`<h2>${t('Use some {x}', { x: esc(p.name) })}</h2><p class="meta">${t('In stock')}: ${fqP(l.qty, p)}</p>
    <div class="grid2"><label>${t('Amount used')}<input name="qty" inputmode="decimal" value="${sub ? 1 : esc(Math.min(l.qty, ['g', 'ml'].includes(p.unit) ? 100 : 1))}"></label>
    <label>${t('Unit')}<select name="unit">${opts(sub ? [p.subUnit, p.unit] : [p.unit], sub ? p.subUnit : p.unit, u => uLabel(u, 2))}</select></label></div>`,
    async fd => { const q = parseAmt(fd.get('qty')); const c = q > 0 ? Engine.convert(q, fd.get('unit'), p) : null; if (!(c > 0)) { toast(t('Check the amount for {x}', { x: p.name })); return false; } return !!(await act('stock.use', { id, qty: c })) || false; }, t('Use'));
  }
  if (mode === 'bin') return openDlg(`<h2>${t('Bin {x}', { x: esc(p.name) })}</h2><p class="meta">${t('Logged as waste, so you can see what goes off most.')}</p>
    <label>${t('Amount')} (${uLabel(p.unit)})<input name="qty" type="number" step="any" min="0" inputmode="decimal" value="${esc(l.qty)}"></label>
    <label>${t('Why?')}<select name="reason">${opts(['off', 'past', 'mould', 'forgot', 'other'], 'off', x => t('reason.' + x))}</select></label>`,
    async fd => !!(await act('stock.bin', { id, qty: fd.get('qty'), reason: fd.get('reason') })) || false, t('Bin'));
  openDlg(`<h2>${esc(p.name)}</h2><div class="grid2"><label>${t('Amount')} (${uLabel(p.unit)})<input name="qty" type="number" step="any" min="0" inputmode="decimal" value="${esc(l.qty)}"></label>
    <label>${t('Where')}<select name="locationId">${locOpts(l.locationId)}</select></label></div>
    <label>${t('Best before')}<input name="bb" type="date" value="${esc(l.bb || '')}"></label>`,
    async fd => !!(await act('stock.update', { id, qty: fd.get('qty'), bb: fd.get('bb'), locationId: fd.get('locationId') })) || false);
}

/* barcode scanning (ZXing, bundled locally) */
let reader = null;
function stopScan() { try { reader && reader.reset(); } catch {} reader = null; }
// The barcode library (330 KB) is only loaded the first time the scanner is opened.
let zxing = null;
const loadZxing = () => zxing ||= new Promise((ok, fail) => { const s = document.createElement('script'); s.src = '/vendor/zxing.min.js'; s.onload = () => ok(window.ZXing); s.onerror = () => { zxing = null; fail(); }; document.head.append(s); });
async function scanDlg() {
  const canCam = window.isSecureContext && navigator.mediaDevices && navigator.mediaDevices.getUserMedia;
  const f = openDlg(`<h2>${t('Scan barcode')}</h2>
    ${canCam ? '<video id="cam" playsinline muted></video>' : `<div class="note warn">${t('The camera only works over HTTPS. Type the barcode instead, or open the app through its https address.')}</div>`}
    <label>${t('Or type the barcode')}<input name="code" inputmode="numeric" autocomplete="off"></label>`, fd => { const c = String(fd.get('code') || '').trim(); if (c) found(c); }, t('Use'));
  if (canCam) {
    let Z; try { Z = await loadZxing(); } catch { return toast(t('Camera not available')); }
    if (!dlg.open || !f.isConnected) return;
    reader = new Z.BrowserMultiFormatReader();
    reader.decodeFromConstraints({ video: { facingMode: 'environment' } }, f.querySelector('#cam'), res => { if (res) { const c = res.getText(); closeDlg(); found(c); } })
      .catch(() => toast(t('Camera not available')));
  }
  function found(code) {
    const p = ST.db.products.find(x => (x.barcodes || []).includes(code));
    setTimeout(() => addStockDlg(p ? { productId: p.id, barcode: code } : { barcode: code }), 60);
    if (!p) toast(t('New barcode — name the product once and it will be remembered'));
  }
}

/* ---------- SHOPPING ---------- */
function reasonText(r) {
  if (r.type === 'meal') return t('for {x}', { x: ((R(r.recipeId) || {}).name || '?') + (r.date ? ' · ' + fmtD(r.date, { weekday: 'short' }) : '') });
  if (r.type === 'min') return t('below minimum');
  if (r.type === 'emergency') return t('emergency stock');
  return '';
}
function shopLabel(s) {
  const p = s.productId && P(s.productId);
  return { name: p ? p.name : s.name, qty: p ? packs(p, s.qty) : (s.qty || '') };
}
function vShop() {
  const open = ST.db.shopping.filter(s => !s.done).sort((a, b) => shopLabel(a).name.localeCompare(shopLabel(b).name));
  const done = ST.db.shopping.filter(s => s.done);
  const row = s => { const l = shopLabel(s); return `<div class="shop ${s.done ? 'done' : ''}"><input type="checkbox" data-a="stog" data-id="${s.id}" ${s.done ? 'checked' : ''} aria-label="${esc(l.name)}">
    <div class="nm"><b>${esc(l.name)}</b><div>${(s.reasons || []).map(r => `<span class="badge ${r.type === 'emergency' ? 'b-sky' : r.type === 'meal' ? 'b-soon' : 'b-soft'}">${esc(reasonText(r))}</span>`).join('')}</div></div>
    <span class="q">${esc(l.qty)}</span>${!s.auto || s.done ? `<button class="mini icon" data-a="sdel" data-id="${s.id}" aria-label="${t('Remove')}">×</button>` : ''}</div>`; };
  $('#view').innerHTML = `<h2>${t('Shopping list')}</h2>${productList()}
  <form id="sForm" class="row"><input name="name" list="plist" required autocomplete="off" placeholder="${t('Add something…')}" class="grow" style="width:auto"><input name="qty" placeholder="${t('How much')}" style="width:110px"><button class="btn">${t('Add')}</button></form>
  <p class="meta small">${t('Items below their minimum, missing for a confirmed menu, or needed for the emergency stock are added automatically.')}</p>
  <div class="card" style="padding:2px 6px">${open.length ? open.map(row).join('') : `<div class="empty" style="border:0">${t('Nothing to buy.')}</div>`}</div>
  ${done.length ? `<div class="group"><span>${t('In the basket')}</span><span>${done.length}</span></div><div class="card" style="padding:2px 6px">${done.map(row).join('')}</div>
  <div class="row"><button class="btn alt" data-a="store">${t('Put away in the pantry')}</button><button class="ghost" data-a="clearDone">${t('Clear without storing')}</button></div>` : ''}
  <div class="row"><button class="ghost" data-a="share">${t('Share list')}</button></div>`;
  $('#sForm').onsubmit = async e => {
    e.preventDefault(); const fd = new FormData(e.target); const name = fd.get('name').trim(); if (!name) return;
    const p = byName(name); const q = fd.get('qty').trim();
    if (await act('shop.add', p ? { productId: p.id, qty: q && Number(q.replace(',', '.')) || p.packSize || 1 } : { name, qty: q })) { const n = $('#sForm'); if (n) n.elements.name.focus(); }
  };
}
function storeDlg() {
  const items = ST.db.shopping.filter(s => s.done);
  openDlg(`<h2>${t('Put away in the pantry')}</h2><p class="meta small">${t('Add best-before dates now; you can also do it later.')}</p>
  ${items.map((s, k) => {
    const p = s.productId && P(s.productId);
    const qty = p ? Math.ceil(s.qty / (p.packSize || 1) - 1e-9) * (p.packSize || 1) : (parseFloat(String(s.qty).replace(',', '.')) || 1);
    return `<div class="card"><b>${esc(shopLabel(s).name)}</b>${p ? '' : `<div class="small meta">${t('New product')}</div><select name="unit${k}">${opts(UNITS, 'pcs', uLabel)}</select>`}
    <div class="grid3" style="margin-top:6px"><label>${t('Amount')}<input name="qty${k}" type="number" step="any" min="0" inputmode="decimal" value="${esc(qty)}"></label>
    <label class="wide">${t('Where')}<select name="loc${k}">${locOpts(p ? p.locationId : '')}</select></label></div>
    <label>${t('Best before')}<input name="bb${k}" type="date"></label></div>`;
  }).join('')}`, async fd => {
    const list = items.map((s, k) => ({ id: s.id, productId: s.productId || (byName(s.name) || {}).id, newProduct: s.productId || byName(s.name) ? null : { name: s.name, unit: fd.get('unit' + k) },
      qty: fd.get('qty' + k), bb: fd.get('bb' + k), locationId: fd.get('loc' + k) }));
    if (!(await act('shop.store', { items: list }))) return false;
    toast(t('Stored {n} item(s)', { n: list.length }));
  }, t('Store'));
}
async function shareList() {
  const txt = ST.db.shopping.filter(s => !s.done).map(s => { const l = shopLabel(s); return `- ${l.name}${l.qty ? ' (' + l.qty + ')' : ''}`; }).join('\n');
  if (!txt) return toast(t('Nothing to buy.'));
  try { if (navigator.share) { await navigator.share({ title: t('Shopping list'), text: txt }); return; } } catch (e) { if (e && e.name === 'AbortError') return; }
  try { await navigator.clipboard.writeText(txt); toast(t('Copied')); } catch { openDlg(`<h2>${t('Shopping list')}</h2><textarea rows="10" readonly>${esc(txt)}</textarea>`, () => {}, ''); }
}

/* ---------- RECIPES ---------- */
const RUNITS = [...UNITS, 'tbsp', 'tsp', ...Engine.SUB_UNITS];
const SUB_DEFAULT = { clove: 10, slice: 20, stalk: 8 }; // first guess when a new product is made from a recipe
// Accepts 1.5, 1,5, 1 1/2, 3/4 and ½-style amounts.
function parseAmt(v) {
  const s = String(v ?? '').trim().replace(/,/g, '.').replace(/[½¼¾⅓⅔]/g, c => ' ' + { '½': '1/2', '¼': '1/4', '¾': '3/4', '⅓': '1/3', '⅔': '2/3' }[c]);
  if (!s) return NaN;
  let n = 0;
  for (const part of s.split(/\s+/).filter(Boolean)) {
    const m = part.match(/^(\d*\.?\d+)\/(\d*\.?\d+)$/);
    if (m) n += m[1] / m[2]; else if (/^\d*\.?\d+$/.test(part)) n += Number(part); else return NaN;
  }
  return n;
}
const amtText = n => n == null ? '' : String(Math.round(n * 1000) / 1000).replace('.', lang === 'nl' ? ',' : '.');
const ingUnit = i => i.unit || (i.productId ? (P(i.productId) || {}).unit : 'pcs') || 'pcs';
const ingName = i => i.name || pName(i.productId);
const sectionsOf = r => (r.sections && r.sections.length) ? r.sections : r.steps ? [{ title: '', steps: [{ text: r.steps, uses: [] }] }] : [];

// The full ingredient list as you'd read it while cooking, scaled to a planned meal (or the usual amount).
function recipeLines(r, e) {
  const out = [];
  if (r.mode === 'ratio') {
    const base = e && e.base > 0 ? e.base : r.baseQty;
    out.push({ name: r.baseName || pName(r.baseProductId), qty: base, unit: r.baseUnit, main: true, productId: r.baseProductId });
    for (const i of r.ingredients || []) {
      let qty = null, unit = ingUnit(i);
      if (!i.taste && i.qty > 0) {
        if (i.per === 'part') {
          qty = i.qty * base; unit = r.baseUnit;
          if (i.unit && i.unit !== unit) { const c = Engine.convert(qty, unit, { unit: i.unit }); if (c != null) { qty = c; unit = i.unit; } }
        } else if (i.per === 'per100') qty = i.qty * base / 100;
        else qty = i.qty;
      }
      out.push({ id: i.id, name: ingName(i), qty, unit, productId: i.productId, note: i.per === 'fixed' || !i.per ? i.note : '' });
    }
  } else {
    const f = ((e && e.servings) || r.servings) / (r.servings || 1);
    for (const i of r.ingredients || []) out.push({ id: i.id, name: ingName(i), qty: !i.taste && i.qty > 0 ? i.qty * f : null, unit: ingUnit(i), productId: i.productId, note: f === 1 ? i.note : '' });
  }
  return out;
}
// One step's ingredients, as a share of the full list ("1 of the 2 tomatoes, large diced").
function stepLines(r, step, e) {
  const all = new Map(recipeLines(r, e).filter(l => l.id).map(l => [l.id, l]));
  return (step.uses || []).map(u => {
    const m = (r.ingredients || []).find(i => i.id === u.iid), ml = all.get(u.iid);
    if (!m || !ml) return null;
    if (ml.qty == null || u.taste) return { ...ml, qty: null, prep: u.prep, note: '' };
    const whole = u.qty == null || !(m.qty > 0) || Math.abs(u.qty - m.qty) < 1e-9;
    return { ...ml, qty: whole ? ml.qty : ml.qty * u.qty / m.qty, note: whole ? ml.note : '', prep: u.prep };
  }).filter(Boolean);
}
function lineText(l) {
  if (l.qty == null) return `${l.name} (${t('to taste')})${l.prep ? ', ' + l.prep : ''}`;
  const p = l.productId && P(l.productId);
  let extra = '';
  if (p && l.unit !== p.unit) {
    const c = Engine.convert(l.qty, l.unit, p);
    extra = c == null ? ' ⚠' : (['tbsp', 'tsp'].includes(l.unit) || Engine.COUNTED.includes(l.unit) || (Engine.COUNTED.includes(p.unit) && !Engine.SUB_UNITS.includes(l.unit))) ? ` (≈ ${fq(Math.round(c * 10) / 10, p.unit)})` : '';
  }
  const q = Math.round(l.qty * 100) / 100;
  const amount = l.unit === 'pcs' ? nf(q) : fq(q, l.unit); // "2 tomatoes", not "2 pcs tomatoes"
  // "1 small can (160 g) white beans" when the recipe gives its own wording
  return (l.note ? `${l.note} (${amount}) ${l.name}` : `${amount} ${l.name}`) + extra + (l.prep ? ', ' + l.prep : '');
}
const linesHtml = ls => `<ul class="lines">${ls.map(l => `<li${l.main ? ' class="main"' : ''}>${esc(lineText(l))}</li>`).join('')}</ul>`;
const mealServings = (r, e) => r.mode === 'ratio' && r.baseQty ? r.servings * ((e && e.base) || r.baseQty) / r.baseQty : (e && e.servings) || r.servings;

function canMake(r) {
  const s = ST.derived.stock;
  const counted = Engine.needs(ST.db, r, null).map(i => ({ ...i, ok: ((s[i.productId] || {}).free || 0) >= i.qty }));
  const present = Engine.presence(r).map(pid => ({ productId: pid, ok: ST.db.lots.some(l => l.productId === pid && l.qty > 0) }));
  return [...counted, ...present];
}
function vRecipes() {
  const q = UI.recipeQ.toLowerCase();
  const rs = ST.db.recipes.filter(r => !q || r.name.toLowerCase().includes(q) || (r.tags || []).some(x => x.toLowerCase().includes(q)))
    .sort((a, b) => (a.emergency - b.emergency) || a.name.localeCompare(b.name));
  const em = ST.derived.emergency.madeCount;
  $('#view').innerHTML = `<h2>${t('Recipes')}</h2><div class="row"><button class="btn" data-a="recipe">+ ${t('Recipe')}</button><input type="search" id="rq2" class="grow" style="width:auto" placeholder="${t('Search')}" value="${esc(UI.recipeQ)}"></div>
  ${rs.length ? rs.map(r => { const ings = canMake(r); const all = ings.length && ings.every(i => i.ok); const steps = sectionsOf(r).reduce((n, s) => n + s.steps.length, 0);
    return `<div class="card" data-a="recipe" data-id="${r.id}" style="cursor:pointer"><div class="row tight" style="justify-content:space-between;flex-wrap:nowrap"><h3>${r.fav ? '★ ' : ''}${esc(r.name)}</h3>${all ? `<span class="badge b-ok">${t('can make now')}</span>` : ''}<button class="mini" data-a="cookr" data-id="${r.id}" aria-label="${t('Cook')}">▶ ${t('Cook')}</button></div>
    <div>${r.mode === 'ratio' ? `<span class="badge b-soon">${esc(t('Based on {x}', { x: pName(r.baseProductId) }))}</span>` : ''}${r.emergency ? `<span class="badge b-sky">${t('Emergency')} · ${t('{n}× from the reserve', { n: em[r.id] || 0 })}</span>` : ''}${r.stove ? `<span class="badge b-soft">${t('needs a stove')}</span>` : ''}${(r.tags || []).map(x => `<span class="badge b-soft">${esc(x)}</span>`).join('')}<span class="meta small">${t('{n} servings', { n: nf(r.servings) })}${steps ? ' · ' + t('{n} steps', { n: steps }) : ''}</span></div>
    <div class="small" style="margin-top:4px">${ings.map(i => `<span class="badge ${i.ok ? 'b-ok' : 'b-no'}">${esc(pName(i.productId))}</span>`).join('')}</div></div>`; }).join('')
    : `<div class="empty">${t('No recipes yet. Add the meals you cook, with their ingredients, so the app can plan and suggest.')}</div>`}`;
  $('#rq2').oninput = e => { UI.recipeQ = e.target.value; const pos = e.target.selectionStart; vRecipes(); const n = $('#rq2'); n.focus(); n.setSelectionRange(pos, pos); };
}

/* ---------- recipe builder: all ingredients first, then sections and steps that pick from them ---------- */
let B = null; // the recipe being edited
const newIid = () => 'i' + Math.random().toString(36).slice(2, 8);
function draftFrom(r) {
  return {
    id: r.id || null, name: r.name || '', servings: r.servings || ST.db.settings.people, mode: r.mode || 'fixed',
    baseName: r.baseProductId ? pName(r.baseProductId) : '', baseQty: r.baseQty || 600, baseUnit: r.baseUnit || 'g',
    tags: (r.tags || []).join(', '), fav: !!r.fav, emergency: !!r.emergency, stove: !!r.stove,
    ingredients: (r.ingredients || []).map(i => ({ id: i.id || newIid(), name: ingName(i), qtyText: i.taste ? '' : amtText(i.qty), unit: i.unit || ingUnit(i), note: i.note || '', stock: !!i.productId, per: i.per || 'fixed' })),
    sections: sectionsOf(r).map(s => ({ title: s.title || '', steps: s.steps.map(st => ({ text: st.text || '', uses: (st.uses || []).map(u => ({ iid: u.iid, qtyText: amtText(u.qty), prep: u.prep || '', taste: !!u.taste })) })) }))
  };
}
function leftOf(m) {
  const uses = B.sections.flatMap(s => s.steps.flatMap(st => st.uses.filter(u => u.iid === m.id)));
  const total = parseAmt(m.qtyText);
  if (!uses.length) return { cls: 'b-soft', text: t('not in a step') };
  if (!(total > 0)) return { cls: 'b-ok', text: '✓ ' + t('in a step') };
  const used = uses.filter(u => !u.taste).reduce((a, u) => a + (parseAmt(u.qtyText) > 0 ? parseAmt(u.qtyText) : total), 0);
  const left = Math.round((total - used) * 1000) / 1000;
  if (Math.abs(left) < 1e-9) return { cls: 'b-ok', text: '✓ ' + t('all used') };
  return left > 0 ? { cls: 'b-soon', text: t('{n} left', { n: fq(left, m.unit) }) } : { cls: 'b-no', text: t('{n} too much', { n: fq(-left, m.unit) }) };
}
function builderHtml() {
  const ratio = B.mode === 'ratio';
  const ingHtml = (m, k) => {
    const isNew = m.stock && m.name.trim() && !byName(m.name);
    return `<div class="ing" data-i="${k}">
      <input data-f="name" list="plist" autocomplete="off" placeholder="${t('Ingredient')}" value="${esc(m.name)}" aria-label="${t('Ingredient')}">
      <button type="button" class="mini icon" data-b="delIng" aria-label="${t('Remove')}">×</button>
      <input data-f="qtyText" inputmode="decimal" autocomplete="off" placeholder="${t('to taste')}" value="${esc(m.qtyText)}" aria-label="${t('Amount')}">
      <select data-f="unit" aria-label="${t('Unit')}">${opts(RUNITS, m.unit || 'pcs', u => uLabel(u, 2))}</select>
      ${ratio ? `<select data-f="per" aria-label="${t('How')}">${opts(['fixed', 'part', 'per100'], m.per, x => x === 'per100' ? t('per 100 {u} main ingredient', { u: uLabel(B.baseUnit) }) : x === 'part' ? t('parts') : t('fixed amount'))}</select>` : ''}
      <input data-f="note" autocomplete="off" placeholder="${t('as written, e.g. 1 small can')}" value="${esc(m.note)}" aria-label="${t('As written in the recipe')}">
      <div class="ingfoot"><label class="check small"><input type="checkbox" data-f="stock" ${m.stock ? 'checked' : ''}> ${t('from stock')}</label>${isNew ? `<span class="badge b-sky">${t('new product')}</span>` : ''}<span class="badge left ${leftOf(m).cls}" data-left="${m.id}">${esc(leftOf(m).text)}</span></div></div>`;
  };
  const useHtml = (u, si, ti, ui) => {
    const m = B.ingredients.find(x => x.id === u.iid) || { name: '?', unit: 'pcs', qtyText: '' };
    const taste = !(parseAmt(m.qtyText) > 0);
    return `<div class="use" data-u="${si}.${ti}.${ui}"><b>${esc(m.name)}</b>
      ${taste ? `<span class="meta small">${t('to taste')}</span>` : `${u.taste ? '' : `<input data-uf="qtyText" inputmode="decimal" autocomplete="off" placeholder="${esc(t('all ({x})', { x: fq(parseAmt(m.qtyText), m.unit) }))}" value="${esc(u.qtyText)}" aria-label="${t('Amount')}"><span class="meta small">${esc(uLabel(m.unit, 2))}</span>`}
        <label class="check small"><input type="checkbox" data-uf="taste" ${u.taste ? 'checked' : ''}> ${t('to taste')}</label>`}
      <input data-uf="prep" autocomplete="off" placeholder="${t('e.g. large diced')}" value="${esc(u.prep)}" aria-label="${t('Preparation')}">
      <button type="button" class="mini icon" data-b="delUse" aria-label="${t('Remove')}">×</button></div>`;
  };
  const addUse = (si, ti) => `<select class="adduse" data-b="addUse" data-st="${si}.${ti}" aria-label="${t('Add an ingredient to this step')}"><option value="">+ ${t('ingredient from the list')}…</option>${B.ingredients.filter(m => m.name.trim()).map(m => `<option value="${m.id}">${esc(m.name)} · ${esc(leftOf(m).text)}</option>`).join('')}</select>`;
  let n = 0;
  return `<div class="bhead"><input data-r="name" class="bname" placeholder="${t('Recipe name')}" value="${esc(B.name)}" aria-label="${t('Name')}">
    <details class="paste"><summary>${t('Paste a recipe')}</summary><p class="meta small">${t('Paste the full text: title, all ingredients, then each section with its ingredients and steps. You can check everything before saving.')}</p>
    <textarea id="pasteT" rows="8" placeholder="${t('Soup au pistou…')}"></textarea><div class="row end"><button type="button" class="btn alt" data-b="parse">${t('Fill in')}</button></div></details>
    <div class="grid2 fields"><label>${ratio ? t('Servings for the usual amount') : t('Servings')}<input data-r="servings" type="number" min="1" inputmode="numeric" value="${esc(B.servings)}"></label>
    <label class="check" style="align-self:end"><input type="checkbox" data-r="ratio" ${ratio ? 'checked' : ''}> ${t('Amounts depend on one main ingredient')}</label></div>
    ${ratio ? `<div class="grid3 fields"><label>${t('Main ingredient')}<input data-r="baseName" list="plist" autocomplete="off" value="${esc(B.baseName)}"></label><label>${t('Usual amount')}<input data-r="baseQty" inputmode="decimal" value="${esc(amtText(B.baseQty))}"></label><label>${t('Unit')}<select data-r="baseUnit">${opts(['g', 'kg', 'pcs', 'ml', 'l'], B.baseUnit, uLabel)}</select></label></div>` : ''}</div>
  <h3 class="bsec">${t('All ingredients')}</h3><p class="meta small">${t('Leave the amount empty for “to taste”. Amounts like 1 1/2 or 1,5 work.')}</p>
  <div class="ings">${B.ingredients.map(ingHtml).join('')}</div><button type="button" class="mini" data-b="addIng">+ ${t('Ingredient')}</button>
  <h3 class="bsec">${t('Steps')}</h3>
  ${B.sections.map((s, si) => `<section class="sec" data-s="${si}"><div class="row tight"><input data-sf="title" class="grow" style="width:auto" placeholder="${t('Section, e.g. For the soup')}" value="${esc(s.title)}"><button type="button" class="mini icon" data-b="delSec" aria-label="${t('Remove')}">×</button></div>
    ${s.steps.map((st, ti) => `<div class="step" data-st="${si}.${ti}"><div class="row tight"><b class="grow">${t('Step {n}', { n: ++n })}</b><button type="button" class="mini icon" data-b="stepUp" aria-label="${t('Earlier')}">↑</button><button type="button" class="mini icon" data-b="stepDown" aria-label="${t('Later')}">↓</button><button type="button" class="mini icon" data-b="delStep" aria-label="${t('Remove')}">×</button></div>
      ${st.uses.map((u, ui) => useHtml(u, si, ti, ui)).join('')}${addUse(si, ti)}
      <textarea data-tf="text" rows="3" placeholder="${t('What to do, e.g. Simmer for 50 minutes')}">${esc(st.text)}</textarea></div>`).join('')}
    <button type="button" class="mini" data-b="addStep" data-s="${si}">+ ${t('Step')}</button></section>`).join('')}
  <button type="button" class="mini" data-b="addSec">+ ${t('Section')}</button>
  <details class="more"><summary>${t('More')}</summary>
    <label>${t('Tags')}<input data-r="tags" value="${esc(B.tags)}" placeholder="${t('e.g. quick, vegetarian')}"></label>
    <label class="check"><input type="checkbox" data-r="fav" ${B.fav ? 'checked' : ''}> ${t('Favourite')}</label>
    <label class="check"><input type="checkbox" data-r="emergency" ${B.emergency ? 'checked' : ''}> ${t('Emergency meal (made from the reserve)')}</label>
    <label class="check"><input type="checkbox" data-r="stove" ${B.stove ? 'checked' : ''}> ${t('Needs cooking (camping stove in an emergency)')}</label></details>`;
}
function recipeDlg(id, preset = {}) {
  B = draftFrom(id ? R(id) : { ...preset });
  if (!B.ingredients.length) B.ingredients.push({ id: newIid(), name: '', qtyText: '', unit: 'pcs', note: '', stock: true, per: 'fixed' });
  if (!B.sections.length) B.sections.push({ title: '', steps: [{ text: '', uses: [] }] });
  const f = openDlg(`${productList()}<div id="bld"></div>`, saveRecipe, t('Save'),
    id ? `<button type="button" class="ghost" data-b="delRecipe" style="margin-right:auto;color:var(--red)">${t('Delete')}</button>` : '', 'full builder');
  const draw = () => { const y = dlg.scrollTop; $('#bld').innerHTML = builderHtml(); dlg.scrollTop = y; };
  const refreshLeft = () => {
    for (const m of B.ingredients) { const el = f.querySelector(`[data-left="${m.id}"]`); if (el) { const l = leftOf(m); el.className = 'badge left ' + l.cls; el.textContent = l.text; } }
  };
  f.addEventListener('input', e => {
    const el = e.target, d = el.dataset;
    if (d.r) { B[d.r] = el.type === 'checkbox' ? el.checked : el.value; if (d.r === 'ratio') { B.mode = el.checked ? 'ratio' : 'fixed'; draw(); } if (d.r === 'baseQty') B.baseQty = parseAmt(el.value); return; }
    if (d.f) { const m = B.ingredients[+el.closest('[data-i]').dataset.i]; m[d.f] = el.type === 'checkbox' ? el.checked : el.value;
      if (d.f === 'name') { const p = m.stock && byName(el.value); if (p) { m.unit = p.unit; el.closest('.ing').querySelector('[data-f=unit]').value = p.unit; } }
      refreshLeft(); return; }
    if (d.sf) { B.sections[+el.closest('[data-s]').dataset.s].title = el.value; return; }
    if (d.tf) { const [si, ti] = el.closest('[data-st]').dataset.st.split('.').map(Number); B.sections[si].steps[ti].text = el.value; return; }
    if (d.uf) { const [si, ti, ui] = el.closest('[data-u]').dataset.u.split('.').map(Number); const u = B.sections[si].steps[ti].uses[ui];
      if (d.uf === 'taste') { u.taste = el.checked; draw(); return; }
      u[d.uf] = el.value; refreshLeft(); }
  });
  f.addEventListener('change', e => {
    const el = e.target;
    if (el.dataset.b === 'addUse' && el.value) {
      const [si, ti] = el.dataset.st.split('.').map(Number), m = B.ingredients.find(x => x.id === el.value);
      const total = parseAmt(m.qtyText), l = leftOf(m);
      const used = B.sections.flatMap(s => s.steps.flatMap(st => st.uses.filter(u => u.iid === m.id && !u.taste))).reduce((a, u) => a + (parseAmt(u.qtyText) > 0 ? parseAmt(u.qtyText) : total), 0);
      const rest = total > 0 && l.cls === 'b-soon' ? total - used : null; // only what's left, or the whole amount
      B.sections[si].steps[ti].uses.push({ iid: m.id, qtyText: rest != null && rest < total ? amtText(rest) : '', prep: '' });
      draw();
    }
    if (['unit', 'per', 'stock'].includes(el.dataset.f) || el.dataset.r === 'baseUnit') draw();
  });
  f.addEventListener('click', async e => {
    const b = e.target.closest('[data-b]'); if (!b || b.tagName === 'SELECT') return;
    const k = b.dataset.b, i = b.closest('[data-i]'), sec = b.closest('[data-s]'), st = b.closest('[data-st]');
    const [si, ti] = st ? st.dataset.st.split('.').map(Number) : [sec ? +sec.dataset.s : 0, 0];
    if (k === 'addIng') B.ingredients.push({ id: newIid(), name: '', qtyText: '', unit: 'pcs', note: '', stock: true, per: B.mode === 'ratio' ? 'part' : 'fixed' });
    if (k === 'delIng') { const id = B.ingredients[+i.dataset.i].id; B.ingredients.splice(+i.dataset.i, 1); B.sections.forEach(s => s.steps.forEach(x => { x.uses = x.uses.filter(u => u.iid !== id); })); }
    if (k === 'delUse') { const [a, c, u] = b.closest('[data-u]').dataset.u.split('.').map(Number); B.sections[a].steps[c].uses.splice(u, 1); }
    if (k === 'addStep') B.sections[+b.dataset.s].steps.push({ text: '', uses: [] });
    if (k === 'delStep') { B.sections[si].steps.splice(ti, 1); }
    if (k === 'stepUp' || k === 'stepDown') { const arr = B.sections[si].steps, j = ti + (k === 'stepUp' ? -1 : 1); if (j >= 0 && j < arr.length) [arr[ti], arr[j]] = [arr[j], arr[ti]]; }
    if (k === 'addSec') B.sections.push({ title: '', steps: [{ text: '', uses: [] }] });
    if (k === 'delSec') B.sections.splice(+sec.dataset.s, 1);
    if (k === 'parse') {
      const r = RecipeText.parseRecipe($('#pasteT').value);
      if (!r.ingredients.length && !r.sections.length) { toast(t('Nothing recognised in that text')); return; }
      B.name = B.name || r.name;
      B.ingredients = r.ingredients.map(m => { const p = m.stock && byName(m.name); return { id: m.id, name: m.name, qtyText: amtText(m.qty), unit: m.unit || (p ? p.unit : 'pcs'), note: m.note, stock: m.stock, per: 'fixed' }; });
      B.sections = r.sections.map(s => ({ title: s.title, steps: s.steps.map(x => ({ text: x.text, uses: x.uses.map(u => ({ iid: u.iid, qtyText: amtText(u.qty), prep: u.prep, taste: u.taste })) })) }));
      if (!B.sections.length) B.sections.push({ title: '', steps: [{ text: r.intro, uses: [] }] });
      toast(t('Filled in — check the ingredients and steps, then save'));
    }
    if (k === 'delRecipe') { if (b.dataset.sure) { if (await act('recipe.delete', { id: B.id })) closeDlg(); } else { b.dataset.sure = 1; b.textContent = t('Tap again to delete'); } return; }
    draw();
  });
  draw();
}
async function saveRecipe() {
  const name = B.name.trim(); if (!name) { toast(t('Name required')); return false; }
  const ratio = B.mode === 'ratio';
  const ensure = async (n, unit) => byName(n) || ((await act('product.add', Engine.SUB_UNITS.includes(unit)
    ? { name: n, unit: 'pcs', subUnit: unit, subCount: SUB_DEFAULT[unit] } // "3 cloves" → a garlic bulb of ~10 cloves
    : { name: n, unit: UNITS.includes(unit) ? unit : 'g' })) || {}).product;
  let baseP = null;
  if (ratio) {
    if (!B.baseName.trim()) { toast(t('Choose the main ingredient')); return false; }
    if (!(B.baseQty > 0)) { toast(t('Check the amount for {x}', { x: B.baseName })); return false; }
    baseP = await ensure(B.baseName.trim(), B.baseUnit); if (!baseP) return false;
  }
  const ingredients = [];
  for (const m of B.ingredients) {
    const n = m.name.trim(); if (!n) continue;
    const qty = parseAmt(m.qtyText), taste = !m.qtyText.trim();
    if (!taste && !(qty > 0)) { toast(t('Check the amount for {x}', { x: n })); return false; }
    const per = ratio ? m.per : 'fixed';
    let productId = null;
    if (m.stock) {
      const p = await ensure(n, per === 'part' ? B.baseUnit : m.unit); if (!p) return false;
      // never drop an amount silently: it must convert to how the product is stocked
      if (!taste && Engine.convert(1, per === 'part' ? B.baseUnit : m.unit, p) == null) { toast(t("{x} can't be converted: set its weight per piece (More → Products)", { x: n })); return false; }
      productId = p.id;
    }
    ingredients.push({ id: m.id, productId, name: n, qty: taste ? null : qty, taste, unit: m.unit, note: m.note.trim(), per });
  }
  const ids = new Set(ingredients.map(i => i.id));
  const sections = B.sections.map(s => ({ title: s.title.trim(), steps: s.steps.map(st => ({ text: st.text.trim(),
    uses: st.uses.filter(u => ids.has(u.iid)).map(u => { const m = ingredients.find(i => i.id === u.iid); const q = parseAmt(u.qtyText); return { iid: u.iid, qty: !u.taste && q > 0 ? q : null, unit: m.unit, prep: u.prep.trim(), taste: !!u.taste && !m.taste }; }) })) }));
  const data = { name, servings: B.servings, ingredients, sections, tags: B.tags.split(',').map(x => x.trim()).filter(Boolean),
    fav: !!B.fav, emergency: !!B.emergency, stove: !!B.stove, mode: ratio ? 'ratio' : 'fixed', baseProductId: baseP && baseP.id, baseUnit: B.baseUnit, baseQty: B.baseQty };
  return !!(await act(B.id ? 'recipe.update' : 'recipe.add', B.id ? { id: B.id, ...data } : data)) || false;
}

/* ---------- cook mode: one step at a time ---------- */
let C = null, wake = null, tick = null;
const DURATION = /(\d+(?:[.,]\d+)?)\s*(minutes?|minuten|minuut|min\.?|hours?|uur|uren)\b/gi;
function cookPages(r) {
  const pages = [{ kind: 'mise' }];
  for (const s of sectionsOf(r)) s.steps.forEach((st, i) => pages.push({ kind: 'step', section: s.title, step: st, first: i === 0 }));
  pages.push({ kind: 'done' });
  return pages;
}
async function keepAwake() { try { if (navigator.wakeLock && C) wake = await navigator.wakeLock.request('screen'); } catch {} }
function beep() {
  try { navigator.vibrate && navigator.vibrate([400, 150, 400, 150, 400]); } catch {}
  try {
    const ac = new (window.AudioContext || window.webkitAudioContext)();
    [0, 0.35, 0.7].forEach(s => { const o = ac.createOscillator(), g = ac.createGain(); o.frequency.value = 880; g.gain.value = 0.25; o.connect(g); g.connect(ac.destination); o.start(ac.currentTime + s); o.stop(ac.currentTime + s + 0.22); });
    setTimeout(() => ac.close(), 1500);
  } catch {}
}
function openCook(recipeId, entryId) {
  const r = R(recipeId); if (!r) return;
  const e = entryId ? ST.db.plan.find(x => x.id === entryId) : null;
  C = { r, e, scale: e ? { ...e } : { servings: r.servings, base: r.baseQty }, page: 0, pages: cookPages(r), ticked: new Set(), timers: [] };
  dlg.className = 'full cookmode';
  dlg.innerHTML = `<div class="cook"><header><b class="grow">${esc(r.name)}</b><span id="cookN" class="meta"></span><button type="button" class="mini icon" data-c="close" aria-label="${t('Close')}">×</button></header>
    <div id="cookBody" class="cookbody"></div><div id="cookTimers" class="timers"></div>
    <footer><button type="button" class="ghost" data-c="prev">‹ ${t('Back')}</button><button type="button" class="btn" data-c="next"></button></footer></div>`;
  try { dlg.showModal(); } catch { dlg.setAttribute('open', ''); }
  keepAwake(); drawCook();
  clearInterval(tick); tick = setInterval(drawTimers, 1000);
}
function drawCook() {
  const { r, page, pages } = C, pg = pages[page], e = C.scale;
  $('#cookN').textContent = page && page < pages.length - 1 ? t('Step {n} of {m}', { n: page, m: pages.length - 2 }) : '';
  let h = '';
  if (pg.kind === 'mise') {
    const lines = recipeLines(r, e);
    h = `<h2>${t('Mise en place')}</h2><p class="meta">${t('Put everything ready. Tick what you have out.')}</p>
      ${C.e ? `<p class="meta">${t('{n} servings', { n: nf(Math.round(mealServings(r, e) * 10) / 10) })}</p>` : r.mode === 'ratio'
        ? `<label class="row tight">${esc(pName(r.baseProductId))} (${uLabel(r.baseUnit)})<input id="cookBase" inputmode="decimal" style="width:110px" value="${esc(amtText(e.base))}"></label>`
        : `<div class="row tight"><button type="button" class="mini icon" data-c="less">−</button><b>${t('{n} servings', { n: nf(e.servings) })}</b><button type="button" class="mini icon" data-c="more">+</button></div>`}
      <div class="miselist">${lines.map((l, i) => `<label class="check big"><input type="checkbox" data-c="tick" data-k="${i}" ${C.ticked.has(i) ? 'checked' : ''}> <span>${esc(lineText(l))}</span></label>`).join('')}</div>`;
  } else if (pg.kind === 'step') {
    const ls = stepLines(r, pg.step, e);
    const durs = [...(pg.step.text || '').matchAll(DURATION)].map(m => ({ label: m[0], sec: Math.round(parseFloat(m[1].replace(',', '.')) * (/^(h|u)/i.test(m[2]) ? 3600 : 60)) }));
    h = `${pg.section ? `<p class="sectitle">${esc(pg.section)}</p>` : ''}
      ${ls.length ? `<ul class="steplist">${ls.map(l => `<li>${esc(lineText(l))}</li>`).join('')}</ul>` : ''}
      <p class="steptext">${esc(pg.step.text || '').replace(/\n/g, '<br>')}</p>
      ${durs.map(d => `<button type="button" class="btn alt" data-c="timer" data-s="${d.sec}" data-l="${esc(d.label)}">⏱ ${esc(d.label)}</button>`).join(' ')}`;
  } else {
    const planned = C.e && C.e.status === 'planned' && ST.db.plan.some(x => x.id === C.e.id && x.status === 'planned');
    h = `<h2>${t('Enjoy your meal!')}</h2>${planned ? `<p>${t('Mark as cooked? This takes these ingredients out of stock:')}</p>
      <ul>${((ST.derived.entries[C.e.id] || {}).alloc || []).map(a => `<li>${esc(pName(a.productId))} — ${fqP(a.qty, P(a.productId))}</li>`).join('') || `<li class="meta">${t('nothing')}</li>`}</ul>
      <button type="button" class="btn" data-c="cooked">✓ ${t('Cooked')}</button>` : ''}`;
  }
  $('#cookBody').innerHTML = h; $('#cookBody').scrollTop = 0;
  const nb = dlg.querySelector('[data-c=next]'); nb.textContent = page === pages.length - 1 ? t('Close') : page === pages.length - 2 ? t('Finish') + ' ›' : t('Next') + ' ›';
  dlg.querySelector('[data-c=prev]').disabled = page === 0;
  const cb = $('#cookBase'); if (cb) cb.oninput = () => { const b = parseAmt(cb.value); if (b > 0) { C.scale.base = b; const pos = cb.selectionStart; drawCook(); const n = $('#cookBase'); n.focus(); n.setSelectionRange(pos, pos); } };
  drawTimers();
}
function drawTimers() {
  if (!C) return;
  const now = Date.now();
  for (const tm of C.timers) if (!tm.done && tm.end <= now) { tm.done = true; beep(); toast(t('Timer done: {x}', { x: tm.label })); }
  const el = $('#cookTimers'); if (!el) return;
  el.innerHTML = C.timers.map((tm, i) => { const s = Math.max(0, Math.round((tm.end - now) / 1000)); return `<button type="button" class="chip ${tm.done ? 'on' : ''}" data-c="stoptimer" data-i="${i}">⏱ ${tm.done ? t('done') : `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`} · ${esc(tm.label)} ×</button>`; }).join('');
}
function closeCook() { clearInterval(tick); tick = null; try { wake && wake.release(); } catch {} wake = null; C = null; closeDlg(); }
dlg.addEventListener('click', async e => {
  const b = e.target.closest('[data-c]'); if (!b || !C) return;
  const k = b.dataset.c;
  if (k === 'close') return closeCook();
  if (k === 'next') { if (C.page === C.pages.length - 1) return closeCook(); C.page++; drawCook(); }
  if (k === 'prev' && C.page > 0) { C.page--; drawCook(); }
  if (k === 'tick') { const i = +b.dataset.k; b.checked ? C.ticked.add(i) : C.ticked.delete(i); }
  if (k === 'less' || k === 'more') { C.scale.servings = Math.max(1, C.scale.servings + (k === 'more' ? 1 : -1)); drawCook(); }
  if (k === 'timer') { C.timers.push({ label: b.dataset.l, end: Date.now() + Number(b.dataset.s) * 1000 }); drawTimers(); }
  if (k === 'stoptimer') { C.timers.splice(+b.dataset.i, 1); drawTimers(); }
  if (k === 'cooked') { const id = C.e.id; if (await act('plan.cook', { id })) { toast(t('Marked as cooked')); closeCook(); } }
});
document.addEventListener('visibilitychange', () => { if (!document.hidden && C) keepAwake(); });

// Change how much of the main ingredient a planned meal uses; everything else follows.
function baseDlg(id) {
  const e = ST.db.plan.find(x => x.id === id), r = R(e.recipeId);
  const f = openDlg(`<h2>${esc(r.name)}</h2><label>${esc(t('How much {x}?', { x: pName(r.baseProductId) }))} (${uLabel(r.baseUnit)})<input name="base" inputmode="decimal" value="${esc(nf(e.base || r.baseQty))}"></label><div id="bprev" class="note small"></div>`,
    async fd => { const b = parseAmt(fd.get('base')); if (!(b > 0)) { toast(t('Check the amount for {x}', { x: pName(r.baseProductId) })); return false; } return !!(await act('plan.setBase', { id, base: b })) || false; });
  const upd = () => { const b = parseAmt(f.elements.base.value); $('#bprev').innerHTML = b > 0 ? linesHtml(recipeLines(r, { base: b }).slice(1)) + `<div class="meta">${t('{n} servings', { n: nf(Math.round(mealServings(r, { base: b }) * 10) / 10) })}</div>` : ''; };
  f.elements.base.addEventListener('input', upd); upd();
}

/* ---------- RESERVE (emergency) ---------- */
function meter(v, need) { const pc = Math.max(0, Math.min(100, need ? v / need * 100 : 0)); return `<div class="meter ${pc >= 100 ? '' : pc >= 60 ? 'low' : 'bad'}"><i style="width:${pc}%"></i></div>`; }
function vReserve() {
  const D = ST.derived, em = D.emergency, S = ST.db.settings;
  const kit = ST.db.kit, have = kit.filter(k => k.have).length;
  const emLots = ST.db.lots.filter(l => (Lc(l.locationId) || {}).emergency).sort(sortLots);
  const targets = ST.db.products.filter(p => p.emergencyQty > 0);
  const planned = new Set(Object.values(D.entries).flatMap(i => (i.alloc || []).map(a => a.lotId)));
  const emRecipes = ST.db.recipes.filter(r => r.emergency);
  $('#view').innerHTML = `<h2>${t('Emergency reserve')}</h2>
  <p class="meta">${t('Goal: {d} days for {p} people, {m} meals a day. The EU asks every household to manage at least 72 hours on its own.', { d: S.days, p: S.people, m: S.mealsPerDay })}</p>
  <div class="stat">
    <div class="card"><div class="meta">${t('Food')}</div><div class="big">${nf(em.daysCovered)} / ${S.days} ${t('days')}</div>${meter(em.servings, em.servingsNeeded)}<div class="small meta">${t('{a} of {b} servings', { a: nf(em.servings), b: em.servingsNeeded })}</div></div>
    <div class="card"><div class="meta">${t('Water')}</div><div class="big">${nf(em.water)} / ${nf(em.waterNeeded)} l</div>${meter(em.water, em.waterNeeded)}<div class="small meta">${t('{n} days', { n: nf(em.waterDays) })} · ${t('{l} l per person per day', { l: nf(S.waterPerPersonDay) })}</div></div>
    <div class="card"><div class="meta">${t('Kit')}</div><div class="big">${have} / ${kit.length}</div>${meter(have, kit.length)}<div class="small meta">${t('items ready')}</div></div>
  </div>
  ${em.rotation.length ? `<div class="group"><span>${t('To rotate (expires within {d} days)', { d: S.rotationDays })}</span></div>${em.rotation.map(x => { const p = P(x.productId) || {}; return `<div class="item st-soon"><div><b>${esc(p.name)}</b> <span class="meta">${fq(x.qty, p.unit)}</span> ${planned.has(x.lotId) ? `<span class="badge b-ok">${t('on the menu')}</span>` : `<span class="badge b-soon">${t('not planned yet')}</span>`}</div><div class="when">${rel(x.bb)}</div></div>`; }).join('')}
    <p class="meta small">${t('These go into menu suggestions; their replacement is already on the shopping list.')}</p>` : ''}
  <div class="group"><span>${t('Stock to keep')}</span></div>
  ${targets.length ? targets.map(p => { const s = D.stock[p.id]; return `<div class="row tight" style="flex-wrap:nowrap"><span class="grow">${esc(p.name)}</span><span class="meta small">${fq(s.emergencySafe, p.unit)} / ${fq(p.emergencyQty, p.unit)}</span></div>${meter(s.emergencySafe, p.emergencyQty)}`; }).join('')
    : `<div class="note">${t("Set 'Keep in emergency stock' on products (More → Products) and the app keeps them topped up.")}</div>`}
  <div class="group"><span>${t('Emergency meals')}</span><button class="mini" data-a="recipe" data-em="1">+ ${t('Recipe')}</button></div>
  ${emRecipes.length ? emRecipes.map(r => `<div class="row tight"><span class="grow">${esc(r.name)}${r.stove ? ` <span class="badge b-soft">${t('needs a stove')}</span>` : ''}</span><span class="badge ${em.madeCount[r.id] ? 'b-ok' : 'b-no'}">${t('{n}× from the reserve', { n: em.madeCount[r.id] || 0 })}</span></div>`).join('')
    : `<div class="note">${t('Mark recipes as emergency meals: long-lasting food you keep on the emergency shelf.')}</div>`}
  <div class="group"><span>${t('On the emergency shelf')}</span><span>${emLots.length}</span></div>
  ${emLots.map(l => { const p = P(l.productId) || {}; return `<div class="item st-${bbState(l.bb)}"><div><b>${esc(p.name)}</b> <span class="meta">${fqP(l.qty, p)}</span></div><div class="when">${rel(l.bb) || `<button class="mini" data-a="editlot" data-id="${l.id}">${t('Add date')}</button>`}</div></div>`; }).join('') || `<div class="empty">${t('Nothing on the emergency shelf yet.')}</div>`}
  <div class="group"><span>${t('Kit checklist')}</span><button class="mini" data-a="kitadd">+ ${t('Item')}</button></div>
  <div class="card" style="padding:2px 6px">${kit.map(k => { const st = k.bb ? bbState(k.bb) : ''; const due = k.bb && diff(today(), k.bb) <= S.rotationDays;
    return `<div class="shop"><input type="checkbox" data-a="kithave" data-id="${k.id}" ${k.have ? 'checked' : ''} aria-label="${esc(k.name || t(k.key))}"><div class="nm"><b>${esc(k.name || t(k.key))}</b>${k.qty ? ` <span class="meta small">${esc(k.qty)}</span>` : ''}${k.bb ? ` <span class="badge ${due ? (st === 'past' ? 'b-no' : 'b-soon') : 'b-soft'}">${rel(k.bb)}</span>` : ''}</div><button class="mini" data-a="kitedit" data-id="${k.id}">${t('Edit')}</button></div>`; }).join('')}</div>`;
}
function kitDlg(id) {
  const k = id ? ST.db.kit.find(x => x.id === id) : { name: '', qty: '', bb: '' };
  openDlg(`<h2>${id ? esc(k.name || t(k.key)) : t('Item')}</h2><label>${t('Name')}<input name="name" value="${esc(k.name || (k.key ? t(k.key) : ''))}"></label>
  <div class="grid2"><label>${t('How much')}<input name="qty" value="${esc(k.qty || '')}"></label><label>${t('Expires')}<input name="bb" type="date" value="${esc(k.bb || '')}"></label></div>`,
  async fd => !!(await act(id ? 'kit.update' : 'kit.add', { id, name: fd.get('name'), qty: fd.get('qty'), bb: fd.get('bb') })) || false, t('Save'),
  id ? `<button type="button" class="ghost" data-a="kitdel" data-id="${id}" style="margin-right:auto;color:var(--red)">${t('Delete')}</button>` : '');
}

/* ---------- MORE ---------- */
function vMore() {
  const S = ST.db.settings;
  const months = []; const now = parse(today());
  for (let i = 11; i >= 0; i--) { const d = new Date(now.getFullYear(), now.getMonth() - i, 1); months.push(isoD(d).slice(0, 7)); }
  const m = UI.wasteMonth || months[11];
  const bins = ST.db.log.filter(x => x.action === 'bin');
  const inMonth = bins.filter(x => (x.date || '').startsWith(m));
  const perMonth = months.map(k => bins.filter(x => (x.date || '').startsWith(k)).length); const maxM = Math.max(1, ...perMonth);
  const byProd = {}; inMonth.forEach(x => { byProd[x.productId] = (byProd[x.productId] || 0) + 1; });
  const byReason = {}; inMonth.forEach(x => { byReason[x.reason] = (byReason[x.reason] || 0) + 1; });
  const top = Object.entries(byProd).sort((a, b) => b[1] - a[1]).slice(0, 8);
  const hist = ST.db.log.slice(-40).reverse();
  const verb = { add: 'added', use: 'used', empty: 'emptied', bin: 'binned', cook: 'cooked' };
  $('#view').innerHTML = `<h2>${t('Waste')}</h2>
  <div class="card"><div class="bars">${months.map((k, i) => `<div class="r" data-a="wm" data-m="${k}" style="cursor:pointer;${k === m ? 'font-weight:700' : ''}"><span>${parse(k + '-01').toLocaleDateString(locale(), { month: 'short', year: '2-digit' })}</span><span><i style="width:${perMonth[i] / maxM * 100}%;${perMonth[i] ? '' : 'background:var(--line);width:3px'}"></i></span><span>${perMonth[i]}</span></div>`).join('')}</div></div>
  <div class="card"><h3>${parse(m + '-01').toLocaleDateString(locale(), { month: 'long', year: 'numeric' })}: ${t('{n} item(s) binned', { n: inMonth.length })}</h3>
  ${top.length ? `<div class="bars" style="margin-top:8px">${top.map(([pid, n]) => `<div class="r"><span>${esc(pName(pid))}</span><span><i style="width:${n / top[0][1] * 100}%"></i></span><span>${n}</span></div>`).join('')}</div>
  <p class="meta small">${Object.entries(byReason).map(([r, n]) => `${esc(t('reason.' + r))}: ${n}`).join(' · ')}</p>` : `<p class="meta">${t('Nothing binned this month.')}</p>`}</div>
  <h2 style="margin-top:22px">${t('Products')}</h2><div class="card" style="padding:2px 6px">${[...ST.db.products].sort((a, b) => a.name.localeCompare(b.name)).map(p => { const s = ST.derived.stock[p.id];
    return `<div class="shop" data-a="prod" data-id="${p.id}" style="cursor:pointer"><div class="nm"><b>${esc(p.name)}</b> <span class="meta small">${fqP(s.onHand, p)}${p.min ? ' · min ' + fq(p.min, p.unit) : ''}${p.emergencyQty ? ' · ★ ' + fq(p.emergencyQty, p.unit) : ''}</span></div><span class="meta">›</span></div>`; }).join('') || `<div class="empty" style="border:0">${t('No products yet.')}</div>`}</div>
  <h2 style="margin-top:22px">${t('Places')}</h2><div class="card" style="padding:2px 6px">${ST.db.locations.map(l => `<div class="shop"><div class="nm"><b>${esc(locName(l))}</b>${l.emergency ? ` <span class="badge b-sky">${t('Emergency')}</span>` : ''}</div><button class="mini" data-a="loc" data-id="${l.id}">${t('Edit')}</button></div>`).join('')}</div>
  <div class="row"><button class="mini" data-a="loc">+ ${t('Place')}</button></div>
  <h2 style="margin-top:22px">${t('Household')}</h2><div class="card" style="padding:2px 6px">${ST.db.users.map(u => `<div class="shop"><div class="nm"><b>${esc(u.name)}</b> ${u.id === me ? `<span class="badge b-ok">${t('this phone')}</span>` : ''}</div><span class="meta">${u.lang.toUpperCase()}</span></div>`).join('')}</div>
  <div class="row"><label class="grow">${t('Language on this phone')}<select id="langSel">${opts(['nl', 'en'], lang, x => x === 'nl' ? 'Nederlands' : 'English')}</select></label><button class="ghost" data-a="switchuser" style="align-self:end">${t('Switch person')}</button></div>
  <h2 style="margin-top:22px">${t('Emergency settings')}</h2><form id="setF" class="card"><div class="grid3 fields">
    <label>${t('People')}<input name="people" type="number" min="1" inputmode="numeric" value="${S.people}"></label><label>${t('Days')}<input name="days" type="number" min="1" inputmode="numeric" value="${S.days}"></label><label class="wide">${t('Meals a day')}<input name="mealsPerDay" type="number" min="1" inputmode="numeric" value="${S.mealsPerDay}"></label></div>
    <div class="grid2 fields" style="margin-top:8px"><label>${t('Rotate (days before expiry)')}<input name="rotationDays" type="number" min="7" inputmode="numeric" value="${S.rotationDays}"></label><label>${t('Water l/person/day')}<input name="waterPerPersonDay" type="number" step="0.5" min="1" inputmode="decimal" value="${S.waterPerPersonDay}"></label></div>
    <div class="row end"><button class="btn">${t('Save')}</button></div></form>
  <h2 style="margin-top:22px">${t('History')}</h2><div class="card small" style="padding:6px 12px">${hist.map(x => `<div style="padding:3px 0;border-bottom:1px solid var(--line)"><span class="meta">${fmtD(x.date || x.ts.slice(0, 10))}</span> ${esc(userName(x.userId))} ${esc(t(verb[x.action] || x.action))} <b>${esc(x.recipeId ? (R(x.recipeId) || {}).name : pName(x.productId))}</b>${x.reason ? ' · ' + esc(t('reason.' + x.reason)) : ''}</div>`).join('') || t('Nothing yet.')}</div>
  <div class="row"><a class="ghost" href="/api/export" download>${t('Download backup')}</a></div>
  <p class="meta small">Mise en Place ${esc(ST.version)}</p>`;
  $('#langSel').onchange = async e => { lang = e.target.value; LS.set('lang', lang); await act('user.update', { id: me, lang }); render(); };
  $('#setF').onsubmit = async e => { e.preventDefault(); const fd = new FormData(e.target); if (await act('settings.update', Object.fromEntries(fd))) toast(t('Saved')); };
}
function prodDlg(id) {
  const p = P(id);
  openDlg(`<h2>${esc(p.name)}</h2><label>${t('Name')}<input name="name" value="${esc(p.name)}"></label>${productFields(p)}
  <label>${t('Barcodes')}<input name="barcodes" value="${esc((p.barcodes || []).join(', '))}" inputmode="numeric"></label>`,
  async fd => !!(await act('product.update', { id, name: fd.get('name'), ...readProduct(fd), barcodes: fd.get('barcodes').split(',').map(x => x.trim()).filter(Boolean) })) || false,
  t('Save'), `<button type="button" class="ghost" data-a="proddel" data-id="${id}" style="margin-right:auto;color:var(--red)">${t('Delete')}</button>`);
}
function locDlg(id) {
  const l = id ? Lc(id) : { name: '', emergency: false };
  openDlg(`<h2>${id ? esc(locName(l)) : t('Place')}</h2><label>${t('Name')}<input name="name" value="${esc(l.name || (l.key ? t(l.key) : ''))}"></label>
  <label class="check"><input type="checkbox" name="emergency" ${l.emergency ? 'checked' : ''}> ${t('Emergency reserve (not used for normal meals until it needs rotating)')}</label>`,
  async fd => !!(await act(id ? 'loc.update' : 'loc.add', { id, name: fd.get('name'), emergency: !!fd.get('emergency') })) || false, t('Save'),
  id ? `<button type="button" class="ghost" data-a="locdel" data-id="${id}" style="margin-right:auto;color:var(--red)">${t('Delete')}</button>` : '');
}

/* ---------- events ---------- */
document.addEventListener('click', async e => {
  const el = e.target.closest('[data-a]'); if (!el || el.tagName === 'SELECT' || el.type === 'checkbox') return;
  const a = el.dataset.a, id = el.dataset.id;
  const wk = UI.week || (ST && ST.derived.week);
  switch (a) {
    case 'pickme': { const u = ST.db.users.find(x => x.id === id); me = id; lang = u.lang; LS.set('user', me); LS.set('lang', lang); location.hash = 'menu'; render(); break; }
    case 'switchuser': me = null; LS.set('user', null); render(); break;
    case 'wk': UI.week = addDays(wk, Number(el.dataset.d)); UI.picks = null; render(); break;
    case 'addmeal': addMealDlg(); break;
    case 'suggest': {
      UI.picks = 'busy'; render();
      try { const r = await fetch('/api/suggest', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ week: wk }) }); UI.picks = (await r.json()).picks || []; }
      catch { UI.picks = null; toast(t("Can't reach the server")); }
      render(); break;
    }
    case 'nopicks': UI.picks = null; render(); break;
    case 'sortweek': act('plan.sort', { week: wk }); break;
    case 'confirm': openDlg(`<h2>${t('Confirm this week?')}</h2><p>${t('After confirming, every meal on it must be cooked this week. You can still move meals around and add more, but not remove them. Missing ingredients go on the shopping list.')}</p>`, async () => { await act('week.confirm', { week: wk }); }, t('Confirm week')); break;
    case 'mv': act('plan.move', { id, dir: Number(el.dataset.d) }); break;
    case 'cook': cookDlg(id); break;
    case 'base': baseDlg(id); break;
    case 'cookm': { const en = ST.db.plan.find(x => x.id === id); openCook(en.recipeId, id); break; }
    case 'cookr': openCook(id, null); break;
    case 'rmmeal': act('plan.remove', { id }); break;
    case 'addstock': addStockDlg(); break;
    case 'scan': scanDlg(); break;
    case 'pf': UI.pantryFilter = el.dataset.k; render(); break;
    case 'use': lotDlg(id, 'use'); break;
    case 'bin': lotDlg(id, 'bin'); break;
    case 'editlot': lotDlg(id, 'edit'); break;
    case 'empty': { const l = ST.db.lots.find(x => x.id === id); if (await act('stock.empty', { id })) toast(t('{x} marked as empty', { x: pName(l.productId) })); break; }
    case 'sdel': act('shop.delete', { id }); break;
    case 'store': storeDlg(); break;
    case 'clearDone': act('shop.clearDone'); break;
    case 'share': shareList(); break;
    case 'recipe': if (el.dataset.em) { recipeDlg(); const c = dlg.querySelector('[name=emergency]'); if (c) c.checked = true; } else recipeDlg(id); break;
    case 'kitadd': kitDlg(); break;
    case 'kitedit': kitDlg(id); break;
    case 'kitdel': if (await act('kit.delete', { id })) closeDlg(); break;
    case 'wm': UI.wasteMonth = el.dataset.m; render(); break;
    case 'prod': prodDlg(id); break;
    case 'proddel': if (await act('product.delete', { id })) closeDlg(); break;
    case 'loc': locDlg(id); break;
    case 'locdel': if (await act('loc.delete', { id })) closeDlg(); break;
  }
});
document.addEventListener('change', e => {
  const el = e.target, a = el.dataset.a; if (!a) return;
  const wk = UI.week || ST.derived.week;
  if (a === 'daytype') act('week.setDay', { week: wk, index: Number(el.dataset.i), type: el.value });
  if (a === 'stog') act('shop.toggle', { id: el.dataset.id, done: el.checked });
  if (a === 'kithave') act('kit.update', { id: el.dataset.id, have: el.checked });
});
document.addEventListener('submit', async e => {
  if (e.target.id !== 'picks') return;
  e.preventDefault();
  const idx = new FormData(e.target).getAll('pick').map(Number);
  const ids = idx.map(i => UI.picks[i].recipeId);
  UI.picks = null;
  if (ids.length) await act('plan.addMany', { week: UI.week || ST.derived.week, recipeIds: ids, sort: true }); else render();
});
$('#who').onclick = () => { location.hash = 'more'; };
// Switch language instantly; remembered on this phone and for this person.
$('#langBtn').onclick = () => { lang = lang === 'nl' ? 'en' : 'nl'; LS.set('lang', lang); render(); if (me) act('user.update', { id: me, lang }); };

/* ---------- start ---------- */
if (ST) index();
render();
live(); // the first 'change' event (or onopen) loads the state
if ('serviceWorker' in navigator && window.isSecureContext) navigator.serviceWorker.register('/sw.js').catch(() => {});
}
