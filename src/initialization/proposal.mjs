import { createHash } from 'node:crypto';
import path from 'node:path';
import { lstat, readFile, readdir } from 'node:fs/promises';
import YAML from 'yaml';

import { SMART_INITIALIZATION_ASSETS } from '../initialization-assets.mjs';
import { PACKAGE_ROOT } from '../package-root.mjs';
import { canonicalJson, recordSha256 } from '../records.mjs';
import { currentSchemaVersion } from '../schema-migrations.mjs';
import { SingularityFlowError } from '../util.mjs';
import { detectorRegistrySha256 } from './detectors.mjs';

const PRESET_ID = 'sflow.outcome-standard';
const PRESET_VERSION = 1;
const RENDERER_ID = 'smart-init-renderer@1';
const STANDARD_WORK_TYPES = Object.freeze(['feature', 'bugfix', 'chore', 'quick-fix', 'spec-driven-standard']);

function sha(bytes) {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

async function packagedFiles(source, destination, output = []) {
  const info = await lstat(source);
  if (info.isSymbolicLink()) throw new SingularityFlowError(
    `Packaged initialization asset is a symbolic link: ${path.relative(PACKAGE_ROOT, source)}`,
    { code: 'INI_PRESET_UNAVAILABLE' }
  );
  if (info.isFile()) {
    output.push({ source, path: destination.replaceAll(path.sep, '/') });
    return output;
  }
  if (!info.isDirectory()) throw new SingularityFlowError(
    `Packaged initialization asset is not a regular file or directory: ${path.relative(PACKAGE_ROOT, source)}`,
    { code: 'INI_PRESET_UNAVAILABLE' }
  );
  const entries = await readdir(source, { withFileTypes: true });
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name, 'en'))) {
    await packagedFiles(path.join(source, entry.name), path.posix.join(destination, entry.name), output);
  }
  return output;
}

function publicCommand(value) {
  const { precedence: _precedence, ...command } = value;
  return command;
}

function initializationPolicy(detection, selections) {
  const verification = detection.commands.verification.map(publicCommand);
  const readiness = verification.length ? 'ready' : 'unavailable';
  return {
    schemaVersion: currentSchemaVersion('smart-init-policy'),
    preset: { id: PRESET_ID, version: PRESET_VERSION },
    delivery: {
      allowedModes: ['outcome', 'workflow'],
      defaultMode: selections.mode,
      workflowProfile: 'standard',
      executionPace: 'manual'
    },
    proof: {
      profile: selections.proofProfile,
      readiness,
      gaps: readiness === 'ready' ? [] : [{
        id: 'INI-GAP-VERIFY-UNAVAILABLE',
        statement: 'No structured verification command was established at initialization.',
        owner: 'repository-maintainers',
        mitigation: 'Configure and execute a candidate-bound verifier before admission.',
        blockingAt: 'candidate-admission', status: 'open'
      }]
    },
    governance: { preset: selections.governance },
    capability: { id: 'repository-root', mode: 'implicit' },
    commands: {
      verification,
      quality: detection.commands.quality.map(publicCommand),
      build: detection.commands.build.map(publicCommand)
    },
    acceptedProtections: [...selections.protect].sort()
  };
}

