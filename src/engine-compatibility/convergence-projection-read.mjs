/** Reads the installed convergence file layout; does not create or move lifecycle authority. */
import path from 'node:path';
import {readFile} from 'node:fs/promises';
import {decodeConvergenceRecord} from '../convergence.mjs';
import {posix,exists,SingularityFlowError} from '../util.mjs';

export function convergenceRecordRelative(itemRelative, iteration) {
  return posix(path.join(itemRelative, 'context', 'convergence', `iteration-${iteration}.json`));
}

export async function readConvergence(root, itemRelative, iteration) {
  const relative = convergenceRecordRelative(itemRelative, iteration);
  if (!(await exists(path.join(root, relative)))) return null;
  try {
    return decodeConvergenceRecord(await readFile(path.join(root, relative)), { iteration });
  } catch (error) {
    if (['SCHEMA_VERSION_FUTURE', 'SCHEMA_VERSION_ARCHIVED'].includes(error?.code)) throw error;
    throw new SingularityFlowError(
      `Convergence record '${relative}' is corrupt and cannot authorize a decision: ${error.message}`,
      { code: error.code ?? 'CONVERGENCE_RECORD_CORRUPT', details: { path: relative }, cause: error }
    );
  }
}
