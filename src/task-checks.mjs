/**
 * What a task's checks were, for its last message (`work status`) [ITW:REQ-015, REQ-018, A13, A20]: the test commands its
 * code and test steps ran, with their counts, and, for a refactor, each thing its plan says must not change that no check
 * covered. A refactor is never reported as safer than what ran.
 *
 * The plan's items are its planned evidence rows (`| Clause | Expected paths | Planned tests |`, the plan template's own
 * machine-readable table): each row is one thing that must not change, named by its clause's sentence, and its Planned
 * tests are the checks that show it. A row is covered when a test of one of those files passed in a run its code or test
 * step kept; a row whose tests are `not-applicable:` or name no file any run covered is "not covered by any check".
 *
 * Pure: the Story's record, `read(repositoryPath)`, which returns a committed file's text or null, and `item`, the Story's
 * folder in the repository.
 */

const RUN_LIMIT = 6;
const ITEM_LIMIT = 8;
const clean = (value, maximum = 160) => {
  const text = String(value ?? '').replace(/\s+/gu, ' ').trim();
  return text.length > maximum ? `${text.slice(0, maximum - 1).trimEnd()}…` : text;
};
const json = (text) => { try { return JSON.parse(text); } catch { return null; } };
const cells = (line) => (/^\s*\|.*\|\s*$/u.test(line) ? line.trim().slice(1, -1).split('|').map((cell) => cell.trim()) : null);
const backticked = (cell) => [...String(cell ?? '').matchAll(/`([^`]+)`/gu)].map((match) => match[1].trim()).filter(Boolean);

/** The test runs a task's steps kept, one per command as a person reads it, with what each run's tests did. */
export function taskTestRuns(workflow, read) {
  const runs = new Map();
  for (const id of workflow?.phaseOrder ?? []) {
    const phase = workflow.phases?.[id];
    if (phase?.status !== 'approved') continue;
    for (const run of [...(phase.deliveryEvidence?.testExecutions ?? []), ...(phase.stepTestRuns?.testExecutions ?? [])]) {
      if (!run?.commandId) continue;
      const check = (phase.checks ?? []).find((entry) => entry?.id === run.commandId);
      const command = clean(check?.command ?? run.commandId, 120);
      const receipt = run.receiptPath ? json(read(run.receiptPath)) : null;
      const tests = receipt?.tests ?? run.counts ?? null;
      const passedFiles = (receipt?.occurrences ?? []).filter((entry) => entry?.outcome === 'passed' && entry.file).map((entry) => entry.file);
      const kept = runs.get(command);
      runs.set(command, { command, status: run.status ?? receipt?.status ?? null, tests,
        passedFiles: [...new Set([...(kept?.passedFiles ?? []), ...passedFiles])] });
    }
  }
  return [...runs.values()];
}

/** A run as a person reads it: its command and what its tests did. */
export function runWords(run) {
  const tests = run.tests;
  if (!tests || !Number.isInteger(tests.discovered)) return `${run.command} (${run.status ?? 'ran'})`;
  const failed = Number(tests.failed ?? 0);
  return `${run.command} (${tests.discovered} ${tests.discovered === 1 ? 'test' : 'tests'}${failed ? `, ${failed} failed` : `, ${tests.discovered === 1 ? 'it' : 'all'} passed`})`;
}

/** The plan's text without SFlow's metadata and the earlier steps' documents it carries as inputs. */
function planText(text) {
  return String(text ?? '').replace(/<!--\s*singularity-flow:inputs:start\s*-->[\s\S]*?<!--\s*singularity-flow:inputs:end\s*-->/gu, '')
    .replace(/<!--[\s\S]*?-->/gu, '');
}

/**
 * The things a plan says must not change, from its planned evidence rows: `{ clause, words, tests, notApplicable }`, in
 * the order the plan lists them. A row's words are its clause's sentence in the plan, else its observable result.
 */
export function planItems(text) {
  const lines = planText(text).split(/\r?\n/u);
  const items = [];
  for (let index = 0; index < lines.length - 1; index += 1) {
    const header = cells(lines[index])?.map((cell) => cell.toLowerCase());
    if (!header || header.slice(0, 3).join('|') !== 'clause|expected paths|planned tests') continue;
    const observable = header.indexOf('observable result');
    for (index += 2; index < lines.length; index += 1) {
      const row = cells(lines[index]);
      if (!row) break;
      const [clause] = backticked(row[0]);
      if (!clause) continue;
      const anchor = `[${clause}]`;
      const sentence = lines.find((line) => line.includes(anchor) && !cells(line));
      const words = sentence ? sentence.replace(anchor, '').replace(/\s+([.;:])/gu, '$1').trim().replace(/\.$/u, '')
        : observable >= 0 && row[observable] ? row[observable] : clause;
      items.push({ clause, words: clean(words), tests: backticked(row[2]), notApplicable: /^not-applicable\s*:/iu.test(row[2] ?? '') });
    }
  }
  return items;
}

/**
 * The task's checks for its last message: `{ ran, notCovered }`, each in a person's words. `notCovered` is read for a
 * refactor only, whose plan says what must not change; null when the task ran no test and has no such plan.
 */
export function taskChecks(workflow, read, { item: folder }) {
  const runs = taskTestRuns(workflow, read);
  const composition = workflow?.resolution?.composition ?? null;
  const plan = composition?.kind === 'refactor' ? (composition.steps ?? []).find((step) => step.intent === 'plan') : null;
  const document = plan ? workflow.phases?.[plan.id]?.requiredArtifact?.path : null;
  const items = document ? planItems(read(`${folder}/${document}`)) : [];
  const passed = new Set(runs.flatMap((run) => run.passedFiles));
  const notCovered = items.filter((entry) => entry.notApplicable || !entry.tests.some((file) => passed.has(file)));
  if (!runs.length && !items.length) return null;
  return { ran: runs.slice(0, RUN_LIMIT).map(runWords), ...(plan ? { items: items.length, notCovered: notCovered.slice(0, ITEM_LIMIT).map((entry) => entry.words) } : {}) };
}

/** The task's checks in its last message's words. */
export function checksWords(checks) {
  if (!checks) return '';
  const ran = checks.ran.length ? ` Checks that ran: ${checks.ran.join('; ')}.` : ' No check ran.';
  const left = checks.notCovered?.length ? ` Not covered by any check: ${checks.notCovered.join('; ')}.` : '';
  return `${ran}${left}`;
}
