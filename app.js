"use strict";

const TOTAL_COUNTRIES = 197;
const STORAGE_KEY = "travel-tracker:v1";
const DOT_SHAPE_ZOOM = 6; // graduated dots give way to real polygons at/above this zoom

const STATUSES = [
  { id: "lived", label: "Lived in", short: "lived", color: "#8e24aa" },
  { id: "visited", label: "Visited", short: "visited", color: "#2e9e4f" },
  { id: "layover", label: "Layover / passed through", short: "layover", color: "#f5a623" },
  { id: "planned", label: "Planned / wishlist", short: "planned", color: "#2979ff" },
];

// ISO 3166-1 alpha-2 -> bundled circular flag asset
const flagSrc = (cc) => `assets/flags/${cc.toLowerCase()}.svg`;
function setFlag(el, cc) {
  el.textContent = "";
  if (!/^[A-Za-z]{2}$/.test(cc || "")) return;
  const img = document.createElement("img");
  img.className = "flag";
  img.src = flagSrc(cc);
  img.alt = "";
  img.onerror = () => img.remove();
  el.appendChild(img);
}
const STATUS_COLOR = Object.fromEntries(STATUSES.map((s) => [s.id, s.color]));

// theme-aware map palette (mirrors CSS tokens; read from :root so map matches surfaces)
const darkMQ = window.matchMedia("(prefers-color-scheme: dark)");
function cssVar(name, fallback) {
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v || fallback;
}
function mapPalette() {
  return {
    ocean: cssVar("--ocean", darkMQ.matches ? "#0e1b27" : "#8fbcdb"),
    land: cssVar("--land", darkMQ.matches ? "#2b333c" : "#d6ccb6"),
    none: cssVar("--none", darkMQ.matches ? "#3c4651" : "#ebe3d2"),
    border: cssVar("--border-on-map", darkMQ.matches ? "#66788a" : "#5f7180"),
    regionBorder: cssVar("--region-border", darkMQ.matches ? "#8b9bac" : "#46586a"),
    selectInk: darkMQ.matches ? "#f4f7fa" : "#15202b",
  };
}
let PAL = mapPalette();

// color expression shared by every layer: feature-state.status -> color
// (function so the trailing "none" color tracks the active theme)
const statusColorExpr = () => [
  "match",
  ["feature-state", "status"],
  ...STATUSES.flatMap((s) => [s.id, s.color]),
  PAL.none,
];

// --- persisted state (code/id -> status) -----------------------------------
function loadState() {
  try {
    const raw = JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}");
    if (raw.countries || raw.regions) return { countries: raw.countries || {}, regions: raw.regions || {} };
    // migrate v1 binary sets -> "visited"
    const countries = {};
    const regions = {};
    (raw.visitedCountries || []).forEach((c) => (countries[c] = "visited"));
    (raw.visitedRegions || []).forEach((r) => (regions[r] = "visited"));
    return { countries, regions };
  } catch {
    return { countries: {}, regions: {} };
  }
}

function saveState() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify({ countries: state.countries, regions: state.regions }));
}

const state = loadState();
const mode = "countries"; // regions now live in the popup, not a separate map mode
let regionsByCountry = new Map();
let regionById = new Map(); // region id -> feature (for the interactive popup)
let totalRegions = 0;
let pointIds = new Set();
let dotOnlyIds = new Set();
let sovereignToIds = new Map(); // sovereign code -> [feature ids it colors: self + territories]
let countryCodes = []; // the 197 sovereign codes
let nameByCode = {}; // sovereign code -> country name

// --- status get/set --------------------------------------------------------
const regionStatus = (id) => state.regions[id] || "none";
const countryExplicit = (cc) => state.countries[cc] || "none"; // what the user set on the country itself
const STATUS_RANK = Object.fromEntries(STATUSES.map((s, i) => [s.id, STATUSES.length - i])); // lived highest
// A country's trackable subdivisions = its admin-1 regions + its dependent territories
// (Puerto Rico, Hong Kong, …). Both store status in state.regions, keyed by their id.
const territoriesOf = (cc) => (sovereignToIds.get(cc) || []).filter((id) => id !== cc);
const subUnitIds = (cc) => [...(regionsByCountry.get(cc) || []), ...territoriesOf(cc)];
function unitName(id) {
  const rf = regionById.get(id);
  if (rf) return rf.properties.name;
  const cf = countriesData.features.find((x) => x.id === id);
  return cf ? cf.properties.name : id;
}
function countryOfUnit(id) {
  const rf = regionById.get(id);
  if (rf) return rf.properties.country;
  const cf = countriesData.features.find((x) => x.id === id);
  return cf ? cf.properties.sovereign : null;
}
function unitType(id) {
  const rf = regionById.get(id);
  if (rf) return rf.properties.type || "Region";
  const cf = countriesData.features.find((x) => x.id === id);
  return (cf && cf.properties.type) || "Territory";
}
function unitNameLocal(id) {
  const rf = regionById.get(id);
  return rf ? rf.properties.nameLocal : null;
}
// display name with the local-language name in brackets: "Bavaria (Bayern)"
function unitDisplayName(id) {
  const local = unitNameLocal(id);
  return local ? `${unitName(id)} (${local})` : unitName(id);
}
// secondary line for a subdivision: type [· country]
function unitSub(id, withCountry) {
  const cc = withCountry ? countryOfUnit(id) : null;
  return [unitType(id), cc ? nameByCode[cc] || cc : null].filter(Boolean).join(" · ");
}
// sort subdivisions by type (states, then provinces, then dependencies…), then by name
const byTypeName = (a, b) => unitType(a).localeCompare(unitType(b)) || unitName(a).localeCompare(unitName(b));
// Effective country status: its best status across its own mark and any subdivision —
// visiting/living in a region or territory means you've been to the country.
function countryStatus(cc) {
  let best = countryExplicit(cc);
  let rank = STATUS_RANK[best] || 0;
  for (const id of subUnitIds(cc)) {
    const r = STATUS_RANK[state.regions[id]] || 0;
    if (r > rank) { rank = r; best = state.regions[id]; }
  }
  return best;
}

// Three detail tiers for zoom LOD; only one renders at a given zoom (layer min/maxzoom).
// Feature-state (status/selection/hover) must be applied to every *loaded* tier source.
const COUNTRY_TIERS = [
  { source: "countries", maxzoom: 4 }, // lo — loaded at start
  { source: "countries-mid", url: "data/countries-mid.geojson", minzoom: 4, maxzoom: 6 },
  { source: "countries-hi", url: "data/countries-hi.geojson", minzoom: 6 },
];
const countrySources = () => COUNTRY_TIERS.map((t) => t.source).filter((s) => map.getSource(s));
const countryFillLayers = () => COUNTRY_TIERS.map((t) => t.source + "-fill").filter((id) => map.getLayer(id));
const countryLineLayers = () => COUNTRY_TIERS.map((t) => t.source + "-line").filter((id) => map.getLayer(id));
function countryRefs(id) {
  const refs = countrySources().map((s) => ({ source: s, id }));
  if (pointIds.has(id)) refs.push({ source: "country-points", id });
  return refs;
}

function setCountryState(cc) {
  const status = countryStatus(cc);
  for (const id of sovereignToIds.get(cc) || [cc])
    for (const ref of countryRefs(id)) map.setFeatureState(ref, { status }); // self + territories, every tier
}
function setRegionState(id) {
  map.setFeatureState({ source: "regions", id }, { status: regionStatus(id) });
}

function setCountryStatus(cc, status) {
  if (status === "none") delete state.countries[cc];
  else state.countries[cc] = status;
  setCountryState(cc);
  saveState();
  renderStats();
}
function setRegionStatus(id, status) {
  if (status === "none") delete state.regions[id];
  else state.regions[id] = status;
  setRegionState(id);
  const cc = countryOfUnit(id); // the country's effective status may have changed -> repaint it
  if (cc) setCountryState(cc);
  saveState();
  renderStats();
}

