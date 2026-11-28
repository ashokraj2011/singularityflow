/**
 * Which person's question a changed file outside the plan is, by its path alone, with the words the card says it in
 * [owner, 2026-11-19, C3]: a dependency, how the product is built, shipped or tested, or who governs the repository. A
 * leaf the decision list reads; out-of-plan-classes.mjs holds the rest of the rule.
 */
import path from 'node:path';

import { configurationPathKind } from './configuration-paths.mjs';
import { classifySupportingChange } from './supporting-changes.mjs';

export const IGNORE_FILES = new Set(['.gitignore', '.dockerignore', '.npmignore', '.prettierignore', '.eslintignore']);
// A dependency manifest: what third-party code the product runs (lock files are configurationPathKind's dependency-lock).
const MANIFESTS = new Set(['package.json', 'pyproject.toml', 'go.mod', 'go.work', 'cargo.toml', 'pom.xml', 'build.gradle', 'build.gradle.kts',
  'gemfile', 'composer.json', 'pipfile', 'setup.py', 'setup.cfg', 'directory.packages.props', 'packages.config', 'podfile', 'package.swift', 'pubspec.yaml']);
const MANIFEST_PATTERNS = [/^requirements(?:[-_.][\w-]+)?\.txt$/u, /\.(?:cs|fs|vb)proj$/u, /\.gemspec$/u];
/**
 * What class of person's question a file is, by its path alone, with the words the card says it in; null for a file that is
 * none of the named ones (behaviour, unless a settle class takes it). Read by the card for every file departure.
 */
export function personClass(file) {
  const relative = String(file ?? '');
  const lower = relative.toLowerCase();
  const base = path.posix.basename(lower);
  const kind = configurationPathKind(relative);
  if (kind === 'dependency-lock' || MANIFESTS.has(base) || MANIFEST_PATTERNS.some((pattern) => pattern.test(base))) {
    return { class: 'dependency', words: 'It can add or change the third-party code the product runs, so a person decides it.' };
  }
  if (kind === 'build-configuration' || kind === 'ci-configuration' || classifySupportingChange(relative).class === 'ci-configuration') {
    return { class: 'build', words: 'It changes how the product is built, shipped or tested (a test runner\'s configuration can narrow which tests run), so a person decides it.' };
  }
  if (kind === 'repository-metadata' && !IGNORE_FILES.has(base)) {
    return { class: 'governance', words: 'It changes who reviews the repository, what is marked generated, or what runs when it is opened, so a person decides it.' };
  }
  return null;
}

/**
 * Who changed a file outside the plan, in the words every place shows it [WCB:REQ-014]: the code approval, its focus page,
 * the change story page's section 6 and the settlement. "by Copilot: <reason>" (", through a terminal command" when that is
 * what SFlow's hooks saw), "by you" (with why no hook could tell, for a folder VS Code opened through a link), or "from
 * <branch>, merged in: not changed in this Story" for a file that holds what the base branch has. A supporting change adds
 * ", as a supporting change"; Copilot owes no reason for one [owner, 2026-11-28].
 */
export function outsidePlanWho({ writer, reason = null, basis = null, branch = null, supporting = null } = {}) {
  if (writer === 'base') return `from ${branch ?? 'the base branch'}, merged in: not changed in this Story`;
  const as = supporting ? ', as a supporting change' : '';
  if (writer === 'copilot') {
    const how = basis === 'shell-write' || basis === 'shell-call' ? ', through a terminal command' : '';
    return `by Copilot${how}${reason ? `: ${reason}` : supporting ? '' : ': no reason written'}${as}`;
  }
  return `by you${basis === 'linked-folder' ? ' (no SFlow hooks ran here: VS Code opened this folder through a link)' : ''}${as}`;
}
