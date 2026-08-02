/**
 * Governing a repository that has never heard of Singularity Flow.
 *
 * The first screen anybody needs and the last one to exist. Everything else in the extension assumes
 * a governed repository; this is the one thing that makes one, so it is the only form that works
 * from a window with nothing open at all.
 *
 * It asks for two things because two things are genuinely unknown: which repository, and what the
 * organisation builds. Everything else — the identifier, the default branch, the approval authority,
 * the state branch — is derived, defaulted, or read from the remote.
 */
import { escape, icon } from './webview.ts';

export interface BootstrapForm {
  url: string;
  capabilityId: string;
  capabilityName: string;
  kind: string;
  jiraProject: string;
  teams: string;
  base: string | null;
  stateBranch: string;
  busy: boolean;
  error: string | null;
}

export const EMPTY_BOOTSTRAP: BootstrapForm = {
  url: '', capabilityId: '', capabilityName: '', kind: 'portfolio',
  jiraProject: '', teams: '', base: null, stateBranch: 'state', busy: false, error: null
};

/** The repository identifier a URL implies — shown so it is a fact rather than a surprise. */
export function repositoryIdOf(url: string): string {
  return url.trim()
    .replace(/\/+$/, '')
    .replace(/\.git$/, '')
    .split(/[/:]/)
    .pop()
    ?.normalize('NFKD')
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase() ?? '';
}

export function bootstrapProblems(form: BootstrapForm): string[] {
  const problems: string[] = [];
  if (!form.url.trim()) problems.push('Name the repository to govern, by clone URL.');
  if (!form.base) problems.push('Choose where to clone it.');
  if (!form.capabilityId.trim()) problems.push('Give the capability an identifier.');
  else if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(form.capabilityId.trim())) {
    problems.push('The capability identifier must be lower-case kebab-case, like commerce-platform.');
  }
  return problems;
}

export function bootstrapCommand(form: BootstrapForm): string[] {
  const args = ['bootstrap', form.url.trim(), '--capability', form.capabilityId.trim(), '--json'];
  if (form.capabilityName.trim()) args.push('--name', form.capabilityName.trim());
  if (form.kind.trim()) args.push('--kind', form.kind.trim());
  if (form.jiraProject.trim()) args.push('--jira-project', form.jiraProject.trim());
  if (form.teams.trim()) args.push('--teams', form.teams.trim());
  if (form.base) args.push('--base', form.base);
  if (form.stateBranch.trim()) args.push('--state-branch', form.stateBranch.trim());
  else args.push('--no-state-branch');
  return args;
}

export function bootstrapHtml(form: BootstrapForm): string {
  const problems = bootstrapProblems(form);
  const repositoryId = repositoryIdOf(form.url);
  return `
  <header>
    <h1>${icon('git', { size: 20 })}Govern a repository</h1>
    <p class="meta">Turn a repository that knows nothing about Singularity Flow into the one
      everything else starts from. Nothing else in the product can run until one exists.</p>
  </header>

  <section class="plain">
    <h2>${icon('repository')}Repository</h2>
    <p>
      <label>Clone URL <input type="text" value="${escape(form.url)}" data-boot="url" size="46"
        placeholder="https://github.com/acme/platform.git"></label>
    </p>
    <p class="muted">This becomes the lead repository: it holds the capability map, the governed
      configuration and the state branch.
      <span data-preview="id">${repositoryId ? `It will be known as ${escape(repositoryId)}.` : ''}</span></p>
    <p>
      <button class="secondary" data-choose="base">Choose folder…</button>
      ${form.base ? `<code>${escape(form.base)}</code>` : '<span class="muted">Where to clone it</span>'}
    </p>
  </section>

  <section>
    <h2>${icon('capability')}What this organisation builds</h2>
    <p>
      <label>Identifier <input type="text" value="${escape(form.capabilityId)}" data-boot="capabilityId"
        size="24" placeholder="commerce"></label>
      <label>Name <input type="text" value="${escape(form.capabilityName)}" data-boot="capabilityName"
        size="28" placeholder="Commerce"></label>
    </p>
    <p>
      <label>Kind <input type="text" value="${escape(form.kind)}" data-boot="kind" size="14"></label>
      <label>Jira <input type="text" value="${escape(form.jiraProject)}" data-boot="jiraProject" size="10"
        placeholder="COM"></label>
    </p>
    <p>
      <label>Teams <input type="text" value="${escape(form.teams)}" data-boot="teams" size="40"
        placeholder="comma separated"></label>
    </p>
    <p class="muted">The top of the tree — the business capability everything else sits under. You
      add what delivers it afterwards, from the Capabilities screen, once this repository exists.</p>
  </section>

  <section>
    <h2>${icon('branch')}Workflow state branch</h2>
    <p>
      <label>Branch <input type="text" value="${escape(form.stateBranch)}" data-boot="stateBranch"
        size="18" placeholder="leave empty to skip"></label>
    </p>
    <p class="muted">An orphan branch with no shared ancestry with any code branch, so a rebase of
      the work cannot rewrite the record of it. Created and pushed with everything else.</p>
  </section>

  <section>
    ${problems.length
    ? `<h2>${icon('bad')}Before this can run</h2><ul class="blockers">${problems.map((problem) => `<li>${escape(problem)}</li>`).join('')}</ul>`
    : `<h2>${icon('ok')}Ready</h2><p class="ok-text">Clones ${escape(form.url.trim())}, writes its governed configuration, and pushes.</p>`}
    ${form.error ? `<p class="blockers">${escape(form.error)}</p>` : ''}
    <p>
      <button data-boot-submit="1" ${problems.length || form.busy ? 'disabled' : ''}>
        ${form.busy ? 'Governing…' : 'Govern this repository'}
      </button>
    </p>
  </section>`;
}

export const BOOTSTRAP_SCRIPT = `
  const vscode = acquireVsCodeApi();
  document.addEventListener('click', (event) => {
    const target = event.target.closest('[data-choose],[data-boot-submit]');
    if (!target) return;
    if (target.dataset.choose) vscode.postMessage({ type: 'choose' });
    else vscode.postMessage({ type: 'bootstrap' });
  });
  // Typed values are reported without re-rendering, so the caret stays where it is; the derived
  // identifier and the submit state are answered here.
  const affordances = () => {
    const value = (field) => (document.querySelector('[data-boot="' + field + '"]')?.value ?? '').trim();
    const url = value('url');
    const id = url.replace(/\\/+$/, '').replace(/\\.git$/, '').split(/[\\/:]/).pop()
      .normalize('NFKD').replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').toLowerCase();
    const preview = document.querySelector('[data-preview="id"]');
    if (preview) preview.textContent = url ? 'It will be known as ' + id + '.' : '';
    const button = document.querySelector('[data-boot-submit]');
    const capability = value('capabilityId');
    if (button) button.disabled = !url || !capability || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(capability);
  };
  document.addEventListener('input', (event) => {
    const field = event.target.dataset?.boot;
    if (!field) return;
    vscode.postMessage({ type: 'field', field, value: event.target.value });
    affordances();
  });
`;
