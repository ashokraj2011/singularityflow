import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import ts from 'typescript';
import { inspectPureModuleGraph } from './helpers/pure-module-graph.mjs';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// Match the aggregate modules by exact basename. Revision components may legitimately contain
// local state in names such as interactive-state.mjs; those are not Story/Initiative stores.
const RAW_STATE_IMPORT = /from\s+['"](?:[^'"]*\/)?(?:state|initiative-state)\.mjs['"]/;

async function sourceFiles(directory) {
  const absolute = path.join(packageRoot, directory);
  const entries = await readdir(absolute, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const relative = path.posix.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await sourceFiles(relative));
    else if (/\.(?:mjs|js|ts|cjs)$/.test(entry.name)) files.push(relative);
  }
  return files;
}

test('the shared foundation and SDA contracts have no infrastructure dependency closure', async () => {
  const foundation = await sourceFiles('src/foundation');
  const contracts = ['src/sda/shared-state-contract.mjs', 'src/sda/lifecycle-authority-contract.mjs'];
  const namespaces = await sourceFiles('src/sda/namespace');
  const content = await sourceFiles('src/sda/content');
  const compatibilityContract = ['src/sda/git-compatibility-contract.mjs'];
  const kernel = await sourceFiles('src/kernel');
  const sdk = await sourceFiles('src/engine-sdk');
  for (const rule of [
    { entries: foundation, allowed: foundation },
    { entries: contracts, allowed: [...foundation, ...contracts] },
    { entries: namespaces, allowed: [...foundation, ...namespaces] },
    { entries: content, allowed: [...foundation, ...namespaces, ...content] },
    { entries: compatibilityContract, allowed: [...foundation, ...contracts, ...namespaces, ...compatibilityContract] },
    { entries: kernel, allowed: [...foundation, ...kernel] },
    { entries: sdk, allowed: [...foundation, ...kernel, ...sdk] }
  ]) {
    const report = await inspectPureModuleGraph({ root: packageRoot, ...rule });
    assert.deepEqual(report.problems, [],
      'foundation must not depend on SDA; contracts may use foundation, without host I/O or computed imports');
  }
});

test('public SDK core, errors, namespace and journal entries remain pure and do not select a backend', async () => {
  const foundation = await sourceFiles('src/foundation'), kernel = await sourceFiles('src/kernel');
  const sdk = await sourceFiles('src/engine-sdk'), namespaces = await sourceFiles('src/sda/namespace'), content = await sourceFiles('src/sda/content');
  const entries = ['index', 'errors', 'namespace', 'content', 'artifacts', 'specifications', 'source', 'source-control', 'changes', 'execution', 'execution/storage', 'storage/journal','testing/reports'].map(name => `packages/engine-sdk/src/${name}.mjs`);
  const report = await inspectPureModuleGraph({ root: packageRoot, entries,
    allowed: [...foundation, ...kernel, ...sdk, ...namespaces, ...content, ...entries, 'src/sgos/operational-contract.mjs'] });
  assert.deepEqual(report.problems, []);
});

test('standalone execution units have no installed provider, repository configuration, Git or lifecycle owner',async()=>{
  const owner='src/sgos/node-execution-unit.mjs',allowed=new Set(['node:fs/promises','node:child_process','node:crypto','node:path',
    '../foundation/record-schema.mjs','../foundation/failures.mjs','../platform-process-values.mjs','./node-execution-values.mjs']);
  const ast=ts.createSourceFile(owner,await readFile(path.join(packageRoot,owner),'utf8'),ts.ScriptTarget.Latest,true);
  const visit=node=>{
    if(ts.isImportDeclaration(node)||ts.isExportDeclaration(node)&&node.moduleSpecifier)assert.ok(allowed.has(node.moduleSpecifier.text),node.moduleSpecifier.text);
    assert.equal(ts.isCallExpression(node)&&node.expression.kind===ts.SyntaxKind.ImportKeyword,false);
    if(ts.isIdentifier(node)&&['loadDefinition','invokeModel','resolveModelProvider','loadSession','repoRoot','transactStory'].includes(node.text))assert.fail('Execution must use explicit constructor bindings.');
    ts.forEachChild(node,visit);
  };visit(ast);
  const legacy=await readFile(path.join(packageRoot,'src/sgos/execution-units.mjs'),'utf8');
  assert.doesNotMatch(legacy,/\b(?:spawn|spawnSync|class|function)\b/u,'legacy execution imports are a compatibility facade');
  for(const file of await sourceFiles('src')){
    if(file==='src/sgos/execution-units.mjs')continue;
    const text=await readFile(path.join(packageRoot,file),'utf8');
    assert.equal(text.includes("from './execution-units.mjs'"),false,file+' must select its explicit execution owner');
    assert.equal(text.includes("from '../sgos/execution-units.mjs'"),false,file+' must select its explicit execution owner');
  }
});

test('execution value validation and retained check-proof reading cannot import process or file owners',async()=>{
  const entries=new Map([
    ['src/sgos/node-execution-values.mjs',new Set(['node:crypto','node:path','../foundation/record-schema.mjs','../foundation/failures.mjs'])],
    ['src/engine-storage/namespace-phase-check-reader.mjs',new Set(['./namespace-test-recovery-reader.mjs','./namespace-test-command-reader.mjs','node:crypto','../foundation/failures.mjs','../foundation/record-schema.mjs',
      '../foundation/execution-unit-port.mjs','../foundation/source-snapshot.mjs','../records.mjs','../kernel/phase-checks.mjs',
      '../kernel/project-enrollment.mjs','../engine-compatibility/node-configuration-path.mjs','../verification/test-report-reader.mjs',
      '../sgos/node-execution-values.mjs','../sda/namespace/values.mjs','../sda/namespace/contract.mjs','../sda/content/contract.mjs',
      './namespace-story-reader.mjs','./namespace-lifecycle-codec.mjs','./namespace-phase-check-contract.mjs'])]
  ]);
  for(const [file,allowed]of entries){
    const ast=ts.createSourceFile(file,await readFile(path.join(packageRoot,file),'utf8'),ts.ScriptTarget.Latest,true);
    const visit=node=>{
      if(ts.isImportDeclaration(node)||ts.isExportDeclaration(node)&&node.moduleSpecifier)assert.ok(allowed.has(node.moduleSpecifier.text),file+': '+node.moduleSpecifier.text);
      const dataName=node.parent&&(ts.isPropertyAccessExpression(node.parent)&&node.parent.name===node
        ||ts.isPropertyAssignment(node.parent)&&node.parent.name===node);
      if(ts.isIdentifier(node)&&!dataName&&['process','eval','Function','require'].includes(node.text))assert.fail(file+' must use explicit read capabilities');
      if(ts.isCallExpression(node)&&node.expression.kind===ts.SyntaxKind.ImportKeyword)assert.fail(file+' cannot load an execution owner');
      if(ts.isPropertyAccessExpression(node)&&['put','transact','start','requestStop','writeFile','unlink'].includes(node.name.text))assert.fail(file+' cannot execute or mutate');
      ts.forEachChild(node,visit);
    };visit(ast);
  }
});

