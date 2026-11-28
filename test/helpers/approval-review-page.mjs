/**
 * The VS Code approval page (apps/vscode/src/views/approval-review.ts) with a stub `vscode`, as the approval tests load it
 * (test/approval-witness-criteria.test.mjs): its validation, arguments, body and script are pure.
 */
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import ts from 'typescript';

export async function approvalReviewPage() {
  const [messages, webview, approvalsModel, sfGuardModel, tryIt] = await Promise.all([import('../../apps/vscode/src/views/messages.ts'),
    import('../../apps/vscode/src/views/webview.ts'), import('../../apps/vscode/src/views/approvals-model.ts'),
    import('../../apps/vscode/src/views/sf-guard-model.ts'), import('../../apps/vscode/src/views/try-it.ts')]);
  const source = await readFile(new URL('../../apps/vscode/src/views/approval-review.ts', import.meta.url), 'utf8');
  const exports = {};
  const modules = { './messages.ts': messages, './webview.ts': webview, './navigate.ts': { navigateTo() {} }, './approvals-model.ts': approvalsModel,
    './sf-guard-model.ts': sfGuardModel, './try-it.ts': tryIt };
  const context = vm.createContext({ exports, Date, require(name) {
    if (name === 'vscode') return {};
    if (Object.hasOwn(modules, name)) return modules[name];
    throw new Error(`Unexpected dependency: ${name}`);
  } });
  vm.runInContext(ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText, context);
  return exports;
}
