/**
 * Reading source as *code*, for the tests that grep it.
 *
 * A recurring and quiet failure in this suite: a test asserts that some name does not appear in a
 * file, and the file legitimately mentions that name in a comment explaining why it does not use
 * it. The assertion fires, the code is correct, and the fix looks like weakening the test.
 *
 * It has happened three times in one change alone — the navigation opt-out check, a refusal-site
 * ratchet counting a call named in a docblock, and a planner list flagged by its own explanation of
 * what it excludes. In each case the *better* code is the one that documents its reasoning, so a
 * grep that punishes explanation is a grep that quietly discourages it.
 *
 * Roughly ten test files strip comments inline already, each with its own pair of regexes. This is
 * that, once.
 */

/**
 * Source with block and line comments removed.
 *
 * Deliberately not a parser. It is wrong inside a string literal containing `//` — a URL, say — and
 * that is an acceptable trade for a helper whose whole job is "does the *code* mention this?". A
 * test that needs to be right about string contents should not be grepping in the first place.
 */
export function codeOnly(source) {
  return String(source)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
}

/** How many times a name appears in the code, ignoring anything the file says about it. */
export function codeOccurrences(source, needle) {
  return codeOnly(source).split(needle).length - 1;
}
