/**
 * Portable workflow bundles and lossless linked workflow copies.
 *
 * A bundle contains configuration needed to understand and run the selected workflows, not Story
 * state.  It intentionally excludes work items, generated artifacts, ledgers, caches, credentials,
 * provider configuration, and repository bindings.  Imports merge only absent objects, reuse exact
 * matches, and refuse a same-name/different-value collision before the first write.
 */
import { createHash, randomBytes } from 'node:crypto';
import path from 'node:path';
import {
  lstat, mkdir, open, readFile, readdir, rename, rm, writeFile
} from 'node:fs/promises';
import YAML from 'yaml';
import { configurationReadRoot } from './configuration-read-scope.mjs';
import {
  portableConfigurationPath, portableFilesystemPathIdentity
} from './configuration-assets.mjs';
import {
  AGENT_LOCK_PATH, discoverAgents, parseAgentDependencies, parseAgentTemplateReference,
  validateAgentCatalog
} from './agents.mjs';
import { validateDefinition, WORKFLOW_PATH } from './config.mjs';
import {
  PORTFOLIO_PATH, validatePortfolio, validatePortfolioWorldModelViews
} from './initiative-config.mjs';
import { currentSchemaVersion, readRecord } from './schema-migrations.mjs';
import { isTemplateReference, parseTemplateReference } from './template-catalog.mjs';
import { secureRepositoryPath, SingularityFlowError, YAML_OUTPUT } from './util.mjs';

export const WORKFLOW_BUNDLE_KIND = 'sflow-workflow-bundle';
const WORKFLOW_BUNDLE_FAMILY = 'workflow-bundle';
export const WORKFLOW_BUNDLE_SCHEMA_VERSION = currentSchemaVersion(WORKFLOW_BUNDLE_FAMILY);

const MAX_ASSETS = 2048;
const MAX_ASSET_BYTES = 1024 * 1024;
const MAX_ASSET_BYTES_TOTAL = 16 * 1024 * 1024;
const MAX_BUNDLE_BYTES = 20 * 1024 * 1024;
const MAX_OBJECTS = 8192;
const ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

const STORE = Object.freeze({
  story: Object.freeze({
    file: WORKFLOW_PATH, workflows: 'workTypes', phases: 'phases', validate: validateDefinition
  }),
  initiative: Object.freeze({
    file: PORTFOLIO_PATH, workflows: 'initiativeProfiles', phases: 'initiativePhases', validate: validatePortfolio
  })
});

function fail(message, code = 'WORKFLOW_BUNDLE_INVALID', details = undefined) {
  throw new SingularityFlowError(message, { code, ...(details ? { details } : {}) });
}

function clone(value) { return value == null ? value : structuredClone(value); }

function canonicalValue(value) {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalValue(value[key])]));
}

function canonicalJson(value) { return JSON.stringify(canonicalValue(value)); }
function digest(value) {
  const bytes = typeof value === 'string' || Buffer.isBuffer(value) ? value : canonicalJson(value);
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

function textAssetFormat(bytes) {
  const bomSignatures = [
    Buffer.from([0xef, 0xbb, 0xbf]),
    Buffer.from([0xff, 0xfe, 0x00, 0x00]),
    Buffer.from([0x00, 0x00, 0xfe, 0xff]),
    Buffer.from([0xff, 0xfe]),
    Buffer.from([0xfe, 0xff])
  ];
  if (bomSignatures.some((signature) => bytes.subarray(0, signature.length).equals(signature))) {
    return { valid: false, reason: 'text asset contains a byte-order mark' };
  }
  const text = bytes.toString('utf8');
  if (!Buffer.from(text, 'utf8').equals(bytes)) {
    return { valid: false, reason: 'text asset is not valid UTF-8' };
  }
  let lf = false;
  let crlf = false;
  let bareCr = false;
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] === '\r') {
      if (text[index + 1] === '\n') {
        crlf = true;
        index += 1;
      } else bareCr = true;
    } else if (text[index] === '\n') lf = true;
  }
  if (bareCr || (lf && crlf)) {
    return { valid: false, reason: 'text asset has mixed or ambiguous line endings' };
  }
  return { valid: true, normalized: text.replaceAll('\r\n', '\n') };
}

function importedAssetReuse(asset, targetBytes) {
  const incomingBytes = Buffer.from(asset.content, 'utf8');
  if (!/^text\//i.test(asset.mediaType)) {
    return { reusable: incomingBytes.equals(targetBytes), reason: 'same path has different content' };
  }
  const incoming = textAssetFormat(incomingBytes);
  if (!incoming.valid) return { reusable: false, reason: `incoming ${incoming.reason}` };
  const target = textAssetFormat(targetBytes);
  if (!target.valid) return { reusable: false, reason: `target ${target.reason}` };
  return {
    reusable: incomingBytes.equals(targetBytes) || incoming.normalized === target.normalized,
    reason: 'same path has different content'
  };
}

function plainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function requireId(value, label) {
  const candidate = String(value ?? '').trim();
  if (!ID.test(candidate)) fail(`${label} must be lower-case kebab-case.`, 'WORKFLOW_ID_INVALID');
  return candidate;
}

function parseWorkflowSelector(value, label = 'Workflow identifier') {
  const candidate = String(value ?? '').trim();
  const qualified = candidate.match(/^(story|initiative):([a-z0-9]+(?:-[a-z0-9]+)*)$/);
  return {
    governs: qualified?.[1] ?? null,
    id: requireId(qualified?.[2] ?? candidate, label),
    selector: qualified ? `${qualified[1]}:${qualified[2]}` : candidate
  };
}

async function regularFile(file, label, { optional = false } = {}) {
  const info = await lstat(file).catch((error) => error?.code === 'ENOENT' ? null : Promise.reject(error));
  if (!info) {
    if (optional) return null;
    fail(`${label} does not exist: ${file}`, 'WORKFLOW_DEPENDENCY_MISSING');
  }
  if (!info.isFile() || info.isSymbolicLink()) {
    fail(`${label} must be a regular file and cannot be a symbolic link: ${file}`,
      'WORKFLOW_DEPENDENCY_NOT_REGULAR');
  }
  return info;
}

async function readYamlDocument(root, store, { optional = false } = {}) {
  const secured = await secureRepositoryPath(root, store.file, {
    label: store.file, mustExist: !optional, type: 'file'
  });
  if (!secured.exists) return null;
  const file = secured.absolute;
  const text = await readFile(file, 'utf8');
  let document;
  try { document = YAML.parseDocument(text); }
  catch (error) { fail(`Cannot parse ${store.file}: ${error.message}`, 'WORKFLOW_CONFIGURATION_INVALID'); }
  if (document.errors?.length) {
    fail(`Cannot parse ${store.file}: ${document.errors[0].message}`, 'WORKFLOW_CONFIGURATION_INVALID');
  }
  return { file, text, document, value: document.toJS() ?? {} };
}

function safeAssetPath(value, label = 'Bundle asset path') {
  const relative = portableConfigurationPath(value);
  if (!relative || relative !== value) fail(`${label} is not a portable repository-relative path: ${value}`,
    'WORKFLOW_BUNDLE_PATH_INVALID');
  return relative;
}

async function assertSafeTarget(root, relative) {
  const safe = safeAssetPath(relative);
  const parts = safe.split('/');
  let cursor = root;
  for (const part of parts) {
    cursor = path.join(cursor, part);
    const info = await lstat(cursor).catch((error) => error?.code === 'ENOENT' ? null : Promise.reject(error));
    if (info?.isSymbolicLink()) fail(`Workflow import target cannot traverse a symbolic link: ${safe}`,
      'WORKFLOW_IMPORT_TARGET_SYMBOLIC_LINK');
  }
  return path.join(root, ...parts);
}

async function portableTargetState(root, relative) {
  const safe = safeAssetPath(relative);
  const parts = safe.split('/');
  let cursor = root;
  const actual = [];
  for (let index = 0; index < parts.length; index += 1) {
    const part = parts[index];
    const parent = await lstat(cursor)
      .catch((error) => error?.code === 'ENOENT' ? null : Promise.reject(error));
    if (!parent) return { exists: false, file: path.join(root, ...parts), caseConflict: null };
    if (parent.isSymbolicLink() || !parent.isDirectory()) {
      return { exists: true, file: cursor, caseConflict: actual.join('/'), blocked: true };
    }
    const identity = portableFilesystemPathIdentity(part);
    const matches = (await readdir(cursor, { withFileTypes: true }))
      .filter((candidate) => portableFilesystemPathIdentity(candidate.name) === identity);
    if (matches.length > 1) {
      return {
        exists: true, file: cursor,
        caseConflict: [...actual, part].join('/'), blocked: true, ambiguous: true
      };
    }
    if (!matches.length) {
      return { exists: false, file: path.join(cursor, ...parts.slice(index)), caseConflict: null };
    }
    const matched = matches[0];
    actual.push(matched.name);
    cursor = path.join(cursor, matched.name);
    if (matched.name !== part) {
      return { exists: true, file: cursor, caseConflict: actual.join('/'), blocked: true };
    }
  }
  return { exists: true, file: cursor, caseConflict: null };
}

function walk(value, visitor, trail = []) {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => walk(entry, visitor, [...trail, index]));
    return;
  }
  if (!plainObject(value)) return;
  for (const [key, entry] of Object.entries(value)) {
    visitor(key, entry, value, [...trail, key]);
    walk(entry, visitor, [...trail, key]);
  }
}

function strings(value) {
  return Array.isArray(value) ? value.filter((entry) => typeof entry === 'string') : [];
}

