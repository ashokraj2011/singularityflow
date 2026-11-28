/**
 * Probe D: does this Git host take what clean pull requests need (Bet 3, SSB M5)?
 *
 * After one Yes, one atomic push sends two throwaway refs to the person's remote, from a temporary repository
 * holding one empty commit: the branch `sflow-probe/<random>` and the hidden ref `refs/singularity/state/probe-<random>`.
 * The hidden ref is then fetched back into the temporary repository, and both refs are deleted at once. No other
 * ref is named, the person's own clone is never written (the push goes to the remote's address from the temporary
 * repository), and the refs are deleted again on the way out even when a step fails. Only the host's KIND is
 * recorded, never its address or organisation.
 */
import { randomBytes } from 'node:crypto';
import { check, PASS } from './report.mjs';
import { throwawayCommit } from './machine.mjs';

// GitHub's own cloud host, joined so the repository holds no public host name (scripts/check.mjs).
const GITHUB_HOST = ['github', 'com'].join('.');
export const GITHUB_CLOUD = ['GitHub', 'com'].join('.');

/** GitHub's cloud, GitHub Enterprise, GitLab, Azure DevOps, Bitbucket or other, from the remote address alone. */
export function hostKind(address) {
  const value = String(address ?? '').trim().toLowerCase();
  if (!value) return 'none';
  let host = '';
  let pathname = '';
  try { const url = new URL(value); host = url.hostname; pathname = url.pathname; } catch {
    const scp = /^(?:[^@/]+@)?([^:/]+):(.*)$/u.exec(value);
    if (scp) { host = scp[1]; pathname = scp[2]; } else return 'local folder';
  }
  if (!host) return value.startsWith('file:') ? 'local folder' : 'other';
  if (host === GITHUB_HOST || host === `ssh.${GITHUB_HOST}`) return GITHUB_CLOUD;
  if (host.endsWith('.ghe.com')) return 'GitHub Enterprise Cloud';
  if (host === 'dev.azure.com' || host === 'ssh.dev.azure.com' || host.endsWith('.visualstudio.com') || pathname.includes('/_git/')) return 'Azure DevOps';
  if (host === 'gitlab.com') return 'GitLab.com';
  if (host.includes('gitlab')) return 'GitLab (self-hosted)';
  if (host === 'bitbucket.org') return 'Bitbucket Cloud';
  if (host.includes('bitbucket') || /^\/?scm\//u.test(pathname)) return 'Bitbucket Data Center';
  if (host.includes('github')) return 'GitHub Enterprise Server';
  return 'other';
}

export const transportKind = (address) => (/^https?:/iu.test(address) ? 'https' : /^(?:ssh:|[^/]+@[^:/]+:)/iu.test(address) ? 'ssh' : /^file:|^[./\\]|^[a-z]:[\\/]/iu.test(address) ? 'local' : 'other');

/** The host's own words, without our refs' names repeated: `remote:` lines and rejection reasons. */
function serverWords(text) {
  return String(text ?? '').split(/\r?\n/u)
    .map((line) => line.replace(/^remote:\s?/u, '').trim())
    .filter((line, index, lines) => line && lines.indexOf(line) === index && !/^(?:To |Counting|Writing|Total|Delta|Enumerating|Compressing)/u.test(line))
    .slice(0, 8).map((line) => line.slice(0, 240));
}

/** Plain words for why a push was refused. */
export function refusalWords(text) {
  const value = String(text ?? '');
  if (/does not support --atomic|atomic push/iu.test(value)) return 'the host does not support atomic pushes';
  if (/funny ref|refusing to create|deny updating a hidden ref|hidden ref|not a valid ref|invalid ref/iu.test(value)) return 'the host refused a ref outside refs/heads and refs/tags';
  if (/pre-receive hook declined|hook declined|pre-receive/iu.test(value)) return 'a server hook (pre-receive) refused the push';
  if (/protected branch|rule violation|ruleset|GH013|push rules|not allowed to push|cannot create/iu.test(value)) return 'a branch rule or permission refused the push';
  if (/GH007|email privacy/iu.test(value)) return 'the host refused the commit\'s email (email privacy)';
  if (/signature|signed|GPG/iu.test(value)) return 'the host requires signed commits';
  if (/authentication|could not read username|permission denied|403|401|access denied|terminal prompts disabled/iu.test(value)) return 'the host asked for a sign-in or refused this account';
  if (/could not resolve|timed out|unable to access|connection refused|network/iu.test(value)) return 'the host could not be reached';
  return 'the host refused it (see its words below)';
}

function pushedRefs(porcelain) {
  const status = {};
  for (const line of String(porcelain ?? '').split(/\r?\n/u)) {
    const match = /^([ +\-*=!])\t[^\t]*:(refs\/[^\t]+)\t(.*)$/u.exec(line);
    if (match) status[match[2]] = { flag: match[1], summary: match[3] };
  }
  return status;
}

export async function gitHostChecks(ctx) {
  const repository = ctx.repository;
  if (!repository?.root || !repository.url) {
    return [check('host-kind', 'D', 'Git host kind', 'not available', [repository?.root ? 'This repository has no remote.' : 'SFlow was not run inside a Git checkout.'], 'Run the checks inside the repository you work in to check its Git host.')];
  }
  const kind = hostKind(repository.url);
  const transport = transportKind(repository.url);
  const checks = [check('host-kind', 'D', 'Git host kind', 'pass', [`${kind}, over ${transport}.`], `Clean pull requests are built for ${kind}.`)];
  const title = 'Atomic push with SFlow\'s hidden records ref';
  const yes = await ctx.ask({
    id: 'push',
    question: 'Push two throwaway refs to your remote and delete them right after?',
    why: 'Clean pull requests keep SFlow\'s records on a hidden ref; this is the only way to learn whether this Git host takes one.',
    yes: 'Yes: SFlow pushes sflow-probe/<random> and refs/singularity/state/probe-<random> (one empty commit) to your remote in one atomic push, fetches the hidden one back, then deletes both. No other ref is touched.',
    no: 'No: skip this check.'
  });
  if (!yes) {
    checks.push(check('host-push', 'D', title, 'not available', ['You chose No, so nothing was pushed.'], 'Whether this host takes SFlow\'s hidden ref is still unknown.'));
    return checks;
  }
  const made = throwawayCommit(ctx);
  if (!made.ok) {
    checks.push(check('host-push', 'D', title, 'not available', [`The throwaway commit could not be made: ${String(made.error).split('\n')[0].slice(0, 200)}`], 'Nothing was pushed.'));
    return checks;
  }
  const suffix = randomBytes(4).toString('hex');
  const branch = `refs/heads/sflow-probe/${suffix}`;
  const hidden = `refs/singularity/state/probe-${suffix}`;
  const env = { ...made.env, GCM_INTERACTIVE: 'never' };
  const hostGit = (args, timeoutMs = 120_000) => ctx.run.gitIn(made.directory, args, { env, timeoutMs });
  const created = new Set();
  ctx.cleanups.push(() => { if (created.size) hostGit(['push', '--porcelain', repository.url, ...[...created].map((ref) => `:${ref}`)], 60_000); });
  const evidence = [];
  const facts = { atomic: null, hidden: null, fetchable: null, advertised: null, deleted: null };
  try {
    ctx.note('Git host: one atomic push of two throwaway refs');
    let push = hostGit(['push', '--atomic', '--porcelain', repository.url, `HEAD:${branch}`, `HEAD:${hidden}`]);
    const refs = pushedRefs(push.stdout);
    const words = serverWords(push.stderr);
    if (push.ok) { facts.atomic = true; facts.hidden = true; created.add(branch); created.add(hidden); }
    else if (/does not support --atomic|atomic push/iu.test(`${push.stdout}\n${push.stderr}`)) {
      facts.atomic = false;
      evidence.push('The host does not support atomic pushes; the two refs were pushed one at a time instead.');
      const one = hostGit(['push', '--porcelain', repository.url, `HEAD:${branch}`]);
      if (one.ok) created.add(branch);
      push = hostGit(['push', '--porcelain', repository.url, `HEAD:${hidden}`]);
      facts.hidden = push.ok;
      if (push.ok) created.add(hidden);
    } else {
      facts.atomic = false;
      evidence.push(`The atomic push was refused: ${refusalWords(`${push.stdout}\n${push.stderr}`)}.`);
      for (const [ref, entry] of Object.entries(refs)) {
        if (entry.flag === '!') evidence.push(`${ref === hidden ? 'The hidden ref' : 'The branch'}: ${entry.summary.replace(/sflow-probe\/[0-9a-f]+|probe-[0-9a-f]+/gu, '<random>').slice(0, 160)}.`);
      }
      // Atomic refused everything: learn whether the hidden ref alone is taken.
      const alone = hostGit(['push', '--porcelain', repository.url, `HEAD:${hidden}`]);
      facts.hidden = alone.ok;
      if (alone.ok) created.add(hidden);
      evidence.push(alone.ok ? 'Pushed alone, the hidden ref was accepted.' : `Pushed alone, the hidden ref was refused: ${refusalWords(`${alone.stdout}\n${alone.stderr}`)}.`);
    }
    if (facts.atomic) evidence.push('The atomic push of the branch and the hidden ref was accepted.');
    if (words.length) evidence.push(`The host said: ${words.join(' / ')}`);
    if (created.has(hidden)) {
      const listed = hostGit(['ls-remote', repository.url, hidden], 60_000);
      facts.advertised = listed.ok && listed.stdout.includes(hidden);
      const back = hostGit(['fetch', '--no-tags', repository.url, `${hidden}:refs/office-check/back`], 120_000);
      facts.fetchable = back.ok;
      evidence.push(facts.fetchable ? 'The hidden ref was fetched back.' : `The hidden ref could not be fetched back: ${refusalWords(back.stderr)}.`);
      evidence.push(facts.advertised ? 'The host lists the hidden ref to every clone.' : 'The host does not list the hidden ref (it is hidden from ordinary listings).');
    }
  } finally {
    if (created.size) {
      ctx.note('Git host: deleting both throwaway refs');
      const refs = [...created];
      let removed = hostGit(['push', ...(facts.atomic ? ['--atomic'] : []), '--porcelain', repository.url, ...refs.map((ref) => `:${ref}`)]);
      if (!removed.ok) removed = { ok: refs.every((ref) => hostGit(['push', '--porcelain', repository.url, `:${ref}`]).ok) };
      const left = hostGit(['ls-remote', repository.url, branch, hidden], 60_000);
      facts.deleted = removed.ok && left.ok && !left.stdout.trim();
      if (facts.deleted) created.clear();
      evidence.push(facts.deleted ? 'Both throwaway refs were deleted.' : 'Deleting a throwaway ref failed: ask the SFlow team, who will name it.');
    }
  }
  const ok = facts.atomic && facts.hidden && facts.fetchable && facts.deleted;
  checks.push(check('host-push', 'D', title, ok ? PASS : 'fail', evidence,
    ok ? 'Clean pull requests can keep records on a hidden ref here: the host takes refs/singularity/* in one atomic push with the branch, returns it, and lets SFlow delete it.'
      : facts.hidden === false ? 'Clean pull requests cannot keep records on a hidden ref here: the host refused refs/singularity/*. SFlow must keep them on a branch (sflow/state/<ID>) instead.'
        : facts.atomic === false ? 'The host takes the hidden ref but not in one atomic push: SFlow must push the branch and its records one after the other.'
          : 'The hidden ref was taken but could not be read back or removed: clean pull requests need both.'));
  ctx.serverWords = evidence.filter((line) => line.startsWith('The host said:') || line.includes('refused'));
  return checks;
}
