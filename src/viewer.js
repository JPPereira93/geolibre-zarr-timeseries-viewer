import { CogBuilder, ZarrLayer, initCogWasm, proj4 } from "./runtime.js";
import * as zarr from "zarrita";
import {
  configFromMetadata,
  configFromLayerSpatialMetadata,
  finiteRange,
  metadataFromDocument,
  normalizeStoreUrl,
  readRemoteMetadata,
} from "./metadata.js";
import { axisLabels, timeAxis } from "./time-axis.js";

const ID = "zarr-timeseries-viewer";
const PANEL = "zarr-timeseries-viewer-panel";
const VERSION = "0.7.6";
const PALETTES = {
  ndvi: [
    "#7f3b08",
    "#d73027",
    "#fdae61",
    "#ffffbf",
    "#a6d96a",
    "#1a9850",
    "#006837",
  ],
  viridis: ["#440154", "#414487", "#2a788e", "#22a884", "#7ad151", "#fde725"],
  plasma: ["#0d0887", "#6a00a8", "#b12a90", "#e16462", "#fca636", "#f0f921"],
  blues: ["#f7fbff", "#c6dbef", "#6baed6", "#2171b5", "#08306b"],
  turbo: [
    "#30123b",
    "#4662d7",
    "#35ab93",
    "#a4d93c",
    "#f9ba38",
    "#e34a33",
    "#7a0403",
  ],
  grayscale: ["#000000", "#ffffff"],
};
const DEFAULT_CONFIG = {
  source: "custom",
  url: "",
  name: "Zarr time series",
  variable: "",
  availableVariables: [],
  valueLabel: "",
  timeDimension: "time",
  timeValuesText: "",
  timeStart: 0,
  timeStep: 1,
  timeCount: 1,
  dateOrigin: "",
  dateUnit: "days",
  climMin: 0,
  climMax: 1,
  palette: "viridis",
  customColors: "#7f3b08, #d73027, #fdae61, #ffffbf, #a6d96a, #1a9850, #006837",
  zarrVersion: 2,
  crs: "",
  proj4: "",
  xDimension: "x",
  yDimension: "y",
  sourceBounds: "",
  mapBounds: "",
  gridVariable: undefined,
  gridWidth: undefined,
  gridHeight: undefined,
  nodata: -9999,
};
let app = null;
let panel = null;
let control = null;
let unregister = null;
let layerId = null;
let mapClick = null;
let queryController = null;
let timer = null;
let speed = 500;
let frame = 0;
let values = [];
let labels = [];
let selectedPoint = null;
let selectedSeries = null;
let loading = false;
let addingAcquisition = false;
let exportingAcquisition = false;
let cfg = { ...DEFAULT_CONFIG };
let localStore = null;
let localStoreId = "";
let metadataController = null;
let inspectedMetadata = null;
const nativeLayers = new Map();
let cogWasmReady = null;
const esc = (value) =>
  String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