function collectNamedDependencies(value, result, { governs = 'story' } = {}) {
  walk(value, (key, entry, parent) => {
    if (key === 'artifactSet' && typeof entry === 'string') result.artifactSets.add(entry);
    if (key === 'authorities' || key === 'requiredAuthorities') {
      for (const id of strings(entry)) result.authorities[governs].add(id);
    }
    // Some initiative gate declarations use one `authority` field instead of an approval
    // `authorities` list.  Treat it as a candidate: values such as `advisory` are vocabulary, not
    // authority IDs, and are ignored later unless they resolve in an authority catalog.
    if (key === 'authority' && typeof entry === 'string') {
      result.authorityCandidates[governs].add(entry);
    }
    if (key === 'requiredServers') for (const id of strings(entry)) result.mcpServers.add(id);
    if (key === 'server' && typeof entry === 'string' && parent.tool) result.mcpServers.add(entry);
    if (key === 'agents') for (const id of strings(entry)) result.agents.add(id);
    if (key === 'worldModelViews') for (const id of strings(entry)) result.worldModelViews.add(id);
    if (key === 'views' && Array.isArray(entry)
        && parent !== value && entry.every((item) => typeof item === 'string')) {
      for (const id of entry) result.worldModelViews.add(id);
    }
    if (key === 'applicability' && plainObject(entry) && typeof entry.policy === 'string') {
      result.applicabilityPolicies.add(entry.policy);
    }
  });
}

function phaseReferences(phase) {
  const result = new Set();
  for (const input of phase?.inputs ?? []) {
    if (typeof input === 'string') result.add(input);
    else if (typeof input?.phase === 'string') result.add(input.phase);
  }
  if (typeof phase?.testEvidenceFrom === 'string') result.add(phase.testEvidenceFrom);
  for (const output of phase?.outputs ?? []) {
    for (const consumed of output?.consumes ?? []) {
      if (typeof consumed === 'string' && consumed.includes('/')) result.add(consumed.split('/')[0]);
    }
  }
  return result;
}

function templateReferences(governs, workflow, phases) {
  const references = new Map();
  const add = (reference, phaseId) => {
    if (typeof reference !== 'string') return;
    const key = `${phaseId ?? ''}\0${reference}`;
    if (!references.has(key)) references.set(key, { governs, reference, phaseId: phaseId ?? null });
  };
  for (const [phaseId, value] of Object.entries(workflow?.templateOverrides ?? {})) {
    add(value, phaseId);
  }
  for (const [phaseId, phase] of Object.entries(phases)) {
    add(phase?.defaultTemplate, phaseId);
    for (const output of phase?.outputs ?? []) {
      add(output?.template, phaseId);
    }
  }
  for (const [phaseId, override] of Object.entries(workflow?.phaseOverrides ?? {})) {
    add(override?.defaultTemplate, phaseId);
    for (const output of override?.outputs ?? []) {
      add(output?.template, phaseId);
    }
  }
  return [...references.values()].sort((a, b) =>
    `${a.phaseId ?? ''}:${a.reference}`.localeCompare(`${b.phaseId ?? ''}:${b.reference}`));
}

function configuredTemplateRoot(config, governs, storyConfig) {
  const value = governs === 'initiative'
    ? config.templatesRoot ?? storyConfig?.templatesRoot ?? 'singularity/templates'
    : config.templatesRoot ?? 'singularity/templates';
  return safeAssetPath(value, `${governs} templatesRoot`);
}

function templateAssetPath(rootPath, reference) {
  if (reference.startsWith('agent:')) return null;
  const safe = safeAssetPath(reference, 'Template reference');
  return safe === rootPath || safe.startsWith(`${rootPath}/`) ? safe : `${rootPath}/${safe}`;
}

function emptyObjects() {
  return {
    story: {
      workTypes: {}, phases: {}, templates: {}, artifactSets: {}, approvalAuthorities: {}, mcpServers: {}
    },
    initiative: { initiativeProfiles: {}, initiativePhases: {}, approvalAuthorities: {}, applicabilityPolicies: {} }
  };
}

function addMapEntry(target, key, value, kind) {
  if (!Object.hasOwn(target, key)) { target[key] = clone(value); return; }
  if (canonicalJson(target[key]) !== canonicalJson(value)) {
    fail(`Dependency '${kind}:${key}' resolved to two different definitions.`, 'WORKFLOW_BUNDLE_DEPENDENCY_CONFLICT');
  }
}

function bundleWithoutDigest(bundle) {
  const copy = clone(bundle);
  delete copy.bundleSha256;
  return copy;
}

function summarizeBundle(bundle) {
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
    assets: bundle.assets.length
  };
}

function dependencyInventory(bundle) {
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
    approvalAuthorities: [
      ...objectIds('story', 'approvalAuthorities').map((id) => `story:${id}`),
      ...objectIds('initiative', 'approvalAuthorities').map((id) => `initiative:${id}`)
    ].sort(),
    mcpServers: objectIds('story', 'mcpServers'),
    applicabilityPolicies: objectIds('initiative', 'applicabilityPolicies'),
    worldModelViews: [...(bundle.requirements?.worldModelViews ?? [])].sort()
  };
}

