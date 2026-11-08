/**
 * `findings report` [CQF:REQ-069]: the update for the security team and the TLM owners, in the same
 * workbook format they upload, with each item's SFlow state, the Story that addresses it and its
 * evidence in three more columns. A person sends it; SFlow never sends anything by itself.
 *
 * Items whose Story has closed move on first (remediation.mjs), and that move is written to the
 * register like an import's, so the report and the register say the same thing.
 */
import { lstat, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { SingularityFlowError } from '../../util.mjs';
import { writeXlsx } from '../workbook/xlsx.mjs';
import { COLUMNS, FEEDS, itemRow, repositoryMatches, SHEET_NAMES } from './format.mjs';
import { compareItems, STATE_LABELS } from './model.mjs';
import { reconcileClosedStories } from './remediation.mjs';
import { currentRepository, readRegister, registerDestination, registerLedger, repositorySettings, writeRegister } from './store.mjs';

export const REPORT_COLUMNS = Object.freeze(['SFlow state', 'Story', 'Evidence', 'Updated']);

/** One line of evidence: the latest proof or state change, in SFlow's words. */
export function evidenceText(item) {
  const proof = item.evidence?.at(-1);
  if (proof?.kind === 'finding-run') return `${proof.proven ? 'Proven' : 'Not proven yet'}: ${proof.proven ? `${proof.tool} rerun on the changed code no longer reports it` : proof.reason}.`;
  if (['tlm-pin', 'manifest-pin'].includes(proof?.kind)) {
    const pins = (proof.pins ?? []).map((pin) => `${pin.file} pins ${pin.version}`).join('; ');
    return `${proof.proven ? 'Proven' : 'Not proven yet'} on ${proof.ref}${pins ? `: ${pins}` : ': no file pins it'}.`;
  }
  const last = item.history?.at(-1);
  return last ? `${STATE_LABELS[last.to] ?? last.to}: ${last.reason}.` : '';
}

/** The report's sheets: each feed's columns, then SFlow's state, Story, evidence and last change. */
export function reportSheets(register, { feeds = FEEDS, include = () => true } = {}) {
  return feeds.map((feed) => {
    const items = register[feed].items.filter(include).sort(compareItems);
    const updated = (item) => (item.history?.at(-1)?.at ?? item.lastSeenAt ?? '').slice(0, 10);
    return {
      name: SHEET_NAMES[feed],
      headers: [...COLUMNS[feed].map((column) => column.header), ...REPORT_COLUMNS],
      rows: items.map((item) => [...itemRow(feed, item), STATE_LABELS[item.state] ?? item.state, item.story?.workId ?? null,
        evidenceText(item) || null, updated(item) ? { date: updated(item) } : null]),
      widths: [...COLUMNS[feed].map((column) => (['title', 'description', 'notes'].includes(column.key) ? 48 : 16)), 22, 18, 60, 12]
    };
  });
}

/**
 * Write the report workbook to `out` (never over an existing file), after moving the items whose
 * Story has closed. Returns where it went and what it holds.
 */
export async function writeFindingsReport(root, { out, feed = null, allRepositories = false, env = process.env, now = new Date() } = {}) {
  const target = path.resolve(out ?? `sflow-findings-report-${now.toISOString().slice(0, 10)}.xlsx`);
  if (!/\.xlsx$/iu.test(target)) throw new SingularityFlowError(`Name the report file with .xlsx: ${target}`, { code: 'FINDINGS_COMMAND_INVALID' });
  if (await lstat(target).catch(() => null)) {
    throw new SingularityFlowError(`${target} already exists; nothing was written. Name another file with --out FILE.`, { code: 'FINDINGS_OUTPUT_EXISTS', details: { path: target } });
  }
  const ledger = await registerLedger(root);
  const settings = await repositorySettings(root);
  const at = now.toISOString();
  const current = await readRegister(root, { env, ledger });
  let register = current.register;
  let moved = reconcileClosedStories(root, register, { ...settings, at, env }).moved;
  let written = null;
  if (moved.length) {
    const destination = await registerDestination(root, ledger, { env });
    written = await writeRegister(root, ledger, destination, (latest) => {
      const result = reconcileClosedStories(root, latest, { ...settings, at, env });
      moved = result.moved;
      return result.register;
    }, `closed Stories moved ${moved.map((entry) => entry.id).join(', ')}`, { env });
    register = written.register;
  }
  const repository = await currentRepository(root, ledger, { env });
  const feeds = feed ? [feed] : FEEDS;
  const include = (item) => allRepositories || repositoryMatches(item.repository, repository);
  const sheets = reportSheets(register, { feeds, include });
  const bytes = writeXlsx(sheets);
  await writeFile(target, bytes, { flag: 'wx' });
  const counts = Object.fromEntries(feeds.map((name) => {
    const items = register[name].items.filter(include);
    const byState = {};
    for (const item of items) byState[item.state] = (byState[item.state] ?? 0) + 1;
    return [name, { items: items.length, byState }];
  }));
  return {
    schemaVersion: 1, resultType: 'sflow-findings-report', path: target, bytes: bytes.length, counts,
    repository: allRepositories ? null : repository.slug ?? repository.name, storiesClosed: moved,
    ...(written ? { store: written.store, storeMessage: written.message } : {}),
    sent: false, note: 'Nothing was sent. Send this workbook to the security team and the TLM owners yourself.'
  };
}
