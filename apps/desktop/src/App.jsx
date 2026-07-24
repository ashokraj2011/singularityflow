import React, { useEffect, useMemo, useRef, useState } from 'react';
import Editor from '@monaco-editor/react';
import YAML from 'yaml';
import helpMarkdown from '../../../HELP.md?raw';
import {
  addWorldModelView,
  addPhaseToWorkType,
  createPersona,
  createPhase,
  createWorkType,
  deleteUnusedPhase,
  personaPromptRepositoryPath,
  removePhaseFromWorkType,
  removePersona,
  removeWorkType,
  removeWorldModelView,
  repositorySkillPath,
  setWorkTypeInputs,
  templateRepositoryPath
} from './workflow-designer.mjs';
import {
  extractCopilotQuestions,
  parseStoryPlan,
  planningLogEntry
} from './planning-ui.mjs';
import {
  addPortfolioRepository,
  repositoryMetadataFromForm
} from './portfolio-designer.mjs';
import {
  GovernedMedia,
  MediaLightbox,
  PinnedMediaStrip,
  VisualComparisonReview
} from './VisualReview.jsx';

const navSections = [
  {
    label: 'Delivery',
    items: [
      ['dashboard', 'Overview'],
      ['documents', 'Requirements'],
      ['planning', 'Planning Copilot'],
      ['studio', 'Artifact Studio'],
      ['impact', 'Impact analysis'],
      ['workspaces', 'Project workspaces'],
      ['initiatives', 'Initiatives'],
      ['jira', 'Jira workspace']
    ]
  },
  {
    label: 'Decisions',
    items: [
      ['inbox', 'Approval inbox'],
      ['review', 'Review bundle']
    ]
  },
  {
    label: 'Studio',
    items: [
      ['workflow', 'Workflow designer'],
      ['templates', 'Artifact designer'],
      ['personas', 'Personas & approvals'],
      ['resources', 'Prompts & skills'],
      ['world-model', 'Repository model'],
      ['agents', 'Remote agents']
    ]
  },
  {
    label: 'Learn',
    items: [['help', 'Help & guides']]
  }
];

const onboardingRoles = [
  ['product-owner', 'Product owner'],
  ['business-analyst', 'Business analyst'],
  ['product-designer', 'Product designer'],
  ['architect', 'Architect'],
  ['developer', 'Developer'],
  ['qa', 'Quality engineer'],
  ['security', 'Security / risk'],
  ['delivery-manager', 'Delivery manager'],
  ['operations', 'Operations / SRE'],
  ['other', 'Another role']
];

function preferredPersonaForRole(role, personas) {
  const aliases = {
    'business-analyst': ['product-owner', 'architect'],
    'delivery-manager': ['product-owner', 'architect'],
    operations: ['developer', 'architect'],
    security: ['architect', 'developer'],
    other: []
  };
  return [role, ...(aliases[role] ?? [])].find((candidate) => candidate && personas[candidate]) ?? Object.keys(personas)[0];
}

const navIconPaths = {
  dashboard: ['M4 4h6v6H4z M14 4h6v4h-6z M14 12h6v8h-6z M4 14h6v6H4z'],
  documents: ['M6 3h8l4 4v14H6z M14 3v5h5 M9 12h6 M9 16h6'],
  planning: ['M12 3l1.2 4.1L17 8.3l-3.8 1.2L12 14l-1.2-4.5L7 8.3l3.8-1.2z M18.5 15l.7 2.3 2.3.7-2.3.7-.7 2.3-.7-2.3-2.3-.7 2.3-.7z'],
  studio: ['M12 3l9 5-9 5-9-5z M5 12l7 4 7-4 M5 16l7 4 7-4'],
  impact: ['M12 5v5 M7 19H4v-4 M17 19h3v-4 M4 15l6-4 M20 15l-6-4 M9 3h6v4H9z M2 19h4v3H2z M18 19h4v3h-4z'],
  workspaces: ['M3 6h7l2 2h9v11H3z M7 3h5l2 2h7v3 M7 12h10 M7 16h6'],
  initiatives: ['M5 4h6v5H5z M13 15h6v5h-6z M8 9v3h8v3 M16 9v3'],
  jira: ['M5 3h14v18H5z M8 7h8 M8 11h8 M8 15h5 M18 17l2 2-2 2'],
  inbox: ['M4 5h16v14H4z M4 14h5l2 2h2l2-2h5'],
  review: ['M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z M8 12l2.5 2.5L16 9'],
  workflow: ['M5 4h5v4H5z M14 16h5v4h-5z M14 4h5v4h-5z M10 6h4 M8 8v10h6'],
  templates: ['M5 3h14v18H5z M9 7h6 M9 11h6 M9 15h4'],
  personas: ['M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8z M3 21v-2a6 6 0 0 1 12 0v2 M17 11a3 3 0 0 0 0-6 M18 21v-2a5 5 0 0 0-2-4'],
  resources: ['M5 4h14v16H5z M8 9l2 2-2 2 M12 15h4'],
  'world-model': ['M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z M3 12h18 M12 3a14 14 0 0 1 0 18 M12 3a14 14 0 0 0 0 18'],
  agents: ['M7 8h10a3 3 0 0 1 3 3v7H4v-7a3 3 0 0 1 3-3z M9 13h.01 M15 13h.01 M9 17h6 M12 3v5 M9 3h6'],
  help: ['M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z M9.7 9a2.5 2.5 0 1 1 3.2 2.4c-.9.4-.9 1-.9 1.6 M12 17h.01'],
  collapse: ['M14 5l-7 7 7 7 M20 5v14'],
  expand: ['M10 5l7 7-7 7 M4 5v14'],
  refresh: ['M20 7v5h-5 M4 17v-5h5 M6.1 8A7 7 0 0 1 18 6l2 6 M17.9 16A7 7 0 0 1 6 18l-2-6'],
  download: ['M12 3v12 M7 10l5 5 5-5 M5 21h14'],
  validate: ['M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z M8 12l2.5 2.5L16 9'],
  publish: ['M4 20h16 M12 4v12 M7 9l5-5 5 5']
};

function NavIcon({ name }) {
  const paths = navIconPaths[name] ?? navIconPaths.dashboard;
  return <svg className="nav-glyph" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths.map((item) => <path d={item} key={item} />)}</svg>;
}

const sequenceGates = [
  ['completion', 'Completed workflow'],
  ['currentPhase', 'Non-current phase'],
  ['phaseStatus', 'Wrong phase status'],
  ['freshGeneration', 'Missing fresh generation'],
  ['generationCommit', 'Missing generation commit'],
  ['remoteGeneration', 'Generation not on remote'],
  ['publicationPending', 'Publication pending'],
  ['documentPhase', 'Document outside intake']
];

function Pill({ children, tone = 'neutral' }) { return <span className={`pill ${tone}`}>{children}</span>; }

function Empty({ title, detail, action }) {
  return <div className="empty"><div className="empty-mark">S</div><h2>{title}</h2><p>{detail}</p>{action}</div>;
}

function RecentRepositories({ items, currentPath = null, busy, onOpen, onForget, compact = false }) {
  if (!items.length) return null;
  return <section className={`recent-repositories ${compact ? 'compact' : ''}`}><header><div><span className="eyebrow">Saved locations</span><h3>Recent repositories</h3></div><span>{items.length} saved</span></header><div className="recent-repository-list">{items.map((repository) => <div className={`recent-repository ${repository.available ? '' : 'unavailable'} ${repository.path === currentPath ? 'current' : ''}`} key={repository.path}><button className="recent-repository-open" disabled={busy || !repository.available} onClick={() => onOpen(repository.path)}><span className="recent-repository-icon">⌘</span><span className="recent-repository-copy"><strong>{repository.name}</strong><small title={repository.path}>{repository.path}</small><em>{repository.available ? `${repository.branch ?? 'Git repository'} · ${formatRecentTime(repository.openedAt)}` : 'Location is no longer available'}</em></span>{repository.path === currentPath && <Pill tone="good">Open</Pill>}<span className="recent-repository-arrow">→</span></button><button className="recent-repository-forget" aria-label={`Remove ${repository.name} from recent repositories`} title="Remove from recent locations" onClick={(event) => onForget(event, repository.path)}>×</button></div>)}</div></section>;
}

function RecentWorkspaces({ items, currentPath = null, busy, onOpen, onForget, compact = false }) {
  if (!items.length) return null;
  return <section className={`recent-workspaces recent-repositories ${compact ? 'compact' : ''}`}><header><div><span className="eyebrow">Isolated project contexts</span><h3>Recent workspaces</h3></div><span>{items.length} saved</span></header><div className="recent-repository-list">{items.map((workspace) => <div className={`recent-repository ${workspace.available ? '' : 'unavailable'} ${workspace.path === currentPath ? 'current' : ''}`} key={workspace.path}><button className="recent-repository-open" disabled={busy || !workspace.available} onClick={() => onOpen(workspace.path)}><span className="recent-repository-icon workspace-icon">W</span><span className="recent-repository-copy"><strong>{workspace.name}</strong><small title={workspace.path}>{workspace.path}</small><em>{workspace.available ? `${workspace.anchorType ?? 'Jira'} ${workspace.anchorKey ?? ''} · ${formatRecentTime(workspace.openedAt)}` : 'Workspace manifest is no longer available'}</em></span>{workspace.path === currentPath && <Pill tone="good">Open</Pill>}<span className="recent-repository-arrow">→</span></button><button className="recent-repository-forget" aria-label={`Forget ${workspace.name}`} title="Forget this local workspace; files are not deleted" onClick={(event) => onForget(event, workspace.path)}>×</button></div>)}</div></section>;
}

function OnboardingWizard({ initial, jira, onComplete, onHelp }) {
  const [draft, setDraft] = useState(() => ({
    ...initial,
    step: initial.step ?? 0,
    repositories: initial.repositories ?? [],
    jiraChoice: jira?.connected ? 'connected' : (initial.jiraChoice ?? 'later')
  }));
  const [connection, setConnection] = useState({
    name: 'corporate-jira',
    deployment: 'cloud',
    baseUrl: jira?.connection?.baseUrl ?? '',
    email: jira?.connection?.email ?? '',
    token: '',
    authMode: jira?.connection?.authMode ?? 'user-token'
  });
  const [jiraStatus, setJiraStatus] = useState(jira ?? { connected: false });
  const [working, setWorking] = useState(false);
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);
  const steps = ['Your name', 'Your role', 'Local workspace', 'Repositories', 'Jira & ready'];
  const roleLabel = onboardingRoles.find(([id]) => id === draft.role)?.[1] ?? 'Not selected';

  function update(field, value) {
    setDraft((current) => ({ ...current, [field]: value }));
    setError(null);
    setNotice(null);
  }

  async function persist(nextStep = draft.step, complete = false) {
    setWorking(true);
    setError(null);
    try {
      const result = await window.singularity.saveOnboarding({ ...draft, step: nextStep }, complete);
      setDraft(result.profile);
      setNotice(result.notices?.length ? result.notices.map((item) => item.message).join(' ') : null);
      if (complete) await onComplete(result);
      return result;
    } catch (saveError) {
      setError(saveError?.message || String(saveError));
      return null;
    } finally {
      setWorking(false);
    }
  }

  async function next() {
    if (draft.step === 0 && !draft.name.trim()) return setError('Enter your name to continue.');
    if (draft.step === 1 && !draft.role) return setError('Choose the role you want to use for this desktop profile.');
    if (draft.step === 2 && !draft.workspacePath) return setError('Choose a local workspace directory.');
    const nextStep = Math.min(4, draft.step + 1);
    await persist(nextStep);
  }

  async function back() {
    const nextStep = Math.max(0, draft.step - 1);
    await persist(nextStep);
  }

  async function chooseWorkspace() {
    setWorking(true);
    setError(null);
    try {
      const selected = await window.singularity.chooseOnboardingWorkspace();
      if (selected) update('workspacePath', selected);
    } catch (chooseError) {
      setError(chooseError?.message || String(chooseError));
    } finally {
      setWorking(false);
    }
  }

  async function addRepositories() {
    setWorking(true);
    setError(null);
    try {
      const selected = await window.singularity.chooseOnboardingRepositories();
      if (!selected?.length) return;
      const repositories = new Map(draft.repositories.map((repository) => [repository.path, repository]));
      selected.forEach((repository) => repositories.set(repository.path, repository));
      update('repositories', [...repositories.values()]);
    } catch (chooseError) {
      setError(chooseError?.message || String(chooseError));
    } finally {
      setWorking(false);
    }
  }

  async function connectJira() {
    setWorking(true);
    setError(null);
    try {
      const result = await window.singularity.connectOnboardingJira({
        ...connection,
        email: connection.deployment === 'data-center' ? null : connection.email,
        authMode: connection.deployment === 'data-center' ? 'pat' : connection.authMode
      });
      setJiraStatus({ connected: true, active: result.active, connection: result.connection });
      setConnection((current) => ({ ...current, token: '' }));
      update('jiraChoice', 'connected');
    } catch (connectError) {
      setError(connectError?.message || String(connectError));
    } finally {
      setWorking(false);
    }
  }

  async function resetJiraCredentials(nextChoice = 'later') {
    setWorking(true);
    setError(null);
    try {
      const result = await window.singularity.resetJiraCredentials();
      setJiraStatus(result);
      update('jiraChoice', nextChoice);
    } catch (resetError) {
      setError(resetError?.message || String(resetError));
    } finally {
      setWorking(false);
    }
  }

  const canFinish = Boolean(
    draft.name.trim()
    && draft.role
    && draft.workspacePath
    && ['connected', 'not-used'].includes(draft.jiraChoice)
    && (!jiraStatus.recovery?.required)
  );
  return <div className="onboarding-shell">
    <aside className="onboarding-rail">
      <div className="brand onboarding-brand"><span>S</span><div><strong>Singularity</strong><small>Desktop setup</small></div></div>
      <div className="onboarding-progress">{steps.map((label, index) => <button key={label} className={`${index === draft.step ? 'active' : ''} ${index < draft.step ? 'complete' : ''}`} disabled={working || index > draft.step} onClick={() => index < draft.step && persist(index)}><span>{index < draft.step ? '✓' : index + 1}</span><div><strong>{label}</strong><small>{index === draft.step ? 'Current step' : index < draft.step ? 'Complete' : 'Up next'}</small></div></button>)}</div>
      <div className="onboarding-promise"><span>Private by design</span><p>Your profile and workspace location stay on this computer. Only governed repository configuration enters Git.</p></div>
    </aside>
    <main className="onboarding-main">
      <header className="onboarding-topbar"><span>First-time setup</span><button className="ghost" onClick={onHelp}>Why Singularity?</button></header>
      <section className="onboarding-stage">
        <div className="onboarding-step-count">Step {draft.step + 1} of 5</div>
        {draft.recovery && <div className="onboarding-recovery" role="status"><strong>Local setup recovered</strong><span>{draft.recovery.message}</span></div>}
        {draft.step === 0 && <div className="onboarding-card"><span className="onboarding-symbol">01</span><div className="onboarding-copy"><span className="eyebrow">Welcome</span><h1>What should we call you?</h1><p>This name identifies your local desktop profile. Git identity still remains the authority recorded for governed approvals.</p></div><label className="onboarding-field"><span>Your name</span><input autoFocus value={draft.name} placeholder="Ashok Raj" onChange={(event) => update('name', event.target.value)} /><small>Stored locally, never written to a repository by onboarding.</small></label></div>}
        {draft.step === 1 && <div className="onboarding-card"><span className="onboarding-symbol">02</span><div className="onboarding-copy"><span className="eyebrow">Working perspective</span><h1>How will you use Singularity?</h1><p>Your role personalizes guidance and recommended personas. It never restricts what work you can perform.</p></div><label className="onboarding-field"><span>Primary role</span><select autoFocus value={draft.role ?? ''} onChange={(event) => update('role', event.target.value)}><option value="">Choose a role…</option>{onboardingRoles.map(([id, label]) => <option key={id} value={id}>{label}</option>)}</select><small>Anyone can still assume any repository-configured persona during a session.</small></label></div>}
        {draft.step === 2 && <div className="onboarding-card"><span className="onboarding-symbol">03</span><div className="onboarding-copy"><span className="eyebrow">Local isolation</span><h1>Choose your workspace home.</h1><p>Singularity uses this folder for project workspaces, repository clones, staged documents, caches, and local planning context.</p></div><div className={`onboarding-picker ${draft.workspacePath ? 'selected' : ''}`}><span className="onboarding-picker-icon">⌂</span><div><strong>{draft.workspacePath ? 'Workspace selected' : 'No folder selected'}</strong><small>{draft.workspacePath ?? 'Choose a corporate-approved local directory.'}</small></div><button className={draft.workspacePath ? 'secondary' : 'primary'} onClick={chooseWorkspace} disabled={working}>{draft.workspacePath ? 'Change' : 'Choose folder'}</button></div><div className="onboarding-note"><strong>No new hierarchy</strong><span>This is a local storage boundary, not another Jira or delivery concept.</span></div></div>}
        {draft.step === 3 && <div className="onboarding-card"><span className="onboarding-symbol">04</span><div className="onboarding-copy"><span className="eyebrow">Optional starting points</span><h1>Add repositories now—or later.</h1><p>Select existing Git repositories already initialized with a visible <code>singularity/</code> folder. They become quick-access locations after setup.</p></div><div className="onboarding-repositories">{draft.repositories.map((repository) => <div key={repository.path}><span>{repository.name.slice(0, 1).toUpperCase()}</span><div><strong>{repository.name}</strong><small>{repository.path}</small></div><button className="ghost" aria-label={`Remove ${repository.name}`} onClick={() => update('repositories', draft.repositories.filter((item) => item.path !== repository.path))}>×</button></div>)}<button className="onboarding-add-repository" onClick={addRepositories} disabled={working}><span>＋</span><div><strong>Add local repositories</strong><small>Optional · up to 20 locations</small></div></button></div></div>}
        {draft.step === 4 && <div className="onboarding-card onboarding-jira-card">
          <span className="onboarding-symbol">05</span>
          <div className="onboarding-copy"><span className="eyebrow">Corporate integration</span><h1>Connect Jira, then you’re ready.</h1><p>The token is validated and encrypted by the operating-system credential store. Repository policies still control which Jira hosts and projects each project may use.</p></div>
          {jiraStatus.recovery?.required ? <div className="onboarding-jira-recovery" role="alert">
            <span>!</span>
            <div><strong>Jira credentials need attention</strong><small>{jiraStatus.recovery.message}</small></div>
            <div><button className="secondary compact" disabled={working} onClick={() => resetJiraCredentials('later')}>Reset Jira setup</button><button className="ghost compact" disabled={working} onClick={() => resetJiraCredentials('not-used')}>Reset & continue without Jira</button></div>
          </div> : jiraStatus.connected || draft.jiraChoice === 'connected' ? <div className="onboarding-jira-connected">
            <span>✓</span><div><strong>Jira connected securely</strong><small>{jiraStatus.connection?.baseUrl ?? 'Credential available in this OS account'} · {jiraStatus.connection?.account?.displayName ?? jiraStatus.connection?.email ?? 'authenticated user'}</small></div><Pill tone="good">Ready</Pill>
          </div> : draft.jiraChoice === 'not-used' ? <div className="onboarding-jira-connected neutral">
            <span>—</span><div><strong>Jira is not used</strong><small>You can connect it later from a repository’s Jira workspace.</small></div><button className="secondary compact" onClick={() => update('jiraChoice', 'later')}>Configure instead</button>
          </div> : <>
            <div className="onboarding-jira-form">
              <label><span>Deployment</span><select value={connection.deployment} onChange={(event) => setConnection((current) => ({ ...current, deployment: event.target.value, authMode: event.target.value === 'data-center' ? 'pat' : 'user-token' }))}><option value="cloud">Jira Cloud</option><option value="data-center">Jira Data Center</option></select></label>
              <label className="wide"><span>Jira HTTPS URL</span><input value={connection.baseUrl} placeholder="https://company.atlassian.net" onChange={(event) => setConnection((current) => ({ ...current, baseUrl: event.target.value }))} /></label>
              {connection.deployment === 'cloud' && <label><span>Email</span><input type="email" value={connection.email} placeholder="you@company.com" onChange={(event) => setConnection((current) => ({ ...current, email: event.target.value }))} /></label>}
              <label><span>{connection.deployment === 'cloud' ? 'API token' : 'Personal access token'}</span><input type="password" value={connection.token} placeholder="Stored in OS keychain" onChange={(event) => setConnection((current) => ({ ...current, token: event.target.value }))} /></label>
            </div>
            <div className="onboarding-jira-actions"><button className="primary" disabled={working || !connection.baseUrl || !connection.token || (connection.deployment === 'cloud' && !connection.email)} onClick={connectJira}>{working ? 'Verifying…' : 'Verify & connect Jira'}</button><button className="ghost" onClick={() => update('jiraChoice', 'not-used')}>We do not use Jira</button></div>
          </>}
          <div className="onboarding-ready-summary"><div><span>✓</span><strong>{draft.name}</strong><small>{roleLabel}</small></div><div><span>✓</span><strong>Workspace</strong><small>{draft.workspacePath}</small></div><div><span>{draft.repositories.length ? '✓' : '○'}</span><strong>{draft.repositories.length} repositories</strong><small>{draft.repositories.length ? 'Ready for quick access' : 'Optional—add later'}</small></div><div><span>{['connected', 'not-used'].includes(draft.jiraChoice) && !jiraStatus.recovery?.required ? '✓' : '○'}</span><strong>Jira decision</strong><small>{draft.jiraChoice === 'connected' && !jiraStatus.recovery?.required ? 'Securely connected' : draft.jiraChoice === 'not-used' && !jiraStatus.recovery?.required ? 'Not used' : 'Action required'}</small></div></div>
        </div>}
        {notice && <div className="onboarding-warning" role="status">{notice}</div>}
        {error && <div className="onboarding-error" role="alert">{error}</div>}
      </section>
      <footer className="onboarding-footer"><button className="ghost" disabled={working || draft.step === 0} onClick={back}>Back</button><span>Your setup is saved locally after each step.</span>{draft.step < 4 ? <button className="primary" disabled={working} onClick={next}>{working ? 'Saving…' : draft.step === 3 ? 'Continue to Jira' : 'Continue'}</button> : <button className="primary onboarding-finish" disabled={working || !canFinish} onClick={() => persist(4, true)}>{working ? 'Finishing…' : 'Finish setup & start'}</button>}</footer>
    </main>
  </div>;
}

function OnboardingLoadFailure({ error, retry, help }) {
  return <div className="onboarding-failure">
    <div className="brand large"><span>S</span><div><strong>Singularity</strong><small>Desktop setup</small></div></div>
    <section>
      <span className="onboarding-failure-mark">!</span>
      <span className="eyebrow">Setup could not be loaded</span>
      <h1>We stopped before opening your workspace.</h1>
      <p>Singularity could not safely read the local onboarding profile. No repository, Jira, or Git state was changed.</p>
      <pre>{error}</pre>
      <div><button className="primary" onClick={retry}>Try again</button><button className="secondary" onClick={help}>Open help</button></div>
    </section>
  </div>;
}

function Toast({ toast, onClose }) {
  if (!toast) return null;
  return <div className={`toast ${toast.tone}`} role={toast.tone === 'bad' ? 'alert' : 'status'} aria-live="polite"><span>{toast.text}</span><button type="button" aria-label="Dismiss message" onClick={onClose}>×</button></div>;
}

function CopilotServiceControl({ repository, notify }) {
  const [status, setStatus] = useState({ state: 'loading', running: false, preflight: null });
  const [logs, setLogs] = useState([]);
  const [model, setModel] = useState('');
  const [open, setOpen] = useState(false);
  const [working, setWorking] = useState(false);
  const controlRef = useRef(null);

  useEffect(() => {
    let active = true;
    Promise.all([
      window.singularity.copilotServiceStatus(repository),
      window.singularity.copilotServiceLogs(repository)
    ]).then(([nextStatus, nextLogs]) => {
      if (!active) return;
      setStatus(nextStatus);
      setLogs(nextLogs);
    }).catch((error) => {
      if (active) setStatus({ state: 'error', running: false, preflight: { ready: false, message: error.message } });
    });
    const unsubscribe = window.singularity.onCopilotServiceEvent?.((event) => {
      if (!active || event.repository !== repository) return;
      setStatus((current) => ({ ...current, ...event.service }));
      setLogs((current) => [...current.slice(-299), event]);
    });
    return () => { active = false; unsubscribe?.(); };
  }, [repository]);

  useEffect(() => {
    if (!open) return undefined;
    const closeOutside = (event) => { if (!controlRef.current?.contains(event.target)) setOpen(false); };
    const closeEscape = (event) => { if (event.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', closeOutside);
    document.addEventListener('keydown', closeEscape);
    return () => { document.removeEventListener('mousedown', closeOutside); document.removeEventListener('keydown', closeEscape); };
  }, [open]);

  async function start() {
    setWorking(true);
    try {
      const result = await window.singularity.startCopilotService(repository, model);
      setStatus(result);
      notify({ tone: 'good', text: 'Copilot backend is ready in native Plan mode.' });
    } catch (error) {
      notify({ tone: 'bad', text: error?.message || String(error) });
    } finally {
      setWorking(false);
    }
  }

  async function stop() {
    setWorking(true);
    try {
      const result = await window.singularity.stopCopilotService(repository);
      setStatus(result);
      notify({ tone: 'good', text: 'Copilot backend stopped.' });
    } catch (error) {
      notify({ tone: 'bad', text: error?.message || String(error) });
    } finally {
      setWorking(false);
    }
  }

  const tone = status.state === 'error' || status.preflight?.ready === false ? 'bad' : status.state === 'busy' ? 'busy' : status.running ? 'ready' : 'stopped';
  const canStop = status.running || status.canStop;
  return <div className="copilot-service-control" ref={controlRef}>
    <button className={`copilot-service-trigger ${tone}`} type="button" aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen((current) => !current)} title="Manage the local Copilot ACP backend"><span className="copilot-service-orb">✦</span><span><strong>Copilot</strong><small>{status.state === 'loading' ? 'checking' : status.state}</small></span><i /></button>
    {open && <section className="copilot-service-popover" role="dialog" aria-label="Copilot backend service">
      <header><div><span className="eyebrow">Local ACP process</span><h2>Copilot backend</h2></div><Pill tone={status.running ? 'good' : status.state === 'error' ? 'bad' : 'neutral'}>{status.state}</Pill></header>
      <p>Start Copilot once, then reuse that native Plan-mode process across governed planning turns. Stopping it cancels any active turn; it never changes Git state by itself.</p>
      <div className="copilot-service-facts"><div><span>Mode</span><strong>{status.mode ?? 'plan'}</strong></div><div><span>Version</span><strong>{status.version ?? status.preflight?.version ?? '—'}</strong></div><div><span>Process</span><strong>{status.processId ?? '—'}</strong></div><div><span>Planning</span><strong>{status.activePlanningSessionId ? 'attached' : 'idle'}</strong></div></div>
      {!status.running && <label><span>Model <em>optional</em></span><input value={model} onChange={(event) => setModel(event.target.value)} placeholder="Copilot auto selection" /></label>}
      {status.preflight?.ready === false && <div className="copilot-service-warning">{status.preflight.message}</div>}
      <div className="copilot-service-actions">{canStop ? <button className="danger-button" disabled={working} onClick={stop}>{working ? 'Stopping…' : status.state === 'error' ? 'Retry stop' : 'Stop backend'}</button> : <button className="primary" disabled={working || status.preflight?.ready === false} onClick={start}>{working ? 'Starting…' : 'Start backend'}</button>}<button className="ghost" onClick={() => setOpen(false)}>Close</button></div>
      <details className="copilot-service-log"><summary>Service log <span>{logs.length}</span></summary><div>{logs.length ? logs.slice(-80).map((entry, index) => <p key={`${entry.at}:${entry.type}:${index}`}><time>{new Date(entry.at).toLocaleTimeString()}</time><code>{entry.type}</code><span>{entry.message ?? entry.detail ?? entry.state ?? ''}</span></p>) : <p className="empty-log">No backend events yet.</p>}</div></details>
    </section>}
  </div>;
}

function ProgressRing({ value = 0 }) {
  return <div className="ring" style={{ '--progress': `${value * 3.6}deg` }}><div><strong>{value}%</strong><span>complete</span></div></div>;
}

function formatTokens(value) { return Number.isFinite(value) && value > 0 ? value.toLocaleString('en-US') : '—'; }

function formatDuration(value) {
  if (!Number.isFinite(value) || value < 0) return '—';
  const totalMinutes = Math.round(value / 60_000);
  if (totalMinutes < 1) return `${Math.round(value / 1000)}s`;
  if (totalMinutes < 60) return `${totalMinutes}m`;
  const totalHours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (totalHours < 24) return `${totalHours}h${minutes ? ` ${minutes}m` : ''}`;
  const days = Math.floor(totalHours / 24);
  const hours = totalHours % 24;
  return `${days}d${hours ? ` ${hours}h` : ''}`;
}

function formatRecentTime(value) {
  const time = Date.parse(value);
  if (!Number.isFinite(time)) return 'Previously opened';
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(time));
}