function originEntries(policy, detection) {
  const entries = [];
  const walk = (value, pointer = '') => {
    if (pointer.startsWith('/commands')) return;
    if (value !== null && typeof value === 'object') {
      if (Array.isArray(value) && !value.length) {
        entries.push({ pointer, origin: 'preset-default-accepted', sourceRefs: [`preset:${PRESET_ID}@${PRESET_VERSION}`], decisionRef: 'smart-init-activation' });
        return;
      }
      for (const [key, child] of Object.entries(value)) {
        const escaped = key.replaceAll('~', '~0').replaceAll('/', '~1');
        walk(child, `${pointer}/${escaped}`);
      }
      return;
    }
    entries.push({
      pointer,
      origin: pointer.startsWith('/capability/') ? 'built-in-safety-invariant' : 'preset-default-accepted',
      sourceRefs: pointer.startsWith('/capability/') ? ['resolver:repository-root'] : [`preset:${PRESET_ID}@${PRESET_VERSION}`],
      decisionRef: 'smart-init-activation'
    });
  };
  walk(policy);
  for (const [category, commands] of Object.entries(policy.commands)) {
    commands.forEach((command, index) => entries.push({
      pointer: `/commands/${category}/${index}`,
      origin: command.confidence === 'declared' ? 'manifest-declared-confirmed' : 'conventional-confirmed',
      sourceRefs: command.evidence,
      decisionRef: 'smart-init-activation'
    }));
  }
  return [...new Map(entries.map((entry) => [entry.pointer, entry])).values()]
    .sort((a, b) => a.pointer.localeCompare(b.pointer, 'en'));
}

async function renderFiles(detection, selections) {
  const policy = initializationPolicy(detection, selections);
  const presetCore = {
    schemaVersion: currentSchemaVersion('smart-init-preset-snapshot'), kind: 'smart-init-preset-snapshot', id: PRESET_ID,
    version: PRESET_VERSION, policy
  };
  const presetSha256 = `sha256:${recordSha256(presetCore)}`;
  const preset = { ...presetCore, presetSha256 };
  const presetPath = `singularity/presets/${PRESET_ID}.v${PRESET_VERSION}.yml`;
  const files = [];
  let selectedPhaseIds = null;
  for (const [sourceRelative, destination] of SMART_INITIALIZATION_ASSETS) {
    for (const asset of await packagedFiles(
      path.join(PACKAGE_ROOT, 'templates', sourceRelative), destination
    )) {
      let bytes = await readFile(asset.source);
      if (asset.path === 'singularity/workflow.yml') {
        const definition = YAML.parse(bytes.toString('utf8'));
        definition.workTypes = Object.fromEntries(STANDARD_WORK_TYPES.map((id) => [id, definition.workTypes[id]]));
        const usedPhases = new Set(Object.values(definition.workTypes).flatMap((workType) => workType.phases));
        selectedPhaseIds = usedPhases;
        definition.phases = Object.fromEntries(Object.entries(definition.phases).filter(([id]) => usedPhases.has(id)));
        if (Array.isArray(definition.documents?.allowedPhases)) {
          definition.documents.allowedPhases = definition.documents.allowedPhases.filter((id) => usedPhases.has(id));
        }
        const usedArtifactSets = new Set(Object.values(definition.phases)
          .map((phase) => phase.artifactSet).filter(Boolean));
        definition.artifactSets = Object.fromEntries(Object.entries(definition.artifactSets ?? {})
          .filter(([id]) => usedArtifactSets.has(id)));
        delete definition.mcpServers;
        const suffix = `\n# Accepted deterministic initialization policy. Explain with: sflow config explain\ninitialization:\n${YAML.stringify(policy).split('\n').map((line) => line ? `  ${line}` : line).join('\n')}\n`;
        bytes = Buffer.from(`${YAML.stringify(definition).replace(/\s+$/u, '')}${suffix}`, 'utf8');
      }
      if (asset.path.startsWith('.github/agents/') && asset.path.endsWith('.agent.md')) {
        if (!selectedPhaseIds) throw new SingularityFlowError(
          'Smart-init agent rendering requires the selected workflow phase catalog.',
          { code: 'INI_PRESET_UNAVAILABLE' }
        );
        const source = bytes.toString('utf8').replace(
          /^(\s*sflow-(?:phases|default-for):\s*")([^"]*)("\s*)$/gmu,
          (_line, prefix, list, suffix) => {
            const retained = list.split(',').map((value) => value.trim())
              .filter((value) => selectedPhaseIds.has(value));
            return `${prefix}${retained.join(',')}${suffix}`;
          }
        );
        bytes = Buffer.from(source, 'utf8');
      }
      files.push({ path: asset.path, role: asset.path === 'singularity/workflow.yml' ? 'configuration' : 'packaged-asset', bytes, sourceKind: 'packaged-preset', expectation: 'create' });
    }
  }
  const configuration = files.find((entry) => entry.path === 'singularity/workflow.yml');
  const proposedConfigurationSha256 = sha(configuration.bytes);
  const originCore = {
    schemaVersion: currentSchemaVersion('configuration-origin-map'),
    kind: 'configuration-origin-map', configurationSha256: proposedConfigurationSha256,
    proposalSha256: null, entries: originEntries(policy, detection),
    declinedSuggestionIds: [...selections.declined].sort()
  };
  const origin = { ...originCore, originMapSha256: `sha256:${recordSha256(originCore)}` };
  files.push({ path: presetPath, role: 'preset-snapshot', bytes: Buffer.from(YAML.stringify(preset), 'utf8'), sourceKind: 'deterministic-renderer', expectation: 'create' });
  files.push({ path: 'singularity/configuration-origin.json', role: 'configuration-origin', bytes: Buffer.from(canonicalJson(origin), 'utf8'), sourceKind: 'deterministic-renderer', expectation: 'create' });
  files.sort((a, b) => a.path.localeCompare(b.path, 'en'));
  return { files, policy, preset, presetSha256, origin, proposedConfigurationSha256 };
}

