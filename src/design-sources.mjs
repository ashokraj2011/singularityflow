import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { listMcpEvidence, verifyMcpEvidence } from './mcp-evidence.mjs';
import { canonicalJson, recordSha256 } from './records.mjs';
import { readDesignInventory } from './design-inventory.mjs';
import { currentSchemaVersion, readRecord } from './schema-migrations.mjs';
import {
  nowIso, posix, secureRepositoryPath, SingularityFlowError, snapshot, writeJson
} from './util.mjs';

function policy(workflow) {
  return workflow.resolution?.designSources ?? null;
}

function itemRoot(root, workflow, itemDirectory) {
  return itemDirectory ?? path.join(
    root,
    workflow.resolution?.workItemRoot ?? 'singularity/work-items',
    workflow.workItem.id
  );
}

export function approvedDesignSourceBinding(workflow) {
  for (const phaseId of workflow.phaseOrder ?? []) {
    const phase = workflow.phases?.[phaseId];
    for (const approval of [...(phase?.approvals ?? [])].reverse()) {
      if (!approval.invalidatedAt && approval.decision === 'approved' && approval.designSourceSet) return approval.designSourceSet;
    }
  }
  return null;
}

export function selectDesignSourceRecords(records, {
  capturePhase, targetGeneration, previousBinding = null, selectionByFileKey = {}
} = {}) {
  const candidates = records.filter((record) =>
    record.kind === 'design-source' && record.phase === capturePhase &&
    Number(record.targetGeneration) === Number(targetGeneration)
  );
  const groups = new Map();
  for (const record of candidates) {
    if (!groups.has(record.fileKey)) groups.set(record.fileKey, []);
    groups.get(record.fileKey).push(record);
  }
  const selected = [];
  const ambiguities = [];
  for (const [fileKey, group] of [...groups.entries()].sort(([left], [right]) => left.localeCompare(right))) {
    const requested = selectionByFileKey[fileKey];
    let match = requested
      ? group.find((record) => record.id === requested || record.fileVersion === requested || record.outputSha256 === requested)
      : null;
    if (!match && group.length === 1) match = group[0];
    if (!match && group.length > 1) {
      ambiguities.push({ fileKey, candidates: group.map((record) => ({ id: record.id, fileVersion: record.fileVersion, outputSha256: record.outputSha256 })) });
      continue;
    }
    if (match) selected.push(match);
  }
  if (!selected.length && previousBinding?.records?.length) {
    const byId = new Map(records.map((record) => [record.id, record]));
    for (const reference of previousBinding.records) {
      const record = byId.get(reference.recordId);
      if (record && record.outputSha256 === reference.outputSha256) selected.push(record);
    }
  }
  return { selected, ambiguities };
}

export function createDesignSourceSet(workflow, records, { phase, generation } = {}) {
  const body = {
    schemaVersion: currentSchemaVersion('design-source-set'),
    kind: 'design-source-set',
    workId: workflow.workItem.id,
    workType: workflow.workItem.workType,
    phase,
    generation,
    records: records.map((record) => ({
      recordId: record.id,
      recordSha256: recordSha256(record),
      server: record.server,
      tool: record.tool,
      fileKey: record.fileKey,
      fileVersion: record.fileVersion,
      fileVersionCreatedAt: record.fileVersionCreatedAt ?? null,
      nodes: [...(record.nodes ?? [])].sort(),
      format: record.format,
      outputPath: record.output?.path,
      outputSha256: record.outputSha256,
      outputBytes: record.output?.bytes ?? null
    })).sort((left, right) => left.fileKey.localeCompare(right.fileKey) || left.recordId.localeCompare(right.recordId))
  };
  return { ...body, setSha256: recordSha256(body), createdAt: nowIso() };
}

export function classifyDesignSourceCandidates(records, binding) {
  if (!binding?.records?.length) return [];
  const selectedIds = new Set(binding.records.map((entry) => entry.recordId));
  const approvedByFile = new Map(binding.records.map((entry) => [entry.fileKey, entry]));
  const candidates = [];
  for (const record of records.filter((entry) => entry.kind === 'design-source' && !selectedIds.has(entry.id))) {
    const approved = approvedByFile.get(record.fileKey);
    if (!approved) continue;
    const approvedCreated = approved.fileVersionCreatedAt ? Date.parse(approved.fileVersionCreatedAt) : NaN;
    const candidateCreated = record.fileVersionCreatedAt ? Date.parse(record.fileVersionCreatedAt) : NaN;
    let classification = 'different-version-unordered';
    if (Number.isFinite(approvedCreated) && Number.isFinite(candidateCreated)) {
      classification = candidateCreated > approvedCreated ? 'newer-version-confirmed' : candidateCreated < approvedCreated ? 'older-version-confirmed' : 'same-version-time';
    } else if (record.fileVersion !== approved.fileVersion) classification = 'later-candidate-recorded';
    candidates.push({ fileKey: record.fileKey, approvedRecordId: approved.recordId, approvedVersion: approved.fileVersion, candidateRecordId: record.id, candidateVersion: record.fileVersion, candidateRecordedAt: record.recordedAt, classification });
  }
  return candidates.sort((a, b) => a.fileKey.localeCompare(b.fileKey) || a.candidateRecordId.localeCompare(b.candidateRecordId));
}

