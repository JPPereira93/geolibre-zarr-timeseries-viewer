import assert from "node:assert/strict";
import test from "node:test";

import { datasetIdentity } from "../src/dataset-context.js";

test("keeps separate identities for local Zarr folder selections", () => {
  assert.equal(
    datasetIdentity({ source: "local", localStoreId: "folder-a" }),
    "local:folder-a"
  );
  assert.notEqual(
    datasetIdentity({ source: "local", localStoreId: "folder-a" }),
    datasetIdentity({ source: "local", localStoreId: "folder-b" })
  );
});

test("normalizes equivalent remote Zarr store URLs", () => {
  assert.equal(
    datasetIdentity({
      source: "custom",
      url: "https://example.test/cube.zarr/.zmetadata",
    }),
    "remote:https://example.test/cube.zarr"
  );
});
