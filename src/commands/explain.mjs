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
export { citationLine, docsHandle, parseDocsHandle, servedBody } from '../help-service.mjs';
import { citationLine, docsHandle, servedBody } from '../help-service.mjs';
import {
  action, because, commandResult, noEffects, refused, succeeded
} from '../narration/command-result.mjs';
import { emitCommandResult } from '../narration/emit.mjs';
import { operationById } from '../command-registry.mjs';
import { optionBoolean, optionNumber, optionString } from '../util.mjs';

const OPERATION = 'explain';

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
      ({ included }) => repositorySnapshot(root, undefined, undefined, { included }),
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

export async function run(argv, { positionals, options } = { positionals: [], options: new Map() }) {
  const operation = operationById(OPERATION);
  const json = optionBoolean(options, 'json');
  const query = positionals[1];
  const resolution = await resolveHelp(query, {
    maxBytes: optionNumber(options, 'max-bytes'),
    section: optionString(options, 'section')
  });
  await recordResolutionMetric(resolution);

  if (resolution.status === 'index') return emitList(resolution.topics, resolution, { json, operation });

  const helpIntent = resolution.helpIntent;

  if (resolution.status === 'ambiguous') {
    // Never a guess `[DOC:CON-006]`. The candidates are the answer.
    const result = commandResult({
      operation,
      outcome: refused('docs.topic-ambiguous', { query: resolution.query, count: resolution.candidates.length }),
      effects: noEffects(),
      why: [because('docs.prefix-ambiguous', 'docs',
        { ref: 'docs/topics', slots: { query: resolution.query, count: resolution.candidates.length } })],
      next: resolution.candidates.slice(0, 5).map((topic) => action({
        id: `explain.${topic.id}`, label: `Read ${topic.id}`, command: `sflow explain ${topic.id}`, kind: 'informational'
      })),
      data: { query: resolution.query, candidates: resolution.candidates.map((topic) => topic.id), helpIntent }
    });
    emitCommandResult(result, { json, restStateWhenIdle: null });
    // A refusal is a refusal at the shell too: a script that pipes `explain` must be able to tell
    // "here is the topic" from "there is no such topic" without parsing the prose.
    process.exitCode = 2;
    return {};
  }

  if (resolution.status === 'not-found') {
    // The no-dead-ends rule binds here as everywhere `[DOC:REQ-013]`: even "I don't have that" has
    // to leave the reader somewhere they can go.
    const fallback = resolution.candidates.map((topic) => topic.id);
    const result = commandResult({
      operation,
      outcome: refused('docs.topic-not-found', { query: resolution.query }),
      effects: noEffects(),
      why: [because('docs.no-such-topic', 'docs',
        { ref: 'docs/topics', slots: { query: resolution.query }, topic: 'help-and-docs' })],
      next: [
        ...fallback.map((id) => action({
          id: `explain.${id}`, label: `Read ${id}`, command: `sflow explain ${id}`, kind: 'informational'
        })),
        action({ id: 'explain.list', label: 'List every topic', command: 'sflow explain', rank: 'LATER', kind: 'informational' })
      ],
      data: { query: resolution.query, nearest: fallback, helpIntent }
    });
    emitCommandResult(result, { json, restStateWhenIdle: null });
    // A refusal is a refusal at the shell too: a script that pipes `explain` must be able to tell
    // "here is the topic" from "there is no such topic" without parsing the prose.
    process.exitCode = 2;
    return {};
  }

  const topic = resolution.topic;
  const provenance = resolution.provenance;
  const served = resolution.served;

  const wantsHere = optionBoolean(options, 'here');
  const situation = wantsHere ? await situationHere() : null;
  const here = situation?.resolved ? situation : null;

  // A topic that names no related reading is a genuine rest state, not a dead end: the reader asked
  // a question and got the whole answer.
  const related = resolution.related.map((entry) => action({
    id: `explain.${entry.id}`,
    label: `Read ${entry.id}`,
    command: `sflow explain ${entry.id}`,
    rank: 'LATER',
    kind: 'informational'
  }));
  const result = commandResult({
    operation,
    outcome: here
      ? succeeded('docs.served-with-state', {
        topic: topic.id, title: topic.title, version: topic.version, subject: here.subject
      })
      : succeeded('docs.served', { topic: topic.id, title: topic.title, version: topic.version }),
    effects: noEffects(),
    // Degrading is explained, not silent: the reader asked for their situation and did not get it.
    why: wantsHere && !here
      ? [because('docs.subject-unresolved', 'docs', { ref: 'docs/topics' })]
      : [],
    next: related,
    restState: related.length ? null : 'informational',
    data: {
      resolvedBy: resolution.matchedBy,
      helpIntent,
      provenance,
      citation: citationLine(provenance),
      topic: {
        id: topic.id, title: topic.title, version: topic.version, sha256: topic.sha256,
        commands: [...topic.commands], related: [...topic.related], aliases: [...topic.aliases]
      },
      served: {
        text: served.text, bytes: served.bytes, truncated: served.truncated,
        sha256: served.sha256, handle: served.handle
      },
      // Two planes, two citations, never blended `[DOC:REQ-022]`. The concept cites a topic version;
      // the situation cites a revision. A reader can always tell which sentence came from where.
      here: here
        ? {
          plane: 'state', subject: here.subject, phase: here.phase, status: here.status,
          revision: here.revision, branch: here.branch, lines: here.lines
        }
        : null,
      // Why the state plane is absent, when it was asked for. `unreadable` is not the same as "you
      // are not in a story", and collapsing the two is what hid this feature being dead.
      hereUnavailable: wantsHere && !here
        ? { reason: situation?.reason ?? 'unknown', detail: situation?.detail ?? null }
        : null
    }
  });

  if (json) {
    emitCommandResult(result, { json: true });
  } else {
    // Text form leads with the bytes, because that is what was asked for, and closes with the
    // citation on its own line so a reader — or a checker — can find it without parsing prose.
    console.log('Concept');
    console.log(served.text);
    if (served.truncated) {
      console.log(`\n[truncated at ${served.bytes} bytes — expand with: sflow show ${served.handle} --section <heading>]`);
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
    emitCommandResult(result, { json: false, restStateWhenIdle: null });
  }
  return {};
}

/** With no argument, `explain` is the table of contents. */
function emitList(topics, resolution, { json, operation }) {
  const result = commandResult({
    operation,
    outcome: succeeded('docs.served', { topic: 'index', title: 'Documentation topics', version: 1 }),
    effects: noEffects(),
    next: topics.slice(0, 3).map((topic) => action({
      id: `explain.${topic.id}`, label: `Read ${topic.id}`, command: `sflow explain ${topic.id}`, kind: 'informational'
    })),
    data: {
      provenance: {
        topic: 'index', topicVersion: 1,
        docsSourceCommit: resolution.provenance?.docsSourceCommit ?? null,
        docsContentSha256: resolution.provenance?.docsContentSha256 ?? null
      },
      topics: topics.map((topic) => ({ id: topic.id, title: topic.title, version: topic.version }))
    }
  });
  if (json) {
    emitCommandResult(result, { json: true });
  } else {
    const width = Math.max(...topics.map((topic) => topic.id.length));
    for (const topic of topics) console.log(`  ${topic.id.padEnd(width)}  ${topic.title}`);
    emitCommandResult(result, { json: false });
  }
  return {};
}
