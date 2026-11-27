import assert from "node:assert/strict";
import test from "node:test";

import {
  configFromLayerSpatialMetadata,
  configFromMetadata,
  finitePercentileRange,
  finiteRange,
  hasResolvableCrs,
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
  });
  assert.equal(precipitation.variable, "precipitation");
  assert.equal(precipitation.valueLabel, "precipitation");
  assert.equal(precipitation.gridVariable, "precipitation");
});

test("discovers labelled non-spatial dimensions and their packed-value transforms", () => {
  const metadata = {
    ".zattrs": {},
    "features/.zarray": { shape: [10, 20, 605, 569], fill_value: -32768 },
    "features/.zattrs": {
      _ARRAY_DIMENSIONS: ["year", "feature", "y", "x"],
      coordinates: "feature_offset feature_scale spatial_ref",
    },
    "feature/.zarray": { shape: [20] },
    "feature/.zattrs": { _ARRAY_DIMENSIONS: ["feature"] },
    "feature_scale/.zarray": { shape: [20] },
    "feature_scale/.zattrs": { _ARRAY_DIMENSIONS: ["feature"] },
    "feature_offset/.zarray": { shape: [20] },
    "feature_offset/.zattrs": { _ARRAY_DIMENSIONS: ["feature"] },
    "year/.zarray": { shape: [10] },
    "year/.zattrs": { _ARRAY_DIMENSIONS: ["year"] },
  };
  const config = configFromMetadata(metadata, {});
  assert.equal(config.variable, "features");
  assert.equal(config.timeDimension, "year");
  assert.equal(config.timeCount, 10);
  assert.deepEqual(config.dimensionSelectors, [
    {
      name: "feature",
      dimensionIndex: 1,
      size: 20,
      coordinatePath: "feature",
      scalePath: "feature_scale",
      offsetPath: "feature_offset",
      values: [],
      scales: [],
      offsets: [],
      selectedIndex: 0,
    },
  ]);
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

test("keeps a projected store's WKT definition for bounds conversion", () => {
  const wkt =
    'PROJCS["ETRS89-extended / LAEA Europe",GEOGCS["ETRS89",DATUM["European Terrestrial Reference System 1989",SPHEROID["GRS 1980",6378137,298.257222101]],PRIMEM["Greenwich",0],UNIT["degree",0.0174532925199433]],PROJECTION["Lambert_Azimuthal_Equal_Area"],PARAMETER["latitude_of_center",52],PARAMETER["longitude_of_center",10],PARAMETER["false_easting",4321000],PARAMETER["false_northing",3210000],UNIT["metre",1],AUTHORITY["EPSG","3035"]]';
  const config = configFromMetadata(
    {
      "retention/.zarray": { shape: [13, 2243, 2178] },
      "retention/.zattrs": {
        _ARRAY_DIMENSIONS: ["period", "y", "x"],
        grid_mapping: "spatial_ref",
      },
      "spatial_ref/.zarray": { shape: [] },
      "spatial_ref/.zattrs": { crs_wkt: wkt },
    },
    {}
  );

  assert.equal(config.crs, "EPSG:3035");
  assert.equal(config.proj4, wkt);
  assert.equal(config.timeDimension, "period");
  assert.equal(config.timeCount, 13);
});

test("detects a CRS coordinate referenced through the coordinates attribute", () => {
  const wkt =
    'PROJCRS["WGS 84 / UTM zone 51N",BASEGEOGCRS["WGS 84",ID["EPSG",4326]],ID["EPSG",32651]]';
  const config = configFromMetadata(
    {
      "ndvi/.zarray": { shape: [731, 642, 823] },
      "ndvi/.zattrs": {
        _ARRAY_DIMENSIONS: ["time", "y", "x"],
        coordinates: "spatial_ref",
      },
      "spatial_ref/.zarray": { shape: [] },
      "spatial_ref/.zattrs": { crs_wkt: wkt, spatial_ref: wkt },
      "x/.zarray": { shape: [823] },
      "x/.zattrs": { _ARRAY_DIMENSIONS: ["x"], units: "metre" },
      "y/.zarray": { shape: [642] },
      "y/.zattrs": { _ARRAY_DIMENSIONS: ["y"], units: "metre" },
    },
    {}
  );

  assert.equal(config.crs, "EPSG:32651");
  assert.equal(config.proj4, wkt);
});

test("falls back to CRS metadata declared by projected spatial axes", () => {
  const config = configFromMetadata(
    {
      "temperature/.zarray": { shape: [12, 20, 30] },
      "temperature/.zattrs": {
        _ARRAY_DIMENSIONS: ["time", "y", "x"],
      },
      "x/.zarray": { shape: [30] },
      "x/.zattrs": { _ARRAY_DIMENSIONS: ["x"], crs: "EPSG:32633" },
      "y/.zarray": { shape: [20] },
      "y/.zattrs": { _ARRAY_DIMENSIONS: ["y"], epsg: 32633 },
    },
    {}
  );

  assert.equal(config.crs, "EPSG:32633");
  assert.equal(config.proj4, undefined);
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

test("requires a CRS for generic projected spatial dimensions", () => {
  assert.equal(hasResolvableCrs({ xDimension: "x", yDimension: "y" }), false);
  assert.equal(
    hasResolvableCrs({ xDimension: "x", yDimension: "y", crs: "EPSG:32651" }),
    true
  );
  assert.equal(
    hasResolvableCrs({ xDimension: "longitude", yDimension: "latitude" }),
    true
  );
});

test("derives a finite display range while ignoring missing values", () => {
  assert.deepEqual(finiteRange([Number.NaN, 24.75, 52.91, Infinity]), [24.75, 52.91]);
  assert.equal(finiteRange([Number.NaN, Infinity]), null);
  assert.deepEqual(finiteRange([10, 10]), [9.5, 10.5]);
});

test("derives physical ranges from packed values and excludes fill values", () => {
  assert.deepEqual(
    finiteRange([-32768, -10_000, 5_000], {
      fillValue: -32768,
      scaleFactor: 0.0001,
    }),
    [-1, 0.5]
  );
  assert.deepEqual(
    finiteRange([0, 10], { scaleFactor: 0.5, addOffset: -2 }),
    [-2, 3]
  );
});

test("derives robust physical display ranges without extreme outliers", () => {
  assert.deepEqual(
    finitePercentileRange([0, 1, 2, 3, 4, 1000], {
      scaleFactor: 2,
      addOffset: 10,
      lower: 0.2,
      upper: 0.8,
    }),
    [12, 18]
  );
  assert.deepEqual(
    finitePercentileRange([-32768, 5, 5], { fillValue: -32768 }),
    [4.5, 5.5]
  );
});

test("discovers packed-value transforms for each variable", () => {
  const metadata = {
    "evi/.zarray": { shape: [728, 642, 823], fill_value: -32768 },
    "evi/.zattrs": {
      _ARRAY_DIMENSIONS: ["time", "y", "x"],
      scale_factor: 0.0001,
    },
    "mvi/.zarray": { shape: [728, 642, 823], fill_value: -32768 },
    "mvi/.zattrs": {
      _ARRAY_DIMENSIONS: ["time", "y", "x"],
      scale_factor: 0.001,
    },
  };

  const evi = configFromMetadata(metadata, { variable: "evi" });
  const mvi = configFromMetadata(metadata, { variable: "mvi" });
  assert.equal(evi.scaleFactor, 0.0001);
  assert.equal(evi.addOffset, 0);
  assert.equal(evi.nodata, -32768);
  assert.equal(mvi.scaleFactor, 0.001);
});

test("uses the physical NDVI range without scanning a data chunk", () => {
  const config = configFromMetadata(
    {
      "ndvi/.zarray": { shape: [728, 642, 823] },
      "ndvi/.zattrs": { _ARRAY_DIMENSIONS: ["time", "y", "x"] },
    },
    {}
  );
  assert.equal(config.hasSuggestedRange, true);
  assert.equal(config.palette, "ndvi");
  assert.deepEqual([config.climMin, config.climMax], [-1, 1]);
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

test("switches between dated observations and annual coordinates without leaking date units", () => {
  const metadata = {
    "time/.zattrs": { units: "days since 2016-01-14" },
    "year/.zattrs": {},
    "evi/.zarray": { shape: [727, 3, 3] },
    "evi/.zattrs": { _ARRAY_DIMENSIONS: ["time", "y", "x"] },
    "longest_gap_days/.zarray": { shape: [10, 3, 3] },
    "longest_gap_days/.zattrs": { _ARRAY_DIMENSIONS: ["year", "y", "x"] },
  };
  const observations = configFromMetadata(metadata, { variable: "evi" });
  assert.equal(observations.dateOrigin, "2016-01-14");
  const annual = configFromMetadata(metadata, {
    ...observations,
    variable: "longest_gap_days",
  });
  assert.equal(annual.timeDimension, "year");
  assert.equal(annual.dateOrigin, "");
  const axis = timeAxis({ ...annual, timeValuesText: "2016,2017,2025" });
  assert.deepEqual(axis.values, [2016, 2017, 2025]);
  assert.deepEqual(axis.labels, ["year 2016", "year 2017", "year 2025"]);
  const restored = configFromMetadata(metadata, { ...annual, variable: "evi" });
  assert.equal(restored.dateOrigin, "2016-01-14");
  assert.equal(restored.dateUnit, "days");
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
