/** Pure, bounded draft suggestions. Never rewrite an approved plan or attest visual correctness. */
import { createHash } from 'node:crypto';
import path from 'node:path';

import { authoredArtifactText } from './publication-preflight.mjs';
import { derivePlannedClaimMap, plannedClaimSource } from './specifications.mjs';
import { proseVerificationDeclarations } from './verification/contracts.mjs';

const MAX_BYTES = 512 * 1024;
const MAX_DECLARATIONS = 64;
const digest = text => createHash('sha256').update(text).digest('hex');
const row = cells => `| ${cells.join(' | ')} |`;
const cells = line => line.trim().startsWith('|') && line.trim().endsWith('|')
  ? line.trim().slice(1, -1).split('|').map(value => value.trim()) : null;
const unwrap = value => value.replace(/^[`\[]|[`\]]$/gu, '').trim().toUpperCase();

function tables(lines, prefix) {
  const result = [];
  for (let index = 0; index < lines.length; index += 1) {
    const header = cells(lines[index]);
    if (!header || header.slice(0, prefix.length).map(value => value.toLowerCase()).join('|') !== prefix.join('|')) continue;
    const divider = cells(lines[index + 1] ?? '');
    if (!divider || divider.length !== header.length || !divider.every(value => /^:?-{3,}:?$/u.test(value))) continue;
    const start = index;
    const rows = [];
    for (index += 2; index < lines.length; index += 1) {
      const values = cells(lines[index]);
      if (!values) break;
      rows.push(values);
    }
    result.push({ start, end: index, header, rows });
    index -= 1;
  }
  return result;
}

