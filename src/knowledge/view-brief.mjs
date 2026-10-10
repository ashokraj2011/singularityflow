/**
 * A registered World Model view, read for a phase brief.
 *
 * A published view file is evidence: a hash header, cited sentences, a facts JSON block and a kernel
 * stamp, kept byte for byte on the state branch for audit and replay. (It lives outside
 * src/world-model/ on purpose: files there are part of the World Model kernel identity.) A phase prompt needs only what
 * the sentences mean. This reads the committed view bytes and keeps the statements a reader can use,
 * with their file and line: declarations folded per type (accessors folded together), imports
 * folded per file, and every "unavailable" fact reduced to one entry for a single "Not known" line.
 * Lexical call guesses are left out. It is pure and deterministic, so a prompt receipt can bind the
 * view file and what was read from it, and a verifier can recompute both from the same bytes.
 */
import { createHash } from 'node:crypto';
import path from 'node:path';

export const VIEW_BRIEF_RENDERER = Object.freeze({ id: 'repository-brief-view', version: 1 });

const SECTION_FOR_VIEW = Object.freeze({
  'biz.rules': 'rules', 'arch.contracts': 'contracts', 'biz.flows': 'flows', 'dev.impact': 'impact', 'dev.hotspots': 'risks'
});

const DECLARATION = /^(\S+) declares (.+) at line (\d+)\.$/u;
const INTERFACE = /^(\S+) is explicitly declared as an interface contract in (\S+) at line (\d+)\.$/u;
const IMPORT = /^(\S+) imports the in-scope module (\S+)\.$/u;
const LEXICAL = /\bcontains a lexical (?:call|reference) candidate\b/u;
const NO_PRODUCER = /^No registered deterministic producer supplied (\S+) for /u;
const NO_BASELINE = /^The pinned source revision has no exact first-parent baseline; (\S+) extraction is unavailable\.$/u;
const MODIFIERS = /\b(?:public|private|protected|static|final|abstract|default|sealed|synchronized|native|transient|volatile)\s+/gu;

function facts(markdown) {
  const block = /^## Facts \{#[^}]+\}\s*```json\n([\s\S]*?)\n```/mu.exec(markdown);
  if (!block) return new Map();
  try {
    return new Map((JSON.parse(block[1]).facts ?? []).map((fact) => [fact.id, fact]));
  } catch {
    return new Map();
  }
}

function viewId(markdown) {
  const match = /^view:\s*([a-z][\w.-]*)@(\d+)\s*$/mu.exec(markdown);
  return match ? { id: match[1], version: Number(match[2]) } : { id: null, version: null };
}

/** The bullets of every section except the facts block, each with the fact ids it cites. */
function bullets(markdown) {
  const out = [];
  let section = null;
  for (const line of markdown.split(/\r?\n/u)) {
    const heading = /^## (.+?)(?: \{#([^}]+)\})?$/u.exec(line);
    if (heading) { section = /\.facts$/u.test(heading[2] ?? '') || heading[1] === 'Facts' ? null : heading[1]; continue; }
    if (/^---\s*$/u.test(line)) section = null;
    if (!section || !line.startsWith('- ')) continue;
    const cited = /\s*\[F:([^\]]+)\]\s*$/u.exec(line);
    out.push({
      section,
      text: (cited ? line.slice(2, cited.index) : line.slice(2)).trim(),
      factIds: cited ? cited[1].split(',').map((id) => id.trim()).filter(Boolean) : []
    });
  }
  return out;
}

function accessorName(signature) {
  const match = /\b(?:get|is|set)([A-Z]\w*)\s*\(/u.exec(signature);
  return match ? match[1][0].toLowerCase() + match[1].slice(1) : null;
}

/** `public Order place(@RequestBody Order order)` becomes `place(Order)`. */
function methodSummary(signature) {
  const match = /([A-Za-z_$][\w$]*)\s*\(([^)]*)\)/u.exec(signature);
  if (!match) return signature.replace(MODIFIERS, '').trim();
  const parameters = match[2].split(',').map((parameter) => parameter.replace(/@\w+(?:\([^)]*\))?\s*/gu, '').trim())
    .filter(Boolean).map((parameter) => parameter.split(/\s+/u).slice(0, -1).join(' ') || parameter);
  return `${match[1]}(${parameters.join(', ')})`;
}

function isTypeDeclaration(signature) {
  return /\b(?:class|interface|enum|record|struct|trait|object|type)\s+[A-Z]/u.test(signature);
}

function stem(file) {
  return path.posix.basename(file).replace(/\.[^.]+$/u, '');
}

/**
 * What a phase brief reads from one committed view file. `lines` keep their source; `notKnown`
 * names each kind of fact the view could not supply, for one closing line.
 */
