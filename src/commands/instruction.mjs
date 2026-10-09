/** Instruction CRUD uses the same reviewed configuration transaction as skills and agents. */
import path from 'node:path';
import { SingularityFlowError } from '../util.mjs';
import { readInstructionText } from '../instruction-library.mjs';
import { emitCommandResult } from '../narration/emit.mjs';
import { action as nextAction, commandResult, effects, succeeded, noop } from '../narration/command-result.mjs';

export const INSTRUCTION_READS = Object.freeze(['list', 'show']);
export const INSTRUCTION_CHANGES = Object.freeze(['create', 'edit', 'remove']);
const AUTHORING = ['json', 'dry-run', 'propose', 'expected-authority-kind', 'expected-authority-commit',
  'expected-authority-remote-fingerprint', 'expected-authority-source-commit'];
export function validateInstructionRequest({ positionals, options }) {
  const action = positionals[1];
  if (![...INSTRUCTION_READS, ...INSTRUCTION_CHANGES].includes(action)
      || (action === 'list' ? positionals.length !== 2 : positionals.length !== 3 || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(positionals[2]))) {
    throw new SingularityFlowError('Use instruction list|show|create|edit|remove [ID]. IDs are lower-case kebab-case.', { code: 'INSTRUCTION_REQUEST_INVALID' });
  }
  const allowed = INSTRUCTION_READS.includes(action) ? ['json'] : [...AUTHORING,
    ...(['create', 'edit'].includes(action) ? ['label', 'description', 'instructions', 'from'] : [])];
  for (const [key, value] of Object.entries(options)) {
    if (!allowed.includes(key) || (['json', 'dry-run', 'propose'].includes(key) ? value !== true : typeof value !== 'string')) {
      throw new SingularityFlowError(`instruction ${action}: unsupported option --${key}.`, { code: 'INSTRUCTION_REQUEST_INVALID' });
    }
  }
  if (options.from !== undefined && options.instructions !== undefined) throw new SingularityFlowError('Use --from or --instructions, not both.', { code: 'INSTRUCTION_REQUEST_INVALID' });
  return action;
}

export async function run(argv, { positionals, options, applyChangeSet }) {
  const action = validateInstructionRequest({ positionals, options });
  if (INSTRUCTION_CHANGES.includes(action) && !applyChangeSet) return (await import('./legacy.mjs')).run(argv);
  const [{ repoRoot }, { withApprovedConfigurationRead }, { buildStudioModel, STUDIO_CHANGE_SET_SCHEMA }] = await Promise.all([
    import('../git.mjs'), import('../approved-configuration-reader.mjs'), import('../workflow-studio.mjs')
  ]);
  const root = repoRoot();
  if (INSTRUCTION_READS.includes(action)) {
    const model = await withApprovedConfigurationRead(root, () => buildStudioModel(root), { preferAuthority: true });
    const item = action === 'show' ? model.instructions.find(item => item.id === positionals[2]) : null;
    if (action === 'show' && !item) throw new SingularityFlowError(`Instruction '${positionals[2]}' does not exist. Run instruction list.`, { code: 'INSTRUCTION_UNKNOWN' });
    const result = action === 'show' ? { schemaVersion: 1, resultType: 'instruction', instruction: item }
      : { schemaVersion: 1, resultType: 'instruction-library', instructions: model.instructions, problems: model.instructionProblems };
    const text = item ? `${item.label} (${item.id})\n${item.path}\nUsed by skills: ${item.usedBy.join(', ') || 'none'}\n\n${item.instructions}`
      : model.instructions.map(item => `${item.label} (${item.id}) — ${item.description}`).join('\n') || 'No reusable instructions yet.';
    return emitCommandResult(commandResult({ operation: { id: `instruction.${action}`, classification: 'read' },
      outcome: succeeded('instruction.inspected', { text }), effects: effects(), restState: 'informational', data: result
    }), { json: Boolean(options.json), restStateWhenIdle: 'informational' });
  }
  const change = { op: `instruction.${action === 'edit' ? 'update' : action}`, id: positionals[2] };
  for (const key of ['label', 'description', 'instructions']) if (options[key] !== undefined) change[key] = options[key];
  if (options.from !== undefined) {
    change.instructions = await readInstructionText(path.resolve(options.from), '--from');
  }
  if (action === 'create' && (!change.description?.trim() || !change.instructions?.trim())) throw new SingularityFlowError('instruction create requires --description and --instructions or --from.', { code: 'INSTRUCTION_REQUEST_INVALID' });
  if (action === 'edit' && Object.keys(change).length === 2) throw new SingularityFlowError('Say which instruction fields to edit.', { code: 'INSTRUCTION_REQUEST_INVALID' });
  const result = await applyChangeSet(root, { schema: STUDIO_CHANGE_SET_SCHEMA, changes: [change] }, {
    subject: change.id, message: `[configuration] instruction ${action}: ${change.id}`
  });
  const preview = options['dry-run'] === true;
  return emitCommandResult(commandResult({ operation: { id: `instruction.${action}${preview ? '.preview' : ''}`, classification: preview ? 'read' : 'mutation' },
    outcome: (result.valid === false ? noop : succeeded)('instruction.changed', { action, status: result.reviewRequired ? 'proposal awaiting human review' : result.valid === false ? 'correction required' : preview ? 'preview only' : 'applied' }),
    effects: effects({ filesChanged: !preview && result.valid !== false && !result.reviewRequired && Boolean(result.files?.length), externalSystemsChanged: Boolean(result.reviewRequired) }),
    next: result.nextAction?.command ? [nextAction({ id: 'configuration-review', label: 'Review the exact configuration proposal.', command: result.nextAction.command })] : [],
    restState: 'informational', data: { result }
  }), { json: Boolean(options.json), restStateWhenIdle: 'informational' });
}