function validateBundleClosure(bundle, agents) {
  const dependencies = {
    artifactSets: new Set(), authorities: { story: new Set(), initiative: new Set() },
    mcpServers: new Set(), agents: new Set(),
    authorityCandidates: { story: new Set(), initiative: new Set() },
    applicabilityPolicies: new Set(), templateCatalog: new Set(), worldModelViews: new Set()
  };
  const selectedPhases = { story: new Set(), initiative: new Set() };
  for (const workflow of bundle.workflows) {
    const store = STORE[workflow.governs];
    const definition = bundle.objects[workflow.governs][store.workflows][workflow.id];
    for (const [phaseId, override] of Object.entries(definition.phaseOverrides ?? {})) {
      if (override?.kind === 'skill' || override?.skillBinding != null) {
        fail(`Workflow bundle v1 cannot transfer skill phase override '${workflow.governs}:${phaseId}' without its approved package.`,
          'SKP_WORKFLOW_TRANSFER_UNSUPPORTED');
      }
    }
    collectNamedDependencies(definition, dependencies, { governs: workflow.governs });
    for (const phaseId of definition.phases ?? []) {
      if (!Object.hasOwn(bundle.objects[workflow.governs][store.phases], phaseId)) {
        fail(`Workflow bundle is missing phase '${workflow.governs}:${phaseId}'.`,
          'WORKFLOW_BUNDLE_DEPENDENCY_MISSING');
      }
      selectedPhases[workflow.governs].add(phaseId);
    }
  }
  for (const governs of ['story', 'initiative']) {
    const store = STORE[governs];
    const queue = [...selectedPhases[governs]];
    for (let cursor = 0; cursor < queue.length; cursor += 1) {
      const phaseId = queue[cursor];
      const phase = bundle.objects[governs][store.phases][phaseId];
      if (!phase) {
        fail(`Workflow bundle is missing phase '${governs}:${phaseId}'.`,
          'WORKFLOW_BUNDLE_DEPENDENCY_MISSING');
      }
      // Bundle v1 has no skill-package asset member. A phase binding without its exact entry,
      // resources, and interpretation profile would look portable while losing its authority.
      // Refuse both export and imported/hand-authored bundles until a versioned transfer format
      // can retain and validate the complete selected package closure.
      if (phase.kind === 'skill' || phase.skillBinding != null) {
        fail(`Workflow bundle v1 cannot transfer skill phase '${governs}:${phaseId}' without its approved package.`,
          'SKP_WORKFLOW_TRANSFER_UNSUPPORTED');
      }
      collectNamedDependencies(phase, dependencies, { governs });
      for (const referenced of phaseReferences(phase)) {
        if (!Object.hasOwn(bundle.objects[governs][store.phases], referenced)) {
          fail(`Workflow bundle phase '${governs}:${phaseId}' references absent phase '${referenced}'.`,
            'WORKFLOW_BUNDLE_DEPENDENCY_MISSING');
        }
        if (!selectedPhases[governs].has(referenced)) {
          selectedPhases[governs].add(referenced);
          queue.push(referenced);
        }
      }
    }
    for (const phaseId of Object.keys(bundle.objects[governs][store.phases])) {
      if (!selectedPhases[governs].has(phaseId)) {
        fail(`Workflow bundle contains unreferenced phase '${governs}:${phaseId}'.`,
          'WORKFLOW_BUNDLE_DEPENDENCY_EXTRA');
      }
    }
  }
  const artifactSetQueue = [...dependencies.artifactSets];
  for (let cursor = 0; cursor < artifactSetQueue.length; cursor += 1) {
    const id = artifactSetQueue[cursor];
    const artifactSet = bundle.objects.story.artifactSets[id];
    if (!artifactSet) {
      fail(`Workflow bundle is missing artifact set '${id}'.`, 'WORKFLOW_BUNDLE_DEPENDENCY_MISSING');
    }
    const before = new Set(dependencies.artifactSets);
    collectNamedDependencies(artifactSet, dependencies, { governs: 'story' });
    for (const dependency of dependencies.artifactSets) {
      if (!before.has(dependency)) artifactSetQueue.push(dependency);
    }
  }
  for (const id of Object.keys(bundle.objects.story.artifactSets)) {
    if (!dependencies.artifactSets.has(id)) {
      fail(`Workflow bundle contains unreferenced artifact set '${id}'.`,
        'WORKFLOW_BUNDLE_DEPENDENCY_EXTRA');
    }
  }
  for (const governs of ['story', 'initiative']) {
    for (const id of dependencies.authorities[governs]) {
      if (!Object.hasOwn(bundle.objects[governs].approvalAuthorities, id)) {
        fail(`Workflow bundle is missing approval authority '${governs}:${id}'.`,
          'WORKFLOW_BUNDLE_DEPENDENCY_MISSING');
      }
    }
    for (const id of dependencies.authorityCandidates[governs]) {
      if (Object.hasOwn(bundle.objects[governs].approvalAuthorities, id)) {
        dependencies.authorities[governs].add(id);
      }
    }
    for (const id of Object.keys(bundle.objects[governs].approvalAuthorities)) {
      if (!dependencies.authorities[governs].has(id)) {
        fail(`Workflow bundle contains unreferenced approval authority '${governs}:${id}'.`,
          'WORKFLOW_BUNDLE_DEPENDENCY_EXTRA');
      }
    }
  }
  for (const [id, server] of Object.entries(bundle.objects.story.mcpServers)) {
    if ((server?.phases ?? []).some((phaseId) => selectedPhases.story.has(phaseId))) {
      dependencies.mcpServers.add(id);
    }
  }
  for (const id of dependencies.mcpServers) {
    if (!Object.hasOwn(bundle.objects.story.mcpServers, id)) {
      fail(`Workflow bundle is missing MCP server '${id}'.`, 'WORKFLOW_BUNDLE_DEPENDENCY_MISSING');
    }
  }
  for (const [id, server] of Object.entries(bundle.objects.story.mcpServers)) {
    if (!dependencies.mcpServers.has(id)) {
      fail(`Workflow bundle contains unreferenced MCP server '${id}'.`,
        'WORKFLOW_BUNDLE_DEPENDENCY_EXTRA');
    }
    for (const agentId of server.agents ?? []) dependencies.agents.add(agentId);
  }
  for (const id of dependencies.applicabilityPolicies) {
    if (!Object.hasOwn(bundle.objects.initiative.applicabilityPolicies, id)) {
      fail(`Workflow bundle is missing applicability policy '${id}'.`,
        'WORKFLOW_BUNDLE_DEPENDENCY_MISSING');
    }
  }
  for (const id of Object.keys(bundle.objects.initiative.applicabilityPolicies)) {
    if (!dependencies.applicabilityPolicies.has(id)) {
      fail(`Workflow bundle contains unreferenced applicability policy '${id}'.`,
        'WORKFLOW_BUNDLE_DEPENDENCY_EXTRA');
    }
  }

  const templateRoots = bundle.requirements?.templateRoots;
  if (!plainObject(templateRoots)
      || Object.keys(templateRoots).some((governs) => !['story', 'initiative'].includes(governs))) {
    fail('Workflow bundle is missing its governed template-root inventory.',
      'WORKFLOW_BUNDLE_DEPENDENCY_MISSING');
  }
  for (const [governs, root] of Object.entries(templateRoots)) {
    safeAssetPath(root, `${governs} template root`);
  }

  const templateAssets = new Map();
  for (const asset of bundle.assets.filter((candidate) => candidate.kind === 'template')) {
    const key = `${asset.governs}:${asset.reference}`;
    const existing = templateAssets.get(key) ?? [];
    existing.push(asset);
    templateAssets.set(key, existing);
    const root = templateRoots[asset.governs];
    if (typeof root !== 'string') {
      fail(`Workflow bundle template '${key}' has no governed template root.`,
        'WORKFLOW_BUNDLE_DEPENDENCY_MISSING');
    }
    let declaredPath = asset.reference;
    if (isTemplateReference(asset.reference)) {
      if (asset.governs !== 'story') {
        fail(`Initiative workflow template '${asset.reference}' cannot use the Story template catalog.`,
          'WORKFLOW_BUNDLE_DEPENDENCY_MISMATCH');
      }
      const id = parseTemplateReference(asset.reference);
      const declaration = bundle.objects.story.templates[id];
      if (declaration == null) {
        fail(`Workflow bundle is missing template catalog entry '${id}'.`,
          'WORKFLOW_BUNDLE_DEPENDENCY_MISSING');
      }
      declaredPath = typeof declaration === 'string' ? declaration : declaration?.path;
      if (typeof declaredPath !== 'string' || !declaredPath) {
        fail(`Workflow bundle template catalog entry '${id}' does not define a path.`,
          'WORKFLOW_BUNDLE_DEPENDENCY_MISMATCH');
      }
    }
    const expectedPath = templateAssetPath(root, declaredPath);
    const expectedRootRelative = expectedPath === root ? '' : expectedPath.slice(root.length + 1);
    if (!expectedRootRelative || asset.rootRelative !== expectedRootRelative
        || asset.path !== `${root}/${expectedRootRelative}`) {
      fail(`Workflow bundle template '${key}' does not match its governed reference, root-relative path, and source path.`,
        'WORKFLOW_BUNDLE_DEPENDENCY_MISMATCH');
    }
  }

  const referencedTemplateAssets = new Set();
  const checkTemplate = (governs, reference, phaseId) => {
    if (reference.startsWith('agent:')) {
      const { agentId, templateId } = parseAgentTemplateReference(reference);
      dependencies.agents.add(agentId);
      const agent = agents.get(agentId);
      if (!agent) {
        fail(`Workflow bundle is missing governed agent '${agentId}' for template '${reference}'.`,
          'WORKFLOW_BUNDLE_DEPENDENCY_MISSING');
      }
      const dependency = agent.dependencies.find((candidate) => candidate.id === templateId);
      if (!dependency) {
        fail(`Governed agent '${agentId}' does not declare remote template '${templateId}'.`,
          'WORKFLOW_BUNDLE_DEPENDENCY_MISSING');
      }
      if (dependency.type !== 'template') {
        fail(`Governed agent '${agentId}' dependency '${templateId}' is '${dependency.type}', not a template.`,
          'WORKFLOW_BUNDLE_DEPENDENCY_MISMATCH');
      }
      if (!phaseId) {
        fail(`Agent template '${reference}' is not bound to a workflow phase.`,
          'WORKFLOW_BUNDLE_DEPENDENCY_MISMATCH');
      }
      if (dependency.phases.length && !dependency.phases.includes(phaseId)) {
        fail(`Agent template '${agentId}/${templateId}' is not scoped to phase '${phaseId}'.`,
          'WORKFLOW_BUNDLE_DEPENDENCY_MISMATCH');
      }
      const locked = bundle.agentLocks?.[agentId]?.dependencies?.find((candidate) =>
        candidate?.id === templateId && candidate?.type === 'template');
      if (!locked) {
        fail(`Agent template '${agentId}/${templateId}' has no matching dependency lock.`,
          'WORKFLOW_AGENT_LOCK_MISSING');
      }
      return;
    }
    if (isTemplateReference(reference)) {
      const id = parseTemplateReference(reference);
      dependencies.templateCatalog.add(id);
      if (!Object.hasOwn(bundle.objects.story.templates, id)) {
        fail(`Workflow bundle is missing template catalog entry '${id}'.`,
          'WORKFLOW_BUNDLE_DEPENDENCY_MISSING');
      }
    }
    const key = `${governs}:${reference}`;
    const matching = templateAssets.get(key) ?? [];
    if (matching.length !== 1) {
      fail(`Workflow bundle is missing template asset '${governs}:${reference}'.`,
        'WORKFLOW_BUNDLE_DEPENDENCY_MISSING');
    }
    referencedTemplateAssets.add(key);
  };
  for (const workflow of bundle.workflows) {
    const store = STORE[workflow.governs];
    const definition = bundle.objects[workflow.governs][store.workflows][workflow.id];
    const phases = bundle.objects[workflow.governs][store.phases];
    for (const { reference, phaseId } of templateReferences(workflow.governs, definition, phases)) {
      checkTemplate(workflow.governs, reference, phaseId);
    }
  }
  for (const [artifactSetId, artifactSet] of Object.entries(bundle.objects.story.artifactSets)) {
    const ownerPhases = Object.entries(bundle.objects.story.phases)
      .filter(([, phase]) => phase?.artifactSet === artifactSetId)
      .map(([phaseId]) => phaseId);
    for (const output of artifactSet.outputs ?? []) {
      if (typeof output?.template !== 'string') continue;
      if (!ownerPhases.length) checkTemplate('story', output.template, null);
      for (const phaseId of ownerPhases) checkTemplate('story', output.template, phaseId);
    }
  }
  for (const key of templateAssets.keys()) {
    if (!referencedTemplateAssets.has(key)) {
      fail(`Workflow bundle contains unreferenced template asset '${key}'.`,
        'WORKFLOW_BUNDLE_DEPENDENCY_EXTRA');
    }
  }
  for (const id of Object.keys(bundle.objects.story.templates)) {
    if (!dependencies.templateCatalog.has(id)) {
      fail(`Workflow bundle contains unreferenced template catalog entry '${id}'.`,
        'WORKFLOW_BUNDLE_DEPENDENCY_EXTRA');
    }
  }
  for (const phaseId of selectedPhases.story) {
    const defaults = [...agents.values()].filter((agent) => agent.defaultFor.includes(phaseId));
    if (defaults.length !== 1) {
      fail(`Workflow bundle phase '${phaseId}' requires exactly one default governed agent; found ${defaults.length}.`,
        'WORKFLOW_BUNDLE_DEPENDENCY_MISSING');
    }
    dependencies.agents.add(defaults[0].id);
  }
  for (const phaseId of selectedPhases.initiative) {
    for (const agent of [...agents.values()].filter((candidate) => candidate.defaultFor.includes(phaseId))) {
      dependencies.agents.add(agent.id);
    }
  }
  for (const id of dependencies.agents) {
    if (!agents.has(id)) fail(`Workflow bundle is missing governed agent '${id}'.`,
      'WORKFLOW_BUNDLE_DEPENDENCY_MISSING');
  }
  for (const id of agents.keys()) {
    if (!dependencies.agents.has(id)) {
      fail(`Workflow bundle contains unreferenced governed agent '${id}'.`,
        'WORKFLOW_BUNDLE_DEPENDENCY_EXTRA');
    }
  }
  for (const agent of agents.values()) {
    for (const view of agent.worldModelViews) dependencies.worldModelViews.add(view);
  }
  const declaredViews = new Set(bundle.requirements?.worldModelViews ?? []);
  for (const view of dependencies.worldModelViews) {
    if (!declaredViews.has(view)) fail(`Workflow bundle is missing World Model requirement '${view}'.`,
      'WORKFLOW_BUNDLE_DEPENDENCY_MISSING');
  }
  for (const view of declaredViews) {
    if (!dependencies.worldModelViews.has(view)) {
      fail(`Workflow bundle contains unreferenced World Model requirement '${view}'.`,
        'WORKFLOW_BUNDLE_DEPENDENCY_EXTRA');
    }
  }
}

