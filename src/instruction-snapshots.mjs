/** Shared instruction closure: owned by retained SKILL.md declarations, never by live files. */
import { createHash } from 'node:crypto';
import { parseLibrarySkill, librarySkillReference } from './skill-library.mjs';
import { parseInstruction, instructionUtf8 } from './instruction-library.mjs';
import { SingularityFlowError } from './util.mjs';
import { canonicalJson } from './records.mjs';

export const INSTRUCTION_COMPOSER = 'story-snapshot-agent-v3';
const qualified = text => `sha256:${createHash('sha256').update(text).digest('hex')}`;
const referenceHash = id => qualified('wfa.dependency-reference.v1\0'
  + canonicalJson(`skill\0${id}\0${librarySkillReference(id)}`));
export function instructionOwner(asset) {
  return asset.purpose === 'workflow-skill' || (asset.purpose === 'agent-skill'
    && asset.source?.referenceSha256 === referenceHash(asset.source.dependencyId));
}

export function assertInstructionClosure(manifest, assets, bytes) {
  const required = new Set();
  for (const asset of assets.values()) {
    if (!instructionOwner(asset)) continue;
    const source = bytes.get(asset.logicalId);
    if (!source) throw new SingularityFlowError('Retained skill bytes are unavailable for instruction validation.', { code: 'WFA_DEPENDENCY_UNAVAILABLE' });
    const skill = parseLibrarySkill(source.toString('utf8'), { id: asset.source.skillId ?? asset.source.dependencyId });
    for (const id of skill.instructionRefs) required.add(id);
  }
  const carried = [...assets.values()].filter(asset => asset.purpose === 'shared-instruction');
  if ((required.size || carried.length) && manifest.semantics?.promptComposer !== INSTRUCTION_COMPOSER) {
    throw new SingularityFlowError('Referenced instructions require the retained instruction composer.', { code: 'WFA_RUNTIME_INCOMPATIBLE' });
  }
  for (const id of required) {
    const asset = assets.get(`instruction:${id}`); const source = bytes.get(`instruction:${id}`);
    if (!asset || !source || asset.purpose !== 'shared-instruction' || asset.dependencies?.length
        || asset.source?.kind !== 'reviewed-instruction' || asset.source.instructionId !== id
        || asset.source.sha256 !== asset.blob.sha256) {
      throw new SingularityFlowError(`Skill instruction '${id}' is missing or not bound to its retained bytes.`, { code: 'WFA_DEPENDENCY_UNAVAILABLE' });
    }
    parseInstruction(instructionUtf8(source), { id });
  }
  if (carried.some(asset => !required.has(asset.source?.instructionId)
      || asset.logicalId !== `instruction:${asset.source?.instructionId}`)) {
    throw new SingularityFlowError('The snapshot carries an undeclared shared instruction.', { code: 'WFA_SNAPSHOT_INVALID' });
  }
}

export function retainedInstructionsForSkill(closure, text, id) {
  const skill = parseLibrarySkill(text, { id });
  return Object.freeze(skill.instructionRefs.map(reference => {
    const source = closure.assetBytes.get(`instruction:${reference}`);
    if (!source) throw new SingularityFlowError(`Retained instruction '${reference}' is unavailable; live substitution is forbidden.`, { code: 'WFA_DEPENDENCY_UNAVAILABLE' });
    return parseInstruction(instructionUtf8(source), { id: reference });
  }));
}
