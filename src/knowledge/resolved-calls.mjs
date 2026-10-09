/**
 * Calls a compiler resolved, read from the AST intelligence layer.
 *
 * The analysis engine matches calls by name when nothing better is available. When a semantic
 * pack is warmed for the repository (the bundled TypeScript pack, or an installed one such as
 * JDT or Pyright), the AST layer holds `calls` relationships at semantic assurance: each names
 * the declaration it is in and the declaration it resolves to. Knowledge uses those edges and
 * keeps name matching only for what they do not cover.
 *
 * The AST layer reads the checkout; knowledge reads the commit. A file whose checkout bytes differ
 * from the commit contributes no resolved calls, so an edge never describes code the build did
 * not read. Nothing here fails a build: without the AST layer the list is simply empty.
 */
import { createHash } from 'node:crypto';

function digest(value) {
  return createHash('sha256').update(value).digest('hex');
}

/**
 * Read resolved call edges for the source's committed files. Returns `{ status, calls, digest,
 * providers }`; each call is `{ from: {path, name, line}, to: {path, name, line}, site }`.
 *
 * Nothing is read until a semantic project under the source's roots has been warmed: before that
 * the AST layer has no resolved calls to give, and parsing the repository would only cost time.
 * The read is one in-process build of the same files (cached skeletons are reused), not a paged
 * CLI read, because knowledge needs every fact at once.
 */
export async function readResolvedCalls(root, source) {
  const empty = (status) => ({ status, calls: [], digest: null, providers: [] });
  if (!source.files?.length) return empty('no-files');
  const committed = new Map(source.files.map((file) => [file.path, file.sha256]));
  let facts;
  try {
    const { buildAstCache } = await import('../ast-intelligence.mjs');
    const { discoverProjectBindings } = await import('../ast-project-binding.mjs');
    const projects = await discoverProjectBindings(root, { paths: source.area ? source.roots : null });
    if (!projects.bindings.some((binding) => binding.complete === true)) return empty('not-warmed');
    // The read selects every tracked file under the same roots, documentation included, so its
    // budget is sized from what knowledge read rather than the interactive default of 500 files.
    const tracked = source.files.length + (source.manifests?.length ?? 0);
    const result = await buildAstCache(root, {
      ...(source.area ? { paths: source.roots.join(',') } : { all: true }),
      'max-files': String(Math.max(500, 2 * tracked)),
      'max-bytes': String(Math.max(20 * 1024 * 1024, 2 * (source.bytes ?? 0)))
    });
    if (result.status === 'disabled') return empty('ast-disabled');
    facts = result.facts ?? [];
  } catch {
    return empty('unavailable');
  }
  const current = new Set(facts.filter((fact) => fact.kind === 'file' && committed.get(fact.path) === fact.sha256).map((fact) => fact.path));
  const symbols = new Map(facts.filter((fact) => fact.kind === 'symbol' && fact.id).map((fact) => [fact.id, fact]));
  const providers = new Set();
  const calls = [];
  for (const fact of facts) {
    if (fact.kind !== 'relationship' || fact.type !== 'calls' || fact.assurance !== 'semantic') continue;
    const from = symbols.get(fact.sourceId);
    const to = symbols.get(fact.target);
    if (!from || !to || !current.has(from.path) || !current.has(to.path)) continue;
    providers.add(fact.extractor?.id ?? 'semantic');
    calls.push({
      from: { path: from.path, name: from.name, line: from.span?.startLine ?? from.line },
      to: { path: to.path, name: to.name, line: to.span?.startLine ?? to.line },
      site: fact.span?.startLine ?? null
    });
  }
  calls.sort((a, b) => `${a.from.path}:${a.from.line}:${a.to.path}:${a.to.line}:${a.site}`
    .localeCompare(`${b.from.path}:${b.from.line}:${b.to.path}:${b.to.line}:${b.site}`, 'en'));
  return {
    status: calls.length ? 'resolved' : 'none',
    calls,
    digest: calls.length ? digest(JSON.stringify(calls)) : null,
    providers: [...providers].sort()
  };
}
