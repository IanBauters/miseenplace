# Mise en Place

Self-hosted kitchen planner for the household: pantry with best-before dates, a weekly dinner menu that pushes food at risk of going off to the front, an automatic shopping list, and a 7-day emergency reserve that rotates through the normal menu before it expires.

Runs as one small Docker container on the Synology NAS. Both phones (Android and iPhone) use it as an installable web app, in Dutch or English.

## What it does

**Pantry**
- Every purchase is a separate entry with amount, place (pantries, fridge, freezer, garage, emergency shelf) and best-before date.
- Scan barcodes with the phone camera; a barcode is remembered after you name the product once (no internet lookup).
- *Use* part of something, mark it *Empty* (cooking with leftovers), or *Bin* it with a reason.
- Each product can have a **minimum stock**: as soon as free stock drops below it, one pack goes on the shopping list.

**Recipes**
- Normal recipes with fixed amounts, or recipes built around one **main ingredient**: other amounts are *parts* of it (1 part apples = same weight as the red cabbage) or *per 100 g* of it (1½ tbsp sugar per 100 g). The planned meal uses the main ingredient you have in stock; change it on the meal and everything scales.
- Amounts like `1 1/2`, `1,5` or `½`; spoons (tbsp/tsp) converted with the product's grams per tablespoon.
- Cloves, slices and stalks: a garlic bulb splits into cloves, so a recipe asks for 3 cloves and the pantry shows "1 pcs + 7 cloves".
- *As written*: keep the recipe's own wording next to the real amount, e.g. "1 small can (160 g)". Tins and jars can have a weight, so 160 g of a 400 g tin counts as 0.4 tin.
- Ingredients not taken from stock (tap water) are shown and scaled, but never reserved or bought.

**Menu**
- One dinner per day, weeks run Monday–Sunday. Each day is *Cook at home*, *Eating out*, *Invited* or *Leftovers*.
- *Suggest* picks recipes from your own collection: ingredients closest to their best-before date score highest, then everything is ordered so the most urgent meal is cooked first.
- Planning a meal **reserves** its ingredients, so two meals never count on the same pack. Missing ingredients are shown straight away.
- *Confirm week* locks the week: meals can be moved and added, not removed, and anything missing goes on the shopping list.
- *Cooked* takes the reserved ingredients out of stock. A meal that isn't cooked by Sunday moves to the front of the next week, marked red.

**Shopping list**
- Automatic lines for: below minimum (one pack), missing for a confirmed menu, emergency restock. Plus your own items.
- Tick items into the basket, then *Put away in the pantry* with place and best-before date.
- Share the list to a message.

**Emergency reserve**
- Goal (adjustable): 7 days, 3 people, 3 meals a day, 3 l water per person per day.
- Shows days of food and water covered, and a kit checklist (torch, radio, batteries, first aid, gas cartridges…).
- Products get a *Keep in emergency stock* amount. Stock on an emergency shelf is never used for normal meals, until it is within 2 months of its date: then it joins the menu suggestions, and its replacement goes on the shopping list straight away.

**Waste overview** — everything binned per month, by product and reason. Plus history of who did what.

## Install on the Synology NAS

1. **Make the image public (once).** After the first push, GitHub builds `ghcr.io/ianbauters/miseenplace`. On GitHub open your profile → *Packages* → *miseenplace* → *Package settings* → *Change visibility* → *Public*. (Prefer to keep it private? Then log the NAS in to ghcr.io with a personal access token that has `read:packages`.)
2. **Install with Task Scheduler.** DSM → *Control Panel* → *Task Scheduler* → *Create* → *Triggered Task* → *User-defined script*. User **root**, event **Boot-up**. Paste the contents of [`nas/install.sh`](nas/install.sh) into *Run command*. Save, select the task, click *Run*.
3. **Open it:** `http://10.0.0.105:8380` at home.

Reaching it through another name (for example a Synology reverse-proxy domain)? Add `-e ALLOWED_HOSTS=your.domain` to the `docker run` line; the app only answers on IP addresses, local names and `*.ts.net` to block DNS-rebinding attacks. Don't add a port forward on the router for it.

Data lives in `/volume1/docker/miseenplace` (`db.json` plus 30 daily backups in `backups/`). *More → Download backup* gives a copy too.

### Updates (Watchtower)

Every push to `main` runs the tests, builds the image and publishes `ghcr.io/ianbauters/miseenplace:latest`. Your Watchtower container picks up the new image and restarts Mise en Place with the same settings; the data folder is untouched. The container carries the label `com.centurylinklabs.watchtower.enable=true`, so it is also updated if Watchtower runs in label mode.

## Phones

Access from outside goes through **Tailscale**; nothing is opened to the internet.

1. In the Tailscale admin console → *DNS*, switch on **HTTPS Certificates** (needed for the camera and the offline cache).
2. The install script runs `tailscale serve`, so the app is at `https://<nas-name>.<tailnet>.ts.net:8443`.
3. **Pixel (Firefox):** if Tailscale is limited to selected apps, make sure Firefox is included. Open the https address → menu ⋮ → *Add to Home screen*.
4. **iPhone 13 (Safari):** install the Tailscale app and sign in to the same tailnet. Open the https address in Safari → Share → *Add to Home Screen*.
5. On first start each person picks their name and language. The NL/EN button in the top bar switches language at any time.

## Development

No dependencies. Node 20+.

```sh
npm start        # http://localhost:8080, data in ./data
npm test         # planning engine tests
```

- `src/engine.js` — planning logic: reservations (first-expiry-first-out), carry-over, automatic shopping list, suggestions, emergency coverage
- `src/server.js` — HTTP server, JSON store, live updates (Server-Sent Events)
- `public/` — the web app; `i18n.js` holds the Dutch translations
- `public/vendor/zxing.min.js` — barcode reader ([ZXing](https://github.com/zxing-js/library), Apache 2.0)

## Licence

MIT
