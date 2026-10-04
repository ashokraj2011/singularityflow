import path from 'node:path';
import { verifyGroundingRecord } from './grounding.mjs';
import { exists } from './util.mjs';

/** Read the same grounding contract as publication, without composing or replacing a prompt. */
export async function phaseGroundingPreflight(root, config, workflow, phase, draft) {
  // Missing session ownership changes who may repair the draft, not what publication verifies.
  if (!['governed-agent', 'legacy-unspecified'].includes(draft.configuredProducer ?? draft.producer)) {
    return { blockers: [], actions: [], check: { errors: [], warnings: [], record: null },
      projection: { status: 'not-applicable', warnings: [] } };
  }
  let check;
  try {
    check = await verifyGroundingRecord(root, config, workflow, phase, {
      agent: draft.ownership.proven ? draft.ownership.agent : null, generation: draft.generation
    });
  } catch (error) {
    check = { errors: [error.message], warnings: [], path: null };
  }
  const missing = check.path && !(await exists(path.join(root, check.path)));
  const blockers = check.errors.map((message) => ({
    code: missing ? 'phase.grounding.required' : 'phase.grounding.not-ready',
    category: 'grounding', path: check.path, line: null, message
  }));
  return {
    check,
    blockers,
    actions: blockers.length ? [{
      command: missing ? `singularity-flow wm compose --phase ${phase.id}`
        : 'singularity-flow wm doctor --json',
      skill: '/sf-worldmodel',
      detail: missing
        ? 'Compose the governed phase prompt, then rerun prepublish. No prompt has been recorded for this generation.'
        : 'Inspect the grounding diagnostics before retrying. Preserve the saved generation prompt and receipt; '
          + 'rebuilding a World Model does not replace context already used for generation. '
          + 'Use governed recovery if a new generation is needed; never edit receipt hashes or freshness flags.'
    }] : [],
    projection: {
      status: blockers.length ? 'blocked' : check.mode === 'off' ? 'off'
        : check.warnings.length ? 'warning' : 'ready',
      mode: check.mode ?? null, path: check.path,
      staleness: check.staleness ?? null, warnings: check.warnings
    }
  };
}