async function readAgentLock(root, { optional = true } = {}) {
  const secured = await secureRepositoryPath(root, AGENT_LOCK_PATH, {
    label: AGENT_LOCK_PATH, mustExist: !optional, type: 'file'
  });
  const file = secured.absolute;
  if (!secured.exists) return { file, text: '', value: { version: 1, agents: {} } };
  const text = await readFile(file, 'utf8');
  let value;
  try { value = YAML.parse(text); }
  catch (error) { fail(`Cannot parse ${AGENT_LOCK_PATH}: ${error.message}`, 'WORKFLOW_AGENT_LOCK_INVALID'); }
  if (!plainObject(value) || value.version !== 1 || !plainObject(value.agents)) {
    fail(`${AGENT_LOCK_PATH} must contain version 1 and an agents object.`, 'WORKFLOW_AGENT_LOCK_INVALID');
  }
  return { file, text, value };
}

function lockedAgentEntry(lock, agent) {
  if (!agent.dependencies.length) return null;
  const entry = lock?.agents?.[agent.id];
  if (!plainObject(entry)) {
    fail(`Governed agent '${agent.id}' has remote dependencies but no exact ${AGENT_LOCK_PATH} entry. `
      + `Run singularity-flow agents lock ${agent.id} before exporting this workflow.`,
    'WORKFLOW_AGENT_LOCK_MISSING');
  }
  if (entry.sourceSha256 !== agent.sha256) {
    fail(`Governed agent '${agent.id}' changed after its dependency lock was recorded. `
      + `Run singularity-flow agents lock ${agent.id} --update before exporting this workflow.`,
    'WORKFLOW_AGENT_LOCK_STALE');
  }
  if (!Array.isArray(entry.dependencies)) {
    fail(`Governed agent '${agent.id}' has an invalid dependency lock.`, 'WORKFLOW_AGENT_LOCK_INVALID');
  }
  const dependencies = [];
  for (const dependency of agent.dependencies) {
    const locked = entry.dependencies.find((candidate) => candidate?.id === dependency.id
      && candidate?.type === dependency.type);
    if (!locked) {
      fail(`Governed agent '${agent.id}' dependency '${dependency.id}' is not locked. `
        + `Run singularity-flow agents lock ${agent.id} --update before exporting this workflow.`,
      'WORKFLOW_AGENT_LOCK_MISSING');
    }
    if (!plainObject(locked) || locked.maxBytes !== dependency.maxBytes) {
      fail(`Governed agent '${agent.id}' dependency '${dependency.id}' has invalid locked metadata.`,
        'WORKFLOW_AGENT_LOCK_INVALID');
    }
    if (dependency.type === 'generated') {
      if (locked.dynamic !== true || locked.urlTemplate !== dependency.url) {
        fail(`Governed agent '${agent.id}' generated dependency '${dependency.id}' has a stale lock.`,
          'WORKFLOW_AGENT_LOCK_STALE');
      }
    } else if (locked.url !== dependency.url
        || (locked.status === 'unavailable'
          ? (!dependency.optional || locked.sha256 != null)
          : !/^[a-f0-9]{64}$/.test(locked.sha256 ?? ''))) {
      fail(`Governed agent '${agent.id}' dependency '${dependency.id}' has a stale or invalid lock.`,
        'WORKFLOW_AGENT_LOCK_STALE');
    }
    dependencies.push(clone(locked));
  }
  return {
    source: entry.source,
    sourceSha256: entry.sourceSha256,
    lockedAt: entry.lockedAt,
    dependencies
  };
}

