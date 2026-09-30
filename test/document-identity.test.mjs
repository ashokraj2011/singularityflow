import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DOCUMENT_MEMBER_NAME_MAXIMUM_LENGTH, assertAvailableDocumentNames, assignDocumentNames,
  defaultDocumentPhases, documentNameKey, documentOfferedToPhase, normalizeDocumentPhases,
  resolveDocumentRecord, validateDocumentName
} from '../src/document-identity.mjs';
import { currentSchemaVersion, readRecord } from '../src/schema-migrations.mjs';

const refusedWith = (code) => (error) => error?.code === code;

test('a document name is trimmed and single-spaced, and refused when empty, unreadable, too long or ID-shaped', () => {
  assert.equal(validateDocumentName('  Payment \t API\ncontract  '), 'Payment API contract');
  assert.throws(() => validateDocumentName('   '), refusedWith('DOCUMENT_NAME_REQUIRED'));
  assert.throws(() => validateDocumentName('Payment\u0000brief'), refusedWith('DOCUMENT_NAME_INVALID'));
  assert.throws(() => validateDocumentName('x'.repeat(121)), refusedWith('DOCUMENT_NAME_INVALID'));
  assert.equal(validateDocumentName('x'.repeat(120)).length, 120);
  assert.throws(() => validateDocumentName('doc-007'), refusedWith('DOCUMENT_NAME_INVALID'));
  assert.throws(() => validateDocumentName('PKG-2'), refusedWith('DOCUMENT_NAME_INVALID'));
  assert.equal(validateDocumentName('DOC-007 review'), 'DOC-007 review', 'only a bare ID is refused');
  const member = `Export/${'screens/'.repeat(40)}login.png`;
  assert.equal(validateDocumentName(member, { maximumLength: DOCUMENT_MEMBER_NAME_MAXIMUM_LENGTH }), member,
    'a package member is named after its package and relative path, which may be longer');
});

test('names compare ignoring case, spacing and Unicode composition', () => {
  assert.equal(documentNameKey('Café  Brief'), documentNameKey('café brief'));
  assert.notEqual(documentNameKey('Brief'), documentNameKey('Brief 2'));
});

test('every top-level input gets exactly one name, and the old label names a single document only', () => {
  assert.deepEqual(assignDocumentNames(2, { names: ['Brief', ' Design '] }), ['Brief', 'Design']);
  assert.throws(() => assignDocumentNames(1), (error) => error.code === 'DOCUMENT_NAME_REQUIRED'
    && /Give the document a name with --name/.test(error.message));
  assert.throws(() => assignDocumentNames(2, { names: ['Brief'] }), (error) => error.code === 'DOCUMENT_NAME_REQUIRED'
    && /Give each of the 2 documents its own name.*\(1 given\)/.test(error.message));
  assert.throws(() => assignDocumentNames(1, { names: ['Brief', 'Extra'] }), refusedWith('DOCUMENT_NAME_REQUIRED'));
  assert.deepEqual(assignDocumentNames(1, { label: 'Checkout design' }), ['Checkout design']);
  assert.throws(() => assignDocumentNames(2, { label: 'Shared label' }), refusedWith('DOCUMENT_NAME_REQUIRED'),
    'one label cannot name two documents');
  assert.deepEqual(assignDocumentNames(1, { names: ['Given'], label: 'Ignored' }), ['Given']);
});

test('a name used anywhere in the Story, detached documents included, cannot be reused', () => {
  const records = [
    { id: 'DOC-001', name: 'Payment brief', status: 'active' },
    { id: 'DOC-002', name: 'Old design', status: 'detached' }
  ];
  assertAvailableDocumentNames(records, ['Checkout design']);
  assert.throws(() => assertAvailableDocumentNames(records, ['payment  BRIEF']), (error) => error.code === 'DOCUMENT_NAME_TAKEN'
    && /already used by DOC-001/.test(error.message) && /'payment {2}BRIEF \(v2\)'/.test(error.message));
  assert.throws(() => assertAvailableDocumentNames(records, ['Old design']),
    (error) => error.code === 'DOCUMENT_NAME_TAKEN' && /DOC-002 \(detached\)/.test(error.message));
  assert.throws(() => assertAvailableDocumentNames([], ['Brief', 'brief']), refusedWith('DOCUMENT_NAME_TAKEN'));
});

