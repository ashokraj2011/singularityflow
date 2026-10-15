/** Repository-independent tagged authoring. Compilation never publishes or approves. */
import { constants } from 'node:fs';
import { lstat, open, readFile } from 'node:fs/promises';
import { TextDecoder } from 'node:util';
import { WORKFLOW_MARKUP_LIMITS, markupError } from '../workflow-markup-parser.mjs';
import { safeCommandGuidance } from '../safe-command-guidance.mjs';

async function capture(file) {
  let bytes;
  if (file === '-') {
    const chunks = []; let total = 0;
    for await (const chunk of process.stdin) {
      total += chunk.length;
      if (total > WORKFLOW_MARKUP_LIMITS.bytes) markupError('Markup exceeds 256 KiB.', null, 'WORKFLOW_MARKUP_LIMIT');
      chunks.push(chunk);
    }
    bytes = Buffer.concat(chunks);
  } else {
    let handle;
    try {
      const selected = await lstat(file, { bigint: true });
      if (!selected.isFile() || selected.size > BigInt(WORKFLOW_MARKUP_LIMITS.bytes)) markupError('Select one bounded regular markup file, not a link or directory.');
      handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
      const before = await handle.stat({ bigint: true });
      if (!before.isFile() || before.dev !== selected.dev || before.ino !== selected.ino || before.size !== selected.size) markupError('Markup file selection changed.');
      const buffer = Buffer.alloc(WORKFLOW_MARKUP_LIMITS.bytes + 1); let length = 0;
      while (length < buffer.length) { const { bytesRead } = await handle.read(buffer, length, buffer.length - length, null); if (!bytesRead) break; length += bytesRead; }
      const after = await handle.stat({ bigint: true });
      if (length > WORKFLOW_MARKUP_LIMITS.bytes || before.size !== after.size || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs) markupError('Markup changed or exceeded its budget while being captured.');
      bytes = buffer.subarray(0, length);
    } catch (error) {
      if (error.code?.startsWith('WORKFLOW_MARKUP_')) throw error;
      markupError('The selected markup file could not be read.', null, 'WORKFLOW_MARKUP_UNAVAILABLE');
    } finally { await handle?.close(); }
  }
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch { markupError('Markup must be valid UTF-8.'); }
}

export async function run(argv, { positionals, options }) {
  const action = positionals[2];
  if (!['example', 'compile'].includes(action) || positionals.length !== (action === 'compile' ? 4 : 3)) markupError('Use workflow markup example, or workflow markup compile <FILE|-> [--out BUNDLE.json] [--json].');
  for (const [key, value] of Object.entries(options)) {
    if (key === 'json' ? value !== true : key === 'out' && action === 'compile' ? typeof value !== 'string' || !value.trim() : true) markupError('Unsupported or repeated markup command option.');
  }
  if (action === 'example') {
    const source = await readFile(new URL('../../examples/demo-tagged-workflow.xml', import.meta.url), 'utf8');
    const commandGuidance = safeCommandGuidance({ executable: 'singularity-flow', argv: ['workflow', 'markup', 'compile', '<FILE>', '--out', '<BUNDLE.json>', '--json'] });
    return console.log(options.json ? JSON.stringify({ schemaVersion: 1, resultType: 'workflow-markup-example', source, commandGuidance }) : source);
  }
  const { compileWorkflowMarkup } = await import('../workflow-markup.mjs');
  const result = await compileWorkflowMarkup(await capture(positionals[3]), { out: options.out ?? null });
  result.commandGuidance = safeCommandGuidance({ executable: 'singularity-flow', argv: result.outputPath
    ? ['workflow', 'import', result.outputPath, '--dry-run', '--propose', '--json']
    : ['workflow', 'markup', 'compile', positionals[3] === '-' ? '<FILE>' : positionals[3], '--out', '<BUNDLE.json>', '--json'] });
  if (options.json) return console.log(JSON.stringify(result, null, 2));
  console.log(`Portable workflow ready: ${result.workflow.label} (${result.workflow.id})`);
  console.log(`${result.workflow.phases.length} phases; ${result.workflow.decisions.length} decisions. Native route simulation: ${result.routeSimulation.status}.`);
  if (result.outputPath) console.log(`Bundle: ${result.outputPath}`);
  console.log(result.meaning);
  if (result.commandGuidance) {
    console.log(`Copilot: ${result.commandGuidance.copilotCommand ?? 'no verified equivalent'}`);
    console.log(`Shell: ${result.commandGuidance.command}`);
    console.log(`VS Code (model-free): ${result.commandGuidance.modelFreeCommand ?? 'not available for this action'}`);
  }
}
