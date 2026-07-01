#!/usr/bin/env bash
# Downloads circular flag SVGs (HatScripts/circle-flags, public-domain flags) for every
# country/territory code the app can reference, into assets/flags/<cc>.svg. Re-runnable.
set -euo pipefail

cd "$(dirname "$0")/.."
mkdir -p assets/flags

command -v curl >/dev/null || { echo "curl required" >&2; exit 1; }

# Union of: the curated 197, every sovereign code, and every region's country code.
codes=$(node --input-type=module -e '
import { readFileSync } from "node:fs";
import { ISO_197 } from "./scripts/iso197.mjs";
const set = new Set(ISO_197);
const c = JSON.parse(readFileSync("data/countries.geojson", "utf8"));
for (const f of c.features) if (f.properties.sovereign) set.add(f.properties.sovereign);
const r = JSON.parse(readFileSync("data/regions.geojson", "utf8"));
for (const f of r.features) if (/^[A-Z]{2}$/.test(f.properties.country)) set.add(f.properties.country);
console.log([...set].sort().join("\n"));
')

base="https://hatscripts.github.io/circle-flags/flags"
missing=()
for cc in $codes; do
  lc=$(echo "$cc" | tr "[:upper:]" "[:lower:]")
  out="assets/flags/${lc}.svg"
  [[ -s "$out" ]] && continue
  if ! curl -fsSL "$base/${lc}.svg" -o "$out"; then
    rm -f "$out"
    missing+=("$lc")
  fi
done

count=$(find assets/flags -name "*.svg" | wc -l | tr -d " ")
echo "have ${count} flags in assets/flags/"
[[ ${#missing[@]} -gt 0 ]] && echo "no flag for: ${missing[*]}" || true