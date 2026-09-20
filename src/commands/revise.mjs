/** Public entry point for one exact interactive REV interval. */
import { repoRoot } from '../git.mjs';
import {
  action as nextAction, commandResult, effects, noEffects, noop, succeeded
} from '../narration/command-result.mjs';
import { emitCommandResult } from '../narration/emit.mjs';
import {
  confirmInteractiveRevision, previewInteractiveRevision, replayInteractiveRevisionConfirmation
} from '../revision/interactive-service.mjs';
import {
  optionBoolean, optionString, optionStrings, SingularityFlowError
} from '../util.mjs';

const MAXIMUM_FEEDBACK_BYTES = 8192;

function refuse(code, message) {
  throw new SingularityFlowError(message, { code });
}

async function feedbackFromStdin(options, input = process.stdin) {
  if (!optionBoolean(options, 'feedback-stdin')) {
    refuse('REV_FEEDBACK_STDIN_REQUIRED',
      'Pass revision feedback with --feedback-stdin so it does not enter argv, environment variables, or repository files.');
  }
  if (input.isTTY) {
    refuse('REV_FEEDBACK_STDIN_REQUIRED', 'Pipe bounded UTF-8 revision feedback into --feedback-stdin.');
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of input) {
    const bytes = Buffer.from(chunk);
    size += bytes.length;
    if (size > MAXIMUM_FEEDBACK_BYTES) {
      refuse('REV_FEEDBACK_TOO_LARGE', `Revision feedback exceeds ${MAXIMUM_FEEDBACK_BYTES} bytes.`);
    }
    chunks.push(bytes);
  }
  let text;
  try {
    text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })
      .decode(Buffer.concat(chunks));
  } catch {
    refuse('REV_FEEDBACK_INVALID', 'Revision feedback must be valid UTF-8.');
  }
  if (!text.trim()) refuse('REV_FEEDBACK_EMPTY', 'Revision feedback is empty.');
  return text;
}

function request(options, feedbackText) {
  return {
    feedbackText,
    criteria: optionStrings(options, 'criteria'),
    disposition: optionString(options, 'disposition') ?? null,
    attachmentSetSha256: optionString(options, 'attachment-set') ?? null,
    savedBuffersConfirmed: optionBoolean(options, 'saved-buffers-confirmed')
  };
}

function shellQuote(value) {
  return `'${String(value).replace(/'/gu, `'"'"'`)}'`;
}

function selectorCommand(options) {
  return [
    ...optionStrings(options, 'criteria').flatMap((value) => ['--criteria', shellQuote(value)]),
    ...(optionString(options, 'disposition')
      ? ['--disposition', shellQuote(optionString(options, 'disposition'))] : []),
    ...(optionString(options, 'attachment-set')
      ? ['--attachment-set', shellQuote(optionString(options, 'attachment-set'))] : []),
    ...(optionBoolean(options, 'saved-buffers-confirmed') ? ['--saved-buffers-confirmed'] : [])
  ].join(' ');
}

function emit(operation, plan, result, options, { preview }) {
  const subject = { kind: 'story', id: plan.subject.workId };
  const replayed = result?.replayed === true;
  const recoveredConfirmationResult = result?.recoveredConfirmationResult === true;
  const outcome = preview
    ? succeeded('revise.previewed', {
      planSha256: plan.planSha256, disposition: plan.disposition.result
    })
    : (replayed && !recoveredConfirmationResult ? noop : succeeded)(
      recoveredConfirmationResult ? 'revise.confirmation-recovered'
        : replayed ? 'revise.already-opened' : 'revise.opened', {
      loopId: result.state.loopId, status: result.state.status
    });
  const declaredEffects = preview || (replayed && !recoveredConfirmationResult)
    ? noEffects()
    : effects({ stateChanged: true, filesChanged: false });
  const next = preview && plan.status === 'ready' ? [nextAction({
    id: 'revise.apply',
    label: 'Confirm this exact revision plan with the same feedback bytes and selectors',
    command: `singularity-flow revise --feedback-stdin ${selectorCommand(options)} --confirm ${plan.planSha256}`
      .replace(/\s+/gu, ' ').trim(),
    skill: 'sf-revise', kind: 'review'
  })] : preview ? [nextAction({
    id: 'revise.route-review',
    label: 'Review the exact routing field in this preview; this command only re-evaluates the repository current next step',
    command: 'singularity-flow recommend --json',
    skill: 'sf-recommend', kind: 'diagnostic'
  })] : result?.state?.status === 'awaiting-edit' ? [nextAction({
    id: 'revision.capture.preview',
    label: 'After saving the bounded implementation edits, preview their exact capture',
    command: 'singularity-flow revision capture --preview --note <CHANGE-NOTE> --saved-buffers-confirmed',
    skill: 'sf-revise', kind: 'review'
  })] : [];
  const safeResult = result ? {
    replayed: result.replayed === true,
    recoveredConfirmationResult,
    state: result.state,
    packetSha256: result.packet?.packetSha256 ?? result.state?.packetSha256 ?? null,
    records: result.records ?? [],
    next: result.next ?? null
  } : null;
  return emitCommandResult(commandResult({
    operation, subject, outcome, effects: declaredEffects, next,
    restState: next.length ? null : 'informational',
    // Feedback and attachment renditions stay in the private content-addressed stores. Command
    // output carries only their hashes and bounded state projection, never the original bytes.
    data: preview ? { plan } : { plan, ...safeResult }
  }), {
    json: optionBoolean(options, 'json'), restStateWhenIdle: 'informational'
  });
}

export async function run(_argv, { positionals, options = {} } = {}) {
  if (positionals?.length !== 1) {
    refuse('UNKNOWN_SUBCOMMAND',
      'Use: singularity-flow revise --dry-run --feedback-stdin --saved-buffers-confirmed, then repeat with the same input and --confirm <plan-sha256>.');
  }
  if (Object.hasOwn(options, 'feedback')) {
    refuse('REV_FEEDBACK_STDIN_REQUIRED',
      'The revise command accepts private feedback only through --feedback-stdin.');
  }
  const preview = optionBoolean(options, 'dry-run');
  const confirmation = optionString(options, 'confirm');
  if (preview && confirmation != null) {
    refuse('REV_CONFIRMATION_CONFLICT', '--dry-run cannot be combined with --confirm.');
  }
  if (!preview && confirmation == null) {
    refuse('REV_CONFIRMATION_REQUIRED',
      'Preview first with --dry-run, then repeat the same feedback and selectors with --confirm <plan-sha256>.');
  }
  const feedbackText = await feedbackFromStdin(options);
  const selected = request(options, feedbackText);
  const root = repoRoot();
  if (!preview && confirmation != null) {
    const replay = await replayInteractiveRevisionConfirmation(root, {
      confirmation, ...selected
    });
    if (replay) {
      return emit({ id: 'revise.apply', classification: 'mutation' }, replay.plan,
        replay, options, { preview: false });
    }
  }
  const plan = await previewInteractiveRevision(root, selected);
  if (preview) {
    return emit({ id: 'revise.preview', classification: 'read' }, plan, null, options,
      { preview: true });
  }
  const result = await confirmInteractiveRevision(root, {
    plan, confirmation, ...selected
  });
  return emit({ id: 'revise.apply', classification: 'mutation' }, plan, result, options,
    { preview: false });
}

export const reviseCliLimits = Object.freeze({ maximumFeedbackBytes: MAXIMUM_FEEDBACK_BYTES });
