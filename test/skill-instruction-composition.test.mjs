import assert from 'node:assert/strict';
import test from 'node:test';
import { instructionText, parseInstruction } from '../src/instruction-library.mjs';
import { librarySkillText, parseLibrarySkill } from '../src/skill-library.mjs';
import { composeSkillInstructions, inlineInstructionTags, instructionSlots, renameInstructionSlots } from '../src/skill-instruction-composition.mjs';
import { selectRetainedSkillInstructions } from '../src/retained-skill-instructions.mjs';
import { assertInstructionClosure, instructionComposerFor } from '../src/instruction-snapshots.mjs';

const definition = id => parseInstruction(instructionText({ id, description: `Use ${id}.`, instructions: `Exact guidance for ${id}.` }));
const skill = (id, body, refs = ['one', 'two', 'three']) => ({ ...parseLibrarySkill(librarySkillText({
  id, description: 'A placed procedure.', instructions: body, instructionRefs: refs
})), referencedInstructions: refs.map(definition) });
const procedure = '## Read sources\n<!-- sflow-instruction: one -->\n## Run tests if applicable\n<!-- sflow-instruction: two -->\n## Propose a route\n<!-- sflow-instruction: three -->\nFinish.';

test('three definitions expand exactly at their procedure steps, preserving conditions and raw skill hashes', () => {
  const value = skill('checker', procedure);
  const { bodies, tail } = composeSkillInstructions([value]); const body = bodies.get(value.id);
  assert.equal(tail, ''); assert.equal(value.instructions, procedure);
  assert.ok(body.indexOf('Exact guidance for one.') > body.indexOf('## Read sources'));
  assert.ok(body.indexOf('Exact guidance for one.') < body.indexOf('## Run tests'));
  assert.ok(body.indexOf('Exact guidance for two.') < body.indexOf('## Propose a route'));
  assert.ok(body.indexOf('Exact guidance for three.') < body.indexOf('Finish.'));
  assert.doesNotMatch(body, /<!-- sflow-instruction:/);
  for (const item of value.referencedInstructions) assert.ok(body.includes(`sha256=${item.sha256}`));
});
test('shared guidance renders once across placed and unplaced active skills; optional procedures stay absent', () => {
  const first = skill('first', 'When visual testing applies:\n<!-- sflow-instruction: one -->', ['one']);
  const second = skill('second', 'Before closing:\n<!-- sflow-instruction: one -->', ['one']);
  const third = skill('third', 'Use shared guidance.', ['one', 'two']);
  const composition = composeSkillInstructions([first, second, third]);
  const text = [...composition.bodies.values(), composition.tail].join('\n');
  assert.equal(text.split('Exact guidance for one.').length - 1, 1);
  assert.equal(text.split('Exact guidance for two.').length - 1, 1);
  assert.match(composition.bodies.get('second'), /defined earlier.*only under this skill's stated condition/);
  assert.doesNotMatch(text, /Exact guidance for three/);
});
test('legacy unplaced skills keep the referenced-instruction appendix and fenced examples never execute', () => {
  const example = '```markdown\n<!-- sflow-instruction: missing -->\n```\n~~~\n<!-- sflow-instruction: other -->\n~~~\n    <!-- sflow-instruction: indented -->\nUse the selected guidance.';
  const value = skill('legacy', example, ['one']);
  const { bodies, tail } = composeSkillInstructions([value]);
  assert.equal(bodies.get(value.id), example); assert.match(tail, /Exact guidance for one/);
  assert.deepEqual(instructionSlots(example, []), []);
});
test('malformed, unselected and duplicate slots cannot silently compose, and missing/conflicting retained bytes refuse', () => {
  for (const body of ['<!-- sflow-instruction: missing -->', 'text <!-- sflow-instruction: one -->',
    '<!-- sflow-instruction: UPPER -->', '<!-- sflow-instruction: ../one -->',
    '<!-- sflow-instruction: one -->\n<!-- sflow-instruction: one -->']) {
    assert.throws(() => skill('invalid', body, ['one']), error => error.code === 'SKILL_INSTRUCTION_PLACEMENT_INVALID');
  }
  const value = skill('valid', '<!-- sflow-instruction: one -->', ['one']);
  assert.throws(() => composeSkillInstructions([{ ...value, referencedInstructions: [] }]), error => error.code === 'INSTRUCTION_REFERENCE_MISSING');
  assert.throws(() => composeSkillInstructions([{ ...value, instructions: 'Legacy appendix.', referencedInstructions: [] }]), error => error.code === 'INSTRUCTION_REFERENCE_MISSING');
  assert.throws(() => composeSkillInstructions([{ ...value, referencedInstructions: [definition('one'), definition('unexpected')] }]), error => error.code === 'INSTRUCTION_REFERENCES_INVALID');
  assert.throws(() => composeSkillInstructions([value, { ...value, id: 'other', referencedInstructions: [{ ...definition('one'), sha256: 'different' }] }]), error => error.code === 'INSTRUCTION_BINDING_CONFLICT');
});
test('rename rewrites only declared live slots, leaving quoted examples and prose intact', () => {
  const body = '<!-- sflow-instruction: one -->\n```md\n<!-- sflow-instruction: one -->\n```\nMention one in prose.';
  assert.equal(renameInstructionSlots(body, ['one'], new Map([['one', 'team-one']])),
    '<!-- sflow-instruction: team-one -->\n```md\n<!-- sflow-instruction: one -->\n```\nMention one in prose.');
});
test('on-demand expansion composes only retained definitions, not the current library', () => {
  const value = { ...skill('optional', procedure), loading: 'on-demand' };
  const workflow = { workItem: { id: 'STORY' }, currentPhase: 'check' };
  const phase = { id: 'check', generation: 0 };
  const context = { identity: { mode: 'workflow-snapshot', snapshotHash: 'abc' }, agentId: 'tester',
    dependencies: [{ ...value, source: 'library', phases: ['check'], inclusion: 'included' }] };
  const result = selectRetainedSkillInstructions(workflow, phase, context, {
    workId: 'STORY', phaseId: 'check', generation: 1, agentId: 'tester', snapshotSha256: 'abc', skillId: value.id, expectedSha256: value.sha256
  });
  assert.equal(result.skill.instructions, procedure);
  assert.match(result.skill.composedText, /Exact guidance for three/);
  assert.equal(result.skill.referencedInstructionText, '');
  assert.deepEqual(result.effects, { filesChanged: false, testsRun: false, storyAdvanced: false });
});

test('placed procedure semantics cannot be downgraded to the legacy snapshot composer', () => {
  const value = skill('checker', procedure); const assets = new Map(); const bytes = new Map();
  const owner = { logicalId: 'workflow:demo:skill:checker', purpose: 'workflow-skill', source: { skillId: value.id } };
  assets.set(owner.logicalId, owner); bytes.set(owner.logicalId, Buffer.from(value.text));
  for (const item of value.referencedInstructions) {
    const id = `instruction:${item.id}`; const sha256 = `sha256:${item.sha256}`;
    assets.set(id, { logicalId: id, purpose: 'shared-instruction', dependencies: [], blob: { sha256 },
      source: { kind: 'reviewed-instruction', instructionId: item.id, sha256 } });
    bytes.set(id, Buffer.from(item.text));
  }
  assert.doesNotThrow(() => assertInstructionClosure({ semantics: { promptComposer: 'story-snapshot-agent-v4' } }, assets, bytes));
  assert.throws(() => assertInstructionClosure({ semantics: { promptComposer: 'story-snapshot-agent-v3' } }, assets, bytes), error => error.code === 'WFA_RUNTIME_INCOMPATIBLE');
});

const tagged = (id, body, declared = []) => ({ ...parseLibrarySkill(librarySkillText({
  id, description: 'An inline procedure.', instructions: body, instructionRefs: declared
})), referencedInstructions: [...new Set([...declared, ...inlineInstructionTags(body).map(tag => tag.id)])].map(definition) });

test('an inline <instruction> tag selects its instruction by itself and places the text inside the sentence', () => {
  const body = 'Review each file and write comments <instruction>one</instruction> before you move on.\nThen <instruction>two</instruction>, and again <instruction>one</instruction>.\nQuote `<instruction>three</instruction>` as an example.\n```md\n<instruction>three</instruction>\n```';
  const value = tagged('inline', body);
  assert.deepEqual(value.instructionRefs, ['one', 'two']);
  assert.deepEqual(value.declaredInstructionRefs, []);
  assert.doesNotMatch(value.text, /sflow-instructions/, 'tagged instructions need no metadata entry');
  const { bodies, tail } = composeSkillInstructions([value]); const composed = bodies.get(value.id);
  assert.equal(tail, '');
  const [first] = composed.split('\n');
  assert.match(first, /^Review each file and write comments <instruction id="one" label="One" sha256="[0-9a-f]{64}">Exact guidance for one\.<\/instruction> before you move on\.$/);
  assert.match(composed, /Then <instruction id="two" [^>]*>Exact guidance for two\.<\/instruction>, and again <instruction id="one">defined earlier in this packet<\/instruction>\./);
  assert.equal(composed.split('Exact guidance for one.').length - 1, 1);
  assert.match(composed, /Quote `<instruction>three<\/instruction>` as an example\./);
  assert.match(composed, /```md\n<instruction>three<\/instruction>\n```/);
  assert.match(composed.trimEnd().split('\n').at(-1), /^Text inside <instruction> tags is reusable guidance/);
});

test('inline tags and slots share one emission order, and metadata keeps only untagged references', () => {
  const value = tagged('mixed', '<!-- sflow-instruction: two -->\nAlso use <instruction>two</instruction> and <instruction>one</instruction>.', ['two', 'three']);
  // 'two' is tagged, so it selects itself and leaves metadata; the slot still finds it.
  assert.deepEqual(value.instructionRefs, ['three', 'two', 'one']);
  assert.deepEqual(value.declaredInstructionRefs, ['three']);
  const { bodies, tail } = composeSkillInstructions([value]); const composed = bodies.get(value.id);
  assert.ok(composed.indexOf('### Instruction: Two') < composed.indexOf('<instruction id="two">defined earlier in this packet</instruction>'));
  assert.match(tail, /Exact guidance for three/);
  const rewritten = librarySkillText({ id: 'mixed', description: 'x', instructions: 'Use <instruction>one</instruction>.', instructionRefs: ['one', 'three'] });
  assert.match(rewritten, /sflow-instructions:\n\s+- three\n/);
  assert.doesNotMatch(rewritten, /- one/);
});

test('a mistyped instruction tag is refused with the form to write, never dropped silently', () => {
  for (const [body, hint] of [
    ['Use <instruction>Review Tone</instruction> here.', /<instruction>review-tone<\/instruction>/],
    ['Use <instruction>one here.', /<instruction>one-here<\/instruction>|<instruction>instruction-id<\/instruction>/],
    ['Use <instruction id="one"/> here.', /<instruction>instruction-id<\/instruction>/],
    ['Use one</instruction> here.', /Line 1/]
  ]) {
    assert.throws(() => inlineInstructionTags(body), error => error.code === 'SKILL_INSTRUCTION_PLACEMENT_INVALID' && hint.test(error.message) && /backticks/.test(error.message), body);
  }
  assert.deepEqual(inlineInstructionTags('Plural <instructions> are prose.'), []);
  assert.deepEqual(inlineInstructionTags('Padded <instruction> one </instruction>.').map(tag => tag.id), ['one']);
});

test('rename rewrites live inline tags only', () => {
  const body = 'Use <instruction>one</instruction> and `<instruction>one</instruction>`.';
  assert.equal(renameInstructionSlots(body, [], new Map([['one', 'team-one']])),
    'Use <instruction>team-one</instruction> and `<instruction>one</instruction>`.');
});

test('inline tags require the inline composer so an older build refuses instead of dropping the text', () => {
  const value = tagged('inline-closure', 'Write <instruction>one</instruction> carefully.');
  const assets = new Map(); const bytes = new Map();
  const owner = { logicalId: 'workflow:demo:skill:inline-closure', purpose: 'workflow-skill', source: { skillId: value.id } };
  assets.set(owner.logicalId, owner); bytes.set(owner.logicalId, Buffer.from(value.text));
  for (const item of value.referencedInstructions) {
    const id = `instruction:${item.id}`; const sha256 = `sha256:${item.sha256}`;
    assets.set(id, { logicalId: id, purpose: 'shared-instruction', dependencies: [], blob: { sha256 },
      source: { kind: 'reviewed-instruction', instructionId: item.id, sha256 } });
    bytes.set(id, Buffer.from(item.text));
  }
  assert.equal(instructionComposerFor({ inline: true, placed: true }), 'story-snapshot-agent-v5');
  assert.doesNotThrow(() => assertInstructionClosure({ semantics: { promptComposer: 'story-snapshot-agent-v5' } }, assets, bytes));
  for (const older of ['story-snapshot-agent-v4', 'story-snapshot-agent-v3']) {
    assert.throws(() => assertInstructionClosure({ semantics: { promptComposer: older } }, assets, bytes), error => error.code === 'WFA_RUNTIME_INCOMPATIBLE');
  }
});
