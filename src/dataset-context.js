import { normalizeStoreUrl } from "./metadata.js";

export function datasetIdentity(config = {}, fallbackLocalId = "") {
  if (config.source === "local") {
    const id = String(config.localStoreId || fallbackLocalId).trim();
    return id ? `local:${id}` : "";
  }
  const url = String(config.url ?? "").trim();
  if (!url) return "";
  try {
    return `remote:${normalizeStoreUrl(url)}`;
  } catch {
    return `remote:${url}`;
  }
}
