/**
 * The office checks (`singularity-flow probe office`, VS Code "SFlow: Run office checks"): every probe in turn,
 * one scrubbed report, and the temporary folder removed at the end, on an error too.
 *
 * Safety, in one place:
 * - Every write goes under one temporary folder in the OS temporary directory, removed at the end. The report
 *   (`sflow-office-checks-<date>.md` and `.json`) is the one file written anywhere else.
 * - The only outward action is the push check, and only after its Yes; the only paid steps are the guided chat
 *   messages, only after a Yes that says each uses a premium request. Every question can be answered No.
 * - Every string in the report passes the scrubber (scrub.mjs), and the written text is checked again for every
 *   machine value before it is written.
 */
import { mkdirSync, mkdtempSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { gitIn, launch, tool } from './process.mjs';
import { buildReport, check, renderMarkdown } from './report.mjs';
import { createScrubber, leftovers, machineLiterals, remoteParts, scrubDeep } from './scrub.mjs';
import { machineChecks } from './machine.mjs';
import { editorChecks } from './editors.mjs';
import { hookChecks } from './hooks.mjs';
import { gitHostChecks } from './git-host.mjs';
import { stateCheckoutChecks } from './state-checkout.mjs';
import { commitPolicyChecks, jiraChecks } from './policy.mjs';

export const REPORT_PREFIX = 'sflow-office-checks';

function repositoryFacts(cwd, run, env) {
  const top = run.gitIn(cwd, ['rev-parse', '--show-toplevel'], { env, timeoutMs: 10_000 });
  if (!top.ok) return null;
  const root = top.stdout.trim();
  const remotes = run.gitIn(root, ['remote'], { env, timeoutMs: 10_000 }).stdout.split(/\r?\n/u).map((name) => name.trim()).filter(Boolean);
  const upstream = run.gitIn(root, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'], { env, timeoutMs: 10_000 });
  const fromUpstream = upstream.ok ? remotes.find((name) => upstream.stdout.trim().startsWith(`${name}/`)) : null;
  const remote = fromUpstream ?? (remotes.includes('origin') ? 'origin' : remotes[0] ?? null);
  const url = remote ? run.gitIn(root, ['remote', 'get-url', '--push', remote], { env, timeoutMs: 10_000 }).stdout.trim() || null : null;
  const allUrls = remotes.flatMap((name) => run.gitIn(root, ['remote', 'get-url', '--all', name], { env, timeoutMs: 10_000 }).stdout.split(/\r?\n/u)).filter(Boolean);
  return { root, remote, url, remotes, allUrls };
}

function systemLine(platform, arch) {
  const name = { darwin: 'macOS', win32: 'Windows', linux: 'Linux' }[platform] ?? platform;
  return `${name} (${arch})`;
}

export function reportFileNames(createdAt, out, cwd) {
  const day = createdAt.slice(0, 10);
  if (out) {
    const target = path.resolve(cwd, out);
    let directory = false;
    try { directory = statSync(target).isDirectory(); } catch { directory = /[\\/]$/u.test(out); }
    if (directory) return { markdown: path.join(target, `${REPORT_PREFIX}-${day}.md`), json: path.join(target, `${REPORT_PREFIX}-${day}.json`) };
    const base = target.replace(/\.(?:md|json)$/iu, '');
    return { markdown: `${base}.md`, json: `${base}.json` };
  }
  return { markdown: path.join(cwd, `${REPORT_PREFIX}-${day}.md`), json: path.join(cwd, `${REPORT_PREFIX}-${day}.json`) };
}

/** What every probe reads: the machine, the run's own temporary folder, the tool runner and the person's answers. */
export function probeContext({
  cwd = process.cwd(), env = process.env, platform = process.platform, arch = process.arch, home = os.homedir(),
  ask = async () => false, askText = async () => null, note = () => {}, surface = 'cli',
  clock = () => performance.now(), sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  cancelled = () => false, run = { tool, gitIn, launch }, getIssue = null, temp, questions = []
} = {}) {
  return {
    cwd: path.resolve(cwd), env, platform, arch, home, temp, tempReal: realpathSync.native(temp), surface,
    release: os.release(), osVersion: typeof os.version === 'function' ? os.version() : '',
    run, note: (text, detail) => note(text, detail), clock, sleep, cancelled, getIssue, secrets: [], cleanups: [], questions,
    ask: async (question) => {
      const answer = cancelled() ? false : Boolean(await ask(question));
      questions.push({ id: question.id, question: question.question, answer: answer ? 'Yes' : 'No' });
      return answer;
    },
    askText: async (question) => {
      const answer = cancelled() ? null : await askText(question);
      questions.push({ id: question.id, question: question.question, answer: String(answer ?? '').trim() ? 'given' : 'none' });
      return answer;
    }
  };
}

/**
 * Run every probe and write the report. `ask` answers a Yes/No question (false skips its probe), `askText` the one
 * optional text (the Jira key), `note` shows progress. Tests replace `run`, `sleep`, `clock` and the probe list.
 */
export async function runOfficeChecks({
  out = null, now = () => new Date(), probes = null, sflowVersion = null, tempParent = os.tmpdir(), ...options
} = {}) {
  const temp = mkdtempSync(path.join(tempParent, `${REPORT_PREFIX}-`));
  const questions = [];
  const ctx = probeContext({ ...options, temp, questions });
  const { env, home, platform, arch, run, note, cancelled } = ctx;
  // What a probe must undo even when it stopped half way (the push check's throwaway refs).
  const undo = () => { for (const cleanup of ctx.cleanups.splice(0)) { try { cleanup(); } catch { /* best effort */ } } };
  const checks = [];
  try {
    ctx.repository = repositoryFacts(ctx.cwd, run, env);
    const list = probes ?? [
      ['Machine', machineChecks], ['Editors and Copilot', editorChecks], ['Copilot hooks', hookChecks],
      ['Git host', gitHostChecks], ['State checkout', stateCheckoutChecks], ['Commit policy', commitPolicyChecks], ['Jira', jiraChecks]
    ];
    for (const [name, probe] of list) {
      if (cancelled()) { checks.push(check(`stopped-${name.toLowerCase().replace(/\W+/gu, '-')}`, 'A', `${name} checks`, 'not available', ['The checks were stopped before this one.'], 'Nothing was learned here.')); continue; }
      note(`${name} checks`);
      try { checks.push(...await probe(ctx)); } catch (error) {
        checks.push(check(`${name.toLowerCase().replace(/\W+/gu, '-')}-stopped`, 'A', `${name} checks`, 'not available', [`The checks stopped: ${String(error?.message ?? error).slice(0, 200)}`], 'Nothing was learned here.'));
      }
    }
  } finally {
    undo();
    try { rmSync(temp, { recursive: true, force: true, maxRetries: 3 }); } catch { /* the OS clears its temporary folder */ }
  }
  const repository = ctx.repository;
  const literals = machineLiterals({ env, homes: [home], extra: [
    ctx.cwd, repository?.root, repository?.root && path.basename(repository.root), path.basename(ctx.cwd), temp, ctx.tempReal,
    ...(repository?.allUrls ?? []).flatMap(remoteParts), ...(repository?.remotes ?? []).filter((name) => name !== 'origin'),
    ...ctx.secrets
  ].filter(Boolean) });
  const scrub = createScrubber(literals);
  const createdAt = now().toISOString();
  const report = scrubDeep(buildReport({
    checks, questions, createdAt, sflowVersion: sflowVersion ?? (await import('../version.mjs')).VERSION,
    system: systemLine(platform, arch)
  }), scrub);
  let markdown = renderMarkdown(report);
  let json = `${JSON.stringify(report, null, 2)}\n`;
  // A second look at the finished text: anything a probe let through is removed before it is written.
  const missed = [...new Set([...leftovers(markdown, scrub.literals), ...leftovers(json, scrub.literals)])];
  if (missed.length) {
    const again = createScrubber(missed);
    markdown = again(markdown);
    json = `${JSON.stringify(scrubDeep(report, again), null, 2)}\n`;
  }
  const files = reportFileNames(createdAt, out, ctx.cwd);
  mkdirSync(path.dirname(files.markdown), { recursive: true });
  writeFileSync(files.markdown, markdown);
  writeFileSync(files.json, json);
  return { files, report: JSON.parse(json), markdown };
}
