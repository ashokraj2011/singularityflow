import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { recordSha256 } from './records.mjs';
import { currentSchemaVersion, readRecord } from './schema-migrations.mjs';
import { nowIso, posix, secureRepositoryPath, SingularityFlowError, snapshot, writeJson, writeText } from './util.mjs';

function itemRoot(root, workflow, itemDirectory) {
  return itemDirectory ?? path.join(root, workflow.resolution?.workItemRoot ?? 'singularity/work-items', workflow.workItem.id);
}

function addCount(target, key, amount = 1) { if (key) target[key] = (target[key] ?? 0) + amount; }
function addValue(target, value) { if (value != null && String(value).trim()) target.add(String(value).trim()); }

function inspectJson(value, totals, seen = new Set()) {
  if (!value || typeof value !== 'object' || seen.has(value)) return;
  seen.add(value);
  if (Array.isArray(value)) { for (const item of value) inspectJson(item, totals, seen); return; }
  const type = typeof value.type === 'string' ? value.type.toUpperCase() : null;
  if (value.id != null || type) {
    totals.nodes += 1; addCount(totals.nodeTypes, type ?? 'UNKNOWN');
    if (type === 'COMPONENT') totals.components += 1;
    if (type === 'COMPONENT_SET') totals.componentSets += 1;
    if (type === 'INSTANCE') totals.instances += 1;
    addValue(totals.names, value.name);
  }
  for (const [key, child] of Object.entries(value)) {
    if (/variant|componentpropert/i.test(key) && child && typeof child === 'object') for (const name of Object.keys(child)) addValue(totals.variantProperties, name);
    if (/variable/i.test(key)) {
      if (typeof child === 'string') addValue(totals.variables, child);
      else if (child && typeof child === 'object') for (const name of Object.keys(child)) addValue(totals.variables, name);
    }
    if (/style/i.test(key)) {
      if (typeof child === 'string') addValue(totals.styles, child);
      else if (child && typeof child === 'object') for (const name of Object.keys(child)) addValue(totals.styles, name);
    }
    inspectJson(child, totals, seen);
  }
}

function stableTotals() {
  return { nodes: 0, components: 0, componentSets: 0, instances: 0, nodeTypes: {}, names: new Set(), variantProperties: new Set(), variables: new Set(), styles: new Set() };
}

export async function generateDesignInventory(root, workflow, binding, { itemDirectory = null } = {}) {
  if (!binding?.setSha256 || !binding.records?.length) throw new SingularityFlowError('An approved design-source set is required before generating the inventory digest.', { code: 'DESIGN_INVENTORY_SOURCE_REQUIRED' });
  const directory = itemRoot(root, workflow, itemDirectory), totals = stableTotals(), sources = [];
  for (const record of binding.records) {
    if (!['figma-rest-file-json', 'sflow-design-nodes-v1'].includes(record.format)) throw new SingularityFlowError(`Design inventory cannot deterministically parse '${record.format}' for ${record.fileKey}.`, { code: 'DESIGN_INVENTORY_FORMAT_UNSUPPORTED' });
    const source = await secureRepositoryPath(directory, record.outputPath, { label: `Design inventory source '${record.recordId}'`, mustExist: true, type: 'file' });
    const current = await snapshot(source.absolute);
    if (current.sha256 !== record.outputSha256) throw new SingularityFlowError(`Design inventory source changed after approval: ${record.outputPath}`, { code: 'DESIGN_INVENTORY_SOURCE_CHANGED' });
    let json; try { json = JSON.parse(await readFile(source.absolute, 'utf8')); } catch (error) { throw new SingularityFlowError(`Design inventory source is invalid JSON: ${error.message}`); }
    inspectJson(json, totals);
    sources.push({ recordId: record.recordId, fileKey: record.fileKey, fileVersion: record.fileVersion, outputSha256: record.outputSha256, format: record.format });
  }
  const digestBody = {
    schemaVersion: currentSchemaVersion('design-inventory-digest'), kind: 'design-inventory-digest', workId: workflow.workItem.id,
    sourceSetSha256: binding.setSha256, sources: sources.sort((a, b) => a.fileKey.localeCompare(b.fileKey)),
    counts: { nodes: totals.nodes, components: totals.components, componentSets: totals.componentSets, instances: totals.instances, nodeTypes: Object.fromEntries(Object.entries(totals.nodeTypes).sort()) },
    names: [...totals.names].sort(), variantProperties: [...totals.variantProperties].sort(), variables: [...totals.variables].sort(), styles: [...totals.styles].sort()
  };
  const digest = { ...digestBody, digestSha256: recordSha256(digestBody), generatedAt: nowIso() };
  const base = posix(path.join('context', 'design-inventory', binding.setSha256));
  const jsonRelative = `${base}/digest.json`, markdownRelative = `${base}/digest.md`;
  const jsonTarget = await secureRepositoryPath(directory, jsonRelative, { label: 'Design inventory digest JSON' });
  await writeJson(jsonTarget.absolute, digest);
  const markdown = [
    '# Design inventory digest', '', `Source set: \`${binding.setSha256}\``, `Digest: \`${digest.digestSha256}\``, '',
    '## Counts', '', `- Nodes: ${totals.nodes}`, `- Components: ${totals.components}`, `- Component sets: ${totals.componentSets}`, `- Instances: ${totals.instances}`, '',
    '## Variant properties', '', ...(digest.variantProperties.length ? digest.variantProperties.map((entry) => `- ${entry}`) : ['- _None observed_']), '',
    '## Variables', '', ...(digest.variables.length ? digest.variables.map((entry) => `- ${entry}`) : ['- _None observed_']), '',
    '## Styles', '', ...(digest.styles.length ? digest.styles.map((entry) => `- ${entry}`) : ['- _None observed_']), ''
  ].join('\n');
  const markdownTarget = await secureRepositoryPath(directory, markdownRelative, { label: 'Design inventory digest Markdown' });
  await writeText(markdownTarget.absolute, markdown);
  const [jsonSnapshot, markdownSnapshot] = await Promise.all([snapshot(jsonTarget.absolute), snapshot(markdownTarget.absolute)]);
  return { digest, json: { path: jsonRelative, sha256: jsonSnapshot.sha256, bytes: jsonSnapshot.size }, markdown: { path: markdownRelative, sha256: markdownSnapshot.sha256, bytes: markdownSnapshot.size } };
}

export async function readDesignInventory(root, workflow, binding, { itemDirectory = null } = {}) {
  if (!binding?.setSha256) return null;
  const directory = itemRoot(root, workflow, itemDirectory), relative = posix(path.join('context', 'design-inventory', binding.setSha256, 'digest.json'));
  const target = await secureRepositoryPath(directory, relative, { label: 'Design inventory digest', mustExist: false });
  const current = await snapshot(target.absolute);
  if (!current.exists) return null;
  const digest = readRecord('design-inventory-digest', await readFile(target.absolute)).record;
  const body = { ...digest }; delete body.digestSha256; delete body.generatedAt;
  if (recordSha256(body) !== digest.digestSha256 || digest.sourceSetSha256 !== binding.setSha256) throw new SingularityFlowError('Design inventory digest integrity is invalid.', { code: 'DESIGN_INVENTORY_INVALID' });
  return { digest, path: relative, sha256: current.sha256, bytes: current.size };
}