function applyAllCountryStates() {
  for (const cc of countryCodes) setCountryState(cc);
}
function applyAllRegionStates() {
  for (const id of Object.keys(state.regions)) setRegionState(id);
}

// --- stats -----------------------------------------------------------------
function breakdown(counts) {
  return STATUSES.map((s) => (counts[s.id] ? `${counts[s.id]} ${s.short}` : null)).filter(Boolean).join(" · ");
}
function renderStats() {
  const counts = { lived: 0, visited: 0, layover: 0, planned: 0 };
  for (const cc of countryCodes) { const s = countryStatus(cc); if (s in counts) counts[s]++; }
  const been = counts.lived + counts.visited + counts.layover;
  const primary = document.getElementById("stat-primary");
  const secondary = document.getElementById("stat-secondary");
  if (primary) primary.textContent = `${been} / ${TOTAL_COUNTRIES} countries`;
  if (secondary) secondary.textContent = breakdown(counts);
  renderListBody();
}

// --- selection + side panel ------------------------------------------------
let selected = null; // { kind, key, name, via }
let selectedRefs = null;
let hoverRefs = null;

function setHover(refs) {
  if (hoverRefs) hoverRefs.forEach((r) => map.setFeatureState(r, { hover: false }));
  hoverRefs = refs;
  if (hoverRefs) hoverRefs.forEach((r) => map.setFeatureState(r, { hover: true }));
}

function setPanelOpen(open) {
  const panel = document.getElementById("sidepanel");
  panel.hidden = !open;
  panel.setAttribute("aria-hidden", open ? "false" : "true");
  document.getElementById("scrim").hidden = !open;
  document.body.classList.toggle("sheet-open", open);
}

function clearSelection() {
  if (selectedRefs) selectedRefs.forEach((r) => map.setFeatureState(r, { selected: false }));
  selectedRefs = null;
  selected = null;
  popRegion = null;
  setPanelOpen(false);
  hideDetail();
}

function selectPlace(sel) {
  if (selectedRefs) selectedRefs.forEach((r) => map.setFeatureState(r, { selected: false }));
  selected = sel;
  selectedRefs = sel.kind === "country" ? countryRefs(sel.key) : [{ source: "regions", id: sel.key }];
  selectedRefs.forEach((r) => map.setFeatureState(r, { selected: true }));
  renderPanel();
  showDetail(sel);
}

function renderPanel() {
  if (!selected) {
    setPanelOpen(false);
    return;
  }
  // a popup subdivision (if one is picked) takes over the sheet; otherwise it's the country.
  // The country shows its EFFECTIVE status (so marking a region updates it), set the explicit.
  const isRegion = !!popRegion;
  const name = isRegion ? unitDisplayName(popRegion) : selected.name;
  const current = isRegion ? regionStatus(popRegion) : countryStatus(selected.key);

  setFlag(document.getElementById("place-flag"), selected.flagCode);
  document.getElementById("place-name").textContent = name;
  const via = document.getElementById("place-via");
  if (isRegion) {
    via.textContent = "‹ " + [unitType(popRegion), selected.name].filter(Boolean).join(" · ");
    via.hidden = false;
    via.style.cursor = "pointer";
    via.onclick = navBack;
  } else {
    via.textContent = selected.via ? `via ${selected.via}` : "";
    via.hidden = !selected.via;
    via.style.cursor = "";
    via.onclick = null;
  }
  const cur = STATUSES.find((s) => s.id === current);
  const list = document.getElementById("status-list");
  list.textContent = "";
  list.classList.remove("open");

  // collapsed trigger showing the current status; tap to reveal the options
  const trigger = document.createElement("button");
  trigger.type = "button";
  trigger.className = "status-select" + (cur ? " set" : "");
  trigger.setAttribute("aria-expanded", "false");
  const tsw = document.createElement("span");
  tsw.className = "swatch" + (cur ? "" : " empty");
  if (cur) tsw.style.background = cur.color;
  const tlabel = document.createElement("span");
  tlabel.className = "status-label";
  tlabel.textContent = cur ? cur.label : "Set status";
  const chev = document.createElement("span");
  chev.className = "chev";
  chev.setAttribute("aria-hidden", "true");
  chev.textContent = "▾";
  trigger.append(tsw, tlabel, chev);
  trigger.onclick = () => {
    const open = list.classList.toggle("open");
    trigger.setAttribute("aria-expanded", open ? "true" : "false");
  };
  list.appendChild(trigger);

  // the options (hidden until open via CSS): the four statuses + "Not visited" (clears)
  const menu = document.createElement("div");
  menu.className = "status-menu";
  const addOpt = (id, label, color) => {
    const o = document.createElement("button");
    o.type = "button";
    o.className = "status-opt" + (current === id ? " active" : "");
    const sw = document.createElement("span");
    sw.className = "swatch" + (color ? "" : " empty");
    if (color) sw.style.background = color;
    o.append(sw, document.createTextNode(label));
    o.onclick = () => assign(id);
    menu.appendChild(o);
  };
  for (const s of STATUSES) addOpt(s.id, s.label, s.color);
  addOpt("none", "Not visited", null);
  list.appendChild(menu);

  const actions = document.getElementById("panel-actions");
  actions.textContent = "";
  if (!isRegion && subUnitIds(selected.key).length) {
    const drill = document.createElement("button");
    drill.id = "drill-btn";
    drill.type = "button";
    drill.append(document.createTextNode("View regions"));
    const arrow = document.createElement("span");
    arrow.setAttribute("aria-hidden", "true");
    arrow.textContent = "›";
    drill.appendChild(arrow);
    drill.onclick = () => { const cc = selected.key; navClosePopup(); drillList(cc); };
    actions.appendChild(drill);
    const hint = document.createElement("p");
    hint.id = "region-hint";
    hint.textContent = "…or tap a region on the map";
    actions.appendChild(hint);
  }

  setPanelOpen(true);
}

function assign(statusId) {
  if (popRegion) setRegionStatus(popRegion, statusId);
  else if (selected) setCountryStatus(selected.key, statusId);
  else return;
  renderPanel(); // refresh active status
  renderDetail(); // recolour the popup
}

// --- floating detail outline (d3-geo, true-shape azimuthal, no Mercator) -----
const SVGNS = "http://www.w3.org/2000/svg";
let detailSel = null;
let popRegion = null; // admin-1 region selected inside the popup
let popZoom = { k: 1, x: 0, y: 0 }; // pan/zoom transform of the popup country map

const detailHighlight = (status) => (status === "none" ? "#8a96a3" : STATUS_COLOR[status]);

// d3-geo needs each exterior ring to enclose the *small* side of the sphere (CCW) and
// holes the large side (CW). Our source is often reversed, which makes a polygon fill the
// whole globe minus the country. Spherical area is antimeridian-safe, unlike planar.
function rewind(poly) {
  return poly.map((ring, i) => (d3.geoArea({ type: "Polygon", coordinates: [ring] }) > 2 * Math.PI === i > 0 ? ring : ring.slice().reverse()));
}
function rewindGeom(g) {
  return g.type === "Polygon"
    ? { type: "Polygon", coordinates: rewind(g.coordinates) }
    : { type: "MultiPolygon", coordinates: g.coordinates.map(rewind) };
}


