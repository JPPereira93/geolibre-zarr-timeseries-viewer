function finiteValues(values) {
  return Array.from(values ?? [], (value) =>
    value === null || value === undefined ? NaN : Number(value)
  ).filter(Number.isFinite);
}

export function percentile(values, probability) {
  const sorted = finiteValues(values).sort((a, b) => a - b);
  if (!sorted.length) return null;
  const p = Math.max(0, Math.min(1, Number(probability)));
  const position = (sorted.length - 1) * p;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return sorted[lower];
  const weight = position - lower;
  return sorted[lower] * (1 - weight) + sorted[upper] * weight;
}

export function percentileRange(values, lower = 0.02, upper = 0.98) {
  const low = percentile(values, lower);
  const high = percentile(values, upper);
  if (low === null || high === null) return null;
  if (low !== high) return [low, high];
  const padding = Math.max(Math.abs(low) * 0.05, 1e-6);
  return [low - padding, high + padding];
}

export function pixelPlotLabels(config = {}, labels = []) {
  const variable = String(config.variable ?? "Value").trim() || "Value";
  const valueLabel = String(config.valueLabel ?? "").trim();
  const timeDimension = String(config.timeDimension ?? "time").trim() || "time";
  const usesDates =
    Boolean(String(config.dateOrigin ?? "").trim()) ||
    labels.some((label) => /^\d{4}-\d{2}-\d{2}/.test(String(label)));
  return {
    x: usesDates ? "Time" : timeDimension,
    y: valueLabel ? `${variable} (${valueLabel})` : variable,
  };
}

function compactNumber(value) {
  const absolute = Math.abs(value);
  if ((absolute > 0 && absolute < 0.001) || absolute >= 1e5)
    return value.toExponential(2);
  return Number(value.toPrecision(5)).toLocaleString();
}

function shorten(value, limit = 32) {
  const text = String(value ?? "");
  return text.length <= limit ? text : `${text.slice(0, limit - 1)}…`;
}

function canvasBlob(canvas) {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) =>
        blob
          ? resolve(blob)
          : reject(new Error("The browser could not create the PNG image.")),
      "image/png"
    );
  });
}

export async function exportPixelPlotPng({
  series,
  labels,
  config,
  point,
  filename,
}) {
  const range = percentileRange(series);
  if (!range) throw new Error("The selected pixel has no finite values to plot.");
  const [yMin, yMax] = range;
  const axis = pixelPlotLabels(config, labels);
  const width = 1600;
  const height = 900;
  const margin = { top: 145, right: 70, bottom: 155, left: 155 };
  const plotWidth = width - margin.left - margin.right;
  const plotHeight = height - margin.top - margin.bottom;
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Canvas rendering is unavailable.");

  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, width, height);
  context.fillStyle = "#111827";
  context.font = "600 38px system-ui, sans-serif";
  context.fillText(
    shorten(`${config.name || "Zarr time series"} — ${config.variable}`, 80),
    margin.left,
    58,
    plotWidth
  );
  context.fillStyle = "#4b5563";
  context.font = "24px system-ui, sans-serif";
  const coordinates = Array.isArray(point)
    ? `Pixel: ${point[1].toFixed(5)}° latitude, ${point[0].toFixed(5)}° longitude`
    : "Selected pixel";
  context.fillText(coordinates, margin.left, 100);

  context.lineWidth = 1;
  context.font = "20px system-ui, sans-serif";
  context.textAlign = "right";
  context.textBaseline = "middle";
  for (let index = 0; index <= 5; index += 1) {
    const ratio = index / 5;
    const y = margin.top + ratio * plotHeight;
    const value = yMax - ratio * (yMax - yMin);
    context.strokeStyle = "#e5e7eb";
    context.beginPath();
    context.moveTo(margin.left, y);
    context.lineTo(margin.left + plotWidth, y);
    context.stroke();
    context.fillStyle = "#374151";
    context.fillText(compactNumber(value), margin.left - 18, y);
  }

  const count = Math.max(series.length, labels.length, 1);
  const xTickCount = Math.min(6, count);
  context.textAlign = "right";
  context.textBaseline = "top";
  for (let tick = 0; tick < xTickCount; tick += 1) {
    const index =
      xTickCount === 1 ? 0 : Math.round((tick / (xTickCount - 1)) * (count - 1));
    const x = margin.left + (index / Math.max(1, count - 1)) * plotWidth;
    context.strokeStyle = "#9ca3af";
    context.beginPath();
    context.moveTo(x, margin.top + plotHeight);
    context.lineTo(x, margin.top + plotHeight + 9);
    context.stroke();
    context.save();
    context.translate(x + 4, margin.top + plotHeight + 18);
    context.rotate(-Math.PI / 6);
    context.fillStyle = "#374151";
    context.fillText(shorten(labels[index] ?? index + 1), 0, 0);
    context.restore();
  }

  context.strokeStyle = "#111827";
  context.lineWidth = 2;
  context.strokeRect(margin.left, margin.top, plotWidth, plotHeight);
  context.strokeStyle = "#2563eb";
  context.lineWidth = 3;
  context.lineJoin = "round";
  context.beginPath();
  let drawing = false;
  Array.from(series ?? []).forEach((raw, index) => {
    const value = Number(raw);
    if (!Number.isFinite(value)) {
      drawing = false;
      return;
    }
    const x = margin.left + (index / Math.max(1, count - 1)) * plotWidth;
    const clipped = Math.max(yMin, Math.min(yMax, value));
    const y = margin.top + ((yMax - clipped) / (yMax - yMin)) * plotHeight;
    if (drawing) context.lineTo(x, y);
    else context.moveTo(x, y);
    drawing = true;
  });
  context.stroke();

  context.fillStyle = "#111827";
  context.font = "600 24px system-ui, sans-serif";
  context.textAlign = "center";
  context.textBaseline = "alphabetic";
  context.fillText(axis.x, margin.left + plotWidth / 2, height - 70);
  context.save();
  context.translate(42, margin.top + plotHeight / 2);
  context.rotate(-Math.PI / 2);
  context.fillText(axis.y, 0, 0);
  context.restore();

  context.fillStyle = "#6b7280";
  context.font = "19px system-ui, sans-serif";
  context.textAlign = "right";
  context.fillText(
    `Y-axis clipped to the 2nd–98th percentiles (${compactNumber(
      yMin
    )} to ${compactNumber(yMax)})`,
    width - margin.right,
    height - 24
  );

  const blob = await canvasBlob(canvas);
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}