function formatCost(value) {
  if (!Number.isFinite(value)) return '—';
  if (value >= 1) return `$${value.toFixed(2)}`;
  if (value >= 0.01) return `$${value.toFixed(4)}`;
  return `$${value.toFixed(6)}`;
}

function costSource(item) {
  if (item.providerCostRecords && item.configuredPriceRecords) return 'provider + configured pricing';
  if (item.providerCostRecords) return 'provider-reported cost';
  if (item.configuredPriceRecords) return 'configured model pricing';
  return 'cost unavailable';
}

function CostDashboard({ report, pricing = {}, telemetry = null }) {
  const coverage = report.costCoverage;
  const pricedPercent = coverage.usageRecords ? Math.round((coverage.pricedRecords / coverage.usageRecords) * 100) : 0;
  const phaseMaximum = Math.max(...report.phases.map((phase) => phase.cost ?? 0), 0);
  const pricingCount = Object.keys(pricing ?? {}).length;
  const statusTone = report.costStatus === 'exact' ? 'good' : report.costStatus === 'partial' ? 'warn' : 'neutral';
  const captureMissing = telemetry && !telemetry.exists;
  const setupOutdated = telemetry?.setup?.installed && !telemetry.setup.current;
  const setupInstalled = telemetry?.setup?.installed && telemetry.setup.current;
  const guidance = captureMissing && coverage.exactUsageRecords === 0
    ? setupOutdated
      ? 'The installed Copilot telemetry wrapper is outdated, so these generations contain no model or token data. Rerun install.sh, fully exit Copilot, and start a new session inside this repository. Past turns cannot be reconstructed; future generations will be captured.'
      : setupInstalled
        ? 'The telemetry wrapper is installed, but this repository has no telemetry file. The active Copilot process was likely started before setup was installed or from outside this repository. Fully exit Copilot and start a new session from this repository. Past turns cannot be reconstructed.'
        : 'No repository telemetry file exists, so these generations contain no model or token data. Install or enable Singularity Flow Copilot telemetry, fully restart Copilot, and start it inside this repository. Past turns cannot be reconstructed.'
    : coverage.pendingRecords > 0
      ? `${coverage.pendingRecords} generation${coverage.pendingRecords === 1 ? ' is' : 's are'} waiting for Copilot to finish exporting. The next submit or /sflow-next action will reconcile, commit, and push the completed usage automatically.`
    : coverage.usageRecords === 0
    ? 'No generation telemetry has been committed for this work item yet. Publish a phase after starting Copilot with metadata-only telemetry enabled.'
    : coverage.exactUsageRecords === 0
      ? 'Usage records exist, but the provider did not expose exact model/token values. Cost remains unavailable and is never estimated.'
      : report.costStatus === 'unavailable'
        ? `Exact usage is available, but no provider cost or matching model price was found. Add exact model-name rates under tokens.pricing in workflow.yml${coverage.missingModels.length ? ` for ${coverage.missingModels.join(', ')}` : ''}.`
        : report.costStatus === 'partial'
          ? `${coverage.pricedRecords} of ${coverage.usageRecords} usage records are priced. The displayed total is partial; add missing exact model prices or provider cost telemetry.`
          : 'Every committed usage record is priced. Provider-reported cost is preferred; configured exact-model rates are used only as a fallback.';
  return <section className="panel cost-dashboard">
    <header className="panel-heading"><div><span className="eyebrow">Committed AI telemetry</span><h2>Model usage & cost</h2></div><div className="row gap">{telemetry && <Pill tone={telemetry.ready ? 'good' : 'warn'}>{telemetry.ready ? 'Copilot capture ready' : telemetry.exists ? 'Copilot capture waiting' : 'Copilot capture inactive'}</Pill>}{coverage.pendingRecords > 0 && <Pill tone="warn">{coverage.pendingRecords} pending export{coverage.pendingRecords === 1 ? '' : 's'}</Pill>}<span className="pricing-count">{pricingCount} configured model price{pricingCount === 1 ? '' : 's'}</span><Pill tone={statusTone}>{report.costStatus} coverage</Pill></div></header>
    <div className="cost-summary">
      <div className="cost-total-card"><span>Recorded cost</span><strong>{formatCost(report.cost)}</strong><small>{report.cost == null ? 'No estimate shown' : 'Provider cost or configured exact-model rates'}</small><div className="coverage-line"><div><span style={{ width: `${pricedPercent}%` }} /></div><b>{pricedPercent}% priced</b></div></div>
      <div className="cost-kpis">
        <div><span>Exact tokens</span><strong>{formatTokens(report.tokens.total)}</strong><small>{coverage.exactUsageRecords}/{coverage.usageRecords} exact usage records</small></div>
        <div><span>Models used</span><strong>{report.tokens.byModel.length || '—'}</strong><small>{report.tokens.byModel.map((item) => item.model).join(', ') || 'unavailable'}</small></div>
        <div><span>Cost records</span><strong>{coverage.pricedRecords || '—'}</strong><small>{coverage.providerCostRecords} provider · {coverage.configuredPriceRecords} configured</small></div>
      </div>
    </div>
    <div className={`cost-guidance ${report.costStatus}`}><strong>{captureMissing && coverage.exactUsageRecords === 0 ? setupOutdated ? 'Telemetry setup is outdated' : 'Copilot capture was inactive' : coverage.pendingRecords > 0 ? 'Waiting for Copilot export' : report.costStatus === 'exact' ? 'Complete cost coverage' : report.costStatus === 'partial' ? 'Partial cost coverage' : 'Cost needs telemetry or pricing'}</strong><span>{guidance}</span></div>
    <div className="cost-breakdown-grid">
      <div className="cost-breakdown"><header><div><span className="eyebrow">Lifecycle allocation</span><h3>Cost by phase</h3></div><span>Tokens · cost</span></header><div className="cost-rows">
        {report.phases.map((phase) => <div className="cost-row" key={phase.id}><div className="cost-row-copy"><strong>{phase.label}</strong><small>{formatTokens(phase.tokens)} tokens · {phase.costStatus}</small></div><div className="cost-bar" aria-label={`${phase.label} cost ${formatCost(phase.cost)}`}><span style={{ width: phase.cost != null && phaseMaximum ? `${Math.max(3, (phase.cost / phaseMaximum) * 100)}%` : '0%' }} /></div><b>{formatCost(phase.cost)}</b></div>)}
      </div></div>
      <div className="cost-breakdown"><header><div><span className="eyebrow">Provider attribution</span><h3>Cost by model</h3></div><span>Coverage source</span></header><div className="model-cost-rows">
        {!report.tokens.byModel.length && <div className="inline-empty">No provider/model usage has been captured yet.</div>}
        {report.tokens.byModel.map((item) => <div className="model-cost-row" key={`${item.provider}:${item.model}`}><div><span className="model-badge">{item.provider.slice(0, 2).toUpperCase()}</span><span><strong>{item.model}</strong><small>{item.provider} · {item.records} record{item.records === 1 ? '' : 's'} · {formatTokens(item.totalTokens)} tokens</small></span></div><div><strong>{formatCost(item.cost)}</strong><small>{item.pricedRecords}/{item.records} priced · {costSource(item)}</small></div></div>)}
      </div></div>
    </div>
  </section>;
}

function WorkflowTiming({ report }) {
  const maximum = Math.max(...report.phases.map((phase) => phase.elapsedMs ?? 0), 0);
  return <section className="panel timing-dashboard">
    <header className="panel-heading"><div><span className="eyebrow">Wall-clock lifecycle</span><h2>Workflow time</h2></div><Pill tone={report.completedAt ? 'good' : 'accent'}>{report.completedAt ? 'Complete' : 'Live'}</Pill></header>
    <div className="timing-summary">
      <div><span>Total elapsed</span><strong>{formatDuration(report.elapsedMs)}</strong><small>{report.completedAt ? 'Creation to final approval' : 'Creation to now'}</small></div>
      <div><span>Active time</span><strong>{formatDuration(report.activeMs)}</strong><small>Elapsed time outside approval queues</small></div>
      <div><span>Approval waiting</span><strong>{formatDuration(report.waitingMs)}</strong><small>{report.bottleneck ? `Longest: ${report.bottleneck.phase} (${formatDuration(report.bottleneck.waitingMs)})` : 'No approval waiting recorded'}</small></div>
    </div>
    <div className="timing-legend"><span><i className="active" />Active</span><span><i className="waiting" />Awaiting approval</span><em>Wall-clock time includes nights and weekends</em></div>
    <div className="timing-table"><div className="timing-header"><span>Phase</span><span>Lifecycle allocation</span><span>Active</span><span>Review wait</span><span>Total</span></div>{report.phases.map((phase) => {
      const activeWidth = maximum ? ((phase.activeMs ?? 0) / maximum) * 100 : 0;
      const waitingWidth = maximum ? ((phase.waitingMs ?? 0) / maximum) * 100 : 0;
      return <div className="timing-row" key={phase.id}><div><StatusDot status={phase.status} /><span><strong>{phase.label}</strong><small>{phase.status.replaceAll('_', ' ')} · generation {phase.generations}</small></span></div><div className="timing-bar" aria-label={`${phase.label}: ${formatDuration(phase.elapsedMs)} total`}><span className="active" style={{ width: `${activeWidth}%` }} /><span className="waiting" style={{ width: `${waitingWidth}%` }} /></div><b>{formatDuration(phase.activeMs)}</b><b>{formatDuration(phase.waitingMs)}</b><strong>{formatDuration(phase.elapsedMs)}</strong></div>;
    })}</div>
  </section>;
}