function evidencePath(value, evidenceRoot) {
  return value.startsWith(`${evidenceRoot}/`) && value === path.posix.normalize(value)
    && !/[\\:*?"<>|\x00-\x1f\x7f`$\[\]{}]/u.test(value)
    && value.split('/').every(part => part && part !== '.' && part !== '..'
      && !/[. ]$/u.test(part) && !/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(part));
}

/**
 * Project only an explicit, unambiguous primary visual/inspection declaration for an indexed AC.
 * The author must still check its meaning against the approved criterion. Existing explicit
 * witness contracts are never replaced or weakened. Every proposed document is re-parsed by the
 * publication validator; exact before/after patches carry authored-byte hashes, not new authority.
 */
export function planningEvidenceRepair(markdown, { clauseIds = [], evidenceRoot, policy = {} } = {}) {
  const original = String(markdown ?? '');
  const sourceSha256 = digest(original);
  const base = { sourceSha256, mutates: false, evidenceAccepted: false, testsWaived: false,
    requiresSemanticVerification: true };
  const review = reason => ({ ...base, status: 'author-review', patches: [], reason });
  if (Buffer.byteLength(original) > MAX_BYTES) return review('Plan exceeds the bounded evidence-repair limit.');
  if (!evidenceRoot || !evidencePath(`${evidenceRoot}/witness`, evidenceRoot)
      || evidenceRoot.startsWith('/') || evidenceRoot !== path.posix.normalize(evidenceRoot)) return review('An exact current-Story evidence root is required.');
  const authored = authoredArtifactText(original);
  const visible = plannedClaimSource(authored);
  const declarations = proseVerificationDeclarations(visible);
  if (!declarations.length) return null;
  if (declarations.length > MAX_DECLARATIONS) return review('Too many evidence declarations for bounded repair.');
  const lines = authored.split(/\r?\n/u);
  const visibleLines = visible.split(/\r?\n/u);
  const newline = authored.includes('\r\n') ? '\r\n' : '\n';
  const known = new Set(clauseIds.map(value => String(value).toUpperCase()));
  const planned = tables(visibleLines, ['clause', 'expected paths', 'planned tests']);
  const contractTables = tables(visibleLines, ['criterion', 'slot', 'method', 'witness']);
  const headings = visibleLines.flatMap((line, index) => /^#{1,6}\s+Verification contracts\s*$/iu.test(line) ? [index] : []);
  if (headings.length > 1 || contractTables.length > 1
      || contractTables.some(table => !headings.some(index => index < table.start
        && !visibleLines.slice(index + 1, table.start).some(line => /^#{1,6}\s/u.test(line))))) {
    return review('Review duplicate or misplaced verification-contract tables; no witness policy was changed.');
  }
  const targets = [];
  for (const declaration of declarations) {
    if (declaration.clauseIds.length !== 1 || !known.has(declaration.clauseIds[0])) return review('Each evidence declaration must bind exactly one approved acceptance criterion.');
    const clauseId = declaration.clauseIds[0];
    if (targets.some(target => target.clauseId === clauseId)) return review('Multiple declarations for one criterion need author reconciliation.');
    const start = declaration.line - 1;
    let end = start + 1;
    while (end < visibleLines.length && !/^#{1,6}\s/u.test(visibleLines[end])
      && !declarations.some(other => other.line - 1 === end)) end += 1;
    const section = visibleLines.slice(start, end).join('\n');
    const ids = [...section.matchAll(/\b([A-Z0-9][A-Z0-9._-]{0,63}:AC-\d{3})\b/giu)].map(match => match[1].toUpperCase());
    const paths = [...new Set([...section.matchAll(/`([^`\n]+)`/gu)].map(match => match[1])
      .filter(value => value.startsWith(`${evidenceRoot}/`)))];
    if (ids.some(id => id !== clauseId) || paths.length !== 1 || !evidencePath(paths[0], evidenceRoot)) return review(`${clauseId} needs one unambiguous exact retained path; do not guess from screenshots or filenames.`);
    const matches = planned.flatMap(table => table.rows.flatMap((values, index) => unwrap(values[0]) === clauseId ? [{ table, values, index }] : []));
    if (matches.length !== 1 || matches[0].values.length !== matches[0].table.header.length) return review(`${clauseId} needs exactly one well-formed planned-evidence row.`);
    if (contractTables.some(table => table.rows.some(values => unwrap(values[0]) === clauseId))) return review(`${clauseId} already has an explicit witness contract. Reconcile it without replacing primary tests, assurance or combinations.`);
    targets.push({ clauseId, path: paths[0], method: declaration.method, ...matches[0] });
  }
  const replacements = [];
  for (const table of planned.filter(table => targets.some(target => target.table === table))) {
    const header = [...table.header];
    let fulfillment = header.findIndex(value => value.toLowerCase() === 'fulfillment');
    if (fulfillment < 0) { fulfillment = header.length; header.push('Fulfillment'); }
    const rows = table.rows.map((values, index) => {
      const changed = [...values];
      if (header.length > table.header.length) changed.push('-');
      const target = targets.find(entry => entry.table === table && entry.index === index);
      if (target) { changed[1] = `\`${target.path}\``; changed[fulfillment] = 'evidence'; }
      return changed;
    });
    replacements.push({ start: table.start, end: table.end,
      before: lines.slice(table.start, table.end).join(newline),
      after: [row(header), row(header.map(() => '---')), ...rows.map(row)].join(newline) });
  }
  const contractTable = contractTables[0];
  if (contractTable?.rows.some(values => values.length !== contractTable.header.length)) return review('Repair the malformed verification-contract rows first; no witness policy was changed.');
  const header = contractTable ? [...contractTable.header] : ['Criterion', 'Slot', 'Method', 'Witness', 'Role', 'Required assurance'];
  if (!header.some(value => value.toLowerCase() === 'role')) header.push('Role');
  if (!header.some(value => value.toLowerCase() === 'required assurance')) header.push('Required assurance');
  const contractRows = (contractTable?.rows ?? []).map(values => [...values, ...Array(header.length - values.length).fill('')]);
  for (const target of targets) {
    const values = { criterion: `\`${target.clauseId}\``, slot: 'retained-evidence', method: target.method,
      witness: `\`${target.path}\``, role: 'primary', 'required assurance': 'source-bound' };
    contractRows.push(header.map(name => values[name.toLowerCase()] ?? ''));
    const tests = [...target.values[2].matchAll(/`([^`\n]+)`/gu)].map(match => match[1]);
    for (const [index, test] of tests.entries()) {
      const supporting = { criterion: values.criterion, slot: `supporting-test-${index + 1}`, method: 'test',
        witness: `\`${test}\``, role: 'supporting' };
      contractRows.push(header.map(name => supporting[name.toLowerCase()] ?? ''));
    }
  }
  const rendered = [row(header), row(header.map(() => '---')), ...contractRows.map(row)].join(newline);
  if (contractTable) replacements.push({ start: contractTable.start, end: contractTable.end,
    before: lines.slice(contractTable.start, contractTable.end).join(newline), after: rendered });
  else if (headings.length) replacements.push({ start: headings[0], end: headings[0] + 1,
    before: lines[headings[0]], after: `${lines[headings[0]]}${newline}${newline}${rendered}` });
  else replacements.push({ start: lines.length, end: lines.length, before: '',
    after: `${newline}## Verification contracts${newline}${newline}${rendered}${newline}` });
  const patches = replacements.filter(entry => entry.before !== entry.after).map(({ before, after }) => ({
    kind: before ? 'replace-exact' : 'append', before, after
  }));
  let candidate = authored;
  for (const patch of patches) {
    if (patch.before && original.indexOf(patch.before) !== original.lastIndexOf(patch.before)) return review('Patch anchor also occurs outside the author-owned draft; inspect it manually.');
    if (patch.before && (candidate.indexOf(patch.before) < 0 || candidate.indexOf(patch.before) !== candidate.lastIndexOf(patch.before))) return review('Patch anchor is not unique; inspect the author-owned table manually.');
    candidate = patch.before ? candidate.replace(patch.before, () => patch.after) : candidate + patch.after;
  }
  try {
    const result = derivePlannedClaimMap(candidate, { clauseIds, evidenceRoot, policy });
    if (result.missingClauseIds.length || result.missingTestClauseIds.length) return review('Complete the remaining clause/test allocations before applying an evidence repair.');
  } catch (error) {
    return review(`The proposed plan still needs author correction: ${error.message}`);
  }
  if (Buffer.byteLength(JSON.stringify(patches)) > MAX_BYTES) return review('Repair patches exceed the bounded output limit.');
  return { ...base, status: 'producer-repair', authoredSourceSha256: digest(authored),
    proposedAuthoredSha256: digest(candidate), targets: targets.map(({ clauseId, path, method }) => ({ clauseId, path, method })),
    patches, guidance: 'Verify these exact draft changes against the approved criteria, then apply only to the owned open artifact and rerun prepublish. Preserve planned tests, other clauses and managed inputs. File presence is not a visual pass; publication, tests, witness review and approval still apply.' };
}
