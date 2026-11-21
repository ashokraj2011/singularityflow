/**
 * Update SFlow's step intents screen (step intents spec §8, Stage 5), as data and one flow, with no `vscode` import so
 * tests drive it with a fake host.
 *
 * After a new build updates sflow/config, a repository whose own workflows have steps that do not say what they are
 * for yet is offered its one screen, once per build: each step, its intent and why, and each setting the step keeps as
 * it is. A step SFlow cannot read for certain asks its one question, from its two or three choices. Confirm writes the
 * screen through the same refresh the update ran (`workspace refresh-configuration --confirm-intents CODE`), and every
 * workflow runs exactly as before; Not now writes nothing, and the workflow keeps working at its version.
 */

type Maybe<T> = Promise<T> | Thenable<T>;
interface Envelope<T> { data?: T }

export interface IntentScreenChoice { intent: string; text: string }
export interface IntentScreenRow {
  step: string; label: string; intent: string; intentLabel: string; badge: string; badgeText: string; why: string;
  kept?: Array<{ setting: string; today: string; intent: string }>;
  question?: { question: string; choices: IntentScreenChoice[]; note?: string };
}
export interface IntentScreenWorkflow {
  workflow: string; label: string; status: 'ready' | 'needs-answer' | 'held'; reason: string | null; rows: IntentScreenRow[];
  kept?: Array<{ setting: string; today: string; intent: string }>;
}
export interface IntentScreen {
  code: string | null;
  workflows: IntentScreenWorkflow[];
  counts: { workflows: number; steps: number; kept: number; open: number; held: number };
  summary?: string | null;
  confirmation?: 'written' | 'stale' | 'refused' | 'nothing-ready';
  problems?: string[];
}
export interface StepIntentsOffer { repository: string; code: string; summary: string; counts: IntentScreen['counts'] }

interface RefreshResult { results?: Array<{ repository: string; intentScreen?: IntentScreen; error?: string | null }> }

export interface StepIntentsHost {
  run<T>(args: string[]): Promise<T>;
  progress<T>(title: string, task: () => Promise<T>): Maybe<T>;
  inform(message: string, ...actions: string[]): Maybe<string | undefined>;
  warn(message: string, ...actions: string[]): Maybe<string | undefined>;
  /** A modal confirmation with its detail; true when the person chose `action`. */
  confirm(message: string, detail: string, action: string): Maybe<boolean>;
  /** One question with its choices; the chosen intent, or undefined when the person closed it. */
  pick(title: string, choices: Array<{ label: string; intent: string }>): Maybe<string | undefined>;
  log(line: string): void;
  remembered<T>(key: string): T | undefined;
  remember(key: string, value: unknown): Maybe<void>;
}

export const STEP_INTENTS_OFFERED_KEY = 'singularityFlow.stepIntents.offered';
const REVIEW = 'Review…';
const NOT_NOW = 'Not now';
const CONFIRM = 'Confirm';

/** The refresh that shows one repository's screen, and the one that writes it with the person's answers. */
export function screenArgs(repository: string): string[] {
  return ['workspace', 'refresh-configuration', '--repository', repository, '--dry-run', '--json'];
}
export function confirmArgs(repository: string, code: string, answers: Record<string, string> = {}): string[] {
  return ['workspace', 'refresh-configuration', '--repository', repository, '--confirm-intents', code,
    ...Object.entries(answers).sort(([left], [right]) => left.localeCompare(right)).flatMap(([step, intent]) => ['--intent', `${step}=${intent}`]), '--json'];
}

/** The rows that ask, in screen order. */
export function questionsOf(shownScreen: IntentScreen): IntentScreenRow[] {
  const seen = new Set<string>();
  return shownScreen.workflows.flatMap((entry) => entry.rows).filter((row) => {
    if (!row.question || row.badge !== 'needs-answer' || seen.has(row.step)) return false;
    seen.add(row.step);
    return true;
  });
}

/** The screen as the confirmation's detail: each workflow, each step, what it keeps, and what is kept as it is. */
export function screenDetail(shownScreen: IntentScreen, answers: Record<string, string> = {}): string {
  const lines: string[] = [];
  for (const entry of shownScreen.workflows) {
    const answered = entry.status === 'needs-answer' && questionsOf({ ...shownScreen, workflows: [entry] }).every((row) => answers[row.step]);
    const state = entry.status === 'ready' || answered ? 'each step says what it is for' : entry.status === 'needs-answer' ? 'waits for your answer' : 'kept as it is';
    lines.push(`${entry.label}: ${state}`);
    if (entry.reason) lines.push(`  ${entry.reason}`);
    for (const row of entry.rows) {
      const intent = answers[row.step] ?? row.intent;
      lines.push(`  ${row.label}: ${intent}${answers[row.step] ? ' (your answer)' : ` (${row.badgeText.toLowerCase()})`}`);
      for (const item of row.kept ?? []) lines.push(`    keeps ${item.today}`);
    }
    for (const item of entry.kept ?? []) lines.push(`  keeps ${item.today}`);
  }
  lines.push('', 'Every workflow runs exactly as before: what an intent would change is kept, with the reason "Kept as it was before step intents".');
  return lines.join('\n');
}