function suggestions(snapshot) {
  const present = new Set(snapshot.entries.filter((entry) => entry.kind !== 'manifest').map((entry) => entry.path));
  const specs = [
    ['protect-auth', /(?:^|\/)auth(?:\/|$)/i, '**/auth/**', 'Authentication changes commonly require explicit review.'],
    ['protect-security', /(?:^|\/)security(?:\/|$)/i, '**/security/**', 'Security changes commonly require explicit review.'],
    ['protect-migrations', /(?:^|\/)migrations(?:\/|$)/i, '**/migrations/**', 'Migration changes commonly require explicit review.'],
    ['protect-infra', /^infra(?:\/|$)/i, 'infra/**', 'Infrastructure changes commonly require explicit review.'],
    ['protect-deploy', /^deploy(?:\/|$)/i, 'deploy/**', 'Deployment changes commonly require explicit review.'],
    ['protect-github', /^\.github(?:\/|$)/i, '.github/**', 'Repository automation commonly requires explicit review.'],
    ['protect-sensitive', /(?:^|\/)(?:\.env[^/]*|secrets?[^/]*)$/i, '**/*.env* and **/secrets*', 'Sensitive paths should be protected without reading their contents.']
  ];
  return specs.filter(([, pattern]) => [...present].some((value) => pattern.test(value)))
    .map(([id, , pattern, reason]) => ({ id, pattern, selected: false, reason, evidence: [`path-pattern:${pattern}`], authorityRequired: null }));
}

