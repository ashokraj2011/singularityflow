/**
 * "Add Your Own Agent Folder…": a person picks the folder that holds their main agent and the skills
 * it uses, sees exactly what `call add` would copy and leave out, and proposes it for review.
 *
 * The host owns every prompt; the CLI owns every rule. This module only sequences them, so the tests
 * can drive the whole conversation without an extension host: preview, choose the main agent when the
 * folder has several, rename on a clash, confirm by the previewed plan digest, then review and
 * activate the proposal the way Workflow Studio's Changes does.
 */

export interface UserAgentPreview {
  name: string; label: string; main: string; output: 'code' | 'document'; step: string; workflow: string;
  folder: string; files: Array<{ path: string; bytes: number }>; leftOut: Array<{ path: string; reason: string }>;
  notUsed: string[]; problems: string[]; planSha256: string; confirmCommand: string | null;
}

export interface UserAgentHost {
  pickFolder(): PromiseLike<string | null>;
  run<T>(argv: string[]): PromiseLike<T>;
  /** A modal with the given buttons; resolves to the one chosen, or undefined when dismissed. */
  confirm(message: string, detail: string, buttons: string[]): PromiseLike<string | undefined>;
  pick(title: string, items: string[]): PromiseLike<string | undefined>;
  input(prompt: string, value: string, validate: (value: string) => string | null): PromiseLike<string | undefined>;
  info(message: string, buttons: string[]): PromiseLike<string | undefined>;
  error(message: string): PromiseLike<void>;
  reviewAndActivate(branch: string): PromiseLike<unknown>;
  openStudio(): PromiseLike<unknown>;
}

export type UserAgentOutcome = 'cancelled' | 'refused' | 'proposed' | 'reviewed';

interface Choices { name?: string; main?: string; output?: 'code' | 'document' }

const NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const plural = (count: number, word: string): string => `${count} ${word}${count === 1 ? '' : 's'}`;

/** The `call add` words for one folder and the choices made so far. */
export function userAgentArgv(folder: string, choices: Choices, confirm: string | null = null): string[] {
  return ['call', 'add', folder,
    ...(choices.name ? ['--name', choices.name] : []), ...(choices.main ? ['--main', choices.main] : []),
    ...(choices.output ? ['--output', choices.output] : []), ...(confirm ? ['--confirm', confirm] : []), '--json'];
}

/** What the confirmation shows: everything copied, everything left out and why, and what it adds. */
export function userAgentPreviewText(preview: UserAgentPreview): { message: string; detail: string } {
  const lines = [
    `Main agent: ${preview.main}. Its instructions become the agent's.`,
    `Copied unchanged to singularity/user-defined/${preview.name}/: ${plural(preview.files.length, 'file')}.`,
    ...preview.files.map((file) => `  • ${file.path} (${file.bytes} bytes)`),
    ...(preview.leftOut.length ? [`Left out: ${plural(preview.leftOut.length, 'file')}.`, ...preview.leftOut.map((entry) => `  • ${entry.path}: ${entry.reason}`)] : []),
    ...(preview.notUsed.length ? [`Not used from ${preview.main}: ${preview.notUsed.join(', ')} (SFlow sets the agent's tools and steps).`] : []),
    `It runs as one ${preview.output === 'code' ? 'code' : 'document'} step. Start a Story with it from Start Work (Your agents) or: singularity-flow start <WORK-ID> --agent ${preview.name}.`,
    'This creates one configuration proposal for review; nothing is active until it is activated.'
  ];
  return { message: `Add ${preview.label} (${preview.name}) from the ${preview.folder} folder?`, detail: lines.join('\n') };
}

function refusal(error: unknown): { code: string | null; message: string; details: Record<string, unknown> } {
  const result = (error as { result?: { error?: { code?: string; message?: string; details?: Record<string, unknown> } } })?.result?.error;
  return { code: result?.code ?? null, message: result?.message ?? (error as Error)?.message ?? String(error), details: result?.details ?? {} };
}

/** The whole "add a folder" conversation. Returns what it ended with; it never activates by itself. */
export async function addUserAgentFolder(host: UserAgentHost): Promise<UserAgentOutcome> {
  const folder = await host.pickFolder();
  if (!folder) return 'cancelled';
  const choices: Choices = {};
  for (;;) {
    let preview: UserAgentPreview;
    try {
      preview = (await host.run<{ data: UserAgentPreview }>(userAgentArgv(folder, choices))).data;
    } catch (error) {
      const refused = refusal(error);
      // Several agent files, or none recognised: the person says which one runs the others.
      if (refused.code === 'USER_AGENT_MAIN_AMBIGUOUS' || refused.code === 'USER_AGENT_MAIN_REQUIRED') {
        const candidates = (refused.details.candidates ?? refused.details.files ?? []) as string[];
        const main = candidates.length ? await host.pick('Which file is the main agent, the one that runs the others?', candidates) : undefined;
        if (!main) return 'cancelled';
        choices.main = main;
        continue;
      }
      await host.error(refused.message);
      return 'refused';
    }
    const taken = preview.problems.find((problem) => /already exists/u.test(problem));
    if (taken) {
      const name = await host.input(`${taken} Choose another name for this agent, its step and its workflow.`, `${preview.name}-agent`,
        (value) => (NAME.test(value) ? null : 'Use lowercase words joined by hyphens.'));
      if (!name) return 'cancelled';
      choices.name = name;
      continue;
    }
    if (preview.problems.length) {
      await host.error(`${preview.label} cannot be proposed yet: ${preview.problems.join(' ')}`);
      return 'refused';
    }
    const text = userAgentPreviewText(preview);
    const other = preview.output === 'code' ? 'Make It a Document Step' : 'Make It a Code Step';
    const answer = await host.confirm(text.message, text.detail, ['Propose It', 'Change the Name…', other]);
    if (answer === 'Change the Name…') {
      const name = await host.input('Name for this agent, its step and its workflow', preview.name,
        (value) => (NAME.test(value) ? null : 'Use lowercase words joined by hyphens.'));
      if (name) choices.name = name;
      continue;
    }
    if (answer === other) { choices.output = preview.output === 'code' ? 'document' : 'code'; continue; }
    if (answer !== 'Propose It') return 'cancelled';
    let proposed: { data: { branch: string | null } };
    try {
      proposed = await host.run<{ data: { branch: string | null } }>(userAgentArgv(folder, choices, preview.planSha256));
    } catch (error) {
      await host.error(refusal(error).message);
      return 'refused';
    }
    const branch = proposed.data.branch;
    const next = await host.info(`${preview.label} was proposed for review${branch ? ` as ${branch}` : ''}. Once it is activated, start a Story with it from Start Work (Your agents).`,
      branch ? ['Review and Activate…', 'Open Workflow Studio'] : ['Open Workflow Studio']);
    if (next === 'Review and Activate…' && branch) { await host.reviewAndActivate(branch); return 'reviewed'; }
    if (next === 'Open Workflow Studio') await host.openStudio();
    return 'proposed';
  }
}