async function buildBundle(root, workflowIds) {
  const sourceRoot = configurationReadRoot(root);
  const story = await readYamlDocument(sourceRoot, STORE.story, { optional: true });
  const initiative = await readYamlDocument(sourceRoot, STORE.initiative, { optional: true });
  if (!story && !initiative) fail('No governed workflow configuration exists. Run singularity-flow init first.',
    'WORKFLOW_CONFIGURATION_MISSING');
  const configs = { story: story?.value ?? {}, initiative: initiative?.value ?? {} };
  const documents = { story, initiative };
  const requested = [...new Set(workflowIds.map((id) => String(id).trim()).filter(Boolean))];
  if (!requested.length) fail('Choose at least one workflow to export.', 'WORKFLOW_EXPORT_SELECTION_REQUIRED');
  const selected = [];
  for (const selector of requested) {
    const parsed = parseWorkflowSelector(selector);
    const { id } = parsed;
    const matches = Object.entries(STORE).filter(([governs, store]) =>
      (!parsed.governs || parsed.governs === governs)
      && Object.hasOwn(configs[governs]?.[store.workflows] ?? {}, id));
    if (!matches.length) fail(`Unknown workflow '${selector}'.`, 'WORKFLOW_UNKNOWN');
    if (matches.length > 1) {
      fail(`Workflow '${id}' exists for Story and Initiative work. Select story:${id} or initiative:${id}.`,
        'WORKFLOW_SELECTOR_AMBIGUOUS');
    }
    const governs = matches[0][0];
    if (!selected.some((entry) => entry.governs === governs && entry.id === id)) {
      selected.push({ governs, id });
    }
  }

  const objects = emptyObjects();
  const dependencies = {
    artifactSets: new Set(), authorities: { story: new Set(), initiative: new Set() },
    mcpServers: new Set(), agents: new Set(),
    authorityCandidates: { story: new Set(), initiative: new Set() },
    applicabilityPolicies: new Set(), worldModelViews: new Set()
  };
  const selectedPhases = { story: new Set(), initiative: new Set() };
  const workflows = [];

  for (const { governs, id } of selected) {
    const store = STORE[governs];
    const config = configs[governs];
    const definition = config[store.workflows][id];
    for (const [phaseId, override] of Object.entries(definition.phaseOverrides ?? {})) {
      if (override?.kind === 'skill' || override?.skillBinding != null) {
        fail(`Workflow bundle v1 cannot transfer skill phase override '${governs}:${phaseId}' without its approved package.`,
          'SKP_WORKFLOW_TRANSFER_UNSUPPORTED');
      }
    }
    const targetMap = governs === 'story' ? objects.story.workTypes : objects.initiative.initiativeProfiles;
    addMapEntry(targetMap, id, definition, `${governs}-workflow`);
    workflows.push({ id, governs, definitionSha256: digest(definition) });
    for (const phaseId of definition.phases ?? []) selectedPhases[governs].add(phaseId);
    collectNamedDependencies(definition, dependencies, { governs });
  }

  for (const governs of ['story', 'initiative']) {
    const config = configs[governs];
    const store = STORE[governs];
    const queue = [...selectedPhases[governs]];
    for (let cursor = 0; cursor < queue.length; cursor += 1) {
      const phaseId = queue[cursor];
      const phase = config?.[store.phases]?.[phaseId];
      if (!phase) fail(`Workflow dependency phase '${governs}:${phaseId}' is not defined.`,
        'WORKFLOW_DEPENDENCY_MISSING');
      if (phase.kind === 'skill' || phase.skillBinding != null) {
        fail(`Workflow bundle v1 cannot transfer skill phase '${governs}:${phaseId}' without its approved package.`,
          'SKP_WORKFLOW_TRANSFER_UNSUPPORTED');
      }
      const targetMap = governs === 'story' ? objects.story.phases : objects.initiative.initiativePhases;
      addMapEntry(targetMap, phaseId, phase, `${governs}-phase`);
      collectNamedDependencies(phase, dependencies, { governs });
      for (const reference of phaseReferences(phase)) {
        if (!selectedPhases[governs].has(reference) && config?.[store.phases]?.[reference]) {
          selectedPhases[governs].add(reference); queue.push(reference);
        }
      }
    }
  }

  for (const [id, value] of Object.entries(configs.story?.mcpServers ?? {})) {
    if ((value?.phases ?? []).some((phase) => selectedPhases.story.has(phase))) dependencies.mcpServers.add(id);
  }
  for (const id of dependencies.artifactSets) {
    const value = configs.story?.artifactSets?.[id];
    if (!value) fail(`Referenced artifact set '${id}' is not defined.`, 'WORKFLOW_DEPENDENCY_MISSING');
    addMapEntry(objects.story.artifactSets, id, value, 'artifact-set');
    // Artifact sets own output templates and can carry their own approval contract.  They are
    // part of the executable dependency closure rather than passive display metadata.
    collectNamedDependencies(value, dependencies, { governs: 'story' });
  }
  for (const id of dependencies.mcpServers) {
    const value = configs.story?.mcpServers?.[id];
    if (!value) fail(`Referenced MCP server '${id}' is not defined.`, 'WORKFLOW_DEPENDENCY_MISSING');
    addMapEntry(objects.story.mcpServers, id, value, 'mcp-server');
    for (const agent of value.agents ?? []) dependencies.agents.add(agent);
  }
  for (const governs of ['story', 'initiative']) {
    for (const id of dependencies.authorities[governs]) {
      const value = configs[governs]?.approvalAuthorities?.[id];
      if (!value) fail(`Referenced approval authority '${governs}:${id}' is not defined.`,
        'WORKFLOW_DEPENDENCY_MISSING');
      const target = governs === 'story'
        ? objects.story.approvalAuthorities : objects.initiative.approvalAuthorities;
      addMapEntry(target, id, value, `${governs}-approval-authority`);
    }
  }
  for (const governs of ['story', 'initiative']) {
    for (const id of dependencies.authorityCandidates[governs]) {
      const value = configs[governs]?.approvalAuthorities?.[id];
      if (!value) continue;
      const target = governs === 'story'
        ? objects.story.approvalAuthorities : objects.initiative.approvalAuthorities;
      addMapEntry(target, id, value, `${governs}-approval-authority`);
    }
  }
  for (const id of dependencies.applicabilityPolicies) {
    const value = configs.initiative?.applicabilityPolicies?.[id];
    if (!value) fail(`Referenced applicability policy '${id}' is not defined.`, 'WORKFLOW_DEPENDENCY_MISSING');
    addMapEntry(objects.initiative.applicabilityPolicies, id, value, 'applicability-policy');
  }

  // Resolve every template before freezing the agent set.  Agent-backed templates (`agent:id`)
  // are dependencies too; collecting them after serializing agents silently produced incomplete
  // bundles for otherwise valid workflow overrides.
  const templateSelections = [];
  const sourceTemplateRoots = {};
  for (const { governs, id } of selected) {
    const store = STORE[governs];
    const workflow = configs[governs][store.workflows][id];
    const phaseMap = Object.fromEntries([...selectedPhases[governs]].map((phaseId) =>
      [phaseId, configs[governs][store.phases][phaseId]]));
    const rootPath = configuredTemplateRoot(configs[governs], governs, configs.story);
    sourceTemplateRoots[governs] = rootPath;
    const references = templateReferences(governs, workflow, phaseMap);
    if (governs === 'story') {
      for (const [artifactSetId, artifactSet] of Object.entries(objects.story.artifactSets)) {
        const ownerPhases = Object.entries(phaseMap)
          .filter(([, phase]) => phase?.artifactSet === artifactSetId)
          .map(([phaseId]) => phaseId);
        for (const output of artifactSet?.outputs ?? []) {
          if (typeof output?.template !== 'string') continue;
          if (!ownerPhases.length) references.push({ governs, reference: output.template, phaseId: null });
          for (const phaseId of ownerPhases) references.push({
            governs, reference: output.template, phaseId
          });
        }
      }
    }
    for (const { reference } of references) {
      if (reference.startsWith('agent:')) {
        const { agentId } = parseAgentTemplateReference(reference);
        dependencies.agents.add(agentId);
        continue;
      }
      let fileReference = reference;
      if (isTemplateReference(reference)) {
        if (governs !== 'story') {
          fail(`Initiative workflow template '${reference}' cannot use the Story template catalog.`,
            'WORKFLOW_DEPENDENCY_MISSING');
        }
        const templateId = parseTemplateReference(reference);
        const declaration = configs.story?.templates?.[templateId];
        if (declaration == null) {
          fail(`Referenced template catalog entry '${templateId}' is not defined.`,
            'WORKFLOW_DEPENDENCY_MISSING');
        }
        addMapEntry(objects.story.templates, templateId, declaration, 'template');
        fileReference = typeof declaration === 'string' ? declaration : declaration?.path;
        if (typeof fileReference !== 'string' || !fileReference) {
          fail(`Template catalog entry '${templateId}' does not define a path.`,
            'WORKFLOW_DEPENDENCY_MISSING');
        }
      }
      const relative = templateAssetPath(rootPath, fileReference);
      const rootRelative = relative === rootPath ? '' : relative.slice(rootPath.length + 1);
      if (!rootRelative) fail(`Template '${reference}' does not identify a file below ${rootPath}.`,
        'WORKFLOW_BUNDLE_PATH_INVALID');
      templateSelections.push({ governs, reference, relative, rootRelative });
    }
  }

  const discovered = await discoverAgents(sourceRoot);
  const sourceAgentLock = await readAgentLock(sourceRoot);
  for (const phaseId of new Set([...selectedPhases.story, ...selectedPhases.initiative])) {
    for (const agent of discovered.filter((candidate) => candidate.defaultFor.includes(phaseId))) {
      dependencies.agents.add(agent.id);
    }
  }
  const assets = [];
  const agentLocks = {};
  const assetIdentity = new Map();
  const pushAsset = (asset) => {
    const identity = `${asset.kind}:${asset.governs ?? ''}:${portableFilesystemPathIdentity(asset.path)}`;
    const prior = assetIdentity.get(identity);
    if (prior) {
      if (prior.sha256 !== asset.sha256) fail(`Bundle asset '${identity}' has conflicting content.`,
        'WORKFLOW_BUNDLE_ASSET_CONFLICT');
      return;
    }
    assetIdentity.set(identity, asset); assets.push(asset);
  };

  for (const agentId of [...dependencies.agents].sort()) {
    const agent = discovered.find((candidate) => candidate.id === agentId);
    if (!agent) fail(`Referenced governed agent '${agentId}' is not installed.`, 'WORKFLOW_DEPENDENCY_MISSING');
    const content = agent.text;
    if (agent.scope === 'repository') {
      await secureRepositoryPath(sourceRoot, agent.source, {
        label: `Governed agent '${agentId}'`, mustExist: true, type: 'file'
      });
    }
    const size = Buffer.byteLength(content, 'utf8');
    if (size > MAX_ASSET_BYTES) fail(`Agent '${agentId}' exceeds the portable asset limit.`,
      'WORKFLOW_BUNDLE_LIMIT_EXCEEDED');
    pushAsset({
      kind: 'agent', id: agentId, path: `.github/agents/${agentId}.agent.md`,
      mediaType: 'text/markdown; charset=utf-8', size, sha256: digest(content), content
    });
    const lockEntry = lockedAgentEntry(sourceAgentLock.value, agent);
    if (lockEntry) agentLocks[agentId] = lockEntry;
    for (const view of agent.worldModelViews) dependencies.worldModelViews.add(view);
  }

  for (const { governs, reference, relative, rootRelative } of templateSelections) {
      const secured = await secureRepositoryPath(sourceRoot, relative, {
        label: `Template '${reference}'`, mustExist: true, type: 'file'
      });
      const file = secured.absolute;
      const info = secured.entry;
      if (info.size > MAX_ASSET_BYTES) fail(`Template '${reference}' exceeds the portable asset limit.`,
        'WORKFLOW_BUNDLE_LIMIT_EXCEEDED');
      const content = await readFile(file, 'utf8');
      const size = Buffer.byteLength(content, 'utf8');
      pushAsset({
        kind: 'template', governs, reference, rootRelative, path: relative,
        mediaType: 'text/markdown; charset=utf-8', size, sha256: digest(content), content
      });
  }
  if (assets.length > MAX_ASSETS || assets.reduce((total, asset) => total + asset.size, 0) > MAX_ASSET_BYTES_TOTAL) {
    fail('Workflow bundle exceeds the portable asset limits.', 'WORKFLOW_BUNDLE_LIMIT_EXCEEDED');
  }

  const bundle = {
    schemaVersion: WORKFLOW_BUNDLE_SCHEMA_VERSION,
    kind: WORKFLOW_BUNDLE_KIND,
    workflows: workflows.sort((a, b) => `${a.governs}:${a.id}`.localeCompare(`${b.governs}:${b.id}`)),
    objects,
    agentLocks,
    assets: assets.sort((a, b) => `${a.kind}:${a.governs ?? ''}:${a.path}`
      .localeCompare(`${b.kind}:${b.governs ?? ''}:${b.path}`)),
    requirements: {
      templateRoots: canonicalValue(sourceTemplateRoots),
      worldModelViews: [...dependencies.worldModelViews].sort(),
      externalAgentDependencies: discovered
        .filter((agent) => dependencies.agents.has(agent.id))
        .flatMap((agent) => agent.dependencies.map((entry) => ({
          agent: agent.id, id: entry.id, type: entry.type, url: entry.url,
          optional: entry.optional, maxBytes: entry.maxBytes
        })))
        .sort((a, b) => `${a.agent}:${a.id}`.localeCompare(`${b.agent}:${b.id}`)),
      dependencyMaterialization: Object.keys(agentLocks).length ? 'hash-verified-refetch' : 'none'
    }
  };
  bundle.bundleSha256 = digest(bundleWithoutDigest(bundle));
  return bundle;
}

