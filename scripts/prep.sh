#!/usr/bin/env bash
# Downloads Natural Earth admin-0 (countries) and admin-1 (states/provinces),
# simplifies them with mapshaper, and curates them into data/*.geojson.
# Re-runnable; skips downloads that already exist in raw/.
set -euo pipefail

cd "$(dirname "$0")/.."
mkdir -p raw data tmp

BASE="https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson"

fetch() {
  local url="$1" out="$2"
  if [[ -s "$out" ]]; then
    echo "have $out"
  else
    echo "downloading $out ..."
    curl -fsSL -m 300 "$url" -o "$out"
  fi
}

fetch "$BASE/ne_10m_admin_0_countries.geojson" raw/countries_raw.geojson
fetch "$BASE/ne_10m_admin_1_states_provinces.geojson" raw/regions_raw.geojson

echo "simplifying countries ..."
npx -y mapshaper raw/countries_raw.geojson \
  -simplify 12% keep-shapes \
  -filter-fields ISO_A2,ISO_A2_EH,ADMIN,NAME,TYPE \
  -o tmp/countries_simplified.geojson force

echo "simplifying regions ..."
npx -y mapshaper raw/regions_raw.geojson \
  -simplify 12% keep-shapes \
  -filter-fields iso_3166_2,iso_a2,name,admin \
  -o tmp/regions_simplified.geojson force

echo "curating ..."
node scripts/curate.mjs

echo "done. outputs:"
du -h data/*.geojson
