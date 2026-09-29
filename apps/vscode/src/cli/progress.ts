/**
 * Story start progress, as the engine reports it. `[perf]`
 *
 * A start takes seconds, and the notification used to say only "Starting story…" for all of them.
 * With `SINGULARITY_FLOW_PROGRESS=stderr-v1` the engine writes one line per start stage to stderr,
 * `@@sflow-progress/v1 <step>`, from a fixed vocabulary of stage names. The runner strips those lines
 * as they arrive, before stderr is shown or parsed as a refusal, and reports each step. Nothing but
 * a known stage name is ever read from them.
 */
const PROGRESS_LINE = /^@@sflow-progress\/v1 (start\.[a-z][a-z-]*)\r?$/u;

/** What each stage is doing, in words for the person waiting. Unknown stages are not shown. */
const START_PROGRESS_LABELS: Readonly<Record<string, string>> = Object.freeze({
  'start.intake-verification': 'Confirming the readiness check',
  'start.authority': 'Reading approved configuration',
  'start.configuration': 'Reading approved configuration',
  'start.fetch': 'Fetching the base branch',
  'start.worktree': 'Creating the Story checkout',
  'start.destination': 'Checking the Story branch name',
  'start.repository-preflight': 'Checking every repository',
  'start.reference-pins': 'Pinning reference repositories',
  'start.references': 'Copying reference repositories',
  'start.documents': 'Attaching documents',
  'start.readiness': 'Checking repository readiness',
  'start.authority-check': 'Confirming approved configuration',
  'start.enrollment': 'Enrolling your approval identity',
  'start.publication': 'Publishing the Story'
});

export function startProgressLabel(step: string): string | null {
  return Object.hasOwn(START_PROGRESS_LABELS, step) ? START_PROGRESS_LABELS[step]! : null;
}

/**
 * Separate progress lines from the rest of a stderr stream, chunk by chunk. A line split across
 * chunks is held until it is complete; anything that is not a progress line passes through as is.
 */
export class ProgressLineSplitter {
  private pending = '';
  private readonly onStep: (step: string) => void;

  constructor(onStep: (step: string) => void) {
    this.onStep = onStep;
  }

  push(text: string): string {
    const combined = this.pending + text;
    const lastNewline = combined.lastIndexOf('\n');
    if (lastNewline < 0) {
      this.pending = combined;
      return '';
    }
    this.pending = combined.slice(lastNewline + 1);
    return this.filter(combined.slice(0, lastNewline + 1));
  }

  end(): string {
    const rest = this.pending;
    this.pending = '';
    if (!rest) return '';
    const step = PROGRESS_LINE.exec(rest)?.[1];
    if (step) {
      this.report(step);
      return '';
    }
    return rest;
  }

  private filter(lines: string): string {
    let kept = '';
    for (const line of lines.split(/(?<=\n)/u)) {
      const step = PROGRESS_LINE.exec(line.replace(/\n$/u, ''))?.[1];
      if (step) this.report(step);
      else kept += line;
    }
    return kept;
  }

  private report(step: string): void {
    try { this.onStep(step); } catch { /* progress is advisory */ }
  }
}
