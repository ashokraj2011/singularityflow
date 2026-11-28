/**
 * Every `'update-ref'` in SFlow's source, sorted by whose ref it moves [owner, 2026-11-28]: SFlow's own, through the one
 * private-ref rule (util.mjs withPrivateGitRef), or a person's or Copilot's, which the commit policy checks as before.
 *
 * A site is SFlow's own when its update-ref sits in a call to withPrivateGitRef or to a local helper that is nothing but a
 * call to it (`const retain = (...) => withPrivateGitRef(...)`), or in an array held by a variable that its function passes
 * to one of those. Read from syntax trees; nothing runs.
 */
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

const RULE = 'withPrivateGitRef';

export function refUpdateSites(file, text) {
  const ast = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const rules = new Set([RULE]);
  (function helpers(node) {
    const body = ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer
      && ts.isArrowFunction(node.initializer) ? node.initializer.body : null;
    if (body && ts.isCallExpression(body) && ts.isIdentifier(body.expression) && body.expression.text === RULE) rules.add(node.name.text);
    ts.forEachChild(node, helpers);
  })(ast);
  const callsRule = (node) => ts.isCallExpression(node) && ts.isIdentifier(node.expression) && rules.has(node.expression.text);
  const isPrivate = (literal) => {
    let array = null;
    for (let parent = literal.parent; parent; parent = parent.parent) {
      if (callsRule(parent)) return true;
      if (!array && ts.isArrayLiteralExpression(parent)) array = parent;
      if (ts.isFunctionLike(parent) || ts.isSourceFile(parent)) {
        const held = array?.parent;
        if (!held || !ts.isVariableDeclaration(held) || !ts.isIdentifier(held.name)) return false;
        let passed = false;
        (function find(node) {
          if (passed) return;
          if (callsRule(node) && node.arguments[1] && ts.isIdentifier(node.arguments[1]) && node.arguments[1].text === held.name.text) passed = true;
          else ts.forEachChild(node, find);
        })(parent);
        return passed;
      }
    }
    return false;
  };
  const sites = { private: 0, checked: 0 };
  (function visit(node) {
    if (ts.isStringLiteralLike(node) && node.text === 'update-ref') sites[isPrivate(node) ? 'private' : 'checked'] += 1;
    ts.forEachChild(node, visit);
  })(ast);
  return sites;
}

/** Each src file with an update-ref, but util.mjs: the policy's own check names the verb. */
export function sourceRefUpdates(root) {
  const found = {};
  const walk = (directory) => {
    for (const entry of readdirSync(path.join(root, directory), { withFileTypes: true })) {
      const relative = path.posix.join(directory, entry.name);
      if (entry.isDirectory()) walk(relative);
      else if (entry.name.endsWith('.mjs') && relative !== 'src/util.mjs') {
        const text = readFileSync(path.join(root, relative), 'utf8');
        if (!text.includes('update-ref')) continue;
        const sites = refUpdateSites(relative, text);
        if (sites.private || sites.checked) found[relative] = sites;
      }
    }
  };
  walk('src');
  return found;
}
