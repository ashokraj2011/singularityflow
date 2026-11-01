/**
 * `singularity-flow backup create|inspect|restore` (SDA M5): the work that exists only on this laptop,
 * configuration and specification drafts, specification split proposals and laptop-local documents,
 * saved into a directory the person chooses and
 * restored on another laptop or on this one (src/local-backup.mjs). Restore approves, proposes,
 * commits and pushes nothing.
 */
import { optionBoolean, optionString, SingularityFlowError } from '../util.mjs';

const SUBCOMMANDS = Object.freeze(['create', 'inspect', 'restore']);
const OPTIONS = Object.freeze({ create: ['out', 'json'], inspect: ['json'], restore: ['json'] });

function fail(message, code = 'BACKUP_COMMAND_INVALID', details = null) {
  throw new SingularityFlowError(message, { code, details });
}

export async function backupCommand(positionals, options = {}) {
  const subcommand = positionals[1];
  if (!SUBCOMMANDS.includes(subcommand)) {
    fail(`${subcommand ? `Unknown backup subcommand '${subcommand}'. ` : ''}Supported: ${SUBCOMMANDS.join(', ')}.`, 'UNKNOWN_SUBCOMMAND',
      { command: 'backup', subcommand: subcommand ?? null, available: [...SUBCOMMANDS] });
  }
  const unknown = Object.keys(options).filter((key) => ![...OPTIONS[subcommand], 'timings'].includes(key)).sort();
  if (unknown.length) fail(`backup ${subcommand} does not accept ${unknown.map((key) => `--${key}`).join(', ')}.`);
  if (positionals.length > (subcommand === 'create' ? 2 : 3)) fail(subcommand === 'create'
    ? 'Choose the directory with --out: singularity-flow backup create --out <DIRECTORY>.'
    : `Name one backup directory: singularity-flow backup ${subcommand} <DIRECTORY>.`);
  const { repoRoot } = await import('../git-execution.mjs');
  const root = repoRoot(process.cwd());
  const backup = await import('../local-backup.mjs');
  if (subcommand === 'create') return backup.createBackup(root, { out: optionString(options, 'out') });
  if (subcommand === 'inspect') return backup.inspectBackup(root, positionals[2]);
  return backup.restoreBackup(root, positionals[2]);
}

const plural = (count, word) => `${count} ${word}${count === 1 ? '' : 's'}`;

function printNotCarried(notCarried) {
  if (!notCarried) return;
  const waiting = notCarried.pendingPublications?.length ?? 0;
  if (waiting) console.log(`  Not carried: ${plural(waiting, 'publication')} waiting on the laptop that made this backup; it is recovered there with singularity-flow sync.`);
  if (notCarried.savedPushes) console.log(`  Not carried: ${plural(notCarried.savedPushes, 'saved push')} waiting on the laptop that made this backup; retried there with singularity-flow sync.`);
  console.log(`  Never carried: ${notCarried.never.join(', ')}.`);
}

function printItems(label, items) {
  for (const item of items) {
    const name = item.description ?? (item.planSha256 ? `${item.specId}@${item.revision}` : null) ?? (item.specId ? `${item.specId} draft snapshot ${item.sequence}` : null)
      ?? (item.documentId ? `${item.documentId} — ${item.name} (${item.workId})` : `${item.key} (${item.workId})`);
    const reason = item.refusal?.message ?? item.problems?.join(' ') ?? (item.status === 'superseded'
      ? 'the Story no longer holds this document; its bytes stay in the backup'
      : item.status === 'story-not-here' ? `the Story is not on this laptop; take it over first: ${item.next}`
        : item.status === 'already-approved' ? 'the approved configuration has it by now, so it is not saved again'
          : item.status === 'kept-local' ? `this clone has its own ${item.planSha256 ? 'split proposal for that revision' : 'draft of that specification'}, which is kept` : null);
    console.log(`  ${label} ${item.status}: ${name}${reason ? ` — ${reason}` : ''}`);
  }
}

function printResult(result) {
  if (result.resultType === 'sflow-backup-create') {
    console.log(`Saved ${plural(result.configurationDrafts, 'configuration draft')}, ${plural(result.specDrafts, 'specification draft')}, `
      + `${plural(result.splitProposals, 'specification split proposal')} and ${plural(result.documents, 'laptop-local document')} to ${result.directory}.`);
    if (result.unreadableDocuments.length) console.log(`  Left out ${plural(result.unreadableDocuments.length, 'document')} whose bytes no longer match their SHA-256.`);
    for (const draft of result.unreadableSpecDrafts) {
      console.log(`  Left out ${draft.specId} draft ${draft.files.join(', ')}: it does not verify, so ${draft.carriedSequence ? `snapshot ${draft.carriedSequence} was carried instead` : 'nothing of that draft was carried'}.`);
    }
    for (const proposal of result.unreadableSplitProposals) console.log(`  Left out the split proposal for ${proposal.specId}@${proposal.revision}: ${proposal.reason}.`);
    printNotCarried(result.notCarried);
    console.log(`  Restore it on any laptop with a clone of this repository: singularity-flow backup restore ${JSON.stringify(result.directory)}`);
    return;
  }
  const what = result.resultType === 'sflow-backup-inspect' ? 'Restoring this backup here would do this' : `Restore ${result.status}`;
  console.log(`${what} (backup ${result.backupId} from ${result.createdAt}${result.fromThisMachine ? ', made on this laptop' : ', made on another laptop'}):`);
  printItems('draft', result.configurationDrafts);
  printItems('specification draft', result.specDrafts ?? []);
  printItems('split proposal', result.splitProposals ?? []);
  printItems('document', result.documents);
  printNotCarried(result.notCarried);
  if (result.resultType === 'sflow-backup-restore') {
    console.log('  Nothing was proposed, approved, committed or pushed.');
    if (result.next) console.log(`  See the restored drafts: ${result.next}`);
  } else console.log(`  Restore it: ${result.next}`);
}

export async function run(_argv, { positionals, options = {} }) {
  const result = await backupCommand(positionals, options);
  if (optionBoolean(options, 'json')) console.log(JSON.stringify(result, null, 2));
  else printResult(result);
  return result;
}