// every individual polygon of the selection (rewound for d3), with spherical metrics.
// `ring` is the full outer ring (exact edge tests) and `radius` its angular extent from
// the centroid (lets splitMain reject far pairs without scanning every vertex).
function detailPolys(sel) {
  const items = [];
  const polysOf = (g) => (g.type === "Polygon" ? [g.coordinates] : g.coordinates);
  // Split metrics come from lo-res (fast clustering), but `draw` keeps the hi-res polygon
  // for crisp rendering — paired by index since keep-shapes preserves polygon order.
  const addFeature = (loF, hiF, fromMain) => {
    const loPolys = polysOf(loF.geometry);
    const hiRw = (hiF ? polysOf(hiF.geometry) : loPolys).map(rewind); // rewound so centroids are valid
    const hiCentroids = hiRw.map((c) => d3.geoCentroid({ type: "Polygon", coordinates: c }));
    for (const loPoly of loPolys) {
      const geometry = { type: "Polygon", coordinates: rewind(loPoly) };
      const centroid = d3.geoCentroid(geometry);
      // pair to the matching hi polygon by nearest centroid (mapshaper reorders by tier)
      let best = geometry.coordinates, bd = Infinity;
      for (let j = 0; j < hiRw.length; j++) {
        const d = d3.geoDistance(centroid, hiCentroids[j]);
        if (d < bd) { bd = d; best = hiRw[j]; }
      }
      const draw = { type: "Polygon", coordinates: best };
      const ring = geometry.coordinates[0];
      let radius = 0;
      for (const p of ring) radius = Math.max(radius, d3.geoDistance(centroid, p));
      items.push({ geometry, draw, fromMain, centroid, area: d3.geoArea(geometry), ring, radius });
    }
  };
  if (sel.kind === "country") {
    for (const id of sovereignToIds.get(sel.key) || [sel.key]) {
      const loF = countriesData.features.find((x) => x.id === id);
      // small countries use full-res detail geometry; everything else the hi tier
      const detF = countriesDetailData && countriesDetailData.features.find((x) => x.id === id);
      const hiF = detF || (countriesHiData && countriesHiData.features.find((x) => x.id === id));
      // detail geometry has islands the lo tier lacks, so split on it too (avoids a
      // polygon-count mismatch that would drop those islands)
      if (loF || detF) addFeature(detF || loF, hiF, id === sel.key);
    }
  } else {
    const f = regionsData.features.find((x) => x.id === sel.key);
    if (f) addFeature(f, null, true);
  }
  return items;
}

// Group polygons into the mainland cluster + detached far clusters (each an inset).
// Single-linkage by min edge distance (~7°): chains keep archipelagos (Indonesia,
// Malaysia, Svalbard ≈6°) whole, while genuinely separated land (Alaska ≈7.4°, Greenland,
// Hawaii, overseas departments) splits off. The mainland is anchored on the sovereign's
// OWN feature so a separate huge territory (Greenland) can't masquerade as Denmark.
function splitMain(items) {
  const LINK = (7 * Math.PI) / 180;
  const pool = items.filter((it) => it.fromMain);
  const anchor = (pool.length ? pool : items).reduce((a, b) => (b.area > a.area ? b : a));
  const parent = items.map((_, i) => i);
  const find = (i) => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  const near = (a, b) => {
    if (d3.geoDistance(a.centroid, b.centroid) - a.radius - b.radius >= LINK) return false; // can't reach
    for (const p of a.ring) for (const q of b.ring) if (d3.geoDistance(p, q) < LINK) return true;
    return false;
  };
  for (let i = 0; i < items.length; i++)
    for (let j = i + 1; j < items.length; j++)
      if (find(i) !== find(j) && near(items[i], items[j])) parent[find(i)] = find(j);
  const root = find(items.indexOf(anchor));
  const groups = new Map();
  items.forEach((it, i) => {
    const r = find(i);
    (groups.get(r) || groups.set(r, []).get(r)).push(it);
  });
  const main = groups.get(root);
  let insets = [...groups].filter(([r]) => r !== root).map(([, g]) => g);

  // A detached cluster whose centre still falls within the mainland's bounding box isn't
  // really "overseas" — e.g. India's Andaman & Nicobar — so fold it back inline instead of
  // making a cutout. Genuinely off-map territories (Greenland, Hawaii, Canaries) stay out.
  let w = 180, s = 90, e = -180, n = -90;
  for (const it of main) for (const [lon, lat] of it.ring) {
    if (lon < w) w = lon;
    if (lon > e) e = lon;
    if (lat < s) s = lat;
    if (lat > n) n = lat;
  }
  w -= 2; e += 2; s -= 2; n += 2;
  const within = (c) => c[0] >= w && c[0] <= e && c[1] >= s && c[1] <= n;
  const kept = [];
  for (const cl of insets) {
    const big = cl.reduce((a, b) => (b.area > a.area ? b : a));
    if (within(big.centroid)) main.push(...cl);
    else kept.push(cl);
  }
  return { main, insets: kept };
}

function svgEl(name, attrs) {
  const el = document.createElementNS(SVGNS, name);
  for (const k in attrs) el.setAttribute(k, attrs[k]);
  return el;
}
function fc(items) {
  return { type: "FeatureCollection", features: items.map((m) => ({ type: "Feature", geometry: m.draw || m.geometry })) };
}
// fit the projection to `fitGeo` (e.g. the dominant landmass) but draw `drawGeo` (all of
// it); far stragglers like the Aleutians then extend past the box and get clipped.
function drawOutline(parent, drawGeo, fitGeo, extent, fill, stroke, strokeW) {
  const c = d3.geoCentroid(fitGeo);
  const proj = d3.geoAzimuthalEqualArea().rotate([-c[0], -c[1]]).fitExtent(extent, fitGeo);
  const d = d3.geoPath(proj)(drawGeo);
  if (d) parent.appendChild(svgEl("path", { d, fill, stroke, "stroke-width": strokeW, "stroke-linejoin": "round" }));
}

function unitFeature(id) {
  return regionById.get(id) || (countriesData && countriesData.features.find((x) => x.id === id)) || null;
}
// A clickable subdivision overlay (admin-1 region or dependent territory), drawn with the
// given projection. Tiny ones (DC, Hong Kong) render as a dot so they stay visible/clickable.
// When the COUNTRY itself is marked, unset subdivisions are borderless so the country reads
// as one mark rather than looking like every subdivision was set individually.
function unitEl(id, path, country, zoomed) {
  const f = unitFeature(id);
  if (!f) return null;
  if (!f._rw) f._rw = rewindGeom(f.geometry);
  const b = path.bounds(f._rw);
  if (!isFinite(b[0][0])) return null;
  const rstat = regionStatus(id);
  const sel = popRegion === id;
  const showBorder = sel || rstat !== "none" || countryExplicit(country) === "none";
  const k = zoomed ? popZoom.k : 1; // main area is zoomable; insets are fixed
  let el;
  // a tiny land subdivision (DC, Hong Kong) becomes a constant-size dot marker
  if (Math.max(b[1][0] - b[0][0], b[1][1] - b[0][1]) * k < 9) {
    const c = path.centroid(f._rw);
    const baseR = sel ? 5 : 4;
    el = svgEl("circle", { cx: c[0], cy: c[1], r: baseR / k, "data-r": zoomed ? baseR : "", class: "pop-region dot" + (sel ? " sel" : ""),
      fill: detailHighlight(rstat), "fill-opacity": rstat === "none" ? 0.9 : 0.92,
      stroke: sel ? PAL.selectInk : PAL.regionBorder, "stroke-width": sel ? 1.6 : 0.9 });
  } else {
    el = svgEl("path", { d: path(f._rw), class: "pop-region" + (sel ? " sel" : ""),
      fill: rstat === "none" ? "transparent" : detailHighlight(rstat),
      "fill-opacity": rstat === "none" ? 0 : 0.92,
      stroke: sel ? PAL.selectInk : showBorder ? PAL.regionBorder : "none", "stroke-width": sel ? 1.8 : 0.9 });
  }
  el.addEventListener("click", (e) => { e.stopPropagation(); if (!popDidPan) popSelectRegion(id); });
  return el;
}

function showDetail(sel) {
  detailSel = sel;
  popRegion = null;
  popZoom = { k: 1, x: 0, y: 0 };
  const el = document.getElementById("detail");
  el.hidden = false;
  el.setAttribute("aria-hidden", "false");
  renderDetail();
}
function hideDetail() {
  detailSel = null;
  const el = document.getElementById("detail");
  el.hidden = true;
  el.setAttribute("aria-hidden", "true");
}
const applyDetail = renderDetail; // status change -> recolour by re-rendering

