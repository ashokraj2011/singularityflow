/** No-growth ceiling at main@7377e3d8, not the obsolete review's 17,917-line estimate. */
export const SOURCE_LINE_BUDGETS = Object.freeze({ 'src/cli.mjs': 18838 });

export function sourceSizeFailures(relative, source) {
  const ceiling = SOURCE_LINE_BUDGETS[relative.replaceAll('\\', '/')];
  if (ceiling == null) return [];
  const lines = source.split('\n').length - (source.endsWith('\n') ? 1 : 0);
  return lines > ceiling ? [`${relative} has ${lines} lines (ceiling ${ceiling}). Extract command logic into src/commands; do not silently raise the baseline.`] : [];
}
