/** Locale-independent ordering for every SGOS hash, ready set, and projection. */
export function compareSgosCodePoints(left, right) {
  const a = Array.from(String(left));
  const b = Array.from(String(right));
  const length = Math.min(a.length, b.length);
  for (let index = 0; index < length; index += 1) {
    const leftPoint = a[index].codePointAt(0);
    const rightPoint = b[index].codePointAt(0);
    if (leftPoint !== rightPoint) return leftPoint < rightPoint ? -1 : 1;
  }
  return a.length < b.length ? -1 : a.length > b.length ? 1 : 0;
}