// Island nations drawn as one map (no insets) with PER-REGION borders: a region that is one
// landmass (or part of a shared island) keeps solid land borders; a region that is a scattered
// GROUP of islands is "circled off" with a dashed maritime ellipse. So Seychelles' Mahé
// districts stay solid while its Outer Islands group reads as one dashed maritime zone.
const ARCHIPELAGO = new Set(["FM", "KI", "MH", "TV", "TO", "MV", "SC", "FJ", "WS", "KM", "CV", "VU", "SB", "BS", "PW", "NR", "ID", "PH"]);
// nations whose subdivision polygons are unusable crude blobs — show a centroid dot per region
// instead of the polygon (Maldives' atolls)
const ARCHIPELAGO_DOTS = new Set(["MV"]);

function pointInPoly(pt, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i][0], yi = poly[i][1], xj = poly[j][0], yj = poly[j][1];
    if ((yi > pt[1]) !== (yj > pt[1]) && pt[0] < ((xj - xi) * (pt[1] - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
function circleRing(cx, cy, r, n = 22) {
  const ring = [];
  for (let i = 0; i < n; i++) { const a = (i / n) * 2 * Math.PI; ring.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]); }
  ring.push(ring[0]);
  return ring;
}
// A region's "maritime shape": buffer every one of its islands by `buffer` px and union the
// buffers. This covers EVERY island (each is buffered) yet hugs them tightly — it never fills
// the convex gaps between far islands, so it can't envelop another region sitting in a gap.
// Returns a MultiPolygon ([[ring, hole…], …]) or null.
function islandsUnion(polysList, path, buffer) {
  const circles = [];
  for (const poly of polysList) {
    const pb = path.bounds({ type: "Polygon", coordinates: poly });
    if (!isFinite(pb[0][0])) continue;
    const cx = (pb[0][0] + pb[1][0]) / 2, cy = (pb[0][1] + pb[1][1]) / 2;
    const r = Math.max((pb[1][0] - pb[0][0]) / 2, (pb[1][1] - pb[0][1]) / 2, 1.5) + buffer;
    circles.push([circleRing(cx, cy, r)]);
  }
  if (!circles.length || typeof polygonClipping === "undefined") return null;
  try { return polygonClipping.union(...circles); } catch { return null; }
}
function multiPolyPath(mp) {
  let d = "";
  for (const poly of mp) for (const ring of poly) d += "M" + ring.map((p) => p[0].toFixed(1) + " " + p[1].toFixed(1)).join("L") + "Z";
  return d;
}
function inMultiPoly(pt, mp) {
  for (const poly of mp) {
    if (!pointInPoly(pt, poly[0])) continue;
    let inHole = false;
    for (let h = 1; h < poly.length; h++) if (pointInPoly(pt, poly[h])) { inHole = true; break; }
    if (!inHole) return true;
  }
  return false;
}

// Island nation popup: each region drawn by its own geography. A region of scattered, isolated
// islands is "circled off" with a dashed maritime blob hugging them (the clickable handle); a
// region that is one landmass — or interleaved with other regions — keeps solid land borders.
function renderIslandsGrouped(host, country, items, W, H, dotsMode = false) {
  const svg = svgEl("svg", { width: W, height: H, viewBox: `0 0 ${W} ${H}` });
  const allGeo = fc(items);
  const mc = d3.geoCentroid(allGeo);
  const mx = W * 0.1, my = H * 0.1;
  const proj = d3.geoAzimuthalEqualArea().rotate([-mc[0], -mc[1]]).fitExtent([[mx, my], [W - mx, H - my]], allGeo);
  const path = d3.geoPath(proj);

  const acp = svgEl("clipPath", { id: "pop-area-clip" });
  acp.appendChild(svgEl("rect", { x: 0, y: 0, width: W, height: H }));
  svg.appendChild(acp);
  const area = svgEl("g", { "clip-path": "url(#pop-area-clip)" });
  const zg = svgEl("g", { id: "pop-zoom-g", transform: `translate(${popZoom.x} ${popZoom.y}) scale(${popZoom.k})` });
  area.appendChild(zg);
  svg.appendChild(area);

  const rids = regionsByCountry.get(country) || [];
  // precompute each region's projected centroid + bbox (used for the interleaving test)
  const meta = [];
  for (const rid of rids) {
    const f = regionById.get(rid);
    if (!f) continue;
    if (!f._rw) f._rw = rewindGeom(f.geometry);
    if (!f._rc) f._rc = d3.geoCentroid(f._rw);
    const b = path.bounds(f._rw);
    if (isFinite(b[0][0])) meta.push({ rid, f, b, c: path.centroid(f._rw) });
  }

  const shapes = [], marks = []; // grouping blobs underneath, islands/dots on top
  for (const { rid, f, b, c } of meta) {
    const st = regionStatus(rid);
    const sel = popRegion === rid;
    const w = b[1][0] - b[0][0], h = b[1][1] - b[0][1];
    const polysList = f._rw.type === "Polygon" ? [f._rw.coordinates] : f._rw.coordinates;
    let bigIsland = 0; // largest single island in the region (projected px)
    for (const poly of polysList) {
      const pb = path.bounds({ type: "Polygon", coordinates: poly });
      if (isFinite(pb[0][0])) bigIsland = Math.max(bigIsland, pb[1][0] - pb[0][0], pb[1][1] - pb[0][1]);
    }
    const scattered = polysList.length >= 2 && bigIsland <= 20 && Math.max(w, h) > 10;
    const tiny = polysList.length < 2 && Math.max(w, h) < 24; // a lone small island/atoll
    const select = (e) => { e.stopPropagation(); if (!popDidPan) popSelectRegion(rid); };

    // a scattered group, or a lone small island, gets a dashed maritime shape hugging its
    // islands — but only if that shape doesn't swallow another region's islands (interleaving)
    let grouped = false;
    if (scattered || tiny) {
      const uni = islandsUnion(polysList, path, 8);
      if (uni && uni.length && !meta.some((o) => o.rid !== rid && inMultiPoly(o.c, uni))) {
        grouped = true;
        const shape = svgEl("path", {
          d: multiPolyPath(uni), "fill-rule": "evenodd", class: "pop-cell" + (sel ? " sel" : ""),
          fill: st !== "none" ? detailHighlight(st) : PAL.selectInk,
          "fill-opacity": st !== "none" ? (sel ? 0.3 : 0.15) : sel ? 0.07 : 0,
          stroke: sel ? PAL.selectInk : PAL.regionBorder, "stroke-width": sel ? 1.3 : 0.8, "stroke-dasharray": "2.5 3",
        });
        shape.addEventListener("click", select);
        shapes.push(shape);
      }
    }
    // a grouped region whose only "island" is a big reef-area polygon (no real land, e.g. a
    // Marshall Islands atoll) is shown by its dashed shape alone — drawing the polygon solid
    // would just be an ugly blob
    if (grouped && bigIsland >= 14) continue;
    // the islands themselves — or a centroid dot when the polygons are unusable (Maldives)
    let mark;
    if (dotsMode) {
      if (!isFinite(c[0])) continue;
      const baseR = sel ? 4.5 : 3.5;
      mark = svgEl("circle", { cx: c[0], cy: c[1], r: baseR / popZoom.k, "data-r": baseR,
        class: grouped ? "pop-island" : "pop-region" + (sel ? " sel" : ""),
        fill: detailHighlight(st), "fill-opacity": 0.95,
        stroke: sel ? PAL.selectInk : PAL.regionBorder, "stroke-width": sel ? 1 : 0.7 });
    } else {
      const d = path(f._rw);
      if (!d) continue;
      mark = svgEl("path", { d, class: grouped ? "pop-island" : "pop-region" + (sel ? " sel" : ""),
        fill: detailHighlight(st), "fill-opacity": 0.95,
        stroke: sel ? PAL.selectInk : PAL.regionBorder, "stroke-width": sel ? 0.9 : 0.5 });
    }
    if (!grouped) mark.addEventListener("click", select); // compact island is its own handle
    marks.push(mark);
  }
  for (const s of shapes) zg.appendChild(s);
  for (const m of marks) zg.appendChild(m);
  host.appendChild(svg);
  attachPopInteraction(svg);
}

function renderDetail() {
  const host = document.getElementById("pop-map");
  if (!host) return;
  host.textContent = "";
  if (!detailSel || !window.d3) return;
  const items = detailPolys(detailSel);
  if (!items.length) return;

  const W = host.clientWidth || 320;
  const H = host.clientHeight || 240;
  const country = detailSel.kind === "country" ? detailSel.key : null;
  // dispersed island nations: one map (no insets), regions shown as a maritime partition
  if (country && ARCHIPELAGO.has(country)) { renderIslandsGrouped(host, country, items, W, H, ARCHIPELAGO_DOTS.has(country)); return; }
  const { main, insets } = country ? splitMain(items) : { main: items, insets: [] };
  const status = country ? countryExplicit(country) : regionStatus(detailSel.key);
  const fill = detailHighlight(status);
  const stroke = PAL.selectInk;
  const pad = 12;
  const gap = 7;

  // Each inset is fit to its dominant landmass (the polygons making up ~88% of area), so
  // Alaska's mainland fills the box and the spread-out Aleutians clip rather than shrink it.
  const boxes = insets.map((g) => {
    const sorted = g.slice().sort((a, b) => b.area - a.area);
    const total = sorted.reduce((s, p) => s + p.area, 0);
    const fitItems = [];
    let acc = 0;
    for (const p of sorted) { fitItems.push(p); acc += p.area; if (acc >= total * 0.88) break; }
    return { items: g, fitItems, area: fitItems.reduce((s, p) => s + p.area, 0), centroid: d3.geoCentroid(fc(g)), units: [] };
  }).sort((a, b) => b.area - a.area);
  const amax = boxes.length ? boxes[0].area : 1;
  for (const b of boxes) b.size = Math.round(30 + Math.sqrt(b.area / amax) * 34);

  // pack boxes into rows within the available width (every territory is shown)
  const rows = [];
  let row = [];
  for (const b of boxes) {
    const used = row.reduce((s, x) => s + x.size + gap, 0);
    if (row.length && used + b.size > W - 2 * pad) { rows.push(row); row = []; }
    row.push(b);
  }
  if (row.length) rows.push(row);
  const rowH = (r) => Math.max(...r.map((b) => b.size));
  const stripH = rows.length ? rows.reduce((s, r) => s + rowH(r) + gap, 0) + gap : 0;

  const svg = svgEl("svg", { width: W, height: H, viewBox: `0 0 ${W} ${H}` });

  // country area — zoomable, clipped to above the inset strip
  const mainGeo = fc(main && main.length ? main : items);
  const mc = d3.geoCentroid(mainGeo);
  const proj = d3.geoAzimuthalEqualArea().rotate([-mc[0], -mc[1]]).fitExtent([[pad, pad], [W - pad, H - stripH - pad]], mainGeo);
  const path = d3.geoPath(proj);
  const acp = svgEl("clipPath", { id: "pop-area-clip" });
  acp.appendChild(svgEl("rect", { x: 0, y: 0, width: W, height: H - stripH }));
  svg.appendChild(acp);
  const area = svgEl("g", { "clip-path": "url(#pop-area-clip)" });
  const zg = svgEl("g", { id: "pop-zoom-g", transform: `translate(${popZoom.x} ${popZoom.y}) scale(${popZoom.k})` });
  area.appendChild(zg);
  svg.appendChild(area);

  const md = path(mainGeo);
  if (md) zg.appendChild(svgEl("path", { d: md, class: "pop-land", fill, stroke, "stroke-width": 1.3 }));

  // assign each subdivision (region or territory) to the nearest cluster, render once
  const mainUnits = [];
  if (country) {
    for (const uid of subUnitIds(country)) {
      const f = unitFeature(uid);
      if (!f) continue;
      if (!f._rw) f._rw = rewindGeom(f.geometry);
      if (!f._rc) f._rc = d3.geoCentroid(f._rw);
      let target = mainUnits, bd = d3.geoDistance(f._rc, mc);
      for (const b of boxes) { const d = d3.geoDistance(f._rc, b.centroid); if (d < bd) { bd = d; target = b.units; } }
      target.push(uid);
    }
  }
  // main-area subdivisions (clickable; tiny ones become dots)
  for (const uid of mainUnits) { const el = unitEl(uid, path, country, true); if (el) zg.appendChild(el); }

  // insets: no boxes — each excerpt vertically centred in its row, separated by a hairline
  if (rows.length) svg.appendChild(svgEl("line", { x1: pad, y1: H - stripH, x2: W - pad, y2: H - stripH, stroke: PAL.border, "stroke-width": 1, opacity: 0.35 }));
  let y = H - stripH + gap;
  let clip = 0;
  for (const r of rows) {
    const h = rowH(r);
    const totalW = r.reduce((s, b) => s + b.size, 0) + (r.length - 1) * gap;
    let x = (W - totalW) / 2;
    r.forEach((b, idx) => {
      if (idx > 0) svg.appendChild(svgEl("line", { x1: x - gap / 2, y1: y + h * 0.18, x2: x - gap / 2, y2: y + h * 0.82, stroke: PAL.border, "stroke-width": 1, opacity: 0.4 }));
      const id = "pop-clip-" + clip++;
      const cp = svgEl("clipPath", { id });
      cp.appendChild(svgEl("rect", { x, y, width: b.size, height: h }));
      svg.appendChild(cp);
      const g = svgEl("g", { "clip-path": `url(#${id})` });
      const bFit = fc(b.fitItems);
      const bc = d3.geoCentroid(bFit);
      const ipath = d3.geoPath(d3.geoAzimuthalEqualArea().rotate([-bc[0], -bc[1]]).fitExtent([[x + 2, y + 2], [x + b.size - 2, y + h - 2]], bFit));
      const land = ipath(fc(b.items));
      if (land) g.appendChild(svgEl("path", { d: land, class: "pop-land", fill, stroke, "stroke-width": 0.8 }));
      // whole-box hit target so tiny island insets (Hawaii, Réunion, Puerto Rico) are easy to select
      if (b.units.length) {
        const primary = b.units[0];
        const hit = svgEl("rect", { x, y, width: b.size, height: h, fill: "transparent", class: "pop-region-hit" });
        hit.addEventListener("click", (e) => { e.stopPropagation(); if (!popDidPan) popSelectRegion(primary); });
        g.appendChild(hit);
      }
      for (const uid of b.units) { const el = unitEl(uid, ipath, country, false); if (el) g.appendChild(el); }
      svg.appendChild(g);
      x += b.size + gap;
    });
    y += h + gap;
  }
  host.appendChild(svg);
  attachPopInteraction(svg);
}

let popDidPan = false;
// pan/zoom the country area (transform-only, no re-render); drags suppress the region click
function attachPopInteraction(svg) {
  const apply = () => {
    const g = svg.querySelector("#pop-zoom-g");
    if (!g) return;
    g.setAttribute("transform", `translate(${popZoom.x} ${popZoom.y}) scale(${popZoom.k})`);
    // keep dot markers a constant screen size as you zoom (radius is in zoomed coords)
    for (const dot of g.querySelectorAll("circle[data-r]")) dot.setAttribute("r", +dot.getAttribute("data-r") / popZoom.k);
  };
  let rerenderT;
  const scheduleRerender = () => { clearTimeout(rerenderT); rerenderT = setTimeout(() => { if (detailSel) renderDetail(); }, 180); };
  svg.addEventListener("wheel", (e) => {
    e.preventDefault();
    const r = svg.getBoundingClientRect();
    const px = e.clientX - r.left, py = e.clientY - r.top;
    const nk = Math.min(40, Math.max(1, popZoom.k * Math.exp(-e.deltaY * 0.0015)));
    const f = nk / popZoom.k;
    if (nk <= 1.001) popZoom = { k: 1, x: 0, y: 0 };
    else popZoom = { k: nk, x: px - (px - popZoom.x) * f, y: py - (py - popZoom.y) * f };
    apply();
    scheduleRerender(); // re-evaluate dot↔polygon once zooming settles
  }, { passive: false });
  // capture only once a real drag begins, so a tap clicks through to the region path
  let dragging = false, captured = false, sx = 0, sy = 0, ox = 0, oy = 0;
  svg.addEventListener("pointerdown", (e) => { if (e.button) return; dragging = true; captured = false; sx = e.clientX; sy = e.clientY; ox = popZoom.x; oy = popZoom.y; });
  svg.addEventListener("pointermove", (e) => {
    if (!dragging) return;
    const dx = e.clientX - sx, dy = e.clientY - sy;
    if (!captured) {
      if (Math.abs(dx) + Math.abs(dy) <= 4) return;
      captured = true;
      try { svg.setPointerCapture(e.pointerId); } catch {}
    }
    popZoom = { k: popZoom.k, x: ox + dx, y: oy + dy };
    apply();
  });
  svg.addEventListener("pointerup", (e) => {
    dragging = false;
    popDidPan = captured;
    if (captured) try { svg.releasePointerCapture(e.pointerId); } catch {}
    setTimeout(() => (popDidPan = false));
  });
  svg.addEventListener("click", () => { if (!popDidPan && popRegion && navTop().v === "region") navReplaceTop({ v: "country", cc: navTop().cc }); });
}

// --- data + map ------------------------------------------------------------
let map;
let countriesData;
let countriesHiData = null; // hi-res tier, lazy-loaded; used by popups + zoomed-in map
let countriesDetailData = null; // full-res geometry for small countries (popups only)
let regionsData;
let pointsData;

// fill/line paint shared by every country tier (so all tiers colour identically)
function countryFillPaint() {
  return { "fill-color": ["case", ["==", ["get", "tracked"], 0], PAL.land, statusColorExpr()] };
}
function countryLinePaint() {
  return {
    "line-color": ["case", ["boolean", ["feature-state", "selected"], false], PAL.selectInk, PAL.border],
    "line-width": ["case", ["boolean", ["feature-state", "selected"], false], 2.4, ["boolean", ["feature-state", "hover"], false], 1.5, 0.85],
  };
}
function addCountryTierLayers(tier, beforeId) {
  const fill = { id: tier.source + "-fill", type: "fill", source: tier.source, filter: ["!", ["in", ["get", "id"], ["literal", [...dotOnlyIds]]]], paint: countryFillPaint() };
  const line = { id: tier.source + "-line", type: "line", source: tier.source, paint: countryLinePaint() };
  for (const o of [fill, line]) {
    if (tier.minzoom != null) o.minzoom = tier.minzoom;
    if (tier.maxzoom != null) o.maxzoom = tier.maxzoom;
    map.addLayer(o, beforeId);
    if (mode !== "countries") map.setLayoutProperty(o.id, "visibility", "none");
  }
}
// Pull the mid + hi tiers in the background once the map is up; wire their layers and
// re-apply state so colours/selection are correct when you zoom in.
async function loadCountryTiers() {
  for (const tier of COUNTRY_TIERS) {
    if (!tier.url || map.getSource(tier.source)) continue;
    const data = await fetch(tier.url).then((r) => r.json());
    if (tier.source === "countries-hi") countriesHiData = data;
    map.addSource(tier.source, { type: "geojson", data, promoteId: "id" });
    addCountryTierLayers(tier, "regions-fill");
  }
  countriesDetailData = await fetch("data/countries-detail.geojson").then((r) => r.json()).catch(() => null);
  applyAllCountryStates();
  if (selected && selected.kind === "country") {
    selectedRefs = countryRefs(selected.key);
    selectedRefs.forEach((r) => map.setFeatureState(r, { selected: true }));
  }
}

async function init() {
  [countriesData, regionsData, pointsData] = await Promise.all([
    fetch("data/countries.geojson").then((r) => r.json()),
    fetch("data/regions.geojson").then((r) => r.json()),
    fetch("data/country-points.geojson").then((r) => r.json()),
  ]);
  pointIds = new Set(pointsData.features.map((f) => f.id));
  dotOnlyIds = new Set(pointsData.features.filter((f) => f.properties.dotOnly).map((f) => f.id));

  regionsByCountry = new Map();
  regionById = new Map();
  for (const f of regionsData.features) {
    if (regionById.has(f.id)) continue;
    regionById.set(f.id, f);
    const cc = f.properties.country;
    if (!regionsByCountry.has(cc)) regionsByCountry.set(cc, []);
    regionsByCountry.get(cc).push(f.id);
  }
  totalRegions = regionById.size;

  sovereignToIds = new Map();
  for (const f of countriesData.features) {
    const s = f.properties.sovereign;
    if (!s) continue;
    if (!sovereignToIds.has(s)) sovereignToIds.set(s, []);
    sovereignToIds.get(s).push(f.id);
    if (f.id === s) nameByCode[s] = f.properties.name;
  }
  countryCodes = [...sovereignToIds.keys()];

  buildLegend();
  renderList(); // the travel list lives permanently below the map (independent of the map)

  map = new maplibregl.Map({
    container: "map",
    style: {
      version: 8,
      sources: {},
      layers: [{ id: "bg", type: "background", paint: { "background-color": PAL.ocean } }],
    },
    center: [12, 22],
    zoom: 0.4, // fitted to the whole world on load (the map shares the screen with the list)
    renderWorldCopies: true, // continuous east-west wrap through the Pacific
    attributionControl: false,
  });
  map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "bottom-right");

  map.on("load", () => {
    // the map shares the screen with the list, so frame the whole world in the top pane
    map.resize();
    map.fitBounds([[-179, -57], [179, 78]], { padding: 6, duration: 0 });
    map.addSource("countries", { type: "geojson", data: countriesData, promoteId: "id" });
    map.addSource("regions", { type: "geojson", data: regionsData, promoteId: "id" });
    map.addSource("country-points", { type: "geojson", data: pointsData, promoteId: "id" });

    map.addLayer({
      id: "countries-fill",
      type: "fill",
      source: "countries",
      maxzoom: 4,
      filter: ["!", ["in", ["get", "id"], ["literal", [...dotOnlyIds]]]],
      paint: countryFillPaint(),
    });
    map.addLayer({
      id: "countries-line",
      type: "line",
      source: "countries",
      maxzoom: 4,
      paint: countryLinePaint(),
    });

    map.addLayer({
      id: "regions-fill",
      type: "fill",
      source: "regions",
      layout: { visibility: "none" },
      paint: { "fill-color": statusColorExpr() },
    });
    // thin subdivision borders
    map.addLayer({
      id: "regions-line",
      type: "line",
      source: "regions",
      layout: { visibility: "none" },
      paint: {
        "line-color": [
          "case",
          ["boolean", ["feature-state", "selected"], false], PAL.selectInk,
          ["boolean", ["feature-state", "hover"], false], PAL.border,
          PAL.border,
        ],
        "line-width": [
          "interpolate",
          ["linear"],
          ["zoom"],
          1, ["case", ["boolean", ["feature-state", "selected"], false], 2, ["boolean", ["feature-state", "hover"], false], 1, 0.7],
          5, ["case", ["boolean", ["feature-state", "selected"], false], 2.8, ["boolean", ["feature-state", "hover"], false], 1.8, 1.4],
        ],
      },
    });
    // thick country borders, drawn over the thin subdivision lines (region view only)
    map.addLayer({
      id: "region-country-borders",
      type: "line",
      source: "countries",
      layout: { visibility: "none" },
      paint: {
        "line-color": PAL.border,
        "line-width": ["interpolate", ["linear"], ["zoom"], 1, 1.1, 5, 2.2],
      },
    });

    const dotPaint = {
      // uniform dots (every small nation reads as one equal marker), sized up so they're
      // clearly visible when fully zoomed out
      "circle-radius": [
        "interpolate",
        ["exponential", 1.5],
        ["zoom"],
        1, 5,
        3, 6.5,
        5, 9,
        7, 14,
        9, 20,
      ],
      "circle-color": statusColorExpr(),
      // a clear dark ring so a dot stands out from the country it sits in (e.g. Singapore on
      // Malaysia) even when both are the same unset colour
      "circle-stroke-width": ["interpolate", ["linear"], ["zoom"], 1, 1.4, 4, 1.8, 9, 2.6],
      "circle-stroke-color": [
        "case",
        ["boolean", ["feature-state", "selected"], false], PAL.selectInk,
        ["boolean", ["feature-state", "hover"], false], PAL.selectInk,
        PAL.regionBorder,
      ],
    };
    map.addLayer({
      id: "country-dots-tiny",
      type: "circle",
      source: "country-points",
      filter: ["==", ["get", "dotOnly"], 1],
      paint: dotPaint,
    });
    map.addLayer({
      id: "country-dots-shaped",
      type: "circle",
      source: "country-points",
      // each dot vanishes at its own zoom once its polygon is big enough to read
      filter: ["all", ["==", ["get", "dotOnly"], 0], ["<", ["zoom"], ["get", "vz"]]],
      paint: dotPaint,
    });

    applyAllCountryStates();
    applyAllRegionStates();
    renderStats();
    loadCountryTiers();

    const activeLayers = () =>
      mode === "countries" ? ["country-dots-tiny", "country-dots-shaped", ...countryFillLayers()] : ["regions-fill"];

    map.on("mousemove", (e) => {
      const f = map.queryRenderedFeatures(e.point, { layers: activeLayers() })[0];
      if (!f || (mode === "countries" && f.properties.tracked === 0)) {
        setHover(null);
        map.getCanvas().style.cursor = "";
        return;
      }
      map.getCanvas().style.cursor = "pointer";
      setHover(mode === "countries" ? countryRefs(f.id) : [{ source: "regions", id: f.id }]);
    });
    map.on("mouseout", () => setHover(null));

    map.on("click", (e) => {
      const f = map.queryRenderedFeatures(e.point, { layers: activeLayers() })[0];
      if (!f) { navClosePopup(); return; }
      if (f.properties.tracked === 0) return; // neutral land
      navRoot({ v: "country", cc: f.properties.sovereign || f.id });
    });
  });

  document.getElementById("panel-close").addEventListener("click", navClosePopup);
  document.getElementById("scrim").addEventListener("click", navClosePopup);

  // Escape goes back one screen
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") navBack();
  });

  // live theme switching: recolor map layers when the system theme flips
  darkMQ.addEventListener("change", repaintForTheme);

  // re-fit the floating outline when the viewport changes
  window.addEventListener("resize", () => { if (detailSel) renderDetail(); });
}

