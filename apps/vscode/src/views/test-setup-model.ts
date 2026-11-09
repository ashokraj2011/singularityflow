/** Guided test-command edits; the existing configuration transaction owns validation and saving. */
import { isDeepStrictEqual } from 'node:util';
import YAML from 'yaml';
import { renderPreservingFormatting } from '../../../../src/yaml-formatting.mjs';
import { normalizeExternalCommand } from '../../../../src/external-command-policy.mjs';

/**
 * The repository's own test commands (`tests:`), which every step that runs tests uses [RTC:REQ-005].
 * Test setup chooses it by default; a step is the other choice, an override for that step only.
 */
export const REPOSITORY_TEST_TARGET = 'repository';

export interface TestSetupTarget {
  id: string; label: string; phaseId: string | null; workType: string | null;
  commands: Record<string, unknown>[]; legacyCommands: string[];
}
export interface TestSetupInspection {
  repositoryPath: string; sourceRoots: string[]; suggestions: Record<string, unknown>[];
  // Commands the team wrote down (src/instruction-test-commands.mjs), with their file, line and env.
  instructionCandidates?: Record<string, any>[];
  diagnostics: Array<{ path: string; code: string; message: string }>;
  testsExecuted: false; baseline: string;
}
/**
 * Whether a person chooses a Story's test scope when it starts: the workflow's `testRecovery.enabled`.
 * `reviews` says the file also sets risk reviews, which this switch keeps exactly as written.
 */
export interface TestScopeSetting { enabled: boolean; reviews: boolean }
export interface TestSetupView {
  targets: TestSetupTarget[]; selected: string | null; inspection: TestSetupInspection | null;
  /** Null when the workflow file cannot be read; the Center's diagnostics say why. */
  testScope?: TestScopeSetting | null;
}
type Row = Record<string, any>;

export function testScopeFromYaml(text: string): TestScopeSetting | null {
  try {
    const document = YAML.parseDocument(text);
    if (document.errors.length) return null;
    const value = (document.toJS() ?? {}).testRecovery;
    if (value == null) return { enabled: false, reviews: false };
    if (typeof value !== 'object' || Array.isArray(value)) return null;
    return { enabled: value.enabled === true, reviews: Object.keys(value).some((key) => key !== 'enabled') };
  } catch { return null; }
}

/** Set only `testRecovery.enabled`; risk reviews and every other setting in the file stay as they are. */
export function updateTestScopeYaml(text: string, enabled: unknown): string {
  if (typeof enabled !== 'boolean') throw new Error('Choose whether test scope is chosen at Story start.');
  const document = YAML.parseDocument(text);
  if (document.errors.length) throw new Error('Repair invalid workflow YAML before changing test scope.');
  const current = (document.toJS() ?? {}).testRecovery;
  if (current != null && (typeof current !== 'object' || Array.isArray(current))) throw new Error('testRecovery in the workflow file must be an object. Repair it before changing test scope.');
  document.setIn(['testRecovery', 'enabled'], enabled);
  // Only the edited lines change; the rest of the file keeps its own formatting and comments.
  return renderPreservingFormatting(text, document);
}

export function testSetupTargetsFromYaml(text: string): TestSetupTarget[] {
  // The Center must remain usable when a candidate configuration is invalid. Its existing
  // diagnostics explain the error; do not invent editable targets or crash every other tab.
  try {
    const document = YAML.parseDocument(text);
    if (document.errors.length) return [];
    return testSetupTargets(document.toJS() ?? {});
  } catch { return []; }
}

