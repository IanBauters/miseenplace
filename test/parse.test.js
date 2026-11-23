'use strict';
// Recipe text reader tests: `npm test`
const assert = require('assert');
const { parseRecipe, parseLine } = require('../public/parse.js');

const one = s => { const r = parseLine(s); assert.strictEqual(r.length, 1, s); const { name, qty, unit, note, prep, taste } = r[0]; return { name, qty, unit, note, prep, taste }; };
assert.deepStrictEqual(one('* 1 small can (160 grams) of white beans'), { name: 'White beans', qty: 160, unit: 'g', note: '1 small can', prep: '', taste: false });
assert.deepStrictEqual(one('* 4 cloves of garlic'), { name: 'Garlic', qty: 4, unit: 'clove', note: '', prep: '', taste: false });
assert.deepStrictEqual(one('* 1 tomato, large diced'), { name: 'Tomato', qty: 1, unit: 'pcs', note: '', prep: 'large diced', taste: false });
assert.deepStrictEqual(one('* 1 small zucchini'), { name: 'Zucchini', qty: 1, unit: 'pcs', note: '', prep: 'small', taste: false });
assert.deepStrictEqual(one('* about 50 grams of basil'), { name: 'Basil', qty: 50, unit: 'g', note: '', prep: '', taste: false });
assert.deepStrictEqual(one('* 3 tablespoons of fruity olive oil'), { name: 'Fruity olive oil', qty: 3, unit: 'tbsp', note: '', prep: '', taste: false });
assert.deepStrictEqual(one('* 50 grams of any small pasta'), { name: 'Small pasta', qty: 50, unit: 'g', note: '', prep: '', taste: false });
assert.deepStrictEqual(one('* Salt'), { name: 'Salt', qty: null, unit: null, note: '', prep: '', taste: true });
assert.deepStrictEqual(one('* 1 1/2 el suiker'), { name: 'Suiker', qty: 1.5, unit: 'tbsp', note: '', prep: '', taste: false });
assert.deepStrictEqual(one('- 2 teentjes look, geplet'), { name: 'Look', qty: 2, unit: 'clove', note: '', prep: 'geplet', taste: false });
assert.deepStrictEqual(one('- 1 klein blikje (70 g) tomatenpuree'), { name: 'Tomatenpuree', qty: 70, unit: 'g', note: '1 klein blikje', prep: '', taste: false });
assert.deepStrictEqual(one('* ½ l melk'), { name: 'Melk', qty: 0.5, unit: 'l', note: '', prep: '', taste: false });
assert.deepStrictEqual(one('* 20 cl room'), { name: 'Room', qty: 200, unit: 'ml', note: '', prep: '', taste: false });
assert.deepStrictEqual(parseLine('* Basil and salt to taste').map(x => [x.name, x.taste]), [['Basil', true], ['Salt', true]]);
assert.deepStrictEqual(parseLine('* peper en zout naar smaak').map(x => x.name), ['Peper', 'Zout']);

const pistou = `Soup au Pistou
All Ingredients.

* 1 small can (160 grams) of white beans
* 1 small can (160 grams) of kidney beans
* 1 small can (160 grams) of green string beans
* 2 tomatoes
* 1 potato
* 1 small zucchini
* 4 cloves of garlic
* Basil
* 50 grams of any small pasta
* 50 grams of grated cheese
* Salt
* Olive oil
* Croutons

Directions for the soup

* 1 small can of white beans
* 1 small can of kidney beans
* 1 small can of green string beans
* 1 tomato, large diced
* 1 potato, large diced
* 1 small zucchini, large diced
* 1 clove of garlic, smashed
* Basil and salt to taste

Put everything in a large pot and cover with water. Simmer for 50 minutes

* 50 grams of pasta
Add the pasta and simmer for another 10 minutes. Remove the garlic if you can

Directions for the pistou

* 1 tomato
* about 50 grams of basil
* 3 cloves of garlic
* 3 tablespoons of fruity olive oil

Purée everything together and keep in the fridge. Add to the soup just before serving`;

const r = parseRecipe(pistou);
const byName = n => r.ingredients.find(i => i.name === n);
assert.strictEqual(r.name, 'Soup au Pistou');
assert.strictEqual(r.ingredients.length, 13, 'the 13 listed ingredients, nothing duplicated');
assert.deepStrictEqual(r.sections.map(s => [s.title, s.steps.length]), [['Directions for the soup', 2], ['Directions for the pistou', 1]]);
const [soup1, soup2] = r.sections[0].steps, pist = r.sections[1].steps[0];
assert.match(soup1.text, /^Put everything in a large pot/);
assert.strictEqual(soup1.uses.length, 9, '3 cans, tomato, potato, zucchini, garlic, basil, salt');
const use = (st, n) => st.uses.find(u => u.iid === byName(n).id);
assert.deepStrictEqual(use(soup1, 'White beans'), { iid: byName('White beans').id, qty: 160, unit: 'g', prep: '', taste: false }, '"1 small can" in a step = the whole 160 g');
assert.deepStrictEqual([use(soup1, 'Tomatoes').qty, use(soup1, 'Tomatoes').prep], [1, 'large diced']);
assert.deepStrictEqual([use(soup1, 'Garlic').qty, use(soup1, 'Garlic').unit, use(soup1, 'Garlic').prep], [1, 'clove', 'smashed']);
assert.strictEqual(use(soup1, 'Zucchini').prep, 'small, large diced');
assert.strictEqual(use(soup1, 'Salt').qty, null);
assert.match(soup2.text, /^Add the pasta/);
assert.strictEqual(use(soup2, 'Small pasta').qty, 50, '"pasta" matches "any small pasta"');
assert.strictEqual(use(pist, 'Garlic').qty, 3);
assert.strictEqual(use(pist, 'Tomatoes').qty, 1);
assert.strictEqual(use(pist, 'Olive oil').qty, 3, '"fruity olive oil" matches "Olive oil"');
assert.deepStrictEqual([byName('Basil').qty, byName('Basil').unit, byName('Basil').taste], [50, 'g', false], 'basil gets the 50 g from the pistou');
assert.deepStrictEqual([use(soup1, 'Basil').qty, use(soup1, 'Basil').taste], [null, true], 'basil stays "to taste" in the soup step');
assert.deepStrictEqual([byName('Croutons').taste, byName('Grated cheese').qty], [true, 50]);
assert.match(pist.text, /Add to the soup just before serving$/);

// Dutch, steps only (the list is built from the steps)
const nl = parseRecipe(`Rode kool
Bereiding
- 600 g rode kool, fijngesneden
- 2 appels
Alles in een pot met wat water en 45 minuten stoven.
- 1 1/2 el suiker
- 1 el suiker
Suiker erbij en goed roeren.`);
assert.deepStrictEqual(nl.ingredients.map(i => [i.name, i.qty, i.unit]), [['Rode kool', 600, 'g'], ['Appels', 2, 'pcs'], ['Suiker', 2.5, 'tbsp']]);
assert.strictEqual(nl.sections[0].steps.length, 2);
console.log('parse tests passed');
