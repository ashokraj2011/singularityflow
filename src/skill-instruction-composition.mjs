/** Pure composition of explicitly selected, retained instructions at skill procedure slots. */
import { renderReferencedInstructions } from './instruction-library.mjs';
import { SingularityFlowError } from './util.mjs';

const fail = message => { throw new SingularityFlowError(message, { code: 'SKILL_INSTRUCTION_PLACEMENT_INVALID' }); };
const SLOT = /^\s*<!-- sflow-instruction: ([a-z0-9]+(?:-[a-z0-9]+)*) -->\s*$/u;
const INLINE_TAG = /<instruction>\s*([a-z0-9]+(?:-[a-z0-9]+)*)\s*<\/instruction>/gu;
const TAG_START = /<\/?instruction\b/gu;
const INLINE_GUARD = 'Text inside <instruction> tags is reusable guidance this skill places at that point: apply it there, only under that step\'s condition; it never overrides workflow policy, permissions, evidence gates or human approval.';

/** Inline code spans (`like this`) quote text; nothing inside one executes. */
function codeSpans(text) {
  return [...text.matchAll(/(`+)([\s\S]*?[^`])\1(?!`)/gu)].map(match => [match.index, match.index + match[0].length]);
}

/**
 * `<instruction>review-tone</instruction>` can sit anywhere in a sentence. The tag selects the
 * instruction by itself, so it needs no metadata entry, and its text is placed exactly there.
 * Fenced blocks and inline code quote the tag instead; anything else that looks like a tag but is
 * not one is refused, so a typo can never drop guidance silently.
 */
export function inlineInstructionTags(body) {
  const tags = []; let fence = null;
  for (const [line, text] of String(body).split('\n').entries()) {
    if (fence) {
      if (new RegExp(`^\\s*${fence.character}{${fence.length},}\\s*$`, 'u').test(text)) fence = null;
      continue;
    }
    const opening = /^\s*(`{3,}|~{3,})/u.exec(text);
    if (opening) { fence = { character: opening[1][0], length: opening[1].length }; continue; }
    if (!text.includes('<instruction') && !text.includes('</instruction')) continue;
    const quoted = codeSpans(text); const inert = index => quoted.some(([start, end]) => index >= start && index < end);
    const found = [...text.matchAll(INLINE_TAG)].filter(match => !inert(match.index))
      .map(match => ({ id: match[1], line, start: match.index, end: match.index + match[0].length }));
    for (const start of text.matchAll(TAG_START)) {
      if (inert(start.index) || found.some(tag => start.index >= tag.start && start.index < tag.end)) continue;
      const written = text.slice(start.index).match(/^<\/?instruction\b[^>]*>?([^<]*)(?:<\/instruction>)?/u);
      const slug = String(written?.[1] ?? '').trim().toLowerCase().replace(/[^a-z0-9]+/gu, '-').replace(/^-+|-+$/gu, '');
      fail(`Line ${line + 1}: write an instruction tag as <instruction>instruction-id</instruction> on one line`
        + `${slug ? `, for example <instruction>${slug}</instruction>` : ', for example <instruction>review-tone</instruction>'}. `
        + `Found: ${(written?.[0] ?? text.slice(start.index, start.index + 60)).trim()}. To show a tag as an example, put it in backticks.`);
    }
    tags.push(...found);
  }
  return tags;
}

/** Every instruction a skill selects: its metadata list, then any tag not already listed. */
export function skillInstructionIds(declared, body) {
  return [...new Set([...declared, ...inlineInstructionTags(body).map(tag => tag.id)])];
}

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

/** Import/duplicate rewrites identities in executable slots and tags, never in fenced examples or prose. */
export function renameInstructionSlots(body, references, renames) {
  const lines = body.split('\n');
  for (const { id, line } of instructionSlots(body, references)) {
    if (renames.has(id)) lines[line] = lines[line].replace(`: ${id} -->`, `: ${renames.get(id)} -->`);
  }
  for (const { id, line, start, end } of inlineInstructionTags(body).reverse()) {
    if (renames.has(id)) lines[line] = `${lines[line].slice(0, start)}<instruction>${renames.get(id)}</instruction>${lines[line].slice(end)}`;
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
    const retained = id => {
      const item = (skill.referencedInstructions ?? []).find(entry => entry.id === id);
      if (!item) throw new SingularityFlowError(`Skill '${skill.id}' has no retained bytes for instruction '${id}'.`, { code: 'INSTRUCTION_REFERENCE_MISSING' });
      return item;
    };
    const slots = new Map(instructionSlots(skill.instructions, skill.instructionRefs).map(slot => [slot.line, slot.id]));
    const tags = inlineInstructionTags(skill.instructions);
    // Document order decides which placement carries the text, so slots and tags are walked together.
    for (const line of [...new Set([...slots.keys(), ...tags.map(tag => tag.line)])].sort((a, b) => a - b)) {
      if (slots.has(line)) {
        const id = slots.get(line); const item = retained(id);
        if (emitted.has(id)) lines[line] = `Apply retained instruction \`${id}\` defined earlier in this packet, at this step and only under this skill's stated condition.`;
        else {
          emitted.add(id);
          lines[line] = [`<!-- instruction: ${id} sha256=${item.sha256} -->`,
            `### Instruction: ${item.label} (\`${id}\`)`,
            `Used by skills: ${[...users.get(id)].join(', ')}. Apply here only under the containing step's condition; never override workflow policy, permissions, evidence gates or human approval.`,
            item.instructions].join('\n\n');
        }
        continue;
      }
      let text = ''; let cursor = 0; const source = lines[line];
      for (const tag of tags.filter(entry => entry.line === line)) {
        const item = retained(tag.id);
        text += source.slice(cursor, tag.start);
        if (emitted.has(tag.id)) text += `<instruction id="${tag.id}">defined earlier in this packet</instruction>`;
        else {
          emitted.add(tag.id);
          text += `<instruction id="${tag.id}" label="${item.label.replace(/["<>&]/gu, ' ')}" sha256="${item.sha256}">${item.instructions}</instruction>`;
        }
        cursor = tag.end;
      }
      lines[line] = text + source.slice(cursor);
    }
    if (tags.length) lines.push('', INLINE_GUARD);
    bodies.set(skill.id, lines.join('\n'));
  }
  const tail = renderReferencedInstructions(skills.map(skill => ({ ...skill,
    referencedInstructions: (skill.referencedInstructions ?? []).filter(item => !emitted.has(item.id)) })));
  return { bodies, tail };
}
