/**
 * Line numbers for byte offsets into one text, computed once for the text rather than once per
 * offset.
 *
 * Six modules had grown the same three-line helper:
 *
 *     function line(text, index) { return text.slice(0, index).split('\n').length; }
 *
 * which copies the file up to the offset and splits it, for every offset asked. Called once per
 * regex match, the cost is symbols × file bytes — quadratic in the size of the file, on the
 * repository-facts and AST extraction paths that run over every source file in a world-model build.
 * `MAX_SCAN_BYTES` caps a file at 512 KB, so a single dense one can do a couple of hundred megabytes
 * of copying to answer questions about itself.
 *
 * Building the line starts is one pass; each lookup is then a binary search. The exported shape is a
 * factory rather than a `line(text, offset)` function on purpose: the saving is entirely in hoisting
 * the scan out of the loop, and a signature that takes the text every time invites putting it back.
 */

/**
 * A 1-indexed line lookup for `text` — what an editor and a citation both mean by "line".
 *
 * Offsets outside the text are clamped rather than rejected: every caller is reporting the position
 * of something it already found in this string, so an out-of-range offset is a bug in the caller and
 * a thrown error here would turn a wrong citation into a failed build.
 */
export function lineNumbers(text) {
  const starts = [0];
  for (let index = text.indexOf('\n'); index >= 0; index = text.indexOf('\n', index + 1)) {
    starts.push(index + 1);
  }
  return (offset) => {
    let low = 0;
    let high = starts.length - 1;
    while (low < high) {
      const middle = (low + high + 1) >> 1;
      if (starts[middle] <= offset) low = middle;
      else high = middle - 1;
    }
    return low + 1;
  };
}
