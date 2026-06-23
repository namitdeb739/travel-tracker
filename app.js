"use strict";

const TOTAL_COUNTRIES = 197;
const STORAGE_KEY = "travel-tracker:v1";
const COLORS = { visited: "#2e7d32", partial: "#9ccc65", none: "#cfd8dc" };

// --- persisted state -------------------------------------------------------
function loadState() {
  try {
    const raw = JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}");
    return {
      visitedCountries: new Set(raw.visitedCountries || []),
      visitedRegions: new Set(raw.visitedRegions || []),
    };
  } catch {
    return { visitedCountries: new Set(), visitedRegions: new Set() };
  }
}

function saveState() {
  localStorage.setItem(
    STORAGE_KEY,
    JSON.stringify({
      visitedCountries: [...state.visitedCountries],
      visitedRegions: [...state.visitedRegions],
    }),
  );
}

const state = loadState();
let mode = "countries"; // or "regions"
let regionsByCountry = new Map(); // country code -> [unique region ids]
let totalRegions = 0; // count of unique region ids

// --- hybrid status ---------------------------------------------------------
function countryStatus(cc) {
  const regs = regionsByCountry.get(cc) || [];
  const done = regs.filter((id) => state.visitedRegions.has(id)).length;
  if (state.visitedCountries.has(cc) || (regs.length > 0 && done === regs.length)) return "visited";
  if (done > 0) return "partial";
  return "none";
}

function applyAllCountryStates() {
  for (const cc of regionsByCountry.keys()) {
    map.setFeatureState({ source: "countries", id: cc }, { status: countryStatus(cc) });
  }
  // countries with no admin-1 regions still need their state set
  for (const f of countriesData.features) {
    map.setFeatureState({ source: "countries", id: f.id }, { status: countryStatus(f.id) });
  }
}

function applyAllRegionStates() {
  for (const id of state.visitedRegions) {
    map.setFeatureState({ source: "regions", id }, { visited: true });
  }
}

// --- stats -----------------------------------------------------------------
function renderStats() {
  const primary = document.getElementById("stat-primary");
  const secondary = document.getElementById("stat-secondary");
  if (mode === "countries") {
    let visited = 0;
    let partial = 0;
    for (const f of countriesData.features) {
      const s = countryStatus(f.id);
      if (s === "visited") visited++;
      else if (s === "partial") partial++;
    }
    primary.textContent = `${visited} / ${TOTAL_COUNTRIES} countries`;
    secondary.textContent = partial ? `${partial} partially visited` : "";
  } else {
    const total = totalRegions;
    const visited = state.visitedRegions.size;
    const countries = new Set(
      regionsData.features
        .filter((f) => state.visitedRegions.has(f.id))
        .map((f) => f.properties.country),
    ).size;
    primary.textContent = `${visited} / ${total} regions`;
    secondary.textContent = `${countries} countries with a region`;
  }
}

// --- data + map ------------------------------------------------------------
let map;
let countriesData;
let regionsData;

async function init() {
  [countriesData, regionsData] = await Promise.all([
    fetch("data/countries.geojson").then((r) => r.json()),
    fetch("data/regions.geojson").then((r) => r.json()),
  ]);

  regionsByCountry = new Map();
  const seenRegionIds = new Set();
  for (const f of regionsData.features) {
    if (seenRegionIds.has(f.id)) continue; // multi-part provinces share one id
    seenRegionIds.add(f.id);
    const cc = f.properties.country;
    if (!regionsByCountry.has(cc)) regionsByCountry.set(cc, []);
    regionsByCountry.get(cc).push(f.id);
  }
  totalRegions = seenRegionIds.size;

  map = new maplibregl.Map({
    container: "map",
    style: {
      version: 8,
      sources: {},
      layers: [{ id: "bg", type: "background", paint: { "background-color": "#add0e8" } }],
    },
    center: [10, 25],
    zoom: 1.4,
    renderWorldCopies: false,
    attributionControl: false,
  });
  map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "bottom-right");

  map.on("load", () => {
    map.addSource("countries", { type: "geojson", data: countriesData, promoteId: "id" });
    map.addSource("regions", { type: "geojson", data: regionsData, promoteId: "id" });

    map.addLayer({
      id: "countries-fill",
      type: "fill",
      source: "countries",
      paint: {
        "fill-color": [
          "match",
          ["feature-state", "status"],
          "visited", COLORS.visited,
          "partial", COLORS.partial,
          COLORS.none,
        ],
      },
    });
    map.addLayer({
      id: "countries-line",
      type: "line",
      source: "countries",
      paint: { "line-color": "#ffffff", "line-width": 0.6 },
    });

    map.addLayer({
      id: "regions-fill",
      type: "fill",
      source: "regions",
      layout: { visibility: "none" },
      paint: {
        "fill-color": [
          "case",
          ["boolean", ["feature-state", "visited"], false],
          COLORS.visited,
          COLORS.none,
        ],
      },
    });
    map.addLayer({
      id: "regions-line",
      type: "line",
      source: "regions",
      layout: { visibility: "none" },
      paint: { "line-color": "#ffffff", "line-width": 0.4 },
    });

    applyAllCountryStates();
    applyAllRegionStates();
    renderStats();

    map.on("click", "countries-fill", (e) => {
      if (mode !== "countries") return;
      const cc = e.features[0].id;
      if (state.visitedCountries.has(cc)) state.visitedCountries.delete(cc);
      else state.visitedCountries.add(cc);
      map.setFeatureState({ source: "countries", id: cc }, { status: countryStatus(cc) });
      saveState();
      renderStats();
    });

    map.on("click", "regions-fill", (e) => {
      if (mode !== "regions") return;
      const f = e.features[0];
      const id = f.id;
      const cc = f.properties.country;
      if (state.visitedRegions.has(id)) state.visitedRegions.delete(id);
      else state.visitedRegions.add(id);
      map.setFeatureState({ source: "regions", id }, { visited: state.visitedRegions.has(id) });
      map.setFeatureState({ source: "countries", id: cc }, { status: countryStatus(cc) });
      saveState();
      renderStats();
    });

    for (const layer of ["countries-fill", "regions-fill"]) {
      map.on("mouseenter", layer, () => (map.getCanvas().style.cursor = "pointer"));
      map.on("mouseleave", layer, () => (map.getCanvas().style.cursor = ""));
    }
  });

  document.getElementById("toggle").addEventListener("click", () => {
    mode = mode === "countries" ? "regions" : "countries";
    const showCountries = mode === "countries";
    map.setLayoutProperty("countries-fill", "visibility", showCountries ? "visible" : "none");
    map.setLayoutProperty("countries-line", "visibility", showCountries ? "visible" : "none");
    map.setLayoutProperty("regions-fill", "visibility", showCountries ? "none" : "visible");
    map.setLayoutProperty("regions-line", "visibility", showCountries ? "none" : "visible");
    document.getElementById("toggle").textContent = showCountries ? "View: Countries" : "View: Regions";
    renderStats();
  });
}

init();