function CopilotQuestionCard({ question, disabled, onAnswer, onDismiss }) {
  const properties = question.schema?.properties ?? {
    answer: { type: 'string', title: 'Your answer', description: 'Give Copilot the decision or missing context.' }
  };
  const [values, setValues] = useState(() => Object.fromEntries(Object.entries(properties).map(([id, property]) => [
    id,
    property.default ?? (property.type === 'boolean' ? false : property.type === 'array' ? [] : '')
  ])));
  const required = new Set(question.schema?.required ?? Object.keys(properties));
  const complete = [...required].every((id) => {
    const value = values[id];
    return Array.isArray(value) ? value.length > 0 : typeof value === 'boolean' ? true : String(value ?? '').trim().length > 0;
  });
  function setField(id, value) { setValues((current) => ({ ...current, [id]: value })); }
  return <article className="copilot-question-card">
    <header><span className="ai-orb">?</span><div><span className="eyebrow">Question from Copilot</span><h3>{question.message}</h3></div></header>
    <div className="copilot-question-fields">{Object.entries(properties).map(([id, property]) => {
      const label = property.title ?? id.replaceAll('_', ' ');
      const options = property.oneOf?.map((item) => ({ value: item.const, label: item.title, detail: item.description }))
        ?? property.enum?.map((item) => ({ value: item, label: item }))
        ?? null;
      if (property.type === 'boolean') return <label className="copilot-check" key={id}><input type="checkbox" checked={Boolean(values[id])} onChange={(event) => setField(id, event.target.checked)} /><span><strong>{label}</strong>{property.description && <small>{property.description}</small>}</span></label>;
      if (property.type === 'array' && property.items) {
        const items = property.items.anyOf?.map((item) => ({ value: item.const, label: item.title }))
          ?? property.items.enum?.map((item) => ({ value: item, label: item }))
          ?? [];
        return <fieldset key={id}><legend>{label}</legend>{property.description && <small>{property.description}</small>}<div className="copilot-multiselect">{items.map((item) => <label key={item.value}><input type="checkbox" checked={values[id]?.includes(item.value)} onChange={(event) => setField(id, event.target.checked ? [...values[id], item.value] : values[id].filter((value) => value !== item.value))} />{item.label}</label>)}</div></fieldset>;
      }
      return <label key={id}><span>{label}{required.has(id) ? ' *' : ''}</span>{property.description && <small>{property.description}</small>}{options ? <select value={values[id]} onChange={(event) => setField(id, event.target.value)}><option value="">Choose…</option>{options.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select> : property.type === 'number' || property.type === 'integer' ? <input type="number" value={values[id]} min={property.minimum} max={property.maximum} onChange={(event) => setField(id, property.type === 'integer' ? Number.parseInt(event.target.value, 10) : Number(event.target.value))} /> : <textarea rows="3" value={values[id]} onChange={(event) => setField(id, event.target.value)} />}</label>;
    })}</div>
    <footer><span>Your answer stays in this Copilot planning session and becomes part of the reviewed decision context.</span><div className="row"><button className="ghost compact" disabled={disabled} onClick={() => onDismiss(question)}>Skip</button><button className="primary compact" disabled={disabled || !complete} onClick={() => onAnswer(question, values)}>Answer Copilot</button></div></footer>
  </article>;
}

function StoryPlanAnalysis({ analysis }) {
  return <section className="panel planning-decomposition">
    <header className="panel-heading"><div><span className="eyebrow">Epic decomposition analysis</span><h2>Planned Jira & Git delivery units</h2></div><Pill tone={analysis.valid ? 'good' : 'warn'}>{analysis.valid ? `${analysis.epics.length} epics · ${analysis.stories.length} stories` : 'needs refinement'}</Pill></header>
    {!analysis.valid ? <div className="planning-warning"><span>⚠ {analysis.error}</span></div> : <>
      <div className="decomposition-kpis"><div><span>Epic IDs</span><strong>{analysis.epics.length}</strong><small>Jira epics after materialization</small></div><div><span>Story Work IDs</span><strong>{analysis.stories.length}</strong><small>Git branch + workflow identity</small></div><div><span>Repositories</span><strong>{analysis.repositories.length}</strong><small>{analysis.repositories.join(', ')}</small></div><div><span>Dependencies</span><strong>{analysis.dependencies}</strong><small>{analysis.blocking} blocking stories</small></div></div>
      <div className="decomposition-epics">{analysis.epics.map((epic) => <section key={epic.id}><header><div><span className="id-pair"><b>Epic ID</b><code>{epic.id}</code></span><h3>{epic.title}</h3></div><span className="id-pair"><b>Jira ID</b><code>{epic.jiraKey ?? 'created later'}</code></span></header><div>{epic.stories.map((story) => <article key={story.id}><div><span className="id-pair"><b>Work ID</b><code>{story.workId}</code></span><Pill tone={story.blocking ? 'accent' : 'neutral'}>{story.blocking ? 'blocking' : 'nonblocking'}</Pill></div><strong>{story.title}</strong><small>{story.repository} · {story.acceptanceCriteria.length} acceptance criteria · Jira {story.jiraKey ?? 'created during materialization'}</small>{story.dependsOn.length > 0 && <em>Depends on {story.dependsOn.map((dependency) => typeof dependency === 'string' ? dependency : dependency.story).join(', ')}</em>}</article>)}</div></section>)}</div>
    </>}
  </section>;
}

function StatusDot({ status }) { return <span className={`status-dot ${String(status).replaceAll('_', '-')}`} title={status} />; }

function SourceEditor({ path, value, onChange, language = 'markdown', dirty, onSave, onDownload, onImport, readOnly = false }) {
  return <section className="editor-panel">
    <header className="editor-header"><div><span className="eyebrow">{readOnly ? 'Repository-owned source' : 'Repository source'}</span><strong>{path}</strong></div><div className="row">{onImport && <button className="ghost compact" onClick={onImport}>Import</button>}{onDownload && <button className="secondary compact" onClick={onDownload}>Download</button>}<Pill tone={readOnly ? 'neutral' : dirty ? 'warn' : 'good'}>{readOnly ? 'Read only' : dirty ? 'Unsaved' : 'Saved'}</Pill>{!readOnly && <button className="primary compact" disabled={!dirty} onClick={onSave}>Save</button>}</div></header>
    <Editor height="calc(100vh - 245px)" language={language} theme="vs-light" value={value} onChange={(next) => !readOnly && onChange(next ?? '')} options={{ readOnly, minimap: { enabled: false }, fontFamily: 'SFMono-Regular, Consolas, Liberation Mono, monospace', fontSize: 14, lineHeight: 23, wordWrap: 'on', padding: { top: 18 }, scrollBeyondLastLine: false, automaticLayout: true }} />
  </section>;
}

function DesignerModal({ title, detail, children, submitLabel, danger = false, error, onCancel, onSubmit }) {
  return <div className="modal-backdrop" onClick={onCancel}><form className="designer-modal" onClick={(event) => event.stopPropagation()} onSubmit={(event) => { event.preventDefault(); onSubmit(); }}>
    <header><div><span className="eyebrow">Guided configuration</span><h2>{title}</h2></div><button type="button" onClick={onCancel}>×</button></header>
    <div className="designer-modal-body">{detail && <p>{detail}</p>}{children}{error && <div className="form-error" role="alert">{error}</div>}</div>
    <footer><button type="button" className="secondary" onClick={onCancel}>Cancel</button><button type="submit" className={danger ? 'danger-button' : 'primary'}>{submitLabel}</button></footer>
  </form></div>;
}

function ArtifactStudio({ data, downloadFile, openWorkspace }) {
  const storyPhases = data.progress?.phases ?? [];
  const initiativePhases = data.initiative?.progress?.phases ?? [];
  const phases = storyPhases.length ? storyPhases : initiativePhases;
  const [selectedPhase, setSelectedPhase] = useState(phases.find((phase) => ['in_progress', 'awaiting_approval'].includes(phase.status))?.id ?? phases[0]?.id ?? '');
  const selected = phases.find((phase) => phase.id === selectedPhase) ?? phases[0];
  const initiativeDocuments = (data.initiative?.documents ?? []).map((document) => ({
    ...document,
    id: `${document.phase}:${document.id}`,
    path: document.repositoryPath,
    kind: document.kind,
    size: document.content ? new TextEncoder().encode(document.content).length : null
  }));
  const documents = data.documents.length ? data.documents : initiativeDocuments;
  const phaseDocuments = documents.filter((document) => document.phase === selected?.id);
  const completion = data.progress?.percentage ?? data.initiative?.progress?.percentage ?? 0;
  const title = data.workflow?.workItem.title ?? data.initiative?.state.initiative.title ?? 'Governed delivery workspace';
  return <div className="page artifact-studio-page">
    <header className="page-heading row-between"><div><span className="eyebrow">Artifact lifecycle</span><h1>Artifact Studio</h1><p>Follow each governed phase from repository context to approved, Git-backed output.</p></div><div className="studio-heading-actions"><Pill tone="accent">{completion}% complete</Pill><button className="primary" onClick={openWorkspace}>Open requirement workspace</button></div></header>
    {!phases.length ? <Empty title="No active delivery selected" detail="Choose a story work item or initiative to see its artifact lifecycle." /> : <>
      <section className="studio-flow panel">
        <header><div><span className="eyebrow">Active delivery</span><h2>{title}</h2></div><span>{phases.length} governed phases</span></header>
        <div className="studio-flow-track">{phases.map((phase, index) => <React.Fragment key={phase.id}><button className={`${phase.id === selected?.id ? 'active' : ''} ${phase.status.replaceAll('_', '-')}`} onClick={() => setSelectedPhase(phase.id)}><span>{phase.status === 'approved' ? '✓' : index + 1}</span><strong>{phase.label}</strong><small>{phase.status.replaceAll('_', ' ')}</small></button>{index < phases.length - 1 && <i>→</i>}</React.Fragment>)}</div>
      </section>
      <div className="studio-insight-grid">
        <section className="panel phase-insight">
          <header className="panel-heading"><div><span className="eyebrow">Phase insight</span><h2>{selected?.label}</h2></div><Pill tone={selected?.status === 'approved' ? 'good' : selected?.status === 'awaiting_approval' ? 'warn' : 'accent'}>{selected?.status.replaceAll('_', ' ')}</Pill></header>
          <div className="phase-insight-body">
            <div><span>Generation</span><strong>{selected?.generation ?? selected?.generatedOutputs ?? 0}</strong><small>immutable artifact revision</small></div>
            <div><span>Approval</span><strong>{selected?.approvals != null ? `${selected.approvals}/${selected.approvalsRequired}` : selected?.status === 'approved' ? 'Complete' : 'Pending'}</strong><small>exact content hash</small></div>
            <div><span>Outputs</span><strong>{phaseDocuments.length || selected?.outputs || 0}</strong><small>registered documents</small></div>
          </div>
          <div className="phase-deliverables"><strong>Governed deliverables</strong>{phaseDocuments.length ? phaseDocuments.map((document) => <button key={document.id} onClick={() => downloadFile(document.path)}><span className="studio-file-icon">{document.kind === 'artifact' ? 'MD' : 'DOC'}</span><span><b>{document.label}</b><small>{document.path}</small></span><em>Download</em></button>) : <div className="inline-empty">No phase document has been published yet.</div>}</div>
        </section>
        <section className="panel studio-assistant">
          <header className="panel-heading"><div><span className="eyebrow">Singularity intelligence</span><h2>What happens next</h2></div><span className="ai-orb">✦</span></header>
          <div className="studio-assistant-copy"><strong>{selected?.status === 'approved' ? 'This phase is governed and reusable.' : selected?.status === 'awaiting_approval' ? 'The artifact is ready for a hash-bound review.' : 'Build the phase output from governed context.'}</strong><p>{selected?.status === 'approved' ? 'Downstream phases can consume this approved artifact through declared inputs.' : selected?.status === 'awaiting_approval' ? 'Open the review bundle to inspect provenance, evidence, and approval requirements.' : 'Use Planning Copilot to explore options, then promote a reviewed artifact into repository state.'}</p></div>
          <div className="assistant-checks"><span><i className="done">✓</i>Repository context pinned</span><span><i className={phaseDocuments.length ? 'done' : ''}>{phaseDocuments.length ? '✓' : '○'}</i>Artifact generated</span><span><i className={selected?.status === 'approved' ? 'done' : ''}>{selected?.status === 'approved' ? '✓' : '○'}</i>Approval recorded</span></div>
        </section>
      </div>
      <section className="panel artifact-repository">
        <header className="panel-heading"><div><span className="eyebrow">Shared repository</span><h2>Governed artifacts</h2></div><span>{documents.length} registered</span></header>
        <div className="artifact-repository-head"><span>Name</span><span>Phase</span><span>Status</span><span>Repository path</span><span /></div>
        {documents.length ? documents.map((document) => <div className="artifact-repository-row" key={document.id}><div><span className="studio-file-icon">{document.kind === 'artifact' ? 'MD' : document.kind === 'url' ? 'URL' : 'DOC'}</span><strong>{document.label}</strong></div><span>{document.phase ?? 'system'}</span><Pill tone={document.status === 'approved' ? 'good' : 'neutral'}>{document.status ?? document.kind}</Pill><code>{document.path ?? document.url}</code><button className="ghost compact" onClick={() => document.path ? downloadFile(document.path) : openWorkspace()}>Open</button></div>) : <div className="inline-empty">Generated and uploaded artifacts will appear here with their repository provenance.</div>}
      </section>
    </>}
  </div>;
}

function ImpactStudio({ data, openPlanning }) {
  const repositories = Object.entries(data.portfolio?.repositories ?? {});
  const graphRepositories = repositories.length ? repositories.slice(0, 5) : [[data.repository.root.split('/').at(-1), { defaultBranch: data.repository.branch, required: true }]];
  const stories = data.initiative?.report?.children?.stories ?? [];
  const staleStories = stories.filter((story) => story.stale);
  const contracts = data.initiative?.contracts ?? [];
  const riskyContracts = contracts.filter((contract) => contract.integrity !== 'verified');
  const subject = data.initiative?.state.initiative.title ?? data.workflow?.workItem.title ?? 'Current repository change';
  const risk = staleStories.length || riskyContracts.length ? 'Medium' : 'Low';
  const nodePositions = [[90, 58], [550, 58], [70, 285], [555, 285], [320, 340]];
  return <div className="impact-page">
    <header className="impact-toolbar"><div><span className="eyebrow">Repository intelligence</span><h1>Impact Analysis Studio</h1><p>{subject}</p></div><div><Pill tone={risk === 'Low' ? 'good' : 'warn'}>{risk} delivery risk</Pill><button className="primary" onClick={openPlanning}>Explore with Planning Copilot</button></div></header>
    <div className="impact-layout">
      <main className="impact-main">
        <section className="impact-canvas panel">
          <header className="panel-heading"><div><span className="eyebrow">Dependency topology</span><h2>Change impact map</h2></div><span>{graphRepositories.length} repositories · {stories.length} stories</span></header>
          <div className="impact-graph">
            <svg viewBox="0 0 640 410" role="img" aria-label="Repository dependency graph">{graphRepositories.map(([id], index) => <line key={id} x1="320" y1="205" x2={nodePositions[index][0]} y2={nodePositions[index][1]} />)}<circle cx="320" cy="205" r="64" /></svg>
            <div className="impact-core"><span>REQ</span><strong>{data.initiative?.state.initiative.id ?? data.workflow?.workItem.id ?? 'LOCAL'}</strong><small>governed change</small></div>
            {graphRepositories.map(([id, repository], index) => <div className="impact-node" key={id} style={{ '--x': `${nodePositions[index][0]}px`, '--y': `${nodePositions[index][1]}px` }}><span>{id.slice(0, 2).toUpperCase()}</span><strong>{repository.metadata?.name ?? id}</strong><small>{repository.metadata?.appId ? `${repository.metadata.appId} · ` : ''}{repository.defaultBranch ?? 'main'} · {repository.required ? 'required' : 'optional'}</small></div>)}
          </div>
        </section>
        <section className="panel affected-repositories">
          <header className="panel-heading"><div><span className="eyebrow">Change surface</span><h2>Affected repositories</h2></div><span>{stories.length || graphRepositories.length} tracked units</span></header>
          <div className="affected-head"><span>Repository</span><span>Branch</span><span>Stories</span><span>State</span></div>
          {graphRepositories.map(([id, repository]) => { const owned = stories.filter((story) => story.repository === id); const stale = owned.some((story) => story.stale); return <div className="affected-row" key={id}><strong>{repository.metadata?.name ?? id}{repository.metadata?.appId && <small> · {repository.metadata.appId}</small>}</strong><code>{repository.defaultBranch ?? 'main'}</code><span>{owned.length || '—'}</span><Pill tone={stale ? 'warn' : 'good'}>{stale ? 'stale context' : 'reachable'}</Pill></div>; })}
        </section>
      </main>
      <aside className="impact-inspector">
        <section className="impact-risk-card"><span className="ai-orb">✦</span><div><span className="eyebrow">Singularity analysis</span><h2>{risk} risk</h2><p>Computed from committed repository reachability, story context freshness, and interface-contract integrity.</p></div></section>
        <section className="impact-kpis"><div><span>Repositories</span><strong>{graphRepositories.length}</strong></div><div><span>Blocking stories</span><strong>{stories.filter((story) => story.blocking).length}</strong></div><div><span>Stale contexts</span><strong>{staleStories.length}</strong></div><div><span>Contract alerts</span><strong>{riskyContracts.length}</strong></div></section>
        <section className="impact-findings"><header><span className="eyebrow">Findings</span><h3>Review before planning</h3></header>{staleStories.length ? <div className="finding warn"><strong>{staleStories.length} stale story context{staleStories.length === 1 ? '' : 's'}</strong><span>Synchronize approved initiative inputs before downstream generation.</span></div> : <div className="finding good"><strong>Child context is current</strong><span>No stale materialized story snapshots were reported.</span></div>}{riskyContracts.length ? <div className="finding warn"><strong>{riskyContracts.length} contract integrity alert{riskyContracts.length === 1 ? '' : 's'}</strong><span>Reconcile producer and consumer hashes before construction.</span></div> : <div className="finding good"><strong>Contracts verified</strong><span>All registered interface contracts match their committed hashes.</span></div>}<div className="finding"><strong>World model remains repository-owned</strong><span>Planning will use the pinned local model plus approved initiative context.</span></div></section>
      </aside>
    </div>
  </div>;
}

function PortfolioSetup({ data, action, onCreated, jiraFirst = false }) {
  const [values, setValues] = useState({
    approvalName: '',
    approvalEmail: '',
    repositoryId: '',
    repositoryUrl: '',
    repositoryAppId: '',
    repositoryName: '',
    repositoryMetadata: [{ key: '', value: '' }],
    defaultBranch: data.definition.defaultBaseBranch ?? 'main',
    jiraEnabled: jiraFirst,
    jiraDeployment: 'cloud',
    jiraBaseUrl: '',
    jiraProjectKey: '',
    jiraWriteMode: 'off'
  });
  const set = (name, value) => setValues((current) => ({ ...current, [name]: value }));
  const setMetadata = (index, field, value) => setValues((current) => ({
    ...current,
    repositoryMetadata: current.repositoryMetadata.map((entry, entryIndex) => entryIndex === index ? { ...entry, [field]: value } : entry)
  }));
  const repositoryPartial = Boolean(
    values.repositoryId
    || values.repositoryUrl
    || values.repositoryAppId
    || values.repositoryName
    || values.repositoryMetadata.some((entry) => entry.key || entry.value)
  );
  const jiraReady = !values.jiraEnabled || Boolean(values.jiraBaseUrl);
  async function create() {
    const result = await action(() => window.singularity.bootstrapPortfolio(data.repository.root, {
      approvalName: values.approvalName || null,
      approvalEmail: values.approvalEmail || null,
      repository: repositoryPartial ? {
        id: values.repositoryId,
        url: values.repositoryUrl,
        defaultBranch: values.defaultBranch,
        required: true,
        metadata: repositoryMetadataFromForm({
          appId: values.repositoryAppId,
          name: values.repositoryName,
          metadata: values.repositoryMetadata
        })
      } : null,
      jira: {
        enabled: values.jiraEnabled,
        deployment: values.jiraDeployment,
        baseUrl: values.jiraBaseUrl,
        projectKey: values.jiraProjectKey,
        writeMode: values.jiraWriteMode,
        connection: 'corporate-jira'
      }
    }), 'Portfolio configuration created and validated');
    if (result) onCreated(result);
  }
  return <div className="portfolio-setup">
    <section className="portfolio-setup-intro"><span className="jira-mark">S</span><span className="eyebrow">Guided repository setup</span><h1>Create the initiative portfolio</h1><p>This creates the editable enterprise and lightweight profiles, approval groups, repository registry, and optional Jira policy under <code>singularity/portfolio.yml</code>. It remains an uncommitted configuration change until you use <strong>Commit & push</strong>.</p><div className="portfolio-setup-steps"><span><b>1</b>Identity</span><span><b>2</b>Repositories</span><span><b>3</b>Jira policy</span></div></section>
    <section className="portfolio-setup-form panel">
      <header><span className="eyebrow">Approval identity</span><h2>Who owns the initial gates?</h2><p>Leave these blank to use the repository’s configured Git name and email.</p></header>
      <div className="control-grid"><label><span>Display name</span><input value={values.approvalName} placeholder="Use Git user.name" onChange={(event) => set('approvalName', event.target.value)} /></label><label><span>Email</span><input type="email" value={values.approvalEmail} placeholder="Use Git user.email" onChange={(event) => set('approvalEmail', event.target.value)} /></label></div>
      <header><span className="eyebrow">Participating repository</span><h2>Add the first delivery repository</h2><p>Optional now. More repositories can be added later in Portfolio designer.</p></header>
      <div className="control-grid expanded"><label><span>Repository ID</span><input value={values.repositoryId} placeholder="mobile" onChange={(event) => set('repositoryId', event.target.value)} /></label><label><span>Application ID</span><input value={values.repositoryAppId} placeholder="APP-1001" onChange={(event) => set('repositoryAppId', event.target.value)} /></label><label className="full"><span>Application name</span><input value={values.repositoryName} placeholder="Mobile application" onChange={(event) => set('repositoryName', event.target.value)} /></label><label className="full"><span>Git URL</span><input value={values.repositoryUrl} placeholder="git@github.com:company/mobile.git" onChange={(event) => set('repositoryUrl', event.target.value)} /></label><label><span>Default branch</span><input value={values.defaultBranch} onChange={(event) => set('defaultBranch', event.target.value)} /></label></div>
      <div className="repository-metadata-fields"><header><div><strong>Additional metadata</strong><span>Optional key/value pairs are committed under this repository in <code>singularity/portfolio.yml</code>.</span></div><button type="button" className="ghost compact" onClick={() => set('repositoryMetadata', [...values.repositoryMetadata, { key: '', value: '' }])}>＋ Add field</button></header>{values.repositoryMetadata.map((entry, index) => <div key={index}><input aria-label={`Metadata key ${index + 1}`} value={entry.key} placeholder="owner" onChange={(event) => setMetadata(index, 'key', event.target.value)} /><input aria-label={`Metadata value ${index + 1}`} value={entry.value} placeholder="Digital Channels" onChange={(event) => setMetadata(index, 'value', event.target.value)} />{values.repositoryMetadata.length > 1 && <button type="button" className="ghost compact" aria-label={`Remove metadata field ${index + 1}`} onClick={() => set('repositoryMetadata', values.repositoryMetadata.filter((_, entryIndex) => entryIndex !== index))}>×</button>}</div>)}</div>
      <header className="portfolio-jira-toggle"><div><span className="eyebrow">Corporate integration</span><h2>Configure Jira now</h2></div><label className="switch"><input type="checkbox" checked={values.jiraEnabled} onChange={(event) => set('jiraEnabled', event.target.checked)} /><span /></label></header>
      {values.jiraEnabled && <div className="control-grid expanded"><label><span>Deployment</span><select value={values.jiraDeployment} onChange={(event) => set('jiraDeployment', event.target.value)}><option value="cloud">Jira Cloud</option><option value="data-center">Jira Data Center</option></select></label><label className="full"><span>Jira HTTPS URL</span><input value={values.jiraBaseUrl} placeholder="https://company.atlassian.net" onChange={(event) => set('jiraBaseUrl', event.target.value)} /></label><label><span>Project key</span><input value={values.jiraProjectKey} placeholder="APP" onChange={(event) => set('jiraProjectKey', event.target.value.toUpperCase())} /></label><label><span>Write policy</span><select value={values.jiraWriteMode} onChange={(event) => set('jiraWriteMode', event.target.value)}><option value="off">Off · browse/adopt only</option><option value="preview">Preview · commit plans only</option><option value="approved">Approved · guarded apply</option></select></label></div>}
      <div className="portfolio-setup-action"><div><strong>No credentials are stored in YAML</strong><span>The API token/PAT is requested separately after the portfolio is created.</span></div><button className="primary" disabled={(repositoryPartial && (!values.repositoryId || !values.repositoryUrl)) || !jiraReady} onClick={create}>Create & validate portfolio</button></div>
    </section>
  </div>;
}

function WorkspaceStudio({ data, action, onOpened, onConfigureJira, defaultBaseDirectory = '' }) {
  const policy = data.portfolio?.jira;
  const current = data.workspace;
  const configuredRepositories = Object.keys(data.portfolio?.repositories ?? {});
  const repositoryChoices = configuredRepositories.length ? configuredRepositories : ['lead'];
  const [jira, setJira] = useState(null);
  const [projects, setProjects] = useState([]);
  const [projectKey, setProjectKey] = useState(policy?.projectKey ?? '');
  const [anchors, setAnchors] = useState([]);
  const [anchorKey, setAnchorKey] = useState('');
  const [hierarchy, setHierarchy] = useState(null);
  const [baseDirectory, setBaseDirectory] = useState(defaultBaseDirectory);
  const [leadRepository, setLeadRepository] = useState(repositoryChoices[0] ?? 'lead');
  const [selectedRepositories, setSelectedRepositories] = useState(() => Object.fromEntries(repositoryChoices.map((id) => [id, true])));
  const [preview, setPreview] = useState(null);
  const [confirmation, setConfirmation] = useState('');
  const [health, setHealth] = useState(current ?? null);

  useEffect(() => {
    let active = true;
    if (!policy?.enabled) return undefined;
    window.singularity.jiraStatus(data.repository.root)
      .then((result) => { if (active) setJira(result); })
      .catch((error) => { if (active) setJira({ error: error.message, credentials: { connected: false } }); });
    return () => { active = false; };
  }, [data.repository.root, policy?.enabled]);

  useEffect(() => { setHealth(data.workspace ?? null); }, [data.workspace]);

  async function chooseBase() {
    const result = await action(() => window.singularity.chooseWorkspaceBase());
    if (result) { setBaseDirectory(result); setPreview(null); }
  }

  async function loadProjects(refresh = false) {
    const result = await action(() => window.singularity.jiraProjects(data.repository.root, '', refresh), refresh ? 'Jira projects refreshed' : null);
    if (!result) return;
    setProjects(result);
    const next = projectKey || policy.projectKey || result[0]?.key || '';
    setProjectKey(next);
    if (next) await loadAnchors(next, refresh);
  }

  async function loadAnchors(key, refresh = false) {
    setProjectKey(key);
    setAnchorKey('');
    setHierarchy(null);
    setPreview(null);
    const result = await action(() => window.singularity.jiraWorkspaceAnchors(data.repository.root, key, refresh));
    if (result) setAnchors(result);
  }

  async function selectAnchor(key) {
    setAnchorKey(key);
    setPreview(null);
    setConfirmation('');
    if (!key) return setHierarchy(null);
    const result = await action(() => window.singularity.jiraHierarchy(data.repository.root, key));
    if (result) setHierarchy(result);
  }

  function selectedIds() {
    return Object.entries(selectedRepositories).filter(([, selected]) => selected).map(([id]) => id);
  }

  async function buildPreview() {
    const result = await action(() => window.singularity.previewWorkspace(data.repository.root, {
      baseDirectory,
      anchorKey,
      leadRepository,
      repositoryIds: selectedIds()
    }));
    if (result) setPreview(result);
  }

  async function create() {
    const result = await action(() => window.singularity.createWorkspace(data.repository.root, {
      baseDirectory,
      anchorKey,
      leadRepository,
      repositoryIds: selectedIds(),
      confirmation
    }), `Workspace ${anchorKey} created with isolated repository clones`);
    if (result) onOpened(result, 'workspaces');
  }

  async function refreshHealth() {
    if (!health?.workspace?.path) return;
    const result = await action(() => window.singularity.workspaceStatus(health.workspace.path), 'Workspace health refreshed');
    if (result) setHealth(result);
  }

  async function sync() {
    const result = await action(() => window.singularity.syncWorkspace(health.workspace.path), 'Workspace remotes fetched; no branch was changed');
    if (result) setHealth(result.status);
  }

  async function repair() {
    const result = await action(() => window.singularity.repairWorkspace(health.workspace.path), 'Missing workspace clones repaired');
    if (result) setHealth(result.status);
  }

  async function stageDocuments() {
    const result = await action(() => window.singularity.stageWorkspaceDocuments(health.workspace.path));
    if (result && !result.canceled) {
      const refreshed = await window.singularity.workspaceStatus(health.workspace.path);
      setHealth(refreshed);
    }
  }

  async function promoteDocument(document) {
    const workId = data.workflow?.workItem?.id;
    const result = await action(() => window.singularity.promoteWorkspaceDocument(
      data.repository.root,
      health.workspace.path,
      document.path,
      workId
    ), `${document.name} imported, committed, and pushed for ${workId}`);
    if (result?.snapshot) onOpened(result.snapshot, 'workspaces');
  }

  const canPromoteDocuments = Boolean(
    data.workflow?.workItem?.id
    && data.repository.branch === data.workflow.workItem.branch
    && data.session?.workId === data.workflow.workItem.id
  );
  const credentialReady = jira?.credentials?.connected;
  return <div className="page workspace-page">
    <header className="page-heading row-between"><div><span className="eyebrow">Local isolation · Jira identity · Git authority</span><h1>Project workspaces</h1><p>A workspace keeps repository clones, staged documents, caches, and Copilot context separate. It creates no additional Jira or SDLC hierarchy.</p></div>{health && <Pill tone={health.healthy ? 'good' : 'warn'}>{health.healthy ? 'Workspace healthy' : 'Needs attention'}</Pill>}</header>

    {health && <section className="workspace-current panel">
      <header className="workspace-current-head"><div><span className="workspace-anchor-type">{health.workspace.anchor.issueTypeName}</span><h2>{health.workspace.anchor.key} · {health.workspace.anchor.title}</h2><p>{health.workspace.path}</p></div><div className="workspace-actions"><button className="ghost" onClick={refreshHealth}>Refresh health</button><button className="secondary" onClick={sync}>Fetch remotes</button><button className="secondary" onClick={stageDocuments}>Stage documents</button>{!health.healthy && <button className="primary" onClick={repair}>Repair missing clones</button>}</div></header>
      <div className="workspace-health-grid">
        <div><span>Repositories</span><strong>{health.counts.ready}/{health.counts.repositories}</strong><small>ready</small></div>
        <div><span>Dirty clones</span><strong>{health.counts.dirty}</strong><small>never auto-updated</small></div>
        <div><span>Staged documents</span><strong>{health.counts.stagedDocuments}</strong><small>not governed</small></div>
        <div><span>Lead repository</span><strong>{health.workspace.leadRepository}</strong><small>{health.leadRepositoryPath}</small></div>
      </div>
      <div className="workspace-repository-list">{health.repositories.map((repository) => <div key={repository.id}><span className={`workspace-state ${repository.state}`} /><div><strong>{repository.metadata?.name ?? repository.id}</strong><small>{repository.metadata?.appId ? `${repository.metadata.appId} · ${repository.id} · ` : `${repository.id} · `}{repository.absolutePath}</small></div><Pill tone={repository.role === 'lead' ? 'accent' : 'neutral'}>{repository.role}</Pill><span>{repository.branch ?? 'not cloned'}</span><span className={repository.dirty ? 'warning-copy' : ''}>{repository.dirty == null ? '—' : repository.dirty ? 'dirty' : 'clean'}</span><Pill tone={repository.state === 'ready' ? 'good' : 'warn'}>{repository.state}</Pill></div>)}</div>
      {!!health.stagedDocuments.length && <div className="workspace-staged"><header><div><span className="eyebrow">Local document inbox</span><h3>Staged — not governed</h3><p>{canPromoteDocuments ? `Import into checked-out work item ${data.workflow.workItem.id} to commit and push a governed copy.` : 'Resume a work item and select a session persona before importing these files.'}</p></div><Pill tone="warn">{health.stagedDocuments.length} local</Pill></header>{health.stagedDocuments.map((document) => <div key={document.path}><strong>{document.name}</strong><code>{document.sha256.slice(0, 12)}</code><span>{document.bytes.toLocaleString()} bytes</span><button className="secondary compact" disabled={!canPromoteDocuments} onClick={() => promoteDocument(document)}>Import to work item</button></div>)}</div>}
    </section>}

    <section className="workspace-create panel">
      <header className="panel-heading"><div><span className="eyebrow">Create from existing Jira hierarchy</span><h2>New isolated workspace</h2></div><Pill>Epic or higher</Pill></header>
      {!data.portfolio && <Empty title="Configure the portfolio first" detail="The lead repository must define repository URLs and Jira policy before a workspace can clone governed project repositories." />}
      {data.portfolio && !policy?.enabled && <Empty title="Enable Jira in portfolio configuration" detail="Workspace creation follows Jira hierarchy and therefore requires an enabled Jira policy. Existing repository-open behavior remains available." action={<button className="primary" onClick={onConfigureJira}>Configure Jira</button>} />}
      {data.portfolio && policy?.enabled && !credentialReady && <div className="workspace-prerequisite"><div><strong>Connect Jira before choosing the anchor</strong><span>{jira?.error ?? 'Credentials remain encrypted in the operating-system account and never enter workspace.json.'}</span></div><button className="primary" onClick={onConfigureJira}>Open Jira connection</button></div>}
      {data.portfolio && policy?.enabled && credentialReady && <div className="workspace-wizard">
        <div className="workspace-step"><span>1</span><div><strong>Storage</strong><small>Choose a corporate-approved local directory.</small></div><button className="secondary" onClick={chooseBase}>{baseDirectory ? 'Change folder' : 'Choose folder'}</button>{baseDirectory && <code>{baseDirectory}</code>}</div>
        <div className="workspace-step"><span>2</span><div><strong>Jira anchor</strong><small>Issue types and levels come from Jira configuration.</small></div>{!projects.length ? <button className="secondary" onClick={() => loadProjects()}>Load projects</button> : <><select value={projectKey} onChange={(event) => loadAnchors(event.target.value)}><option value="">Project…</option>{projects.map((project) => <option key={project.key} value={project.key}>{project.key} · {project.name}</option>)}</select><select value={anchorKey} onChange={(event) => selectAnchor(event.target.value)}><option value="">Epic or higher…</option>{anchors.map((anchor) => <option key={anchor.key} value={anchor.key}>{anchor.key} · {anchor.issueType} · {anchor.title}</option>)}</select></>}</div>
        {hierarchy && <div className="workspace-hierarchy"><div className="workspace-breadcrumb">{[...hierarchy.ancestors, hierarchy.anchor].map((item, index) => <React.Fragment key={item.key}><span><small>{item.issueType}</small><strong>{item.key}</strong></span>{index < hierarchy.ancestors.length && <b>›</b>}</React.Fragment>)}</div><p>{hierarchy.descendants.length} descendant Jira item{hierarchy.descendants.length === 1 ? '' : 's'} will be visible for planning. The anchor remains {hierarchy.anchor.issueType}; no synthetic parent is created.</p></div>}
        <div className="workspace-step repository-selection"><span>3</span><div><strong>Repository isolation</strong><small>Every selected repository receives a separate clone.</small></div><label><small>Lead repository</small><select value={leadRepository} onChange={(event) => { setLeadRepository(event.target.value); setSelectedRepositories((current) => ({ ...current, [event.target.value]: true })); setPreview(null); }}>{repositoryChoices.map((id) => <option key={id} value={id}>{id}</option>)}</select></label><div className="workspace-repository-choices">{repositoryChoices.map((id) => <label key={id}><input type="checkbox" checked={selectedRepositories[id] !== false || id === leadRepository} disabled={id === leadRepository} onChange={(event) => { setSelectedRepositories((current) => ({ ...current, [id]: event.target.checked })); setPreview(null); }} /><span>{id}</span></label>)}</div></div>
        <div className="workspace-preview-actions"><button className="secondary" disabled={!baseDirectory || !anchorKey || !leadRepository} onClick={buildPreview}>Preview clone plan</button>{preview && <><code>{preview.root}</code><input value={confirmation} onChange={(event) => setConfirmation(event.target.value.toUpperCase())} placeholder={`Type ${anchorKey}`} /><button className="primary" disabled={confirmation !== anchorKey} onClick={create}>Create workspace</button></>}</div>
        {preview && <div className="workspace-operation-list">{preview.operations.map((operation) => <div key={operation.repository}><Pill tone={operation.repository === leadRepository ? 'accent' : 'neutral'}>{operation.repository === leadRepository ? 'lead' : 'clone'}</Pill><strong>{operation.repository}</strong><code>{operation.url}</code><span>{operation.target}</span></div>)}</div>}
      </div>}
    </section>
  </div>;
}

function JiraWorkspace({ data, action, reload, onConfigure, bootstrapPortfolio }) {
  const policy = data.portfolio?.jira;
  const repositoryIds = Object.keys(data.portfolio?.repositories ?? {});
  const [status, setStatus] = useState(null);
  const [connection, setConnection] = useState({
    name: policy?.connection ?? 'corporate-jira',
    deployment: policy?.deployment ?? 'cloud',
    baseUrl: '',
    email: '',
    token: '',
    authMode: policy?.deployment === 'data-center' ? 'pat' : 'user-token'
  });
  const [projects, setProjects] = useState([]);
  const [projectKey, setProjectKey] = useState(policy?.projectKey ?? '');
  const [epics, setEpics] = useState([]);
  const [selectedEpic, setSelectedEpic] = useState(null);
  const [stories, setStories] = useState([]);
  const [repositoryMap, setRepositoryMap] = useState({});
  const [initiativeId, setInitiativeId] = useState(data.selectedInitiativeId ?? data.initiatives?.[0]?.id ?? '');
  const [adoption, setAdoption] = useState(null);
  const [writePlan, setWritePlan] = useState(null);
  const [applyConfirmation, setApplyConfirmation] = useState('');

  useEffect(() => {
    let current = true;
    if (!policy?.enabled) return undefined;
    window.singularity.jiraStatus(data.repository.root)
      .then((result) => { if (current) setStatus(result); })
      .catch((error) => { if (current) setStatus({ error: error.message, credentials: { connected: false } }); });
    return () => { current = false; };
  }, [data.repository.root, policy?.enabled]);

  useEffect(() => {
    setInitiativeId(data.selectedInitiativeId ?? data.initiatives?.[0]?.id ?? '');
  }, [data.selectedInitiativeId, data.initiatives]);

  async function loadProjects(refresh = false) {
    const result = await action(() => window.singularity.jiraProjects(data.repository.root, '', refresh), refresh ? 'Jira projects refreshed' : null);
    if (!result) return;
    setProjects(result);
    const next = projectKey || policy.projectKey || result[0]?.key || '';
    setProjectKey(next);
    if (next) await loadEpics(next, refresh);
  }

  async function connect() {
    const result = await action(() => window.singularity.connectJira(data.repository.root, {
      name: connection.name,
      deployment: connection.deployment,
      baseUrl: connection.baseUrl,
      authMode: connection.authMode,
      email: connection.authMode === 'pat' ? null : connection.email,
      token: connection.token
    }), 'Jira connection verified and stored securely');
    if (!result) return;
    setConnection((current) => ({ ...current, token: '' }));
    setStatus({ policy, credentials: { connected: true, active: result.active, connection: result.connection } });
    setProjects(result.discovery.projects ?? []);
    const next = projectKey || policy.projectKey || result.discovery.projects?.[0]?.key || '';
    setProjectKey(next);
    if (next) await loadEpics(next, true);
  }

  async function disconnect() {
    const result = await action(() => window.singularity.disconnectJira(data.repository.root, status?.credentials?.selected), 'Jira credentials removed from this OS account');
    if (result) {
      setStatus({ policy, credentials: result });
      setProjects([]); setEpics([]); setStories([]); setSelectedEpic(null);
    }
  }

  async function resetCredentials() {
    const result = await action(
      () => window.singularity.resetJiraCredentials(data.repository.root),
      'Unreadable Jira credentials removed; reconnect when ready'
    );
    if (result) {
      setStatus({ policy, credentials: result });
      setProjects([]); setEpics([]); setStories([]); setSelectedEpic(null);
    }
  }

  async function loadEpics(key = projectKey, refresh = false) {
    if (!key) return;
    const result = await action(() => window.singularity.jiraEpics(data.repository.root, key, refresh), refresh ? `${key} refreshed` : null);
    if (result) { setProjectKey(key); setEpics(result); setSelectedEpic(null); setStories([]); setAdoption(null); }
  }

  async function chooseEpic(epic) {
    setSelectedEpic(epic);
    setAdoption(null); setWritePlan(null);
    const result = await action(() => window.singularity.jiraChildren(data.repository.root, epic.key));
    if (!result) return;
    setStories(result);
    const fallback = repositoryIds.length === 1 ? repositoryIds[0] : '';
    setRepositoryMap(Object.fromEntries(result.map((story) => [story.key, fallback])));
  }

  async function previewAdoption() {
    if (!initiativeId || !selectedEpic) return;
    const result = await action(() => window.singularity.previewJiraAdoption(data.repository.root, initiativeId, selectedEpic.key, repositoryMap));
    if (result) setAdoption(result);
  }

  async function adopt() {
    const result = await action(() => window.singularity.adoptJiraEpic(data.repository.root, initiativeId, selectedEpic.key, repositoryMap), `${selectedEpic.key} adopted and pushed`);
    if (!result) return;
    setAdoption(result);
    await reload(null, initiativeId);
  }

  async function planWrites() {
    const result = await action(() => window.singularity.createJiraWritePlan(data.repository.root, initiativeId), 'Jira write plan committed and pushed');
    if (result) setWritePlan(result.plan);
  }

  async function applyWrites() {
    if (!writePlan || applyConfirmation !== initiativeId) return;
    const result = await action(() => window.singularity.applyJiraWritePlan(data.repository.root, initiativeId, writePlan.sha256, applyConfirmation), 'Jira write plan applied and receipts pushed');
    if (!result) return;
    setWritePlan(result.plan);
    setApplyConfirmation('');
    await reload(null, initiativeId);
    if (selectedEpic) await chooseEpic(selectedEpic);
  }

  if (!data.portfolio) return <div className="page"><PortfolioSetup data={data} action={action} onCreated={bootstrapPortfolio} jiraFirst /></div>;
  if (!policy?.enabled) return <div className="page jira-page"><header className="page-heading"><span className="eyebrow">Corporate integration</span><h1>Jira workspace</h1><p>Browse existing Epics, adopt their stories into Git-native initiative planning, and apply only reviewed write plans.</p></header><section className="panel jira-disabled"><span className="jira-mark">J</span><div><h2>Jira is disabled by repository policy</h2><p>Set <code>jira.enabled: true</code> in <code>singularity/portfolio.yml</code>, choose Cloud or Data Center, and define allowed hosts, projects, authentication modes, and write policy.</p><button className="primary compact" onClick={onConfigure}>Configure Jira policy</button></div></section></div>;

  const connected = status?.credentials?.connected;
  return <div className="page jira-page">
    <header className="page-heading row-between"><div><span className="eyebrow">Secure corporate integration</span><h1>Jira workspace</h1><p>Credentials stay in the operating-system keychain. Every import is hash-snapshotted; every write is previewed, confirmed, committed, and receipted.</p></div><div className="row gap"><button className="ghost compact" onClick={onConfigure}>Policy YAML</button>{connected && <><Pill tone="good">Connected</Pill><button className="secondary compact" onClick={() => loadProjects(true)}>↻ Refresh</button><button className="ghost compact" onClick={disconnect}>Disconnect</button></>}</div></header>
    {!connected ? status?.credentials?.recovery?.required ? <section className="jira-credential-recovery panel" role="alert">
      <span className="jira-mark">!</span>
      <div><span className="eyebrow">Local credential recovery</span><h2>Jira credentials cannot be read</h2><p>{status.credentials.recovery.message}</p><p>Reset removes only the unreadable encrypted Jira file from this operating-system account. Repository configuration and Git state are unchanged.</p></div>
      <button className="primary" onClick={resetCredentials}>Reset Jira credentials</button>
      </section> : <section className="jira-connect panel"><div className="jira-connect-copy"><span className="jira-mark">J</span><span className="eyebrow">One-time setup</span><h2>Connect your Jira account</h2><p>{policy.deployment === 'cloud' ? 'Use an Atlassian API token. The renderer never receives it again after this form is submitted.' : 'Use a Jira Data Center personal access token. Password authentication is not supported.'}</p><ul><li>HTTPS and repository host allowlists are enforced.</li><li>Permissions are discovered before writes.</li><li>Tokens never enter Git, CLI child environments, logs, or planning prompts.</li></ul></div><div className="jira-connect-form"><label><span>Connection name · repository policy</span><input value={connection.name} readOnly /></label><label><span>Deployment</span><select value={connection.deployment} onChange={(event) => { const deployment = event.target.value; setConnection({ ...connection, deployment, authMode: deployment === 'data-center' ? 'pat' : 'user-token' }); }}><option value="cloud">Jira Cloud</option><option value="data-center">Jira Data Center</option></select></label><label className="full"><span>Jira HTTPS URL</span><input placeholder="https://company.atlassian.net" value={connection.baseUrl} onChange={(event) => setConnection({ ...connection, baseUrl: event.target.value })} /></label>{connection.authMode !== 'pat' && <label className="full"><span>Account email</span><input type="email" autoComplete="username" value={connection.email} onChange={(event) => setConnection({ ...connection, email: event.target.value })} /></label>}<label><span>Authentication</span><select value={connection.authMode} onChange={(event) => setConnection({ ...connection, authMode: event.target.value })}>{connection.deployment === 'cloud' ? <><option value="user-token">User API token</option><option value="service-account">Service account token</option></> : <option value="pat">Personal access token</option>}</select></label><label><span>{connection.authMode === 'pat' ? 'PAT' : 'API token'}</span><input type="password" autoComplete="current-password" value={connection.token} onChange={(event) => setConnection({ ...connection, token: event.target.value })} /></label><button className="primary full" disabled={!connection.baseUrl || !connection.token || (connection.authMode !== 'pat' && !connection.email)} onClick={connect}>Test connection & save securely</button>{status?.error && <p className="warning-copy full">{status.error}</p>}</div></section> : <>
      <section className="jira-context-strip"><div><span>Connection</span><strong>{status.credentials.connection?.name}</strong><small>{status.credentials.connection?.baseUrl}</small></div><div><span>Account</span><strong>{status.credentials.connection?.account?.displayName ?? status.credentials.connection?.email}</strong><small>{status.credentials.connection?.authMode}</small></div><div><span>Policy</span><strong>{policy.writeMode} writes</strong><small>{policy.allowedProjects?.length ? `${policy.allowedProjects.length} allowed projects` : 'all visible projects'}</small></div><div><span>Cache</span><strong>{policy.read.cacheMinutes} minutes</strong><small>manual refresh available</small></div></section>
      <div className="jira-browser">
        <aside className="jira-projects panel"><header><span className="eyebrow">Scope</span><h2>Projects</h2></header>{!projects.length && <button className="primary" onClick={() => loadProjects()}>Load permitted projects</button>}{projects.map((project) => <button className={project.key === projectKey ? 'active' : ''} key={project.key} onClick={() => loadEpics(project.key)}><span>{project.key.slice(0, 2)}</span><div><strong>{project.name}</strong><small>{project.key} · {project.projectType ?? 'software'}</small></div></button>)}</aside>
        <section className="jira-epics panel"><header className="panel-heading"><div><span className="eyebrow">Existing Jira hierarchy</span><h2>{projectKey ? `${projectKey} Epics` : 'Choose a project'}</h2></div><span>{epics.length} visible</span></header>{!epics.length && projectKey && <div className="inline-empty">No Epics loaded. Refresh the project to query Jira.</div>}{epics.map((epic) => <button className={selectedEpic?.key === epic.key ? 'active' : ''} key={epic.key} onClick={() => chooseEpic(epic)}><StatusDot status={epic.statusCategory === 'Done' ? 'approved' : 'in_progress'} /><div><strong>{epic.key} — {epic.title}</strong><small>{epic.status ?? 'unknown status'} · updated {formatRecentTime(epic.updatedAt)}</small></div><span>→</span></button>)}</section>
        <aside className="jira-story-panel panel">{selectedEpic ? <><header><span className="eyebrow">Epic children</span><h2>{selectedEpic.key}</h2><p>{selectedEpic.title}</p></header><div className="jira-story-list">{stories.map((story) => <div key={story.key}><div><strong>{story.key}</strong><span>{story.title}</span><small>{story.issueType} · {story.status ?? 'unknown'}</small></div><label><span>Owning repository</span><select value={repositoryMap[story.key] ?? ''} onChange={(event) => setRepositoryMap({ ...repositoryMap, [story.key]: event.target.value })}><option value="">Choose repository…</option>{repositoryIds.map((id) => <option value={id} key={id}>{id}</option>)}</select></label></div>)}</div><label><span>Target Singularity initiative</span><select value={initiativeId} onChange={(event) => { setInitiativeId(event.target.value); setAdoption(null); }}><option value="">Choose initiative…</option>{data.initiatives.map((initiative) => <option value={initiative.id} key={initiative.id}>{initiative.id} — {initiative.title}</option>)}</select></label><div className="jira-actions"><button className="secondary" disabled={!initiativeId || stories.some((story) => !repositoryMap[story.key])} onClick={previewAdoption}>Preview adoption</button><button className="primary" disabled={!adoption?.ready} onClick={adopt}>Adopt into Git</button></div>{adoption && <div className={`jira-adoption ${adoption.ready ? 'ready' : 'warn'}`}><strong>{adoption.ready ? 'Ready to adopt' : 'Mapping incomplete'}</strong><span>{adoption.draft?.epics?.[0]?.stories?.length ?? adoption.breakdown?.stories?.length} stories · source {adoption.sourceSha256?.slice(0, 12)}</span>{adoption.unresolved?.length > 0 && <small>Map: {adoption.unresolved.map((item) => item.jiraKey).join(', ')}</small>}</div>}</> : <Empty title="Choose an Epic" detail="Its child stories, Jira status, and repository ownership controls will appear here." />}</aside>
      </div>
      {initiativeId && <section className="panel jira-write-plan"><header className="panel-heading"><div><span className="eyebrow">Governed outbound synchronization</span><h2>Jira write plan</h2></div><Pill tone={policy.writeMode === 'approved' ? 'warn' : 'neutral'}>{policy.writeMode}</Pill></header><p>Generate a hash-pinned diff from the approved Singularity story plan. No Jira mutation occurs until the plan phase is approved and the exact initiative ID and plan hash are confirmed.</p><div className="jira-plan-actions"><button className="secondary" disabled={policy.writeMode === 'off'} onClick={planWrites}>Generate & commit plan</button>{writePlan && <><code>{writePlan.sha256}</code><input aria-label="Exact initiative confirmation" placeholder={`Type ${initiativeId}`} value={applyConfirmation} onChange={(event) => setApplyConfirmation(event.target.value)} /><button className="primary" disabled={policy.writeMode !== 'approved' || applyConfirmation !== initiativeId} onClick={applyWrites}>Apply reviewed plan</button></>}</div>{writePlan && <div className="jira-operation-list">{writePlan.operations.map((operation) => <div key={operation.id}><Pill tone={operation.action.startsWith('create') ? 'accent' : 'warn'}>{operation.action}</Pill><strong>{operation.subject.jiraKey ?? operation.subject.id}</strong><span>{Object.keys(operation.fields ?? operation.issue ?? {}).join(', ')}</span></div>)}</div>}</section>}
    </>}
  </div>;
}

function Dashboard({ data }) {
  const p = data.progress;
  if (!data.workflow) return <Empty title="No work item selected" detail="Choose a work item above to see progress, approvals, usage, and supporting evidence." />;
  const current = data.workflow.phases[data.workflow.currentPhase];
  const simulation = data.workflowSimulations?.find((item) => item.id === data.workflow.workItem.workType);
  return <div className="page dashboard-page">
    <div className="hero-card">
      <div><div className="row gap"><Pill tone="accent">{data.workflow.workItem.workTypeLabel}</Pill><Pill>{data.workflow.status}</Pill></div><h1>{data.workflow.workItem.title}</h1><p className="muted">{data.workflow.workItem.id} · branch {data.workflow.workItem.branch}</p></div>
      <ProgressRing value={p.percentage} />
    </div>
    <div className="metrics">
      <div className="metric"><span>Current phase</span><strong>{current?.label ?? 'Complete'}</strong><small>{p.currentPosition} of {p.totalPhases}</small></div>
      <div className="metric"><span>Total elapsed</span><strong>{formatDuration(data.report?.elapsedMs)}</strong><small>{data.report?.completedAt ? 'workflow complete' : 'wall-clock so far'}</small></div>
      <div className="metric"><span>Approvals</span><strong>{p.approvedPhases}</strong><small>approved phases</small></div>
      <div className="metric"><span>Documents</span><strong>{p.documents}</strong><small>evidence items</small></div>
      <div className="metric"><span>Token usage</span><strong>{p.tokens.totalTokens || '—'}</strong><small>{p.tokens.totalTokens ? 'exact tokens' : 'unavailable'}</small></div>
    </div>
    {data.report && <WorkflowTiming report={data.report} />}
    {data.report && <CostDashboard report={data.report} pricing={data.definition.tokens?.pricing} telemetry={data.telemetry} />}
    {!!data.workflow.sequenceOverrides?.length && <div className="notice">⚠ {data.workflow.sequenceOverrides.length} confirmed soft sequence override(s) are recorded. Review the work-item report before final approval.</div>}
    {data.diagnostics && <section className={`health-strip ${data.diagnostics.healthy ? 'good' : 'warn'}`}><strong>{data.diagnostics.healthy ? 'Repository ready' : 'Setup needs attention'}</strong><span>{data.diagnostics.counts.pass} checks passed · {data.diagnostics.counts.warn} warnings · {data.diagnostics.counts.fail} failures</span></section>}
    <section className="panel"><header className="panel-heading"><div><span className="eyebrow">Lifecycle</span><h2>Phase progress</h2></div></header><div className="phase-list">
      {p.phases.map((phase) => { const timing = data.report?.phases.find((item) => item.id === phase.id); return <div className={`phase-row ${phase.id === p.currentPhase ? 'active' : ''}`} key={phase.id}><StatusDot status={phase.status} /><div className="phase-copy"><strong>{phase.label}</strong><span>{phase.id}</span></div><Pill>{phase.generation ? `Generation ${phase.generation}` : 'Not generated'}</Pill><span className="approval-count">{phase.approvals}/{phase.approvalsRequired} approvals</span><span className="phase-time">{formatDuration(timing?.elapsedMs)}</span><span className="phase-status">{phase.status.replaceAll('_', ' ')}</span></div>; })}
    </div></section>
    {simulation && <section className="panel contract-preview"><header className="panel-heading"><div><span className="eyebrow">Resolved preflight</span><h2>Workflow contract preview</h2></div><Pill>{simulation.inputsMode} inputs</Pill></header><div className="contract-grid">{simulation.phases.map((phase) => <div key={phase.id}><strong>{phase.label}</strong><code>{phase.template}</code><span>{phase.inputs.length ? `← ${phase.inputs.join(', ')}` : 'No phase inputs'} · {phase.minimumApprovals} approval(s)</span></div>)}</div></section>}
  </div>;
}

function ApprovalInbox({ data, busy, refresh, attach }) {
  const inbox = data.approvalInbox;
  const items = inbox?.items ?? [];
  return <div className="page inbox-page">
    <header className="page-heading row-between"><div><span className="eyebrow">Remote reviewer queue</span><h1>Pending approvals</h1><p>Committed work-item branches awaiting a governed decision, ordered by waiting time.</p></div><button className="secondary" onClick={refresh} disabled={busy}>↻ Fetch remote inbox</button></header>
    <div className="metrics inbox-metrics"><div className="metric"><span>Awaiting review</span><strong>{items.length}</strong><small>committed phases</small></div><div className="metric"><span>Remote</span><strong>{inbox?.remote ?? 'origin'}</strong><small>{inbox?.fetched ? 'freshly fetched' : 'fetch required'}</small></div><div className="metric"><span>Oldest wait</span><strong>{items[0]?.waiting ?? '—'}</strong><small>{items[0]?.id ?? 'nothing pending'}</small></div></div>
    {!items.length ? <Empty title="Inbox clear" detail="No committed remote work-item phase is awaiting approval. Fetch the remote inbox to check for new submissions." /> : <section className="panel inbox-panel"><div className="inbox-header"><span>Work item</span><span>Phase</span><span>Approvals</span><span>Waiting</span><span>Review personas</span><span /></div>{items.map((item) => <div className="inbox-row" key={`${item.id}:${item.phase}:${item.commit}`}><div><StatusDot status={item.status} /><span><strong>{item.id} — {item.title}</strong><small>{item.artifact ?? 'No required artifact'} · {item.commit?.slice(0, 8)}</small></span></div><span>{item.phaseLabel}<small>generation {item.generation}</small></span><span>{item.approvalsReceived}/{item.approvalsRequired}{item.selfApprovalWarning && <small className="warning-copy">self-approval</small>}</span><span>{item.waiting}</span><span>{item.reviewerPersonas.join(', ') || 'Any configured persona'}</span><button className="secondary compact" onClick={() => attach(item.id)} disabled={busy}>Open review</button></div>)}</section>}
  </div>;
}

function PlanningStudio({ data, action, reload, openPlanningPrompt, profileRole = null }) {
  const groups = data.planning?.targets ?? [];
  const defaultGroup = groups.find((item) => item.scope === 'initiative') ?? groups[0] ?? null;
  const [groupKey, setGroupKey] = useState(defaultGroup ? `${defaultGroup.scope}:${defaultGroup.id}` : '');
  const [phaseId, setPhaseId] = useState(defaultGroup?.currentPhase ?? '');
  const initialPhase = defaultGroup?.phases.find((phase) => phase.id === defaultGroup.currentPhase);
  const [targetId, setTargetId] = useState(initialPhase?.targets[0]?.id ?? '');
  const [persona, setPersona] = useState(data.session?.persona && data.definition.personas[data.session.persona]
    ? data.session.persona
    : preferredPersonaForRole(profileRole, data.definition.personas));
  const [objective, setObjective] = useState('');
  const [model, setModel] = useState('');
  const [preflight, setPreflight] = useState(null);
  const [contextPack, setContextPack] = useState(null);
  const [messages, setMessages] = useState([]);
  const [plan, setPlan] = useState('');
  const [followup, setFollowup] = useState('');
  const [running, setRunning] = useState(false);
  const [started, setStarted] = useState(false);
  const [reviewed, setReviewed] = useState(false);
  const [usage, setUsage] = useState(null);
  const [questions, setQuestions] = useState([]);
  const [logs, setLogs] = useState([]);
  const [activity, setActivity] = useState('Build a governed context pack to begin.');
  const transcriptRef = useRef('');
  const planRef = useRef('');
  const questionsRef = useRef([]);
  const group = groups.find((item) => `${item.scope}:${item.id}` === groupKey) ?? defaultGroup;
  const phase = group?.phases.find((item) => item.id === phaseId) ?? group?.phases.find((item) => item.current) ?? null;
  const target = phase?.targets.find((item) => item.id === targetId) ?? phase?.targets[0] ?? null;
  const currentReady = Boolean(group && phase?.current && phase.status === 'in_progress' && target);
  const storyPlanAnalysis = useMemo(
    () => target?.id === 'story-plan' && plan.trim() ? parseStoryPlan(plan) : null,
    [target?.id, plan]
  );

  useEffect(() => {
    let active = true;
    window.singularity.planningPreflight(data.repository.root)
      .then((result) => { if (active) setPreflight(result); })
      .catch((error) => { if (active) setPreflight({ ready: false, message: error.message }); });
    return () => { active = false; };
  }, [data.repository.root]);

  useEffect(() => {
    const available = data.planning?.targets ?? [];
    const selected = available.find((item) => `${item.scope}:${item.id}` === groupKey)
      ?? available.find((item) => item.scope === 'initiative')
      ?? available[0];
    if (!selected) return;
    if (`${selected.scope}:${selected.id}` !== groupKey) setGroupKey(`${selected.scope}:${selected.id}`);
    const selectedPhase = selected.phases.find((item) => item.id === selected.currentPhase) ?? selected.phases[0];
    setPhaseId(selectedPhase?.id ?? '');
    setTargetId(selectedPhase?.targets[0]?.id ?? '');
    setContextPack(null);
    setStarted(false);
  }, [data.selectedWorkId, data.selectedInitiativeId]);

  useEffect(() => {
    if (!window.singularity.onPlanningEvent) return undefined;
    return window.singularity.onPlanningEvent((event) => {
      if (!contextPack || event.planningSessionId !== contextPack.sessionId) return;
      if (!['agent_message_chunk', 'user_message_chunk', 'plan', 'plan_update'].includes(event.type)) {
        const entry = planningLogEntry(event);
        setLogs((current) => {
          const last = current.at(-1);
          if (last?.type === entry.type && ['agent_thought_chunk', 'tool_call_update', 'diagnostic'].includes(entry.type)) {
            return [...current.slice(0, -1), { ...last, detail: `${last.detail}${entry.detail}`.slice(-4000), at: entry.at }];
          }
          return [...current.slice(-299), entry];
        });
      }
      if (event.type === 'ready') {
        setStarted(true);
        setRunning(true);
        setActivity(`Copilot ${event.version ?? ''} connected in native Plan mode.`);
      } else if (event.type === 'turn-started') {
        setRunning(true);
        setActivity('Copilot is inspecting governed phase context…');
      } else if (event.type === 'agent_message_chunk' && event.text) {
        transcriptRef.current += event.text;
        setMessages((current) => {
          const last = current.at(-1);
          if (last?.role === 'assistant' && last.id === (event.messageId ?? 'assistant')) {
            return [...current.slice(0, -1), { ...last, text: `${last.text}${event.text}` }];
          }
          return [...current, { role: 'assistant', id: event.messageId ?? `assistant-${current.length}`, text: event.text }];
        });
      } else if (event.type === 'user_message_chunk' && event.text) {
        setMessages((current) => [...current, { role: 'user', id: event.messageId ?? `user-${current.length}`, text: event.text }]);
      } else if (event.type === 'question') {
        const question = {
          id: event.questionId,
          native: true,
          message: event.message,
          schema: event.schema,
          status: 'pending'
        };
        questionsRef.current = [...questionsRef.current, question];
        setQuestions(questionsRef.current);
        setActivity('Copilot needs your decision before it can finish the plan.');
      } else if (event.type === 'question-answered') {
        questionsRef.current = questionsRef.current.map((question) => question.id === event.questionId ? { ...question, status: event.action } : question);
        setQuestions(questionsRef.current);
      } else if ((event.type === 'plan' || event.type === 'plan_update') && event.plan) {
        planRef.current = event.plan;
        setPlan(event.plan);
        setActivity('Copilot produced a structured plan. Review and refine it before promotion.');
      } else if (event.type === 'plan_removed') {
        planRef.current = '';
        setPlan('');
        setReviewed(false);
        setActivity('Copilot withdrew its structured plan; continue the conversation to produce a replacement.');
      } else if (event.type === 'tool_call') {
        setActivity(`${event.title} · ${event.status}`);
      } else if (event.type === 'permission-denied') {
        setActivity(`${event.title} was blocked by Planning Studio read-only policy.`);
      } else if (event.type === 'usage_update') {
        setUsage((current) => ({
          ...(current ?? {}),
          contextTokens: event.usage?.used ?? null,
          contextWindow: event.usage?.size ?? null,
          cost: event.usage?.cost ?? current?.cost ?? null
        }));
      } else if (event.type === 'turn-complete') {
        setRunning(false);
        setUsage((current) => ({ ...(current ?? {}), ...(event.usage ?? {}) }));
        const unansweredNative = questionsRef.current.some((question) => question.native && question.status === 'pending');
        const fallbackQuestions = unansweredNative ? [] : extractCopilotQuestions(transcriptRef.current);
        if (fallbackQuestions.length && !planRef.current.trim()) {
          const existing = new Set(questionsRef.current.map((question) => question.message.toLowerCase()));
          const additions = fallbackQuestions.filter((question) => !existing.has(question.toLowerCase())).map((question, index) => ({
            id: `fallback-${Date.now()}-${index}`,
            native: false,
            message: question,
            schema: { type: 'object', properties: { answer: { type: 'string', title: 'Your answer' } }, required: ['answer'] },
            status: 'pending'
          }));
          questionsRef.current = [...questionsRef.current, ...additions];
          setQuestions(questionsRef.current);
          setActivity('Copilot asked for clarification. Answer here to continue the same planning session.');
        } else if (!planRef.current.trim() && transcriptRef.current.trim()) {
          planRef.current = transcriptRef.current.trim();
          setPlan(planRef.current);
          setActivity(`Planning turn completed: ${event.stopReason}.`);
        } else {
          setActivity(`Planning turn completed: ${event.stopReason}.`);
        }
      } else if (event.type === 'error') {
        setRunning(false);
        setActivity(`Copilot error: ${event.message}`);
      } else if (event.type === 'process-exit' && started) {
        setRunning(false);
        setStarted(false);
      }
    });
  }, [contextPack?.sessionId, started]);

  function resetSession() {
    setContextPack(null);
    setMessages([]);
    setPlan('');
    planRef.current = '';
    transcriptRef.current = '';
    setStarted(false);
    setRunning(false);
    setReviewed(false);
    setUsage(null);
    questionsRef.current = [];
    setQuestions([]);
    setLogs([]);
  }

  function selectGroup(value) {
    const selected = groups.find((item) => `${item.scope}:${item.id}` === value);
    setGroupKey(value);
    const selectedPhase = selected?.phases.find((item) => item.current) ?? selected?.phases[0];
    setPhaseId(selectedPhase?.id ?? '');
    setTargetId(selectedPhase?.targets[0]?.id ?? '');
    resetSession();
  }

  function selectPhase(value) {
    setPhaseId(value);
    const selected = group?.phases.find((item) => item.id === value);
    setTargetId(selected?.targets[0]?.id ?? '');
    resetSession();
  }

  async function buildContext() {
    const result = await action(() => window.singularity.buildPlanningContext(data.repository.root, {
      scope: group.scope,
      id: group.id,
      phase: phase.id,
      persona,
      target: target.id,
      objective
    }), 'Governed planning context built');
    if (!result) return;
    setContextPack(result);
    setMessages([]);
    setPlan('');
    planRef.current = '';
    transcriptRef.current = '';
    setReviewed(false);
    questionsRef.current = [];
    setQuestions([]);
    setLogs([]);
    setActivity(`${result.manifest.sources.length} hashed sources ready for Copilot.`);
  }

  async function startCopilot() {
    setRunning(true);
    const result = await action(() => window.singularity.startPlanningSession(data.repository.root, contextPack.sessionId, model), 'Copilot Plan mode connected');
    if (!result) setRunning(false);
  }

  async function sendFollowup() {
    const text = followup.trim();
    if (!text) return;
    setMessages((current) => [...current, { role: 'user', id: `followup-${Date.now()}`, text }]);
    transcriptRef.current = '';
    setFollowup('');
    setRunning(true);
    const result = await action(() => window.singularity.promptPlanningSession(data.repository.root, contextPack.sessionId, text));
    if (!result) setRunning(false);
  }

  async function answerQuestion(question, values) {
    if (question.native) {
      const result = await action(() => window.singularity.answerPlanningQuestion(
        data.repository.root,
        contextPack.sessionId,
        question.id,
        values,
        'accept'
      ), 'Answer sent to Copilot');
      if (!result) return;
      setMessages((current) => [...current, {
        role: 'user',
        id: `answer-${question.id}`,
        text: `${question.message}\n${Object.entries(values).map(([key, value]) => `${key}: ${Array.isArray(value) ? value.join(', ') : value}`).join('\n')}`
      }]);
      return;
    }
    questionsRef.current = questionsRef.current.map((item) => item.id === question.id ? { ...item, status: 'accept' } : item);
    setQuestions(questionsRef.current);
    const text = `Answer to your clarification question "${question.message}": ${values.answer}. Continue the governed planning analysis and produce the complete configured artifact.`;
    setMessages((current) => [...current, { role: 'user', id: `answer-${question.id}`, text }]);
    transcriptRef.current = '';
    setRunning(true);
    const result = await action(() => window.singularity.promptPlanningSession(data.repository.root, contextPack.sessionId, text));
    if (!result) setRunning(false);
  }

  async function dismissQuestion(question) {
    questionsRef.current = questionsRef.current.map((item) => item.id === question.id ? { ...item, status: 'decline' } : item);
    setQuestions(questionsRef.current);
    if (question.native) {
      await action(() => window.singularity.answerPlanningQuestion(
        data.repository.root,
        contextPack.sessionId,
        question.id,
        null,
        'decline'
      ), 'Question skipped');
      return;
    }
    const text = `I am not providing an answer to "${question.message}". Continue by recording the uncertainty and the safest explicit assumption in the governed plan.`;
    setMessages((current) => [...current, { role: 'user', id: `decline-${question.id}`, text }]);
    transcriptRef.current = '';
    setRunning(true);
    const result = await action(() => window.singularity.promptPlanningSession(data.repository.root, contextPack.sessionId, text));
    if (!result) setRunning(false);
  }

  async function stopCopilot() {
    await action(() => window.singularity.stopPlanningSession(data.repository.root, contextPack.sessionId), 'Planning context released; the Copilot backend remains ready');
    setRunning(false);
    setStarted(false);
  }

  async function promote() {
    const result = await action(
      () => window.singularity.promotePlanningArtifact(data.repository.root, contextPack.sessionId, persona, plan),
      `Reviewed plan promoted to ${target.path}, committed, and pushed`
    );
    if (!result) return;
    setReviewed(false);
    await reload(data.selectedWorkId, data.selectedInitiativeId);
  }

  if (!groups.length) return <div className="page"><Empty title="Select governed work first" detail="Choose a story work item or initiative from the top bar. Planning Studio will then expose its current phase, exact outputs, personas, world model, approved inputs, and repository boundaries." /></div>;
  return <div className="page planning-page">
    <header className="page-heading planning-heading"><div><span className="eyebrow">Copilot-native decision workspace</span><h1>Planning Studio</h1><p>Move from business intent to a reviewable, phase-specific plan without allowing the planning session to mutate source or lifecycle state.</p></div><div className="row"><Pill tone={preflight?.ready ? 'good' : 'warn'}>{preflight?.ready ? 'Copilot Plan mode ready' : 'Copilot setup needed'}</Pill><button className="secondary" onClick={openPlanningPrompt}>Edit planning prompt</button></div></header>
    <section className="planning-safety">
      <span>◈</span><div><strong>Read-only reasoning; explicit Git-backed promotion</strong><p>Copilot receives the selected phase context through ACP in native Plan mode. The chat stays local. Only the reviewed artifact you promote is written, audited, committed, and pushed.</p></div>
    </section>
    <div className="planning-layout">
      <aside className="planning-controls">
        <section className="panel">
          <header className="panel-heading"><div><span className="eyebrow">1 · Frame</span><h2>Planning target</h2></div></header>
          <div className="planning-form">
            <label><span>Work</span><select disabled={started || running} value={groupKey} onChange={(event) => selectGroup(event.target.value)}>{groups.map((item) => <option key={`${item.scope}:${item.id}`} value={`${item.scope}:${item.id}`}>{item.scope === 'initiative' ? 'Initiative' : 'Story'} · {item.id}</option>)}</select></label>
            <label><span>Phase</span><select disabled={started || running} value={phase?.id ?? ''} onChange={(event) => selectPhase(event.target.value)}>{group.phases.map((item) => <option key={item.id} value={item.id}>{item.current ? '● ' : item.status === 'approved' ? '✓ ' : '○ '}{item.label} · {item.status.replaceAll('_', ' ')}</option>)}</select></label>
            <label><span>Promotion target</span><select disabled={started || running} value={target?.id ?? ''} onChange={(event) => { setTargetId(event.target.value); resetSession(); }}>{phase?.targets.map((item) => <option key={item.id} value={item.id}>{item.label} · {item.kind}</option>)}</select></label>
            <label><span>Persona for this plan</span><select disabled={started || running} value={persona} onChange={(event) => { setPersona(event.target.value); resetSession(); }}>{Object.entries(data.definition.personas).map(([id, item]) => <option key={id} value={id}>{item.label} · {id}</option>)}</select></label>
            <label><span>Planning objective</span><textarea disabled={started || running} rows="4" value={objective} onChange={(event) => { setObjective(event.target.value); setContextPack(null); }} placeholder={`What decision must ${phase?.label ?? 'this phase'} make?`} /></label>
            <label><span>Copilot model <em>optional</em></span><input disabled={started || running} value={model} onChange={(event) => setModel(event.target.value)} placeholder="auto" /></label>
            {!phase?.current && <div className="planning-blocker"><strong>Sequence protected</strong><span>The active phase is {group.currentPhase}. Future and approved phases are visible for orientation but cannot start a new plan.</span></div>}
            {phase?.current && phase.status !== 'in_progress' && <div className="planning-blocker"><strong>Phase is {phase.status.replaceAll('_', ' ')}</strong><span>Planning requires an in-progress phase. Complete its current lifecycle action first.</span></div>}
            <button className="primary full" disabled={!currentReady || !preflight?.ready || running} onClick={buildContext}>{contextPack ? 'Rebuild governed context' : 'Build governed context'}</button>
          </div>
        </section>
        <section className="panel planning-phase-map"><header className="panel-heading"><div><span className="eyebrow">Phase map</span><h2>{group.title}</h2></div></header>{group.phases.map((item, index) => <button disabled={started || running} key={item.id} className={`${item.id === phase?.id ? 'active' : ''} ${item.current ? 'current' : ''}`} onClick={() => selectPhase(item.id)}><span>{item.status === 'approved' ? '✓' : item.current ? '●' : index + 1}</span><div><strong>{item.label}</strong><small>{item.targets.length} promotable output{item.targets.length === 1 ? '' : 's'}</small></div></button>)}</section>
      </aside>
      <main className="planning-workbench">
        <section className="panel planning-context">
          <header className="panel-heading"><div><span className="eyebrow">2 · Ground</span><h2>Context manifest</h2></div>{contextPack ? <Pill tone={contextPack.warnings.length ? 'warn' : 'good'}>{contextPack.manifest.sources.length} hashed sources</Pill> : <Pill>not built</Pill>}</header>
          {!contextPack ? <div className="inline-empty">Choose the current phase, persona, output, and objective, then build the context. No content is sent to Copilot before this step.</div> : <>
            <div className="context-kpis"><div><span>Repository head</span><strong>{contextPack.manifest.repository.head.slice(0, 10)}</strong></div><div><span>Context</span><strong>{Math.ceil(contextPack.manifest.context.bytes / 1024)} KB</strong></div><div><span>Generation</span><strong>{contextPack.manifest.generation}</strong></div><div><span>Target</span><strong>{contextPack.target.kind}</strong></div></div>
            {!!contextPack.warnings.length && <div className="planning-warning">{contextPack.warnings.map((warning) => <span key={warning}>⚠ {warning}</span>)}</div>}
            <div className="context-source-list">{contextPack.manifest.sources.map((source, index) => <div key={`${source.kind}:${source.path}:${index}`}><span>{source.kind.replaceAll('-', ' ')}</span><strong title={source.path}>{source.path}</strong><code>{source.sha256?.slice(0, 12) ?? 'unavailable'}</code></div>)}</div>
            <details><summary>Inspect complete prompt sent to Copilot</summary><pre>{contextPack.context}</pre></details>
            <div className="planning-context-actions"><span>{contextPack.target.label} → <code>{contextPack.target.path}</code></span><button className="primary" disabled={running || started} onClick={startCopilot}>Start Copilot Plan mode</button></div>
          </>}
        </section>
        {storyPlanAnalysis && <StoryPlanAnalysis analysis={storyPlanAnalysis} />}
        <div className="planning-dual">
          <section className="panel planning-chat">
            <header className="panel-heading"><div><span className="eyebrow">3 · Explore</span><h2>Copilot conversation</h2></div><Pill tone={running ? 'accent' : started ? 'good' : 'neutral'}>{running ? 'thinking' : started ? 'connected' : 'local'}</Pill></header>
            <div className="planning-activity">{activity}</div>
            {questions.some((question) => question.status === 'pending') && <div className="copilot-question-stack">{questions.filter((question) => question.status === 'pending').map((question) => <CopilotQuestionCard key={question.id} question={question} disabled={!started} onAnswer={answerQuestion} onDismiss={dismissQuestion} />)}</div>}
            <div className="planning-messages">{messages.length ? messages.map((message, index) => <div className={message.role} key={`${message.id}:${index}`}><strong>{message.role === 'user' ? 'You' : 'Copilot'}</strong><pre>{message.text}</pre></div>) : <div className="inline-empty">The phase-aware conversation will appear here. Ask Copilot to challenge assumptions, compare options, or refine the decomposition.</div>}</div>
            <div className="planning-followup"><textarea rows="3" value={followup} onChange={(event) => setFollowup(event.target.value)} disabled={!started || running} placeholder="Challenge the plan, add a constraint, or ask for another option…" /><div><span>{usage?.totalTokens ? `${usage.totalTokens.toLocaleString()} session tokens` : usage?.contextTokens ? `${usage.contextTokens.toLocaleString()} / ${usage.contextWindow?.toLocaleString() ?? '—'} context tokens` : 'Exact usage appears here when ACP exposes it.'}{usage?.cost?.amount != null ? ` · ${usage.cost.currency ?? 'USD'} ${Number(usage.cost.amount).toFixed(4)}` : ''}</span><div className="row"><button className="ghost compact" disabled={!started} onClick={stopCopilot}>Stop</button><button className="secondary compact" disabled={!started || running || !followup.trim()} onClick={sendFollowup}>Send follow-up</button></div></div></div>
          </section>
          <section className="panel planning-review">
            <header className="panel-heading"><div><span className="eyebrow">4 · Govern</span><h2>Reviewed artifact</h2></div><Pill tone={plan.trim() ? 'accent' : 'neutral'}>{target?.kind ?? 'artifact'}</Pill></header>
            <textarea className="planning-editor" value={plan} onChange={(event) => { setPlan(event.target.value); planRef.current = event.target.value; setReviewed(false); }} placeholder="Copilot's proposed artifact will appear here. Edit it until it is ready to become governed repository state." />
            <div className="promotion-check"><label><input type="checkbox" checked={reviewed} onChange={(event) => setReviewed(event.target.checked)} />I reviewed this complete artifact and want to promote it to <code>{target?.path}</code>.</label><small>Promotion does not submit or approve the phase. It creates and pushes an auditable planning commit; the normal phase gate remains next.</small></div>
            <button className="primary full" disabled={!contextPack || running || !reviewed || !plan.trim()} onClick={promote}>Promote, commit & push</button>
          </section>
        </div>
        <details className="panel planning-console">
          <summary><span><b>⌘</b><strong>Copilot logs</strong><small>IDE-style diagnostics, tool activity, thinking status, and session events</small></span><Pill>{logs.length} events</Pill></summary>
          <div className="planning-console-toolbar"><span>Read-only local session diagnostics</span><button className="ghost compact" onClick={() => setLogs([])}>Clear</button></div>
          <div className="planning-console-lines">{logs.length ? logs.map((entry, index) => <div className={entry.level} key={`${entry.id}:${index}`}><time>{new Date(entry.at).toLocaleTimeString()}</time><code>{entry.type}</code><pre>{entry.detail}</pre></div>) : <div className="inline-empty">Copilot events will appear here after the session starts.</div>}</div>
        </details>
      </main>
    </div>
  </div>;
}

function InitiativeStudio({ data, editor, setEditor, saveEditor, downloadFile, action, reload, bootstrapPortfolio }) {
  const [tab, setTab] = useState('delivery');
  const [materializationModal, setMaterializationModal] = useState(null);
  const [repositoryModal, setRepositoryModal] = useState(null);
  const portfolio = data.portfolio;
  const selected = data.initiative;
  if (!portfolio) return <div className="page"><PortfolioSetup data={data} action={action} onCreated={bootstrapPortfolio} /></div>;
  const configValue = editor.path === data.portfolioPath ? editor.content : data.portfolioText;
  const configOriginal = editor.path === data.portfolioPath ? editor.original : data.portfolioText;
  let portfolioDraft = portfolio;
  try {
    const parsed = YAML.parse(configValue);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) portfolioDraft = parsed;
  } catch { /* The source editor reports invalid YAML on save. */ }
  const profiles = Object.entries(portfolio.initiativeProfiles ?? {});
  const repositories = Object.entries(portfolioDraft.repositories ?? {});
  const authorities = Object.entries(portfolio.approvalAuthorities ?? {});
  const state = selected?.state;
  const progress = selected?.progress;
  const report = selected?.report;
  const currentDefinition = state?.resolution.phases.find((phase) => phase.id === state.currentPhase) ?? state?.resolution.phases.at(-1);
  const currentChecks = selected?.phaseGate?.checklist ?? [];
  const children = report?.children.stories ?? [];
  const epics = report?.children.epics ?? [];
  const leadBaseBranch = data.definition.defaultBaseBranch ?? 'main';
  function openRepositoryModal() {
    setRepositoryModal({
      values: {
        id: '',
        appId: '',
        name: '',
        url: '',
        defaultBranch: leadBaseBranch,
        required: true,
        metadata: [{ key: '', value: '' }]
      },
      error: null
    });
  }
  function repositoryField(field, value) {
    setRepositoryModal((current) => ({ ...current, values: { ...current.values, [field]: value }, error: null }));
  }
  function repositoryMetadataField(index, field, value) {
    setRepositoryModal((current) => ({
      ...current,
      values: {
        ...current.values,
        metadata: current.values.metadata.map((entry, entryIndex) => entryIndex === index ? { ...entry, [field]: value } : entry)
      },
      error: null
    }));
  }
  function addRepository() {
    try {
      const current = YAML.parse(configValue);
      const next = addPortfolioRepository(current, repositoryModal.values);
      setEditor({ path: data.portfolioPath, content: YAML.stringify(next), original: configOriginal, kind: 'portfolio' });
      setRepositoryModal(null);
    } catch (error) {
      setRepositoryModal((current) => ({ ...current, error: error.message }));
    }
  }
  async function previewMaterialization() {
    const result = await action(() => window.singularity.previewInitiativeMaterialization(data.repository.root, state.initiative.id));
    if (result) setMaterializationModal({ preview: result.review, confirmation: '' });
  }
  async function materializeStories() {
    const initiativeId = state.initiative.id;
    if (materializationModal.confirmation !== initiativeId) return;
    const result = await action(
      () => window.singularity.materializeInitiative(data.repository.root, initiativeId, materializationModal.confirmation),
      `Created or attached ${materializationModal.preview.stories.length} Jira/Git story work items and published the receipts`
    );
    if (!result) return;
    setMaterializationModal(null);
    await reload(null, initiativeId);
  }
  async function synchronizeStories() {
    const initiativeId = state.initiative.id;
    const result = await action(
      () => window.singularity.syncInitiative(data.repository.root, initiativeId),
      'Story branches synchronized and epic progress published'
    );
    if (result) await reload(null, initiativeId);
  }
  return <div className="page initiative-page">
    <header className="page-heading initiative-heading"><div><span className="eyebrow">Cross-repository control plane</span><h1>Initiative orchestration</h1><p>Govern initiative outputs, evidence, contracts, and repository stories without changing the existing story workflow.</p></div><div className="segmented"><button className={tab === 'delivery' ? 'active' : ''} onClick={() => setTab('delivery')}>Delivery</button><button className={tab === 'configuration' ? 'active' : ''} onClick={() => setTab('configuration')}>Portfolio designer</button></div></header>
    {tab === 'delivery' && <div className="branch-baseline-note"><span>⑂</span><div><strong>Branches stay isolated</strong><p><code>{leadBaseBranch}</code> supplies the starting source and configuration baseline. Initiative and story branches receive their own commits; Singularity never merges them into a default branch automatically.</p></div></div>}
    {tab === 'configuration' ? <div className="initiative-config-layout">
      <aside className="initiative-config-summary">
        <section className="panel"><header className="panel-heading"><div><span className="eyebrow">Profiles</span><h2>{profiles.length} delivery models</h2></div></header><div className="initiative-mini-list">{profiles.map(([id, profile]) => <div key={id}><strong>{profile.label}</strong><span>{profile.phases.length} phases</span><small>{profile.phases.join(' → ')}</small></div>)}</div></section>
        <section className="panel"><header className="panel-heading"><div><span className="eyebrow">Repository registry</span><h2>{repositories.length} repositories</h2></div><button className="primary compact" onClick={openRepositoryModal}>＋ Add repository</button></header><div className="initiative-mini-list repository-registry-list">{repositories.length ? repositories.map(([id, repository]) => <div key={id}><strong>{repository.metadata?.name ?? id}</strong><span>{repository.metadata?.appId ?? (repository.required ? 'Required' : 'Optional')}</span><small>{id} · {repository.defaultBranch} · {repository.url}</small>{Object.entries(repository.metadata ?? {}).filter(([key]) => !['appId', 'name'].includes(key)).length > 0 && <em>{Object.entries(repository.metadata).filter(([key]) => !['appId', 'name'].includes(key)).map(([key, value]) => `${key}: ${value}`).join(' · ')}</em>}</div>) : <div><strong>No repositories yet</strong><small>Add a repository with application identity and organization metadata.</small></div>}</div></section>
        <section className="panel"><header className="panel-heading"><div><span className="eyebrow">Issue materialization</span><h2>Jira {portfolio.jira?.enabled ? portfolio.jira.writeMode : 'off'}</h2></div><Pill tone={portfolio.jira?.writeMode === 'approved' ? 'good' : 'neutral'}>{portfolio.jira?.projectKey || 'Git only'}</Pill></header><div className="initiative-mini-list"><div><strong>Epic → Story hierarchy</strong><span>{portfolio.jira?.writeMode === 'approved' ? 'Guarded apply' : portfolio.jira?.writeMode === 'preview' ? 'Plan only' : 'Git only'}</span><small>{portfolio.jira?.writeMode === 'approved' ? `${portfolio.jira.epicIssueType ?? 'Epic'} / ${portfolio.jira.storyIssueType ?? 'Story'} · exact approved write plan required` : portfolio.jira?.writeMode === 'preview' ? 'Create and commit Jira write plans without mutating Jira.' : 'Enable Jira policy and choose a write mode in portfolio.yml; no network is used while off.'}</small></div></div></section>
        <section className="panel"><header className="panel-heading"><div><span className="eyebrow">Approval authorities</span><h2>{authorities.length} groups</h2></div></header><div className="initiative-mini-list">{authorities.map(([id, authority]) => <div key={id}><strong>{id}</strong><span>{authority.members.length} identities</span><small>{authority.members.map((member) => member.email).join(', ') || 'Configure members before starting.'}</small></div>)}</div></section>
      </aside>
      <SourceEditor path={data.portfolioPath} value={configValue} dirty={configValue !== configOriginal} onChange={(content) => setEditor({ path: data.portfolioPath, content, original: configOriginal, kind: 'portfolio' })} onSave={saveEditor} onDownload={() => downloadFile(data.portfolioPath)} language="yaml" />
    </div> : !selected ? <><div className="initiative-profile-strip">{profiles.map(([id, profile]) => <section className="panel" key={id}><span className="eyebrow">{id}</span><h2>{profile.label}</h2><p>{profile.description}</p><div>{profile.phases.map((phase) => <span key={phase}>{phase}</span>)}</div></section>)}</div><Empty title="No initiative selected on this branch" detail="Start or resume an initiative with /sflow-initiative-start in GitHub Copilot, then choose it from the top selector to see its cross-repository dashboard." /></> : <>
      <section className="initiative-hero">
        <div><div className="row gap"><Pill tone="accent">{state.initiative.profileLabel}</Pill><Pill tone={state.status === 'complete' ? 'good' : 'neutral'}>{state.status}</Pill><Pill>configured-local identity</Pill></div><h2>{state.initiative.title}</h2><p>{state.initiative.id} · branch {state.initiative.branch} · current phase {state.currentPhase ?? 'complete'}</p></div><ProgressRing value={progress.percentage} />
      </section>
      <div className="initiative-metrics"><div><span>Total elapsed</span><strong>{report.duration}</strong><small>wall-clock lifecycle</small></div><div><span>Blocking stories</span><strong>{report.children.blocking}</strong><small>{report.children.stale} stale</small></div><div><span>Evidence</span><strong>{report.evidence.records}</strong><small>{report.evidence.stale} stale checks</small></div><div><span>Models</span><strong>{report.telemetry.models.length || '—'}</strong><small>{report.telemetry.models.join(', ') || 'unavailable'}</small></div><div><span>Tokens</span><strong>{formatTokens(report.telemetry.totalTokens)}</strong><small>committed usage</small></div><div><span>Cost</span><strong>{formatCost(report.telemetry.providerCost)}</strong><small>{report.telemetry.costStatus}</small></div></div>
      {!!report.approvals.selfApprovals.length && <div className="notice warn">⚠ {report.approvals.selfApprovals.length} self-approval{report.approvals.selfApprovals.length === 1 ? '' : 's'} recorded. These decisions are valid under the configured policy but are not independent review.</div>}
      <section className="panel initiative-flow-panel"><header className="panel-heading"><div><span className="eyebrow">Phase gates</span><h2>{state.initiative.profileLabel}</h2></div><span>{progress.percentage}% complete</span></header><div className={`initiative-flow ${state.phaseOrder.length > 4 ? 'enterprise' : 'lite'}`}>{progress.phases.map((phase, index) => <React.Fragment key={phase.id}><div className={`initiative-phase ${phase.status.replaceAll('_', '-')} ${phase.id === state.currentPhase ? 'current' : ''}`}><StatusDot status={phase.status} /><span><strong>{phase.label}</strong><small>{phase.generatedOutputs}/{phase.outputs} outputs · {phase.checklist} checks</small></span></div>{index < progress.phases.length - 1 && <i>→</i>}</React.Fragment>)}</div></section>
      <div className="initiative-lanes">{[['business-product', 'Business / Product'], ['design-architecture', 'Design / Architecture'], ['engineering', 'Engineering']].map(([laneId, laneLabel]) => <section className="panel" key={laneId}><header><span>{laneLabel}</span></header><div>{state.resolution.phases.filter((phase) => phase.lanes.includes(laneId)).map((phase) => <div key={phase.id}><StatusDot status={state.phases[phase.id].status} /><span><strong>{phase.label}</strong><small>{phase.outputs.map((output) => output.label).join(' · ')}</small></span></div>)}</div></section>)}</div>
      <div className="initiative-grid">
        <section className="panel initiative-checks"><header className="panel-heading"><div><span className="eyebrow">Assurance & freshness</span><h2>{currentDefinition?.label} checklist</h2></div><Pill tone={selected.phaseGate?.ready ? 'good' : 'warn'}>{selected.phaseGate?.ready ? 'Gate ready' : 'Action needed'}</Pill></header><div className="initiative-table-head"><span>Check</span><span>Requirement</span><span>Assurance</span><span>Status</span></div>{currentChecks.map((check) => <div className="initiative-table-row" key={check.id}><span><strong>{check.label}</strong><small>{check.id}</small></span><Pill>{check.requirement} · {check.gate}</Pill><span>{check.evidence.length ? check.evidence.map((entry) => entry.assurance).join(', ') : check.acceptedAssurance.join(' / ')}</span><Pill tone={['satisfied', 'waived', 'not_applicable', 'optional'].includes(check.status) ? 'good' : check.status === 'stale' ? 'warn' : 'bad'}>{check.status}</Pill></div>)}</section>
        <section className="panel initiative-next"><header className="panel-heading"><div><span className="eyebrow">Deterministic guidance</span><h2>Next actions</h2></div></header>{selected.nextActions.map((action, index) => <div key={`${action.action}:${index}`}><span>{index + 1}</span><section><strong>{action.action.replaceAll('-', ' ')}</strong><code>{action.command}</code><small>{action.reason}</small></section></div>)}</section>
      </div>
      <section className="panel initiative-stories">
        <header className="panel-heading"><div><span className="eyebrow">Repository delivery graph</span><h2>Epic-level story progress</h2></div><div className="row gap"><span>{report.children.materialized}/{children.length} materialized</span><button className="secondary compact" onClick={synchronizeStories} disabled={!report.children.materialized}>↻ Sync story branches</button><button className="primary compact" onClick={previewMaterialization} disabled={selected.materialization.phaseStatus !== 'approved'}>Create Jira & Git stories</button></div></header>
        {!epics.length ? <div className="inline-empty">The story plan has no epics yet. Use Planning Copilot on the story-plan output, review its Epic IDs and Story Work IDs, then promote it.</div> : <div className="epic-progress-list">{epics.map((epic) => <section key={epic.id} className={epic.stale ? 'stale' : ''}>
          <header><div><span className="id-pair"><b>Epic ID</b><code>{epic.id}</code></span><span className="id-pair"><b>Jira ID</b><code>{epic.jiraKey ?? 'not created'}</code></span><h3>{epic.title}</h3></div><div className="epic-progress-summary"><strong>{epic.percentage}%</strong><span>{epic.complete}/{epic.total} complete</span><div><i style={{ width: `${epic.percentage}%` }} /></div></div></header>
          <div className="epic-story-table"><div className="epic-story-head"><span>Story Work ID / Jira ID</span><span>Repository</span><span>Phase</span><span>Progress</span><span>State</span></div>{epic.stories.map((story) => <article key={story.id} className={`${story.stale ? 'stale' : ''} ${story.blocked ? 'blocked' : ''}`}><span><strong>{story.workId}</strong><small>Jira: {story.jiraKey ?? 'not created'}</small></span><span>{story.repository}</span><span>{story.currentPhase ?? (story.materialized ? 'seeded' : 'planned')}</span><span className="story-progress"><i><b style={{ width: `${story.progress?.percentage ?? 0}%` }} /></i><em>{story.progress?.percentage ?? 0}%</em></span><span><Pill tone={story.stale || story.blocked ? 'warn' : story.status === 'complete' ? 'good' : story.materialized ? 'accent' : 'neutral'}>{story.stale ? 'stale' : story.blocked ? 'blocked' : story.status}</Pill>{story.blocking && <small>blocking</small>}</span></article>)}</div>
        </section>)}</div>}
      </section>
      <div className="initiative-grid">
        <section className="panel initiative-contracts"><header className="panel-heading"><div><span className="eyebrow">Producer / consumer graph</span><h2>Interface contracts</h2></div><span>{selected.contracts.length}</span></header>{selected.contracts.length ? selected.contracts.map((contract) => <div key={contract.key}><div><strong>{contract.key}</strong><Pill tone={contract.integrity === 'verified' ? 'good' : 'warn'}>{contract.integrity}</Pill></div><span>{contract.format} · {contract.sha256.slice(0, 12)}</span><small>{contract.producers.join(', ') || 'external'} → {contract.consumers.join(', ') || 'no consumers'}</small></div>) : <div className="inline-empty">No interface contracts registered yet.</div>}</section>
        <section className="panel initiative-documents"><header className="panel-heading"><div><span className="eyebrow">Governed outputs</span><h2>Initiative documents</h2></div><span>{selected.documents.length}</span></header>{selected.documents.map((document) => <div key={`${document.phase}:${document.id}`}><span><strong>{document.label}</strong><small>{document.phase} · generation {document.generation}</small></span><Pill tone={document.status === 'approved' ? 'good' : document.status === 'stale' ? 'warn' : 'neutral'}>{document.status}</Pill><button className="ghost compact" disabled={!document.sha256} onClick={() => downloadFile(document.repositoryPath)}>Download</button></div>)}</section>
      </div>
    </>}
    {repositoryModal && <DesignerModal title="Add a participating repository" detail="Application identity and custom key/value pairs are stored as governed Git metadata under repositories.<id>.metadata in singularity/portfolio.yml." submitLabel="Add to YAML draft" error={repositoryModal.error} onCancel={() => setRepositoryModal(null)} onSubmit={addRepository}><div className="modal-grid"><label><span>Repository ID</span><input autoFocus value={repositoryModal.values.id} placeholder="mobile" onChange={(event) => repositoryField('id', event.target.value)} /></label><label><span>Application ID</span><input value={repositoryModal.values.appId} placeholder="APP-1001" onChange={(event) => repositoryField('appId', event.target.value)} /></label><label className="full"><span>Application name</span><input value={repositoryModal.values.name} placeholder="Mobile application" onChange={(event) => repositoryField('name', event.target.value)} /></label><label className="full"><span>Git URL</span><input value={repositoryModal.values.url} placeholder="git@github.com:company/mobile.git" onChange={(event) => repositoryField('url', event.target.value)} /></label><label><span>Default branch</span><input value={repositoryModal.values.defaultBranch} onChange={(event) => repositoryField('defaultBranch', event.target.value)} /></label><label className="check-row"><input type="checkbox" checked={repositoryModal.values.required} onChange={(event) => repositoryField('required', event.target.checked)} />Required for initiative delivery</label></div><div className="repository-metadata-fields"><header><div><strong>Custom metadata</strong><span>Examples: owner, businessUnit, costCenter, criticality.</span></div><button type="button" className="ghost compact" onClick={() => repositoryField('metadata', [...repositoryModal.values.metadata, { key: '', value: '' }])}>＋ Add field</button></header>{repositoryModal.values.metadata.map((entry, index) => <div key={index}><input aria-label={`Repository metadata key ${index + 1}`} value={entry.key} placeholder="owner" onChange={(event) => repositoryMetadataField(index, 'key', event.target.value)} /><input aria-label={`Repository metadata value ${index + 1}`} value={entry.value} placeholder="Digital Channels" onChange={(event) => repositoryMetadataField(index, 'value', event.target.value)} /><button type="button" className="ghost compact" aria-label={`Remove repository metadata ${index + 1}`} onClick={() => repositoryField('metadata', repositoryModal.values.metadata.filter((_, entryIndex) => entryIndex !== index))}>×</button></div>)}</div></DesignerModal>}
    {materializationModal && <DesignerModal title={`Create stories for ${state.initiative.id}?`} detail="This creates or attaches Jira stories under their planned Epic IDs, creates one Git branch per Story Work ID in its configured repository, writes the governed seed, and pushes every receipt. The operation is resumable and never force-pushes." submitLabel="Create Jira & Git stories" onCancel={() => setMaterializationModal(null)} onSubmit={materializeStories}><div className="materialization-preview"><div><span>Epics</span><strong>{materializationModal.preview.epics}</strong></div><div><span>Stories</span><strong>{materializationModal.preview.stories.length}</strong></div><div><span>Repositories</span><strong>{Object.keys(materializationModal.preview.repositories).length}</strong></div></div><label><span>Type the Initiative ID to confirm</span><input autoFocus value={materializationModal.confirmation} placeholder={state.initiative.id} onChange={(event) => setMaterializationModal({ ...materializationModal, confirmation: event.target.value })} /></label>{materializationModal.confirmation !== state.initiative.id && <div className="notice warn">Exact confirmation required: <code>{state.initiative.id}</code></div>}</DesignerModal>}
  </div>;
}