function repaintForTheme() {
  PAL = mapPalette();
  if (!map || !map.getLayer("bg")) return;
  map.setPaintProperty("bg", "background-color", PAL.ocean);
  for (const id of countryFillLayers()) map.setPaintProperty(id, "fill-color", countryFillPaint()["fill-color"]);
  for (const id of countryLineLayers()) map.setPaintProperty(id, "line-color", countryLinePaint()["line-color"]);
  map.setPaintProperty("regions-fill", "fill-color", statusColorExpr());
  map.setPaintProperty("regions-line", "line-color", [
    "case",
    ["boolean", ["feature-state", "selected"], false], PAL.selectInk,
    ["boolean", ["feature-state", "hover"], false], PAL.border,
    PAL.border,
  ]);
  map.setPaintProperty("region-country-borders", "line-color", PAL.border);
  const dotStroke = [
    "case",
    ["boolean", ["feature-state", "selected"], false], PAL.selectInk,
    ["boolean", ["feature-state", "hover"], false], PAL.selectInk,
    PAL.regionBorder,
  ];
  map.setPaintProperty("country-dots-tiny", "circle-stroke-color", dotStroke);
  map.setPaintProperty("country-dots-shaped", "circle-stroke-color", dotStroke);
  map.setPaintProperty("country-dots-tiny", "circle-color", statusColorExpr());
  map.setPaintProperty("country-dots-shaped", "circle-color", statusColorExpr());
}

