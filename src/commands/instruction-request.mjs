/** Pure instruction argv contract, evaluated before repository routing. */
import { SingularityFlowError } from '../util.mjs';
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
