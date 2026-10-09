import assert from "node:assert/strict";
import test from "node:test";

import {
  configFromLayerSpatialMetadata,
  configFromMetadata,
  finiteRange,
  metadataFromDocument,
  normalizeStoreUrl,
  readRemoteMetadata,
} from "../src/metadata.js";
import { timeAxis } from "../src/time-axis.js";

test("normalizes metadata URLs to the store root", () => {
  assert.equal(
    normalizeStoreUrl("https://example.test/cube.zarr/.zmetadata"),
    "https://example.test/cube.zarr"
  );
});

test("discovers variables and dimensions in a consolidated v2 store", async () => {
  const document = {
    metadata: {
      ".zattrs": {},
      "time/.zattrs": { units: "hours since 2024-01-01" },
      "temperature/.zarray": {
        shape: [4, 20, 30],
        fill_value: -9999,
      },
      "temperature/.zattrs": {
        _ARRAY_DIMENSIONS: ["time", "latitude", "longitude"],
        long_name: "Air temperature",
      },
      "precipitation/.zarray": { shape: [4, 20, 30] },
      "precipitation/.zattrs": {
        _ARRAY_DIMENSIONS: ["time", "latitude", "longitude"],
      },
    },
  };
  const fakeFetch = async (url) => ({
    ok: true,
    status: 200,
    json: async () => document,
  });
  const discovered = await readRemoteMetadata(
    "https://example.test/weather.zarr",
    fakeFetch
  );
  const config = configFromMetadata(discovered.metadata, {});
  assert.equal(discovered.zarrVersion, 2);
  assert.deepEqual(config.availableVariables, ["temperature", "precipitation"]);
  assert.equal(config.variable, "temperature");
  assert.equal(config.timeDimension, "time");
  assert.equal(config.timeCount, 4);
  assert.equal(config.xDimension, "longitude");
  assert.equal(config.yDimension, "latitude");
  assert.equal(config.crs, "EPSG:4326");
  assert.equal(config.dateUnit, "hours");

  const precipitation = configFromMetadata(discovered.metadata, {
    ...config,
    variable: "precipitation",
    valueLabel: "",
  });
  assert.equal(precipitation.variable, "precipitation");
  assert.equal(precipitation.gridVariable, "precipitation");
});

test("collapses multiscale level paths into logical variable names", () => {
  const metadata = {
    ".zattrs": {
      multiscales: [{ datasets: [{ path: "0" }, { path: "1" }] }],
    },
    "0/salinity/.zarray": { shape: [182, 128, 128] },
    "0/salinity/.zattrs": { _ARRAY_DIMENSIONS: ["time", "y", "x"] },
    "1/salinity/.zarray": { shape: [182, 256, 256] },
    "1/salinity/.zattrs": { _ARRAY_DIMENSIONS: ["time", "y", "x"] },
  };
  const config = configFromMetadata(metadata, {});
  assert.deepEqual(config.availableVariables, ["salinity"]);
  assert.equal(config.variable, "salinity");
  assert.equal(config.timeCount, 182);
});

test("reads consolidated v3 metadata and prefers the time dimension", () => {
  const document = {
    zarr_format: 3,
    node_type: "group",
    attributes: {},
    consolidated_metadata: {
      metadata: {
        climate_t2m_mean: {
          node_type: "array",
          shape: [6, 55152, 6, 8],
          fill_value: "NaN",
          dimension_names: ["models", "time", "latitude", "longitude"],
          attributes: {},
        },
        time: {
          node_type: "array",
          shape: [55152],
          dimension_names: ["time"],
          attributes: { units: "days since 1950-01-01 00:00:00" },
        },
      },
    },
  };
  const discovered = metadataFromDocument(document);
  const config = configFromMetadata(discovered.metadata, {});
  assert.equal(discovered.zarrVersion, 3);
  assert.equal(config.variable, "climate_t2m_mean");
  assert.equal(config.timeDimension, "time");
  assert.equal(config.timeCount, 55152);
  assert.equal(config.xDimension, "longitude");
  assert.equal(config.yDimension, "latitude");
  assert.equal(config.valueLabel, "climate_t2m_mean");
});

