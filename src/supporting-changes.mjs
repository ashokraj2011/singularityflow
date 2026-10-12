/**
 * What a plan may list under `## Supporting files`: changes the code needs that no requirement
 * claims and that cannot carry a `@clause` tag. Each entry must belong to one of a closed set of
 * classes and state why it changes. Application source, test source and migrations never qualify:
 * listing them as supporting would let behaviour escape requirement accounting, so they belong in
 * a clause row of the plan instead.
 */
import path from 'node:path';
import { posix } from './util.mjs';
import { isTestAutomationPath } from './source-boundary.mjs';
import { configurationPathKind } from './configuration-paths.mjs';

export const SUPPORTING_CHANGE_CLASSES = Object.freeze([
  'dependency-lock', 'build-configuration', 'ci-configuration', 'repository-metadata', 'documentation'
]);

const DOCUMENT_EXTENSIONS = /\.(?:md|markdown|mdx|rst|adoc|txt)$/u;
const MIGRATION_SEGMENT = /(?:^|\/)(?:migrations?|db\/migrate)(?:\/|$)/u;
// CI helper scripts were already permitted supporting assets. Keep that exact scope policy:
// they do not become configuration merely by living next to a YAML file, and approved plans
// must not fail to load because the configuration/source roles are now separated.
const CI_SUPPORT_PATHS = [/^\.github\/actions\//u, /^\.gitlab\/ci\//u, /^\.azure-pipelines\//u, /^\.circleci\//u, /^\.buildkite\//u];

/**
 * Classify one exact repository path for the supporting-files list.
 * Returns `{ class }` for an allowed class, or `{ refused, reason }` when the path cannot be one.
 */
export function classifySupportingChange(candidate) {
  const relative = posix(String(candidate ?? '')).replace(/^\.\//u, '');
  const lower = relative.toLowerCase();
  const base = path.posix.basename(lower);
  const atRoot = !lower.includes('/');
  if (MIGRATION_SEGMENT.test(lower)) {
    return { refused: 'migration', reason: 'a migration changes data or schema behaviour' };
  }
  const configuration = configurationPathKind(relative);
  if (configuration === 'runtime-configuration') {
    return { refused: 'configuration', reason: 'runtime configuration belongs in a clause with fulfillment configuration, not unclaimed supporting files' };
  }
  if (configuration) return { class: configuration };
  if (isTestAutomationPath(relative)) {
    return { refused: 'test-source', reason: 'a test belongs in the Planned tests column of its clause row' };
  }
  if (CI_SUPPORT_PATHS.some(pattern => pattern.test(lower))) return { class: 'ci-configuration' };
  if (DOCUMENT_EXTENSIONS.test(base) && (atRoot || /^docs?\//u.test(lower))) return { class: 'documentation' };
  return { refused: 'application-source', reason: 'it can carry application behaviour, so a clause must claim it' };
}