async function validateBundle(raw) {
  const { record } = readRecord(WORKFLOW_BUNDLE_FAMILY, raw);
  raw = record;
  if (!plainObject(raw) || raw.kind !== WORKFLOW_BUNDLE_KIND) {
    fail(`Workflow bundle must use ${WORKFLOW_BUNDLE_KIND} schema version ${WORKFLOW_BUNDLE_SCHEMA_VERSION}.`);
  }
  if (!Array.isArray(raw.workflows) || !raw.workflows.length || !plainObject(raw.objects)
      || !plainObject(raw.objects.story) || !plainObject(raw.objects.initiative)
      || !plainObject(raw.agentLocks) || !Array.isArray(raw.assets) || !plainObject(raw.requirements)
      || !Array.isArray(raw.requirements.worldModelViews)) {
    fail('Workflow bundle is missing workflows, objects, agent locks, or assets.');
  }
  const expectedObjects = emptyObjects();
  if (canonicalJson(Object.keys(raw.objects).sort()) !== canonicalJson(Object.keys(expectedObjects).sort())) {
    fail('Workflow bundle has unknown or missing governed object sections.');
  }
  for (const governs of Object.keys(expectedObjects)) {
    if (canonicalJson(Object.keys(raw.objects[governs]).sort())
        !== canonicalJson(Object.keys(expectedObjects[governs]).sort())) {
      fail(`Workflow bundle has unknown or missing '${governs}' object catalogs.`);
    }
  }
  for (const { governs, section } of configSections(raw)) {
    if (!plainObject(raw.objects[governs]?.[section])) {
      fail(`Workflow bundle object catalog '${governs}.${section}' must be an object.`);
    }
  }
  const expected = digest(bundleWithoutDigest(raw));
  if (raw.bundleSha256 !== expected) fail('Workflow bundle digest does not match its content.',
    'WORKFLOW_BUNDLE_DIGEST_MISMATCH');
  if (raw.assets.length > MAX_ASSETS) fail('Workflow bundle has too many assets.', 'WORKFLOW_BUNDLE_LIMIT_EXCEEDED');
  let total = 0;
  const identities = new Set();
  const agents = new Map();
  for (const asset of raw.assets) {
    if (!plainObject(asset) || !['template', 'agent'].includes(asset.kind)
        || typeof asset.content !== 'string' || typeof asset.sha256 !== 'string'
        || typeof asset.mediaType !== 'string') {
      fail('Workflow bundle contains an invalid asset record.');
    }
    safeAssetPath(asset.path);
    if (asset.kind === 'agent' && (!ID.test(asset.id ?? '')
        || asset.path !== `.github/agents/${asset.id}.agent.md`)) {
      fail(`Workflow bundle agent path is not canonical: ${asset.path}`);
    }
    if (asset.kind === 'template') {
      if (!['story', 'initiative'].includes(asset.governs)
          || typeof asset.reference !== 'string' || !asset.reference
          || typeof asset.rootRelative !== 'string') {
        fail(`Workflow bundle template asset is missing its governed reference: ${asset.path}`);
      }
      if (isTemplateReference(asset.reference)) parseTemplateReference(asset.reference);
      else safeAssetPath(asset.reference, 'Template reference');
      safeAssetPath(asset.rootRelative, 'Template root-relative path');
    }
    const identity = `${asset.kind}:${asset.governs ?? ''}:${portableFilesystemPathIdentity(asset.path)}`;
    if (identities.has(identity)) fail(`Workflow bundle repeats asset '${identity}'.`);
    identities.add(identity);
    const size = Buffer.byteLength(asset.content, 'utf8');
    if (size !== asset.size || size > MAX_ASSET_BYTES || digest(asset.content) !== asset.sha256) {
      fail(`Workflow bundle asset '${asset.path}' failed size or digest validation.`,
        'WORKFLOW_BUNDLE_ASSET_INVALID');
    }
    if (/^text\//i.test(asset.mediaType)) {
      const format = textAssetFormat(Buffer.from(asset.content, 'utf8'));
      if (!format.valid) {
        fail(`Workflow bundle asset '${asset.path}' ${format.reason}.`,
          'WORKFLOW_BUNDLE_ASSET_INVALID');
      }
    }
    if (asset.kind === 'agent') {
      const parsed = parseAgentDependencies(asset.content, { source: asset.path, agentId: asset.id });
      agents.set(asset.id, { ...parsed, sha256: asset.sha256.replace(/^sha256:/, '') });
    }
    total += size;
  }
  if (total > MAX_ASSET_BYTES_TOTAL) fail('Workflow bundle assets exceed the aggregate limit.',
    'WORKFLOW_BUNDLE_LIMIT_EXCEEDED');
  for (const id of Object.keys(raw.agentLocks)) {
    requireId(id, 'Agent lock identifier');
    if (!agents.has(id)) fail(`Workflow bundle has a lock for absent agent '${id}'.`,
      'WORKFLOW_AGENT_LOCK_INVALID');
  }
  for (const agent of agents.values()) {
    const locked = lockedAgentEntry({ agents: raw.agentLocks }, agent);
    if (!agent.dependencies.length && Object.hasOwn(raw.agentLocks, agent.id)) {
      fail(`Workflow bundle carries an unnecessary lock for local-only agent '${agent.id}'.`,
        'WORKFLOW_AGENT_LOCK_INVALID');
    }
    if (agent.dependencies.length && !locked) {
      fail(`Workflow bundle is missing the dependency lock for agent '${agent.id}'.`,
        'WORKFLOW_AGENT_LOCK_MISSING');
    }
  }
  validateBundleClosure(raw, agents);

  let objectCount = 0;
  for (const [governs, section] of Object.entries(raw.objects)) {
    if (!plainObject(section)) fail('Workflow bundle object sections must be objects.');
    for (const [catalog, values] of Object.entries(section)) {
      if (!plainObject(values)) fail('Workflow bundle object catalogs must be objects.');
      for (const id of Object.keys(values)) requireId(id, `${governs}.${catalog} object identifier`);
      objectCount += Object.keys(values).length;
    }
  }
  if (objectCount > MAX_OBJECTS) fail('Workflow bundle has too many configuration objects.',
    'WORKFLOW_BUNDLE_LIMIT_EXCEEDED');
  const workflowIdentities = new Set();
  for (const entry of raw.workflows) {
    if (!plainObject(entry) || !['story', 'initiative'].includes(entry.governs) || !ID.test(entry.id ?? '')) {
      fail('Workflow bundle has an invalid workflow identity.');
    }
    const identity = `${entry.governs}:${entry.id}`;
    if (workflowIdentities.has(identity)) fail(`Workflow bundle repeats workflow '${identity}'.`);
    workflowIdentities.add(identity);
    const catalog = entry.governs === 'story'
      ? raw.objects.story.workTypes : raw.objects.initiative.initiativeProfiles;
    if (!Object.hasOwn(catalog ?? {}, entry.id) || digest(catalog[entry.id]) !== entry.definitionSha256) {
      fail(`Workflow bundle definition digest is invalid for '${identity}'.`,
        'WORKFLOW_BUNDLE_DIGEST_MISMATCH');
    }
  }
  const catalogWorkflows = [
    ...Object.keys(raw.objects.story.workTypes).map((id) => `story:${id}`),
    ...Object.keys(raw.objects.initiative.initiativeProfiles).map((id) => `initiative:${id}`)
  ].sort();
  if (canonicalJson([...workflowIdentities].sort()) !== canonicalJson(catalogWorkflows)) {
    fail('Workflow bundle workflow inventory does not exactly match its governed workflow objects.');
  }
  return clone(raw);
}

export async function exportWorkflowBundle(root, workflowIds, outPath = null) {
  const bundle = await buildBundle(root, workflowIds);
  await validateBundle(bundle);
  if (!outPath) return bundle;
  const target = path.resolve(outPath);
  await mkdir(path.dirname(target), { recursive: true });
  let handle;
  try {
    handle = await open(target, 'wx', 0o600);
    await handle.writeFile(`${JSON.stringify(canonicalValue(bundle), null, 2)}\n`, 'utf8');
  } catch (error) {
    if (error?.code === 'EEXIST') fail(`Workflow bundle output already exists: ${target}`,
      'WORKFLOW_EXPORT_OUTPUT_EXISTS');
    throw error;
  } finally { await handle?.close(); }
  return {
    schemaVersion: 1, resultType: 'workflow-export', status: 'exported', outputPath: target,
    bundleSha256: bundle.bundleSha256, workflows: bundle.workflows,
    summary: summarizeBundle(bundle), dependencies: dependencyInventory(bundle)
  };
}

export async function readWorkflowBundle(filePath) {
  const file = path.resolve(filePath);
  const info = await regularFile(file, 'Workflow bundle');
  if (info.size > MAX_BUNDLE_BYTES) fail('Workflow bundle file exceeds its size limit.',
    'WORKFLOW_BUNDLE_LIMIT_EXCEEDED');
  const text = await readFile(file, 'utf8');
  let parsed;
  try { parsed = JSON.parse(text); }
  catch (error) { fail(`Workflow bundle is not valid JSON: ${error.message}`); }
  return validateBundle(parsed);
}

async function normalizedBundle(bundleOrPath) {
  return typeof bundleOrPath === 'string'
    ? readWorkflowBundle(bundleOrPath) : validateBundle(bundleOrPath);
}

function configSections(bundle) {
  return [
    ['story', 'workTypes'], ['story', 'phases'], ['story', 'templates'], ['story', 'artifactSets'],
    ['story', 'approvalAuthorities'], ['story', 'mcpServers'],
    ['initiative', 'initiativeProfiles'], ['initiative', 'initiativePhases'],
    ['initiative', 'approvalAuthorities'], ['initiative', 'applicabilityPolicies']
  ].map(([governs, section]) => ({ governs, section, values: bundle.objects[governs][section] ?? {} }));
}

function linkedDependencyKind(governs, section) {
  return ({
    phases: `${governs}.phase`,
    initiativePhases: `${governs}.phase`,
    templates: 'template-catalog',
    artifactSets: 'artifact-set',
    approvalAuthorities: `${governs}.approval-authority`,
    mcpServers: 'mcp-server',
    applicabilityPolicies: 'applicability-policy'
  })[section] ?? `${governs}.${section}`;
}

function targetTemplatePath(asset, storyValue, initiativeValue) {
  if (asset.kind === 'agent') return asset.path;
  const governs = asset.governs;
  const targetRoot = configuredTemplateRoot(
    governs === 'story' ? storyValue : initiativeValue, governs, storyValue
  );
  const rootRelative = safeAssetPath(asset.rootRelative, 'Template root-relative path');
  return `${targetRoot}/${rootRelative}`;
}

async function targetSnapshot(root, bundle) {
  const targetRoot = configurationReadRoot(root);
  const story = await readYamlDocument(targetRoot, STORE.story, {
    optional: !Object.keys(bundle.objects.story.workTypes ?? {}).length
  });
  const initiative = await readYamlDocument(targetRoot, STORE.initiative, {
    optional: !Object.keys(bundle.objects.initiative.initiativeProfiles ?? {}).length
  });
  const agentLock = await readAgentLock(targetRoot);
  return { root: targetRoot, story, initiative, agentLock };
}