function Review({ data, downloadFile }) {
  if (!data.workflow || !data.review) return <div className="page"><Empty title="Choose a work item" detail="The review bundle combines the current artifact, provenance, checks, approvals, usage, source changes, and supporting evidence." /></div>;
  const phase = data.review.phase;
  return <div className="page review-page"><header className="page-heading row-between"><div><span className="eyebrow">Unified reviewer handoff</span><h1>{phase.label} review bundle</h1><p>{data.workflow.workItem.id} · generation {phase.generation} · {phase.status.replaceAll('_', ' ')}</p></div>{data.review.artifact && <button className="secondary" onClick={() => downloadFile(data.review.artifact.path)}>Download artifact</button>}</header>
    {data.review.selfApprovalWarning && <div className="notice warn">⚠ This phase contains self-approval and must not be presented as independent review.</div>}
    {phase.id === 'visual-verification' && <VisualComparisonReview repository={data.repository.root} workId={data.selectedWorkId} records={data.review.documents} artifactContent={data.review.artifact?.content ?? ''} />}
    <div className="review-grid"><section className="panel review-summary"><header className="panel-heading"><h2>Decision context</h2><Pill tone="accent">{phase.status}</Pill></header><dl><div><dt>Required artifact</dt><dd>{data.review.artifact?.path ?? 'Not generated'}</dd></div><div><dt>Inputs</dt><dd>{data.review.inputs.length}</dd></div><div><dt>Checks</dt><dd>{data.review.checks.length}</dd></div><div><dt>Approvals</dt><dd>{data.review.approvals.length}/{phase.approvalMinimum}</dd></div><div><dt>Evidence</dt><dd>{data.review.documents.length}</dd></div><div><dt>Usage records</dt><dd>{data.review.usage.length}</dd></div></dl></section><section className="panel review-source"><header className="panel-heading"><h2>Source changes</h2></header><pre>{data.review.changeSummary || 'No source changes.'}</pre></section></div>
    <section className="panel review-document"><header className="panel-heading"><div><span className="eyebrow">Complete portable bundle</span><h2>Reviewer document</h2></div></header><pre>{data.review.markdown}</pre></section>
  </div>;
}

