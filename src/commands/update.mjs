/**
 * `singularity-flow update`: the installed package's own updater, so nobody needs a script path.
 * It is loaded only here, outside the shared CLI/read bundle closure: runtime/update.mjs and its
 * runtime/updater/* closure are Node built-ins only and also ship in the VSIX and the updater ZIP.
 */
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { PACKAGE_ROOT } from '../package-root.mjs';
import { optionBoolean, SingularityFlowError } from '../util.mjs';

/** The CLI's own flags, which the updater does not know. */
const CLI_FLAGS = new Set(['--json', '--timings', '--for-agent']);

export async function run(argv, { options = {} } = {}) {
  const start = argv.indexOf('update');
  const updaterArgv = argv.slice(start + 1).filter(arg => !CLI_FLAGS.has(arg));
  const json = optionBoolean(options, 'json');
  const updater = await import(pathToFileURL(path.join(PACKAGE_ROOT, 'runtime', 'update.mjs')).href);
  let result;
  try {
    result = await updater.updateCommand(updaterArgv, {
      interactive: Boolean(process.stdin.isTTY) && !json,
      // With --json, stdout carries only the result; progress goes to stderr.
      log: json ? (text) => process.stderr.write(`${text}\n`) : (text) => console.log(text)
    });
  } catch (error) {
    // A wrong link or folder is fixed by another source; anything else by the same command once its cause is fixed.
    const nextAction = error?.sourceProblem
      ? { command: 'singularity-flow update --source \'LINK\'', label: 'Use the folder link you were given.' }
      : { command: 'singularity-flow update', label: 'Resolve the reported cause, then run the update again.' };
    throw new SingularityFlowError(`SFlow update failed: ${error?.message ?? error}`,
      { code: 'SFLOW_UPDATE_FAILED', details: { nextAction }, cause: error });
  }
  if (json && result?.status !== 'help') console.log(JSON.stringify(result, null, 2));
  return result;
}
