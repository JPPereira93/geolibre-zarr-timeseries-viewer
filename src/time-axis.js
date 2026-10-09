export function axisLabels(axis, config) {
  const origin = Date.parse(config.dateOrigin);
  const unit =
    { milliseconds: 1, seconds: 1e3, minutes: 6e4, hours: 36e5, days: 864e5 }[
      config.dateUnit
    ] ?? 1;
  const formatter = new Intl.DateTimeFormat(void 0, {
    year: "numeric",
    month: "short",
    day: "2-digit",
    timeZone: "UTC",
  });
  return axis.map((value) => {
    const date = new Date(origin + value * unit);
    return Number.isFinite(origin) &&
      typeof value === "number" &&
      Number.isFinite(date.getTime())
      ? formatter.format(date)
      : `${config.timeDimension} ${value}`;
  });
}

export function timeAxis(config) {
  const tokens = String(config.timeValuesText ?? "")
    .split(/[\n,]+/)
    .map((item) => item.trim())
    .filter(Boolean);

  let values;
  if (tokens.length) {
    values = tokens.map((token) =>
      Number.isFinite(Number(token)) ? Number(token) : token
    );
  } else {
    const count = Number(config.timeCount);
    const start = Number(config.timeStart);
    const step = Number(config.timeStep);
    if (!Number.isSafeInteger(count) || count < 1)
      throw new Error("The time count must be a positive integer.");
    if (![start, step].every(Number.isFinite))
      throw new Error("The time start and step must be finite numbers.");
    values = Array.from({ length: count }, (_, index) => start + index * step);
  }

  if (
    !values.length ||
    values.some((item) => typeof item === "number" && !Number.isFinite(item))
  ) {
    throw new Error("The time axis must contain at least one valid coordinate.");
  }
  return { values, labels: axisLabels(values, config) };
}
