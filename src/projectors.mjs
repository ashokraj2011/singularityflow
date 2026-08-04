import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { canonicalJson, LEDGER_INTENT_DIRECTORY } from './ledger.mjs';
import {
  approvalPath, artifactMetadataBlock, statusPath, storyArtifactMetadata,
  storyStatusMarkdown, workDir, workDirRelative
} from './state.mjs';
import {
  initiativeDir, initiativeRelative, initiativeStatusMarkdown
} from './initiative-state.mjs';
import {
  initiativeApprovalSummary, readInitiativeRecords
} from './initiative-evidence.mjs';
import { exists, repoRelative, SingularityFlowError, writeAtomic } from './util.mjs';

const STORY_METADATA = /^<!-- singularity-flow:metadata\n[\s\S]*?\n-->/;
const INITIATIVE_METADATA = /^<!-- singularity-flow:initiative-metadata\n[\s\S]*?\n-->/;

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function json(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function normalizePath(value) {
  return value.split(path.sep).join('/');
}

function assertSubjectPath(root, subjectDirectory, candidate, label) {
  const relative = repoRelative(root, candidate);
  const subjectRelative = normalizePath(path.relative(root, subjectDirectory));
  if (relative !== subjectRelative && !relative.startsWith(`${subjectRelative}/`)) {
    throw new SingularityFlowError(`${label} escapes the governed subject directory: ${relative}.`);
  }
  return relative;
}

function projection({ id, kind, relativePath, content, source }) {
  return { id, kind, path: relativePath, content, source, repairable: true };
}

async function replaceManagedBlock(file, pattern, block) {
  if (!(await exists(file))) return null;
  const authored = await readFile(file, 'utf8');
  return pattern.test(authored) ? authored.replace(pattern, block) : `${block}\n\n${authored}`;
}

export function projectStatusMarkdown(kind, aggregate) {
  return kind === 'story' ? storyStatusMarkdown(aggregate) : initiativeStatusMarkdown(aggregate);
}

export async function projectArtifactMetadata(root, {
  kind,
  aggregate,
  definition,
  portfolio
}) {
  const specs = [];
  if (kind === 'story') {
    const directory = workDir(root, definition, aggregate.workItem.id);
    for (const phaseId of aggregate.phaseOrder) {
      const phase = aggregate.phases[phaseId];
      const file = path.join(directory, phase.requiredArtifact.path);
      const block = artifactMetadataBlock(storyArtifactMetadata(aggregate, phase));
      const content = await replaceManagedBlock(file, STORY_METADATA, block);
      if (content == null) continue;
      specs.push(projection({
        id: `artifact-metadata:${phaseId}`,
        kind: 'ArtifactMetadata',
        relativePath: assertSubjectPath(root, directory, file, `Story artifact metadata '${phaseId}'`),
        content,
        source: 'workflow.json'
      }));
    }
    return specs;
  }
  const directory = initiativeDir(root, portfolio, aggregate.initiative.id);
  for (const phaseId of aggregate.phaseOrder) {
    const phase = aggregate.phases[phaseId];
    for (const output of Object.values(phase.outputs ?? {})) {
      if (!output.projectionMetadata) continue;
      const file = path.join(directory, output.path);
      const block = `<!-- singularity-flow:initiative-metadata\n${JSON.stringify(output.projectionMetadata, null, 2)}\n-->`;
      const content = await replaceManagedBlock(file, INITIATIVE_METADATA, block);
      if (content == null) continue;
      specs.push(projection({
        id: `artifact-metadata:${phaseId}/${output.id}`,
        kind: 'ArtifactMetadata',
        relativePath: assertSubjectPath(root, directory, file, `Initiative artifact metadata '${phaseId}/${output.id}'`),
        content,
        source: 'state.json'
      }));
    }
  }
  return specs;
}

export async function projectApprovalSummary(root, {
  kind,
  aggregate,
  definition,
  portfolio
}) {
  const specs = [];
  if (kind === 'story') {
    const directory = workDir(root, definition, aggregate.workItem.id);
    for (const phaseId of aggregate.phaseOrder) {
      const phase = aggregate.phases[phaseId];
      const file = approvalPath(root, definition, aggregate.workItem.id, phaseId);
      if (!(phase.approvals?.length) && !(await exists(file))) continue;
      specs.push(projection({
        id: `approval-summary:${phaseId}`,
        kind: 'ApprovalSummary',
        relativePath: assertSubjectPath(root, directory, file, `Story approval summary '${phaseId}'`),
        content: json({ schemaVersion: 2, phase: phaseId, decisions: phase.approvals ?? [] }),
        source: 'workflow.json'
      }));
    }
    return specs;
  }
  const records = await readInitiativeRecords(root, portfolio, aggregate.initiative.id, 'approvals');
  const directory = initiativeDir(root, portfolio, aggregate.initiative.id);
  const file = path.join(directory, 'approvals', 'SUMMARY.json');
  if (!records.length && !(await exists(file))) return specs;
  specs.push(projection({
    id: 'approval-summary',
    kind: 'ApprovalSummary',
    relativePath: assertSubjectPath(root, directory, file, 'Initiative approval summary'),
    content: canonicalJson(initiativeApprovalSummary(aggregate.initiative.id, records)),
    source: 'immutable approval records'
  }));
  return specs;
}

function packetSpec(root, directory, record, category) {
  if (!record?.projection || !record?.packetSha256 || !record?.path) return null;
  const packetHash = sha256(JSON.stringify(record.projection));
  if (packetHash !== record.packetSha256) {
    throw new SingularityFlowError(`${category} projection recipe does not match ${record.packetSha256}.`);
  }
  return projection({
    id: `${category.toLowerCase()}:${record.packetSha256}`,
    kind: 'ReviewPacket',
    relativePath: assertSubjectPath(root, directory, path.join(root, record.path), category),
    content: json({ ...record.projection, packetSha256: record.packetSha256 }),
    source: 'workflow.json lineage recipe'
  });
}

export function projectReviewPacket(root, { kind, aggregate, definition }) {
  if (kind !== 'story') return [];
  const directory = workDir(root, definition, aggregate.workItem.id);
  return [
    ...(aggregate.lineage?.submissions ?? []).map((record) => packetSpec(root, directory, record, 'ReviewPacket')),
    ...(aggregate.lineage?.finalizations ?? []).map((record) => packetSpec(root, directory, record, 'FinalizationPacket'))
  ].filter(Boolean);
}

export function projectLedgerIntent(root, {
  kind,
  aggregate,
  definition,
  portfolio
}) {
  const directory = kind === 'story'
    ? workDir(root, definition, aggregate.workItem.id)
    : initiativeDir(root, portfolio, aggregate.initiative.id);
  const relativeDirectory = kind === 'story'
    ? workDirRelative(definition, aggregate.workItem.id)
    : initiativeRelative(portfolio, aggregate.initiative.id);
  return (aggregate.publicationProjections ?? [])
    .filter((record) => record.ledgerIntent)
    .map((record) => {
      const intent = record.ledgerIntent;
      if (intent.eventId !== record.event?.eventId) {
        throw new SingularityFlowError(`Ledger intent ${intent.eventId} does not match its publication event.`);
      }
      const relativePath = path.posix.join(relativeDirectory, LEDGER_INTENT_DIRECTORY, `${intent.eventId}.json`);
      return projection({
        id: `ledger-intent:${intent.eventId}`,
        kind: 'LedgerIntent',
        relativePath: assertSubjectPath(root, directory, path.join(root, relativePath), `Ledger intent '${intent.eventId}'`),
        content: canonicalJson(intent),
        source: `${kind === 'story' ? 'workflow.json' : 'state.json'} publication recipe`
      });
    });
}

export async function declaredProjections(root, options) {
  const { kind, aggregate, definition, portfolio } = options;
  const directory = kind === 'story'
    ? workDir(root, definition, aggregate.workItem.id)
    : initiativeDir(root, portfolio, aggregate.initiative.id);
  const statusFile = kind === 'story'
    ? statusPath(root, definition, aggregate.workItem.id)
    : path.join(directory, 'STATUS.md');
  const specs = [projection({
    id: 'status',
    kind: 'StatusMarkdown',
    relativePath: assertSubjectPath(root, directory, statusFile, 'Status projection'),
    content: projectStatusMarkdown(kind, aggregate),
    source: kind === 'story' ? 'workflow.json' : 'state.json'
  })];
  specs.push(...await projectArtifactMetadata(root, options));
  specs.push(...await projectApprovalSummary(root, options));
  specs.push(...projectReviewPacket(root, options));
  specs.push(...projectLedgerIntent(root, options));
  const unique = new Map();
  for (const spec of specs) {
    if (unique.has(spec.path)) throw new SingularityFlowError(`Two projectors target ${spec.path}.`);
    unique.set(spec.path, spec);
  }
  return [...unique.values()];
}

export async function inspectProjections(root, options) {
  const specs = await declaredProjections(root, options);
  const items = [];
  for (const spec of specs) {
    const file = path.join(root, spec.path);
    const actual = await exists(file) ? await readFile(file, 'utf8') : null;
    items.push({
      id: spec.id,
      kind: spec.kind,
      path: spec.path,
      source: spec.source,
      exists: actual != null,
      current: actual === spec.content,
      repairable: spec.repairable,
      expectedSha256: sha256(spec.content),
      actualSha256: actual == null ? null : sha256(actual),
      content: spec.content
    });
  }
  return items;
}

export async function repairProjections(root, items) {
  const repairedPaths = [];
  for (const item of items.filter((entry) => !entry.current && entry.repairable)) {
    await writeAtomic(path.join(root, item.path), item.content);
    repairedPaths.push(item.path);
  }
  return repairedPaths;
}
