/** Pure composition of explicitly selected, retained instructions at skill procedure slots. */
import { renderReferencedInstructions } from './instruction-library.mjs';
import { SingularityFlowError } from './util.mjs';

const fail = message => { throw new SingularityFlowError(message, { code: 'SKILL_INSTRUCTION_PLACEMENT_INVALID' }); };
const SLOT = /^\s*<!-- sflow-instruction: ([a-z0-9]+(?:-[a-z0-9]+)*) -->\s*$/u;

/** Slots are standalone lines outside fenced examples; references remain the selection authority. */
export function instructionSlots(body, references = []) {
  const slots = []; const seen = new Set(); let fence = null;
  for (const [line, text] of String(body).split('\n').entries()) {
    if (fence) {
      if (new RegExp(`^ {0,3}${fence.character}{${fence.length},}\\s*$`, 'u').test(text)) fence = null;
      continue;
    }
    const opening = /^ {0,3}(`{3,}|~{3,})/u.exec(text);
    if (opening) { fence = { character: opening[1][0], length: opening[1].length }; continue; }
    if (/^(?: {4}|\t)/u.test(text)) continue; // Indented Markdown examples are inert too.
    if (!text.includes('<!-- sflow-instruction:')) continue;
    const match = SLOT.exec(text);
    if (!match) fail('An instruction slot must be a standalone <!-- sflow-instruction: lower-case-id --> line.');
    const id = match[1];
    if (!references.includes(id)) fail(`Instruction slot '${id}' must also be selected in metadata.sflow-instructions.`);
    if (seen.has(id)) fail(`Place instruction '${id}' once per skill; reference that step again instead of duplicating its body.`);
    seen.add(id); slots.push({ id, line });
  }
  return slots;
}

/** Import/duplicate rewrites identities in executable slots, never in fenced examples or prose. */
export function renameInstructionSlots(body, references, renames) {
  const lines = body.split('\n');
  for (const { id, line } of instructionSlots(body, references)) {
    if (renames.has(id)) lines[line] = lines[line].replace(`: ${id} -->`, `: ${renames.get(id)} -->`);
  }
  return lines.join('\n');
}

/** One prompt-local registry: shared bodies appear once, optional unexpanded skills contribute nothing. */
export function composeSkillInstructions(skills) {
  const definitions = new Map(); const users = new Map(); const emitted = new Set();
  for (const skill of skills) {
    for (const id of skill.instructionRefs ?? []) if (!(skill.referencedInstructions ?? []).some(item => item.id === id)) {
      throw new SingularityFlowError(`Skill '${skill.id}' has no retained bytes for instruction '${id}'.`, { code: 'INSTRUCTION_REFERENCE_MISSING' });
    }
    for (const item of skill.referencedInstructions ?? []) {
      if (!(skill.instructionRefs ?? []).includes(item.id)) throw new SingularityFlowError(`Skill '${skill.id}' carries undeclared instruction '${item.id}'.`, { code: 'INSTRUCTION_REFERENCES_INVALID' });
      const prior = definitions.get(item.id);
      if (prior && prior.sha256 !== item.sha256) throw new SingularityFlowError(`Conflicting retained instruction '${item.id}'.`, { code: 'INSTRUCTION_BINDING_CONFLICT' });
      definitions.set(item.id, item);
      if (!users.has(item.id)) users.set(item.id, new Set());
      users.get(item.id).add(skill.id);
    }
  }
  const bodies = new Map();
  for (const skill of skills) {
    const lines = skill.instructions.split('\n');
    for (const { id, line } of instructionSlots(skill.instructions, skill.instructionRefs)) {
      const item = (skill.referencedInstructions ?? []).find(entry => entry.id === id);
      if (!item) throw new SingularityFlowError(`Skill '${skill.id}' has no retained bytes for instruction '${id}'.`, { code: 'INSTRUCTION_REFERENCE_MISSING' });
      if (emitted.has(id)) lines[line] = `Apply retained instruction \`${id}\` defined earlier in this packet, at this step and only under this skill's stated condition.`;
      else {
        emitted.add(id);
        lines[line] = [`<!-- instruction: ${id} sha256=${item.sha256} -->`,
          `### Instruction: ${item.label} (\`${id}\`)`,
          `Used by skills: ${[...users.get(id)].join(', ')}. Apply here only under the containing step's condition; never override workflow policy, permissions, evidence gates or human approval.`,
          item.instructions].join('\n\n');
      }
    }
    bodies.set(skill.id, lines.join('\n'));
  }
  const tail = renderReferencedInstructions(skills.map(skill => ({ ...skill,
    referencedInstructions: (skill.referencedInstructions ?? []).filter(item => !emitted.has(item.id)) })));
  return { bodies, tail };
}