export async function buildDesignSourceSet(root, workflow, {
  itemDirectory = null, selectionByFileKey = {}
} = {}) {
  const configured = policy(workflow);
  if (!configured) return null;
  const phase = workflow.phases?.[configured.capturePhase];
  if (!phase) throw new SingularityFlowError(`Pinned design-source capture phase '${configured.capturePhase}' is missing.`);
  const directory = itemRoot(root, workflow, itemDirectory);
  const integrity = await verifyMcpEvidence(root, workflow, { itemDirectory: directory });
  if (integrity.errors.length) throw new SingularityFlowError(`Design-source evidence is not valid:\n- ${integrity.errors.join('\n- ')}`, { code: 'DESIGN_SOURCE_EVIDENCE_INVALID' });
  const { selected, ambiguities } = selectDesignSourceRecords(integrity.records, {
    capturePhase: configured.capturePhase,
    targetGeneration: phase.generation,
    previousBinding: approvedDesignSourceBinding(workflow),
    selectionByFileKey
  });
  if (ambiguities.length) throw new SingularityFlowError(
    `More than one design version is available. Select one record for: ${ambiguities.map((item) => item.fileKey).join(', ')}.`,
    { code: 'DESIGN_SOURCE_AMBIGUOUS', details: { ambiguities } }
  );
  if (!selected.length && configured.requireApprovedSet) throw new SingularityFlowError(
    `Phase '${configured.capturePhase}' requires at least one recorded design source for generation ${phase.generation}.`,
    { code: 'DESIGN_SOURCE_REQUIRED' }
  );
  const sourceSet = createDesignSourceSet(workflow, selected, { phase: phase.id, generation: phase.generation });
  const relative = posix(path.join('context', 'design-sources', `${phase.id}-gen${phase.generation}.json`));
  const target = await secureRepositoryPath(directory, relative, { label: 'Design source set' });
  await writeJson(target.absolute, sourceSet);
  const captured = await snapshot(target.absolute);
  const binding = { path: relative, sha256: captured.sha256, setSha256: sourceSet.setSha256, phase: phase.id, generation: phase.generation, records: sourceSet.records };
  phase.designSourceSets = [...(phase.designSourceSets ?? []).filter((entry) => entry.generation !== phase.generation), binding];
  return { sourceSet, binding };
}

export async function verifyDesignSourceSet(root, workflow, binding, { itemDirectory = null } = {}) {
  const errors = [], warnings = [], passes = [];
  if (!binding) return { errors: ['No approved design-source set is bound to this workflow.'], warnings, passes };
  const directory = itemRoot(root, workflow, itemDirectory);
  const target = await secureRepositoryPath(directory, binding.path ?? '', { label: 'Approved design source set', mustExist: false });
  const current = await snapshot(target.absolute);
  if (!current.exists) return { errors: [`Approved design-source set is missing: ${binding.path}`], warnings, passes };
  if (current.sha256 !== binding.sha256) errors.push(`Approved design-source set changed after approval: ${binding.path}`);
  let sourceSet;
  try { sourceSet = readRecord('design-source-set', await readFile(target.absolute)).record; }
  catch (error) { errors.push(`Approved design-source set is invalid JSON: ${error.message}`); return { errors, warnings, passes }; }
  const body = { ...sourceSet }; delete body.setSha256; delete body.createdAt;
  if (recordSha256(body) !== sourceSet.setSha256 || sourceSet.setSha256 !== binding.setSha256) errors.push('Approved design-source set content hash does not match its approval binding.');
  if (sourceSet.workId !== workflow.workItem.id || sourceSet.phase !== binding.phase || sourceSet.generation !== binding.generation) errors.push('Approved design-source set identity does not match the workflow approval.');
  const evidence = await verifyMcpEvidence(root, workflow, { itemDirectory: directory });
  errors.push(...evidence.errors);
  const byId = new Map(evidence.records.map((record) => [record.id, record]));
  for (const reference of sourceSet.records ?? []) {
    const record = byId.get(reference.recordId);
    if (!record) errors.push(`Approved design-source record is missing: ${reference.recordId}`);
    else if (recordSha256(record) !== reference.recordSha256 || record.outputSha256 !== reference.outputSha256) errors.push(`Approved design-source record changed: ${reference.recordId}`);
  }
  if (!errors.length) passes.push(`design sources: ${sourceSet.records?.length ?? 0} record(s) @${binding.setSha256.slice(0, 8)}`);
  return { errors, warnings, passes, sourceSet };
}

