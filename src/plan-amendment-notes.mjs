/**
 * What the plan's amendments changed, said to the next turn from the record [bin-opr2].
 *
 * After PAM-001 was recorded the next /sf-code still said "the approved plan has no amendment", and moved only
 * when the person typed a sentence. An amendment changes what a code step may and must touch, so phase
 * entry names each one and what it still needs: a file it lists that is not in this checkout yet has to be
 * created. Reads the record and asks only whether each file exists. It informs and refuses nothing.
 */
import { lstat } from 'node:fs/promises';
import path from 'node:path';

import { countedRecords } from './presence/counted.mjs';

const LATEST = 5;

function changeWords(change) {
  return change.kind === 'add-location' ? `added ${change.path} to ${change.clauseId}` : `added ${change.path} as a supporting change (${change.class})`;
}

/** Each amendment of the Story, newest last, with the files it lists that are missing here. Empty when the plan was never amended. */
export async function planChangeNotes(root, workflow) {
  const notes = [];
  for (const amendment of countedRecords(workflow, workflow?.planAmendments).slice(-LATEST)) {
    const changes = (amendment.changes ?? []).filter((change) => change.path);
    const missing = [];
    for (const change of changes) {
      if (!await lstat(path.join(root, change.path)).then(() => true, () => false)) missing.push(change.path);
    }
    const unique = [...new Set(missing)];
    notes.push({ id: amendment.id, paths: changes.map((change) => change.path), missing: unique,
      words: `${amendment.id} ${changes.map(changeWords).join(', ')}${unique.length ? `; ${unique.join(', ')} ${unique.length === 1 ? 'does' : 'do'} not exist yet, so create ${unique.length === 1 ? 'it' : 'them'}` : ''}.` });
  }
  return notes;
}
