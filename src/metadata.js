const SPATIAL_DIMENSIONS = new Set([
  "x",
  "y",
  "lon",
  "lat",
  "longitude",
  "latitude",
]);

export function normalizeStoreUrl(value) {
  const url = String(value ?? "")
    .trim()
    .replace(/\/(?:\.zmetadata|zarr\.json)\/?$/, "")
    .replace(/\/$/, "");
  if (!/^https?:\/\//i.test(url)) {
    throw new Error("Enter an HTTP or HTTPS Zarr store URL.");
  }
  return url;
}

function v3Metadata(document) {
  const consolidated = document?.consolidated_metadata?.metadata;
  if (!consolidated || typeof consolidated !== "object") return null;
  const metadata = { ".zattrs": document.attributes ?? {} };
  for (const [path, node] of Object.entries(consolidated)) {
    const cleanPath = String(path).replace(/^\/+|\/+$/g, "");
    if (!cleanPath || !node || typeof node !== "object") continue;
    if (node.node_type === "array") {
      metadata[`${cleanPath}/.zarray`] = {
        shape: node.shape,
        fill_value: node.fill_value,
      };
      metadata[`${cleanPath}/.zattrs`] = {
        ...(node.attributes ?? {}),
        ...(Array.isArray(node.dimension_names)
          ? { _ARRAY_DIMENSIONS: node.dimension_names }
          : {}),
      };
    } else if (node.node_type === "group") {
      metadata[`${cleanPath}/.zattrs`] = node.attributes ?? {};
    }
  }
  return metadata;
}

export function metadataFromDocument(document) {
  if (document?.metadata && typeof document.metadata === "object") {
    return { zarrVersion: 2, metadata: document.metadata };
  }
  const metadata = v3Metadata(document);
  if (metadata) return { zarrVersion: 3, metadata };
  throw new Error(
    "No consolidated Zarr metadata was found. Expected .zmetadata (v2) or consolidated metadata in zarr.json (v3)."
  );
}

async function fetchJson(fetchImpl, url, signal) {
  const response = await fetchImpl(url, { signal });
  if (response.status === 404) return null;
  if (!response.ok) {
    throw new Error(`Could not read ${url} (${response.status}).`);
  }
  return response.json();
}

export async function readRemoteMetadata(value, fetchImpl = fetch, signal) {
  const url = normalizeStoreUrl(value);
  const v2 = await fetchJson(fetchImpl, `${url}/.zmetadata`, signal);
  if (v2) return { url, ...metadataFromDocument(v2) };
  const v3 = await fetchJson(fetchImpl, `${url}/zarr.json`, signal);
  if (v3) return { url, ...metadataFromDocument(v3) };
  throw new Error(
    "No consolidated Zarr metadata was found. Remote variable discovery requires .zmetadata (v2) or consolidated metadata in zarr.json (v3)."
  );
}

export function configFromLayerSpatialMetadata(layer, current = {}) {
  const result = { ...current };
  const spatial = layer?.xyLimits ? layer : layer?.zarrStore ?? layer;
  const limits = spatial?.xyLimits;
  const bounds = limits
    ? [limits.xMin, limits.yMin, limits.xMax, limits.yMax]
    : [];
  if (
    !String(result.sourceBounds ?? "").trim() &&
    bounds.length === 4 &&
    bounds.every(Number.isFinite)
  ) {
    result.sourceBounds = bounds.join(", ");
  }
  const crs = spatial?.crs ?? layer?.crs;
  if (!String(result.crs ?? "").trim() && String(crs ?? "").trim()) {
    result.crs = String(crs).trim();
  }
  return result;
}

export function finiteRange(values) {
  let minimum = Infinity;
  let maximum = -Infinity;
  for (const value of values ?? []) {
    const number = Number(value);
    if (!Number.isFinite(number)) continue;
    if (number < minimum) minimum = number;
    if (number > maximum) maximum = number;
  }
  if (minimum > maximum) return null;
  if (minimum === maximum) {
    const padding = Math.max(Math.abs(minimum) * 0.01, 0.5);
    return [minimum - padding, maximum + padding];
  }
  return [minimum, maximum];
}

function multiscaleVariables(arrays, rootAttrs) {
  const paths = rootAttrs?.multiscales?.[0]?.datasets
    ?.map((dataset) => String(dataset?.path ?? "").replace(/^\/+|\/+$/g, ""))
    .filter(Boolean);
  const firstPath = paths?.[0];
  if (!firstPath) return arrays;
  const prefix = `${firstPath}/`;
  const variables = arrays
    .filter((item) => item.name.startsWith(prefix))
    .map((item) => ({
      ...item,
      metadataName: item.name,
      name: item.name.slice(prefix.length),
    }));
  return variables.length ? variables : arrays;
}

