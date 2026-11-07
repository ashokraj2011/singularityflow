/** Shared document option grammar; no document storage or lifecycle access. */
import {nearestNames,SingularityFlowError} from '../../util.mjs';

// Options every documents subcommand accepts. A near miss of anything else is refused below.
const DOCUMENTS_COMMON_OPTIONS = Object.freeze(['json', 'verbose', 'work-id']);
const DOCUMENTS_SUBCOMMAND_OPTIONS = Object.freeze({
  artifacts: ['version'],
  list: ['active', 'all', 'phase'],
  view: ['all'],
  preview: [],
  browse: ['provider', 'path'],
  detach: ['reason', 'scope', 'dry-run', 'yes'],
  scope: ['phases', 'reason', 'scope', 'dry-run', 'yes'],
  store: ['store'],
  restore: ['file'],
  readiness: ['phase'],
  upload: ['url', 'name', 'label', 'kind', 'phases', 'store', 'confirm-override'],
  add: ['url', 'name', 'label', 'kind', 'phases', 'store', 'confirm-override'],
  fetch: ['provider', 'ref', 'name', 'filename', 'label', 'kind', 'phases', 'store', 'confirm-override']
});

/**
 * Refuse an option that is a near miss of one this subcommand reads. `--phase specification` on an
 * upload, silently ignored, would offer the document to the default phases instead: a governed
 * mutation that did something other than what was typed. Options that are not close to any known
 * one are left alone, because other layers of the CLI read their own.
 */
export function refuseNearMissDocumentOptions(subcommand, options) {
  const known = [...DOCUMENTS_COMMON_OPTIONS, ...(DOCUMENTS_SUBCOMMAND_OPTIONS[subcommand] ?? [])];
  for (const key of Object.keys(options)) {
    if (known.includes(key)) continue;
    const nearest = nearestNames(key, known, { limit: 1 })[0];
    if (nearest) {
      throw new SingularityFlowError(`'documents ${subcommand}' has no option --${key}. Did you mean --${nearest}?`,
        { code: 'UNKNOWN_OPTION', details: { command: `documents ${subcommand}`, option: key, suggestion: nearest } });
    }
  }
}