function Workflow({ data, editor, setEditor, saveEditor, downloadFile, importWorkflow }) {
  const draft = useMemo(() => { try { return YAML.parse(editor.content); } catch { return data.definition; } }, [editor.content, data.definition]);
  const [workType, setWorkType] = useState(Object.keys(draft.workTypes)[0]);
  const [phaseId, setPhaseId] = useState(draft.workTypes[workType]?.phases[0]);
  const [modal, setModal] = useState(null);
  useEffect(() => { if (!draft.workTypes[workType]) setWorkType(Object.keys(draft.workTypes)[0]); }, [draft, workType]);
  useEffect(() => { const first = draft.workTypes[workType]?.phases[0]; if (!draft.workTypes[workType]?.phases.includes(phaseId)) setPhaseId(first); }, [workType, draft, phaseId]);
  const profile = draft.workTypes[workType];
  const phase = draft.phases[phaseId];
  function replace(next) { setEditor({ ...editor, content: YAML.stringify(next) }); }
  function change(mutator) { const next = structuredClone(draft); mutator(next); replace(next); }
  function openModal(kind, values = {}) { setModal({ kind, error: null, values }); }
  function field(name, value) { setModal((current) => ({ ...current, error: null, values: { ...current.values, [name]: value } })); }
  function submitModal() {
    try {
      let next = draft;
      if (modal.kind === 'new-workflow') {
        next = createWorkType(draft, { ...modal.values, copyFrom: workType });
        setWorkType(modal.values.id.trim());
      } else if (modal.kind === 'delete-workflow') {
        next = removeWorkType(draft, workType);
        setWorkType(Object.keys(next.workTypes)[0]);
      } else if (modal.kind === 'add-stage') {
        next = addPhaseToWorkType(draft, workType, modal.values.phaseId);
        setPhaseId(modal.values.phaseId);
      } else if (modal.kind === 'new-stage') {
        next = createPhase(draft, workType, modal.values);
        setPhaseId(modal.values.id.trim());
      } else if (modal.kind === 'remove-stage') {
        next = removePhaseFromWorkType(draft, workType, phaseId);
        if (modal.values.deleteDefinition && !Object.values(next.workTypes).some((item) => item.phases.includes(phaseId))) next = deleteUnusedPhase(next, phaseId);
        setPhaseId(next.workTypes[workType].phases[Math.min(phaseIndex, next.workTypes[workType].phases.length - 1)]);
      }
      replace(next);
      setModal(null);
    } catch (error) {
      setModal((current) => ({ ...current, error: error.message }));
    }
  }
  function toggleApprovalPersona(personaId) { change((next) => { const values = next.phases[phaseId].approval.personas ??= []; const index = values.indexOf(personaId); if (index >= 0) values.splice(index, 1); else { values.push(personaId); const capability = next.personas[personaId].mayApprove ??= []; if (!capability.includes(phaseId)) capability.push(phaseId); } }); }
  function toggleSuggestedPersona(personaId) { change((next) => { const values = next.phases[phaseId].suggestedPersonas ??= []; const index = values.indexOf(personaId); if (index >= 0) values.splice(index, 1); else values.push(personaId); }); }
  function toggleRejectTarget(target) { change((next) => { const values = next.phases[phaseId].approval.rejectTo ??= []; const index = values.indexOf(target); if (index >= 0) values.splice(index, 1); else values.push(target); }); }
  function toggleInput(target) { const current = profile.phaseOverrides?.[phaseId]?.inputs ?? phase.inputs ?? []; const selected = current.map((entry) => typeof entry === 'string' ? entry : entry.phase); replace(setWorkTypeInputs(draft, workType, phaseId, selected.includes(target) ? selected.filter((id) => id !== target) : [...selected, target])); }
  function movePhase(offset) { change((next) => { const targetProfile = next.workTypes[workType]; const phases = targetProfile.phases; const index = phases.indexOf(phaseId); const target = index + offset; if (target < 0 || target >= phases.length) return; [phases[index], phases[target]] = [phases[target], phases[index]]; for (const [consumerIndex, consumerId] of phases.entries()) { const earlier = new Set(phases.slice(0, consumerIndex)); const inherited = targetProfile.phaseOverrides?.[consumerId]?.inputs ?? next.phases[consumerId]?.inputs ?? []; const valid = inherited.filter((entry) => earlier.has(typeof entry === 'string' ? entry : entry.phase)); if (valid.length === inherited.length) continue; targetProfile.phaseOverrides ??= {}; targetProfile.phaseOverrides[consumerId] = { ...(targetProfile.phaseOverrides[consumerId] ?? {}), inputs: valid }; } }); }
  function setGlobalGate(gate, mode) { change((next) => { next.sequenceGates ??= {}; if (mode) next.sequenceGates[gate] = mode; else delete next.sequenceGates[gate]; }); }
  function setProfileGate(gate, mode) { change((next) => { next.workTypes[workType].sequenceGates ??= {}; if (mode) next.workTypes[workType].sequenceGates[gate] = mode; else delete next.workTypes[workType].sequenceGates[gate]; }); }
  const phaseIndex = profile.phases.indexOf(phaseId);
  const templateNames = data.templates.map((item) => item.name);
  const inactivePhases = Object.keys(draft.phases).filter((id) => !profile.phases.includes(id));
  const effectiveInputs = (profile.phaseOverrides?.[phaseId]?.inputs ?? phase?.inputs ?? []).map((entry) => typeof entry === 'string' ? entry : entry.phase);
  const defaults = { persona: Object.keys(draft.personas)[0], template: templateNames[0], writeScope: 'artifact-only', minimumBytes: 200 };
  return <div className="split-page workflow-layout">
    <div className="design-pane"><header className="page-heading"><span className="eyebrow">Visual configuration</span><h1>Workflow designer</h1><p>Inspect phase order, approval authority, rejection paths, and template resolution.</p></header>
      <div className="designer-toolbar"><div className="segmented">{Object.entries(draft.workTypes).map(([id, item]) => <button className={id === workType ? 'active' : ''} key={id} onClick={() => setWorkType(id)}>{item.label}</button>)}</div><div className="row"><button className="secondary compact" onClick={() => openModal('new-workflow', { id: '', label: '' })}>＋ Workflow</button><button className="ghost compact" disabled={Object.keys(draft.workTypes).length === 1} onClick={() => openModal('delete-workflow')}>Delete</button></div></div>
      <section className="profile-card"><label><span>Workflow name</span><input value={profile.label} onChange={(event) => change((next) => { next.workTypes[workType].label = event.target.value; })} /></label><code>{workType}</code><div className="row"><button className="secondary compact" disabled={!inactivePhases.length} onClick={() => openModal('add-stage', { phaseId: inactivePhases[0] })}>＋ Existing stage</button><button className="primary compact" onClick={() => openModal('new-stage', { ...defaults, id: '', label: '', artifactFile: '', kind: '' })}>＋ New stage</button></div></section>
      <section className="gate-panel"><header><div><span className="eyebrow">Copilot session policy</span><h2>Work item & persona binding</h2></div></header><p>Select durable remote work-item state before binding the contributor's declared persona. Workflow actions audit both the persona and Git identity.</p><div className="control-grid"><label><span>Work-item selection</span><select value={draft.session?.workItemSelection ?? 'off'} onChange={(event) => change((next) => { next.session ??= {}; next.session.workItemSelection = event.target.value; })}><option value="off">Off · legacy behavior</option><option value="reuse">Reuse active branch</option><option value="prompt">Prompt and sync remote</option></select></label><label><span>Persona selection</span><select value={draft.session?.personaSelection ?? 'off'} onChange={(event) => change((next) => { next.session ??= {}; next.session.personaSelection = event.target.value; })}><option value="off">Off · legacy behavior</option><option value="reuse">Reuse valid persona</option><option value="prompt">Prompt contributor</option></select></label></div><div className="choice-group"><span>Session controls</span><div><label className={draft.session?.promptOnNewSession ? 'checked' : ''}><input type="checkbox" checked={draft.session?.promptOnNewSession ?? false} onChange={(event) => change((next) => { next.session ??= {}; next.session.promptOnNewSession = event.target.checked; })} />Ask persona in every new Copilot session</label><label className={draft.session?.promptOnResume ? 'checked' : ''}><input type="checkbox" checked={draft.session?.promptOnResume ?? false} onChange={(event) => change((next) => { next.session ??= {}; next.session.promptOnResume = event.target.checked; })} />Ask persona again when Copilot resumes</label><label className={draft.session?.requireBeforeTools ? 'checked' : ''}><input type="checkbox" checked={draft.session?.requireBeforeTools ?? false} onChange={(event) => change((next) => { next.session ??= {}; next.session.requireBeforeTools = event.target.checked; })} />Block mutating tools until both selections complete</label></div></div></section>
      <section className="gate-panel"><header><div><span className="eyebrow">Exception policy</span><h2>Sequence gates</h2></div><label><span>Global default</span><select value={draft.sequenceGates?.default ?? 'hard'} onChange={(event) => setGlobalGate('default', event.target.value)}><option value="hard">Hard · block</option><option value="soft">Soft · ask</option></select></label></header><p>Hard gates stop immediately. Soft gates require a human to type <code>continue</code> and record an audited override.</p><div className="gate-grid"><strong>Gate</strong><strong>Global</strong><strong>{profile.label}</strong>{sequenceGates.map(([id, label]) => <React.Fragment key={id}><label title={id}>{label}<small>{id}</small></label><select value={draft.sequenceGates?.[id] ?? ''} onChange={(event) => setGlobalGate(id, event.target.value)}><option value="">Use default</option><option value="hard">Hard</option><option value="soft">Soft</option></select><select value={profile.sequenceGates?.[id] ?? ''} onChange={(event) => setProfileGate(id, event.target.value)}><option value="">Use global</option><option value="hard">Hard</option><option value="soft">Soft</option></select></React.Fragment>)}</div></section>
      <div className="flow-canvas">{profile.phases.map((id, index) => <React.Fragment key={id}><button className={`phase-node ${id === phaseId ? 'selected' : ''}`} onClick={() => setPhaseId(id)}><span>{String(index + 1).padStart(2, '0')}</span><strong>{draft.phases[id].label}</strong><small>{draft.workTypes[workType].templateOverrides?.[id] ?? draft.phases[id].defaultTemplate}</small></button>{index < profile.phases.length - 1 && <div className="connector">↓</div>}</React.Fragment>)}</div>
      {phase && <section className="inspector"><div className="inspector-title"><div><span className="eyebrow">Selected stage</span><h2>{phase.label}</h2></div><div className="row"><button className="icon-button" disabled={phaseIndex === 0} onClick={() => movePhase(-1)}>↑</button><button className="icon-button" disabled={phaseIndex === profile.phases.length - 1} onClick={() => movePhase(1)}>↓</button><button className="ghost compact" disabled={profile.phases.length === 1} onClick={() => openModal('remove-stage', { deleteDefinition: false })}>Remove</button></div></div>
        <div className="control-grid expanded"><label><span>Stage name</span><input value={phase.label} onChange={(event) => change((next) => { next.phases[phaseId].label = event.target.value; })} /></label><label><span>Write scope</span><select value={phase.writeScope} onChange={(event) => change((next) => { next.phases[phaseId].writeScope = event.target.value; })}><option value="artifact-only">Artifact only</option><option value="source-and-artifact">Source and artifact</option></select></label><label className="full"><span>Artifact path</span><input value={phase.artifact.path} onChange={(event) => change((next) => { next.phases[phaseId].artifact.path = event.target.value; })} /></label><label><span>Artifact kind</span><input value={phase.artifact.kind ?? ''} onChange={(event) => change((next) => { next.phases[phaseId].artifact.kind = event.target.value; })} /></label><label><span>Minimum bytes</span><input type="number" min="1" value={phase.artifact.minimumBytes ?? 1} onChange={(event) => change((next) => { next.phases[phaseId].artifact.minimumBytes = Number(event.target.value); })} /></label><label><span>Approval threshold</span><input type="number" min="0" max="10" value={phase.approval?.minimum ?? 0} onChange={(event) => change((next) => { next.phases[phaseId].approval.minimum = Number(event.target.value); })} /></label><label><span>Artifact template</span><select value={profile.templateOverrides?.[phaseId] ?? phase.defaultTemplate} onChange={(event) => change((next) => { next.workTypes[workType].templateOverrides ??= {}; next.workTypes[workType].templateOverrides[phaseId] = event.target.value; })}>{templateNames.map((name) => <option value={name} key={name}>{name}</option>)}</select></label><label className="full"><span>World-model views</span><input value={phase.worldModel?.views?.join(', ') ?? ''} onChange={(event) => change((next) => { next.phases[phaseId].worldModel ??= {}; next.phases[phaseId].worldModel.views = event.target.value.split(',').map((item) => item.trim()).filter(Boolean); })} /></label><label className="full"><span>Quality commands (one per line)</span><textarea value={phase.qualityCommands?.join('\n') ?? ''} onChange={(event) => change((next) => { next.phases[phaseId].qualityCommands = event.target.value.split('\n').map((item) => item.trim()).filter(Boolean); })} /></label></div>
        <div className="choice-group"><span>Inputs from earlier stages</span><div>{profile.phases.slice(0, phaseIndex).map((id) => <label key={id} className={effectiveInputs.includes(id) ? 'checked' : ''}><input type="checkbox" checked={effectiveInputs.includes(id)} onChange={() => toggleInput(id)} />{draft.phases[id].label}</label>)}{phaseIndex === 0 && <small className="choice-empty">First stage has no earlier inputs.</small>}</div></div>
        <div className="choice-group"><span>Suggested personas</span><div>{Object.entries(draft.personas).map(([id, persona]) => <label key={id} className={phase.suggestedPersonas?.includes(id) ? 'checked' : ''}><input type="checkbox" checked={phase.suggestedPersonas?.includes(id)} onChange={() => toggleSuggestedPersona(id)} />{persona.label}</label>)}</div></div>
        <div className="choice-group"><span>Approval personas</span><div>{Object.entries(draft.personas).map(([id, persona]) => <label key={id} className={phase.approval?.personas?.includes(id) ? 'checked' : ''}><input type="checkbox" checked={phase.approval?.personas?.includes(id)} onChange={() => toggleApprovalPersona(id)} />{persona.label}</label>)}</div></div>
        <div className="choice-group"><span>Allowed rejection targets</span><div>{profile.phases.slice(0, phaseIndex + 1).map((id) => <label key={id} className={phase.approval?.rejectTo?.includes(id) ? 'checked' : ''}><input type="checkbox" checked={phase.approval?.rejectTo?.includes(id)} onChange={() => toggleRejectTarget(id)} />{draft.phases[id].label}</label>)}</div></div>
      </section>}
    </div>
    <SourceEditor path={data.definitionPath} value={editor.content} dirty={editor.content !== editor.original} onChange={(content) => setEditor({ ...editor, content })} language="yaml" onSave={saveEditor} onDownload={() => downloadFile(data.definitionPath)} onImport={importWorkflow} />
    {modal?.kind === 'new-workflow' && <DesignerModal title="Create workflow" detail={`Create a new profile by copying ${profile.label}, then adjust its stages.`} submitLabel="Create workflow" error={modal.error} onCancel={() => setModal(null)} onSubmit={submitModal}><label><span>Workflow ID</span><input autoFocus value={modal.values.id} placeholder="security-review" onChange={(event) => field('id', event.target.value)} /></label><label><span>Display name</span><input value={modal.values.label} placeholder="Security review" onChange={(event) => field('label', event.target.value)} /></label></DesignerModal>}
    {modal?.kind === 'delete-workflow' && <DesignerModal title={`Delete ${profile.label}?`} detail="The workflow profile will be removed from the YAML draft. Shared stage definitions and templates remain available." submitLabel="Delete workflow" danger error={modal.error} onCancel={() => setModal(null)} onSubmit={submitModal} />}
    {modal?.kind === 'add-stage' && <DesignerModal title="Add an existing stage" detail="The stage is appended and receives the current last stage as its initial input." submitLabel="Add stage" error={modal.error} onCancel={() => setModal(null)} onSubmit={submitModal}><label><span>Available stage</span><select value={modal.values.phaseId} onChange={(event) => field('phaseId', event.target.value)}>{inactivePhases.map((id) => <option key={id} value={id}>{draft.phases[id].label} · {id}</option>)}</select></label></DesignerModal>}
    {modal?.kind === 'new-stage' && <DesignerModal title="Create a stage and artifact contract" detail="The stage is added to this workflow. Its ID, artifact location, approval authority, and template become governed YAML." submitLabel="Create stage" error={modal.error} onCancel={() => setModal(null)} onSubmit={submitModal}><div className="modal-grid"><label><span>Stage ID</span><input autoFocus value={modal.values.id} placeholder="security-review" onChange={(event) => field('id', event.target.value)} /></label><label><span>Stage name</span><input value={modal.values.label} placeholder="Security review" onChange={(event) => field('label', event.target.value)} /></label><label><span>Artifact filename</span><input value={modal.values.artifactFile} placeholder="security-review.md" onChange={(event) => field('artifactFile', event.target.value)} /></label><label><span>Artifact kind</span><input value={modal.values.kind} placeholder="security-review" onChange={(event) => field('kind', event.target.value)} /></label><label><span>Template</span><select value={modal.values.template} onChange={(event) => field('template', event.target.value)}>{templateNames.map((name) => <option key={name} value={name}>{name}</option>)}</select></label><label><span>Approval persona</span><select value={modal.values.persona} onChange={(event) => field('persona', event.target.value)}>{Object.entries(draft.personas).map(([id, persona]) => <option key={id} value={id}>{persona.label}</option>)}</select></label><label><span>Write scope</span><select value={modal.values.writeScope} onChange={(event) => field('writeScope', event.target.value)}><option value="artifact-only">Artifact only</option><option value="source-and-artifact">Source and artifact</option></select></label><label><span>Minimum bytes</span><input type="number" min="1" value={modal.values.minimumBytes} onChange={(event) => field('minimumBytes', event.target.value)} /></label></div></DesignerModal>}
    {modal?.kind === 'remove-stage' && <DesignerModal title={`Remove ${phase.label}?`} detail={`This removes the stage from ${profile.label} and cleans its profile-specific inputs.`} submitLabel="Remove stage" danger error={modal.error} onCancel={() => setModal(null)} onSubmit={submitModal}><label className="check-row"><input type="checkbox" checked={modal.values.deleteDefinition} onChange={(event) => field('deleteDefinition', event.target.checked)} /><span>Also delete the global stage definition if no other workflow uses it. Templates are never deleted automatically.</span></label></DesignerModal>}
  </div>;
}

