/**
 * Which tests a Story's gates run, changed while it is open [TCE:REQ-090]. This only offers the choices
 * and builds the one CLI command; the engine decides what the change means and records it.
 */
export type TestScope = 'all-configured' | 'changed-and-affected' | 'new-and-changed';
export const TEST_SCOPE_LABELS: Readonly<Record<TestScope, string>> = {
  'all-configured': 'All configured tests',
  'changed-and-affected': 'Changed and affected tests',
  'new-and-changed': 'Only new and changed tests'
};
const MEANING: Readonly<Record<TestScope, string>> = {
  'all-configured': "Also runs the repository's own suite",
  'changed-and-affected': 'Runs every test of the modules this Story touches',
  'new-and-changed': 'Other tests never run; only files this Story adds or changes'
};
const ORDER: readonly TestScope[] = ['all-configured', 'changed-and-affected', 'new-and-changed'];

interface ScopedWorkflow { testScopeChanges?: Array<{ to?: string }>; resolution?: unknown }

/** The scope in force, as the engine reads it: the latest change, else what intake chose. */
export function currentTestScope(workflow: ScopedWorkflow): TestScope {
  const recorded = workflow.testScopeChanges?.at(-1)?.to ?? (workflow.resolution as { testExecutionMode?: string } | undefined)?.testExecutionMode;
  return ORDER.includes(recorded as TestScope) ? recorded as TestScope : 'changed-and-affected';
}

/** The quick-pick entries, the current scope marked; choosing it changes nothing. */
export function testScopeChoices(current: TestScope): Array<{ label: string; description: string; scope: TestScope }> {
  return ORDER.map((scope) => ({ label: TEST_SCOPE_LABELS[scope], description: `${scope === current ? 'Current · ' : ''}${MEANING[scope]}`, scope }));
}

/** Whether moving there runs fewer tests, so the engine asks why and shows the reviewer the answer. */
export function runsFewerTests(from: TestScope, to: TestScope): boolean {
  return ORDER.indexOf(to) > ORDER.indexOf(from);
}

export function testScopeReasonProblem(reason: string): string | null {
  const text = reason.trim();
  return text.length < 10 || text.length > 500 ? 'Say why in 10 to 500 characters; the step\'s reviewer reads it.' : null;
}

export function testScopeArgs(workId: string, scope: TestScope, reason?: string): string[] {
  return ['story', 'test-policy', 'scope', workId, '--to', scope, ...(reason?.trim() ? ['--reason', reason.trim()] : []), '--json'];
}
