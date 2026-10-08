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
  if (v2?.metadata && typeof v2.metadata === "object") {
    return { url, zarrVersion: 2, metadata: v2.metadata };
  }
  const v3 = await fetchJson(fetchImpl, `${url}/zarr.json`, signal);
  const metadata = v3Metadata(v3);
  if (metadata) return { url, zarrVersion: 3, metadata };
  throw new Error(
    "No consolidated Zarr metadata was found. Remote variable discovery requires .zmetadata (v2) or consolidated metadata in zarr.json (v3).",
  );
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

export function configFromMetadata(metadata, current = {}) {
  const rootAttrs = metadata[".zattrs"] ?? {};
  const arrays = Object.entries(metadata)
    .filter(
      ([key, value]) =>
        key.endsWith("/.zarray") &&
        Array.isArray(value?.shape) &&
        value.shape.length >= 3,
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
    throw new Error("The store contains no arrays with at least three dimensions.");
  }

  const variableAttrs = metadata[`${selected.metadataName}/.zattrs`] ?? {};
  const dimensions = variableAttrs._ARRAY_DIMENSIONS ?? [];
  const xDimension =
    dimensions.find((name) =>
      ["x", "lon", "longitude"].includes(String(name).toLowerCase()),
    ) ?? "x";
  const yDimension =
    dimensions.find((name) =>
      ["y", "lat", "latitude"].includes(String(name).toLowerCase()),
    ) ?? "y";
  const timeDimension =
    dimensions.find(
      (name) => !SPATIAL_DIMENSIONS.has(String(name).toLowerCase()),
    ) ?? dimensions[0] ?? "time";
  const timeIndex = dimensions.indexOf(timeDimension);
  const xIndex = dimensions.indexOf(xDimension);
  const yIndex = dimensions.indexOf(yDimension);
  const coordinate =
    metadata[`${selected.metadataName.slice(0, selected.metadataName.lastIndexOf("/") + 1)}${timeDimension}/.zattrs`] ??
    metadata[`${timeDimension}/.zattrs`] ??
    {};
  const units = String(coordinate.units ?? "").match(
    /^(milliseconds|seconds|minutes|hours|days)\s+since\s+(.+)$/i,
  );
  const declaredRange =
    variableAttrs.actual_range ??
    variableAttrs.valid_range ??
    rootAttrs.variable_ranges?.[selected.name];
  const latitudeLongitude = [xDimension, yDimension].every((name) =>
    ["lon", "longitude", "lat", "latitude"].includes(
      String(name).toLowerCase(),
    ),
  );

  return {
    ...current,
    variable: selected.name,
    availableVariables: variables.map((item) => item.name),
    valueLabel:
      variableAttrs.long_name ??
      variableAttrs.standard_name ??
      current.valueLabel ??
      "",
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
    palette: selected.name.toLowerCase() === "ndvi" ? "ndvi" : "viridis",
    ...(Array.isArray(declaredRange) &&
    declaredRange.length >= 2 &&
    declaredRange.every(Number.isFinite)
      ? { climMin: Number(declaredRange[0]), climMax: Number(declaredRange[1]) }
      : {}),
    ...(latitudeLongitude && !current.crs ? { crs: "EPSG:4326" } : {}),
  };
}
