const DURATION_PARTS =
  /^(?:(\d+(?:\.\d+)?)\s*h(?:ours?)?)?\s*(?:(\d+(?:\.\d+)?)\s*m(?:in(?:utes?)?)?)?\s*(?:(\d+(?:\.\d+)?)\s*s(?:ec(?:onds?)?)?)?$/i;

/** Convert a provider's structured duration hint to milliseconds. */
export function parseDurationHint(value: unknown): number | undefined {
  if (typeof value === 'number')
    return Number.isFinite(value) && value > 0 ? Math.round(value * 1000) : undefined;
  if (typeof value !== 'string' || !value.trim()) return undefined;

  const input = value.trim();
  if (/^\d+(?:\.\d+)?$/.test(input)) {
    const seconds = Number(input);
    return Number.isFinite(seconds) && seconds > 0
      ? Math.round(seconds * 1000)
      : undefined;
  }
  const match = DURATION_PARTS.exec(input);
  if (!match || !match[0]) return undefined;
  const hours = Number(match[1] ?? 0);
  const minutes = Number(match[2] ?? 0);
  const seconds = Number(match[3] ?? 0);
  if (![hours, minutes, seconds].every(Number.isFinite)) return undefined;
  const milliseconds = Math.round((hours * 3600 + minutes * 60 + seconds) * 1000);
  return milliseconds > 0 ? milliseconds : undefined;
}