export async function renderDesignSourcePromptContext(root, workflow, phase, {
  itemDirectory = null, record = false
} = {}) {
  const configured = policy(workflow);
  if (!configured || !configured.consumeIn.includes(phase.id)) return { markdown: '', files: [], warnings: [] };
  const binding = approvedDesignSourceBinding(workflow);
  const verification = await verifyDesignSourceSet(root, workflow, binding, { itemDirectory });
  if (verification.errors.length && configured.requireApprovedSet) throw new SingularityFlowError(`Approved design context is not usable:\n- ${verification.errors.join('\n- ')}`, { code: 'DESIGN_SOURCE_APPROVAL_INVALID' });
  if (!binding || !verification.sourceSet) return { markdown: '', files: [], warnings: verification.errors };
  const generation = Number(phase.generation ?? 0) + 1;
  const provenance = {
    schemaVersion: currentSchemaVersion('design-source-provenance'),
    kind: 'design-source-provenance',
    workId: workflow.workItem.id,
    phase: phase.id,
    generation,
    approvedSet: binding,
    records: verification.sourceSet.records,
    verifiedAt: nowIso()
  };
  const relative = posix(path.join('context', `design-sources-${phase.id}-gen${generation}.json`));
  const directory = itemRoot(root, workflow, itemDirectory);
  const inventory = configured.inventoryDigest === 'off' ? null : await readDesignInventory(root, workflow, binding, { itemDirectory: directory });
  if (!inventory && configured.inventoryDigest === 'required') throw new SingularityFlowError('The approved design source requires a deterministic inventory digest. Run singularity-flow wm design-inventory --from-records.', { code: 'DESIGN_INVENTORY_REQUIRED' });
  let provenanceSnapshot = null;
  if (record) {
    const target = await secureRepositoryPath(directory, relative, { label: 'Design-source prompt provenance' });
    await writeJson(target.absolute, provenance);
    provenanceSnapshot = await snapshot(target.absolute);
  }
  const markdown = [
    '# Approved design sources', '',
    `Use only the source set approved for ${binding.phase} generation ${binding.generation}.`,
    `Source-set SHA-256: \`${binding.setSha256}\``, '',
    ...(provenance.records ?? []).flatMap((entry) => [
      `## ${entry.fileKey} @ ${entry.fileVersion}`,
      `- MCP record: \`${entry.recordId}\``,
      `- Nodes: ${(entry.nodes ?? []).map((node) => `\`${node}\``).join(', ') || '_whole-file metadata_'}`,
      `- Format: \`${entry.format}\``,
      `- Managed output: \`${entry.outputPath}\` @ \`${entry.outputSha256}\``, ''
    ]),
    ...(inventory ? [
      '# Deterministic design inventory', '',
      `Inventory digest: \`${inventory.digest.digestSha256}\``,
      `Nodes: ${inventory.digest.counts.nodes}; components: ${inventory.digest.counts.components}; instances: ${inventory.digest.counts.instances}.`,
      `Managed digest: \`${inventory.path}\``, ''
    ] : []),
    'The managed output remains evidence. Do not substitute a newer live design unless a new source set is generated and approved.'
  ].join('\n');
  const body = canonicalJson(provenance);
  const repositoryRelative = (relativePath) => posix(path.relative(root, path.join(directory, relativePath)));
  return {
    markdown,
    warnings: verification.warnings,
    files: [{
      path: repositoryRelative(relative),
      // Once persisted, provenance uses the hash and byte count of the exact file
      // that downstream prompt records point at. Dry-run composition has no file,
      // so its deterministic canonical hash remains an honest preview value.
      sha256: provenanceSnapshot?.sha256 ?? recordSha256(provenance),
      bytes: provenanceSnapshot?.size ?? Buffer.byteLength(body),
      injectedBytes: Buffer.byteLength(markdown),
      truncated: false,
      category: 'design-source-provenance',
      level: 1,
      reason: `approved source set ${binding.setSha256}`
    }, ...(inventory ? [{ path: repositoryRelative(inventory.path), sha256: inventory.sha256, bytes: inventory.bytes, injectedBytes: 0, truncated: false, category: 'design-inventory', level: 1, reason: `approved source set ${binding.setSha256}` }] : [])]
  };
}

export async function verifyDesignSourceLifecycle(root, workflow, options = {}) {
  const configured = policy(workflow);
  if (!configured) return { errors: [], warnings: [], passes: [] };
  const binding = approvedDesignSourceBinding(workflow);
  if (!binding) {
    const message = 'No approved design-source set is recorded.';
    const consumerActive = configured.consumeIn.some((phaseId) => {
      const status = workflow.phases?.[phaseId]?.status;
      return status && status !== 'not_started';
    });
    return configured.requireApprovedSet && consumerActive
      ? { errors: [message], warnings: [], passes: [] }
      : { errors: [], warnings: [message], passes: [] };
  }
  const result = await verifyDesignSourceSet(root, workflow, binding, options);
  const evidence = await listMcpEvidence(root, workflow, options);
  const candidates = classifyDesignSourceCandidates(evidence, binding);
  const stale = candidates.filter((entry) => ['newer-version-confirmed', 'later-candidate-recorded'].includes(entry.classification));
  if (stale.length && configured.staleness !== 'ignore') {
    const messages = stale.map((entry) => `Approved design source '${entry.fileKey}' has candidate ${entry.candidateVersion} (${entry.classification}).`);
    if (configured.staleness === 'fail') result.errors.push(...messages); else result.warnings.push(...messages);
  }
  return { ...result, candidates, stale };
}