export function testSetupTargets(definition: Row): TestSetupTarget[] {
  const phases = definition.phases ?? {};
  const target = (phaseId: string, workType: string | null, value: Row): TestSetupTarget => ({
    id: JSON.stringify([workType, phaseId]), phaseId, workType,
    label: `${workType ? definition.workTypes[workType].label ?? workType : 'Shared workflows'} — ${phases[phaseId]?.label ?? phaseId}`,
    commands: (value.qualityCommands ?? []).filter((command: unknown) => command && typeof command === 'object' && (command as Row).kind === 'test'),
    legacyCommands: (value.qualityCommands ?? []).filter((command: unknown) => typeof command === 'string')
  });
  // No steps means no configuration to edit: the Center's diagnostics say why.
  if (!phases || typeof phases !== 'object' || !Object.keys(phases).length) return [];
  const tests = Array.isArray(definition.tests) ? definition.tests : [];
  return [
    { id: REPOSITORY_TEST_TARGET, label: 'The repository: every step that runs tests, in every workflow', phaseId: null, workType: null,
      commands: tests.filter((command: unknown) => command && typeof command === 'object' && (command as Row).kind === 'test'), legacyCommands: [] },
    ...Object.entries(phases).map(([id, phase]) => target(id, null, phase as Row)),
    ...Object.entries(definition.workTypes ?? {}).flatMap(([id, value]) => {
      const workType = value as Row;
      return (workType.phases ?? []).filter((phaseId: string) => phases[phaseId]).map((phaseId: string) =>
        target(phaseId, id, { ...phases[phaseId], ...workType.phaseOverrides?.[phaseId] }));
    })
  ];
}

export function updateTestSetupYaml(text: string, targetId: string, commands: unknown): string {
  const document = YAML.parseDocument(text);
  if (document.errors.length) throw new Error('Repair invalid workflow YAML before editing test setup.');
  const definition = document.toJS();
  const target = testSetupTargets(definition).find(entry => entry.id === targetId);
  if (!target) throw new Error('The selected workflow phase no longer exists. Reload Test setup.');
  if (!Array.isArray(commands) || !commands.length || commands.length > 20) throw new Error('Provide from 1 to 20 structured test commands.');
  const ids = new Set<string>();
  for (const [index, command] of commands.entries()) {
    if (!command || typeof command !== 'object' || Array.isArray(command)
        || command.kind !== 'test' || command.modelPolicy !== 'never'
        || !Array.isArray(command.argv) || !command.argv.length
        || command.argv.some((part: unknown) => typeof part !== 'string' || /[\0\r\n]/.test(part))
        || !command.id || !command.result || !Array.isArray(command.affectedRoots) || !command.affectedRoots.length) {
      throw new Error('Each test needs an ID, argv arguments, affected roots, modelPolicy never, and a structured report contract.');
    }
    const normalized = normalizeExternalCommand(command, index);
    if (ids.has(normalized.id)) throw new Error(`Duplicate test command ID: ${normalized.id}`);
    ids.add(normalized.id);
  }
  if (target.id === REPOSITORY_TEST_TARGET) {
    if (definition.tests != null && !Array.isArray(definition.tests)) throw new Error('tests in the workflow file must be a list. Repair it before editing test setup.');
    // An entry saved unchanged keeps its node, so a command the team wrote down keeps where it was read from.
    const existing = document.getIn(['tests'], true);
    const kept = YAML.isSeq(existing) ? [...existing.items] : [];
    const list = YAML.isSeq(existing) ? existing : document.createNode([]) as YAML.YAMLSeq;
    const items = commands.map((command) => kept.find((node) => YAML.isMap(node) && isDeepStrictEqual(node.toJSON(), command)) ?? document.createNode(command));
    // The comment above the list's first entry belongs to that entry: it goes when that entry does.
    if (items[0] !== kept[0]) list.commentBefore = undefined;
    list.items = items;
    list.flow = false;
    if (list !== existing) document.setIn(['tests'], list);
    return renderPreservingFormatting(text, document);
  }
  const prefix = target.workType ? ['workTypes', target.workType, 'phaseOverrides', target.phaseId] : ['phases', target.phaseId as string];
  const phaseId = target.phaseId as string;
  const current = target.workType
    ? { ...definition.phases[phaseId], ...definition.workTypes[target.workType].phaseOverrides?.[phaseId] }
    : definition.phases[phaseId];
  const retained = (current.qualityCommands ?? []).filter((command: unknown) => !command || typeof command !== 'object' || (command as Row).kind !== 'test');
  if (retained.some((command: Row) => command && typeof command === 'object' && ids.has(String(command.id)))) throw new Error('A test ID conflicts with another quality command.');
  document.setIn([...prefix, 'qualityCommands'], [...retained, ...commands]);
  // Only the edited lines change; the rest of the file keeps its own formatting and comments.
  return renderPreservingFormatting(text, document);
}
