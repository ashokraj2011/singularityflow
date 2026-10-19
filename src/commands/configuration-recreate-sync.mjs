/**
 * `configuration recreate-sync [--apply [--confirm sha256:...]]`: the preview lists every proposal
 * apply would replay (teammates' unreviewed ones included) and returns its `confirmation` digest.
 * Apply needs that digest, so a proposal pushed after the review is refused instead of replayed.
 * In an interactive terminal `--apply` alone previews, prints that exact list and asks once; any
 * other caller must pass the reviewed digest. Nothing here is applied without a person seeing it.
 */
import { stdin as input, stdout as output } from 'node:process';
import readline from 'node:readline/promises';
import { optionBoolean, optionString } from '../util.mjs';

async function ask(question) {
  const io = readline.createInterface({ input, output });
  try { return await io.question(question); } finally { io.close(); }
}

const short = commit => String(commit ?? '').slice(0, 12);

/** The exact packet a person confirms: each proposal, its tip, author, summary and files. */
export function recreateSyncReviewLines(preview) {
  const pending = preview.proposals.filter(item => !item.merged);
  const merged = preview.proposals.filter(item => item.merged);
  const lines = [`Recreate & sync onto approved ${preview.targetBranch}@${short(preview.baseCommit)}.`];
  const proposal = item => `  ${item.branch} @ ${short(item.commit)}${item.author ? ` by ${item.author}` : ''}${item.summary ? ` — ${item.summary}` : ''}`;
  if (pending.length) lines.push(`Replays ${pending.length} pending proposal${pending.length === 1 ? '' : 's'}, teammates' unreviewed ones included:`);
  for (const item of pending) lines.push(proposal(item), ...(item.files ?? []).map(file => `      ${file}`));
  if (merged.length) lines.push(`Retires ${merged.length} already merged proposal${merged.length === 1 ? '' : 's'} (archived as tags):`, ...merged.map(proposal));
  lines.push(`Configuration files changed: ${preview.files.length ? preview.files.join(', ') : 'none'}.`);
  for (const item of preview.replacements ?? []) lines.push(`  Replaces current ${item.path}${item.pointer === '/' ? '' : ` ${item.pointer}`} with ${item.branch}.`);
  lines.push('Application code, Stories and approvals stay unchanged. A proposal pushed after this preview is refused, not added.');
  return lines;
}

export async function recreateSyncCommand({ root, options, interactive = !optionBoolean(options, 'json') && Boolean(input.isTTY && output.isTTY),
  question = ask, print = line => console.log(line), recreate = null }) {
  const recreateAndSync = recreate ?? (await import('../configuration-recreate-sync.mjs')).recreateAndSyncConfiguration;
  const apply = optionBoolean(options, 'apply');
  const confirm = optionString(options, 'confirm') ?? null;
  // A digest, a preview, or a non-interactive caller goes straight to the engine, which refuses an
  // apply that does not carry the digest of the exact list a person reviewed.
  if (!apply || confirm != null || !interactive) return recreateAndSync(root, { apply, confirm });
  const preview = await recreateAndSync(root, { apply: false });
  if (!preview.proposals.length) return recreateAndSync(root, { apply: true, confirm: preview.confirmation });
  for (const line of recreateSyncReviewLines(preview)) print(line);
  const answer = String(await question('Replay exactly these proposals into the shared configuration? [y/N] ') ?? '').trim();
  if (!/^y(?:es)?$/iu.test(answer)) {
    print('Nothing was applied.');
    const { commandGuidance, ...declined } = preview; // the declined packet offers no apply command
    return { ...declined, status: 'declined' };
  }
  return recreateAndSync(root, { apply: true, confirm: preview.confirmation });
}
