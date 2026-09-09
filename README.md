# EDIO — Sales Geographic Intelligence Dashboard

A complete, self-contained dashboard that turns your Google Sheet of Smart Clone
sales into interactive India maps: **India → State → District → Customers**.

No server, no install, no build step. Everything (postal database, maps,
address engine) ships inside this folder.

---

## 1. Open it

Unzip and double-click **`index.html`**. It opens in any modern browser
(Chrome / Edge / Firefox) and starts with a realistic demo dataset of ~1,300
sales so you can explore every feature immediately.

You can also host the folder on any static host (GitHub Pages, Netlify,
Hostinger, a shared-hosting `public_html`) — it behaves identically.

## 2. Connect your real Google Sheet

1. Open your sales sheet in Google Sheets.
2. Either
   - **Share** → General access → **Anyone with the link** (Viewer), **or**
   - File → Share → **Publish to web** → select the sheet tab → **CSV** → Publish.
3. Copy the link.
4. In the dashboard: **Data quality** tab → *Data source & settings* →
   paste the link → **Connect**.

The dashboard reads the sheet directly from your browser (pressing **Enter**
in the link box also connects). Nothing is uploaded anywhere; your data never
leaves your machine.

**If Connect fails** — some browsers (especially Safari, or any browser when
`index.html` is opened straight from disk) block web requests from local
files. The error message will say so. In that case use the always-works
route: in Google Sheets, **File → Download → CSV**, then
**Upload a CSV file…** in the same settings panel. All maps, filters,
verification and exports behave identically.

**Expected columns** (order and exact wording don't matter — headers are
matched intelligently):

| Date of Tool Purchased | Customer Name | Address | Mobile Number |
|---|---|---|---|

**Optional columns picked up automatically:** `Tool Type` / `Product`,
`Salesperson`, `Quantity` (sales become the sum of quantity), `Dealer`,
`Customer Type`, `Payment`. Any of these with 2+ distinct values becomes a
filter dropdown in the toolbar.

### Sync honesty

- The header always shows **“Last synced …”** — the dashboard is exactly as
  fresh as that moment.
- **↻ Sync data** re-reads the sheet on demand.
- Background polling (off / 1 / 5 / 15 minutes) is configurable in settings.
- If the sheet is unreachable, you get a clear error and the last synced copy
  stays on screen (it is cached locally).

## 3. How addresses become geography

Every row runs through a multi-signal engine, in strict priority order:

1. **PIN code** — checked against a bundled India Post directory of ~19,000
   PINs (with post-2014 district reorganisations applied: Tamil Nadu's
   Tirupattur/Ranipet/Kallakurichi splits, Andhra Pradesh's 26 districts,
   Telangana's 33, and more). Mobile numbers are removed first so a phone
   number can never be mistaken for a PIN.
2. **Explicit state name** (including old spellings: Orissa → Odisha,
   Pondicherry → Puducherry, Tamilnadu → Tamil Nadu…).
3. **District name.**
4. **City / town** — with correct district mapping (Hubli → Dharwad,
   Vaniyambadi → Tirupattur, Varkala → Thiruvananthapuram,
   Srivilliputtur → Virudhunagar, Rameshwaram → Ramanathapuram…).
5. **Locality gazetteer** — ~200,000 post-office and taluk names.

Each record gets a **confidence**: `high` (PIN-verified), `medium`
(city + state, or an approximated district), `low` (vague locality),
`unknown` (no usable signal). **The engine never guesses:** a record with no
signal stays Unknown, and a record whose signals disagree (e.g. *"Hubli,
Tamil Nadu, 580020"*) is marked **conflict** and is never placed on a map.

## 4. Fixing records manually

**Data quality → Needs verification** lists every unknown, conflicting,
low-confidence or approximated record with the reason. Pick the correct
State → District → **Save**. Corrections:

- are stored on your device (browser local storage),
- **survive every sync** — they are keyed to the row's content, not its
  position, so re-reading the sheet never wipes them,
- can be undone per-row or cleared all at once.

## 5. Everything else

- **KPIs** — tools sold, customers, states/districts reached, top state, top
  district. All computed live from the visible data; nothing is hardcoded.
- **Maps** — real GeoJSON boundaries, 36 states/UTs and 736 districts, fixed
  colour scale (0 / 1–10 / 11–50 / 51–100 / 101–250 / 251–500 / 500+) so views
  are comparable. Hover for numbers, click to drill, “← Back” to come up.
- **Tables** — Sales by state / by district with share bars; full customer
  table with search, column sorting and pagination.
- **Privacy** — mobile numbers are masked (98•••••210) by default and never
  appear on maps; a checkbox reveals them when you need them.
- **Duplicates** — same mobile + same date (or identical name + address +
  date) is flagged “possible duplicate”, never auto-deleted.
- **Export CSV** — exports exactly what you're looking at: current date
  filter, facet filters, drill-down scope and search all respected. A separate
  export exists for the needs-verification list.
- **Date filters** — Today / This week / This month / Last month / This year /
  All time / Custom range (dates are parsed day-first: 08/09/2026 = 8 Sep).
- One bad row never breaks anything — it simply lands in Needs verification.

## 6. Known limitations (told straight)

- The district map is drawn from the best open boundary data available.
  Two very new districts have no separate polygon yet: **Mayiladuthurai**
  (shown inside Nagapattinam, TN) and **Vijayanagara** (shown inside Ballari,
  KA). Sales there are still counted correctly at state level.
- PINs that fall in recently split districts are mapped to the modern district
  where the postal taluk makes it certain; where it doesn't, the record is
  marked *approximated* and appears in Needs verification instead of being
  silently guessed.
- Google Sheets must be link-shared or published; private sheets can't be read
  from a browser without a server, and this dashboard doesn't pretend
  otherwise.

## Folder contents

```
index.html          the dashboard (open this)
app.js              application logic
engine.js           address-intelligence engine
data/geo.js         India + district boundaries (GeoJSON)
data/pincodes.js    PIN directory with modern districts
data/places.js      town/locality gazetteer
data/demo-data.js   demo dataset (replaced visually the moment you connect a sheet)
```

Data sources: India Post open PIN directory; openly licensed
Survey-of-India-derived GeoJSON boundaries.