test('a reference resolves by ID or alias first, then by name, then by path, and never guesses', () => {
  const records = [
    { id: 'DOC-001', name: 'Payment brief', path: 'items/W-1/inputs/DOC-001/brief.md', status: 'detached' },
    { id: 'DOC-002', name: 'payment brief (v2)', path: 'items/W-1/inputs/DOC-002/brief.md' },
    { id: 'DOC-003', name: 'DOC-001', path: 'items/W-1/inputs/DOC-003/design.png' },
    { id: 'BRIEF-1', aliases: ['LEGACY-BRIEF'], name: 'Agent brief' }
  ];
  assert.equal(resolveDocumentRecord(records, 'doc-001').id, 'DOC-001', 'an ID wins over a name that spells it');
  assert.equal(resolveDocumentRecord(records, 'legacy-brief').id, 'BRIEF-1');
  assert.equal(resolveDocumentRecord(records, ' PAYMENT   brief (V2) ').id, 'DOC-002');
  assert.equal(resolveDocumentRecord(records, 'Payment brief').id, 'DOC-001', 'a detached document is still found by its name');
  assert.equal(resolveDocumentRecord(records, 'items/W-1/inputs/DOC-003/design.png').id, 'DOC-003');
  assert.equal(resolveDocumentRecord(records, 'design.png').id, 'DOC-003');
  assert.throws(() => resolveDocumentRecord(records, 'brief.md'), (error) => error.code === 'DOCUMENT_REFERENCE_AMBIGUOUS'
    && /DOC-001, DOC-002/.test(error.message));
  assert.throws(() => resolveDocumentRecord(records, 'missing'), refusedWith('DOCUMENT_NOT_FOUND'));

  const renamed = [
    { id: 'DOC-001', name: 'Brief', status: 'detached' },
    { id: 'DOC-004', name: 'brief', status: 'active' }
  ];
  assert.equal(resolveDocumentRecord(renamed, 'BRIEF').id, 'DOC-004', 'an active document is preferred over a detached one');
});

test('phases default to the current phase onward, keep workflow order, and refuse phases the Story lacks', () => {
  const workflow = { phaseOrder: ['intake', 'specification', 'planning', 'implementation'], currentPhase: 'specification' };
  assert.deepEqual(defaultDocumentPhases(workflow), ['specification', 'planning', 'implementation']);
  assert.deepEqual(normalizeDocumentPhases(null, workflow), ['specification', 'planning', 'implementation']);
  assert.deepEqual(normalizeDocumentPhases(null, workflow, { fromPhase: 'intake' }), workflow.phaseOrder);
  assert.deepEqual(normalizeDocumentPhases('planning, intake', workflow), ['intake', 'planning']);
  assert.deepEqual(normalizeDocumentPhases(['implementation', 'planning', 'planning'], workflow), ['planning', 'implementation']);
  assert.deepEqual(normalizeDocumentPhases('ALL', workflow), workflow.phaseOrder);
  assert.throws(() => normalizeDocumentPhases('planing', workflow), (error) => error.code === 'DOCUMENT_PHASES_INVALID'
    && /no phase 'planing'/.test(error.message));
  assert.equal(documentOfferedToPhase({ phases: null }, 'planning'), true, 'a document from before phase scope is offered everywhere');
  assert.equal(documentOfferedToPhase({}, 'planning'), true);
  assert.equal(documentOfferedToPhase({ phases: ['specification'] }, 'planning'), false);
  assert.equal(documentOfferedToPhase({ phases: ['specification'] }, 'specification'), true);
});

test('a v2 catalog reads as v3 with a name for every document, legacy phases and Git storage', () => {
  assert.equal(currentSchemaVersion('document-manifest'), 3);
  const v2 = {
    schemaVersion: 2, workId: 'W-1', packages: [{ id: 'PKG-001', name: 'Export' }],
    documents: [
      { id: 'DOC-001', type: 'file', label: 'Research notes', sourceName: 'notes.md', path: 'a/DOC-001/notes.md' },
      { id: 'DOC-002', type: 'file', label: null, sourceName: 'notes.md', path: 'a/DOC-002/notes.md' },
      { id: 'DOC-003', type: 'file', label: 'research NOTES', sourceName: 'other.md', path: 'a/DOC-003/other.md' },
      { id: 'DOC-004', type: 'file', packageId: 'PKG-001', sourceRelativePath: 'screens/login.png', path: 'a/DOC-004/login.png' },
      { id: 'DOC-005', type: 'url', label: null, url: 'https://www.figma.com/design/abc' },
      { id: 'DOC-006', type: 'file', label: 'Kept', phases: ['planning'], storage: { kind: 'git' }, path: 'a/DOC-006/kept.md' }
    ]
  };
  const read = readRecord('document-manifest', Buffer.from(JSON.stringify(v2)));
  const { record } = read;
  assert.equal(record.schemaVersion, 3);
  assert.deepEqual(record.documents.map((document) => document.name), [
    'Research notes', 'notes.md', 'research NOTES (DOC-003)', 'screens/login.png', 'https://www.figma.com/design/abc', 'Kept'
  ]);
  assert.deepEqual(record.documents.map((document) => document.phases), [null, null, null, null, null, ['planning']]);
  assert.deepEqual(record.documents[0].storage, { kind: 'git' });
  assert.equal(record.documents[4].storage, undefined, 'a link has no stored bytes');
  assert.equal(record.documents[0].label, 'Research notes', 'the label is kept');
  assert.deepEqual(record.packages, v2.packages);
  assert.deepEqual(readRecord('document-manifest', Buffer.from(JSON.stringify(v2))).record, record, 'the upgrade is deterministic');
  assert.deepEqual(readRecord('document-manifest', Buffer.from(JSON.stringify(record))).record, record, 'a v3 catalog reads unchanged');
});
