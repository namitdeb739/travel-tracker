// Reads the mapshaper-simplified Natural Earth layers from tmp/ and writes normalized,
// minimal GeoJSON to data/. Countries are emitted at three detail tiers (lo/mid/hi) for
// zoom-based LOD on the main map and crisp popups; regions/points come from the lo tier.

import { readFileSync, writeFileSync } from "node:fs";
import { ISO_197, NAME_PATCHES } from "./iso197.mjs";

const load = (p) => JSON.parse(readFileSync(p, "utf8"));
const valid = (c) => typeof c === "string" && /^[A-Z]{2}$/.test(c);

const SMALL_AREA = Number(process.env.SMALL_AREA ?? 0.2);
// up-to-date English country names where Natural Earth's are outdated
const NAME_OVERRIDE = { TR: "Türkiye" };

function ringArea(r) {
  let a = 0;
  for (let i = 0, n = r.length, j = n - 1; i < n; j = i++) a += (r[j][0] + r[i][0]) * (r[j][1] - r[i][1]);
  return Math.abs(a / 2);
}
function planarArea(g) {
  const polys = g.type === "Polygon" ? [g.coordinates] : g.coordinates;
  return polys.reduce((a, p) => a + ringArea(p[0]), 0);
}
function labelPoint(p, g) {
  if (Number.isFinite(p.LABEL_X) && Number.isFinite(p.LABEL_Y)) return [p.LABEL_X, p.LABEL_Y];
  const polys = g.type === "Polygon" ? [g.coordinates] : g.coordinates;
  const ring = polys.sort((a, b) => ringArea(b[0]) - ringArea(a[0]))[0][0];
  const c = ring.reduce((s, pt) => [s[0] + pt[0], s[1] + pt[1]], [0, 0]);
  return [c[0] / ring.length, c[1] / ring.length];
}
function repPoint(g) {
  const polys = g.type === "Polygon" ? [g.coordinates] : g.coordinates;
  const ring = polys.map((p) => p[0]).sort((a, b) => ringArea(b) - ringArea(a))[0];
  let x = 0, y = 0;
  for (const p of ring) { x += p[0]; y += p[1]; }
  return [x / ring.length, y / ring.length];
}
function pointInRing(pt, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (yi > pt[1] !== yj > pt[1] && pt[0] < ((xj - xi) * (pt[1] - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
// Drop interior rings that are lakes so they don't punch through to the ocean. A hole is
// kept only when another feature's representative point falls inside it (a real enclave).
function fillLakes(features) {
  const pts = features.map((f) => ({ id: f.id, p: repPoint(f.geometry) }));
  let dropped = 0;
  for (const f of features) {
    const polys = f.geometry.type === "Polygon" ? [f.geometry.coordinates] : f.geometry.coordinates;
    for (const poly of polys) {
      if (poly.length <= 1) continue;
      const kept = [poly[0]];
      for (let i = 1; i < poly.length; i++) {
        if (pts.some((o) => o.id !== f.id && pointInRing(o.p, poly[i]))) kept.push(poly[i]);
        else dropped++;
      }
      poly.length = 0;
      poly.push(...kept);
    }
  }
  return dropped;
}

function resolveCountryCode(p) {
  if (p.ADMIN in NAME_PATCHES) return NAME_PATCHES[p.ADMIN];
  if (valid(p.ISO_A2_EH)) return p.ISO_A2_EH;
  if (valid(p.ISO_A2)) return p.ISO_A2;
  return null;
}

const allow = new Set(ISO_197);

// Tiny territories NE's countries layer omits, pulled from map_units so e.g. Norway gets
// Bouvet/Jan Mayen — consistent with France's overseas lands. (GEOUNIT -> id + sovereign)
const EXTRA = {
  "Bouvet Island": { id: "BV", sov: "NO" },
  "Jan Mayen": { id: "JANMAYEN", sov: "NO" },
  "Christmas Island": { id: "CX", sov: "AU" },
  "Cocos (Keeling) Islands": { id: "CC", sov: "AU" },
  "Tokelau": { id: "TK", sov: "NZ" },
};
const extraRaw = load("tmp/extra.geojson");

// Disputed/neutral areas assigned to a de-facto sovereign (matched on NAME or ADMIN).
const FORCE_SOVEREIGN = {
  "W. Sahara": "MA", "Western Sahara": "MA",
  Somaliland: "SO",
  "N. Cyprus": "CY", "Northern Cyprus": "CY",
  "Cyprus U.N. Buffer Zone": "CY",
  "Siachen Glacier": "IN",
};

// sovereign name -> alpha-2, so territories can be tied to a parent (built from any tier)
function buildNameToCode(features) {
  const m = new Map();
  for (const f of features) {
    const code = resolveCountryCode(f.properties);
    if (code && allow.has(code)) for (const k of [f.properties.NAME, f.properties.ADMIN, f.properties.SOVEREIGNT]) if (k) m.set(k, code);
  }
  return m;
}

// Build the normalized country features for one detail tier. Each carries `sovereign` (the
// alpha-2 it's colored/tracked by) and `tracked` (0 = neutral land). Supplements appended.
function buildCountries(rawFeatures, nameToCode) {
  const byCode = new Map();
  const features = [];
  const seen = new Set();
  for (const f of rawFeatures) {
    const p = f.properties;
    const code = resolveCountryCode(p);
    const inSet = code && allow.has(code);
    const id = inSet ? code : valid(code) ? code : "x" + p.NE_ID;
    if (seen.has(id)) continue;
    seen.add(id);
    let sovereign = inSet ? code : nameToCode.get(p.SOVEREIGNT) ?? "";
    const forced = FORCE_SOVEREIGN[p.NAME] ?? FORCE_SOVEREIGN[p.ADMIN];
    if (forced) sovereign = forced;
    const props = { id, name: NAME_OVERRIDE[id] ?? p.NAME ?? p.ADMIN, sovereign, tracked: sovereign ? 1 : 0 };
    if (sovereign && id !== sovereign) props.type = p.TYPE && !/country/i.test(p.TYPE) ? p.TYPE : "Territory"; // territory type
    features.push({ type: "Feature", id, properties: props, geometry: f.geometry });
    if (inSet) byCode.set(code, f);
  }
  for (const f of extraRaw.features) {
    const e = EXTRA[f.properties.GEOUNIT];
    if (!e || seen.has(e.id)) continue;
    seen.add(e.id);
    features.push({ type: "Feature", id: e.id, properties: { id: e.id, name: f.properties.NAME ?? f.properties.GEOUNIT, sovereign: e.sov, tracked: 1, type: f.properties.TYPE && !/country/i.test(f.properties.TYPE) ? f.properties.TYPE : "Territory" }, geometry: f.geometry });
  }
  fillLakes(features);
  return { features, byCode };
}

const nameToCode = buildNameToCode(load("tmp/countries_lo.geojson").features);

const tiers = [
  ["tmp/countries_lo.geojson", "data/countries.geojson"],
  ["tmp/countries_mid.geojson", "data/countries-mid.geojson"],
  ["tmp/countries_hi.geojson", "data/countries-hi.geojson"],
];
let loByCode;
for (const [src, out] of tiers) {
  const { features, byCode } = buildCountries(load(src).features, nameToCode);
  writeFileSync(out, JSON.stringify({ type: "FeatureCollection", features }));
  const nTerr = features.filter((f) => f.properties.tracked && f.id !== f.properties.sovereign).length;
  console.log(`${out}: ${features.length} features (${byCode.size}/197 sovereign, ${nTerr} territories)`);
  if (src.includes("_lo")) loByCode = byCode;
}

const missing = ISO_197.filter((c) => !loByCode.has(c));
if (missing.length) console.warn(`WARNING: ${missing.length} of 197 not matched:`, missing.join(" "));

// Full-res geometry for *small* countries only (popups blow these up, so they need the
// detail; large countries use the hi tier). Area is planar deg² — antimeridian crossers
// (Fiji) get a bogus huge area and are simply excluded, falling back to the hi tier.
const DETAIL_AREA = Number(process.env.DETAIL_AREA ?? 3);
const full = buildCountries(load("tmp/countries_full.geojson").features, nameToCode).features;
const detail = full.filter((f) => planarArea(f.geometry) < DETAIL_AREA);
writeFileSync("data/countries-detail.geojson", JSON.stringify({ type: "FeatureCollection", features: detail }));
console.log(`countries-detail.geojson: ${detail.length} small countries (full res)`);

// Small countries -> dots (from the lo tier)
const MIN_R = 3;
const MAX_R = 7;
const DOT_ONLY_AREA = Number(process.env.DOT_ONLY_AREA ?? 0.005);
// large-area nations that are still hard to see/tap at world zoom because their land is
// scattered across the ocean (or split by the antimeridian) — force a dot anyway
const FORCE_DOT = new Set(["FJ", "VU", "SB"]);
const small = [];
for (const [code, f] of loByCode) {
  const a = planarArea(f.geometry);
  if (a < SMALL_AREA || FORCE_DOT.has(code)) small.push({ code, f, area: a, root: Math.sqrt(a) });
}
const roots = small.map((s) => s.root);
const lo = Math.min(...roots);
const hi = Math.max(...roots);
const points = small.map(({ code, f, area, root }) => {
  const t = hi > lo ? (root - lo) / (hi - lo) : 0;
  const r = Math.round((MIN_R + t * (MAX_R - MIN_R)) * 10) / 10;
  const dotOnly = area < DOT_ONLY_AREA ? 1 : 0;
  // zoom at which the country's own polygon is big enough to see, so the dot can vanish —
  // bigger countries reach it earlier. (~6px on-screen extent; calibrated so Malta ≈ z6.)
  const vz = Math.round(Math.max(2.5, Math.min(9, Math.log2((6 * 360) / 256 / Math.sqrt(area)))) * 10) / 10;
  const [x, y] = labelPoint(f.properties, f.geometry);
  return { type: "Feature", id: code, properties: { id: code, name: f.properties.NAME ?? f.properties.ADMIN, r, dotOnly, vz }, geometry: { type: "Point", coordinates: [x, y] } };
});
writeFileSync("data/country-points.geojson", JSON.stringify({ type: "FeatureCollection", features: points }));
console.log(`country-points.geojson: ${points.length} dots`);

// --- Regions (admin-1) ---
// first-order division type for the dissolved countries (NE labels the sub-units oddly)
const DISSOLVE_TYPE = { ES: "Autonomous Community", FR: "Region", IT: "Region" };
// English names for the dissolved ES/FR/IT regions (their `region` field is local-language);
// anything not listed already matches its English name
const REGION_EN = {
  "Andalucía": "Andalusia", "Aragón": "Aragon", "Canary Is.": "Canary Islands",
  "Castilla y León": "Castile and León", "Castilla-La Mancha": "Castile-La Mancha",
  "Cataluña": "Catalonia", "Foral de Navarra": "Navarre", "Islas Baleares": "Balearic Islands",
  "País Vasco": "Basque Country", "Valenciana": "Valencia",
  "Bretagne": "Brittany", "Corse": "Corsica", "Guyane française": "French Guiana",
  "Normandie": "Normandy", "Occitanie": "Occitania",
  "Lombardia": "Lombardy", "Piemonte": "Piedmont", "Sardegna": "Sardinia",
  "Toscana": "Tuscany", "Valle d'Aosta": "Aosta Valley",
};
const rawRegions = load("tmp/regions_simplified.geojson");
const regionFeatures = [];
for (const f of rawRegions.features) {
  const p = f.properties;
  const country = p.iso_a2;
  // dissolved first-order divisions (Spain/France/Italy) carry a composite key + region name
  const dissolved = typeof p.dkey === "string" && p.dkey.includes("|");
  const id = dissolved ? p.dkey : p.iso_3166_2;
  // primary display name = English; keep the local-language name to show alongside it
  const local = dissolved ? p.region : p.name;
  const name = dissolved ? REGION_EN[p.region] || p.region : p.name_en || p.name;
  const nameLocal = local && local !== name ? local : null;
  const type = dissolved ? DISSOLVE_TYPE[p.iso_a2] : p.type_en || "Region";
  // skip Natural Earth's unnamed "unassigned" admin-1 slivers (placeholder X-codes, e.g. the
  // unnamed Mexican island north of Yucatán) — they shouldn't appear as trackable regions
  if (!valid(country) || !id || !name || !String(name).trim() || name === "null") continue;
  regionFeatures.push({ type: "Feature", id, properties: { id, name, country, type, nameLocal }, geometry: f.geometry });
}
console.log(`regions: dropped ${fillLakes(regionFeatures)} lake holes`);
writeFileSync("data/regions.geojson", JSON.stringify({ type: "FeatureCollection", features: regionFeatures }));
const countriesWithRegions = new Set(regionFeatures.map((f) => f.properties.country)).size;
console.log(`regions.geojson: ${regionFeatures.length} features across ${countriesWithRegions} countries`);