function entry(kind, id, extra = {}) { return { kind, id, ...extra }; }

function mergedConfigurationValue(existing, bundle, governs) {
  const merged = clone(existing);
  for (const { section, values } of configSections(bundle).filter((item) => item.governs === governs)) {
    merged[section] ??= {};
    for (const [id, value] of Object.entries(values)) {
      if (!Object.hasOwn(merged[section], id)) merged[section][id] = clone(value);
    }
  }
  return merged;
}

async function mergedImportAgentCatalog(root, bundle) {
  const catalog = new Map((await discoverAgents(root)).map((agent) => [agent.id, agent]));
  for (const asset of bundle.assets.filter((candidate) => candidate.kind === 'agent')) {
    const parsed = parseAgentDependencies(asset.content, { source: asset.path, agentId: asset.id });
    catalog.set(asset.id, {
      ...parsed, scope: 'repository', file: path.join(root, asset.path), text: asset.content,
      sha256: asset.sha256.replace(/^sha256:/, '')
    });
  }
  return catalog;
}

function storyImportCandidate(value, agentCatalog) {
  const candidate = clone(value);
  candidate.agentCatalog = [...agentCatalog.values()]
    .sort((left, right) => left.id.localeCompare(right.id));
  candidate.agents = Object.fromEntries(candidate.agentCatalog.map((agent) => [agent.id, agent]));
  return candidate;
}

function validateStoryImportCandidate(value, agentCatalog) {
  const candidate = storyImportCandidate(value, agentCatalog);
  validateDefinition(candidate);
  validateAgentCatalog(candidate.agentCatalog, candidate);
  return candidate;
}

export async function planWorkflowImport(root, bundleOrPath) {
  const bundle = await normalizedBundle(bundleOrPath);
  const target = await targetSnapshot(root, bundle);
  const values = { story: target.story?.value ?? {}, initiative: target.initiative?.value ?? {} };
  const add = []; const reuse = []; const conflicts = [];
  for (const { governs, section, values: incoming } of configSections(bundle)) {
    const existing = values[governs][section] ?? {};
    for (const [id, value] of Object.entries(incoming)) {
      const record = entry(`${governs}.${section}`, id);
      if (!Object.hasOwn(existing, id)) add.push(record);
      else if (canonicalJson(existing[id]) === canonicalJson(value)) reuse.push(record);
      else conflicts.push({ ...record, reason: 'same ID has different content' });
    }
  }
  for (const [id, value] of Object.entries(bundle.agentLocks)) {
    const existing = target.agentLock.value.agents[id];
    const record = entry('agent-lock', id);
    if (existing == null) add.push(record);
    else if (canonicalJson(existing) === canonicalJson(value)) reuse.push(record);
    else conflicts.push({ ...record, reason: 'same agent has a different dependency lock' });
  }
  const assetTargets = [];
  const targetPaths = new Map();
  for (const asset of bundle.assets) {
    const relative = targetTemplatePath(asset, values.story, values.initiative);
    const targetIdentity = portableFilesystemPathIdentity(relative);
    const prior = targetPaths.get(targetIdentity);
    if (prior) {
      if (prior.sha256 !== asset.sha256) {
        conflicts.push(entry('asset', relative, { reason: 'two bundle assets map to this target with different content' }));
      }
      continue;
    }
    targetPaths.set(targetIdentity, { ...asset, targetPath: relative });
    const targetState = await portableTargetState(target.root, relative);
    const file = await assertSafeTarget(target.root, relative);
    const info = targetState.caseConflict ? null
      : await lstat(file).catch((error) => error?.code === 'ENOENT' ? null : Promise.reject(error));
    if (targetState.caseConflict) {
      conflicts.push(entry(asset.kind, relative, {
        reason: `target collides by portable path identity with '${targetState.caseConflict}'`
      }));
    } else if (!info) add.push(entry(asset.kind, relative, { sha256: asset.sha256 }));
    else if (!info.isFile() || info.isSymbolicLink()) {
      conflicts.push(entry(asset.kind, relative, { reason: 'target is not a regular file' }));
    } else {
      const content = await readFile(file);
      const comparison = importedAssetReuse(asset, content);
      if (comparison.reusable) reuse.push(entry(asset.kind, relative, { sha256: asset.sha256 }));
      else conflicts.push(entry(asset.kind, relative, { reason: comparison.reason }));
    }
    assetTargets.push({ asset, relative });
  }
  const agentCatalog = await mergedImportAgentCatalog(target.root, bundle);
  const incomingConfiguration = Object.fromEntries(['story', 'initiative'].map((governs) => [
    governs,
    configSections(bundle).filter((item) => item.governs === governs)
      .some((item) => Object.keys(item.values).length)
  ]));
  const candidates = Object.fromEntries(['story', 'initiative'].map((governs) => [
    governs, mergedConfigurationValue(values[governs], bundle, governs)
  ]));
  // Preview the complete merged schema before asking for confirmation.  A valid source bundle can
  // still be incompatible with a target repository's global policy (for example, a legacy view
  // assignment under a registered-v4 catalog).  That is an import conflict, not a surprise apply
  // failure after the user has confirmed a supposedly ready plan.
  for (const governs of ['story', 'initiative']) {
    const hasObjectConflict = conflicts.some((item) => item.kind.startsWith(`${governs}.`));
    if (!incomingConfiguration[governs] || hasObjectConflict) continue;
    try {
      if (governs === 'story') validateStoryImportCandidate(candidates.story, agentCatalog);
      else validatePortfolio(clone(candidates.initiative));
    } catch (error) {
      conflicts.push(entry(`${governs}.configuration`, STORE[governs].file, {
        reason: error?.message ?? String(error), code: error?.code ?? 'WORKFLOW_CONFIGURATION_INVALID'
      }));
    }
  }
  // Initiative routing is a two-document contract: a portfolio can be structurally valid on its
  // own while assigning a view absent from the repository's Story World-Model catalog.  Check the
  // exact merged pair before presenting a ready plan, including for Initiative-only bundles.
  if (incomingConfiguration.initiative
      && !conflicts.some((item) => item.kind.startsWith('story.')
        || item.kind.startsWith('initiative.'))) {
    try {
      const storyCandidate = storyImportCandidate(candidates.story, agentCatalog);
      const portfolioCandidate = validatePortfolio(clone(candidates.initiative));
      validatePortfolioWorldModelViews(portfolioCandidate, storyCandidate);
    } catch (error) {
      conflicts.push(entry('initiative.configuration', STORE.initiative.file, {
        reason: error?.message ?? String(error), code: error?.code ?? 'WORKFLOW_CONFIGURATION_INVALID'
      }));
    }
  }
  const state = {
    story: digest(target.story?.text ?? ''), initiative: digest(target.initiative?.text ?? ''),
    agentLock: digest(target.agentLock.text),
    assets: [...targetPaths.values()].map(({ targetPath: relative }) => relative).sort().map((relative) => {
      const operation = [...add, ...reuse, ...conflicts].find((item) => item.id === relative);
      return { path: relative, state: operation?.reason ?? operation?.sha256 ?? operation?.kind ?? 'unknown' };
    })
  };
  const changedPaths = new Set();
  if (add.some((item) => item.kind.startsWith('story.'))) changedPaths.add(WORKFLOW_PATH);
  if (add.some((item) => item.kind.startsWith('initiative.'))) changedPaths.add(PORTFOLIO_PATH);
  if (add.some((item) => item.kind === 'agent-lock')) changedPaths.add(AGENT_LOCK_PATH);
  for (const item of add) {
    if (item.kind === 'agent' || item.kind === 'template' || item.kind === 'asset') changedPaths.add(item.id);
  }
  const planCore = {
    schemaVersion: 1, resultType: 'workflow-import-plan', bundleSha256: bundle.bundleSha256,
    targetStateSha256: digest(state),
    operations: {
      add: add.sort((a, b) => `${a.kind}:${a.id}`.localeCompare(`${b.kind}:${b.id}`)),
      reuse: reuse.sort((a, b) => `${a.kind}:${a.id}`.localeCompare(`${b.kind}:${b.id}`)),
      conflicts: conflicts.sort((a, b) => `${a.kind}:${a.id}`.localeCompare(`${b.kind}:${b.id}`))
    },
    changedPaths: [...changedPaths].sort(),
    sharedDependencies: summarizeBundle(bundle)
  };
  const planSha256 = digest(planCore);
  const result = {
    ...planCore, planSha256, status: conflicts.length ? 'blocked' : 'ready',
    added: planCore.operations.add, reused: planCore.operations.reuse,
    conflicts: planCore.operations.conflicts,
    counts: { add: add.length, reuse: reuse.length, conflicts: conflicts.length },
  };
  // Kept non-enumerable so apply can reuse a validated target map without disclosing absolute
  // paths in JSON or binding the plan digest to a temporary approved-configuration mount.
  Object.defineProperty(result, '_internal', {
    value: { bundle, target, assetTargets }, enumerable: false, configurable: false, writable: false
  });
  return result;
}

async function rollbackWrites(applied) {
  const failures = [];
  for (const item of [...applied].reverse()) {
    try {
      if (item.previous == null) await rm(item.file, { force: true });
      else await writeFile(item.file, item.previous);
    } catch (error) {
      failures.push({ file: item.file, message: error?.message ?? String(error) });
    }
  }
  return failures;
}

