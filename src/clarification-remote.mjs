/**
 * Clarification answers from another clone (2026-10-28).
 *
 * A step's clarification answers are decided by its approvers, but they were recorded only in the
 * author's checkout: the record binds that checkout's composed prompt and reaches the Story with
 * that checkout's publication. An approver on another machine had to borrow the author's checkout
 * under a swapped Git identity. Now the approver answers in their own clone, in their own terminal
 * (`clarification answer`): the answer is one small commit, never on the Story branch, pushed
 * create-only to `refs/sflow-clarifications/<WORK-ID>/<STEP>/gen<N>/<QUESTION>` with them as its
 * committer. The author's `clarification import` fetches those refs and records each answer that
 * still binds this step and generation, whose committer is the person it names and a member of the
 * step's approval groups, into the author's own record (bound to the author's composed prompt, as
 * a typed answer is). Nothing else is trusted from the packet.
 */
import { createHash } from 'node:crypto';
import { requireApprovalAuthority } from './kernel/approval-policy.mjs';
import { runRemoteGitAsync } from './git-execution.mjs';
import { nextPhaseGeneration } from './kernel/phase-policy.mjs';
import { nowIso, run, SingularityFlowError } from './util.mjs';

export const ANSWER_PACKET_KIND = 'clarification-answer';
const FILE = 'answer.json';
const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const normalized = (question) => String(question ?? '').trim().replace(/\s+/gu, ' ');

/** The ref family one step generation's remote answers live under. */
export function answerRefPrefix(workId, phaseId, generation) {
  return `refs/sflow-clarifications/${workId}/${phaseId}/gen${generation}`;
}

function git(root, args, input) {
  const result = run('git', args, { cwd: root, allowFailure: true, ...(input === undefined ? {} : { input }) });
  return result.status === 0 ? result.stdout.trim() : null;
}

/** Who may answer this step's questions: its approval groups, as `clarification record` checks. */
function answerAuthority(definition, workflow, phase, actor) {
  const policy = phase.approvalPolicy;
  if ((policy?.mode ?? 'required') === 'none' || !(policy?.authorities ?? []).length) {
    throw new SingularityFlowError(`Phase '${phase.id}' has no approval group, so its author answers its questions in their own checkout with singularity-flow clarification record.`,
      { code: 'CLARIFICATION_REMOTE_NOT_NEEDED', details: { phase: phase.id } });
  }
  return requireApprovalAuthority(workflow.resolution?.approvalAuthorities ?? definition.approvalAuthorities, policy, actor);
}

/**
 * Publish one answer from this clone. `actor` is this clone's Git identity, which is also the
 * packet commit's committer. Create-only: an answer is never replaced remotely; a different one
 * is recorded by the author with --replace after review.
 */
export async function publishClarificationAnswer(root, definition, workflow, phase, {
  question, marker = null, answer, why = null, actor, remote = definition.git?.remote ?? 'origin'
}) {
  const text = normalized(question ?? marker);
  if (!text || !String(answer ?? '').trim()) {
    throw new SingularityFlowError('clarification answer needs --question (or --marker) and --answer.', { code: 'CLARIFICATION_ANSWER_INVALID' });
  }
  const authority = answerAuthority(definition, workflow, phase, actor);
  const generation = nextPhaseGeneration(phase);
  const questionSha256 = sha256(text);
  const packet = {
    kind: ANSWER_PACKET_KIND, version: 1, workId: workflow.workItem.id, phase: phase.id, generation,
    question: text, questionSha256, ...(marker ? { marker: normalized(marker) } : {}),
    answer: String(answer).trim(), ...(why ? { why: String(why).trim() } : {}),
    answeredBy: { name: actor?.name ?? null, email: actor?.email ?? null },
    authorityGroup: authority.authorityGroup ?? null, identityAssurance: authority.identityAssurance ?? null, at: nowIso()
  };
  const blob = git(root, ['hash-object', '-w', '--stdin'], `${JSON.stringify(packet, null, 2)}\n`);
  const tree = blob ? git(root, ['mktree'], `100644 blob ${blob}\t${FILE}\n`) : null;
  const commit = tree ? git(root, ['commit-tree', tree, '-m', `[${packet.workId}][clarification:${phase.id}] answer ${questionSha256.slice(0, 12)}`]) : null;
  if (!commit) throw new SingularityFlowError('The answer could not be written as a Git object here. Nothing was sent.', { code: 'CLARIFICATION_ANSWER_WRITE_FAILED' });
  const ref = `${answerRefPrefix(packet.workId, phase.id, generation)}/${questionSha256.slice(0, 16)}`;
  const pushed = await runRemoteGitAsync(['push', '--porcelain', `--force-with-lease=${ref}:`, remote, `${commit}:${ref}`],
    { cwd: root, operation: 'remote-push' });
  if (pushed.status !== 0) {
    throw new SingularityFlowError(`The answer was not sent to ${remote}: ${String(pushed.stderr || pushed.stdout).trim().split('\n').at(-1) ?? 'push failed'}. `
      + 'An answer to this question may already be there; the author reviews it with singularity-flow clarification import.',
    { code: 'CLARIFICATION_ANSWER_NOT_SENT', details: { ref, commit } });
  }
  return { packet, commit, ref, remote };
}

