/** Portable workflow dependency names and query bindings. No configuration/body reads or host I/O. */
import { SingularityFlowError } from '../foundation/failures.mjs';

// These projections retain the native export field order, sorting and skill-package phase order.
export function summarizeWorkflowAssets(bundle) {
  return {
    workflows: bundle.workflows.length,
    phases: Object.keys(bundle.objects.story.phases).length
      + Object.keys(bundle.objects.initiative.initiativePhases).length,
    artifactSets: Object.keys(bundle.objects.story.artifactSets).length,
    approvalAuthorities: Object.keys(bundle.objects.story.approvalAuthorities).length
      + Object.keys(bundle.objects.initiative.approvalAuthorities).length,
    mcpServers: Object.keys(bundle.objects.story.mcpServers).length,
    agents: bundle.assets.filter((asset) => asset.kind === 'agent').length,
    agentLocks: Object.keys(bundle.agentLocks ?? {}).length,
    templates: bundle.assets.filter((asset) => asset.kind === 'template').length,
    vendoredCopies: bundle.assets.filter((asset) => asset.kind === 'vendored').length,
    skills: bundle.assets.filter((asset) => asset.kind === 'skill').length,
    instructions: bundle.assets.filter((asset) => asset.kind === 'instruction').length,
    constitutions: bundle.assets.filter((asset) => asset.kind === 'constitution').length,
    userDefinedFiles: bundle.assets.filter((asset) => asset.kind === 'user-defined').length,
    importRecords: Object.keys(bundle.imports ?? {}).length,
    assets: bundle.assets.length,
    skillPackages: bundle.skillPackages?.length ?? 0,
    skillFiles: (bundle.skillPackages ?? []).reduce((total, record) => total + record.files.length, 0)
  };
}

export function workflowAssetInventory(bundle) {
  const objectIds = (governs, section) => Object.keys(bundle.objects[governs][section] ?? {}).sort();
  return {
    workflows: bundle.workflows.map(({ governs, id }) => `${governs}:${id}`).sort(),
    phases: [
      ...objectIds('story', 'phases').map((id) => `story:${id}`),
      ...objectIds('initiative', 'initiativePhases').map((id) => `initiative:${id}`)
    ].sort(),
    artifactSets: objectIds('story', 'artifactSets'),
    templateCatalog: objectIds('story', 'templates'),
    templateAssets: bundle.assets.filter((asset) => asset.kind === 'template')
      .map((asset) => `${asset.governs}:${asset.reference}`).sort(),
    agents: bundle.assets.filter((asset) => asset.kind === 'agent').map((asset) => asset.id).sort(),
    agentLocks: Object.keys(bundle.agentLocks ?? {}).sort(),
    vendoredCopies: bundle.assets.filter((asset) => asset.kind === 'vendored').map((asset) => asset.path).sort(),
    skills: bundle.assets.filter((asset) => asset.kind === 'skill').map((asset) => asset.id).sort(),
    instructions: bundle.assets.filter((asset) => asset.kind === 'instruction').map((asset) => asset.id).sort(),
    constitutions: bundle.assets.filter((asset) => asset.kind === 'constitution').map((asset) => asset.path).sort(),
    userDefinedFolders: [...new Set(bundle.assets.filter((asset) => asset.kind === 'user-defined').map((asset) => asset.owner.id))].sort(),
    importRecords: Object.keys(bundle.imports ?? {}).sort(),
    approvalAuthorities: [
      ...objectIds('story', 'approvalAuthorities').map((id) => `story:${id}`),
      ...objectIds('initiative', 'approvalAuthorities').map((id) => `initiative:${id}`)
    ].sort(),
    mcpServers: objectIds('story', 'mcpServers'),
    integrationTargets: Object.keys(bundle.objects.story.integrations?.targets ?? {}).sort(),
    applicabilityPolicies: objectIds('initiative', 'applicabilityPolicies'),
    worldModelViews: [...(bundle.requirements?.worldModelViews ?? [])].sort(),
    skillPackages: (bundle.skillPackages ?? []).map((record) => ({
      skillId: record.skillId, packageSha256: record.manifest.packageSha256,
      phases: record.phaseBindings.map((binding) => `${binding.governs}:${binding.phaseId}`)
    }))
  };
}

const listFields = Object.freeze(['workflows', 'phases', 'artifactSets', 'templateCatalog', 'templateAssets', 'agents', 'agentLocks',
  'vendoredCopies', 'skills', 'instructions', 'constitutions', 'userDefinedFolders', 'importRecords', 'approvalAuthorities',
  'mcpServers', 'integrationTargets', 'applicabilityPolicies', 'worldModelViews']);