test('Story-command proofs cannot execute tests or select persistence and only their writer composes mutations',async()=>{
  const reader='src/engine-storage/namespace-test-command-reader.mjs',writer='src/engine-storage/namespace-test-commands.mjs',
    allowed=new Set(['node:crypto','../foundation/failures.mjs','../foundation/record-schema.mjs','../records.mjs','../kernel/test-recovery.mjs',
      '../kernel/decision-plan.mjs','../kernel/approval-fallback.mjs','../kernel/approval-policy.mjs','../engine-compatibility/node-configuration-path.mjs',
      '../sda/namespace/values.mjs','./namespace-decision-contract.mjs','./namespace-recorded-mutation-reader.mjs']);
  const source=ts.createSourceFile(reader,await readFile(path.join(packageRoot,reader),'utf8'),ts.ScriptTarget.Latest,true);
  const visit=node=>{
    if(ts.isImportDeclaration(node))assert.ok(allowed.has(node.moduleSpecifier.text),node.moduleSpecifier.text);
    if(ts.isCallExpression(node))assert.notEqual(node.expression.kind,ts.SyntaxKind.ImportKeyword);
    if(ts.isIdentifier(node)&&['process','require','eval','Function'].includes(node.text))assert.fail('Command proofs require explicit admitted values.');
    if(ts.isPropertyAccessExpression(node)&&['put','transact','commit','writeFile','unlink','start','requestStop','spawn','spawnSync'].includes(node.name.text))assert.fail('Command-proof replay cannot execute or mutate.');
    ts.forEachChild(node,visit);
  };visit(source);
  for(const file of await sourceFiles('src')){
    if([writer,'src/engine-storage/namespace-engine.mjs'].includes(file))continue;
    assert.doesNotMatch(await readFile(path.join(packageRoot,file),'utf8'),/from ['"].*namespace-test-commands\.mjs['"]/u,file+' must use the read-only command owner');
  }
});

test('local check execution binds only explicit SGOS, report and content owners',async()=>{
  const file='src/sgos/node-check-execution-unit.mjs',text=await readFile(path.join(packageRoot,file),'utf8');
  const ast=ts.createSourceFile(file,text,ts.ScriptTarget.Latest,true),allowed=new Set(['node:fs','node:fs/promises','node:crypto','node:path',
    '../foundation/failures.mjs','../foundation/record-schema.mjs','../foundation/source-snapshot.mjs',
    '../sda/namespace/values.mjs','../sda/content/contract.mjs','../verification/test-report-reader.mjs',
    './filesystem-source-unit.mjs','./node-execution-unit.mjs','../foundation/execution-unit-port.mjs']);
  for(const statement of ast.statements)if(ts.isImportDeclaration(statement))assert.ok(allowed.has(statement.moduleSpecifier.text),statement.moduleSpecifier.text);
  assert.doesNotMatch(text,/\bspawn\b|\bspawnSync\b|loadDefinition|invokeModel|repoRoot|transactStory|process\.env/u);
  assert.match(text,/sandbox:\{kind:'host-local',enforcement:'none'\}/u);assert.match(text,/network:\{mode:'host-unrestricted'\}/u);
  assert.match(text,/await executePinnedProcess/u);
});

test('only explicit storage adapters consume namespace contracts outside their pure directory', async () => {
  const directory = path.join(packageRoot, 'src/sda/namespace') + path.sep;
  // Phase 3 composes the existing owners without selecting a generic namespace store. CLI/SDK
  // routing is a later vertical slice; adding a direct host dependency must fail this guard.
  const compatibility = new Set(['src/sda/git-compatibility-contract.mjs', 'src/sda/git-compatibility-adapter.mjs']);
  const namespaceAdapters = new Set(['src/engine-storage/namespace-test-cohort-reader.mjs','src/engine-storage/namespace-test-cohorts.mjs','src/engine-storage/namespace-witness-mapping-reader.mjs','src/engine-storage/namespace-witness-renewals.mjs','src/engine-storage/namespace-obligation-risks.mjs','src/engine-storage/namespace-obligation-risk-reader.mjs','src/engine-storage/namespace-terminal-evidence.mjs','src/engine-storage/namespace-evidence-reader.mjs','src/engine-storage/namespace-evidence.mjs','src/engine-storage/namespace-test-repair-contract.mjs','src/engine-storage/namespace-test-repair-reader.mjs','src/engine-storage/namespace-test-repair.mjs','src/engine-storage/namespace-forward-contract.mjs','src/engine-storage/namespace-forward-reader.mjs','src/engine-storage/namespace-document-review.mjs','src/engine-storage/namespace-decision-batch-journal.mjs','src/engine-storage/namespace-convergence-policy.mjs','src/engine-storage/namespace-convergence-contract.mjs','src/engine-storage/namespace-repair-budget-reader.mjs','src/engine-storage/namespace-test-command-reader.mjs','src/engine-storage/namespace-constitution-exceptions.mjs','src/engine-storage/namespace-constitution-exception-reader.mjs','src/engine-storage/namespace-witness-decisions.mjs','src/engine-storage/namespace-artifact-set-reader.mjs','src/engine-storage/namespace-phase-inspection.mjs','src/engine-storage/namespace-story-queries.mjs','src/engine-storage/namespace-generation-reader.mjs','src/engine-storage/namespace-plan-decisions-reader.mjs','src/engine-storage/namespace-decision-contract.mjs','src/engine-storage/namespace-recorded-mutation.mjs','src/engine-storage/namespace-human-decision.mjs','src/engine-storage/namespace-human-decision-contract.mjs','src/engine-storage/namespace-conformance.mjs','src/engine-storage/namespace-code-inputs.mjs','src/engine-storage/namespace-code-policy.mjs','src/engine-storage/namespace-phase-entry.mjs','src/engine-storage/namespace-clarifications.mjs','src/engine-storage/namespace-clarification-reader.mjs','src/engine-storage/namespace-policy-contract.mjs','src/engine-storage/namespace-policy-reader.mjs','src/engine-storage/namespace-policy-retention.mjs','src/engine-storage/namespace-specifications.mjs','src/engine-storage/namespace-specification-retention.mjs','src/engine-storage/namespace-specification-contract.mjs','src/engine-storage/namespace-source-control.mjs','src/engine-storage/namespace-source-control-reader.mjs','src/engine-storage/namespace-source-control-contract.mjs','src/engine-storage/namespace-source-origins.mjs',
    'src/engine-storage/namespace-output-retention.mjs','src/engine-storage/namespace-output-retention-reader.mjs','src/engine-storage/namespace-output-retention-contract.mjs','src/engine-storage/namespace-read-session.mjs',
    'src/engine-storage/namespace-delivery-inspection.mjs','src/engine-storage/namespace-test-witnesses.mjs','src/engine-storage/namespace-source-baseline.mjs','src/engine-storage/namespace-source-baseline-reader.mjs','src/engine-storage/namespace-source-baseline-contract.mjs',
    'src/engine-storage/namespace-source-retention.mjs','src/engine-storage/namespace-source-retention-reader.mjs','src/engine-storage/namespace-source-retention-contract.mjs',
    'src/engine-storage/namespace-source-inspection.mjs','src/engine-storage/namespace-phase-check-reader.mjs','src/engine-storage/namespace-phase-checks.mjs','src/engine-storage/namespace-phase-check-contract.mjs',
    'src/sgos/node-check-execution-unit.mjs','src/sgos/durable-execution-unit.mjs','src/sgos/namespace-operational-store.mjs','src/sda/filesystem-namespace-adapter.mjs', 'src/sda/filesystem-namespace-journal.mjs',
    'src/sda/namespace-journal-adapter.mjs', 'src/sda/application-namespace-adapter.mjs',
    'src/sda/sqlite-namespace-adapter.mjs', 'src/sda/sqlite-namespace-journal.mjs', 'src/sda/sqlite-native.mjs',
    'src/sda/content/contract.mjs', 'src/sda/sqlite-content-adapter.mjs',
    'src/engine-storage/namespace-reader.mjs', 'src/engine-storage/namespace-read-contract.mjs',
    'src/engine-storage/namespace-lifecycle-commit.mjs', 'src/engine-storage/namespace-lifecycle-contract.mjs',
    'src/engine-storage/namespace-lifecycle-codec.mjs','src/engine-storage/namespace-lifecycle-receipt-reader.mjs',
    'src/engine-storage/namespace-project.mjs', 'src/engine-storage/namespace-project-contract.mjs',
    'src/engine-storage/namespace-configuration.mjs', 'src/engine-storage/namespace-configuration-contract.mjs',
    'src/engine-storage/namespace-configuration-codec.mjs','src/engine-storage/namespace-configuration-reader.mjs',
    'src/engine-storage/namespace-lifecycle-reader.mjs','src/engine-storage/namespace-story.mjs','src/engine-storage/namespace-story-contract.mjs',
    'src/engine-storage/namespace-story-codec.mjs','src/engine-storage/namespace-story-reader.mjs',
    'src/engine-storage/namespace-source.mjs','src/engine-storage/namespace-draft-store.mjs',
    'src/engine-storage/namespace-draft-contract.mjs','src/engine-storage/namespace-preparation.mjs',
    'src/engine-storage/namespace-publication.mjs','src/engine-storage/namespace-publication-contract.mjs',
    'src/engine-storage/namespace-submission.mjs','src/engine-storage/namespace-submission-contract.mjs',
    'src/engine-storage/namespace-approval.mjs','src/engine-storage/namespace-approval-contract.mjs',
    'src/engine-storage/namespace-routing-choice.mjs','src/engine-storage/namespace-routing-choice-contract.mjs',
    'src/engine-storage/namespace-engine.mjs','src/engine-storage/namespace-upstream-artifact.mjs']);
  const violations = [];
  for (const relative of await sourceFiles('src')) {
    const absolute = path.join(packageRoot, relative);
    if (absolute.startsWith(directory)) continue;
    const source = ts.createSourceFile(relative, await readFile(absolute, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
    const visit = node => {
      const specifier = (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) ? node.moduleSpecifier
        : ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword ? node.arguments[0] : null;
      if (specifier && ts.isStringLiteralLike(specifier) && specifier.text.startsWith('.')) {
        const target = path.resolve(path.dirname(absolute), specifier.text);
        if ((target.startsWith(directory) || [...compatibility].some(file => target === path.join(packageRoot, file)))
          && !compatibility.has(relative) && !namespaceAdapters.has(relative)) violations.push(relative);
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  assert.deepEqual(violations, [], 'new namespace backends must not change installed Git routing');
});

test('namespace operational history uses SDA ports without selecting files, Git, models or lifecycle authority',async()=>{
  const file='src/sgos/namespace-operational-store.mjs',allowed=new Set(['node:crypto','../foundation/record-schema.mjs',
    '../foundation/failures.mjs','../sda/namespace/contract.mjs','../sda/namespace/values.mjs',
    '../sda/namespace/transaction.mjs','../sda/content/contract.mjs','./operational-contract.mjs']);
  const ast=ts.createSourceFile(file,await readFile(path.join(packageRoot,file),'utf8'),ts.ScriptTarget.Latest,true);
  const visit=node=>{
    if(ts.isImportDeclaration(node)||ts.isExportDeclaration(node)&&node.moduleSpecifier)assert.ok(allowed.has(node.moduleSpecifier.text),node.moduleSpecifier.text);
    assert.equal(ts.isCallExpression(node)&&node.expression.kind===ts.SyntaxKind.ImportKeyword,false);
    if(ts.isIdentifier(node)&&['process','repoRoot','loadDefinition','invokeModel','transactStory'].includes(node.text))assert.fail('Operational storage must use explicit SDA ports.');
    if(ts.isStringLiteral(node))assert.equal(['state','config','evidence','local'].includes(node.text),false,'Operational storage may only publish runtime records.');
    ts.forEachChild(node,visit);
  };visit(ast);
});

test('durable execution decorates explicit operational ports without selecting native storage or lifecycle authority',async()=>{
  const file='src/sgos/durable-execution-unit.mjs',allowed=new Set(['node:crypto','../foundation/record-schema.mjs',
    '../foundation/execution-unit-port.mjs','../foundation/failures.mjs','./operational-contract.mjs',
    '../sda/content/contract.mjs','../sda/namespace/values.mjs']);
  const ast=ts.createSourceFile(file,await readFile(path.join(packageRoot,file),'utf8'),ts.ScriptTarget.Latest,true);
  const visit=node=>{
    if(ts.isImportDeclaration(node)||ts.isExportDeclaration(node)&&node.moduleSpecifier)assert.ok(allowed.has(node.moduleSpecifier.text),node.moduleSpecifier.text);
    assert.equal(ts.isCallExpression(node)&&node.expression.kind===ts.SyntaxKind.ImportKeyword,false);
    if(ts.isIdentifier(node)&&['process','repoRoot','loadDefinition','invokeModel','transactStory'].includes(node.text))assert.fail('Execution coordination must use its captured ports.');
    if(ts.isStringLiteral(node))assert.equal(['state','config','evidence','local'].includes(node.text),false,'The decorator writes operational history only.');
    ts.forEachChild(node,visit);
  };visit(ast);
});

test('test report parsing has pure rules and a narrow native byte binding, with native environment setup in its existing host',async()=>{
  const codec=await readFile(path.join(packageRoot,'src/kernel/test-report-codec.mjs'),'utf8');
  assert.doesNotMatch(codec,/process\.|loadDefinition|readFile|\bspawn\b|import\s*\(/u);
  const pure=ts.createSourceFile('test-report-codec.mjs',codec,ts.ScriptTarget.Latest,true);
  for(const statement of pure.statements)if(ts.isImportDeclaration(statement))assert.equal(statement.moduleSpecifier.text,'../foundation/failures.mjs');
  const binding=ts.createSourceFile('test-report-reader.mjs',await readFile(path.join(packageRoot,'src/verification/test-report-reader.mjs'),'utf8'),ts.ScriptTarget.Latest,true);
  for(const statement of binding.statements)if(ts.isImportDeclaration(statement))assert.ok(['node:crypto','../kernel/test-report-codec.mjs'].includes(statement.moduleSpecifier.text));
  const legacy=await readFile(path.join(packageRoot,'src/code-delivery-tests.mjs'),'utf8');
  assert.match(legacy,/from '\.\/verification\/test-report-reader\.mjs'/u);
  assert.doesNotMatch(legacy,/function (?:parseXml|junitObservation|testReportFromContents|replayTestReports)\b/u);
  for(const file of ['src/state.mjs','src/local-test-runs.mjs','src/test-recovery-runtime.mjs']) {
    const text=await readFile(path.join(packageRoot,file),'utf8');assert.equal(text.includes('verification/node-test-observation.mjs'),false,file);
  }
  const facade=ts.createSourceFile('node-test-observation.mjs',await readFile(path.join(packageRoot,'src/verification/node-test-observation.mjs'),'utf8'),ts.ScriptTarget.Latest,true);
  assert.ok(facade.statements.every(ts.isExportDeclaration));
  const identity=await readFile(path.join(packageRoot,'src/build-identity.mjs'),'utf8'),manifest=await readFile(path.join(packageRoot,'src/vsix-source-manifest.mjs'),'utf8');
  for(const file of ['kernel/test-report-codec.mjs','verification/test-report-reader.mjs']) {
    assert.ok(identity.includes("'"+file+"'"),file+' build identity');assert.ok(manifest.includes("'src/"+file+"'"),file+' staged payload');
  }
});

test('kernel tree shaking is backed by pure initialization and no side-effect-only imports', async () => {
  assert.deepEqual(JSON.parse(await readFile(path.join(packageRoot, 'src/kernel/package.json'), 'utf8')), { sideEffects: false });
  for (const file of await sourceFiles('src/kernel')) {
    const ast = ts.createSourceFile(file, await readFile(path.join(packageRoot, file), 'utf8'), ts.ScriptTarget.Latest, true);
    const initializer = node => {
      if (ts.isFunctionExpression(node) || ts.isArrowFunction(node) || ts.isMethodDeclaration(node)) return;
      if (ts.isCallExpression(node)) assert.equal(node.expression.getText(ast), 'Object.freeze', file);
      if (ts.isNewExpression(node)) assert.ok(['Set', 'Map', 'WeakMap', 'WeakSet', 'RegExp'].includes(node.expression.getText(ast)), file);
      assert.equal(ts.isAwaitExpression(node) || ts.isYieldExpression(node), false, file);
      assert.equal(ts.isDeleteExpression(node) || ts.isPostfixUnaryExpression(node)
        || ts.isPrefixUnaryExpression(node) && [ts.SyntaxKind.PlusPlusToken, ts.SyntaxKind.MinusMinusToken].includes(node.operator), false, file);
      if (ts.isBinaryExpression(node)) assert.equal(node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment
        && node.operatorToken.kind <= ts.SyntaxKind.LastAssignment, false, file);
      ts.forEachChild(node, initializer);
    };
    for (const node of ast.statements) {
      if (ts.isVariableStatement(node)) {
        for (const declaration of node.declarationList.declarations) if (declaration.initializer) initializer(declaration.initializer);
      }
      else if (ts.isImportDeclaration(node)) assert.ok(node.importClause, file);
      else if (ts.isClassDeclaration(node)) {
        // A plain Error subclass evaluates no member bodies. Computed names, fields, static
        // blocks and decorators can evaluate effects, so none are admitted by this exception.
        assert.equal(node.heritageClauses?.length, 1, file);
        assert.equal(node.heritageClauses[0].token, ts.SyntaxKind.ExtendsKeyword, file);
        assert.equal(node.heritageClauses[0].types.length, 1, file);
        assert.equal(node.heritageClauses[0].types[0].expression.getText(ast), 'Error', file);
        assert.equal(node.modifiers?.length ?? 0, 0, file);
        for (const member of node.members) {
          assert.ok(ts.isConstructorDeclaration(member) || ts.isMethodDeclaration(member), file);
          assert.equal(member.modifiers?.length ?? 0, 0, file);
          assert.equal(Boolean(member.name && ts.isComputedPropertyName(member.name)), false, file);
        }
      }
      else assert.ok(ts.isFunctionDeclaration(node) || ts.isExportDeclaration(node), file);
    }
  }
});

test('only the portable path and structural record helpers are side-effect-free in the foundation package', async () => {
  const { sideEffects } = JSON.parse(await readFile(path.join(packageRoot, 'src/foundation/package.json'), 'utf8'));
  assert.ok(Array.isArray(sideEffects));
  const files = await sourceFiles('src/foundation');
  const pure=['src/foundation/portable-paths.mjs','src/foundation/record-shapes.mjs'];
  assert.deepEqual(files.filter(file => !sideEffects.includes('./' + path.basename(file))), pure);
  assert.deepEqual([...sideEffects].sort(), files.filter(file => !pure.includes(file)).map(file => './' + path.basename(file)).sort());
  for(const file of pure){
  const ast = ts.createSourceFile(file, await readFile(path.join(packageRoot, file), 'utf8'), ts.ScriptTarget.Latest, true);
  for (const statement of ast.statements) {
    if (ts.isImportDeclaration(statement)) assert.ok(statement.importClause, 'no side-effect-only imports');
    else if (ts.isVariableStatement(statement)) {
      assert.ok(statement.declarationList.flags & ts.NodeFlags.Const);
      for (const declaration of statement.declarationList.declarations) assert.ok(declaration.initializer && ts.isRegularExpressionLiteral(declaration.initializer));
    } else assert.ok(ts.isFunctionDeclaration(statement), 'no module-time execution');
  }}
});

test('next-step hosts execute one registered plan and keep native observations out of command handlers', async () => {
  const command = await readFile(path.join(packageRoot, 'src/commands/nextsteps.mjs'), 'utf8');
  assert.match(command, /binding\.engine\.run\('story\.next'/);
  assert.doesNotMatch(command, /readPhaseDraftEvidence\(|pendingDecisionSummary\(|inspectMcpPhaseReadiness\(/);
  const observer = await readFile(path.join(packageRoot, 'src/engine-compatibility/git-nextsteps.mjs'), 'utf8');
  assert.doesNotMatch(observer, /(?:from|import\()\s*['"][^'"]*commands\/|console\.|optionBoolean\(/);
  const core = await readFile(path.join(packageRoot, 'src/kernel/next-plan.mjs'), 'utf8');
  assert.doesNotMatch(core, /singularity-flow|safeCommandGuidance|copilot|operationContext|readFile/);
  const aliases = ['src/guide.mjs', 'src/source-review-continuation.mjs', 'src/phase-governance-routing.mjs'];
  for (const file of aliases) {
    const ast = ts.createSourceFile(file, await readFile(path.join(packageRoot, file), 'utf8'), ts.ScriptTarget.Latest, true);
    assert.ok(ast.statements.every(ts.isExportDeclaration), file);
  }
});

test('artifact parsing and authoring rules are pure while native wrappers own bytes, hashing and I/O', async () => {
  const read = relative => readFile(path.join(packageRoot, relative), 'utf8');
  const core = await read('src/kernel/artifact-content.mjs');
  assert.doesNotMatch(core, /node:|createHash|readFile|Buffer\.|process\.|singularity-flow (?:phase|recover)/);
  const preflight = await read('src/publication-preflight.mjs');
  assert.match(preflight, /artifactContentObservation\(text\)/);
  assert.match(preflight, /sha256\(observation\.fingerprintText\)/);
  assert.match(preflight, /inspectArtifactContentObservation\(observation,/);
  assert.match(preflight, /sortArtifactFindings\(findings, \{ byPath: true \}\)/);
  assert.doesNotMatch(preflight, /FINDING_PRIORITY/);
  assert.doesNotMatch(preflight, /function (?:artifactPlaceholderFindings|repairPreparedArtifactMetadata|requiredHeadingFindings)\(/);
  const native = await read('src/artifact-review-read.mjs');
  assert.match(native, /createHash\('sha256'\)/);
  assert.doesNotMatch(native, /function (?:authoredArtifactText|inspectManagedArtifactMetadata|artifactTextCheckoutMatches)\(/);
  const document = await read('src/kernel/document-read.mjs');
  assert.match(document, /import \{ utf8Bytes \} from '\.\/artifact-content\.mjs'/);
  assert.doesNotMatch(document, /function utf8Bytes\(/);
  for (const file of ['src/markdown-structure.mjs', 'src/traceability-ids.mjs']) {
    const ast = ts.createSourceFile(file, await read(file), ts.ScriptTarget.Latest, true);
    assert.ok(ast.statements.every(ts.isExportDeclaration), file);
  }
});

test('configuration declarations have one pure owner and native effects remain outside the compiler', async () => {
  const core = await readFile(path.join(packageRoot, 'src/kernel/configuration-declarations.mjs'), 'utf8');
  assert.doesNotMatch(core, /node:|process\.|console\.|readFile|safeCommandGuidance/);
  for (const file of ['src/ledger-config.mjs','src/token-reporting-policy.mjs']) {
    const ast = ts.createSourceFile(file, await readFile(path.join(packageRoot, file), 'utf8'), ts.ScriptTarget.Latest, true);
    assert.ok(ast.statements.every(ts.isExportDeclaration), file);
  }
  for (const file of ['src/logging.mjs','src/story-branch-name.mjs','src/initiative-config.mjs','src/convergence.mjs']) {
    const ast = ts.createSourceFile(file, await readFile(path.join(packageRoot, file), 'utf8'), ts.ScriptTarget.Latest, true);
    const moved = new Set(['normalizeLogging','assertStoryBranchNaming','normalizeStorage','assertNoAutonomousConvergence']);
    assert.equal(ast.statements.some(node => ts.isFunctionDeclaration(node) && moved.has(node.name?.text)), false, file);
  }
});

test('configuration path rules depend on a string-syntax contract and native binding owns no business rule', async () => {
  const source = await readFile(path.join(packageRoot,'src/kernel/configuration-path-policies.mjs'),'utf8');
  assert.doesNotMatch(source,/node:|process\.|console\.|readFile|safeCommandGuidance/);
  for (const [file,allowed] of [
    ['src/engine-compatibility/node-configuration-path.mjs',new Set(['node:path','../kernel/configuration-path-policies.mjs'])]
  ]) {
    const ast = ts.createSourceFile(file,await readFile(path.join(packageRoot,file),'utf8'),ts.ScriptTarget.Latest,true);
    for (const node of ast.statements.filter(ts.isImportDeclaration)) assert.ok(allowed.has(node.moduleSpecifier.text),file+':'+node.moduleSpecifier.text);
    const visit = node => {
      assert.equal(ts.isCallExpression(node)&&(node.expression.kind===ts.SyntaxKind.ImportKeyword
        ||ts.isIdentifier(node.expression)&&['require','eval','Function'].includes(node.expression.text)),false,file);
      if (ts.isIdentifier(node)&&node.text==='process') assert.fail(file+' must not discover ambient context.');
      ts.forEachChild(node,visit);
    };visit(ast);
  }
  const adapter = ts.createSourceFile('adapter',await readFile(path.join(packageRoot,'src/engine-compatibility/node-configuration-path.mjs'),'utf8'),ts.ScriptTarget.Latest,true);
  assert.equal(adapter.statements.some(ts.isFunctionDeclaration),false);
});

test('source path rules have one pure owner and legacy facades cannot import repository infrastructure',async()=>{
  const allowed=new Set(['node:path','node:crypto','../test-runners.mjs','./node-configuration-path.mjs','../governed-roots.mjs','../kernel/source-path-policies.mjs','../kernel/configuration-declarations.mjs','../kernel/code-delivery-evidence.mjs','../kernel/test-report-codec.mjs','../kernel/verification-witnesses.mjs']);
  const file='src/engine-compatibility/node-source-policy.mjs';
  const binding=ts.createSourceFile(file,await readFile(path.join(packageRoot,file),'utf8'),ts.ScriptTarget.Latest,true);
  assert.equal(binding.statements.some(ts.isFunctionDeclaration),false);
  const visit=node=>{
    if(ts.isImportDeclaration(node)||ts.isExportDeclaration(node)&&node.moduleSpecifier)assert.ok(allowed.has(node.moduleSpecifier.text),node.moduleSpecifier.text);
    if(ts.isIdentifier(node)&&['process','eval','Function','require'].includes(node.text))assert.fail(file+' must bind declared string values only');
    if(ts.isCallExpression(node)&&node.expression.kind===ts.SyntaxKind.ImportKeyword)assert.fail(file+' cannot discover host implementations');
    ts.forEachChild(node,visit);
  };visit(binding);
  for(const name of ['configuration-paths','source-boundary','supporting-changes','application-paths','configuration-materialization']){
    const ast=ts.createSourceFile(name,await readFile(path.join(packageRoot,`src/${name}.mjs`),'utf8'),ts.ScriptTarget.Latest,true);
    assert.ok(ast.statements.every(node=>ts.isExportDeclaration(node)&&node.moduleSpecifier.text==='./engine-compatibility/node-source-policy.mjs'),name);
  }
  for(const source of await sourceFiles('src')){
    if(['configuration-paths','source-boundary','supporting-changes','application-paths','configuration-materialization'].some(name=>source===`src/${name}.mjs`))continue;
    const ast=ts.createSourceFile(source,await readFile(path.join(packageRoot,source),'utf8'),ts.ScriptTarget.Latest,true);
    for(const node of ast.statements){
      if(!ts.isImportDeclaration(node)&&!(ts.isExportDeclaration(node)&&node.moduleSpecifier))continue;
      assert.equal(/(?:^|\/)(?:configuration-paths|source-boundary|supporting-changes|application-paths|configuration-materialization)\.mjs$/u.test(node.moduleSpecifier.text),false,source);
    }
  }
});

test('code-delivery replay rules stay in the kernel and the native verifier only serves explicit evidence requests',async()=>{
  const owner='src/kernel/code-delivery-evidence.mjs';
  const pure=await inspectPureModuleGraph({root:packageRoot,entries:[owner],allowed:[...await sourceFiles('src/foundation'),...await sourceFiles('src/kernel')]});
  assert.deepEqual(pure.problems,[]);
  const text=await readFile(path.join(packageRoot,'src/delivery-evidence.mjs'),'utf8');
  const ast=ts.createSourceFile('native-delivery',text,ts.ScriptTarget.Latest,true);
  const replay=ast.statements.find(node=>ts.isFunctionDeclaration(node)&&node.name?.text==='verifyCodeDeliveryReceipt');
  assert.ok(replay);
  const body=replay.body.getText(ast);
  assert.equal((body.match(/codeDeliveryReceiptReplay\(/gu)??[]).length,1);
  for(const decision of ['testReceiptPassing','testCommandCoversPath','modelAssuranceRank','evaluateStoryProtectedPaths','cornerCaseMatrixDigest']){
    assert.equal(body.includes(decision+'('),false,decision+' belongs to the shared replay rules');
  }
  assert.equal(body.includes('plan.throw(error)'),true,'reader failures return to the same rule checkpoint');
  const kernel=await readFile(path.join(packageRoot,owner),'utf8');
  assert.doesNotMatch(kernel,/\b(?:readFile|spawn|process|run|invokeModel|loadSession|loadDefinition)\s*[.(]/u);
  assert.doesNotMatch(kernel,/import\s*\(/u);
});

test('code preflight uses shared policy and refusal formatting cannot authorize a delivery',async()=>{
  const native=await readFile(path.join(packageRoot,'src/delivery-evidence.mjs'),'utf8'),ast=ts.createSourceFile('preflight',native,ts.ScriptTarget.Latest,true);
  const select=name=>ast.statements.find(node=>ts.isFunctionDeclaration(node)&&node.name?.text===name)?.body.getText(ast);
  const preflight=select('evaluateCodeDeliveryPreflight');assert.ok(preflight);
  assert.equal((preflight.match(/codeDeliveryPreflightReplay\(/gu)??[]).length,1);
  for(const decision of ['changesProductSource','evaluateStoryProtectedPaths','evaluateSourceBoundary','codeDeliveryCandidateSha256','canonicalFinding'])assert.equal(preflight.includes(decision+'('),false,decision);
  const formatter=select('formatCodeDeliveryPreflightRefusal');assert.ok(formatter);
  assert.doesNotMatch(formatter,/\b(?:readFile|run|secureRepositoryPath|loadActiveSpecRecords|evaluateCodeDeliveryPreflight)\s*\(/u);
  const kernelText=await readFile(path.join(packageRoot,'src/kernel/code-delivery-evidence.mjs'),'utf8');
  assert.doesNotMatch(kernelText,/singularity-flow\s+(?:recover|decision|phase|story|upstream-issue)\b/u);
  const kernel=ts.createSourceFile('rules',kernelText,ts.ScriptTarget.Latest,true);let refusals=0;
  const visit=node=>{
    if(ts.isCallExpression(node)&&ts.isIdentifier(node.expression)&&node.expression.text==='request'&&node.arguments[0]?.text==='format-preflight-refusal'){
      assert.equal(ts.isYieldExpression(node.parent),true);
      assert.equal(ts.isParenthesizedExpression(node.parent.parent),true);
      assert.equal(ts.isThrowStatement(node.parent.parent.parent),true);refusals++;
    }ts.forEachChild(node,visit);
  };visit(kernel);assert.equal(refusals,4);
});

test('source-clause rules have one pure owner and the native function only supplies exact observations',async()=>{
  const text=await readFile(path.join(packageRoot,'src/delivery-evidence.mjs'),'utf8'),ast=ts.createSourceFile('source-clauses',text,ts.ScriptTarget.Latest,true),
    entry=ast.statements.find(node=>ts.isFunctionDeclaration(node)&&node.name?.text==='plannedSourceClauseBindings');assert.ok(entry);
  const body=entry.body.getText(ast);assert.equal((body.match(/plannedSourceClauseBindingsReplay\(/gu)??[]).length,1);
  for(const decision of ['changesProductSource','plannedProductSourcePaths','storyOwnsTag','namespaceOf','predecessorSpecClauses'])assert.equal(body.includes(decision+'('),false,decision);
  assert.match(body,/readFile\(secured\.get\(request\.path\)\.absolute\)/u,'read the exact canonical path issued by the native security owner');
  const specification=ts.createSourceFile('specifications',await readFile(path.join(packageRoot,'src/specifications.mjs'),'utf8'),ts.ScriptTarget.Latest,true);
  assert.equal(specification.statements.some(node=>ts.isFunctionDeclaration(node)&&node.name?.text==='predecessorSpecClauses'),false);
});

test('source-tag ownership stays in the kernel while Git patch decoding remains an adapter fact',async()=>{
  const owner='src/delivery-evidence.mjs',text=await readFile(path.join(packageRoot,owner),'utf8'),ast=ts.createSourceFile(owner,text,ts.ScriptTarget.Latest,true);
  for(const [name,replay]of [['carriedTags','carriedTagIdsReplay'],['storyAddedTagLines','storyTagLinesReplay']]) {
    const entry=ast.statements.find(node=>ts.isFunctionDeclaration(node)&&node.name?.text===name);assert.ok(entry);
    const body=entry.body.getText(ast);assert.equal((body.match(new RegExp(replay+'\\(','gu'))??[]).length,1);
    for(const policy of ['isApplicationPath','isDocumentationPath','isConfigurationPath','isAllowedTestAutomationPath','tagKey'])assert.equal(body.includes(policy+'('),false,name+': '+policy);
    assert.doesNotMatch(body,/\.trim\(|net\.set|added\.set/u,'a native fact server cannot decide which lines count');
  }
  assert.equal(ast.statements.some(node=>ts.isFunctionDeclaration(node)&&node.name?.text==='patchHeaderPath'),false);
  const parser=await readFile(path.join(packageRoot,'src/git-status-detail.mjs'),'utf8'),wire=ts.createSourceFile('wire',parser,ts.ScriptTarget.Latest,true),
    decode=wire.statements.find(node=>ts.isFunctionDeclaration(node)&&node.name?.text==='gitTagLineDeltas');assert.ok(decode);
  assert.doesNotMatch(decode.body.getText(wire),/isApplicationPath|isTestAutomationPath|plannedClaims|workIntervals|loadDefinition|readFile/u);
});

test('specification and verification compatibility facades share kernel values and retain native observation ordering',async()=>{
  for(const file of ['src/verification/contracts.mjs','src/verification/intent.mjs','src/draft-diagnostics.mjs','src/specification-quality.mjs','src/clarification-markers.mjs','src/specification-scenarios.mjs']) {
    const ast=ts.createSourceFile(file,await readFile(path.join(packageRoot,file),'utf8'),ts.ScriptTarget.Latest,true);
    assert.ok(ast.statements.every(node=>ts.isExportDeclaration(node)),file+' must remain a facade');
  }
  const file='src/engine-compatibility/node-specification-policy.mjs';
  const ast=ts.createSourceFile(file,await readFile(path.join(packageRoot,file),'utf8'),ts.ScriptTarget.Latest,true);
  const allowed=new Set(['../records.mjs','./node-configuration-path.mjs','../kernel/verification-policy.mjs','../kernel/specification-values.mjs','../kernel/specification-policy.mjs','../kernel/specification-analysis.mjs','../kernel/specification-markers.mjs','../kernel/conformance-report.mjs']);
  for(const node of ast.statements) {
    if(ts.isImportDeclaration(node))assert.ok(allowed.has(node.moduleSpecifier.text),node.moduleSpecifier.text);
    assert.equal(ts.isFunctionDeclaration(node),false,'bindings may not grow feature rules');
  }
  const native=ts.createSourceFile('native',await readFile(path.join(packageRoot,'src/specifications.mjs'),'utf8'),ts.ScriptTarget.Latest,true);
  for(const name of ['extractClauses','ignoredRanges','plannedClaimSource','canonicalJson'])assert.equal(native.statements.some(node=>ts.isFunctionDeclaration(node)&&node.name?.text===name),false,name);
  const body=native.statements.find(node=>ts.isFunctionDeclaration(node)&&node.name?.text==='buildSpecIndex').body.getText(native);
  let previous=-1;
  for(const step of ['normalizeSpecPolicy(','secureRepositoryPath(','readFile(','snapshot(','extractClauses(','specificationIndexRecord(','writeJson(']) {
    const current=body.indexOf(step);assert.ok(current>previous,'preserve native observation order: '+step);previous=current;
  }
  assert.doesNotMatch(body,/indexSha256:|createHash\(|currentSchemaVersion\(/u,'identity belongs to the shared index owner');
  const legacy=new Set(['src/verification/contracts.mjs','src/verification/intent.mjs','src/draft-diagnostics.mjs']);
  for(const file of await sourceFiles('src')) {
    if(legacy.has(file))continue;
    const source=ts.createSourceFile(file,await readFile(path.join(packageRoot,file),'utf8'),ts.ScriptTarget.Latest,true);
    const visit=node=>{
      const dependency=ts.isImportDeclaration(node)||ts.isExportDeclaration(node)?node.moduleSpecifier
        :ts.isCallExpression(node)&&node.expression.kind===ts.SyntaxKind.ImportKeyword?node.arguments[0]:null;
      if(dependency&&ts.isStringLiteralLike(dependency)&&dependency.text.startsWith('.')) {
        const target=path.posix.normalize(path.posix.join(path.posix.dirname(file),dependency.text));
        assert.equal(legacy.has(target),false,file+' must import the explicit owner rather than its compatibility facade');
      }
      ts.forEachChild(node,visit);
    };visit(source);
  }
});

test('coverage, active records and candidate completeness have one kernel owner and native code only serves observations and presentation',async()=>{
  const source=await readFile(path.join(packageRoot,'src/specifications.mjs'),'utf8'),ast=ts.createSourceFile('native',source,ts.ScriptTarget.Latest,true);
  for(const name of ['codeCoverageEnforcement','plannedClaimsForObservedPhase','mergeObservedClaimRecords','selectActiveSpecRecords','evaluateSpecAcceptance'])
    assert.equal(ast.statements.some(node=>ts.isFunctionDeclaration(node)&&node.name?.text===name),false,name+' must have one kernel owner');
  const inspect=ast.statements.find(node=>ts.isFunctionDeclaration(node)&&node.name?.text==='evaluateSpecCoverage').body.getText(ast);
  assert.equal((inspect.match(/evaluateSpecCoverageReplay\(/gu)??[]).length,1);
  assert.doesNotMatch(inspect,/mergePlannedClaimRecords\(|mergeObservedClaimRecords\(|claimedPaths|unimplemented|invalidEvidence/u);
  const preview='src/spec-coverage-preview.mjs',native=ts.createSourceFile(preview,await readFile(path.join(packageRoot,preview),'utf8'),ts.ScriptTarget.Latest,true),
    body=native.statements.find(node=>ts.isFunctionDeclaration(node)&&node.name?.text==='assertStrictCandidateSpecificationCoverage').body.getText(native);
  assert.equal((body.match(/candidateSpecificationCoverageReplay\(/gu)??[]).length,1);
  for(const rule of ['deriveObservedClaimMap','evaluateSpecCoverage','mergePlannedClaimRecords','plannedProductSourcePaths','phaseRequiresCodeDelivery'])assert.equal(body.includes(rule+'('),false,rule);
  assert.match(body,/loadBoundActiveSpecRecords\(/u);assert.match(body,/request===SPECIFICATION_CLAIM_TIMESTAMP_REQUEST/u);
  assert.match(body,/step\.value\.status === 'correction-required'/u);
  const owner='src/kernel/specification-values.mjs',graph=await inspectPureModuleGraph({root:packageRoot,entries:[owner],allowed:[...await sourceFiles('src/kernel'),...await sourceFiles('src/foundation')]});
  assert.deepEqual(graph.problems,[]);
});

test('claim normalization has a shared value owner and native code only services its late clock',async()=>{
  const file='src/specifications.mjs',text=await readFile(path.join(packageRoot,file),'utf8');
  const ast=ts.createSourceFile(file,text,ts.ScriptTarget.Latest,true);
  const functions=new Map(ast.statements.filter(ts.isFunctionDeclaration).map(node=>[node.name.text,node]));
  for(const name of ['normalizeClaimMap','inspectPlannedClaimMap','derivePlannedClaimMap','deriveObservedClaimMap']) {
    const body=functions.get(name).body.getText(ast);
    assert.equal((body.match(new RegExp(name+'Replay\\(','gu'))??[]).length,1,name);
    assert.doesNotMatch(body,/normalizeSpecPolicy\(|Date|nowIso|byteLength|fulfillment|testDisposition/u);
  }
  const clock=functions.get('nativeSpecificationClaimValue').body.getText(ast);
  assert.equal((clock.match(/nowIso\(/gu)??[]).length,1);
  assert.match(clock,/replay\.throw\(error\)/u,'clock errors return to the exact rule checkpoint');
  assert.doesNotMatch(clock,/normalizeClaimMap|normalizeSpecPolicy|readFile|writeFile|sourcePaths|testDisposition/u);
  for(const name of ['normalizePaths','plannedObligationFields','supportingFilesFromPlan','validatePlannedEvidenceTypes','testOnlyClaimEvidence'])assert.equal(functions.has(name),false,name);
  const kernel=await readFile(path.join(packageRoot,'src/kernel/specification-values.mjs'),'utf8');
  assert.doesNotMatch(kernel,/\b(?:Date|Buffer|nowIso|readFile|spawn|currentSchemaVersion)\b/u);
  const delivery=ts.createSourceFile('delivery',await readFile(path.join(packageRoot,'src/kernel/code-delivery-evidence.mjs'),'utf8'),ts.ScriptTarget.Latest,true);
  let duplicate=false;const names=new Set(['plannedImplementationPaths','plannedProductSourcePaths','plannedSupportingFiles','changesProductSource']);
  const visit=node=>{if(ts.isFunctionDeclaration(node)&&names.has(node.name?.text))duplicate=true;ts.forEachChild(node,visit);};visit(delivery);
  assert.equal(duplicate,false,'delivery must use the same planned path-role rules as claim projection');
});

test('namespace specification reads cannot write evidence or discover a host and retention cannot mutate lifecycle authority',async()=>{
  const reader='src/engine-storage/namespace-specifications.mjs',writer='src/engine-storage/namespace-specification-retention.mjs';
  const allowed=new Map([
    [reader,new Set(['../foundation/failures.mjs','../foundation/record-schema.mjs','../kernel/specification-values.mjs','../kernel/plan-corrections.mjs','../records.mjs','../engine-compatibility/node-configuration-path.mjs',
      '../kernel/specification-publication.mjs','../kernel/specification-policy.mjs','../engine-compatibility/node-specification-policy.mjs','../engine-compatibility/node-source-policy.mjs','../engine-compatibility/node-repository-plan.mjs',
      './namespace-submission-reader.mjs','./namespace-specification-contract.mjs','./namespace-plan-decisions-reader.mjs','./namespace-candidate-content.mjs'])],
    [writer,new Set(['node:crypto','../foundation/record-schema.mjs','../foundation/failures.mjs','../sda/content/contract.mjs','./namespace-specification-contract.mjs'])]
  ]);
  for(const [file,imports] of allowed) {
    const ast=ts.createSourceFile(file,await readFile(path.join(packageRoot,file),'utf8'),ts.ScriptTarget.Latest,true);
    const visit=node=>{
      if(ts.isImportDeclaration(node)||ts.isExportDeclaration(node)&&node.moduleSpecifier)assert.ok(imports.has(node.moduleSpecifier.text),file+': '+node.moduleSpecifier.text);
      if(ts.isIdentifier(node)&&['process','require','eval','Function','transact','writeFile','unlink','nowIso'].includes(node.text))assert.fail(file+' cannot discover or mutate a host');
      if((file===reader||file.endsWith('-decision-reader.mjs')||file.endsWith('-rejection-reader.mjs'))&&ts.isPropertyAccessExpression(node)&&['put','retain','commit','save'].includes(node.name.text))assert.fail('Specification proof is read-only');
      assert.equal(ts.isCallExpression(node)&&node.expression.kind===ts.SyntaxKind.ImportKeyword,false);ts.forEachChild(node,visit);
    };visit(ast);
  }
  const state=await readFile(path.join(packageRoot,'src/state.mjs'),'utf8');
  assert.doesNotMatch(state,/function placeholderTestReason\(/u);assert.match(state,/plannedClaimContractFindings\(derived\.claimMap\.claims,codeSteps\)/u);
  const profiles=ts.createSourceFile('profiles',await readFile(path.join(packageRoot,'src/verification/profiles.mjs'),'utf8'),ts.ScriptTarget.Latest,true);
  assert.ok(profiles.statements.every(ts.isExportDeclaration),'adapter profile compatibility must not own another interpretation');
});

test('the namespace read host only composes explicit ports and has no repository, filesystem, provider or command owner', async () => {
  const allowed = new Set(['node:path', 'node:crypto', '../engine-sdk/index.mjs', '../foundation/failures.mjs',
    '../records.mjs', '../document-identity.mjs', '../kernel/phase-policy.mjs', '../sda/namespace/contract.mjs',
    '../sda/namespace/values.mjs', '../sda/content/contract.mjs', './namespace-read-contract.mjs','./namespace-lifecycle-reader.mjs','./namespace-submission-reader.mjs','./namespace-phase-check-reader.mjs',
    './namespace-routing-choice-reader.mjs','./namespace-story-codec.mjs','./namespace-story-reader.mjs','./namespace-read-session.mjs']);
  const file = 'src/engine-storage/namespace-reader.mjs', text = await readFile(path.join(packageRoot, file), 'utf8');
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const visit = node => {
    if (ts.isImportDeclaration(node)) assert.ok(allowed.has(node.moduleSpecifier.text), node.moduleSpecifier.text);
    assert.equal(ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword
      || ts.isIdentifier(node.expression) && ['require','eval','Function'].includes(node.expression.text)), false);
    if (ts.isIdentifier(node) && node.text === 'process') assert.fail('The read host must not discover ambient machine state.');
    ts.forEachChild(node, visit);
  }; visit(source);
  const identity = await inspectPureModuleGraph({ root: packageRoot, entries: ['src/document-identity.mjs'],
    allowed: ['src/document-identity.mjs', ...await sourceFiles('src/foundation')] });
  assert.deepEqual(identity.problems, []);
});

test('the internal namespace lifecycle committer composes explicit ports without installed authority or host I/O', async () => {
  const owner = 'src/engine-storage/namespace-lifecycle-commit.mjs';
  const allowed = new Set(['node:crypto', '../engine-sdk/index.mjs', '../foundation/failures.mjs',
    '../records.mjs','../foundation/record-schema.mjs',
    '../sda/namespace/contract.mjs', '../sda/namespace/values.mjs', '../sda/namespace/transaction.mjs',
    '../sda/content/contract.mjs', './namespace-lifecycle-contract.mjs','./namespace-lifecycle-reader.mjs','./namespace-lifecycle-codec.mjs']);
  const ast = ts.createSourceFile(owner, await readFile(path.join(packageRoot, owner), 'utf8'), ts.ScriptTarget.Latest, true);
  const visit = node => {
    if (ts.isImportDeclaration(node)) assert.ok(allowed.has(node.moduleSpecifier.text), node.moduleSpecifier.text);
    assert.equal(ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword
      || ts.isIdentifier(node.expression) && ['require','eval','Function'].includes(node.expression.text)), false);
    if (ts.isIdentifier(node) && node.text === 'process') assert.fail('Lifecycle persistence must not discover installed authority.');
    ts.forEachChild(node, visit);
  }; visit(ast);
  const contract = 'src/engine-storage/namespace-lifecycle-contract.mjs';
  const report = await inspectPureModuleGraph({ root: packageRoot, entries: [contract],
    allowed: [contract, ...await sourceFiles('src/foundation'), ...await sourceFiles('src/sda/namespace'), ...await sourceFiles('src/sda/content')] });
  assert.deepEqual(report.problems, []);
  for (const file of await sourceFiles('src')) {
    if ([owner,'src/engine-storage/namespace-source.mjs','src/engine-storage/namespace-publication.mjs','src/engine-storage/namespace-submission.mjs',
      'src/engine-storage/namespace-approval.mjs','src/engine-storage/namespace-recorded-mutation.mjs','src/engine-storage/namespace-human-decision.mjs','src/engine-storage/namespace-conformance-decisions.mjs','src/engine-storage/namespace-rejection.mjs','src/engine-storage/namespace-routing-choice.mjs'].includes(file)) continue;
    const text = await readFile(path.join(packageRoot, file), 'utf8');
    assert.equal(text.includes('namespace-lifecycle-commit.mjs'), false, file + ' must not select the new authority before a verified cutover');
  }
});

test('lifecycle receipt encoding is pure and accepted-evidence inspection cannot import or invoke a writer',async()=>{
  const codec='src/engine-storage/namespace-lifecycle-codec.mjs',reader='src/engine-storage/namespace-lifecycle-receipt-reader.mjs';
  const pure=await inspectPureModuleGraph({root:packageRoot,entries:[codec],allowed:[codec,
    'src/engine-storage/namespace-lifecycle-contract.mjs',...await sourceFiles('src/foundation'),
    ...await sourceFiles('src/sda/namespace'),...await sourceFiles('src/sda/content')]});
  assert.deepEqual(pure.problems,[]);
  const allowed=new Set(['../foundation/failures.mjs','../records.mjs','../sda/namespace/values.mjs','../sda/namespace/contract.mjs',
    './namespace-lifecycle-reader.mjs','./namespace-lifecycle-codec.mjs','./namespace-lifecycle-contract.mjs','./namespace-read-session.mjs','../sda/namespace/read-batch.mjs']);
  const ast=ts.createSourceFile(reader,await readFile(path.join(packageRoot,reader),'utf8'),ts.ScriptTarget.Latest,true);
  const visit=node=>{
    if(ts.isImportDeclaration(node)||ts.isExportDeclaration(node)&&node.moduleSpecifier)assert.ok(allowed.has(node.moduleSpecifier.text),node.moduleSpecifier.text);
    if(ts.isPropertyAccessExpression(node)&&['put','transact','commit','writeFile','unlink','close','run'].includes(node.name.text))assert.fail('Receipt inspection cannot execute or mutate storage');
    if(ts.isIdentifier(node)&&['process','require','eval','Function'].includes(node.text))assert.fail('Receipt inspection cannot discover host authority');
    assert.equal(ts.isCallExpression(node)&&node.expression.kind===ts.SyntaxKind.ImportKeyword,false);ts.forEachChild(node,visit);
  };visit(ast);
});

test('project enrollment owns only explicit namespace ports and cannot select installed Git authority', async () => {
  const owner = 'src/engine-storage/namespace-project.mjs';
  const allowed = new Set(['node:crypto', '../engine-sdk/index.mjs', '../foundation/failures.mjs',
    '../kernel/project-enrollment.mjs', '../sda/namespace/contract.mjs', '../sda/namespace/values.mjs',
    '../sda/namespace/transaction.mjs', '../sda/content/contract.mjs', './namespace-lifecycle-contract.mjs', './namespace-project-contract.mjs']);
  const source = ts.createSourceFile(owner, await readFile(path.join(packageRoot, owner), 'utf8'), ts.ScriptTarget.Latest, true);
  const visit = node => {
    if (ts.isImportDeclaration(node)) assert.ok(allowed.has(node.moduleSpecifier.text), node.moduleSpecifier.text);
    assert.equal(ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword
      || ts.isIdentifier(node.expression) && ['require','eval','Function'].includes(node.expression.text)), false);
    if (ts.isIdentifier(node) && node.text === 'process') assert.fail('Enrollment must not discover installed projects.');
    ts.forEachChild(node, visit);
  }; visit(source);
  const contract = 'src/engine-storage/namespace-project-contract.mjs';
  const report = await inspectPureModuleGraph({ root: packageRoot, entries: [contract],
    allowed: [contract, 'src/engine-storage/namespace-lifecycle-contract.mjs', ...await sourceFiles('src/foundation'),
      ...await sourceFiles('src/sda/namespace'), ...await sourceFiles('src/sda/content')] });
  assert.deepEqual(report.problems, []);
  for (const file of await sourceFiles('src')) {
    if (file === owner || file === 'src/engine-storage/namespace-engine.mjs') continue;
    assert.equal((await readFile(path.join(packageRoot, file), 'utf8')).includes('namespace-project.mjs'), false,
      file + ' must not enroll an installed project implicitly');
  }
});

test('explicit configuration approval cannot discover or select installed authority',async()=>{
  const owner='src/engine-storage/namespace-configuration.mjs';
  const allowed=new Set(['node:crypto','../engine-sdk/index.mjs','../foundation/failures.mjs',
    '../kernel/artifact-content.mjs',
    '../engine-compatibility/node-namespace-configuration.mjs','../kernel/namespace-configuration.mjs','../kernel/project-enrollment.mjs',
    '../sda/namespace/contract.mjs','../sda/namespace/values.mjs','../sda/namespace/transaction.mjs','../sda/content/contract.mjs',
    './namespace-lifecycle-contract.mjs','./namespace-configuration-contract.mjs','./namespace-configuration-codec.mjs','./namespace-configuration-reader.mjs']);
  const ast=ts.createSourceFile(owner,await readFile(path.join(packageRoot,owner),'utf8'),ts.ScriptTarget.Latest,true);
  const visit=node=>{
    if(ts.isImportDeclaration(node))assert.ok(allowed.has(node.moduleSpecifier.text),node.moduleSpecifier.text);
    assert.equal(ts.isCallExpression(node)&&(node.expression.kind===ts.SyntaxKind.ImportKeyword
      ||ts.isIdentifier(node.expression)&&['require','eval','Function'].includes(node.expression.text)),false);
    if(ts.isIdentifier(node)&&node.text==='process')assert.fail('Approval cannot discover ambient workspace, identity or authority.');
    ts.forEachChild(node,visit);
  };visit(ast);
  const contract='src/engine-storage/namespace-configuration-contract.mjs';
  const report=await inspectPureModuleGraph({root:packageRoot,entries:[contract],allowed:[contract,
    ...await sourceFiles('src/foundation'),...await sourceFiles('src/kernel'),...await sourceFiles('src/sda/namespace')]});
  assert.deepEqual(report.problems,[]);
  for(const file of await sourceFiles('src')) {
    if(file===owner||file==='src/engine-storage/namespace-engine.mjs')continue;
    const source=ts.createSourceFile(file,await readFile(path.join(packageRoot,file),'utf8'),ts.ScriptTarget.Latest,true);
    for(const node of source.statements.filter(ts.isImportDeclaration))if(node.moduleSpecifier.text.startsWith('.')) {
      assert.notEqual(path.posix.normalize(path.posix.join(path.posix.dirname(file),node.moduleSpecifier.text)),owner,
        file+' cannot implicitly activate namespace configuration');
    }
  }
});

test('Story genesis composes only explicit storage, access and clock ports; observers cannot write',async()=>{
  const owner='src/engine-storage/namespace-story.mjs';
  const allowed=new Set(['node:crypto','../engine-sdk/index.mjs','../foundation/failures.mjs',
    '../kernel/story-creation.mjs','../kernel/project-enrollment.mjs','../sda/namespace/contract.mjs',
    '../sda/namespace/values.mjs','../sda/namespace/transaction.mjs','../sda/namespace/journal-contract.mjs',
    '../sda/content/contract.mjs','./namespace-configuration-reader.mjs','./namespace-lifecycle-reader.mjs',
    './namespace-lifecycle-contract.mjs','./namespace-story-contract.mjs','./namespace-read-contract.mjs','./namespace-reader.mjs','./namespace-story-codec.mjs','./namespace-constitution-reader.mjs']);
  const ast=ts.createSourceFile(owner,await readFile(path.join(packageRoot,owner),'utf8'),ts.ScriptTarget.Latest,true);
  const visit=node=>{
    if(ts.isImportDeclaration(node))assert.ok(allowed.has(node.moduleSpecifier.text),node.moduleSpecifier.text);
    assert.equal(ts.isCallExpression(node)&&(node.expression.kind===ts.SyntaxKind.ImportKeyword
      ||ts.isIdentifier(node.expression)&&['require','eval','Function'].includes(node.expression.text)),false);
    if(ts.isIdentifier(node)&&node.text==='process')assert.fail('Creation cannot discover installed state or identity.');
    ts.forEachChild(node,visit);
  };visit(ast);
  const contract='src/engine-storage/namespace-story-contract.mjs';
  const report=await inspectPureModuleGraph({root:packageRoot,entries:[contract],allowed:[contract,
    'src/engine-storage/namespace-lifecycle-contract.mjs',...await sourceFiles('src/foundation'),
    ...await sourceFiles('src/kernel'),...await sourceFiles('src/sda/namespace'),...await sourceFiles('src/sda/content')]});
  assert.deepEqual(report.problems,[]);
  for(const file of ['src/engine-storage/namespace-lifecycle-reader.mjs','src/engine-storage/namespace-configuration-reader.mjs','src/engine-storage/namespace-story-reader.mjs']) {
    const text=await readFile(path.join(packageRoot,file),'utf8');
    const source=ts.createSourceFile(file,text,ts.ScriptTarget.Latest,true);
    const readOnly=node=>{
      if(ts.isImportDeclaration(node)&&node.moduleSpecifier.text.startsWith('node:'))assert.equal(node.moduleSpecifier.text,'node:crypto');
      if(ts.isPropertyAccessExpression(node)&&['put','transact','remove','delete','close'].includes(node.name.text))assert.fail(file+' cannot mutate a storage port');
      if(ts.isIdentifier(node)&&['process','eval','Function','require'].includes(node.text))assert.fail(file+' cannot discover a host');
      ts.forEachChild(node,readOnly);
    };readOnly(source);
  }
  for(const file of await sourceFiles('src')) {
    if(file===owner||file==='src/engine-storage/namespace-engine.mjs')continue;
    const source=ts.createSourceFile(file,await readFile(path.join(packageRoot,file),'utf8'),ts.ScriptTarget.Latest,true);
    for(const node of source.statements.filter(ts.isImportDeclaration))if(node.moduleSpecifier.text.startsWith('.'))assert.notEqual(
      path.posix.normalize(path.posix.join(path.posix.dirname(file),node.moduleSpecifier.text)),owner,
      file+' cannot silently select a namespace Story creator');
  }
});

test('namespace policy proof is read-only, versioned, and independent of Story creation and low-level storage admission',async()=>{
  const codec='src/engine-storage/namespace-story-codec.mjs',reader='src/engine-storage/namespace-story-reader.mjs';
  const imports=new Map([
    [codec,new Set(['node:crypto','../foundation/failures.mjs','../records.mjs','../sda/namespace/values.mjs',
      '../sda/namespace/transaction.mjs','../sda/namespace/journal-contract.mjs','./namespace-lifecycle-contract.mjs',
      './namespace-lifecycle-reader.mjs','./namespace-story-contract.mjs','./namespace-read-contract.mjs'])],
    [reader,new Set(['node:crypto','../foundation/failures.mjs','../kernel/story-policy.mjs','../sda/namespace/contract.mjs','../sda/content/contract.mjs',
      '../sda/namespace/values.mjs','./namespace-lifecycle-reader.mjs','./namespace-configuration-reader.mjs',
      './namespace-story-codec.mjs','./namespace-story-contract.mjs','./namespace-lifecycle-contract.mjs','./namespace-lifecycle-receipt-reader.mjs','./namespace-read-session.mjs'])]
  ]);
  for(const [file,allowed] of imports) {
    const text=await readFile(path.join(packageRoot,file),'utf8'),ast=ts.createSourceFile(file,text,ts.ScriptTarget.Latest,true);
    const visit=node=>{
      if(ts.isImportDeclaration(node)||ts.isExportDeclaration(node)&&node.moduleSpecifier)assert.ok(allowed.has(node.moduleSpecifier.text),file+': '+node.moduleSpecifier.text);
      if(ts.isPropertyAccessExpression(node)&&['put','transact','remove','delete','close','run'].includes(node.name.text))assert.fail(file+' cannot execute or mutate');
      if(ts.isIdentifier(node)&&['process','eval','Function','require','initialNamespaceStory'].includes(node.text))assert.fail(file+' cannot discover a host or rebuild old genesis');
      assert.equal(ts.isCallExpression(node)&&node.expression.kind===ts.SyntaxKind.ImportKeyword,false);
      ts.forEachChild(node,visit);
    };visit(ast);
  }
  const rule='src/kernel/story-policy.mjs',pure=await inspectPureModuleGraph({root:packageRoot,entries:[rule],allowed:[rule,...await sourceFiles('src/foundation')]});
  assert.deepEqual(pure.problems,[]);
  const owners=new Set([reader,'src/engine-storage/namespace-test-cohorts.mjs','src/engine-storage/namespace-witness-renewals.mjs','src/engine-storage/namespace-obligation-risks.mjs','src/engine-storage/namespace-test-risks.mjs','src/engine-storage/namespace-evidence-reuse.mjs','src/engine-storage/namespace-evidence.mjs','src/engine-storage/namespace-test-repair.mjs','src/engine-storage/namespace-test-recovery.mjs','src/engine-storage/namespace-decision-list.mjs','src/engine-storage/namespace-decision-batch.mjs','src/engine-storage/namespace-convergence-advancement.mjs','src/engine-storage/namespace-convergence.mjs','src/engine-storage/namespace-test-commands.mjs','src/engine-storage/namespace-output-retention-reader.mjs','src/engine-storage/namespace-constitution-exceptions.mjs','src/engine-storage/namespace-code-predecessors.mjs','src/engine-storage/namespace-source-review.mjs','src/engine-storage/namespace-source-review-reader.mjs','src/engine-storage/namespace-assignment.mjs','src/engine-storage/namespace-witness-reader.mjs','src/engine-storage/namespace-witness-decisions.mjs','src/engine-storage/namespace-workflow-assets.mjs','src/engine-storage/namespace-phase-inspection.mjs','src/engine-storage/namespace-story-queries.mjs','src/engine-storage/namespace-plan-decisions.mjs','src/engine-storage/namespace-recorded-mutation.mjs','src/engine-storage/namespace-scope-decisions.mjs','src/engine-storage/namespace-upstream.mjs','src/engine-storage/namespace-upstream-reader.mjs','src/engine-storage/namespace-input-documents.mjs','src/engine-storage/namespace-code-policy.mjs','src/engine-storage/namespace-code-preflight.mjs','src/engine-storage/namespace-phase-entry.mjs','src/engine-storage/namespace-clarifications.mjs','src/engine-storage/namespace-reader.mjs','src/engine-storage/namespace-source.mjs','src/engine-storage/namespace-source-baseline-reader.mjs','src/engine-storage/namespace-delivery-inspection.mjs','src/engine-storage/namespace-test-witnesses.mjs',
    'src/engine-storage/namespace-preparation.mjs','src/engine-storage/namespace-publication.mjs','src/engine-storage/namespace-source-inspection.mjs','src/engine-storage/namespace-source-retention-reader.mjs','src/engine-storage/namespace-phase-checks.mjs','src/engine-storage/namespace-phase-check-reader.mjs',
    'src/engine-storage/namespace-submission.mjs','src/engine-storage/namespace-approval.mjs','src/engine-storage/namespace-recorded-mutation.mjs','src/engine-storage/namespace-human-decision.mjs','src/engine-storage/namespace-conformance-decisions.mjs','src/engine-storage/namespace-rejection.mjs','src/engine-storage/namespace-routing-choice.mjs']);
  for(const file of await sourceFiles('src')) {
    if(owners.has(file))continue;
    const text=await readFile(path.join(packageRoot,file),'utf8');
    if(['src/engine-storage/namespace-test-cohort-reader.mjs','src/engine-storage/namespace-obligation-risk-reader.mjs','src/engine-storage/namespace-test-risk-reader.mjs','src/engine-storage/namespace-evidence-reuse-reader.mjs','src/engine-storage/namespace-test-recovery-reader.mjs','src/engine-storage/namespace-forward-reader.mjs','src/engine-storage/namespace-plan-decisions-reader.mjs','src/engine-storage/namespace-rejection-reader.mjs',
      'src/engine-storage/namespace-repair-budget-reader.mjs'].includes(file)){
      const ast=ts.createSourceFile(file,text,ts.ScriptTarget.Latest,true),selected=ast.statements.filter(node=>ts.isImportDeclaration(node)&&node.moduleSpecifier.text==='./namespace-story-reader.mjs');
      assert.equal(selected.length,1);assert.equal(selected[0].importClause?.name,undefined);
      const names=selected[0].importClause?.namedBindings;assert.ok(names&&ts.isNamedImports(names));
      assert.deepEqual(names.elements.map(node=>[node.propertyName?.text??node.name.text,node.name.text]),file.endsWith('namespace-forward-reader.mjs')?[['namespaceLocalInputBytes','namespaceLocalInputBytes'],['memoNamespaceObservedDecision','memoNamespaceObservedDecision']]:[['memoNamespaceObservedDecision','memoNamespaceObservedDecision']],
        file+': decision proofs may reuse only the genuine observer memo; constructing Story admission is still forbidden');continue;
    }
    assert.equal(text.includes('namespace-story-reader.mjs'),false,
      file+' cannot implicitly activate new-project business admission');
  }
});

test('namespace acceptance coordination delegates only to the bound conditional committer',async()=>{
  const owner='src/engine-storage/namespace-commit-coordination.mjs';
  const pure=await inspectPureModuleGraph({root:packageRoot,entries:[owner],allowed:[owner]});assert.deepEqual(pure.problems,[]);
  const writers=new Set([owner,'src/engine-storage/namespace-publication.mjs','src/engine-storage/namespace-submission.mjs',
    'src/engine-storage/namespace-approval.mjs','src/engine-storage/namespace-recorded-mutation.mjs','src/engine-storage/namespace-human-decision.mjs','src/engine-storage/namespace-conformance-decisions.mjs','src/engine-storage/namespace-rejection.mjs','src/engine-storage/namespace-routing-choice.mjs','src/engine-storage/namespace-source.mjs']);
  for(const file of await sourceFiles('src')) {
    if(writers.has(file))continue;
    assert.equal((await readFile(path.join(packageRoot,file),'utf8')).includes('namespace-commit-coordination.mjs'),false,
      file+' cannot implicitly coordinate a namespace write');
  }
});

test('source binding separates source I/O, pure rules and namespace persistence',async()=>{
  const sourceOwner='src/sgos/filesystem-source-unit.mjs',namespaceOwner='src/engine-storage/namespace-source.mjs';
  const permitted=new Map([
    [sourceOwner,new Set(['node:fs','node:fs/promises','node:crypto','node:path','../foundation/failures.mjs','../foundation/record-schema.mjs','../foundation/source-snapshot.mjs'])],
    [namespaceOwner,new Set(['node:crypto','../engine-sdk/index.mjs','../foundation/failures.mjs','../foundation/record-schema.mjs',
      '../foundation/source-snapshot.mjs','../kernel/source-binding.mjs','../kernel/project-enrollment.mjs','../sda/namespace/values.mjs',
      '../sda/content/contract.mjs','./namespace-lifecycle-commit.mjs','./namespace-commit-coordination.mjs','./namespace-lifecycle-reader.mjs','./namespace-story-reader.mjs','./namespace-lifecycle-contract.mjs','./namespace-reader.mjs','./namespace-repository-plan.mjs'])]
  ]);
  for(const [owner,allowed] of permitted) {
    const ast=ts.createSourceFile(owner,await readFile(path.join(packageRoot,owner),'utf8'),ts.ScriptTarget.Latest,true);
    const visit=node=>{
      if(ts.isImportDeclaration(node))assert.ok(allowed.has(node.moduleSpecifier.text),node.moduleSpecifier.text);
      if(ts.isIdentifier(node)&&['process','require','eval','Function'].includes(node.text))assert.fail(owner+' cannot discover a checkout or installed authority');
      assert.equal(ts.isCallExpression(node)&&node.expression.kind===ts.SyntaxKind.ImportKeyword,false);
      if(owner===sourceOwner&&ts.isPropertyAccessExpression(node)&&['writeFile','mkdir','unlink','rm','rename','chmod','transact'].includes(node.name.text))assert.fail('Source capture is read-only');
      ts.forEachChild(node,visit);
    };visit(ast);
  }
  for(const file of await sourceFiles('src')) {
    if(file===namespaceOwner||file==='src/engine-storage/namespace-engine.mjs')continue;
    const ast=ts.createSourceFile(file,await readFile(path.join(packageRoot,file),'utf8'),ts.ScriptTarget.Latest,true);
    for(const node of ast.statements.filter(ts.isImportDeclaration))if(node.moduleSpecifier.text.startsWith('.')) {
      assert.notEqual(path.posix.normalize(path.posix.join(path.posix.dirname(file),node.moduleSpecifier.text)),namespaceOwner,
        file+' cannot implicitly bind installed source context');
    }
  }
});

test('the opt-in Git source reader uses fixed local reads and the shared pinned process owner',async()=>{
  const owner='src/sgos/node-git-source-control-reader.mjs',allowed=new Set(['node:crypto','node:os','node:path',
    '../foundation/failures.mjs','../foundation/record-schema.mjs','../foundation/source-snapshot.mjs','../foundation/source-control.mjs',
    '../engine-compatibility/node-source-policy.mjs','../git-status-detail.mjs','./filesystem-source-unit.mjs','./node-execution-unit.mjs']);
  const text=await readFile(path.join(packageRoot,owner),'utf8'),ast=ts.createSourceFile(owner,text,ts.ScriptTarget.Latest,true);
  const visit=node=>{
    if(ts.isImportDeclaration(node)||ts.isExportDeclaration(node)&&node.moduleSpecifier)assert.ok(allowed.has(node.moduleSpecifier.text),node.moduleSpecifier.text);
    assert.equal(ts.isCallExpression(node)&&node.expression.kind===ts.SyntaxKind.ImportKeyword,false);
    if(ts.isIdentifier(node)&&['process','require','eval','Function','spawn','spawnSync','loadDefinition','repoRoot','transactStory'].includes(node.text))assert.fail(owner+' must use explicit capabilities');
    if(ts.isPropertyAccessExpression(node)&&['put','transact','writeFile','mkdir','unlink','rm','rename','chmod','publish'].includes(node.name.text))assert.fail('Source-control observation is read-only');
    ts.forEachChild(node,visit);
  };visit(ast);assert.match(text,/await executePinnedProcess/u);assert.match(text,/await bindFilesystemSource/u);
  const protocol='src/git-status-detail.mjs',pure=await inspectPureModuleGraph({root:packageRoot,entries:[protocol],allowed:[protocol,...await sourceFiles('src/foundation')]});
  assert.deepEqual(pure.problems,[],'Git wire decoding has no process, filesystem, kernel or installed configuration dependency');
});

test('private preparation composes explicit storage and source ports without an installed authority or ambient host',async()=>{
  const owner='src/engine-storage/namespace-preparation.mjs',draft='src/engine-storage/namespace-draft-store.mjs';
  const permitted=new Map([
    [owner,new Set(['./namespace-test-recovery-reader.mjs','../kernel/namespace-artifact-sets.mjs','../engine-compatibility/node-configuration-path.mjs','../records.mjs','node:crypto','../engine-sdk/index.mjs','../foundation/failures.mjs','../foundation/record-schema.mjs',
      '../foundation/source-snapshot.mjs','../kernel/artifact-content.mjs','../kernel/phase-preparation.mjs','../kernel/phase-admission.mjs',
      '../kernel/phase-policy.mjs','../kernel/phase-inputs.mjs','../kernel/lifecycle-transitions.mjs','../kernel/project-enrollment.mjs',
      '../kernel/story-creation.mjs','../sda/namespace/values.mjs','../sda/namespace/contract.mjs','../sda/content/contract.mjs',
      './namespace-draft-store.mjs','./namespace-lifecycle-reader.mjs','./namespace-configuration-reader.mjs','./namespace-story-reader.mjs','./namespace-read-session.mjs','./namespace-submission-reader.mjs','./namespace-reader.mjs','./namespace-phase-check-reader.mjs','./namespace-phase-resources.mjs','./namespace-repository-plan.mjs','./namespace-code-history.mjs','./namespace-code-predecessors.mjs','./namespace-local-content-reader.mjs','./namespace-generation-reader.mjs','./namespace-convergence-decisions-reader.mjs','./namespace-artifact-repair-reader.mjs'])],
    [draft,new Set(['node:crypto','../foundation/failures.mjs','../foundation/record-schema.mjs','../sda/namespace/contract.mjs',
      '../sda/namespace/values.mjs','../sda/namespace/transaction.mjs','../sda/namespace/journal-contract.mjs',
      '../sda/content/contract.mjs','./namespace-draft-contract.mjs'])]
  ]);
  for(const [file,allowed] of permitted) {
    const ast=ts.createSourceFile(file,await readFile(path.join(packageRoot,file),'utf8'),ts.ScriptTarget.Latest,true);
    const visit=node=>{
      if(ts.isImportDeclaration(node))assert.ok(allowed.has(node.moduleSpecifier.text),file+': '+node.moduleSpecifier.text);
      if(ts.isIdentifier(node)&&['process','require','eval','Function'].includes(node.text))assert.fail(file+' cannot discover installed state or execute host code');
      assert.equal(ts.isCallExpression(node)&&node.expression.kind===ts.SyntaxKind.ImportKeyword,false);
      ts.forEachChild(node,visit);
    };visit(ast);
  }
  const contract='src/engine-storage/namespace-draft-contract.mjs';
  const report=await inspectPureModuleGraph({root:packageRoot,entries:[contract],allowed:[contract,...await sourceFiles('src/foundation'),
    ...await sourceFiles('src/sda/namespace'),...await sourceFiles('src/sda/content')]});
  assert.deepEqual(report.problems,[]);
  for(const file of await sourceFiles('src')) {
    if(file===owner||file==='src/engine-storage/namespace-engine.mjs')continue;
    const ast=ts.createSourceFile(file,await readFile(path.join(packageRoot,file),'utf8'),ts.ScriptTarget.Latest,true);
    for(const node of ast.statements.filter(ts.isImportDeclaration))if(node.moduleSpecifier.text.startsWith('.')) {
      const target=path.posix.normalize(path.posix.join(path.posix.dirname(file),node.moduleSpecifier.text));
      if(!['src/engine-storage/namespace-publication.mjs','src/engine-storage/namespace-phase-checks.mjs','src/engine-storage/namespace-engine.mjs','src/engine-storage/namespace-source-inspection.mjs','src/engine-storage/namespace-source-retention.mjs','src/engine-storage/namespace-delivery-inspection.mjs','src/engine-storage/namespace-test-witnesses.mjs','src/engine-storage/namespace-source-control.mjs'].includes(file))assert.notEqual(target,owner,file+' cannot implicitly replace installed preparation');
      assert.notEqual(target,draft,file+' cannot save private phase drafts outside their explicit composition');
    }
  }
});

test('source inspection has no filesystem, process, lifecycle writer or draft-write call',async()=>{
  const file='src/engine-storage/namespace-source-inspection.mjs';
  const allowed=new Set(['node:crypto','../engine-sdk/index.mjs','../foundation/failures.mjs','../foundation/record-schema.mjs',
    '../kernel/source-changes.mjs','../kernel/phase-policy.mjs',
    '../engine-compatibility/node-source-policy.mjs','../sda/namespace/values.mjs','./namespace-story-reader.mjs','./namespace-preparation.mjs','./namespace-source-observations.mjs']);
  const ast=ts.createSourceFile(file,await readFile(path.join(packageRoot,file),'utf8'),ts.ScriptTarget.Latest,true);
  const visit=node=>{
    if(ts.isImportDeclaration(node))assert.ok(allowed.has(node.moduleSpecifier.text),node.moduleSpecifier.text);
    if(ts.isCallExpression(node)&&node.expression.kind===ts.SyntaxKind.ImportKeyword)assert.fail(file+' cannot discover host implementations');
    if(ts.isPropertyAccessExpression(node)&&['put','save','transact','spawn','start','requestStop','writeFile','admitDraft'].includes(node.name.text))assert.fail(file+' cannot execute or mutate');
    ts.forEachChild(node,visit);
  };visit(ast);
});

test('native analysis caches delegate to shared rules and the Node binding cannot acquire I/O',async()=>{
  const entries=['src/kernel/javascript-declarations.mjs','src/kernel/source-comments.mjs'];
  const graph=await inspectPureModuleGraph({root:packageRoot,entries,allowed:[...await sourceFiles('src/foundation'),...await sourceFiles('src/kernel')]});
  assert.deepEqual(graph.problems,[]);
  const owner='src/engine-compatibility/node-source-analysis.mjs',allowed=new Set(['../records.mjs','./node-configuration-path.mjs',
    '../kernel/javascript-declarations.mjs','../kernel/source-comments.mjs','../kernel/code-documentation.mjs','../kernel/polyglot-lexical.mjs','../kernel/code-delivery-evidence.mjs']);
  const ast=ts.createSourceFile(owner,await readFile(path.join(packageRoot,owner),'utf8'),ts.ScriptTarget.Latest,true);
  const visit=node=>{
    if((ts.isImportDeclaration(node)||ts.isExportDeclaration(node))&&node.moduleSpecifier)assert.ok(allowed.has(node.moduleSpecifier.text),node.moduleSpecifier.text);
    if(ts.isCallExpression(node)&&node.expression.kind===ts.SyntaxKind.ImportKeyword)assert.fail('Source values cannot acquire infrastructure.');
    if(ts.isIdentifier(node)&&['process','require','eval','Function','fetch'].includes(node.text))assert.fail('Source values cannot acquire a host.');
    ts.forEachChild(node,visit);
  };visit(ast);
  for(const file of ['src/verification/tags.mjs','src/javascript-source-comments.mjs']) {
    const text=await readFile(path.join(packageRoot,file),'utf8');assert.doesNotMatch(text,/\b(?:function|class|const)\b/u,file+' is a compatibility reexport only');
  }
  const source=await readFile(path.join(packageRoot,'src/source-clause-tags.mjs'),'utf8'),declarations=await readFile(path.join(packageRoot,'src/verification/javascript-declarations.mjs'),'utf8');
  assert.match(source,/kernel\/source-comments\.mjs/u);assert.match(declarations,/engine-compatibility\/node-source-analysis\.mjs/u);
  assert.doesNotMatch(source+declarations,/\b(?:readFile|spawn|fetch)\s*\(/u);
  assert.doesNotMatch(source+declarations,/function\s+(?:tokenizeJavaScript|analyzeJavaScriptDeclarations)\s*\(/u);
  const identity=await readFile(path.join(packageRoot,'src/build-identity.mjs'),'utf8'),manifest=await readFile(path.join(packageRoot,'src/vsix-source-manifest.mjs'),'utf8');
  for(const file of ['kernel/javascript-declarations.mjs','kernel/source-comments.mjs','engine-compatibility/node-source-analysis.mjs']){
    assert.ok(identity.includes("'"+file+"'"),file+' must affect the native build identity');
    assert.ok(manifest.includes("'src/"+file+"'"),file+' must be required in the staged CLI payload');
  }
});

test('implementation regions and reviewer choices have pure owners while the native adapter only reads requested facts',async()=>{
  const rules=['src/kernel/code-documentation.mjs','src/kernel/polyglot-lexical.mjs','src/kernel/code-delivery-evidence.mjs'],
    graph=await inspectPureModuleGraph({root:packageRoot,entries:rules,allowed:[...await sourceFiles('src/foundation'),...await sourceFiles('src/kernel')]});
  assert.deepEqual(graph.problems,[]);
  const owner='src/implementation-bindings.mjs',allowed=new Set(['node:fs/promises','node:path','./comprehension/diff-preview.mjs','./foundation/failures.mjs',
    './engine-compatibility/node-source-analysis.mjs','./kernel/code-delivery-evidence.mjs','./engine-compatibility/node-source-policy.mjs']);
  const ast=ts.createSourceFile(owner,await readFile(path.join(packageRoot,owner),'utf8'),ts.ScriptTarget.Latest,true);
  const visit=node=>{
    if((ts.isImportDeclaration(node)||ts.isExportDeclaration(node))&&node.moduleSpecifier)assert.ok(allowed.has(node.moduleSpecifier.text),node.moduleSpecifier.text);
    if(ts.isCallExpression(node)&&node.expression.kind===ts.SyntaxKind.ImportKeyword)assert.fail('A binding read cannot discover another owner.');
    if(ts.isCallExpression(node)&&['publicDeclarations','changedDeclarations','clauseTagExplanation','reviewBindings'].includes(node.expression.getText(ast)))assert.fail('The native adapter cannot implement binding or review rules.');
    if(ts.isPropertyAccessExpression(node)&&['spawn','transact','put','commit','writeFile'].includes(node.name.text))assert.fail('Binding observations cannot mutate or execute.');
    ts.forEachChild(node,visit);
  };visit(ast);
  const approval=await readFile(path.join(packageRoot,'src/engine-compatibility/approval-transition.mjs'),'utf8');
  assert.match(approval,/import \{ reviewBindings \} from '\.\.\/kernel\/code-delivery-evidence\.mjs'/u);
  const identity=await readFile(path.join(packageRoot,'src/build-identity.mjs'),'utf8'),manifest=await readFile(path.join(packageRoot,'src/vsix-source-manifest.mjs'),'utf8');
  for(const file of ['kernel/code-documentation.mjs','kernel/polyglot-lexical.mjs']){
    assert.ok(identity.includes("'"+file+"'"));assert.ok(manifest.includes("'src/"+file+"'"));
  }
  for(const file of await sourceFiles('src')){
    if(['src/code-documentation.mjs','src/polyglot-lexical.mjs'].includes(file))continue;
    const text=await readFile(path.join(packageRoot,file),'utf8');
    if(!/code-documentation\.mjs|polyglot-lexical\.mjs/u.test(text))continue;
    const imports=ts.createSourceFile(file,text,ts.ScriptTarget.Latest,true).statements.filter(ts.isImportDeclaration);
    for(const node of imports)if(node.moduleSpecifier.text.startsWith('.')){
      const target=path.posix.normalize(path.posix.join(path.posix.dirname(file),node.moduleSpecifier.text));
      assert.equal(['src/code-documentation.mjs','src/polyglot-lexical.mjs'].includes(target),false,file+' must use the intended lexical owner');
    }
  }
});

test('retained source proof and shared observations cannot execute or write',async()=>{
  const allowedByFile=new Map([
    ['src/engine-storage/namespace-output-retention-reader.mjs',new Set(['node:crypto','../foundation/failures.mjs','../foundation/record-schema.mjs','../records.mjs',
      '../kernel/phase-outputs.mjs','../kernel/source-changes.mjs','../kernel/phase-admission.mjs','../kernel/story-creation.mjs','../kernel/project-enrollment.mjs',
      '../sda/namespace/values.mjs','../sda/namespace/contract.mjs','../sda/content/contract.mjs','./namespace-story-reader.mjs','./namespace-lifecycle-codec.mjs',
      './namespace-source-retention-reader.mjs','./namespace-source-retention-contract.mjs','./namespace-output-retention-contract.mjs'])],
    ['src/engine-storage/namespace-constitution-exception-reader.mjs',new Set(['../foundation/failures.mjs','../foundation/record-schema.mjs','../records.mjs',
      '../kernel/approval-policy.mjs','../kernel/phase-policy.mjs','../kernel/namespace-constitution-exceptions.mjs','./namespace-submission-reader.mjs','./namespace-phase-check-reader.mjs',
      './namespace-recorded-mutation-reader.mjs','./namespace-decision-contract.mjs'])],
    ['src/engine-storage/namespace-generation-reader.mjs',new Set(['node:crypto','../foundation/failures.mjs','../foundation/record-schema.mjs',
      '../sda/namespace/values.mjs','../sda/content/contract.mjs','./namespace-draft-contract.mjs','./namespace-lifecycle-reader.mjs','./namespace-lifecycle-codec.mjs','./namespace-code-predecessors.mjs','../records.mjs'])],
    ['src/engine-storage/namespace-code-predecessors.mjs',new Set(['../foundation/failures.mjs','../foundation/record-schema.mjs','../kernel/phase-policy.mjs',
      '../kernel/source-changes.mjs','../engine-compatibility/node-source-policy.mjs','./namespace-submission-reader.mjs','./namespace-phase-check-reader.mjs',
      './namespace-source-retention-reader.mjs','./namespace-specifications.mjs','../records.mjs','./namespace-story-reader.mjs','../engine-compatibility/node-repository-plan.mjs'])],
    ['src/engine-storage/namespace-plan-decisions-reader.mjs',new Set(['node:crypto','../foundation/failures.mjs','../foundation/record-schema.mjs','../foundation/source-snapshot.mjs',
      '../kernel/decision-plan.mjs','../kernel/approval-policy.mjs','../kernel/phase-policy.mjs','../kernel/specification-policy.mjs','../kernel/plan-corrections.mjs','../kernel/verification-policy.mjs',
      '../engine-compatibility/node-configuration-path.mjs','../records.mjs','../engine-compatibility/node-specification-policy.mjs','../engine-compatibility/node-plan-policy.mjs',
      '../engine-compatibility/node-repository-plan.mjs','./namespace-specifications.mjs','./namespace-phase-check-reader.mjs','./namespace-source-observations.mjs',
      './namespace-recorded-mutation-reader.mjs','./namespace-decision-contract.mjs','./namespace-story-reader.mjs'])],
    ['src/engine-storage/namespace-code-initial-history.mjs',new Set(['./namespace-forward-reader.mjs','../foundation/failures.mjs','../foundation/record-schema.mjs','../kernel/approval-policy.mjs',
      '../kernel/routed-approval.mjs','../kernel/lifecycle-transitions.mjs','./namespace-submission-reader.mjs','./namespace-approval-reader.mjs','./namespace-phase-check-reader.mjs',
      './namespace-rejection-reader.mjs','./namespace-routing-receipt-reader.mjs','./namespace-human-decision-contract.mjs','./namespace-routing-choice-contract.mjs','./namespace-approval-contract.mjs','./namespace-upstream-return-reader.mjs'])],
    ['src/engine-storage/namespace-upstream-return-reader.mjs',new Set(['../foundation/record-schema.mjs','../foundation/failures.mjs',
      '../kernel/upstream-issues.mjs','./namespace-decision-contract.mjs','./namespace-upstream-reader.mjs'])],
    ['src/engine-storage/namespace-upstream-reader.mjs',new Set(['./namespace-test-recovery-reader.mjs','node:crypto','../foundation/failures.mjs','../foundation/record-schema.mjs',
      '../kernel/decision-plan.mjs','../kernel/upstream-issues.mjs','../kernel/approval-policy.mjs','./namespace-phase-check-reader.mjs',
      './namespace-publication-reader.mjs','./namespace-recorded-mutation-reader.mjs','./namespace-decision-contract.mjs','./namespace-upstream-artifact-reader.mjs','./namespace-plan-decisions-reader.mjs','./namespace-forward-reader.mjs','./namespace-repair-budget-reader.mjs','./namespace-story-reader.mjs','../kernel/project-enrollment.mjs'])],
    ['src/engine-storage/namespace-upstream-artifact-reader.mjs',new Set(['node:crypto','../foundation/failures.mjs','../foundation/record-schema.mjs',
      '../kernel/phase-policy.mjs','../kernel/phase-upstream-discrepancies.mjs','../kernel/upstream-issues.mjs','../records.mjs'])],
    ['src/engine-storage/namespace-conformance.mjs',new Set(['./namespace-obligation-risk-reader.mjs','node:crypto','../foundation/failures.mjs','../foundation/record-schema.mjs','../sda/namespace/values.mjs',
      '../engine-compatibility/node-specification-policy.mjs','./namespace-upstream-reader.mjs','../kernel/conformance-report.mjs','../kernel/specification-publication.mjs','./namespace-code-inputs.mjs','./namespace-submission-reader.mjs',
      './namespace-phase-check-reader.mjs','./namespace-specification-contract.mjs','./namespace-policy-contract.mjs','./namespace-conformance-decision-reader.mjs','./namespace-candidate-content.mjs'])],
    ['src/engine-storage/namespace-code-history.mjs',new Set(['../kernel/code-delivery-evidence.mjs','../foundation/failures.mjs','../foundation/record-schema.mjs',
      '../kernel/conformance-decisions.mjs','./namespace-targeted-repair-reader.mjs','../engine-compatibility/node-source-policy.mjs','./namespace-publication-reader.mjs',
      './namespace-phase-check-reader.mjs','./namespace-source-retention-reader.mjs','./namespace-human-decision-contract.mjs','./namespace-rejection-reader.mjs','./namespace-code-return-reader.mjs','./namespace-code-initial-history.mjs'])],
    ['src/engine-storage/namespace-code-inputs.mjs',new Set(['node:crypto','../foundation/failures.mjs','../foundation/record-schema.mjs','../foundation/source-snapshot.mjs',
      '../sda/namespace/values.mjs','../kernel/publication-intent.mjs','../kernel/phase-inputs.mjs','../kernel/test-report-codec.mjs','../engine-compatibility/node-source-policy.mjs',
      './namespace-submission-reader.mjs','./namespace-source-retention-reader.mjs','./namespace-phase-check-reader.mjs','./namespace-policy-contract.mjs','./namespace-specification-contract.mjs'])],
    ['src/engine-storage/namespace-check-witnesses.mjs',new Set(['../verification/test-report-reader.mjs'])],
    ['src/engine-storage/namespace-code-policy.mjs',new Set(['./namespace-test-risk-reader.mjs','../kernel/test-recovery.mjs','node:crypto','../foundation/failures.mjs','../foundation/record-schema.mjs','../foundation/source-snapshot.mjs',
      '../sda/namespace/values.mjs','../sda/content/contract.mjs','../kernel/publication-intent.mjs','../kernel/specification-policy.mjs','../kernel/specification-values.mjs',
      '../kernel/verification-witnesses.mjs','../kernel/verification-policy.mjs','../engine-compatibility/node-source-policy.mjs','../engine-compatibility/node-specification-policy.mjs',
      '../engine-compatibility/node-repository-plan.mjs','./namespace-code-preflight.mjs','./namespace-source-retention-reader.mjs','./namespace-source-baseline-reader.mjs','./namespace-source-retention-contract.mjs',
      './namespace-source-control-reader.mjs','./namespace-phase-check-reader.mjs','./namespace-story-reader.mjs','./namespace-specifications.mjs','./namespace-check-witnesses.mjs','./namespace-policy-contract.mjs','./namespace-specification-contract.mjs','./namespace-output-retention-reader.mjs'])],
    ['src/engine-storage/namespace-code-preflight.mjs',new Set(['./namespace-test-recovery-reader.mjs','./namespace-test-command-reader.mjs','node:crypto','../foundation/failures.mjs','../foundation/record-schema.mjs','../kernel/specification-policy.mjs','../kernel/repository-plan.mjs','../kernel/specification-values.mjs','../kernel/phase-policy.mjs',
      '../engine-compatibility/node-source-policy.mjs','../engine-compatibility/node-specification-policy.mjs','../engine-compatibility/node-source-analysis.mjs','../engine-compatibility/node-repository-plan.mjs',
      './namespace-code-source.mjs','./namespace-code-history.mjs','./namespace-code-initial-history.mjs','./namespace-code-predecessors.mjs','./namespace-story-reader.mjs','./namespace-specifications.mjs','./namespace-source-retention-reader.mjs','./namespace-source-baseline-reader.mjs','./namespace-source-clauses.mjs','./namespace-phase-check-reader.mjs','./namespace-source-control-reader.mjs','./namespace-output-retention-reader.mjs'])],
    ['src/engine-storage/namespace-code-source.mjs',new Set(['../foundation/record-schema.mjs','../foundation/failures.mjs','../foundation/source-snapshot.mjs','../kernel/code-delivery-evidence.mjs','./namespace-source-patches.mjs','./namespace-source-content-reader.mjs'])],
    ['src/engine-storage/namespace-source-patches.mjs',new Set(['../foundation/record-schema.mjs','../foundation/failures.mjs','../foundation/source-snapshot.mjs','../kernel/source-text-diff.mjs','./namespace-source-content-reader.mjs'])],
    ['src/engine-storage/namespace-implementation-regions.mjs',new Set(['../foundation/failures.mjs','../foundation/record-schema.mjs','../engine-compatibility/node-source-analysis.mjs','./namespace-source-content-reader.mjs','./namespace-source-patches.mjs'])],
    ['src/engine-storage/namespace-test-witnesses.mjs',new Set(['./namespace-test-risk-reader.mjs','./namespace-test-command-reader.mjs','../engine-sdk/index.mjs','../foundation/failures.mjs','../foundation/record-schema.mjs',
      '../kernel/phase-policy.mjs','../kernel/specification-policy.mjs','../kernel/publication-intent.mjs','../kernel/verification-witnesses.mjs','../kernel/verification-policy.mjs',
      '../engine-compatibility/node-source-policy.mjs','../engine-compatibility/node-specification-policy.mjs','../engine-compatibility/node-repository-plan.mjs','../engine-compatibility/node-source-analysis.mjs',
      './namespace-check-witnesses.mjs','../sda/namespace/values.mjs','./namespace-story-reader.mjs','./namespace-preparation.mjs','./namespace-specifications.mjs',
      './namespace-source-observations.mjs','./namespace-source-baseline-reader.mjs','./namespace-source-retention-reader.mjs','./namespace-source-control-reader.mjs','./namespace-phase-check-reader.mjs','./namespace-source-content-reader.mjs'])],
    ['src/engine-storage/namespace-repository-plan.mjs',new Set(['../foundation/failures.mjs','../kernel/phase-policy.mjs','../engine-compatibility/node-repository-plan.mjs',
      './namespace-specifications.mjs','./namespace-publication-contract.mjs','./namespace-phase-check-reader.mjs','./namespace-specification-contract.mjs'])],
    ['src/engine-storage/namespace-source-origins.mjs',new Set(['../foundation/record-schema.mjs','../foundation/failures.mjs','../sda/namespace/values.mjs',
      '../engine-compatibility/node-source-policy.mjs','../engine-compatibility/node-source-analysis.mjs','./namespace-source-baseline-reader.mjs','./namespace-source-content-reader.mjs'])],
    ['src/engine-storage/namespace-source-control-reader.mjs',new Set(['node:crypto','../foundation/failures.mjs','../foundation/record-schema.mjs','../foundation/source-control.mjs',
      '../kernel/story-creation.mjs','../kernel/phase-admission.mjs','../kernel/project-enrollment.mjs','../engine-compatibility/node-source-policy.mjs',
      '../records.mjs','../sda/namespace/values.mjs','../sda/namespace/contract.mjs','../sda/content/contract.mjs',
      './namespace-source-retention-reader.mjs','./namespace-source-retention-contract.mjs','./namespace-source-control-contract.mjs','./namespace-source-origins.mjs'])],
    ['src/engine-storage/namespace-delivery-inspection.mjs',new Set(['../engine-sdk/index.mjs','../foundation/failures.mjs','../foundation/record-schema.mjs',
      '../kernel/source-changes.mjs','../kernel/phase-policy.mjs','../kernel/publication-intent.mjs','../engine-compatibility/node-source-policy.mjs',
      '../sda/namespace/values.mjs','./namespace-story-reader.mjs','./namespace-preparation.mjs','./namespace-source-observations.mjs',
      './namespace-source-baseline-reader.mjs','./namespace-source-retention-reader.mjs','./namespace-phase-check-reader.mjs','./namespace-source-analysis.mjs','./namespace-source-clauses.mjs','./namespace-source-control-reader.mjs','./namespace-implementation-regions.mjs'])],
    ['src/engine-storage/namespace-source-clauses.mjs',new Set(['../foundation/record-schema.mjs','../foundation/failures.mjs',
      '../engine-compatibility/node-source-policy.mjs','../engine-compatibility/node-source-analysis.mjs','../engine-compatibility/node-repository-plan.mjs','../kernel/source-changes.mjs',
      './namespace-specifications.mjs','./namespace-source-content-reader.mjs'])],
    ['src/engine-storage/namespace-source-analysis.mjs',new Set(['../foundation/record-schema.mjs','../foundation/failures.mjs',
      '../engine-compatibility/node-source-policy.mjs','../engine-compatibility/node-specification-policy.mjs','../engine-compatibility/node-source-analysis.mjs',
      './namespace-source-content-reader.mjs','../kernel/source-changes.mjs'])],
    ['src/engine-storage/namespace-source-observations.mjs',new Set(['node:crypto','../foundation/failures.mjs','../foundation/record-schema.mjs','../foundation/source-snapshot.mjs','../kernel/source-binding.mjs'])],
    ['src/engine-storage/namespace-source-retention-reader.mjs',new Set(['node:crypto','../foundation/failures.mjs','../foundation/record-schema.mjs','../foundation/source-snapshot.mjs',
      '../records.mjs','../kernel/source-changes.mjs','../kernel/phase-policy.mjs','../kernel/phase-admission.mjs','../kernel/story-creation.mjs','../kernel/project-enrollment.mjs',
      '../engine-compatibility/node-source-policy.mjs','../sda/namespace/values.mjs','../sda/namespace/contract.mjs','../sda/content/contract.mjs',
      './namespace-story-reader.mjs','./namespace-lifecycle-codec.mjs','./namespace-source-retention-contract.mjs','./namespace-source-content-reader.mjs','./namespace-source-observations.mjs','./namespace-generation-reader.mjs'])],
    ['src/engine-storage/namespace-source-content-reader.mjs',new Set(['node:crypto','../foundation/failures.mjs','../foundation/source-snapshot.mjs','../sda/content/contract.mjs'])],
    ['src/engine-storage/namespace-source-baseline-reader.mjs',new Set(['node:crypto','../foundation/failures.mjs','../foundation/record-schema.mjs','../foundation/source-snapshot.mjs',
      '../records.mjs','../engine-compatibility/node-source-policy.mjs','../kernel/source-binding.mjs','../kernel/source-changes.mjs','../kernel/story-creation.mjs','../kernel/project-enrollment.mjs',
      '../sda/namespace/values.mjs','../sda/namespace/contract.mjs','../sda/content/contract.mjs','./namespace-story-reader.mjs','./namespace-lifecycle-codec.mjs',
      './namespace-source-observations.mjs','./namespace-source-content-reader.mjs','./namespace-source-baseline-contract.mjs'])]
  ]);
  for(const [file,allowed]of allowedByFile){
    const ast=ts.createSourceFile(file,await readFile(path.join(packageRoot,file),'utf8'),ts.ScriptTarget.Latest,true);
    const visit=node=>{
      if(ts.isImportDeclaration(node))assert.ok(allowed.has(node.moduleSpecifier.text),file+': '+node.moduleSpecifier.text);
      if(ts.isCallExpression(node)&&node.expression.kind===ts.SyntaxKind.ImportKeyword)assert.fail(file+' cannot discover infrastructure');
      if(ts.isPropertyAccessExpression(node)&&['put','save','transact','run','spawn','start','writeFile','admitDraft'].includes(node.name.text))assert.fail(file+' cannot mutate or execute');
      ts.forEachChild(node,visit);
    };visit(ast);
  }
  const contract='src/engine-storage/namespace-source-retention-contract.mjs';
  const graph=await inspectPureModuleGraph({root:packageRoot,entries:[contract],allowed:[contract,'src/engine-storage/namespace-lifecycle-codec.mjs',
    'src/engine-storage/namespace-lifecycle-contract.mjs',...await sourceFiles('src/foundation'),...await sourceFiles('src/sda/namespace'),...await sourceFiles('src/sda/content')]});
  assert.deepEqual(graph.problems,[]);
  const baseline='src/engine-storage/namespace-source-baseline-contract.mjs';
  const baselineGraph=await inspectPureModuleGraph({root:packageRoot,entries:[baseline],allowed:[baseline,'src/engine-storage/namespace-lifecycle-codec.mjs',
    'src/engine-storage/namespace-lifecycle-contract.mjs',...await sourceFiles('src/foundation'),...await sourceFiles('src/sda/namespace'),...await sourceFiles('src/sda/content')]});
  assert.deepEqual(baselineGraph.problems,[]);
  const output='src/engine-storage/namespace-output-retention-contract.mjs',outputGraph=await inspectPureModuleGraph({root:packageRoot,entries:[output],allowed:[output,
    'src/engine-storage/namespace-lifecycle-codec.mjs','src/engine-storage/namespace-lifecycle-contract.mjs',...await sourceFiles('src/foundation'),
    ...await sourceFiles('src/kernel'),...await sourceFiles('src/sda/namespace'),...await sourceFiles('src/sda/content')]});assert.deepEqual(outputGraph.problems,[]);
});

test('source-control acceptance owns only evidence transactions and never selects Git or lifecycle writers',async()=>{
  const owner='src/engine-storage/namespace-source-control.mjs',allowed=new Set(['node:crypto','../engine-sdk/index.mjs',
    '../foundation/failures.mjs','../foundation/record-schema.mjs','../foundation/source-control.mjs','../kernel/phase-preparation.mjs',
    '../kernel/project-enrollment.mjs','../sda/namespace/values.mjs','./namespace-preparation.mjs','./namespace-source-content.mjs',
    './namespace-source-control-reader.mjs','./namespace-source-control-contract.mjs']);
  const ast=ts.createSourceFile(owner,await readFile(path.join(packageRoot,owner),'utf8'),ts.ScriptTarget.Latest,true);
  const visit=node=>{if(ts.isImportDeclaration(node))assert.ok(allowed.has(node.moduleSpecifier.text),node.moduleSpecifier.text);
    if(ts.isCallExpression(node)&&node.expression.kind===ts.SyntaxKind.ImportKeyword)assert.fail('Control acceptance cannot discover an executor');
    if(ts.isIdentifier(node)&&['process','require','eval','Function','spawn','spawnSync','writeFile','transactStory','loadDefinition'].includes(node.text))assert.fail('Control acceptance uses explicit metadata/content/source capabilities');
    ts.forEachChild(node,visit);};visit(ast);
  const contract='src/engine-storage/namespace-source-control-contract.mjs',graph=await inspectPureModuleGraph({root:packageRoot,entries:[contract],
    allowed:[contract,'src/engine-storage/namespace-lifecycle-codec.mjs','src/engine-storage/namespace-lifecycle-contract.mjs',
      ...await sourceFiles('src/foundation'),...await sourceFiles('src/sda/namespace'),...await sourceFiles('src/sda/content')]});
  assert.deepEqual(graph.problems,[]);
});

test('specification analysis shares pure rules; policy verification is read-only and retention writes content only',async()=>{
  const reader='src/engine-storage/namespace-policy-reader.mjs',writer='src/engine-storage/namespace-policy-retention.mjs',
    contract='src/engine-storage/namespace-policy-contract.mjs';
  const allowed=new Map([
    [reader,new Set(['./namespace-test-cohort-reader.mjs','./namespace-test-risk-reader.mjs','./namespace-evidence-reuse-reader.mjs','./namespace-test-recovery-reader.mjs','./namespace-document-review.mjs','./namespace-convergence-policy.mjs','./namespace-convergence-contract.mjs','./namespace-constitution-exception-reader.mjs','./namespace-constitution-reader.mjs','./namespace-assignment-reader.mjs','../kernel/phase-policy.mjs','./namespace-witness-reader.mjs','./namespace-artifact-set-reader.mjs','node:crypto','./namespace-clarification-reader.mjs','../kernel/clarification-responses.mjs','../foundation/failures.mjs','../foundation/record-schema.mjs','../kernel/specification-analysis.mjs',
      '../engine-compatibility/node-specification-policy.mjs','./namespace-specification-contract.mjs','./namespace-policy-contract.mjs','./namespace-code-policy.mjs','./namespace-code-inputs.mjs','./namespace-conformance.mjs','./namespace-publication-reader.mjs','./namespace-candidate-content.mjs'])],
    [writer,new Set(['./namespace-test-cohort-reader.mjs','./namespace-test-risk-reader.mjs','./namespace-evidence-reuse-reader.mjs','./namespace-test-recovery-reader.mjs','./namespace-document-review.mjs','./namespace-convergence-policy.mjs','./namespace-convergence-contract.mjs','./namespace-constitution-reader.mjs','./namespace-artifact-set-reader.mjs','../kernel/artifact-content.mjs','./namespace-clarification-reader.mjs','node:crypto','../foundation/record-schema.mjs','../foundation/failures.mjs','../sda/content/contract.mjs',
      './namespace-specification-contract.mjs','./namespace-policy-contract.mjs'])]
  ]);
  for(const [file,imports]of allowed) {
    const ast=ts.createSourceFile(file,await readFile(path.join(packageRoot,file),'utf8'),ts.ScriptTarget.Latest,true);
    const inspect=node=>{
      if((ts.isImportDeclaration(node)||ts.isExportDeclaration(node))&&node.moduleSpecifier)assert.ok(imports.has(node.moduleSpecifier.text),file+': '+node.moduleSpecifier.text);
      if(ts.isIdentifier(node)&&['process','require','eval','Function'].includes(node.text))assert.fail(file+' cannot discover a host');
      assert.equal(ts.isCallExpression(node)&&node.expression.kind===ts.SyntaxKind.ImportKeyword,false);
      if(ts.isPropertyAccessExpression(node)&&['transact','commit','prepare','writeFile','unlink',...(file===reader?['put']:[])].includes(node.name.text))assert.fail(file+' cannot mutate lifecycle authority');
      ts.forEachChild(node,inspect);
    };inspect(ast);
  }
  const graph=await inspectPureModuleGraph({root:packageRoot,entries:[contract,'src/kernel/specification-analysis.mjs','src/kernel/specification-markers.mjs','src/kernel/specification-scenarios.mjs'],
    allowed:[contract,'src/engine-storage/namespace-lifecycle-contract.mjs',...await sourceFiles('src/foundation'),...await sourceFiles('src/kernel'),
      ...await sourceFiles('src/sda/namespace'),...await sourceFiles('src/sda/content')]});
  assert.deepEqual(graph.problems,[]);
  const retired=new Set(['src/specification-quality.mjs','src/clarification-markers.mjs','src/specification-scenarios.mjs']);
  for(const file of await sourceFiles('src')) {
    if(retired.has(file))continue;
    const ast=ts.createSourceFile(file,await readFile(path.join(packageRoot,file),'utf8'),ts.ScriptTarget.Latest,true);
    const inspect=node=>{
      const target=(ts.isImportDeclaration(node)||ts.isExportDeclaration(node))?node.moduleSpecifier
        :ts.isCallExpression(node)&&node.expression.kind===ts.SyntaxKind.ImportKeyword?node.arguments[0]:null;
      if(target&&ts.isStringLiteralLike(target)&&target.text.startsWith('.'))assert.equal(retired.has(path.posix.normalize(path.posix.join(path.posix.dirname(file),target.text))),false,file+' must use the shared owner');
      ts.forEachChild(node,inspect);
    };inspect(ast);
  }
});

test('namespace publication composes verified private drafts and the conditional writer through explicit ports only',async()=>{
  const owner='src/engine-storage/namespace-publication.mjs',contract='src/engine-storage/namespace-publication-contract.mjs';
  const allowed=new Set(['./namespace-forward-reader.mjs','../kernel/document-review.mjs','./namespace-test-command-reader.mjs','../kernel/namespace-artifact-sets.mjs','../engine-compatibility/node-configuration-path.mjs','../records.mjs','node:crypto','../engine-sdk/index.mjs','../foundation/failures.mjs','../foundation/record-schema.mjs',
    '../foundation/source-snapshot.mjs','../kernel/artifact-content.mjs','../kernel/publication-intent.mjs','../kernel/specification-publication.mjs','../kernel/specification-analysis.mjs','../kernel/clarification-responses.mjs','../kernel/phase-policy.mjs','../kernel/lifecycle-transitions.mjs',
    '../kernel/project-enrollment.mjs','../sda/namespace/values.mjs','../sda/content/contract.mjs','./namespace-preparation.mjs',
    './namespace-lifecycle-commit.mjs','./namespace-commit-coordination.mjs','./namespace-lifecycle-reader.mjs','./namespace-story-reader.mjs','./namespace-lifecycle-contract.mjs','./namespace-publication-contract.mjs','./namespace-publication-reader.mjs','./namespace-specification-retention.mjs','./namespace-policy-retention.mjs','./namespace-reader.mjs','./namespace-read-session.mjs','./namespace-phase-check-reader.mjs']);
  const ast=ts.createSourceFile(owner,await readFile(path.join(packageRoot,owner),'utf8'),ts.ScriptTarget.Latest,true);
  const visit=node=>{
    if(ts.isImportDeclaration(node)||ts.isExportDeclaration(node)&&node.moduleSpecifier)assert.ok(allowed.has(node.moduleSpecifier.text),node.moduleSpecifier.text);
    if(ts.isIdentifier(node)&&['process','require','eval','Function'].includes(node.text))assert.fail(owner+' cannot discover installed state or execute host code');
    assert.equal(ts.isCallExpression(node)&&node.expression.kind===ts.SyntaxKind.ImportKeyword,false);
    ts.forEachChild(node,visit);
  };visit(ast);
  const pure=await inspectPureModuleGraph({root:packageRoot,entries:[contract],allowed:[contract,'src/engine-storage/namespace-forward-contract.mjs','src/engine-storage/namespace-policy-contract.mjs','src/engine-storage/namespace-specification-contract.mjs','src/engine-storage/namespace-phase-check-contract.mjs','src/engine-storage/namespace-lifecycle-codec.mjs','src/engine-storage/namespace-lifecycle-contract.mjs',...await sourceFiles('src/foundation'),
    ...await sourceFiles('src/kernel'),...await sourceFiles('src/sda/namespace'),...await sourceFiles('src/sda/content')]});
  assert.deepEqual(pure.problems,[]);
  for(const file of await sourceFiles('src')) {
    if(file===owner||file==='src/engine-storage/namespace-engine.mjs')continue;
    const ast=ts.createSourceFile(file,await readFile(path.join(packageRoot,file),'utf8'),ts.ScriptTarget.Latest,true);
    const inspect=node=>{
      const specifier=(ts.isImportDeclaration(node)||ts.isExportDeclaration(node))?node.moduleSpecifier
        :ts.isCallExpression(node)&&node.expression.kind===ts.SyntaxKind.ImportKeyword?node.arguments[0]:null;
      if(specifier&&ts.isStringLiteralLike(specifier)&&specifier.text.startsWith('.'))assert.notEqual(
        path.posix.normalize(path.posix.join(path.posix.dirname(file),specifier.text)),owner,
        file+' cannot implicitly replace installed publication authority');
      ts.forEachChild(node,inspect);
    };inspect(ast);
  }
});

test('shared submission never selects a private working store, Git host or installed authority',async()=>{
  const owner='src/engine-storage/namespace-submission.mjs',reader='src/engine-storage/namespace-publication-reader.mjs',
    submissionReader='src/engine-storage/namespace-submission-reader.mjs',contract='src/engine-storage/namespace-submission-contract.mjs';
  const allowed=new Map([
    [owner,new Set(['./namespace-forward-reader.mjs','./namespace-convergence-submission.mjs','node:crypto','../engine-sdk/index.mjs','../foundation/failures.mjs','../foundation/record-schema.mjs',
      '../kernel/phase-preparation.mjs','../kernel/phase-admission.mjs','../kernel/phase-policy.mjs','../kernel/publication-intent.mjs',
      '../kernel/lifecycle-transitions.mjs','../kernel/project-enrollment.mjs','../kernel/submission-routing.mjs','../sda/namespace/values.mjs','../sda/content/contract.mjs',
      './namespace-lifecycle-reader.mjs','./namespace-lifecycle-commit.mjs','./namespace-commit-coordination.mjs','./namespace-configuration-reader.mjs','./namespace-story-reader.mjs','./namespace-publication-reader.mjs',
      './namespace-reader.mjs','./namespace-read-session.mjs','./namespace-phase-check-reader.mjs','./namespace-lifecycle-contract.mjs','./namespace-submission-contract.mjs','./namespace-submission-reader.mjs','./namespace-source-review-reader.mjs'])],
    [reader,new Set(['./namespace-forward-reader.mjs','node:crypto','../foundation/failures.mjs','../foundation/record-schema.mjs','../kernel/artifact-content.mjs','./namespace-publication-contract.mjs','./namespace-lifecycle-receipt-reader.mjs','./namespace-specifications.mjs','./namespace-policy-reader.mjs'])],
    [submissionReader,new Set(['./namespace-forward-reader.mjs','./namespace-convergence-submission.mjs','../foundation/failures.mjs','../foundation/record-schema.mjs','../kernel/submission-routing.mjs','./namespace-submission-contract.mjs',
      './namespace-publication-reader.mjs','./namespace-approval-reader.mjs','./namespace-lifecycle-receipt-reader.mjs','./namespace-code-policy.mjs','./namespace-source-review-reader.mjs'])]
  ]);
  for(const [file,imports] of allowed) {
    const ast=ts.createSourceFile(file,await readFile(path.join(packageRoot,file),'utf8'),ts.ScriptTarget.Latest,true);
    const visit=node=>{
      if(ts.isImportDeclaration(node)||ts.isExportDeclaration(node)&&node.moduleSpecifier)assert.ok(imports.has(node.moduleSpecifier.text),file+': '+node.moduleSpecifier.text);
      if(ts.isIdentifier(node)&&['process','require','eval','Function'].includes(node.text))assert.fail(file+' cannot discover a host');
      assert.equal(ts.isCallExpression(node)&&node.expression.kind===ts.SyntaxKind.ImportKeyword,false);
      if([reader,submissionReader].includes(file)&&ts.isPropertyAccessExpression(node)&&['put','transact','commit','writeFile','unlink'].includes(node.name.text))assert.fail('Publication and submission inspection are read-only');
      ts.forEachChild(node,visit);
    };visit(ast);
  }
  const pure=await inspectPureModuleGraph({root:packageRoot,entries:[contract],allowed:[contract,'src/engine-storage/namespace-forward-contract.mjs','src/engine-storage/namespace-convergence-contract.mjs','src/engine-storage/namespace-policy-contract.mjs','src/engine-storage/namespace-specification-contract.mjs','src/engine-storage/namespace-phase-check-contract.mjs','src/engine-storage/namespace-lifecycle-codec.mjs','src/engine-storage/namespace-lifecycle-contract.mjs',...await sourceFiles('src/foundation'),
    ...await sourceFiles('src/kernel'),...await sourceFiles('src/sda/namespace'),...await sourceFiles('src/sda/content')]});
  assert.deepEqual(pure.problems,[]);
  for(const file of await sourceFiles('src')) {
    if(file===owner||file==='src/engine-storage/namespace-engine.mjs')continue;
    const ast=ts.createSourceFile(file,await readFile(path.join(packageRoot,file),'utf8'),ts.ScriptTarget.Latest,true);
    const inspect=node=>{
      const specifier=(ts.isImportDeclaration(node)||ts.isExportDeclaration(node))?node.moduleSpecifier
        :ts.isCallExpression(node)&&node.expression.kind===ts.SyntaxKind.ImportKeyword?node.arguments[0]:null;
      if(specifier&&ts.isStringLiteralLike(specifier)&&specifier.text.startsWith('.'))assert.notEqual(
        path.posix.normalize(path.posix.join(path.posix.dirname(file),specifier.text)),owner,file+' cannot select a new submission authority');
      ts.forEachChild(node,inspect);
    };inspect(ast);
  }
});

test('namespace human approval has explicit ports, a pure vote contract and no installed-authority selection',async()=>{
  const owner='src/engine-storage/namespace-approval.mjs',reader='src/engine-storage/namespace-approval-reader.mjs',contract='src/engine-storage/namespace-approval-contract.mjs';
  const allowed=new Map([
    [owner,new Set(['./namespace-witness-mapping-reader.mjs','./namespace-terminal-evidence.mjs','./namespace-forward-reader.mjs','node:crypto','../engine-sdk/index.mjs','../foundation/failures.mjs','../foundation/record-schema.mjs',
      '../kernel/phase-preparation.mjs','../kernel/approval-policy.mjs','../kernel/phase-admission.mjs','../kernel/phase-policy.mjs',
      '../kernel/publication-intent.mjs','../kernel/lifecycle-transitions.mjs','../kernel/workflow-decisions.mjs','../kernel/routed-approval.mjs','../kernel/project-enrollment.mjs',
      '../sda/namespace/values.mjs','../sda/content/contract.mjs','./namespace-lifecycle-reader.mjs','./namespace-lifecycle-commit.mjs','./namespace-commit-coordination.mjs',
      './namespace-configuration-reader.mjs','./namespace-story-reader.mjs','./namespace-read-session.mjs','./namespace-submission-reader.mjs','./namespace-approval-reader.mjs','./namespace-reader.mjs','./namespace-phase-check-reader.mjs',
      './namespace-lifecycle-contract.mjs','./namespace-approval-contract.mjs','../engine-compatibility/node-specification-policy.mjs'])],
    [reader,new Set(['./namespace-specifications.mjs','./namespace-witness-mapping-reader.mjs','./namespace-terminal-evidence.mjs','./namespace-forward-reader.mjs','node:crypto','../foundation/failures.mjs','../foundation/record-schema.mjs','../kernel/approval-policy.mjs',
      '../kernel/workflow-decisions.mjs','../kernel/routed-approval.mjs','./namespace-approval-contract.mjs','./namespace-lifecycle-receipt-reader.mjs','./namespace-policy-reader.mjs'])]
  ]);
  for(const [file,imports]of allowed){const ast=ts.createSourceFile(file,await readFile(path.join(packageRoot,file),'utf8'),ts.ScriptTarget.Latest,true);
    const visit=node=>{
      if(ts.isImportDeclaration(node)||ts.isExportDeclaration(node)&&node.moduleSpecifier)assert.ok(imports.has(node.moduleSpecifier.text),file+': '+node.moduleSpecifier.text);
      if(ts.isIdentifier(node)&&['process','require','eval','Function'].includes(node.text))assert.fail(file+' cannot discover installed state or a reviewer');
      assert.equal(ts.isCallExpression(node)&&node.expression.kind===ts.SyntaxKind.ImportKeyword,false);
      if((file===reader||file.endsWith('-decision-reader.mjs')||file.endsWith('-rejection-reader.mjs'))&&ts.isPropertyAccessExpression(node)&&['put','transact','commit','writeFile'].includes(node.name.text))assert.fail('Vote proof reading cannot mutate records');
      ts.forEachChild(node,visit);
    };visit(ast);
  }
  const pure=await inspectPureModuleGraph({root:packageRoot,entries:[contract],allowed:[contract,'src/engine-storage/namespace-forward-contract.mjs','src/engine-storage/namespace-policy-contract.mjs','src/engine-storage/namespace-lifecycle-contract.mjs',...await sourceFiles('src/foundation'),
    ...await sourceFiles('src/kernel'),...await sourceFiles('src/sda/namespace'),...await sourceFiles('src/sda/content')]});
  assert.deepEqual(pure.problems,[]);
  for(const file of await sourceFiles('src')){
    if(file===owner||file==='src/engine-storage/namespace-engine.mjs')continue;
    const ast=ts.createSourceFile(file,await readFile(path.join(packageRoot,file),'utf8'),ts.ScriptTarget.Latest,true);
    const visit=node=>{const specifier=(ts.isImportDeclaration(node)||ts.isExportDeclaration(node))?node.moduleSpecifier
      :ts.isCallExpression(node)&&node.expression.kind===ts.SyntaxKind.ImportKeyword?node.arguments[0]:null;
      if(specifier&&ts.isStringLiteralLike(specifier)&&specifier.text.startsWith('.'))assert.notEqual(
        path.posix.normalize(path.posix.join(path.posix.dirname(file),specifier.text)),owner,file+' cannot replace installed approval authority');
      ts.forEachChild(node,visit);
    };visit(ast);
  }
});

test('namespace route choices use explicit human ports and shared read-only question proofs',async()=>{
  const owner='src/engine-storage/namespace-routing-choice.mjs',reader='src/engine-storage/namespace-routing-choice-reader.mjs';
  const contract='src/engine-storage/namespace-routing-choice-contract.mjs';
  const allowed=new Map([
    [owner,new Set(['node:crypto','../engine-sdk/index.mjs','../foundation/failures.mjs','../foundation/record-schema.mjs',
      '../kernel/phase-preparation.mjs','../kernel/approval-policy.mjs','../kernel/routed-approval.mjs',
      '../kernel/project-enrollment.mjs','../sda/namespace/values.mjs','../sda/content/contract.mjs',
      './namespace-lifecycle-reader.mjs','./namespace-lifecycle-commit.mjs','./namespace-commit-coordination.mjs','./namespace-configuration-reader.mjs','./namespace-story-reader.mjs',
      './namespace-routing-choice-reader.mjs','./namespace-routing-receipt-reader.mjs','./namespace-reader.mjs','./namespace-phase-check-reader.mjs','./namespace-lifecycle-contract.mjs','./namespace-routing-choice-contract.mjs'])],
    [reader,new Set(['../foundation/failures.mjs','../foundation/record-schema.mjs','../kernel/decision-plan.mjs',
      '../kernel/routed-approval.mjs','./namespace-submission-reader.mjs','./namespace-approval-reader.mjs'])],
    ['src/engine-storage/namespace-routing-receipt-reader.mjs',new Set(['node:crypto','../foundation/failures.mjs','../foundation/record-schema.mjs',
      '../kernel/routed-approval.mjs','./namespace-lifecycle-receipt-reader.mjs','./namespace-routing-choice-reader.mjs','./namespace-submission-reader.mjs',
      './namespace-phase-check-reader.mjs','./namespace-routing-choice-contract.mjs'])]
  ]);
  for(const [file,imports]of allowed) {
    const ast=ts.createSourceFile(file,await readFile(path.join(packageRoot,file),'utf8'),ts.ScriptTarget.Latest,true);
    const visit=node=>{
      if(ts.isImportDeclaration(node)||ts.isExportDeclaration(node)&&node.moduleSpecifier)assert.ok(imports.has(node.moduleSpecifier.text),file+': '+node.moduleSpecifier.text);
      if(ts.isIdentifier(node)&&['process','require','eval','Function'].includes(node.text))assert.fail(file+' cannot discover a human or installed authority');
      assert.equal(ts.isCallExpression(node)&&node.expression.kind===ts.SyntaxKind.ImportKeyword,false);
      if(file!==owner&&ts.isPropertyAccessExpression(node)&&['put','transact','commit','writeFile','unlink'].includes(node.name.text))assert.fail('Question proof reading cannot mutate');
      ts.forEachChild(node,visit);
    };visit(ast);
  }
  const pure=await inspectPureModuleGraph({root:packageRoot,entries:[contract],allowed:[contract,...await sourceFiles('src/foundation'),
    ...await sourceFiles('src/kernel'),...await sourceFiles('src/sda/namespace'),...await sourceFiles('src/sda/content')]});
  assert.deepEqual(pure.problems,[]);
  for(const file of await sourceFiles('src')) {
    if(file===owner||file==='src/engine-storage/namespace-engine.mjs')continue;
    const ast=ts.createSourceFile(file,await readFile(path.join(packageRoot,file),'utf8'),ts.ScriptTarget.Latest,true);
    const visit=node=>{const specifier=(ts.isImportDeclaration(node)||ts.isExportDeclaration(node))?node.moduleSpecifier
      :ts.isCallExpression(node)&&node.expression.kind===ts.SyntaxKind.ImportKeyword?node.arguments[0]:null;
      if(specifier&&ts.isStringLiteralLike(specifier)&&specifier.text.startsWith('.'))assert.notEqual(
        path.posix.normalize(path.posix.join(path.posix.dirname(file),specifier.text)),owner,file+' must not replace installed routing authority');
      ts.forEachChild(node,visit);
    };visit(ast);
  }
});

test('clarification rules are pure, read manifests are read-only and human records cannot select a lifecycle writer',async()=>{
  const kernel='src/kernel/clarification-responses.mjs',reader='src/engine-storage/namespace-clarification-reader.mjs',
    resources='src/engine-storage/namespace-phase-resources.mjs',writer='src/engine-storage/namespace-clarifications.mjs';
  const graph=await inspectPureModuleGraph({root:packageRoot,entries:[kernel],allowed:[...await sourceFiles('src/kernel'),...await sourceFiles('src/foundation')]});
  assert.deepEqual(graph.problems,[]);
  for(const file of [reader,resources,writer]) {
    const ast=ts.createSourceFile(file,await readFile(path.join(packageRoot,file),'utf8'),ts.ScriptTarget.Latest,true);
    const inspect=node=>{
      if(ts.isImportDeclaration(node))assert.ok(!node.moduleSpecifier.text.startsWith('node:')||node.moduleSpecifier.text==='node:crypto',file+' cannot discover a host');
      if(ts.isIdentifier(node)&&['process','require','eval','Function','createNamespaceLifecycleCommitter','commitNamespaceOperation'].includes(node.text))assert.fail(file+' cannot mutate lifecycle authority or discover a host');
      if(ts.isPropertyAccessExpression(node)&&['writeFile','unlink','spawn','spawnSync',...(file===writer?[]:['put','transact','commit'])].includes(node.name.text))assert.fail(file+' has the wrong effect owner');
      assert.equal(ts.isCallExpression(node)&&node.expression.kind===ts.SyntaxKind.ImportKeyword,false);
      ts.forEachChild(node,inspect);
    };inspect(ast);
  }
  const native=await readFile(path.join(packageRoot,'src/clarifications.mjs'),'utf8');
  assert.match(native,/clarificationResponseSet\(/u);
  assert.doesNotMatch(native,/function (?:normalizeResponse|normalizeMarkerBinding|mergeResponses|answeredMarkerHashes|clarificationRoutes)\(/u);
});

test('the opt-in headless composition captures capabilities and constructs exactly one registered Engine',async()=>{
  const file='src/engine-storage/namespace-engine.mjs';
  const allowed=new Set(['./namespace-test-cohorts.mjs','./namespace-witness-renewals.mjs','./namespace-obligation-risks.mjs','./namespace-test-risks.mjs','./namespace-evidence-reuse.mjs','./namespace-evidence.mjs','./namespace-test-recovery.mjs','./namespace-test-repair.mjs','./namespace-decision-list.mjs','./namespace-decision-batch.mjs','./namespace-convergence.mjs','./namespace-convergence-advancement.mjs','./namespace-test-commands.mjs','./namespace-output-retention.mjs','./namespace-constitution-exceptions.mjs','../engine-sdk/index.mjs','../foundation/failures.mjs','../foundation/source-snapshot.mjs','../foundation/source-control.mjs',
    '../sda/namespace/contract.mjs','../sda/namespace/values.mjs','../sda/content/contract.mjs','./namespace-reader.mjs',
    './namespace-project.mjs','./namespace-configuration.mjs','./namespace-story.mjs','./namespace-source.mjs',
    './namespace-source-review.mjs','./namespace-assignment.mjs','./namespace-witness-decisions.mjs','./namespace-preparation.mjs','./namespace-publication.mjs','./namespace-submission.mjs','./namespace-approval.mjs','./namespace-conformance-decisions.mjs','./namespace-rejection.mjs','./namespace-routing-choice.mjs','./namespace-read-session.mjs','./namespace-plan-decisions.mjs','./namespace-scope-decisions.mjs','./namespace-upstream.mjs','./namespace-input-documents.mjs','./namespace-phase-checks.mjs','./namespace-source-inspection.mjs','./namespace-source-retention.mjs','./namespace-source-baseline.mjs','./namespace-delivery-inspection.mjs','./namespace-test-witnesses.mjs','./namespace-source-control.mjs','./namespace-clarifications.mjs','./namespace-phase-entry.mjs','./namespace-phase-inspection.mjs','./namespace-story-queries.mjs','./namespace-workflow-assets.mjs','../sda/namespace/read-batch.mjs']);
  const ast=ts.createSourceFile(file,await readFile(path.join(packageRoot,file),'utf8'),ts.ScriptTarget.Latest,true);
  let engines=0;
  const visit=node=>{
    if(ts.isImportDeclaration(node))assert.ok(allowed.has(node.moduleSpecifier.text),node.moduleSpecifier.text);
    if(ts.isIdentifier(node)&&['process','require','eval','Function'].includes(node.text))assert.fail('Composition cannot discover an installed context');
    if(ts.isCallExpression(node)) {
      assert.equal(node.expression.kind===ts.SyntaxKind.ImportKeyword,false);
      if(ts.isIdentifier(node.expression)&&node.expression.text==='createEngine')engines++;
      if(ts.isPropertyAccessExpression(node.expression))assert.equal(['run','read','transact','put','inspectOperation'].includes(node.expression.name.text),false,
        'Composition cannot dispatch another Engine or perform persistence operations');
    }
    ts.forEachChild(node,visit);
  };visit(ast);assert.equal(engines,1);
  for(const candidate of await sourceFiles('src')) {
    if(candidate===file)continue;
    const source=ts.createSourceFile(candidate,await readFile(path.join(packageRoot,candidate),'utf8'),ts.ScriptTarget.Latest,true);
    const inspect=node=>{const specifier=(ts.isImportDeclaration(node)||ts.isExportDeclaration(node))?node.moduleSpecifier
      :ts.isCallExpression(node)&&node.expression.kind===ts.SyntaxKind.ImportKeyword?node.arguments[0]:null;
      if(specifier&&ts.isStringLiteralLike(specifier)&&specifier.text.startsWith('.'))assert.notEqual(
        path.posix.normalize(path.posix.join(path.posix.dirname(candidate),specifier.text)),file,candidate+' must not implicitly replace an installed host');
      ts.forEachChild(node,inspect);
    };inspect(source);
  }
});

test('namespace authoring entry reads explicit proofs and private observations without persistence or host execution',async()=>{
  const file='src/engine-storage/namespace-phase-entry.mjs',allowed=new Set(['./namespace-test-recovery-reader.mjs','node:crypto','../foundation/failures.mjs','../foundation/record-schema.mjs',
    '../foundation/source-snapshot.mjs','../kernel/phase-entry.mjs','../kernel/phase-admission.mjs','../kernel/phase-preparation.mjs','../kernel/phase-policy.mjs',
    '../sda/namespace/values.mjs','../sda/content/contract.mjs','./namespace-story-reader.mjs','./namespace-clarification-reader.mjs',
    './namespace-publication-reader.mjs','./namespace-phase-check-reader.mjs','./namespace-code-history.mjs','./namespace-artifact-repair-reader.mjs']);
  const ast=ts.createSourceFile(file,await readFile(path.join(packageRoot,file),'utf8'),ts.ScriptTarget.Latest,true);
  const visit=node=>{
    if(ts.isImportDeclaration(node))assert.ok(allowed.has(node.moduleSpecifier.text),node.moduleSpecifier.text);
    if(ts.isIdentifier(node)&&['process','require','eval','Function','createEngine','createNamespaceLifecycleCommitter'].includes(node.text))assert.fail(file+' cannot discover a host or select another lifecycle writer');
    if(ts.isPropertyAccessExpression(node)&&['put','transact','commit','writeFile','unlink','spawn','spawnSync','run'].includes(node.name.text))assert.fail(file+' must remain read-only');
    assert.equal(ts.isCallExpression(node)&&node.expression.kind===ts.SyntaxKind.ImportKeyword,false);
    ts.forEachChild(node,visit);
  };visit(ast);
});

test('namespace diagnostic and candidate inspection owners cannot write, execute or grant draft authority',async()=>{
  const files=new Map([
    ['namespace-artifact-set-reader.mjs',new Set(['node:crypto','../foundation/failures.mjs','../foundation/record-schema.mjs','../kernel/namespace-artifact-sets.mjs','../engine-compatibility/node-configuration-path.mjs','../records.mjs','../sda/namespace/values.mjs','../sda/content/contract.mjs','./namespace-lifecycle-contract.mjs','./namespace-specification-contract.mjs','./namespace-candidate-content.mjs','./namespace-artifact-repair-reader.mjs'])],
    ['namespace-workflow-assets.mjs',new Set(['node:crypto','../foundation/failures.mjs','../foundation/record-schema.mjs','../kernel/phase-preparation.mjs','../kernel/namespace-workflow-assets.mjs','../kernel/workflow-assets.mjs','./namespace-story-reader.mjs'])],
    ['namespace-story-queries.mjs',new Set(['./namespace-forward-reader.mjs','../foundation/failures.mjs','../kernel/phase-preparation.mjs','../kernel/phase-policy.mjs','./namespace-story-reader.mjs','./namespace-source-review-reader.mjs'])],
    ['namespace-candidate-content.mjs',new Set(['node:crypto','../foundation/failures.mjs'])],
    ['namespace-phase-inspection.mjs',new Set(['../kernel/document-review.mjs','./namespace-test-command-reader.mjs','../kernel/namespace-artifact-sets.mjs','../engine-compatibility/node-configuration-path.mjs','../records.mjs','node:crypto','../foundation/failures.mjs','../foundation/record-schema.mjs','../kernel/phase-preparation.mjs',
      '../kernel/phase-policy.mjs','../kernel/artifact-content.mjs','../kernel/publication-intent.mjs','../kernel/specification-publication.mjs',
      '../kernel/specification-analysis.mjs','../kernel/clarification-responses.mjs','./namespace-story-reader.mjs','./namespace-publication-reader.mjs','./namespace-phase-check-reader.mjs'])]
  ]);
  for(const [name,allowed]of files){const file='src/engine-storage/'+name,ast=ts.createSourceFile(file,await readFile(path.join(packageRoot,file),'utf8'),ts.ScriptTarget.Latest,true);
    const visit=node=>{
      if(ts.isImportDeclaration(node))assert.ok(allowed.has(node.moduleSpecifier.text),file+': '+node.moduleSpecifier.text);
      if(ts.isIdentifier(node)&&['process','require','eval','Function','createEngine','createNamespaceLifecycleCommitter'].includes(node.text))assert.fail(file+' cannot discover an installed host or writer');
      if(ts.isPropertyAccessExpression(node)&&['put','transact','commit','save','writeFile','unlink','spawn','spawnSync','run','admitDraft'].includes(node.name.text))assert.fail(file+' must remain read-only');
      assert.equal(ts.isCallExpression(node)&&node.expression.kind===ts.SyntaxKind.ImportKeyword,false);ts.forEachChild(node,visit);
    };visit(ast);
  }
});

test('namespace backends do not import lifecycle, Git, command or approval owners', async () => {
  const owners = ['src/sda/filesystem-namespace-adapter.mjs', 'src/sda/filesystem-namespace-journal.mjs',
    'src/sda/namespace-journal-adapter.mjs', 'src/sda/application-namespace-adapter.mjs',
    'src/sda/sqlite-namespace-adapter.mjs', 'src/sda/sqlite-namespace-journal.mjs', 'src/sda/sqlite-native.mjs', 'src/sda/sqlite-content-adapter.mjs'];
  for (const owner of owners) {
    const source = ts.createSourceFile(owner, await readFile(path.join(packageRoot, owner), 'utf8'), ts.ScriptTarget.Latest, true);
    const visit = node => {
      const specifier = (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) ? node.moduleSpecifier
        : ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword ? node.arguments[0] : null;
      if (specifier) {
        assert.equal(ts.isStringLiteralLike(specifier), true);
        const name = specifier.text;
        assert.ok(['node:crypto', 'node:fs', 'node:fs/promises', 'node:path', 'node:sqlite'].includes(name)
          || name.startsWith('./namespace/') || name.startsWith('./content/') || name === '../foundation/record-schema.mjs' || ['./filesystem-namespace-journal.mjs',
            './sqlite-namespace-journal.mjs', './namespace-journal-adapter.mjs', './sqlite-native.mjs'].includes(name), `${owner}: ${name}`);
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
});

test('Git compatibility composes existing owners without introducing another persistence or authorization path', async () => {
  const relative = 'src/sda/git-compatibility-adapter.mjs';
  const source = ts.createSourceFile(relative, await readFile(path.join(packageRoot, relative), 'utf8'), ts.ScriptTarget.Latest, true);
  const staticImports = [];
  const dynamicImports = [];
  const visit = node => {
    if (ts.isImportDeclaration(node) || (ts.isExportDeclaration(node) && node.moduleSpecifier)) {
      staticImports.push(node.moduleSpecifier.text);
    }
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      assert.equal(ts.isStringLiteralLike(node.arguments[0]), true, 'owner imports must be literal and reviewable');
      dynamicImports.push(node.arguments[0].text);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  assert.deepEqual(staticImports.sort(), ['node:path', './shared-state-contract.mjs', './namespace/values.mjs',
    './git-compatibility-contract.mjs'].sort());
  assert.deepEqual(dynamicImports.sort(), ['../approved-configuration-reader.mjs', '../configuration-proposal.mjs',
    './story-branch-authority.mjs', './git-ledger-adapter.mjs'].sort());
});

test('production consumers use kernel phase rules and only the compatibility aggregate opens native transitions',async()=>{
  const packageFiles=[...await sourceFiles('src'),...await sourceFiles('apps')];
  const oldRules=new Set(['src/auto/auto-policy.mjs','src/adhoc/policy.mjs','src/phase-roles.mjs','src/phase-generation.mjs',
    'src/phase-inspection-generation.mjs','src/phase-generation-need.mjs','src/commands/status-read.mjs','src/lifecycle-transitions.mjs','src/phase-actor-policy.mjs',
    'src/approval-authority.mjs','src/approval-fallback.mjs','src/commands/decision-story-records.mjs',
    'src/commands/decision-plan-amendment.mjs','src/commands/decision-obligation-risk.mjs',
    'src/commands/shared/story-draft-transaction.mjs','src/commands/shared/convergence-preparation-state.mjs'].map(file=>path.join(packageRoot,file)));
  const transitions=new Set(['src/engine-compatibility/generation-publication.mjs',
    'src/engine-compatibility/submission-transition.mjs','src/engine-compatibility/approval-transition.mjs',
    'src/engine-compatibility/rejection-transition.mjs'].map(file=>path.join(packageRoot,file)));
  const submissionPort=path.join(packageRoot,'src/engine-compatibility/git-submission.mjs');
  const approvalPort=path.join(packageRoot,'src/engine-compatibility/git-approval.mjs');
  const rejectionPort=path.join(packageRoot,'src/engine-compatibility/git-rejection.mjs');
  const decisionPort=path.join(packageRoot,'src/engine-compatibility/git-decisions.mjs');
  const advancementPort=path.join(packageRoot,'src/engine-compatibility/git-advancement.mjs');
  const singleDecisionPort=path.join(packageRoot,'src/engine-compatibility/git-decision-record.mjs');
  const testDecisionPort=path.join(packageRoot,'src/engine-compatibility/git-test-decision-record.mjs');
  const witnessWriter=path.join(packageRoot,'src/engine-compatibility/native-witness-decisions.mjs');
  const correctionPort=path.join(packageRoot,'src/engine-compatibility/git-plan-correction.mjs');
  const upstreamPort=path.join(packageRoot,'src/engine-compatibility/git-upstream.mjs');
  const forwardWriter=path.join(packageRoot,'src/engine-compatibility/native-forward-amendments.mjs');
  const upstreamReader=path.join(packageRoot,'src/engine-compatibility/upstream-artifact-issues.mjs');
  const reviewPort=path.join(packageRoot,'src/engine-compatibility/git-phase-review.mjs');
  const nativeReview=path.join(packageRoot,'src/engine-compatibility/native-phase-review.mjs');
  const documentPort=path.join(packageRoot,'src/engine-compatibility/git-document-read.mjs');
  const documentReferences=path.join(packageRoot,'src/engine-compatibility/native-document-references.mjs');
  const entryPort=path.join(packageRoot,'src/engine-compatibility/git-phase-entry.mjs');
  const workflowAssetsPort=path.join(packageRoot,'src/engine-compatibility/git-workflow-assets.mjs');
  const nativeEntry=path.join(packageRoot,'src/engine-compatibility/native-phase-entry.mjs');
  const nativeConvergence=path.join(packageRoot,'src/engine-compatibility/native-convergence.mjs');
  const generationBoundary=path.join(packageRoot,'src/generation-boundary.mjs');
  const problems=[];
  for(const relative of packageFiles){
    const file=path.join(packageRoot,relative);
    const source=ts.createSourceFile(relative,await readFile(file,'utf8'),ts.ScriptTarget.Latest,true);
    const visit=node=>{
      const specifier=(ts.isImportDeclaration(node)||ts.isExportDeclaration(node))?node.moduleSpecifier
        :ts.isCallExpression(node)&&node.expression.kind===ts.SyntaxKind.ImportKeyword?node.arguments[0]:null;
      if(specifier&&ts.isStringLiteralLike(specifier)&&specifier.text.startsWith('.')){
        const target=path.resolve(path.dirname(file),specifier.text);
        const budgetAlias=relative==='src/repair-budget.mjs'&&ts.isExportDeclaration(node)
          &&target===path.join(packageRoot,'src/engine-compatibility/rejection-transition.mjs')
          &&node.exportClause&&ts.isNamedExports(node.exportClause)&&node.exportClause.elements.length===1
          &&node.exportClause.elements[0].name.text==='consumeRepairAttempt';
        if(oldRules.has(target)||(transitions.has(target)&&relative!=='src/state.mjs'&&!budgetAlias))problems.push(relative);
        if(target===submissionPort&&relative!=='src/engine-compatibility/git-publication.mjs')problems.push(relative);
        if(target===approvalPort&&relative!=='src/engine-compatibility/git-publication.mjs')problems.push(relative);
        if(target===rejectionPort&&relative!=='src/engine-compatibility/git-publication.mjs')problems.push(relative);
        if(target===decisionPort&&relative!=='src/engine-compatibility/git-publication.mjs')problems.push(relative);
        if(target===advancementPort&&relative!=='src/engine-compatibility/git-publication.mjs')problems.push(relative);
        if(target===singleDecisionPort&&relative!=='src/engine-compatibility/git-publication.mjs')problems.push(relative);
        if(target===testDecisionPort&&relative!=='src/engine-compatibility/git-publication.mjs')problems.push(relative);
        if(target===witnessWriter&&relative!=='src/engine-compatibility/git-decision-record.mjs')problems.push(relative);
        if(target===correctionPort&&relative!=='src/engine-compatibility/git-publication.mjs')problems.push(relative);
        if(target===upstreamPort&&relative!=='src/engine-compatibility/git-publication.mjs')problems.push(relative);
        if((target===forwardWriter||target===upstreamReader)&&relative!=='src/engine-compatibility/git-upstream.mjs')problems.push(relative);
        if(target===reviewPort&&!['src/engine-compatibility/git-query.mjs','src/engine-compatibility/git-publication.mjs'].includes(relative))problems.push(relative);
        if(target===nativeReview&&!['src/engine-compatibility/git-phase-review.mjs','src/commands/shared/phase-review.mjs'].includes(relative))problems.push(relative);
        if(target===documentPort&&!['src/engine-compatibility/git-query.mjs','src/engine-compatibility/git-publication.mjs'].includes(relative))problems.push(relative);
        if(target===documentReferences&&!['src/engine-compatibility/git-phase-review.mjs','src/engine-compatibility/git-document-read.mjs','src/engine-compatibility/native-phase-entry.mjs'].includes(relative))problems.push(relative);
        if(target===entryPort&&!['src/engine-compatibility/git-query.mjs','src/engine-compatibility/git-publication.mjs','src/phase-entry.mjs','src/phase-entry-authoring.mjs','src/commands/phase-lifecycle.mjs','src/commands/prepare.mjs','src/commands/inputs.mjs','src/commands/shared/prepare-configured-phase.mjs'].includes(relative))problems.push(relative);
        if(target===workflowAssetsPort&&!['src/engine-compatibility/git-query.mjs','src/workflow-transfer.mjs'].includes(relative))problems.push(relative);
        if(target===nativeEntry&&relative!=='src/engine-compatibility/git-phase-entry.mjs')problems.push(relative);
        if(target===nativeConvergence&&!['src/commands/story.mjs','src/engine-compatibility/git-phase-entry.mjs'].includes(relative))problems.push(relative);
        if(target===generationBoundary&&relative!=='src/state.mjs'&&ts.isImportDeclaration(node)
          &&node.importClause?.namedBindings&&ts.isNamedImports(node.importClause.namedBindings)
          &&node.importClause.namedBindings.elements.some(item=>(item.propertyName??item.name).text==='beginNativePhaseGeneration'))problems.push(relative);
      }
      ts.forEachChild(node,visit);
    };visit(source);
  }
  assert.deepEqual(problems,[],'old paths are compatibility exports, not another internal policy or write path');
});

test('ordinary status commands and warm reads use one native registry observer and shared evidence rules', async () => {
  const read = relative => readFile(path.join(packageRoot, relative), 'utf8');
  const native = await read('src/engine-compatibility/git-story-status.mjs');
  assert.match(native, /binding\.engine\.run\('story\.status', \{\}\)/);
  assert.doesNotMatch(native, /loadAcceptedStoryExecution|submissionReadiness|actionActor|transactStory|withoutReadScope/);
  const shim = ts.createSourceFile('status-read.mjs', await read('src/commands/status-read.mjs'), ts.ScriptTarget.Latest, true);
  assert.ok(shim.statements.every(node => ts.isExportDeclaration(node)), 'the old reader is a compatibility export only');
  const worker = await read('src/read-worker-service.mjs');
  assert.match(worker, /import\('\.\/engine-compatibility\/git-story-status\.mjs'\)/);
  assert.doesNotMatch(worker, /import\('\.\/commands\/status\.mjs'\)/);
  const next = await read('src/commands/nextsteps.mjs');
  assert.match(next, /recordedEvidenceSummary as evidenceSummary/);
  assert.doesNotMatch(next, /function evidenceSummary\(/);
});

test('guide and handoff hosts render shared kernel decisions and the CLI uses the registered query',async()=>{
  const sources={
    'phase-transition-routes.mjs':['phaseHandoffPlan','workflowGuidePlan','sourceReviewContinuationPlan','phaseGovernancePlan'],
    'phase-authoring-progress.mjs':['phaseAuthoringPlan']
  };
  for(const [file,functions] of Object.entries(sources)) {
    const source=await readFile(path.join(packageRoot,'src',file),'utf8');
    for(const name of functions)assert.ok(source.includes(name+'('),file+' must use '+name);
    assert.doesNotMatch(source,/phaseNeedsGeneration\(|sourceReviewAuthorConflict\(|consumedByPublishedGeneration\(/);
  }
  const command=await readFile(path.join(packageRoot,'src/commands/guide.mjs'),'utf8');
  assert.match(command,/\.engine\.run\('story\.guide'/);
  assert.doesNotMatch(command,/loadAcceptedStoryExecution|workflowGuide\(/);
  const presentation=ts.createSourceFile('phase-transition-routes.mjs',await readFile(path.join(packageRoot,'src/phase-transition-routes.mjs'),'utf8'),ts.ScriptTarget.Latest,true);
  const transition=presentation.statements.find(node=>ts.isFunctionDeclaration(node)&&node.name?.text==='convergenceTransitionRoute');
  assert.match(transition.getText(presentation),/convergenceTransitionPlan\(/);
  assert.doesNotMatch(transition.getText(presentation),/generationPublications|record\.sha256|recorded =/);
});

test('native submission and approval keep admission outside shared kernel state mutations',async()=>{
  const read=relative=>readFile(path.join(packageRoot,relative),'utf8');
  const submission=await read('src/engine-compatibility/submission-transition.mjs');
  assert.match(submission,/beginPhaseSubmission\(phase, nowIso\(\)\)/);
  assert.match(submission,/applyPhaseSubmissionDisposition\(phase, \{reviewableFailure,applicationReviewPending,waiver\}\)/);
  assert.doesNotMatch(submission,/phase\.status\s*=(?!=)|phase\.approvalWaiver\s*=/);
  const approvalSource=await read('src/engine-compatibility/approval-transition.mjs');
  const ast=ts.createSourceFile('approval-transition.mjs',approvalSource,ts.ScriptTarget.Latest,true);
  const approval=ast.statements.find(node=>ts.isFunctionDeclaration(node)&&node.name?.text==='approveNativePhase');
  assert.match(approval.getText(ast),/recordPhaseApprovalState\(phase,decision,\{key,reached\}\)/);
  assert.doesNotMatch(approval.getText(ast),/phase\.approvals\.push\(|phase\.status\s*=(?!=)/);
  const shim=ts.createSourceFile('lifecycle-transitions.mjs',await read('src/lifecycle-transitions.mjs'),ts.ScriptTarget.Latest,true);
  assert.ok(shim.statements.every(node=>ts.isExportDeclaration(node)));
  const core=await read('src/kernel/lifecycle-transitions.mjs');
  assert.doesNotMatch(core,/singularity-flow|copilot|readFile|saveWorkflow/);
});

test('native publication preserves admission, clock and accepted-write checkpoints around pure aggregate updates', async () => {
  const source = await readFile(path.join(packageRoot, 'src/engine-compatibility/generation-publication.mjs'), 'utf8');
  const ast = ts.createSourceFile('generation-publication.mjs', source, ts.ScriptTarget.Latest, true);
  const calls = [];
  const visit = node => {
    if (ts.isCallExpression(node)) calls.push({ name: node.expression.getText(ast), node });
    ts.forEachChild(node, visit);
  };
  visit(ast);
  const call = name => {
    const found = calls.find(entry => entry.name === name);
    assert.ok(found, name);
    return found.node;
  };
  const begin = call('beginGenerationPublication');
  for (const name of ['assertStoryNotArchived', 'assertPhaseAgentMayMutate', 'assertNoPendingPublication',
    'assertPhaseSequence', 'assertProducerAllowed', 'assertPhasePublicationReadiness', 'assertAstLifecycleGate']) {
    assert.ok(call(name).pos < begin.pos, name + ' must precede aggregate changes');
  }
  const clock = calls.find(entry => entry.name === 'nowIso' && entry.node.pos > begin.pos).node;
  assert.ok(begin.end < clock.pos && clock.end < call('appendGenerationAuthorship').pos);
  const receipt = call('codeDeliveryPublicationReceipt');
  const acceptedWrite = calls.find(entry => entry.name === 'writeJson'
    && entry.node.arguments[0]?.getText(ast) === 'path.join(root, receiptPath)').node;
  assert.ok(ts.isAwaitExpression(acceptedWrite.parent), 'delivery receipt must be accepted before its live binding');
  assert.ok(receipt.end < acceptedWrite.pos && acceptedWrite.end < call('recordCodeDeliveryPublication').pos);
  assert.ok(call('persistAstLifecycleReceipt').end < call('recordGenerationAstGate').pos);
  assert.ok(call('recordPhaseTelemetry').end < call('recordGenerationTelemetry').pos);
  assert.ok(call('createAgentBriefs').end < call('recordGenerationAgentBriefs').pos);
  assert.ok(call('catalogArtifactSet').end < call('recordGenerationArtifactSet').pos);
  assert.ok(call('validatePhase').end < call('recordGenerationPublication').pos);
  assert.ok(call('recordGenerationPublication').end < call('persistGenerationPublicationRecord').pos);
  assert.ok(call('persistGenerationPublicationRecord').end < call('saveWorkflow').pos);
  assert.doesNotMatch(source, /phase\.(?:deliveryEvidence|generationPublications|authorship|artifactSet|astGates|clarifications|markers|agentBriefs|telemetry)\s*=/);
});

test('native sequence and role adapters render shared admission while confirmations remain host-scoped', async () => {
  const read = relative => readFile(path.join(packageRoot, relative), 'utf8');
  const sequence = await read('src/sequence.mjs'), actor = await read('src/phase-transition-routes.mjs');
  const ast = ts.createSourceFile('sequence.mjs', sequence, ts.ScriptTarget.Latest, true);
  const find = name => ast.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === name).getText(ast);
  assert.match(find('evaluateSequence'), /sequenceAdmission\(workflow/);
  assert.doesNotMatch(find('evaluateSequence'), /workflow\.pendingDecision|workflow\.status|allowedStatuses\.includes/);
  assert.match(find('applySequenceDecision'), /applyConfirmedSequenceState\(next, phase, decision, at\)/);
  assert.doesNotMatch(find('applySequenceDecision'), /\.status\s*=|\.approvals\?/);
  assert.match(find('withConfirmationPort'), /confirmationPorts\.run\(/);
  assert.doesNotMatch(sequence, /activeConfirmationPort|function switchCurrentPhase|function reconcileStatus/);
  assert.match(actor, /phaseAgentMutationFacts\(/); assert.doesNotMatch(actor, /export function readOnlyAgent|SOURCE_REVIEW_REVIEWER_CANNOT_/);
  const alias = ts.createSourceFile('phase-actor-policy.mjs', await read('src/phase-actor-policy.mjs'), ts.ScriptTarget.Latest, true);
  assert.ok(alias.statements.every(ts.isExportDeclaration));
  const config = await read('src/kernel/workflow-configuration.mjs'), review = await read('src/source-review-policy.mjs');
  assert.match(config, /assertSourceReviewerAvailable, normalizeSourceReviewPolicy.*\.\/phase-admission\.mjs/);
  assert.doesNotMatch(review, /function normalizeSourceReviewPolicy|function assertSourceReviewerAvailable/);
  const simulation = await read('src/workflow-lifecycle-simulation.mjs');
  assert.match(simulation, /sequenceAdmission as evaluateSequence/); assert.doesNotMatch(simulation, /from '\.\/sequence\.mjs'/);
  const identity = await read('src/build-identity.mjs'), manifest = await read('src/vsix-source-manifest.mjs');
  for (const name of ['kernel/lifecycle-transitions.mjs','kernel/phase-admission.mjs','kernel/workflow-configuration.mjs','kernel/configuration-policy.mjs']) {
    assert.ok(identity.includes("'" + name + "'"), name + ' must invalidate advisory snapshots');
    assert.ok(manifest.includes("'src/" + name + "'"), name + ' must be present in staged CLI payloads');
  }
});

test('native publication dependencies use the shared compiled worklist and close every required observation', async () => {
  const text = await readFile(path.join(packageRoot, 'src/phase-publication-readiness.mjs'), 'utf8');
  assert.match(text, /phasePublicationDependencyInspection\(workflow, phase, \{ producer, generation, agent \}\)/);
  assert.match(text, /inspection\.observe\(/); assert.match(text, /inspection\.finish\(\)/);
  for (const id of ['appeal','design-source','visual-coverage']) assert.ok(text.includes("inspection.requires('" + id + "')"));
  assert.doesNotMatch(text, /producer === 'governed-agent'|isVisualVerificationPhase\(|workflow\.phaseAppeals !==/);
  assert.match(text, /clarificationCheck\.retainObservedRecord/);
  assert.match(text, /const decision = judgement \?\? judge\(id, errors, \{ code \}\)/);
  assert.match(text, /if \(!decision\.blocked\) return/);
  for (const code of ['PHASE_INPUTS_NOT_READY','PHASE_CLARIFICATION_NOT_READY','MCP_EVIDENCE_REQUIRED','VISUAL_COVERAGE_FAILED']) {
    assert.equal(text.includes("'" + code + "'"), false, code + ' must retain one kernel default');
  }
});

test('workflow compilation and routing simulation use the pure interpreter while native rendering and pending hashes stay outside it', async () => {
  const core = await readFile(path.join(packageRoot, 'src/kernel/workflow-decisions.mjs'), 'utf8');
  assert.doesNotMatch(core, /singularity-flow|createHash|canonicalJson|applicabilityStatus|describeWhen|describeOutcome|parseDecisionAssignments|storyDecisionView/);
  for (const file of ['kernel/workflow-configuration.mjs', 'workflow-route-simulation.mjs', 'phase-retention.mjs']) {
    const source = await readFile(path.join(packageRoot, 'src', file), 'utf8');
    if (file.startsWith('kernel/')) assert.match(source, /from '\.\/workflow-decisions\.mjs'/, file);
    else {
      assert.match(source, /from '\.\/kernel\/workflow-decisions\.mjs'/, file);
      assert.doesNotMatch(source, /from '\.\/workflow-decisions\.mjs'/, file);
    }
  }
  const native = ts.createSourceFile('workflow-decisions.mjs', await readFile(path.join(packageRoot, 'src/workflow-decisions.mjs'), 'utf8'), ts.ScriptTarget.Latest, true);
  const functions = new Map(native.statements.filter(ts.isFunctionDeclaration).map(node => [node.name.text, node.getText(native)]));
  assert.equal(functions.has('normalizeDecisions'), false);
  assert.equal(functions.has('chooseRoute'), false);
  assert.match(functions.get('decisionOutcome'), /decisionOutcomeFacts\(workflow, phase\)/);
  assert.match(functions.get('pendingDecisionRecord'), /pendingDecisionPayload\(workflow, phase, outcome, \{ at \}\)/);
  assert.match(functions.get('resolveDecisionChoice'), /resolveDecisionChoicePlan\(workflow, pending/);
  const alias = ts.createSourceFile('decision-inputs.mjs', await readFile(path.join(packageRoot, 'src/kernel/decision-inputs.mjs'), 'utf8'), ts.ScriptTarget.Latest, true);
  assert.ok(alias.statements.every(ts.isExportDeclaration));
});

test('rejection host uses the registry and only the compatibility aggregate calls its native transition', async () => {
  const cli = ts.createSourceFile('cli.mjs', await readFile(path.join(packageRoot, 'src/cli.mjs'), 'utf8'), ts.ScriptTarget.Latest, true);
  const command = cli.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'rejectCommand');
  assert.ok(command.getText(cli).includes("binding.engine.run('phase.reject'"));
  const forbidden = new Set(['transactStory','rejectPhase','rejectNativePhase','activateWorkItemSession']);
  const check = node => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) assert.equal(forbidden.has(node.expression.text), false, node.expression.text);
    ts.forEachChild(node, check);
  }; check(command);
  const writers = [];
  for (const file of await sourceFiles('src')) {
    const source = ts.createSourceFile(file, await readFile(path.join(packageRoot, file), 'utf8'), ts.ScriptTarget.Latest, true);
    const visit = node => {
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'rejectNativePhase') writers.push(file);
      ts.forEachChild(node, visit);
    }; visit(source);
  }
  assert.deepEqual(writers, ['src/state.mjs']);
});

test('extracted native decision writers do not import command handlers or host presentation',async()=>{
  const owners=['native-story-decisions.mjs','native-plan-decisions.mjs','native-obligation-risk.mjs',
    'native-evidence-decisions.mjs','native-visual-decisions.mjs','native-test-command-decisions.mjs',
    'native-test-narrowing-decisions.mjs','native-test-risk-decisions.mjs','native-upstream-decisions.mjs','native-witness-decisions.mjs','git-plan-correction.mjs',
    'git-decisions.mjs','git-decision-record.mjs','git-test-decision-record.mjs','record-decision-context.mjs',
    'test-decision-intent.mjs','git-advancement.mjs','convergence-projection-read.mjs',
    'git-upstream.mjs','native-forward-amendments.mjs','upstream-artifact-issues.mjs',
    'git-query.mjs','git-workflow-assets.mjs','git-phase-review.mjs','native-phase-review.mjs','git-document-read.mjs','native-document-references.mjs',
    'git-phase-entry.mjs','native-phase-entry.mjs','native-convergence.mjs','story-draft-transaction.mjs'];
  const problems=[];
  for(const name of owners) {
    const file=path.join(packageRoot,'src/engine-compatibility',name);
    const source=ts.createSourceFile(file,await readFile(file,'utf8'),ts.ScriptTarget.Latest,true);
    const visit=node=>{
      const specifier=(ts.isImportDeclaration(node)||ts.isExportDeclaration(node))?node.moduleSpecifier
        :ts.isCallExpression(node)&&node.expression.kind===ts.SyntaxKind.ImportKeyword?node.arguments[0]:null;
      if(specifier&&ts.isStringLiteralLike(specifier)) {
        const target=path.resolve(path.dirname(file),specifier.text);
        if(target.startsWith(path.join(packageRoot,'src/commands')+path.sep)
          || target===path.join(packageRoot,'src/phase-post-transition-guidance.mjs'))problems.push(`${name}: ${specifier.text}`);
      }
      ts.forEachChild(node,visit);
    };visit(source);
  }
  assert.deepEqual(problems,[],'native decisions return local effect reports; command helpers only project them');
});

test('the upstream host owns grammar and presentation, with no direct writer or admission path',async()=>{
  const source=await readFile(path.join(packageRoot,'src/commands/upstream-issue.mjs'),'utf8');
  assert.match(source,/binding\.engine\.run\(operations\[action\],input\)/);
  assert.doesNotMatch(source,/loadAcceptedStoryExecution|actionActor|loadSession|transactStory|readFile|readdir/);
  const ast=ts.createSourceFile('upstream-issue.mjs',source,ts.ScriptTarget.Latest,true);
  for(const node of ast.statements.filter(node=>ts.isImportDeclaration(node))) {
    assert.doesNotMatch(node.moduleSpecifier.text,/native-upstream-decisions|state-stores/);
  }
});

test('phase show uses the registry and keeps terminal consent in its host',async()=>{
  const source=await readFile(path.join(packageRoot,'src/commands/phase-show.mjs'),'utf8');
  assert.match(source,/binding\.engine\.run\('phase.review'/);
  assert.doesNotMatch(source,/loadAcceptedStoryExecution|phaseReview\(|readFile|actionActor|transactStory/);
  assert.match(source,/recordTerminalReview\(root, terminalReviewBinding\(workflow, phase\)\)/);
  const alias=await readFile(path.join(packageRoot,'src/commands/shared/phase-review.mjs'),'utf8');
  assert.match(alias,/export \{phaseReview\} from '\.\.\/\.\.\/engine-compatibility\/native-phase-review.mjs'/);
});

test('document view owns grammar and rendering, with a single registered byte-read operation',async()=>{
  const source=await readFile(path.join(packageRoot,'src/commands/documents-view.mjs'),'utf8');
  assert.match(source,/binding\.engine\.run\('document.read'/);
  assert.doesNotMatch(source,/loadAcceptedStoryExecution|viewDocument\(|readFile|recordTerminalReview|transactStory/);
  const cli=ts.createSourceFile('cli.mjs',await readFile(path.join(packageRoot,'src/cli.mjs'),'utf8'),ts.ScriptTarget.Latest,true);
  const documents=cli.statements.find(node=>ts.isFunctionDeclaration(node)&&node.name?.text==='documentsCommand');
  assert.match(documents.body.getText(cli),/subcommand === 'view'\) return \(await import\('\.\/commands\/documents-view.mjs'\)\)/);
  assert.doesNotMatch(documents.body.getText(cli),/await viewDocument\(/);
});

test('entry wrappers use the registry; native composition does not decide admission or plan readiness',async()=>{
  for(const file of ['src/phase-entry.mjs','src/phase-entry-authoring.mjs']) {
    const source=await readFile(path.join(packageRoot,file),'utf8');
    assert.match(source,/binding\.engine\.run\('phase.enter'/);
    assert.doesNotMatch(source,/recoveryPlan\(|composePhasePrompt\(|verifyClarificationRecord\(|resumeWorkflowTask\(/);
  }
  const native=await readFile(path.join(packageRoot,'src/engine-compatibility/native-phase-entry.mjs'),'utf8');
  assert.doesNotMatch(native,/phaseContextAdmission\(|const preparationAdmitted =|const authoringAllowed =|const status =/);
  assert.match(native,/const \{preparationAdmitted,status\} = plan/);
  const inputs=await readFile(path.join(packageRoot,'src/phase-input-policy.mjs'),'utf8');
  assert.match(inputs,/export \{workflowInputsMode,resolvedPhaseInputs,approvedInputPhases\} from '\.\/kernel\/phase-inputs.mjs'/);
});

test('configuration and SKP validation use pure clarification policy instead of native record I/O',async()=>{
  for(const file of ['src/kernel/workflow-configuration.mjs','src/kernel/skill-phase-contract.mjs']) {
    const source=await readFile(path.join(packageRoot,file),'utf8');
    assert.match(source,/import \{\s*normalizeClarificationPolicy\s*\} from '\.\/(?:kernel\/)?phase-inputs.mjs'/);
    assert.doesNotMatch(source,/from '\.\/clarifications.mjs'/);
  }
});

test('the installed configuration adapter composes one compiler and keeps runtime loading outside the kernel',async()=>{
  const compiler=await readFile(path.join(packageRoot,'src/kernel/workflow-configuration.mjs'),'utf8');
  const adapter=await readFile(path.join(packageRoot,'src/config.mjs'),'utf8');
  assert.match(adapter,/createWorkflowConfigurationCompiler\(\{/);
  assert.doesNotMatch(adapter,/function (resolveWorkType|normalizePlannedClaimsPolicy)\(/);
  const ast=ts.createSourceFile('config.mjs',adapter,ts.ScriptTarget.Latest,true);
  const projection=ast.statements.find(node=>ts.isFunctionDeclaration(node)&&node.name?.text==='validateDefinition');
  assert.equal(projection.body.statements.length,1,'the adapter only forwards the call and projects errors');
  const attempt=projection.body.statements[0];assert.ok(ts.isTryStatement(attempt));
  assert.equal(attempt.tryBlock.statements.length,1);
  assert.equal(attempt.tryBlock.statements[0].expression.getText(ast),'Reflect.apply(validateDefinitionCore, undefined, arguments)');
  const calls=[];
  const visit=node=>{if(ts.isCallExpression(node))calls.push(node.expression.getText(ast));ts.forEachChild(node,visit);};
  visit(projection);
  assert.deepEqual(calls.sort(),['Reflect.apply','error.code.startsWith','requireCommitPolicyRuntime','requireCommitPolicyRuntime().rcpFailure'].sort());
  assert.equal(attempt.catchClause.block.statements.at(-1).expression.getText(ast),'error');
  assert.match(adapter,/createRequire\(path\.join\(PACKAGE_ROOT/);
  assert.doesNotMatch(compiler,/createRequire|process\.features|PACKAGE_ROOT|readFile|run\(/);
  assert.match(compiler,/definition\.git\.commitPolicy = normalizeCommitPolicyRuntime\(/);
  const consumers=[];
  for(const file of await sourceFiles('src')) {
    const ast=ts.createSourceFile(file,await readFile(path.join(packageRoot,file),'utf8'),ts.ScriptTarget.Latest,true);
    for(const node of ast.statements.filter(ts.isImportDeclaration)) {
      const bindings=node.importClause?.namedBindings;
      if(bindings&&ts.isNamedImports(bindings)&&bindings.elements.some(binding=>(binding.propertyName??binding.name).text==='createWorkflowConfigurationCompiler'))consumers.push(file);
    }
  }
  assert.deepEqual(consumers,['src/config.mjs','src/kernel/namespace-configuration.mjs']);
  const alias=ts.createSourceFile('phase-overrides.mjs',await readFile(path.join(packageRoot,'src/phase-overrides.mjs'),'utf8'),ts.ScriptTarget.Latest,true);
  assert.ok(alias.statements.every(ts.isExportDeclaration));
  for(const file of ['src/workflow-intent-catalog.mjs','src/workflow-intent-capabilities.mjs']) {
    const source=await readFile(path.join(packageRoot,file),'utf8');
    assert.match(source,/'kernel\/workflow-configuration\.mjs'/,file);
    assert.match(source,/'kernel\/configuration-policy\.mjs'/,file);
  }
});

test('configuration policy rules have one pure owner while native runtime and rendering stay outside it',async()=>{
  const core=await readFile(path.join(packageRoot,'src/kernel/configuration-policy.mjs'),'utf8');
  const compiler=await readFile(path.join(packageRoot,'src/kernel/workflow-configuration.mjs'),'utf8');
  assert.match(compiler,/from '\.\/configuration-policy\.mjs'/);
  assert.doesNotMatch(core,/from ['"]node:|createHash|process\.|formatCommandRouteLines|contextBoundaryHandoff|readRecord|testRuntimeEnvironment|tokenEconomyDigest/);
  const files=['session-policy','template-catalog','intelligence-policy','model-tasks','harness-import-policy','document-storage-policy'];
  for(const name of files) {
    const ast=ts.createSourceFile(name+'.mjs',await readFile(path.join(packageRoot,'src',name+'.mjs'),'utf8'),ts.ScriptTarget.Latest,true);
    assert.ok(ast.statements.every(ts.isExportDeclaration),name+' must retain aliases only');
  }
  for(const [file,rule,native]of [['context-policy','normalizeContextPolicy','contextBoundaryHandoff'],
    ['test-runtime','normalizeTestRuntime','testRuntimeEnvironment'],['token-economy','normalizeTokenEconomy','tokenEconomyDigest'],
    ['specifications','normalizeSpecPolicy','buildSpecIndex'],['code-delivery-policy','normalizeCodeDeliveryPolicy','codeOutcomeReviewOffer'],
    ['engine-compatibility/rejection-transition','normalizeReworkLoops','consumeRepairAttempt']]) {
    const source=await readFile(path.join(packageRoot,'src',file+'.mjs'),'utf8');
    assert.equal(source.includes('function '+rule+'('),false,file);
    assert.equal(source.includes('function '+native+'('),true,file);
  }
});

test('execution and integration rules stay in kernel modules while native adapters retain effects',async()=>{
  const modules=['auto-policy','adhoc-policy','mcp-policy','step-action-policy'];
  const identity=await readFile(path.join(packageRoot,'src/build-identity.mjs'),'utf8');
  const manifest=await readFile(path.join(packageRoot,'src/vsix-source-manifest.mjs'),'utf8');
  for(const name of modules){
    const source=await readFile(path.join(packageRoot,'src/kernel',name+'.mjs'),'utf8');
    assert.doesNotMatch(source,/from ['"]node:|createHash|process\.|readFile|fetch\(|rpcSmoke|renderMcpPromptPolicy|stepActionDeliveryKey|buildStepActionEvent/);
    assert.ok(identity.includes("'kernel/"+name+".mjs'"),name+' identity');
    assert.ok(manifest.includes("'src/kernel/"+name+".mjs'"),name+' staged payload');
    for(const file of ['workflow-intent-catalog.mjs','workflow-intent-capabilities.mjs']){
      assert.ok((await readFile(path.join(packageRoot,'src',file),'utf8')).includes("'kernel/"+name+".mjs'"),name+' interpretation identity');
    }
  }
  for(const file of ['src/auto/auto-policy.mjs','src/adhoc/policy.mjs']){
    const ast=ts.createSourceFile(file,await readFile(path.join(packageRoot,file),'utf8'),ts.ScriptTarget.Latest,true);
    assert.ok(ast.statements.every(ts.isExportDeclaration),file+' aliases');
  }
  for(const [file,moved,retained]of [['mcp','normalizeMcpServers','renderMcpPromptPolicy'],['step-actions','normalizeIntegrations','stepActionDeliveryKey']]){
    const source=await readFile(path.join(packageRoot,'src',file+'.mjs'),'utf8');
    assert.equal(source.includes('function '+moved+'('),false,file);
    assert.equal(source.includes('function '+retained+'('),true,file);
  }
});

test('generation begin uses registry coordination and a native transaction, without a command-layer persistence owner',async()=>{
  const host=await readFile(path.join(packageRoot,'src/commands/phase-lifecycle.mjs'),'utf8');
  const source=ts.createSourceFile('phase-lifecycle.mjs',host,ts.ScriptTarget.Latest,true);
  const begin=source.statements.find(node=>ts.isFunctionDeclaration(node)&&node.name?.text==='phaseBeginCommand');
  assert.ok(begin);assert.match(begin.getText(source),/\.engine\.run\('phase\.begin'/u);
  assert.doesNotMatch(begin.getText(source),/\b(beginPhaseGeneration|saveStoryDraft|storyDraftTransaction|verifyOpenGenerationIntent)\s*\(/u);
  const aggregate=await readFile(path.join(packageRoot,'src/state.mjs'),'utf8');
  const parsed=ts.createSourceFile('state.mjs',aggregate,ts.ScriptTarget.Latest,true);
  const legacy=parsed.statements.find(node=>ts.isFunctionDeclaration(node)&&node.name?.text==='beginPhaseGeneration');
  assert.ok(legacy);assert.match(legacy.body.getText(parsed),/beginNativePhaseGeneration/u);
  assert.doesNotMatch(legacy.body.getText(parsed),/\bbeginCodeGeneration\s*\(/u);
});

test('prepublish host delegates one inspection and the native checker shares its pure readiness rule',async()=>{
  const host=await readFile(path.join(packageRoot,'src/commands/phase-lifecycle.mjs'),'utf8');
  const source=ts.createSourceFile('phase-lifecycle.mjs',host,ts.ScriptTarget.Latest,true);
  const check=source.statements.find(node=>ts.isFunctionDeclaration(node)&&node.name?.text==='phasePrepublishCommand');
  assert.ok(check);assert.match(check.getText(source),/\.engine\.run\('phase\.prepublish'/u);
  assert.doesNotMatch(check.getText(source),/\b(phasePrepublish|loadSession|loadAcceptedStoryExecution|readWorkflowTaskResume)\s*\(/u);
  const native=await readFile(path.join(packageRoot,'src/phase-prepublish.mjs'),'utf8');
  assert.match(native,/const ready = phasePrepublishReady\(/u);
  const compatibility=await readFile(path.join(packageRoot,'src/phase-finding-policy.mjs'),'utf8');
  assert.match(compatibility,/export \{phaseFindingCode,phaseFindingIdentity,phaseFindingPolicy,isArtifactQualityFinding\} from '\.\/kernel\/phase-findings\.mjs'/u);
});

test('draft-check host uses registry inspection and shares the installed pure draft-health rule',async()=>{
  const host=await readFile(path.join(packageRoot,'src/commands/phase-lifecycle.mjs'),'utf8');
  const source=ts.createSourceFile('phase-lifecycle.mjs',host,ts.ScriptTarget.Latest,true);
  const check=source.statements.find(node=>ts.isFunctionDeclaration(node)&&node.name?.text==='phaseDraftCheckCommand');
  assert.ok(check);assert.match(check.getText(source),/\.engine\.run\('phase\.draft-check'/u);
  assert.doesNotMatch(check.getText(source),/\b(phaseDraftCheck|loadSession|loadAcceptedStoryExecution|readWorkflowTaskResume)\s*\(/u);
  const native=await readFile(path.join(packageRoot,'src/phase-draft-check.mjs'),'utf8');
  assert.match(native,/const clean = phaseDraftCheckReady\(/u);
  assert.doesNotMatch(host,/import \{ phaseDraftCheck \} from/u);
});

test('phase-input hosts delegate preparation and byte inspection while presentation contains no file reads',async()=>{
  const host=await readFile(path.join(packageRoot,'src/commands/inputs.mjs'),'utf8');
  const source=ts.createSourceFile('inputs.mjs',host,ts.ScriptTarget.Latest,true);
  const command=source.statements.find(node=>ts.isFunctionDeclaration(node)&&node.name?.text==='inputsCommand');
  assert.match(command.getText(source),/\.engine\.run\('phase\.inputs'/u);
  assert.doesNotMatch(command.getText(source),/\b(preparePhaseInputs|saveStoryDraft|storyDraftTransaction|phaseInputArtifacts)\s*\(/u);
  const presentation=await readFile(path.join(packageRoot,'src/phase-input-presentation.mjs'),'utf8');
  assert.doesNotMatch(presentation,/node:(?:fs|crypto)|\breadFile\s*\(/u);
  assert.match(presentation,/export \{ phaseInputArtifacts \} from '\.\/inputs\.mjs'/u);
});

test('rollover host delegates inspection and mutation to the registry, retaining only command projection',async()=>{
  const host=await readFile(path.join(packageRoot,'src/commands/phase-lifecycle.mjs'),'utf8');
  const source=ts.createSourceFile('phase-lifecycle.mjs',host,ts.ScriptTarget.Latest,true);
  const rollover=source.statements.find(node=>ts.isFunctionDeclaration(node)&&node.name?.text==='phaseRolloverCommand');
  assert.ok(rollover);assert.match(rollover.getText(source),/\.engine\.run\('phase\.rollover'/u);
  assert.doesNotMatch(host,/\b(loadAcceptedStoryExecution|generationRecovery|beginPhaseGeneration|saveStoryDraft|storyDraftTransaction|verifyOpenGenerationIntent)\s*\(/u);
  assert.doesNotMatch(host,/import.*(?:state-stores|generation-boundary|accepted-story-execution)\.mjs/u);
});

test('preparation hosts share the registry and cannot directly load or write phase state',async()=>{
  for(const relative of ['src/commands/prepare.mjs','src/commands/shared/prepare-configured-phase.mjs']) {
    const host=await readFile(path.join(packageRoot,relative),'utf8');
    assert.match(host,/\.engine\.run\('phase\.prepare'/u,relative);
    assert.doesNotMatch(host,/\b(loadAcceptedStoryExecution|preparePhase|saveStoryDraft|storyDraftTransaction|prepareDeterministicConvergence)\s*\(/u,relative);
    assert.doesNotMatch(host,/import.*(?:state-stores|accepted-story-execution)\.mjs/u,relative);
  }
});

test('native transition extraction keeps every operation binding declared',async()=>{
  const files=[...await sourceFiles('src/engine-compatibility'),...await sourceFiles('src/engine-sdk'),
    ...await sourceFiles('src/kernel'),'src/state.mjs'].map(file=>path.join(packageRoot,file));
  const program=ts.createProgram(files,{allowJs:true,checkJs:true,noResolve:true,types:[],target:ts.ScriptTarget.ESNext});
  const missing=program.getSemanticDiagnostics().filter(diagnostic=>diagnostic.code===2304
    && !/Cannot find name '(?:process|Buffer|NodeJS)'/.test(ts.flattenDiagnosticMessageText(diagnostic.messageText,' ')))
    .map(diagnostic=>`${path.relative(packageRoot,diagnostic.file.fileName)}:${diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start).line+1}: ${ts.flattenDiagnosticMessageText(diagnostic.messageText,' ')}`);
  assert.deepEqual(missing,[],'an extracted transition lost a required binding');
});

test('standalone decision adapters do not duplicate admission or import native decision writers',async()=>{
  const cli=ts.createSourceFile('cli.mjs',await readFile(path.join(packageRoot,'src/cli.mjs'),'utf8'),ts.ScriptTarget.Latest,true);
  const names=['decisionScopeCommand','decisionCompletenessCommand','decisionApplicabilityCommand','decisionRiskCommand','decisionChooseCommand'];
  for(const name of names) {
    const node=cli.statements.find(node=>ts.isFunctionDeclaration(node)&&node.name?.text===name);
    assert.ok(node,name);
    assert.match(node.body.getText(cli),/import\('\.\/commands\/decision-record\.mjs'\)/);
    assert.doesNotMatch(node.body.getText(cli),/loadAcceptedStoryExecution|loadConfig|transactStory|commitScope|commitRouting/,
      `${name} bypasses the registered operation`);
  }
  const witness=cli.statements.find(node=>ts.isFunctionDeclaration(node)&&node.name?.text==='decisionWitnessCommand');
  assert.match(witness.body.getText(cli),/import\('\.\/commands\/decision-witness\.mjs'\)/);
  for(const file of ['decision-witness','decision-witness-exception']) {
    const source=await readFile(path.join(packageRoot,`src/commands/${file}.mjs`),'utf8');
    assert.doesNotMatch(source,/loadAcceptedStoryExecution|loadConfig|checkoutStoryBranch|actionActor|loadSession|transactStory|recordPublishedWitness|recordWitnessExceptionRenewal/);
    assert.match(source,/binding\.engine\.run\(/);
  }
  const plan=cli.statements.find(node=>ts.isFunctionDeclaration(node)&&node.name?.text==='decisionPlanCommand');
  assert.match(plan.body.getText(cli),/import\('\.\/commands\/decision-plan\.mjs'\)/);
  for(const file of ['decision-plan','plan-correction']) {
    const source=await readFile(path.join(packageRoot,`src/commands/${file}.mjs`),'utf8');
    assert.doesNotMatch(source,/loadAcceptedStoryExecution|checkoutStoryBranch|transactStory|recordPlanRowCorrection|commitPlanAmendment|loadBoundActiveSpecRecords|requireApprovalAuthority/);
    assert.match(source,/binding\.engine\.run\(/);
  }
  const adapter=await readFile(path.join(packageRoot,'src/commands/decision-record.mjs'),'utf8');
  assert.doesNotMatch(adapter,/native-story-decisions|native-obligation-risk|loadAcceptedStoryExecution|checkoutStoryBranch|transactStory/);
  assert.match(adapter,/binding\.engine\.run\(operation,/);
  for(const [file,name] of [['decision-evidence-reuse','decisionEvidenceReuseCommand'],
    ['decision-visual-profile','decisionVisualProfileCommand'],['decision-test-narrowing','decisionTestNarrowingCommand'],
    ['decision-test-risk','decisionTestRiskCommand'],['decision-test-command','decisionTestCommandCommand']]) {
    const source=ts.createSourceFile(file,await readFile(path.join(packageRoot,`src/commands/${file}.mjs`),'utf8'),ts.ScriptTarget.Latest,true);
    const node=source.statements.find(node=>ts.isFunctionDeclaration(node)&&node.name?.text===name);
    assert.ok(node,name);
    assert.match(node.body.getText(source),/executeTestDecision\(/);
    assert.doesNotMatch(node.body.getText(source),/loadAcceptedStoryExecution|loadConfig|checkoutStoryBranch|actionActor|loadSession|transactStory|await record/);
  }
  const testAdapter=await readFile(path.join(packageRoot,'src/commands/shared/test-decision-operation.mjs'),'utf8');
  assert.match(testAdapter,/binding\.engine\.run\(operation,/);
  assert.doesNotMatch(testAdapter,/native-.*decisions|loadAcceptedStoryExecution|transactStory/);
});

test('decision effect and combined-approval coordinators import native recorders instead of commands',async()=>{
  const problems=[];
  for(const relative of ['src/engine-compatibility/git-decisions.mjs','src/approval-decisions.mjs']) {
    const file=path.join(packageRoot,relative);
    const source=ts.createSourceFile(file,await readFile(file,'utf8'),ts.ScriptTarget.Latest,true);
    const visit=node=>{
      const specifier=ts.isImportDeclaration(node)?node.moduleSpecifier
        :ts.isCallExpression(node)&&node.expression.kind===ts.SyntaxKind.ImportKeyword?node.arguments[0]:null;
      if(specifier&&ts.isStringLiteralLike(specifier)
        && path.resolve(path.dirname(file),specifier.text).startsWith(path.join(packageRoot,'src/commands')+path.sep)) {
        problems.push(`${relative}: ${specifier.text}`);
      }
      ts.forEachChild(node,visit);
    };visit(source);
  }
  assert.deepEqual(problems,[],'decision writes must not execute command parsing or presentation');
});

test('application surfaces cannot bypass the revisioned state-store boundary', async () => {
  const domainBoundaryFiles = new Set([
    'src/state.mjs',
    'src/initiative-state.mjs',
    'src/state-stores.mjs',
    'src/projectors.mjs',
    // Epic source generators are loaded while Initiative configuration is
    // initialized, before state-stores can safely be evaluated. It is a domain
    // collaborator, not an application surface; its draft save remains explicit.
    'src/epic-sources.mjs',
    // Read-only domain projection. This legacy source contains byte-preserved
    // evidence separators and never imports either raw save primitive.
    'src/initiative-impact.mjs'
  ]);
  const sourceGateways = (await sourceFiles('src'))
    .filter((relative) => !domainBoundaryFiles.has(relative));
  const surfaceFiles = (await Promise.all([
    sourceFiles('apps'),
    sourceFiles('bin'),
    sourceFiles('plugin'),
    sourceFiles('scripts')
  ])).flat();

  const violations = [];
  for (const relative of [...sourceGateways, ...surfaceFiles]) {
    const content = await readFile(path.join(packageRoot, relative), 'utf8');
    if (RAW_STATE_IMPORT.test(content)) violations.push(relative);
  }

  assert.deepEqual(violations, [],
    'surfaces must load and mutate Story/Initiative aggregates through state-stores.mjs');
});

test('the revisioned store boundary does not expose raw persistence primitives', async () => {
  const content = await readFile(path.join(packageRoot, 'src/state-stores.mjs'), 'utf8');
  const exportBlocks = [...content.matchAll(/export\s*\{([^}]*)\}/gs)].map((match) => match[1]);
  assert.equal(exportBlocks.some((block) => /\bsaveWorkflow\b/.test(block)), false);
  assert.equal(exportBlocks.some((block) => /\bsaveInitiative\b/.test(block)), false);
  assert.match(content, /saveStoryDraft/);
  assert.match(content, /saveInitiativeDraft/);
});

test('aggregate extraction preserves the existing status and validation exports', async () => {
  const [aggregate, writer, validation] = await Promise.all([
    import('../src/state.mjs'), import('../src/story-state-write.mjs'), import('../src/story-state-validation.mjs')
  ]);
  for (const name of ['statusPath', 'storyStatusMarkdown', 'validateId', 'saveWorkflow']) {
    assert.equal(aggregate[name], writer[name], name);
    assert.equal(typeof aggregate[name], 'function', name);
  }
  assert.equal(aggregate.validateWorkflow, validation.validateWorkflow);
  assert.equal(typeof aggregate.validateWorkflow, 'function');
});

test('source code cannot hard-code a direct push to an application branch', async () => {
  const violations = [];
  for (const relative of await sourceFiles('src')) {
    const lines = (await readFile(path.join(packageRoot, relative), 'utf8')).split('\n');
    lines.forEach((line, index) => {
      if (/(?:\[['"]push['"]|pushBranch\()/.test(line)
        && /(?:refs\/heads\/|HEAD:)?(?:main|master)\b/.test(line)) {
        violations.push(`${relative}:${index + 1}`);
      }
    });
  }
  assert.deepEqual(violations, [], 'application branches may be resolved, but never literal push targets');
});

test('unscoped publishers guard before they stage or commit', async () => {
  // The World Model publishes only to its state branch (registered-v4); its application-branch
  // publisher went with legacy-v3.
  const publishers = [
    ['src/editor.mjs', 'export async function publishEditorConfiguration'],
    ['src/story-lineage.mjs', 'export async function attachStoryBranch']
  ];
  for (const [relative, marker] of publishers) {
    const content = await readFile(path.join(packageRoot, relative), 'utf8');
    const start = content.indexOf(marker);
    assert.notEqual(start, -1, `${relative} publisher exists`);
    const nextExport = content.indexOf('\nexport ', start + marker.length);
    const body = content.slice(start, nextExport < 0 ? content.length : nextExport);
    const guard = body.indexOf('assertNotDefaultBranch(');
    const mutation = Math.min(...['add(', "run('git', ['add'", 'saveStoryDraft(', 'commit(']
      .map((needle) => body.indexOf(needle)).filter((index) => index >= 0));
    assert.ok(guard >= 0 && guard < mutation, `${relative} must guard before its first mutation`);
  }
});


test('conformance rules are pure and native callers share the bound policy owner',async()=>{
  const owner='src/kernel/conformance-report.mjs',graph=await inspectPureModuleGraph({root:packageRoot,entries:[owner],
    allowed:[...await sourceFiles('src/foundation'),...await sourceFiles('src/kernel')]});
  assert.deepEqual(graph.problems,[]);
  const identity=await readFile(path.join(packageRoot,'src/build-identity.mjs'),'utf8'),manifest=await readFile(path.join(packageRoot,'src/vsix-source-manifest.mjs'),'utf8');
  assert.ok(identity.includes("'kernel/conformance-report.mjs'"));assert.ok(manifest.includes("'src/kernel/conformance-report.mjs'"));
  for(const file of await sourceFiles('src')){
    if(file==='src/conformance-verdicts.mjs')continue;
    const ast=ts.createSourceFile(file,await readFile(path.join(packageRoot,file),'utf8'),ts.ScriptTarget.Latest,true);
    for(const statement of ast.statements)if((ts.isImportDeclaration(statement)||ts.isExportDeclaration(statement))&&statement.moduleSpecifier?.text.startsWith('.')){
      assert.notEqual(path.posix.normalize(path.posix.join(path.posix.dirname(file),statement.moduleSpecifier.text)),'src/conformance-verdicts.mjs',file+' must use the owned policy');
    }
  }
});

test('targeted Code scope is read from original publications and human plans without selecting a writer or host',async()=>{
  const file='src/engine-storage/namespace-targeted-repair-reader.mjs',allowed=new Set(['../foundation/failures.mjs','../foundation/record-schema.mjs',
    '../kernel/conformance-decisions.mjs','../kernel/approval-policy.mjs','../kernel/publication-intent.mjs','../kernel/specification-policy.mjs',
    '../engine-compatibility/node-repository-plan.mjs','./namespace-specifications.mjs','./namespace-publication-reader.mjs',
    './namespace-submission-reader.mjs','./namespace-phase-check-reader.mjs']),ast=ts.createSourceFile(file,await readFile(path.join(packageRoot,file),'utf8'),ts.ScriptTarget.Latest,true);
  const visit=node=>{
    if(ts.isImportDeclaration(node))assert.ok(allowed.has(node.moduleSpecifier.text),node.moduleSpecifier.text);
    if(ts.isIdentifier(node)&&['process','require','eval','Function','createEngine','createNamespaceLifecycleCommitter','createNamespaceStoryObserver'].includes(node.text))assert.fail(file+' cannot discover a host or select admission or mutation');
    if(ts.isPropertyAccessExpression(node)&&['put','transact','commit','writeFile','unlink','spawn','spawnSync','run','start'].includes(node.name.text))assert.fail(file+' must remain read-only');
    if(ts.isCallExpression(node)&&node.expression.kind===ts.SyntaxKind.ImportKeyword)assert.fail(file+' cannot discover infrastructure');
    ts.forEachChild(node,visit);
  };visit(ast);
});

test('human conformance rules stay pure and conditional human writes have one explicit namespace owner',async()=>{
  const rule='src/kernel/conformance-decisions.mjs',pure=await inspectPureModuleGraph({root:packageRoot,entries:[rule],
    allowed:[...await sourceFiles('src/kernel'),...await sourceFiles('src/foundation')]});assert.deepEqual(pure.problems,[]);
  const writer='src/engine-storage/namespace-human-decision.mjs',contract='src/engine-storage/namespace-human-decision-contract.mjs',
    reader='src/engine-storage/namespace-human-decision-reader.mjs',owners=new Set([writer,reader,
      'src/engine-storage/namespace-conformance-decisions.mjs','src/engine-storage/namespace-conformance-decision-reader.mjs','src/engine-storage/namespace-rejection.mjs','src/engine-storage/namespace-rejection-reader.mjs']);
  for(const file of [writer,contract,reader,...owners]){
    const text=await readFile(path.join(packageRoot,file),'utf8'),ast=ts.createSourceFile(file,text,ts.ScriptTarget.Latest,true);
    const visit=node=>{
      if(ts.isImportDeclaration(node))assert.doesNotMatch(node.moduleSpecifier.text,/node:(?:fs|child_process)|git\.mjs|state(?:-stores)?\.mjs|commands\//u);
      if(ts.isIdentifier(node)&&['process','require','eval','Function'].includes(node.text))assert.fail(file+' cannot discover ambient host authority');
      if((file===reader||file.endsWith('-decision-reader.mjs')||file.endsWith('-rejection-reader.mjs'))&&ts.isPropertyAccessExpression(node)&&['put','transact','commit','prepare','start'].includes(node.name.text))assert.fail('Human receipt verification cannot mutate or execute');
      ts.forEachChild(node,visit);
    };visit(ast);
  }
  for(const file of await sourceFiles('src')){
    if(owners.has(file)||file==='src/engine-storage/namespace-engine.mjs')continue;
    assert.doesNotMatch(await readFile(path.join(packageRoot,file),'utf8'),/from ['"].*namespace-human-decision\.mjs['"]/u,
      file+' must not select the conditional human mutation writer');
  }
  const native=await readFile(path.join(packageRoot,'src/kernel/upstream-issues.mjs'),'utf8');
  assert.match(native,/upstreamDispositionFacts\(\{outcome,reason,expiresAt,at\}\)/u);
  assert.doesNotMatch(native,/const MAX_RISK_DAYS|parsed - Date\.parse\(at\)/u);
});


test('conditional decision coordination has one writer while domain replay remains read only',async()=>{
  const writer='src/engine-storage/namespace-recorded-mutation.mjs',reader='src/engine-storage/namespace-recorded-mutation-reader.mjs',
    users=new Set([writer,'src/engine-storage/namespace-test-cohorts.mjs','src/engine-storage/namespace-witness-renewals.mjs','src/engine-storage/namespace-obligation-risks.mjs','src/engine-storage/namespace-test-risks.mjs','src/engine-storage/namespace-evidence-reuse.mjs','src/engine-storage/namespace-test-recovery.mjs','src/engine-storage/namespace-convergence.mjs','src/engine-storage/namespace-test-commands.mjs','src/engine-storage/namespace-constitution-exceptions.mjs','src/engine-storage/namespace-source-review.mjs','src/engine-storage/namespace-assignment.mjs','src/engine-storage/namespace-witness-decisions.mjs','src/engine-storage/namespace-plan-decisions.mjs','src/engine-storage/namespace-human-decision.mjs','src/engine-storage/namespace-scope-decisions.mjs','src/engine-storage/namespace-upstream.mjs','src/engine-storage/namespace-input-documents.mjs']);
  for(const file of [writer,reader,'src/engine-storage/namespace-witness-reader.mjs','src/engine-storage/namespace-witness-decisions.mjs','src/engine-storage/namespace-upstream-reader.mjs','src/engine-storage/namespace-decision-contract.mjs','src/engine-storage/namespace-scope-decisions.mjs','src/engine-storage/namespace-scope-reader.mjs','src/engine-storage/namespace-upstream.mjs']){
    const ast=ts.createSourceFile(file,await readFile(path.join(packageRoot,file),'utf8'),ts.ScriptTarget.Latest,true);
    const visit=node=>{
      if(ts.isImportDeclaration(node))assert.doesNotMatch(node.moduleSpecifier.text,/node:(?:fs|child_process)|git\.mjs|state(?:-stores)?\.mjs|commands\//u);
      if(ts.isIdentifier(node)&&['process','require','eval','Function'].includes(node.text))assert.fail(file+' cannot discover host authority');
      if((file===reader||file.endsWith('namespace-upstream-reader.mjs')||file.endsWith('namespace-witness-reader.mjs')||file.endsWith('namespace-scope-reader.mjs'))&&ts.isPropertyAccessExpression(node)&&['put','transact','commit','prepare','start'].includes(node.name.text))assert.fail('Decision verification cannot mutate or execute');
      ts.forEachChild(node,visit);
    };visit(ast);
  }
  for(const file of await sourceFiles('src'))if(!users.has(file))assert.doesNotMatch(await readFile(path.join(packageRoot,file),'utf8'),
    /from ['"].*namespace-recorded-mutation\.mjs['"]/u,file+' cannot select the decision mutation coordinator');
  const pure=await inspectPureModuleGraph({root:packageRoot,entries:['src/engine-storage/namespace-decision-contract.mjs'],
    allowed:['src/engine-storage/namespace-decision-contract.mjs',...await sourceFiles('src/kernel'),...await sourceFiles('src/foundation'),
      ...await sourceFiles('src/sda/namespace'),...await sourceFiles('src/sda/content')]});assert.deepEqual(pure.problems,[]);
});

test('observed cohorts use actual check and decision readers while the registry coordinator owns their single write path',async()=>{
  const file='src/engine-storage/namespace-test-cohort-reader.mjs',text=await readFile(path.join(packageRoot,file),'utf8'),
    allowed=new Set(['../foundation/record-schema.mjs','../foundation/failures.mjs','../records.mjs','../kernel/test-recovery.mjs',
      '../kernel/source-path-policies.mjs','../engine-compatibility/node-configuration-path.mjs','../kernel/approval-fallback.mjs',
      '../kernel/approval-policy.mjs','../kernel/decision-plan.mjs','./namespace-phase-check-reader.mjs','./namespace-recorded-mutation-reader.mjs',
      './namespace-decision-contract.mjs','./namespace-story-reader.mjs','./namespace-policy-contract.mjs','./namespace-test-risk-reader.mjs','./namespace-test-command-reader.mjs']),
    ast=ts.createSourceFile(file,text,ts.ScriptTarget.Latest,true);
  const visit=node=>{
    if(ts.isImportDeclaration(node))assert.ok(allowed.has(node.moduleSpecifier.text),node.moduleSpecifier.text);
    if(ts.isIdentifier(node)&&['process','require','eval','Function','createNamespaceEngine','createNamespaceLifecycleCommitter','commitNamespaceOperation'].includes(node.text))
      assert.fail('Cohort observations cannot discover authority or select another execution path.');
    if(ts.isPropertyAccessExpression(node)&&['put','transact','commit','prepare','start','spawn','spawnSync','writeFile','unlink'].includes(node.name.text))
      assert.fail('The cohort reader cannot persist a decision or execute a test.');
    assert.equal(ts.isCallExpression(node)&&node.expression.kind===ts.SyntaxKind.ImportKeyword,false);ts.forEachChild(node,visit);
  };visit(ast);
  assert.match(text,/checks\.accepted\(/u);assert.match(text,/createNamespaceRecordedMutationReader\(/u);assert.match(text,/checks\.publicationObservation\(/u);
  const coordinator=await readFile(path.join(packageRoot,'src/engine-storage/namespace-test-cohorts.mjs'),'utf8');
  assert.match(coordinator,/createNamespaceRecordedMutationPort\(/u);assert.doesNotMatch(coordinator,/\.transact\(|\.put\(|\.start\(|git\.mjs|state\.mjs|process\./u);
});

test('decision lists stay read-only and batches invoke the same registry without selecting infrastructure',async()=>{
  for(const file of ['src/engine-storage/namespace-decision-list-reader.mjs','src/engine-storage/namespace-decision-list.mjs',
    'src/engine-storage/namespace-decision-batch.mjs','src/engine-storage/namespace-decision-batch-journal.mjs']){
    const text=await readFile(path.join(packageRoot,file),'utf8'),ast=ts.createSourceFile(file,text,ts.ScriptTarget.Latest,true);
    const visit=node=>{
      if(ts.isImportDeclaration(node))assert.doesNotMatch(node.moduleSpecifier.text,/node:(?:fs|child_process)|git\.mjs|state(?:-stores)?\.mjs|commands\//u,file);
      if(ts.isIdentifier(node)&&['process','require','eval','Function','createEngine','createNamespaceEngine','createNamespaceLifecycleCommitter'].includes(node.text))
        assert.fail(file+' must use explicit existing owners');
      if(ts.isPropertyAccessExpression(node)&&['run','start','spawn','spawnSync','writeFile'].includes(node.name.text))assert.fail(file+' cannot dispatch through another host');
      if(file.includes('decision-list')&&ts.isPropertyAccessExpression(node)&&['put','transact','commit','prepare','retain'].includes(node.name.text))assert.fail(file+' must remain read-only');
      if(ts.isCallExpression(node)&&node.expression.kind===ts.SyntaxKind.ImportKeyword)assert.fail(file+' cannot discover an alternate host');
      ts.forEachChild(node,visit);
    };visit(ast);
    if(file.endsWith('batch-journal.mjs')){
      assert.match(text,/namespace:'runtime',key:key\(value\.identity\)/u);assert.match(text,/op:'put',namespace:'runtime'/u);
      assert.doesNotMatch(text,/op:'(?:put|delete)',namespace:'(?:state|config|evidence)'/u,'batch receipts cannot replace domain transactions');
    }
  }
  const host=await readFile(path.join(packageRoot,'src/engine-storage/namespace-engine.mjs'),'utf8');
  assert.match(host,/executeOperation=engine\.run\.bind\(engine\)/u);assert.match(host,/createNamespaceDecisionBatchPort\(common,runtime,executeOperation\)/u);
  assert.equal((host.match(/createEngine\(/gu)??[]).length,1);
});

test('read-only Auto Plan and skill-package inventory do not load synthesis or provider execution',async()=>{
  const readOnly=['src/auto/auto-plan-read.mjs','src/skp-host-readiness.mjs'];
  const forbidden=new Set(['src/auto/auto-plan.mjs','src/model-runner.mjs','src/model-provider-registry.mjs']);
  const visited=new Set();
  async function visit(file){if(visited.has(file))return;visited.add(file);assert.equal(forbidden.has(file),false,file);
    const ast=ts.createSourceFile(file,await readFile(path.join(packageRoot,file),'utf8'),ts.ScriptTarget.Latest,true),pending=[];
    for(const node of ast.statements)if((ts.isImportDeclaration(node)||ts.isExportDeclaration(node))&&node.moduleSpecifier
      &&ts.isStringLiteralLike(node.moduleSpecifier)&&node.moduleSpecifier.text.startsWith('.'))pending.push(
        path.posix.normalize(path.posix.join(path.posix.dirname(file),node.moduleSpecifier.text)));
    for(const dependency of pending)await visit(dependency);
  }
  for(const file of readOnly)await visit(file);
  const read=await readFile(path.join(packageRoot,readOnly[0]),'utf8');
  assert.doesNotMatch(read,/\b(?:writeFile|transact|commit|spawn|synthesize|ratify)\s*\(/u);
});


test('human witness records share pure rules while native file and recovery rendering remain in their adapter',async()=>{
  const owner='src/kernel/human-witnesses.mjs',native='src/verification/witness-records.mjs',
    graph=await inspectPureModuleGraph({root:packageRoot,entries:[owner],allowed:[...await sourceFiles('src/foundation'),...await sourceFiles('src/kernel')]});
  assert.deepEqual(graph.problems,[]);
  const shared=await readFile(path.join(packageRoot,owner),'utf8'),adapter=await readFile(path.join(packageRoot,native),'utf8');
  assert.doesNotMatch(shared,/git restore|singularity-flow |readFile|generation-publication-store/u);
  assert.match(adapter,/witnessRecordPolicies/u);assert.doesNotMatch(adapter,/function witnessContextBinding\(|function witnessRecordResults\(|function assertWitnessReviewBinding\(/u);
});


test('verification contract evaluation has one pure kernel owner and its native adapter owns only the optional clock',async()=>{
  const core='src/kernel/verification-contract-results.mjs',native='src/verification/contract-results.mjs';
  const graph=await inspectPureModuleGraph({root:packageRoot,entries:[core],allowed:[...await sourceFiles('src/kernel'),...await sourceFiles('src/foundation')]});
  assert.deepEqual(graph.problems,[]);const source=await readFile(path.join(packageRoot,native),'utf8');
  assert.match(source,/evaluateContract\(id,contract,entries/);assert.doesNotMatch(source,/function testSlotResult|function recordSlotResult|BLOCKERS/);
  assert.doesNotMatch(await readFile(path.join(packageRoot,core),'utf8'),/new Date\(\)|Date\.now/);
});

test('plan corrections share pure value/schema owners while presence and retained Git verification stay native',async()=>{
  const owners=['src/kernel/plan-corrections.mjs','src/kernel/plan-correction-shapes.mjs','src/foundation/record-shapes.mjs'],
    graph=await inspectPureModuleGraph({root:packageRoot,entries:owners,allowed:[...await sourceFiles('src/kernel'),...await sourceFiles('src/foundation')]});
  assert.deepEqual(graph.problems,[]);
  for(const file of owners)assert.doesNotMatch(await readFile(path.join(packageRoot,file),'utf8'),/countedRecords|readFile|exactFileAtObject|node:|new Date\(\)|Date\.now/u,file);
  const row=await readFile(path.join(packageRoot,'src/plan-row-corrections.mjs'),'utf8'),evidence=await readFile(path.join(packageRoot,'src/plan-evidence-amendments.mjs'),'utf8');
  for(const facade of [row,evidence]){assert.match(facade,/planCorrectionPolicies/u);assert.match(facade,/countedRecords/u);assert.match(facade,/nativeRecordShape/u);}
  assert.doesNotMatch(row,/function applyOperation|function recordPlanRowCorrection|previousClaimSha256/u);
  assert.doesNotMatch(evidence,/function evidenceCorrectionProjection|function evidenceOwnerAuthorities/u);assert.match(evidence,/exactFileAtObject/u);
  const upstream=await readFile(path.join(packageRoot,'src/kernel/upstream-issues.mjs'),'utf8');
  assert.match(upstream,/parseRecordShape as parseRecord/u);assert.doesNotMatch(upstream,/function parseRecord\(/u);
});

test('coordination shares the original pure reducer and verifies assignment evidence without a writer',async()=>{
  const native=await readFile(path.join(packageRoot,'src/collaboration.mjs'),'utf8'),ast=ts.createSourceFile('native',native,ts.ScriptTarget.Latest,true),
    reducer=ast.statements.find(node=>ts.isFunctionDeclaration(node)&&node.name?.text==='assignPhase').body.getText(ast);
  assert.match(reducer,/phaseAssignmentStateReplay/u);assert.equal((reducer.match(/nowIso\(/gu)??[]).length,1);
  assert.doesNotMatch(reducer,/\.assignments|\.notifications|\.history/u);
  const file='src/engine-storage/namespace-assignment-reader.mjs',source=ts.createSourceFile(file,await readFile(path.join(packageRoot,file),'utf8'),ts.ScriptTarget.Latest,true),
    allowed=new Set(['node:crypto','../foundation/failures.mjs','../foundation/record-schema.mjs','../kernel/phase-policy.mjs','./namespace-recorded-mutation-reader.mjs','./namespace-decision-contract.mjs']);
  const visit=node=>{if(ts.isImportDeclaration(node))assert.ok(allowed.has(node.moduleSpecifier.text),node.moduleSpecifier.text);
    if(ts.isPropertyAccessExpression(node)&&['put','transact','commit','prepare','start','spawn'].includes(node.name.text))assert.fail('Coordination verification must remain read only');
    ts.forEachChild(node,visit);};visit(source);
});

test('source review shares pure citation rules and retains evidence only through its explicit review operation',async()=>{
  const rule='src/kernel/source-grounded-review.mjs',wrapper=await readFile(path.join(packageRoot,'src/source-grounded-review.mjs'),'utf8'),
    reader='src/engine-storage/namespace-source-review-reader.mjs',writer='src/engine-storage/namespace-source-review.mjs';
  const pure=await inspectPureModuleGraph({root:packageRoot,entries:[rule],allowed:[...await sourceFiles('src/kernel'),...await sourceFiles('src/foundation')]});
  assert.deepEqual(pure.problems,[]);assert.match(wrapper,/sourceGroundedReviewPolicies/u);assert.match(wrapper,/SPECIFICATION_CLAIM_TIMESTAMP_REQUEST/u);
  assert.doesNotMatch(wrapper,/readRecord|function citedSource|function evaluatePlanningRows|source-statement-unmapped/u);
  const source=await readFile(path.join(packageRoot,reader),'utf8'),adapter=await readFile(path.join(packageRoot,writer),'utf8');
  assert.match(source,/sourceGroundedReviewPolicies/u);assert.match(source,/namespaceLocalInputBytes/u);assert.match(adapter,/createNamespaceRecordedMutationPort/u);
  for(const file of [reader,writer]){
    const ast=ts.createSourceFile(file,await readFile(path.join(packageRoot,file),'utf8'),ts.ScriptTarget.Latest,true);
    const visit=node=>{if(ts.isImportDeclaration(node))assert.doesNotMatch(node.moduleSpecifier.text,/node:(?:fs|child_process)|git\.mjs|state\.mjs|commands\//u);
      if(file===reader&&ts.isPropertyAccessExpression(node)&&['put','transact','commit','prepare','start','spawn'].includes(node.name.text))assert.fail('Source review inspection cannot execute or acquire a writer');
      ts.forEachChild(node,visit);};visit(ast);
  }
  const replay=await readFile(path.join(packageRoot,'src/engine-storage/namespace-recorded-mutation-reader.mjs'),'utf8');
  assert.match(replay,/operation==='source-review\.record'\)return phaseSourceReviewerAdmission/u);
  assert.match(replay,/const facts=phaseAgentMutationFacts/u,'every other decision retains its normal read-only role prohibition');
});

test('constitution policy values remain pure while native YAML formatting, file access and CLI hints stay in their adapter',async()=>{
  const owner='src/kernel/constitution.mjs',graph=await inspectPureModuleGraph({root:packageRoot,entries:[owner,'src/kernel/constitution-publication.mjs'],
    allowed:[...await sourceFiles('src/kernel'),...await sourceFiles('src/foundation')]});
  assert.deepEqual(graph.problems,[]);
  const pure=await readFile(path.join(packageRoot,owner),'utf8'),native=await readFile(path.join(packageRoot,'src/constitution.mjs'),'utf8');
  assert.doesNotMatch(pure,/node:|from ['"]yaml|singularity-flow constitution |readFile|writeFile|Date\.now|new Date\(\)/u);
  assert.match(native,/constitutionValuePolicies/u);assert.match(native,/renderDataPreservingFormatting/u);assert.match(native,/readFile/u);
  assert.doesNotMatch(native,/function articleHash|function validateCitations|function requiredArticles|function buildConstitutionException/u);
  assert.match(await readFile(path.join(packageRoot,'src/schema-migrations.mjs'),'utf8'),/family\(CONSTITUTION_RECORD_SCHEMA\)/u);
  const reader=await readFile(path.join(packageRoot,'src/engine-storage/namespace-constitution-reader.mjs'),'utf8');
  assert.match(reader,/constitutionPublicationPolicies/u);assert.doesNotMatch(reader,/node:fs|child_process|Date\.now|new Date\(\)|\.transact\(|\.put\(/u);
  const binding=await readFile(path.join(packageRoot,'src/engine-compatibility/node-constitution-policy.mjs'),'utf8');
  assert.match(binding,/from 'yaml'/u);assert.doesNotMatch(binding,/node:fs|child_process|state\.mjs|commands\//u);
});


test('bounded return provenance and private batched observations cannot select writers, execute checks or discover host state',async()=>{
  const file='src/engine-storage/namespace-repair-budget-reader.mjs',allowed=new Set([
    './namespace-forward-reader.mjs',
    '../foundation/failures.mjs','../foundation/record-schema.mjs','../kernel/test-recovery.mjs',
    './namespace-human-decision-contract.mjs','./namespace-decision-contract.mjs','./namespace-rejection-reader.mjs',
    './namespace-upstream-reader.mjs','./namespace-submission-reader.mjs','./namespace-phase-check-reader.mjs','./namespace-story-reader.mjs']);
  const ast=ts.createSourceFile(file,await readFile(path.join(packageRoot,file),'utf8'),ts.ScriptTarget.Latest,true);
  const visit=node=>{if(ts.isImportDeclaration(node))assert.ok(allowed.has(node.moduleSpecifier.text),node.moduleSpecifier.text);
    if(ts.isPropertyAccessExpression(node)&&['put','transact','commit','prepare','start','writeFile'].includes(node.name.text))assert.fail('Budget proof cannot mutate or execute');
    if(ts.isIdentifier(node)&&['process','require','eval','Function'].includes(node.text))assert.fail('Budget proof cannot discover ambient authority');
    ts.forEachChild(node,visit);};visit(ast);
  const batch='src/sda/namespace/read-batch.mjs',pure=await inspectPureModuleGraph({root:packageRoot,entries:[batch],allowed:[batch,...await sourceFiles('src/foundation'),...await sourceFiles('src/sda/namespace')]});
  assert.deepEqual(pure.problems,[]);
  const owners=new Set(['src/sda/namespace-journal-adapter.mjs','src/sda/sqlite-namespace-adapter.mjs',
    'src/engine-storage/namespace-engine.mjs','src/engine-storage/namespace-read-session.mjs',
    'src/engine-storage/namespace-lifecycle-reader.mjs','src/engine-storage/namespace-lifecycle-receipt-reader.mjs']);
  for(const source of await sourceFiles('src')){if(owners.has(source))continue;
    const text=await readFile(path.join(packageRoot,source),'utf8');assert.doesNotMatch(text,/from ['"][^'"]*namespace\/read-batch\.mjs['"]/u,source+' cannot claim a private read capability');}
});


test('deterministic convergence has one pure rule owner while native reads and shell guidance stay in adapters',async()=>{
  const core=await readFile(path.join(packageRoot,'src/kernel/convergence-values.mjs'),'utf8');
  assert.doesNotMatch(core,/from ['"]node:|process\.|readFile|readRecord|singularity-flow story converge|safeCommandGuidance/u);
  for(const file of ['src/convergence.mjs','src/plan-accounts.mjs']){
    const text=await readFile(path.join(packageRoot,file),'utf8');
    assert.match(text,/from ['"]\.\/kernel\/convergence-values\.mjs['"]/u);
    assert.doesNotMatch(text,/function (?:convergenceFacts|convergenceProjection|renderConvergenceArtifact|stillAsked|settleChangedPaths)\(/u);
  }
  const native=await readFile(path.join(packageRoot,'src/convergence.mjs'),'utf8');assert.match(native,/readRecord\('convergence-record'/u);
  assert.match(native,/singularity-flow story converge/u);
  const facade=ts.createSourceFile('repair-budget.mjs',await readFile(path.join(packageRoot,'src/repair-budget.mjs'),'utf8'),ts.ScriptTarget.Latest,true);
  assert.ok(facade.statements.every(ts.isExportDeclaration));
  const rejection=await readFile(path.join(packageRoot,'src/engine-compatibility/rejection-transition.mjs'),'utf8');
  assert.match(rejection,/function consumeRepairAttempt\(/u);assert.match(rejection,/consumeRepairAttemptValue\(/u);
  assert.doesNotMatch(await readFile(path.join(packageRoot,'src/state.mjs'),'utf8'),/from ['"]\.\/repair-budget\.mjs['"]/u);
});


test('convergence proof readers cannot stage records, discover a checkout or execute a provider',async()=>{
  const files=['namespace-convergence-reader','namespace-convergence-decisions-reader','namespace-convergence-policy','namespace-convergence-submission'];
  for(const name of files){const file='src/engine-storage/'+name+'.mjs',source=await readFile(path.join(packageRoot,file),'utf8'),
    ast=ts.createSourceFile(file,source,ts.ScriptTarget.Latest,true);
    const inspect=node=>{
      if(ts.isImportDeclaration(node))assert.doesNotMatch(node.moduleSpecifier.text,/node:(?:fs|child_process)|git\.mjs|state\.mjs|commands\/|namespace-(?:lifecycle-commit|recorded-mutation)\.mjs/u);
      if(ts.isIdentifier(node)&&['process','require','eval','Function'].includes(node.text))assert.fail(file+' cannot discover an execution host');
      if(ts.isPropertyAccessExpression(node)&&['put','transact','prepare','commit','start','launch','spawn'].includes(node.name.text))assert.fail(file+' cannot persist or execute');
      ts.forEachChild(node,inspect);
    };inspect(ast);
  }
  const pure=await inspectPureModuleGraph({root:packageRoot,entries:['src/kernel/convergence-values.mjs','src/kernel/namespace-convergence.mjs'],
    allowed:[...await sourceFiles('src/kernel'),...await sourceFiles('src/foundation')]});assert.deepEqual(pure.problems,[]);
});

test('artifact repair and return-proof owners are read-only and native bundle differences share the pure rule',async()=>{
  const permitted=new Map([
    ['namespace-artifact-repair-reader.mjs',new Set(['../foundation/failures.mjs','../foundation/record-schema.mjs','../kernel/approval-policy.mjs',
      '../kernel/namespace-artifact-sets.mjs','../engine-compatibility/node-configuration-path.mjs','../records.mjs','./namespace-publication-reader.mjs',
      './namespace-submission-reader.mjs','./namespace-phase-check-reader.mjs','./namespace-rejection-reader.mjs','./namespace-human-decision-contract.mjs'])],
    ['namespace-code-return-reader.mjs',new Set(['./namespace-forward-reader.mjs','../foundation/failures.mjs','../foundation/record-schema.mjs','../kernel/approval-policy.mjs','../kernel/routed-approval.mjs',
      './namespace-submission-reader.mjs','./namespace-approval-reader.mjs','./namespace-approval-contract.mjs','./namespace-phase-check-reader.mjs',
      './namespace-human-decision-contract.mjs','./namespace-rejection-reader.mjs','./namespace-routing-choice-contract.mjs','./namespace-routing-receipt-reader.mjs','./namespace-upstream-return-reader.mjs'])]
  ]);
  for(const [name,allowed]of permitted){const file='src/engine-storage/'+name,ast=ts.createSourceFile(file,await readFile(path.join(packageRoot,file),'utf8'),ts.ScriptTarget.Latest,true);
    const visit=node=>{if(ts.isImportDeclaration(node))assert.ok(allowed.has(node.moduleSpecifier.text),file+': '+node.moduleSpecifier.text);
      if(ts.isIdentifier(node)&&['process','require','eval','Function'].includes(node.text))assert.fail('Repair proof cannot discover a host');
      if(ts.isPropertyAccessExpression(node)&&['put','transact','commit','prepare','start','launch','writeFile','unlink','spawn','spawnSync'].includes(node.name.text))assert.fail('Repair proof cannot write or execute');
      assert.equal(ts.isCallExpression(node)&&node.expression.kind===ts.SyntaxKind.ImportKeyword,false);ts.forEachChild(node,visit);};visit(ast);
  }
  const native=await readFile(path.join(packageRoot,'src/artifact-sets.mjs'),'utf8');assert.match(native,/return artifactSetDiffValues\(readablePrevious,current,\{declared\}\)/u);
  assert.match(native,/readRecord\('artifact-set'/u);assert.doesNotMatch(native,/const intended = new Set\(declared/u);
});


test('forward document proof stays read-only while replacement evidence is staged in memory',async()=>{
  for(const name of ['namespace-forward-reader.mjs','namespace-document-review.mjs']){
    const file='src/engine-storage/'+name,ast=ts.createSourceFile(file,await readFile(path.join(packageRoot,file),'utf8'),ts.ScriptTarget.Latest,true);
    const visit=node=>{
      if(ts.isImportDeclaration(node))assert.doesNotMatch(node.moduleSpecifier.text,/node:(?:fs|child_process)|(?:git|state)\.mjs|commands\//u);
      if(ts.isIdentifier(node)&&['process','require','eval','Function'].includes(node.text))assert.fail(file+' cannot discover host authority');
      if(ts.isPropertyAccessExpression(node)&&['put','transact','commit','prepare','start','run','writeFile','unlink'].includes(node.name.text))assert.fail(file+' cannot mutate or execute');
      ts.forEachChild(node,visit);
    };visit(ast);
  }
  const file='src/engine-storage/namespace-forward-evidence.mjs',body=await readFile(path.join(packageRoot,file),'utf8');
  assert.match(body,/content=\{async put/u);assert.match(body,/staged=new Map/u);
  assert.doesNotMatch(body,/node:(?:fs|child_process)|namespace-lifecycle-commit|records\.transact|options\.content/u);
  const native=await readFile(path.join(packageRoot,'src/state.mjs'),'utf8');assert.match(native,/forwardAmendmentPhaseTarget\(workflow,phaseId\)/u);
  const contract='src/engine-storage/namespace-forward-contract.mjs',pure=await inspectPureModuleGraph({root:packageRoot,entries:[contract,'src/kernel/document-review.mjs'],
    allowed:[contract,...await sourceFiles('src/foundation'),...await sourceFiles('src/kernel'),...await sourceFiles('src/sda/namespace'),...await sourceFiles('src/sda/content')]});
  assert.deepEqual(pure.problems,[]);
});

test('test recovery has read-only proof owners, a pure reservation contract and explicit SGOS execution',async()=>{
  for(const name of ['namespace-test-recovery-reader.mjs','namespace-test-repair-reader.mjs']){
    const file='src/engine-storage/'+name,ast=ts.createSourceFile(file,await readFile(path.join(packageRoot,file),'utf8'),ts.ScriptTarget.Latest,true);
    const inspect=node=>{
      if(ts.isImportDeclaration(node))assert.doesNotMatch(node.moduleSpecifier.text,/node:(?:fs|child_process)|(?:git|state)\.mjs|commands\//u);
      if(ts.isIdentifier(node)&&['process','require','eval','Function','createNamespaceStoryObserver'].includes(node.text))assert.fail(file+' cannot select host authority');
      if(ts.isPropertyAccessExpression(node)&&['put','transact','commit','start','spawn','writeFile','run'].includes(node.name.text))assert.fail(file+' cannot execute or mutate');
      ts.forEachChild(node,inspect);
    };inspect(ast);
  }
  const contract='src/engine-storage/namespace-test-repair-contract.mjs',pure=await inspectPureModuleGraph({root:packageRoot,entries:[contract],
    allowed:[contract,'src/engine-storage/namespace-lifecycle-codec.mjs','src/engine-storage/namespace-lifecycle-contract.mjs',
      ...await sourceFiles('src/foundation'),...await sourceFiles('src/sda/namespace'),...await sourceFiles('src/sda/content')]});
  assert.deepEqual(pure.problems,[]);
  const writer=await readFile(path.join(packageRoot,'src/engine-storage/namespace-test-repair.mjs'),'utf8');
  assert.match(writer,/createDurableExecutionUnit/u);assert.match(writer,/executeOperation\('phase\.checks\.run'/u);
  assert.match(writer,/executeOperation\('phase\.source\.retain'/u);assert.match(writer,/codec\.transaction\(s\.plan,s\.reference\)/u);
  assert.doesNotMatch(writer,/node:(?:fs|child_process)|git\.mjs|state\.mjs|commands\//u);
});

test('evidence evaluation owns pure facets and actions while native presence, clocks and command rendering stay in adapters',async()=>{
  const entry='src/kernel/evidence-evaluation.mjs',allowed=[entry,
    ...await sourceFiles('src/kernel'),...await sourceFiles('src/foundation')],pure=await inspectPureModuleGraph({root:packageRoot,entries:[entry],allowed});
  assert.deepEqual(pure.problems,[]);
  const body=await readFile(path.join(packageRoot,entry),'utf8');
  assert.doesNotMatch(body,/singularity-flow|new Date|Date\.now|countedRecords|countedApprovals|scopeDecisionCommandLine|node:/u);
  assert.match(body,/requiredInputs:\['disposition','clauseIds','reason'\]/u);
  assert.match(body,/explicit observation timestamp/u);
  const native=await readFile(path.join(packageRoot,'src/evidence/evaluate.mjs'),'utf8');
  assert.match(native,/rules\.evaluateEvidence/u);assert.match(native,/countedApprovals/u);assert.match(native,/legacyAction/u);
  assert.doesNotMatch(native,/function rowResult|function executionOutcome|const BLOCKING_RESULTS/u);
});


test('the namespace evidence view cannot stage records, execute tests or discover host source',async()=>{
  for(const file of ['src/engine-storage/namespace-evidence-reader.mjs','src/engine-storage/namespace-evidence.mjs']){
    const body=await readFile(path.join(packageRoot,file),'utf8'),ast=ts.createSourceFile(file,body,ts.ScriptTarget.Latest,true);
    const inspect=node=>{
      if(ts.isImportDeclaration(node))assert.doesNotMatch(node.moduleSpecifier.text,/node:(?:fs|child_process)|(?:git|state)\.mjs|commands\//u);
      if(ts.isIdentifier(node)&&['process','require','eval','Function'].includes(node.text))assert.fail(file+' cannot discover host authority');
      if(ts.isPropertyAccessExpression(node)&&['put','transact','commit','start','spawn','writeFile','execute'].includes(node.name.text))assert.fail(file+' cannot mutate or execute');
      ts.forEachChild(node,inspect);};inspect(ast);
  }
  const native=await readFile(path.join(packageRoot,'src/evidence/graph.mjs'),'utf8');
  assert.match(native,/evidenceValues\.evidenceGraph/u);assert.match(native,/currentCompletenessReview/u);
});

test('obligation risks retain the kernel rule and shared proof owners without executing or authorizing through flags',async()=>{
  const entry='src/kernel/obligation-risks.mjs',pure=await inspectPureModuleGraph({root:packageRoot,entries:[entry],
    allowed:[...await sourceFiles('src/kernel'),...await sourceFiles('src/foundation')]});assert.deepEqual(pure.problems,[]);
  for(const file of ['src/engine-storage/namespace-obligation-risk-reader.mjs','src/engine-storage/namespace-terminal-evidence.mjs']){
    const body=await readFile(path.join(packageRoot,file),'utf8'),ast=ts.createSourceFile(file,body,ts.ScriptTarget.Latest,true);
    const visit=node=>{
      if(ts.isImportDeclaration(node))assert.doesNotMatch(node.moduleSpecifier.text,/node:(?:fs|child_process)|(?:git|state)\.mjs|commands\//u);
      if(ts.isIdentifier(node)&&['process','require','eval','Function','createNamespaceStoryObserver','createNamespaceLifecycleCommitter'].includes(node.text))assert.fail(file+' cannot discover authority');
      if(ts.isPropertyAccessExpression(node)&&['put','transact','commit','start','spawn','writeFile','run'].includes(node.name.text))assert.fail(file+' cannot mutate or execute');
      ts.forEachChild(node,visit);};visit(ast);assert.doesNotMatch(body,/Date\.now|allowWithRisk|waiveTests/u);
  }
  const owner=await readFile(path.join(packageRoot,'src/engine-storage/namespace-obligation-risk-reader.mjs'),'utf8');
  assert.match(owner,/createNamespaceRecordedMutationReader/u);assert.match(owner,/\.unexcepted\(snapshot,options\)/u);
  const terminal=await readFile(path.join(packageRoot,'src/engine-storage/namespace-terminal-evidence.mjs'),'utf8');
  assert.match(terminal,/principalApprovalPlan/u);assert.match(terminal,/uncommitted-human-vote/u);assert.match(terminal,/ENGINE_TERMINAL_EVIDENCE_REQUIRED/u);
});

test('application-review values share event and capture rules without importing native storage, human authority or execution',async()=>{
  const entry='src/kernel/application-review.mjs',pure=await inspectPureModuleGraph({root:packageRoot,entries:[entry],
    allowed:[...await sourceFiles('src/kernel'),...await sourceFiles('src/foundation')]});assert.deepEqual(pure.problems,[]);
  const body=await readFile(path.join(packageRoot,entry),'utf8');
  assert.doesNotMatch(body,/schema-migrations\.mjs|application-review-(?:human|host|preview|read)\.mjs|Date\.now|new Date|node:|captureApplicationReview/u);
  const native=await readFile(path.join(packageRoot,'src/application-review-contract.mjs'),'utf8');
  assert.match(native,/applicationReviewPolicies\(NODE_RECORD_BYTES,NODE_TEXT_DIGESTS\)/u);
  assert.doesNotMatch(native,/function (?:appendReviewEvent|projectReview|validateReviewCaptureSet)|readRecord\(/u);
});


test('evidence reuse keeps execution, native Git identities and human authority out of its value rules',async()=>{
  const kernel='src/kernel/evidence-reuse.mjs',graph=await inspectPureModuleGraph({root:packageRoot,entries:[kernel],
    allowed:[...await sourceFiles('src/kernel'),...await sourceFiles('src/foundation')]});assert.deepEqual(graph.problems,[]);
  const body=await readFile(path.join(packageRoot,kernel),'utf8');assert.doesNotMatch(body,/Date\.now|node:|singularity-flow|source\.commit|TA-\[/u);
  const file='src/engine-storage/namespace-evidence-reuse-reader.mjs',ast=ts.createSourceFile(file,await readFile(path.join(packageRoot,file),'utf8'),ts.ScriptTarget.Latest,true);
  const visit=node=>{if(ts.isImportDeclaration(node))assert.doesNotMatch(node.moduleSpecifier.text,/node:(?:fs|child_process)|(?:git|state)\.mjs|commands\//u);
    if(ts.isIdentifier(node)&&['process','require','eval','Function','createNamespaceStoryObserver','createNamespaceLifecycleCommitter'].includes(node.text))assert.fail(file+' cannot discover host authority');
    if(ts.isPropertyAccessExpression(node)&&['put','transact','commit','start','spawn','writeFile','run'].includes(node.name.text))assert.fail(file+' cannot execute or mutate');
    assert.equal(ts.isCallExpression(node)&&node.expression.kind===ts.SyntaxKind.ImportKeyword,false);ts.forEachChild(node,visit);};visit(ast);
  const adapter=await readFile(path.join(packageRoot,'src/evidence-reuse.mjs'),'utf8');assert.match(adapter,/evidenceReuseExpiry\(expires,at\)/u);
  const manifest=await readFile(path.join(packageRoot,'src/vsix-source-manifest.mjs'),'utf8'),identity=await readFile(path.join(packageRoot,'src/build-identity.mjs'),'utf8');
  assert.ok(manifest.includes("'src/kernel/evidence-reuse.mjs'"));assert.ok(identity.includes("'kernel/evidence-reuse.mjs'"));
  assert.match(adapter,/countedRecords/u);assert.match(adapter,/COMMIT/u);assert.match(adapter,/ATTEMPT_ID/u);
});

test('cause classification and report messages share one pure owner with explicit memory normalization',async()=>{
  const kernel='src/kernel/test-run-cause.mjs',adapter='src/engine-compatibility/node-test-causes.mjs',
    graph=await inspectPureModuleGraph({root:packageRoot,entries:[kernel],allowed:[...await sourceFiles('src/kernel'),...await sourceFiles('src/foundation')]});
  assert.deepEqual(graph.problems,[]);const body=await readFile(path.join(packageRoot,kernel),'utf8');
  assert.doesNotMatch(body,/\bBuffer\b|Date\.now|spawnSync|readFile/u);assert.match(body,/const normalize=toBytes/u);
  for(const file of ['src/test-run-cause.mjs','src/test-case-messages.mjs']){
    const text=await readFile(path.join(packageRoot,file),'utf8');assert.match(text,/node-test-causes\.mjs/u);
    assert.doesNotMatch(text,/function|classifyTestRunCause\s*\(/u,'legacy exports remain compatibility aliases');
  }
  const binding=await readFile(path.join(packageRoot,adapter),'utf8');assert.match(binding,/testRunCausePolicies/u);assert.match(binding,/Buffer\.from/u);
  assert.doesNotMatch(binding,/node:|git\.mjs|state\.mjs|process|spawn|readFile/u);
  const manifest=await readFile(path.join(packageRoot,'src/vsix-source-manifest.mjs'),'utf8'),identity=await readFile(path.join(packageRoot,'src/build-identity.mjs'),'utf8');
  for(const file of ['kernel/test-run-cause.mjs','engine-compatibility/node-test-causes.mjs']){
    assert.ok(manifest.includes("'src/"+file+"'"));assert.ok(identity.includes("'"+file+"'"));
  }
});

test('test risk values and retained failure proofs cannot authenticate, run checks or mutate evidence',async()=>{
  const kernel='src/kernel/test-recovery.mjs',graph=await inspectPureModuleGraph({root:packageRoot,entries:[kernel],
    allowed:[...await sourceFiles('src/kernel'),...await sourceFiles('src/foundation')]});assert.deepEqual(graph.problems,[]);
  const native=await readFile(path.join(packageRoot,'src/test-run-risk.mjs'),'utf8');
  assert.match(native,/testRunRiskRecordPolicies/u);assert.match(native,/countedRecords/u);assert.match(native,/Date\.now/u);
  assert.doesNotMatch(native,/function (?:testsExecuted|testRunCause|recordTestRunRisk)\(/u);
  const file='src/engine-storage/namespace-test-risk-reader.mjs',ast=ts.createSourceFile(file,await readFile(path.join(packageRoot,file),'utf8'),ts.ScriptTarget.Latest,true);
  const visit=node=>{if(ts.isImportDeclaration(node))assert.doesNotMatch(node.moduleSpecifier.text,/node:(?:fs|child_process)|(?:git|state)\.mjs|commands\//u);
    if(ts.isIdentifier(node)&&['process','require','eval','Function','createNamespaceStoryObserver','createNamespaceLifecycleCommitter'].includes(node.text)
      &&!(ts.isPropertyAccessExpression(node.parent)&&node.parent.name===node))assert.fail(file+' cannot discover host authority');
    if(ts.isPropertyAccessExpression(node)&&['put','transact','commit','start','spawn','writeFile','run'].includes(node.name.text))assert.fail(file+' cannot execute or mutate');
    ts.forEachChild(node,visit);};visit(ast);
  const codec=await readFile(path.join(packageRoot,'src/engine-storage/namespace-phase-check-reader.mjs'),'utf8');
  assert.match(codec,/assertPassing\(selected\.found,input\.phaseId\)/u);assert.match(codec,/assertPassing\(found,value\.phase\)/u);
  assert.match(codec,/async function publicationObservation/u);assert.match(codec,/async function freshObservedSources/u);
});

test('witness exception renewal values cannot import Git, presence, rendering or implicit time',async()=>{
  const owner='src/kernel/human-witnesses.mjs',graph=await inspectPureModuleGraph({root:packageRoot,entries:[owner],
    allowed:[...await sourceFiles('src/kernel'),...await sourceFiles('src/foundation')]});assert.deepEqual(graph.problems,[]);
  const pure=await readFile(path.join(packageRoot,owner),'utf8');assert.doesNotMatch(pure,/Date\.now|readFile|singularity-flow decision|countedRecords/u);
  const native=await readFile(path.join(packageRoot,'src/witness-exception-renewals.mjs'),'utf8');
  assert.match(native,/witnessExceptionRenewalPolicies\(\{renewedWitnessExpiry\}\)/u);assert.doesNotMatch(native,/function witnessException|MAX_REASON|Date\.parse/u);
  const query=await readFile(path.join(packageRoot,'src/governance.mjs'),'utf8');
  assert.match(query,/witnessRenewalExpiryValue\(countedRecords\(workflow,workflow\?\.witnessExceptionRenewals\)/u);
});

test('test adequacy mapping rules share the pure human-witness owner while native defaults stay in the adapter',async()=>{
  const pure=await readFile(path.join(packageRoot,'src/kernel/human-witnesses.mjs'),'utf8'),
    native=await readFile(path.join(packageRoot,'src/wel-review.mjs'),'utf8');
  assert.match(pure,/export function witnessMappingReviewPolicies/u);assert.doesNotMatch(pure,/Buffer|Date\.now|readFile/u);
  assert.match(native,/witnessMappingReviewPolicies\(NODE_TEXT_VALUE_SYNTAX,NODE_TEXT_DIGESTS\)/u);
  assert.match(native,/now=Date\.now\(\)/u);assert.doesNotMatch(native,/const DECISIONS|function mappingCore|MAX_MAPPINGS/u);
});

test('namespace witness mapping construction cannot discover hosts, mutate storage or execute tests',async()=>{
  const file='src/engine-storage/namespace-witness-mapping-reader.mjs',ast=ts.createSourceFile(file,await readFile(path.join(packageRoot,file),'utf8'),ts.ScriptTarget.Latest,true);
  const imports=new Set(['node:crypto','../foundation/record-schema.mjs','../foundation/failures.mjs','../kernel/human-witnesses.mjs','../records.mjs','../engine-compatibility/node-specification-policy.mjs']);
  const visit=node=>{if(ts.isImportDeclaration(node))assert.ok(imports.has(node.moduleSpecifier.text));
    if(ts.isPropertyAccessExpression(node)&&['put','transact','commit','writeFile','start','run','read'].includes(node.name.text))assert.fail('Mapping values cannot perform effects.');
    if(ts.isIdentifier(node)&&['process','eval','Function','require'].includes(node.text))assert.fail('No host discovery in witness values.');ts.forEachChild(node,visit);};visit(ast);
  const renewal=await readFile(path.join(packageRoot,'src/engine-storage/namespace-witness-renewals.mjs'),'utf8');
  assert.match(renewal,/inspectApprovedMany/u);assert.match(renewal,/reader\.accepted/u);assert.match(renewal,/recordWitnessExceptionRenewal/u);
  assert.doesNotMatch(renewal,/Date\.now|spawn|writeFile|runTests|approvalRecorded:true/u);
});

test('test narrowing values require admitted records and explicit time while native collection and presence retain their owners',async()=>{
  const entry='src/kernel/test-recovery.mjs',pure=await inspectPureModuleGraph({root:packageRoot,entries:[entry],
    allowed:[...await sourceFiles('src/kernel'),...await sourceFiles('src/foundation')]});assert.deepEqual(pure.problems,[]);
  const body=await readFile(path.join(packageRoot,entry),'utf8'),values=body.slice(body.indexOf('export function testNarrowingPolicies'));
  assert.doesNotMatch(values,/Date\.now|countedRecords|node:|\bprocess\b|readFile|committedFiles|commandTokens/u);
  assert.match(values,/Array\.isArray\(records\)/u);assert.match(values,/at===undefined/u);
  const native=await readFile(path.join(packageRoot,'src/test-narrowing.mjs'),'utf8');
  assert.match(native,/testNarrowingPolicies\(NODE_TEXT_DIGESTS\)/u);assert.match(native,/countedRecords/u);assert.match(native,/Date\.now/u);
  assert.match(native,/committedFilesAtRevisions/u);assert.match(native,/commandTokens/u);
  assert.doesNotMatch(native,/function (?:observedNarrowing|narrowingCovers|recordTestNarrowing)\(/u);
});
