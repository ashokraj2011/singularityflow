/**
 * Picking register items at Story creation [CQF:REQ-065, REQ-068].
 *
 * A new Story is shown the register's open items for its repository, highest severity and nearest due
 * date first, with any item another Story already addresses shown with that Story and not pickable.
 * Nothing is picked by default. Each picked item becomes a clause of the Story's source with its
 * proof, and its register state becomes "in a Story". The list is read from the state ref this clone
 * has; a Story never fetches it.
 *
 * The clause is SFlow's sentence about the item. The team's own words (a title, a component) appear in
 * it only quoted, bounded and on one line: data the Story is about, never an instruction to the model.
 */
import { compareItems, PICKABLE_STATES, setItemStates } from './model.mjs';
import { repositoryMatches } from './format.mjs';
import { currentRepository, readRegister, registerDestination, registerLedger, writeRegister } from './store.mjs';
import { normalizeLedgerConfig } from '../../ledger-config.mjs';

const LISTED_STATES = Object.freeze(['open', 'in-story']);
/** The team's own words as SFlow shows them: one line, no quotes or control characters, bounded, in quotes. */
export const quoted = (value, maximum = 160) => {
  const text = String(value ?? '').replace(/[\u0000-\u001f\u007f"]+/gu, ' ').replace(/\s+/gu, ' ').trim();
  return `"${text.length <= maximum ? text : `${text.slice(0, maximum - 1)}…`}"`;
};

/** One item as a list row: what a person needs to choose it. */
export function itemSummary(item) {
  return {
    id: item.id, feed: item.feed, state: item.state, severity: item.severity ?? null, dueAt: item.dueAt ?? null,
    label: item.feed === 'tlm' ? `${item.component} ${item.currentVersion ?? '?'} → ${item.targetVersion}` : item.title,
    ...(item.file ? { file: item.file, line: item.line ?? null } : {}),
    ...(item.package ? { package: item.package, installedVersion: item.installedVersion ?? null, fixedVersion: item.fixedVersion ?? null } : {}),
    ...(item.feed === 'tlm' ? { component: item.component, ecosystem: item.ecosystem ?? null, currentVersion: item.currentVersion ?? null, targetVersion: item.targetVersion, endOfLifeAt: item.endOfLifeAt ?? null } : {}),
    repository: item.repository, source: item.source, story: item.story?.workId ?? null
  };
}

/** The proof a picked item's clause carries (REQ-068). */
export function itemProof(item) {
  const both = 'All existing tests run, and the build passes.';
  if (item.feed === 'tlm') {
    return `The manifest, lockfile or runtime file that pins ${quoted(item.component, 80)} shows ${quoted(item.targetVersion, 40)} or later. ${both}`;
  }
  const tool = item.tool ? quoted(item.tool, 60) : 'the tool that reported it';
  return `The same tool, ${tool}, run on the changed code no longer reports it; a finding only the security team can rescan is recorded as fixed, awaiting rescan. ${both}`;
}

/** The clause a picked item becomes: an anchor of its own, SFlow's sentence, its proof. */
export function itemClause(item) {
  const due = item.dueAt ? `, due ${item.dueAt}` : '';
  let text;
  if (item.feed === 'tlm') {
    text = `Upgrade the component the TLM list names ${quoted(item.component, 80)}${item.ecosystem ? ` (${item.ecosystem})` : ''}`
      + `${item.currentVersion ? ` from ${quoted(item.currentVersion, 40)}` : ''} to ${quoted(item.targetVersion, 40)} or later${due}.`;
  } else {
    const where = [item.file ? `in ${quoted(item.file, 120)}${item.line ? ` line ${item.line}` : ''}` : null,
      item.package ? `in the package ${quoted(item.package, 80)}${item.installedVersion ? ` ${quoted(item.installedVersion, 40)}` : ''}${item.fixedVersion ? ` (fixed in ${quoted(item.fixedVersion, 40)})` : ''}` : null,
      item.cve ? `(${quoted(item.cve, 40)})` : null, item.rule ? `rule ${quoted(item.rule, 80)}` : null].filter(Boolean).join(' ');
    text = `Fix the ${item.severity} security finding the security team titled ${quoted(item.title)}${where ? ` ${where}` : ''}${due}.`;
  }
  return { anchor: `[${item.id}]`, text, proof: itemProof(item) };
}

/** A picked item as the Story's source records it: the item's facts, its clause and proof. */
export function sourceFinding(item, at) {
  const clause = itemClause(item);
  return { ...itemSummary(item), anchor: clause.anchor, text: clause.text, proof: clause.proof, pickedAt: at,
    ...(item.rule ? { rule: item.rule } : {}), ...(item.tool ? { tool: item.tool } : {}), ...(item.cve ? { cve: item.cve } : {}) };
}

/**
 * The register's open items and the items other Stories address, for this repository: what a new
 * Story offers. Never throws: a register that cannot be read is `available: false` with the reason.
 */
export async function findingsForStart(root, { ledger = null, env = process.env, limit = 50 } = {}) {
  try {
    const settings = ledger ? normalizeLedgerConfig(ledger) : await registerLedger(root);
    const [read, repository] = await Promise.all([readRegister(root, { env, ledger: settings }), currentRepository(root, settings, { env })]);
    const items = ['security', 'tlm'].flatMap((feed) => read.register[feed].items)
      .filter((item) => LISTED_STATES.includes(item.state) && repositoryMatches(item.repository, repository))
      .sort(compareItems);
    return {
      available: true, location: read.location, repository: repository.slug ?? repository.name,
      total: items.length, open: items.filter((item) => PICKABLE_STATES.includes(item.state)).length,
      items: items.slice(0, limit).map(itemSummary)
    };
  } catch (error) {
    return { available: false, reason: String(error?.message ?? error).split('\n')[0].slice(0, 300), items: [], total: 0, open: 0 };
  }
}

/** `--address A,B` as IDs, in order, once each. */
export function addressedIds(values) {
  return [...new Set((Array.isArray(values) ? values : [values]).flatMap((value) => String(value ?? '').split(','))
    .map((value) => value.trim()).filter(Boolean))];
}

/**
 * The items a Story asked to address, as source findings, and the ones it could not take with why:
 * unknown, another repository's, already in another Story, or not open. Nothing refuses.
 */
export async function resolveAddressedFindings(root, ids, { ledger = null, env = process.env, at = new Date().toISOString() } = {}) {
  if (!ids.length) return { picked: [], skipped: [] };
  const settings = ledger ? normalizeLedgerConfig(ledger) : await registerLedger(root);
  const [read, repository] = await Promise.all([readRegister(root, { env, ledger: settings }), currentRepository(root, settings, { env })]);
  const byId = new Map(['security', 'tlm'].flatMap((feed) => read.register[feed].items.map((item) => [item.id, item])));
  const picked = [];
  const skipped = [];
  for (const id of ids) {
    const item = byId.get(id);
    if (!item) skipped.push({ id, reason: 'it is not in the register' });
    else if (!repositoryMatches(item.repository, repository)) skipped.push({ id, reason: `it names another repository (${item.repository})` });
    else if (item.state === 'in-story') skipped.push({ id, reason: `Story ${item.story?.workId ?? 'another Story'} already addresses it`, story: item.story?.workId ?? null });
    else if (!PICKABLE_STATES.includes(item.state)) skipped.push({ id, reason: `it is ${item.state.replaceAll('-', ' ')}` });
    else picked.push(sourceFinding(item, at));
  }
  return { picked, skipped };
}

/**
 * Mark picked items "in a Story" in the register, where the register may be written. Never throws:
 * a Story that started stays started, and the result says what to run when the mark did not land.
 */
export async function markFindingsInStory(root, picked, workId, { branch = null, ledger = null, env = process.env, at = new Date().toISOString(), runCommand = undefined } = {}) {
  if (!picked.length) return { marked: [] };
  try {
    const settings = ledger ? normalizeLedgerConfig(ledger) : await registerLedger(root);
    const destination = await registerDestination(root, settings, { env, ...(runCommand ? { runCommand } : {}) });
    let moved = [];
    const written = await writeRegister(root, settings, destination, (register) => {
      let next = register;
      moved = [];
      for (const feed of ['security', 'tlm']) {
        const ids = picked.filter((entry) => entry.feed === feed).map((entry) => entry.id);
        if (!ids.length) continue;
        const result = setItemStates(next, feed, ids, 'in-story', { at, reason: `picked by Story ${workId}`, story: { workId, ...(branch && branch !== workId ? { branch } : {}), linkedAt: at } });
        next = result.register;
        moved.push(...result.moved);
      }
      return next;
    }, `Story ${workId} addresses ${picked.map((entry) => entry.id).join(', ')}`, { env });
    return { marked: moved, store: written.store, storeMessage: written.message };
  } catch (error) {
    return { marked: [], error: String(error?.message ?? error).split('\n')[0].slice(0, 300),
      nextAction: `singularity-flow findings link ${workId} --address ${picked.map((entry) => entry.id).join(',')}` };
  }
}
