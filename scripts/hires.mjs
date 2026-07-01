// Higher-resolution boundaries for small countries (where Natural Earth 10m is too coarse
// to blow up in the popup). Pulls country outlines (ADM0) + subdivisions (ADM1) from
// geoBoundaries (CC-BY), simplifies them to a popup-appropriate detail, and merges them
// into data/countries-detail.geojson (outlines) and data/regions.geojson (subdivisions).
// Run after prep.sh. Downloads are cached in raw/geob/.

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { execSync } from "node:child_process";

// iso2 -> { iso3, type }  (type = how its first-order divisions are labelled)
const SMALL = [
  ["SG", "SGP", "Region"], ["MT", "MLT", "Region"], ["LU", "LUX", "Canton"],
  ["BH", "BHR", "Governorate"], ["BN", "BRN", "District"], ["LI", "LIE", "Municipality"],
  ["SM", "SMR", "Municipality"], ["MC", "MCO", "Ward"], ["AD", "AND", "Parish"],
  ["MV", "MDV", "Atoll"], ["BB", "BRB", "Parish"], ["GD", "GRD", "Parish"],
  ["LC", "LCA", "District"], ["VC", "VCT", "Parish"], ["AG", "ATG", "Parish"],
  ["DM", "DMA", "Parish"], ["KN", "KNA", "Parish"], ["SC", "SYC", "District"],
  ["KM", "COM", "Island"], ["MU", "MUS", "District"], ["ST", "STP", "District"],
  ["CV", "CPV", "Municipality"], ["CY", "CYP", "District"], ["LB", "LBN", "Governorate"],
  ["QA", "QAT", "Municipality"], ["KW", "KWT", "Governorate"], ["SI", "SVN", "Municipality"],
  ["JM", "JAM", "Parish"], ["TT", "TTO", "Region"], ["GM", "GMB", "Division"],
  ["DJ", "DJI", "Region"], ["GQ", "GNQ", "Province"],
  ["KI", "KIR", "Island Group"], ["FM", "FSM", "State"], ["MH", "MHL", "Atoll"], ["PW", "PLW", "State"],
  ["TV", "TUV", "Island"], ["NR", "NRU", "District"], ["TO", "TON", "Division"], ["WS", "WSM", "District"], ["NU", "NIU", "Village"],
  ["FJ", "FJI", "Division"], ["BS", "BHS", "District"], ["VU", "VUT", "Province"], ["SB", "SLB", "Province"],
];

mkdirSync("raw/geob", { recursive: true });

async function download(iso3, lvl) {
  const out = `raw/geob/${iso3}-${lvl}.geojson`;
  if (existsSync(out)) return JSON.parse(readFileSync(out, "utf8"));
  const meta = await (await fetch(`https://www.geoboundaries.org/api/current/gbOpen/${iso3}/${lvl}/`)).json();
  if (!meta.gjDownloadURL) throw new Error("no download URL");
  const txt = await (await fetch(meta.gjDownloadURL)).text();
  writeFileSync(out, txt);
  return JSON.parse(txt);
}

const adm0 = [];
const adm1 = [];
for (const [iso2, iso3, type] of SMALL) {
  try {
    const a0 = await download(iso3, "ADM0");
    for (const f of a0.features) adm0.push({ type: "Feature", properties: { _iso2: iso2 }, geometry: f.geometry });
    try {
      const a1 = await download(iso3, "ADM1");
      for (const f of a1.features) adm1.push({ type: "Feature", properties: { _iso2: iso2, _type: type, _name: f.properties.shapeName, _iso: f.properties.shapeISO || "" }, geometry: f.geometry });
    } catch { console.warn(`  ${iso2}: no ADM1`); }
    console.log(`  ${iso2} ok`);
  } catch (e) { console.warn(`  ${iso2} FAILED: ${e.message}`); }
}
writeFileSync("tmp/geob_adm0.geojson", JSON.stringify({ type: "FeatureCollection", features: adm0 }));
writeFileSync("tmp/geob_adm1.geojson", JSON.stringify({ type: "FeatureCollection", features: adm1 }));

const D = "6%";
// simplify subdivisions topologically (shared edges stay aligned), then derive each country's
// outline by DISSOLVING those simplified subdivisions — so the coast and the region edges are
// the exact same vertices. ADM0 is simplified only as a fallback for countries lacking ADM1.
execSync(`npx -y mapshaper tmp/geob_adm0.geojson -simplify ${D} keep-shapes -o tmp/geob_adm0_s.geojson force`, { stdio: "inherit" });
execSync(`npx -y mapshaper tmp/geob_adm1.geojson -simplify ${D} keep-shapes -o tmp/geob_adm1_s.geojson force`, { stdio: "inherit" });
execSync(`npx -y mapshaper tmp/geob_adm1_s.geojson -dissolve _iso2 -o tmp/geob_outline.geojson force`, { stdio: "inherit" });

// merge hi-res outlines into the small-country detail file (id unchanged)
const detail = JSON.parse(readFileSync("data/countries-detail.geojson", "utf8"));
const outline = new Map();
for (const f of JSON.parse(readFileSync("tmp/geob_outline.geojson", "utf8")).features) outline.set(f.properties._iso2, f.geometry);
for (const f of JSON.parse(readFileSync("tmp/geob_adm0_s.geojson", "utf8")).features) if (!outline.has(f.properties._iso2)) outline.set(f.properties._iso2, f.geometry);
let n0 = 0;
for (const f of detail.features) if (outline.has(f.id)) { f.geometry = outline.get(f.id); n0++; }
writeFileSync("data/countries-detail.geojson", JSON.stringify(detail));

// replace these countries' subdivisions in regions.geojson with hi-res ADM1
const titleCase = (s) => s.toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());
const hiCountries = new Set(SMALL.map((s) => s[0]));
const regions = JSON.parse(readFileSync("data/regions.geojson", "utf8"));
const kept = regions.features.filter((f) => !hiCountries.has(f.properties.country));
let n1 = 0;
for (const f of JSON.parse(readFileSync("tmp/geob_adm1_s.geojson", "utf8")).features) {
  const cc = f.properties._iso2;
  const name = titleCase(f.properties._name || "");
  const id = /^[A-Z]{2}-/.test(f.properties._iso) ? f.properties._iso : `${cc}~${name}`;
  kept.push({ type: "Feature", id, properties: { id, name, country: cc, type: f.properties._type }, geometry: f.geometry });
  n1++;
}
writeFileSync("data/regions.geojson", JSON.stringify({ type: "FeatureCollection", features: kept }));
console.log(`hires: replaced ${n0} country outlines, ${n1} subdivisions`);
