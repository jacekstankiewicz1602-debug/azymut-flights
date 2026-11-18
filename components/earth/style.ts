// Custom vector style for the globe (OpenFreeMap tiles, OpenMapTiles schema; no key). Built from
// scratch: water and land in two close tones, a faint hillshade, thin muted borders, country and
// big-city names first, smaller places only when zoomed in.
import maplibregl, { type StyleSpecification } from "maplibre-gl";

// Terrain (hillshade) tiles come from S3 without cache headers, so the browser would fetch them again
// and again. They go through the "azdem" protocol instead: an in-memory store. The relief uses zoom
// 0-3 only (85 tiles for the whole world), all fetched once after the globe loads, so the camera
// never waits for terrain.
const DEM_HOST = "https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png";
export const DEM_URL = DEM_HOST.replace("https://", "azdem://");
const demStore = new Map<string, Promise<ArrayBuffer>>();
export function demTile(url: string): Promise<ArrayBuffer> {
  const key = url.replace("azdem://", "https://");
  let hit = demStore.get(key);
  if (hit) { demStore.delete(key); demStore.set(key, hit); return hit; } // most recently used last
  hit = fetch(key).then((r) => { if (!r.ok) throw new Error(`dem ${r.status}`); return r.arrayBuffer(); });
  hit.catch(() => demStore.delete(key));
  demStore.set(key, hit);
  if (demStore.size > 900) demStore.delete(demStore.keys().next().value!);
  return hit;
}
let protocol = false;
/** All terrain tiles the style can ask for (zoom 0-3), fetched in the background. */
export async function prefetchDem() {
  const list: string[] = [];
  for (let z = 0; z <= 3; z++) for (let x = 0; x < 2 ** z; x++) for (let y = 0; y < 2 ** z; y++) list.push(DEM_URL.replace("{z}", String(z)).replace("{x}", String(x)).replace("{y}", String(y)));
  const worker = async () => { while (list.length) await demTile(list.shift()!).catch(() => null); };
  await Promise.all(Array.from({ length: 4 }, worker));
}
export function registerDemProtocol() {
  if (protocol) return;
  protocol = true;
  maplibregl.addProtocol("azdem", async (params) => ({ data: await demTile(params.url) }));
}

export type Theme = "dark" | "light";

export const PALETTE = {
  dark: {
    // night globe: a saturated deep-blue ocean, lighter slate land, bright borders and a blue atmosphere,
    // so the globe reads as an object against the near-black stage
    ocean: "#0d2347", land: "#3a4862", landEdge: "#43526e", ice: "#56637c", park: "#36465c",
    border: "rgba(190, 210, 245, 0.32)", borderState: "rgba(190, 210, 245, 0.12)",
    road: "rgba(190, 210, 245, 0.08)", river: "rgba(110, 160, 230, 0.5)",
    country: "#a9b6cc", city: "#c5cee0", town: "#94a0b6", halo: "rgba(10, 20, 38, 0.9)",
    shadow: "#1c2638", highlight: "#5a6b8a", sky: "#060a12", horizon: "#3f86ff", fog: "#16305e",
    arc: "#ff7a59", arcHead: "#ffd2c2", ground: "#9aa6bb", airport: "#ffffff", airportText: "#eef2f8",
  },
  light: {
    ocean: "#c9dcef", land: "#f4f5f7", landEdge: "#eceef2", ice: "#ffffff", park: "#e6ede2",
    border: "rgba(100, 112, 135, 0.28)", borderState: "rgba(100, 112, 135, 0.1)",
    road: "rgba(110, 120, 140, 0.14)", river: "rgba(130, 170, 210, 0.65)",
    country: "#8a92a0", city: "#5d6573", town: "#858d9a", halo: "rgba(255, 255, 255, 0.92)",
    shadow: "#b9c0cc", highlight: "#ffffff", sky: "#eef3f9", horizon: "#f6f8fb", fog: "#eef0f4",
    arc: "#e4694e", arcHead: "#f7a283", ground: "#8e96a3", airport: "#e4694e", airportText: "#454b57",
  },
} as const;

const FONT = ["Noto Sans Regular"];
const FONT_BOLD = ["Noto Sans Bold"];