export function projectRegisteredView(markdown) {
  const text = String(markdown ?? '');
  const { id, version } = viewId(text);
  const byId = facts(text);
  const notKnown = new Set();
  const baseline = new Set();
  const declarations = new Map();
  const imports = new Map();
  const lines = [];
  let lexical = 0;
  const seen = new Set();
  for (const bullet of bullets(text)) {
    const cited = bullet.factIds.map((factId) => byId.get(factId)).filter(Boolean);
    const unavailable = cited.length ? cited.every((fact) => fact.status === 'unavailable') : NO_PRODUCER.test(bullet.text) || NO_BASELINE.test(bullet.text);
    if (unavailable) {
      const base = NO_BASELINE.exec(bullet.text);
      if (base) { baseline.add(base[1]); continue; }
      const producer = NO_PRODUCER.exec(bullet.text);
      if (producer) { notKnown.add(producer[1]); continue; }
      for (const fact of cited) {
        const detail = String(fact.reason?.detail ?? '');
        notKnown.add(fact.reason?.code === 'NO_REGISTERED_PRODUCER' || NO_PRODUCER.test(detail)
          ? (NO_PRODUCER.exec(detail)?.[1] ?? fact.factType)
          : (detail || fact.factType || 'unavailable').replace(/\.$/u, ''));
      }
      continue;
    }
    if (LEXICAL.test(bullet.text)) { lexical += 1; continue; }
    const declaration = DECLARATION.exec(bullet.text);
    if (declaration) {
      const [, file, signature, line] = declaration;
      if (!declarations.has(file)) declarations.set(file, []);
      declarations.get(file).push({ signature, line: Number(line) });
      continue;
    }
    const contract = INTERFACE.exec(bullet.text);
    if (contract) {
      const key = `interface:${contract[1]}`;
      if (!seen.has(key)) { seen.add(key); lines.push({ text: `interface ${contract[1]}`, source: { path: contract[2], line: Number(contract[3]) } }); }
      continue;
    }
    const imported = IMPORT.exec(bullet.text);
    if (imported) {
      if (!imports.has(imported[1])) imports.set(imported[1], new Set());
      imports.get(imported[1]).add(stem(imported[2]));
      continue;
    }
    if (seen.has(bullet.text)) continue;
    seen.add(bullet.text);
    const located = /(\S+\.[A-Za-z0-9]+)(?: at)? line (\d+)/u.exec(bullet.text);
    lines.push({ text: bullet.text.replace(/\.$/u, ''), source: located ? { path: located[1], line: Number(located[2]) } : null });
  }
  for (const [file, entries] of [...declarations].sort(([a], [b]) => a.localeCompare(b, 'en'))) {
    entries.sort((a, b) => a.line - b.line);
    const types = entries.filter((entry) => isTypeDeclaration(entry.signature)).map((entry) => entry.signature.replace(MODIFIERS, '').trim());
    const members = entries.filter((entry) => !isTypeDeclaration(entry.signature));
    const accessors = [...new Set(members.map((entry) => accessorName(entry.signature)).filter(Boolean))];
    const methods = [...new Set(members.filter((entry) => !accessorName(entry.signature)).map((entry) => methodSummary(entry.signature)))];
    const parts = [
      ...(types.length ? [types.join('; ')] : []),
      ...(methods.length ? [`${methods.length === 1 ? 'method' : 'methods'} ${methods.join(', ')}`] : []),
      ...(accessors.length ? [`accessors for ${accessors.join(', ')}`] : [])
    ];
    lines.push({ text: `${stem(file)}: ${parts.join('; ')}`, source: { path: file, line: entries[0].line } });
  }
  for (const [file, modules] of [...imports].sort(([a], [b]) => a.localeCompare(b, 'en'))) {
    lines.push({ text: `${stem(file)} uses ${[...modules].sort().join(', ')}`, source: { path: file, line: null } });
  }
  if (baseline.size) notKnown.add('no first-parent baseline for change analysis');
  if (lexical) notKnown.add('calls are matched by name');
  return {
    renderer: VIEW_BRIEF_RENDERER,
    view: id, version, section: SECTION_FOR_VIEW[id] ?? 'overview',
    lines, notKnown: [...notKnown]
  };
}

/** The digest a prompt receipt records for what was read from one view file. */
export function viewProjectionDigest(projection) {
  const canonical = JSON.stringify({
    renderer: projection.renderer, view: projection.view, version: projection.version, section: projection.section,
    lines: projection.lines.map((line) => [line.text, line.source?.path ?? null, line.source?.line ?? null]),
    notKnown: projection.notKnown
  });
  return { sha256: createHash('sha256').update(canonical).digest('hex'), bytes: Buffer.byteLength(canonical) };
}
