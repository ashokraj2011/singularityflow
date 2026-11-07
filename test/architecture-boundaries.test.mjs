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
  const compatibilityContract = ['src/sda/git-compatibility-contract.mjs'];
  const kernel = await sourceFiles('src/kernel');
  const sdk = await sourceFiles('src/engine-sdk');
  for (const rule of [
    { entries: foundation, allowed: foundation },
    { entries: contracts, allowed: [...foundation, ...contracts] },
    { entries: namespaces, allowed: [...foundation, ...namespaces] },
    { entries: compatibilityContract, allowed: [...foundation, ...contracts, ...namespaces, ...compatibilityContract] },
    { entries: kernel, allowed: [...foundation, ...kernel] },
    { entries: sdk, allowed: [...foundation, ...kernel, ...sdk] }
  ]) {
    const report = await inspectPureModuleGraph({ root: packageRoot, ...rule });
    assert.deepEqual(report.problems, [],
      'foundation must not depend on SDA; contracts may use foundation, without host I/O or computed imports');
  }
});

test('only the explicit Git compatibility boundary may consume namespace contracts outside their pure directory', async () => {
  const directory = path.join(packageRoot, 'src/sda/namespace') + path.sep;
  // Phase 3 composes the existing owners without selecting a generic namespace store. CLI/SDK
  // routing is a later vertical slice; adding a direct host dependency must fail this guard.
  const compatibility = new Set(['src/sda/git-compatibility-contract.mjs', 'src/sda/git-compatibility-adapter.mjs']);
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
          && !compatibility.has(relative)) violations.push(relative);
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  assert.deepEqual(violations, [], 'namespace contracts and the compatibility facade must not change existing production routing');
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
  const oldRules=new Set(['src/phase-roles.mjs','src/phase-generation.mjs',
    'src/approval-authority.mjs','src/approval-fallback.mjs','src/commands/decision-story-records.mjs',
    'src/commands/decision-plan-amendment.mjs','src/commands/decision-obligation-risk.mjs'].map(file=>path.join(packageRoot,file)));
  const transitions=new Set(['src/engine-compatibility/generation-publication.mjs',
    'src/engine-compatibility/submission-transition.mjs','src/engine-compatibility/approval-transition.mjs'].map(file=>path.join(packageRoot,file)));
  const submissionPort=path.join(packageRoot,'src/engine-compatibility/git-submission.mjs');
  const approvalPort=path.join(packageRoot,'src/engine-compatibility/git-approval.mjs');
  const decisionPort=path.join(packageRoot,'src/engine-compatibility/git-decisions.mjs');
  const advancementPort=path.join(packageRoot,'src/engine-compatibility/git-advancement.mjs');
  const singleDecisionPort=path.join(packageRoot,'src/engine-compatibility/git-decision-record.mjs');
  const testDecisionPort=path.join(packageRoot,'src/engine-compatibility/git-test-decision-record.mjs');
  const witnessWriter=path.join(packageRoot,'src/engine-compatibility/native-witness-decisions.mjs');
  const correctionPort=path.join(packageRoot,'src/engine-compatibility/git-plan-correction.mjs');
  const upstreamPort=path.join(packageRoot,'src/engine-compatibility/git-upstream.mjs');
  const forwardWriter=path.join(packageRoot,'src/engine-compatibility/native-forward-amendments.mjs');
  const upstreamReader=path.join(packageRoot,'src/engine-compatibility/upstream-artifact-issues.mjs');
  const problems=[];
  for(const relative of packageFiles){
    const file=path.join(packageRoot,relative);
    const source=ts.createSourceFile(relative,await readFile(file,'utf8'),ts.ScriptTarget.Latest,true);
    const visit=node=>{
      const specifier=(ts.isImportDeclaration(node)||ts.isExportDeclaration(node))?node.moduleSpecifier
        :ts.isCallExpression(node)&&node.expression.kind===ts.SyntaxKind.ImportKeyword?node.arguments[0]:null;
      if(specifier&&ts.isStringLiteralLike(specifier)&&specifier.text.startsWith('.')){
        const target=path.resolve(path.dirname(file),specifier.text);
        if(oldRules.has(target)||(transitions.has(target)&&relative!=='src/state.mjs'))problems.push(relative);
        if(target===submissionPort&&relative!=='src/engine-compatibility/git-publication.mjs')problems.push(relative);
        if(target===approvalPort&&relative!=='src/engine-compatibility/git-publication.mjs')problems.push(relative);
        if(target===decisionPort&&relative!=='src/engine-compatibility/git-publication.mjs')problems.push(relative);
        if(target===advancementPort&&relative!=='src/engine-compatibility/git-publication.mjs')problems.push(relative);
        if(target===singleDecisionPort&&relative!=='src/engine-compatibility/git-publication.mjs')problems.push(relative);
        if(target===testDecisionPort&&relative!=='src/engine-compatibility/git-publication.mjs')problems.push(relative);
        if(target===witnessWriter&&relative!=='src/engine-compatibility/git-decision-record.mjs')problems.push(relative);
        if(target===correctionPort&&relative!=='src/engine-compatibility/git-publication.mjs')problems.push(relative);
        if(target===upstreamPort&&relative!=='src/engine-compatibility/git-publication.mjs')problems.push(relative);
        if((target===forwardWriter||target===upstreamReader)&&relative!=='src/engine-compatibility/git-upstream.mjs')problems.push(relative);
      }
      ts.forEachChild(node,visit);
    };visit(source);
  }
  assert.deepEqual(problems,[],'old paths are compatibility exports, not another internal policy or write path');
});

test('extracted native decision writers do not import command handlers or host presentation',async()=>{
  const owners=['native-story-decisions.mjs','native-plan-decisions.mjs','native-obligation-risk.mjs',
    'native-evidence-decisions.mjs','native-visual-decisions.mjs','native-test-command-decisions.mjs',
    'native-test-narrowing-decisions.mjs','native-test-risk-decisions.mjs','native-upstream-decisions.mjs','native-witness-decisions.mjs','git-plan-correction.mjs',
    'git-decisions.mjs','git-decision-record.mjs','git-test-decision-record.mjs','record-decision-context.mjs',
    'test-decision-intent.mjs','git-advancement.mjs','convergence-projection-read.mjs',
    'git-upstream.mjs','native-forward-amendments.mjs','upstream-artifact-issues.mjs'];
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