export function mapStyle(theme: Theme): StyleSpecification {
  const c = PALETTE[theme];
  return {
    version: 8,
    projection: { type: "globe" },
    glyphs: "https://tiles.openfreemap.org/fonts/{fontstack}/{range}.pbf",
    sky: {
      "sky-color": c.sky,
      "horizon-color": c.horizon,
      "fog-color": c.fog,
      "sky-horizon-blend": 0.6,
      "horizon-fog-blend": 0.7,
      "fog-ground-blend": 0.9,
      // soft atmosphere halo from orbit, fading out as the camera comes down
      "atmosphere-blend": ["interpolate", ["linear"], ["zoom"], 0, theme === "dark" ? 1 : 0.8, 4, theme === "dark" ? 0.6 : 0.55, 7, 0],
    },
    sources: {
      omt: { type: "vector", url: "https://tiles.openfreemap.org/planet", attribution: "© OpenFreeMap © OpenMapTiles © OpenStreetMap" },
      dem: {
        // maxzoom 3: the relief is a faint texture seen from orbit; it fades out closer in (layer below)
        type: "raster-dem", encoding: "terrarium", tileSize: 256, maxzoom: 3,
        tiles: [DEM_URL], attribution: "Mapzen terrain",
      },
    },
    layers: [
      { id: "land", type: "background", paint: { "background-color": c.land } },
      { id: "ice", type: "fill", source: "omt", "source-layer": "landcover", filter: ["==", ["get", "class"], "ice"], paint: { "fill-color": c.ice, "fill-opacity": 0.8 } },
      { id: "park", type: "fill", source: "omt", "source-layer": "landcover", minzoom: 5, filter: ["in", ["get", "class"], ["literal", ["wood", "grass"]]], paint: { "fill-color": c.park, "fill-opacity": ["interpolate", ["linear"], ["zoom"], 5, 0, 8, 0.5] } },
      {
        // stops above zoom 6, so a close-in camera never waits for terrain tiles
        id: "hillshade", type: "hillshade", source: "dem", maxzoom: 6,
        paint: {
          "hillshade-exaggeration": ["interpolate", ["linear"], ["zoom"], 4.5, theme === "dark" ? 0.3 : 0.12, 6, 0], "hillshade-shadow-color": c.shadow,
          "hillshade-highlight-color": c.highlight, "hillshade-accent-color": c.shadow, "hillshade-illumination-direction": 315,
        },
      },
      // no outline layer on water: polygon outlines include the tile cut at 85° latitude (a ring around the pole)
      { id: "water", type: "fill", source: "omt", "source-layer": "water", filter: ["!=", ["get", "brunnel"], "tunnel"], paint: { "fill-color": c.ocean, "fill-antialias": true } },
      { id: "river", type: "line", source: "omt", "source-layer": "waterway", minzoom: 6, filter: ["==", ["get", "class"], "river"], paint: { "line-color": c.river, "line-width": ["interpolate", ["linear"], ["zoom"], 6, 0.4, 10, 1.2] } },
      { id: "road", type: "line", source: "omt", "source-layer": "transportation", minzoom: 6, filter: ["in", ["get", "class"], ["literal", ["motorway", "trunk"]]], paint: { "line-color": c.road, "line-width": ["interpolate", ["linear"], ["zoom"], 6, 0.4, 10, 1.4] } },
      {
        id: "border-state", type: "line", source: "omt", "source-layer": "boundary", minzoom: 4,
        filter: ["all", ["==", ["get", "admin_level"], 4], ["!=", ["get", "maritime"], 1]],
        paint: { "line-color": c.borderState, "line-width": 0.6, "line-dasharray": [3, 2] },
      },
      {
        id: "border", type: "line", source: "omt", "source-layer": "boundary",
        filter: ["all", ["==", ["get", "admin_level"], 2], ["!=", ["get", "maritime"], 1], ["!=", ["get", "disputed"], 1]],
        layout: { "line-join": "round", "line-cap": "round" },
        paint: { "line-color": c.border, "line-width": ["interpolate", ["linear"], ["zoom"], 1, 0.35, 5, 0.7, 8, 1.1] },
      },
      {
        id: "place-town", type: "symbol", source: "omt", "source-layer": "place", minzoom: 6.5,
        filter: ["in", ["get", "class"], ["literal", ["town", "city"]]],
        layout: {
          "text-field": ["coalesce", ["get", "name:pl"], ["get", "name:latin"], ["get", "name"]], "text-font": FONT,
          "text-size": ["interpolate", ["linear"], ["zoom"], 6.5, 10.5, 10, 13], "symbol-sort-key": ["get", "rank"], "text-padding": 6,
        },
        paint: { "text-color": c.town, "text-halo-color": c.halo, "text-halo-width": 1.2 },
      },
      {
        id: "place-city", type: "symbol", source: "omt", "source-layer": "place", minzoom: 2.6,
        filter: ["all", ["==", ["get", "class"], "city"], ["<=", ["get", "rank"], ["step", ["zoom"], 1, 3.5, 2, 4.5, 4, 5.5, 7]]],
        layout: {
          "text-field": ["coalesce", ["get", "name:pl"], ["get", "name:latin"], ["get", "name"]], "text-font": FONT,
          "text-size": ["interpolate", ["linear"], ["zoom"], 2.6, 11, 6, 14], "symbol-sort-key": ["get", "rank"], "text-padding": 8,
          "text-variable-anchor": ["top", "bottom", "left", "right"], "text-radial-offset": 0.4,
        },
        paint: { "text-color": c.city, "text-halo-color": c.halo, "text-halo-width": 1.2, "text-opacity": ["interpolate", ["linear"], ["zoom"], 2.6, 0, 3.2, 1] },
      },
      {
        id: "place-country", type: "symbol", source: "omt", "source-layer": "place", minzoom: 1.6, maxzoom: 7,
        filter: ["all", ["==", ["get", "class"], "country"], ["<=", ["coalesce", ["get", "rank"], 9], ["step", ["zoom"], 1, 2.4, 2, 3.2, 3, 4.2, 4, 5.2, 6]]],
        layout: {
          "text-field": ["coalesce", ["get", "name:pl"], ["get", "name:latin"], ["get", "name"]], "text-font": FONT,
          "text-size": ["interpolate", ["linear"], ["zoom"], 1.6, 9.5, 5, 12.5], "text-transform": "uppercase", "text-letter-spacing": 0.2,
          "text-max-width": 7, "symbol-sort-key": ["get", "rank"],
        },
        paint: { "text-color": c.country, "text-halo-color": c.halo, "text-halo-width": 1, "text-opacity": ["interpolate", ["linear"], ["zoom"], 1.6, 0, 2.1, 0.9, 6, 0.9, 7, 0] },
      },
    ],
  };
}
