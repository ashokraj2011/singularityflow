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
 * Deliberately not a parser, but quoted single-line strings are stepped over: a glob such as
 * `'refs/**' + '/*'` written as one literal, or `'A trailing /** is optional.'`, otherwise opens a
 * block comment that runs to the next `*\/` and silently deletes tens of kilobytes of real code.
 * Template literals and regular-expression literals are still read as code.
 */
export function codeOnly(source) {
  return String(source).replace(
    /'(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"|\/\*[\s\S]*?\*\/|^[ \t]*\/\/.*$/gm,
    (match) => match.startsWith('/*') || /^[ \t]*\/\//.test(match) ? '' : match
  );
}

/** How many times a name appears in the code, ignoring anything the file says about it. */
export function codeOccurrences(source, needle) {
  return codeOnly(source).split(needle).length - 1;
}
