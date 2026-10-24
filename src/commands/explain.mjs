/**
 * `sflow explain` — the retrieval half of the grounded documentation layer.
 *
 * This command serves bytes. It does not summarise them, does not consult a model, and does not
 * need a repository: a global install with no clone anywhere must answer `[DOC:REQ-010]`. Everything
 * it returns carries the topic id, the topic version and the manifest's source commit, so a reply
 * built on it can be checked rather than trusted `[DOC:REQ-014]`.
 *
 * Handles. The spec asks for over-threshold topics to return a preview plus a handle that
 * `sflow show <handle> --section` expands `[DOC:REQ-011]`. The existing `sfref:` handles are
 * repository-scoped evidence records — registered, git-resolved, and explicitly an
 * "evidence-transport boundary" under NCL-002 — so a topic cannot be one without either dragging a
 * repository into a command that must work without one, or blurring that boundary. Topics get their
 * own namespace instead, `sfdoc:v1:<topic>:<sha12>`, resolved from the package. Same verb for the
 * reader, no confusion about what is governed evidence and what is documentation.
 */
import { resolveHelp } from '../help-service.mjs';
import { actionCommandLines, copilotAction } from '../copilot-guidance.mjs';
export { citationLine, docsHandle, parseDocsHandle, servedBody } from '../help-service.mjs';
import { citationLine, docsHandle, servedBody } from '../help-service.mjs';
import {
  explainClarificationResult, explainIndexResult, explainServedResult
} from '../gateway/planners/help-explain.mjs';
import { message } from '../gateway/messages.mjs';
import { markCommandFeedback } from '../dx-timing-context.mjs';
import { optionBoolean, optionNumber, optionString } from '../util.mjs';

async function recordResolutionMetric(resolution) {
  try {
    const [{ repoRoot }, { recordHelpMetric }] = await Promise.all([
      import('../git.mjs'), import('../help-metrics.mjs')
    ]);
    const root = repoRoot();
    await recordHelpMetric(root, {
      surface: 'cli',
      intent: resolution.helpIntent,
      outcome: resolution.status === 'resolved' || resolution.status === 'index'
        ? 'resolved' : resolution.status === 'not-found' ? 'no-match' : resolution.status,
      topicId: resolution.topic?.id ?? null,
      matchedBy: resolution.matchedBy,
      latencyMs: resolution.latencyMs,
      answerBytes: resolution.served?.bytes ?? 0,
      actionCategory: null
    });
  } catch {
    // Help remains available outside a repository and when observational storage is unavailable.
  }
}

/**
 * The situation half of `--here` `[DOC:REQ-020]`.
 *
 * Reuses the read model every other surface already reads. No new state query is invented for
 * documentation `[DOC:CON-007]`: a help command that learned to interrogate the repository its own
 * way would be a second opinion about lifecycle state, and the product has exactly one of those on
 * purpose.
 *
 * Returns null whenever anything is missing — no repository, no work item, an unreadable
 * configuration. `--here` degrades to the concept and never becomes an error `[DOC:BEH-001]`,
 * because a person asking "how do approvals work" has asked a question that has an answer whether
 * or not they happen to be standing in a story.
 */
async function situationHere() {
  let root;
  try {
    const { repoRoot } = await import('../git.mjs');
    root = repoRoot();
  } catch {
    // No repository. The overwhelmingly common case, and the only one that is not a defect.
    return { resolved: false, reason: 'no-repository' };
  }

  // Everything past this point is a real read that is *expected* to work, so its failure is
  // reported rather than swallowed. The first version of this function caught everything and asked
  // for a snapshot slice named `workflow`, which does not exist — the slice is `lifecycle`. The
  // catch turned that into "no work item resolves here", the degradation looked correct in every
  // test, and the state plane had never once rendered. Degrading silently is how a feature ships
  // dead.
  try {
    const { SnapshotCoordinator } = await import('../snapshot-coordinator.mjs');
    const { repositorySnapshot } = await import('../editor.mjs');
    const snapshot = await new SnapshotCoordinator(root).capture(
      ({ included, revision }) => repositorySnapshot(root, undefined, undefined, {
        included,
        revision
      }),
      { included: ['lifecycle'], consistency: 'best-effort' }
    );
    const workflow = snapshot?.lifecycle?.workflow;
    const item = workflow?.workItem;
    if (!item?.id) return { resolved: false, reason: 'no-work-item' };

    const phase = workflow.phases?.[workflow.currentPhase] ?? null;
    const rail = workflow.phaseOrder ?? [];
    const position = rail.indexOf(workflow.currentPhase);
    return {
      resolved: true,
      subject: item.id,
      title: item.title ?? null,
      phase: workflow.currentPhase ?? null,
      status: phase?.status ?? workflow.status ?? null,
      revision: snapshot.revision?.head ?? null,
      branch: snapshot.revision?.branch ?? null,
      lines: [
        `${item.id}${item.title ? ` — ${item.title}` : ''} is at ${workflow.currentPhase ?? 'an unnamed phase'}`
        + `${phase?.status ? ` (${phase.status})` : ''}.`,
        ...(rail.length
          ? [`Phase ${position >= 0 ? position + 1 : '?'} of ${rail.length} on its pinned rail: ${rail.join(' → ')}.`]
          : [])
      ]
    };
  } catch (error) {
    return { resolved: false, reason: 'unreadable', detail: error.message };
  }
}

