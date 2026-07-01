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
fetch "$BASE/ne_10m_admin_0_map_units.geojson" raw/map_units.geojson

# three detail tiers for zoom LOD: lo (zoomed out) -> hi (zoomed in / popups)
DETAIL_LO="${DETAIL_LO:-4%}"
DETAIL_MID="${DETAIL_MID:-12%}"
DETAIL_HI="${DETAIL_HI:-35%}"
DETAIL_REGIONS="${DETAIL_REGIONS:-6%}"

CFIELDS=ISO_A2,ISO_A2_EH,ADMIN,NAME,TYPE,SOVEREIGNT,NE_ID,LABEL_X,LABEL_Y
for tier in "lo:$DETAIL_LO" "mid:$DETAIL_MID" "hi:$DETAIL_HI"; do
  name="${tier%%:*}"
  pct="${tier##*:}"
  echo "simplifying countries [$name] ($pct) ..."
  npx -y mapshaper raw/countries_raw.geojson \
    -simplify "$pct" keep-shapes \
    -filter-fields "$CFIELDS" \
    -o "tmp/countries_${name}.geojson" force
done

# full-resolution geometry (no simplification) — curate keeps only the small countries from
# this, so tiny nations (Singapore, Malta) aren't blocky when blown up in the popup
echo "extracting full-res countries ..."
npx -y mapshaper raw/countries_raw.geojson \
  -filter-fields "$CFIELDS" \
  -o tmp/countries_full.geojson force

# tiny territories NE's countries layer omits (Bouvet, Jan Mayen, Christmas, Cocos, Tokelau)
echo "extracting supplementary territories ..."
npx -y mapshaper raw/map_units.geojson \
  -filter '["Bouvet Island","Jan Mayen","Christmas Island","Cocos (Keeling) Islands","Tokelau"].indexOf(GEOUNIT) > -1' \
  -filter-fields ISO_A2,ISO_A2_EH,ADMIN,NAME,GEOUNIT,TYPE,SOVEREIGNT,NE_ID,LABEL_X,LABEL_Y \
  -o tmp/extra.geojson force

# Natural Earth admin-1 is below the ISO 3166-2 first level for some countries (Spain
# provinces, France departments, Italy provinces). Dissolve those into their `region`
# (autonomous community / region); leave every other country's admin-1 as-is.
DISSOLVE='["ES","FR","IT"]'
echo "simplifying + dissolving regions ($DETAIL_REGIONS) ..."
npx -y mapshaper raw/regions_raw.geojson \
  -simplify "$DETAIL_REGIONS" keep-shapes \
  -filter-fields iso_3166_2,iso_a2,name,name_en,region,type_en \
  -each "dkey = ($DISSOLVE.indexOf(iso_a2) > -1 && region) ? iso_a2 + '|' + region : iso_3166_2" \
  -dissolve dkey copy-fields=iso_a2,region,name,name_en,iso_3166_2,type_en \
  -o tmp/regions_simplified.geojson force

echo "curating ..."
node scripts/curate.mjs

echo "hi-res small-country boundaries (geoBoundaries) ..."
node scripts/hires.mjs

echo "done. outputs:"
du -h data/*.geojson
