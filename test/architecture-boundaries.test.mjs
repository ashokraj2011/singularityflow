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
  const entries = ['index', 'errors', 'namespace', 'content', 'storage/journal'].map(name => `packages/engine-sdk/src/${name}.mjs`);
  const report = await inspectPureModuleGraph({ root: packageRoot, entries,
    allowed: [...foundation, ...kernel, ...sdk, ...namespaces, ...content, ...entries] });
  assert.deepEqual(report.problems, []);
});

test('only explicit storage adapters consume namespace contracts outside their pure directory', async () => {
  const directory = path.join(packageRoot, 'src/sda/namespace') + path.sep;
  // Phase 3 composes the existing owners without selecting a generic namespace store. CLI/SDK
  // routing is a later vertical slice; adding a direct host dependency must fail this guard.
  const compatibility = new Set(['src/sda/git-compatibility-contract.mjs', 'src/sda/git-compatibility-adapter.mjs']);
  const namespaceAdapters = new Set(['src/sda/filesystem-namespace-adapter.mjs', 'src/sda/filesystem-namespace-journal.mjs',
    'src/sda/namespace-journal-adapter.mjs', 'src/sda/application-namespace-adapter.mjs',
    'src/sda/sqlite-namespace-adapter.mjs', 'src/sda/sqlite-namespace-journal.mjs', 'src/sda/sqlite-native.mjs',
    'src/sda/content/contract.mjs', 'src/sda/sqlite-content-adapter.mjs',
    'src/engine-storage/namespace-reader.mjs', 'src/engine-storage/namespace-read-contract.mjs',
    'src/engine-storage/namespace-lifecycle-commit.mjs', 'src/engine-storage/namespace-lifecycle-contract.mjs']);
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
      else assert.ok(ts.isFunctionDeclaration(node) || ts.isExportDeclaration(node), file);
    }
  }
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

test('the namespace read host only composes explicit ports and has no repository, filesystem, provider or command owner', async () => {
  const allowed = new Set(['node:path', 'node:crypto', '../engine-sdk/index.mjs', '../foundation/failures.mjs',
    '../records.mjs', '../document-identity.mjs', '../kernel/phase-policy.mjs', '../sda/namespace/contract.mjs',
    '../sda/namespace/values.mjs', '../sda/content/contract.mjs', './namespace-read-contract.mjs']);
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
    '../sda/namespace/contract.mjs', '../sda/namespace/values.mjs', '../sda/namespace/transaction.mjs',
    '../sda/content/contract.mjs', './namespace-lifecycle-contract.mjs']);
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
    if (file === owner) continue;
    const text = await readFile(path.join(packageRoot, file), 'utf8');
    assert.equal(text.includes('namespace-lifecycle-commit.mjs'), false, file + ' must not select the new authority before a verified cutover');
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
  const oldRules=new Set(['src/phase-roles.mjs','src/phase-generation.mjs',
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
        if(oldRules.has(target)||(transitions.has(target)&&relative!=='src/state.mjs'))problems.push(relative);
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
  const config = await read('src/config.mjs'), review = await read('src/source-review-policy.mjs');
  assert.match(config, /assertSourceReviewerAvailable, normalizeSourceReviewPolicy.*kernel\/phase-admission\.mjs/);
  assert.doesNotMatch(review, /function normalizeSourceReviewPolicy|function assertSourceReviewerAvailable/);
  const simulation = await read('src/workflow-lifecycle-simulation.mjs');
  assert.match(simulation, /sequenceAdmission as evaluateSequence/); assert.doesNotMatch(simulation, /from '\.\/sequence\.mjs'/);
  const identity = await read('src/build-identity.mjs'), manifest = await read('src/vsix-source-manifest.mjs');
  for (const name of ['kernel/lifecycle-transitions.mjs','kernel/phase-admission.mjs']) {
    assert.ok(identity.includes("'" + name + "'"), name + ' must invalidate advisory snapshots');
    assert.ok(manifest.includes("'src/" + name + "'"), name + ' must be present in staged CLI payloads');
  }
});

test('workflow compilation and routing simulation use the pure interpreter while native rendering and pending hashes stay outside it', async () => {
  const core = await readFile(path.join(packageRoot, 'src/kernel/workflow-decisions.mjs'), 'utf8');
  assert.doesNotMatch(core, /singularity-flow|createHash|canonicalJson|applicabilityStatus|describeWhen|describeOutcome|parseDecisionAssignments|storyDecisionView/);
  for (const file of ['config.mjs', 'workflow-route-simulation.mjs', 'phase-retention.mjs']) {
    const source = await readFile(path.join(packageRoot, 'src', file), 'utf8');
    assert.match(source, /from '\.\/kernel\/workflow-decisions\.mjs'/, file);
    assert.doesNotMatch(source, /from '\.\/workflow-decisions\.mjs'/, file);
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
  for(const file of ['src/config.mjs','src/skp-contract.mjs']) {
    const source=await readFile(path.join(packageRoot,file),'utf8');
    assert.match(source,/import \{normalizeClarificationPolicy\} from '\.\/kernel\/phase-inputs.mjs'/);
    assert.doesNotMatch(source,/from '\.\/clarifications.mjs'/);
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