const countFields = Object.freeze(['workflows', 'phases', 'artifactSets', 'approvalAuthorities', 'mcpServers', 'agents', 'agentLocks',
  'templates', 'vendoredCopies', 'skills', 'instructions', 'constitutions', 'userDefinedFiles', 'importRecords', 'assets', 'skillPackages', 'skillFiles']);
const countedLists = Object.freeze({ workflows: 'workflows', phases: 'phases', artifactSets: 'artifactSets',
  approvalAuthorities: 'approvalAuthorities', mcpServers: 'mcpServers', agents: 'agents', agentLocks: 'agentLocks',
  templates: 'templateAssets', vendoredCopies: 'vendoredCopies', skills: 'skills', instructions: 'instructions',
  constitutions: 'constitutions', importRecords: 'importRecords', skillPackages: 'skillPackages' });
const text = value => typeof value === 'string' && value.length > 0 && !/[\u0000-\u001f]/u.test(value);
const digest = value => typeof value === 'string' && /^sha256:[a-f0-9]{64}$/u.test(value);
const fields = (value, keys) => value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const strings = value => Array.isArray(value) && value.length <= 8192 && value.every(text);
const invalid = () => { throw new SingularityFlowError('The workflow asset port returned invalid or differently bound facts.', { code: 'ENGINE_PORT_RESULT_INVALID' }); };

export function workflowAssetSelection(context, inputs) {
  const selection = context?.selection;
  if (!fields(selection, ['workflows', 'bundleSha256', 'source']) || !digest(selection.bundleSha256)
    || !Array.isArray(selection.workflows) || !selection.workflows.length || selection.workflows.length > 8192
    || !fields(selection.source, ['kind', 'revision']) || !['approved-snapshot', 'working-configuration'].includes(selection.source.kind)
    || (selection.source.kind === 'approved-snapshot' ? !text(selection.source.revision) : selection.source.revision !== null)) invalid();
  const selected = new Set();
  for (const workflow of selection.workflows) {
    if (!fields(workflow, ['governs', 'id']) || !['story', 'initiative'].includes(workflow.governs)
      || typeof workflow.id !== 'string' || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(workflow.id)) invalid();
    const key = `${workflow.governs}:${workflow.id}`;
    if (selected.has(key)) invalid(); selected.add(key);
  }
  const requested = new Set();
  for (const selector of inputs.workflowIds) {
    const matches = selection.workflows.filter(workflow => selector === `${workflow.governs}:${workflow.id}` || selector === workflow.id);
    if (matches.length !== 1) invalid(); requested.add(`${matches[0].governs}:${matches[0].id}`);
  }
  if (selected.size !== requested.size || [...selected].some(key => !requested.has(key))) invalid();
  return selection;
}

export function workflowAssetManifest(binding, facts) {
  if (!fields(facts, ['bundleSha256', 'dependencies', 'summary']) || facts.bundleSha256 !== binding.bundleSha256
    || !fields(facts.dependencies, [...listFields, 'skillPackages']) || !fields(facts.summary, countFields)
    || listFields.some(field => !strings(facts.dependencies[field]))
    || countFields.some(field => !Number.isSafeInteger(facts.summary[field]) || facts.summary[field] < 0)
    || !Array.isArray(facts.dependencies.skillPackages) || facts.dependencies.skillPackages.length > 32) invalid();
  for (const record of facts.dependencies.skillPackages) if (!fields(record, ['skillId', 'packageSha256', 'phases'])
    || !text(record.skillId) || !digest(record.packageSha256) || !strings(record.phases)) invalid();
  if (Object.entries(countedLists).some(([count, list]) => facts.summary[count] !== facts.dependencies[list].length)
    || facts.summary.userDefinedFiles < facts.dependencies.userDefinedFolders.length
    || facts.summary.assets !== ['agents', 'templates', 'vendoredCopies', 'skills', 'instructions', 'constitutions', 'userDefinedFiles']
      .reduce((sum, field) => sum + facts.summary[field], 0)) invalid();
  const expected = binding.workflows.map(({ governs, id }) => `${governs}:${id}`).sort();
  if (facts.summary.workflows !== expected.length || JSON.stringify(facts.dependencies.workflows) !== JSON.stringify(expected)) invalid();
  return { schemaVersion: 1, contract: 'sflow-workflow-assets/v1', bundleSha256: binding.bundleSha256,
    source: binding.source, dependencies: facts.dependencies, summary: facts.summary,
    contentIncluded: false, importPerformed: false, approvalRecorded: false };
}
