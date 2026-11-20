/**
 * The four page tools VS Code's chat calls: each checks its input, runs the command that opens its page, and hands back what
 * the person did there as JSON; a failure is `blocked` with what it said. One table, so the extension (extension.ts) and the
 * VS Code journey host (test/helpers/vscode-host.mjs) call the same thing, and a journey walks what the chat really gets
 * back [hardening C, "walk the VS Code path"]. No `vscode` import: the caller passes its command runner.
 */
export type ExecuteCommand = (command: string, ...args: unknown[]) => PromiseLike<unknown>;

const STORY = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const CAPABILITY = /^[a-z0-9][a-z0-9-]*$/u;

interface DecisionTool {
  /** The command the tool runs, with the chat's input as its argument. */
  command: string;
  /** What the chat is told when the command answers nothing: this window has no SFlow repository ready. */
  nothing: string;
  /** Throws when the input is not what the tool takes; the page itself checks the rest. */
  check?: (input: Record<string, unknown> | undefined) => void;
  /** Extra words on a failure. */
  onFailure?: Record<string, unknown>;
}

export const DECISION_TOOLS: Readonly<Record<string, DecisionTool>> = Object.freeze({
  singularityFlow_deliveryValidation: {
    command: 'singularityFlow.guideDeliveryValidation',
    nothing: 'Delivery validation could not open here, because this window has no SFlow repository ready. Nothing was recorded. Open the Story\'s checkout, check Singularity Flow: Diagnostics, then ask again.',
    check: (input) => {
      if (!input || Object.keys(input).some((key) => !['workId', 'capability'].includes(key)) || typeof input.workId !== 'string' || !STORY.test(input.workId)
          || input.capability !== undefined && (typeof input.capability !== 'string' || !CAPABILITY.test(input.capability))) {
        throw new Error('Delivery validation accepts only an exact Story ID and optional capability ID; the person chooses the action in VS Code.');
      }
    }
  },
  singularityFlow_adjudicate: {
    command: 'singularityFlow.adjudicate',
    nothing: 'The decisions page could not open here, because this window has no SFlow repository ready. Nothing was recorded. Open the Story\'s checkout, or ask the person to run /sf-converge in it.'
  },
  singularityFlow_decide: {
    command: 'singularityFlow.decide',
    nothing: 'The decisions page could not open here, because this window has no SFlow repository ready. Nothing was recorded. Open the Story\'s checkout, or ask the person to run /sf-decide in it.'
  },
  singularityFlow_witnessReview: {
    command: 'singularityFlow.reviewWitness',
    nothing: 'Witness review could not open here, because this window has no SFlow repository ready. Nothing was recorded. Open the Story\'s checkout, check Singularity Flow: Diagnostics, then ask again.',
    onFailure: { next: 'Follow the returned repair or recovery route before reopening this review. A failed publication can retain a local record; inspect its outcome instead of repeating an unchanged witness.' }
  }
});

/** The answer a page tool gives the chat for `input`: never undefined, which crashes VS Code's chat turn. */
export async function decisionToolAnswer(name: string, input: Record<string, unknown> | undefined, executeCommand: ExecuteCommand): Promise<unknown> {
  const tool = DECISION_TOOLS[name];
  if (!tool) throw new Error(`${name} is not one of SFlow's page tools.`);
  let result: unknown;
  try {
    tool.check?.(input);
    result = await executeCommand(tool.command, tool.check ? input : input ?? {});
  } catch (error) {
    const failure = error as Error & { result?: unknown };
    result = { status: 'blocked', recorded: null, message: failure.message, ...(failure.result ? { refusal: failure.result } : {}), ...(tool.onFailure ?? {}) };
  }
  return result ?? { status: 'blocked', recorded: null, message: tool.nothing };
}
