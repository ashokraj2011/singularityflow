/**
 * Every governed push names the revision it expects to replace (SDA §7.2 item 2, SDA-AC-025).
 *
 * Three shapes are read from src/ as syntax trees. A Git push argument list (an array whose verb is
 * `push`) must carry a `--force-with-lease`, or be a `--dry-run`. A call to the branch push helper
 * must name `expectedRemoteSha` in its options. A stated `unleased` reason, to that helper or to the
 * publication unit of work, marks a push on fast-forward protection alone. The sites below are those;
 * each says why, and the list may only shrink: an entry that no longer matches a site fails.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { run } from '../src/util.mjs';
import { pushCommitToBranchAsync } from '../src/git.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BRANCH_PUSH_HELPERS = new Set(['pushCommitToBranchAsync', 'pushCommitToBranch']);

const FAST_FORWARD_ONLY = Object.freeze({
  'git.mjs#pushIsolatedDeliveryCommit':
    'Source delivery, not governed state. A plain push never rewrites the branch; a moved branch is reported as moved.',
  'state.mjs#unleased':
    'Story recovery of a pending publication saved before exact leases existed; it keeps fast-forward protection.',
  'publication-pending.mjs#unleased':
    'The same recovery for a pending publication saved before exact leases existed.',
  'workflow-walk/sandbox.mjs#createSandbox':
    'A workflow walk\'s throwaway project, pushed once to its own empty local remote: no governed state, nothing to replace.'
});

async function sourceFiles(directory, output = []) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) await sourceFiles(absolute, output);
    else if (entry.name.endsWith('.mjs')) output.push(absolute);
  }
  return output;
}

function stringValue(node) {
  return ts.isStringLiteralLike(node) ? node.text : null;
}

/** The index of the `push` verb when the array is a Git argument list (`-c key=value` pairs may lead). */
function pushVerbIndex(array) {
  for (let index = 0; index < array.elements.length; index += 2) {
    const value = stringValue(array.elements[index]);
    if (value === 'push') return index;
    if (value !== '-c') return -1;
  }
  return -1;
}

function enclosingFunction(node) {
  for (let current = node.parent; current; current = current.parent) {
    if ((ts.isFunctionDeclaration(current) || ts.isMethodDeclaration(current)) && current.name) return current.name.text;
    if ((ts.isArrowFunction(current) || ts.isFunctionExpression(current)) && ts.isVariableDeclaration(current.parent)) {
      return current.parent.name.getText();
    }
  }
  return '<module>';
}

/** `Object.freeze([...])` is a constant list (`PENDING_OPERATION_KINDS`), never a process's arguments. */
function frozenConstant(array, sourceFile) {
  return ts.isCallExpression(array.parent) && array.parent.expression.getText(sourceFile) === 'Object.freeze';
}

/** Whether one argument-list element carries a lease: its text, or a variable named for one. */
function carriesLease(element, sourceFile) {
  if (element.getText(sourceFile).includes('--force-with-lease')) return true;
  const named = ts.isSpreadElement(element) ? element.expression : element;
  return ts.isIdentifier(named) && /lease/iu.test(named.text);
}

function objectFor(node, sourceFile) {
  if (ts.isObjectLiteralExpression(node)) return node;
  if (!ts.isIdentifier(node)) return null;
  let found = null;
  const visit = (candidate) => {
    if (!found && ts.isVariableDeclaration(candidate) && candidate.name.getText(sourceFile) === node.text
        && candidate.initializer && ts.isObjectLiteralExpression(candidate.initializer)) found = candidate.initializer;
    ts.forEachChild(candidate, visit);
  };
  visit(sourceFile);
  return found;
}