function list(value, length, label) {
  if (!String(value ?? "").trim()) return void 0;
  const result = String(value)
    .split(/[\s,]+/)
    .filter(Boolean)
    .map(Number);
  if (result.length !== length || result.some((item) => !Number.isFinite(item)))
    throw new Error(`${label} must contain ${length} numbers.`);
  return result;
}
function colors(config = cfg) {
  if (config.palette !== "custom")
    return PALETTES[config.palette] ?? PALETTES.viridis;
  const result = String(config.customColors)
    .split(/[\s,]+/)
    .filter((item) => /^#[0-9a-f]{6}$/i.test(item));
  if (result.length < 2)
    throw new Error(
      "A custom palette needs at least two six-digit hex colors."
    );
  return result;
}
function status(message, kind = "info") {
  const element = panel?.querySelector("[data-status]");
  if (element) {
    element.textContent = message;
    element.dataset.kind = kind;
  }
}
function sourceUrl(config) {
  if (config.source === "local") {
    if (!localStore) throw new Error("Choose the Zarr folder again.");
    return `local-zarr:${encodeURIComponent(
      config.url || "zarr"
    )}?${localStoreId}`;
  }
  return normalizeStoreUrl(config.url);
}

function storeForConfig(config) {
  if (config.source === "local") return localStore;
  return null;
}

function hasConfiguredSource(config = cfg) {
  if (!String(config.variable ?? "").trim()) return false;
  if (!String(config.timeDimension ?? "").trim()) return false;
  if (config.source === "local") return Boolean(localStore);
  return Boolean(String(config.url ?? "").trim());
}

function proj4Definition(config = cfg) {
  const explicit = String(config.proj4 ?? "").trim();
  if (explicit) return explicit;
  const match = String(config.crs ?? "")
    .trim()
    .toUpperCase()
    .match(/^EPSG:(326|327)(\d{2})$/);
  if (!match) return undefined;
  const zone = Number(match[2]);
  if (zone < 1 || zone > 60) return undefined;
  return `+proj=utm +zone=${zone}${
    match[1] === "327" ? " +south" : ""
  } +datum=WGS84 +units=m +no_defs`;
}

function sourceProjection(config = cfg) {
  const crs = String(config.crs ?? "").trim();
  return proj4Definition(config) || crs || "EPSG:4326";
}

function sourceBoundsGeometry(config = cfg) {
  const bounds = list(config.sourceBounds, 4, "Source bounds");
  if (!bounds)
    throw new Error("Source bounds are required for this operation.");
  const [xMin, yMin, xMax, yMax] = bounds;
  const ring = [];
  const samples = 16;
  for (let index = 0; index <= samples; index += 1)
    ring.push([xMin + ((xMax - xMin) * index) / samples, yMin]);
  for (let index = 1; index <= samples; index += 1)
    ring.push([xMax, yMin + ((yMax - yMin) * index) / samples]);
  for (let index = 1; index <= samples; index += 1)
    ring.push([xMax - ((xMax - xMin) * index) / samples, yMax]);
  for (let index = 1; index <= samples; index += 1)
    ring.push([xMin, yMax - ((yMax - yMin) * index) / samples]);
  const projection = sourceProjection(config);
  const coordinates = ring.map((coordinate) =>
    projection === "EPSG:4326" || projection === "OGC:CRS84"
      ? coordinate
      : proj4(projection, "EPSG:4326", coordinate)
  );
  coordinates.push(coordinates[0]);
  return { type: "Polygon", coordinates: [coordinates] };
}

function datasetMapBounds(config = cfg) {
  const declared = list(config.mapBounds, 4, "Map bounds");
  if (declared) return declared;
  const coordinates = sourceBoundsGeometry(config).coordinates[0];
  return [
    Math.min(...coordinates.map(([x]) => x)),
    Math.min(...coordinates.map(([, y]) => y)),
    Math.max(...coordinates.map(([x]) => x)),
    Math.max(...coordinates.map(([, y]) => y)),
  ];
}

function applyLayerSpatialMetadata(layer, config) {
  Object.assign(config, configFromLayerSpatialMetadata(layer, config));
  if (!String(config.mapBounds ?? "").trim() && config.sourceBounds) {
    config.mapBounds = datasetMapBounds(config).join(", ");
  }
}

function activeLayer(id = layerId) {
  return id ? nativeLayers.get(id)?.layer ?? null : null;
}

function removeNativeLayer(id) {
  if (!id) return;
  const registration = nativeLayers.get(id);
  const map = registration?.map ?? app?.getMap?.();
  if (map?.getLayer?.(id)) map.removeLayer(id);
  (registration?.host ?? app)?.unregisterExternalNativeLayer?.(id);
  nativeLayers.delete(id);
}

async function addNativeZarrLayer(name, config, selector) {
  const host = app;
  if (!host) throw new DOMException("Zarr viewer deactivated.", "AbortError");
  const map = host.getMap?.();
  if (!map?.addLayer) {
    throw new Error("The Zarr viewer requires GeoLibre's MapLibre renderer.");
  }
  const id = `${ID}-${crypto.randomUUID()}`;
  const bounds = list(config.sourceBounds, 4, "Source bounds");
  let mapBounds;
  try {
    mapBounds = datasetMapBounds(config);
  } catch {
    mapBounds = undefined;
  }
  const layer = new ZarrLayer({
    id,
    ...(storeForConfig(config)
      ? { store: storeForConfig(config) }
      : { source: sourceUrl(config) }),
    variable: config.variable,
    selector,
    clim: [Number(config.climMin), Number(config.climMax)],
    colormap: colors(config),
    opacity: 0.9,
    zarrVersion: Number(config.zarrVersion),
    ...(config.crs.trim() ? { crs: config.crs.trim() } : {}),
    ...(proj4Definition(config) ? { proj4: proj4Definition(config) } : {}),
    ...(bounds ? { bounds } : {}),
    spatialDimensions: {
      lon: config.xDimension.trim() || undefined,
      lat: config.yDimension.trim() || undefined,
    },
    onLoadingStateChange(state) {
      if (state.error) status(state.error.message, "error");
    },
  });
  map.addLayer(layer);
  nativeLayers.set(id, { layer, name, mapBounds, map, host });
  try {
    await layer.ready;
    if (app !== host || !nativeLayers.has(id)) {
      removeNativeLayer(id);
      throw new DOMException("Zarr viewer deactivated.", "AbortError");
    }
    applyLayerSpatialMetadata(layer, config);
    mapBounds = datasetMapBounds(config);
    nativeLayers.get(id).mapBounds = mapBounds;
    host.registerExternalNativeLayer?.({
      id,
      name,
      type: "zarr",
      nativeLayerIds: [id],
      opacity: 0.9,
      paintMode: "plugin",
      paintBridge: {
        setOpacity: (opacity) => layer.setOpacity(opacity),
        setVisibility: (visible) => layer.setOpacity(visible ? 0.9 : 0),
      },
      source: {
        type: "raster",
        url: sourceUrl(config),
        variable: config.variable,
        selector,
        bounds: mapBounds,
      },
      metadata: {
        sourceKind: "zarr-url",
        paintMode: "plugin",
        variable: config.variable,
        selector,
        ...(config.crs.trim() ? { crs: config.crs.trim() } : {}),
        bounds: mapBounds,
      },
      sourcePath: sourceUrl(config),
    });
  } catch (error) {
    removeNativeLayer(id);
    throw error;
  }
  return id;
}

function applyInspectedMetadata(metadata, next, zarrVersion) {
  inspectedMetadata = metadata;
  cfg = configFromMetadata(metadata, {
    ...next,
    zarrVersion,
    crs: "",
    proj4: "",
    sourceBounds: "",
    mapBounds: "",
  });
  values = [];
  labels = [];
  render();
  panel?.querySelector(".ztsv-config")?.setAttribute("open", "");
  status(
    `Found ${cfg.availableVariables.length} data variable${
      cfg.availableVariables.length === 1 ? "" : "s"
    }. Select one, review the display range, then add the time series.`,
    "success"
  );
}

async function inspectRemoteStore(form) {
  metadataController?.abort();
  metadataController = new AbortController();
  const next = readForm(form);
  next.source = "custom";
  status("Reading remote Zarr metadata…");
  try {
    const discovered = await readRemoteMetadata(
      next.url,
      fetch,
      metadataController.signal
    );
    applyInspectedMetadata(
      discovered.metadata,
      {
        ...next,
        url: discovered.url,
      },
      discovered.zarrVersion
    );
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") return;
    status(
      error instanceof Error
        ? error.message
        : "Could not inspect this Zarr store.",
      "error"
    );
  }
}

function inspectLocalStore(form) {
  if (!localStore || !inspectedMetadata) {
    throw new Error("Choose a Zarr folder before reading its metadata.");
  }
  const next = readForm(form);
  applyInspectedMetadata(
    inspectedMetadata,
    { ...next, source: "local", url: cfg.url },
    cfg.zarrVersion
  );
}
async function inspectLocalDisplayRange() {
  if (!localStore)
    return { range: null, reason: "unavailable", values: 0 };
  if (cfg.hasDeclaredRange)
    return { range: null, reason: "declared", values: 0 };
  if (cfg.hasSuggestedRange)
    return { range: null, reason: "suggested", values: 0 };
  const root = await zarr.open(localStore, { kind: "group" });
  const array = await zarr.open(root.resolve(cfg.variable), { kind: "array" });
  const chunk = await array.getChunk(Array(array.shape.length).fill(0));
  return {
    range: finiteRange(chunk.data),
    reason: "sampled",
    values: chunk.data.length,
  };
}
async function applyLocalDisplayRange() {
  const result = await inspectLocalDisplayRange();
  if (!result.range) return result;
  cfg = { ...cfg, climMin: result.range[0], climMax: result.range[1] };
  render();
  panel?.querySelector(".ztsv-config")?.setAttribute("open", "");
  return result;
}
async function chooseFolder(fileList) {
  const files = [...fileList];
  if (!files.length) return;
  const rawIndex = new Map();
  let root = "";
  for (const file of files) {
    const parts = String(file.webkitRelativePath || file.name).split("/");
    const candidateRoot = parts.length > 1 ? parts.shift() : "zarr";
    if (root && candidateRoot !== root)
      throw new Error("Choose one Zarr folder at a time.");
    root = candidateRoot;
    rawIndex.set(parts.join("/"), file);
  }
  const metadataPaths = [...rawIndex.keys()]
    .filter((key) => key === ".zmetadata" || key.endsWith("/.zmetadata"))
    .sort((a, b) => a.split("/").length - b.split("/").length);
  const zarrJsonPaths = [...rawIndex.keys()]
    .filter((key) => key === "zarr.json" || key.endsWith("/zarr.json"))
    .sort((a, b) => a.split("/").length - b.split("/").length);
  const metadataPath = metadataPaths[0] ?? zarrJsonPaths[0];
  if (!metadataPath)
    throw new Error("No .zmetadata or zarr.json was found in that folder.");
  const prefix = metadataPath.includes("/")
    ? metadataPath.slice(0, metadataPath.lastIndexOf("/") + 1)
    : "";
  const index = new Map(
    [...rawIndex.entries()]
      .filter(([key]) => key.startsWith(prefix))
      .map(([key, file]) => [key.slice(prefix.length), file])
  );
  const storeName =
    prefix.replace(/\/$/, "").split("/").filter(Boolean).at(-1) ||
    root ||
    "zarr";
  localStore = {
    async get(key) {
      const file = index.get(String(key).replace(/^\//, ""));
      return file ? new Uint8Array(await file.arrayBuffer()) : void 0;
    },
  };
  localStoreId = crypto.randomUUID();
  const metadataFile = index.get(
    metadataPath.endsWith(".zmetadata") ? ".zmetadata" : "zarr.json"
  );
  if (!metadataFile)
    throw new Error("The selected Zarr metadata file could not be read.");
  const discovered = metadataFromDocument(
    JSON.parse(await metadataFile.text())
  );
  applyInspectedMetadata(
    discovered.metadata,
    {
      ...cfg,
      source: "local",
      url: storeName,
      name: storeName,
    },
    discovered.zarrVersion
  );
  status("Reading the first acquisition to determine its display range…");
  const result = await applyLocalDisplayRange();
  if (result.range) {
    status(
      `Found ${cfg.availableVariables.length} data variable${
        cfg.availableVariables.length === 1 ? "" : "s"
      } and derived a display range of ${result.range[0].toLocaleString()} to ${result.range[1].toLocaleString()} from a small sample chunk.`,
      "success"
    );
  } else if (result.reason === "suggested") {
    status(
      `Found ${cfg.availableVariables.length} data variable${
        cfg.availableVariables.length === 1 ? "" : "s"
      }. Using the standard NDVI display range of -1 to 1.`,
      "success"
    );
  } else {
    status(
      `Found ${cfg.availableVariables.length} data variable${
        cfg.availableVariables.length === 1 ? "" : "s"
      }. Review the display range before adding the time series.`,
      "success"
    );
  }
}
function currentValue() {
  const value = selectedSeries?.[frame];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}
function updateUi() {
  if (!panel || !values.length) return;
  const range = panel.querySelector("[data-range]");
  const date = panel.querySelector("[data-date]");
  const count = panel.querySelector("[data-count]");
  const play2 = panel.querySelector("[data-play]");
  const acquisition = panel.querySelector("[data-acquisition]");
  const acquisitionIndex = panel.querySelector("[data-acquisition-index]");
  const current = panel.querySelector("[data-current]");
  const cursor = panel.querySelector("[data-cursor]");
  if (range) {
    range.max = String(values.length - 1);
    range.value = String(frame);
  }
  if (date) date.textContent = labels[frame] ?? String(values[frame]);
  if (count) count.textContent = `${frame + 1} / ${values.length}`;
  if (acquisition) acquisition.value = String(frame);
  if (acquisitionIndex) acquisitionIndex.value = String(frame + 1);
  if (play2) {
    play2.textContent = timer ? "Pause" : "Play";
    play2.setAttribute("aria-pressed", timer ? "true" : "false");
  }
  const value = currentValue();
  if (current)
    current.textContent =
      value === null
        ? `No valid ${cfg.variable} value`
        : `${cfg.valueLabel || cfg.variable} ${value.toFixed(3)}`;
  const x = 10 + (frame / Math.max(1, values.length - 1)) * 300;
  if (cursor) {
    cursor.setAttribute("x1", String(x));
    cursor.setAttribute("x2", String(x));
  }
}
async function show(next) {
  frame = Math.max(0, Math.min(values.length - 1, Math.round(next)));
  updateUi();
  const layer = activeLayer();
  if (!layer) return;
  try {
    await layer.setSelector({
      [cfg.timeDimension]: values[frame],
    });
  } catch (error) {
    status(
      error instanceof Error
        ? error.message
        : "Could not change the time step.",
      "error"
    );
  }
}
function stop() {
  if (timer) window.clearInterval(timer);
  timer = null;
  updateUi();
}
function play() {
  if (timer) return stop();
  timer = window.setInterval(
    () => void show((frame + 1) % values.length),
    speed
  );
  updateUi();
}
function flatten(value, result = []) {
  if (typeof value === "number")
    result.push(Number.isFinite(value) ? value : null);
  else if (typeof value === "bigint") result.push(Number(value));
  else if (Array.isArray(value) || ArrayBuffer.isView(value))
    for (const item of value) flatten(item, result);
  else if (value && typeof value === "object")
    for (const item of Object.values(value)) flatten(item, result);
  return result;
}
function chart(series) {
  const svg = panel?.querySelector("[data-chart]");
  const summary = panel?.querySelector("[data-summary]");
  if (!svg || !summary) return;
  const valid = series.filter(
    (item) => typeof item === "number" && Number.isFinite(item)
  );
  if (!valid.length) {
    svg.innerHTML = "";
    summary.textContent = "No valid observations at this pixel.";
    return;
  }
  let min = Number(cfg.climMin),
    max = Number(cfg.climMax);
  if (!Number.isFinite(min) || !Number.isFinite(max) || min === max) {
    min = Math.min(...valid);
    max = Math.max(...valid);
    if (min === max) max++;
  }
  let path = "",
    drawing = false;
  series.slice(0, values.length).forEach((value, index) => {
    if (typeof value !== "number" || !Number.isFinite(value)) {
      drawing = false;
      return;
    }
    const x = 10 + (index / Math.max(1, values.length - 1)) * 300;
    const y =
      92 - ((Math.max(min, Math.min(max, value)) - min) / (max - min)) * 80;
    path += `${drawing ? "L" : "M"}${x.toFixed(2)},${y.toFixed(2)}`;
    drawing = true;
  });
  const mean = valid.reduce((sum, item) => sum + item, 0) / valid.length;
  summary.textContent = `Min ${Math.min(...valid).toFixed(
    3
  )} · Mean ${mean.toFixed(3)} · Max ${Math.max(...valid).toFixed(3)}`;
  svg.innerHTML = `<line x1="10" y1="12" x2="310" y2="12" class="ztsv-grid"/><line x1="10" y1="92" x2="310" y2="92" class="ztsv-axis"/><path d="${path}" class="ztsv-line"/><line data-cursor y1="10" y2="94" class="ztsv-cursor"/><text x="12" y="21">${esc(
    max.toFixed(2)
  )}</text><text x="12" y="88">${esc(
    min.toFixed(2)
  )}</text><text x="10" y="108">${esc(
    labels[0]
  )}</text><text x="310" y="108" text-anchor="end">${esc(
    labels.at(-1)
  )}</text>`;
  updateUi();
}
async function inspect(longitude, latitude) {
  const layer = activeLayer();
  if (!layer) return;
  queryController?.abort();
  queryController = new AbortController();
  selectedPoint = [longitude, latitude];
  selectedSeries = null;
  const location = panel?.querySelector("[data-location]");
  const summary = panel?.querySelector("[data-summary]");
  if (location)
    location.textContent = `${latitude.toFixed(5)}°, ${longitude.toFixed(5)}°`;
  if (summary) summary.textContent = `Reading ${values.length} observations…`;
  try {
    const result = await layer.queryData(
      { type: "Point", coordinates: [longitude, latitude] },
      { [cfg.timeDimension]: values },
      { signal: queryController.signal, includeSpatialCoordinates: false }
    );
    const found = flatten(result?.[cfg.variable]);
    selectedSeries = Array.from(
      { length: values.length },
      (_, index) => found[index] ?? null
    );
    chart(selectedSeries);
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") return;
    if (summary)
      summary.textContent =
        error instanceof Error ? error.message : "Could not read this pixel.";
  }
}
function bindMap() {
  const map = app.getMap?.();
  if (!map || mapClick) return;
  mapClick = (event) => void inspect(event.lngLat.lng, event.lngLat.lat);
  map.on("click", mapClick);
}
async function addCurrentAcquisition() {
  if (addingAcquisition || loading || !layerId || !values.length) return;
  addingAcquisition = true;
  const label = labels[frame] ?? `${cfg.timeDimension} ${values[frame]}`;
  try {
    await addNativeZarrLayer(`${cfg.name || cfg.variable} — ${label}`, cfg, {
      [cfg.timeDimension]: values[frame],
    });
    status(`Added ${label} as a separate map layer.`, "success");
  } catch (error) {
    status(
      error instanceof Error
        ? error.message
        : "Could not add this acquisition.",
      "error"
    );
  } finally {
    addingAcquisition = false;
  }
}
function exportFileName(label) {
  const stem = `${cfg.name || cfg.variable}-${cfg.variable}-${label}`
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/gi, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase();
  return `${stem || "zarr-acquisition"}.tif`;
}

function numericArray(value, keepMissing = false) {
  return Array.isArray(value) || ArrayBuffer.isView(value)
    ? Array.from(value, Number).filter(
        (item) => keepMissing || Number.isFinite(item)
      )
    : [];
}

function medianSpacing(values) {
  const sorted = [...new Set(values)].sort((a, b) => a - b);
  const gaps = sorted
    .slice(1)
    .map((value, index) => Math.abs(value - sorted[index]))
    .filter((value) => value > 0)
    .sort((a, b) => a - b);
  return gaps.length ? gaps[Math.floor(gaps.length / 2)] : null;
}

function queryResultToRaster(result) {
  const xDimension = cfg.xDimension || result.dimensions?.at(-1);
  const yDimension = cfg.yDimension || result.dimensions?.at(-2);
  const x = numericArray(result.coordinates?.[xDimension]);
  const y = numericArray(result.coordinates?.[yDimension]);
  const data = numericArray(result[cfg.variable], true);
  if (!data.length || data.length !== x.length || data.length !== y.length)
    throw new Error("The selected acquisition contains no exportable pixels.");
  const uniqueX = [...new Set(x)].sort((a, b) => a - b);
  const uniqueY = [...new Set(y)].sort((a, b) => b - a);
  const bounds = list(cfg.sourceBounds, 4, "Source bounds");
  const inferredX = medianSpacing(uniqueX);
  const inferredY = medianSpacing(uniqueY);
  const width = Math.round(
    Number.isInteger(cfg.gridWidth)
      ? cfg.gridWidth
      : bounds && inferredX
      ? (bounds[2] - bounds[0]) / inferredX
      : uniqueX.length
  );
  const height = Math.round(
    Number.isInteger(cfg.gridHeight)
      ? cfg.gridHeight
      : bounds && inferredY
      ? (bounds[3] - bounds[1]) / inferredY
      : uniqueY.length
  );
  const resX = bounds ? (bounds[2] - bounds[0]) / width : inferredX || 1;
  const resY = bounds ? (bounds[3] - bounds[1]) / height : inferredY || 1;
  const originX = bounds ? bounds[0] : uniqueX[0] - resX / 2;
  const originY = bounds ? bounds[3] : uniqueY[0] + resY / 2;
  const nodata = Number.isFinite(cfg.nodata) ? Number(cfg.nodata) : -9999;
  const band = new Float32Array(width * height);
  band.fill(nodata);
  for (let index = 0; index < data.length; index += 1) {
    const column = Math.min(
      width - 1,
      Math.max(0, Math.floor((x[index] - originX) / resX))
    );
    const row = Math.min(
      height - 1,
      Math.max(0, Math.floor((originY - y[index]) / resY))
    );
    band[row * width + column] = Number.isFinite(data[index])
      ? data[index]
      : nodata;
  }
  return { band, width, height, originX, originY, resX, resY, nodata };
}

function overviewLevels(width, height) {
  const levels = [];
  for (let factor = 2; Math.max(width, height) / factor > 256; factor *= 2)
    levels.push(factor);
  return Uint32Array.from(levels);
}

async function rasterToCog(raster) {
  const wasmUrl = app.resolvePluginAssetUrl?.(ID, "geolibre_wasm_bg.wasm");
  if (!wasmUrl)
    throw new Error("The plugin COG encoder could not be resolved.");
  cogWasmReady ??= initCogWasm(wasmUrl).catch((error) => {
    cogWasmReady = null;
    throw error;
  });
  await cogWasmReady;
  const epsg = Number(
    String(cfg.crs)
      .toUpperCase()
      .match(/^EPSG:(\d+)$/)?.[1]
  );
  if (!Number.isInteger(epsg) || epsg < 1 || epsg > 65535)
    throw new Error("COG export requires an EPSG CRS.");
  const builder = new CogBuilder(raster.width, raster.height, 1);
  try {
    builder.set_epsg(epsg);
    builder.set_geo_transform(
      Float64Array.from([
        raster.originX,
        raster.resX,
        0,
        raster.originY,
        0,
        -raster.resY,
      ])
    );
    builder.set_nodata(raster.nodata);
    builder.set_tile_size(512);
    builder.set_compression("deflate");
    builder.set_overview_levels(overviewLevels(raster.width, raster.height));
    return builder.write_f32(raster.band);
  } finally {
    builder.free();
  }
}

async function saveCog(bytes, filename) {
  const blob = new Blob([bytes], { type: "image/tiff" });
  if (typeof window.showSaveFilePicker === "function") {
    const handle = await window.showSaveFilePicker({
      suggestedName: filename,
      types: [
        {
          description: "Cloud Optimized GeoTIFF",
          accept: { "image/tiff": [".tif"] },
        },
      ],
    });
    const writable = await handle.createWritable();
    await writable.write(blob);
    await writable.close();
    return;
  }
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}
async function exportCurrentAcquisition() {
  if (exportingAcquisition || loading || !layerId || !values.length) return;
  exportingAcquisition = true;
  stop();
  const button = panel?.querySelector("[data-export-acquisition]");
  if (button) {
    button.disabled = true;
    button.textContent = "Exporting COG…";
  }
  const label = labels[frame] ?? `${cfg.timeDimension} ${values[frame]}`;
  try {
    status(`Reading ${label} at full resolution…`);
    const mapBounds = datasetMapBounds(cfg);
    const [west, south, east, north] = mapBounds;
    const padX = Math.max((east - west) * 1e-6, 1e-9);
    const padY = Math.max((north - south) * 1e-6, 1e-9);
    const geometry = {
      type: "Polygon",
      coordinates: [
        [
          [west - padX, south - padY],
          [east + padX, south - padY],
          [east + padX, north + padY],
          [west - padX, north + padY],
          [west - padX, south - padY],
        ],
      ],
    };
    const result = await activeLayer().queryData(
      geometry,
      { [cfg.timeDimension]: values[frame] },
      { includeSpatialCoordinates: true, level: "finest" }
    );
    const bytes = await rasterToCog(queryResultToRaster(result));
    await saveCog(bytes, exportFileName(label));
    status(`Saved ${label} as a Cloud Optimized GeoTIFF.`, "success");
  } catch (error) {
    if (error?.name === "AbortError") {
      status("COG export cancelled.");
      return;
    }
    status(
      error instanceof Error
        ? error.message
        : "Could not export this acquisition.",
      "error"
    );
  } finally {
    exportingAcquisition = false;
    if (button) {
      button.disabled = false;
      button.textContent = "Export current acquisition as COG";
    }
  }
}
async function load(next = cfg) {
  if (loading) return;
  loading = true;
  try {
    if (!next.variable.trim() || !next.timeDimension.trim())
      throw new Error("Variable and time dimension are required.");
    const axis = timeAxis(next),
      palette = colors(next);
    const clim = [Number(next.climMin), Number(next.climMax)];
    if (clim.some((item) => !Number.isFinite(item)) || clim[0] >= clim[1])
      throw new Error("Color minimum must be smaller than color maximum.");
    list(next.sourceBounds, 4, "Source bounds");
    cfg = { ...next };
    values = axis.values;
    labels = axis.labels;
    frame = values.length - 1;
    selectedPoint = null;
    selectedSeries = null;
    status(`Loading ${cfg.variable}…`);
    void palette;
    void clim;
    if (layerId) removeNativeLayer(layerId);
    const nextLayerId = await addNativeZarrLayer(
      cfg.name || `${cfg.variable} time series`,
      cfg
    );
    if (!app || !nativeLayers.has(nextLayerId)) {
      removeNativeLayer(nextLayerId);
      throw new DOMException("Zarr viewer deactivated.", "AbortError");
    }
    layerId = nextLayerId;
    const dimensions = activeLayer()?.dimensionValues;
    const detected = dimensions?.[cfg.timeDimension];
    if (Array.isArray(detected) && detected.length) {
      values = [...detected];
      labels = axisLabels(values, cfg);
      cfg.timeCount = values.length;
      frame = values.length - 1;
      const layer = activeLayer();
      if (!layer)
        throw new DOMException("Zarr viewer deactivated.", "AbortError");
      await layer.setSelector({ [cfg.timeDimension]: values[frame] });
      if (!app || activeLayer() !== layer)
        throw new DOMException("Zarr viewer deactivated.", "AbortError");
    }
    try {
      app.fitBounds?.(datasetMapBounds(cfg));
    } catch {
      // Rendering can still work without a declared or derivable WGS84 extent.
    }
    bindMap();
    render();
    status(
      `Ready. Click the ${cfg.variable} layer to chart a pixel.`,
      "success"
    );
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") return;
    status(
      error instanceof Error
        ? error.message
        : typeof error === "string" && error
        ? error
        : "Could not load the Zarr data.",
      "error"
    );
  } finally {
    loading = false;
  }
}
function readForm(form) {
  const data = new FormData(form),
    get = (key) => String(data.get(key) ?? "");
  const variable = get("variable");
  const sameGrid = variable === cfg.gridVariable;
  return {
    source: get("source"),
    url: get("url"),
    name: get("name"),
    variable,
    availableVariables: cfg.availableVariables ?? [],
    valueLabel: get("valueLabel"),
    timeDimension: get("timeDimension"),
    timeValuesText: get("timeValuesText"),
    timeStart: Number(get("timeStart")),
    timeStep: Number(get("timeStep")),
    timeCount: Number(get("timeCount")),
    dateOrigin: get("dateOrigin"),
    dateUnit: get("dateUnit"),
    climMin: Number(get("climMin")),
    climMax: Number(get("climMax")),
    palette: get("palette"),
    customColors: get("customColors"),
    zarrVersion: Number(get("zarrVersion")),
    crs: get("crs"),
    proj4: get("proj4"),
    xDimension: get("xDimension"),
    yDimension: get("yDimension"),
    sourceBounds: get("sourceBounds"),
    mapBounds: get("mapBounds"),
    gridVariable: sameGrid ? cfg.gridVariable : void 0,
    gridWidth: sameGrid ? cfg.gridWidth : void 0,
    gridHeight: sameGrid ? cfg.gridHeight : void 0,
    nodata: sameGrid ? cfg.nodata : -9999,
  };
}
function formHtml() {
  const option = (value, current) =>
    `<option value="${value}" ${value === current ? "selected" : ""}>${
      value[0].toUpperCase() + value.slice(1)
    }</option>`;
  const availableVariables = cfg.availableVariables ?? [];
  const variableControl = availableVariables.length
    ? `<select name="variable" required>${availableVariables
        .map(
          (name) =>
            `<option value="${esc(name)}" ${
              name === cfg.variable ? "selected" : ""
            }>${esc(name)}</option>`
        )
        .join("")}</select>`
    : `<input name="variable" value="${esc(cfg.variable)}" required/>`;
  return `<details class="ztsv-config"><summary>Data source and display settings</summary><form data-form>
    <label>Source<select name="source">${
    cfg.source === "local"
      ? '<option value="local" selected>Local folder</option>'
      : ""
  }${option("custom", cfg.source)}</select></label>
    <div class="ztsv-folder ztsv-wide"><button type="button" data-folder>Choose Zarr folder</button><input data-folder-input type="file" webkitdirectory directory multiple hidden/><span>${
      cfg.source === "local"
        ? esc(cfg.url)
        : "Select a directory containing .zmetadata or zarr.json"
    }</span></div>
    <label class="ztsv-wide">Zarr store URL<input name="url" value="${esc(
      cfg.url
    )}" placeholder="https://example.com/cube.zarr"/></label><button class="ztsv-secondary ztsv-wide" type="button" data-inspect-url>Read metadata and variables</button>
    <label>Layer name<input name="name" value="${esc(
      cfg.name
    )}"/></label><label>Variable${variableControl}</label>
    <label>Value label<input name="valueLabel" value="${esc(
      cfg.valueLabel
    )}" placeholder="°C"/></label><label>Time dimension<input name="timeDimension" value="${esc(
    cfg.timeDimension
  )}" required/></label>
    <label>Start<input name="timeStart" type="number" step="any" value="${esc(
      cfg.timeStart
    )}"/></label><label>Step<input name="timeStep" type="number" step="any" value="${esc(
    cfg.timeStep
  )}"/></label>
    <label>Count<input name="timeCount" type="number" min="1" value="${esc(
      cfg.timeCount
    )}"/></label><label class="ztsv-wide">Explicit time values<textarea name="timeValuesText" rows="2" placeholder="Optional comma-separated coordinates">${esc(
    cfg.timeValuesText
  )}</textarea></label>
    <label>Date origin<input name="dateOrigin" value="${esc(
      cfg.dateOrigin
    )}" placeholder="2020-01-01T00:00:00Z"/></label><label>Date unit<select name="dateUnit">${[
    "milliseconds",
    "seconds",
    "minutes",
    "hours",
    "days",
  ]
    .map((value) => option(value, cfg.dateUnit))
    .join("")}</select></label>
    <label>Color minimum<input name="climMin" type="number" step="any" value="${esc(
      cfg.climMin
    )}"/></label><label>Color maximum<input name="climMax" type="number" step="any" value="${esc(
    cfg.climMax
  )}"/></label>
    <label>Palette<select name="palette">${[...Object.keys(PALETTES), "custom"]
      .map((value) => option(value, cfg.palette))
      .join(
        ""
      )}</select></label><label class="ztsv-wide">Custom colors<input name="customColors" value="${esc(
    cfg.customColors
  )}"/></label>
    <label>Zarr version<select name="zarrVersion">${option(
      "2",
      String(cfg.zarrVersion)
    )}${option(
    "3",
    String(cfg.zarrVersion)
  )}</select></label><label>CRS<input name="crs" value="${esc(
    cfg.crs
  )}" placeholder="EPSG:4326"/></label>
    <label class="ztsv-wide">Proj4 definition<input name="proj4" value="${esc(
      cfg.proj4
    )}" placeholder="Optional for non-WGS84/Web Mercator CRS"/></label>
    <label>X dimension<input name="xDimension" value="${esc(
      cfg.xDimension
    )}"/></label><label>Y dimension<input name="yDimension" value="${esc(
    cfg.yDimension
  )}"/></label>
    <label class="ztsv-wide">Source bounds<input name="sourceBounds" value="${esc(
      cfg.sourceBounds
    )}" placeholder="xMin, yMin, xMax, yMax"/></label><label class="ztsv-wide">Map bounds (WGS84)<input name="mapBounds" value="${esc(
    cfg.mapBounds
  )}" placeholder="west, south, east, north"/></label>
    <button class="ztsv-primary" type="submit">Add time series</button></form></details>`;
}
function render() {
  if (!panel) return;
  if (!values.length) {
    const axis = timeAxis(cfg);
    values = axis.values;
    labels = axis.labels;
    frame = values.length - 1;
  }
  const palette = (() => {
    try {
      return colors();
    } catch {
      return PALETTES.viridis;
    }
  })();
  const acquisitionControl =
    labels.length <= 2000
      ? `<select data-acquisition>${labels
          .map(
            (label, index) =>
              `<option value="${index}" ${
                index === frame ? "selected" : ""
              }>${esc(label)}</option>`
          )
          .join("")}</select>`
      : `<input data-acquisition-index type="number" min="1" max="${
          labels.length
        }" value="${
          frame + 1
        }" aria-label="Acquisition number"/><small>Enter an acquisition number from 1 to ${labels.length.toLocaleString()}.</small>`;
  panel.classList.add("ztsv-panel");
  panel.innerHTML = `<section class="ztsv-hero"><div class="ztsv-eyebrow">Zarr data cube</div><h2>${esc(
    cfg.name
  )}</h2><p>${esc(cfg.variable)} · ${values.length} time steps</p></section>
    <div data-status class="ztsv-status">${
      layerId
        ? "Ready. Click the layer to chart a pixel."
        : "Choose a local Zarr folder or enter a remote store URL."
    }</div>${formHtml()}
    <section class="ztsv-card"><div class="ztsv-date-row"><strong data-date></strong><span data-count></span></div><label class="ztsv-speed">Acquisition${acquisitionControl}</label><input data-range class="ztsv-range" type="range" min="0" max="${
    values.length - 1
  }" step="1" aria-label="Time step"/><div class="ztsv-controls"><button data-prev>Previous</button><button data-play aria-pressed="false">Play</button><button data-next>Next</button></div><button data-add-acquisition class="ztsv-secondary" ${
    layerId ? "" : "disabled"
  }>Add current acquisition as layer</button><button data-export-acquisition class="ztsv-secondary" ${
    layerId ? "" : "disabled"
  }>Export current acquisition as COG</button><label class="ztsv-speed">Playback speed<select data-speed><option value="1000">1×</option><option value="500" selected>2×</option><option value="250">4×</option></select></label><div class="ztsv-legend"><span>${esc(
    cfg.climMin
  )}</span><i style="background:linear-gradient(90deg,${palette.join(
    ","
  )})"></i><span>${esc(
    cfg.climMax
  )}</span></div><div class="ztsv-legend-labels"><span>Low</span><span>High</span></div></section>
    <section class="ztsv-card ztsv-inspector"><div class="ztsv-section-title"><div><span class="ztsv-eyebrow">Pixel history</span><strong data-location>Click the map</strong></div><span data-current></span></div><svg data-chart class="ztsv-chart" viewBox="0 0 320 112" role="img" aria-label="${esc(
      cfg.variable
    )} time-series chart"></svg><p data-summary class="ztsv-summary">Click inside the layer footprint to inspect all ${
    values.length
  } observations.</p></section>
    <section class="ztsv-card ztsv-details"><strong>About this dataset</strong><dl><div><dt>Variable</dt><dd>${esc(
      cfg.variable
    )}</dd></div><div><dt>Time axis</dt><dd>${esc(cfg.timeDimension)} · ${
    values.length
  } steps</dd></div><div><dt>CRS</dt><dd>${esc(
    cfg.crs || "From store"
  )}</dd></div><div><dt>Color range</dt><dd>${esc(cfg.climMin)} to ${esc(
    cfg.climMax
  )}</dd></div><div><dt>Source</dt><dd>${esc(
    cfg.url
  )}</dd></div></dl><button data-zoom class="ztsv-secondary">Zoom to dataset</button></section>`;
  panel.querySelector("[data-form]")?.addEventListener("submit", (event) => {
    event.preventDefault();
    stop();
    void load(readForm(event.currentTarget));
  });
  panel
    .querySelector('[name="source"]')
    ?.addEventListener("change", (event) => {
      if (event.currentTarget.value !== "custom") return;
      localStore = null;
      inspectedMetadata = null;
      const form = event.currentTarget.form;
      form.elements.url.value = "";
      form.elements.name.value = "Zarr time series";
      form.elements.variable.value = "";
      form.elements.valueLabel.value = "";
      form.elements.timeStart.value = "0";
      form.elements.timeStep.value = "1";
      form.elements.timeCount.value = "1";
      form.elements.dateOrigin.value = "";
      form.elements.crs.value = "";
      form.elements.proj4.value = "";
      form.elements.sourceBounds.value = "";
      form.elements.mapBounds.value = "";
    });
  const remoteUrlInput = panel.querySelector('[name="url"]');
  panel
    .querySelector("[data-inspect-url]")
    ?.addEventListener("click", (event) => {
      const form = event.currentTarget.form;
      if (form?.elements.source.value === "local") {
        try {
          inspectLocalStore(form);
        } catch (error) {
          status(
            error instanceof Error
              ? error.message
              : "Could not inspect this local Zarr store.",
            "error"
          );
        }
        return;
      }
      void inspectRemoteStore(form);
    });
  remoteUrlInput?.addEventListener("change", (event) => {
    const form = event.currentTarget.form;
    if (
      form?.elements.source.value === "custom" &&
      event.currentTarget.value.trim()
    )
      void inspectRemoteStore(form);
  });
  panel
    .querySelector('[name="variable"]')
    ?.addEventListener("change", (event) => {
      const form = event.currentTarget.form;
      if (
        !inspectedMetadata ||
        !["custom", "local"].includes(form?.elements.source.value)
      )
        return;
      cfg = configFromMetadata(inspectedMetadata, {
        ...readForm(form),
        variable: event.currentTarget.value,
      });
      values = [];
      labels = [];
      render();
      panel?.querySelector(".ztsv-config")?.setAttribute("open", "");
      if (form.elements.source.value === "local" && !cfg.hasDeclaredRange) {
        status("Reading the first acquisition to determine its display range…");
        void applyLocalDisplayRange()
          .then((result) => {
            if (!result.range) {
              status(
                result.reason === "suggested"
                  ? `${cfg.variable} selected with the standard NDVI display range of -1 to 1.`
                  : `${cfg.variable} selected. Review the display range before adding the time series.`,
                "success"
              );
              return;
            }
            status(
              `${cfg.variable} selected with a derived display range of ${result.range[0].toLocaleString()} to ${result.range[1].toLocaleString()}.`,
              "success"
            );
          })
          .catch((error) =>
            status(
              error instanceof Error
                ? error.message
                : "Could not inspect this variable's display range.",
              "error"
            )
          );
        return;
      }
      status(
        `${cfg.variable} selected. Review the display range, then add the time series.`,
        "success"
      );
    });
  const folderInput = panel.querySelector("[data-folder-input]");
  panel
    .querySelector("[data-folder]")
    ?.addEventListener("click", () => folderInput?.click());
  folderInput?.addEventListener("change", (event) => {
    void chooseFolder(event.currentTarget.files).catch((error) =>
      status(
        error instanceof Error ? error.message : "Could not open this folder.",
        "error"
      )
    );
  });
  panel.querySelector("[data-range]")?.addEventListener("input", (event) => {
    const next = Number(event.currentTarget.value);
    stop();
    void show(next);
  });
  panel
    .querySelector("[data-acquisition]")
    ?.addEventListener("change", (event) => {
      const next = Number(event.currentTarget.value);
      stop();
      void show(next);
    });
  panel
    .querySelector("[data-acquisition-index]")
    ?.addEventListener("change", (event) => {
      const next = Number(event.currentTarget.value) - 1;
      stop();
      void show(next);
    });
  panel
    .querySelector("[data-add-acquisition]")
    ?.addEventListener("click", () => void addCurrentAcquisition());
  panel
    .querySelector("[data-export-acquisition]")
    ?.addEventListener("click", () => void exportCurrentAcquisition());
  panel.querySelector("[data-prev]")?.addEventListener("click", () => {
    stop();
    void show(frame - 1);
  });
  panel.querySelector("[data-next]")?.addEventListener("click", () => {
    stop();
    void show(frame + 1);
  });
  panel.querySelector("[data-play]")?.addEventListener("click", play);
  panel.querySelector("[data-speed]")?.addEventListener("change", (event) => {
    speed = Number(event.currentTarget.value);
    if (timer) {
      stop();
      play();
    }
  });
  panel.querySelector("[data-zoom]")?.addEventListener("click", () => {
    try {
      app.fitBounds?.(datasetMapBounds(cfg));
    } catch (error) {
      status(error.message, "error");
    }
  });
  updateUi();
  if (selectedPoint && selectedSeries) {
    panel.querySelector(
      "[data-location]"
    ).textContent = `${selectedPoint[1].toFixed(
      5
    )}°, ${selectedPoint[0].toFixed(5)}°`;
    chart(selectedSeries);
  }
}
function renderPanel(container) {
  panel = container;
  render();
  if (!layerId && hasConfiguredSource()) void load();
  return () => {
    if (panel === container) panel = null;
  };
}
class ViewerControl {
  onAdd() {
    const wrapper = document.createElement("div"),
      button = document.createElement("button");
    wrapper.className =
      "maplibregl-ctrl maplibregl-ctrl-group ztsv-map-control";
    button.type = "button";
    button.title = "Open Zarr Time Series Viewer";
    button.setAttribute("aria-label", button.title);
    button.textContent = "Zarr";
    button.addEventListener("click", () => app.openRightPanel?.(PANEL));
    wrapper.appendChild(button);
    this.container = wrapper;
    return wrapper;
  }
  onRemove() {
    this.container?.remove();
    this.container = null;
  }
}
const plugin = {
  id: ID,
  name: "Zarr Time Series Viewer",
  version: VERSION,
  activate(host) {
    app = host;
    unregister = host.registerRightPanel?.({
      id: PANEL,
      title: "Zarr Time Series",
      dock: "replace-style",
      defaultWidth: 400,
      render: renderPanel,
      onCollapse: stop,
      onClose: stop,
    });
    control = new ViewerControl();
    host.addMapControl(control, "top-right");
    host.openRightPanel?.(PANEL);
    if (!host.registerRightPanel && hasConfiguredSource()) void load();
    return true;
  },
  deactivate(host) {
    stop();
    queryController?.abort();
    const map = host.getMap?.();
    if (map && mapClick) map.off("click", mapClick);
    mapClick = null;
    for (const id of [...nativeLayers.keys()]) removeNativeLayer(id);
    layerId = null;
    if (control) host.removeMapControl(control);
    host.closeRightPanel?.(PANEL);
    unregister?.();
    panel = null;
    control = null;
    unregister = null;
    metadataController?.abort();
    metadataController = null;
    inspectedMetadata = null;
    app = null;
  },
  getProjectState() {
    return { config: cfg, frame, speed, selectedPoint };
  },
  applyProjectState(_host, state) {
    if (!state || typeof state !== "object") return false;
    if (state.config && typeof state.config === "object") {
      cfg = { ...DEFAULT_CONFIG, ...state.config };
      if (cfg.source === "sample") cfg = { ...DEFAULT_CONFIG };
    }
    try {
      const axis = timeAxis(cfg);
      values = axis.values;
      labels = axis.labels;
    } catch {
      return false;
    }
    if (Number.isInteger(state.frame))
      frame = Math.max(0, Math.min(values.length - 1, state.frame));
    if ([250, 500, 1e3].includes(state.speed)) speed = state.speed;
    selectedPoint =
      Array.isArray(state.selectedPoint) && state.selectedPoint.length === 2
        ? [...state.selectedPoint]
        : null;
    selectedSeries = null;
    updateUi();
    const restoredPoint = selectedPoint;
    if (!layerId && hasConfiguredSource()) {
      void load(cfg);
      return true;
    }
    if (layerId)
      void show(frame).then(() => {
        if (restoredPoint) return inspect(...restoredPoint);
      });
    return true;
  },
};
var stdin_default = plugin;
export { stdin_default as default, plugin };
