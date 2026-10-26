/**
 * "Add Your Own Agent Folder…": a person picks the folder that holds their main agent and the skills
 * it uses, sees exactly what `call add` would copy and leave out, and proposes it for review.
 *
 * The host owns every prompt; the CLI owns every rule. This module only sequences them, so the tests
 * can drive the whole conversation without an extension host: preview, choose the main agent when the
 * folder has several, rename on a clash, confirm by the previewed plan digest, then review and
 * activate the proposal the way Workflow Studio's Changes does. A folder of several agents that hand
 * work to each other is a workflow: the person builds one from it (team import), or adds one agent.
 */

export interface UserAgentPreview {
  name: string; label: string; main: string; output: 'code' | 'document'; step: string; workflow: string;
  folder: string; files: Array<{ path: string; bytes: number; kind?: 'document' | 'viewable' }>; leftOut: Array<{ path: string; reason: string }>;
  /** How the folder's files link, as the CLI read them. */
  map?: { links: Array<{ from: string; to: string; kind: string }> };
  notUsed: string[]; problems: string[]; planSha256: string; confirmCommand: string | null; frontMatterNote?: string | null;
  /** A new copy of an existing agent's folder under the same name (call add --replace). */
  replace?: boolean;
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
  /** Open Import a Team Workflow on `folder`: SFlow reads it, Copilot proposes the steps, SFlow checks them. */
  buildWorkflow(folder: string): PromiseLike<unknown>;
}

export type UserAgentOutcome = 'cancelled' | 'refused' | 'proposed' | 'reviewed' | 'workflow';

interface Choices { name?: string; main?: string; output?: 'code' | 'document'; replace?: boolean }

const NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const plural = (count: number, word: string): string => `${count} ${word}${count === 1 ? '' : 's'}`;
const KIND_NOTE = { document: ', read as its text', viewable: ', an image or PDF the agent opens' } as const;
export const BUILD_WORKFLOW = 'Build a Workflow from This Folder…';
export const ADD_ONE_AGENT = 'Add One of Its Agents…';

/** The `call add` words for one folder and the choices made so far. */
export function userAgentArgv(folder: string, choices: Choices, confirm: string | null = null): string[] {
  return ['call', 'add', folder,
    ...(choices.name ? ['--name', choices.name] : []), ...(choices.main ? ['--main', choices.main] : []),
    ...(choices.output ? ['--output', choices.output] : []), ...(choices.replace ? ['--replace'] : []),
    ...(confirm ? ['--confirm', confirm] : []), '--json'];
}

/** What the confirmation shows: everything copied, everything left out and why, and what it adds. */
export function userAgentPreviewText(preview: UserAgentPreview): { message: string; detail: string } {
  const lines = [
    `Main agent: ${preview.main}. Its instructions become the agent's.`,
    `Copied unchanged to singularity/user-defined/${preview.name}/: ${plural(preview.files.length, 'file')}.`,
    ...preview.files.map((file) => `  • ${file.path} (${file.bytes} bytes${file.kind ? KIND_NOTE[file.kind] : ''})`),
    ...(preview.map?.links.length ? [`Links between its files: ${plural(preview.map.links.length, 'link')}.`,
      ...preview.map.links.slice(0, 12).map((link) => `  • ${link.from} → ${link.to}`)] : []),
    ...(preview.leftOut.length ? [`Left out: ${plural(preview.leftOut.length, 'file')}.`, ...preview.leftOut.map((entry) => `  • ${entry.path}: ${entry.reason}`)] : []),
    ...(preview.notUsed.length ? [`Not used from ${preview.main}: ${preview.notUsed.join(', ')} (SFlow sets the agent's tools and steps).`] : []),
    ...(preview.frontMatterNote ? [`${preview.main}: ${preview.frontMatterNote}`] : []),
    preview.replace
      ? `It replaces the folder of your agent ${preview.name}; its step and workflow stay, and running Stories keep the folder they started with.`
      : `It runs as one ${preview.output === 'code' ? 'code' : 'document'} step. Start a Story with it from Start Work (Your agents) or: singularity-flow start <WORK-ID> --agent ${preview.name}.`,
    'This creates one configuration proposal for review; nothing is active until it is activated.'
  ];
  return { message: preview.replace ? `Replace the folder of ${preview.label} (${preview.name}) with the ${preview.folder} folder?`
    : `Add ${preview.label} (${preview.name}) from the ${preview.folder} folder?`, detail: lines.join('\n') };
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
      // Several agents that hand work to each other: a workflow to build, or one agent to add alone.
      if (refused.code === 'USER_AGENT_FOLDER_IS_WORKFLOW') {
        const agents = (refused.details.agents ?? []) as string[];
        const answer = await host.confirm(refused.message,
          'Build a workflow: SFlow reads every file and how they link, Copilot proposes the steps, and SFlow checks every route before you review it. Or add one of its agents as a single step.',
          agents.length ? [BUILD_WORKFLOW, ADD_ONE_AGENT] : [BUILD_WORKFLOW]);
        if (answer === BUILD_WORKFLOW) { await host.buildWorkflow(folder); return 'workflow'; }
        if (answer !== ADD_ONE_AGENT) return 'cancelled';
        const main = await host.pick('Which agent do you want to add as one step?', agents);
        if (!main) return 'cancelled';
        choices.main = main;
        continue;
      }
      // Several agent files, or none recognised: the person says which one runs the others.
      if (refused.code === 'USER_AGENT_MAIN_AMBIGUOUS' || refused.code === 'USER_AGENT_MAIN_REQUIRED') {
        const candidates = (refused.details.candidates ?? refused.details.files ?? []) as string[];
        // Nothing to choose from: say why, rather than closing as if the person had cancelled.
        if (!candidates.length) { await host.error(refused.message); return 'refused'; }
        const main = await host.pick('Which file is the main agent, the one that runs the others?', candidates);
        if (!main) return 'cancelled';
        choices.main = main;
        continue;
      }
      await host.error(refused.message);
      return 'refused';
    }
    const taken = preview.problems.find((problem) => /already exists/u.test(problem));
    // One of the person's own agents: replace its folder under the same name, or use another name.
    if (taken && /--replace/u.test(taken) && !choices.replace) {
      const answer = await host.confirm(`${preview.name} is already one of your agents.`,
        'Replace its folder with this one: its step and workflow stay, and running Stories keep the folder they started with. Or add this folder under another name.',
        ['Replace Its Folder', 'Use Another Name…']);
      if (answer === 'Replace Its Folder') { choices.replace = true; continue; }
      if (answer !== 'Use Another Name…') return 'cancelled';
    }
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
    // A replaced folder keeps its name and what its step makes, so only proposing it is offered.
    const answer = await host.confirm(text.message, text.detail, preview.replace ? ['Propose It'] : ['Propose It', 'Change the Name…', other]);
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