function Personas({ data, openPrompt, savePersona, createPersonaConfig, deletePersonaConfig, downloadFile }) {
  const [selected, setSelected] = useState(Object.keys(data.definition.personas)[0]);
  const [draft, setDraft] = useState(structuredClone(data.definition.personas[selected]));
  const [modal, setModal] = useState(null);
  useEffect(() => { if (!data.definition.personas[selected]) setSelected(Object.keys(data.definition.personas)[0]); }, [data, selected]);
  useEffect(() => { setDraft(structuredClone(data.definition.personas[selected] ?? Object.values(data.definition.personas)[0])); }, [data, selected]);
  const personaId = data.definition.personas[selected] ? selected : Object.keys(data.definition.personas)[0];
  const persona = data.definition.personas[personaId];
  const prompt = data.personaPrompts.find((item) => item.name === persona?.prompt);
  const dirty = JSON.stringify(draft) !== JSON.stringify(persona);
  function field(name, value) { setDraft((current) => ({ ...current, [name]: value })); }
  function toggle(name, value) { const values = draft[name] ?? []; field(name, values.includes(value) ? values.filter((item) => item !== value) : [...values, value]); }
  async function submitNew() { const result = await createPersonaConfig(modal.values); if (result) { setSelected(modal.values.id.trim()); setModal(null); } }
  async function submitDelete() { const result = await deletePersonaConfig(personaId, modal.replacement); if (result) { setSelected(modal.replacement); setModal(null); } }
  return <div className="page"><header className="page-heading row-between"><div><span className="eyebrow">Identity, prompt, and authority</span><h1>Personas & approvals</h1><p>Create personas, edit their prompt perspective, and configure phase and approval coverage.</p></div><div className="row"><button className="secondary" disabled={Object.keys(data.definition.personas).length === 1} onClick={() => setModal({ kind: 'delete', replacement: Object.keys(data.definition.personas).find((id) => id !== selected) })}>Delete persona</button><button className="primary" onClick={() => setModal({ kind: 'new', error: null, values: { id: '', label: '', description: '', prompt: '' } })}>＋ Persona</button></div></header>
    <div className="persona-grid">{Object.entries(data.definition.personas).map(([id, item]) => <button key={id} className={`persona-card ${personaId === id ? 'selected' : ''}`} onClick={() => setSelected(id)}><span className="avatar">{item.label.slice(0, 2).toUpperCase()}</span><strong>{item.label}</strong><small>{item.description}</small><div className="tags">{item.worldModelViews?.map((view) => <Pill key={view}>{view}</Pill>)}</div></button>)}</div>
    <div className="two-column"><section className="panel persona-detail"><header className="panel-heading"><div><span className="eyebrow">Persona contract</span><h2>{persona.label}</h2></div><div className="row">{prompt && <button className="ghost compact" onClick={() => downloadFile(prompt.path)}>Download prompt</button>}{prompt && <button className="secondary compact" onClick={() => openPrompt(prompt)}>Edit prompt</button>}<button className="primary compact" disabled={!dirty} onClick={() => savePersona(personaId, draft)}>Save persona</button></div></header><div className="persona-form"><label><span>Display name</span><input value={draft.label} onChange={(event) => field('label', event.target.value)} /></label><label><span>Description</span><textarea value={draft.description ?? ''} onChange={(event) => field('description', event.target.value)} /></label><label><span>Prompt file</span><select value={draft.prompt} onChange={(event) => field('prompt', event.target.value)}>{data.personaPrompts.map((file) => <option key={file.name} value={file.name}>{file.name}</option>)}</select></label><label><span>Repository world-model views</span><input value={draft.worldModelViews?.join(', ') ?? ''} onChange={(event) => field('worldModelViews', event.target.value.split(',').map((item) => item.trim()).filter(Boolean))} placeholder="architecture, security" /></label></div><div className="choice-group persona-choices"><span>Suggested stages</span><div>{Object.entries(data.definition.phases).map(([id, phase]) => <label key={id} className={draft.suggestedPhases?.includes(id) ? 'checked' : ''}><input type="checkbox" checked={draft.suggestedPhases?.includes(id)} onChange={() => toggle('suggestedPhases', id)} />{phase.label}</label>)}</div></div><div className="choice-group persona-choices"><span>May approve</span><div>{Object.entries(data.definition.phases).map(([id, phase]) => <label key={id} className={draft.mayApprove?.includes(id) ? 'checked' : ''}><input type="checkbox" checked={draft.mayApprove?.includes(id)} onChange={() => toggle('mayApprove', id)} />{phase.label}</label>)}</div></div></section>
      <section className="panel"><header className="panel-heading"><div><span className="eyebrow">Approval coverage</span><h2>Configured rules</h2></div></header><div className="rule-list">{Object.entries(data.definition.phases).filter(([, phase]) => phase.approval?.personas?.includes(personaId)).map(([id, phase]) => <div key={id}><StatusDot status="approved" /><span><strong>{phase.label}</strong><small>{phase.approval.minimum} required · reject to {phase.approval.rejectTo?.join(', ')}</small></span></div>)}</div></section></div>
    {modal?.kind === 'new' && <DesignerModal title="Create persona and prompt" detail="A configurable Markdown prompt is created in the repository and linked from workflow.yml." submitLabel="Create persona" error={modal.error} onCancel={() => setModal(null)} onSubmit={submitNew}><div className="modal-grid"><label><span>Persona ID</span><input autoFocus value={modal.values.id} placeholder="security-reviewer" onChange={(event) => setModal({ ...modal, values: { ...modal.values, id: event.target.value, prompt: modal.values.prompt || `${event.target.value}.md` } })} /></label><label><span>Display name</span><input value={modal.values.label} placeholder="Security reviewer" onChange={(event) => setModal({ ...modal, values: { ...modal.values, label: event.target.value } })} /></label><label className="full"><span>Description</span><input value={modal.values.description} placeholder="Review threats, controls, and evidence." onChange={(event) => setModal({ ...modal, values: { ...modal.values, description: event.target.value } })} /></label><label className="full"><span>Prompt filename</span><input value={modal.values.prompt} placeholder="security-reviewer.md" onChange={(event) => setModal({ ...modal, values: { ...modal.values, prompt: event.target.value } })} /></label></div></DesignerModal>}
    {modal?.kind === 'delete' && <DesignerModal title={`Delete ${persona.label}?`} detail="Every stage reference will move to the replacement persona. The old prompt is removed only when nothing else references it." submitLabel="Delete persona" danger onCancel={() => setModal(null)} onSubmit={submitDelete}><label><span>Replacement persona</span><select value={modal.replacement} onChange={(event) => setModal({ ...modal, replacement: event.target.value })}>{Object.entries(data.definition.personas).filter(([id]) => id !== selected).map(([id, item]) => <option key={id} value={id}>{item.label}</option>)}</select></label></DesignerModal>}
  </div>;
}

function InlineMarkdown({ text }) {
  const pieces = String(text).split(/(\*\*[^*]+\*\*|`[^`]+`|\[[^\]]+\]\(https?:\/\/[^)]+\))/g).filter(Boolean);
  return pieces.map((piece, index) => {
    if (piece.startsWith('**') && piece.endsWith('**')) return <strong key={index}>{piece.slice(2, -2)}</strong>;
    if (piece.startsWith('`') && piece.endsWith('`')) return <code key={index}>{piece.slice(1, -1)}</code>;
    const link = piece.match(/^\[([^\]]+)\]\((https?:\/\/[^)]+)\)$/);
    if (link) return <a key={index} href={link[2]} target="_blank" rel="noreferrer">{link[1]}</a>;
    return <React.Fragment key={index}>{piece}</React.Fragment>;
  });
}

function markdownBlocks(content) {
  const lines = content.split('\n');
  const blocks = [];
  for (let index = 0; index < lines.length;) {
    const line = lines[index];
    if (line.startsWith('```')) {
      const language = line.slice(3).trim(); const code = []; index += 1;
      while (index < lines.length && !lines[index].startsWith('```')) { code.push(lines[index]); index += 1; }
      blocks.push(<pre className="preview-code" key={`code-${index}`}><code data-language={language}>{code.join('\n')}</code></pre>); index += 1; continue;
    }
    if (line.startsWith('|')) {
      const rows = []; while (index < lines.length && lines[index].startsWith('|')) { rows.push(lines[index].split('|').slice(1, -1).map((cell) => cell.trim())); index += 1; }
      const dataRows = rows.filter((row) => !row.every((cell) => /^:?-+:?$/.test(cell)));
      const [header, ...body] = dataRows;
      blocks.push(<div className="preview-table-wrap" key={`table-${index}`}><table className="preview-table"><thead><tr>{header?.map((cell, cellIndex) => <th key={cellIndex}><InlineMarkdown text={cell} /></th>)}</tr></thead><tbody>{body.map((row, rowIndex) => <tr key={rowIndex}>{row.map((cell, cellIndex) => <td key={cellIndex}><InlineMarkdown text={cell} /></td>)}</tr>)}</tbody></table></div>); continue;
    }
    if (line.startsWith('# ')) blocks.push(<h1 key={index}><InlineMarkdown text={line.slice(2)} /></h1>);
    else if (line.startsWith('## ')) blocks.push(<h2 key={index}><InlineMarkdown text={line.slice(3)} /></h2>);
    else if (line.startsWith('### ')) blocks.push(<h3 key={index}><InlineMarkdown text={line.slice(4)} /></h3>);
    else if (line.startsWith('- ')) blocks.push(<div className="preview-list" key={index}>• <InlineMarkdown text={line.slice(2)} /></div>);
    else if (/^\d+\.\s/.test(line)) blocks.push(<div className="preview-list numbered" key={index}><InlineMarkdown text={line} /></div>);
    else if (line.startsWith('> ')) blocks.push(<blockquote key={index}><InlineMarkdown text={line.slice(2)} /></blockquote>);
    else if (line) blocks.push(<p key={index}><InlineMarkdown text={line} /></p>);
    index += 1;
  }
  return blocks;
}

function TemplatePreview({ content, className = '' }) {
  return <div className={`markdown-preview ${className}`}>{markdownBlocks(content)}</div>;
}

