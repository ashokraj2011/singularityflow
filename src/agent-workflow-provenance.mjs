/**
 * Where a workflow made from a marketplace agent came from (docs/SPEC-MCR-MARKETPLACE-CONVERSION-REVIEW-v1.md §7), as one
 * record of `singularity/imports.lock.yml` that the workflow's bundle carries, so the reviewed import writes it:
 * - the marketplace, its repository and the commit read;
 * - the agent and its version;
 * - the SHA-256 of agent.md, of the agent's apm.yml and of each skill it attached;
 * - the person's answers (by step ID);
 * - the SFlow version that converted it.
 *
 * `imports check` compares it with the marketplace's newest commit (§8), and `workflow from-agent --update` converts again
 * with its answers. Pure, apart from hashing.
 */
import { createHash } from 'node:crypto';

export const WORKFLOW_IMPORT_KIND = 'workflow';
export const MARKETPLACE_AGENT_SOURCE = 'marketplace-agent';

const sha = (text) => createHash('sha256').update(String(text ?? ''), 'utf8').digest('hex');

/** The ledger key of the workflow `workflowId`, as importLedgerKey('workflow', { id }) makes it. */
export const workflowImportKey = (workflowId) => `${WORKFLOW_IMPORT_KIND}:${workflowId}`;

/** What an agent's workflow is made of, as digests: its agent.md, its apm.yml and every skill it uses, by name. */
export function sourcePieces(agent, skills = []) {
  return {
    agent: sha(agent?.text),
    manifest: agent?.manifestSha256 ?? null,
    skills: Object.fromEntries([...skills].filter((entry) => entry?.name).sort((left, right) => left.name.localeCompare(right.name))
      .map((entry) => [entry.name, sha(entry.text)]))
  };
}

/**
 * The record for a ready conversion of a marketplace agent, or null for one from a folder. `targetPath` is the agent
 * file the workflow carries and `agentText` its bytes as written, so `imports status` can tell when it was edited here.
 */
export function agentProvenance(conversion, { agent, skills = [], answers = {}, convertedBy, targetPath, agentText }) {
  const { source } = conversion;
  if (!source?.marketplace) return null;
  const pieces = sourcePieces(agent, skills);
  return {
    kind: WORKFLOW_IMPORT_KIND,
    source: {
      kind: MARKETPLACE_AGENT_SOURCE, marketplace: source.marketplace, repository: source.repository ?? null, commit: source.commit ?? null,
      agent: source.agent, version: source.version ?? null,
      answers: Object.fromEntries(Object.entries(answers ?? {}).sort(([left], [right]) => left.localeCompare(right)))
    },
    workflow: conversion.workflow.id,
    pieces,
    sha256: sha(JSON.stringify(pieces)),
    fileSha256: sha(agentText),
    convertedBy: convertedBy ?? null,
    target: { path: targetPath, id: conversion.agent.id }
  };
}

/** What changed between the pieces imported and the pieces at another commit: `{ agent, manifest, skills: { added, removed, changed }, unchanged }`. */
export function piecesDifferences(before, after) {
  const was = before?.skills ?? {};
  const now = after?.skills ?? {};
  const skills = {
    added: Object.keys(now).filter((name) => !(name in was)).sort(),
    removed: Object.keys(was).filter((name) => !(name in now)).sort(),
    changed: Object.keys(now).filter((name) => name in was && was[name] !== now[name]).sort()
  };
  const agent = (before?.agent ?? null) !== (after?.agent ?? null);
  // A manifest digest an older reader did not keep is no change.
  const manifest = Boolean(before?.manifest && after?.manifest && before.manifest !== after.manifest);
  return { agent, manifest, skills, unchanged: !agent && !manifest && !skills.added.length && !skills.removed.length && !skills.changed.length };
}

const list = (names) => (names.length <= 2 ? names.join(' and ') : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`);

/** What changed, in one sentence: "agent.md and skill web-xray-creation changed; skill x was added". */
export function differencesWords(difference) {
  if (difference.unchanged) return 'nothing it uses changed';
  const changed = [...(difference.agent ? ['agent.md'] : []), ...(difference.manifest ? ['its apm.yml'] : []),
    ...(difference.skills.changed.length ? [`skill${difference.skills.changed.length === 1 ? '' : 's'} ${list(difference.skills.changed)}`] : [])];
  return [
    changed.length ? `${list(changed)} changed` : null,
    difference.skills.added.length ? `skill${difference.skills.added.length === 1 ? '' : 's'} ${list(difference.skills.added)} ${difference.skills.added.length === 1 ? 'was' : 'were'} added` : null,
    difference.skills.removed.length ? `skill${difference.skills.removed.length === 1 ? '' : 's'} ${list(difference.skills.removed)} ${difference.skills.removed.length === 1 ? 'was' : 'were'} removed` : null
  ].filter(Boolean).join('; ');
}
