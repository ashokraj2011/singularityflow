/**
 * `singularity-flow findings template` [CQF:REQ-060, REQ-070]: the security team's and the TLM
 * owners' workbook, in SFlow's format.
 *
 * `template` writes an empty workbook with both sheets, their headers and one made-up example row
 * each. It never overwrites a file: a person names another --out.
 */
import { lstat, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { optionBoolean, optionString, SingularityFlowError } from '../util.mjs';

const SUBCOMMANDS = Object.freeze(['template']);
const OPTIONS = Object.freeze({ template: ['out', 'json'] });
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
  if (positionals.length > 2) fail(`findings ${subcommand} takes no operand: ${positionals.slice(2).join(' ')}.`);
  return templateCommand(options);
}

function printResult(result) {
  if (result.resultType === 'sflow-findings-template') {
    console.log(`Wrote the findings workbook template: ${result.path}`);
    for (const sheet of result.sheets) {
      console.log(`  ${sheet.sheet} sheet. Required: ${sheet.required.join(', ')}. Optional: ${sheet.optional.join(', ')}.`);
    }
    console.log('Each sheet has one made-up example row; replace it with your own rows.');
    console.log(`Import it with: ${result.next.command}`);
  }
}

export async function run(_argv, { positionals, options = {} }) {
  const result = await findingsCommand(positionals, options);
  if (optionBoolean(options, 'json')) console.log(JSON.stringify(result, null, 2));
  else printResult(result);
  return result;
}
