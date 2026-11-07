import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import ts from 'typescript';
import * as core from '../src/kernel/lifecycle-transitions.mjs';
import { publicationStateCases, observePublicationState } from './helpers/publication-state-cases.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
test('16 original publication receipts and aggregate projections preserve their exact serialized bytes', async () => {
  const baseline = JSON.parse(await readFile(new URL('./fixtures/engine-publication-state/native-v1.json', import.meta.url), 'utf8'));
  for (const [index, entry] of publicationStateCases().entries()) {
    assert.equal(entry.name, baseline.cases[index].name);
    assert.equal(hash(JSON.stringify(observePublicationState(core, entry, baseline.schemaVersion))), baseline.cases[index].sha256, entry.name);
  }
});

test('delivery and retained-generation object expressions are unchanged apart from the explicit schema-version fact', async () => {
  const baseline = JSON.parse(await readFile(new URL('./fixtures/engine-publication-state/native-v1.json', import.meta.url), 'utf8'));
  const source = await readFile(new URL('../src/kernel/lifecycle-transitions.mjs', import.meta.url), 'utf8');
  const ast = ts.createSourceFile('lifecycle-transitions.mjs', source, ts.ScriptTarget.Latest, true);
  const find = name => ast.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === name);
  const returned = find('codeDeliveryPublicationReceipt').body.statements.find(ts.isReturnStatement).expression;
  assert.equal(hash(returned.getText(ast)), baseline.expressions.receipt);
  for (const [name, field, expected] of [
    ['recordCodeDeliveryPublication', 'phase.deliveryEvidence', baseline.expressions.delivery],
    ['recordGenerationArtifactSet', 'phase.artifactSet', baseline.expressions.artifactSet],
    ['recordGenerationPublication', 'phase.generationPublications', baseline.expressions.publications]
  ]) {
    const statement = find(name).body.statements.find(node => ts.isExpressionStatement(node)
      && ts.isBinaryExpression(node.expression) && node.expression.left.getText(ast) === field);
    assert.ok(statement, name); assert.equal(hash(statement.expression.right.getText(ast)), expected, name);
  }
});

test('publication state keeps historical claims, human decisions and actor ownership without asserting completion', () => {
  const f = publicationStateCases()[0], phase = f.phase;
  phase.approvals = [{ generation: 1, actor: 'reviewer' }]; phase.history = [{ event: 'previous-publication' }];
  const claims = phase.claimMaps.planned, approvals = structuredClone(phase.approvals), history = structuredClone(phase.history);
  core.beginGenerationPublication(phase, { targetGeneration: 2, actor: f.actor, agent: f.agent, producer: 'governed-agent' });
  assert.equal(phase.generatedBy, f.actor); assert.equal(phase.generatedAgent, f.agent); assert.equal(phase.generation, 2);
  assert.equal(phase.status, 'in_progress'); assert.equal(phase.submissionArchitectureDecision, null);
  core.appendGenerationAuthorship(phase, f.effectiveAuthorship, f.publishedAt);
  assert.notEqual(phase.authorship.at(-1).details, f.effectiveAuthorship.details);
  core.resetGenerationDeliveryBindings(phase);
  assert.equal(phase.claimMaps.planned, claims); assert.equal('observed' in phase.claimMaps, false);
  assert.equal(phase.generationCommit, null); assert.equal(phase.publicationCommit, null); assert.equal(phase.submittedAt, null);
  assert.deepEqual(phase.approvals, approvals); assert.deepEqual(phase.history, history);
  assert.equal(phase.authorship[0].generation, 1);
});

test('receipt preparation is separate from accepting live delivery evidence and does not invent test execution', () => {
  const f = publicationStateCases().find(entry => entry.name === 'all-optional-evidence'), phase = f.phase;
  phase.generation = 2;
  const before = structuredClone(phase), facts = { ...f, schemaVersion: 2 };
  const receipt = core.codeDeliveryPublicationReceipt(f.workflow, phase, f.deliveryPreflight, facts);
  assert.deepEqual(phase, before); assert.equal(receipt.status, 'pending-tests'); assert.deepEqual(receipt.testExecutions, []);
  assert.equal(receipt.tree.generationCommit, null); assert.equal(receipt.tree.generationTree, null);
  assert.equal(receipt.model.required, true); assert.equal(receipt.model.authorshipProducer, 'governed-agent');
  assert.deepEqual(receipt.model.invocationIds, []); assert.equal(receipt.model.assurance, 'unavailable');
  core.recordCodeDeliveryPublication(phase, f.deliveryPreflight, facts);
  assert.equal(phase.deliveryEvidence.changeSet, f.deliveryPreflight.changeSet, 'native shallow binding remains live');
  assert.notEqual(receipt.documentationCorrection, f.deliveryPreflight.documentationCorrection);
  assert.equal(phase.deliveryEvidence.status, 'pending-tests'); assert.equal(phase.deliveryEvidence.validation, null);
  assert.deepEqual(f.effectiveAuthorship.changeOrigins, ['agent-edit']);
});

test('generation retention replaces the selected record and preserves previous immutable generations', () => {
  const f = publicationStateCases()[0], phase = f.phase; phase.generation = 2;
  const record = f.generationPublication;
  core.recordGenerationPublication(phase, record);
  assert.equal(phase.generationPublications[0].generation, '1'); assert.equal(phase.generationPublications[1], record);
  record.record = { path: 'context/publication.json', sha256: 'a'.repeat(64) };
  assert.equal(phase.generationPublications[1].record, record.record, 'native persistence can fill the accepted record reference');
  core.recordGenerationPublication(phase, { generation: '2', id: 'replaced' });
  assert.equal(phase.generationPublications.length, 2); assert.equal(phase.generationPublications[1].id, 'replaced');
  core.recordGenerationAgentBriefs(phase, f.agentBriefs);
  assert.deepEqual(phase.agentBriefs.map(entry => entry.consumerPhase), ['later', 'a', 'z']);
  core.recordGenerationArtifactSet(phase, f.catalog, f.diff);
  assert.equal('surgicalReopen' in phase, false); assert.deepEqual(phase.artifactSet.reopen.incidental, ['evidence']);
});

test('every publication projection executes without infrastructure, clocks or executable discovery', () => {
  const source = `
    import {registerHooks} from 'node:module';
    const hooks=registerHooks({resolve(specifier,context,next){if(specifier.startsWith('node:'))throw new Error(specifier);return next(specifier,context);}});
    const core=await import(${JSON.stringify(new URL('../src/kernel/lifecycle-transitions.mjs', import.meta.url).href)});
    const fixture=await import(${JSON.stringify(new URL('./helpers/publication-state-cases.mjs', import.meta.url).href)});
    for(const entry of fixture.publicationStateCases()){
      const result=fixture.observePublicationState(core,entry,2);
      if(result.phase.status!=='in_progress'||result.receipt.status!=='pending-tests'||result.workflow.history.length)throw new Error('invented completion');
    }
    hooks.deregister();
  `;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', source], { encoding: 'utf8', timeout: 15000, env: { ...process.env, PATH: '' } });
  assert.equal(result.status, 0, result.stderr || result.error?.message);
});
