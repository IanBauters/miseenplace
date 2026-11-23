'use strict';
// Plain-Node tests for the planning engine: `npm test`
const assert = require('assert');
const E = require('../src/engine');

const today = '2026-11-25'; // a Wednesday
const wk = E.monday(today);
assert.strictEqual(wk, '2026-11-23');
assert.strictEqual(E.addDays('2026-03-28', 2), '2026-03-30'); // across daylight saving change

const db = E.freshDb();
const P = (id, name, extra = {}) => db.products.push({ id, name, unit: 'g', packSize: 500, min: 0, emergencyQty: 0, barcodes: [], ...extra });
P('pasta', 'Pasta', { min: 500 });
P('spin', 'Spinach', { unit: 'pcs', packSize: 1 });
P('beans', 'Tinned beans', { unit: 'tin', packSize: 1, emergencyQty: 4 });
P('water', 'Water', { unit: 'l', packSize: 6, water: true, emergencyQty: 63 });
db.lots.push(
  { id: 'l1', productId: 'pasta', qty: 800, bb: '2027-05-01', locationId: 'pantry1' },
  { id: 'l2', productId: 'spin', qty: 1, bb: '2026-11-26', locationId: 'fridge' },
  { id: 'l3', productId: 'beans', qty: 4, bb: '2027-01-10', locationId: 'reserve' }, // inside the 60-day window
  { id: 'l4', productId: 'water', qty: 30, bb: '2028-01-01', locationId: 'reserve' }
);
db.recipes.push(
  { id: 'r1', name: 'Spinach pasta', servings: 3, ingredients: [{ productId: 'pasta', qty: 400 }, { productId: 'spin', qty: 1 }] },
  { id: 'r2', name: 'Plain pasta', servings: 3, ingredients: [{ productId: 'pasta', qty: 500 }] },
  { id: 'r3', name: 'Bean stew', servings: 3, emergency: true, ingredients: [{ productId: 'beans', qty: 2 }] }
);
E.ensureWeek(db, wk);

// Suggestions: the spinach (due tomorrow) and the rotating emergency beans come first.
const picks = E.suggest(db, today, wk);
assert.ok(picks.length >= 2, 'should suggest meals');
assert.strictEqual(picks[0].recipeId, 'r1', 'spinach pasta first: spinach is due tomorrow');
assert.ok(picks.some(p => p.recipeId === 'r3' && p.rotate), 'emergency stew suggested for rotation');

// Plan two pasta meals: the second one lacks pasta (800 g for 900 g needed).
for (const r of ['r1', 'r2']) db.plan.push({ id: 'e' + r, week: wk, recipeId: r, servings: 3, status: 'planned', order: db.plan.length });
let d = E.compute(db, today);
assert.deepStrictEqual(d.entries.er1.missing, []);
assert.strictEqual(d.entries.er2.missing[0].qty, 100);
assert.strictEqual(d.stock.pasta.free, 0);

// Not confirmed: missing items are not on the list yet, but below-minimum pasta is.
E.syncAuto(db, today, d);
let pasta = db.shopping.find(s => s.productId === 'pasta');
assert.strictEqual(pasta.qty, 500, 'one pack for minimum stock');
// Emergency restock: beans inside the rotation window don't count, water is short.
assert.strictEqual(db.shopping.find(s => s.productId === 'beans').qty, 4);
assert.strictEqual(db.shopping.find(s => s.productId === 'water').qty, 33);

// Confirm the week: the missing 100 g is added to the pasta line.
db.weeks[wk].confirmed = true;
d = E.compute(db, today); E.syncAuto(db, today, d);
pasta = db.shopping.find(s => s.productId === 'pasta');
assert.strictEqual(pasta.qty, 600);
assert.strictEqual(db.shopping.filter(s => s.productId === 'pasta').length, 1, 'no duplicate lines');

// Ticking it off as bought removes the need for a second line.
pasta.done = true; d = E.compute(db, today); E.syncAuto(db, today, d);
assert.strictEqual(db.shopping.filter(s => s.productId === 'pasta').length, 1);

