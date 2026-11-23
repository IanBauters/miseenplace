'use strict';
// Planning engine: dates, stock reservations (first-expiry-first-out), carry-over,
// automatic shopping list, menu suggestions and emergency coverage.
// Pure functions over the db object; the server persists the result.

const DAY = 864e5;
const iso = d => d.toLocaleDateString('sv-SE'); // YYYY-MM-DD in the container's local time zone
const todayISO = () => iso(new Date());
const parse = s => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };
const addDays = (s, n) => { const d = parse(s); d.setDate(d.getDate() + n); return iso(d); };
const diff = (a, b) => Math.round((parse(b) - parse(a)) / DAY); // days from a to b
const monday = s => { const d = parse(s); d.setDate(d.getDate() - ((d.getDay() + 6) % 7)); return iso(d); };
const round = x => Math.round(x * 1000) / 1000;
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
const fefo = (a, b) => (a.bb || '9999-12-31').localeCompare(b.bb || '9999-12-31') || (a.addedAt || '').localeCompare(b.addedAt || '');
const DAY_TYPES = ['home', 'out', 'invited', 'leftovers'];

function freshDb() {
  return {
    version: 1,
    users: [],
    locations: [
      { id: 'pantry1', key: 'Pantry 1' },
      { id: 'pantry2', key: 'Pantry 2' },
      { id: 'fridge', key: 'Fridge' },
      { id: 'freezer', key: 'Freezer' },
      { id: 'garage', key: 'Garage' },
      { id: 'reserve', key: 'Garage – emergency shelf', emergency: true }
    ],
    products: [],
    lots: [],
    recipes: [],
    weeks: {},
    plan: [],
    shopping: [],
    kit: ['Torch', 'Spare batteries', 'Battery or wind-up radio', 'Charged power bank', 'First aid kit',
      'Personal medicines', 'Copies of ID and important papers', 'Cash in small notes', 'Camping stove',
      'Gas cartridges', 'Matches or lighter', 'Manual can opener', 'Hygiene items and wet wipes',
      'Rubbish bags', 'Warm blankets', 'Whistle'].map(k => ({ id: uid(), key: k, qty: '', have: false, bb: '' })),
    log: [],
    settings: { people: 3, days: 7, mealsPerDay: 3, rotationDays: 60, waterPerPersonDay: 3 }
  };
}

function ensureWeek(db, wk) {
  if (!db.weeks[wk]) db.weeks[wk] = { days: Array(7).fill('home'), confirmed: false };
  return db.weeks[wk];
}

// Meals fill the 'home' days of their week in order; extra meals overflow (date null).
function assignDates(db, wk) {
  const w = ensureWeek(db, wk);
  const home = w.days.map((t, i) => t === 'home' ? i : -1).filter(i => i >= 0);
  const out = {};
  db.plan.filter(e => e.week === wk).sort((a, b) => a.order - b.order)
    .forEach((e, i) => { out[e.id] = i < home.length ? addDays(wk, home[i]) : null; });
  return out;
}

function renumber(db, wk) {
  db.plan.filter(e => e.week === wk).sort((a, b) => a.order - b.order).forEach((e, i) => { e.order = i; });
}

// Uncooked meals from past weeks move to the front of the current week.
function carryOver(db, today) {
  const cur = monday(today);
  ensureWeek(db, cur);
  const late = db.plan.filter(e => e.status === 'planned' && e.week < cur)
    .sort((a, b) => a.week.localeCompare(b.week) || a.order - b.order);
  if (!late.length) return false;
  late.forEach((e, i) => { e.week = cur; e.carried = true; e.order = -1000 + i; });
  renumber(db, cur);
  return true;
}

function maps(db) {
  return {
    locs: new Map(db.locations.map(l => [l.id, l])),
    prods: new Map(db.products.map(p => [p.id, p])),
    recipes: new Map(db.recipes.map(r => [r.id, r]))
  };
}