function buildLegend() {
  const legend = document.getElementById("legend");
  legend.textContent = "";
  for (const s of STATUSES) {
    const item = document.createElement("span");
    item.className = "legend-item";
    const swatch = document.createElement("span");
    swatch.className = "swatch";
    swatch.style.background = s.color;
    item.append(swatch, document.createTextNode(s.short));
    legend.appendChild(item);
  }
}

// --- travel list (Mark O'Travel-style) --------------------------------------
let listMode = "countries"; // top-level tab
let listCountry = null; // when drilled into one country's subdivisions
let listQuery = ""; // search box text (searches all places, marked or not)
function openCountryFromList(cc) { navPush({ v: "country", cc }); }
function openRegionFromList(cc, id) { navPush({ v: "region", cc, rid: id }); }
// drill the always-visible list into one country's subdivisions (from "View regions")
function drillList(cc) { listCountry = cc; listQuery = ""; renderList(); }

function listRow({ flag, name, sub, status, onClick }) {
  const row = document.createElement("button");
  row.type = "button";
  row.className = "list-item";
  if (flag) { const fl = document.createElement("span"); fl.className = "list-flag"; setFlag(fl, flag); row.appendChild(fl); }
  const tx = document.createElement("div");
  tx.className = "list-item-text";
  const nm = document.createElement("div");
  nm.className = "list-item-name";
  nm.textContent = name;
  tx.appendChild(nm);
  if (sub) { const su = document.createElement("div"); su.className = "list-item-sub"; su.textContent = sub; tx.appendChild(su); }
  row.appendChild(tx);
  const dot = document.createElement("span");
  dot.className = "swatch" + (status && status !== "none" ? "" : " empty");
  if (status && status !== "none") dot.style.background = STATUS_COLOR[status];
  row.appendChild(dot);
  row.onclick = onClick;
  return row;
}
function listSection(body, headChildren) {
  const sec = document.createElement("div");
  sec.className = "list-section";
  const sh = document.createElement("div");
  sh.className = "list-sec-head";
  sh.append(...headChildren);
  sec.appendChild(sh);
  body.appendChild(sec);
  return sec;
}
function statusHead(s, count) {
  const sw = document.createElement("span"); sw.className = "swatch"; sw.style.background = s.color;
  const sl = document.createElement("span"); sl.className = "list-sec-label"; sl.textContent = s.label;
  const sc = document.createElement("span"); sc.className = "list-sec-count"; sc.textContent = count;
  return [sw, sl, sc];
}
function listEmpty(body, text) {
  const p = document.createElement("p");
  p.className = "list-empty";
  p.textContent = text;
  body.appendChild(p);
}