// Carry-over: next Monday, the uncooked meals move to the new week, first in line.
const nextMon = E.addDays(wk, 7);
db.plan.push({ id: 'new', week: nextMon, recipeId: 'r2', servings: 3, status: 'planned', order: 0 });
E.carryOver(db, nextMon);
const order = db.plan.filter(e => e.week === nextMon).sort((a, b) => a.order - b.order).map(e => e.id);
assert.deepStrictEqual(order, ['er1', 'er2', 'new']);
assert.ok(db.plan.find(e => e.id === 'er1').carried);

// Dates: an 'out' day is skipped.
E.ensureWeek(db, nextMon).days[0] = 'out';
const dates = E.assignDates(db, nextMon);
assert.strictEqual(dates.er1, E.addDays(nextMon, 1));

// Emergency coverage: 4 tins = 2 stews = 6 servings; need 3 people × 3 meals × 7 days = 63.
d = E.compute(db, today);
assert.strictEqual(d.emergency.servings, 6);
assert.strictEqual(d.emergency.servingsNeeded, 63);
assert.strictEqual(d.emergency.water, 30);
// Ratio recipe (red cabbage): 1 part cabbage, 1 part apples, 1 part water (tap), 1½ tbsp sugar per 100 g cabbage.
const db2 = E.freshDb();
db2.products.push(
  { id: 'cab', name: 'Red cabbage', unit: 'g', packSize: 1, barcodes: [] },
  { id: 'app', name: 'Apples', unit: 'pcs', pieceG: 150, packSize: 1, barcodes: [] },
  { id: 'sug', name: 'Sugar', unit: 'g', spoonG: 12.5, packSize: 1000, barcodes: [] });
const kool = { id: 'rk', name: 'Rode kool', servings: 4, mode: 'ratio', baseProductId: 'cab', baseUnit: 'g', baseQty: 600, ingredients: [
  { productId: 'app', qty: 1, per: 'part' },
  { productId: null, name: 'Water', qty: 1, unit: 'ml', per: 'part' },
  { productId: 'sug', qty: 1.5, unit: 'tbsp', per: 'per100' }] };
db2.recipes.push(kool);
const n = Object.fromEntries(E.needs(db2, kool, { base: 300 }).map(x => [x.productId, x.qty]));
assert.deepStrictEqual(n, { cab: 300, app: 2, sug: 56.25 }, '300 g cabbage → 300 g apples = 2 pieces, 4½ tbsp sugar = 56.25 g, water not from stock');
assert.strictEqual(E.convert(1, 'tbsp', { unit: 'ml' }), 15);
assert.strictEqual(E.convert(1, 'kg', { unit: 'g' }), 1000);
assert.strictEqual(E.convert(1, 'pcs', { unit: 'g' }), null, 'pieces without a weight cannot become grams');
db2.lots.push({ id: 'c1', productId: 'cab', qty: 450, bb: '2026-12-01', locationId: 'fridge' }, { id: 'c2', productId: 'cab', qty: 900, bb: '2026-12-20', locationId: 'fridge' });
assert.strictEqual(E.defaultBase(db2, kool, new Map(), E.usableFor(db2, today)), 450, 'defaults to the first cabbage in stock');
db2.plan.push({ id: 'p1', week: wk, recipeId: 'rk', base: 450, status: 'planned', order: 0 });
const d2 = E.compute(db2, today);
assert.deepStrictEqual(d2.entries.p1.missing.map(m => [m.productId, m.qty]), [['app', 3], ['sug', 84.375]]);
// Garlic: stocked as bulbs, recipes use cloves.
const garlic = { id: 'gar', unit: 'pcs', subUnit: 'clove', subCount: 10 };
assert.strictEqual(E.convert(3, 'clove', garlic), 0.3);
assert.strictEqual(E.convert(3, 'clove', { unit: 'pcs' }), null, 'no cloves without knowing how many per bulb');
assert.strictEqual(E.convert(2, 'clove', { unit: 'g', subUnit: 'clove', subCount: 10, pieceG: 50 }), 10);
// "1 small can (160 g)": stock kept as 400 g tins → 0.4 tin.
assert.strictEqual(E.convert(160, 'g', { unit: 'tin', pieceG: 400 }), 0.4);
assert.strictEqual(E.convert(3, 'clove', { unit: 'pcs', subUnit: 'clove', subCount: 10 }), 0.3);
console.log('engine tests passed');
