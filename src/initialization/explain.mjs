import { createHash } from 'node:crypto';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import YAML from 'yaml';

import { recordSha256 } from '../records.mjs';
import { readRecord } from '../schema-migrations.mjs';
import { SingularityFlowError } from '../util.mjs';
import { readLatestSmartInitActivation } from './recovery.mjs';

function meaning(pointer) {
  if (pointer.startsWith('/commands/verification')) return 'A structured command available as verification evidence only after it is explicitly executed.';
  if (pointer.startsWith('/commands/quality')) return 'An optional repository quality command; detection alone is not proof.';
  if (pointer.startsWith('/commands/build')) return 'An optional repository build command; detection alone is not proof.';
  if (pointer === '/delivery/defaultMode') return 'The delivery experience offered by default when new work begins.';
  if (pointer === '/proof/profile') return 'The default proof-strength profile; unavailable evidence remains an explicit gap.';
  if (pointer === '/capability/id') return 'Stable implicit ownership by this repository without a capability map.';
  return 'A field installed by the accepted initialization proposal.';
}

export async function explainSmartInitialization(root, { pointer = null } = {}) {
  let origin; let workflow;
  try {
    const originBytes = await readFile(path.join(root, 'singularity', 'configuration-origin.json'));
    const workflowBytes = await readFile(path.join(root, 'singularity', 'workflow.yml'));
    origin = readRecord('configuration-origin-map', originBytes).record;
    const originCore = structuredClone(origin);
    delete originCore.originMapSha256;
    if (origin.originMapSha256 !== `sha256:${recordSha256(originCore)}`
        || origin.configurationSha256 !== `sha256:${createHash('sha256').update(workflowBytes).digest('hex')}`) {
      throw new SingularityFlowError('Smart-initialization origin binding is invalid.', { code: 'INI_CONFIGURATION_INVALID' });
    }
    workflow = YAML.parse(workflowBytes.toString('utf8'));
  } catch (error) {
    throw new SingularityFlowError(
      'No explainable smart-initialization origin map was found. Use legacy configuration inspection or initialize with --smart-detect.',
      { code: 'INI_CONFIGURATION_INVALID', cause: error }
    );
  }
  const activation = (await readLatestSmartInitActivation(root))?.record ?? null;
  const entries = origin.entries.filter((entry) => !pointer || entry.pointer === pointer).map((entry) => ({
    ...entry,
    meaning: meaning(entry.pointer),
    law: entry.origin === 'built-in-safety-invariant' ? 'product' : 'repository',
    acceptedBy: activation?.decision?.actor ?? null,
    proposalSha256: activation?.proposalSha256 ?? origin.proposalSha256,
    receiptSha256: activation?.receiptSha256 ?? null,
    influences: entry.pointer.startsWith('/commands/') ? ['precheck', 'candidate-evidence'] : ['work-start', 'home'],
    safeChange: 'Run sflow init --smart-detect --dry-run, review the semantic proposal, and activate its exact hash through the configured authority.'
  }));
  if (pointer && !entries.length) throw new SingularityFlowError(
    `Configuration origin has no smart-generated field '${pointer}'.`,
    { code: 'INI_CONFIGURATION_INVALID', details: { pointer } }
  );
  return {
    schemaVersion: 1, // schema-transient: read-only explanation envelope, never persisted
    kind: 'smart-init-configuration-explanation',
    configuration: 'singularity/workflow.yml', configurationSha256: origin.configurationSha256,
    preset: workflow.initialization?.preset ?? null,
    proofReadiness: workflow.initialization?.proof?.readiness ?? 'unavailable',
    entries
  };
}