test("detects a projected CRS and excludes its grid-mapping array", () => {
  const document = {
    zarr_format: 3,
    node_type: "group",
    attributes: {},
    consolidated_metadata: {
      metadata: {
        spatial_ref: {
          node_type: "array",
          shape: [63, 1908, 1998],
          fill_value: "NaN",
          dimension_names: ["time", "y", "x"],
          attributes: {
            crs_wkt:
              'PROJCS["WGS 84 / UTM zone 33N",AUTHORITY["EPSG","32633"]]',
          },
        },
        temperature: {
          node_type: "array",
          shape: [63, 1908, 1998],
          fill_value: "NaN",
          dimension_names: ["time", "y", "x"],
          attributes: { grid_mapping: "spatial_ref" },
        },
        time: {
          node_type: "array",
          shape: [63],
          dimension_names: ["time"],
          attributes: { units: "seconds since 2013-06-18T09:46:45" },
        },
        x: {
          node_type: "array",
          shape: [1998],
          dimension_names: ["x"],
          attributes: {},
        },
        y: {
          node_type: "array",
          shape: [1908],
          dimension_names: ["y"],
          attributes: {},
        },
      },
    },
  };

  const discovered = metadataFromDocument(document);
  const config = configFromMetadata(discovered.metadata, {});
  assert.deepEqual(config.availableVariables, ["temperature"]);
  assert.equal(config.variable, "temperature");
  assert.equal(config.crs, "EPSG:32633");
  assert.equal(config.gridWidth, 1998);
  assert.equal(config.gridHeight, 1908);
});

test("copies renderer-derived coordinate bounds into plugin configuration", () => {
  const config = configFromLayerSpatialMetadata(
    {
      crs: "EPSG:32633",
      xyLimits: {
        xMin: 589300,
        yMin: 5418360,
        xMax: 649240,
        yMax: 5475600,
      },
    },
    { sourceBounds: "", crs: "" }
  );

  assert.equal(config.crs, "EPSG:32633");
  assert.equal(config.sourceBounds, "589300, 5418360, 649240, 5475600");
});

test("copies bounds from the renderer's internal Zarr store", () => {
  const config = configFromLayerSpatialMetadata(
    {
      zarrStore: {
        crs: "EPSG:32633",
        xyLimits: { xMin: 1, yMin: 2, xMax: 3, yMax: 4 },
      },
    },
    { sourceBounds: "", crs: "" }
  );

  assert.equal(config.crs, "EPSG:32633");
  assert.equal(config.sourceBounds, "1, 2, 3, 4");
});

test("derives a finite display range while ignoring missing values", () => {
  assert.deepEqual(finiteRange([Number.NaN, 24.75, 52.91, Infinity]), [24.75, 52.91]);
  assert.equal(finiteRange([Number.NaN, Infinity]), null);
  assert.deepEqual(finiteRange([10, 10]), [9.5, 10.5]);
});

test("builds time axes longer than ten thousand coordinates", () => {
  const axis = timeAxis({
    timeValuesText: "",
    timeCount: 14367,
    timeStart: 0,
    timeStep: 1,
    timeDimension: "time",
    dateOrigin: "invalid",
    dateUnit: "days",
  });

  assert.equal(axis.values.length, 14367);
  assert.equal(axis.values.at(-1), 14366);
  assert.equal(axis.labels.at(-1), "time 14366");
});

test("rejects invalid generated time counts", () => {
  assert.throws(
    () =>
      timeAxis({
        timeValuesText: "",
        timeCount: 1.5,
        timeStart: 0,
        timeStep: 1,
        timeDimension: "time",
      }),
    /positive integer/
  );
});

test("explains that two-dimensional stores are not time series", () => {
  assert.throws(
    () =>
      configFromMetadata(
        {
          "temperature/.zarray": { shape: [180, 360] },
          "temperature/.zattrs": {
            _ARRAY_DIMENSIONS: ["latitude", "longitude"],
          },
        },
        {}
      ),
    /time or sequence axis plus two spatial axes/
  );
});