const helpMatches = [...helpMarkdown.matchAll(/^##\s+(.+)$/gm)];
const helpTopics = helpMatches.map((match, index) => ({
  id: match[1].toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''),
  title: match[1].trim(),
  content: helpMarkdown.slice(match.index + match[0].length, helpMatches[index + 1]?.index ?? helpMarkdown.length).trim()
}));

function Help() {
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState(helpTopics[0]?.id);
  const filtered = helpTopics.filter((topic) => `${topic.title}\n${topic.content}`.toLowerCase().includes(query.trim().toLowerCase()));
  const topic = helpTopics.find((item) => item.id === selected && filtered.includes(item)) ?? filtered[0];
  return <div className="help-layout">
    <aside className="help-toc"><header><span className="eyebrow">Built-in manual</span><h2>Help</h2><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search help…" /></header><div className="help-topic-list">{filtered.map((item) => <button key={item.id} className={topic?.id === item.id ? 'active' : ''} onClick={() => setSelected(item.id)}>{item.title}</button>)}</div>{!filtered.length && <p className="help-empty">No help topic matches “{query}”.</p>}</aside>
    <main className="help-main"><header className="help-header"><div><span className="eyebrow">Singularity Flow manual</span><h1>{topic?.title ?? 'No results'}</h1></div>{topic && <code>singularity-flow help {topic.id}</code>}</header>{topic && <TemplatePreview className="help-preview" content={`## ${topic.title}\n\n${topic.content}`} />}</main>
  </div>;
}

function Templates({ data, editor, setEditor, chooseTemplate, saveEditor, createTemplate, deleteTemplate, downloadFile, importTemplate }) {
  const [search, setSearch] = useState('');
  const [preview, setPreview] = useState(false);
  const [modal, setModal] = useState(null);
  const files = data.templates.filter((item) => item.name.toLowerCase().includes(search.toLowerCase()));
  const current = data.templates.find((file) => file.path === editor.path) ?? null;
  async function submitCreate() { if (!modal.name.trim()) return setModal({ ...modal, error: 'Enter a relative Markdown filename.' }); const result = await createTemplate(modal.name.trim()); if (result) setModal(null); }
  async function submitDelete() { const result = await deleteTemplate(current); if (result) setModal(null); }
  return <div className="template-layout"><aside className="file-list"><header><div className="row-between"><div><span className="eyebrow">Artifact library</span><h2>Templates</h2></div><div className="row"><button className="icon-button" title="Import template" onClick={importTemplate}>⇧</button><button className="icon-button" title="Create template" onClick={() => setModal({ kind: 'create', name: '', error: null })}>＋</button></div></div><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Filter templates…" /></header>{files.map((file) => <button key={file.path} className={editor.path === file.path ? 'active' : ''} onClick={() => chooseTemplate(file)}><span>MD</span><div><strong>{file.name.split('/').at(-1)}</strong><small>{file.name.includes('/') ? file.name.slice(0, file.name.lastIndexOf('/')) : 'root'}</small></div></button>)}</aside>
    <main className="template-main"><header className="template-toolbar"><div><span className="eyebrow">Template studio</span><h1>{editor.path?.split('/').at(-1)}</h1></div><div className="row"><div className="segmented small"><button className={!preview ? 'active' : ''} onClick={() => setPreview(false)}>Source</button><button className={preview ? 'active' : ''} onClick={() => setPreview(true)}>Preview</button></div><button className="secondary compact" disabled={!current} onClick={() => downloadFile(current.path)}>Download</button><Pill tone={editor.content !== editor.original ? 'warn' : 'good'}>{editor.content !== editor.original ? 'Unsaved' : 'Saved'}</Pill><button className="primary compact" disabled={editor.content === editor.original} onClick={saveEditor}>Save</button></div></header>
      <div className="template-contract-bar"><span>Templates define the generated artifact structure and may use <code>{'{{work.id}}'}</code>, <code>{'{{phase.label}}'}</code>, and <code>{'{{inputs}}'}</code>.</span><div className="row"><button className="ghost compact" onClick={importTemplate}>Import Markdown</button><button className="ghost compact" disabled={!current} onClick={() => setModal({ kind: 'delete', error: null })}>Delete template</button></div></div>
      {preview ? <TemplatePreview content={editor.content} /> : <Editor height="calc(100vh - 186px)" language="markdown" theme="vs-dark" value={editor.content} onChange={(content) => setEditor({ ...editor, content: content ?? '' })} options={{ minimap: { enabled: false }, fontSize: 13, lineHeight: 21, wordWrap: 'on', padding: { top: 20 }, scrollBeyondLastLine: false, automaticLayout: true }} />}
    </main>
    {modal?.kind === 'create' && <DesignerModal title="Create artifact template" detail="Create repository Markdown under the configured templates root. You can assign it to a stage from the Workflow page." submitLabel="Create template" error={modal.error} onCancel={() => setModal(null)} onSubmit={submitCreate}><label><span>Relative template path</span><input autoFocus value={modal.name} placeholder="security/security-review.md" onChange={(event) => setModal({ ...modal, name: event.target.value, error: null })} /></label></DesignerModal>}
    {modal?.kind === 'delete' && <DesignerModal title={`Delete ${current?.name}?`} detail="Deletion is allowed only when no stage or workflow profile references this template." submitLabel="Delete template" danger error={modal.error} onCancel={() => setModal(null)} onSubmit={submitDelete} />}
  </div>;
}

function Resources({ data, editor, setEditor, chooseResource, saveEditor, createSkill, deleteFile, downloadFile, importResource, materializeWorldModelPrompt, materializePlanningPrompt }) {
  const [category, setCategory] = useState(editor.kind === 'skill' ? 'skills' : 'prompts');
  const [modal, setModal] = useState(null);
  const promptFiles = [
    ...data.personaPrompts,
    { ...data.worldModelPrompt, name: `world-model/${data.worldModelPrompt.name}`, worldModelBuilder: true },
    { ...data.planning.prompt, name: `planning/${data.planning.prompt.name}`, planningPrompt: true }
  ];
  const files = category === 'skills' ? data.repositorySkills : promptFiles;
  const current = files.find((file) => file.path === editor.path) ?? files[0];
  useEffect(() => { if (current && editor.path !== current.path) chooseResource(current, category === 'skills' ? 'skill' : 'prompt'); }, [category]);
  async function submitSkill() { const result = await createSkill(modal.id.trim()); if (result) setModal(null); }
  return <div className="template-layout"><aside className="file-list"><header><div className="row-between"><div><span className="eyebrow">Repository Markdown</span><h2>Prompts & skills</h2></div><button className="icon-button" title={category === 'skills' ? 'Create skill' : 'Import prompt'} onClick={() => category === 'skills' ? setModal({ kind: 'skill', id: '', error: null }) : importResource('prompt')}>＋</button></div><div className="segmented resource-tabs"><button className={category === 'prompts' ? 'active' : ''} onClick={() => setCategory('prompts')}>Prompts</button><button className={category === 'skills' ? 'active' : ''} onClick={() => setCategory('skills')}>Skills</button></div></header>{files.map((file) => <button key={file.path} className={current?.path === file.path ? 'active' : ''} onClick={() => chooseResource(file, category === 'skills' ? 'skill' : 'prompt')}><span>{category === 'skills' ? 'SK' : 'PR'}</span><div><strong>{file.name.split('/').at(-1)}</strong><small>{file.worldModelBuilder ? 'world-model builder' : file.planningPrompt ? 'Copilot planning contract' : file.name.includes('/') ? file.name.slice(0, file.name.lastIndexOf('/')) : category === 'skills' ? 'repository skill' : 'persona prompt'}</small></div></button>)}</aside>
    <main className="template-main">{current ? <><div className="resource-summary"><div><Pill tone="accent">{current.worldModelBuilder ? 'Builder prompt' : current.planningPrompt ? 'Planning contract' : category === 'skills' ? 'Repository skill' : 'Persona prompt'}</Pill><span>{current.worldModelBuilder ? 'Controls repository world-model generation.' : current.planningPrompt ? 'Controls phase-aware Copilot Plan-mode behavior and promotion output.' : category === 'skills' ? 'Discovered by Copilot from .github/skills.' : 'Combined with phase and world-model context.'}</span></div><div className="row"><button className="ghost compact" onClick={() => importResource(current.worldModelBuilder ? 'world-prompt' : current.planningPrompt ? 'planner-prompt' : category === 'skills' ? 'skill' : 'prompt')}>Import</button>{!current.missing && <button className="secondary compact" onClick={() => downloadFile(current.path)}>Download</button>}{category === 'skills' && <button className="ghost compact" onClick={() => deleteFile(current)}>Delete</button>}{current.worldModelBuilder && current.missing && <button className="primary compact" onClick={() => materializeWorldModelPrompt(editor.path === current.path ? editor.content : current.content)}>Create repository copy</button>}{current.planningPrompt && current.missing && <button className="primary compact" onClick={() => materializePlanningPrompt(editor.path === current.path ? editor.content : current.content)}>Create repository copy</button>}</div></div><SourceEditor path={current.path} value={editor.path === current.path ? editor.content : current.content} dirty={editor.path === current.path && editor.content !== editor.original} onChange={(content) => setEditor({ path: current.path, content, original: current.content, kind: category === 'skills' ? 'skill' : 'prompt' })} onSave={current.worldModelBuilder && current.missing ? () => materializeWorldModelPrompt(editor.content) : current.planningPrompt && current.missing ? () => materializePlanningPrompt(editor.content) : saveEditor} onDownload={current.missing ? null : () => downloadFile(current.path)} onImport={() => importResource(current.worldModelBuilder ? 'world-prompt' : current.planningPrompt ? 'planner-prompt' : category === 'skills' ? 'skill' : 'prompt')} /></> : <Empty title={category === 'skills' ? 'No repository skills yet' : 'No prompts found'} detail={category === 'skills' ? 'Create or import Markdown skills under .github/skills.' : 'Persona, world-model, and planning prompts live in the repository.'} action={category === 'skills' && <button className="primary" onClick={() => setModal({ kind: 'skill', id: '', error: null })}>Create first skill</button>} />}</main>
    {modal?.kind === 'skill' && <DesignerModal title="Create repository skill" detail="The skill is stored as .github/skills/<id>/SKILL.md and is loaded by Copilot for this repository." submitLabel="Create skill" error={modal.error} onCancel={() => setModal(null)} onSubmit={submitSkill}><label><span>Skill ID</span><input autoFocus value={modal.id} placeholder="security-review" onChange={(event) => setModal({ ...modal, id: event.target.value, error: null })} /></label></DesignerModal>}
  </div>;
}

function WorldModel({ data, editor, setEditor, saveEditor, downloadFile, importResource, materializeWorldModelPrompt, addView, removeView }) {
  const [selected, setSelected] = useState('registry');
  const [modal, setModal] = useState(null);
  const current = data.worldModel.files.find((file) => file.path === selected) ?? null;
  const prompt = data.worldModelPrompt;
  function selectPrompt() {
    setSelected('prompt');
    setEditor({ path: prompt.path, content: prompt.content, original: prompt.content, kind: 'prompt' });
  }
  async function submitView() {
    const result = await addView(modal.id.trim());
    if (result) setModal(null);
  }
  return <div className="template-layout"><aside className="file-list world-model-list"><header><span className="eyebrow">Repository grounding</span><h2>World model</h2><div className="repo-only"><StatusDot status="approved" /><span>Repository only</span></div></header><button className={selected === 'registry' ? 'active' : ''} onClick={() => setSelected('registry')}><span>VW</span><div><strong>View registry</strong><small>{data.worldModel.views.length} governed views</small></div></button><button className={selected === 'prompt' ? 'active' : ''} onClick={selectPrompt}><span>PR</span><div><strong>Builder prompt</strong><small>{prompt.missing ? 'create repository copy' : 'editable repository source'}</small></div></button><div className="file-list-divider"><span>Generated outputs</span></div>{data.worldModel.files.map((file) => <button key={file.path} className={current?.path === file.path ? 'active' : ''} onClick={() => setSelected(file.path)}><span>{file.name.endsWith('.md') ? 'MD' : 'JS'}</span><div><strong>{file.name.split('/').at(-1)}</strong><small>{file.name.includes('/') ? file.name.slice(0, file.name.lastIndexOf('/')) : 'root'}</small></div></button>)}</aside>
    <main className="template-main">{selected === 'registry' ? <><div className="world-model-banner"><div><span className="eyebrow">Governed repository context</span><h1>Repository-owned world model</h1><p>Define the approved views that prompts, personas, stages, workflow overrides, and injection rules may consume. A referenced view cannot be removed until every dependency is cleared.</p></div><dl><div><dt>Output</dt><dd>{data.worldModel.root}</dd></div><div><dt>Grounding</dt><dd>{data.definition.worldModel?.grounding ?? 'off'}</dd></div><div><dt>Builder</dt><dd>{data.definition.worldModel?.promptSource ?? 'builtin'}</dd></div></dl><button className="primary compact" onClick={() => setModal({ id: '', error: null })}>＋ Add view</button></div><section className="view-registry"><header><div><span className="eyebrow">Dependency-safe catalog</span><h2>World-model views</h2></div><Pill tone="accent">Validated on every save</Pill></header><div className="view-table"><div className="view-table-head"><span>View</span><span>Structured use</span><span>Markdown prompt use</span><span>Action</span></div>{data.worldModel.views.map((view) => <div className="view-row" key={view.id}><div><span className="view-glyph">{view.id.slice(0, 2).toUpperCase()}</span><strong>{view.id}</strong></div><div className="dependency-list">{view.structuredReferences.length ? view.structuredReferences.map((item) => <code key={item}>{item}</code>) : <span>Not referenced</span>}</div><div className="dependency-list">{view.promptReferences.length ? view.promptReferences.map((item) => <code key={item}>{item}</code>) : <span>Not referenced</span>}</div><button className="ghost compact danger-text" disabled={view.references.length > 0} title={view.references.length ? `Used by ${view.references.join(', ')}` : 'Remove unused view'} onClick={() => removeView(view)}>Remove</button></div>)}</div><div className="dependency-note"><strong>Safe deletion policy</strong><span>Update stage, persona, workflow, injection-rule, and Markdown references first. Invalid YAML or prompt edits are rejected and rolled back atomically.</span></div></section></> : selected === 'prompt' ? <><div className="resource-summary"><div><Pill tone="accent">Editable builder prompt</Pill><span>This prompt controls how repository evidence becomes the governed views above.</span></div><div className="row"><button className="ghost compact" onClick={() => importResource('world-prompt')}>Import</button>{!prompt.missing && <button className="secondary compact" onClick={() => downloadFile(prompt.path)}>Download</button>}{prompt.missing && <button className="primary compact" onClick={() => materializeWorldModelPrompt(editor.path === prompt.path ? editor.content : prompt.content)}>Create repository copy</button>}</div></div><SourceEditor path={prompt.path} value={editor.path === prompt.path ? editor.content : prompt.content} dirty={editor.path === prompt.path && editor.content !== editor.original} onChange={(content) => setEditor({ path: prompt.path, content, original: prompt.content, kind: 'prompt' })} onSave={prompt.missing ? () => materializeWorldModelPrompt(editor.content) : saveEditor} onDownload={prompt.missing ? null : () => downloadFile(prompt.path)} onImport={() => importResource('world-prompt')} /></> : current ? <><div className="resource-summary"><div><Pill>Generated view</Pill><span>Read-only repository snapshot; regenerate it through the world-model lifecycle.</span></div><button className="secondary compact" onClick={() => downloadFile(current.path)}>Download</button></div><SourceEditor path={current.path} value={current.content} readOnly onChange={() => {}} onDownload={() => downloadFile(current.path)} /></> : <Empty title="World model output not found" detail="Run singularity-flow wm build to generate repository-grounded Markdown and evidence." />}</main>
    {modal && <DesignerModal title="Add world-model view" detail="Use a stable lower-case kebab-case ID. Once referenced by a stage, persona, rule, or prompt, the view is protected from deletion." submitLabel="Add view" error={modal.error} onCancel={() => setModal(null)} onSubmit={submitView}><label><span>View ID</span><input autoFocus value={modal.id} placeholder="data-governance" onChange={(event) => setModal({ ...modal, id: event.target.value, error: null })} /></label></DesignerModal>}
  </div>;
}

function Agents({ data, editor, setEditor, chooseAgent, saveEditor, createAgent, deleteFile, downloadFile, importAgent }) {
  const [lockView, setLockView] = useState(false);
  const [modal, setModal] = useState(null);
  const current = data.agents.find((agent) => agent.path === editor.path) ?? data.agents[0];
  const status = data.agentStatus.find((entry) => entry.id === current?.id);
  async function submitAgent() { const result = await createAgent(modal.id.trim()); if (result) setModal(null); }
  return <div className="template-layout"><aside className="file-list"><header><div className="row-between"><div><span className="eyebrow">Agent registry</span><h2>Agents</h2></div><div className="row"><button className="icon-button" title="Import agent" onClick={importAgent}>⇧</button><button className="icon-button" title="Create agent" onClick={() => setModal({ id: '', error: null })}>＋</button></div></div><p className="muted">Remote links are inert until explicitly locked.</p></header>{data.agents.map((agent) => <button key={`${agent.scope}:${agent.path}`} className={!lockView && current?.path === agent.path ? 'active' : ''} onClick={() => { setLockView(false); chooseAgent(agent); }}><span>AG</span><div><strong>{agent.id}</strong><small>{agent.scope} · {agent.remoteResources} remote</small></div></button>)}<button className={lockView ? 'active' : ''} onClick={() => setLockView(true)}><span>RO</span><div><strong>agents.lock.yml</strong><small>read-only · refresh with CLI</small></div></button></aside>
    <main className="template-main">{lockView ? <><header className="template-toolbar"><div><span className="eyebrow">Pinned trust state</span><h1>{data.agentsLock.path}</h1></div><div className="row"><button className="secondary compact" disabled={!data.agentsLock.exists} onClick={() => downloadFile(data.agentsLock.path)}>Download</button><Pill>Read only</Pill></div></header><pre className="lock-preview">{data.agentsLock.content}</pre></> : current ? <><header className="agent-summary"><span><Pill tone={status?.status === 'ready' || status?.status === 'local-only' ? 'good' : 'warn'}>{status?.status ?? 'unknown'}</Pill><small>{current.sha256.slice(0, 12)} · {current.editable ? 'repository Markdown' : 'bundled plugin agent'}</small></span><span className="row"><button className="secondary compact" onClick={() => downloadFile(current.path)}>Download</button>{current.editable && <button className="ghost compact" onClick={() => deleteFile(current)}>Delete</button>}<code>singularity-flow agents {status?.locked ? 'sync' : 'lock'} {current.id}</code></span></header><SourceEditor path={current.path} value={editor.path === current.path ? editor.content : current.content} dirty={current.editable && editor.content !== editor.original} onChange={(content) => current.editable && setEditor({ ...editor, content })} onSave={saveEditor} onDownload={() => downloadFile(current.path)} onImport={current.editable ? importAgent : null} readOnly={!current.editable} /></> : <Empty title="No agents found" detail="Create or import agent Markdown under .github/agents." action={<button className="primary" onClick={() => setModal({ id: '', error: null })}>Create first agent</button>} />}</main>
    {modal && <DesignerModal title="Create repository agent" detail="Create editable agent Markdown with remote-skill, remote-template, and generated-output dependency tables." submitLabel="Create agent" error={modal.error} onCancel={() => setModal(null)} onSubmit={submitAgent}><label><span>Agent ID</span><input autoFocus value={modal.id} placeholder="architecture" onChange={(event) => setModal({ ...modal, id: event.target.value, error: null })} /></label></DesignerModal>}
  </div>;
}

function Documents({ data, action, reload, downloadFile }) {
  const [url, setUrl] = useState('');
  const [label, setLabel] = useState('');
  const [preview, setPreview] = useState(null);
  const [lightbox, setLightbox] = useState(null);
  const [selectedId, setSelectedId] = useState(data.documents[0]?.id ?? '');
  const currentBranch = data.repository.branch;
  const activeBranch = data.workflow?.workItem.branch;
  const canMutate = data.workflow && currentBranch === activeBranch;
  const selectedRecord = data.documents.find((record) => record.id === selectedId) ?? data.documents[0] ?? null;
  const headings = (preview?.content ?? '').split('\n').filter((line) => /^#{1,3}\s+/.test(line)).map((line) => ({ depth: line.match(/^#+/)[0].length, label: line.replace(/^#+\s+/, '') })).slice(0, 12);
  useEffect(() => {
    if (!selectedId && data.documents[0]) setSelectedId(data.documents[0].id);
    if (selectedId && !data.documents.some((record) => record.id === selectedId)) {
      setSelectedId(data.documents[0]?.id ?? '');
      setPreview(null);
    }
  }, [data.documents, selectedId]);
  async function selectPersona(event) { await action(() => window.singularity.selectPersona(data.repository.root, data.selectedWorkId, event.target.value), 'Persona selected'); await reload(); }
  async function upload() { const result = await action(() => window.singularity.uploadDocuments(data.repository.root), 'Documents uploaded'); if (result && !result.canceled) await reload(); }
  async function uploadDirectory() { const result = await action(() => window.singularity.uploadDocumentDirectory(data.repository.root), 'Design package imported and indexed'); if (result && !result.canceled) await reload(); }
  async function addUrl() { if (!url.trim()) return; await action(() => window.singularity.addDocumentUrl(data.repository.root, url.trim(), label.trim()), 'Document link added'); setUrl(''); setLabel(''); await reload(); }
  async function inspect(record) {
    setSelectedId(record.id);
    setPreview(null);
    const result = await action(() => window.singularity.previewDocument(data.repository.root, data.selectedWorkId, record.id));
    if (!result) return;
    if (result.content != null || result.dataUrl || result.record?.type === 'url') setPreview(result);
    else await action(() => window.singularity.openDocument(data.repository.root, data.selectedWorkId, record));
  }
  async function openSelected() { await action(() => window.singularity.openDocument(data.repository.root, data.selectedWorkId, selectedRecord)); }
  if (!data.workflow) return <div className="page"><Empty title="Choose a work item" detail="Documents are cataloged per work item and branch." /></div>;
  return <div className="requirement-workspace"><header className="requirement-toolbar"><div><span className="eyebrow">Requirement workspace</span><h1>{data.workflow.workItem.title}</h1><p>{data.workflow.workItem.id} · {data.workflow.workItem.branch}</p></div><div className="session-control"><label>Session persona</label><select value={data.session?.workId === data.selectedWorkId ? data.session.persona : ''} onChange={selectPersona} disabled={!canMutate}><option value="">Choose persona</option>{Object.entries(data.definition.personas).map(([id, persona]) => <option value={id} key={id}>{persona.label}</option>)}</select></div></header>
    {!canMutate && <div className="notice warn">Work item {data.selectedWorkId} is on branch <strong>{activeBranch}</strong>. Resume that branch before uploading documents.</div>}
    <section className="workspace-uploadbar"><button className="primary" onClick={upload} disabled={!canMutate || data.session?.workId !== data.selectedWorkId}>＋ Upload files</button><button className="secondary" onClick={uploadDirectory} disabled={!canMutate || data.session?.workId !== data.selectedWorkId}>Import design folder</button><div className="workspace-url"><input value={url} onChange={(event) => setUrl(event.target.value)} placeholder="Figma or reference URL" disabled={!canMutate} /><input value={label} onChange={(event) => setLabel(event.target.value)} placeholder="Label" disabled={!canMutate} /><button className="secondary" onClick={addUrl} disabled={!canMutate || !url.trim()}>Add</button></div></section>
    <div className="requirement-layout">
      <aside className="requirement-tree">
        <header><span className="eyebrow">Artifacts</span><h2>Repository documents</h2><small>{data.documents.length} registered</small></header>
        {data.progress.phases.map((phase) => { const records = data.documents.filter((record) => record.phase === phase.id); return <section key={phase.id}><div className="tree-phase"><StatusDot status={phase.status} /><strong>{phase.label}</strong><span>{records.length}</span></div>{records.map((record) => <button className={selectedRecord?.id === record.id ? 'active' : ''} key={record.id} onClick={() => inspect(record)}><span className="doc-icon">{record.mimeType?.startsWith('image/') ? 'IMG' : record.type === 'url' ? 'URL' : 'MD'}</span><span><strong>{record.label}</strong><small>{record.kind}</small></span></button>)}</section>; })}
        {data.documents.filter((record) => !record.phase).map((record) => <button className={selectedRecord?.id === record.id ? 'active' : ''} key={record.id} onClick={() => inspect(record)}><span className="doc-icon">DOC</span><span><strong>{record.label}</strong><small>supporting evidence</small></span></button>)}
      </aside>
      <main className="requirement-document">
        {selectedRecord ? <><header><div><span className="eyebrow">{selectedRecord.id}</span><h2>{selectedRecord.label}</h2><p>{selectedRecord.path ?? selectedRecord.url}</p></div><div className="row"><Pill>{selectedRecord.kind}</Pill>{selectedRecord.path && <button className="secondary compact" onClick={() => downloadFile(selectedRecord.path)}>Download</button>}</div></header><PinnedMediaStrip repository={data.repository.root} workId={data.selectedWorkId} records={data.documents} selectedId={selectedRecord.id} onSelect={inspect} />{preview?.record.id === selectedRecord.id && preview.dataUrl ? <div className="requirement-media-preview"><GovernedMedia record={selectedRecord} preview={preview} onZoom={(record, media) => setLightbox({ record, preview: media })} /></div> : preview?.record.id === selectedRecord.id && preview.content != null ? <TemplatePreview className="requirement-preview" content={preview.content} /> : preview?.record.id === selectedRecord.id && selectedRecord.type === 'url' ? <div className="live-design-card"><span className="live-design-mark">↗</span><h3>{selectedRecord.kind === 'figma' ? 'Open in Figma' : 'Open external reference'}</h3><p><strong>Live design — may differ from the pinned intake.</strong> Use committed image exports for approval; open this link only as current-design context.</p><code>{selectedRecord.url}</code><button className="primary" onClick={openSelected}>{selectedRecord.kind === 'figma' ? 'Open in Figma' : 'Open HTTPS link'}</button></div> : <div className="document-placeholder"><span>{selectedRecord.mimeType?.startsWith('image/') ? 'IMG' : selectedRecord.type === 'url' ? 'URL' : 'MD'}</span><h3>Open the governed document</h3><p>Images and PDFs preview inside Singularity with their committed SHA. Other binary files use their native viewer.</p><button className="primary" onClick={() => inspect(selectedRecord)}>Open document</button></div>}<MediaLightbox item={lightbox} onClose={() => setLightbox(null)} /></> : <Empty title="No documents yet" detail="Upload source material or generate the current phase artifact to populate this workspace." />}
      </main>
      <aside className="requirement-inspector">
        <section><span className="eyebrow">Git status</span><dl><div><dt>Branch</dt><dd>{data.repository.branch}</dd></div><div><dt>Workflow</dt><dd>{data.workflow.status}</dd></div><div><dt>Phase</dt><dd>{selectedRecord?.phase ?? 'supporting'}</dd></div><div><dt>Persona</dt><dd>{data.session?.persona ?? 'not selected'}</dd></div></dl></section>
        <section><span className="eyebrow">Document metadata</span><dl><div><dt>Kind</dt><dd>{selectedRecord?.kind ?? '—'}</dd></div><div><dt>Size</dt><dd>{selectedRecord?.size ? `${Math.ceil(selectedRecord.size / 1024)} KB` : '—'}</dd></div><div><dt>Reference</dt><dd>{selectedRecord?.id ?? '—'}</dd></div><div><dt>SHA-256</dt><dd>{selectedRecord?.sha256?.slice(0, 12) ?? '—'}</dd></div><div><dt>Integrity</dt><dd>{preview?.record.id === selectedRecord?.id && preview.integrity === 'verified' ? 'matches record ✓' : 'verify on preview'}</dd></div></dl></section>
        <section className="document-outline"><span className="eyebrow">Outline</span>{headings.length ? headings.map((heading, index) => <span style={{ paddingLeft: `${(heading.depth - 1) * 12}px` }} key={`${heading.label}:${index}`}>{heading.label}</span>) : <p>Open a Markdown artifact to see its governed section outline.</p>}</section>
      </aside>
    </div>
    <div className="workspace-command"><span className="ai-orb">✦</span><div><strong>Ask Singularity</strong><small>Use Planning Copilot to refine this requirement with its complete governed context.</small></div><code>/sflow-next</code></div>
  </div>;
}

export default function App() {
  const [data, setData] = useState(null);
  const [onboarding, setOnboarding] = useState(null);
  const [onboardingLoading, setOnboardingLoading] = useState(true);
  const [onboardingError, setOnboardingError] = useState(null);
  const [onboardingAttempt, setOnboardingAttempt] = useState(0);
  const [page, setPage] = useState('dashboard');
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState(null);
  const [standaloneHelp, setStandaloneHelp] = useState(false);
  const [recentRepositories, setRecentRepositories] = useState([]);
  const [recentWorkspaces, setRecentWorkspaces] = useState([]);
  const [repositoryMenu, setRepositoryMenu] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => window.localStorage.getItem('singularity.sidebar.collapsed') === 'true');
  const [editor, setEditor] = useState({ path: '', content: '', original: '', kind: 'workflow' });

  useEffect(() => {
    let current = true;
    setOnboardingLoading(true);
    setOnboardingError(null);
    Promise.resolve()
      .then(() => {
        if (!window.singularity?.onboarding) throw new Error('The secure desktop bridge is unavailable. Restart Singularity Desktop.');
        return window.singularity.onboarding();
      })
      .then((result) => { if (current) setOnboarding(result); })
      .catch((error) => {
        if (!current) return;
        setOnboarding(null);
        setOnboardingError(error?.message || String(error));
      })
      .finally(() => { if (current) setOnboardingLoading(false); });
    return () => { current = false; };
  }, [onboardingAttempt]);
  useEffect(() => { if (data && !editor.path) setEditor({ path: data.definitionPath, content: data.definitionText, original: data.definitionText, kind: 'workflow' }); }, [data, editor.path]);
  useEffect(() => { if (toast?.tone !== 'good') return undefined; const timer = setTimeout(() => setToast(null), 5000); return () => clearTimeout(timer); }, [toast]);
  useEffect(() => {
    if (!window.singularity?.recentRepositories) return undefined;
    let current = true;
    window.singularity.recentRepositories().then((items) => { if (current) setRecentRepositories(items); }).catch((error) => { if (current) setToast({ tone: 'bad', text: `Could not load recent repositories: ${error.message}` }); });
    return () => { current = false; };
  }, []);
  useEffect(() => {
    if (!window.singularity?.recentWorkspaces) return undefined;
    let current = true;
    window.singularity.recentWorkspaces().then((items) => { if (current) setRecentWorkspaces(items); }).catch((error) => { if (current) setToast({ tone: 'bad', text: `Could not load recent workspaces: ${error.message}` }); });
    return () => { current = false; };
  }, []);
  useEffect(() => {
    if (!repositoryMenu) return undefined;
    const closeOutside = (event) => { if (!event.target.closest?.('.repo-switcher')) setRepositoryMenu(false); };
    const closeEscape = (event) => { if (event.key === 'Escape') setRepositoryMenu(false); };
    document.addEventListener('mousedown', closeOutside); document.addEventListener('keydown', closeEscape);
    return () => { document.removeEventListener('mousedown', closeOutside); document.removeEventListener('keydown', closeEscape); };
  }, [repositoryMenu]);
  useEffect(() => {
    window.localStorage.setItem('singularity.sidebar.collapsed', String(sidebarCollapsed));
  }, [sidebarCollapsed]);
  useEffect(() => {
    const toggleNavigation = (event) => {
      if (!(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== 'b') return;
      const target = event.target;
      if (target instanceof HTMLElement && (target.isContentEditable || ['INPUT', 'SELECT', 'TEXTAREA'].includes(target.tagName))) return;
      event.preventDefault();
      setSidebarCollapsed((current) => !current);
    };
    window.addEventListener('keydown', toggleNavigation);
    return () => window.removeEventListener('keydown', toggleNavigation);
  }, []);
  const repoName = useMemo(() => data?.repository.root.split('/').at(-1), [data]);
  const activeNavigation = useMemo(() => navSections.flatMap((section) => section.items.map(([id, label]) => ({ id, label, section: section.label }))).find((item) => item.id === page) ?? { id: page, label: 'Workspace', section: 'Singularity' }, [page]);
  const configurationChanges = data?.repository.configurationChanges ?? [];
  const unrelatedChanges = data?.repository.unrelatedChanges ?? [];
  const publishReady = data?.repository.publishReady === true;
  const publishHint = !configurationChanges.length ? 'No workflow, template, persona, prompt, skill, or agent changes are ready to publish.' : unrelatedChanges.length ? `Blocked by ${unrelatedChanges.length} non-configuration working-tree change(s).` : 'Commit and push desktop configuration changes.';
  async function action(task, success) { setBusy(true); setToast(null); try { const result = await task(); if (success && result != null) setToast({ tone: 'good', text: success }); return result; } catch (error) { setToast({ tone: 'bad', text: error?.message || String(error) }); return null; } finally { setBusy(false); } }
  async function refreshRecentRepositories() {
    try { const items = await window.singularity.recentRepositories(); setRecentRepositories(items); return items; }
    catch (error) { setToast({ tone: 'bad', text: `Could not load recent repositories: ${error.message}` }); return []; }
  }
  async function refreshRecentWorkspaces() {
    try { const items = await window.singularity.recentWorkspaces(); setRecentWorkspaces(items); return items; }
    catch (error) { setToast({ tone: 'bad', text: `Could not load recent workspaces: ${error.message}` }); return []; }
  }
  function acceptOpened(result, nextPage = null) {
    setData(result);
    setEditor({ path: result.definitionPath, content: result.definitionText, original: result.definitionText, kind: 'workflow' });
    setRepositoryMenu(false);
    if (nextPage) setPage(nextPage);
  }
  async function openRepository(repositoryPath = null) {
    const result = await action(() => repositoryPath ? window.singularity.openRepository(repositoryPath) : window.singularity.chooseRepository());
    if (result) {
      acceptOpened(result);
      await refreshRecentRepositories();
      await refreshRecentWorkspaces();
      if (result.repository.migration) setToast({ tone: 'good', text: `Moved ${result.repository.migration.from}/ to ${result.repository.migration.to}/. Review the working-tree rename, then use Commit & push when ready.` });
    }
  }
  async function openWorkspace(workspacePath = null) {
    const result = await action(() => workspacePath ? window.singularity.openWorkspace(workspacePath) : window.singularity.chooseWorkspace());
    if (!result) return;
    acceptOpened(result, 'workspaces');
    await refreshRecentRepositories();
    await refreshRecentWorkspaces();
  }
  async function completeOnboarding(result) {
    setOnboarding(result);
    await refreshRecentRepositories();
    const firstRepository = result.profile.repositories?.[0];
    if (firstRepository) await openRepository(firstRepository.path);
    if (result.notices?.length) {
      setToast({ tone: 'warning', text: result.notices.map((notice) => notice.message).join(' ') });
    }
  }
  async function forgetRepository(event, repositoryPath) {
    event.stopPropagation();
    const items = await action(() => window.singularity.forgetRepository(repositoryPath), 'Repository removed from recent locations');
    if (items) setRecentRepositories(items);
  }
  async function forgetWorkspace(event, workspacePath) {
    event.stopPropagation();
    const items = await action(() => window.singularity.forgetWorkspace(workspacePath), 'Workspace forgotten; no local files were deleted');
    if (items) setRecentWorkspaces(items);
  }
  async function reload(workId = data?.selectedWorkId, initiativeId = data?.selectedInitiativeId) { if (!data) return null; const result = await action(() => window.singularity.snapshot(data.repository.root, workId, initiativeId)); if (result) setData(result); return result; }
  async function refreshInbox() { const result = await action(() => window.singularity.refreshInbox(data.repository.root), 'Remote approval inbox refreshed'); if (result) setData(result); return result; }
  async function attachInboxItem(workId) { const result = await action(() => window.singularity.attachInboxItem(data.repository.root, workId), `Attached to ${workId} at the latest remote commit`); if (result) { setData(result); setPage('review'); } return result; }
  async function selectWorkItem(event) { await reload(event.target.value || null); }
  async function selectInitiative(event) { const result = await reload(null, event.target.value || null); if (result && event.target.value) setPage('initiatives'); }
  async function saveEditor() { const result = await action(() => window.singularity.saveFile(data.repository.root, editor.path, editor.content), `${editor.path} saved and validated`); if (result) { setEditor({ ...editor, original: editor.content }); await reload(); } }
  async function validate() { await action(() => window.singularity.validate(data.repository.root), 'Configuration is valid'); }
  async function publish() { if (!publishReady) return setToast({ tone: 'bad', text: publishHint }); const result = await action(() => window.singularity.publish(data.repository.root, 'Configure Singularity Flow desktop workflow'), 'Configuration committed and published'); if (result) await reload(); }
  function workflowPage() { setPage('workflow'); setEditor({ path: data.definitionPath, content: data.definitionText, original: data.definitionText, kind: 'workflow' }); }
  function initiativePage() { setPage('initiatives'); if (data.portfolioText) setEditor({ path: data.portfolioPath, content: data.portfolioText, original: data.portfolioText, kind: 'portfolio' }); }
  function acceptPortfolioBootstrap(snapshot) {
    setData(snapshot);
    setEditor({ path: snapshot.portfolioPath, content: snapshot.portfolioText, original: snapshot.portfolioText, kind: 'portfolio' });
  }
  function openPlanningPrompt() {
    const prompt = data.planning.prompt;
    setEditor({ path: prompt.path, content: prompt.content, original: prompt.content, kind: 'prompt' });
    setPage('resources');
  }
  async function downloadFile(filePath) {
    if (!filePath) return null;
    const result = await action(() => window.singularity.downloadFile(data.repository.root, filePath));
    if (result && !result.canceled) setToast({ tone: 'good', text: `Downloaded ${filePath} to ${result.path}` });
    return result;
  }
  async function exportBundle() {
    const result = await action(() => window.singularity.exportBundle(data.repository.root));
    if (result && !result.canceled) setToast({ tone: 'good', text: `Exported ${result.files} YAML/Markdown files to ${result.path}. World-model files remain repository-owned snapshots.` });
    return result;
  }
  async function importFile(options, success) {
    const result = await action(() => window.singularity.importFile(data.repository.root, options), success);
    if (!result || result.canceled) return null;
    const snapshot = await reload();
    return { result, snapshot };
  }
  async function importWorkflow() {
    const imported = await importFile({ targetPath: data.definitionPath }, 'Workflow YAML imported and validated');
    if (imported) setEditor({ path: imported.snapshot.definitionPath, content: imported.snapshot.definitionText, original: imported.snapshot.definitionText, kind: 'workflow' });
  }
  function chooseTemplate(file) { setEditor({ path: file.path, content: file.content, original: file.content, kind: 'template' }); }
  async function createTemplate(name) {
    const content = '# {{work.id}} — {{phase.label}}\n\n## Purpose\n\nDescribe the artifact outcome.\n\n{{inputs}}\n\n## Evidence\n\nAdd traceable evidence here.\n';
    const result = await action(() => window.singularity.saveFile(data.repository.root, templateRepositoryPath(data.definition, name), content), 'Artifact template created');
    if (!result) return null;
    const snapshot = await reload();
    const file = snapshot?.templates.find((item) => item.path === result.path);
    if (file) chooseTemplate(file);
    return result;
  }
  async function deleteTemplate(file) {
    const result = await action(() => window.singularity.deleteTemplate(data.repository.root, file.path), 'Artifact template deleted');
    if (!result) return null;
    const snapshot = await reload();
    const replacement = snapshot?.templates[0];
    setEditor(replacement ? { path: replacement.path, content: replacement.content, original: replacement.content, kind: 'template' } : { path: '', content: '', original: '', kind: 'template' });
    return result;
  }
  async function importTemplate() {
    const imported = await importFile({ targetDirectory: data.definition.templatesRoot, kind: 'template' }, 'Artifact template imported');
    if (!imported) return null;
    const file = imported.snapshot.templates.find((item) => item.path === imported.result.path);
    if (file) chooseTemplate(file);
    return imported.result;
  }
  async function savePersona(personaId, persona) {
    const next = structuredClone(data.definition);
    next.personas[personaId] = persona;
    const result = await action(() => window.singularity.saveFile(data.repository.root, data.definitionPath, YAML.stringify(next)), `Persona '${personaId}' saved and validated`);
    if (result) await reload();
    return result;
  }
  async function createPersonaConfig(values) {
    let next;
    try { next = createPersona(data.definition, values); }
    catch (error) { setToast({ tone: 'bad', text: error.message }); return null; }
    const id = values.id.trim();
    const persona = next.personas[id];
    const promptPath = personaPromptRepositoryPath(next, persona.prompt);
    const prompt = `# ${persona.label}\n\n${persona.description}\n\n## Perspective\n\nAct as the **${persona.label}** persona. Apply this perspective to the current phase while preserving its governed contract, required repository world-model views, approved inputs, and evidence requirements.\n`;
    const promptResult = await action(() => window.singularity.saveFile(data.repository.root, promptPath, prompt));
    if (!promptResult) return null;
    const result = await action(() => window.singularity.saveFile(data.repository.root, data.definitionPath, YAML.stringify(next)), `Persona '${id}' and prompt created`);
    if (result) await reload();
    return result;
  }
  async function deletePersonaConfig(personaId, replacementId) {
    let next;
    try { next = removePersona(data.definition, personaId, replacementId); }
    catch (error) { setToast({ tone: 'bad', text: error.message }); return null; }
    const oldPrompt = data.definition.personas[personaId].prompt;
    const promptStillUsed = Object.values(next.personas).some((persona) => persona.prompt === oldPrompt);
    const result = await action(() => window.singularity.saveFile(data.repository.root, data.definitionPath, YAML.stringify(next)), `Persona '${personaId}' removed; references moved to '${replacementId}'`);
    if (!result) return null;
    if (!promptStillUsed && data.personaPrompts.some((file) => file.name === oldPrompt)) await action(() => window.singularity.deleteFile(data.repository.root, personaPromptRepositoryPath(data.definition, oldPrompt)));
    await reload();
    return result;
  }
  function chooseResource(file, kind) { setEditor({ path: file.path, content: file.content, original: file.content, kind }); }
  function resourcesPage() {
    setPage('resources');
    const file = data.personaPrompts[0] ?? data.worldModelPrompt ?? data.repositorySkills[0];
    if (file) chooseResource(file, data.repositorySkills.includes(file) ? 'skill' : 'prompt');
  }
  async function importResource(kind) {
    const options = kind === 'skill'
      ? { targetDirectory: '.github/skills', kind: 'skill' }
      : kind === 'world-prompt'
        ? { targetPath: data.worldModelPrompt.path, kind: 'prompt' }
        : kind === 'planner-prompt'
          ? { targetPath: data.planning.prompt.path, kind: 'prompt' }
        : { targetDirectory: data.definition.personaPromptsRoot, kind: 'prompt' };
    const imported = await importFile(options, `${kind === 'skill' ? 'Repository skill' : 'Prompt'} imported`);
    if (!imported) return null;
    let snapshot = imported.snapshot;
    if (kind === 'world-prompt' && (data.definition.worldModel?.promptSource ?? 'builtin') === 'builtin') {
      const next = structuredClone(data.definition);
      next.worldModel ??= {};
      next.worldModel.promptSource = data.worldModelPrompt.path;
      const configured = await action(() => window.singularity.saveFile(data.repository.root, data.definitionPath, YAML.stringify(next)), 'World-model builder prompt imported and configured');
      if (!configured) return null;
      snapshot = await reload();
    }
    const files = kind === 'skill' ? snapshot.repositorySkills : [...snapshot.personaPrompts, snapshot.worldModelPrompt, snapshot.planning.prompt];
    const file = files.find((item) => item.path === imported.result.path);
    if (file) chooseResource(file, kind === 'skill' ? 'skill' : 'prompt');
    return imported.result;
  }
  async function createSkill(skillId) {
    let skillPath;
    try { skillPath = repositorySkillPath(skillId); }
    catch (error) { setToast({ tone: 'bad', text: error.message }); return null; }
    const content = `---\nname: ${skillId}\ndescription: Repository-specific ${skillId.replaceAll('-', ' ')} guidance.\n---\n\n# ${skillId.replaceAll('-', ' ')}\n\nUse this skill when its repository-specific guidance applies.\n\n## Instructions\n\n- Ground decisions in the current repository and approved Singularity Flow artifacts.\n- Preserve phase boundaries, traceability, and configured approval rules.\n`;
    const result = await action(() => window.singularity.saveFile(data.repository.root, skillPath, content), `Repository skill '${skillId}' created`);
    if (!result) return null;
    const snapshot = await reload();
    const file = snapshot?.repositorySkills.find((item) => item.path === skillPath);
    if (file) chooseResource(file, 'skill');
    return result;
  }
  async function deleteFile(file) {
    if (!file?.path) return null;
    const result = await action(() => window.singularity.deleteFile(data.repository.root, file.path), `${file.path} deleted`);
    if (!result) return null;
    const snapshot = await reload();
    const candidates = page === 'agents' ? snapshot?.agents.filter((item) => item.editable) : snapshot?.repositorySkills;
    const replacement = candidates?.[0];
    setEditor(replacement ? { path: replacement.path, content: replacement.content, original: replacement.content, kind: page === 'agents' ? 'agent' : 'skill' } : { path: '', content: '', original: '', kind: page === 'agents' ? 'agent' : 'skill' });
    return result;
  }
  async function materializeWorldModelPrompt(content = data.worldModelPrompt.content) {
    const prompt = data.worldModelPrompt;
    const result = await action(() => window.singularity.saveFile(data.repository.root, prompt.path, content));
    if (!result) return null;
    if ((data.definition.worldModel?.promptSource ?? 'builtin') === 'builtin') {
      const next = structuredClone(data.definition);
      next.worldModel ??= {};
      next.worldModel.promptSource = prompt.path;
      const definitionResult = await action(() => window.singularity.saveFile(data.repository.root, data.definitionPath, YAML.stringify(next)), 'Repository world-model builder prompt created and configured');
      if (!definitionResult) return null;
    }
    const snapshot = await reload();
    chooseResource(snapshot.worldModelPrompt, 'prompt');
    return result;
  }
  async function materializePlanningPrompt(content = data.planning.prompt.content) {
    const prompt = data.planning.prompt;
    const result = await action(() => window.singularity.saveFile(data.repository.root, prompt.path, content), 'Repository Copilot planning prompt created');
    if (!result) return null;
    const snapshot = await reload();
    chooseResource(snapshot.planning.prompt, 'prompt');
    return result;
  }
  async function addWorldModelViewConfig(viewId) {
    let next;
    try { next = addWorldModelView(data.definition, viewId); }
    catch (error) { setToast({ tone: 'bad', text: error.message }); return null; }
    const result = await action(() => window.singularity.saveFile(data.repository.root, data.definitionPath, YAML.stringify(next)), `World-model view '${viewId}' added and validated`);
    if (result) await reload();
    return result;
  }
  async function removeWorldModelViewConfig(view) {
    let next;
    try { next = removeWorldModelView(data.definition, view.id, view.promptReferences.map((file) => `Markdown '${file}'`)); }
    catch (error) { setToast({ tone: 'bad', text: error.message }); return null; }
    const result = await action(() => window.singularity.saveFile(data.repository.root, data.definitionPath, YAML.stringify(next)), `Unused world-model view '${view.id}' removed`);
    if (result) await reload();
    return result;
  }
  function chooseAgent(agent) { setEditor({ path: agent.path, content: agent.content, original: agent.content, kind: 'agent' }); }
  async function createAgent(agentId) {
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(agentId)) { setToast({ tone: 'bad', text: 'Agent ID must be lower-case kebab-case.' }); return null; }
    const agentPath = `.github/agents/${agentId}.agent.md`;
    const title = agentId.replaceAll('-', ' ');
    const content = `---\nname: ${agentId}\ndescription: Repository agent for ${title}.\n---\n\n# ${title}\n\nActivate the relevant Singularity Flow session and use approved repository artifacts as governed context.\n\n## Remote skills\n\n| ID | URL | Phases | Personas | Optional | Max bytes |\n| --- | --- | --- | --- | --- | --- |\n\n## Remote artifact templates\n\n| ID | URL | Phases | Optional | Max bytes |\n| --- | --- | --- | --- | --- |\n\n## Remote generated artifacts\n\n| ID | URL template | Phase | Target | Optional | Max bytes |\n| --- | --- | --- | --- | --- | --- |\n`;
    const result = await action(() => window.singularity.saveFile(data.repository.root, agentPath, content), `Repository agent '${agentId}' created`);
    if (!result) return null;
    const snapshot = await reload();
    const agent = snapshot?.agents.find((item) => item.path === agentPath);
    if (agent) chooseAgent(agent);
    return result;
  }
  async function importAgent() {
    const imported = await importFile({ targetDirectory: '.github/agents', kind: 'agent' }, 'Repository agent imported and validated');
    if (!imported) return null;
    const agent = imported.snapshot.agents.find((item) => item.path === imported.result.path);
    if (agent) chooseAgent(agent);
    return imported.result;
  }
  function openPrompt(file) { setEditor({ path: file.path, content: file.content, original: file.content, kind: 'prompt' }); setPage('resources'); }
  function agentsPage() { setPage('agents'); if (data.agents[0]) chooseAgent(data.agents[0]); }

  if (onboardingLoading) return <div className="onboarding-loading"><div className="brand large"><span>S</span><div><strong>Singularity</strong><small>Preparing desktop setup</small></div></div><span className="onboarding-loading-orb">✦</span></div>;
  if (!data && standaloneHelp) return <div className="standalone-help"><button className="ghost help-back" onClick={() => setStandaloneHelp(false)}>← Back</button><Help /></div>;
  if (onboardingError) return <OnboardingLoadFailure error={onboardingError} retry={() => setOnboardingAttempt((current) => current + 1)} help={() => setStandaloneHelp(true)} />;
  if (!onboarding?.profile?.completed) return <><OnboardingWizard initial={onboarding.profile} jira={onboarding.jira} onComplete={completeOnboarding} onHelp={() => setStandaloneHelp(true)} /><Toast toast={toast} onClose={() => setToast(null)} /></>;
  if (!data) return <div className={`welcome ${busy ? 'busy' : ''}`}><header className="welcome-nav"><div className="brand large"><span>S</span><div><strong>Singularity</strong><small>Git-native delivery</small></div></div><nav><button onClick={() => setStandaloneHelp(true)}>How it works</button><button onClick={() => setStandaloneHelp(true)}>Documentation</button><button className="secondary" onClick={() => openWorkspace()} disabled={busy}>Open workspace</button><button className="primary" onClick={() => openRepository()} disabled={busy}>Open repository</button></nav></header><main className="welcome-hero"><section><Pill tone="accent">Plan · govern · deliver</Pill><h1>The Git-backed<br /><em>delivery engine.</em></h1><p>Turn requirements into approved artifacts, executable plans, and cross-repository delivery—without losing human judgment or audit history.</p><div className="welcome-actions"><button className="primary large-button" onClick={() => openWorkspace()} disabled={busy}>{busy ? 'Opening…' : 'Open a project workspace'}</button><button className="secondary large-button" onClick={() => openRepository()} disabled={busy}>{busy ? 'Opening repository…' : 'Open one repository'}</button><button className="ghost large-button" onClick={() => setStandaloneHelp(true)} disabled={busy}>Open help</button></div>{busy && <p className="opening-state" role="status">Validating the repository and loading workflow state…</p>}</section><section className="welcome-visual" aria-label="Singularity workflow preview"><div className="visual-glow" /><div className="visual-window"><header><span>SINGULARITY</span><i /><i /><i /></header><div className="visual-body"><aside><span className="active">Workspace</span><span>Artifacts</span><span>Planning Copilot</span><span>Impact analysis</span></aside><main><span className="eyebrow">Jira-anchored delivery</span><h3>Initiative across repositories</h3><div className="visual-flow"><b className="done">✓</b><i /><b className="done">✓</b><i /><b>3</b><i /><b>4</b></div><div className="visual-cards"><span /><span /><span /></div></main></div></div></section></main><section className="welcome-recent"><RecentWorkspaces items={recentWorkspaces} busy={busy} onOpen={openWorkspace} onForget={forgetWorkspace} /><RecentRepositories items={recentRepositories} busy={busy} onOpen={openRepository} onForget={forgetRepository} /></section><Toast toast={toast} onClose={() => setToast(null)} /></div>;
  return <div className={`shell ${sidebarCollapsed ? 'sidebar-collapsed' : ''}`}>
    <aside className="sidebar"><div className="brand"><span>S</span><div><strong>Singularity</strong><small>{data.workspace ? data.workspace.workspace.anchor.key : 'Flow workspace'}</small></div></div><button className="sidebar-edge-toggle" type="button" title={`${sidebarCollapsed ? 'Expand' : 'Collapse'} navigation (⌘/Ctrl+B)`} aria-label={sidebarCollapsed ? 'Expand navigation' : 'Collapse navigation'} aria-expanded={!sidebarCollapsed} aria-controls="primary-navigation" onClick={() => setSidebarCollapsed((current) => !current)}><NavIcon name={sidebarCollapsed ? 'expand' : 'collapse'} /></button><nav id="primary-navigation" aria-label="Primary navigation">{navSections.map((section) => <section key={section.label}><span className="nav-section-label">{section.label}</span>{section.items.map(([id, label]) => <button key={id} title={sidebarCollapsed ? label : undefined} aria-label={label} className={page === id ? 'active' : ''} onClick={() => id === 'workflow' ? workflowPage() : id === 'initiatives' ? initiativePage() : id === 'resources' ? resourcesPage() : id === 'agents' ? agentsPage() : setPage(id)}><i><NavIcon name={id} /></i><span className="nav-label">{label}</span>{id === 'inbox' && data.approvalInbox.count > 0 && <span className="nav-badge">{data.approvalInbox.count}</span>}</button>)}</section>)}</nav><div className="sidebar-bottom"><div className="repo-switcher"><div className="repo-card"><span className="repo-icon">{repoName?.slice(0, 1).toUpperCase()}</span><div><strong>{data.workspace?.workspace.name ?? repoName}</strong><small>{repoName} · {data.repository.branch} · singularity/</small></div><button title="Switch workspace or repository" aria-label="Switch workspace or repository" onClick={() => setRepositoryMenu(!repositoryMenu)}>⋯</button></div>{repositoryMenu && <div className="repository-menu"><RecentWorkspaces items={recentWorkspaces} currentPath={data.workspace?.workspace.path} busy={busy} onOpen={openWorkspace} onForget={forgetWorkspace} compact /><RecentRepositories items={recentRepositories} currentPath={data.repository.root} busy={busy} onOpen={openRepository} onForget={forgetRepository} compact /><button className="secondary repository-browse" onClick={() => openWorkspace()} disabled={busy}>＋ Open workspace</button><button className="secondary repository-browse" onClick={() => openRepository()} disabled={busy}>＋ Open another repository</button></div>}</div><div className={`connection ${data.repository.changes.length ? 'dirty' : ''}`}><span /><em>{data.repository.changes.length ? `${data.repository.changes.length} uncommitted change(s)` : data.workspace ? `${data.workspace.counts.ready}/${data.workspace.counts.repositories} repositories ready` : 'Working tree clean'}</em></div></div></aside>
    <main className="content"><header className="topbar"><div className="topbar-leading"><div className="page-context"><span>{activeNavigation.section}</span><strong>{activeNavigation.label}</strong></div><div className="context-selectors"><select aria-label="Work item" value={data.selectedWorkId ?? ''} onChange={selectWorkItem}><option value="">Story work item</option>{data.workItems.map((item) => <option value={item.id} key={item.id}>{item.id} — {item.title}</option>)}</select>{data.portfolio && <select aria-label="Initiative" value={data.selectedInitiativeId ?? ''} onChange={selectInitiative}><option value="">Initiative</option>{data.initiatives.map((item) => <option value={item.id} key={item.id}>{item.id} — {item.title}</option>)}</select>}{data.workflow && <Pill tone="accent">{data.workflow.currentPhase ?? 'complete'}</Pill>}{data.initiative && <Pill tone="accent">{data.initiative.state.currentPhase ?? 'complete'}</Pill>}</div></div><div className="topbar-title" aria-live="polite"><span>{activeNavigation.section}</span><strong>{activeNavigation.label}</strong></div><div className="topbar-actions"><CopilotServiceControl repository={data.repository.root} notify={setToast} /><button className="ghost icon-action" onClick={() => reload()} disabled={busy} title="Refresh workspace"><NavIcon name="refresh" /><span>Refresh</span></button><button className="ghost icon-action" onClick={exportBundle} disabled={busy} title="Download configuration"><NavIcon name="download" /><span>Download config</span></button><button className="secondary icon-action" onClick={validate} disabled={busy}><NavIcon name="validate" /><span>Validate</span></button><button className="primary icon-action" onClick={publish} disabled={busy || !publishReady} title={publishHint}><NavIcon name="publish" /><span>Commit & push</span></button></div></header>
      <div className={busy ? 'busy view' : 'view'}><div className="page-stage" key={page}>{page === 'dashboard' && <Dashboard data={data} />}{page === 'studio' && <ArtifactStudio data={data} downloadFile={downloadFile} openWorkspace={() => setPage('documents')} />}{page === 'impact' && <ImpactStudio data={data} openPlanning={() => setPage('planning')} />}{page === 'workspaces' && <WorkspaceStudio data={data} action={action} defaultBaseDirectory={onboarding?.profile?.workspacePath ?? ''} onOpened={(result, nextPage) => { acceptOpened(result, nextPage); void refreshRecentRepositories(); void refreshRecentWorkspaces(); }} onConfigureJira={() => setPage('jira')} />}{page === 'initiatives' && <InitiativeStudio data={data} editor={editor} setEditor={setEditor} saveEditor={saveEditor} downloadFile={downloadFile} action={action} reload={reload} bootstrapPortfolio={acceptPortfolioBootstrap} />}{page === 'jira' && <JiraWorkspace data={data} action={action} reload={reload} onConfigure={initiativePage} bootstrapPortfolio={acceptPortfolioBootstrap} />}{page === 'planning' && <PlanningStudio data={data} action={action} reload={reload} openPlanningPrompt={openPlanningPrompt} profileRole={onboarding?.profile?.role} />}{page === 'inbox' && <ApprovalInbox data={data} busy={busy} refresh={refreshInbox} attach={attachInboxItem} />}{page === 'workflow' && <Workflow data={data} editor={editor} setEditor={setEditor} saveEditor={saveEditor} downloadFile={downloadFile} importWorkflow={importWorkflow} />}{page === 'personas' && <Personas data={data} openPrompt={openPrompt} savePersona={savePersona} createPersonaConfig={createPersonaConfig} deletePersonaConfig={deletePersonaConfig} downloadFile={downloadFile} />}{page === 'templates' && <Templates data={data} editor={editor.kind !== 'template' ? { path: data.templates[0]?.path, content: data.templates[0]?.content ?? '', original: data.templates[0]?.content ?? '', kind: 'template' } : editor} setEditor={setEditor} chooseTemplate={chooseTemplate} saveEditor={saveEditor} createTemplate={createTemplate} deleteTemplate={deleteTemplate} downloadFile={downloadFile} importTemplate={importTemplate} />}{page === 'resources' && <Resources data={data} editor={editor} setEditor={setEditor} chooseResource={chooseResource} saveEditor={saveEditor} createSkill={createSkill} deleteFile={deleteFile} downloadFile={downloadFile} importResource={importResource} materializeWorldModelPrompt={materializeWorldModelPrompt} materializePlanningPrompt={materializePlanningPrompt} />}{page === 'agents' && <Agents data={data} editor={editor} setEditor={setEditor} chooseAgent={chooseAgent} saveEditor={saveEditor} createAgent={createAgent} deleteFile={deleteFile} downloadFile={downloadFile} importAgent={importAgent} />}{page === 'world-model' && <WorldModel data={data} editor={editor} setEditor={setEditor} saveEditor={saveEditor} downloadFile={downloadFile} importResource={importResource} materializeWorldModelPrompt={materializeWorldModelPrompt} addView={addWorldModelViewConfig} removeView={removeWorldModelViewConfig} />}{page === 'review' && <Review data={data} downloadFile={downloadFile} />}{page === 'documents' && <Documents data={data} action={action} reload={reload} downloadFile={downloadFile} />}{page === 'help' && <Help />}</div></div>
    </main><Toast toast={toast} onClose={() => setToast(null)} />
  </div>;
}
