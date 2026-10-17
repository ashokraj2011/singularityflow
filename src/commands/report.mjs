import { readStoryState } from '../story-state-read.mjs';
import { readReportPreferences } from '../report-preferences.mjs';
import { withCommandConfirmation } from '../command-confirmation.mjs';
import { withCommandObservability } from '../command-observability.mjs';
import { TimingCollector, writeHumanTimings } from '../dx-timings.mjs';
import { repoRoot } from '../git.mjs';
import { deriveReport, renderHtml, renderMarkdown } from '../report.mjs';
import * as style from '../style.mjs';
import { SingularityFlowError, commandLineFile, optionBoolean, optionString, writeText } from '../util.mjs';
import { selectedPhaseArgument } from './shared/selected-phase-argument.mjs';

export async function run(argv, { positionals, options }) {
  return withCommandObservability(positionals[0], argv, options,
    () => withCommandConfirmation(options, () =>
      positionals[0] === 'review'
        ? reviewCommand(positionals, options)
        : reportCommand(positionals, options)));
}

/**
 * Describe a rendered document instead of printing it.
 *
 * Enough to know it is the right one and what to do with it: how big it is, how it starts, and the
 * flag that prints the rest. Used by the two commands that otherwise put a whole document on screen.
 */
export function summariseRendered(rendered, label) {
  const lines = String(rendered).split('\n');
  const heading = lines.find((line) => line.trim().startsWith('#'))?.replace(/^#+\s*/, '').trim();
  return [
    `${style.heading(label)} ${style.detail(style.fields(
      `${lines.length} lines`,
      `${Buffer.byteLength(rendered)} bytes`,
      heading ? `starts: ${heading}` : null
    ))}`,
    style.detail('Printed in full without --brief; redirect to a file with --out <path>.')
  ].join('\n');
}

export async function reportCommand(positionals, options) {
  const timingsEnabled = optionBoolean(options, 'timings');
  const timer = new TimingCollector({ enabled: timingsEnabled });
  const root = repoRoot();
  const workflow = await timer.measure(
    'story-record-read',
    () => readStoryState(root, positionals[1])
  );
  // `report --recap` is the same account the pull-request body carries, from the same beats. Kept on
  // `report` rather than given its own verb: it answers "what happened here", which is the question
  // report already exists to answer, and one surface is one thing to keep true.
  if (optionBoolean(options, 'recap')) {
    const { recap } = await import('../narration/recap.mjs');
    const length = optionString(options, 'length', 'standard');
    const account = recap(workflow, {
      length,
      locale: optionString(options, 'locale', 'en-GB'),
      timeZone: optionString(options, 'timezone', 'UTC')
    });
    return console.log(account || `No recorded beats for ${workflow.workItem.id} yet.`);
  }
  const format = optionString(options, 'format', 'md').toLowerCase();
  if (!['md', 'html', 'json'].includes(format)) throw new SingularityFlowError(`Unknown report format: ${format}. Use md, html, or json.`);
  const preferences = await readReportPreferences(root);
  const report = await timer.measure('derive', async () => deriveReport(workflow, preferences));
  let rendered = await timer.measure('render', async () => format === 'json'
    ? `${JSON.stringify(report, null, 2)}\n`
    : format === 'html' ? renderHtml(report) : renderMarkdown(report));
  const timings = timer.finish();
  if (format === 'json' && timings) {
    report.timings = timings;
    rendered = `${JSON.stringify(report, null, 2)}\n`;
  }
  const outputFile = optionString(options, 'out');
  if (outputFile) {
    const absolute = commandLineFile(root, outputFile);
    await writeText(absolute, rendered);
    console.log(`Report written to ${absolute}`);
    if (format !== 'json') writeHumanTimings(timings);
    return;
  }
  // stdout stays the default. The extension classifies `report` as a read precisely when `--out` is
  // absent and calls it that way, and `singularity-flow report > notes.md` is how everyone else uses
  // it — so `--brief` is opt-in rather than the other way round.
  if (optionBoolean(options, 'brief') && format !== 'json') {
    console.log(summariseRendered(rendered, `report for ${workflow.workItem.id}`));
    if (format !== 'json') writeHumanTimings(timings);
    return;
  }
  process.stdout.write(rendered);
  if (format !== 'json') writeHumanTimings(timings);
}

export async function reviewCommand(positionals, options) {
  const { loadAcceptedStoryExecution } = await import('../accepted-story-execution.mjs');
  const { createReviewBundle, reviewContinuationLines, reviewHtml, reviewMarkdown } = await import('../review.mjs');
  const root = repoRoot();
  const { config, workflow } = await loadAcceptedStoryExecution(root);
  const bundle = await createReviewBundle(root, config, workflow, selectedPhaseArgument(positionals, options, 'review'));
  const format = optionString(options, 'format', 'md').toLowerCase();
  if (!['md', 'html', 'json'].includes(format)) throw new SingularityFlowError('Review format must be md, html, or json.');
  const rendered = format === 'json' ? `${JSON.stringify(bundle, null, 2)}\n` : format === 'html' ? reviewHtml(bundle) : reviewMarkdown(bundle);
  const outputFile = optionString(options, 'out');
  if (outputFile) {
    const absolute = commandLineFile(root, outputFile); await writeText(absolute, rendered); console.log(`Review bundle written to ${absolute}\n${reviewContinuationLines(bundle.continuation).join('\n')}`); return;
  }
  // Same rule as `report`: stdout is the default because piping it is the common case and the
  // extension depends on it. `--brief` describes the bundle instead of printing it.
  if (optionBoolean(options, 'brief') && format !== 'json') {
    return console.log(`${summariseRendered(rendered, `review bundle for ${workflow.workItem.id}`)}\n${reviewContinuationLines(bundle.continuation).join('\n')}`);
  }
  process.stdout.write(rendered);
}

/** Same informational JSON derivation used by the CLI, without console capture. */
export async function readReport(root, workId = null) {
  const workflow = await readStoryState(root, workId);
  return deriveReport(workflow, await readReportPreferences(root));
}
