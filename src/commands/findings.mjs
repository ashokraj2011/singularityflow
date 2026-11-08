/**
 * `singularity-flow findings template|import` [CQF:REQ-060, REQ-062, REQ-070]: the security team's
 * and the TLM owners' lists, in SFlow's workbook format, and the register they go into.
 *
 * `template` writes an empty workbook with both sheets, their headers and one made-up example row
 * each. It never overwrites a file: a person names another --out. `import` reads a workbook or CSV
 * file into the register on the state branch (src/findings/register/); an invalid row is reported
 * and the rest import.
 */
import { lstat, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { optionBoolean, optionString, SingularityFlowError } from '../util.mjs';

const SUBCOMMANDS = Object.freeze(['template', 'import']);
const OPTIONS = Object.freeze({ template: ['out', 'json'], import: ['feed', 'source', 'dry-run', 'json'] });
export const DEFAULT_TEMPLATE_NAME = 'sflow-findings-template.xlsx';

function fail(message, code = 'FINDINGS_COMMAND_INVALID', details = null) {
  throw new SingularityFlowError(message, { code, details });
}

async function templateCommand(options) {
  const [{ writeXlsx }, { templateSheets, COLUMNS }] = await Promise.all([
    import('../findings/workbook/xlsx.mjs'), import('../findings/register/format.mjs')]);
  const out = path.resolve(optionString(options, 'out') ?? DEFAULT_TEMPLATE_NAME);
  if (!/\.xlsx$/iu.test(out)) fail(`Name the template file with .xlsx: ${out}`);
  if (await lstat(out).catch(() => null)) {
    fail(`${out} already exists; nothing was written. Name another file with --out FILE.`, 'FINDINGS_OUTPUT_EXISTS', { path: out });
  }
  const bytes = writeXlsx(templateSheets());
  await writeFile(out, bytes, { flag: 'wx' });
  return {
    schemaVersion: 1, resultType: 'sflow-findings-template', path: out, bytes: bytes.length,
    sheets: Object.entries(COLUMNS).map(([feed, columns]) => ({
      feed, sheet: feed === 'security' ? 'Security' : 'TLM',
      required: columns.filter((column) => column.required).map((column) => column.header),
      optional: columns.filter((column) => !column.required).map((column) => column.header)
    })),
    next: { command: `singularity-flow findings import ${JSON.stringify(out)}` }
  };
}

export async function findingsCommand(positionals, options = {}) {
  const subcommand = positionals[1];
  if (!SUBCOMMANDS.includes(subcommand)) {
    fail(`${subcommand ? `Unknown findings subcommand '${subcommand}'` : 'Name a findings subcommand'}. Supported: ${SUBCOMMANDS.join(', ')}.`, 'UNKNOWN_SUBCOMMAND',
      { command: 'findings', subcommand: subcommand ?? null, available: [...SUBCOMMANDS] });
  }
  const unknown = Object.keys(options).filter((key) => ![...OPTIONS[subcommand], 'timings'].includes(key)).sort();
  if (unknown.length) fail(`findings ${subcommand} does not accept ${unknown.map((key) => `--${key}`).join(', ')}.`);
  const operands = { template: 0, import: 1 }[subcommand];
  if (positionals.length > 2 + operands) fail(`findings ${subcommand} takes ${operands ? 'one operand' : 'no operand'}: ${positionals.slice(2 + operands).join(' ')}.`);
  if (subcommand === 'template') return templateCommand(options);
  const { repoRoot } = await import('../git-execution.mjs');
  const root = repoRoot(process.cwd());
  if (!positionals[2]) fail('Name the workbook or CSV file: singularity-flow findings import FILE [--feed security|tlm] [--source NAME].');
  const { importFindings } = await import('../findings/register/import.mjs');
  return importFindings(root, positionals[2], {
    feed: optionString(options, 'feed') ?? null, source: optionString(options, 'source') ?? null, dryRun: optionBoolean(options, 'dry-run')
  });
}

function printResult(result) {
  if (result.resultType === 'sflow-findings-template') {
    console.log(`Wrote the findings workbook template: ${result.path}`);
    for (const sheet of result.sheets) {
      console.log(`  ${sheet.sheet} sheet. Required: ${sheet.required.join(', ')}. Optional: ${sheet.optional.join(', ')}.`);
    }
    console.log('Each sheet has one made-up example row; replace it with your own rows.');
    console.log(`Import it with: ${result.next.command}`);
    return;
  }
  if (result.resultType === 'sflow-findings-import') {
    console.log(`${result.dryRun ? 'Would import' : 'Imported'} ${result.file.name} (${result.file.sha256.slice(0, 19)}…) from source ${result.source} as ${result.importId}.`);
    if (result.nothingImported) { console.log(result.message); return; }
    for (const [feed, counts] of Object.entries(result.feeds)) {
      console.log(`  ${feed === 'tlm' ? 'TLM' : 'Security'}: ${counts.imported} rows imported (${counts.added} new, ${counts.updated} updated, ${counts.unchanged} unchanged`
        + `${counts.reopened ? `, ${counts.reopened} open again` : ''}${counts.closed ? `, ${counts.closed} closed` : ''}), ${counts.rejected} rejected`
        + `${counts.notInLatest ? `; ${counts.notInLatest} no longer listed (kept, marked not in the latest import)` : ''}.`);
      if (counts.otherRepositories) console.log(`    ${counts.otherRepositories} of them name another repository; they are kept and listed with --all-repositories.`);
    }
    for (const row of result.rejected.slice(0, 20)) console.log(`  Rejected: ${row.sheet} row ${row.row}: ${row.reason}.`);
    if (result.rejected.length > 20) console.log(`  … and ${result.rejected.length - 20} more rejected rows (see --json).`);
    for (const sheet of result.ignoredSheets) console.log(`  Not read: sheet "${sheet.sheet}": ${sheet.reason}.`);
    for (const [feed, headers] of Object.entries(result.unknownHeaders)) console.log(`  ${feed === 'tlm' ? 'TLM' : 'Security'} headers not used: ${headers.map((header) => JSON.stringify(header)).join(', ')}.`);
    for (const warning of result.warnings) console.log(`  Warning: ${warning}`);
    console.log(result.dryRun ? `Nothing was written. ${result.storeMessage}` : `${result.storeMessage}${result.commit ? ` (${result.branch} ${result.commit.slice(0, 12)})` : ''}`);
  }
}

export async function run(_argv, { positionals, options = {} }) {
  const result = await findingsCommand(positionals, options);
  if (optionBoolean(options, 'json')) console.log(JSON.stringify(result, null, 2));
  else printResult(result);
  return result;
}
