import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, symlink, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { instructionReferences, instructionText, parseInstruction, readInstruction, loadInstructionLibrary, renderReferencedInstructions, instructionUtf8 } from '../src/instruction-library.mjs';
import { copilotCommandForCommand } from '../src/copilot-guidance.mjs';
import { modelFreeCommandForCommand } from '../src/model-free-commands.mjs';
import { librarySkillText, parseLibrarySkill } from '../src/skill-library.mjs';
import { validateInstructionRequest } from '../src/commands/instruction.mjs';
import { resolveOperation } from '../src/command-registry.mjs';

const definition = { id: 'web-guide', label: 'Web guide', description: 'Accessible controls.', instructions: 'Preserve keyboard interaction.' };
test('instructions and skill references round-trip without granting global scope', () => {
  const item = parseInstruction(instructionText(definition), { id: definition.id });
  assert.equal(item.instructions, definition.instructions);
  assert.equal(item.path, 'singularity/instruction-library/web-guide/INSTRUCTIONS.md');
  const skill = parseLibrarySkill(librarySkillText({ id: 'web-review', description: 'Review a UI.', instructions: 'Review changes.', instructionRefs: ['web-guide'] }));
  assert.deepEqual(skill.instructionRefs, ['web-guide']);
  assert.deepEqual(parseLibrarySkill(librarySkillText({ id: 'legacy', description: 'Old skill.', instructions: 'Review.' })).instructionRefs, []);
  assert.equal(parseInstruction('\uFEFF' + instructionText(definition).replaceAll('\n', '\r\n')).id, 'web-guide');
});
test('instruction references reject cycles, paths, URLs, duplicates and oversized definitions', () => {
  for (const refs of ['web-guide', null, ['../other'], ['https://example.invalid/a'], ['UPPER'], ['web-guide', 'web-guide'], Array.from({ length: 33 }, (_, i) => 'i-' + i)]) assert.throws(() => instructionReferences(refs));
  const valid = instructionText(definition);
  for (const text of [valid + '\u0000', valid + 'x'.repeat(65536), valid.replace('name: web-guide', 'name: other'), valid.replace('metadata:', 'metadata:\n  sflow-instructions: [other]')]) assert.throws(() => parseInstruction(text, { id: definition.id }));
  assert.throws(() => instructionText({ ...definition, instructions: '' }));
});
test('instruction loading refuses symlink files and parent folders', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-instruction-path-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const folder = path.join(root, 'singularity/instruction-library/web-guide');
  await mkdir(folder, { recursive: true });
  await writeFile(path.join(root, 'outside.md'), instructionText(definition));
  await symlink(path.join(root, 'outside.md'), path.join(folder, 'INSTRUCTIONS.md'));
  await assert.rejects(readInstruction(root, 'web-guide'));
  assert.equal((await loadInstructionLibrary(root)).problems.length, 1);
  await rm(path.join(root, 'singularity/instruction-library'), { recursive: true });
  await symlink(root, path.join(root, 'singularity/instruction-library'));
  await assert.rejects(loadInstructionLibrary(root));
});
test('prompt rendering deduplicates exact definitions and rejects identity conflicts', () => {
  const item = parseInstruction(instructionText(definition));
  const text = renderReferencedInstructions([{ id: 'one', referencedInstructions: [item] }, { id: 'two', referencedInstructions: [item] }]);
  assert.equal(text.split(definition.instructions).length - 1, 1);
  assert.match(text, /Used by skills: one, two/);
  assert.match(text, /do not override workflow policy/);
  assert.throws(() => renderReferencedInstructions([{ id: 'one', referencedInstructions: [item] }, { id: 'two', referencedInstructions: [{ ...item, sha256: 'other' }] }]), error => error.code === 'INSTRUCTION_BINDING_CONFLICT');
});
test('instruction CLI validates exact requests before discovery and has no model operations', () => {
  assert.throws(() => instructionUtf8(Buffer.from([0xff, 0xfe, 0xab])));
  assert.equal(copilotCommandForCommand('singularity-flow instruction show web-guide --json'), '/sf-instructions show web-guide --json');
  assert.equal(modelFreeCommandForCommand('singularity-flow instruction list --json'), '@sflow /instructions');
  assert.equal(validateInstructionRequest({ positionals: ['instruction', 'list'], options: { json: true } }), 'list');
  for (const positionals of [['instruction'], ['instruction', 'show'], ['instruction', 'show', '../other'], ['instruction', 'list', 'extra']]) assert.throws(() => validateInstructionRequest({ positionals, options: {} }));
  assert.throws(() => validateInstructionRequest({ positionals: ['instruction', 'list'], options: { from: 'x' } }));
  for (const action of ['list', 'show', 'create', 'edit', 'remove']) {
    const operation = resolveOperation({ requestedCommand: 'instruction', positionals: ['instruction', action], options: {} });
    assert.equal(operation.modelPolicy, 'never');
    assert.equal(operation.classification, ['list', 'show'].includes(action) ? 'read' : 'mutation');
  }
});
