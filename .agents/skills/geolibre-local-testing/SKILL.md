---
name: geolibre-local-testing
description: Build, install, start, inspect, or stop a standalone GeoLibre plugin in a local unchanged GeoLibre web checkout. Use when the user asks to test, preview, run, or check a GeoLibre plugin locally.
---

# GeoLibre Local Testing

Use the bundled launcher for a repeatable local smoke test. It builds the
standalone plugin, copies its installable `geolibre-plugin/` contents into the
selected GeoLibre checkout, starts the web app, waits for it to respond, and
opens the browser.

Do not edit GeoLibre core as part of this workflow. Treat the copied plugin
directory inside GeoLibre as disposable test output; keep authored code in the
standalone plugin repository.

## Start

Locate the plugin root by finding both `package.json` and
`geolibre-plugin/plugin.json`. Then run:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File "<skill-dir>\scripts\geolibre_local_test.ps1" -Action Start -PluginRoot "<plugin-root>"
```

Pass `-GeoLibreRoot "<checkout-root>"` when the user names a checkout or
automatic discovery is ambiguous. Pass `-Port <port>` only when another port
is requested.

The helper uses `npm ci` only when `node_modules/` is absent, runs the plugin's
`build` script when present, installs the manifest ID into
`apps/geolibre-desktop/public/plugins/<plugin-id>`, starts GeoLibre, and prints
the URL and log paths. Report those details and give concise plugin-specific
smoke-test steps.

## Diagnose and stop

Use the same plugin root and optional port:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File "<skill-dir>\scripts\geolibre_local_test.ps1" -Action Status -PluginRoot "<plugin-root>"
powershell -NoProfile -ExecutionPolicy Bypass -File "<skill-dir>\scripts\geolibre_local_test.ps1" -Action Logs -PluginRoot "<plugin-root>"
powershell -NoProfile -ExecutionPolicy Bypass -File "<skill-dir>\scripts\geolibre_local_test.ps1" -Action Stop -PluginRoot "<plugin-root>"
```

When startup fails, inspect `Logs` before changing code. Distinguish plugin
build failures, missing GeoLibre dependencies, occupied ports, and runtime
browser errors. Do not claim the UI works solely because the server returned
HTTP 200; describe that as server readiness and ask the user to verify the
plugin's visible workflow when UI automation is unavailable.

