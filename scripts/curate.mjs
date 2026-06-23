// Reads the mapshaper-simplified Natural Earth layers from tmp/ and writes normalized,
// minimal GeoJSON to data/. Countries are filtered to the curated 197 and keyed by
// alpha-2; regions keep all admin-1 features keyed by ISO 3166-2 with a country code.

import { readFileSync, writeFileSync } from "node:fs";
import { ISO_197, NAME_PATCHES } from "./iso197.mjs";

const load = (p) => JSON.parse(readFileSync(p, "utf8"));
const valid = (c) => typeof c === "string" && /^[A-Z]{2}$/.test(c);

function resolveCountryCode(p) {
  if (p.ADMIN in NAME_PATCHES) return NAME_PATCHES[p.ADMIN]; // may be null = exclude
  if (valid(p.ISO_A2_EH)) return p.ISO_A2_EH;
  if (valid(p.ISO_A2)) return p.ISO_A2;
  return null;
}

// --- Countries ---
const allow = new Set(ISO_197);
const rawCountries = load("tmp/countries_simplified.geojson");
const byCode = new Map();
for (const f of rawCountries.features) {
  const code = resolveCountryCode(f.properties);
  if (!code || !allow.has(code) || byCode.has(code)) continue;
  byCode.set(code, {
    type: "Feature",
    id: code,
    properties: { id: code, name: f.properties.NAME ?? f.properties.ADMIN },
    geometry: f.geometry,
  });
}

const missing = ISO_197.filter((c) => !byCode.has(c));
if (missing.length) console.warn(`WARNING: ${missing.length} of 197 not matched:`, missing.join(" "));

writeFileSync(
  "data/countries.geojson",
  JSON.stringify({ type: "FeatureCollection", features: [...byCode.values()] }),
);
console.log(`countries.geojson: ${byCode.size} / 197 features`);

// --- Regions (admin-1) ---
const rawRegions = load("tmp/regions_simplified.geojson");
const regionFeatures = [];
for (const f of rawRegions.features) {
  const id = f.properties.iso_3166_2;
  const country = f.properties.iso_a2;
  if (!valid(country) || !id) continue;
  regionFeatures.push({
    type: "Feature",
    id,
    properties: { id, name: f.properties.name, country },
    geometry: f.geometry,
  });
}
writeFileSync(
  "data/regions.geojson",
  JSON.stringify({ type: "FeatureCollection", features: regionFeatures }),
);
const countriesWithRegions = new Set(regionFeatures.map((f) => f.properties.country)).size;
console.log(`regions.geojson: ${regionFeatures.length} features across ${countriesWithRegions} countries`);
