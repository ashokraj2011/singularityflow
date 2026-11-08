/**
 * `singularity-flow findings template|import|list|link|plan|start|report` [CQF:REQ-060 to REQ-070]: the
 * security team's and the TLM owners' lists, in SFlow's workbook format, and the register they go into.
 *
 * `template` writes an empty workbook with both sheets, their headers and one made-up example row
 * each. It never overwrites a file: a person names another --out. `import` reads a workbook or CSV
 * file into the register on the state branch (src/findings/register/); an invalid row is reported
 * and the rest import. `list` reads the register this clone has and never fetches. `link` marks
 * items "in a Story" when the Story's own start could not. `plan` and `start` are remediation Stories
 * (src/findings/register/remediation.mjs). `report` writes the update for the security team and the
 * TLM owners; a person sends it, SFlow never does.
 */
import { lstat, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { optionBoolean, optionString, SingularityFlowError } from '../util.mjs';

const SUBCOMMANDS = Object.freeze(['template', 'import', 'list', 'link', 'plan', 'start', 'report']);
const OPTIONS = Object.freeze({
  template: ['out', 'json'], import: ['feed', 'source', 'dry-run', 'json'],
  list: ['feed', 'state', 'all-repositories', 'limit', 'json', 'for-agent'], link: ['address', 'json'],
  plan: ['feed', 'all-repositories', 'json', 'for-agent'], start: ['work-id', 'from-branch', 'fetch', 'isolated-worktree', 'json'],
  report: ['out', 'feed', 'all-repositories', 'json']
});
// What `list` shows unless --state says otherwise: everything not closed, accepted or waived.
const ACTIVE_STATES = Object.freeze(['open', 'in-story', 'fixed-awaiting-proof', 'fixed-awaiting-rescan', 'not-in-latest-import']);
export const DEFAULT_TEMPLATE_NAME = 'sflow-findings-template.xlsx';

function fail(message, code = 'FINDINGS_COMMAND_INVALID', details = null) {
  throw new SingularityFlowError(message, { code, details });
}

async function templateCommand(options) {
  const [{ writeXlsx }, { templateSheets, COLUMNS }] = await Promise.all([
    import('../findings/workbook/xlsx.mjs'), import('../findings/register/format.mjs')]);
  const out = path.resolve(optionString(options, 'out') ?? DEFAULT_TEMPLATE_NAME);
  if (!/\.xlsx$/iu.test(out)) fail(`Name the template file with .xlsx: ${out}`);
  if (await lstat(out).catch(() => null)) {
    fail(`${out} already exists; nothing was written. Name another file with --out FILE.`, 'FINDINGS_OUTPUT_EXISTS', { path: out });
  }
  const bytes = writeXlsx(templateSheets());
  await writeFile(out, bytes, { flag: 'wx' });
  return {
    schemaVersion: 1, resultType: 'sflow-findings-template', path: out, bytes: bytes.length,
    sheets: Object.entries(COLUMNS).map(([feed, columns]) => ({
      feed, sheet: feed === 'security' ? 'Security' : 'TLM',
      required: columns.filter((column) => column.required).map((column) => column.header),
      optional: columns.filter((column) => !column.required).map((column) => column.header)
    })),
    next: { command: `singularity-flow findings import ${JSON.stringify(out)}` }
  };
}

export async function findingsCommand(positionals, options = {}) {
  const subcommand = positionals[1];
  if (!SUBCOMMANDS.includes(subcommand)) {
    fail(`${subcommand ? `Unknown findings subcommand '${subcommand}'` : 'Name a findings subcommand'}. Supported: ${SUBCOMMANDS.join(', ')}.`, 'UNKNOWN_SUBCOMMAND',
      { command: 'findings', subcommand: subcommand ?? null, available: [...SUBCOMMANDS] });
  }
  const unknown = Object.keys(options).filter((key) => ![...OPTIONS[subcommand], 'timings'].includes(key)).sort();
  if (unknown.length) fail(`findings ${subcommand} does not accept ${unknown.map((key) => `--${key}`).join(', ')}.`);
  const operands = { template: 0, import: 1, list: 0, link: 1, plan: 0, start: 1, report: 0 }[subcommand];
  if (positionals.length > 2 + operands) fail(`findings ${subcommand} takes ${operands ? 'one operand' : 'no operand'}: ${positionals.slice(2 + operands).join(' ')}.`);
  if (subcommand === 'template') return templateCommand(options);
  const { repoRoot } = await import('../git-execution.mjs');
  const root = repoRoot(process.cwd());
  if (subcommand === 'list') return listCommand(root, options);
  if (subcommand === 'link') return linkCommand(root, positionals[2], options);
  if (subcommand === 'plan') return planCommand(root, options);
  if (subcommand === 'start') return startRemediation(root, positionals[2], options);
  if (subcommand === 'report') {
    const feed = optionString(options, 'feed');
    if (feed && !['security', 'tlm'].includes(feed)) fail(`--feed is security or tlm, not '${feed.slice(0, 40)}'.`);
    const { writeFindingsReport } = await import('../findings/register/report.mjs');
    return writeFindingsReport(root, { out: optionString(options, 'out') ?? null, feed: feed ?? null, allRepositories: optionBoolean(options, 'all-repositories') });
  }
  if (!positionals[2]) fail('Name the workbook or CSV file: singularity-flow findings import FILE [--feed security|tlm] [--source NAME].');
  const { importFindings } = await import('../findings/register/import.mjs');
  return importFindings(root, positionals[2], {
    feed: optionString(options, 'feed') ?? null, source: optionString(options, 'source') ?? null, dryRun: optionBoolean(options, 'dry-run')
  });
}

async function listCommand(root, options) {
  const [{ readRegister, currentRepository }, { ITEM_STATES, STATE_LABELS, compareItems }, { repositoryMatches, FEEDS }, { itemSummary }] = await Promise.all([
    import('../findings/register/store.mjs'), import('../findings/register/model.mjs'), import('../findings/register/format.mjs'), import('../findings/register/pick.mjs')]);
  const feed = optionString(options, 'feed');
  if (feed && !FEEDS.includes(feed)) fail(`--feed is security or tlm, not '${feed.slice(0, 40)}'.`);
  const state = optionString(options, 'state') ?? 'active';
  if (!['active', 'all', ...ITEM_STATES].includes(state)) fail(`--state is active, all or one of ${ITEM_STATES.join(', ')}.`);
  const limit = Number(optionString(options, 'limit') ?? 200);
  if (!Number.isInteger(limit) || limit < 1 || limit > 2000) fail('--limit is a whole number from 1 to 2000.');
  const read = await readRegister(root);
  const repository = await currentRepository(root, read.ledger);
  const everywhere = optionBoolean(options, 'all-repositories');
  const all = (feed ? [feed] : FEEDS).flatMap((name) => read.register[name].items)
    .filter((item) => everywhere || repositoryMatches(item.repository, repository));
  const shown = all.filter((item) => state === 'all' || (state === 'active' ? ACTIVE_STATES.includes(item.state) : item.state === state)).sort(compareItems);
  const counts = {};
  for (const item of all) {
    counts[item.feed] ??= {};
    counts[item.feed][item.state] = (counts[item.feed][item.state] ?? 0) + 1;
  }
  const lastImport = read.register.imports.imports.at(-1) ?? null;
  return {
    schemaVersion: 1, resultType: 'sflow-findings-list', location: read.location, ...(read.commit ? { stateCommit: read.commit } : {}),
    repository: everywhere ? null : repository.slug ?? repository.name, state, counts, total: shown.length,
    items: shown.slice(0, limit).map((item) => ({ ...itemSummary(item), stateLabel: STATE_LABELS[item.state] })),
    ...(shown.length > limit ? { notShown: shown.length - limit } : {}),
    ...(read.damaged.length ? { damaged: read.damaged } : {}),
    lastImport: lastImport ? { importId: lastImport.importId, at: lastImport.at, source: lastImport.source, file: lastImport.file?.name ?? null } : null
  };
}

async function remediationGroups(root, options) {
  const [{ readRegister, currentRepository }, { readFindingsConfig }, { planGroups }] = await Promise.all([
    import('../findings/register/store.mjs'), import('../findings/register/config.mjs'), import('../findings/register/remediation.mjs')]);
  const read = await readRegister(root);
  const [repository, config] = await Promise.all([currentRepository(root, read.ledger), readFindingsConfig(root)]);
  const feed = optionString(options, 'feed');
  if (feed && !['security', 'tlm'].includes(feed)) fail(`--feed is security or tlm, not '${feed.slice(0, 40)}'.`);
  const groups = planGroups(read.register, repository, { stories: config.stories, allRepositories: optionBoolean(options, 'all-repositories') })
    .filter((group) => !feed || group.feed === feed);
  return { read, repository, config, groups };
}

async function planCommand(root, options) {
  const { read, repository, config, groups } = await remediationGroups(root, options);
  return {
    schemaVersion: 1, resultType: 'sflow-findings-plan', location: read.location,
    repository: optionBoolean(options, 'all-repositories') ? null : repository.slug ?? repository.name,
    grouping: { security: `per repository by due date, at most ${config.stories.security.maximumFindings} a Story`, tlm: 'per component' },
    groups: groups.map((group) => ({ ...group, command: `singularity-flow findings start ${group.id}` })),
    ...(config.warnings.length ? { warnings: config.warnings } : {})
  };
}

/** Open a findings-remediation Story for one group, through Story start itself. */
async function startRemediation(root, groupId, options) {
  if (!groupId) fail('Name the group: singularity-flow findings start GROUP-ID (singularity-flow findings plan lists them).');
  // This repository's groups: a remediation Story starts in the repository whose items it fixes.
  const { groups } = await remediationGroups(root, {});
  const group = groups.find((entry) => entry.id === groupId);
  if (!group) {
    fail(`No remediation group '${String(groupId).slice(0, 80)}'. Groups now: ${groups.map((entry) => entry.id).join(', ') || 'none (nothing is open)'}.`, 'FINDINGS_GROUP_UNKNOWN',
      { nextAction: 'singularity-flow findings plan' });
  }
  const [{ groupDescription }, { repositorySettings }, { startCommand }] = await Promise.all([
    import('../findings/register/remediation.mjs'), import('../findings/register/store.mjs'), import('./start.mjs')]);
  const settings = await repositorySettings(root);
  const workId = optionString(options, 'work-id') ?? group.workId;
  // All existing tests run in a remediation Story (decision 22); its clauses are the group's items.
  await startCommand(['start', workId], {
    title: group.title, description: groupDescription(group), 'work-type': 'findings-remediation',
    address: group.items.map((item) => item.id).join(','), 'test-execution-mode': 'all-configured',
    'from-branch': optionString(options, 'from-branch') ?? settings.defaultBranch,
    ...(optionBoolean(options, 'fetch') ? { fetch: true } : {}), ...(optionBoolean(options, 'isolated-worktree') ? { 'isolated-worktree': true } : {}),
    ...(optionBoolean(options, 'json') ? { json: true } : {})
  });
  return { schemaVersion: 1, resultType: 'sflow-findings-start', group: group.id, workId, items: group.items.map((item) => item.id),
    majorUpgrades: group.majorUpgrades,
    next: { command: `singularity-flow auto plan --story ${workId} --json`, label: 'Plan its Auto flight to a tested Candidate; a person confirms the plan and approves the result.' } };
}

async function linkCommand(root, workId, options) {
  const { addressedIds, resolveAddressedFindings, markFindingsInStory } = await import('../findings/register/pick.mjs');
  if (!workId) fail('Name the Story: singularity-flow findings link WORK-ID --address ID,...');
  const ids = addressedIds(optionString(options, 'address') ?? '');
  if (!ids.length) fail(`Name the items: singularity-flow findings link ${workId} --address ID,...`);
  const { picked, skipped } = await resolveAddressedFindings(root, ids);
  const mark = await markFindingsInStory(root, picked, workId);
  return { schemaVersion: 1, resultType: 'sflow-findings-link', workId, marked: mark.marked, skipped,
    ...(mark.error ? { error: mark.error, nextAction: mark.nextAction } : { store: mark.store, storeMessage: mark.storeMessage }) };
}

function printResult(result) {
  if (result.resultType === 'sflow-findings-template') {
    console.log(`Wrote the findings workbook template: ${result.path}`);
    for (const sheet of result.sheets) {
      console.log(`  ${sheet.sheet} sheet. Required: ${sheet.required.join(', ')}. Optional: ${sheet.optional.join(', ')}.`);
    }
    console.log('Each sheet has one made-up example row; replace it with your own rows.');
    console.log(`Import it with: ${result.next.command}`);
    return;
  }
  if (result.resultType === 'sflow-findings-import') {
    console.log(`${result.dryRun ? 'Would import' : 'Imported'} ${result.file.name} (${result.file.sha256.slice(0, 19)}…) from source ${result.source} as ${result.importId}.`);
    if (result.nothingImported) { console.log(result.message); return; }
    for (const [feed, counts] of Object.entries(result.feeds)) {
      console.log(`  ${feed === 'tlm' ? 'TLM' : 'Security'}: ${counts.imported} rows imported (${counts.added} new, ${counts.updated} updated, ${counts.unchanged} unchanged`
        + `${counts.reopened ? `, ${counts.reopened} open again` : ''}${counts.closed ? `, ${counts.closed} closed` : ''}), ${counts.rejected} rejected`
        + `${counts.notInLatest ? `; ${counts.notInLatest} no longer listed (kept, marked not in the latest import)` : ''}.`);
      if (counts.otherRepositories) console.log(`    ${counts.otherRepositories} of them name another repository; they are kept and listed with --all-repositories.`);
    }
    for (const row of result.rejected.slice(0, 20)) console.log(`  Rejected: ${row.sheet} row ${row.row}: ${row.reason}.`);
    if (result.rejected.length > 20) console.log(`  … and ${result.rejected.length - 20} more rejected rows (see --json).`);
    for (const sheet of result.ignoredSheets) console.log(`  Not read: sheet "${sheet.sheet}": ${sheet.reason}.`);
    for (const [feed, headers] of Object.entries(result.unknownHeaders)) console.log(`  ${feed === 'tlm' ? 'TLM' : 'Security'} headers not used: ${headers.map((header) => JSON.stringify(header)).join(', ')}.`);
    for (const warning of result.warnings) console.log(`  Warning: ${warning}`);
    console.log(result.dryRun ? `Nothing was written. ${result.storeMessage}` : `${result.storeMessage}${result.commit ? ` (${result.branch} ${result.commit.slice(0, 12)})` : ''}`);
    return;
  }
  if (result.resultType === 'sflow-findings-list') {
    const where = { 'state-branch': 'the state branch', local: 'this computer only', 'state-branch and local': 'the state branch and this computer', none: 'nowhere yet' }[result.location];
    console.log(`Findings register (${where}${result.repository ? `, repository ${result.repository}` : ', every repository'}): ${result.total} ${result.state === 'all' ? '' : `${result.state} `}item(s).`);
    if (!result.total) console.log(result.location === 'none' ? 'Nothing has been imported. Start with: singularity-flow findings template' : 'Nothing to show.');
    for (const item of result.items) {
      const what = item.feed === 'tlm' ? `TLM ${item.label}` : `${item.severity} ${JSON.stringify(item.label)}${item.file ? ` ${item.file}${item.line ? `:${item.line}` : ''}` : ''}${item.package ? ` ${item.package}` : ''}`;
      console.log(`  ${item.id.padEnd(12)} ${item.stateLabel}${item.story ? ` (${item.story})` : ''} · ${what}${item.dueAt ? ` · due ${item.dueAt}` : ''}`);
    }
    if (result.notShown) console.log(`  … and ${result.notShown} more (--limit).`);
    if (result.lastImport) console.log(`Last import: ${result.lastImport.importId} from ${result.lastImport.source} at ${result.lastImport.at}.`);
    return;
  }
  if (result.resultType === 'sflow-findings-plan') {
    console.log(`Remediation groups${result.repository ? ` for ${result.repository}` : ''}: security ${result.grouping.security}; TLM ${result.grouping.tlm}.`);
    if (!result.groups.length) console.log('Nothing is open to remediate.');
    for (const group of result.groups) {
      console.log(`  ${group.id}: ${group.title} (${group.count} item${group.count === 1 ? '' : 's'}: ${group.items.map((item) => item.id).join(', ')})`);
      if (group.majorUpgrades.length) console.log(`    Major upgrade, listed for a person and never made by itself: ${group.majorUpgrades.join(', ')}.`);
      console.log(`    Start it: ${group.command}`);
    }
    return;
  }
  if (result.resultType === 'sflow-findings-report') {
    console.log(`Wrote the findings report: ${result.path}`);
    for (const [feed, counts] of Object.entries(result.counts)) {
      console.log(`  ${feed === 'tlm' ? 'TLM' : 'Security'}: ${counts.items} item(s); ${Object.entries(counts.byState).map(([state, count]) => `${count} ${state.replaceAll('-', ' ')}`).join(', ') || 'none'}.`);
    }
    for (const entry of result.storiesClosed) console.log(`  ${entry.id}: Story ${entry.story} closed; now ${entry.to.replaceAll('-', ' ')}.`);
    if (result.storeMessage) console.log(result.storeMessage);
    console.log(result.note);
    return;
  }
  if (result.resultType === 'sflow-findings-link') {
    console.log(result.marked.length ? `In Story ${result.workId}: ${result.marked.join(', ')}.` : `Nothing was marked for Story ${result.workId}.`);
    for (const entry of result.skipped) console.log(`  Not marked: ${entry.id}, because ${entry.reason}.`);
    if (result.error) console.log(`The register could not be written (${result.error}). Retry: ${result.nextAction}`);
    else if (result.storeMessage) console.log(result.storeMessage);
  }
}

export async function run(_argv, { positionals, options = {} }) {
  const result = await findingsCommand(positionals, options);
  // findings start prints through Story start itself; only its next step is added in prose.
  if (result.resultType === 'sflow-findings-start') {
    if (!optionBoolean(options, 'json')) {
      if (result.majorUpgrades.length) console.log(`Major upgrades listed for a person, never made by themselves: ${result.majorUpgrades.join(', ')}.`);
      console.log(`Next: ${result.next.label}\n  ${result.next.command}`);
    }
    return result;
  }
  if (optionBoolean(options, 'json')) console.log(JSON.stringify(result, null, 2));
  else printResult(result);
  return result;
}