/**
 * Offer each repository's screen once per build: Review… shows it, asks each question, and Confirm writes it; Not now,
 * or closing a question, writes nothing. Returns what happened per repository.
 */
export async function offerStepIntents(host: StepIntentsHost, offers: StepIntentsOffer[], { loadedBuild }: { loadedBuild: string }): Promise<string[]> {
  const outcomes: string[] = [];
  const offered = host.remembered<Record<string, string>>(STEP_INTENTS_OFFERED_KEY) ?? {};
  for (const offer of offers) {
    if (offered[offer.repository] === `${loadedBuild}:${offer.code}`) { outcomes.push('offered-before'); continue; }
    await host.remember(STEP_INTENTS_OFFERED_KEY, { ...offered, [offer.repository]: `${loadedBuild}:${offer.code}` });
    const choice = await host.inform(`Your own workflows in ${offer.repository} can say what each step is for. Nothing changes until you confirm, `
      + 'and every workflow runs as before.', REVIEW, NOT_NOW);
    if (choice !== REVIEW) { outcomes.push('not-now'); continue; }
    outcomes.push(await reviewStepIntents(host, offer.repository));
  }
  return outcomes;
}

/** Show one repository's screen, ask its questions, and write it when the person confirms. */
export async function reviewStepIntents(host: StepIntentsHost, repository: string): Promise<string> {
  let shownScreen: IntentScreen | undefined;
  try {
    const shown = await host.progress(`Singularity Flow: reading what each step of ${repository}'s workflows is for`,
      () => host.run<Envelope<RefreshResult>>(screenArgs(repository)));
    shownScreen = shown.data?.results?.find((entry) => entry.repository === repository)?.intentScreen;
  } catch (error) {
    void host.warn(`Singularity Flow could not show the step intents screen for ${repository}: ${(error as Error).message} `
      + `Run singularity-flow workspace refresh-configuration --repository ${repository} --dry-run to see it.`);
    return 'failed';
  }
  if (!shownScreen?.code || !(shownScreen.counts.workflows || shownScreen.counts.open)) return 'nothing';
  const answers: Record<string, string> = {};
  for (const row of questionsOf(shownScreen)) {
    const intent = await host.pick(`${row.question!.question}${row.question!.note ? ` ${row.question!.note}` : ''}`,
      row.question!.choices.map((choice) => ({ label: choice.text, intent: choice.intent })));
    if (!intent) return 'not-now';
    answers[row.step] = intent;
  }
  const confirmed = await host.confirm(`Say what each step of ${repository}'s own workflows is for?`, screenDetail(shownScreen, answers), CONFIRM);
  if (!confirmed) return 'not-now';
  let written: IntentScreen | undefined;
  try {
    const result = await host.progress(`Singularity Flow: writing what each step is for in ${repository}`,
      () => host.run<Envelope<RefreshResult>>(confirmArgs(repository, shownScreen.code!, answers)));
    written = result.data?.results?.find((entry) => entry.repository === repository)?.intentScreen;
  } catch (error) {
    void host.warn(`Singularity Flow could not write the step intents for ${repository}: ${(error as Error).message} Nothing was written.`);
    return 'failed';
  }
  if (written?.confirmation === 'written') {
    if (written.summary) host.log(`Configuration: ${repository}: ${written.summary}`);
    void host.inform(`Each step of ${repository}'s own workflows now says what it is for; every workflow runs as before.`);
    return 'written';
  }
  const why = written?.problems?.[0] ?? 'nothing was written.';
  // The screen changed since it was read (a teammate's edit, another build): the screen as it is now is one Review away.
  if (written?.confirmation === 'stale') {
    const again = await host.warn(`The step intents for ${repository} were not written: ${why}`, REVIEW);
    return again === REVIEW ? reviewStepIntents(host, repository) : 'not-written';
  }
  // Anything else would refuse the same way again: a build of the workflow settles each step with what it changes in view.
  const workflow = shownScreen.workflows.find((entry) => entry.status !== 'held')?.workflow ?? shownScreen.workflows[0]?.workflow;
  void host.warn(`The step intents for ${repository} were not written: ${why}${workflow
    ? ` Say what each step is for with what it changes in view: singularity-flow workflow build start --intents ${workflow}` : ''}`);
  return 'not-written';
}
