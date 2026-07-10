export function normalizeOptionalIsoTimestamp(value: string | null | undefined) {
  if (!value) return undefined;
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return null;
  return new Date(parsed).toISOString();
}

export function isAtOrAfterIsoTimestamp(value: string, lowerBound?: string) {
  return !lowerBound || value >= lowerBound;
}