export async function governedPushSites(sourceRoot = path.join(root, 'src')) {
  const sites = [];
  for (const file of await sourceFiles(sourceRoot)) {
    const text = await readFile(file, 'utf8');
    if (!/'push'|pushCommitToBranch/u.test(text)) continue;
    const sourceFile = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
    const relative = path.relative(sourceRoot, file).split(path.sep).join('/');
    const line = (node) => sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
    const visit = (node) => {
      if (ts.isArrayLiteralExpression(node) && (ts.isCallExpression(node.parent) || ts.isVariableDeclaration(node.parent))
          && !frozenConstant(node, sourceFile)) {
        const verb = pushVerbIndex(node);
        if (verb >= 0) {
          const rest = node.elements.slice(verb + 1);
          const kind = rest.some((element) => stringValue(element) === '--dry-run') ? 'dry-run'
            : rest.some((element) => carriesLease(element, sourceFile)) ? 'leased' : 'unleased';
          sites.push({ key: `${relative}#${enclosingFunction(node)}`, line: line(node), shape: 'argv', kind });
        }
      }
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && BRANCH_PUSH_HELPERS.has(node.expression.text)
          && !(ts.isFunctionDeclaration(node.parent))) {
        const options = node.arguments[4] ? objectFor(node.arguments[4], sourceFile) : null;
        const names = new Set((options?.properties ?? []).map((property) => property.name?.getText(sourceFile)).filter(Boolean));
        const kind = names.has('expectedRemoteSha') ? 'leased'
          : options?.getText(sourceFile).includes('unleased') ? 'unleased' : 'missing';
        sites.push({
          key: kind === 'unleased' ? `${relative}#unleased` : `${relative}#${enclosingFunction(node)}`,
          line: line(node), shape: 'helper', kind
        });
      }
      // A stated reason, to the branch helper or in a publication spec for the unit of work. Forwarding
      // a caller's own reason (`unleased: publication.unleased`) states none.
      if (ts.isPropertyAssignment(node) && node.name.getText(sourceFile) === 'unleased'
          && !(ts.isPropertyAccessExpression(node.initializer) && node.initializer.name.text === 'unleased')) {
        sites.push({ key: `${relative}#unleased`, line: line(node), shape: 'reason', kind: 'unleased' });
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
  }
  return sites;
}

test('every governed push names the revision it replaces, and the fast-forward-only list only shrinks (SDA-AC-025)', async () => {
  const sites = await governedPushSites();
  // The scan finds what it is meant to: the branch helper's callers and the raw push lists.
  assert.ok(sites.filter((site) => site.shape === 'helper').length >= 6);
  assert.ok(sites.filter((site) => site.shape === 'argv' && site.kind === 'leased').length >= 15);
  const missing = sites.filter((site) => site.kind === 'missing').map((site) => `${site.key}:${site.line}`);
  assert.deepEqual(missing, [], 'a branch push helper call must name expectedRemoteSha, or unleased with a listed reason');
  const unleased = [...new Set(sites.filter((site) => site.kind === 'unleased').map((site) => site.key))].sort();
  assert.deepEqual(unleased, Object.keys(FAST_FORWARD_ONLY).sort(),
    'a push without a lease is listed with its reason; a listed site that now leases is removed from the list');
});

test('the scan tells a leased push list from an unleased one', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'sflow-push-lease-'));
  await writeFile(path.join(directory, 'fixture.mjs'), [
    "async function leased() { return runRemoteGitAsync(['push', `--force-with-lease=${ref}:`, remote, spec]); }",
    "async function bare() { return runRemoteGitAsync(['-c', 'core.hooksPath=x', 'push', remote, spec]); }",
    "async function probe() { return runRemoteGitAsync(['push', '--dry-run', remote, spec]); }",
    "async function named() { const args = ['push', ...leases, remote, spec]; return runRemoteGitAsync(args); }",
    "const COMMANDS = [['push', 'retry'], ['fetch', 'push']];",
    "async function helper() { return pushCommitToBranchAsync(root, remote, commit, branch, { transportRemote }); }",
    "async function legacy() { return unit.execute({ publication: { mode: 'required', unleased: 'an older record' } }); }",
    "async function forward(publication) { return pushCommitToBranchAsync(root, remote, commit, branch, { expectedRemoteSha: publication.expectedRemoteSha, unleased: publication.unleased }); }"
  ].join('\n'));
  const sites = await governedPushSites(directory);
  assert.deepEqual(sites.map((site) => [site.key, site.kind]), [
    ['fixture.mjs#leased', 'leased'], ['fixture.mjs#bare', 'unleased'], ['fixture.mjs#probe', 'dry-run'],
    ['fixture.mjs#named', 'leased'], ['fixture.mjs#helper', 'missing'], ['fixture.mjs#unleased', 'unleased'],
    ['fixture.mjs#forward', 'leased']
  ]);
});

test('the branch push helper refuses to push without an expected revision or a stated reason', async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), 'sflow-push-lease-run-'));
  const bare = path.join(base, 'remote.git');
  const work = path.join(base, 'work');
  run('git', ['init', '-q', '--bare', bare]);
  run('git', ['init', '-q', '-b', 'main', work]);
  await writeFile(path.join(work, 'README.md'), 'one\n');
  run('git', ['add', 'README.md'], { cwd: work });
  run('git', ['-c', 'user.name=Lease Test', '-c', 'user.email=lease@example.test', 'commit', '-qm', 'one'], { cwd: work });
  run('git', ['remote', 'add', 'origin', bare], { cwd: work });
  const commit = run('git', ['rev-parse', 'HEAD'], { cwd: work }).stdout.trim();
  await assert.rejects(pushCommitToBranchAsync(work, 'origin', commit, 'governed', {}),
    (error) => error.code === 'PUSH_EXPECTED_REVISION_REQUIRED');
  assert.notEqual(run('git', ['--git-dir', bare, 'rev-parse', '--verify', 'refs/heads/governed'], { allowFailure: true }).status, 0,
    'nothing was pushed');
  assert.equal((await pushCommitToBranchAsync(work, 'origin', commit, 'governed', { expectedRemoteSha: null })).status, 0);
  assert.equal((await pushCommitToBranchAsync(work, 'origin', commit, 'other', { unleased: 'test of the stated reason' })).status, 0);
});
