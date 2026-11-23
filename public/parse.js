// Reads a recipe written as text (Dutch or English) into ingredients, sections and steps.
// Format it understands:
//   Title
//   All ingredients            ← optional heading, then bullet lines
//   * 1 small can (160 grams) of white beans
//   Directions for the soup    ← short line without a full stop = section heading
//   * 1 tomato, large diced    ← bullets: ingredients for the next step
//   Put everything in a pot…   ← plain text: the step itself
// Shared by the phones (window.parseRecipe) and the tests (require).
(function (root) {
'use strict';
const FRAC = { '½': 0.5, '¼': 0.25, '¾': 0.75, '⅓': 1 / 3, '⅔': 2 / 3 };
const NUM = /^(\d+(?:[.,]\d+)?(?:\s+\d+\/\d+)?|\d+\/\d+|[½¼¾⅓⅔])(?:\s*[-–]\s*\d+(?:[.,]\d+)?)?/;
const UNIT_WORDS = [
  [/^(kilo(gram(me)?s?)?|kg)\b\.?/i, 'kg'],
  [/^(grams?|grammes?|gr|g)\b\.?/i, 'g'],
  [/^(millilit(er|re)s?|ml)\b\.?/i, 'ml'],
  [/^(centilit(er|re)s?|cl)\b\.?/i, 'cl'],
  [/^(lit(er|re)s?|l)\b\.?/i, 'l'],
  [/^(tablespoons?|tbsp|tbs|el|eetlepels?)\b\.?/i, 'tbsp'],
  [/^(teaspoons?|tsp|kl|koffielepels?|theelepels?|tl)\b\.?/i, 'tsp'],
  [/^(cloves?|teentjes?|tenen|teen)\b/i, 'clove'],
  [/^(slices?|sneetjes?|sneden|plakjes?|plakken)\b/i, 'slice'],
  [/^(stalks?|stengels?)\b/i, 'stalk'],
  [/^(cans?|tins?|blikjes?|blikken|blik)\b/i, 'tin'],
  [/^(jars?|potjes?|potten|pot)\b/i, 'jar'],
  [/^(packs?|packets?|pakjes?|pakken|pak)\b/i, 'pack'],
  [/^(bags?|zakjes?|zakken|zak)\b/i, 'bag'],
  [/^(bottles?|flesjes?|flessen|fles)\b/i, 'bottle'],
  [/^(pieces?|stuks?|st)\b\.?/i, 'pcs']
];
const SIZE = /^(small|large|big|medium|klein|kleine|groot|grote|middelgrote?)\s+/i;
const APPROX = /^(about|approx\.?|approximately|around|ongeveer|ca\.?|circa|±|~)\s*/i;
const TASTE = /\b(to taste|naar smaak|optional|optioneel|naar keuze)\b/gi;
const BULLET = /^\s*([*\-•·–]|\d+[.)])\s+/;
const INGR_HEAD = /^(all(e)?\s+)?ingredi[eë]nt(s|en)?\b/i;
const HEAD_WORDS = /^(directions?|instructions?|method|preparation|bereiding|werkwijze|instructies|voor de|for the|stap|step)\b/i;
const NOT_STOCK = /^(water|tap water|kraantjeswater|leidingwater|warm water|koud water|cold water|hot water)$/i;

function num(s) {
  let n = 0;
  for (const p of s.trim().replace(/,/g, '.').split(/\s+/)) {
    if (FRAC[p]) n += FRAC[p]; else if (p.includes('/')) { const [a, b] = p.split('/'); n += a / b; } else n += Number(p);
  }
  return n;
}
function amount(s) {
  s = s.trim().replace(APPROX, '');
  const m = s.match(NUM); if (!m) return null;
  let rest = s.slice(m[0].length).trim(), unit = null;
  for (const [re, u] of UNIT_WORDS) { const mm = rest.match(re); if (mm) { unit = u; rest = rest.slice(mm[0].length).trim(); break; } }
  let qty = num(m[1]);
  if (unit === 'cl') { qty *= 10; unit = 'ml'; }
  return unit && !rest ? { qty, unit } : null;
}
const cap = s => s ? s[0].toUpperCase() + s.slice(1) : s;

// One bullet line → one or more ingredients: { name, qty, unit, note, prep, taste, stock }
function parseLine(raw) {
  let s = raw.replace(BULLET, '').trim(), prep = '';
  const c = s.indexOf(',');
  if (c > 0) { prep = s.slice(c + 1).trim(); s = s.slice(0, c).trim(); }
  let taste = /\b(to taste|naar smaak|optional|optioneel|naar keuze)\b/i.test(raw);
  s = s.replace(TASTE, '').trim(); prep = prep.replace(TASTE, '').replace(/^[,\s]+|[,\s]+$/g, '').trim();
  s = s.replace(APPROX, '');
  let ref = null;
  s = s.replace(/\(([^)]*)\)/, (m, inner) => { const r = amount(inner); if (r) { ref = r; return ''; } prep = [prep, inner.trim()].filter(Boolean).join(', '); return ''; })
    .replace(/\s+/g, ' ').trim();
  const start = s;
  let qty = null, unit = null, size = '';
  const m = s.match(NUM);
  if (m) { qty = num(m[1]); s = s.slice(m[0].length).trim(); }
  const sz = s.match(SIZE);
  if (sz) { size = sz[1]; s = s.slice(sz[0].length).trim(); }
  for (const [re, u] of UNIT_WORDS) {
    if (qty === null && u === 'l') continue; // a lone "l…" word without a number is a name
    const mm = s.match(re); if (mm) { unit = u; s = s.slice(mm[0].length).trim(); break; }
  }
  if (unit === 'cl') { qty = (qty || 1) * 10; unit = 'ml'; }
  const written = start.slice(0, start.length - s.length).trim();
  s = s.replace(/^(of|van|de|het)\s+/i, '').replace(/^(any|some|wat)\s+/i, '').trim();
  let note = '';
  if (ref) { note = written; qty = ref.qty; unit = ref.unit; }
  else if (size && unit) note = written;                     // "1 small can": keep the wording
  else if (size) prep = [size, prep].filter(Boolean).join(', '); // "1 small zucchini": size is a note
  if (qty !== null && !unit) unit = 'pcs';
  if (qty === null) taste = true;
  const make = name => ({ name: cap(name.trim()), qty: taste ? null : qty, unit: taste ? null : unit, note, prep, taste, stock: !NOT_STOCK.test(name.trim()) });
  if (taste && qty === null && /\s(and|en|&)\s/i.test(s)) return s.split(/\s(?:and|en|&)\s|,\s*/i).filter(Boolean).map(make);
  return s ? [make(s)] : [];
}

