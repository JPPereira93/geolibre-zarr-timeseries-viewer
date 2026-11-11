import test from "node:test";
import assert from "node:assert/strict";
import {
  percentile,
  percentileRange,
  pixelPlotLabels,
} from "../src/pixel-plot.js";

test("calculates interpolated percentiles while ignoring missing values", () => {
  assert.equal(percentile([null, NaN, 0, 10, 20, 30, 40], 0.5), 20);
  assert.equal(percentile([0, 10], 0.25), 2.5);
});

test("uses the 2nd and 98th percentiles for the plot range", () => {
  const values = Array.from({ length: 101 }, (_, index) => index);
  assert.deepEqual(percentileRange(values), [2, 98]);
});

test("adds padding for a constant pixel series", () => {
  const range = percentileRange([5, 5, 5]);
  assert.ok(range[0] < 5);
  assert.ok(range[1] > 5);
});

test("describes time and variable axes from dataset metadata", () => {
  assert.deepEqual(
    pixelPlotLabels(
      {
        variable: "temperature",
        valueLabel: "°C",
        timeDimension: "time",
        dateOrigin: "2020-01-01",
      },
      ["2020-01-01", "2020-01-02"]
    ),
    { x: "Time", y: "temperature (°C)" }
  );
  assert.deepEqual(
    pixelPlotLabels({ variable: "runoff", timeDimension: "month" }, [1, 2]),
    { x: "month", y: "runoff" }
  );
});