function compute(db, today) {
  const { locs, prods, recipes } = maps(db);
  const S = db.settings;
  const isEm = lot => !!(locs.get(lot.locationId) || {}).emergency;
  const rotating = lot => isEm(lot) && !!lot.bb && diff(today, lot.bb) <= S.rotationDays;
  const usable = lot => !isEm(lot) || rotating(lot);
  const rem = new Map(db.lots.map(l => [l.id, l.qty]));
  const byProd = new Map();
  for (const l of db.lots) { if (!byProd.has(l.productId)) byProd.set(l.productId, []); byProd.get(l.productId).push(l); }
  for (const a of byProd.values()) a.sort(fefo);

  const dates = {};
  for (const wk of Object.keys(db.weeks)) Object.assign(dates, assignDates(db, wk));

  const entries = {};
  const planned = db.plan.filter(e => e.status === 'planned').sort((a, b) => a.week.localeCompare(b.week) || a.order - b.order);
  for (const e of planned) {
    const r = recipes.get(e.recipeId);
    const info = { date: dates[e.id] || null, alloc: [], missing: [], warn: [], deadline: null };
    if (r) {
      const f = (e.servings || r.servings || 1) / (r.servings || 1);
      for (const ing of r.ingredients || []) {
        let need = round(ing.qty * f);
        for (const l of (byProd.get(ing.productId) || []).filter(usable)) {
          if (need <= 0) break;
          const have = rem.get(l.id); if (have <= 0) continue;
          const take = Math.min(have, need);
          rem.set(l.id, round(have - take)); need = round(need - take);
          info.alloc.push({ lotId: l.id, productId: l.productId, qty: take, bb: l.bb || null, rotating: rotating(l) });
          if (l.bb) {
            if (!info.deadline || l.bb < info.deadline) info.deadline = l.bb;
            const due = info.date || addDays(e.week, 6);
            if (l.bb < today) info.warn.push({ type: 'past', productId: l.productId, bb: l.bb });
            else if (l.bb < due) info.warn.push({ type: 'late', productId: l.productId, bb: l.bb });
          }
        }
        if (need > 1e-9) info.missing.push({ productId: ing.productId, qty: need });
      }
    }
    entries[e.id] = info;
  }
  for (const e of db.plan) if (!entries[e.id]) entries[e.id] = { date: dates[e.id] || null, alloc: [], missing: [], warn: [] };

  const stock = {};
  for (const p of db.products) {
    const lots = byProd.get(p.id) || [];
    const sum = (arr, fn) => round(arr.reduce((s, l) => s + fn(l), 0));
    const normal = lots.filter(l => !isEm(l)), em = lots.filter(isEm);
    stock[p.id] = {
      onHand: sum(normal, l => l.qty),
      free: sum(normal, l => rem.get(l.id)),
      emergencySafe: sum(em.filter(l => !rotating(l)), l => l.qty)
    };
  }

  // Emergency coverage: how many servings the emergency recipes can make from the reserve.
  const emRem = new Map(db.lots.filter(isEm).map(l => [l.id, rem.get(l.id)]));
  const emRecipes = db.recipes.filter(r => r.emergency && (r.ingredients || []).length);
  let servings = 0, guard = 0, progress = true;
  const madeCount = {};
  while (progress && guard++ < 400) {
    progress = false;
    for (const r of emRecipes) {
      const trial = new Map(emRem); let ok = true;
      for (const ing of r.ingredients) {
        let need = ing.qty;
        for (const l of (byProd.get(ing.productId) || []).filter(isEm)) {
          if (need <= 0) break;
          const have = trial.get(l.id) || 0; const take = Math.min(have, need);
          trial.set(l.id, round(have - take)); need = round(need - take);
        }
        if (need > 1e-9) { ok = false; break; }
      }
      if (ok) { for (const [k, v] of trial) emRem.set(k, v); servings += r.servings || 1; madeCount[r.id] = (madeCount[r.id] || 0) + 1; progress = true; }
    }
  }
  let water = 0;
  for (const l of db.lots) {
    const p = prods.get(l.productId);
    if (p && p.water && isEm(l)) water += p.unit === 'ml' ? l.qty / 1000 : l.qty;
  }
  const perDay = Math.max(1, S.people) * Math.max(1, S.mealsPerDay);
  const emergency = {
    servings, servingsNeeded: perDay * S.days, daysCovered: round(servings / perDay), madeCount,
    water: round(water), waterNeeded: S.people * S.days * S.waterPerPersonDay,
    waterDays: round(water / Math.max(0.1, S.people * S.waterPerPersonDay)),
    rotation: db.lots.filter(rotating).sort(fefo).map(l => ({ lotId: l.id, productId: l.productId, bb: l.bb, qty: l.qty }))
  };

  const soon = db.lots.filter(l => l.bb && !isEm(l) && diff(today, l.bb) <= 3).length;
  return { today, week: monday(today), entries, stock, emergency, soon, rem: Object.fromEntries(rem) };
}

