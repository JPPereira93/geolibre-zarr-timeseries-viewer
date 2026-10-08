import assert from "node:assert/strict";
import test from "node:test";

import {
  configFromMetadata,
  normalizeStoreUrl,
  readRemoteMetadata,
} from "../src/metadata.js";

test("normalizes metadata URLs to the store root", () => {
  assert.equal(
    normalizeStoreUrl("https://example.test/cube.zarr/.zmetadata"),
    "https://example.test/cube.zarr",
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
    fakeFetch,
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