function readPacket(root, commit) {
  const entries = git(root, ['ls-tree', '--name-only', commit]);
  if (entries !== FILE) return { problem: 'it holds more than one answer file' };
  let packet;
  try { packet = JSON.parse(git(root, ['cat-file', 'blob', `${commit}:${FILE}`]) ?? ''); } catch { return { problem: 'its answer is not readable' }; }
  const [name, email] = (git(root, ['log', '-1', '--format=%cn%x00%ce', commit]) ?? '').split('\0');
  return { packet, committer: { name, email } };
}

/**
 * Fetch this step generation's remote answers and return the ones that bind it, as responses for
 * recordClarificationResponses, with the person who answered each. Refused packets are named.
 */
export async function remoteClarificationAnswers(root, definition, workflow, phase, { remote = definition.git?.remote ?? 'origin' } = {}) {
  const generation = nextPhaseGeneration(phase);
  const prefix = answerRefPrefix(workflow.workItem.id, phase.id, generation);
  const fetched = await runRemoteGitAsync(['fetch', '--no-tags', remote, `+${prefix}/*:${prefix}/*`],
    { cwd: root, operation: 'remote-configuration' });
  if (fetched.status !== 0) {
    throw new SingularityFlowError(`Answers could not be fetched from ${remote}: ${String(fetched.stderr).trim().split('\n').at(-1) ?? 'fetch failed'}.`,
      { code: 'CLARIFICATION_ANSWERS_UNAVAILABLE' });
  }
  const refs = (git(root, ['for-each-ref', '--format=%(objectname) %(refname)', `${prefix}/`]) ?? '').split('\n').filter(Boolean);
  const accepted = [];
  const refused = [];
  for (const line of refs) {
    const [commit, ref] = line.split(' ');
    const { packet, committer, problem } = readPacket(root, commit);
    const refuse = (why) => refused.push({ ref, commit, why });
    if (problem) { refuse(problem); continue; }
    if (packet?.kind !== ANSWER_PACKET_KIND || packet.workId !== workflow.workItem.id || packet.phase !== phase.id
        || Number(packet.generation) !== generation) { refuse(`it answers another Story, step or generation`); continue; }
    if (packet.questionSha256 !== sha256(normalized(packet.question)) || !ref.endsWith(`/${packet.questionSha256.slice(0, 16)}`)) {
      refuse('its question does not match its digest'); continue;
    }
    if (!committer.email || committer.email.toLowerCase() !== String(packet.answeredBy?.email ?? '').toLowerCase()) {
      refuse(`it was committed by ${committer.email || 'nobody'}, not by the person it names`); continue;
    }
    let authority;
    try { authority = answerAuthority(definition, workflow, phase, committer); }
    catch (error) { refuse(`${committer.email} is not in ${phase.id}'s approval groups: ${error.message}`); continue; }
    accepted.push({
      actor: committer, commit, ref, authorityGroup: authority.authorityGroup ?? null,
      response: {
        question: packet.question, answer: packet.answer, ...(packet.why ? { why: packet.why } : {}),
        ...(packet.marker ? { marker: packet.marker } : {}), status: 'answered',
        owner: `${committer.name || committer.email} <${committer.email}> (answered in another clone, ${commit.slice(0, 12)})`
      }
    });
  }
  return { generation, prefix, accepted, refused };
}
