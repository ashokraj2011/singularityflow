/**
 * Which files are governed configuration.
 *
 * Kept apart from validation.ts, which needs `vscode` and so cannot be loaded in a plain Node
 * process. This is the part worth testing — deciding what counts as configuration is a judgement,
 * and the judgement that matters most is what it excludes.
 */
import path from 'node:path';

/**
 * Governed configuration, relative to the repository root.
 *
 * Generated world models and initiative state are deliberately absent. They live under the same
 * directory and look similar, but they are engine output rather than the team's settings: editing
 * them is a different problem with a different answer, and validating them as configuration would
 * report the wrong thing about the wrong file.
 */
const GOVERNED = [
  /^singularity\/workflow\.yml$/,
  /^singularity\/portfolio\.yml$/,
  /^singularity\/personas\/.*\.md$/,
  /^singularity\/templates\/.*$/,
  /^singularity\/prompts\/.*\.md$/,
  /^\.github\/skills\/.*\.md$/,
  /^singularity\/agent-mappings\.yml$/
];

export function isGovernedConfiguration(repository: string, file: string): boolean {
  const relative = path.relative(repository, file).split(path.sep).join('/');
  if (relative.startsWith('..') || path.isAbsolute(relative)) return false;
  return GOVERNED.some((pattern) => pattern.test(relative));
}
