/**
 * Probe F: the repository's commit rules, read only (SFlow's commit policy, the local Git hooks and the setup
 * files that install them), and what the push check learned about the host's own hooks.
 * Probe G: Jira for "Start a task from a Jira key": whether SFlow's Jira settings are there (yes or no each),
 * and, only for an issue key the person gives, whether SFlow can read that one issue (its title's length only).
 */
import { check, PASS } from './report.mjs';

const JIRA_KEY = /^[A-Z][A-Z0-9_]{0,30}-\d{1,9}$/u;

export async function commitPolicyChecks(ctx) {
  const root = ctx.repository?.root;
  const checks = [];
  if (!root) {
    checks.push(check('policy-local', 'F', 'The repository\'s commit rules', 'not available', ['SFlow was not run inside a Git checkout.'], 'Run the checks inside the repository you work in.'));
  } else {
    const [{ commitPolicyEnforcedHint }, { discoverCommitPolicy }] = await Promise.all([
      import('../util.mjs'), import('../repository-commit-policy/discovery.mjs')]);
    const evidence = [];
    let enforced = null;
    try { enforced = commitPolicyEnforcedHint(root); } catch { /* unreadable */ }
    evidence.push(enforced === true ? 'SFlow\'s commit policy is adopted in this repository.' : enforced === false ? 'SFlow\'s commit policy is not adopted in this repository.' : 'Whether SFlow\'s commit policy is adopted could not be read.');
    try {
      const found = await discoverCommitPolicy(root, { env: ctx.env });
      const hooks = found.hooks.filter((hook) => hook.status === 'present').map((hook) => hook.stage);
      evidence.push(hooks.length ? `Local Git hooks installed: ${hooks.join(', ')}.` : 'No local Git commit hooks are installed.');
      const setup = found.setup.map((entry) => entry.path).filter((name) => /pre-commit|commitlint|husky/u.test(name));
      evidence.push(setup.length ? `Hook tools set up in the repository: ${setup.join(', ')}.` : 'No hook tool (pre-commit, husky, commitlint) is set up in the repository.');
      const custom = !/[\\/]\.git[\\/]hooks$/u.test(found.effectiveHooksPath) && !/[\\/]hooks$/u.test(found.effectiveHooksPath.replace(/[\\/]worktrees[\\/][^\\/]+/u, ''));
      if (custom) evidence.push('Git hooks come from a folder other than the usual one (core.hooksPath).');
    } catch (error) { evidence.push(`The hooks could not be read (${error.code ?? 'error'}).`); }
    checks.push(check('policy-local', 'F', 'The repository\'s commit rules', 'pass', evidence,
      enforced ? 'SFlow\'s commits here follow the adopted policy; its checks run before each commit.'
        : 'SFlow\'s commits here run the repository\'s own hooks like any commit; nothing extra is enforced.'));
  }
  const server = ctx.serverWords ?? null;
  checks.push(check('policy-server', 'F', 'Server hooks seen by the push check', server ? PASS : 'not available',
    server ? (server.length ? server : ['The host took the push with no message of its own.']) : ['The push check did not run.'],
    server ? (server.length ? 'These are the host\'s own rules SFlow\'s pushes must meet.' : 'No server hook spoke during SFlow\'s push.') : 'What the host\'s own hooks require is still unknown.'));
  return checks;
}

export async function jiraChecks(ctx) {
  const env = ctx.env;
  const set = (...names) => names.some((name) => String(env[name] ?? '').trim());
  const dataCenter = String(env.JIRA_DEPLOYMENT ?? 'cloud').trim().toLowerCase() === 'data-center';
  const present = { address: set('JIRA_BASE_URL'), account: dataCenter || set('JIRA_USERNAME', 'JIRA_EMAIL'), token: set('JIRA_PAT', 'JIRA_API_TOKEN') };
  const ready = present.address && present.account && present.token;
  const checks = [check('jira-settings', 'G', 'SFlow\'s Jira settings present', ready ? PASS : 'fail',
    [`Jira address: ${present.address ? 'set' : 'not set'}.`, `Account: ${dataCenter ? 'not needed (Data Center)' : present.account ? 'set' : 'not set'}.`,
      `Token: ${present.token ? 'set' : 'not set'}.`, `Kind: ${dataCenter ? 'Data Center' : 'Cloud'}.`,
      ctx.surface === 'vscode' ? 'Read from VS Code\'s stored Jira connection and the environment.' : 'Read from the environment only (VS Code\'s stored connection counts when the check runs from VS Code).'],
    ready ? 'Start a task from a Jira key can reach Jira from here.' : 'Start a task from a Jira key cannot read Jira here until the Jira connection is set (VS Code: Singularity Flow: Connect Jira Securely).')];
  const key = await ctx.askText({
    id: 'jira-key',
    question: 'Give one Jira issue key to check that SFlow can read it (optional).',
    why: 'Only the length of its title goes in the report, never its text. Leave it empty to skip.'
  });
  const value = String(key ?? '').trim().toUpperCase();
  if (!value) {
    checks.push(check('jira-read', 'G', 'SFlow reads one Jira issue', 'not available', ['No issue key was given, so no issue was read.'], 'Whether SFlow can read an issue here is still unknown.'));
    return checks;
  }
  if (!JIRA_KEY.test(value)) {
    checks.push(check('jira-read', 'G', 'SFlow reads one Jira issue', 'not available', ['The text given is not a Jira issue key, so no issue was read.'], 'Nothing was learned here.'));
    return checks;
  }
  ctx.secrets.push(value, value.split('-')[0]);
  if (!ready) {
    checks.push(check('jira-read', 'G', 'SFlow reads one Jira issue', 'fail', ['The Jira settings are not all set, so the issue could not be asked for.'], 'Connect Jira first.'));
    return checks;
  }
  try {
    const { getIssue } = await import('../jira.mjs');
    const issue = await (ctx.getIssue ?? getIssue)(value, { env });
    for (const text of [issue?.title, issue?.summary]) if (typeof text === 'string') ctx.secrets.push(text);
    const length = String(issue?.title ?? issue?.summary ?? '').length;
    checks.push(check('jira-read', 'G', 'SFlow reads one Jira issue', 'pass', [`The issue was read; its title is ${length} characters long.`],
      'Start a task from a Jira key works from here.'));
  } catch (error) {
    const category = error?.category ?? 'request';
    const words = { authentication: 'Jira refused the sign-in', permission: 'this account may not read the issue', network: 'Jira could not be reached',
      timeout: 'Jira did not answer in time', 'not-found': 'Jira has no such issue (or hides it from this account)', response: 'Jira answered in a shape SFlow did not expect' }[category]
      ?? (error?.status === 404 ? 'Jira has no such issue (or hides it from this account)' : error?.status === 403 ? 'this account may not read the issue' : 'the request failed');
    checks.push(check('jira-read', 'G', 'SFlow reads one Jira issue', 'fail', [`The issue could not be read: ${words}${error?.status ? ` (HTTP ${error.status})` : ''}.`],
      'Start a task from a Jira key would fail here the same way.'));
  }
  return checks;
}