function gridMappingNames(metadata) {
  return new Set(
    Object.entries(metadata)
      .filter(([key]) => key.endsWith("/.zattrs"))
      .map(([, attributes]) => String(attributes?.grid_mapping ?? "").trim())
      .filter(Boolean)
      .map((value) => value.split(/[\s:]+/, 1)[0])
  );
}

function epsgFromText(value) {
  if (
    Number.isInteger(value) &&
    String(value).length >= 4 &&
    String(value).length <= 6
  ) {
    return `EPSG:${value}`;
  }
  const text = String(value ?? "");
  const direct = text.match(/EPSG(?:\s*[:/]\s*|::)(\d{4,6})/i);
  if (direct) return `EPSG:${direct[1]}`;
  const matches = [
    ...text.matchAll(/(?:AUTHORITY|ID)\s*\[\s*["']EPSG["']\s*,\s*["']?(\d{4,6})/gi),
  ];
  return matches.length ? `EPSG:${matches.at(-1)[1]}` : "";
}

function referencedAttributes(metadata, variableName, reference) {
  const cleanReference = String(reference ?? "")
    .trim()
    .replace(/^\/+|\/+$/g, "");
  if (!cleanReference) return null;
  const slash = variableName.lastIndexOf("/");
  const prefix = slash >= 0 ? variableName.slice(0, slash + 1) : "";
  const paths = cleanReference.includes("/")
    ? [cleanReference]
    : [`${prefix}${cleanReference}`, cleanReference];
  for (const path of new Set(paths)) {
    const attributes = metadata[`${path}/.zattrs`];
    if (attributes && typeof attributes === "object") return attributes;
  }
  return null;
}

function spatialMetadataAttributes(
  metadata,
  variableName,
  variableAttrs,
  xDimension,
  yDimension
) {
  const mappingName = String(variableAttrs.grid_mapping ?? "")
    .trim()
    .split(/[\s:]+/, 1)[0];
  const coordinateNames = String(variableAttrs.coordinates ?? "")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  const references = [
    mappingName,
    ...coordinateNames,
    xDimension,
    yDimension,
  ].filter(Boolean);
  const attributes = references
    .map((reference) => referencedAttributes(metadata, variableName, reference))
    .filter(Boolean);
  return [...new Set(attributes)];
}

function metadataCrs(
  metadata,
  variableName,
  variableAttrs,
  rootAttrs,
  xDimension,
  yDimension
) {
  const spatialAttrs = spatialMetadataAttributes(
    metadata,
    variableName,
    variableAttrs,
    xDimension,
    yDimension
  );
  const candidates = [
    variableAttrs.crs,
    variableAttrs.epsg,
    variableAttrs.epsg_code,
    variableAttrs.crs_wkt,
    variableAttrs.spatial_ref,
    ...spatialAttrs.flatMap((attributes) => [
      attributes.crs,
      attributes.epsg,
      attributes.epsg_code,
      attributes.crs_wkt,
      attributes.spatial_ref,
    ]),
    rootAttrs.crs,
    rootAttrs.epsg,
    rootAttrs.epsg_code,
    rootAttrs.crs_wkt,
    rootAttrs.spatial_ref,
  ];
  for (const candidate of candidates) {
    const epsg = epsgFromText(candidate);
    if (epsg) return epsg;
  }
  return "";
}

function metadataProjectionDefinition(
  metadata,
  variableName,
  variableAttrs,
  rootAttrs,
  xDimension,
  yDimension
) {
  const spatialAttrs = spatialMetadataAttributes(
    metadata,
    variableName,
    variableAttrs,
    xDimension,
    yDimension
  );
  const candidates = [
    variableAttrs.crs_wkt,
    variableAttrs.spatial_ref,
    ...spatialAttrs.flatMap((attributes) => [
      attributes.crs_wkt,
      attributes.spatial_ref,
    ]),
    rootAttrs.crs_wkt,
    rootAttrs.spatial_ref,
  ];
  return (
    candidates.find(
      (candidate) =>
        typeof candidate === "string" && candidate.trim().length > 0
    )?.trim() ?? ""
  );
}

export function configFromMetadata(metadata, current = {}) {
  const rootAttrs = metadata[".zattrs"] ?? {};
  const coordinateReferenceArrays = gridMappingNames(metadata);
  const arrays = Object.entries(metadata)
    .filter(
      ([key, value]) =>
        key.endsWith("/.zarray") &&
        Array.isArray(value?.shape) &&
        value.shape.length >= 3 &&
        !coordinateReferenceArrays.has(key.slice(0, -8))
    )
    .map(([key, array]) => ({
      name: key.slice(0, -8),
      metadataName: key.slice(0, -8),
      array,
    }));
  const variables = multiscaleVariables(arrays, rootAttrs);
  const selected =
    variables.find((item) => item.name === current.variable) ?? variables[0];
  if (!selected) {
    throw new Error(
      "The store contains no time-series arrays. Expected a variable with at least three dimensions: a time or sequence axis plus two spatial axes."
    );
  }

  const variableAttrs = metadata[`${selected.metadataName}/.zattrs`] ?? {};
  const dimensions = variableAttrs._ARRAY_DIMENSIONS ?? [];
  const xDimension =
    dimensions.find((name) =>
      ["x", "lon", "longitude"].includes(String(name).toLowerCase())
    ) ?? "x";
  const yDimension =
    dimensions.find((name) =>
      ["y", "lat", "latitude"].includes(String(name).toLowerCase())
    ) ?? "y";
  const timeDimension =
    dimensions.find((name) => String(name).toLowerCase() === "time") ??
    dimensions.find(
      (name) => !SPATIAL_DIMENSIONS.has(String(name).toLowerCase())
    ) ??
    dimensions[0] ??
    "time";
  const timeIndex = dimensions.indexOf(timeDimension);
  const xIndex = dimensions.indexOf(xDimension);
  const yIndex = dimensions.indexOf(yDimension);
  const coordinate =
    metadata[
      `${selected.metadataName.slice(
        0,
        selected.metadataName.lastIndexOf("/") + 1
      )}${timeDimension}/.zattrs`
    ] ??
    metadata[`${timeDimension}/.zattrs`] ??
    {};
  const units = String(coordinate.units ?? "").match(
    /^(milliseconds|seconds|minutes|hours|days)\s+since\s+(.+)$/i
  );
  const declaredRange =
    variableAttrs.actual_range ??
    variableAttrs.valid_range ??
    rootAttrs.variable_ranges?.[selected.name];
  const normalizedVariable = selected.name.toLowerCase().split("/").at(-1);
  const suggestedRange = normalizedVariable === "ndvi" ? [-1, 1] : null;
  const latitudeLongitude = [xDimension, yDimension].every((name) =>
    ["lon", "longitude", "lat", "latitude"].includes(String(name).toLowerCase())
  );
  const detectedCrs = metadataCrs(
    metadata,
    selected.metadataName,
    variableAttrs,
    rootAttrs,
    xDimension,
    yDimension
  );
  const detectedProjection = metadataProjectionDefinition(
    metadata,
    selected.metadataName,
    variableAttrs,
    rootAttrs,
    xDimension,
    yDimension
  );

  return {
    ...current,
    variable: selected.name,
    availableVariables: variables.map((item) => item.name),
    valueLabel:
      variableAttrs.long_name ??
      variableAttrs.standard_name ??
      variableAttrs.units ??
      (current.variable === selected.name && current.valueLabel
        ? current.valueLabel
        : selected.name),
    timeDimension,
    timeCount: selected.array.shape[timeIndex >= 0 ? timeIndex : 0] ?? 1,
    timeStart: 0,
    timeStep: 1,
    timeValuesText: "",
    ...(units
      ? { dateUnit: units[1].toLowerCase(), dateOrigin: units[2] }
      : {}),
    xDimension,
    yDimension,
    gridVariable: selected.name,
    gridWidth: selected.array.shape[xIndex],
    gridHeight: selected.array.shape[yIndex],
    nodata: Number.isFinite(Number(selected.array.fill_value))
      ? Number(selected.array.fill_value)
      : -9999,
    hasDeclaredRange:
      Array.isArray(declaredRange) &&
      declaredRange.length >= 2 &&
      declaredRange.every(Number.isFinite),
    hasSuggestedRange: Boolean(suggestedRange),
    palette: selected.name.toLowerCase() === "ndvi" ? "ndvi" : "viridis",
    ...(Array.isArray(declaredRange) &&
    declaredRange.length >= 2 &&
    declaredRange.every(Number.isFinite)
      ? { climMin: Number(declaredRange[0]), climMax: Number(declaredRange[1]) }
      : suggestedRange
      ? { climMin: suggestedRange[0], climMax: suggestedRange[1] }
      : {}),
    ...(!current.crs && detectedCrs
      ? { crs: detectedCrs }
      : latitudeLongitude && !current.crs
      ? { crs: "EPSG:4326" }
      : {}),
    ...(!current.proj4 && detectedProjection
      ? { proj4: detectedProjection }
      : {}),
  };
}
