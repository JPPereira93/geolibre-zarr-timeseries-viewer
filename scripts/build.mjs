import { build } from "esbuild";
import { copyFile, mkdir } from "node:fs/promises";

await mkdir("geolibre-plugin", { recursive: true });
await build({
  entryPoints: ["src/viewer.js"],
  bundle: true,
  format: "esm",
  platform: "browser",
  target: ["es2022"],
  supported: { "template-literal": false },
  minify: true,
  outfile: "geolibre-plugin/viewer.js",
  legalComments: "none",
});
await copyFile(
  "node_modules/geolibre-wasm/geolibre_wasm_bg.wasm",
  "geolibre-plugin/geolibre_wasm_bg.wasm",
);
