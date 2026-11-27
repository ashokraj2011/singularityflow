export function formatReading(value, unit) {
  if (value === null) return '-';
  return `${value.toFixed(2)} ${unit}`;
}