// Words that identify an ingredient, singular-ish, for matching "1 tomato" to "2 tomatoes".
const STOP = new Set(['of', 'and', 'the', 'a', 'van', 'de', 'het', 'en', 'een', 'small', 'large', 'big', 'fresh', 'klein', 'kleine', 'groot', 'grote', 'vers', 'verse', 'fruity', 'any', 'some']);
const stem = w => w.replace(/(oes|es|en|s)$/, '').replace(/e$/, '');
const keys = name => String(name).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').split(/[^a-z0-9]+/).filter(w => w && !STOP.has(w)).map(stem);
function bestMatch(name, list) {
  const k = keys(name); let best = null, score = 0;
  for (const item of list) {
    const ik = keys(item.name);
    const shared = k.filter(w => ik.some(x => x === w || (x.length > 3 && w.length > 3 && (x.startsWith(w) || w.startsWith(x))))).length;
    const sc = shared / Math.max(k.length, ik.length, 1);
    if (shared && sc > score) { best = item; score = sc; }
  }
  return best;
}
const sameUnit = (a, b) => a === b || (!a && !b);

let seq = 0;
const newId = () => 'i' + Date.now().toString(36).slice(-4) + (seq++).toString(36);

function parseRecipe(text) {
  const lines = String(text || '').split(/\r?\n/).map(l => l.trim());
  let name = '', mode = 'start', sec = null, step = null;
  const master = [], sections = [], intro = [];
  for (const l of lines) {
    if (!l) continue;
    if (!name && !BULLET.test(l)) { name = l.replace(/[:.]$/, ''); continue; }
    if (!BULLET.test(l) && INGR_HEAD.test(l)) { mode = 'master'; continue; }
    if (BULLET.test(l)) {
      const items = parseLine(l);
      if (mode === 'master' || mode === 'start' && !sections.length && !step) { mode = 'master'; master.push(...items); continue; }
      if (!sec) { sec = { title: '', steps: [] }; sections.push(sec); }
      if (!step || step.text) { step = { text: '', uses: [] }; sec.steps.push(step); }
      step.uses.push(...items);
      continue;
    }
    const words = l.split(/\s+/).length;
    const heading = HEAD_WORDS.test(l) || /:$/.test(l) || (words <= 5 && !/[.!?]$/.test(l) && !(step && step.uses.length && !step.text));
    if (heading && !(step && step.uses.length && !step.text && !HEAD_WORDS.test(l))) {
      sec = { title: l.replace(/:$/, ''), steps: [] }; sections.push(sec); step = null; mode = 'steps';
      continue;
    }
    if (mode === 'master' && !sections.length && !step) { mode = 'steps'; }
    if (mode === 'start') { intro.push(l); continue; }
    if (!sec) { sec = { title: '', steps: [] }; sections.push(sec); }
    if (step && (step.uses.length || step.text) && !(step.text && step.closed)) step.text = step.text ? step.text + '\n' + l : l;
    else { step = { text: l, uses: [] }; sec.steps.push(step); }
  }

  // Link each step ingredient to the full list; build the list from the steps when there is none.
  for (const m of master) m.id = newId();
  for (const s of sections) for (const st of s.steps) {
    st.uses = st.uses.map(u => {
      let m = bestMatch(u.name, master);
      if (!m) { m = { ...u, id: newId(), prep: '', fromSteps: true, qty: u.qty, note: u.note }; master.push(m); }
      else if (m.fromSteps && sameUnit(m.unit, u.unit) && u.qty != null) m.qty = (m.qty || 0) + u.qty;
      return { iid: m.id, qty: u.qty, unit: u.unit, prep: u.prep, taste: u.taste, _m: m };
    });
  }
  // "Basil" listed without an amount but "50 grams of basil" in a step: the list takes the step amounts.
  for (const m of master) {
    if (!m.taste) continue;
    const uses = sections.flatMap(s => s.steps.flatMap(st => st.uses.filter(u => u.iid === m.id && u.qty != null)));
    if (uses.length && uses.every(u => sameUnit(u.unit, uses[0].unit))) { m.qty = uses.reduce((a, u) => a + u.qty, 0); m.unit = uses[0].unit; m.taste = false; }
  }
  // A step amount in other words than the list ("1 small can" vs 160 g) means: all of it.
  for (const s of sections) for (const st of s.steps) for (const u of st.uses) {
    const m = u._m; delete u._m;
    if (u.qty != null && !sameUnit(u.unit, m.unit)) { u.qty = m.qty; u.unit = m.unit; }
    if (m.taste || u.taste) { u.qty = null; u.unit = null; u.taste = true; }
  }
  for (const m of master) { delete m.fromSteps; m.prep = ''; }
  return {
    name, intro: intro.join('\n'),
    ingredients: master.map(m => ({ id: m.id, name: m.name, qty: m.qty, unit: m.unit, note: m.note || '', taste: !!m.taste, stock: m.stock !== false })),
    sections: sections.map(s => ({ title: s.title, steps: s.steps.map(st => ({ text: st.text, uses: st.uses.map(u => ({ iid: u.iid, qty: u.qty, unit: u.unit, prep: u.prep || '', taste: !!u.taste })) })) }))
  };
}

const API = { parseRecipe, parseLine, bestMatch };
if (typeof module === 'object' && module.exports) module.exports = API; else root.RecipeText = API;
})(typeof self !== 'undefined' ? self : globalThis);