export async function run(argv, {
  positionals, options, operation: suppliedOperation = null
} = { positionals: [], options: new Map(), operation: null }) {
  // An explicit subject selects the repository-bound XPL2 route. It is checked first so that
  // `explain code --subject ...` or `explain <topic> --subject ...` is refused instead of one of
  // the two older routes silently ignoring the option [XPL2-REQ-002].
  if (optionString(options, 'subject') != null) {
    const { runExplanationSubject } = await import('../comprehension/xpl2/command.mjs');
    return runExplanationSubject(argv, { positionals, options, operation: suppliedOperation });
  }
  if (positionals[1] === 'code') {
    const { runCodeExplanation } = await import('../comprehension/code-explanation-command.mjs');
    return runCodeExplanation(argv, { positionals, options, operation: suppliedOperation });
  }
  const json = optionBoolean(options, 'json');
  const query = positionals[1];
  const resolution = await resolveHelp(query, {
    maxBytes: optionNumber(options, 'max-bytes'),
    section: optionString(options, 'section')
  });
  await recordResolutionMetric(resolution);

  if (resolution.status === 'index') return emitList(resolution.topics, resolution, { json });

  if (resolution.status === 'ambiguous' || resolution.status === 'not-found') {
    // Never a guess `[DOC:CON-006]`, and never a dead end `[DOC:REQ-013]`: the candidates are the answer.
    emit(explainClarificationResult(resolution), { json });
    // A refusal is a refusal at the shell too: a script that pipes `explain` must be able to tell
    // "here is the topic" from "there is no such topic" without parsing the prose.
    process.exitCode = 2;
    return {};
  }

  const provenance = resolution.provenance;
  const served = resolution.served;

  const wantsHere = optionBoolean(options, 'here');
  const situation = wantsHere ? await situationHere() : null;
  const here = situation?.resolved ? situation : null;
  const result = explainServedResult(resolution, { wantsHere, here, situation });

  if (json) return emit(result, { json: true });
  // Text form leads with the bytes, because that is what was asked for, and closes with the
  // citation on its own line so a reader — or a checker — can find it without parsing prose.
  console.log('Concept');
  console.log(served.text);
  if (served.truncated) {
    console.log(`\n[truncated at ${served.bytes} bytes]`);
    for (const line of actionCommandLines(copilotAction({
      command: `sflow show ${served.handle} --section <heading>`
    }), 'Expand')) console.log(line);
  }
  console.log(citationLine(provenance));
  if (here) {
    console.log('\nHere');
    for (const line of here.lines) console.log(line);
    // The state plane cites a revision, never a topic version. That is the whole point of keeping
    // the two labelled `[DOC:REQ-022]`: a reader can tell which sentence came from which plane.
    console.log(`— ${here.subject} at revision ${here.revision ? here.revision.slice(0, 7) : 'unknown'}`);
  } else if (wantsHere) {
    console.log(`\nHere\n${situation?.reason === 'unreadable'
      ? `The lifecycle could not be read here (${situation.detail}), so only the concept is shown.`
      : 'No work item resolves in this directory, so only the concept is shown.'}`);
  }
  emit(result, { json: false, headline: false });
  return {};
}

/**
 * One output boundary for the v2 envelope. `[INT:IFC-020]`
 *
 * JSON is the result itself. Text is the catalogued headline and reasons, then each offered action
 * with its terminal route — the same four channels a host renders, in the order a reader needs them.
 */
function emit(result, { json, headline = true }) {
  markCommandFeedback();
  if (json) {
    console.log(JSON.stringify(result, null, 2));
    return {};
  }
  const lines = [];
  if (headline) lines.push(message(result.outcome.messageId, result.outcome.slots).label);
  for (const reason of result.why) {
    if (reason.code !== 'explain.cited' && reason.code !== 'explain.index') lines.push(`- ${message(reason.code, reason.slots).label}`);
  }
  if (result.next.length) {
    lines.push('', 'Next:');
    for (const action of result.next) lines.push(`  ${action.label}${action.fallback?.command ? `  (${action.fallback.command})` : ''}`);
  }
  if (lines.length) console.log(lines.join('\n'));
  return {};
}

/** With no argument, `explain` is the table of contents. */
function emitList(topics, resolution, { json }) {
  const result = explainIndexResult(topics, resolution.provenance);
  if (json) return emit(result, { json: true });
  const width = Math.max(...topics.map((topic) => topic.id.length));
  for (const topic of topics) console.log(`  ${topic.id.padEnd(width)}  ${topic.title}`);
  return emit(result, { json: false, headline: false });
}