// Automatic shopping items: missing for confirmed weeks, below minimum (one pack), emergency restock.
function syncAuto(db, today, derived) {
  const { prods } = maps(db);
  const want = new Map();
  const add = (pid, qty, reason) => {
    if (!prods.has(pid) || qty <= 0) return;
    const w = want.get(pid) || { qty: 0, reasons: [] };
    w.qty = round(w.qty + qty); w.reasons.push(reason); want.set(pid, w);
  };
  for (const e of db.plan) {
    if (e.status !== 'planned' || !(db.weeks[e.week] || {}).confirmed) continue;
    for (const m of (derived.entries[e.id] || {}).missing || []) add(m.productId, m.qty, { type: 'meal', recipeId: e.recipeId, date: derived.entries[e.id].date });
  }
  for (const p of db.products) {
    const s = derived.stock[p.id];
    if (p.min > 0 && s.free < p.min) add(p.id, p.packSize || 1, { type: 'min' });
    if (p.emergencyQty > 0 && s.emergencySafe < p.emergencyQty) add(p.id, round(p.emergencyQty - s.emergencySafe), { type: 'emergency' });
  }
  // Items already ticked off (bought, not yet put away) count towards what's wanted.
  for (const it of db.shopping) {
    if (it.done && it.productId && want.has(it.productId)) {
      const w = want.get(it.productId); w.qty = round(w.qty - (Number(it.qty) || 0));
      if (w.qty <= 0) want.delete(it.productId);
    }
  }
  let changed = false;
  db.shopping = db.shopping.filter(it => {
    if (!it.auto || it.done) return true;
    const w = want.get(it.productId);
    if (!w) { changed = true; return false; }
    if (it.qty !== w.qty || JSON.stringify(it.reasons) !== JSON.stringify(w.reasons)) { it.qty = w.qty; it.reasons = w.reasons; changed = true; }
    want.delete(it.productId);
    return true;
  });
  for (const [pid, w] of want) {
    db.shopping.push({ id: uid(), productId: pid, qty: w.qty, reasons: w.reasons, auto: true, done: false, addedAt: new Date().toISOString() });
    changed = true;
  }
  return changed;
}

// Suggest recipes for the empty home days of a week, most urgent first.
function suggest(db, today, wk) {
  const w = ensureWeek(db, wk);
  const derived = compute(db, today);
  const { locs } = maps(db);
  const S = db.settings;
  const rem = new Map(Object.entries(derived.rem));
  const isEm = l => !!(locs.get(l.locationId) || {}).emergency;
  const rotating = l => isEm(l) && !!l.bb && diff(today, l.bb) <= S.rotationDays;
  const usable = l => !isEm(l) || rotating(l);
  const byProd = new Map();
  for (const l of [...db.lots].sort(fefo)) { if (!byProd.has(l.productId)) byProd.set(l.productId, []); byProd.get(l.productId).push(l); }
  const homeDays = w.days.filter(t => t === 'home').length;
  const inWeek = db.plan.filter(e => e.week === wk);
  const slots = Math.max(0, homeDays - inWeek.length);
  const ref = wk > today ? wk : today;
  const recent = new Set(db.log.filter(x => x.action === 'cook' && x.date && diff(x.date, today) <= 14).map(x => x.recipeId));
  const taken = new Set(inWeek.map(e => e.recipeId));
  const picks = [];
  for (let k = 0; k < slots; k++) {
    let best = null;
    for (const r of db.recipes) {
      if (taken.has(r.id) || !(r.ingredients || []).length) continue;
      const trial = new Map(); let urgency = 0; const urgent = []; const missing = []; let rot = false; let deadline = null;
      for (const ing of r.ingredients) {
        let need = ing.qty;
        for (const l of (byProd.get(ing.productId) || []).filter(usable)) {
          if (need <= 0) break;
          const have = trial.has(l.id) ? trial.get(l.id) : (rem.get(l.id) || 0);
          if (have <= 0) continue;
          const take = Math.min(have, need);
          trial.set(l.id, round(have - take)); need = round(need - take);
          if (l.bb) {
            const dl = diff(ref, l.bb);
            if (!deadline || l.bb < deadline) deadline = l.bb;
            if (dl <= 14) { urgency += (15 - Math.max(dl, 0)) / 3; urgent.push({ productId: l.productId, bb: l.bb }); }
          }
          if (rotating(l)) { urgency += 6; rot = true; }
        }
        if (need > 1e-9) missing.push(ing.productId);
      }
      if (r.emergency && !rot) continue; // emergency meals only join the menu when their stock needs rotating
      const score = urgency + (missing.length ? -3 * missing.length : 4) + (r.fav ? 1 : 0) - (recent.has(r.id) ? 3 : 0) + Math.random() * 0.3;
      if (!best || score > best.score) best = { recipeId: r.id, score, urgent, missing, rotate: rot, deadline, trial };
    }
    if (!best) break;
    for (const [id, v] of best.trial) rem.set(id, v);
    taken.add(best.recipeId);
    delete best.trial;
    picks.push(best);
  }
  picks.sort((a, b) => (a.deadline || '9999').localeCompare(b.deadline || '9999'));
  return picks;
}

module.exports = { freshDb, ensureWeek, assignDates, renumber, carryOver, compute, syncAuto, suggest,
  todayISO, addDays, monday, round, uid, DAY_TYPES };
