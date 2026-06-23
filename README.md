# Travel Tracker

A personal, offline-first travel map. Toggle between **countries** (193 UN members +
Vatican + Palestine + Taiwan + Kosovo = 197) and **level-1 administrative regions**
(states / provinces / prefectures). Tap to mark visited; progress is saved locally.

No backend, no accounts, no map-tile provider — polygons are rendered directly, so it
works fully offline and costs nothing to host.

## Stack

- [MapLibre GL JS](https://maplibre.org/) (via CDN) for rendering
- Plain `index.html` + `app.js` + `style.css` — no build step
- [Natural Earth](https://www.naturalearthdata.com/) admin-0 / admin-1 data (public domain)
- State persisted in `localStorage`

## Data prep (one-time)

Generates `data/countries.geojson` and `data/regions.geojson`:

```sh
./scripts/prep.sh
```

Downloads Natural Earth GeoJSON into `raw/` (gitignored), simplifies with `mapshaper`,
and curates to the 197-country allowlist (`scripts/iso197.mjs`).

## Run

Any static server works (relative `fetch` needs HTTP, not `file://`):

```sh
npx -y serve .
# or: python3 -m http.server
```

Then open the printed URL.

## Roadmap

- [x] Country / region two-mode map with hybrid visited coloring
- [ ] Export / import JSON backup
- [ ] UNESCO World Heritage Sites layer
- [ ] PWA shell (manifest + service worker) for home-screen install