async function applyFiles(files) {
  const applied = [];
  try {
    for (const { file, content } of files) {
      const info = await lstat(file).catch((error) => error?.code === 'ENOENT' ? null : Promise.reject(error));
      const previous = info ? await readFile(file) : null;
      const directory = path.dirname(file);
      await mkdir(directory, { recursive: true });
      const temporary = path.join(directory, `.sflow-workflow-import-${process.pid}-${randomBytes(6).toString('hex')}`);
      try {
        await writeFile(temporary, content, { flag: 'wx' });
        await rename(temporary, file);
      } catch (error) {
        await rm(temporary, { force: true }).catch(() => {});
        throw error;
      }
      applied.push({ file, previous });
    }
  } catch (error) {
    const rollbackFailures = await rollbackWrites(applied);
    if (rollbackFailures.length) {
      fail(`Workflow transfer failed and ${rollbackFailures.length} rollback operation`
        + `${rollbackFailures.length === 1 ? '' : 's'} also failed. Inspect the reported paths before retrying.`,
      'WORKFLOW_IMPORT_ROLLBACK_FAILED', {
        originalError: error?.message ?? String(error), rollbackFailures
      });
    }
    throw error;
  }
}

function assertConfirmation(expected, actual, operation) {
  if (!expected || expected !== actual) {
    fail(`${operation} plan changed or was not confirmed. Preview again and confirm exact plan ${actual}.`,
      'WORKFLOW_TRANSFER_PLAN_STALE', { expected: expected ?? null, actual });
  }
}

export async function applyWorkflowImport(root, bundleOrPath, { expectedPlanSha256 } = {}) {
  const plan = await planWorkflowImport(root, bundleOrPath);
  assertConfirmation(expectedPlanSha256, plan.planSha256, 'Workflow import');
  if (plan.conflicts.length) {
    fail(`Workflow import has ${plan.conflicts.length} collision${plan.conflicts.length === 1 ? '' : 's'}; nothing was changed.`,
      'WORKFLOW_IMPORT_CONFLICT', { conflicts: plan.conflicts });
  }
  const { bundle, target, assetTargets } = plan._internal;
  const outputs = [];
  const candidateDocuments = {};
  const incomingConfiguration = {};
  for (const governs of ['story', 'initiative']) {
    const current = target[governs];
    const sections = configSections(bundle).filter((item) => item.governs === governs);
    incomingConfiguration[governs] = sections.some((item) => Object.keys(item.values).length);
    if (!incomingConfiguration[governs]) continue;
    if (!current) fail(`Import requires ${STORE[governs].file}. Run singularity-flow init first.`,
      'WORKFLOW_CONFIGURATION_MISSING');
    const document = current.document.clone();
    let changed = false;
    for (const { section, values } of sections) {
      for (const [id, value] of Object.entries(values)) {
        if (document.getIn([section, id]) !== undefined) continue;
        if (document.getIn([section]) === undefined) document.setIn([section], document.createNode({}));
        document.setIn([section, id], document.createNode(value)); changed = true;
      }
    }
    candidateDocuments[governs] = { current, document, changed };
  }
  // Repeat schema and cross-document validation immediately before constructing the write set.
  // This keeps apply fail-closed even if preview logic changes independently in the future.
  const candidateValues = {
    story: candidateDocuments.story?.document.toJS() ?? target.story?.value ?? {},
    initiative: candidateDocuments.initiative?.document.toJS() ?? target.initiative?.value ?? {}
  };
  const agentCatalog = await mergedImportAgentCatalog(target.root, bundle);
  if (incomingConfiguration.story) validateStoryImportCandidate(candidateValues.story, agentCatalog);
  if (incomingConfiguration.initiative) {
    const portfolioCandidate = validatePortfolio(clone(candidateValues.initiative));
    const storyCandidate = storyImportCandidate(candidateValues.story, agentCatalog);
    validatePortfolioWorldModelViews(portfolioCandidate, storyCandidate);
  }
  for (const governs of ['story', 'initiative']) {
    const candidate = candidateDocuments[governs];
    if (!candidate?.changed) continue;
    outputs.push({ file: candidate.current.file, content: candidate.document.toString(YAML_OUTPUT) });
  }
  const addedAgentLocks = Object.entries(bundle.agentLocks)
    .filter(([id]) => plan.operations.add.some((item) => item.kind === 'agent-lock' && item.id === id));
  if (addedAgentLocks.length) {
    const value = clone(target.agentLock.value);
    for (const [id, lock] of addedAgentLocks) value.agents[id] = clone(lock);
    outputs.push({ file: target.agentLock.file, content: YAML.stringify(value) });
  }
  for (const { asset, relative } of assetTargets) {
    if (!plan.operations.add.some((item) => item.id === relative
        && (item.kind === asset.kind || item.kind === 'asset'))) continue;
    outputs.push({ file: await assertSafeTarget(target.root, relative), content: asset.content });
  }
  await applyFiles(outputs);
  return {
    schemaVersion: 1, resultType: 'workflow-import', status: outputs.length ? 'imported' : 'current',
    planSha256: plan.planSha256, bundleSha256: bundle.bundleSha256,
    workflows: bundle.workflows, added: plan.added, reused: plan.reused, conflicts: [],
    changed: outputs.length > 0,
    paths: outputs.map((item) => path.relative(target.root, item.file).split(path.sep).join('/')).sort()
  };
}

async function locateWorkflow(root, id) {
  const selected = parseWorkflowSelector(id, 'Source workflow identifier');
  const targetRoot = configurationReadRoot(root);
  const documents = {
    story: await readYamlDocument(targetRoot, STORE.story, { optional: true }),
    initiative: await readYamlDocument(targetRoot, STORE.initiative, { optional: true })
  };
  const found = Object.entries(STORE).filter(([governs, store]) =>
    (!selected.governs || selected.governs === governs)
    && Object.hasOwn(documents[governs]?.value?.[store.workflows] ?? {}, selected.id));
  if (!found.length) fail(`Unknown workflow '${selected.selector}'.`, 'WORKFLOW_UNKNOWN');
  if (found.length > 1) fail(`Workflow '${selected.id}' is ambiguous between Story and Initiative configuration.`,
    'WORKFLOW_SELECTOR_AMBIGUOUS');
  const [governs, store] = found[0];
  return {
    root: targetRoot, governs, store, id: selected.id, selector: `${governs}:${selected.id}`,
    document: documents[governs], documents
  };
}

export async function planWorkflowCopy(root, { sourceId, targetId, label } = {}) {
  const target = requireId(targetId, 'Target workflow identifier');
  if (typeof label !== 'string' || !label.trim()) fail('Workflow copy requires a non-empty label.',
    'WORKFLOW_COPY_LABEL_REQUIRED');
  const located = await locateWorkflow(root, sourceId);
  const source = located.id;
  if (source === target) fail('Source and target workflow IDs must be different.', 'WORKFLOW_COPY_TARGET_INVALID');
  const allTargetMatches = Object.entries(STORE).filter(([governs, store]) =>
    Object.hasOwn(located.documents[governs]?.value?.[store.workflows] ?? {}, target));
  const conflicts = allTargetMatches.map(([governs]) => entry(`${governs}.workflow`, target, {
    reason: 'target workflow already exists'
  }));
  const definition = clone(located.document.value[located.store.workflows][source]);
  definition.label = label.trim();
  const closure = await buildBundle(root, [located.selector]);
  const reuse = configSections(closure).flatMap(({ governs, section, values }) =>
    Object.keys(values)
      .filter((id) => !(governs === located.governs && section === located.store.workflows && id === source))
      .map((id) => entry(linkedDependencyKind(governs, section), id)));
  for (const asset of closure.assets) reuse.push(entry(asset.kind, asset.path));
  for (const id of Object.keys(closure.agentLocks)) reuse.push(entry('agent-lock', id));
  const core = {
    schemaVersion: 1, resultType: 'workflow-copy-plan', sourceId: source,
    sourceSelector: located.selector, targetId: target,
    governs: located.governs, targetStateSha256: digest({
      story: located.documents.story?.text ?? '', initiative: located.documents.initiative?.text ?? ''
    }),
    definitionSha256: digest(definition),
    changedPaths: conflicts.length ? [] : [located.store.file],
    operations: {
      add: conflicts.length ? [] : [entry(`${located.governs}.workflow`, target)],
      reuse: reuse.sort((a, b) => `${a.kind}:${a.id}`.localeCompare(`${b.kind}:${b.id}`)),
      conflicts
    },
    sharedDependencies: {
      ...summarizeBundle(closure),
      worldModelViews: clone(closure.requirements.worldModelViews),
      dependencyMaterialization: closure.requirements.dependencyMaterialization,
      linked: true
    }
  };
  return {
    ...core, planSha256: digest(core), status: conflicts.length ? 'blocked' : 'ready',
    added: core.operations.add, reused: core.operations.reuse, conflicts
  };
}

export async function copyWorkflow(root, {
  sourceId, targetId, label, expectedPlanSha256
} = {}) {
  const plan = await planWorkflowCopy(root, { sourceId, targetId, label });
  assertConfirmation(expectedPlanSha256, plan.planSha256, 'Workflow copy');
  if (plan.conflicts.length) fail(`Workflow '${targetId}' already exists; nothing was changed.`,
    'WORKFLOW_COPY_TARGET_EXISTS', { conflicts: plan.conflicts });
  const located = await locateWorkflow(root, sourceId);
  const document = located.document.document.clone();
  const definition = clone(located.document.value[located.store.workflows][located.id]);
  definition.label = label.trim();
  document.setIn([located.store.workflows, targetId], document.createNode(definition));
  located.store.validate(document.toJS());
  await applyFiles([{ file: located.document.file, content: document.toString(YAML_OUTPUT) }]);
  return {
    schemaVersion: 1, resultType: 'workflow-copy', status: 'copied',
    sourceId: located.id, sourceSelector: located.selector,
    targetId, workflowId: targetId, governs: located.governs,
    path: located.store.file, planSha256: plan.planSha256,
    sharedDependencies: plan.sharedDependencies, changed: true
  };
}