function renderList() {
  const lv = document.getElementById("listview");
  lv.textContent = "";

  // header: drill shows a back button; otherwise the live travel stats
  const head = document.createElement("div");
  head.id = "list-head";
  if (listCountry) {
    const back = document.createElement("button");
    back.type = "button"; back.id = "list-back"; back.className = "list-back";
    back.textContent = "‹ " + (nameByCode[listCountry] || listCountry);
    back.onclick = () => { listCountry = null; renderList(); };
    head.appendChild(back);
  } else {
    const stats = document.createElement("div");
    stats.id = "stats";
    const p = document.createElement("span"); p.id = "stat-primary";
    const s = document.createElement("span"); s.id = "stat-secondary";
    stats.append(p, s);
    head.appendChild(stats);
  }
  lv.appendChild(head);

  if (!listCountry) {
    const seg = document.createElement("div");
    seg.id = "list-seg";
    for (const [m, label] of [["countries", "Countries"], ["regions", "Regions"]]) {
      const b = document.createElement("button");
      b.type = "button"; b.className = "lseg" + (listMode === m ? " active" : ""); b.textContent = label;
      b.onclick = () => { listMode = m; renderList(); };
      seg.appendChild(b);
    }
    lv.appendChild(seg);

    // search any place (marked or not) to jump to it and set a status
    const search = document.createElement("div");
    search.id = "list-search";
    const input = document.createElement("input");
    input.type = "search";
    input.placeholder = listMode === "countries" ? "Search all countries…" : "Search all regions…";
    input.value = listQuery;
    input.autocapitalize = "off";
    input.spellcheck = false;
    input.addEventListener("input", (e) => { listQuery = e.target.value; renderListBody(); });
    search.appendChild(input);
    lv.appendChild(search);
  }

  const body = document.createElement("div");
  body.id = "list-body";
  lv.appendChild(body);
  renderStats(); // fills the header stats + the body
}