export async function buildSmartInitProposal(snapshot, detection, requested = {}) {
  const availableSuggestions = suggestions(snapshot);
  const known = new Set(availableSuggestions.map((entry) => entry.id));
  const protect = [...new Set(requested.protect ?? [])];
  for (const id of protect) if (!known.has(id)) throw new SingularityFlowError(
    `Unknown or inapplicable initialization protection '${id}'.`,
    { code: 'INI_DETECTION_AMBIGUOUS', details: { available: [...known].sort() } }
  );
  const selections = {
    mode: requested.mode ?? 'outcome',
    proofProfile: requested.proofProfile ?? 'standard',
    governance: requested.governance ?? 'team',
    activation: requested.activation ?? 'local-confirmation',
    protect,
    declined: availableSuggestions.map((entry) => entry.id).filter((id) => !protect.includes(id))
  };
  if (!['outcome', 'workflow'].includes(selections.mode)) throw new SingularityFlowError('--mode must be outcome or workflow.', { code: 'INI_CONFIGURATION_INVALID' });
  if (!['standard', 'high-assurance', 'regulated'].includes(selections.proofProfile)) throw new SingularityFlowError('--proof-profile must be standard, high-assurance, or regulated.', { code: 'INI_CONFIGURATION_INVALID' });
  if (!['team', 'poc'].includes(selections.governance)) throw new SingularityFlowError('--governance must be team or poc.', { code: 'INI_CONFIGURATION_INVALID' });
  if (!['local-confirmation', 'review-proposal', 'proposal-only'].includes(selections.activation)) throw new SingularityFlowError('--activation must be local-confirmation, review-proposal, or proposal-only.', { code: 'INI_CONFIGURATION_INVALID' });

  const rendered = await renderFiles(detection, selections);
  const writeSet = rendered.files.map((file) => ({
    path: file.path, role: file.role, bytes: file.bytes.length, sha256: sha(file.bytes),
    sourceKind: file.sourceKind, expectation: file.expectation
  }));
  const assetManifestSha256 = `sha256:${recordSha256(writeSet.filter((entry) => entry.role === 'packaged-asset'))}`;
  const presetCatalogSha256 = `sha256:${recordSha256({ id: PRESET_ID, version: PRESET_VERSION, sha256: rendered.presetSha256, assetManifestSha256 })}`;
  const resolverSha256 = `sha256:${recordSha256({ id: 'repository-root', version: 1, owns: ['**'] })}`;
  const core = {
    schemaVersion: currentSchemaVersion('smart-init-proposal'), kind: 'smart-init-proposal',
    subject: snapshot.subject,
    sourceManifestSha256: snapshot.sourceManifestSha256,
    sourceManifest: snapshot.sourceManifest,
    detectorRegistrySha256,
    presetCatalogSha256,
    rendererSha256: `sha256:${recordSha256({ id: RENDERER_ID })}`,
    detections: detection.facts,
    detectedStacks: detection.stacks,
    commands: Object.fromEntries(Object.entries(rendered.policy.commands).map(([key, values]) => [key, values])),
    ambiguities: detection.ambiguities,
    discardedCommands: detection.discardedCommands.map(publicCommand),
    delivery: rendered.policy.delivery,
    proof: rendered.policy.proof,
    governance: { preset: selections.governance, activationChannel: selections.activation },
    capability: { mode: 'implicit', id: 'repository-root', resolverSha256 },
    builtInInvariants: [
      { id: 'protect-git-authority', pattern: '.git/**', source: 'built-in' },
      { id: 'protect-sflow-authority', pattern: 'singularity/**', source: 'built-in' }
    ],
    suggestions: availableSuggestions.map((entry) => ({ ...entry, selected: protect.includes(entry.id) })),
    selectedSuggestionIds: [...protect].sort(),
    declinedSuggestionIds: [...selections.declined].sort(),
    preset: {
      id: PRESET_ID, version: PRESET_VERSION, sha256: rendered.presetSha256,
      snapshotSha256: rendered.presetSha256, assetManifestSha256
    },
    proposedConfigurationSha256: rendered.proposedConfigurationSha256,
    writeSet,
    writeSetSha256: `sha256:${recordSha256(writeSet)}`,
    warnings: detection.ambiguities.length ? ['Detection contains unresolved ambiguity.'] : []
  };
  const proposal = { ...core, proposalSha256: `sha256:${recordSha256(core)}` };
  return { proposal, files: rendered.files, policy: rendered.policy, origin: rendered.origin };
}

export function verifySmartInitProposal(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || value.kind !== 'smart-init-proposal') {
    throw new SingularityFlowError('Smart-init proposal is not a valid proposal record.', { code: 'INI_CONFIGURATION_INVALID' });
  }
  const core = structuredClone(value);
  const supplied = core.proposalSha256;
  delete core.proposalSha256;
  const expected = `sha256:${recordSha256(core)}`;
  if (supplied !== expected) throw new SingularityFlowError('Smart-init proposal failed its integrity check.', {
    code: 'INI_PROPOSAL_STALE', details: { expected, supplied }
  });
  return value;
}

export function smartInitProposalBytes(proposal) {
  return canonicalJson(proposal);
}
