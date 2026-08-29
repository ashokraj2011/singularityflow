/**
 * Narration migration ratchet.
 *
 * Every public command is deliberately classified. Adding a command without deciding whether it
 * emits a CommandResult fails the deterministic check. `legacy` is debt, not a silent default.
 */
import { COMMAND_REGISTRY } from '../command-registry.mjs';
import { SingularityFlowError } from '../util.mjs';

export const MIGRATED_NARRATION_COMMANDS = Object.freeze([
  'adhoc', 'agent', 'approvals', 'approve', 'auto', 'clarification', 'constitution', 'converge', 'explain', 'land', 'local-reset', 'prepare', 'quickstart', 'reject', 'secrets',
  'context', 'copilot', 'fault', 'fix', 'goal', 'help-metrics', 'implement', 'intent', 'journal', 'plan', 'process', 'program', 'push', 'receipt', 'recommend', 'reinstall', 'repair', 'request', 'resume', 'return', 'specify', 'start', 'submit', 'task', 'tokens', 'verify'
]);

export const LEGACY_NARRATION_COMMANDS = Object.freeze([
  'about', 'action', 'agents', 'artifact', 'assign', 'bootstrap', 'cancel',
  'capabilities', 'capability', 'choices', 'configuration', 'doctor', 'home',
  'documents', 'epic', 'factory-reset', 'finalize', 'fresh-install', 'gate', 'guide',
  'harness', 'help', 'hook', 'impact', 'inbox', 'init', 'initiative', 'inputs', 'jira',
  'knowledge', 'ledger', 'logs', 'mcp', 'next', 'nextsteps', 'phase', 'plugin', 'pr',
  'progress', 'prompt-log', 'recover', 'refresh-branch', 'regression',
  'reopen', 'report', 'reset-all', 'review', 'run', 'session', 'show', 'snapshot',
  'spec', 'stack', 'state', 'status', 'story', 'sync', 'telemetry',
  'validate', 'visual', 'watch', 'wm', 'workflow', 'workspace'
]);

// This is a ratchet, not a target. New commands must use CommandResult from day one. Lower this
// ceiling whenever another legacy command is converted so the unstructured-output surface can
// only shrink.
export const MAX_LEGACY_NARRATION_COMMANDS = 64;

export function validateNarrationMigrationStatus() {
  const registered = new Set(COMMAND_REGISTRY.map((entry) => entry.name));
  const migrated = new Set(MIGRATED_NARRATION_COMMANDS);
  const legacy = new Set(LEGACY_NARRATION_COMMANDS);
  const overlap = [...migrated].filter((name) => legacy.has(name));
  const unknown = [...migrated, ...legacy].filter((name) => !registered.has(name));
  const missing = [...registered].filter((name) => !migrated.has(name) && !legacy.has(name));
  const grew = legacy.size > MAX_LEGACY_NARRATION_COMMANDS;
  if (overlap.length || unknown.length || missing.length || grew) {
    throw new SingularityFlowError([
      'Narration migration catalog is incomplete.',
      overlap.length ? `Both migrated and legacy: ${overlap.sort().join(', ')}` : null,
      unknown.length ? `Unknown commands: ${[...new Set(unknown)].sort().join(', ')}` : null,
      missing.length ? `Unclassified commands: ${missing.sort().join(', ')}` : null,
      grew ? `Legacy allowlist grew to ${legacy.size}; maximum is ${MAX_LEGACY_NARRATION_COMMANDS}. New commands must emit CommandResult.` : null
    ].filter(Boolean).join(' '), { code: 'NARRATION_MIGRATION_INCOMPLETE' });
  }
  return Object.freeze({
    registered: registered.size,
    migrated: Object.freeze([...migrated].sort()),
    legacy: Object.freeze([...legacy].sort())
  });
}