// fill #list-body only (so typing in the search box doesn't rebuild/blur the input)
function renderListBody() {
  const body = document.getElementById("list-body");
  if (!body) return;
  body.textContent = "";
  if (listCountry) { renderDrill(body, listCountry); return; }
  const q = listQuery.trim().toLowerCase();
  if (q) { renderSearch(body, q); return; }
  if (listMode === "countries") renderCountries(body);
  else renderRegionsByCountry(body);
}

// flat search results across ALL places (not just marked), each tappable to set a status
function renderSearch(body, q) {
  if (listMode === "countries") {
    const matches = countryCodes
      .filter((cc) => (nameByCode[cc] || cc).toLowerCase().includes(q))
      .sort((a, b) => (nameByCode[a] || a).localeCompare(nameByCode[b] || b));
    if (!matches.length) { listEmpty(body, "No countries found."); return; }
    const sec = listSection(body, [labelSpan(`${matches.length} ${matches.length === 1 ? "country" : "countries"}`)]);
    for (const cc of matches) sec.appendChild(listRow({
      flag: cc, name: nameByCode[cc] || cc, status: countryStatus(cc),
      onClick: () => openCountryFromList(cc),
    }));
  } else {
    const matches = regionsData.features
      .filter((f) => {
        const n = f.properties.name, l = f.properties.nameLocal;
        return (n && n.toLowerCase().includes(q)) || (l && l.toLowerCase().includes(q));
      })
      .sort((a, b) => a.properties.name.localeCompare(b.properties.name))
      .slice(0, 80);
    if (!matches.length) { listEmpty(body, "No regions found."); return; }
    const sec = listSection(body, [labelSpan(`${matches.length}${matches.length === 80 ? "+" : ""} regions`)]);
    for (const f of matches) {
      const cc = f.properties.country;
      sec.appendChild(listRow({
        flag: cc, name: unitDisplayName(f.id), sub: unitSub(f.id, true),
        status: regionStatus(f.id), onClick: () => openRegionFromList(cc, f.id),
      }));
    }
  }
}
function labelSpan(text) {
  const sl = document.createElement("span");
  sl.className = "list-sec-label";
  sl.textContent = text;
  return sl;
}

// countries grouped by status; tapping one drills into its subdivisions
function renderCountries(body) {
  const items = [];
  for (const cc of countryCodes) { const s = countryStatus(cc); if (s !== "none") items.push({ cc, name: nameByCode[cc] || cc, status: s }); }
  items.sort((a, b) => a.name.localeCompare(b.name));
  let any = false;
  for (const s of STATUSES) {
    const group = items.filter((i) => i.status === s.id);
    if (!group.length) continue;
    any = true;
    const sec = listSection(body, statusHead(s, group.length));
    for (const it of group) sec.appendChild(listRow({
      flag: it.cc, name: it.name, status: it.status,
      onClick: () => openCountryFromList(it.cc),
    }));
  }
  if (!any) listEmpty(body, "No countries marked yet — tap a country on the map.");
}

// every marked region/territory, grouped by its country
function renderRegionsByCountry(body) {
  const byCountry = new Map();
  for (const id of Object.keys(state.regions)) {
    const cc = countryOfUnit(id);
    if (!byCountry.has(cc)) byCountry.set(cc, []);
    byCountry.get(cc).push(id);
  }
  const countries = [...byCountry.keys()].sort((a, b) => (nameByCode[a] || a).localeCompare(nameByCode[b] || b));
  for (const cc of countries) {
    const fl = document.createElement("span"); fl.className = "list-sec-flag"; setFlag(fl, cc);
    const sl = document.createElement("span"); sl.className = "list-sec-label"; sl.textContent = nameByCode[cc] || cc;
    const sc = document.createElement("span"); sc.className = "list-sec-count"; sc.textContent = byCountry.get(cc).length;
    const sec = listSection(body, [fl, sl, sc]);
    sec.firstChild.classList.add("country");
    const ids = byCountry.get(cc).sort(byTypeName);
    for (const id of ids) sec.appendChild(listRow({ name: unitDisplayName(id), sub: unitSub(id, false), status: state.regions[id], onClick: () => openRegionFromList(cc, id) }));
  }
  if (!countries.length) listEmpty(body, "No regions marked yet.");
}

// one country's subdivisions: marked ones by status, then the rest under "Not visited"
function renderDrill(body, cc) {
  const ids = subUnitIds(cc);
  if (!ids.length) { listEmpty(body, "This country has no subdivisions in the data."); return; }
  const row = (id) => listRow({ name: unitDisplayName(id), sub: unitSub(id, false), status: state.regions[id], onClick: () => openRegionFromList(cc, id) });
  for (const s of STATUSES) {
    const group = ids.filter((id) => state.regions[id] === s.id).sort(byTypeName);
    if (!group.length) continue;
    const sec = listSection(body, statusHead(s, group.length));
    for (const id of group) sec.appendChild(row(id));
  }
  const unmarked = ids.filter((id) => !state.regions[id]).sort(byTypeName);
  if (unmarked.length) {
    const sl = document.createElement("span"); sl.className = "list-sec-label"; sl.textContent = "Not visited";
    const sc = document.createElement("span"); sc.className = "list-sec-count"; sc.textContent = unmarked.length;
    const sec = listSection(body, [sl, sc]);
    for (const id of unmarked) sec.appendChild(row(id));
  }
}

// --- navigation stack (the popup overlay only; the bottom list is always present) ----------
// "back" pops to the previous screen, so the route you took (map→region, or list→region)
// determines where back returns to. Screens: {v:"map"} {v:"country",cc} {v:"region",cc,rid}
let nav = [{ v: "map" }];
const navTop = () => nav[nav.length - 1];
const countrySel = (cc) => ({ kind: "country", key: cc, flagCode: cc, name: nameByCode[cc] || cc, via: null });
function applyScreen(s) {
  if (s.v === "map") { clearSelection(); return; }
  if (!selected || selected.kind !== "country" || selected.key !== s.cc) selectPlace(countrySel(s.cc));
  popRegion = s.v === "region" ? s.rid : null;
  renderDetail();
  renderPanel();
}
const navApply = () => applyScreen(navTop());
function navPush(s) { nav.push(s); navApply(); }
function navReplaceTop(s) { nav[nav.length - 1] = s; navApply(); }
function navBack() { if (nav.length > 1) { nav.pop(); navApply(); } }
function navRoot(s) { nav = [{ v: "map" }, s]; navApply(); }
function navClosePopup() { nav = [{ v: "map" }]; navApply(); }
// click a subdivision in the popup: select / switch / toggle-off, kept at one stack level
function popSelectRegion(id) {
  const t = navTop();
  if (t.v === "region" && t.rid === id) navReplaceTop({ v: "country", cc: t.cc });
  else if (t.v === "region") navReplaceTop({ v: "region", cc: t.cc, rid: id });
  else navPush({ v: "region", cc: detailSel.key, rid: id });
}

init();
