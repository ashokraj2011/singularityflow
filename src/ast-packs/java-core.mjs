/**
 * Java calls the JDK's compiler resolved: where JavaCallResolver.java looks for sources, and how its
 * answers are read. The semantic stage runs the resolver on the machine's own JDK, which attributes
 * the sources and names the declaration each call resolves to by path, name and the line of that
 * name; semantic-join.mjs joins those answers to the structural preview's declaration IDs.
 */
import path from 'node:path';

export const JAVA_SEMANTIC_PACK = Object.freeze({ id: 'sflow-java', packVersion: '1.0.0', extractorVersion: '1.0.0' });

// Directories that never hold a project's own source.
const SKIPPED_DIRECTORIES = new Set(['.git', 'node_modules', 'target', 'build', 'out', 'bin', '.gradle', '.idea', '.mvn', 'dist']);

/**
 * The source root of a file whose package is known: `src/main/java/com/acme/Cart.java` in
 * package `com.acme` lives under `src/main/java`. Null when the path does not end in the
 * package's directories (javac then cannot find its siblings by name anyway).
 */
export function javaSourceRoot(relativePath, packageName) {
  const directory = path.posix.dirname(relativePath);
  if (!packageName) return directory;
  const suffix = packageName.split('.').join('/');
  if (directory === suffix) return '.';
  return directory.endsWith(`/${suffix}`) ? directory.slice(0, -suffix.length - 1) : null;
}

/**
 * Conventional source roots below a directory (`<module>/src/<set>/java`), so a call into a class
 * outside the files of one request still resolves. The walk is bounded and reads names only.
 */
export async function conventionalJavaRoots(readdir, start = '.', { maxDepth = 8, maxDirectories = 20_000 } = {}) {
  const roots = [];
  const pending = [[start, 0]];
  let visited = 0;
  while (pending.length && visited < maxDirectories) {
    const [directory, depth] = pending.shift();
    visited += 1;
    let entries;
    try { entries = await readdir(directory, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      if (!entry.isDirectory() || SKIPPED_DIRECTORIES.has(entry.name) || entry.name.startsWith('.')) continue;
      const child = directory === '.' ? entry.name : `${directory}/${entry.name}`;
      if (entry.name === 'java' && path.posix.basename(path.posix.dirname(path.posix.dirname(child))) === 'src') roots.push(child);
      else if (depth < maxDepth) pending.push([child, depth + 1]);
    }
  }
  return roots.sort();
}

/**
 * Parse JavaCallResolver output into `{ type, caller, target, span }` edges, where type is
 * `calls` or `overrides` (caller is then the overriding method). Malformed lines are skipped.
 */
export function parseResolverOutput(text) {
  const edges = [];
  for (const line of String(text).split('\n')) {
    const fields = line.split('\t');
    if (!['call', 'override'].includes(fields[0]) || fields.length !== 11) continue;
    const numbers = [3, 6, 7, 8, 9, 10].map((index) => Number(fields[index]));
    if (numbers.some((value) => !Number.isInteger(value) || value < 1)) continue;
    const [callerLine, targetLine, startLine, startColumn, endLine, endColumn] = numbers;
    edges.push({
      type: fields[0] === 'call' ? 'calls' : 'overrides',
      caller: { path: fields[1], name: fields[2], line: callerLine },
      target: { path: fields[4], name: fields[5], line: targetLine },
      span: {
        startLine, startColumn, endLine,
        endColumn: endLine === startLine ? Math.max(startColumn, endColumn) : endColumn
      }
    });
  }
  return edges;
}
