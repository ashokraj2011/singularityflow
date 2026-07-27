import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Editor, { DiffEditor } from '@monaco-editor/react';
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
  ARTIFACT_SECTION_LIBRARY,
  addArtifactSection,
  moveArtifactSection,
  parseArtifactTemplate,
  removeArtifactSection,
  serializeArtifactTemplate,
  updateArtifactSection
} from './artifact-builder.mjs';
import { workspaceLandingPage } from './workspace-routing.mjs';
// Shared with the CLI so the app and the terminal agree on what comes next.
import { nextInitiativeAction, normalizeNextActionId, NEXT_ACTIONS } from '../../../src/initiative-next.mjs';
import { PHASE_SCOPE } from '../../../src/planning-scope.mjs';
import {
  GovernedMedia,
  MediaLightbox,
  PinnedMediaStrip,
  VisualComparisonReview
} from './VisualReview.jsx';

// One navigation for everyone. The Business and Engineer experiences used to be separate shells
// with separate menus, which meant the Epic planning journey existed only in Business and the
// configuration tools only in Engineer. This is the union, in the Engineer shell: every
// destination is reachable from one sidebar regardless of role.
const navSections = [
  {
    label: 'Epic planning',
    items: [
      ['epics', 'Epic overview'],
      ['business-requirements', 'Requirements workspace'],
      ['business-planning', 'Planning'],
      ['business-stories', 'Create Stories'],
      ['templates', 'Artifact templates']
    ]
  },
  {
    label: 'Delivery',
    items: [
      ['story-intake', 'Story intake'],
      ['dashboard', 'Overview'],
      ['studio', 'Artifact studio'],
      ['impact', 'Impact analysis'],
      ['documents', 'Documents']
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
    label: 'Agent tools',
    items: [
      ['agent-workbench', 'Agent workbench']
    ]
  },
  {
    label: 'Configuration',
    items: [
      ['workspaces', 'Workspace configuration'],
      ['session-choices', 'Session choices'],
      ['initiatives', 'Portfolio designer'],
      ['workflow', 'Workflow designer'],
      ['personas', 'Personas & approvals'],
      ['resources', 'Prompts & skills'],
      ['world-model', 'Repository model'],
      ['agents', 'Remote agents']
    ]
  },
  {
    label: 'Learn',
    items: [
      ['screensaver', 'Screensaver'],
      ['help', 'Help & guides']
    ]
  }
];

const screensaverSlides = [
  {
    id: 'flow-intro',
    title: 'Singularity Flow',
    subtitle: 'Plan, govern, and deliver with Git-native lineage.',
    src: 'screensaver/singularity-flow-intro.gif'
  },
  {
    id: 'epic-to-stories',
    title: 'Epic to delivery-ready Stories',
    subtitle: 'Jira Epic, pinned evidence, governed requirements, Story plan, and branch lineage.',
    src: 'screensaver/poster-05-epic-to-stories.png'
  },
  {
    id: 'who-approved',
    title: 'Who approved what',
    subtitle: 'Persona, identity, exact artifact hash, and visible self-approval warnings.',
    src: 'screensaver/poster-06-who-approved.png'
  },
  {
    id: 'one-workspace',
    title: 'One workspace for every repo',
    subtitle: 'Lead repository, delivery repositories, Jira routing, App IDs, and local isolation.',
    src: 'screensaver/poster-07-one-workspace.png'
  },
  {
    id: 'maturity',
    title: 'Maturity that can be seen',
    subtitle: 'Flow progress, phase readiness, checks, approvals, and delivery confidence.',
    src: 'screensaver/poster-08-maturity.png'
  },
  {
    id: 'grounding',
    title: 'Repository grounding',
    subtitle: 'World model snapshots keep planning and spec generation tied to the codebase.',
    src: 'screensaver/poster-09-grounding.png'
  },
  {
    id: 'trust',
    title: 'Trust through lineage',
    subtitle: 'Every document, source, model run, Jira write, branch, and decision stays traceable.',
    src: 'screensaver/poster-10-trust.png'
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
  'agent-workbench': ['M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18z M12 7v5l3 2 M4 12h3 M17 12h3'],
  screensaver: ['M4 5h16v11H4z M8 20h8 M12 16v4 M7 9h4 M13 9h4 M7 12h10'],
  help: ['M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z M9.7 9a2.5 2.5 0 1 1 3.2 2.4c-.9.4-.9 1-.9 1.6 M12 17h.01'],
  epics: ['M5 4h14v16H5z M8 8h8 M8 12h8 M8 16h5'],
  collapse: ['M14 5l-7 7 7 7 M20 5v14'],
  expand: ['M10 5l7 7-7 7 M4 5v14'],
  refresh: ['M20 7v5h-5 M4 17v-5h5 M6.1 8A7 7 0 0 1 18 6l2 6 M17.9 16A7 7 0 0 1 6 18l-2-6'],
  download: ['M12 3v12 M7 10l5 5 5-5 M5 21h14'],
  validate: ['M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z M8 12l2.5 2.5L16 9'],
  publish: ['M4 20h16 M12 4v12 M7 9l5-5 5 5']
};

function NavIcon({ name }) {
  const aliases = {
    'business-requirements': 'documents',
    'business-planning': 'planning',
    'business-stories': 'epics',
    'story-intake': 'jira'
  };
  const paths = navIconPaths[aliases[name] ?? name] ?? navIconPaths.dashboard;
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

function FlowBrand({ context = null, className = '', inverse = false }) {
  const classes = ['flow-brand', inverse ? 'inverse' : '', className].filter(Boolean).join(' ');
  return <div className={classes} aria-label={`Singularity Flow${context ? ` — ${context}` : ''}`}>
    <span className="flow-brand-mark" aria-hidden="true"><b>S</b><i /></span>
    <div className="flow-brand-copy">
      <small className="flow-brand-parent">Singularity</small>
      <strong className="flow-brand-product">Flow</strong>
      {context && <em className="flow-brand-context">{context}</em>}
    </div>
  </div>;
}

function Empty({ title, detail, action }) {
  return <div className="empty"><div className="empty-mark">S</div><h2>{title}</h2><p>{detail}</p>{action}</div>;
}

function RecentWorkspaces({ items, currentPath = null, busy, onOpen, onForget, compact = false }) {
  const visible = items.filter((workspace) => !workspace.archivedAt);
  if (!visible.length) return null;
  return <section className={`recent-workspaces recent-repositories ${compact ? 'compact' : ''}`}><header><div><span className="eyebrow">Isolated project contexts</span><h3>Recent workspaces</h3></div><span>{visible.length} saved</span></header><div className="recent-repository-list">{visible.map((workspace) => <div className={`recent-repository ${workspace.available ? '' : 'unavailable'} ${workspace.path === currentPath ? 'current' : ''}`} key={workspace.path}><button className="recent-repository-open" disabled={busy || !workspace.available} onClick={() => onOpen(workspace.path)}><span className="recent-repository-icon workspace-icon">W</span><span className="recent-repository-copy"><strong>{workspace.name}</strong><small title={workspace.path}>{workspace.path}</small><em>{workspace.available ? `${workspace.anchorType ?? 'Jira'} ${workspace.anchorKey ?? ''} · ${formatRecentTime(workspace.openedAt)}` : 'Workspace manifest is no longer available'}</em></span>{workspace.path === currentPath && <Pill tone="good">Open</Pill>}<span className="recent-repository-arrow">→</span></button>{onForget && <button className="recent-repository-forget" aria-label={`Forget ${workspace.name}`} title="Forget this local workspace; files are not deleted" onClick={(event) => onForget(event, workspace.path)}>×</button>}</div>)}</div></section>;
}

function ArchivedWorkspaces({ items, busy, onRestore }) {
  const archived = items.filter((workspace) => workspace.archivedAt);
  if (!archived.length) return null;
  return <section className="archived-workspaces panel"><header className="panel-heading"><div><span className="eyebrow">Recoverable local records</span><h2>Archived workspaces</h2><p>Archiving hides a workspace without deleting its folder, repositories, documents, or Git history.</p></div><Pill tone="neutral">{archived.length}</Pill></header>{archived.map((workspace) => <div key={workspace.path}><span className="recent-repository-icon workspace-icon">W</span><div><strong>{workspace.name}</strong><small>{workspace.path}</small><em>Archived {formatRecentTime(workspace.archivedAt)}</em></div><button className="secondary compact" disabled={busy || !workspace.available} onClick={() => onRestore(workspace.path)}>Restore</button></div>)}</section>;
}

function WorkspaceSelector({ items, currentWorkspace = null, busy, onOpen }) {
  const currentPath = currentWorkspace?.path ?? '';
  const currentIsSaved = items.some((workspace) => workspace.path === currentPath);
  const activeItems = items.filter((workspace) => !workspace.archivedAt);
  const choices = currentWorkspace && !currentIsSaved
    ? [{ path: currentPath, name: currentWorkspace.name, anchorKey: currentWorkspace.anchor?.key, available: true }, ...activeItems]
    : activeItems;
  function selectWorkspace(event) {
    const value = event.target.value;
    if (value === '__browse__') onOpen();
    else if (value && value !== currentPath) onOpen(value);
  }
  return <section className="workspace-quick-selector" aria-label="Workspace selection">
    <header><div><span className="eyebrow">Project context</span><h3>Current workspace</h3></div><span>{items.length} saved</span></header>
    <div className="workspace-quick-control">
      <span className="workspace-quick-icon">W</span>
      <label>
        <span>{currentWorkspace ? 'Active workspace' : 'No workspace selected'}</span>
        <select aria-label="Select current workspace" value={currentPath} onChange={selectWorkspace} disabled={busy}>
          {!currentWorkspace && <option value="">No workspace selected — choose one</option>}
          {choices.map((workspace) => <option value={workspace.path} disabled={!workspace.available} key={workspace.path}>{workspace.name}{workspace.anchorKey ? ` · ${workspace.anchorKey}` : ''}{workspace.available ? '' : ' · unavailable'}</option>)}
          <option value="__browse__">＋ Open or create workspace…</option>
        </select>
      </label>
      <button type="button" className="workspace-quick-browse" aria-label="Open or create workspace" title="Open or create workspace" onClick={() => onOpen()} disabled={busy}>＋</button>
    </div>
    <p>{currentWorkspace ? <><strong>{currentWorkspace.name}</strong><span title={currentPath}>{currentPath}</span></> : <>Choose a workspace to load its repositories, Jira routing, and complete project context.</>}</p>
  </section>;
}

// The workspace switcher lives in the top bar, so the current workspace is visible from every
// page instead of being pinned to the bottom of the sidebar.
function WorldModelPrompt({ reason, busy, onGenerate }) {
  return <section className="world-model-prompt" role="status">
    <span className="world-model-prompt-mark" aria-hidden="true">◈</span>
    <div>
      <strong>Ground this Story branch before delivery work</strong>
      <p>{reason} Story intake is complete, so Copilot can now inspect this repository and commit the model to the canonical Story branch. The first phase cannot be generated until grounding is current.</p>
    </div>
    <div className="row">
      <button className="primary compact" onClick={() => onGenerate(false)} disabled={busy}>Generate &amp; push world model</button>
    </div>
  </section>;
}

function WorldModelRunDialog({ run, onClose }) {
  const [, tick] = useState(0);
  useEffect(() => {
    if (run.status !== 'running') return undefined;
    const timer = setInterval(() => tick((value) => value + 1), 1000);
    return () => clearInterval(timer);
  }, [run.status]);
  const elapsed = Math.max(0, (run.status === 'running' ? Date.now() : (run.finishedAt ?? Date.now())) - run.startedAt);
  const seconds = Math.floor(elapsed / 1000);
  const elapsedLabel = `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, '0')}s`;
  const statusLabel = run.status === 'running' ? 'Copilot is working' : run.status === 'success' ? 'World model ready' : 'World model build failed';
  return <div className="world-model-run-backdrop" role="dialog" aria-modal="true" aria-label="World-model generation progress">
    <section className="world-model-run-dialog">
      <header>
        <div><span className="eyebrow">Repository grounding</span><h2>{statusLabel}</h2></div>
        <button className="icon-button" onClick={onClose} aria-label="Close progress window">×</button>
      </header>
      <div className="world-model-run-body">
        <div className={`world-model-run-status ${run.status}`}><span className="world-model-run-pulse" /><div><strong>{run.phaseLabel}</strong><small>{run.repository}</small></div><time>{elapsedLabel}</time></div>
        <p className="world-model-run-note">This window stays open while the builder runs. The desktop is not frozen; Copilot is inspecting the repository in an isolated process and will commit the generated views when validation finishes.</p>
        <div className="world-model-run-steps" aria-label="World-model build steps">
          {['starting', 'copilot', 'finalizing', 'complete'].map((step) => <span key={step} className={run.phase === step || (run.status === 'success' && step === 'complete') ? 'active' : run.steps?.includes(step) ? 'done' : ''}><b>{run.steps?.includes(step) || (run.status === 'success' && step === 'complete') ? '✓' : '·'}</b>{step === 'starting' ? 'Prepare prompt' : step === 'copilot' ? 'Copilot build' : step === 'finalizing' ? 'Validate & commit' : 'Complete'}</span>)}
        </div>
        <details className="world-model-run-prompt" open>
          <summary>Prompt sent to Copilot <code>{run.promptPath}</code></summary>
          <pre>{run.prompt || 'The configured repository builder prompt is unavailable in this snapshot.'}</pre>
        </details>
        <details className="world-model-run-log" open={run.status !== 'running'}>
          <summary>Activity log <span>{run.logs.length}</span></summary>
          <div>{run.logs.length ? run.logs.map((entry, index) => <p key={`${entry.time}-${index}`}><time>{new Date(entry.time).toLocaleTimeString()}</time><span>{entry.message}</span></p>) : <p className="muted">Waiting for Copilot output…</p>}</div>
        </details>
        {run.error && <div className="form-error" role="alert">{run.error}</div>}
      </div>
      <footer><span className="muted">{run.status === 'running' ? 'You can close this window; the build will continue.' : run.status === 'success' ? 'Generated Markdown is now part of the repository state.' : 'Fix the reported issue and run the builder again.'}</span><button className={run.status === 'running' ? 'ghost' : 'primary'} onClick={onClose}>{run.status === 'running' ? 'Hide progress' : 'Close'}</button></footer>
    </section>
  </div>;
}

function StartupIntro({ onDone }) {
  useEffect(() => {
    const timer = setTimeout(onDone, 3600);
    const onKey = (event) => {
      if (['Escape', 'Enter', ' '].includes(event.key)) {
        event.preventDefault();
        onDone();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => {
      clearTimeout(timer);
      window.removeEventListener('keydown', onKey);
    };
  }, [onDone]);
  return <main className="startup-intro" aria-label="Singularity Flow introduction" onClick={onDone}>
    <img src="screensaver/singularity-flow-intro.gif" alt="Singularity Flow animated introduction" />
    <button type="button" onClick={onDone} aria-label="Continue to Singularity Flow">Continue</button>
  </main>;
}

function Screensaver({ onExit }) {
  const frameRef = useRef(null);
  const [index, setIndex] = useState(0);
  const slide = screensaverSlides[index];

  const go = (direction) => setIndex((current) => (current + direction + screensaverSlides.length) % screensaverSlides.length);

  useEffect(() => {
    const timer = setInterval(() => go(1), 2600);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    const onKey = (event) => {
      if (event.key === 'Escape') onExit();
      if (event.key === 'ArrowRight') go(1);
      if (event.key === 'ArrowLeft') go(-1);
      if (event.key.toLowerCase() === 'f') toggleFullscreen();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onExit]);

  async function toggleFullscreen() {
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else await frameRef.current?.requestFullscreen?.();
    } catch {
      // Fullscreen can be denied by the OS; the screensaver still works in-window.
    }
  }

  return <main className="screensaver-stage" ref={frameRef} aria-label="Singularity Flow screensaver" onDoubleClick={toggleFullscreen}>
    {screensaverSlides.map((item, itemIndex) => <img className={`screensaver-image ${itemIndex === index ? 'active' : ''}`} src={item.src} alt={itemIndex === index ? item.title : ''} aria-hidden={itemIndex === index ? undefined : 'true'} key={item.id} />)}
    <button type="button" className="screensaver-exit" onClick={onExit} aria-label="Close screensaver">×</button>
    <section className="screensaver-caption" aria-live="polite">
      <span>{String(index + 1).padStart(2, '0')} / {String(screensaverSlides.length).padStart(2, '0')}</span>
      <h1>{slide.title}</h1>
      <p>{slide.subtitle}</p>
    </section>
  </main>;
}

function TopbarWorkspace({ data, repoName, repositoryMenu, setRepositoryMenu, recentWorkspaces, busy, openWorkspace, onResetJira }) {
  const workspaceName = data.workspace?.workspace.name ?? repoName;
  // The top bar truncates, so the full context — including which repository is the lead — stays
  // available as the tooltip rather than being dropped along with the sidebar card.
  const detail = data.workspace
    ? `${workspaceName} · ${repoName} · ${data.repository.branch} · lead repository`
    : 'No workspace selected';
  return <div className="repo-switcher topbar-workspace">
    <button className="topbar-workspace-button" type="button" title={`Switch workspace — ${detail}`} aria-label={`Switch workspace. Current: ${detail}`} aria-expanded={repositoryMenu} aria-haspopup="dialog" onClick={() => setRepositoryMenu(!repositoryMenu)}>
      <span className="repo-icon">{workspaceName?.slice(0, 1).toUpperCase() ?? 'W'}</span>
      <span className="topbar-workspace-text">
        <strong>{workspaceName ?? 'No workspace'}</strong>
        <small>{data.workspace ? `${repoName} · ${data.repository.branch}` : 'Choose a workspace'}</small>
      </span>
      <i aria-hidden="true">⌄</i>
    </button>
    {repositoryMenu && <div className="repository-menu" role="dialog" aria-label="Switch workspace">
      <WorkspaceSelector items={recentWorkspaces} currentWorkspace={data.workspace?.workspace} busy={busy} onOpen={openWorkspace} />
      <div className="workspace-quick-actions">
        <button type="button" className="ghost danger-text" disabled={busy} onClick={onResetJira}>Reset saved Jira connection</button>
        <small>Removes Jira credentials from this OS account. Workspace routing and Git files are kept.</small>
      </div>
    </div>}
  </div>;
}

function jiraCredentialDraft(connection = {}, deployment = 'cloud') {
  return {
    name: connection.name ?? 'corporate-jira',
    deployment: connection.deployment ?? deployment,
    baseUrl: connection.baseUrl ?? '',
    username: connection.username ?? connection.email ?? '',
    pat: ''
  };
}

function jiraCredentialPayload(connection, deployment = connection.deployment) {
  const cloud = deployment !== 'data-center';
  return {
    name: connection.name,
    deployment,
    baseUrl: connection.baseUrl,
    username: cloud ? connection.username : null,
    pat: connection.pat,
    authMode: cloud ? 'user-token' : 'pat'
  };
}

function jiraCredentialsReady(connection, deployment = connection.deployment) {
  return /^https:\/\//i.test(connection.baseUrl)
    && Boolean(connection.pat)
    && (deployment === 'data-center' || Boolean(connection.username));
}

function JiraCredentialFields({ connection, setConnection, deploymentLocked = false }) {
  const cloud = connection.deployment !== 'data-center';
  const update = (field, value) => setConnection((current) => ({ ...current, [field]: value }));
  return <>
    {!deploymentLocked && <div className="jira-deployment-choice full wide" role="group" aria-label="Jira connection type">
      <button type="button" className={cloud ? 'active' : ''} onClick={() => update('deployment', 'cloud')}><strong>Jira Cloud</strong><small>Username + PAT/API token</small></button>
      <button type="button" className={!cloud ? 'active' : ''} onClick={() => update('deployment', 'data-center')}><strong>Data Center</strong><small>Bearer PAT</small></button>
    </div>}
    <label className="full wide"><span>Jira URL</span><input value={connection.baseUrl} placeholder={cloud ? 'https://company.atlassian.net' : 'https://jira.company.example'} onChange={(event) => update('baseUrl', event.target.value)} /></label>
    {cloud && <label><span>Username or email</span><input autoComplete="username" value={connection.username} placeholder="you@company.com" onChange={(event) => update('username', event.target.value)} /></label>}
    <label><span>{cloud ? 'PAT / API token' : 'Personal access token'}</span><input type="password" autoComplete="current-password" value={connection.pat} placeholder="Stored in OS keychain" onChange={(event) => update('pat', event.target.value)} /></label>
    <p className="jira-credential-note full wide">{cloud ? 'Cloud authentication sends Basic base64(username:PAT). Your password is never requested.' : 'Data Center sends the PAT as a Bearer token. Your password is never requested.'}</p>
  </>;
}

function OnboardingWizard({ initial, jira, onComplete, onHelp }) {
  const [draft, setDraft] = useState(() => ({
    ...initial,
    step: initial.step ?? 0,
    repositories: initial.repositories ?? [],
    jiraChoice: jira?.connected ? 'connected' : (initial.jiraChoice ?? 'later')
  }));
  const [connection, setConnection] = useState(() => jiraCredentialDraft(jira?.connection));
  const [jiraStatus, setJiraStatus] = useState(jira ?? { connected: false });
  const [working, setWorking] = useState(false);
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);
  const [advancedOpen, setAdvancedOpen] = useState(Boolean(
    initial.workspacePath
    || initial.repositories?.length
    || jira?.connected
    || jira?.recovery?.required
  ));
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
        ...jiraCredentialPayload(connection)
      });
      setJiraStatus({ connected: true, active: result.active, connection: result.connection });
      setConnection((current) => ({ ...current, pat: '' }));
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

  const canFinish = Boolean(draft.name.trim() && draft.role);
  const advancedCount = [
    draft.workspacePath,
    draft.repositories.length,
    jiraStatus.connected || draft.jiraChoice === 'connected'
  ].filter(Boolean).length;
  return <div className="onboarding-shell">
    <aside className="onboarding-rail">
      <FlowBrand className="brand onboarding-brand flow-brand-onboarding" context="Desktop setup" inverse />
      <div className="onboarding-journey">
        <span className="eyebrow">Your first outcome</span>
        <h2>Start with the work.</h2>
        <ol>
          <li className="active"><span>1</span><div><strong>Personalize</strong><small>Name and working role</small></div></li>
          <li><span>2</span><div><strong>Open an Epic</strong><small>Bring requirements and sources</small></div></li>
          <li><span>3</span><div><strong>Plan Stories</strong><small>Review, approve, and publish</small></div></li>
        </ol>
      </div>
      <div className="onboarding-promise"><span>Connections come later</span><p>Local workspaces, GitHub, and Jira are available under Advanced. None of them block this welcome setup.</p></div>
    </aside>
    <main className="onboarding-main">
      <header className="onboarding-topbar"><span>Quick start · about one minute</span><button className="ghost" onClick={onHelp}>Why Flow?</button></header>
      <section className="onboarding-stage">
        {draft.recovery && <div className="onboarding-recovery" role="status"><strong>Local setup recovered</strong><span>{draft.recovery.message}</span></div>}
        <div className="onboarding-card onboarding-quick-card">
          <div className="onboarding-copy"><span className="eyebrow">Welcome to Flow</span><h1>Set your working perspective.</h1><p>Two details personalize the experience. Connections and storage are optional, project-specific tools that can wait until you need them.</p></div>
          <div className="onboarding-core-fields">
            <label className="onboarding-field"><span>Your name</span><input autoFocus value={draft.name} placeholder="Ashok Raj" onChange={(event) => update('name', event.target.value)} /><small>Local display name; Git identity remains the approval authority.</small></label>
            <label className="onboarding-field"><span>Primary role</span><select value={draft.role ?? ''} onChange={(event) => update('role', event.target.value)}><option value="">Choose a role…</option>{onboardingRoles.map(([id, label]) => <option key={id} value={id}>{label}</option>)}</select><small>Guidance only—you may use any configured persona.</small></label>
          </div>
          <button type="button" className={`onboarding-advanced-trigger ${advancedOpen ? 'open' : ''}`} aria-expanded={advancedOpen} onClick={() => setAdvancedOpen((current) => !current)}>
            <span className="onboarding-advanced-icon">⌘</span>
            <span><strong>Advanced setup</strong><small>Local workspace, repositories, GitHub, and Jira</small></span>
            {advancedCount > 0 && <Pill tone="good">{advancedCount} configured</Pill>}
            <b>{advancedOpen ? '−' : '+'}</b>
          </button>
          {advancedOpen && <div className="onboarding-advanced-grid">
            <section className="advanced-setup-card workspace">
              <header><span>01</span><div><strong>Local workspace</strong><small>Clone and cache boundary</small></div></header>
              <p>Choose a corporate-approved folder only when you want managed multi-repository workspaces.</p>
              <div className="advanced-setup-value"><code>{draft.workspacePath ?? 'Not configured'}</code><button className="secondary compact" onClick={chooseWorkspace} disabled={working}>{draft.workspacePath ? 'Change' : 'Choose folder'}</button></div>
            </section>
            <section className="advanced-setup-card github">
              <header><span>02</span><div><strong>Workspace repositories</strong><small>Lead and participating repositories</small></div></header>
              <p>Add repositories to the workspace project boundary. Singularity uses each repository’s Git identity and the existing authenticated <code>gh</code> CLI session.</p>
              <div className="onboarding-repositories compact-list">{draft.repositories.map((repository) => <div key={repository.path}><span>{repository.name.slice(0, 1).toUpperCase()}</span><div><strong>{repository.name}</strong><small>{repository.path}</small></div><button className="ghost" aria-label={`Remove ${repository.name}`} onClick={() => update('repositories', draft.repositories.filter((item) => item.path !== repository.path))}>×</button></div>)}<button className="onboarding-add-repository" onClick={addRepositories} disabled={working}><span>＋</span><div><strong>Add repositories</strong><small>Optional · GitHub is detected after opening</small></div></button></div>
            </section>
            <section className="advanced-setup-card jira">
              <header><span>03</span><div><strong>Jira connection</strong><small>Import Epics and publish Stories</small></div></header>
              {jiraStatus.recovery?.required ? <div className="onboarding-jira-recovery" role="alert">
                <span>!</span><div><strong>Saved credentials need attention</strong><small>{jiraStatus.recovery.message}</small></div><button className="secondary compact" disabled={working} onClick={() => resetJiraCredentials('later')}>Reset</button>
              </div> : jiraStatus.connected || draft.jiraChoice === 'connected' ? <div className="onboarding-jira-connected">
                <span>✓</span><div><strong>Connected securely</strong><small>{jiraStatus.connection?.baseUrl ?? 'Credential available in this OS account'}</small></div><Pill tone="good">Ready</Pill>
              </div> : <>
                <div className="onboarding-jira-form">
                  <JiraCredentialFields connection={connection} setConnection={setConnection} />
                </div>
                <div className="onboarding-jira-actions"><button className="primary compact" disabled={working || !jiraCredentialsReady(connection)} onClick={connectJira}>{working ? 'Verifying…' : 'Verify Jira'}</button><button className="ghost compact" onClick={() => update('jiraChoice', 'not-used')}>Skip</button></div>
              </>}
            </section>
          </div>}
          <div className="onboarding-ready-strip"><span>✓</span><div><strong>{draft.name || 'Your local profile'}</strong><small>{draft.role ? `${roleLabel} · ready to start` : 'Choose a role to continue'}</small></div><em>Advanced setup remains available later</em></div>
        </div>
        {notice && <div className="onboarding-warning" role="status">{notice}</div>}
        {error && <div className="onboarding-error" role="alert">{error}</div>}
      </section>
      <footer className="onboarding-footer"><span /><span>Name and role stay local. Advanced connections are configured only when opened.</span><button className="primary onboarding-finish" disabled={working || !canFinish} onClick={() => persist(4, true)}>{working ? 'Finishing…' : 'Continue to Flow'}</button></footer>
    </main>
  </div>;
}

function OnboardingLoadFailure({ error, retry, help }) {
  return <div className="onboarding-failure">
    <FlowBrand className="brand large flow-brand-welcome" context="Desktop setup" />
    <section>
      <span className="onboarding-failure-mark">!</span>
      <span className="eyebrow">Setup could not be loaded</span>
      <h1>We stopped before opening your workspace.</h1>
      <p>Flow could not safely read the local onboarding profile. No repository, Jira, or Git state was changed.</p>
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
  const [operation, setOperation] = useState(null);
  const [clock, setClock] = useState(Date.now());
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
      setModel(nextStatus.model ?? '');
    }).catch((error) => {
      if (active) setStatus({ state: 'error', running: false, preflight: { ready: false, message: error.message } });
    });
    const unsubscribe = window.singularity.onCopilotServiceEvent?.((event) => {
      if (!active || event.repository !== repository) return;
      setStatus((current) => ({ ...current, ...event.service }));
      setLogs((current) => [...current.slice(-299), event]);
      if (['ready', 'model-changed', 'config_option_update'].includes(event.type)) {
        setModel(event.service?.model ?? '');
      }
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

  useEffect(() => {
    if (!open || !status.running) return undefined;
    setClock(Date.now());
    const timer = window.setInterval(() => setClock(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [open, status.running]);

  async function start() {
    setOperation('start');
    try {
      const result = await window.singularity.startCopilotService(repository, model);
      setStatus(result);
      setModel(result.model ?? model);
      notify({ tone: 'good', text: 'Copilot backend is ready in native Plan mode.' });
    } catch (error) {
      notify({ tone: 'bad', text: error?.message || String(error) });
    } finally {
      setOperation(null);
    }
  }

  async function applyModel() {
    setOperation('model');
    try {
      const result = await window.singularity.setCopilotServiceModel(repository, model);
      setStatus(result);
      setModel(result.model ?? model);
      notify({ tone: 'good', text: `Copilot model changed to ${result.model}.` });
    } catch (error) {
      notify({ tone: 'bad', text: error?.message || String(error) });
    } finally {
      setOperation(null);
    }
  }

  async function applyMode(modeId) {
    setOperation('mode');
    try {
      const result = await window.singularity.setCopilotServiceMode(repository, modeId);
      setStatus(result);
      notify({
        tone: result.readOnly ? 'good' : 'warn',
        text: result.readOnly
          ? `Copilot mode is ${result.mode}: read-only, nothing reaches Git except through promotion.`
          : `Copilot mode is ${result.mode}. Tool calls that change the repository are now put to you one at a time.`
      });
    } catch (error) {
      notify({ tone: 'bad', text: error?.message || String(error) });
    } finally {
      setOperation(null);
    }
  }

  async function stop() {
    setOperation('stop');
    try {
      const result = await window.singularity.stopCopilotService(repository);
      setStatus(result);
      notify({ tone: 'good', text: 'Copilot backend stopped.' });
    } catch (error) {
      notify({ tone: 'bad', text: error?.message || String(error) });
    } finally {
      setOperation(null);
    }
  }

  const tone = status.state === 'error' || status.preflight?.ready === false ? 'bad' : status.state === 'busy' ? 'busy' : status.running ? 'ready' : 'stopped';
  const canStop = status.running || status.canStop;
  const connectedAt = Date.parse(status.connectedAt ?? status.startedAt);
  const connectedFor = status.running && Number.isFinite(connectedAt) ? Math.max(0, clock - connectedAt) : null;
  const availableModels = status.availableModels ?? [];
  const availableModes = status.availableModes ?? [];
  const selectedModelKnown = !model || availableModels.some((candidate) => candidate.value === model);
  const modelChanged = Boolean(model && model !== status.model);
  const usage = status.usage ?? { status: 'unavailable', byModel: [] };
  const working = Boolean(operation);
  const usageTone = usage.status === 'exact' ? 'good' : usage.status === 'partial' ? 'warn' : 'neutral';
  const modelLabel = status.model
    ? availableModels.find((candidate) => candidate.value === status.model)?.label ?? status.model
    : 'Copilot auto';
  return <div className="copilot-service-control" ref={controlRef}>
    <button className={`copilot-service-trigger ${tone}`} type="button" aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen((current) => !current)} title="Manage the local Copilot ACP backend"><span className="copilot-service-orb">✦</span><span><strong>Copilot</strong><small>{status.state === 'loading' ? 'checking' : status.state}</small></span><i /></button>
    {open && <section className="copilot-service-popover" role="dialog" aria-label="Copilot backend service">
      <header><div><span className="eyebrow">Local ACP process</span><h2>Copilot backend</h2></div><Pill tone={status.running ? 'good' : status.state === 'error' ? 'bad' : 'neutral'}>{status.state}</Pill></header>
      <p>Start Copilot once, then reuse that native Plan-mode process across governed planning turns. Stopping it cancels any active turn; it never changes Git state by itself.</p>
      <div className="copilot-service-facts"><div><span>Model</span><strong title={modelLabel}>{modelLabel}</strong></div><div><span>Connected</span><strong>{connectedFor === null ? '—' : formatDuration(connectedFor)}</strong></div><div><span>Total tokens</span><strong>{formatServiceTokens(usage.totalTokens)}</strong></div><div><span>Planning</span><strong>{status.activePlanningSessionId ? 'attached' : 'idle'}</strong></div></div>
      <div className="copilot-service-meta"><span>{status.mode ? `${status.mode} mode` : 'Plan mode'}</span><span>PID {status.processId ?? '—'}</span><span>{status.version ?? status.preflight?.version ?? 'Version unavailable'}</span></div>
      <label className="copilot-model-control"><span>Session mode</span>
        <select value={status.modeId ?? ''} disabled={working || !status.running || !status.modeSwitchSupported} onChange={(event) => applyMode(event.target.value)}>
          {!status.running && <option value="">Plan (on connection)</option>}
          {availableModes.map((candidate) => <option key={candidate.id} value={candidate.id}>{candidate.name}{candidate.readOnly ? ' · read-only' : ''}</option>)}
        </select>
        <small>{!status.running
          ? 'Every session starts in Plan. Switch it here once the backend is connected.'
          : status.readOnly
            ? 'Plan mode refuses every tool call that could change the repository. Artifacts reach Git through promotion.'
            : 'Copilot may ask to edit or run things. Each request is put to you before it happens.'}</small>
      </label>
      <label className="copilot-model-control"><span>{status.running ? 'Active model' : 'Model for next connection'}</span>{availableModels.length
        ? <select value={selectedModelKnown ? model : ''} disabled={working || (status.running && !status.modelSwitchSupported)} onChange={(event) => setModel(event.target.value)}>
          {!selectedModelKnown && <option value="">{model}</option>}
          {!status.running && <option value="">Copilot auto selection</option>}
          {availableModels.map((candidate) => <option key={candidate.value} value={candidate.value}>{candidate.label}</option>)}
        </select>
        : <input value={model} disabled={working || status.running} onChange={(event) => setModel(event.target.value)} placeholder="Copilot auto selection" />}
        <small>{status.running
          ? status.modelSwitchSupported ? 'Switches this idle ACP session without restarting it.' : 'This Copilot version requires a stop and restart to change models.'
          : 'Leave blank to let Copilot choose. The resolved model appears after connection.'}</small>
      </label>
      <section className="copilot-usage">
        <header><div><span className="eyebrow">This connection</span><strong>Token usage by model</strong></div><Pill tone={usageTone}>{usage.status}</Pill></header>
        {usage.byModel?.length
          ? <div className="copilot-usage-table"><div className="head"><span>Model</span><span>Input</span><span>Output</span><span>Cache</span><span>Total</span></div>{usage.byModel.map((entry) => <div key={entry.model}><strong title={entry.model}>{entry.model}</strong><span>{formatServiceTokens(entry.inputTokens)}</span><span>{formatServiceTokens(entry.outputTokens)}</span><span>{formatServiceTokens(entry.cachedReadTokens)}</span><span>{formatServiceTokens(entry.totalTokens)}</span></div>)}</div>
          : <div className="copilot-usage-empty"><strong>Waiting for exact usage</strong><span>Totals appear after a Copilot turn when ACP returns token counts. Singularity never estimates missing values.</span></div>}
        <footer><span>{usage.exactTurns ?? 0} exact turn{usage.exactTurns === 1 ? '' : 's'}</span>{usage.unavailableTurns > 0 && <span>{usage.unavailableTurns} unavailable</span>}</footer>
      </section>
      {status.preflight?.ready === false && <div className="copilot-service-warning">{status.preflight.message}</div>}
      <div className="copilot-service-actions">{status.running && status.modelSwitchSupported && modelChanged && <button className="primary" disabled={working || status.state === 'busy' || Boolean(status.activePlanningSessionId)} onClick={applyModel}>{operation === 'model' ? 'Applying…' : 'Apply model'}</button>}{operation === 'start' || status.state === 'starting' ? <button className="primary" disabled>Starting…</button> : canStop ? <button className="danger-button" disabled={working} onClick={stop}>{operation === 'stop' ? 'Stopping…' : status.state === 'error' ? 'Retry stop' : 'Stop backend'}</button> : <button className="primary" disabled={working || status.preflight?.ready === false} onClick={start}>Start backend</button>}<button className="ghost" onClick={() => setOpen(false)}>Close</button></div>
      <details className="copilot-service-log"><summary>Service log <span>{logs.length}</span></summary><div>{logs.length ? logs.slice(-80).map((entry, index) => <p key={`${entry.at}:${entry.type}:${index}`}><time>{new Date(entry.at).toLocaleTimeString()}</time><code>{entry.type}</code><span>{entry.message ?? entry.detail ?? entry.state ?? ''}</span></p>) : <p className="empty-log">No backend events yet.</p>}</div></details>
    </section>}
  </div>;
}

function formatServiceTokens(value) {
  return Number.isFinite(value) && value >= 0 ? value.toLocaleString('en-US') : 'Unavailable';
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

function storyOrbitStatus(story) {
  const percentage = story.progress?.percentage ?? (story.status === 'complete' ? 100 : 0);
  if (story.stale) return { id: 'stale', label: 'Needs refresh' };
  if (story.blocked) return { id: 'blocked', label: 'Blocked' };
  if (story.status === 'complete' || percentage >= 100) return { id: 'complete', label: 'Complete' };
  if (percentage > 0 || story.currentPhase) return { id: 'active', label: 'In delivery' };
  if (story.materialized) return { id: 'seeded', label: 'Ready for developer' };
  return { id: 'planned', label: 'Planned' };
}

function StoryDeliveryOrbit({ epic }) {
  const stories = epic.stories ?? [];
  const [selectedId, setSelectedId] = useState(stories[0]?.id ?? null);
  useEffect(() => {
    if (!stories.some((story) => story.id === selectedId)) setSelectedId(stories[0]?.id ?? null);
  }, [stories, selectedId]);
  const selected = stories.find((story) => story.id === selectedId) ?? stories[0] ?? null;
  const selectedStatus = selected ? storyOrbitStatus(selected) : null;
  const maximumNodes = 12;
  const visibleStories = stories.slice(0, maximumNodes);
  const hiddenStories = Math.max(0, stories.length - maximumNodes);
  const counts = stories.reduce((result, story) => {
    const status = storyOrbitStatus(story).id;
    result[status] = (result[status] ?? 0) + 1;
    return result;
  }, {});
  const dependencies = selected?.dependsOn?.map((dependency) => typeof dependency === 'string' ? dependency : dependency.story) ?? [];
  return <section className="story-delivery-orbit" aria-label={`Story delivery orbit for ${epic.title}`}>
    <div className="story-orbit-visual">
      <div className={`story-orbit-track ${visibleStories.length > 8 ? 'dense' : ''}`} style={{ '--orbit-progress': `${Math.max(0, Math.min(100, epic.percentage ?? 0)) * 3.6}deg` }}>
        <div className="story-orbit-center">
          <span>Epic delivery</span>
          <strong>{epic.percentage ?? 0}%</strong>
          <small>{epic.complete}/{epic.total} Stories complete</small>
        </div>
        {visibleStories.map((story, index) => {
          const status = storyOrbitStatus(story);
          const angle = -90 + ((360 / visibleStories.length) * index);
          const radians = angle * (Math.PI / 180);
          const left = 50 + (42 * Math.cos(radians));
          const top = 50 + (42 * Math.sin(radians));
          const percentage = story.progress?.percentage ?? (story.status === 'complete' ? 100 : 0);
          return <button
            type="button"
            key={story.id}
            className={`story-orbit-node ${status.id} ${selected?.id === story.id ? 'selected' : ''}`}
            style={{ left: `${left}%`, top: `${top}%` }}
            onClick={() => setSelectedId(story.id)}
            aria-pressed={selected?.id === story.id}
            aria-label={`${story.workId ?? story.id}: ${status.label}, ${percentage}% complete`}
          >
            <span>{status.id === 'complete' ? '✓' : percentage ? `${percentage}%` : '○'}</span>
            <strong>{story.workId ?? story.id}</strong>
            <small>{status.label}</small>
          </button>;
        })}
        {hiddenStories > 0 && <div className="story-orbit-overflow">+{hiddenStories}<small>in table</small></div>}
      </div>
    </div>
    <aside className="story-orbit-inspector">
      <header><span className="eyebrow">Selected Story</span><Pill tone={selectedStatus?.id === 'complete' ? 'good' : ['blocked', 'stale'].includes(selectedStatus?.id) ? 'warn' : selectedStatus?.id === 'active' ? 'accent' : 'neutral'}>{selectedStatus?.label ?? 'No Stories'}</Pill></header>
      {selected ? <>
        <h3>{selected.title ?? selected.workId ?? selected.id}</h3>
        <div className="story-orbit-identities"><span><b>Work ID</b><code>{selected.workId ?? selected.id}</code></span><span><b>Jira</b><code>{selected.jiraKey ?? 'not created'}</code></span></div>
        <dl>
          <div><dt>Repository</dt><dd>{selected.repository}</dd></div>
          <div><dt>Current phase</dt><dd>{selected.currentPhase ?? (selected.materialized ? 'Ready for developer' : 'Planning')}</dd></div>
          <div><dt>Branch state</dt><dd>{selected.materialized ? 'Canonical branch created' : 'Not materialized'}</dd></div>
          <div><dt>Dependencies</dt><dd>{dependencies.length ? dependencies.join(', ') : 'None'}</dd></div>
        </dl>
        <div className="story-orbit-progress"><span><b>Delivery progress</b><em>{selected.progress?.percentage ?? (selected.status === 'complete' ? 100 : 0)}%</em></span><i><b style={{ width: `${selected.progress?.percentage ?? (selected.status === 'complete' ? 100 : 0)}%` }} /></i></div>
        {(selected.stale || selected.blocked) && <p className="story-orbit-alert">⚠ {selected.stale ? 'The committed Story context is stale and must be synchronized.' : 'This Story is blocked by delivery lineage or a dependency.'}</p>}
      </> : <p>No Stories are present in this Epic plan.</p>}
      <footer className="story-orbit-legend" aria-label="Story status legend">
        {[['complete', 'Complete'], ['active', 'In delivery'], ['seeded', 'Ready'], ['blocked', 'Blocked'], ['stale', 'Stale'], ['planned', 'Planned']].map(([id, label]) => <span key={id} className={id}><i />{label}<b>{counts[id] ?? 0}</b></span>)}
      </footer>
    </aside>
  </section>;
}

// height is a prop because this editor is no longer always the only thing in its column; where it
// shares space it fills what is left instead of assuming the viewport minus a constant.
function SourceEditor({ path, value, onChange, language = 'markdown', dirty, onSave, onDownload, onImport, readOnly = false, height = 'calc(100vh - 245px)' }) {
  return <section className="editor-panel">
    <header className="editor-header"><div><span className="eyebrow">{readOnly ? 'Repository-owned source' : 'Repository source'}</span><strong>{path}</strong></div><div className="row">{onImport && <button className="ghost compact" onClick={onImport}>Import</button>}{onDownload && <button className="secondary compact" onClick={onDownload}>Download</button>}<Pill tone={readOnly ? 'neutral' : dirty ? 'warn' : 'good'}>{readOnly ? 'Read only' : dirty ? 'Unsaved' : 'Saved'}</Pill>{!readOnly && <button className="primary compact" disabled={!dirty} onClick={onSave}>Save</button>}</div></header>
    <Editor height={height} language={language} theme="vs-light" value={value} onChange={(next) => !readOnly && onChange(next ?? '')} options={{ readOnly, minimap: { enabled: false }, fontFamily: 'SFMono-Regular, Consolas, Liberation Mono, monospace', fontSize: 14, lineHeight: 23, wordWrap: 'on', padding: { top: 18 }, scrollBeyondLastLine: false, automaticLayout: true }} />
  </section>;
}

function DesignerModal({ title, detail, children, submitLabel, danger = false, submitDisabled = false, error, onCancel, onSubmit }) {
  return <div className="modal-backdrop" onClick={onCancel}><form className="designer-modal" onClick={(event) => event.stopPropagation()} onSubmit={(event) => { event.preventDefault(); onSubmit(); }}>
    <header><div><span className="eyebrow">Guided configuration</span><h2>{title}</h2></div><button type="button" onClick={onCancel}>×</button></header>
    <div className="designer-modal-body">{detail && <p>{detail}</p>}{children}{error && <div className="form-error" role="alert">{error}</div>}</div>
    <footer><button type="button" className="secondary" onClick={onCancel}>Cancel</button><button type="submit" className={danger ? 'danger-button' : 'primary'} disabled={submitDisabled}>{submitLabel}</button></footer>
  </form></div>;
}

function ArtifactStudio({ data, openWorkspace, downloadFile }) {
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
  const { openArtifact, artifactViewer } = useArtifactViewer({
    repository: data.repository.root,
    workId: data.workflow ? data.selectedWorkId : null,
    downloadFile
  });
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
          <div className="phase-deliverables"><strong>Governed deliverables</strong>{phaseDocuments.length ? phaseDocuments.map((document) => <button key={document.id} onClick={() => openArtifact(document)}><span className="studio-file-icon">{kindTag(document.path ?? document.kind)}</span><span><b>{document.label}</b><small>{document.path}</small></span><em>Open</em></button>) : <div className="inline-empty">No phase document has been published yet.</div>}</div>
        </section>
        <section className="panel studio-assistant">
          <header className="panel-heading"><div><span className="eyebrow">Singularity intelligence</span><h2>What happens next</h2></div><span className="ai-orb">✦</span></header>
          <div className="studio-assistant-copy"><strong>{selected?.status === 'approved' ? 'This phase is governed and reusable.' : selected?.status === 'awaiting_approval' ? 'The artifact is ready for a hash-bound review.' : 'Build the phase output from governed context.'}</strong><p>{selected?.status === 'approved' ? 'Downstream phases can consume this approved artifact through declared inputs.' : selected?.status === 'awaiting_approval' ? 'Open the review bundle to inspect provenance, evidence, and approval requirements.' : 'Run /sflow-next in Copilot CLI, then refresh this workspace to inspect the committed result.'}</p></div>
          <div className="assistant-checks"><span><i className="done">✓</i>Repository context pinned</span><span><i className={phaseDocuments.length ? 'done' : ''}>{phaseDocuments.length ? '✓' : '○'}</i>Artifact generated</span><span><i className={selected?.status === 'approved' ? 'done' : ''}>{selected?.status === 'approved' ? '✓' : '○'}</i>Approval recorded</span></div>
        </section>
      </div>
      <section className="panel artifact-repository">
        <header className="panel-heading"><div><span className="eyebrow">Shared repository</span><h2>Governed artifacts</h2></div><span>{documents.length} registered</span></header>
        <div className="artifact-repository-head"><span>Name</span><span>Phase</span><span>Status</span><span>Repository path</span><span /></div>
        {documents.length ? documents.map((document) => <div className="artifact-repository-row" key={document.id}><div><span className="studio-file-icon">{document.kind === 'url' ? 'URL' : kindTag(document.path ?? document.kind)}</span><strong>{document.label}</strong></div><span>{document.phase ?? 'system'}</span><Pill tone={document.status === 'approved' ? 'good' : 'neutral'}>{document.status ?? document.kind}</Pill><code>{document.path ?? document.url}</code><button className="ghost compact" onClick={() => openArtifact(document)}>Open</button></div>) : <div className="inline-empty">Generated and uploaded artifacts will appear here with their repository provenance.</div>}
      </section>
      {artifactViewer}
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
    <header className="impact-toolbar"><div><span className="eyebrow">Repository intelligence</span><h1>Impact Analysis Studio</h1><p>{subject}</p></div><div><Pill tone={risk === 'Low' ? 'good' : 'warn'}>{risk} delivery risk</Pill><button className="primary" onClick={() => openPlanning('epic-planning')}>Show Copilot CLI command</button></div></header>
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

function PortfolioSetup({ data, action, onCreated, jiraFirst = false, onCancel = null }) {
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
    }), 'Epic governance created and validated');
    if (result) await onCreated(result, {
      deployment: values.jiraDeployment,
      baseUrl: values.jiraBaseUrl,
      projectKey: values.jiraProjectKey,
      writeMode: values.jiraWriteMode
    });
  }
  return <div className="portfolio-setup">
    <section className="portfolio-setup-intro"><span className="jira-mark">{jiraFirst ? 'J' : 'S'}</span><span className="eyebrow">{jiraFirst ? 'Jira setup' : 'Advanced governance setup'}</span><h1>{jiraFirst ? 'Connect Jira to bring in Epics' : 'Set up your Epic workspace'}</h1><p>{jiraFirst ? <>Define the allowed Jira host and project for this repository. Credentials are entered on the next screen and stay encrypted in the operating-system keychain.</> : <>This creates the governed profiles, approval groups, repository registry, and optional Jira policy under <code>singularity/portfolio.yml</code>. It remains an uncommitted configuration change until you use <strong>Commit & push</strong>.</>}</p><div className="portfolio-setup-steps">{jiraFirst ? <><span><b>1</b>Policy</span><span><b>2</b>Credentials</span><span><b>3</b>Choose Epic</span></> : <><span><b>1</b>Identity</span><span><b>2</b>Repositories</span><span><b>3</b>Jira policy</span></>}</div></section>
    <section className="portfolio-setup-form panel">
      {!jiraFirst && <><header><span className="eyebrow">Approval identity</span><h2>Who owns the initial gates?</h2><p>Leave these blank to use the repository’s configured Git name and email.</p></header>
      <div className="control-grid"><label><span>Display name</span><input value={values.approvalName} placeholder="Use Git user.name" onChange={(event) => set('approvalName', event.target.value)} /></label><label><span>Email</span><input type="email" value={values.approvalEmail} placeholder="Use Git user.email" onChange={(event) => set('approvalEmail', event.target.value)} /></label></div>
      <header><span className="eyebrow">Participating repository</span><h2>Add the first delivery repository</h2><p>Optional now. More repositories can be added later in Advanced governance.</p></header>
      <div className="control-grid expanded"><label><span>Repository ID</span><input value={values.repositoryId} placeholder="mobile" onChange={(event) => set('repositoryId', event.target.value)} /></label><label><span>Application ID</span><input value={values.repositoryAppId} placeholder="APP-1001" onChange={(event) => set('repositoryAppId', event.target.value)} /></label><label className="full"><span>Application name</span><input value={values.repositoryName} placeholder="Mobile application" onChange={(event) => set('repositoryName', event.target.value)} /></label><label className="full"><span>Git URL</span><input value={values.repositoryUrl} placeholder="git@github.com:company/mobile.git" onChange={(event) => set('repositoryUrl', event.target.value)} /></label><label><span>Default branch</span><input value={values.defaultBranch} onChange={(event) => set('defaultBranch', event.target.value)} /></label></div>
      <div className="repository-metadata-fields"><header><div><strong>Additional metadata</strong><span>Optional key/value pairs are committed under this repository in <code>singularity/portfolio.yml</code>.</span></div><button type="button" className="ghost compact" onClick={() => set('repositoryMetadata', [...values.repositoryMetadata, { key: '', value: '' }])}>＋ Add field</button></header>{values.repositoryMetadata.map((entry, index) => <div key={index}><input aria-label={`Metadata key ${index + 1}`} value={entry.key} placeholder="owner" onChange={(event) => setMetadata(index, 'key', event.target.value)} /><input aria-label={`Metadata value ${index + 1}`} value={entry.value} placeholder="Digital Channels" onChange={(event) => setMetadata(index, 'value', event.target.value)} />{values.repositoryMetadata.length > 1 && <button type="button" className="ghost compact" aria-label={`Remove metadata field ${index + 1}`} onClick={() => set('repositoryMetadata', values.repositoryMetadata.filter((_, entryIndex) => entryIndex !== index))}>×</button>}</div>)}</div></>}
      <header className="portfolio-jira-toggle"><div><span className="eyebrow">Corporate integration</span><h2>{jiraFirst ? 'Choose your Jira deployment' : 'Configure Jira now'}</h2></div>{!jiraFirst && <label className="switch"><input type="checkbox" checked={values.jiraEnabled} onChange={(event) => set('jiraEnabled', event.target.checked)} /><span /></label>}</header>
      {values.jiraEnabled && <div className="control-grid expanded"><label><span>Deployment</span><select value={values.jiraDeployment} onChange={(event) => set('jiraDeployment', event.target.value)}><option value="cloud">Jira Cloud</option><option value="data-center">Jira Data Center</option></select></label><label className="full"><span>Jira HTTPS URL</span><input value={values.jiraBaseUrl} placeholder="https://company.atlassian.net" onChange={(event) => set('jiraBaseUrl', event.target.value)} /></label><label><span>Project key</span><input value={values.jiraProjectKey} placeholder="APP" onChange={(event) => set('jiraProjectKey', event.target.value.toUpperCase())} /></label><label><span>Write policy</span><select value={values.jiraWriteMode} onChange={(event) => set('jiraWriteMode', event.target.value)}><option value="off">Off · browse/adopt only</option><option value="preview">Preview · commit plans only</option><option value="approved">Approved · guarded apply</option></select></label></div>}
      <div className="portfolio-setup-action"><div><strong>No credentials are stored in Git</strong><span>The API token/PAT is requested securely on the next screen.</span></div><div className="row gap">{onCancel && <button className="ghost" onClick={onCancel}>Back to Epic</button>}<button className="primary" disabled={(repositoryPartial && (!values.repositoryId || !values.repositoryUrl)) || !jiraReady} onClick={create}>{jiraFirst ? 'Save Jira policy & continue' : 'Create & validate governance'}</button></div></div>
    </section>
  </div>;
}

function workspaceRepositoryDraft(repository) {
  return {
    id: repository.id ?? '',
    path: repository.path ?? '',
    localPath: repository.localPath ?? '',
    url: repository.url ?? '',
    defaultBranch: repository.defaultBranch ?? 'main',
    name: repository.metadata?.name ?? repository.id ?? '',
    appId: repository.metadata?.appId ?? '',
    jiraBoard: repository.jira?.board ?? '',
    metadata: Object.entries(repository.metadata ?? {})
      .filter(([key]) => !['name', 'appId'].includes(key))
      .map(([key, value]) => ({ key, value: String(value) }))
  };
}

function WorkspaceJiraConnection({ data, action, onDone }) {
  const workspace = data.workspace?.workspace;
  const [status, setStatus] = useState(null);
  const [connection, setConnection] = useState(() => jiraCredentialDraft());
  async function refresh() {
    const result = await action(() => window.singularity.workspaceJiraContext(data.repository.root, workspace.path));
    if (!result) return;
    setStatus(result);
    if (result.credentials?.connection) {
      setConnection((current) => ({
        ...current,
        name: result.credentials.connection.name,
        deployment: result.credentials.connection.deployment,
        baseUrl: result.credentials.connection.baseUrl,
        username: result.credentials.connection.username ?? result.credentials.connection.email ?? ''
      }));
    }
  }
  useEffect(() => { void refresh(); }, [data.repository.root, workspace?.path]);
  async function connect() {
    const result = await action(() => window.singularity.connectWorkspaceJira(data.repository.root, workspace.path, {
      ...jiraCredentialPayload(connection)
    }), 'Jira connection verified and stored securely');
    if (!result) return;
    setConnection((current) => ({ ...current, pat: '' }));
    setStatus({ credentials: result, routing: result.routing });
  }
  async function disconnect() {
    const result = await action(() => window.singularity.disconnectWorkspaceJira(data.repository.root, workspace.path), 'Jira disconnected from this OS account');
    if (result) setStatus({ credentials: result, routing: status?.routing });
  }
  async function resetCredentials() {
    if (!window.confirm('Reset every saved Jira connection for this OS account? Workspace routing and Git state will not be changed.')) return;
    const result = await action(
      () => window.singularity.resetJiraCredentials(data.repository.root),
      'All saved Jira credentials were reset; reconnect when ready'
    );
    if (!result) return;
    setConnection((current) => ({ ...current, pat: '' }));
    setStatus({ credentials: result, routing: status?.routing });
  }
  const projectKeys = status?.routing?.projectKeys
    ?? [...new Set(Object.values(workspace.repositories).map((repository) => repository.jira?.board).filter(Boolean))];
  const connected = status?.credentials?.connected;
  const ready = jiraCredentialsReady(connection);
  return <div className="page workspace-jira-page">
    <header className="page-heading row-between"><div><span className="eyebrow">Workspace integration</span><h1>Connect Jira</h1><p>The workspace already owns project routing. Add only your Jira account credentials; they stay encrypted in the operating-system keychain.</p></div><div className="row gap"><button className="ghost danger-text" onClick={resetCredentials}>Reset saved Jira</button><button className="ghost" onClick={onDone}>Close</button></div></header>
    <section className="workspace-jira-routing panel">
      <div><span className="jira-mark">J</span><div><span className="eyebrow">Configured project scope</span><h2>{workspace.name}</h2><p>{projectKeys.length ? `This connection must be able to access ${projectKeys.join(', ')}.` : 'Add a Jira project key to a workspace repository before connecting.'}</p></div></div>
      {connected ? <div className="workspace-jira-connected"><Pill tone="good">Connected</Pill><strong>{status.credentials.connection?.account?.displayName ?? status.credentials.connection?.username ?? status.credentials.connection?.email}</strong><small>{status.credentials.connection?.baseUrl}</small><button className="secondary compact" onClick={disconnect}>Disconnect</button></div> : <div className="jira-connect-form workspace-jira-form">
        <JiraCredentialFields connection={connection} setConnection={setConnection} />
        <button className="primary full" disabled={!ready || !projectKeys.length} onClick={connect}>Test connection & save securely</button>
      </div>}
    </section>
  </div>;
}

function WorkspaceStudio({
  data,
  action,
  onOpened,
  defaultBaseDirectory = '',
  recentWorkspaces = [],
  onOpenWorkspace,
  onForgetWorkspace,
  onArchiveWorkspace,
  onRestoreWorkspace,
  onSetupJira
}) {
  const current = data.workspace ?? null;
  const repositoryRoot = data.repository?.root ?? null;
  const [baseDirectory, setBaseDirectory] = useState(defaultBaseDirectory);
  const [workspaceId, setWorkspaceId] = useState('');
  const [workspaceName, setWorkspaceName] = useState('');
  const [repositories, setRepositories] = useState([]);
  const [leadIndex, setLeadIndex] = useState(0);
  const [preview, setPreview] = useState(null);
  const [health, setHealth] = useState(current ?? null);
  const [editorMode, setEditorMode] = useState(current ? 'closed' : 'create');
  const [archiveConfirmation, setArchiveConfirmation] = useState('');
  const [archiveOpen, setArchiveOpen] = useState(false);
  const saveActions = useRef(null);

  useEffect(() => {
    let active = true;
    if (editorMode !== 'create' || !repositoryRoot) return undefined;
    window.singularity.workspaceRepositoryDefaults(repositoryRoot)
      .then((repository) => {
        if (!active || repositories.length) return;
        setRepositories([workspaceRepositoryDraft(repository)]);
      })
      .catch(() => {});
    return () => { active = false; };
  }, [repositoryRoot, editorMode]);

  useEffect(() => { setHealth(data.workspace ?? null); }, [data.workspace]);

  function resetPreview() {
    setPreview(null);
  }

  function editWorkspace() {
    if (!health) return;
    const manifest = health.workspace;
    const entries = Object.values(manifest.repositories);
    setBaseDirectory(manifest.path);
    setWorkspaceId(manifest.anchor.key);
    setWorkspaceName(manifest.name);
    setRepositories(entries.map(workspaceRepositoryDraft));
    setLeadIndex(Math.max(0, entries.findIndex((repository) => repository.id === manifest.leadRepository)));
    setPreview(null);
    setEditorMode('edit');
  }

  function newWorkspace() {
    setBaseDirectory(defaultBaseDirectory);
    setWorkspaceId('');
    setWorkspaceName('');
    setRepositories([]);
    setLeadIndex(0);
    setPreview(null);
    setEditorMode('create');
  }

  function closeEditor() {
    setPreview(null);
    setEditorMode(health ? 'closed' : 'create');
  }

  async function chooseBase() {
    const result = await action(() => window.singularity.chooseWorkspaceBase());
    if (result) { setBaseDirectory(result); resetPreview(); }
  }

  function uniqueRepositoryId(candidate, taken = repositories.map((repository) => repository.id)) {
    const base = candidate || 'repository';
    let next = base;
    let suffix = 2;
    while (taken.includes(next)) next = `${base}-${suffix++}`;
    return next;
  }

  async function addRepositories() {
    const selected = await action(() => window.singularity.chooseWorkspaceRepositories());
    if (!selected?.length) return;
    setRepositories((currentRepositories) => {
      const next = [...currentRepositories];
      for (const repository of selected) {
        if (next.some((entry) => entry.url === repository.url)) continue;
        next.push(workspaceRepositoryDraft({
          ...repository,
          id: uniqueRepositoryId(repository.id, next.map((entry) => entry.id))
        }));
      }
      return next;
    });
    resetPreview();
  }

  function addRepositoryManually() {
    setRepositories((currentRepositories) => [
      ...currentRepositories,
      workspaceRepositoryDraft({
        id: uniqueRepositoryId('repository', currentRepositories.map((repository) => repository.id)),
        defaultBranch: 'main'
      })
    ]);
    resetPreview();
  }

  function updateRepository(index, field, value) {
    setRepositories((currentRepositories) => currentRepositories.map((repository, repositoryIndex) => (
      repositoryIndex === index ? { ...repository, [field]: value } : repository
    )));
    resetPreview();
  }

  function updateMetadata(repositoryIndex, metadataIndex, field, value) {
    setRepositories((currentRepositories) => currentRepositories.map((repository, index) => index === repositoryIndex ? {
      ...repository,
      metadata: repository.metadata.map((entry, entryIndex) => (
        entryIndex === metadataIndex ? { ...entry, [field]: value } : entry
      ))
    } : repository));
    resetPreview();
  }

  function addMetadata(repositoryIndex) {
    setRepositories((currentRepositories) => currentRepositories.map((repository, index) => index === repositoryIndex ? {
      ...repository,
      metadata: [...repository.metadata, { key: '', value: '' }]
    } : repository));
    resetPreview();
  }

  function removeMetadata(repositoryIndex, metadataIndex) {
    setRepositories((currentRepositories) => currentRepositories.map((repository, index) => index === repositoryIndex ? {
      ...repository,
      metadata: repository.metadata.filter((_, entryIndex) => entryIndex !== metadataIndex)
    } : repository));
    resetPreview();
  }

  function removeRepository(index) {
    if (repositories.length === 1) return;
    setRepositories((currentRepositories) => currentRepositories.filter((_, repositoryIndex) => repositoryIndex !== index));
    setLeadIndex((currentLead) => currentLead === index ? 0 : currentLead > index ? currentLead - 1 : currentLead);
    resetPreview();
  }

  function repositoryConfiguration() {
    return Object.fromEntries(repositories.map((repository) => {
      const id = repository.id.trim();
      return [id, {
        url: repository.url.trim(),
        defaultBranch: repository.defaultBranch.trim() || 'main',
        required: true,
        path: repository.path || `repos/${id}`,
        jira: { board: repository.jiraBoard.trim() },
        metadata: {
          name: repository.name.trim(),
          appId: repository.appId.trim(),
          ...Object.fromEntries(repository.metadata
            .filter((entry) => entry.key.trim() && entry.value.trim())
            .map((entry) => [entry.key.trim(), entry.value.trim()]))
        }
      }];
    }));
  }

  async function buildPreview() {
    const configuration = {
      name: workspaceName.trim(),
      repositories: repositoryConfiguration(),
      leadRepository: repositories[leadIndex]?.id.trim()
    };
    const result = await action(() => editorMode === 'edit'
      ? window.singularity.previewWorkspaceUpdate(repositoryRoot, health.workspace.path, configuration)
      : window.singularity.previewWorkspaceConfiguration(repositoryRoot, {
        ...configuration,
        baseDirectory,
        id: workspaceId.trim()
      }));
    if (result) {
      setPreview(result);
      requestAnimationFrame(() => saveActions.current?.scrollIntoView({ behavior: 'smooth', block: 'center' }));
    }
  }

  async function create() {
    const configuration = {
      name: workspaceName.trim(),
      repositories: repositoryConfiguration(),
      leadRepository: repositories[leadIndex]?.id.trim(),
      confirmation: workspaceId.trim()
    };
    const result = await action(() => editorMode === 'edit'
      ? window.singularity.updateWorkspaceConfiguration(repositoryRoot, health.workspace.path, configuration)
      : window.singularity.createWorkspaceConfiguration(repositoryRoot, {
        ...configuration,
        baseDirectory,
        id: workspaceId.trim()
      }), editorMode === 'edit' ? 'Workspace configuration updated' : 'Workspace configuration saved');
    if (result) {
      setEditorMode('closed');
      onOpened(result, 'workspaces');
    }
  }

  async function archive() {
    if (!health || archiveConfirmation !== health.workspace.anchor.key) return;
    const archived = await onArchiveWorkspace(health.workspace.path, archiveConfirmation);
    if (archived) {
      setArchiveOpen(false);
      setArchiveConfirmation('');
    }
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
    if (result?.snapshot) onOpened(result.snapshot, 'workspaces');
    else if (result) setHealth(result.status);
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
      repositoryRoot,
      health.workspace.path,
      document.path,
      workId
    ), `${document.name} imported, committed, and pushed for ${workId}`);
    if (result?.snapshot) onOpened(result.snapshot, 'workspaces');
  }

  const canPromoteDocuments = Boolean(
    repositoryRoot
    && data.workflow?.workItem?.id
    && data.repository?.branch === data.workflow.workItem.branch
    && data.session?.workId === data.workflow.workItem.id
  );
  const repositoryIds = repositories.map((repository) => repository.id.trim());
  const validRepositories = repositories.length > 0
    && new Set(repositoryIds).size === repositoryIds.length
    && repositories.every((repository) => {
      const metadataKeys = repository.metadata.map((entry) => entry.key.trim()).filter(Boolean);
      const metadataValid = repository.metadata.every((entry) => (
        (!entry.key.trim() && !entry.value.trim())
        || (
          /^[A-Za-z][A-Za-z0-9._-]{0,127}$/.test(entry.key.trim())
          && !['name', 'appId'].includes(entry.key.trim())
          && entry.value.trim()
        )
      )) && new Set(metadataKeys).size === metadataKeys.length;
      return /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(repository.id.trim())
        && repository.url.trim()
        && repository.name.trim()
        && repository.appId.trim()
        && metadataValid;
    });
  const formReady = Boolean(
    baseDirectory
    && workspaceName.trim()
    && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(workspaceId.trim())
    && validRepositories
    && repositories[leadIndex]
  );
  const missingWorkspaceFields = [
    !workspaceName.trim() && 'workspace name',
    !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(workspaceId.trim()) && 'valid workspace ID',
    !baseDirectory && 'local working directory',
    !validRepositories && 'complete repository details'
  ].filter(Boolean);
  const materializedRepositoryIds = new Set(
    editorMode === 'edit' ? Object.keys(health?.workspace?.repositories ?? {}) : []
  );
  const setupNeedsAttention = data.workspaceSetup?.mode?.startsWith('saved-needs') === true;

  return <div className="page workspace-page">
    <header className="page-heading row-between"><div><span className="eyebrow">One place for project setup</span><h1>Workspace configuration</h1><p>Create as many isolated workspaces as you need. Each workspace has one lead Git repository for Epic-level artifacts and any number of participating repositories.</p></div>{health && <Pill tone={health.healthy && !setupNeedsAttention ? 'good' : 'warn'}>{health.healthy && !setupNeedsAttention ? 'Workspace healthy' : 'Needs attention'}</Pill>}</header>

    {data.workspaceSetup?.mode?.startsWith('saved') && <div className={`workspace-save-result ${setupNeedsAttention ? 'warning' : 'success'}`} role="status"><span>{setupNeedsAttention ? '!' : '✓'}</span><div><strong>Workspace configuration saved</strong><small>{data.workspaceSetup.message}</small></div></div>}

    {health && <section className="workspace-current panel">
      <header className="workspace-current-head"><div><span className="workspace-anchor-type">Active workspace</span><h2>{health.workspace.name}</h2><p>{health.workspace.path}</p></div><div className="workspace-actions"><button className="ghost" onClick={refreshHealth}>Refresh health</button><button className="secondary" onClick={sync}>Fetch remotes</button><button className="secondary" onClick={stageDocuments}>Stage documents</button><button className="secondary" onClick={onSetupJira}>Jira connection</button><button className="secondary" onClick={editWorkspace}>Edit workspace</button><button className="ghost" onClick={newWorkspace}>New workspace</button><button className="ghost danger" onClick={() => setArchiveOpen((open) => !open)}>Archive</button>{!health.healthy && <button className="primary" onClick={repair}>Repair missing clones</button>}</div></header>
      {archiveOpen && <div className="workspace-archive-confirmation"><div><strong>Archive without deleting anything</strong><span>This removes the workspace from active selection. Its folder, cloned repositories, documents, and Git history remain in place and it can be restored later.</span></div><label><span>Type {health.workspace.anchor.key} to confirm</span><input value={archiveConfirmation} onChange={(event) => setArchiveConfirmation(event.target.value)} /></label><button className="secondary danger" disabled={archiveConfirmation !== health.workspace.anchor.key} onClick={archive}>Archive workspace</button><button className="ghost" onClick={() => { setArchiveOpen(false); setArchiveConfirmation(''); }}>Cancel</button></div>}
      <div className="workspace-health-grid">
        <div><span>Repositories</span><strong>{health.counts.ready}/{health.counts.repositories}</strong><small>ready</small></div>
        <div><span>Dirty clones</span><strong>{health.counts.dirty}</strong><small>never auto-updated</small></div>
        <div><span>Staged documents</span><strong>{health.counts.stagedDocuments}</strong><small>not governed</small></div>
        <div><span>Epic artifact home</span><strong>{health.workspace.leadRepository}</strong><small>{health.leadRepositoryPath}</small></div>
      </div>
      <div className="workspace-repository-list">{health.repositories.map((repository) => <div key={repository.id}><span className={`workspace-state ${repository.state}`} /><div><strong>{repository.metadata?.name ?? repository.id}</strong><small>{repository.metadata?.appId} · Jira {repository.jira?.board ?? 'not set'} · {repository.absolutePath}</small></div><Pill tone={repository.role === 'lead' ? 'accent' : 'neutral'}>{repository.role === 'lead' ? 'Epic lead' : 'participant'}</Pill><span>{repository.branch ?? 'not cloned'}</span><span className={repository.dirty ? 'warning-copy' : ''}>{repository.dirty == null ? '—' : repository.dirty ? 'dirty' : 'clean'}</span><Pill tone={repository.state === 'ready' ? 'good' : 'warn'}>{repository.state}</Pill></div>)}</div>
      {!!health.stagedDocuments.length && <div className="workspace-staged"><header><div><span className="eyebrow">Local document inbox</span><h3>Staged — not governed</h3><p>{canPromoteDocuments ? `Import into checked-out work item ${data.workflow.workItem.id} to commit and push a governed copy.` : 'Resume a work item and select a session persona before importing these files.'}</p></div><Pill tone="warn">{health.stagedDocuments.length} local</Pill></header>{health.stagedDocuments.map((document) => <div key={document.path}><strong>{document.name}</strong><code>{document.sha256.slice(0, 12)}</code><span>{document.bytes.toLocaleString()} bytes</span><button className="secondary compact" disabled={!canPromoteDocuments} onClick={() => promoteDocument(document)}>Import to work item</button></div>)}</div>}
    </section>}

    {!!recentWorkspaces.length && <RecentWorkspaces items={recentWorkspaces} currentPath={health?.workspace?.path} busy={false} onOpen={onOpenWorkspace} onForget={onForgetWorkspace} />}
    <ArchivedWorkspaces items={recentWorkspaces} busy={false} onRestore={onRestoreWorkspace} />

    {editorMode !== 'closed' && <section className="workspace-create panel">
      <header className="panel-heading"><div><span className="eyebrow">{editorMode === 'edit' ? 'Edit active workspace' : 'New workspace'}</span><h2>{editorMode === 'edit' ? 'Update repository routing and metadata' : 'Define the project boundary once'}</h2><p>{editorMode === 'edit' ? 'Existing clone identities remain fixed. You can update the name, Jira project routing, App IDs, metadata, lead designation, and add repositories.' : 'Jira connection and initiative governance are not separate setup steps. Repository routing lives here.'}</p></div><div className="row gap"><Pill>{repositories.length} repositories</Pill>{health && <button className="ghost compact" onClick={closeEditor}>Cancel</button>}</div></header>
      <div className={`workspace-save-callout ${formReady ? 'ready' : ''}`}>
        <div><span className="eyebrow">Workspace action</span><strong>{editorMode === 'edit' ? 'Save workspace changes' : 'Save workspace'}</strong><small>{formReady ? 'All required details are ready. Review the target and repository plan, then save.' : `Complete: ${missingWorkspaceFields.join(', ')}.`}</small></div>
        <button className="primary" disabled={!formReady} onClick={buildPreview}>{preview ? 'Refresh save plan' : editorMode === 'edit' ? 'Review changes' : 'Review save plan'}</button>
      </div>
      <div className="workspace-identity-grid">
        <label><span>Workspace name</span><input value={workspaceName} placeholder="Payments modernization" onChange={(event) => { setWorkspaceName(event.target.value); resetPreview(); }} /></label>
        <label><span>Workspace ID</span><input readOnly={editorMode === 'edit'} value={workspaceId} placeholder="payments-modernization" onChange={(event) => { setWorkspaceId(event.target.value); resetPreview(); }} /></label>
        <label className="workspace-directory-field"><span>{editorMode === 'edit' ? 'Workspace location' : 'Local working directory'}</span><div><input readOnly value={baseDirectory} placeholder="Choose a parent folder" />{editorMode !== 'edit' && <button className="secondary" onClick={chooseBase}>{baseDirectory ? 'Change' : 'Choose'}</button>}</div></label>
      </div>
      <div className="workspace-repository-config">
        <header><div><span className="eyebrow">Repository registry</span><h3>Add delivery repositories</h3><p>Every repository requires an application identity and exactly one lead designation. Jira routing is optional and can be added later.</p></div><div className="row"><button className="ghost compact" onClick={addRepositoryManually}>＋ Enter URL</button><button className="secondary compact" onClick={addRepositories}>＋ Add local repos</button></div></header>
        {repositories.map((repository, index) => { const materialized = materializedRepositoryIds.has(repository.id); return <article className={`workspace-repository-editor ${leadIndex === index ? 'lead' : ''}`} key={`${index}-${repository.localPath}`}>
          <header><label className="workspace-lead-choice"><input type="radio" name="lead-repository" checked={leadIndex === index} onChange={() => { setLeadIndex(index); resetPreview(); }} /><span><strong>{leadIndex === index ? 'Lead repository' : 'Make lead'}</strong><small>{leadIndex === index ? 'Epic-level artifacts are committed here' : materialized ? 'Existing materialized repository' : 'New repository will be cloned'}</small></span></label>{repositories.length > 1 && !materialized && <button className="ghost compact" onClick={() => removeRepository(index)}>Remove</button>}</header>
          <div className="workspace-repository-fields">
            <label><span>Repository ID</span><input readOnly={materialized} value={repository.id} placeholder="mobile" onChange={(event) => updateRepository(index, 'id', event.target.value)} /></label>
            <label><span>Display name</span><input value={repository.name} placeholder="Mobile application" onChange={(event) => updateRepository(index, 'name', event.target.value)} /></label>
            <label className="wide"><span>Git clone URL</span><input readOnly={materialized} value={repository.url} placeholder="git@github.com:company/mobile.git" onChange={(event) => updateRepository(index, 'url', event.target.value)} /></label>
            <label><span>Default branch</span><input readOnly={materialized} value={repository.defaultBranch} placeholder="main" onChange={(event) => updateRepository(index, 'defaultBranch', event.target.value)} /></label>
            <label><span>Jira project key <em>optional</em></span><input value={repository.jiraBoard} placeholder="Add later if needed" onChange={(event) => updateRepository(index, 'jiraBoard', event.target.value.toUpperCase())} /><small>Needed only for Jira features. Add or change it any time through Edit workspace.</small></label>
            <label><span>Application ID</span><input value={repository.appId} placeholder="APP-1001" onChange={(event) => updateRepository(index, 'appId', event.target.value)} /></label>
          </div>
          <div className="workspace-metadata-editor"><header><div><strong>Additional metadata</strong><span>Optional repository-specific key/value pairs.</span></div><button className="ghost compact" onClick={() => addMetadata(index)}>＋ Add field</button></header>{repository.metadata.map((entry, metadataIndex) => <div key={metadataIndex}><input aria-label={`Repository ${index + 1} metadata key ${metadataIndex + 1}`} value={entry.key} placeholder="owner" onChange={(event) => updateMetadata(index, metadataIndex, 'key', event.target.value)} /><input aria-label={`Repository ${index + 1} metadata value ${metadataIndex + 1}`} value={entry.value} placeholder="Digital Channels" onChange={(event) => updateMetadata(index, metadataIndex, 'value', event.target.value)} /><button className="ghost compact" aria-label={`Remove metadata ${metadataIndex + 1}`} onClick={() => removeMetadata(index, metadataIndex)}>×</button></div>)}</div>
        </article>; })}
      </div>
      {!validRepositories && <div className="workspace-form-note">Complete a unique repository ID, display name, Git URL, and Application ID for every repository. Jira project keys are optional.</div>}
      <div className="workspace-preview-actions" ref={saveActions}>{preview ? <><div className="workspace-save-plan"><strong>Preview ready — not saved yet</strong><small>The configuration will be stored in workspace.json; repository clones can be repaired independently.</small></div><code>{preview.root}/workspace.json</code><button className="primary" onClick={create}>{editorMode === 'edit' ? 'Save workspace changes' : 'Save workspace now'}</button></> : <div className="workspace-save-plan"><strong>No save plan yet</strong><small>Complete the required fields, then use the review action above.</small></div>}</div>
      {preview && <div className="workspace-operation-list">{preview.operations.map((operation) => <div key={operation.repository}><Pill tone={operation.repository === repositories[leadIndex]?.id.trim() ? 'accent' : 'neutral'}>{operation.repository === repositories[leadIndex]?.id.trim() ? 'Epic lead' : operation.action}</Pill><strong>{operation.repository}</strong><code>{operation.url}</code><span>{operation.target}</span></div>)}</div>}
    </section>}
  </div>;
}

function JiraPolicySetup({ data, action, reload, onConfigured, onCancel }) {
  const existing = data.portfolio?.jira ?? {};
  const [values, setValues] = useState({
    deployment: existing.deployment ?? 'cloud',
    baseUrl: '',
    projectKey: existing.projectKey ?? '',
    writeMode: existing.writeMode ?? 'off'
  });
  const set = (name, value) => setValues((current) => ({ ...current, [name]: value }));
  const ready = /^https:\/\//i.test(values.baseUrl) && (!values.projectKey || /^[A-Z][A-Z0-9_-]{0,31}$/.test(values.projectKey));

  async function save() {
    let hostname;
    try {
      const parsed = new URL(values.baseUrl);
      if (parsed.protocol !== 'https:' || parsed.username || parsed.password) throw new Error();
      hostname = parsed.hostname.toLowerCase();
    } catch {
      return action(() => Promise.reject(new Error('Enter a Jira HTTPS URL without embedded credentials.')));
    }
    const document = YAML.parseDocument(data.portfolioText);
    document.setIn(['jira', 'enabled'], true);
    document.setIn(['jira', 'connection'], existing.connection ?? 'corporate-jira');
    document.setIn(['jira', 'deployment'], values.deployment);
    document.setIn(['jira', 'allowedHosts'], [hostname]);
    document.setIn(['jira', 'allowedProjects'], values.projectKey ? [values.projectKey] : []);
    document.setIn(['jira', 'authentication', 'permitted'], values.deployment === 'data-center' ? ['pat'] : ['user-token', 'service-account']);
    document.setIn(['jira', 'writeMode'], values.writeMode);
    document.setIn(['jira', 'write'], values.writeMode === 'approved');
    document.setIn(['jira', 'projectKey'], values.projectKey);
    const result = await action(
      () => window.singularity.saveFile(data.repository.root, data.portfolioPath, String(document)),
      'Jira policy saved and validated'
    );
    if (!result) return;
    const published = await action(
      () => window.singularity.publish(data.repository.root, 'Configure governed Jira access'),
      'Jira policy committed and pushed'
    );
    if (!published) return;
    onConfigured(values);
    await reload();
  }

  return <div className="page jira-policy-page">
    <header className="page-heading row-between"><div><span className="eyebrow">Jira setup · Step 1 of 2</span><h1>Enable Jira for this workspace</h1><p>Choose the governed Jira boundary first. Your account token is requested only after this policy validates.</p></div><button className="ghost" onClick={onCancel}>Back to Epic</button></header>
    <section className="jira-connect panel">
      <div className="jira-connect-copy"><span className="jira-mark">J</span><span className="eyebrow">Repository policy</span><h2>Define where Singularity may connect</h2><p>The allowed host and project are committed with the repository. Passwords and tokens never enter this file.</p><ul><li>HTTPS is mandatory.</li><li>Project scope is checked before reads and writes.</li><li>Story creation stays off unless explicitly enabled.</li></ul></div>
      <div className="jira-connect-form">
        <label><span>Deployment</span><select value={values.deployment} onChange={(event) => set('deployment', event.target.value)}><option value="cloud">Jira Cloud</option><option value="data-center">Jira Data Center</option></select></label>
        <label><span>Project key</span><input value={values.projectKey} placeholder="APP" onChange={(event) => set('projectKey', event.target.value.toUpperCase())} /></label>
        <label className="full"><span>Jira HTTPS URL</span><input value={values.baseUrl} placeholder="https://company.atlassian.net" onChange={(event) => set('baseUrl', event.target.value)} /></label>
        <label className="full"><span>Story write policy</span><select value={values.writeMode} onChange={(event) => set('writeMode', event.target.value)}><option value="off">Browse and import only</option><option value="preview">Preview and commit write plans</option><option value="approved">Apply explicitly approved write plans</option></select></label>
        <button className="primary full" disabled={!ready} onClick={save}>Save policy & enter credentials</button>
      </div>
    </section>
  </div>;
}

function JiraWorkspace({ data, action, reload, onConfigure, bootstrapPortfolio, onDone }) {
  const policy = data.portfolio?.jira;
  const repositoryIds = Object.keys(data.portfolio?.repositories ?? {});
  const [status, setStatus] = useState(null);
  const [connection, setConnection] = useState(() => jiraCredentialDraft({
    name: policy?.connection ?? 'corporate-jira'
  }, policy?.deployment ?? 'cloud'));
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
      ...jiraCredentialPayload(connection, policy.deployment)
    }), 'Jira connection verified and stored securely');
    if (!result) return;
    setConnection((current) => ({ ...current, pat: '' }));
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
    if (!window.confirm('Reset every saved Jira connection for this OS account? Repository policy, workspace routing, and Git state will not be changed.')) return;
    const result = await action(
      () => window.singularity.resetJiraCredentials(data.repository.root),
      'All saved Jira credentials were reset; reconnect when ready'
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

  if (!data.portfolio && data.workspace?.workspace) {
    return <WorkspaceJiraConnection data={data} action={action} onDone={onDone} />;
  }
  if (!data.portfolio) return <div className="page"><PortfolioSetup data={data} action={action} onCreated={async (snapshot, setup) => {
    const published = await action(
      () => window.singularity.publish(data.repository.root, 'Initialize governed Jira access'),
      'Jira policy committed and pushed'
    );
    if (!published) return;
    setConnection((current) => ({
      ...current,
      deployment: setup.deployment,
      baseUrl: setup.baseUrl
    }));
    bootstrapPortfolio(await reload() ?? snapshot);
  }} jiraFirst onCancel={onDone} /></div>;
  if (!policy?.enabled) return <JiraPolicySetup data={data} action={action} reload={reload} onConfigured={(setup) => setConnection((current) => ({
    ...current,
    deployment: setup.deployment,
    baseUrl: setup.baseUrl
  }))} onCancel={onDone} />;

  const connected = status?.credentials?.connected;
  return <div className="page jira-page">
    <header className="page-heading row-between"><div><span className="eyebrow">Secure corporate integration</span><h1>Jira workspace</h1><p>Credentials stay in the operating-system keychain. Every import is hash-snapshotted; every write is previewed, confirmed, committed, and receipted.</p></div><div className="row gap"><button className="ghost compact" onClick={onDone}>Back to Epic</button><button className="ghost compact" onClick={onConfigure}>Policy YAML</button><button className="ghost compact danger-text" onClick={resetCredentials}>Reset saved Jira</button>{connected && <><Pill tone="good">Connected</Pill><button className="secondary compact" onClick={() => loadProjects(true)}>↻ Refresh</button><button className="ghost compact" onClick={disconnect}>Disconnect</button></>}</div></header>
    {!connected ? status?.credentials?.recovery?.required ? <section className="jira-credential-recovery panel" role="alert">
      <span className="jira-mark">!</span>
      <div><span className="eyebrow">Local credential recovery</span><h2>Jira credentials cannot be read</h2><p>{status.credentials.recovery.message}</p><p>Reset removes only the unreadable encrypted Jira file from this operating-system account. Repository configuration and Git state are unchanged.</p></div>
      <button className="primary" onClick={resetCredentials}>Reset Jira credentials</button>
      </section> : <section className="jira-connect panel"><div className="jira-connect-copy"><span className="jira-mark">J</span><span className="eyebrow">One-time setup</span><h2>Connect your Jira account</h2><p>{policy.deployment === 'cloud' ? 'Enter the Jira URL, username, and PAT/API token. The renderer never receives the token again after this form is submitted.' : 'Enter the Jira URL and Data Center personal access token. Password authentication is not supported.'}</p><ul><li>HTTPS and repository host allowlists are enforced.</li><li>Permissions are discovered before writes.</li><li>Tokens never enter Git, CLI child environments, logs, or planning prompts.</li></ul></div><div className="jira-connect-form"><JiraCredentialFields connection={{ ...connection, deployment: policy.deployment }} setConnection={setConnection} deploymentLocked /><button className="primary full" disabled={!jiraCredentialsReady(connection, policy.deployment)} onClick={connect}>Test connection & save securely</button>{status?.error && <p className="warning-copy full">{status.error}</p>}</div></section> : <>
      <section className="jira-context-strip"><div><span>Connection</span><strong>{status.credentials.connection?.name}</strong><small>{status.credentials.connection?.baseUrl}</small></div><div><span>Account</span><strong>{status.credentials.connection?.account?.displayName ?? status.credentials.connection?.username ?? status.credentials.connection?.email}</strong><small>{status.credentials.connection?.authMode}</small></div><div><span>Policy</span><strong>{policy.writeMode} writes</strong><small>{policy.allowedProjects?.length ? `${policy.allowedProjects.length} allowed projects` : 'all visible projects'}</small></div><div><span>Cache</span><strong>{policy.read.cacheMinutes} minutes</strong><small>manual refresh available</small></div></section>
      <div className="jira-browser">
        <aside className="jira-projects panel"><header><span className="eyebrow">Scope</span><h2>Projects</h2></header>{!projects.length && <button className="primary" onClick={() => loadProjects()}>Load permitted projects</button>}{projects.map((project) => <button className={project.key === projectKey ? 'active' : ''} key={project.key} onClick={() => loadEpics(project.key)}><span>{project.key.slice(0, 2)}</span><div><strong>{project.name}</strong><small>{project.key} · {project.projectType ?? 'software'}</small></div></button>)}</aside>
        <section className="jira-epics panel"><header className="panel-heading"><div><span className="eyebrow">Existing Jira hierarchy</span><h2>{projectKey ? `${projectKey} Epics` : 'Choose a project'}</h2></div><span>{epics.length} visible</span></header>{!epics.length && projectKey && <div className="inline-empty">No Epics loaded. Refresh the project to query Jira.</div>}{epics.map((epic) => <button className={selectedEpic?.key === epic.key ? 'active' : ''} key={epic.key} onClick={() => chooseEpic(epic)}><StatusDot status={epic.statusCategory === 'Done' ? 'approved' : 'in_progress'} /><div><strong>{epic.key} — {epic.title}</strong><small>{epic.status ?? 'unknown status'} · updated {formatRecentTime(epic.updatedAt)}</small></div><span>→</span></button>)}</section>
        <aside className="jira-story-panel panel">{selectedEpic ? <><header><span className="eyebrow">Epic children</span><h2>{selectedEpic.key}</h2><p>{selectedEpic.title}</p></header><div className="jira-story-list">{stories.map((story) => <div key={story.key}><div><strong>{story.key}</strong><span>{story.title}</span><small>{story.issueType} · {story.status ?? 'unknown'}</small></div><label><span>Owning repository</span><select value={repositoryMap[story.key] ?? ''} onChange={(event) => setRepositoryMap({ ...repositoryMap, [story.key]: event.target.value })}><option value="">Choose repository…</option>{repositoryIds.map((id) => <option value={id} key={id}>{id}</option>)}</select></label></div>)}</div><label><span>Target Singularity initiative</span><select value={initiativeId} onChange={(event) => { setInitiativeId(event.target.value); setAdoption(null); }}><option value="">Choose initiative…</option>{data.initiatives.map((initiative) => <option value={initiative.id} key={initiative.id}>{initiative.id} — {initiative.title}</option>)}</select></label><div className="jira-actions"><button className="secondary" disabled={!initiativeId || stories.some((story) => !repositoryMap[story.key])} onClick={previewAdoption}>Preview adoption</button><button className="primary" disabled={!adoption?.ready} onClick={adopt}>Adopt into Git</button></div>{adoption && <div className={`jira-adoption ${adoption.ready ? 'ready' : 'warn'}`}><strong>{adoption.ready ? 'Ready to adopt' : 'Mapping incomplete'}</strong><span>{adoption.draft?.epics?.[0]?.stories?.length ?? adoption.breakdown?.stories?.length} stories · source {adoption.sourceSha256?.slice(0, 12)}</span>{adoption.unresolved?.length > 0 && <small>Map: {adoption.unresolved.map((item) => item.jiraKey).join(', ')}</small>}</div>}</> : <Empty title="Choose an Epic" detail="Its child stories, Jira status, and repository ownership controls will appear here." />}</aside>
      </div>
      {initiativeId && <section className="panel jira-write-plan"><header className="panel-heading"><div><span className="eyebrow">Governed outbound synchronization</span><h2>Jira write plan</h2></div><Pill tone={policy.writeMode === 'approved' ? 'warn' : 'neutral'}>{policy.writeMode}</Pill></header><p>Generate a hash-pinned diff from the approved Singularity story plan. No Jira mutation occurs until the plan phase is approved and the exact initiative ID and plan hash are confirmed.</p><div className="jira-plan-actions"><button className="secondary" disabled={policy.writeMode === 'off'} onClick={planWrites}>Generate & commit plan</button>{writePlan && <><code>{writePlan.sha256}</code><input aria-label="Exact initiative confirmation" placeholder={`Type ${initiativeId}`} value={applyConfirmation} onChange={(event) => setApplyConfirmation(event.target.value)} /><button className="primary" disabled={policy.writeMode !== 'approved' || applyConfirmation !== initiativeId} onClick={applyWrites}>Apply reviewed plan</button></>}</div>{writePlan && <div className="jira-operation-list">{writePlan.operations.map((operation) => <div key={operation.id}><Pill tone={operation.action.startsWith('create') ? 'accent' : 'warn'}>{operation.action}</Pill><strong>{operation.subject.jiraKey ?? operation.subject.id}</strong><span>{Object.keys(operation.fields ?? operation.issue ?? {}).join(', ')}</span></div>)}</div>}</section>}
    </>}
  </div>;
}

function businessStatusLabel(value) {
  return String(value ?? 'not_started').replaceAll('_', ' ');
}

function documentExcerpt(content, fallback = 'No preview text is available for this document yet.') {
  if (!content) return fallback;
  const plain = String(content)
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .split('\n')
    .map((line) => line.replace(/^#{1,6}\s+/, '').replace(/^[-*]\s+/, '').trim())
    .filter(Boolean)
    .slice(0, 4)
    .join(' · ');
  return plain.length > 280 ? `${plain.slice(0, 277)}…` : plain || fallback;
}

function approvalDisplayName(approval) {
  if (!approval) return 'No approval yet';
  if (approval.actorName && approval.actorEmail && approval.actorName !== approval.actorEmail) return `${approval.actorName} · ${approval.actorEmail}`;
  return approval.actorName ?? approval.actorEmail ?? approval.actor ?? 'Unknown approver';
}

function artifactPath(document) {
  return document?.repositoryPath ?? document?.path ?? null;
}

function artifactFormat(document) {
  const file = String(artifactPath(document) ?? document?.label ?? '').toLowerCase();
  const kind = String(document?.kind ?? '').toLowerCase();
  if (kind === 'json' || file.endsWith('.json') || file.endsWith('.jsonl')) return 'json';
  if (kind === 'yaml' || file.endsWith('.yml') || file.endsWith('.yaml')) return 'yaml';
  if (kind === 'markdown' || kind === 'interface-contract' || file.endsWith('.md') || file.endsWith('.markdown')) return 'markdown';
  if (kind === 'text' || file.endsWith('.txt')) return 'text';
  if (document?.mimeType?.startsWith('image/')) return 'image';
  if (document?.mimeType === 'application/pdf') return 'pdf';
  return kind || 'document';
}

function prettyArtifactContent(document, content) {
  if (content == null) return null;
  if (artifactFormat(document) !== 'json') return String(content);
  try { return JSON.stringify(JSON.parse(content), null, 2); }
  catch { return String(content); }
}

function JsonArtifactNode({ name = null, value, depth = 0 }) {
  const compound = value !== null && typeof value === 'object';
  if (!compound) return <div className="json-artifact-leaf"><span>{name}</span><code className={value === null ? 'null' : typeof value}>{value === null ? 'null' : typeof value === 'string' ? `"${value}"` : String(value)}</code></div>;
  const entries = Object.entries(value);
  const label = Array.isArray(value) ? `${entries.length} item${entries.length === 1 ? '' : 's'}` : `${entries.length} field${entries.length === 1 ? '' : 's'}`;
  return <details className="json-artifact-node" open={depth < 2}>
    <summary>{name != null && <strong>{name}</strong>}<span>{Array.isArray(value) ? 'Array' : 'Object'} · {label}</span></summary>
    <div>{entries.map(([key, child]) => <JsonArtifactNode key={key} name={Array.isArray(value) ? `[${key}]` : key} value={child} depth={depth + 1} />)}</div>
  </details>;
}

function ArtifactPreviewDialog({ viewer, onClose, onDownload }) {
  const [mode, setMode] = useState('preview');
  useEffect(() => { setMode('preview'); }, [viewer?.document?.id, viewer?.document?.repositoryPath, viewer?.document?.path]);
  useEffect(() => {
    if (!viewer) return undefined;
    const close = (event) => { if (event.key === 'Escape') onClose(); };
    window.addEventListener('keydown', close);
    return () => window.removeEventListener('keydown', close);
  }, [viewer, onClose]);
  if (!viewer) return null;
  const document = viewer.document;
  const format = artifactFormat(document);
  const content = prettyArtifactContent(document, viewer.content);
  let parsedJson = null;
  if (format === 'json' && content != null) {
    try { parsedJson = JSON.parse(content); } catch { /* Invalid JSON remains inspectable as source. */ }
  }
  const generated = document.status !== 'not_generated' && Boolean(document.sha256 || content != null || artifactPath(document));
  const headings = format === 'markdown'
    ? String(content ?? '').split('\n').filter((line) => /^#{1,3}\s+/.test(line)).map((line) => ({ depth: line.match(/^#+/)[0].length, label: line.replace(/^#+\s+/, '') })).slice(0, 18)
    : [];
  return <div className="modal-backdrop artifact-reader-backdrop" role="dialog" aria-modal="true" aria-label={`${document.label} artifact preview`} onClick={onClose}>
    <section className="artifact-reader" onClick={(event) => event.stopPropagation()}>
      <header className="artifact-reader-header">
        <div className="artifact-reader-identity"><span className={`artifact-reader-icon ${format}`}>{kindTag(document.path ?? document.kind)}</span><div><span className="eyebrow">{document.phase ?? 'Governed artifact'} · generation {document.generation ?? 0}</span><h2>{document.label}</h2><code>{artifactPath(document) ?? document.id}</code></div></div>
        <div className="row"><Pill tone={document.status === 'approved' ? 'good' : document.status === 'published' ? 'accent' : generated ? 'warn' : 'neutral'}>{businessStatusLabel(document.status ?? (generated ? 'generated' : 'not_generated'))}</Pill><button className="ghost compact" onClick={onClose}>Close</button></div>
      </header>
      <div className="artifact-reader-facts">
        <span><small>Format</small><strong>{format.toUpperCase()}</strong></span>
        <span><small>Version</small><strong>Generation {document.generation ?? 0}</strong></span>
        <span><small>Integrity</small><strong>{document.sha256 ? 'Hash recorded ✓' : 'Hash pending'}</strong></span>
        <span><small>SHA-256</small><code>{document.sha256?.slice(0, 16) ?? 'not generated'}</code></span>
        <span><small>Size</small><strong>{document.bytes || document.size ? formatBytes(document.bytes ?? document.size) : '—'}</strong></span>
      </div>
      <div className="artifact-reader-toolbar">
        <div className="artifact-reader-tabs"><button className={mode === 'preview' ? 'active' : ''} onClick={() => setMode('preview')}>{format === 'json' ? 'Structured view' : 'Readable view'}</button>{content != null && <button className={mode === 'source' ? 'active' : ''} onClick={() => setMode('source')}>Source</button>}</div>
        <div className="row">{content != null && <button className="ghost compact" onClick={() => copyText(content)}>Copy content</button>}{artifactPath(document) && <button className="secondary compact" onClick={() => onDownload(artifactPath(document))}>Download</button>}</div>
      </div>
      <div className={`artifact-reader-layout ${headings.length ? 'with-outline' : ''}`}>
        {headings.length > 0 && <aside className="artifact-reader-outline"><span className="eyebrow">On this page</span>{headings.map((heading, index) => <span style={{ paddingLeft: `${(heading.depth - 1) * 12}px` }} key={`${heading.label}:${index}`}>{heading.label}</span>)}</aside>}
        <main className="artifact-reader-content">
          {viewer.loading ? <div className="artifact-reader-empty"><span className="artifact-reader-spinner" /><h3>Loading governed artifact…</h3><p>Reading the committed file and verifying its catalog reference.</p></div>
            : viewer.error ? <div className="artifact-reader-empty error"><span>!</span><h3>Artifact could not be opened</h3><p>{viewer.error}</p></div>
              : !generated ? <div className="artifact-reader-empty"><span>○</span><h3>Not generated yet</h3><p>This configured output will become readable here after its phase publishes a generation.</p></div>
                : viewer.dataUrl?.startsWith('data:application/pdf') ? <iframe title={document.label} src={viewer.dataUrl} />
                  : viewer.dataUrl?.startsWith('data:image/') ? <img alt={document.label} src={viewer.dataUrl} />
                    : content == null ? <div className="artifact-reader-empty"><span>{kindTag(document.path ?? document.kind)}</span><h3>No safe inline preview</h3><p>Download this governed artifact and open it with its native application.</p></div>
                      : mode === 'source' ? <pre className={`artifact-source ${format}`}><code>{content}</code></pre>
                        : format === 'json' && parsedJson != null ? <div className="json-artifact-preview"><JsonArtifactNode value={parsedJson} /></div>
                          : format === 'markdown' ? <TemplatePreview className="artifact-markdown-preview" content={content} />
                            : <pre className={`artifact-source ${format}`}><code>{content}</code></pre>}
        </main>
      </div>
    </section>
  </div>;
}

function useArtifactViewer({ repository, workId = null, downloadFile }) {
  const [viewer, setViewer] = useState(null);
  const closeArtifact = useCallback(() => setViewer(null), []);
  const openArtifact = useCallback(async (document) => {
    if (!document) return;
    if (document.content != null || !workId || !document.id) {
      setViewer({ document, content: document.content ?? null, loading: false });
      return;
    }
    setViewer({ document, content: null, loading: true });
    try {
      const result = await window.singularity.previewDocument(repository, workId, document.id);
      setViewer({ document: { ...document, ...(result.record ?? {}) }, ...result, loading: false });
    } catch (error) {
      setViewer({ document, content: null, loading: false, error: error?.message ?? String(error) });
    }
  }, [repository, workId]);
  return {
    openArtifact,
    artifactViewer: <ArtifactPreviewDialog viewer={viewer} onClose={closeArtifact} onDownload={downloadFile} />
  };
}

function EpicBusinessOverview({ data, downloadFile }) {
  const selected = data.initiative;
  const state = selected.state;
  const report = selected.report ?? {};
  const progress = selected.progress ?? {};
  const phases = report.phases?.length ? report.phases : progress.phases ?? [];
  const documents = selected.documents ?? [];
  const generatedDocuments = documents.filter((document) => document.status !== 'not_generated' && (document.sha256 || document.content || document.status === 'approved' || document.status === 'published'));
  const approvals = report.approvals?.recent ?? [];
  const approvalsByPhase = report.approvals?.byPhase ?? {};
  const currentPhase = state.currentPhase ? state.phases[state.currentPhase] : null;
  const percent = progress.percentage ?? 0;
  const jiraSnapshot = selected.sources?.jiraSnapshot ? 1 : 0;
  const totalSources = (report.sources?.total ?? selected.sources?.sources?.length ?? 0) + jiraSnapshot;
  const pinnedSources = (report.sources?.pinned ?? 0) + jiraSnapshot;
  const storyTotal = report.children?.total ?? selected.breakdown?.stories?.length ?? 0;
  const storyComplete = report.children?.complete ?? 0;
  const storyMaterialized = report.children?.materialized ?? 0;
  const selfApprovals = report.approvals?.selfApprovals?.length ?? 0;
  const phaseCount = phases.length || state.phaseOrder.length;
  const approvedPhases = phases.filter((phase) => phase.status === 'approved').length;
  const { openArtifact, artifactViewer } = useArtifactViewer({ repository: data.repository.root, downloadFile });
  return <div className="page dashboard-page epic-business-page">
    <section className="epic-command-hero">
      <div className="epic-command-copy">
        <span className="eyebrow">Business command center</span>
        <div className="row gap"><Pill tone="accent">{state.initiative.profileLabel}</Pill><Pill tone={state.status === 'complete' ? 'good' : 'neutral'}>{state.status}</Pill><Pill>{report.identityAssurance ?? 'configured-local'} identity</Pill></div>
        <h1>{state.initiative.title}</h1>
        <p>{state.initiative.id} · branch {state.initiative.branch} · current stage {currentPhase?.label ?? 'complete'}</p>
        <div className="epic-business-refresh"><span>↻</span><strong>Run work in Copilot CLI, then press Refresh here.</strong><small>This screen reads only committed Git/Jira lineage, so it shows exactly what reviewers and business users can trust.</small></div>
      </div>
      <div className="epic-command-progress"><ProgressRing value={percent} /><span><b>{approvedPhases}/{phaseCount}</b> phases approved</span></div>
    </section>
    <div className="epic-business-metrics">
      <div><span>Current stage</span><strong>{currentPhase?.label ?? 'Complete'}</strong><small>{state.currentPhase ?? 'all gates complete'}</small></div>
      <div><span>Generated documents</span><strong>{generatedDocuments.length}/{documents.length}</strong><small>hash-bound artifacts</small></div>
      <div><span>Approvals</span><strong>{report.approvals?.records ?? 0}</strong><small>{selfApprovals ? `${selfApprovals} self-approval warning${selfApprovals === 1 ? '' : 's'}` : 'review decisions recorded'}</small></div>
      <div><span>Pinned sources</span><strong>{pinnedSources}/{totalSources}</strong><small>Jira and uploaded evidence</small></div>
      <div><span>Stories</span><strong>{storyComplete}/{storyTotal}</strong><small>{storyMaterialized} materialized</small></div>
      <div><span>Elapsed</span><strong>{report.duration ?? '—'}</strong><small>wall-clock lifecycle</small></div>
    </div>
    {selfApprovals > 0 && <div className="notice warn">⚠ {selfApprovals} self-approval{selfApprovals === 1 ? '' : 's'} recorded. Valid if configured, but not independent business review.</div>}
    <div className="epic-business-grid">
      <section className="panel business-phase-board">
        <header className="panel-heading"><div><span className="eyebrow">Epic progress</span><h2>Phase-by-phase status</h2></div><Pill tone={state.status === 'complete' ? 'good' : 'accent'}>{percent}% complete</Pill></header>
        <div className="business-phase-list">
          {phases.map((phase, index) => {
            const phaseApprovals = approvalsByPhase[phase.id] ?? [];
            const latestApproval = phaseApprovals[0] ?? null;
            return <article className={`${phase.status.replaceAll('_', '-')} ${phase.id === state.currentPhase ? 'current' : ''}`} key={phase.id}>
              <div className="business-phase-step"><span>{index + 1}</span><StatusDot status={phase.status} /></div>
              <div><h3>{phase.label}</h3><p>{businessStatusLabel(phase.status)}</p></div>
              <div className="business-phase-facts"><span>{phase.publishedOutputs ?? phase.generatedOutputs ?? 0}/{phase.outputs ?? 0} docs</span><span>generation {phase.generation ?? phase.generations ?? 0}</span><span>{phase.errors?.length ? `${phase.errors.length} blockers` : phase.warnings?.length ? `${phase.warnings.length} warnings` : 'gate clean'}</span></div>
              <div className={latestApproval ? 'phase-approved-by' : 'phase-approved-by empty'}><strong>{latestApproval ? approvalDisplayName(latestApproval) : 'Not approved yet'}</strong><small>{latestApproval ? `${latestApproval.decision} · ${formatRecentTime(latestApproval.at)}${latestApproval.selfApproval ? ' · self-approval' : ''}` : 'No reviewer decision recorded for this phase.'}</small></div>
            </article>;
          })}
          {!phases.length && <div className="inline-empty">No Epic phases have been recorded yet. Start or refresh the Epic workspace.</div>}
        </div>
      </section>
      <section className="panel business-approval-register">
        <header className="panel-heading"><div><span className="eyebrow">Governance</span><h2>Who approved</h2></div><Pill>{approvals.length} recent</Pill></header>
        <div className="business-approval-list">
          {approvals.map((approval) => <article key={approval.sha256 ?? `${approval.phase}:${approval.subject}:${approval.at}`}>
            <span className="approval-avatar">{approval.actorName?.slice(0, 1)?.toUpperCase() ?? '✓'}</span>
            <div><strong>{approvalDisplayName(approval)}</strong><small>{approval.phase} · {approval.subject} · {formatRecentTime(approval.at)}</small></div>
            <Pill tone={approval.selfApproval ? 'warn' : 'good'}>{approval.selfApproval ? 'self-approval' : approval.decision}</Pill>
          </article>)}
          {!approvals.length && <div className="inline-empty">No approvals have been committed yet. Approved stages will show the person, persona, time, and exact subject here.</div>}
        </div>
      </section>
    </div>
    <div className="epic-business-grid lower">
      <section className="panel business-documents">
        <header className="panel-heading"><div><span className="eyebrow">Documents</span><h2>Generated artifacts in one place</h2></div><Pill tone={generatedDocuments.length ? 'good' : 'neutral'}>{generatedDocuments.length} generated</Pill></header>
        <div className="business-document-list">
          {documents.map((document) => <article className={document.status === 'not_generated' ? 'pending' : ''} key={`${document.phase}:${document.id}`} onClick={() => openArtifact(document)}>
            <header><div><span>{document.phase}</span><h3>{document.label}</h3></div><Pill tone={document.status === 'approved' ? 'good' : document.status === 'published' ? 'accent' : document.status === 'not_generated' ? 'neutral' : 'warn'}>{businessStatusLabel(document.status)}</Pill></header>
            <p>{documentExcerpt(document.content, document.status === 'not_generated' ? 'Not generated yet. The configured artifact will appear here after the CLI phase publishes it.' : 'Generated file exists, but inline preview is not available for this format.')}</p>
            <footer><code>{document.repositoryPath ?? document.path ?? 'not written yet'}</code><span>{document.sha256 ? `sha ${document.sha256.slice(0, 12)}` : 'hash pending'}</span><button className="artifact-card-open" type="button">Open artifact →</button></footer>
          </article>)}
          {!documents.length && <div className="inline-empty">No configured Epic documents were found for this workspace.</div>}
        </div>
      </section>
      <section className="panel business-story-readiness">
        <header className="panel-heading"><div><span className="eyebrow">Delivery readiness</span><h2>Stories tied to this Epic</h2></div><Pill tone={storyTotal && storyComplete === storyTotal ? 'good' : storyMaterialized ? 'accent' : 'neutral'}>{storyComplete}/{storyTotal} complete</Pill></header>
        <div className="business-story-summary">
          {(report.children?.epics ?? []).map((epic) => <section key={epic.id}><header><div><strong>{epic.jiraKey ?? epic.id}</strong><span>{epic.title}</span></div><em>{epic.percentage}%</em></header><div>{epic.stories.slice(0, 6).map((story) => <article key={story.workId ?? story.id}><StatusDot status={story.status === 'complete' ? 'approved' : story.materialized ? 'in_progress' : 'not_started'} /><span><strong>{story.workId ?? story.id}</strong><small>{story.repository} · {story.currentPhase ?? (story.materialized ? 'seeded' : 'planned')}</small></span><Pill tone={story.stale || story.blocked ? 'warn' : story.status === 'complete' ? 'good' : 'neutral'}>{story.jiraKey ?? 'Jira pending'}</Pill></article>)}</div></section>)}
          {!(report.children?.epics ?? []).length && <div className="inline-empty">No Story plan has been approved yet. Generated Stories will appear here after Planning publishes them.</div>}
        </div>
      </section>
    </div>
    {artifactViewer}
  </div>;
}

function StoryArtifactOverview({ data, downloadFile }) {
  const documents = (data.documents ?? []).filter((document) => ['artifact', 'package'].includes(document.type));
  const { openArtifact, artifactViewer } = useArtifactViewer({
    repository: data.repository.root,
    workId: data.selectedWorkId,
    downloadFile
  });
  return <section className="panel overview-artifacts">
    <header className="panel-heading"><div><span className="eyebrow">Generated outputs</span><h2>Artifacts ready to inspect</h2><p>Open Markdown, JSON, YAML, images, and PDFs without leaving the workflow overview.</p></div><Pill tone={documents.length ? 'good' : 'neutral'}>{documents.length} generated</Pill></header>
    {documents.length ? <div className="overview-artifact-grid">{documents.map((document) => <button type="button" className="overview-artifact-card" key={document.id} onClick={() => openArtifact(document)}>
      <span className="artifact-reader-icon">{kindTag(document.path ?? document.kind)}</span>
      <span><small>{document.phase ?? 'workflow'} · generation {document.generation ?? 0}</small><strong>{document.label}</strong><code>{document.path}</code></span>
      <span className="overview-artifact-state"><Pill tone={document.status === 'approved' ? 'good' : 'accent'}>{businessStatusLabel(document.status ?? 'generated')}</Pill><em>Open →</em></span>
    </button>)}</div> : <div className="inline-empty">No generated artifacts are committed for this Story yet. Refresh after the next CLI publication.</div>}
    {artifactViewer}
  </section>;
}

function Dashboard({ data, downloadFile }) {
  if (data.initiative) return <EpicBusinessOverview data={data} downloadFile={downloadFile} />;
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
    <StoryArtifactOverview data={data} downloadFile={downloadFile} />
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

// The governed Copilot session: context pack, ACP transcript, inline questions, and promotion.
// Extracted so more than one screen can present it — Copilot Studio shows it phase-by-phase,
// while the Requirements workspace wraps the same session in a sources/chat/artifacts layout.
// One implementation, because the ACP event handling here is subtle and must not drift.
function useCopilotPlanningSession({ data, action, reload, profileRole = null, focus = null, onCopilotLost = null }) {
  const groups = data.planning?.targets ?? [];
  const defaultGroup = groups.find((item) => item.scope === 'initiative') ?? groups[0] ?? null;
  // A hand-off from a phase screen names the phase and output it wants. Honour it only when that
  // phase is actually plannable here; otherwise fall back to the current phase, so a stale link can
  // never frame the studio on a phase the sequence gate would refuse.
  const focusPhase = focus?.phase && defaultGroup?.phases.some((item) => item.id === focus.phase) ? focus.phase : null;
  const [groupKey, setGroupKey] = useState(defaultGroup ? `${defaultGroup.scope}:${defaultGroup.id}` : '');
  const [phaseId, setPhaseId] = useState(focusPhase ?? defaultGroup?.currentPhase ?? '');
  const initialPhase = defaultGroup?.phases.find((phase) => phase.id === (focusPhase ?? defaultGroup.currentPhase));
  const [targetId, setTargetId] = useState(
    (focus?.target && initialPhase?.targets.some((item) => item.id === focus.target) ? focus.target : null)
      ?? initialPhase?.targets[0]?.id
      ?? ''
  );
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
  const [permissions, setPermissions] = useState([]);
  const [logs, setLogs] = useState([]);
  const [activity, setActivity] = useState('Build a governed context pack to begin.');
  const transcriptRef = useRef('');
  const planRef = useRef('');
  const questionsRef = useRef([]);
  const permissionsRef = useRef([]);
  const group = groups.find((item) => `${item.scope}:${item.id}` === groupKey) ?? defaultGroup;
  const phase = group?.phases.find((item) => item.id === phaseId) ?? group?.phases.find((item) => item.current) ?? null;
  const target = phase?.targets.find((item) => item.id === targetId) ?? phase?.targets[0] ?? null;
  const currentReady = Boolean(group && phase?.current && phase.status === 'in_progress' && target);
  const sessionStorageKey = useMemo(
    () => `singularity.phase-session:${data.repository.root}:${data.selectedInitiativeId ?? data.selectedWorkId ?? 'none'}:${focusPhase ?? phaseId}`,
    [data.repository.root, data.selectedInitiativeId, data.selectedWorkId, focusPhase, phaseId]
  );
  const storyPlanAnalysis = useMemo(
    () => target?.id === 'story-plan' && plan.trim() ? parseStoryPlan(plan) : null,
    [target?.id, plan]
  );
  const contextStale = Boolean(
    contextPack?.stale
    || (contextPack && data.repository.head && contextPack.manifest.repository.head !== data.repository.head)
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
    // This effect also runs on mount, so it has to honour a hand-off focus. Resolving to
    // currentPhase unconditionally would immediately overwrite the framing the caller asked for
    // and silently drop the user back on the current phase.
    const selectedPhase = selected.phases.find((item) => item.id === (focusPhase ?? selected.currentPhase))
      ?? selected.phases[0];
    setPhaseId(selectedPhase?.id ?? '');
    setTargetId(
      (focus?.target && selectedPhase?.targets.some((item) => item.id === focus.target) ? focus.target : null)
        ?? selectedPhase?.targets[0]?.id
        ?? ''
    );
    // Full reset, not just contextPack + started: switching work while a turn was in flight left
    // running=true with no session to clear it, and running gates every control here — including
    // the build button — so the studio locked up completely.
    resetSession();
    let active = true;
    const resumePhase = focusPhase ?? selected?.currentPhase;
    const resumeId = data.selectedInitiativeId;
    if (resumeId && resumePhase && window.singularity.listPlanningSessions && window.singularity.resumePlanningSession) {
      window.singularity.listPlanningSessions(data.repository.root)
        .then((entries) => entries.find((entry) => entry.id === resumeId && entry.phase === resumePhase && entry.status !== 'promoted'))
        .then((entry) => entry ? window.singularity.resumePlanningSession(data.repository.root, entry.sessionId) : null)
        .then((pack) => {
          if (!active || !pack) return;
          setContextPack(pack);
          setTargetId(pack.target?.id ?? targetId);
          setActivity(`Restored the saved ${resumePhase} context. Start Copilot to continue this phase session.`);
          try {
            const journal = JSON.parse(window.localStorage.getItem(sessionStorageKey) ?? 'null');
            if (journal?.sessionId === pack.sessionId) {
              setMessages(journal.messages ?? []);
              setPlan(journal.plan ?? '');
              planRef.current = journal.plan ?? '';
              setQuestions(journal.questions ?? []);
              questionsRef.current = journal.questions ?? [];
              setUsage(journal.usage ?? null);
              setPersona(journal.persona ?? persona);
              setObjective(journal.objective ?? objective);
            }
          } catch { /* stale local journals are disposable */ }
          if (pack.savedStatus === 'active') {
            setStarted(true);
            setActivity(`Reconnected to the active ${resumePhase} Copilot session.`);
          }
        })
        .catch(() => { /* a stale context is rebuilt explicitly by the user */ });
    }
    return () => { active = false; };
  }, [data.selectedWorkId, data.selectedInitiativeId]);

  useEffect(() => {
    if (!contextPack?.sessionId) return;
    try {
      window.localStorage.setItem(sessionStorageKey, JSON.stringify({
        sessionId: contextPack.sessionId,
        messages: messages.slice(-120),
        plan,
        questions,
        usage,
        persona,
        objective,
        updatedAt: new Date().toISOString()
      }));
    } catch { /* local journal is an enhancement, never a governance dependency */ }
  }, [sessionStorageKey, contextPack?.sessionId, messages, plan, questions, usage, persona, objective]);

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
      } else if (event.type === 'permission-request') {
        // Outside Plan mode the backend asks rather than refuses, so the request has to reach the
        // operator: an unanswered one blocks Copilot's turn until the session ends.
        permissionsRef.current = [...permissionsRef.current, {
          id: event.requestId,
          title: event.title,
          kind: event.kind,
          locations: event.locations ?? [],
          mode: event.mode ?? null
        }];
        setPermissions(permissionsRef.current);
        setActivity(`Copilot is asking to ${event.kind ?? 'act'}: ${event.title}`);
      } else if (event.type === 'permission-allowed') {
        permissionsRef.current = permissionsRef.current.filter((request) => request.id !== event.requestId);
        setPermissions(permissionsRef.current);
        setActivity(`${event.title} · ${event.requestId ? 'allowed' : 'reading'}`);
      } else if (event.type === 'permission-denied') {
        permissionsRef.current = permissionsRef.current.filter((request) => request.id !== event.requestId);
        setPermissions(permissionsRef.current);
        setActivity(event.detail ?? `${event.title} was blocked.`);
      } else if (event.type === 'mode-changed' || event.type === 'current_mode_update') {
        setActivity(event.readOnly === false
          ? `Copilot is in ${event.mode} mode: it may ask to change the repository.`
          : `Copilot is in ${event.mode ?? 'Plan'} mode: read-only.`);
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
        } else if (!planRef.current.trim()) {
          // Nothing came back at all: no proposal, no transcript, no questions. Reporting only the
          // stop reason left both panels showing their placeholder text, which is indistinguishable
          // from still waiting for Copilot. Say so, and point at the next useful step.
          setActivity(`Copilot ended the turn (${event.stopReason}) without proposing anything. Send a follow-up with a more specific instruction, or open the Copilot logs below to see the tool activity and diagnostics for this turn.`);
        } else {
          setActivity(`Planning turn completed: ${event.stopReason}.`);
        }
      } else if (event.type === 'error') {
        setRunning(false);
        setActivity(`Copilot error: ${event.message}`);
      } else if (event.type === 'process-exit' && started) {
        setRunning(false);
        setStarted(false);
        setActivity(event.code === 0
          ? 'Copilot ended the session. Start it again to continue.'
          : `Copilot stopped unexpectedly (exit ${event.code ?? 'unknown'}${event.signal ? `, ${event.signal}` : ''}). The conversation is kept; start again to continue.`);
        onCopilotLost?.();
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
    permissionsRef.current = [];
    setPermissions([]);
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
    // Rebuilding mints a new planning session, so the previous one has to be released and the
    // connection state cleared. Without this the studio kept started=true while contextPack moved
    // to a session that was never started: 'Start Copilot Plan mode' stayed disabled because it is
    // gated on started, the Frame stayed locked for the same reason, and every incoming event was
    // dropped by the `event.planningSessionId !== contextPack.sessionId` guard. The pill still read
    // 'connected' and follow-ups posted to a dead session, so the screen looked live and did nothing.
    const previousSession = (started || running) ? contextPack?.sessionId : null;
    if (previousSession) {
      // Best effort: a session that already exited must not block the rebuild.
      try { await window.singularity.stopPlanningSession(data.repository.root, previousSession); }
      catch { /* already gone */ }
    }
    setStarted(false);
    setRunning(false);
    setUsage(null);
    const result = await action(() => window.singularity.buildPlanningContext(data.repository.root, {
      scope: group.scope,
      id: group.id,
      phase: phase.id,
      persona,
      target: target.id,
      objective
    }), 'Governed planning context built');
    if (!result) return null;
    try { window.localStorage.removeItem(sessionStorageKey); } catch { /* ignore unavailable storage */ }
    setContextPack(result);
    setMessages([]);
    setPlan('');
    planRef.current = '';
    transcriptRef.current = '';
    setReviewed(false);
    questionsRef.current = [];
    permissionsRef.current = [];
    setPermissions([]);
    setQuestions([]);
    setLogs([]);
    setActivity(`${result.manifest.sources.length} hashed sources ready for Copilot.`);
    // Returned so a caller can start the session on the same pack without waiting for the state
    // round-trip — the two-step existed partly because contextPack was only readable next render.
    return result;
  }

  // One action. The prompt stays inspectable afterwards — reviewing it was always optional, but the
  // two-step made it feel mandatory and left the screen with two "start" buttons in different places.
  async function beginSession() {
    const pack = await buildContext();
    if (!pack?.sessionId) return null;
    setRunning(true);
    const result = await action(
      () => window.singularity.startPlanningSession(data.repository.root, pack.sessionId, model),
      'Copilot received the governed context'
    );
    if (!result) setRunning(false);
    return result;
  }

  async function startCopilot() {
    if (contextStale) {
      setActivity('This governed context is stale. Rebuild it before starting another Copilot turn.');
      return;
    }
    setRunning(true);
    const result = await action(() => window.singularity.startPlanningSession(data.repository.root, contextPack.sessionId, model), 'Copilot Plan mode connected');
    if (!result) setRunning(false);
  }

  async function sendFollowup() {
    if (contextStale) {
      setActivity('This governed context is stale. Rebuild it before sending another instruction.');
      return;
    }
    const text = followup.trim();
    if (!text) return;
    setMessages((current) => [...current, { role: 'user', id: `followup-${Date.now()}`, text }]);
    transcriptRef.current = '';
    setFollowup('');
    setRunning(true);
    const result = await action(() => window.singularity.promptPlanningSession(data.repository.root, contextPack.sessionId, text));
    if (!result) setRunning(false);
  }

  async function answerPermission(request, allow) {
    const result = await action(
      () => window.singularity.answerCopilotPermission(data.repository.root, request.id, allow),
      allow ? `Allowed: ${request.title}` : `Refused: ${request.title}`
    );
    if (!result) return;
    permissionsRef.current = permissionsRef.current.filter((item) => item.id !== request.id);
    setPermissions(permissionsRef.current);
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
      questionsRef.current = questionsRef.current.map((item) => item.id === question.id ? { ...item, status: 'accept' } : item);
      setQuestions(questionsRef.current);
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

  // Halting a runaway answer and discarding the conversation are different intents. Stop used to
  // do the second, and threw when the agent did not acknowledge — leaving the session unable to
  // stop or start.
  async function interruptTurn() {
    if (!contextPack) return;
    await action(() => window.singularity.interruptPlanningTurn(data.repository.root, contextPack.sessionId), 'Asked Copilot to stop the current turn');
    setRunning(false);
    setActivity('Turn interrupted. The session is still attached.');
  }
  async function stopCopilot() {
    await action(() => window.singularity.stopPlanningSession(data.repository.root, contextPack.sessionId), 'Planning context released; the Copilot backend remains ready');
    setRunning(false);
    setStarted(false);
  }

  async function promote() {
    if (contextStale) {
      setActivity('This governed context is stale. Rebuild it before promotion.');
      return;
    }
    // A phase-scoped session produces several fenced artifacts from one conversation, so the
    // single-artifact call would send the fences themselves as one document and the engine would
    // reject '*' as a promotion target. Parse the set and promote it as one commit instead.
    const phaseScoped = contextPack?.target?.id === PHASE_SCOPE || targetId === PHASE_SCOPE;
    const outputs = contextPack?.outputs ?? [];
    const set = phaseScoped ? readArtifactBlocks(plan, outputs.map((output) => output.id)) : null;
    if (phaseScoped && !set.size) {
      setActivity(`No fenced artifact was found. Copilot must wrap each artifact in its <<<SFLOW-ARTIFACT:id …>>> fence.`);
      return;
    }
    const result = await action(
      () => (phaseScoped
        ? window.singularity.promotePlanningArtifacts(
          data.repository.root, contextPack.sessionId, persona,
          [...set].map(([outputId, content]) => ({ outputId, content }))
        )
        : window.singularity.promotePlanningArtifact(data.repository.root, contextPack.sessionId, persona, plan)),
      phaseScoped
        ? `Promoted ${set.size} artifact${set.size === 1 ? '' : 's'}, committed, and pushed`
        : `Reviewed plan promoted to ${target.path}, committed, and pushed`
    );
    if (!result) return;
    setReviewed(false);
    await reload(data.selectedWorkId, data.selectedInitiativeId);
  }

  // Phase navigation must not release the session. The registry and context pack are the durable
  // hand-off; only the explicit Stop button releases the Copilot planning context.

  return {
    groups, defaultGroup, focusPhase, groupKey, setGroupKey, phaseId, setPhaseId, initialPhase, targetId, setTargetId, persona, setPersona, objective, setObjective, model, setModel, preflight, setPreflight, contextPack, setContextPack, messages, setMessages, plan, setPlan, followup, setFollowup, running, setRunning, started, setStarted, reviewed, setReviewed, usage, setUsage, questions, setQuestions, permissions, answerPermission, logs, setLogs, activity, setActivity, transcriptRef, planRef, questionsRef, group, phase, target, currentReady, storyPlanAnalysis, contextStale, resetSession, selectGroup, selectPhase, buildContext, beginSession, startCopilot, sendFollowup, answerQuestion, dismissQuestion, interruptTurn, stopCopilot, promote
  };
}

function PlanningStudio({ data, action, reload, openPlanningPrompt, profileRole = null, focus = null, onCopilotRetry = null }) {
  const {
    groups, defaultGroup, focusPhase, groupKey, setGroupKey, phaseId, setPhaseId, initialPhase, targetId, setTargetId, persona, setPersona, objective, setObjective, model, setModel, preflight, setPreflight, contextPack, setContextPack, messages, setMessages, plan, setPlan, followup, setFollowup, running, setRunning, started, setStarted, reviewed, setReviewed, usage, setUsage, questions, setQuestions, permissions, answerPermission, logs, setLogs, activity, setActivity, transcriptRef, planRef, questionsRef, group, phase, target, currentReady, storyPlanAnalysis, contextStale, resetSession, selectGroup, selectPhase, buildContext, beginSession, startCopilot, sendFollowup, answerQuestion, dismissQuestion, interruptTurn, stopCopilot, promote
  } = useCopilotPlanningSession({ data, action, reload, profileRole, focus });
  if (!groups.length) return <div className="page"><Empty title="Select governed work first" detail="Choose a story work item or initiative from the top bar. Copilot Studio will then expose its current phase, exact outputs, personas, world model, approved inputs, and repository boundaries." /></div>;
  return <div className="page planning-page">
    <header className="page-heading planning-heading"><div><span className="eyebrow">Copilot-native decision workspace</span><h1>Copilot Studio</h1><p>Move from business intent to a reviewable, phase-specific plan without allowing the planning session to mutate source or lifecycle state.</p></div><div className="row"><Pill tone={preflight?.ready ? 'good' : 'warn'}>{preflight?.ready ? 'Copilot Plan mode ready' : 'Copilot setup needed'}</Pill><button className="secondary" onClick={openPlanningPrompt}>Edit planning prompt</button></div></header>
    {preflight?.ready === false && <CopilotUnavailable health={preflight} action="Copilot Studio" onRetry={onCopilotRetry} />}
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
            {contextStale && <div className="planning-warning"><span>⚠ This saved context is out of date. Review remains available, but rebuild before starting Copilot or promoting an artifact.</span><button className="primary compact" disabled={running} onClick={buildContext}>Rebuild context</button></div>}
            <div className="context-kpis"><div><span>Repository head</span><strong>{contextPack.manifest.repository.head.slice(0, 10)}</strong></div><div><span>Context</span><strong>{Math.ceil(contextPack.manifest.context.bytes / 1024)} KB</strong></div><div><span>Generation</span><strong>{contextPack.manifest.generation}</strong></div><div><span>Target</span><strong>{contextPack.target.kind}</strong></div></div>
            {!!contextPack.warnings.length && <div className="planning-warning">{contextPack.warnings.map((warning) => <span key={warning}>⚠ {warning}</span>)}</div>}
            <div className="context-source-list">{contextPack.manifest.sources.map((source, index) => <div key={`${source.kind}:${source.path}:${index}`}><span>{source.kind.replaceAll('-', ' ')}</span><strong title={source.path}>{source.path}</strong><code>{source.sha256?.slice(0, 12) ?? 'unavailable'}</code></div>)}</div>
            <details><summary>Inspect complete prompt sent to Copilot</summary><pre>{contextPack.context}</pre></details>
            <div className="planning-context-actions"><span>{contextPack.target.label} → <code>{contextPack.target.path}</code></span><button className="primary" disabled={running || started || contextStale} onClick={startCopilot}>Start Copilot Plan mode</button></div>
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
            <button className="primary full" disabled={!contextPack || contextStale || running || !reviewed || !plan.trim()} onClick={promote}>Promote, commit & push</button>
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

// What the Epic was imported from. epic:start pins the whole Jira issue into initiative state —
// summary, description, acceptance criteria, status, labels, attachments — but nothing rendered it,
// so an Epic pulled from Jira looked empty in the app while its content sat in governed state.
// This is a read-only view of that pinned snapshot; it is never re-fetched from Jira here.
function ImportedEpicView({ selected }) {
  const initiative = selected.state.initiative;
  const source = initiative.source ?? {};
  if (source.type !== 'jira') {
    return <section className="panel imported-epic">
      <header className="panel-heading"><div><span className="eyebrow">Epic origin</span><h2>Described directly</h2></div><Pill>manual</Pill></header>
      <p className="imported-epic-empty">This Epic was described in Singularity Flow rather than imported from Jira. Its intent lives in the intake artifacts below.</p>
    </section>;
  }
  const facts = [
    ['Jira key', source.key ?? initiative.id],
    ['Issue type', source.issueType],
    ['Status', source.status],
    ['Priority', source.priority],
    ['Assignee', source.assignee],
    ['Reporter', source.reporter],
    ['Story points', source.storyPoints],
    ['Project', source.project?.name ?? source.project?.key]
  ].filter(([, value]) => value != null && value !== '');
  const attachments = source.attachments ?? [];
  return <section className="panel imported-epic">
    <header className="panel-heading">
      <div><span className="eyebrow">Epic origin · pinned at import</span><h2>{source.title ?? initiative.title}</h2></div>
      <Pill tone="accent">Jira {source.key ?? initiative.id}</Pill>
    </header>
    <dl className="imported-epic-facts">{facts.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{String(value)}</dd></div>)}</dl>
    {source.labels?.length > 0 && <div className="imported-epic-tags">{source.labels.map((tag) => <code key={tag}>{tag}</code>)}</div>}
    <div className="imported-epic-body">
      <h3>Description</h3>
      {source.description?.trim()
        ? <pre>{source.description}</pre>
        : <p className="imported-epic-empty">The Jira Epic has no description. Pin the requirement evidence below instead of inferring intent.</p>}
    </div>
    {source.acceptanceCriteria?.trim() && <div className="imported-epic-body">
      <h3>Acceptance criteria from Jira</h3>
      <pre>{source.acceptanceCriteria}</pre>
    </div>}
    {attachments.length > 0 && <div className="imported-epic-body">
      <h3>{attachments.length} Jira attachment{attachments.length === 1 ? '' : 's'}</h3>
      <p className="imported-epic-empty">Listed from the import snapshot. An attachment only becomes evidence once it is pinned as a source below, which records its own hash.</p>
      <ul className="imported-epic-attachments">{attachments.map((file) => <li key={file.id ?? file.filename}><strong>{file.filename}</strong><small>{file.mimeType ?? 'unknown type'}{file.size ? ` · ${Math.ceil(file.size / 1024)} KB` : ''}</small></li>)}</ul>
    </div>}
    <p className="imported-epic-note">This snapshot was taken when the Epic was started and is not refreshed automatically. Nothing here is governed evidence: requirements must cite pinned sources.</p>
  </section>;
}

function EpicSourcesView({ data, selected, action, reload }) {
  const providers = Object.entries(selected.state.resolution.storage?.providers ?? {});
  const [providerId, setProviderId] = useState(selected.state.resolution.storage?.defaultProvider ?? providers[0]?.[0] ?? '');
  const [url, setUrl] = useState('');
  const [label, setLabel] = useState('');
  const [token, setToken] = useState('');
  const [noteText, setNoteText] = useState('');
  const [noteLabel, setNoteLabel] = useState('');
  const [credentials, setCredentials] = useState([]);
  const [verification, setVerification] = useState(null);
  const sources = selected.sources?.sources ?? [];
  const jiraSnapshotAvailable = selected.state.initiative.source?.type === 'jira';
  const provider = selected.state.resolution.storage?.providers?.[providerId];
  const credential = credentials.find((entry) => entry.providerId === providerId);
  useEffect(() => {
    let active = true;
    window.singularity.epicSources(data.repository.root, selected.state.initiative.id)
      .then((result) => { if (active) setCredentials(result.credentials ?? []); })
      .catch(() => { if (active) setCredentials([]); });
    return () => { active = false; };
  }, [data.repository.root, selected.state.initiative.id]);
  async function upload() {
    const result = await action(
      () => window.singularity.uploadEpicSources(data.repository.root, selected.state.initiative.id, providerId),
      'Pinned source files uploaded and published'
    );
    if (result && !result.canceled) await reload(null, selected.state.initiative.id);
  }
  async function addUrl() {
    const result = await action(
      () => window.singularity.addEpicSourceUrl(data.repository.root, selected.state.initiative.id, providerId, url.trim(), label.trim() || null),
      'Pinned source URL registered and published'
    );
    if (result) {
      setUrl('');
      setLabel('');
      await reload(null, selected.state.initiative.id);
    }
  }
  async function addText() {
    const result = await action(
      () => window.singularity.addEpicTextSource(
        data.repository.root,
        selected.state.initiative.id,
        noteText.trim(),
        noteLabel.trim() || 'Epic notes'
      ),
      'Text notes pinned to the Epic branch and published'
    );
    if (result) {
      setNoteText('');
      setNoteLabel('');
      await reload(null, selected.state.initiative.id);
    }
  }
  async function verify() {
    const result = await action(
      () => window.singularity.verifyEpicSources(data.repository.root, selected.state.initiative.id, providerId, true),
      'Every accessible source was downloaded and checked against its pinned hash'
    );
    if (result) setVerification(result);
  }
  async function saveCredential() {
    const result = await action(
      () => window.singularity.saveEpicStorageCredential(data.repository.root, providerId, token),
      `Credential for ${providerId} stored with operating-system encryption`
    );
    if (result) {
      setToken('');
      const status = await window.singularity.epicSources(data.repository.root, selected.state.initiative.id);
      setCredentials(status.credentials ?? []);
    }
  }
  async function connectSharePoint() {
    const result = await action(
      () => window.singularity.connectEpicSharePoint(data.repository.root, selected.state.initiative.id, providerId),
      `Microsoft SharePoint connected through delegated OAuth PKCE`
    );
    if (result) {
      const status = await window.singularity.epicSources(data.repository.root, selected.state.initiative.id);
      setCredentials(status.credentials ?? []);
    }
  }
  async function disconnectStorage() {
    const result = await action(
      () => window.singularity.disconnectEpicStorage(data.repository.root, providerId),
      `${providerId} disconnected from this operating-system account`
    );
    if (result) setCredentials((current) => current.filter((entry) => entry.providerId !== providerId));
  }
  return <div className="epic-workspace-view">
    <section className="panel epic-source-hero"><div><span className="eyebrow">Immutable source lineage</span><h2>Requirements begin with pinned evidence</h2><p>Files stay in approved shared storage. Git records the provider version, SHA-256, size, MIME type, and uploader—not the file bytes.</p></div><div className="source-provider-controls"><label><span>Storage provider</span><select value={providerId} onChange={(event) => setProviderId(event.target.value)}>{providers.map(([id, item]) => <option value={id} key={id}>{id} · {item.type}</option>)}</select></label><button className="primary" onClick={upload} disabled={!providerId || provider?.type === 'https-reference'}>＋ Add source files</button><button className="secondary" onClick={verify} disabled={!sources.length}>Verify all hashes</button></div></section>
    <section className="panel epic-source-url">
      <label><span>Paste requirement notes or additional Epic details</span><textarea rows="4" value={noteText} onChange={(event) => setNoteText(event.target.value)} placeholder="Paste workshop notes, constraints, decisions, or other requirement context…" /></label>
      <label><span>Label</span><input value={noteLabel} onChange={(event) => setNoteLabel(event.target.value)} placeholder="Workshop notes" /></label>
      <button className="primary" disabled={!noteText.trim()} onClick={addText}>Pin text as source</button>
    </section>
    {provider?.type === 'artifactory' && <section className="panel storage-credential-card"><div><span className="eyebrow">OS-protected credential</span><h3>{providerId}</h3><p>The renderer never receives a saved token. It is decrypted only in Electron’s main process for this provider.</p></div><input type="password" autoComplete="off" value={token} onChange={(event) => setToken(event.target.value)} placeholder="Artifactory access token" /><div className="row"><button className="secondary" disabled={!token.trim()} onClick={saveCredential}>Save securely</button>{credential?.connected && <button className="ghost" onClick={disconnectStorage}>Disconnect</button>}</div></section>}
    {provider?.type === 'sharepoint' && <section className="panel storage-credential-card"><div><span className="eyebrow">Microsoft delegated identity</span><h3>{providerId}</h3><p>Sign-in opens in your system browser using OAuth 2.0 PKCE. Access and refresh tokens remain OS-encrypted in Electron’s main process.</p></div><div className="sharepoint-connection-state"><Pill tone={credential?.connected ? 'good' : 'warn'}>{credential?.connected ? 'connected' : 'sign-in required'}</Pill><span>{credential?.expiresAt ? `Access token refreshes after ${new Date(credential.expiresAt).toLocaleString()}` : 'Your administrator supplies the public-client ID in portfolio.yml.'}</span></div><div className="row"><button className="primary" onClick={connectSharePoint}>{credential?.connected ? 'Sign in again' : 'Sign in with Microsoft'}</button>{credential?.connected && <button className="ghost" onClick={disconnectStorage}>Disconnect</button>}</div></section>}
    {provider?.type === 'https-reference' && <section className="panel epic-source-url"><label><span>HTTPS source URL</span><input value={url} onChange={(event) => setUrl(event.target.value)} placeholder="https://approved.example/specification.pdf" /></label><label><span>Label</span><input value={label} onChange={(event) => setLabel(event.target.value)} placeholder="Customer journey specification" /></label><button className="primary" disabled={!url.trim()} onClick={addUrl}>Pin URL version</button></section>}
    {verification && <div className={`notice ${verification.valid ? 'good' : 'warn'}`}>{verification.valid ? 'All source bytes match their committed hashes.' : 'One or more sources are unavailable or changed. Blocking planning gates will not pass.'}</div>}
    <section className="panel epic-source-list"><header className="panel-heading"><div><span className="eyebrow">Source catalog</span><h2>Pinned source versions · {sources.length + (jiraSnapshotAvailable ? 1 : 0)}</h2></div><Pill tone={sources.length || jiraSnapshotAvailable ? 'good' : 'warn'}>{sources.length || jiraSnapshotAvailable ? 'pinned' : 'source gap'}</Pill></header>
      {sources.length || jiraSnapshotAvailable ? <div className="epic-source-table">{jiraSnapshotAvailable && <div className="epic-source-row"><span><strong>Jira Epic snapshot</strong><small>Committed Epic identity and description</small></span><span>jira-snapshot</span><span>application/json<small>available from Git state</small></span><code>available</code><Pill tone="good">pinned</Pill></div>}{sources.length > 0 && <><div className="epic-source-row head"><span>Source</span><span>Provider</span><span>Type / size</span><span>SHA-256</span><span>Status</span></div>{sources.map((source) => <div className="epic-source-row" key={source.sourceId}><span><strong>{source.name}</strong><small>{source.sourceId}</small></span><span>{source.provider}</span><span>{source.mimeType}<small>{source.bytes?.toLocaleString()} bytes</small></span><code>{source.sha256.slice(0, 16)}…</code><Pill tone="good">{source.status}</Pill></div>)}</>}</div> : <Empty title="No source files pinned" detail="The Epic can continue from Jira data. Upload requirements, research, designs, PDFs, screenshots, or spreadsheets when additional evidence is useful." />}
    </section>
  </div>;
}

function EpicArtifactView({ selected, phases, title, detail, openPlanning, downloadFile }) {
  const documents = selected.documents.filter((document) => phases.includes(document.phase));
  const { openArtifact, artifactViewer } = useArtifactViewer({ downloadFile });
  return <div className="epic-workspace-view"><section className="panel epic-artifact-hero"><div><span className="eyebrow">Governed artifact workspace</span><h2>{title}</h2><p>{detail}</p></div>{openPlanning && <button className="primary" onClick={() => openPlanning(phases[0])}>Show Copilot CLI command</button>}</section><section className="panel initiative-documents expanded"><header className="panel-heading"><div><span className="eyebrow">Hash-bound outputs</span><h2>{documents.length} documents</h2></div></header>{documents.map((document) => <div key={`${document.phase}:${document.id}`}><span><strong>{document.label}</strong><small>{document.phase} · generation {document.generation}</small></span><Pill tone={document.status === 'approved' ? 'good' : document.status === 'stale' ? 'warn' : 'neutral'}>{document.status}</Pill><button className="secondary compact" disabled={!document.sha256} onClick={() => openArtifact(document)}>View artifact</button></div>)}</section>{artifactViewer}</div>;
}

// Parse fenced artifacts out of a Copilot reply. Mirrors parseArtifactBlocks in src/planning.mjs;
// the renderer needs it to show what is on offer before anything is promoted, and the CLI
// re-validates on the way in so this is a preview, never the authority.
function readArtifactBlocks(text, allowedIds) {
  const found = new Map();
  const pattern = /<<<SFLOW-ARTIFACT:([A-Za-z0-9._-]+)\r?\n([\s\S]*?)\r?\nSFLOW-ARTIFACT:\1>>>/g;
  for (const match of String(text ?? '').matchAll(pattern)) {
    const [, id, body] = match;
    if (allowedIds.includes(id) && body.trim() && !found.has(id)) found.set(id, body.trim());
  }
  return found;
}

// A short badge for the icon tile. documentKind returns prose ("Markdown"), which truncates to
// "Mar"; and an output's kind is a type name rather than a file name, so neither works alone.
function kindTag(nameOrKind = '') {
  const value = String(nameOrKind).toLowerCase();
  const byKind = {
    markdown: 'MD', yaml: 'YML', 'interface-contract': 'API', json: 'JSN', text: 'TXT'
  }[value];
  if (byKind) return byKind;
  return {
    Markdown: 'MD', YAML: 'YML', JSON: 'JSN', Text: 'TXT', Image: 'IMG',
    PDF: 'PDF', DOC: 'DOC', DOCX: 'DOC', XLS: 'XLS', XLSX: 'XLS', CSV: 'CSV', Figma: 'FIG'
  }[documentKind(nameOrKind)] ?? documentKind(nameOrKind).slice(0, 3).toUpperCase();
}

// Fenced artifacts are promoted, not read: leaving a whole requirements specification inline
// buries the reasoning the conversation exists to capture.
function stripArtifactFences(text) {
  const pattern = /<<<SFLOW-ARTIFACT:([A-Za-z0-9._-]+)\r?\n[\s\S]*?\r?\nSFLOW-ARTIFACT:\1>>>/g;
  let stripped = 0;
  const value = String(text ?? '').replace(pattern, () => { stripped += 1; return ''; });
  return { text: value.replace(/\n{3,}/g, '\n\n').trim(), stripped };
}

function copyText(value) {
  try { void navigator.clipboard?.writeText(String(value ?? '')); } catch { /* Clipboard access is a convenience, never load-bearing. */ }
}

function copilotCliCommands({ phaseId, epicId = null, workId = null }) {
  const epic = epicId ? ` ${epicId}` : '';
  const phase = {
    'epic-intake': {
      skill: `/sflow-epic-sources${epic}`,
      shell: `singularity-flow epic sources list${epicId ? ` --epic ${epicId}` : ''}`,
      purpose: 'Review the Jira snapshot, upload files or folders, and pin notes as governed Epic sources.'
    },
    'epic-requirements': {
      skill: `/sflow-epic-requirements${epic}`,
      shell: 'singularity-flow epic requirements status --json',
      purpose: 'Ask questions, use the repository world model, formalize requirements, and publish the Requirements bundle.'
    },
    'epic-planning': {
      skill: `/sflow-epic-story-draft${epic}`,
      shell: 'singularity-flow epic planning status --json',
      purpose: 'Decompose approved requirements into editable Stories and specifications, then stop for business approval in this UI.'
    },
    'epic-publish': {
      skill: `/sflow-epic-stories${epic}`,
      shell: `singularity-flow epic create-stories${epicId ? ` --epic ${epicId}` : ''}`,
      purpose: 'Review the exact write plan, create Jira Stories, seed canonical branches, and record the receipts.'
    }
  }[phaseId];
  if (phase) return [
    { ...phase, primary: true },
    {
      skill: `/sflow-upload${epicId ? ` --epic ${epicId}` : workId ? ` --work-id ${workId}` : ''}`,
      shell: epicId
        ? `singularity-flow epic sources add --epic ${epicId} --file <PATH>`
        : 'singularity-flow documents upload <PATH...>',
      purpose: 'Upload additional files, exported design folders, screenshots, PDFs, spreadsheets, or reference URLs.'
    },
    {
      skill: '/sflow-nextsteps',
      shell: epicId ? `singularity-flow epic status ${epicId}` : 'singularity-flow nextsteps',
      purpose: 'Re-read committed state and show the next valid action without changing it.'
    }
  ];
  if (epicId) return [
    {
      skill: `/sflow-initiative-phase ${phaseId} --initiative ${epicId}`,
      shell: `singularity-flow initiative phase ${phaseId} --initiative ${epicId}`,
      purpose: `Compose the governed ${phaseId} prompt, author its configured outputs, and publish the exact initiative generation.`,
      primary: true
    },
    {
      skill: `/sflow-initiative-documents ${phaseId} --initiative ${epicId}`,
      shell: `singularity-flow initiative documents ${phaseId} --initiative ${epicId}`,
      purpose: 'List and display every generated initiative document in full before review or approval.'
    },
    {
      skill: `/sflow-initiative-next ${epicId}`,
      shell: `singularity-flow initiative next ${epicId}`,
      purpose: 'Re-read committed initiative state and show the next valid action without changing it.'
    }
  ];
  return [
    {
      skill: '/sflow-next',
      shell: 'singularity-flow next',
      purpose: 'Execute the next valid Story-workflow action in Copilot CLI.',
      primary: true
    },
    {
      skill: `/sflow-upload${workId ? ` --work-id ${workId}` : ''}`,
      shell: 'singularity-flow documents upload <PATH...>',
      purpose: 'Upload supporting files or directories into the current Story work item.'
    },
    {
      skill: '/sflow-documents list',
      shell: workId ? `singularity-flow documents list ${workId}` : 'singularity-flow documents list',
      purpose: 'List every uploaded and generated document with stable IDs.'
    }
  ];
}

function CopilotCliHandoff({ data, phaseId, title = 'Continue in Copilot CLI', detail = null }) {
  const epicId = data.initiative?.state?.initiative?.id ?? data.selectedInitiativeId ?? null;
  const workId = data.workflow?.workItem?.id ?? data.selectedWorkId ?? null;
  const commands = copilotCliCommands({ phaseId, epicId, workId });
  return <section className="panel cli-handoff" aria-label="Copilot CLI handoff">
    <header className="panel-heading">
      <div><span className="eyebrow">Copilot runs in your terminal</span><h2>{title}</h2><p>{detail ?? 'Open Copilot CLI in the lead repository and run the highlighted skill. The skill reads the committed Singularity state, asks questions there, and commits and pushes its outputs.'}</p></div>
      <Pill tone="good">No desktop session</Pill>
    </header>
    <div className="cli-handoff-location">
      <div><span>Run from</span><p>Open Copilot CLI in this repository first.</p></div>
      <pre><code>cd {data.repository.root}</code></pre>
      <button className="secondary compact" onClick={() => copyText(`cd ${data.repository.root}`)}>Copy</button>
    </div>
    <div className="cli-command-list">{commands.map((command, commandIndex) => <article className={`cli-command-card ${command.primary ? 'primary-command' : ''}`} key={command.skill}>
      <header>
        <span>{command.primary ? 'Recommended next command' : `Optional command ${commandIndex}`}</span>
        <button className={command.primary ? 'primary compact' : 'secondary compact'} onClick={() => copyText(command.skill)}>Copy</button>
      </header>
      <p>{command.purpose}</p>
      <div className="cli-command-terminal" role="group" aria-label={`Copilot command ${command.skill}`}>
        <span aria-hidden="true">$</span>
        <code>{command.skill}</code>
      </div>
      <div className="cli-command-equivalent">
        <span>Shell equivalent</span>
        <code>{command.shell}</code>
      </div>
    </article>)}</div>
    <footer><span>After Copilot finishes, return here and press <b>Refresh</b> to see the committed documents, Jira receipts, approvals, and progress.</span></footer>
  </section>;
}

function formatBytes(bytes = 0) {
  if (!bytes) return '0 KB';
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.ceil(bytes / 1024))} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

// One row shape for every kind of source, so a pinned upload and a Jira attachment are told apart
// by their stated status rather than by which list they happen to sit in.
/**
 * Shown wherever Copilot work can be started and Copilot cannot do it.
 *
 * The preflight already distinguishes "not installed" from "installed but the wrong build", so the
 * banner states which, rather than a single unhelpful "unavailable".
 */
/**
 * What a phase session is usually asked to do, phrased once.
 *
 * The composer was an empty box, so each turn started by re-inventing the request for work the
 * phase contract already describes. `outputs` comes from the built context, so the wording names
 * the artifacts this phase actually owes rather than a generic list.
 */
function phaseCommands(outputs = []) {
  const names = outputs.map((output) => output.label).filter(Boolean);
  const list = names.length ? names.join(', ') : 'the configured artifacts';
  return [
    {
      id: 'draft',
      label: 'Draft every artifact',
      hint: 'Produce the full set from the pinned sources',
      prompt: `Produce ${list}. Use only the pinned sources, cite the source id in every derived requirement and acceptance criterion, and wrap each artifact in its own promotion fence.`
    },
    {
      id: 'gaps',
      label: 'What the sources do not answer',
      hint: 'Find the holes before drafting',
      prompt: 'List everything this phase needs that the pinned sources do not answer. Do not guess at any of it — record each as an open question with the decision it blocks.'
    },
    {
      id: 'trace',
      label: 'Check traceability',
      hint: 'Every REQ and AC back to a pinned source',
      prompt: 'Check that every REQ and AC traces to a pinned source id, and list any that do not along with what evidence they would need.'
    },
    {
      id: 'challenge',
      label: 'Challenge the assumptions',
      hint: 'Argue against the current draft',
      prompt: 'Challenge the assumptions in the current draft. Name each one, say what it would take to be wrong, and what would change if it were.'
    },
    {
      id: 'tighten',
      label: 'Tighten acceptance criteria',
      hint: 'Make each one testable',
      prompt: 'Rewrite the acceptance criteria so each is independently testable, with an unambiguous pass condition. Flag any that cannot be made testable from the pinned sources.'
    }
  ];
}

function CopilotUnavailable({ health, onRetry = null, action = 'this' }) {
  if (!health || health.ready !== false) return null;
  const cause = health.installed === false
    ? 'The GitHub Copilot CLI was not found on your PATH.'
    : health.acp === false || health.planMode === false
      ? 'The installed Copilot CLI does not support the ACP Plan mode this needs.'
      : 'Copilot is installed but did not respond.';
  return <section className="copilot-down" role="alert">
    <div>
      <strong>Copilot is not available — {action} cannot run</strong>
      <p>{cause}</p>
      {health.message && <p className="copilot-down-detail">{health.message}</p>}
      {health.version && <p className="copilot-down-detail">Detected: {health.version}</p>}
    </div>
    {onRetry && <button className="secondary compact" onClick={onRetry}>Check again</button>}
  </section>;
}

function SourceCard({ name, detail, title = undefined, state = 'ready', onOpen = null }) {
  const body = <>
    <span className="source-icon" aria-hidden="true">{kindTag(name)}</span>
    <span className="source-body">
      <strong>{name}</strong>
      <small>{detail}</small>
    </span>
    <span className={`source-state ${state}`} aria-hidden="true">{state === 'ready' ? '✓' : '○'}</span>
  </>;
  // A pinned source used to be a dead card: a name, a size and a hash, with no way to see what had
  // actually been attached.
  if (!onOpen) return <div className={`source-card ${state}`} title={title}>{body}</div>;
  return <button type="button" className={`source-card ${state} openable`} title={title ?? 'Open this source'} onClick={onOpen}>{body}</button>;
}

function documentKind(name = '') {
  const extension = String(name).split('.').pop()?.toLowerCase() ?? '';
  return {
    pdf: 'PDF', doc: 'DOC', docx: 'DOCX', xls: 'XLS', xlsx: 'XLSX', csv: 'CSV',
    png: 'Image', jpg: 'Image', jpeg: 'Image', gif: 'Image', svg: 'Image',
    md: 'Markdown', txt: 'Text', fig: 'Figma', json: 'JSON', yml: 'YAML', yaml: 'YAML'
  }[extension] ?? (extension ? extension.toUpperCase() : 'File');
}

// Journey controls can originate from the Epic overview or from another phase page. Route first,
// then reveal the exact control that owns the action after React has committed the destination.
// In particular, `add-evidence` must land on the evidence attestation/checklist area rather than
// being mistaken for an unknown lifecycle mutation.
function revealPhaseAction(actionId) {
  if (![NEXT_ACTIONS.APPROVE, NEXT_ACTIONS.EVIDENCE, NEXT_ACTIONS.PUBLISH].includes(actionId)) return;
  window.requestAnimationFrame(() => window.requestAnimationFrame(() => {
    const target = actionId === NEXT_ACTIONS.EVIDENCE
      ? document.querySelector('.evidence-attest') ?? document.querySelector('.stage-evidence') ?? document.querySelector('.phase-governance')
      : document.querySelector('.phase-governance');
    if (!target) return;
    if (target instanceof HTMLDetailsElement) target.open = true;
    target.scrollIntoView({ behavior: 'smooth', block: 'center' });
    target.querySelector('button, textarea, input, select')?.focus({ preventScroll: true });
  }));
}

// Sources, conversation, and artifacts in one place. Requirements used to mean bouncing between a
// governance screen and Copilot Studio, re-framing the phase by hand, and promoting one artifact at
// a time; the phase is one piece of work, so it gets one workspace.

// What to do next, in one sentence. Advancing a phase means author → publish → satisfy every
// blocking gate → approve, and none of that sequence was visible: a blocked step announced itself
// as a refusal from whatever command was tried next. This states the single next action and why.
function NextActionStrip({ initiative, phaseId = null, checklist = null, busy, onAuthor, onPublish, onApprove }) {
  const next = nextInitiativeAction(initiative, phaseId, { checklist });
  if (!next || next.action === NEXT_ACTIONS.COMPLETE) return null;
  const handler = {
    [NEXT_ACTIONS.AUTHOR]: onAuthor,
    [NEXT_ACTIONS.PUBLISH]: onPublish,
    'author-and-publish': onPublish,
    [NEXT_ACTIONS.APPROVE]: onApprove,
    [NEXT_ACTIONS.EVIDENCE]: onApprove
  }[next.action] ?? null;
  const label = {
    [NEXT_ACTIONS.AUTHOR]: 'Compose',
    [NEXT_ACTIONS.PUBLISH]: 'Publish',
    'author-and-publish': 'Publish',
    // These two scroll to the governance panel rather than deciding anything. A button labelled
    // "Approve" that only moves the page is the same defect this strip exists to remove.
    [NEXT_ACTIONS.APPROVE]: 'Go to approval',
    [NEXT_ACTIONS.EVIDENCE]: 'Go to evidence'
  }[next.action] ?? null;
  return <section className={`next-action next-action-${next.action}`} role="status">
    <span className="next-action-mark" aria-hidden="true">→</span>
    <div>
      <strong>{next.title}</strong>
      {next.detail && <p>{next.detail}</p>}
      {next.command && <code>{next.command}</code>}
    </div>
    {handler && label && <button className="primary compact" disabled={busy} onClick={handler}>{label}</button>}
  </section>;
}

function EpicJourneyRail({ journey, onSelect, onNext, ownsPhase = null }) {
  if (!journey) return null;
  // A screen that already owns this phase's work offers it directly — the next-action strip and the
  // governance panel are right below. Repeating it in the rail produced "Open Requirements
  // workspace" for someone standing in the Requirements workspace: the dead-button pattern again.
  const ownedHere = Boolean(ownsPhase && journey.nextAction?.phaseId === ownsPhase);
  return <section className="epic-journey-rail" aria-label="Epic journey progress">
    <div className="epic-journey-steps">
      {journey.stages.map((stage, index) => <React.Fragment key={stage.id}>
        <button
          type="button"
          className={`epic-journey-step ${stage.status}`}
          disabled={!onSelect || stage.status === 'upcoming'}
          onClick={() => onSelect?.(stage.id)}
          title={stage.phaseStatus ? `${stage.label}: ${stage.phaseStatus.replaceAll('_', ' ')}` : stage.label}
        >
          <span>{stage.status === 'complete' ? '✓' : index + 1}</span>
          <strong>{stage.label}</strong>
        </button>
        {index < journey.stages.length - 1 && <i aria-hidden="true">→</i>}
      </React.Fragment>)}
    </div>
    <div className="epic-journey-next">
      {/* Where the work stands, next to what to do about it. Printing the action in both places
          said the same sentence twice and never answered the first question. */}
      <span><small>{journey.completionPercent}% complete</small><strong>{ownedHere ? `You are here · ${journey.stageLabel ?? 'this phase'}` : `In ${journey.stageLabel ?? 'setup'}`}</strong></span>
      {onNext && !ownedHere && journey.nextAction.id !== 'status' && <button type="button" className="primary compact" onClick={() => onNext(journey.nextAction)}>{journey.nextAction.label}</button>}
    </div>
  </section>;
}

// Phase generation now belongs to the Copilot CLI plugin. The desktop remains the durable review
// surface: it shows the exact command, committed inputs and outputs, and the human governance gate.
// It deliberately has no planning-session bridge, prompt box, or hidden agent process.
function PhaseCliWorkspace({ data, selected, action, reload, downloadFile, onJourneyStage, onJourneyNext, requestedPhaseId = null }) {
  const state = selected.state;
  const phaseId = requestedPhaseId ?? state.currentPhase ?? 'epic-intake';
  const phase = state.phases[phaseId];
  const phaseResolution = state.resolution?.phases?.find((item) => item.id === phaseId);
  const phaseLabel = phaseResolution?.label ?? phaseId;
  const current = state.currentPhase === phaseId && phase?.status === 'in_progress';
  const approved = phase?.status === 'approved';
  const documents = selected.documents.filter((document) => document.phase === phaseId);
  const outputs = phaseResolution?.outputs ?? [];
  const sources = selected.sources?.sources ?? [];
  const jiraSnapshot = state.initiative.source?.type === 'jira';
  const { openArtifact, artifactViewer } = useArtifactViewer({ repository: data.repository.root, downloadFile });
  const nextAction = (next) => {
    const actionId = normalizeNextActionId(next?.id ?? next?.action);
    if ([NEXT_ACTIONS.STATUS, NEXT_ACTIONS.ADVANCE].includes(actionId)) {
      return void reload(null, state.initiative.id);
    }
    onJourneyNext?.({ ...next, id: actionId ?? next?.id });
  };
  return <div className="page epic-phase-cli">
    <header className="page-heading row-between">
      <div><span className="eyebrow">{phaseLabel} · Git-backed phase</span><h1>{state.initiative.title}</h1><p>Author with the Singularity Flow skills in Copilot CLI; inspect and govern the committed result here.</p></div>
      <div className="row"><Pill tone={approved ? 'good' : current ? 'accent' : 'warn'}>{phase?.status?.replaceAll('_', ' ') ?? 'not started'}</Pill><Pill>{state.initiative.id}</Pill></div>
    </header>
    <EpicJourneyRail journey={selected.journey} onSelect={onJourneyStage} onNext={nextAction} ownsPhase={phaseId} />
    {!current && !approved && <section className="phase-lock notice" role="status">
      <strong>{phaseLabel} is not active yet.</strong>
      <p>Complete <b>{state.currentPhase ?? 'the preceding phase'}</b> first. You can inspect this phase contract now, but its Copilot CLI skill will enforce the same sequence.</p>
    </section>}
    <CopilotCliHandoff
      data={data}
      phaseId={phaseId}
      title={current ? `Run ${phaseLabel} in Copilot CLI` : approved ? `${phaseLabel} is complete` : `${phaseLabel} command is ready when the phase unlocks`}
      detail={approved
        ? 'The approved artifacts remain visible below. Use the next-stage command when you are ready to continue.'
        : 'The desktop does not start or host Copilot. The skill composes the configured persona, world model, pinned sources, approved inputs, templates, and phase contract inside your normal Copilot CLI session.'}
    />
    <div className="cli-review-grid">
      <section className="panel cli-evidence-summary">
        <header className="panel-heading"><div><span className="eyebrow">Governed inputs</span><h2>Evidence available to the skill</h2></div><Pill tone={sources.length || jiraSnapshot ? 'good' : 'warn'}>{sources.length + (jiraSnapshot ? 1 : 0)} sources</Pill></header>
        {jiraSnapshot && <div className="cli-evidence-row"><span><strong>Jira Epic snapshot</strong><small>Committed identity and description</small></span><Pill tone="good">pinned</Pill></div>}
        {sources.map((source) => <div className="cli-evidence-row" key={source.sourceId}><span><strong>{source.name ?? source.path}</strong><small>{source.sourceId} · {formatBytes(source.bytes ?? 0)}</small></span><code>{source.sha256?.slice(0, 12)}</code></div>)}
        {!sources.length && !jiraSnapshot && <div className="inline-empty">No governed sources are pinned. Use <code>/sflow-upload</code> in Copilot CLI before authoring.</div>}
      </section>
      <section className="panel cli-output-summary">
        <header className="panel-heading"><div><span className="eyebrow">Phase contract</span><h2>Expected and committed outputs</h2></div><Pill tone={documents.length ? 'good' : 'neutral'}>{documents.length}/{outputs.length}</Pill></header>
        {outputs.map((output) => {
          const document = documents.find((item) => item.id === output.id);
          return <div className="cli-output-row" key={output.id}>
            <span><strong>{output.label}</strong><small>{output.id} · {output.required ? 'required' : 'optional'}</small></span>
            <Pill tone={document?.status === 'approved' ? 'good' : document?.sha256 ? 'warn' : 'neutral'}>{document?.status?.replaceAll('_', ' ') ?? 'not generated'}</Pill>
            <button className="secondary compact" disabled={!document?.repositoryPath} onClick={() => openArtifact(document)}>Open artifact</button>
          </div>;
        })}
        {!outputs.length && <div className="inline-empty">This phase has no configured document outputs.</div>}
      </section>
    </div>
    <PhaseGovernance data={data} selected={selected} phaseId={phaseId} action={action} reload={reload} />
    {artifactViewer}
  </div>;
}

// Requirements owns one phase page: sources, the Copilot conversation, and the artifacts that
// Requirements owes. Other Epic phases use their own dedicated page so their context cannot drift.
function PhaseWorkspace({ data, selected, action, reload, downloadFile, profileRole = null, openPlanningPrompt, onJourneyStage, onJourneyNext, requestedPhaseId = null, copilotHealth = null, onCopilotRetry = null, onCopilotLost = null }) {
  // The route can intentionally show a future phase, but the engine remains sequence-aware and
  // disables authoring until that phase is current.
  const activePhaseId = requestedPhaseId ?? selected.state.currentPhase ?? 'epic-intake';
  const session = useCopilotPlanningSession({ data, action, reload, profileRole, focus: { phase: activePhaseId }, onCopilotLost });
  const {
    contextPack, messages, questions, permissions, running, started, activity, plan, followup, setFollowup,
    objective, setObjective, persona, setPersona, preflight, phase, group, usage, logs, setLogs,
    contextStale, buildContext, beginSession, startCopilot, sendFollowup, answerQuestion, answerPermission, dismissQuestion, interruptTurn, stopCopilot
  } = session;

  const messageRef = useRef(null);
  const stickToBottom = useRef(true);
  const [activityOpen, setActivityOpen] = useState(true);
  useEffect(() => {
    const node = messageRef.current;
    if (!node || !stickToBottom.current) return;
    node.scrollTop = node.scrollHeight;
  }, [messages, activity]);
  const [edits, setEdits] = useState({});
  const [reviewed, setReviewed] = useState(false);
  const [fullView, setFullView] = useState(null);
  const [dragging, setDragging] = useState(false);
  const [preview, setPreview] = useState(null);
  const [localNote, setLocalNote] = useState(null);
  const setToastLocal = (text) => setLocalNote(text);
  const [selectedArtifact, setSelectedArtifact] = useState(null);
  const [promoting, setPromoting] = useState(false);
  const providers = Object.entries(selected.state.resolution.storage?.providers ?? {});
  const [providerId, setProviderId] = useState(selected.state.resolution.storage?.defaultProvider ?? providers[0]?.[0] ?? '');

  // Same governed path as the full sources view: bytes go to the configured provider and Git keeps
  // the hash, so a pinned document is citable evidence rather than an attachment.
  async function addSources(paths = null) {
    // Only a real list survives. Everything here crosses the IPC boundary, where a React event —
    // which a bare onClick would hand us as this argument — fails structured clone with the
    // useless message 'An object could not be cloned.'
    const filePaths = Array.isArray(paths) ? paths : null;
    const result = await action(
      () => window.singularity.uploadEpicSources(data.repository.root, selected.state.initiative.id, providerId, undefined, filePaths),
      'Pinned source files uploaded and published'
    );
    if (result && !result.canceled) await reload(undefined, selected.state.initiative.id);
  }

  // Electron removed File.path, so the location comes from the preload's webUtils bridge. Anything
  // without a resolvable path (a browser-synthesised file, a dragged selection) is reported rather
  // than silently dropped.
  async function dropSources(event) {
    event.preventDefault();
    setDragging(false);
    const files = [...(event.dataTransfer?.files ?? [])];
    if (!files.length) return;
    const paths = files.map((file) => window.singularity?.pathForFile?.(file)).filter(Boolean);
    if (!paths.length) {
      setToastLocal('Those files have no readable path. Use Add source instead.');
      return;
    }
    await addSources(paths);
  }

  async function pinJiraAttachments() {
    const result = await action(
      () => window.singularity.pinJiraAttachments(data.repository.root, selected.state.initiative.id),
      'Jira attachments pinned as citable evidence'
    );
    if (result) await reload(undefined, selected.state.initiative.id);
  }

  async function openSource(sourceId) {
    setPreview({ loading: true, sourceId });
    const result = await action(
      () => window.singularity.previewEpicSource(data.repository.root, selected.state.initiative.id, sourceId)
    );
    setPreview(result ? { ...result, loading: false } : null);
  }

  const state = selected.state;
  const activePhase = state.phases[activePhaseId];
  const phaseLabel = state.resolution?.phases?.find((phase) => phase.id === activePhaseId)?.label ?? activePhaseId;
  const intake = state.phases['epic-intake'];
  const requirements = state.phases['epic-requirements'];
  const intakeApproved = intake?.status === 'approved';
  const phaseId = activePhaseId;
  const phaseIsCurrent = selected.state.currentPhase === phaseId && activePhase?.status === 'in_progress';
  const phaseIsApproved = activePhase?.status === 'approved';
  // The phase's outputs are known from its pinned resolution, so the pane can show what this phase
  // owes from the moment it opens. Waiting for a session made it read as "nothing to produce".
  const outputs = contextPack?.outputs
    ?? selected.state.resolution?.phases?.find((item) => item.id === activePhaseId)?.outputs
    ?? [];
  const parsed = useMemo(() => readArtifactBlocks(plan, outputs.map((output) => output.id)), [plan, outputs]);
  // What is promoted is what is on screen: an edited artifact wins over the parsed one, so the
  // reviewer's corrections are what reaches Git rather than being silently discarded.
  const proposed = useMemo(() => {
    const merged = new Map(parsed);
    for (const [id, value] of Object.entries(edits)) if (merged.has(id) && value.trim()) merged.set(id, value);
    return merged;
  }, [parsed, edits]);
  const edited = useMemo(
    () => [...parsed].filter(([id, value]) => edits[id] !== undefined && edits[id] !== value).map(([id]) => id),
    [parsed, edits]
  );
  // A new proposal supersedes edits made against the previous one.
  useEffect(() => { setEdits({}); setReviewed(false); }, [plan]);
  // Compared here rather than at promotion time so the user learns while the conversation is still
  // cheap to redo.
  const changedContextSources = contextPack?.changedSources ?? [];

  const sources = selected.sources?.sources ?? [];
  const jiraAttachments = state.initiative.source?.type === 'jira' ? (state.initiative.source.attachments ?? []) : [];
  const jiraSnapshot = useMemo(() => {
    const source = state.initiative.source;
    if (source?.type !== 'jira') return null;
    // Mirrors jiraSnapshotSource in src/epic-sources.mjs; shown so the user can see the id that
    // verifyEpicTraceability will accept in a citation.
    return { sourceId: selected.sources?.jiraSnapshot?.sourceId ?? null, name: `Jira Epic ${source.key ?? state.initiative.id} snapshot` };
  }, [state.initiative.source, state.initiative.id, selected.sources]);
  const citableCount = sources.length + (jiraSnapshot ? 1 : 0);
  const documents = selected.documents.filter((document) => document.phase === phaseId);

  // The whole set lands as one commit: a traceability matrix and the requirements it cites are one
  // decision, and approving them a step apart would leave the branch citing things that are not there.
  async function approveArtifacts() {
    if (contextStale) {
      setActivity('This governed context is stale. Rebuild it before writing or pushing artifacts.');
      return;
    }
    if (!proposed.size) return;
    setPromoting(true);
    const result = await action(
      () => window.singularity.promotePlanningArtifacts(
        data.repository.root,
        contextPack.sessionId,
        persona,
        [...proposed].map(([outputId, content]) => ({ outputId, content }))
      ),
      `Wrote and pushed ${proposed.size} artifact${proposed.size === 1 ? '' : 's'}`
    );
    setPromoting(false);
    if (result) await reload(undefined, state.initiative.id);
  }

  const phaseOutputs = useMemo(
    () => selected.state.resolution?.phases?.find((item) => item.id === activePhaseId)?.outputs ?? [],
    [selected.state.resolution, activePhaseId]
  );
  // Only the current phase can have its documents chosen; a phase that is done is done.
  // Any phase whose decisions are still open — not just the one in progress. Knowing you do not
  // need a document is most useful before you reach the phase that would demand it.
  const outputChoiceEntry = selected.outputChoicesByPhase?.[activePhaseId] ?? null;
  const outputChoices = outputChoiceEntry?.editable ? outputChoiceEntry.choices : [];
  const includedOutputIds = outputChoices.filter((choice) => choice.included).map((choice) => choice.id);
  const [chosenOutputs, setChosenOutputs] = useState(includedOutputIds);
  const [outputReason, setOutputReason] = useState('');
  useEffect(() => {
    setChosenOutputs(includedOutputIds);
    setOutputReason('');
  }, [includedOutputIds.join(','), activePhaseId]);
  const outputChoiceChanged = [...chosenOutputs].sort().join(',') !== [...includedOutputIds].sort().join(',');

  async function applyOutputChoice() {
    const result = await action(
      () => window.singularity.selectInitiativeOutputs(data.repository.root, selected.state.initiative.id, activePhaseId, chosenOutputs, outputReason.trim()),
      `${activePhaseId} will produce ${chosenOutputs.length} document${chosenOutputs.length === 1 ? '' : 's'}`
    );
    if (result) await reload(undefined, selected.state.initiative.id);
  }

  const phaseWork = phaseId === selected.state.currentPhase ? selected.phaseWork ?? [] : [];


  // Every step here already had a control somewhere on this page. What was missing was the order
  // and the knowledge of which one is next, so the buttons route to those same controls.
  function runPhaseStep(step) {
    if (step.kind === 'author') {
      setSelectedArtifact(step.outputId);
      document.querySelector('.requirements-composer textarea')?.focus();
      return;
    }
    // The judgement and approval controls live in the governance panel below; this brings the
    // reader to them rather than pretending to be them.
    if (step.kind === 'attest' || step.kind === 'approve') { document.querySelector('.phase-governance')?.scrollIntoView({ behavior: 'smooth', block: 'center' }); return; }
    if (step.kind === 'publish') { void publishPhase(); return; }

  }

  const requiredOutputIds = useMemo(() => new Set(
    (selected.state.resolution?.phases?.find((item) => item.id === activePhaseId)?.outputs ?? [])
      .filter((output) => output.required)
      .map((output) => output.id)
  ), [selected.state.resolution, activePhaseId]);

  const artifactGroups = useMemo(() => {
    const rows = outputs.map((output) => ({
      output,
      content: proposed.get(output.id),
      committed: selected.documents.find((document) => document.id === output.id && document.phase === phaseId)
    }));
    return [
      { id: 'proposed', label: 'Proposed in this session', items: rows.filter((row) => row.content) },
      { id: 'draft', label: 'Draft', items: rows.filter((row) => !row.content && row.committed?.sha256 && row.committed.status !== 'approved') },
      { id: 'approved', label: 'Approved', items: rows.filter((row) => !row.content && row.committed?.status === 'approved') },
      { id: 'awaiting', label: 'Not generated yet', items: rows.filter((row) => !row.content && !row.committed?.sha256) }
    ];
  }, [outputs, proposed, selected.documents, phaseId]);

  const intakeIsNonBlocking = state.initiative?.profile === 'epic-planning' && phaseId === 'epic-intake';
  const blockingChecks = Object.values(state.phases[phaseId]?.checklist ?? {})
    .filter((check) => !intakeIsNonBlocking && check.requirement === 'must' && check.status !== 'satisfied');
  const pendingQuestions = questions.filter((question) => question.status === 'pending');
  const ready = preflight?.ready;

  async function publishPhase() {
    const result = await action(
      () => window.singularity.publishInitiativePhase(data.repository.root, state.initiative.id, phaseId, persona),
      `${phaseLabel} published, committed, and pushed`
    );
    if (result) await reload(undefined, state.initiative.id);
  }

  // Dispatch on the canonical vocabulary only. Comparing against a mix of canonical and legacy
  // names is what let 'approve-phase' slip past every branch and fall through to a no-op.
  function nextAction(next) {
    const actionId = normalizeNextActionId(next.action ?? next.id);
    if (actionId === NEXT_ACTIONS.AUTHOR) return void buildContext();
    if (actionId === NEXT_ACTIONS.PUBLISH) return void publishPhase();
    if (actionId === NEXT_ACTIONS.APPROVE || actionId === NEXT_ACTIONS.EVIDENCE) {
      // The decision itself lives in the governance panel, which owns the persona and the typed
      // confirmation. Bring it into view and focus it so the action is unmistakably next.
      const panel = document.querySelector('.phase-governance');
      panel?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      panel?.querySelector('input, select')?.focus({ preventScroll: true });
      return;
    }
    onJourneyNext?.({ ...next, id: actionId ?? next.action ?? next.id, sourceId: next.sourceId ?? next.action ?? next.id });
  }

  return <div className="requirements-workspace">
    <header className="page-heading requirements-heading">
      <div>
        <span className="eyebrow">{phaseLabel} · governed authoring</span>
        <h1>{state.initiative.title}</h1>
        <p>Bring the evidence, work it through with Copilot, then approve the artifacts into Git.</p>
      </div>
      <div className="row">
        <Pill tone={activePhase?.status === 'approved' ? 'good' : 'accent'}>{phaseId} · {activePhase?.status?.replaceAll('_', ' ')}</Pill>
        <Pill tone={ready ? 'good' : 'warn'}>{ready ? 'Copilot ready' : 'Copilot setup needed'}</Pill>
      </div>
    </header>

    <EpicJourneyRail journey={selected.journey} onSelect={onJourneyStage} onNext={nextAction} ownsPhase={phaseId} />

    {!phaseIsCurrent && !phaseIsApproved && <section className="phase-lock notice" role="status">
      <strong>{phaseLabel} is not the active phase yet.</strong>
      <p>Finish and approve <b>{selected.state.currentPhase ?? 'the preceding phase'}</b> first. This page is intentionally read-only until the workflow reaches {phaseLabel}.</p>
      <button className="secondary compact" onClick={() => onJourneyStage?.(selected.journey?.stage ?? 'intake')}>Open current phase</button>
    </section>}

    {/* The whole of what is left in this phase, in order, with exactly one step marked as now.
        The strip below answers "what is the single next command", which is the right answer for a
        CLI and the wrong one here: it told someone standing in the workspace to open the
        workspace, while four separate things were outstanding in three different panels. */}
    {phaseWork.length > 0 && <section className="phase-work" aria-label={`What is left in ${phaseLabel}`}>
      <header>
        <strong>What is left in {phaseLabel}</strong>
        <small>{phaseWork.filter((step) => step.done).length} of {phaseWork.length} done</small>
      </header>
      <ol>
        {phaseWork.map((step) => <li key={step.id} className={step.state}>
          <span className="phase-work-mark" aria-hidden="true">{step.done ? '✓' : step.state === 'now' ? '→' : '·'}</span>
          <span className="phase-work-copy"><strong>{step.label}</strong><small>{step.detail}</small></span>
          {step.state === 'now' && <button className="primary compact" disabled={running || promoting} onClick={() => runPhaseStep(step)}>{{
            author: 'Compose',
            attest: 'Open judgement',
            publish: 'Publish',
            approve: 'Open approval'
          }[step.kind] ?? 'Open'}</button>}
        </li>)}
      </ol>
    </section>}

    <NextActionStrip
      initiative={state}
      phaseId={phaseId}
      checklist={Object.values(state.phases[phaseId]?.checklist ?? {})}
      busy={running || promoting}
      onAuthor={() => nextAction({ action: NEXT_ACTIONS.AUTHOR })}
      onPublish={() => nextAction({ action: NEXT_ACTIONS.PUBLISH })}
      onApprove={() => nextAction({ action: NEXT_ACTIONS.APPROVE })}
    />
    {blockingChecks.length > 0 && <section className="requirements-gate">
      <div>
        <strong>{phaseId} cannot be approved yet</strong>
        <p>
          {blockingChecks.length} required check{blockingChecks.length === 1 ? '' : 's'} still {blockingChecks.length === 1 ? 'has' : 'have'} no evidence.
          You can author artifacts now, but the phase will not advance — and the next phase cannot be planned — until {blockingChecks.length === 1 ? 'it is' : 'they are'} satisfied.
        </p>
      </div>
      <ul>{blockingChecks.map((check) => <li key={check.id}><code>{check.id}</code> — {check.label}</li>)}</ul>
    </section>}

    {copilotHealth?.ready === false && <CopilotUnavailable health={copilotHealth} action="Copilot work" onRetry={onCopilotRetry} />}

    {state.initiative.source?.type === 'jira' && <details className="requirements-origin">
      <summary>Imported Jira Epic — the source these requirements derive from</summary>
      <ImportedEpicView selected={selected} />
    </details>}

    <div className="requirements-panes">
      <aside
        className={`requirements-sources ${dragging ? 'dropping' : ''}`}
        data-accepts-drop=""

        onDragOver={(event) => { event.preventDefault(); setDragging(true); }}
        onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget)) setDragging(false); }}
        onDrop={dropSources}
      >
        <header><h2>Sources</h2><Pill tone={citableCount ? 'good' : 'neutral'}>{citableCount} citable</Pill></header>
        {dragging && <div className="requirements-dropzone" aria-hidden="true">Drop files to pin them as evidence</div>}
        {localNote && <p className="field-error" role="alert">{localNote}</p>}
        <p className="requirements-hint">Everything pinned here is hashed and becomes part of the governed prompt. Requirements may only cite what is listed.</p>

        {jiraSnapshot && <SourceCard
          name={jiraSnapshot.name}
          detail={`${jiraSnapshot.sourceId} · imported Epic · citable`}
          title="Requirements may cite this source id"
          state="ready"
        />}
        {!sources.length
          ? <p className="requirements-hint">{jiraSnapshot
            ? 'The imported Epic above is already citable. Drop a file here, or use Add source, to pin more evidence.'
            : 'Nothing pinned yet. Drop the specification, research, designs, or spreadsheets this phase must be based on, or use Add source.'}</p>
          : sources.map((source) => <SourceCard
            key={source.sourceId}
            name={source.name ?? source.path}
            detail={`${source.sourceId} · ${formatBytes(source.bytes ?? 0)}`}
            title={`${source.sourceId} · ${source.sha256?.slice(0, 12) ?? ''}`}
            state="ready"
            onOpen={() => openSource(source.sourceId)}
          />)}
        {jiraAttachments.length > 0 && <section className="requirements-jira-attachments">
          <h3>From Jira ({jiraAttachments.length})</h3>
          <p className="requirements-hint">Listed from the Epic import. Pinning fetches and hashes each one so requirements may cite it.</p>
          <button className="secondary full compact" onClick={pinJiraAttachments}>Pin all as evidence</button>
          {jiraAttachments.map((file) => <SourceCard
            key={file.id ?? file.filename}
            name={file.filename}
            detail={`Jira attachment${file.size ? ` · ${formatBytes(file.size)}` : ''} · not pinned`}
            state="pending"
          />)}
        </section>}
        <details className="requirements-advanced">
          <summary>Manage providers, credentials and URL sources</summary>
          <EpicSourcesView data={data} selected={selected} action={action} reload={reload} />
        </details>
        <footer className="requirements-source-actions">
          <select aria-label="Storage provider" value={providerId} onChange={(event) => setProviderId(event.target.value)}>
            {providers.map(([id, provider]) => <option key={id} value={id}>{id} · {provider.type}</option>)}
          </select>
          <button className="secondary full" disabled={!providers.length} onClick={() => addSources()}>＋ Add source</button>
        </footer>
      </aside>

      <section className="requirements-conversation">
        {!contextPack ? <div className="requirements-start">
          <h2>Describe what this phase must decide</h2>
          <p>Copilot receives the phase contract, your persona, the repository world model, and every pinned source. It reasons read-only; nothing is written until you approve.</p>
          <textarea
            rows="4"
            value={objective}
            onChange={(event) => setObjective(event.target.value)}
            placeholder={`What must ${phase?.label ?? 'this phase'} settle? For example: turn the pinned specification into REQ/AC records, and flag anything the sources do not answer.`}
          />
          <div className="composer-commands start-commands">
            {phaseCommands(phaseOutputs).map((command) => <button
              key={command.id}
              type="button"
              className="composer-command"
              disabled={!ready || running}
              title={command.hint}
              onClick={() => setObjective(command.prompt)}
            >{command.label}</button>)}
          </div>
          <div className="row">
            <select aria-label="Persona" value={persona} onChange={(event) => setPersona(event.target.value)}>
              {Object.entries(data.definition.personas).map(([id, item]) => <option key={id} value={id}>{item.label}</option>)}
            </select>
            <button className="primary" disabled={!ready || running || !group} onClick={beginSession}>Start with Copilot</button>
          </div>
          {!ready && <CopilotUnavailable health={preflight} action="a planning session" onRetry={onCopilotRetry} />}
        </div> : <>
          {contextStale && <div className="requirements-stale" role="status">
            <div>
              <strong>This context is out of date</strong>
              {changedContextSources.length > 0
                ? <p>{changedContextSources.map((source) => source.path).join(', ')} changed after this context was built. The saved conversation is still available for review, but it cannot be continued or promoted until you rebuild against current governed state.</p>
                : <p>
                  The repository moved to <code>{data.repository.head?.slice(0, 10)}</code> since Copilot was given
                  this context at <code>{contextPack.manifest.repository.head.slice(0, 10)}</code> — pinning a source or
                  recording evidence both commit. Promotion will be refused until the context is rebuilt.
                  Rebuilding starts a fresh governed turn.
                </p>}
            </div>
            <button className="primary compact" disabled={running} onClick={buildContext}>Rebuild context</button>
          </div>}
          {(contextPack.warnings ?? []).length > 0 && <div className="context-warnings" role="status">
            {contextPack.warnings.map((warning, index) => <p key={index}>{warning}</p>)}
          </div>}
          <div className="requirements-context-bar">
            <span>{contextPack.manifest.sources.length} hashed sources · {Math.ceil(contextPack.manifest.context.bytes / 1024)} KB context</span>
            <details><summary>Inspect the exact prompt</summary><pre>{contextPack.context}</pre></details>
            {!started && !running && !contextStale && <button className="ghost compact" disabled={running} onClick={startCopilot} title="The session did not start — send this context again">Retry send</button>}
          </div>
          <div className="copilot-identity">
            <span className="copilot-avatar" aria-hidden="true">✦</span>
            <div>
              <strong>Copilot</strong>
              <small>{data.definition.personas[persona]?.label ?? persona}</small>
            </div>
            <Pill tone={running ? 'accent' : started ? 'good' : 'neutral'}>
              {running ? 'Working' : started ? 'Ready for input' : 'Not started'}
            </Pill>
          </div>
          <div className="requirements-activity">{activity}</div>
          {pendingQuestions.length > 1 && <p className="requirements-hint">{pendingQuestions.length} questions are waiting.</p>}
          <div
            className="requirements-messages"
            ref={messageRef}
            onScroll={(event) => {
              const node = event.currentTarget;
              // Yield to a reader who has scrolled up; resume when they return to the bottom.
              stickToBottom.current = node.scrollHeight - node.scrollTop - node.clientHeight < 40;
            }}
          >
            {messages.length ? messages.map((message, index) => {
              // Artifact fences belong in the Artifacts pane; repeating a whole specification inside
              // the transcript buries the reasoning the conversation is actually for.
              const visible = stripArtifactFences(message.text);
              return <div className={`chat-turn ${message.role}`} key={`${message.id}:${index}`}>
                <span className="chat-avatar" aria-hidden="true">{message.role === 'user' ? '·' : '✦'}</span>
                <div className="chat-bubble">
                  <header>
                    <strong>{message.role === 'user' ? 'You' : 'Copilot'}</strong>
                    <button className="ghost compact" title="Copy this message" onClick={() => copyText(message.text)}>Copy</button>
                  </header>
                  {message.role === 'assistant'
                    ? <TemplatePreview content={visible.text} />
                    : <pre>{visible.text}</pre>}
                  {visible.stripped > 0 && <small className="chat-fenced">{visible.stripped} artifact{visible.stripped === 1 ? '' : 's'} proposed — review them in Artifacts</small>}
                </div>
              </div>;
            }) : <div className="inline-empty">Copilot's reasoning appears here. Ask it to challenge an assumption, tighten an acceptance criterion, or justify a requirement against its source.</div>}
          </div>
          <div className="requirements-telemetry">
            <span>{usage?.contextTokens ? `${formatTokens(usage.contextTokens)} context tokens` : 'Usage appears once Copilot reports it'}{usage?.contextWindow ? ` of ${formatTokens(usage.contextWindow)}` : ''}</span>
            {/* Open by default, and it stays wherever the reader leaves it. Copilot's tool calls,
                refusals and diagnostics are the only account of what it actually did; behind a
                closed summary the turn looked like silence. */}
            <details className="requirements-console" open={activityOpen} onToggle={(event) => setActivityOpen(event.currentTarget.open)}>
              <summary>Copilot activity ({logs.length})</summary>
              <div className="requirements-console-lines">
                {logs.length
                  ? logs.slice(-80).map((entry, index) => <div className={entry.level} key={`${entry.id}:${index}`}>
                    <time>{new Date(entry.at).toLocaleTimeString()}</time><code>{entry.type}</code><span>{entry.detail}</span>
                  </div>)
                  : <div className="inline-empty">Tool calls, thinking and diagnostics appear here.</div>}
              </div>
            </details>
          </div>
          <div className="composer-commands">
            {phaseCommands(outputs).map((command) => <button
              key={command.id}
              type="button"
              className="composer-command"
              disabled={!started || running}
              title={command.hint}
              onClick={() => { setFollowup(command.prompt); }}
            >{command.label}</button>)}
          </div>
          {/* Enter sends and Shift+Enter breaks the line, the convention every chat surface uses.
              The hint under the box is only honest if the keys actually behave that way. */}
          <div className="requirements-composer">
            <textarea
              rows="3"
              value={followup}
              disabled={!started || running}
              onChange={(event) => setFollowup(event.target.value)}
              onKeyDown={(event) => {
                if (event.key !== 'Enter' || event.shiftKey) return;
                event.preventDefault();
                if (started && !running && followup.trim()) void sendFollowup();
              }}
              placeholder={started ? 'Add an instruction, answer a question, or ask for a revision…' : 'Start Copilot with the governed context first.'}
            />
            <div className="composer-bar">
              <small>{started ? 'Shift + Enter for a new line' : 'Start Copilot above to begin the conversation.'}</small>
              {started && <div className="row">
                {/* Stop halts the turn and keeps the conversation; ending the session is separate
                    and explicit, because losing the transcript is not what "stop" means. */}
                <button className="ghost compact" disabled={!running} onClick={interruptTurn} title="Halt the current turn; the conversation stays">Stop</button>
                <button className="ghost compact" onClick={stopCopilot} title="Discard this session and release Copilot">End session</button>
                <button className="secondary compact" disabled={running || !followup.trim()} onClick={sendFollowup}>Send ➤</button>
              </div>}
            </div>
          </div>
        </>}
      </section>

      <aside className="requirements-artifacts">
        <header><h2>Artifacts</h2><Pill tone={proposed.size ? 'accent' : 'neutral'}>{proposed.size}/{outputs.length || '—'}</Pill></header>
        {/* What this phase demands is a property of the profile; what this Epic needs is a
            decision. Optional outputs are chosen here, and the choice is a governed change. */}
        {outputChoices.length > 0 && <details className="artifact-choice">
          <summary>Documents for this Epic ({outputChoices.filter((choice) => choice.included).length} of {outputChoices.length})</summary>
          {outputChoices.map((choice) => <label key={choice.id} className={choice.required ? 'locked' : undefined}>
            <input
              type="checkbox"
              checked={chosenOutputs.includes(choice.id)}
              disabled={choice.required || choice.authored}
              onChange={(event) => setChosenOutputs((current) => event.target.checked
                ? [...current, choice.id]
                : current.filter((id) => id !== choice.id))}
            />
            <span><strong>{choice.label}</strong><small>{choice.required
              ? 'Required by this delivery profile'
              : choice.authored ? 'Already has content — remove the file first' : 'Optional'}{choice.pinned ? '' : ' · added to the profile since this Epic started'}</small></span>
          </label>)}
          {outputChoiceChanged && <div className="row">
            <input aria-label="Why this Epic's documents changed" value={outputReason} onChange={(event) => setOutputReason(event.target.value)} placeholder="Why — recorded with the change" />
            <button className="primary compact" disabled={!outputReason.trim()} onClick={applyOutputChoice}>Apply</button>
          </div>}
        </details>}
        {!outputs.length ? <p className="requirements-hint">Start a session to see what this phase must produce.</p> : <>
          {artifactGroups.map((group) => group.items.length > 0 && <section key={group.id} className="artifact-group">
            <h3>{group.label}</h3>
            {group.items.map(({ output, content, committed }) => <button
              key={output.id}
              type="button"
              className={`requirements-artifact ${selectedArtifact === output.id ? 'active' : ''} ${content ? 'proposed' : ''}`}
              onClick={() => setSelectedArtifact(selectedArtifact === output.id ? null : output.id)}
            >
              <span className="artifact-icon" aria-hidden="true">{kindTag(committed?.path ?? output.kind)}</span>
              <span className="artifact-body">
                <strong>{output.label}</strong>
                <small className="artifact-id">{output.id}{committed?.generation ? ` · v${committed.generation}` : ''}</small>
                <small>{content
                  ? `Proposed in this session · ${formatBytes(content.length)}`
                  : committed?.sha256
                    ? `${committed.status.replaceAll('_', ' ')}${committed.bytes ? ` · ${formatBytes(committed.bytes)}` : ''}${committed.generatedPersona ? ` · ${committed.generatedPersona}` : ''}`
                    : requiredOutputIds.has(output.id) ? 'Required · not generated yet' : 'Optional · not generated yet'}</small>
              </span>
              {content && <span className="artifact-state proposed" title="Proposed, not yet written">●</span>}
              {!content && committed?.status === 'approved' && <span className="artifact-state approved" title="Approved">✓</span>}
            </button>)}
          </section>)}
          {selectedArtifact && proposed.get(selectedArtifact) && <>
            <pre className="requirements-artifact-preview">{proposed.get(selectedArtifact)}</pre>
            <button className="secondary full compact" onClick={() => setFullView(selectedArtifact)}>Open full size · review &amp; edit</button>
          </>}
          <div className="requirements-approval">
            <p className="requirements-hint">
              Approving writes every proposed artifact and pushes them as one commit. The phase gate stays a separate decision, and approval can happen from anywhere on the pushed branch.
            </p>
            {edited.length > 0 && <p className="requirements-hint"><b>{edited.length} edited</b> — your version is what gets written.</p>}
            {proposed.size > 0 && <label className="self-approval-ack">
              <input type="checkbox" checked={reviewed} onChange={(event) => setReviewed(event.target.checked)} />
              <span>I have read {proposed.size === 1 ? 'this artifact' : `all ${proposed.size} artifacts`} in full.</span>
            </label>}
            <button className="primary full" disabled={!proposed.size || !reviewed || contextStale || promoting || running} onClick={approveArtifacts}>
              {promoting ? 'Writing…' : `Approve ${proposed.size || ''} artifact${proposed.size === 1 ? '' : 's'} & push`}
            </button>
            {proposed.size > 0 && !reviewed && <small className="field-error">Confirm you have read the artifacts before they are written and pushed.</small>}
          </div>
        </>}
      </aside>
    </div>
    <PhaseGovernance data={data} selected={selected} phaseId={phaseId} action={action} reload={reload} />
    {permissions[0] && <div className="modal-backdrop copilot-ask" role="dialog" aria-modal="true">
      <div className="preview-modal question-modal">
        <header>
          <div>
            <strong>Copilot wants to {permissions[0].kind ?? 'act on'} the repository</strong>
            <small>{permissions.length > 1 ? `${permissions.length} requests waiting · deciding one at a time` : `${permissions[0].mode ?? 'This'} mode puts each of these to you before it happens`}</small>
          </div>
        </header>
        <div className="copilot-permission-request">
          <p><strong>{permissions[0].title}</strong></p>
          {!!permissions[0].locations.length && <ul className="copilot-permission-paths">{permissions[0].locations.map((location) => <li key={location}><code>{location}</code></li>)}</ul>}
          <p className="field-help">Refusing is safe: Copilot is told no and continues. Nothing here is committed — publishing and approval still run through the governed phase.</p>
          <div className="row">
            <button className="primary" onClick={() => answerPermission(permissions[0], true)}>Allow once</button>
            <button className="ghost" onClick={() => answerPermission(permissions[0], false)}>Refuse</button>
          </div>
        </div>
      </div>
    </div>}
    {pendingQuestions[0] && <div className="modal-backdrop copilot-ask" role="dialog" aria-modal="true">
      <div className="preview-modal question-modal">
        <header>
          <div>
            <strong>Copilot needs an answer to continue</strong>
            <small>{pendingQuestions.length > 1 ? `${pendingQuestions.length} waiting · answering one at a time` : 'The turn is paused until you answer or skip'}</small>
          </div>
        </header>
        <CopilotQuestionCard
          question={pendingQuestions[0]}
          disabled={!started}
          onAnswer={answerQuestion}
          onDismiss={dismissQuestion}
        />
      </div>
    </div>}
    {fullView && (() => {
      const output = outputs.find((item) => item.id === fullView);
      const committed = selected.documents.find((document) => document.id === fullView && document.phase === phaseId);
      const current = proposed.get(fullView) ?? '';
      const language = output?.kind === 'yaml' ? 'yaml' : 'markdown';
      return <div className="modal-backdrop" role="dialog" aria-modal="true" onClick={() => setFullView(null)}>
        <div className="preview-modal artifact-modal" onClick={(event) => event.stopPropagation()}>
          <header>
            <div>
              <strong>{output?.label ?? fullView}</strong>
              <small>{fullView} · {output?.kind}{committed?.sha256 ? ` · comparing against generation ${committed.generation}` : ' · nothing committed yet'}</small>
            </div>
            <div className="row">
              {edits[fullView] !== undefined && <button className="ghost compact" onClick={() => setEdits((rest) => { const next = { ...rest }; delete next[fullView]; return next; })}>Revert edits</button>}
              <button className="ghost compact" onClick={() => setFullView(null)}>Close</button>
            </div>
          </header>
          {/* A diff only means something once there is a committed generation to compare with. */}
          {committed?.content
            ? <DiffEditor
              height="min(620px, 68vh)"
              language={language}
              original={committed.content}
              modified={current}
              options={{ renderSideBySide: true, readOnly: false, minimap: { enabled: false }, fontSize: 12, scrollBeyondLastLine: false }}
              onMount={(editor) => {
                // Edits are made on the modified side; Monaco's diff editor exposes it separately.
                editor.getModifiedEditor().onDidChangeModelContent(() => {
                  setEdits((rest) => ({ ...rest, [fullView]: editor.getModifiedEditor().getValue() }));
                });
              }}
            />
            : <Editor
              height="min(620px, 68vh)"
              language={language}
              value={current}
              options={{ minimap: { enabled: false }, fontSize: 12, wordWrap: 'on', scrollBeyondLastLine: false }}
              onChange={(value) => setEdits((rest) => ({ ...rest, [fullView]: value ?? '' }))}
            />}
        </div>
      </div>;
    })()}
    {preview && <div className="modal-backdrop" role="dialog" aria-modal="true" onClick={() => setPreview(null)}>
      <div className="preview-modal" onClick={(event) => event.stopPropagation()}>
        <header>
          <div>
            <strong>{preview.name ?? 'Pinned source'}</strong>
            <small>{preview.sourceId}{preview.bytes ? ` · ${formatBytes(preview.bytes)}` : ''}{preview.verified ? ' · hash verified' : ''}</small>
          </div>
          <button className="ghost compact" onClick={() => setPreview(null)}>Close</button>
        </header>
        {preview.loading
          ? <p className="requirements-hint">Materialising the pinned bytes…</p>
          : preview.tooLarge
            ? <p className="requirements-hint">This source is {formatBytes(preview.bytes)} — too large to preview here. Its hash is still governed evidence.</p>
            : preview.text != null
              ? <TemplatePreview content={preview.text} />
              : preview.dataUrl?.startsWith('data:application/pdf')
                ? <iframe title={preview.name} src={preview.dataUrl} />
                : preview.dataUrl?.startsWith('data:image/')
                  ? <img alt={preview.name} src={preview.dataUrl} />
                  : <p className="requirements-hint">No inline view for {preview.mimeType}. The bytes are pinned and hashed; open the cached file to inspect it.</p>}
      </div>
    </div>}
  </div>;
}

function PhaseGovernance({ data, selected, phaseId, action, reload }) {
  const phase = selected.state.phases[phaseId];
  const [persona, setPersona] = useState(
    selected.state.sessionPersona
      ?? preferredPersonaForRole(data.desktopProfile?.role, data.definition.personas)
      ?? Object.keys(data.definition.personas)[0]
      ?? ''
  );
  const [confirmation, setConfirmation] = useState('');
  // Why the approve action is unavailable, in the words of what to do about it.
  const approvalBlocker = !persona
    ? 'Select your review persona first.'
    : confirmation.trim() === ''
      ? `Type ${phaseId}:phase in the confirmation field to approve this exact document set.`
      : confirmation !== `${phaseId}:phase`
        ? `The confirmation phrase does not match. Type exactly ${phaseId}:phase.`
        : null;
  const [selfApproval, setSelfApproval] = useState(false);
  const [attesting, setAttesting] = useState(null);
  const [attestation, setAttestation] = useState('');

  if (!phase) return null;
  // A check whose acceptedAssurance includes human-approved is one a person may attest to; the rest
  // can only be earned by a verifier at publish. Read it from the pinned resolution, which is the
  // per-initiative source of truth — the phase-state projection does not carry it.
  const checkDefinitions = selected.state.resolution?.phases?.find((item) => item.id === phaseId)?.checklist ?? [];
  const attestable = Object.values(phase.checklist ?? {})
    .filter((check) => check.status !== 'satisfied' && check.requirement !== 'optional')
    .map((check) => ({ ...check, definition: checkDefinitions.find((item) => item.id === check.id) }))
    .filter((check) => check.definition?.acceptedAssurance?.includes('human-approved'));
  const externalEvidence = (selected.phaseGate?.checklist ?? [])
    .filter((check) => !['satisfied', 'waived', 'not_applicable', 'optional'].includes(check.status))
    .filter((check) => !check.acceptedAssurance?.includes('human-approved'))
    .map((check) => {
      const assurance = check.acceptedAssurance?.[0] ?? '<LEVEL>';
      return {
        ...check,
        command: `singularity-flow initiative evidence add ${check.id} --phase ${phaseId} --assurance ${assurance} --path <EVIDENCE-FILE> --verification <METHOD>`
      };
    });

  async function recordEvidence(checkId) {
    const result = await action(
      () => window.singularity.recordInitiativeEvidence(
        data.repository.root, selected.state.initiative.id, phaseId, checkId, attestation, attestation
      ),
      `Evidence recorded for ${checkId}`
    );
    if (!result) return;
    setAttesting(null);
    setAttestation('');
    await reload(undefined, selected.state.initiative.id);
  }

  const outputs = Object.values(phase.outputs ?? {});
  // Publication needs every REQUIRED output authored. The engine already works this way
  // (verifyInitiativePhaseOutputs only reports a missing output when definition.required), so
  // demanding all of them here made the button stricter than the gate it represents: an optional
  // output left blank disabled publish in the app while the CLI would have accepted it.
  // Epic Intake is intentionally non-blocking. Keep older pinned Epic
  // snapshots usable even if they recorded these outputs as required.
  const epicIntake = selected.state.initiative?.profile === 'epic-planning' && phaseId === 'epic-intake';
  const requiredOutputs = outputs.filter((output) => output.required !== false);
  const effectiveRequiredOutputs = epicIntake ? [] : requiredOutputs;
  const authoredOutputs = outputs.filter((output) => output.sha256 && output.status === 'draft');
  const readyToPublish = phase.status === 'in_progress'
    && (epicIntake || requiredOutputs.every((output) => output.sha256 && output.status === 'draft'))
    && effectiveRequiredOutputs.every((output) => output.sha256 && output.status === 'draft');
  const pendingRequired = effectiveRequiredOutputs.filter((output) => !(output.sha256 && output.status === 'draft'));
  const awaitingApproval = phase.status === 'awaiting_approval';
  const approved = phase.status === 'approved';
  const phaseIndex = (selected.state.phaseOrder ?? []).indexOf(phaseId);
  const nextPhaseId = phaseIndex >= 0 ? selected.state.phaseOrder?.[phaseIndex + 1] : null;
  const nextPhaseLabel = selected.state.resolution?.phases?.find((item) => item.id === nextPhaseId)?.label ?? 'the next phase';
  const approvalExplanation = phaseId === 'epic-intake'
    ? `This confirms the imported Epic details and Jira snapshot. Nothing is being built yet; it simply unlocks ${nextPhaseLabel}.`
    : `This accepts the exact ${phase.label.toLowerCase()} documents currently shown above and unlocks ${nextPhaseLabel}.`;
  async function publish() {
    const result = await action(
      () => window.singularity.publishInitiativePhase(data.repository.root, selected.state.initiative.id, phaseId, persona),
      `${phase.label} generation published, committed, and pushed`
    );
    if (result) await reload(undefined, selected.state.initiative.id);
  }
  async function approve() {
    const result = await action(
      () => window.singularity.approveInitiativePhase(
        data.repository.root,
        selected.state.initiative.id,
        'phase',
        confirmation,
        persona,
        selfApproval
      ),
      `${phase.label} approved against its exact bundle hash, committed, and pushed`
    );
    if (result) {
      setConfirmation('');
      setSelfApproval(false);
      await reload(undefined, selected.state.initiative.id);
    }
  }
  return <section className="panel phase-governance">
    <div><span className="eyebrow">Phase decision</span><h3>{awaitingApproval ? `Approve ${phase.label} to continue` : phase.label}</h3><p>{approved ? `Approved. ${nextPhaseLabel === 'the next phase' ? 'This phase is complete.' : `${nextPhaseLabel} is now unlocked.`}` : awaitingApproval ? approvalExplanation : readyToPublish ? (epicIntake ? 'Ready to publish. The Jira Epic snapshot is enough; add optional documents only when they add useful context.' : 'The authored outputs are ready to publish for review.') : pendingRequired.length ? `Waiting on ${pendingRequired.length} required output${pendingRequired.length === 1 ? '' : 's'}: ${pendingRequired.map((output) => output.id).join(', ')}. Run the phase’s /sflow-* skill in Copilot CLI, then refresh this page.` : 'Generate every required output with Copilot CLI before publishing this phase.'}</p>
      {!readyToPublish && !awaitingApproval && !approved && authoredOutputs.length > 0 && <p className="stage-progress">{authoredOutputs.length} of {effectiveRequiredOutputs.length} required outputs authored.</p>}
    </div>
    <label><span>Your review persona</span><select value={persona} onChange={(event) => setPersona(event.target.value)}>{Object.entries(data.definition.personas).map(([id, item]) => <option value={id} key={id}>{item.label}</option>)}</select></label>
    {attestable.length > 0 && <section className="evidence-attest">
      <header><strong>Checks awaiting your judgement</strong><small>Recorded as human-approved evidence against your Git identity, committed append-only. The engine refuses an actor outside the check's approval authority.</small></header>
      {attestable.map((check) => <div key={check.id} className="evidence-attest-row">
        <div>
          <code>{check.id}</code>
          <span>{check.label}</span>
          {check.definition?.acceptedAssurance?.includes('machine-verified') && <em>Normally earned automatically at publish — attest only if you are accepting it deliberately.</em>}
        </div>
        {attesting === check.id ? <div className="evidence-attest-form">
          <textarea
            rows="2"
            value={attestation}
            onChange={(event) => setAttestation(event.target.value)}
            placeholder="What did you review, and what did you conclude? This is recorded with your name."
          />
          <div className="row">
            <button className="ghost compact" onClick={() => { setAttesting(null); setAttestation(''); }}>Cancel</button>
            <button className="primary compact" disabled={!attestation.trim()} onClick={() => void recordEvidence(check.id)}>Record evidence</button>
          </div>
          {!attestation.trim() && <small className="field-error">Say what you reviewed — an attestation with no reasoning is not evidence.</small>}
        </div> : <button className="secondary compact" onClick={() => { setAttesting(check.id); setAttestation(''); }}>Record judgement</button>}
      </div>)}
    </section>}
    {externalEvidence.length > 0 && <section className="evidence-attest external-evidence">
      <header><strong>Checks awaiting verified evidence</strong><small>These checks cannot be satisfied by a human attestation. Register the relevant test, scanner, system, or source evidence from Copilot CLI, then refresh this page.</small></header>
      {externalEvidence.map((check) => <div key={check.id} className="evidence-attest-row">
        <div>
          <code>{check.id}</code>
          <span>{check.label}</span>
          <em>Accepted assurance: {check.acceptedAssurance.join(' / ')}</em>
        </div>
        <code className="external-evidence-command">{check.command}</code>
      </div>)}
    </section>}
    {awaitingApproval && <><label><span>Type the confirmation phrase</span><small className="field-help">Enter <code>{phaseId}:phase</code> to confirm you reviewed this exact document set. This protects against approving a changed version.</small><input aria-label={`Type ${phaseId}:phase to confirm`} className={confirmation.trim() && confirmation !== `${phaseId}:phase` ? 'confirmation-mismatch' : undefined} value={confirmation} onChange={(event) => setConfirmation(event.target.value)} placeholder="Type the phrase here" />{approvalBlocker && <small className="field-error">{approvalBlocker}</small>}</label><label className="self-approval-ack"><input type="checkbox" checked={selfApproval} onChange={(event) => setSelfApproval(event.target.checked)} /><span>I understand that self-approval, when detected, is valid but not independent review.</span></label></>}
    <div className="stage-primary-action">{approved ? <Pill tone="good">Approved — next phase unlocked</Pill> : awaitingApproval ? <button className="primary" disabled={Boolean(approvalBlocker)} title={approvalBlocker ?? undefined} onClick={approve}>Approve {phase.label} &amp; continue</button> : <button className="primary" disabled={!readyToPublish || !persona} title={!persona ? 'Select a persona first.' : pendingRequired.length ? `Not yet authored: ${pendingRequired.map((output) => output.id).join(', ')}` : undefined} onClick={publish}>Publish {phase.label} for review</button>}</div>
    {selected.state.currentPhase === phaseId && <details className="stage-evidence"><summary>Evidence & governance details <span>{selected.phaseGate?.checklist?.length ?? 0} checks</span></summary><div>{selected.phaseGate?.checklist?.map((check) => <p key={check.id}><Pill tone={['satisfied', 'waived', 'not_applicable', 'optional'].includes(check.status) ? 'good' : 'warn'}>{check.status}</Pill><span><strong>{check.label}</strong><small>{check.acceptedAssurance.join(' / ')} · {check.gate}</small></span></p>)}</div></details>}
  </section>;
}

function epicStageLabel(item) {
  if (item.status === 'complete') return 'Complete';
  if (item.currentPhase === 'epic-intake') return 'Sources';
  if (item.currentPhase === 'epic-requirements') return 'Requirements';
  if (item.currentPhase === 'epic-planning') return 'Planning';
  if (item.currentPhase === 'epic-publish') return 'Stories';
  return item.currentPhaseLabel ?? 'Not started';
}

function JiraStoryIntake({ data, action, onStarted, onSetupJira }) {
  const workspacePath = data.workspace?.workspace?.path;
  const workspaceManifest = data.workspace?.workspace;
  const repositoryHealth = data.workspace?.repositories ?? [];
  const repositoryConfiguration = workspaceManifest?.repositories ?? {};
  const [jira, setJira] = useState(null);
  const [stories, setStories] = useState([]);
  const [warnings, setWarnings] = useState([]);
  const [loading, setLoading] = useState(false);
  const [storyReference, setStoryReference] = useState('');
  const [selectedKey, setSelectedKey] = useState('');
  const [story, setStory] = useState(null);
  const [repositoryId, setRepositoryId] = useState('');
  const workTypes = Object.entries(data.definition?.workTypes ?? {});
  const personas = Object.entries(data.definition?.personas ?? {});
  const [workType, setWorkType] = useState(workTypes[0]?.[0] ?? '');
  const [persona, setPersona] = useState(
    data.session?.persona && data.definition?.personas?.[data.session.persona]
      ? data.session.persona
      : personas[0]?.[0] ?? ''
  );

  const repositories = repositoryHealth.map((health) => {
    const configured = repositoryConfiguration[health.id] ?? {};
    return {
      ...health,
      projectKey: String(configured.jira?.board ?? health.jira?.board ?? '').trim().toUpperCase(),
      displayName: configured.metadata?.name ?? health.metadata?.name ?? health.id
    };
  });
  const storyProject = story?.project?.key ?? (story?.key?.includes('-') ? story.key.slice(0, story.key.lastIndexOf('-')) : '');
  const routedRepositories = repositories.filter((repository) => repository.projectKey === storyProject);
  const selectedRepository = repositories.find((repository) => repository.id === repositoryId) ?? null;
  const existing = story ? data.workItems.find((item) => item.id === story.key) : null;
  const connected = jira?.credentials?.connected && jira?.routing?.configured;

  async function loadJira(refresh = false) {
    if (!workspacePath) return;
    setLoading(true);
    try {
      const context = await window.singularity.workspaceJiraContext(data.repository.root, workspacePath);
      setJira(context);
      if (!context.credentials?.connected || !context.routing?.configured) {
        setStories([]);
        return;
      }
      const result = await window.singularity.workspaceJiraStories(data.repository.root, workspacePath, refresh);
      setStories(result.stories ?? []);
      setWarnings(result.warnings ?? []);
    } catch (error) {
      setWarnings([{ message: error.message }]);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { void loadJira(false); }, [workspacePath]);

  async function fetchStory(reference = selectedKey || storyReference) {
    if (!reference.trim()) return;
    const result = await action(() =>
      window.singularity.workspaceJiraStory(data.repository.root, workspacePath, reference));
    if (!result) return;
    setStory(result);
    setStoryReference(result.key);
    setSelectedKey(stories.some((item) => item.key === result.key) ? result.key : '');
    const project = result.project?.key ?? result.key.slice(0, result.key.lastIndexOf('-'));
    const candidates = repositories.filter((repository) => repository.projectKey === project && repository.state === 'ready');
    setRepositoryId(candidates[0]?.id ?? '');
  }

  async function start() {
    const result = await action(
      () => window.singularity.startStoryWizard(
        data.repository.root,
        workspacePath,
        repositoryId,
        story.key,
        workType,
        persona
      ),
      existing ? `${story.key} resumed` : `${story.key} workflow created, committed, and pushed`
    );
    if (result) onStarted(result);
  }

  if (!workspacePath) {
    return <div className="page story-intake-page"><Empty title="Open a project workspace first" detail="Story intake needs workspace repository routing and Jira project configuration." /></div>;
  }

  const canStart = connected && story && repositoryId && selectedRepository?.state === 'ready' && workType && persona;
  return <div className="page story-intake-page">
    <header className="page-heading row-between"><div><span className="eyebrow">Developer entry point · no Epic intake required</span><h1>Start directly from a Jira Story</h1><p>Choose the Story, verify its optional parent Epic and repository lineage, then create or resume the canonical Jira-key branch with a pinned workflow.</p></div><Pill tone={connected ? 'good' : 'warn'}>{connected ? 'Jira ready' : 'Jira setup required'}</Pill></header>
    <section className="story-intake-journey" aria-label="Jira Story intake workflow">
      {[
        ['1', 'Choose Story'],
        ['2', 'Review context'],
        ['3', 'Route repository'],
        ['4', 'Select workflow'],
        ['5', 'Start delivery']
      ].map(([number, label], index) => <React.Fragment key={number}><span className={(story ? index < 2 : index === 0) || (repositoryId && index === 2) || (workType && persona && index === 3) ? 'active' : ''}><b>{number}</b><small>{label}</small></span>{index < 4 && <i />}</React.Fragment>)}
    </section>

    <section className="story-intake-grid">
      <article className="panel story-picker-panel">
        <header className="panel-heading"><div><span className="eyebrow">Step 1 · Jira</span><h2>Choose an assigned Story</h2><p>The list uses the Jira projects configured for this workspace. Backlog-only work is not loaded.</p></div><button className="secondary compact" disabled={loading || !connected} onClick={() => loadJira(true)}>{loading ? 'Refreshing…' : '↻ Refresh'}</button></header>
        {!connected && <div className="notice warn"><div><strong>Jira is not ready for this workspace.</strong><span>Connect this operating-system user and verify each repository’s Jira project key.</span></div><button className="secondary" onClick={onSetupJira}>Set up Jira</button></div>}
        {warnings.map((warning, index) => <div className="notice warn" key={`${warning.projectKey ?? 'jira'}-${index}`}><strong>{warning.projectKey ? `${warning.projectKey} could not be loaded` : 'Could not load Jira Stories'}</strong><span>{warning.message}</span></div>)}
        <div className="story-picker-list">
          {stories.map((item) => <button className={selectedKey === item.key ? 'active' : ''} key={item.key} onClick={() => { setSelectedKey(item.key); void fetchStory(item.key); }}><StatusDot status={item.statusCategory === 'Done' ? 'approved' : 'in_progress'} /><span><strong>{item.key} — {item.title}</strong><small>{item.status ?? 'unknown'} · {item.priority ?? 'no priority'}{item.parent?.key ? ` · parent ${item.parent.key}` : ''}</small></span><em>→</em></button>)}
          {!loading && connected && !stories.length && <div className="inline-empty">No assigned Stories were found. Enter an exact Story key below.</div>}
        </div>
        <div className="exact-story-entry"><label><span>Exact Story key or Jira URL</span><input value={storyReference} onChange={(event) => setStoryReference(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') void fetchStory(); }} placeholder="KAN-123 or https://…/browse/KAN-123" /></label><button className="secondary" disabled={!connected || !storyReference.trim()} onClick={() => fetchStory()}>Fetch Story</button></div>
      </article>

      <article className="panel story-context-panel">
        <header className="panel-heading"><div><span className="eyebrow">Steps 2–4 · Governed context</span><h2>{story ? `${story.key} intake` : 'Review before starting'}</h2><p>Nothing is committed until the exact Story, repository, workflow, and persona are visible here.</p></div>{story && <Pill tone="accent">{story.status ?? 'unknown'}</Pill>}</header>
        {!story ? <Empty title="Choose a Jira Story" detail="Its description, acceptance criteria, attachments, parent Epic, and repository route will appear here." /> : <>
          <section className="story-jira-summary">
            <div><span>Story</span><strong>{story.title}</strong><small>{story.issueType} · {story.priority ?? 'No priority'} · {story.assignee ?? 'Unassigned'}</small></div>
            <div><span>Parent lineage</span><strong>{story.parent?.key ?? 'No Jira parent'}</strong><small>{story.parent?.title ?? 'This Story can still be governed directly and linked later.'}</small></div>
            <div><span>Acceptance criteria</span><strong>{story.acceptanceCriteria ? 'Available' : 'Not supplied'}</strong><small>{story.acceptanceCriteria || 'Capture missing criteria during the first workflow phase.'}</small></div>
            <div><span>Attachments</span><strong>{story.attachments?.length ?? 0}</strong><small>Metadata is pinned in the Jira snapshot; governed files can be uploaded after intake.</small></div>
          </section>
          <details className="story-description" open><summary>Description</summary><p>{story.description || 'No Jira description was supplied.'}</p></details>
          <div className="story-intake-selectors">
            <label><span>Delivery repository</span><select value={repositoryId} onChange={(event) => setRepositoryId(event.target.value)}><option value="">Choose the routed repository</option>{routedRepositories.map((repository) => <option key={repository.id} value={repository.id} disabled={repository.state !== 'ready'}>{repository.displayName} · {repository.id} ({repository.state})</option>)}</select><small>{routedRepositories.length ? `Jira ${storyProject} is mapped by workspace configuration.` : `No ready repository is mapped to Jira project ${storyProject}. Edit Workspace configuration first.`}</small></label>
            <label><span>Story workflow</span><select value={workType} onChange={(event) => setWorkType(event.target.value)}>{workTypes.map(([id, item]) => <option value={id} key={id}>{item.label}</option>)}</select><small>The selected workflow is pinned for this Story after intake.</small></label>
            <label><span>Session persona</span><select value={persona} onChange={(event) => setPersona(event.target.value)}>{personas.map(([id, item]) => <option value={id} key={id}>{item.label}</option>)}</select><small>The persona applies locally to this session and can be changed on resume.</small></label>
          </div>
          {existing && <div className="notice accent"><strong>{story.key} already exists in this repository.</strong><span>Starting will fetch and resume its canonical branch instead of creating a second workflow.</span></div>}
          <footer className="story-intake-action"><div><strong>What happens next</strong><span>Singularity checks out <code>{story.key}</code>, pins the Jira snapshot, creates and pushes the workflow branch, then asks you to generate the repository world model on that branch. Continue with <code>/sflow-phase</code> after grounding succeeds.</span></div><button className="primary" disabled={!canStart} onClick={start}>{existing ? `Resume ${story.key}` : 'Start Story workflow'}</button></footer>
        </>}
      </article>
    </section>
  </div>;
}

function EpicsHome({ data, action, reload, openEpic, generateWorldModel, onSetupJira, startNew = false }) {
  // "New Epic" from inside an Epic workspace clears the selection and lands here; honour that
  // intent by opening the wizard directly instead of dropping the user on the list.
  const [starting, setStarting] = useState(Boolean(startNew));
  // Every initiative, whatever its delivery profile. Filtering to epic-planning meant an Epic
  // like an enterprise-delivery one appeared in no list anywhere: this page showed an empty state
  // and offered to start it, which the engine then refused because it already existed.
  const epics = data.initiatives;
  async function refreshEpics() {
    const result = await action(
      () => window.singularity.refreshInitiatives(data.repository.root),
      'Fetched the latest Epic branches'
    );
    if (result) await reload(null, null);
  }
  if (!epics.length || starting) return <div className="page epics-home"><header className="page-heading"><div><span className="eyebrow">Epic delivery workspace</span><h1>Turn requirements into ready-to-build Stories</h1><p>Bring an Epic from Jira or describe the work, ground it in source evidence, plan with Copilot, and publish governed Stories.</p></div>{epics.length > 0 && <button className="secondary" onClick={() => setStarting(false)}>← Back to Epics</button>}</header><EpicStartWizard data={data} action={action} reload={reload} generateWorldModel={generateWorldModel} openEpic={openEpic} onSetupJira={onSetupJira} /></div>;
  return <div className="page epics-home">
    <header className="page-heading epics-home-heading"><div><span className="eyebrow">Epic delivery workspace</span><h1>Your Epics</h1><p>One clear view of requirements, planning, Story publication, and downstream delivery readiness.</p></div><div className="row gap"><button className="secondary" onClick={refreshEpics}>↻ Fetch latest</button><button className="primary" onClick={() => setStarting(true)}>＋ Start Epic</button></div></header>
    <section className="epics-summary"><div><strong>{epics.length}</strong><span>Active Epics</span></div><div><strong>{epics.filter((item) => item.currentPhase === 'epic-publish').length}</strong><span>Ready for Stories</span></div><div><strong>{epics.filter((item) => item.status === 'complete').length}</strong><span>Completed</span></div></section>
    <section className="epic-card-grid">{epics.map((item) => {
      const waitingMs = item.waitingSince ? Date.now() - Date.parse(item.waitingSince) : null;
      return <button className="epic-home-card" key={item.id} onClick={() => openEpic(item.id)}>
        <header><span><code>{item.id}</code><Pill tone={item.idAuthority === 'jira' ? 'accent' : 'neutral'}>{item.idAuthority}</Pill>{item.profileLabel && <Pill tone="neutral">{item.profileLabel}</Pill>}</span><Pill tone={item.status === 'complete' ? 'good' : item.currentPhaseStatus === 'awaiting_approval' ? 'warn' : 'neutral'}>{epicStageLabel(item)}</Pill></header>
        <h2>{item.title}</h2>
        <p>{item.currentPhaseStatus === 'awaiting_approval' ? `Waiting for approval in ${item.currentPhaseLabel}` : `Currently in ${item.currentPhaseLabel ?? 'setup'}`}{Number.isFinite(waitingMs) ? ` · ${formatDuration(waitingMs)}` : ''}</p>
        <div className="epic-home-progress"><i><b style={{ width: `${item.percentage ?? 0}%` }} /></i><span>{item.percentage ?? 0}%</span></div>
        <footer><span>{item.phasesApproved ?? 0}/{item.phasesTotal ?? 0} stages approved</span><strong>Open Epic →</strong></footer>
      </button>;
    })}</section>
  </div>;
}

function EpicReviewView({ data, selected, action, reload }) {
  const [inbox, setInbox] = useState([]);
  const [review, setReview] = useState(null);
  const [loading, setLoading] = useState(true);
  const [persona, setPersona] = useState('');
  const [rejectTarget, setRejectTarget] = useState('');
  const [reason, setReason] = useState('');
  const initiativeId = selected.state.initiative.id;
  useEffect(() => {
    let active = true;
    setLoading(true);
    window.singularity.epicReviewInbox(data.repository.root, initiativeId)
      .then((items) => { if (active) setInbox(items); })
      .catch(() => { if (active) setInbox([]); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [data.repository.root, initiativeId]);
  async function open(item) {
    const result = await action(() => window.singularity.epicReview(data.repository.root, initiativeId, item.workId, item.packetSha256));
    if (result) {
      setReview(result);
      setPersona(result.approval.personas[0]?.id ?? '');
      setRejectTarget(result.approval.rejectTo[0] ?? result.approval.phase);
      setReason('');
    }
  }
  async function checks() {
    if (!review) return;
    const result = await action(
      () => window.singularity.runEpicChecks(data.repository.root, initiativeId, review.story.workId ?? review.story.id, review.packet.packetSha256),
      'Exact-SHA governance and GitHub Actions evidence recorded and published'
    );
    if (result) {
      await reload(null, initiativeId);
      setReview({ ...review, checks: result.checks.evidence });
    }
  }
  async function decide(decision) {
    if (!review || !persona) return;
    const result = await action(
      () => window.singularity.decideEpicReview(
        data.repository.root,
        initiativeId,
        review.story.workId ?? review.story.id,
        review.packet.packetSha256,
        decision,
        persona,
        decision === 'reject' ? rejectTarget : null,
        decision === 'reject' ? reason : null
      ),
      `${decision === 'approve' ? 'Approval' : 'Rejection'} bound to packet ${review.packet.packetSha256.slice(0, 12)} and published`
    );
    if (result) {
      setReview(null);
      setPersona('');
      setReason('');
      await reload(null, initiativeId);
      setInbox(await window.singularity.epicReviewInbox(data.repository.root, initiativeId));
    }
  }
  const checksReady = Boolean(review?.checks?.ready || review?.approval?.evidence?.ready);
  return <div className="epic-workspace-view review-inbox-workspace">
    <aside className="panel epic-review-list">
      <header><span className="eyebrow">Story review inbox · Cross-repository</span><h2>Submitted stories</h2><p>Review packets are discovered from published canonical and registered child branches.</p></header>
      {loading ? <div className="inline-empty">Refreshing published Story branches…</div> : inbox.length ? inbox.map((item) => <button className={review?.packet?.packetSha256 === item.packetSha256 ? 'active' : ''} key={item.packetSha256} onClick={() => open(item)}><span><strong>{item.workId}</strong><small>{item.repository} · {item.branch}</small></span><Pill tone="accent">Finalized</Pill><code>{item.finalizationSha256?.slice(0, 12) ?? item.packetSha256.slice(0, 12)}</code></button>) : <Empty title="No finalized stories" detail="Stories appear here after a developer completes every configured phase and runs sflow-finalize." />}
    </aside>
    <main className="panel epic-review-detail">
      {review ? <>
        <header className="panel-heading"><div><span className="eyebrow">Exact review packet</span><h2>{review.story.workId ?? review.story.id}</h2><p>{initiativeId} → {review.story.planId ?? review.story.id} → {review.story.jiraKey ?? 'Jira pending'} → {review.submittedBranch}</p></div><button className="primary" onClick={checks}>Run and record exact-SHA checks</button></header>
        <div className="review-packet-metrics"><div><span>Packet</span><code>{review.packet.packetSha256}</code></div><div><span>Source commit</span><code>{review.packet.sourceCommit}</code></div><div><span>Tree hash</span><code>{review.packet.sourceTreeSha256}</code></div><div><span>GitHub evidence</span><strong>{checksReady ? 'ready' : 'not recorded'}</strong></div></div>
        {review.approval.selfApprovalWarning && <div className="notice warn"><strong>Self-approval warning.</strong> Your Git identity matches this packet’s submitter or generator. The decision remains valid but is not independent review.</div>}
        <section className="epic-review-decision">
          <div><span className="eyebrow">Hash-bound decision</span><h3>Approve or return this exact packet</h3><p>Approval stays disabled until deterministic and required GitHub checks pass for the submitted source SHA.</p></div>
          <label><span>Approval persona</span><select value={persona} onChange={(event) => setPersona(event.target.value)}><option value="">Choose persona…</option>{review.approval.personas.map((entry) => <option value={entry.id} key={entry.id}>{entry.label}</option>)}</select></label>
          <label><span>Return to phase</span><select value={rejectTarget} onChange={(event) => setRejectTarget(event.target.value)}>{review.approval.rejectTo.map((phase) => <option value={phase} key={phase}>{phase}</option>)}</select></label>
          <label className="wide"><span>Rejection reason</span><input value={reason} onChange={(event) => setReason(event.target.value)} placeholder="Required only when returning the Story" /></label>
          <div className="epic-review-actions"><button className="secondary danger-text" disabled={!persona || !reason.trim()} onClick={() => decide('reject')}>Return with feedback</button><button className="primary" disabled={!persona || !checksReady} onClick={() => decide('approve')}>Approve exact packet</button></div>
        </section>
        <pre className="review-packet-document">{review.review.markdown}</pre>
      </> : <Empty title="Select a Story packet" detail="You’ll see complete documents, source lineage, Git diff, checks, approvals, tokens, and conformance evidence." />}
    </main>
  </div>;
}

const epicJourneySteps = ['Sources', 'Requirements', 'Planning', 'Stories', 'Complete'];

function EpicJourneyDiagram({ activeStep = 0 }) {
  return <div className="epic-start-flow" aria-label="Epic planning workflow">
    {epicJourneySteps.map((label, index) => <React.Fragment key={label}>
      <span className={index < activeStep ? 'complete' : index === activeStep ? 'active' : ''}>
        <i>{index < activeStep || index === epicJourneySteps.length - 1 ? '✓' : index + 1}</i>
        <small>{label}</small>
      </span>
      {index < epicJourneySteps.length - 1 && <b aria-hidden="true" />}
    </React.Fragment>)}
  </div>;
}

// `generateWorldModel` is the App-level runner: it drives the progress modal, checks Copilot health
// before spending minutes, and toasts failures. It has to be passed in — it is declared inside
// `App`, so a bare call from here is a ReferenceError inside a floating promise, which is exactly
// how "Generate world model" came to do nothing at all when clicked.
function EpicStartWizard({ data, action, reload, generateWorldModel, openEpic, onSetupJira = () => window.dispatchEvent(new Event('singularity:setup-jira')) }) {
  const initiativeProfiles = data.portfolio?.initiativeProfiles ?? {
    'epic-planning': { label: 'Epic planning' }
  };
  const personas = data.definition?.personas ?? {};
  const workspace = data.workspace?.workspace ?? null;
  const workspacePath = workspace?.path ?? null;
  const workspaceRepositories = Object.values(workspace?.repositories ?? {});
  const workspaceProjectKeys = [...new Set(workspaceRepositories.map((repository) => repository.jira?.board).filter(Boolean))];
  const leadProjectKey = workspace?.repositories?.[workspace.leadRepository]?.jira?.board ?? workspaceProjectKeys[0] ?? '';
  const jiraConfigured = Boolean(data.portfolio?.jira?.enabled || (workspacePath && workspaceProjectKeys.length));
  const [source, setSource] = useState(jiraConfigured ? 'jira' : 'local');
  const [status, setStatus] = useState(null);
  const [epicKey, setEpicKey] = useState('');
  const [selectedEpicKey, setSelectedEpicKey] = useState('');
  const [fetchedEpic, setFetchedEpic] = useState(null);
  const [availableEpics, setAvailableEpics] = useState([]);
  const [epicsLoading, setEpicsLoading] = useState(false);
  const [epicsError, setEpicsError] = useState('');
  const [epicListWarnings, setEpicListWarnings] = useState([]);
  const [localPreview, setLocalPreview] = useState(null);
  const [localTitle, setLocalTitle] = useState('');
  const [localDescription, setLocalDescription] = useState('');
  const [localGoal, setLocalGoal] = useState('');
  const [profile, setProfile] = useState(
    initiativeProfiles['epic-planning'] ? 'epic-planning' : Object.keys(initiativeProfiles)[0] ?? ''
  );
  const [persona, setPersona] = useState(
    preferredPersonaForRole(data.desktopProfile?.role, personas)
      ?? Object.keys(personas)[0]
      ?? ''
  );
  useEffect(() => {
    let active = true;
    if (!jiraConfigured) return undefined;
    const request = workspacePath
      ? window.singularity.workspaceJiraContext(data.repository.root, workspacePath)
      : window.singularity.jiraStatus(data.repository.root);
    request
      .then((result) => { if (active) setStatus(result); })
      .catch((error) => { if (active) setStatus({ error: error.message, credentials: { connected: false } }); });
    return () => { active = false; };
  }, [data.repository.root, data.portfolio?.jira?.enabled, workspacePath, jiraConfigured]);
  const connected = status?.credentials?.connected;
  const portfolioProjectKeys = status?.policy?.allowedProjects?.length
    ? status.policy.allowedProjects
    : [status?.policy?.projectKey ?? data.portfolio?.jira?.projectKey].filter(Boolean);
  const epicProjectKeys = workspacePath
    ? status?.routing?.projectKeys ?? workspaceProjectKeys
    : portfolioProjectKeys;
  const epicProjectKeySignature = epicProjectKeys.join(',');
  async function requestEpicList(refresh = false) {
    if (workspacePath) {
      return window.singularity.workspaceJiraEpics(data.repository.root, workspacePath, refresh);
    }
    const projects = await Promise.all(epicProjectKeys.map(async (projectKey) => {
      try {
        return {
          projectKey,
          epics: await window.singularity.jiraEpics(data.repository.root, projectKey, refresh)
        };
      } catch (error) {
        return { projectKey, error: error.message };
      }
    }));
    return {
      epics: projects.flatMap((project) => project.epics ?? []),
      warnings: projects.filter((project) => project.error).map((project) => ({
        projectKey: project.projectKey,
        repositoryIds: [],
        message: project.error
      }))
    };
  }
  function normalizeEpicList(result) {
    const epics = Array.isArray(result) ? result : result?.epics ?? [];
    const warnings = Array.isArray(result?.warnings) ? result.warnings : [];
    return {
      epics: [...new Map(epics.map((epic) => [epic.key, epic])).values()]
        .sort((left, right) => String(right.updatedAt ?? '').localeCompare(String(left.updatedAt ?? ''))
          || String(left.key).localeCompare(String(right.key))),
      warning: warnings.map((item) => {
        const repositories = item.repositoryIds?.length ? ` for ${item.repositoryIds.join(', ')}` : '';
        return `${item.projectKey}${repositories}: ${item.message}`;
      }).join(' '),
      warnings
    };
  }
  useEffect(() => {
    let active = true;
    if (source !== 'jira' || !connected) {
      setAvailableEpics([]);
      setEpicsError('');
      setEpicListWarnings([]);
      return undefined;
    }
    setEpicsLoading(true);
    setEpicsError('');
    requestEpicList()
      .then((result) => {
        if (!active) return;
        const normalized = normalizeEpicList(result);
        setAvailableEpics(normalized.epics);
        setEpicsError(normalized.warning);
        setEpicListWarnings(normalized.warnings);
      })
      .catch((error) => { if (active) { setEpicsError(error.message); setEpicListWarnings([]); } })
      .finally(() => { if (active) setEpicsLoading(false); });
    return () => { active = false; };
  }, [data.repository.root, source, connected, workspacePath, epicProjectKeySignature]);
  useEffect(() => {
    let active = true;
    if (source !== 'local') return undefined;
    if (!data.portfolio) {
      setLocalPreview({ id: 'Reserved when started' });
      return undefined;
    }
    window.singularity.previewLocalEpicId(data.repository.root)
      .then((result) => { if (active) setLocalPreview(result); })
      .catch((error) => { if (active) setLocalPreview({ error: error.message }); });
    return () => { active = false; };
  }, [data.repository.root, source]);
  async function loadEpics() {
    setEpicsLoading(true);
    setEpicsError('');
    try {
      const normalized = normalizeEpicList(await requestEpicList(true));
      setAvailableEpics(normalized.epics);
      setEpicsError(normalized.warning);
      setEpicListWarnings(normalized.warnings);
    } catch (error) {
      setEpicsError(error.message);
      setEpicListWarnings([]);
    } finally {
      setEpicsLoading(false);
    }
  }
  async function fetchEpic(reference = epicKey) {
    const key = String(reference).trim();
    setEpicKey(key);
    setFetchedEpic(null);
    const result = await action(() => workspacePath
      ? window.singularity.workspaceJiraEpic(data.repository.root, workspacePath, key)
      : window.singularity.jiraEpic(data.repository.root, key));
    if (result) {
      setEpicKey(result.key);
      setSelectedEpicKey(availableEpics.some((epic) => epic.key === result.key) ? result.key : '');
      setFetchedEpic(result);
    }
  }
  function projectFromEpicReference(reference) {
    let value = String(reference ?? '').trim();
    if (/^https:\/\//i.test(value)) {
      try {
        const url = new URL(value);
        value = url.pathname.match(/\/browse\/([^/?#]+)/i)?.[1]
          ?? url.searchParams.get('selectedIssue')
          ?? url.searchParams.get('issueKey')
          ?? '';
      } catch {
        return null;
      }
    }
    const match = value.trim().toUpperCase().match(/^([A-Z][A-Z0-9_]*)-\d+$/);
    return match?.[1] ?? null;
  }
  const referenceProjectKey = projectFromEpicReference(epicKey);
  const routingCorrection = workspacePath && referenceProjectKey
    ? epicListWarnings.find((warning) => warning.projectKey !== referenceProjectKey && warning.repositoryIds?.length)
    : null;
  async function correctJiraRouting() {
    if (!routingCorrection) return;
    const result = await action(
      () => window.singularity.correctWorkspaceJiraRoute(
        data.repository.root,
        workspacePath,
        routingCorrection.projectKey,
        epicKey
      ),
      `Workspace Jira routing corrected from ${routingCorrection.projectKey} to ${referenceProjectKey}`
    );
    if (result) await reload();
  }
  async function start() {
    if (!data.portfolio) {
      const initialized = await action(
        () => workspacePath
          ? window.singularity.bootstrapWorkspacePortfolio(data.repository.root, workspacePath)
          : window.singularity.bootstrapPortfolio(data.repository.root, { jira: { enabled: false } }),
        workspacePath
          ? 'Epic planning initialized from the selected workspace'
          : 'Epic planning initialized from the repository defaults'
      );
      if (!initialized) return;
      const published = await action(
        () => window.singularity.publish(data.repository.root, 'Initialize governed Epic planning'),
        'Epic planning configuration committed and pushed'
      );
      if (!published) return;
    }
    if (source === 'local') {
      const result = await action(
        () => window.singularity.startLocalEpic(data.repository.root, localTitle, localDescription, localGoal, profile, persona),
        'Local Epic ID reserved, initialized, committed, and pushed'
      );
      if (result) await reload(null, result.initiativeId);
      return;
    }
    const result = await action(
      () => window.singularity.startEpicWizard(data.repository.root, fetchedEpic.key, profile, persona),
      `Epic ${fetchedEpic.key} fetched from Jira, initialized, committed, and pushed`
    );
    if (!result) return;
    await reload(null, fetchedEpic.key);
  }
  const defaultBranch = data.definition.defaultBaseBranch ?? 'main';
  const localStartReady = data.repository.branch === defaultBranch && data.repository.changes.length === 0;
  // An Epic that already has a branch cannot be started again — the engine refuses it, and
  // rightly. What was missing was the other door: the wizard offered 'start' for work that only
  // needed opening, and then reported a CLI command this app has no way to run.
  const startedEpics = new Map((data.initiatives ?? []).map((item) => [item.id, item]));
  const alreadyStarted = source === 'jira' && fetchedEpic ? startedEpics.get(fetchedEpic.key) ?? null : null;
  const canStart = source === 'jira'
    ? connected && fetchedEpic?.key === epicKey && profile && persona && !alreadyStarted
    : localStartReady && localTitle.trim() && localDescription.trim() && localGoal.trim() && profile && persona && (!data.portfolio || !localPreview?.error);
  return <div className="epic-start-wizard">
    <section className="epic-start-intro">
      <div className="epic-start-intro-copy">
        <span className="ai-orb">S</span>
        <div><span className="eyebrow">Start a governed Epic</span><h2>Turn an Epic into delivery-ready Stories</h2><p>Bring the Epic from Jira or describe it directly; Singularity pins its identity, branch, and workflow before planning.</p></div>
      </div>
      <EpicJourneyDiagram />
    </section>
    <section className="panel epic-start-form">
      <div className="epic-origin-choice" role="group" aria-label="Epic identity source"><button className={`${source === 'jira' ? 'active' : ''} ${jiraConfigured ? '' : 'needs-setup'}`} onClick={() => jiraConfigured ? setSource('jira') : onSetupJira()}><strong>Bring from Jira</strong><small>{jiraConfigured ? `Fetch an Epic from ${workspaceProjectKeys.join(', ') || data.portfolio?.jira?.projectKey || 'the configured project'}` : 'Add Jira routing to the workspace first'}</small>{!jiraConfigured && <b>Set up Jira →</b>}</button><button className={source === 'local' ? 'active' : ''} onClick={() => setSource('local')}><strong>Describe the work</strong><small>Enter Epic-like details without Jira</small></button></div>
      {source === 'jira' ? <>
        <div className="epic-start-step"><b>1</b><div><span className="eyebrow">Workspace Jira connection</span><h3>Use the Jira routing already configured</h3><p>{connected ? `Connected as ${status.credentials.connection?.account?.displayName ?? status.credentials.connection?.email}. Allowed projects: ${status.routing?.projectKeys?.join(', ') || data.portfolio?.jira?.allowedProjects?.join(', ') || 'repository policy'}.` : 'This workspace has Jira project routing, but this operating-system user still needs a valid Jira connection.'}</p></div>{connected ? <Pill tone="good">ready</Pill> : <button className="secondary" onClick={onSetupJira}>Connect Jira</button>}</div>
        <div className="epic-start-step"><b>2</b><div><span className="eyebrow">Epic intake</span><h3>Select an Epic from Jira</h3><p>Choose from every Epic visible in the workspace’s configured Jira projects. Singularity fetches and pins the exact Jira snapshot before requirements are generated.</p><div className="epic-picker"><label><span>Jira Epic</span><select value={selectedEpicKey} disabled={!connected || epicsLoading} onChange={(event) => { setSelectedEpicKey(event.target.value); setEpicKey(event.target.value); setFetchedEpic(null); }}><option value="">{epicsLoading ? 'Loading Jira Epics…' : availableEpics.length ? 'Choose an Epic…' : 'No Epics found'}</option>{availableEpics.map((epic) => <option value={epic.key} key={epic.key}>{epic.key} — {epic.title} ({startedEpics.has(epic.key) ? 'already started' : epic.status ?? 'unknown'})</option>)}</select></label><button className="secondary" disabled={!connected || epicsLoading} onClick={loadEpics}>{epicsLoading ? 'Refreshing…' : 'Refresh list'}</button><button className="primary" disabled={!connected || !selectedEpicKey} onClick={() => fetchEpic(selectedEpicKey)}>Fetch selected Epic</button></div><div className="epic-picker-meta"><span>{availableEpics.length} Epic{availableEpics.length === 1 ? '' : 's'} visible across {epicProjectKeys.length} Jira project{epicProjectKeys.length === 1 ? '' : 's'}</span></div>{epicsError && <div className="notice warn epic-routing-warning"><div><strong>Some configured Jira projects could not be loaded.</strong><span>{epicsError} Valid projects are still listed above.</span></div>{routingCorrection ? <button className="secondary" onClick={correctJiraRouting}>Change {routingCorrection.repositoryIds.join(', ')} from {routingCorrection.projectKey} to {referenceProjectKey}</button> : <span>Correct the Jira project key under Workspace configuration → Edit workspace.</span>}</div>}<details className="epic-reference-fallback"><summary>Enter an Epic key, URL, or numeric Jira ID instead</summary><div className="epic-key-fetch"><label><span>Exact Jira reference</span><input value={epicKey} disabled={!connected} onChange={(event) => { setSelectedEpicKey(''); setEpicKey(event.target.value); setFetchedEpic(null); }} onKeyDown={(event) => { if (event.key === 'Enter' && epicKey.trim()) fetchEpic(); }} placeholder={`${leadProjectKey || data.portfolio?.jira?.projectKey || 'APP'}-123 or Jira URL`} /></label><button className="secondary" disabled={!connected || !epicKey.trim()} onClick={() => fetchEpic()}>Fetch Epic</button></div></details>{fetchedEpic && <article className="fetched-epic-card"><div><Pill tone={alreadyStarted ? 'accent' : 'good'}>{alreadyStarted ? 'Already started' : 'Fetched from Jira'}</Pill><code>{fetchedEpic.key}</code></div><h4>{fetchedEpic.title}</h4><p>{fetchedEpic.description || 'No Jira description was provided. Add supporting details and documents after starting.'}</p><small>{alreadyStarted ? `This Epic already has a branch — ${alreadyStarted.currentPhaseLabel ?? alreadyStarted.currentPhase ?? 'in progress'} on branch ${alreadyStarted.branch ?? alreadyStarted.id}. Open it to carry on; starting it again is refused.` : `${fetchedEpic.issueType} · ${fetchedEpic.status ?? 'unknown status'} · snapshot will be hash-recorded`}</small></article>}</div></div>
      </> : <div className="epic-start-step local-epic-fields"><b>1</b><div><span className="eyebrow">Business intent</span><h3>Describe the Epic</h3><div className="epic-local-id"><span>Next reserved ID</span><code>{localPreview?.id ?? 'Checking…'}</code></div><label><span>Epic title</span><input value={localTitle} onChange={(event) => setLocalTitle(event.target.value)} placeholder="Customer onboarding modernization" /></label><label><span>Problem or opportunity</span><textarea rows="3" value={localDescription} onChange={(event) => setLocalDescription(event.target.value)} placeholder="Describe why this work matters and the boundaries already known." /></label><label><span>Desired outcome</span><textarea rows="2" value={localGoal} onChange={(event) => setLocalGoal(event.target.value)} placeholder="Describe the measurable result." /></label>{localPreview?.error && <div className="notice warn">{localPreview.error}</div>}</div></div>}
      <div className="epic-start-step"><b>3</b><div><span className="eyebrow">Session choices</span><h3>Pin the workflow and choose your working persona</h3><div className="epic-start-controls"><label><span>Delivery workflow</span><select aria-label="Delivery workflow" value={profile} onChange={(event) => setProfile(event.target.value)}>{Object.entries(initiativeProfiles).map(([id, item]) => <option value={id} key={id}>{item.label}</option>)}</select><small>{initiativeProfiles[profile]?.description ?? 'Controls the governed phases and outputs for this Epic.'}</small></label><label><span>Working persona</span><select aria-label="Working persona" value={persona} onChange={(event) => setPersona(event.target.value)}>{Object.entries(personas).map(([id, item]) => <option value={id} key={id}>{item.label}</option>)}</select><small>{personas[persona]?.description ?? 'Adds a perspective to Copilot prompts for this session.'}</small></label></div><p className="epic-defaults-note">Manage these options under <strong>Configuration → Session choices</strong>. The workflow is pinned to the Epic; the persona applies to your current session.</p>{!data.portfolio && <p className="epic-defaults-note">The governed Epic defaults will be created when you start. No separate portfolio setup is required.</p>}</div></div>
      {source === 'local' && !localStartReady && <div className="notice warn epic-start-blocker"><strong>Local Epic creation starts from a clean {defaultBranch} branch.</strong><span>{data.repository.changes.length ? `Commit or set aside the ${data.repository.changes.length} current working-tree change(s), then switch to ${defaultBranch}.` : `Switch from ${data.repository.branch} to ${defaultBranch}, then refresh this workspace.`}</span></div>}
      <footer><div><strong>Next: source details → formatted requirements → Planning.</strong><span>The requirements specification and traceability file are committed to the Epic branch and become the approved inputs to Story planning.</span></div>{alreadyStarted ? <button className="primary" onClick={() => openEpic(alreadyStarted.id)}>Open {alreadyStarted.id}</button> : <button className="primary" disabled={!canStart} onClick={start}>{source === 'jira' ? 'Use Epic & start requirements' : 'Create requirements workspace'}</button>}</footer>
    </section>
  </div>;
}

function EditableEpicStory({ data, selected, story, action, reload, onSplit }) {
  const pairList = (value = {}) => Object.entries(value).map(([key, entryValue]) => ({ key, value: String(entryValue) }));
  const [draft, setDraft] = useState(() => ({
    title: story.title ?? '',
    description: story.description ?? '',
    repository: story.repository ?? '',
    suggestedWorkType: story.suggestedWorkType ?? 'feature',
    requirements: (story.requirements ?? []).join(', '),
    acceptanceCriteria: (story.acceptanceCriteria ?? []).join(', '),
    dependsOn: (story.dependsOn ?? []).map((item) => item.story ?? item).join(', '),
    specification: story.specification ?? '',
    blocking: story.blocking !== false,
    metadata: pairList(story.metadata),
    tasks: (story.tasks ?? []).map((task) => ({
      ...task,
      acceptanceCriteria: (task.acceptanceCriteria ?? []).join(', '),
      metadata: pairList(task.metadata)
    }))
  }));
  const planId = story.planId ?? story.id;
  const repositoryIds = Object.keys(selected.state.resolution?.repositories ?? data.portfolio?.repositories ?? {});
  const workTypes = Object.keys(data.definition?.workTypes ?? {});
  function field(key, value) { setDraft((current) => ({ ...current, [key]: value })); }
  function pairs(entries) {
    return Object.fromEntries(entries.map((entry) => [entry.key.trim(), entry.value.trim()]).filter(([key]) => key));
  }
  function metadataField(index, key, value) {
    field('metadata', draft.metadata.map((entry, entryIndex) => entryIndex === index ? { ...entry, [key]: value } : entry));
  }
  function taskField(index, key, value) {
    field('tasks', draft.tasks.map((task, taskIndex) => taskIndex === index ? { ...task, [key]: value } : task));
  }
  function taskMetadataField(taskIndex, metadataIndex, key, value) {
    field('tasks', draft.tasks.map((task, index) => index === taskIndex
      ? { ...task, metadata: task.metadata.map((entry, entryIndex) => entryIndex === metadataIndex ? { ...entry, [key]: value } : entry) }
      : task));
  }
  function addTask() {
    const id = `TASK-${String(draft.tasks.length + 1).padStart(3, '0')}`;
    field('tasks', [...draft.tasks, { id, title: '', description: '', acceptanceCriteria: '', metadata: [] }]);
  }
  async function save() {
    const split = (value) => value.split(',').map((item) => item.trim()).filter(Boolean);
    const result = await action(
      () => window.singularity.updateEpicStory(data.repository.root, selected.state.initiative.id, planId, {
        title: draft.title,
        description: draft.description,
        repository: draft.repository,
        suggestedWorkType: draft.suggestedWorkType,
        requirements: split(draft.requirements),
        acceptanceCriteria: split(draft.acceptanceCriteria),
        dependsOn: split(draft.dependsOn),
        specification: draft.specification,
        blocking: draft.blocking,
        metadata: pairs(draft.metadata),
        tasks: draft.tasks.map((task) => ({
          id: task.id,
          title: task.title,
          description: task.description ?? '',
          acceptanceCriteria: split(task.acceptanceCriteria ?? ''),
          metadata: pairs(task.metadata ?? []),
          jiraKey: task.jiraKey ?? null,
          jiraIssueId: task.jiraIssueId ?? null
        }))
      }),
      `${planId} saved; Planning approval invalidated until the combined package is reviewed again`
    );
    if (result) await reload(null, selected.state.initiative.id);
  }
  return <article className="editable-story-card">
    <div><span className="story-identity"><code>{planId}</code>{story.jiraKey && <small>{story.jiraKey}</small>}{story.parentMode === 'external' && <Pill tone="accent">Direct Jira Story</Pill>}</span><label className="story-blocking"><input type="checkbox" checked={draft.blocking} onChange={(event) => field('blocking', event.target.checked)} /> Blocks Epic completion</label></div>
    <label><span>Story title</span><input value={draft.title} onChange={(event) => field('title', event.target.value)} /></label>
    <label><span>Description</span><textarea rows="3" value={draft.description} onChange={(event) => field('description', event.target.value)} /></label>
    <div className="story-edit-grid">
      <label><span>Repository</span><select value={draft.repository} onChange={(event) => field('repository', event.target.value)}>{repositoryIds.map((id) => <option key={id} value={id}>{id}</option>)}</select></label>
      <label><span>Developer workflow</span><select value={draft.suggestedWorkType} onChange={(event) => field('suggestedWorkType', event.target.value)}>{workTypes.map((id) => <option key={id} value={id}>{data.definition.workTypes[id].label ?? id}</option>)}</select></label>
      <label><span>Requirements</span><input value={draft.requirements} onChange={(event) => field('requirements', event.target.value)} /></label>
      <label><span>Acceptance criteria</span><input value={draft.acceptanceCriteria} onChange={(event) => field('acceptanceCriteria', event.target.value)} /></label>
      <label><span>Depends on</span><input value={draft.dependsOn} onChange={(event) => field('dependsOn', event.target.value)} placeholder="STORY-002, STORY-003" /></label>
    </div>
    <details><summary>Story specification</summary><textarea rows="12" value={draft.specification} onChange={(event) => field('specification', event.target.value)} /></details>
    <details className="story-structured-editor"><summary>Jira metadata · {draft.metadata.length} fields</summary><div className="story-key-values">{draft.metadata.map((entry, index) => <div key={index}><input aria-label={`Story metadata key ${index + 1}`} value={entry.key} placeholder="component" onChange={(event) => metadataField(index, 'key', event.target.value)} /><input aria-label={`Story metadata value ${index + 1}`} value={entry.value} placeholder="checkout" onChange={(event) => metadataField(index, 'value', event.target.value)} /><button type="button" className="ghost compact" onClick={() => field('metadata', draft.metadata.filter((_, entryIndex) => entryIndex !== index))}>×</button></div>)}<button type="button" className="ghost compact" onClick={() => field('metadata', [...draft.metadata, { key: '', value: '' }])}>＋ Add key/value</button></div></details>
    <details className="story-structured-editor"><summary>Jira tasks · {draft.tasks.length}</summary><div className="story-task-list">{draft.tasks.map((task, taskIndex) => <section key={`${task.id}-${taskIndex}`} className="story-task-editor"><header><input aria-label={`Task ID ${taskIndex + 1}`} value={task.id} onChange={(event) => taskField(taskIndex, 'id', event.target.value)} /><button type="button" className="ghost compact" onClick={() => field('tasks', draft.tasks.filter((_, index) => index !== taskIndex))}>Remove</button></header><input aria-label={`Task title ${taskIndex + 1}`} value={task.title} placeholder="Task title" onChange={(event) => taskField(taskIndex, 'title', event.target.value)} /><textarea rows="2" aria-label={`Task description ${taskIndex + 1}`} value={task.description ?? ''} placeholder="Task details" onChange={(event) => taskField(taskIndex, 'description', event.target.value)} /><input aria-label={`Task acceptance criteria ${taskIndex + 1}`} value={task.acceptanceCriteria ?? ''} placeholder="AC-001, AC-002" onChange={(event) => taskField(taskIndex, 'acceptanceCriteria', event.target.value)} /><div className="story-key-values">{(task.metadata ?? []).map((entry, metadataIndex) => <div key={metadataIndex}><input value={entry.key} aria-label={`Task metadata key ${taskIndex + 1}.${metadataIndex + 1}`} placeholder="type" onChange={(event) => taskMetadataField(taskIndex, metadataIndex, 'key', event.target.value)} /><input value={entry.value} aria-label={`Task metadata value ${taskIndex + 1}.${metadataIndex + 1}`} placeholder="frontend" onChange={(event) => taskMetadataField(taskIndex, metadataIndex, 'value', event.target.value)} /><button type="button" className="ghost compact" onClick={() => taskField(taskIndex, 'metadata', task.metadata.filter((_, index) => index !== metadataIndex))}>×</button></div>)}<button type="button" className="ghost compact" onClick={() => taskField(taskIndex, 'metadata', [...(task.metadata ?? []), { key: '', value: '' }])}>＋ Task metadata</button></div></section>)}<button type="button" className="secondary compact" onClick={addTask}>＋ Create Jira task</button></div></details>
    <footer><span>Assignment stays in Jira. Saving reopens Planning review.</span><div className="row"><button className="ghost compact" onClick={() => onSplit(story)}>Split Story</button><button className="secondary" onClick={save}>Save Story</button></div></footer>
  </article>;
}

function EpicStoryPlanView({ data, selected, openPlanning, downloadFile, action, reload }) {
  const epics = selected.report?.children?.epics ?? [];
  const [modal, setModal] = useState(null);
  const repositoryIds = Object.keys(selected.state.resolution?.repositories ?? data.portfolio?.repositories ?? {});
  const jiraEnabled = selected.state.resolution?.jira?.enabled;
  const splitList = (value) => String(value ?? '').split(',').map((item) => item.trim()).filter(Boolean);
  function openSplit(story) {
    setModal({
      kind: 'split',
      source: story.planId ?? story.id,
      jiraKey: '',
      title: `${story.title} — split`,
      description: story.description ?? '',
      repository: story.repository ?? repositoryIds[0] ?? '',
      suggestedWorkType: story.suggestedWorkType ?? 'feature',
      requirements: (story.requirements ?? []).join(', '),
      acceptanceCriteria: (story.acceptanceCriteria ?? []).join(', '),
      specification: story.specification ?? ''
    });
  }
  function openAdopt() {
    setModal({
      kind: 'adopt',
      jiraKey: '',
      title: '',
      description: '',
      repository: repositoryIds[0] ?? '',
      suggestedWorkType: 'feature',
      requirements: '',
      acceptanceCriteria: '',
      specification: ''
    });
  }
  function modalField(key, value) { setModal((current) => ({ ...current, [key]: value })); }
  async function submitStoryModal() {
    const changes = {
      ...(modal.title.trim() ? { title: modal.title.trim() } : {}),
      ...(modal.description.trim() ? { description: modal.description.trim() } : {}),
      repository: modal.repository,
      suggestedWorkType: modal.suggestedWorkType,
      requirements: splitList(modal.requirements),
      acceptanceCriteria: splitList(modal.acceptanceCriteria),
      ...(modal.specification.trim() ? { specification: modal.specification.trim() } : {})
    };
    const result = modal.kind === 'split'
      ? await action(
        () => window.singularity.splitEpicStory(data.repository.root, selected.state.initiative.id, modal.source, changes),
        `${modal.source} split into a new governed Story; Planning returned to UI review`
      )
      : await action(
        () => window.singularity.adoptEpicStory(data.repository.root, selected.state.initiative.id, modal.jiraKey.trim().toUpperCase(), changes),
        `Existing Jira Story ${modal.jiraKey.trim().toUpperCase()} added without changing its current parent`
      );
    if (!result) return;
    setModal(null);
    await reload(null, selected.state.initiative.id);
  }
  const phaseStatus = selected.state.phases['epic-planning']?.status;
  return <div className="epic-workspace-view">
    <EpicArtifactView selected={selected} phases={['epic-planning']} title="Plan and review the generated Stories" detail="The /sflow-epic-story-draft skill decomposes approved REQ and AC identifiers into repository-owned Stories, writes the parent and per-Story specifications, and stops for review here." downloadFile={downloadFile} openPlanning={openPlanning} />
    {phaseStatus === 'awaiting_approval' && <section className="notice accent copilot-ui-stop" role="status"><strong>Copilot has finished the Story package and is waiting for this UI.</strong><span>Review, edit, split, or add existing Jira Stories here. Copilot must not create Jira issues until the complete package is approved below.</span></section>}
    <section className="panel planned-story-review">
      <header className="panel-heading"><div><span className="eyebrow">Planning output</span><h2>{selected.report.children.total} generated User Stories</h2><p>This editable list, parent specification, and per-Story specifications share one approval hash. Directly created Jira Stories can be adopted without rewriting their parent.</p></div><div className="row">{jiraEnabled && <button className="secondary compact" onClick={openAdopt}>＋ Add existing Jira Story</button>}<Pill tone={phaseStatus === 'approved' ? 'good' : 'warn'}>{phaseStatus ?? 'not started'}</Pill></div></header>
      {!epics.length ? <Empty title="No Stories generated yet" detail="Run /sflow-epic-story-draft in Copilot CLI, then refresh this page." /> : epics.map((epic) => <div className="planned-epic" key={epic.id}><header><span><small>Epic</small><code>{epic.jiraKey ?? epic.id}</code></span><h3>{epic.title}</h3><strong>{epic.stories.length} Stories</strong></header><div className="planned-story-grid">{epic.stories.map((story) => <EditableEpicStory key={story.id} data={data} selected={selected} story={story} action={action} reload={reload} onSplit={openSplit} />)}</div></div>)}
    </section>
    {modal && <DesignerModal title={modal.kind === 'split' ? `Split ${modal.source}` : 'Add an existing Jira Story'} detail={modal.kind === 'split' ? 'Create a separately governed Story and move or refine its requirement and acceptance-criteria allocation before approval.' : 'Use this when the real Jira Story exists outside the Epic relationship. Singularity records it as a direct lineage edge and never changes its current Jira parent.'} submitLabel={modal.kind === 'split' ? 'Create split Story' : 'Add to Epic plan'} submitDisabled={modal.kind === 'adopt' && !modal.jiraKey.trim()} onCancel={() => setModal(null)} onSubmit={submitStoryModal}><div className="modal-grid">{modal.kind === 'adopt' && <label><span>Exact Jira Story key</span><input autoFocus value={modal.jiraKey} placeholder="MOB-123" onChange={(event) => modalField('jiraKey', event.target.value)} /></label>}<label className={modal.kind === 'split' ? 'full' : ''}><span>Story title {modal.kind === 'adopt' && '(optional override)'}</span><input autoFocus={modal.kind === 'split'} value={modal.title} onChange={(event) => modalField('title', event.target.value)} /></label><label><span>Repository</span><select value={modal.repository} onChange={(event) => modalField('repository', event.target.value)}>{repositoryIds.map((id) => <option value={id} key={id}>{id}</option>)}</select></label><label><span>Developer workflow</span><select value={modal.suggestedWorkType} onChange={(event) => modalField('suggestedWorkType', event.target.value)}>{Object.entries(data.definition?.workTypes ?? {}).map(([id, item]) => <option value={id} key={id}>{item.label ?? id}</option>)}</select></label><label className="full"><span>Requirements</span><input value={modal.requirements} placeholder="REQ-001, REQ-002" onChange={(event) => modalField('requirements', event.target.value)} /></label><label className="full"><span>Acceptance criteria</span><input value={modal.acceptanceCriteria} placeholder="AC-001, AC-002" onChange={(event) => modalField('acceptanceCriteria', event.target.value)} /></label><label className="full"><span>Description</span><textarea rows="3" value={modal.description} onChange={(event) => modalField('description', event.target.value)} /></label><label className="full"><span>Story specification</span><textarea rows="8" value={modal.specification} onChange={(event) => modalField('specification', event.target.value)} /></label></div></DesignerModal>}
  </div>;
}

function EpicCompletionPanel({ data, selected, action, reload, synchronizeStories, reviewExternalStory }) {
  const [confirmation, setConfirmation] = useState('');
  const delivery = selected.delivery;
  const initiativeId = selected.state.initiative.id;
  async function complete() {
    const result = await action(
      () => window.singularity.completeEpicDelivery(data.repository.root, initiativeId, confirmation),
      `Epic ${initiativeId} marked complete against exact Story and conformance hashes`
    );
    if (result) {
      setConfirmation('');
      await reload(null, initiativeId);
    }
  }
  return <section className={`panel epic-completion-panel ${delivery?.status === 'complete' ? 'complete' : ''}`}>
    <header className="panel-heading"><div><span className="eyebrow">Final Product Owner gate</span><h2>Spec-to-code completion</h2><p>Every blocking Story—including directly adopted or externally parented Jira Stories—must be complete, conformant to the approved parent/Story specification, and backed by exact-SHA checks before the Epic can close.</p></div><Pill tone={delivery?.status === 'complete' ? 'good' : delivery?.ready ? 'accent' : 'warn'}>{delivery?.status === 'complete' ? 'Epic complete' : delivery?.ready ? 'Ready to complete' : `${delivery?.readyStories ?? 0}/${delivery?.requiredStories ?? 0} ready`}</Pill></header>
    <div className="epic-completion-stories">{delivery?.stories?.map((story) => <div key={story.planId} className={story.ready ? 'ready' : story.blocking ? 'blocked' : 'optional'}><StatusDot status={story.ready ? 'approved' : 'awaiting_approval'} /><span><strong>{story.workId}</strong><small>{story.repository} · {story.jiraKey ?? 'Jira pending'}{story.parentMode === 'external' ? ' · direct lineage' : ''}</small></span><code>{story.observedCommit?.slice(0, 12) ?? 'not synchronized'}</code><Pill tone={story.ready ? 'good' : 'warn'}>{story.ready ? 'matched' : story.problems[0] ?? 'deferred'}</Pill></div>)}</div>
    {delivery?.status === 'complete' ? <div className="epic-completion-result"><strong>Completion decision {delivery.completion?.sha256?.slice(0, 12)}</strong><span>The committed report is immutable and remains bound to the listed Story commits, packets, checks, and conformance trees.</span></div> : <footer><button className="ghost" onClick={reviewExternalStory}>＋ Add external Jira Story</button><button className="secondary" onClick={synchronizeStories}>↻ Synchronize Story branches</button><label><span>Exact Epic confirmation</span><input value={confirmation} onChange={(event) => setConfirmation(event.target.value.toUpperCase())} placeholder={`Type ${initiativeId}`} /></label><button className="primary" disabled={!delivery?.ready || confirmation !== initiativeId} onClick={complete}>Mark Epic complete</button></footer>}
  </section>;
}

// Planning is deliberately a separate phase page. The Story list, parent specification, and
// per-Story specifications are generated and reviewed as one exact-hash package.
function EpicPlanningPage({ data, action, reload, openPlanningPrompt, downloadFile, profileRole = null, copilotHealth = null, onCopilotRetry = null }) {
  const initiative = data.initiative;
  if (!initiative) return <div className="page"><Empty title="Select an Epic first" detail="Choose an Epic from the top bar or open one from the Epics page before planning its Stories." /></div>;
  const phase = initiative.state.phases['epic-planning'];
  const current = initiative.state.currentPhase === 'epic-planning' && phase?.status === 'in_progress';
  const approved = phase?.status === 'approved';
  return <div className="epic-phase-page">
    <header className="page-heading planning-heading"><div><span className="eyebrow">Epic planning · phase 3 of 4</span><h1>Turn approved requirements into Stories</h1><p>{initiative.state.initiative.title} · Planning produces one editable Story plan, a parent solution contract, and a specification for every Story before Jira and Git publication.</p></div><div className="row"><Pill tone={current ? 'accent' : approved ? 'good' : 'warn'}>{approved ? 'Planning approved' : current ? 'Planning active' : `Waiting for ${initiative.state.currentPhase ?? 'requirements'}`}</Pill></div></header>
    {!current && !approved && <section className="phase-lock notice" role="status"><strong>Planning is locked until Requirements is approved.</strong><p>The approved requirements artifact is the only planning input. Return to Requirements, finish its phase gate, then come back here.</p></section>}
    <PlanningStudio onCopilotRetry={onCopilotRetry} data={data} action={action} reload={reload} openPlanningPrompt={openPlanningPrompt} profileRole={profileRole} focus={{ phase: 'epic-planning', target: PHASE_SCOPE }} />
    <EpicStoryPlanView data={data} selected={initiative} openPlanning={null} downloadFile={downloadFile} action={action} reload={reload} />
    <PhaseGovernance data={data} selected={initiative} phaseId="epic-planning" action={action} reload={reload} />
  </div>;
}

function EpicPlanningCliPage({ data, action, reload, downloadFile }) {
  const initiative = data.initiative;
  if (!initiative) return <div className="page"><Empty title="Select an Epic first" detail="Choose an Epic before planning its Stories." /></div>;
  const phase = initiative.state.phases['epic-planning'];
  const current = initiative.state.currentPhase === 'epic-planning' && phase?.status === 'in_progress';
  const approved = phase?.status === 'approved';
  return <div className="page epic-phase-page">
    <header className="page-heading row-between"><div><span className="eyebrow">Epic planning · phase 3 of 4</span><h1>Turn approved requirements into Stories</h1><p>{initiative.state.initiative.title} · Copilot CLI generates one editable Story plan, a parent solution contract, and a specification for every Story.</p></div><Pill tone={approved ? 'good' : current ? 'accent' : 'warn'}>{approved ? 'Planning approved' : current ? 'Planning active' : `Waiting for ${initiative.state.currentPhase ?? 'requirements'}`}</Pill></header>
    {!current && !approved && <section className="phase-lock notice" role="status"><strong>Planning is locked until Requirements is approved.</strong><p>The `/sflow-epic-story-draft` skill enforces the same sequence and will stop without changing state.</p></section>}
    <CopilotCliHandoff data={data} phaseId="epic-planning" title="Generate the Story package in Copilot CLI" />
    <EpicStoryPlanView data={data} selected={initiative} openPlanning={null} downloadFile={downloadFile} action={action} reload={reload} />
    <PhaseGovernance data={data} selected={initiative} phaseId="epic-planning" action={action} reload={reload} />
  </div>;
}

function CopilotCliPage({ data, phaseId = null }) {
  const resolvedPhase = phaseId
    ?? data.initiative?.state?.currentPhase
    ?? data.workflow?.currentPhase
    ?? null;
  return <div className="page">
    <header className="page-heading"><div><span className="eyebrow">Terminal handoff</span><h1>Use Singularity Flow in Copilot CLI</h1><p>The Electron app no longer starts a Copilot backend or carries a planning conversation. It remains focused on configuration, documents, progress, review, and approval.</p></div></header>
    <CopilotCliHandoff data={data} phaseId={resolvedPhase} />
  </div>;
}

// Editing portfolio.yml here always wrote to the checked-out branch and the topbar always
// committed it, but nothing on this tab said either thing. Someone editing their Epic's
// configuration could not tell whether the change was saved, which branch it would land on, or
// that a separate control across the window was the one that would commit it. This panel puts the
// branch, the pending files, and the commit in the place the edit happens.
function ConfigurationPublish({ data, initiativeId, dirty, busy, publishConfiguration }) {
  const changes = data.repository.configurationChanges ?? [];
  const blocked = data.repository.unrelatedChanges ?? [];
  const branchName = data.repository.branch ?? 'the current branch';
  const [message, setMessage] = useState('');
  const [publishing, setPublishing] = useState(false);
  const subject = message.trim() || `Update ${data.portfolioPath.split('/').at(-1)}${initiativeId ? ` for ${initiativeId}` : ''}`;
  const ready = changes.length > 0 && blocked.length === 0 && !dirty;

  async function commitAndPush() {
    setPublishing(true);
    try { await publishConfiguration(subject); setMessage(''); } finally { setPublishing(false); }
  }

  return <section className="panel configuration-publish">
    <header className="panel-heading"><div><span className="eyebrow">Working tree</span><h2>Commit to <code>{branchName}</code></h2><p>Saving writes the file; this commits it and pushes it to this Epic's branch. Nothing is merged anywhere else.</p></div><Pill tone={dirty ? 'warn' : changes.length ? 'accent' : 'good'}>{dirty ? 'Unsaved edits' : changes.length ? `${changes.length} to commit` : 'Nothing pending'}</Pill></header>
    {dirty && <p className="configuration-publish-note warn">Save the editor first — unsaved edits are not part of a commit.</p>}
    {changes.length > 0 && <ul className="configuration-publish-files">{changes.map((file) => <li key={file}><code>{file}</code></li>)}</ul>}
    {!changes.length && !dirty && <p className="configuration-publish-note">No configuration changes are waiting. Edit the file below and save to stage one.</p>}
    {blocked.length > 0 && <p className="configuration-publish-note warn">Blocked by {blocked.length} unrelated working-tree change{blocked.length === 1 ? '' : 's'}: {blocked.map((file, index) => <React.Fragment key={file}>{index > 0 && ', '}<code>{file}</code></React.Fragment>)}. Commit or discard them first.</p>}
    <footer>
      <label className="configuration-publish-message"><span>Commit message</span><input value={message} placeholder={subject} onChange={(event) => setMessage(event.target.value)} /></label>
      <button className="primary" disabled={!ready || busy || publishing} onClick={() => commitAndPush()}>{publishing ? 'Publishing…' : `Commit & push to ${branchName}`}</button>
    </footer>
    {/* An Epic resolves its phases once, at start; a later portfolio edit does not retroactively
        change a running Epic, and saying so here avoids the "I changed it and nothing happened"
        report this panel would otherwise invite. */}
    {initiativeId && <p className="configuration-publish-note">Phases already resolved for {initiativeId} stay pinned. Use the document chooser on a phase, or ↺ Start again, to adopt what you change here.</p>}
  </section>;
}

function InitiativeStudio({ data, editor, setEditor, saveEditor, downloadFile, action, reload, bootstrapPortfolio, openPlanning, setupJira, generateWorldModel, openEpic, localRole, jiraAccount, publishConfiguration = null, busy = false, entryTab = null, onAllEpics = null, reportProblem = null, onStagePage = null }) {
  // Epic overview is a read-mostly lifecycle dashboard. Phase authoring lives on the dedicated
  // Requirements and Planning pages; opening an Epic must not silently drop the user into Intake.
  const [tab, setTab] = useState('overview');
  const [materializationModal, setMaterializationModal] = useState(null);
  const { openArtifact, artifactViewer } = useArtifactViewer({ repository: data.repository.root, downloadFile });
  // Starting again keeps the branch, the identity, the pinned sources and the world model; only
  // this attempt's artifacts go. The typed ID is the same bar the CLI sets, for the same reason.
  const [restartModal, setRestartModal] = useState(null);
  async function restartEpic() {
    if (restartModal.confirmation.trim() !== selected.state.initiative.id) return;
    const result = await action(
      () => window.singularity.restartInitiative(data.repository.root, selected.state.initiative.id, restartModal.confirmation.trim(), restartModal.reason.trim() || null),
      `${selected.state.initiative.id} restarted at its first phase`
    );
    if (!result) return;
    setRestartModal(null);
    await reload(undefined, selected.state.initiative.id);
  }
  const [repositoryModal, setRepositoryModal] = useState(null);
  const [jiraArtifacts, setJiraArtifacts] = useState({});
  const [artifactDestination, setArtifactDestination] = useState('epic');
  const portfolio = data.portfolio;
  const selected = data.initiative;
  useEffect(() => {
    const defaults = {};
    for (const document of selected?.documents ?? []) {
      if (['requirements-specification', 'requirements-traceability', 'parent-specification', 'story-specification-index'].includes(document.id) && document.sha256) {
        defaults[`${document.phase}/${document.id}`] = true;
      }
    }
    setJiraArtifacts(defaults);
  }, [selected?.state.initiative.id, selected?.state.history.length]);
  useEffect(() => {
    if (entryTab) {
      setTab(entryTab);
      return;
    }
    // Selecting or reopening an Epic always lands on the cross-phase summary. The journey rail
    // remains the explicit route to Sources, Requirements, Planning, Stories, and Completion.
    if (selected) setTab('overview');
  }, [entryTab, selected?.state.initiative.id, selected?.state.currentPhase, selected?.state.status]);
  if (!portfolio) return <div className="page initiative-page"><EpicStartWizard data={data} action={action} reload={reload} generateWorldModel={generateWorldModel} openEpic={openEpic} onSetupJira={setupJira} /></div>;
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
  const businessStage = entryTab && selected?.state.initiative.profile === 'epic-planning'
    ? {
        requirements: {
          step: 'Business requirements',
          title: 'Turn pinned Epic sources into approved requirements',
          detail: 'Generate and review REQ-nnn and AC-nnn records here. Every item stays linked to its source before Planning can use it.',
          activeStep: 1,
          prerequisite: state.phases['epic-intake']?.status === 'approved',
          prerequisiteLabel: 'Approve Epic intake first'
        },
        planning: {
          step: 'Business planning',
          title: 'Decompose requirements into governed User Stories',
          detail: 'The /sflow-epic-story-draft skill allocates requirements and acceptance criteria to repository-owned Stories, produces the high-level specification, then waits for UI approval.',
          activeStep: 2,
          prerequisite: state.phases['epic-requirements']?.status === 'approved',
          prerequisiteLabel: 'Approve requirements first'
        },
        publish: {
          step: 'Jira and Git handoff',
          title: 'Publish the reviewed Story plan',
          detail: 'Review every generated Story and selected artifact, then create or attach the Jira issue and canonical Git branch using the returned Jira key.',
          activeStep: 3,
          prerequisite: state.phases['epic-planning']?.status === 'approved',
          prerequisiteLabel: 'Approve the combined Story and specification package first'
        }
      }[entryTab]
    : null;
  const jiraArtifactCandidates = selected?.documents.filter((document) =>
    ['epic-requirements', 'epic-planning'].includes(document.phase) && document.sha256
  ) ?? [];
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
    if (!result) return;
    let writePlan = null;
    if (state.initiative.profile === 'epic-planning' && state.lineage?.idAuthority === 'jira' && data.portfolio.jira?.enabled) {
      const targets = artifactDestination === 'both' ? ['epic', 'stories'] : [artifactDestination];
      const artifacts = jiraArtifactCandidates
        .filter((document) => jiraArtifacts[`${document.phase}/${document.id}`])
        .map((document) => ({ phase: document.phase, id: document.id, targets }));
      writePlan = await action(() => window.singularity.createJiraWritePlan(data.repository.root, state.initiative.id, artifacts), 'Exact Jira Story and artifact write plan generated and published');
      if (!writePlan) return;
    }
    setMaterializationModal({ preview: result.review, writePlan: writePlan?.plan ?? null, confirmation: '' });
  }
  async function materializeStories() {
    const initiativeId = state.initiative.id;
    if (materializationModal.confirmation !== initiativeId) return;
    if (materializationModal.writePlan) {
      const applied = await action(
        () => window.singularity.applyJiraWritePlan(data.repository.root, initiativeId, materializationModal.writePlan.sha256, materializationModal.confirmation),
        'Reviewed Jira Story plan applied with append-only receipts'
      );
      if (!applied) return;
    }
    const result = await action(
      () => window.singularity.materializeInitiative(data.repository.root, initiativeId, materializationModal.confirmation),
      `Published ${materializationModal.preview.stories.length} governed Stories and branches; Epic planning is complete and developer delivery tracking is open`
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
  function selectJourneyStage(stage) {
    // Requirements, Planning and Stories each have a full workspace page. Routing them to a tab
    // here opened a second, older Requirements screen for the same phase, so which UI you got
    // depended on whether you arrived from the rail or the sidebar.
    if (onStagePage && ['requirements', 'planning', 'stories'].includes(stage)) return void onStagePage(stage);
    // Only Epic planning has business stages that map to tabs here. Every other profile names its
    // stages after its own phases, and each of those opens the phase workspace — without this the
    // rail set a tab that does not exist and the click did nothing at all.
    if (stage !== 'complete' && selected?.state.phaseOrder?.includes(stage)) return void openPlanning?.(stage);
    setTab({ intake: 'intake', complete: 'complete' }[stage] ?? 'intake');
  }
  function focusJourneyPhase(phaseId, actionId = null) {
    const epicStage = {
      'epic-intake': 'intake',
      'epic-requirements': 'requirements',
      'epic-planning': 'planning',
      'epic-publish': 'stories'
    }[phaseId];
    if (!epicStage && selected?.state.phaseOrder?.includes(phaseId)) {
      openPlanning?.(phaseId);
      revealPhaseAction(actionId);
      return;
    }
    const stage = epicStage ?? selected?.journey?.stage ?? 'intake';
    if (onStagePage && ['requirements', 'planning', 'stories'].includes(stage)) {
      onStagePage(stage);
      revealPhaseAction(actionId);
      return;
    }
    setTab(stage === 'stories' ? 'publish' : stage);
    if ([NEXT_ACTIONS.APPROVE, NEXT_ACTIONS.EVIDENCE, NEXT_ACTIONS.PUBLISH].includes(actionId)) {
      revealPhaseAction(actionId);
    } else {
      window.setTimeout(() => document.querySelector('.epic-artifact-hero')?.scrollIntoView({ behavior: 'smooth', block: 'center' }), 0);
    }
  }
  function continueJourney(next) {
    const actionId = normalizeNextActionId(next?.action ?? next?.id);
    if (actionId === NEXT_ACTIONS.MATERIALIZE) return void previewMaterialization();
    if (actionId === NEXT_ACTIONS.REPORT) return setTab('complete');
    if ([NEXT_ACTIONS.AUTHOR, NEXT_ACTIONS.PUBLISH, NEXT_ACTIONS.APPROVE, NEXT_ACTIONS.EVIDENCE].includes(actionId)) {
      return void focusJourneyPhase(next?.phaseId ?? selected?.state.currentPhase ?? 'epic-intake', actionId);
    }
    if (actionId === NEXT_ACTIONS.ADVANCE || actionId === NEXT_ACTIONS.STATUS || actionId === NEXT_ACTIONS.SOURCES) {
      return selectJourneyStage(selected?.journey?.stage ?? 'intake');
    }
    // Navigating to the stage already open is indistinguishable from a dead button, which is what
    // hid this defect on the other rail. Say so instead.
    reportProblem?.(`No action is wired for '${next?.sourceId ?? next?.id ?? 'unknown'}'. Nothing was changed — please report this.`);
  }
  function openOverviewStage(stage) {
    if (onStagePage) return onStagePage(stage);
    if (stage === 'stories') return setTab('publish');
    const phaseId = {
      requirements: 'epic-requirements',
      planning: 'epic-planning'
    }[stage];
    if (phaseId) return openPlanning?.(phaseId);
  }
  const epicWorkspaceTitle = {
    overview: 'Epic overview',
    intake: 'Epic sources',
    publish: 'Create Stories',
    complete: 'Delivery overview',
    configuration: 'Epic configuration'
  }[tab] ?? 'Epic workspace';
  return <div className="page initiative-page">
    <header className="page-heading initiative-heading"><div><span className="eyebrow">Cross-repository control plane · Epic planning and delivery lineage</span><h1>{selected?.state.initiative.profile === 'epic-planning' ? epicWorkspaceTitle : 'Initiative orchestration'}</h1><p>Move from pinned sources to approved requirements, Jira Stories, canonical branches, review packets, and Epic progress.</p>{onAllEpics && <div className="row gap epic-workspace-exits">
      {/* Selecting an Epic replaces the Epic list with this workspace, so without these the list
          and the start wizard are only reachable by blanking the top-bar Epic selector. */}
      <button className="ghost compact" onClick={() => onAllEpics()}>← All Epics</button>
      {selected && <button className="ghost compact" onClick={() => setRestartModal({ confirmation: '', reason: '' })} title="Return this Epic to its first phase on the same branch">↺ Start again</button>}
      <button className="secondary compact" onClick={() => onAllEpics('new')}>＋ New Epic</button>
      <button className={`ghost compact ${tab === 'configuration' ? 'active' : ''}`} onClick={() => setTab(tab === 'configuration' ? 'overview' : 'configuration')}>⚙ Configuration</button>
    </div>}</div><div className="epic-identity-strip" title="These identities are recorded separately and are not claimed to be cryptographically equivalent"><span><b>Local role</b>{localRole ?? data.desktopProfile?.role ?? 'not set'}</span><span><b>Jira account</b>{jiraAccount ?? data.jiraSession?.connection?.email ?? data.jiraSession?.connection?.account?.emailAddress ?? 'not connected'}</span><span><b>Git identity</b>{data.identities?.git?.email ?? 'not configured'}</span><span><b>GitHub login</b>{data.identities?.github ?? 'not signed in'}</span></div></header>
    {selected?.journey && <EpicJourneyRail journey={selected.journey} onSelect={selectJourneyStage} onNext={continueJourney} />}
    {businessStage && <section className={`business-stage-intro ${businessStage.prerequisite ? 'ready' : 'waiting'}`}>
      <div className="business-stage-copy"><span className="eyebrow">{businessStage.step}</span><h2>{businessStage.title}</h2><p>{businessStage.detail}</p></div>
      <EpicJourneyDiagram activeStep={businessStage.activeStep} />
      <Pill tone={businessStage.prerequisite ? 'good' : 'warn'}>{businessStage.prerequisite ? 'Ready to work' : businessStage.prerequisiteLabel}</Pill>
      {entryTab === 'publish' && <div className="business-lineage-handoff"><span><b>1</b>Approved Story plan</span><i>→</i><span><b>2</b>Jira Story key</span><i>→</i><span><b>3</b>Canonical Git branch</span><i>→</i><span><b>4</b>Governed seed & receipts</span></div>}
    </section>}
    {selected?.state.initiative.profile !== 'epic-planning' && <nav className="epic-workspace-nav" aria-label="Initiative workspace">{[['delivery', 'Overview'], ['requirements', 'Documents'], ['configuration', 'Configuration']].map(([id, label]) => <button key={id} className={tab === id ? 'active' : ''} onClick={() => setTab(id)}>{label}</button>)}</nav>}
    {['delivery', 'publish'].includes(tab) && selected && <div className="branch-baseline-note"><span>⑂</span><div><strong>Branches stay isolated</strong><p><code>{leadBaseBranch}</code> supplies the starting source and configuration baseline. Epic and Story branches receive their own commits; Singularity never merges them into a default branch automatically. Accepted canonical Story results alone advance Epic progress.</p></div></div>}
    {tab === 'configuration' ? <div className="initiative-config-layout">
      <aside className="initiative-config-summary">
        <section className="panel"><header className="panel-heading"><div><span className="eyebrow">Profiles</span><h2>{profiles.length} delivery models</h2></div></header><div className="initiative-mini-list">{profiles.map(([id, profile]) => <div key={id}><strong>{profile.label}</strong><span>{profile.phases.length} phases</span><small>{profile.phases.join(' → ')}</small></div>)}</div></section>
        <section className="panel"><header className="panel-heading"><div><span className="eyebrow">Repository registry</span><h2>{repositories.length} repositories</h2></div><button className="primary compact" onClick={openRepositoryModal}>＋ Add repository</button></header><div className="initiative-mini-list repository-registry-list">{repositories.length ? repositories.map(([id, repository]) => <div key={id}><strong>{repository.metadata?.name ?? id}</strong><span>{repository.metadata?.appId ?? (repository.required ? 'Required' : 'Optional')}</span><small>{id} · {repository.defaultBranch} · {repository.url}</small>{Object.entries(repository.metadata ?? {}).filter(([key]) => !['appId', 'name'].includes(key)).length > 0 && <em>{Object.entries(repository.metadata).filter(([key]) => !['appId', 'name'].includes(key)).map(([key, value]) => `${key}: ${value}`).join(' · ')}</em>}</div>) : <div><strong>No repositories yet</strong><small>Add a repository with application identity and organization metadata.</small></div>}</div></section>
        <section className="panel"><header className="panel-heading"><div><span className="eyebrow">Issue materialization</span><h2>Jira {portfolio.jira?.enabled ? portfolio.jira.writeMode : 'off'}</h2></div><Pill tone={portfolio.jira?.writeMode === 'approved' ? 'good' : 'neutral'}>{portfolio.jira?.projectKey || 'Git only'}</Pill></header><div className="initiative-mini-list"><div><strong>Epic → Story hierarchy</strong><span>{portfolio.jira?.writeMode === 'approved' ? 'Guarded apply' : portfolio.jira?.writeMode === 'preview' ? 'Plan only' : 'Git only'}</span><small>{portfolio.jira?.writeMode === 'approved' ? `${portfolio.jira.epicIssueType ?? 'Epic'} / ${portfolio.jira.storyIssueType ?? 'Story'} · exact approved write plan required` : portfolio.jira?.writeMode === 'preview' ? 'Create and commit Jira write plans without mutating Jira.' : 'Enable Jira policy and choose a write mode in portfolio.yml; no network is used while off.'}</small></div></div></section>
        <section className="panel"><header className="panel-heading"><div><span className="eyebrow">Approval authorities</span><h2>{authorities.length} groups</h2></div></header><div className="initiative-mini-list">{authorities.map(([id, authority]) => <div key={id}><strong>{id}</strong><span>{authority.members.length} identities</span><small>{authority.members.map((member) => member.email).join(', ') || 'Configure members before starting.'}</small></div>)}</div></section>
      </aside>
      <div className="initiative-config-editor">
        {publishConfiguration && <ConfigurationPublish data={data} initiativeId={selected?.state.initiative.id ?? null} dirty={configValue !== configOriginal} busy={busy} publishConfiguration={publishConfiguration} />}
        <SourceEditor path={data.portfolioPath} value={configValue} dirty={configValue !== configOriginal} onChange={(content) => setEditor({ path: data.portfolioPath, content, original: configOriginal, kind: 'portfolio' })} onSave={saveEditor} onDownload={() => downloadFile(data.portfolioPath)} language="yaml" height="100%" />
      </div>
    </div> : !selected ? <EpicStartWizard data={data} action={action} reload={reload} generateWorldModel={generateWorldModel} openEpic={openEpic} onSetupJira={setupJira} /> : tab === 'intake' ? <div className="epic-workspace-view"><ImportedEpicView selected={selected} /><EpicSourcesView data={data} selected={selected} action={action} reload={reload} /><EpicArtifactView selected={selected} phases={['epic-intake']} title="Optional intake notes" detail="The pinned Jira Epic or local Epic description is sufficient to continue. Add files or text only when they improve the requirements context; repository grounding begins after Story intake." downloadFile={downloadFile} openPlanning={openPlanning} /></div> : tab === 'planning' ? <div className="epic-workspace-view"><EpicStoryPlanView data={data} selected={selected} openPlanning={openPlanning} downloadFile={downloadFile} action={action} reload={reload} /><EpicArtifactView selected={selected} phases={['epic-planning']} title="Parent and Story specifications" detail="Review the parent solution contract and every Story-specific specification together with the editable Story list. One exact bundle approval covers the complete handoff." downloadFile={downloadFile} openPlanning={openPlanning} /><PhaseGovernance data={data} selected={selected} phaseId="epic-planning" action={action} reload={reload} /></div> : tab === 'publish' ? <div className="epic-workspace-view">
      <section className="panel jira-artifact-publish">
        <header className="panel-heading"><div><span className="eyebrow">Reviewed outbound package</span><h2>Select what Jira receives</h2><p>The exact file hashes become part of the Jira write plan. Selected Markdown/YAML files are attached with hash-stamped filenames; retries reuse matching attachments.</p></div><Pill tone={state.phases['epic-planning']?.status === 'approved' ? 'good' : 'warn'}>{state.phases['epic-planning']?.status === 'approved' ? 'Planning package approved' : 'Approve Planning first'}</Pill></header>
        <div className="jira-artifact-options">{jiraArtifactCandidates.map((document) => { const reference = `${document.phase}/${document.id}`; return <label key={reference} className={jiraArtifacts[reference] ? 'selected' : ''}><input type="checkbox" checked={Boolean(jiraArtifacts[reference])} onChange={(event) => setJiraArtifacts((current) => ({ ...current, [reference]: event.target.checked }))} /><span><strong>{document.label}</strong><small>{reference} · {document.sha256.slice(0, 12)}</small></span><Pill tone={document.status === 'approved' ? 'good' : 'neutral'}>{document.status}</Pill></label>; })}</div>
        <footer>{state.lineage?.idAuthority === 'jira' && <label><span>Attach selected documents to</span><select value={artifactDestination} onChange={(event) => setArtifactDestination(event.target.value)}><option value="epic">Epic only · recommended</option><option value="stories">Every generated Story</option><option value="both">Epic and every Story</option></select></label>}<button className="primary" onClick={previewMaterialization} disabled={selected.materialization.phaseStatus !== 'approved'}>Review {state.lineage?.idAuthority === 'jira' ? 'Jira & Git' : 'Git'} publication</button></footer>
      </section>
      <EpicArtifactView selected={selected} phases={['epic-publish']} title="Publication records" detail="After Jira and Git materialization, generate the final write-plan and receipt report, then complete the planning governance gate." downloadFile={downloadFile} openPlanning={openPlanning} />
      <PhaseGovernance data={data} selected={selected} phaseId="epic-publish" action={action} reload={reload} />
    </div> : tab === 'complete' ? <div className="epic-workspace-view"><section className="panel epic-delivery-summary"><header className="panel-heading"><div><span className="eyebrow">Read-only downstream view</span><h2>Story delivery progress</h2><p>Developers continue in their own tools. Singularity aggregates the canonical Story branches and returns review packets here.</p></div><button className="secondary" onClick={synchronizeStories}>↻ Synchronize Story branches</button></header></section><EpicReviewView data={data} selected={selected} action={action} reload={reload} /><EpicCompletionPanel data={data} selected={selected} action={action} reload={reload} synchronizeStories={synchronizeStories} reviewExternalStory={() => setTab('planning')} /></div> : <>
      {state.initiative.profile === 'epic-planning' && <section className="epic-overview-purpose">
        <div><span className="eyebrow">Cross-phase summary · no phase authoring</span><h2>Epic overview</h2><p>Monitor the complete Epic, its governed documents, approvals, Story delivery, time, tokens, and cost. Open a phase workspace when you need to create or approve phase-specific content.</p></div>
        <nav aria-label="Open an Epic phase workspace">
          <button className="secondary compact" onClick={() => setTab('intake')}>Review Epic sources</button>
          <button className="primary compact" onClick={() => openOverviewStage('requirements')}>Open Requirements workspace</button>
          <button className="secondary compact" onClick={() => openOverviewStage('planning')}>Open Planning</button>
          <button className="secondary compact" onClick={() => openOverviewStage('stories')}>Open Create Stories</button>
        </nav>
      </section>}
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
        {!epics.length ? <div className="inline-empty">The story plan has no Epics yet. Run <code>/sflow-epic-story-draft</code> in Copilot CLI, then refresh and review its Epic IDs and Story Work IDs here.</div> : <div className="epic-progress-list">{epics.map((epic) => <section key={epic.id} className={epic.stale ? 'stale' : ''}>
          <header><div><span className="id-pair"><b>Epic ID</b><code>{epic.id}</code></span><span className="id-pair"><b>Jira ID</b><code>{epic.jiraKey ?? 'not created'}</code></span><h3>{epic.title}</h3></div><div className="epic-progress-summary"><strong>{epic.percentage}%</strong><span>{epic.complete}/{epic.total} complete</span><div><i style={{ width: `${epic.percentage}%` }} /></div></div></header>
          <StoryDeliveryOrbit epic={epic} />
          <details className="epic-story-details"><summary>View detailed Story table <span>{epic.total} Stories</span></summary><div className="epic-story-table"><div className="epic-story-head"><span>Story Work ID / Jira ID</span><span>Repository</span><span>Phase</span><span>Progress</span><span>State</span></div>{epic.stories.map((story) => <article key={story.id} className={`${story.stale ? 'stale' : ''} ${story.blocked ? 'blocked' : ''}`}><span><strong>{story.workId}</strong><small>Jira: {story.jiraKey ?? 'not created'}</small></span><span>{story.repository}</span><span>{story.currentPhase ?? (story.materialized ? 'seeded' : 'planned')}</span><span className="story-progress"><i><b style={{ width: `${story.progress?.percentage ?? 0}%` }} /></i><em>{story.progress?.percentage ?? 0}%</em></span><span><Pill tone={story.stale || story.blocked ? 'warn' : story.status === 'complete' ? 'good' : story.materialized ? 'accent' : 'neutral'}>{story.stale ? 'stale' : story.blocked ? 'blocked' : story.status}</Pill>{story.blocking && <small>blocking</small>}</span></article>)}</div></details>
        </section>)}</div>}
      </section>
      <div className="initiative-grid">
        <section className="panel initiative-contracts"><header className="panel-heading"><div><span className="eyebrow">Producer / consumer graph</span><h2>Interface contracts</h2></div><span>{selected.contracts.length}</span></header>{selected.contracts.length ? selected.contracts.map((contract) => <div key={contract.key}><div><strong>{contract.key}</strong><Pill tone={contract.integrity === 'verified' ? 'good' : 'warn'}>{contract.integrity}</Pill></div><span>{contract.format} · {contract.sha256.slice(0, 12)}</span><small>{contract.producers.join(', ') || 'external'} → {contract.consumers.join(', ') || 'no consumers'}</small></div>) : <div className="inline-empty">No interface contracts registered yet.</div>}</section>
        <section className="panel initiative-documents"><header className="panel-heading"><div><span className="eyebrow">Governed outputs</span><h2>Initiative documents</h2></div><span>{selected.documents.length}</span></header>{selected.documents.map((document) => <div key={`${document.phase}:${document.id}`}><span><strong>{document.label}</strong><small>{document.phase} · generation {document.generation}</small></span><Pill tone={document.status === 'approved' ? 'good' : document.status === 'stale' ? 'warn' : 'neutral'}>{document.status}</Pill><button className="ghost compact" disabled={!document.sha256} onClick={() => openArtifact(document)}>View</button></div>)}</section>
      </div>
    </>}
    {repositoryModal && <DesignerModal title="Add a participating repository" detail="Application identity and custom key/value pairs are stored as governed Git metadata under repositories.<id>.metadata in singularity/portfolio.yml." submitLabel="Add to YAML draft" error={repositoryModal.error} onCancel={() => setRepositoryModal(null)} onSubmit={addRepository}><div className="modal-grid"><label><span>Repository ID</span><input autoFocus value={repositoryModal.values.id} placeholder="mobile" onChange={(event) => repositoryField('id', event.target.value)} /></label><label><span>Application ID</span><input value={repositoryModal.values.appId} placeholder="APP-1001" onChange={(event) => repositoryField('appId', event.target.value)} /></label><label className="full"><span>Application name</span><input value={repositoryModal.values.name} placeholder="Mobile application" onChange={(event) => repositoryField('name', event.target.value)} /></label><label className="full"><span>Git URL</span><input value={repositoryModal.values.url} placeholder="git@github.com:company/mobile.git" onChange={(event) => repositoryField('url', event.target.value)} /></label><label><span>Default branch</span><input value={repositoryModal.values.defaultBranch} onChange={(event) => repositoryField('defaultBranch', event.target.value)} /></label><label className="check-row"><input type="checkbox" checked={repositoryModal.values.required} onChange={(event) => repositoryField('required', event.target.checked)} />Required for initiative delivery</label></div><div className="repository-metadata-fields"><header><div><strong>Custom metadata</strong><span>Examples: owner, businessUnit, costCenter, criticality.</span></div><button type="button" className="ghost compact" onClick={() => repositoryField('metadata', [...repositoryModal.values.metadata, { key: '', value: '' }])}>＋ Add field</button></header>{repositoryModal.values.metadata.map((entry, index) => <div key={index}><input aria-label={`Repository metadata key ${index + 1}`} value={entry.key} placeholder="owner" onChange={(event) => repositoryMetadataField(index, 'key', event.target.value)} /><input aria-label={`Repository metadata value ${index + 1}`} value={entry.value} placeholder="Digital Channels" onChange={(event) => repositoryMetadataField(index, 'value', event.target.value)} /><button type="button" className="ghost compact" aria-label={`Remove repository metadata ${index + 1}`} onClick={() => repositoryField('metadata', repositoryModal.values.metadata.filter((_, entryIndex) => entryIndex !== index))}>×</button></div>)}</div></DesignerModal>}
    {restartModal && <DesignerModal
      title={`Start ${selected.state.initiative.id} again?`}
      detail={`This returns the Epic to its first phase and discards this attempt's artifacts. It stays on branch ${selected.state.initiative.branch}: the Epic identity and pinned sources are kept, and this attempt stays on the record. Story-branch world models are not changed. The phase shape is resolved again from current configuration.`}
      submitLabel="Start again"
      danger
      submitDisabled={restartModal.confirmation.trim() !== selected.state.initiative.id}
      onCancel={() => setRestartModal(null)}
      onSubmit={restartEpic}
    >
      <label><span>Why</span><input value={restartModal.reason} onChange={(event) => setRestartModal({ ...restartModal, reason: event.target.value })} placeholder="Recorded with the restart" /></label>
      <label><span>Type {selected.state.initiative.id} to confirm</span><input value={restartModal.confirmation} onChange={(event) => setRestartModal({ ...restartModal, confirmation: event.target.value })} placeholder={selected.state.initiative.id} /></label>
      {restartModal.confirmation.trim() && restartModal.confirmation.trim() !== selected.state.initiative.id && <small className="field-error">That is not {selected.state.initiative.id}.</small>}
    </DesignerModal>}
    {materializationModal && <DesignerModal title={`Create stories for ${state.initiative.id}?`} detail="This applies the exact reviewed Jira plan, creates configured Jira tasks, uploads selected hash-bound artifacts, adopts returned Jira keys as immutable Work IDs, creates one canonical branch per Story, and publishes every receipt. Success completes Epic planning and opens developer delivery tracking. It is resumable and never force-pushes." submitLabel="Create Jira & Git stories" onCancel={() => setMaterializationModal(null)} onSubmit={materializeStories}><div className="materialization-preview"><div><span>Epics</span><strong>{materializationModal.preview.epics}</strong></div><div><span>Stories</span><strong>{materializationModal.preview.stories.length}</strong></div><div><span>Repositories</span><strong>{Object.keys(materializationModal.preview.repositories).length}</strong></div><div><span>Selected artifacts</span><strong>{materializationModal.writePlan?.artifacts?.length ?? 0}</strong></div></div>{materializationModal.writePlan && <><div className="notice neutral"><strong>Exact Jira Story and artifact plan</strong><br />Jira tasks are included in the governed operation list and receipts.<br />Plan hash: <code>{materializationModal.writePlan.sha256}</code><br />Source breakdown: <code>{materializationModal.writePlan.source.breakdownSha256}</code></div>{materializationModal.writePlan.artifacts?.length > 0 && <div className="jira-modal-artifacts">{materializationModal.writePlan.artifacts.map((artifact) => <div key={artifact.reference}><span><strong>{artifact.label}</strong><small>{artifact.filename}</small></span><code>{artifact.sha256.slice(0, 12)}</code><Pill>{artifact.targets.join(' + ')}</Pill></div>)}</div>}</>}<label><span>Type the Epic ID to confirm the exact plan</span><input autoFocus value={materializationModal.confirmation} placeholder={state.initiative.id} onChange={(event) => setMaterializationModal({ ...materializationModal, confirmation: event.target.value })} /></label>{materializationModal.confirmation !== state.initiative.id && <div className="notice warn">Exact confirmation required: <code>{state.initiative.id}</code></div>}</DesignerModal>}
    {artifactViewer}
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

function SessionChoices({ data, openPortfolio, openWorkflow, openPersonas }) {
  const profiles = Object.entries(data.portfolio?.initiativeProfiles ?? {
    'epic-planning': { label: 'Epic planning', description: 'Intake, requirements, planning, and Story creation.', phases: [] }
  });
  const personas = Object.entries(data.definition?.personas ?? {});
  const session = data.definition?.session ?? {};
  const policyLabel = (value) => ({
    off: 'Off · legacy behavior',
    reuse: 'Reuse current selection',
    prompt: 'Ask the contributor'
  })[value] ?? 'Not configured';
  return <div className="page session-choices-page">
    <header className="page-heading row-between"><div><span className="eyebrow">Epic start and Copilot identity</span><h1>Session choices</h1><p>These are the workflow and persona options shown when a user starts an Epic or resumes governed work.</p></div><Pill tone="accent">{profiles.length} workflows · {personas.length} personas</Pill></header>
    <section className="session-choice-explainer">
      <div><b>1</b><span><strong>Choose a workflow</strong><small>Pinned to the Epic and immutable after work starts.</small></span></div>
      <i>→</i>
      <div><b>2</b><span><strong>Choose a persona</strong><small>Applies to the contributor’s current Copilot session.</small></span></div>
      <i>→</i>
      <div><b>3</b><span><strong>Start governed work</strong><small>Git identity and persona are recorded with the next action.</small></span></div>
    </section>
    <div className="session-choice-columns">
      <section className="panel"><header className="panel-heading"><div><span className="eyebrow">Stored in singularity/portfolio.yml</span><h2>Epic workflow choices</h2><p>The selected profile controls the phase sequence, expected outputs, gates, and approvals.</p></div><button className="secondary compact" onClick={openPortfolio}>Configure workflows</button></header><div className="session-choice-list">{profiles.map(([id, profile]) => <article key={id}><span className="session-choice-mark">W</span><div><strong>{profile.label ?? id}</strong><small>{profile.description ?? `${profile.phases?.length ?? 0} governed phases`}</small><code>{id}</code></div><Pill tone="neutral">{profile.phases?.length ?? 0} phases</Pill></article>)}</div></section>
      <section className="panel"><header className="panel-heading"><div><span className="eyebrow">Stored in singularity/workflow.yml</span><h2>Working personas</h2><p>Personas change prompt perspective and approval capability; they do not replace Git identity.</p></div><button className="secondary compact" onClick={openPersonas}>Configure personas</button></header><div className="session-choice-list">{personas.map(([id, persona]) => <article key={id}><span className="session-choice-mark persona">{(persona.label ?? id).slice(0, 2).toUpperCase()}</span><div><strong>{persona.label ?? id}</strong><small>{persona.description ?? 'No description configured.'}</small><code>{id}</code></div><Pill tone="neutral">{persona.mayApprove?.length ?? 0} approvals</Pill></article>)}</div></section>
    </div>
    <section className="panel session-policy-panel"><header className="panel-heading"><div><span className="eyebrow">Copilot session behavior</span><h2>When should Flow ask again?</h2><p>This policy controls selection prompts when work starts or resumes.</p></div><button className="secondary compact" onClick={openWorkflow}>Edit session policy</button></header><div className="session-policy-grid"><div><span>Work item</span><strong>{policyLabel(session.workItemSelection)}</strong></div><div><span>Persona</span><strong>{policyLabel(session.personaSelection)}</strong></div><div><span>New session</span><strong>{session.promptOnNewSession ? 'Ask again' : 'Keep selection'}</strong></div><div><span>Resume</span><strong>{session.promptOnResume ? 'Ask again' : 'Keep selection'}</strong></div><div><span>Before tools</span><strong>{session.requireBeforeTools ? 'Selection required' : 'No blocking prompt'}</strong></div></div></section>
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

const lifecycleSteps = [
  {
    id: 'jira-intake',
    system: 'jira',
    icon: 'jira',
    number: '01',
    eyebrow: 'Jira',
    title: 'Bring in the Epic',
    detail: 'Flow snapshots the Epic identity, description, attachments, and source references without making Jira the approval ledger.'
  },
  {
    id: 'git-grounding',
    system: 'git',
    icon: 'workflow',
    number: '02',
    eyebrow: 'Lead Git repository',
    title: 'Pin the evidence',
    detail: 'Source hashes, workflow profile, persona, and templates are committed to the Epic branch. Repository grounding begins later on each Story branch.'
  },
  {
    id: 'copilot-planning',
    system: 'copilot',
    icon: 'planning',
    number: '03',
    eyebrow: 'Copilot CLI',
    title: 'Formalize the work',
    detail: 'The /sflow-* skills compose governed context so Copilot can draft requirements, impact analysis, specifications, and a Story plan.'
  },
  {
    id: 'business-decision',
    system: 'human',
    icon: 'review',
    number: '04',
    eyebrow: 'Business review',
    title: 'Approve exact versions',
    detail: 'People review the generated documents in Flow. Decisions bind to content hashes and are committed and pushed with identity and persona.'
  },
  {
    id: 'story-materialization',
    system: 'jira',
    icon: 'epics',
    number: '05',
    eyebrow: 'Jira + delivery Git',
    title: 'Create governed Stories',
    detail: 'Approved Stories are written to Jira and receive repository routing, a canonical branch, a seed, parent specification, and lineage receipts.'
  },
  {
    id: 'copilot-delivery',
    system: 'copilot',
    icon: 'resources',
    number: '06',
    eyebrow: 'Developer Copilot',
    title: 'Design, build, and test',
    detail: 'A developer fetches a Story with sflow, works in any tool, and publishes phase artifacts, evidence, approvals, and source commits.'
  },
  {
    id: 'finalize',
    system: 'git',
    icon: 'validate',
    number: '07',
    eyebrow: 'Exact Git SHA',
    title: 'Finalize the delivery packet',
    detail: 'The finalized packet connects the Story spec to source, tests, conformance findings, approvals, model usage, and the exact submitted commit.'
  },
  {
    id: 'reconcile',
    system: 'reconcile',
    icon: 'refresh',
    number: '08',
    eyebrow: 'Product owner',
    title: 'Reconcile and complete',
    detail: 'Flow compares every Story with the parent spec, surfaces Jira drift or missing evidence, and records an explicit adopt, restore, approve, or reject decision.'
  }
];

function HowItWorks({ onDocumentation }) {
  return <main className="how-it-works">
    <header className="how-it-works-hero">
      <div>
        <span className="eyebrow">Two-minute visual guide</span>
        <h1>From Jira Epic to<br /><em>reconciled delivery.</em></h1>
        <p>Singularity Flow connects business intent, AI-assisted authoring, delivery repositories, and human decisions without hiding which system owns each part of the lifecycle.</p>
      </div>
      <div className="how-it-works-summary" aria-label="Core operating model">
        <span><NavIcon name="jira" /><strong>Jira tracks work</strong><small>Epics, Stories, assignment, and status</small></span>
        <span><NavIcon name="workflow" /><strong>Git carries truth</strong><small>Artifacts, hashes, lineage, and decisions</small></span>
        <span><NavIcon name="planning" /><strong>Copilot authors</strong><small>Governed prompts through /sflow-* skills</small></span>
        <span><NavIcon name="review" /><strong>People decide</strong><small>Exact-version approval and reconciliation</small></span>
      </div>
    </header>

    <section className="lifecycle-visual" aria-labelledby="lifecycle-title">
      <header>
        <div><span className="eyebrow">End-to-end lifecycle</span><h2 id="lifecycle-title">One continuous chain of evidence</h2></div>
        <div className="lifecycle-legend" aria-label="System legend">
          <span className="jira">Jira</span>
          <span className="git">Git</span>
          <span className="copilot">Copilot</span>
          <span className="human">Human decision</span>
        </div>
      </header>
      <ol className="lifecycle-map">
        {lifecycleSteps.map((step) => <li className={`lifecycle-node ${step.system}`} key={step.id}>
          <div className="lifecycle-node-head"><span className="lifecycle-icon"><NavIcon name={step.icon} /></span><b>{step.number}</b></div>
          <span className="eyebrow">{step.eyebrow}</span>
          <h3>{step.title}</h3>
          <p>{step.detail}</p>
        </li>)}
      </ol>
      <div className="git-state-spine">
        <span className="git-state-icon"><NavIcon name="publish" /></span>
        <div><strong>Git state transfer is always underneath the journey</strong><small>Every generation, submission, approval, rejection, Story receipt, and reconciliation decision becomes an atomic commit and push. Another terminal can resume from the branch.</small></div>
        <code>generate → commit → push → review → decide</code>
      </div>
      <div className="reconcile-loop">
        <span className="reconcile-loop-icon"><NavIcon name="refresh" /></span>
        <div><span className="eyebrow">The reconciliation loop</span><strong>External changes are observed, never silently merged</strong><p>If Jira, a branch, a contract, or approved evidence changes, Flow shows the drift. The product owner explicitly adopts it into a new Git generation or restores the approved Git-owned value.</p></div>
        <div className="reconcile-route" aria-label="Reconciliation route"><span>Observe</span><i>→</i><span>Compare</span><i>→</i><span>Decide</span><i>→</i><span>Commit</span></div>
      </div>
    </section>

    <section className="guide-surface-comparison" aria-labelledby="guide-difference-title">
      <header><span className="eyebrow">Choose the right guide</span><h2 id="guide-difference-title">How it works is the map. Documentation is the manual.</h2></header>
      <div>
        <article className="active"><span className="guide-number">01</span><h3>How it works</h3><p>Use this pictorial overview to understand the lifecycle, system boundaries, state transfer, approvals, and reconciliation.</p><strong>You are here</strong></article>
        <article><span className="guide-number">02</span><h3>Documentation</h3><p>Use the searchable manual for exact CLI commands, workflow YAML, templates, personas, remote agents, Jira setup, and troubleshooting.</p><button className="secondary" onClick={onDocumentation}>Open documentation</button></article>
      </div>
    </section>
  </main>;
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
  const [view, setView] = useState('builder');
  const [modal, setModal] = useState(null);
  const [artifact, setArtifact] = useState(() => parseArtifactTemplate(editor.content));
  const [selectedSection, setSelectedSection] = useState(null);
  const files = data.templates.filter((item) => item.name.toLowerCase().includes(search.toLowerCase()));
  const current = data.templates.find((file) => file.path === editor.path) ?? null;
  const groups = [...new Set(ARTIFACT_SECTION_LIBRARY.map((item) => item.group))];
  useEffect(() => {
    const parsed = parseArtifactTemplate(editor.content);
    setArtifact(parsed);
    setSelectedSection(parsed.sections[0]?.id ?? null);
  }, [editor.path]);
  async function submitCreate() { if (!modal.name.trim()) return setModal({ ...modal, error: 'Enter a relative Markdown filename.' }); const result = await createTemplate(modal.name.trim()); if (result) setModal(null); }
  async function submitDelete() { const result = await deleteTemplate(current); if (result) setModal(null); }
  function applyArtifact(next) {
    setArtifact(next);
    setEditor({ ...editor, content: serializeArtifactTemplate(next) });
  }
  function switchView(next) {
    if (next === 'builder') {
      const parsed = parseArtifactTemplate(editor.content);
      setArtifact(parsed);
      setSelectedSection(parsed.sections[0]?.id ?? null);
    }
    setView(next);
  }
  function insertSection(type, targetIndex = artifact.sections.length) {
    const next = addArtifactSection(artifact, type, targetIndex);
    applyArtifact(next);
    setSelectedSection(next.sections[targetIndex]?.id ?? next.sections.at(-1)?.id ?? null);
  }
  function moveSection(sectionId, targetIndex) {
    applyArtifact(moveArtifactSection(artifact, sectionId, targetIndex));
  }
  function dropSection(event, targetIndex) {
    event.preventDefault();
    const type = event.dataTransfer.getData('application/x-singularity-section-type');
    const sectionId = event.dataTransfer.getData('application/x-singularity-section-id');
    if (type) insertSection(type, targetIndex);
    else if (sectionId) moveSection(sectionId, targetIndex);
  }
  async function submitRemoteTemplate() {
    if (!modal.url?.trim()) return setModal({ ...modal, error: 'Enter a public HTTPS Markdown URL.' });
    if (!modal.fetched) {
      setModal({ ...modal, fetching: true, error: null });
      try {
        const fetched = await window.singularity.previewTemplateUrl(data.repository.root, modal.url.trim());
        let filename = 'remote-template.md';
        try {
          const candidate = new URL(fetched.resolvedUrl).pathname.split('/').filter(Boolean).at(-1);
          if (candidate) filename = candidate.replace(/[^a-zA-Z0-9._-]/g, '-');
        } catch { /* The main process already validated the URL. */ }
        if (!filename.toLowerCase().endsWith('.md')) filename = `${filename}.md`;
        setModal({ ...modal, fetching: false, fetched, name: modal.name || `imports/${filename}`, error: null });
      } catch (error) {
        setModal({ ...modal, fetching: false, error: error?.message || String(error) });
      }
      return;
    }
    if (modal.destination === 'current' && current) {
      setEditor({ ...editor, content: modal.fetched.content });
      const parsed = parseArtifactTemplate(modal.fetched.content);
      setArtifact(parsed);
      setSelectedSection(parsed.sections[0]?.id ?? null);
      setView('builder');
      setModal(null);
      return;
    }
    if (!modal.name?.trim()) return setModal({ ...modal, error: 'Enter a repository template path.' });
    const result = await createTemplate(modal.name.trim(), modal.fetched.content);
    if (result) {
      setView('builder');
      setModal(null);
    }
  }
  return <div className="template-layout"><aside className="file-list"><header><div className="row-between"><div><span className="eyebrow">Artifact library</span><h2>Templates</h2></div><div className="row"><button className="icon-button" title="Import template from this computer" onClick={importTemplate}>⇧</button><button className="icon-button" title="Create template" onClick={() => setModal({ kind: 'create', name: '', error: null })}>＋</button></div></div><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Filter templates…" /></header>{files.map((file) => <button key={file.path} className={editor.path === file.path ? 'active' : ''} onClick={() => chooseTemplate(file)}><span>MD</span><div><strong>{file.name.split('/').at(-1)}</strong><small>{file.name.includes('/') ? file.name.slice(0, file.name.lastIndexOf('/')) : 'root'}</small></div></button>)}</aside>
    <main className="template-main"><header className="template-toolbar"><div><span className="eyebrow">Artifact builder</span><h1>{editor.path?.split('/').at(-1)}</h1></div><div className="row"><div className="segmented small"><button className={view === 'builder' ? 'active' : ''} onClick={() => switchView('builder')}>Builder</button><button className={view === 'source' ? 'active' : ''} onClick={() => switchView('source')}>Source</button><button className={view === 'preview' ? 'active' : ''} onClick={() => switchView('preview')}>Preview</button></div><button className="secondary compact" disabled={!current} onClick={() => downloadFile(current.path)}>Download</button><Pill tone={editor.content !== editor.original ? 'warn' : 'good'}>{editor.content !== editor.original ? 'Unsaved' : 'Saved'}</Pill><button className="primary compact" disabled={editor.content === editor.original} onClick={saveEditor}>Save</button></div></header>
      <div className="template-contract-bar"><span>Drag reusable sections into the canvas. The builder writes standard Markdown with <code>{'{{work.id}}'}</code>, <code>{'{{phase.label}}'}</code>, and <code>{'{{inputs}}'}</code>.</span><div className="row"><button className="ghost compact" onClick={() => setModal({ kind: 'url', url: '', name: '', destination: 'new', fetched: null, error: null })}>Import from URL</button><button className="ghost compact" onClick={importTemplate}>Import file</button><button className="ghost compact" disabled={!current} onClick={() => setModal({ kind: 'delete', error: null })}>Delete template</button></div></div>
      {view === 'builder' ? <div className="artifact-builder">
        <aside className="artifact-section-palette"><header><span className="eyebrow">Section library</span><h2>Drag into artifact</h2><p>Click also adds a section at the end.</p></header>{groups.map((group) => <section key={group}><strong>{group}</strong>{ARTIFACT_SECTION_LIBRARY.filter((item) => item.group === group).map((item) => <button key={item.type} draggable onDragStart={(event) => { event.dataTransfer.effectAllowed = 'copy'; event.dataTransfer.setData('application/x-singularity-section-type', item.type); }} onClick={() => insertSection(item.type)}><span>＋</span><div><b>{item.label}</b><small>{item.description}</small></div></button>)}</section>)}</aside>
        <section className="artifact-builder-canvas"><header><div><span className="eyebrow">Artifact structure</span><h2>{artifact.sections.length} sections</h2></div><div className="template-token-tray"><code>{'{{work.id}}'}</code><code>{'{{phase.label}}'}</code><code>{'{{inputs}}'}</code></div></header>
          <article className="artifact-preamble-card"><div><span>DOC</span><strong>Document header</strong><small>Title, managed metadata placeholders, and opening guidance</small></div><textarea value={artifact.preamble} onChange={(event) => applyArtifact({ ...artifact, preamble: event.target.value })} rows="5" placeholder={'# {{work.id}} — {{phase.label}}'} /></article>
          <div className="artifact-drop-zone" onDragOver={(event) => event.preventDefault()} onDrop={(event) => dropSection(event, 0)}><span>Drop a section here</span></div>
          {artifact.sections.map((section, index) => <React.Fragment key={section.id}><article className={`artifact-section-card ${selectedSection === section.id ? 'selected' : ''}`} draggable onDragStart={(event) => { event.dataTransfer.effectAllowed = 'move'; event.dataTransfer.setData('application/x-singularity-section-id', section.id); }} onClick={() => setSelectedSection(section.id)}>
            <header><button className="artifact-drag-handle" type="button" aria-label={`Drag ${section.title}`}>⠿</button><span>{String(index + 1).padStart(2, '0')}</span><input value={section.title} aria-label="Section title" onChange={(event) => applyArtifact(updateArtifactSection(artifact, section.id, { title: event.target.value }))} /><Pill>{section.type}</Pill><div><button type="button" title="Move section up" disabled={index === 0} onClick={(event) => { event.stopPropagation(); moveSection(section.id, index - 1); }}>↑</button><button type="button" title="Move section down" disabled={index === artifact.sections.length - 1} onClick={(event) => { event.stopPropagation(); moveSection(section.id, index + 2); }}>↓</button><button type="button" className="danger-text" title="Remove section" onClick={(event) => { event.stopPropagation(); applyArtifact(removeArtifactSection(artifact, section.id)); }}>×</button></div></header>
            <textarea value={section.body} onChange={(event) => applyArtifact(updateArtifactSection(artifact, section.id, { body: event.target.value }))} rows={Math.max(4, Math.min(10, section.body.split('\n').length + 2))} />
          </article><div className="artifact-drop-zone" onDragOver={(event) => event.preventDefault()} onDrop={(event) => dropSection(event, index + 1)}><span>Drop between sections</span></div></React.Fragment>)}
          {!artifact.sections.length && <div className="artifact-canvas-empty"><span>↙</span><strong>Build the artifact structure</strong><p>Drag sections from the library or click a section to add it.</p></div>}
        </section>
        <aside className="artifact-live-preview"><header><div><span className="eyebrow">Live output</span><h2>Markdown preview</h2></div><Pill tone="accent">Live</Pill></header><TemplatePreview content={editor.content} /></aside>
      </div> : view === 'preview' ? <TemplatePreview content={editor.content} /> : <Editor height="calc(100vh - 186px)" language="markdown" theme="vs-dark" value={editor.content} onChange={(content) => setEditor({ ...editor, content: content ?? '' })} options={{ minimap: { enabled: false }, fontSize: 13, lineHeight: 21, wordWrap: 'on', padding: { top: 20 }, scrollBeyondLastLine: false, automaticLayout: true }} />}
    </main>
    {modal?.kind === 'create' && <DesignerModal title="Create artifact template" detail="Create repository Markdown under the configured templates root. You can assign it to a stage from the Workflow page." submitLabel="Create template" error={modal.error} onCancel={() => setModal(null)} onSubmit={submitCreate}><label><span>Relative template path</span><input autoFocus value={modal.name} placeholder="security/security-review.md" onChange={(event) => setModal({ ...modal, name: event.target.value, error: null })} /></label></DesignerModal>}
    {modal?.kind === 'url' && <DesignerModal title="Import a template from URL" detail="Singularity fetches non-empty UTF-8 Markdown from a public HTTPS URL, follows at most three HTTPS redirects, and enforces a 1 MiB limit. No credentials or cookies are sent." submitLabel={modal.fetching ? 'Fetching…' : modal.fetched ? 'Use this template' : 'Fetch & preview'} error={modal.error} onCancel={() => setModal(null)} onSubmit={submitRemoteTemplate}><label><span>Public Markdown URL</span><input autoFocus type="url" value={modal.url} disabled={modal.fetching || modal.fetched} placeholder="https://raw.githubusercontent.com/org/templates/main/requirements.md" onChange={(event) => setModal({ ...modal, url: event.target.value, error: null })} /></label>{modal.fetched && <><div className="remote-template-receipt"><span><b>Verified Markdown</b><small>{modal.fetched.size.toLocaleString()} bytes · SHA-256 {modal.fetched.sha256.slice(0, 16)}…</small></span><code>{modal.fetched.resolvedUrl}</code></div><div className="remote-template-preview"><TemplatePreview content={modal.fetched.content} /></div><div className="choice-group remote-template-destination"><span>Destination</span><div><label className={modal.destination === 'new' ? 'checked' : ''}><input type="radio" checked={modal.destination === 'new'} onChange={() => setModal({ ...modal, destination: 'new' })} />Create a new repository template</label>{current && <label className={modal.destination === 'current' ? 'checked' : ''}><input type="radio" checked={modal.destination === 'current'} onChange={() => setModal({ ...modal, destination: 'current' })} />Replace the current editor draft</label>}</div></div>{modal.destination === 'new' && <label><span>Relative template path</span><input value={modal.name} placeholder="imports/requirements.md" onChange={(event) => setModal({ ...modal, name: event.target.value, error: null })} /></label>}</>}</DesignerModal>}
    {modal?.kind === 'delete' && <DesignerModal title={`Delete ${current?.name}?`} detail="Deletion is allowed only when no stage or workflow profile references this template." submitLabel="Delete template" danger error={modal.error} onCancel={() => setModal(null)} onSubmit={submitDelete} />}
  </div>;
}

function Resources({ data, editor, setEditor, chooseResource, saveEditor, createSkill, customizeFlowSkill, deleteFile, downloadFile, importResource, materializeWorldModelPrompt, materializePlanningPrompt }) {
  const [category, setCategory] = useState(editor.kind === 'flow-skill' ? 'flow' : editor.kind === 'skill' ? 'repository' : 'prompts');
  const [query, setQuery] = useState('');
  const [modal, setModal] = useState(null);
  const promptFiles = [
    ...data.personaPrompts,
    { ...data.worldModelPrompt, name: `world-model/${data.worldModelPrompt.name}`, worldModelBuilder: true },
    { ...data.planning.prompt, name: `planning/${data.planning.prompt.name}`, planningPrompt: true }
  ];
  const flowSkills = data.flowSkills ?? [];
  const repositorySkills = data.repositorySkills ?? [];
  const sourceFiles = category === 'flow' ? flowSkills : category === 'repository' ? repositorySkills : promptFiles;
  const normalizedQuery = query.trim().toLowerCase();
  const files = sourceFiles.filter((file) => !normalizedQuery || `${file.id ?? ''} ${file.name} ${file.description ?? ''} ${file.content}`.toLowerCase().includes(normalizedQuery));
  const current = files.find((file) => file.path === editor.path) ?? files[0];
  const isFlowSkill = category === 'flow';
  const isRepositorySkill = category === 'repository';
  const override = isFlowSkill && current ? repositorySkills.find((file) => file.path === current.repositoryPath) : null;
  const flowOrigin = isRepositorySkill && current ? flowSkills.find((skill) => skill.repositoryPath === current.path) : null;
  useEffect(() => {
    if (!current || editor.path === current.path) return;
    chooseResource(current, isFlowSkill ? 'flow-skill' : isRepositorySkill ? 'skill' : 'prompt');
  }, [category, query, current?.path]);
  async function submitSkill() { const result = await createSkill(modal.id.trim()); if (result) setModal(null); }
  return <div className="template-layout skill-library-layout">
    <aside className="file-list skill-library-list">
      <header>
        <div className="row-between"><div><span className="eyebrow">Copilot instruction library</span><h2>Prompts &amp; skills</h2></div>{category !== 'flow' && <button className="icon-button" title={isRepositorySkill ? 'Create repository skill' : 'Import prompt'} onClick={() => isRepositorySkill ? setModal({ kind: 'skill', id: '', error: null }) : importResource('prompt')}>＋</button>}</div>
        <div className="segmented resource-tabs skill-scope-tabs">
          <button className={category === 'prompts' ? 'active' : ''} onClick={() => setCategory('prompts')}>Prompts <span>{promptFiles.length}</span></button>
          <button className={category === 'flow' ? 'active' : ''} onClick={() => setCategory('flow')}>Flow skills <span>{flowSkills.length}</span></button>
          <button className={category === 'repository' ? 'active' : ''} onClick={() => setCategory('repository')}>Repository <span>{repositorySkills.length}</span></button>
        </div>
        <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder={category === 'flow' ? 'Search /sflow commands…' : 'Search Markdown…'} />
      </header>
      {files.map((file) => {
        const customized = category === 'flow' && repositorySkills.some((item) => item.path === file.repositoryPath);
        const overridesFlow = category === 'repository' && flowSkills.some((item) => item.repositoryPath === file.path);
        return <button key={file.path} className={current?.path === file.path ? 'active skill-library-item' : 'skill-library-item'} onClick={() => chooseResource(file, isFlowSkill ? 'flow-skill' : isRepositorySkill ? 'skill' : 'prompt')}>
          <span>{category === 'prompts' ? 'PR' : 'SK'}</span>
          <div><strong>{file.id ?? (file.name.endsWith('/SKILL.md') ? file.name.split('/')[0] : file.name.split('/').at(-1))}</strong><small>{file.worldModelBuilder ? 'world-model builder' : file.planningPrompt ? 'Copilot planning contract' : customized ? 'repository customization active' : overridesFlow ? 'overrides bundled Flow skill' : isFlowSkill ? file.command : file.name.includes('/') ? file.name.slice(0, file.name.lastIndexOf('/')) : isRepositorySkill ? 'repository skill' : 'persona prompt'}</small></div>
          {(customized || overridesFlow) && <em>Customized</em>}
        </button>;
      })}
      {!files.length && <div className="inline-empty">{normalizedQuery ? 'No skills match this search.' : isRepositorySkill ? 'No repository skills yet.' : 'No resources found.'}</div>}
    </aside>
    <main className="template-main skill-library-main">{current ? <>
      <div className="resource-summary skill-resource-summary">
        <div>
          <div className="row"><Pill tone={isFlowSkill ? 'accent' : isRepositorySkill ? 'good' : 'neutral'}>{isFlowSkill ? 'Bundled Flow skill' : flowOrigin ? 'Repository override' : isRepositorySkill ? 'Repository skill' : current.worldModelBuilder ? 'Builder prompt' : current.planningPrompt ? 'Planning contract' : 'Persona prompt'}</Pill>{isFlowSkill && <code>{current.command}</code>}</div>
          <strong>{isFlowSkill ? current.id : flowOrigin?.id ?? current.name.split('/').at(-1)}</strong>
          <span>{isFlowSkill ? current.description : flowOrigin ? `This project copy takes precedence over the bundled ${flowOrigin.command} skill.` : current.worldModelBuilder ? 'Controls repository world-model generation.' : current.planningPrompt ? 'Controls phase-aware Copilot Plan-mode behavior and promotion output.' : isRepositorySkill ? 'Discovered by Copilot from .github/skills.' : 'Combined with phase and world-model context.'}</span>
          {isFlowSkill && current.argumentHint && <small>Usage: <code>{current.command} {current.argumentHint}</code></small>}
        </div>
        <div className="row">
          {isFlowSkill && <button className="ghost compact" onClick={() => copyText(current.command)}>Copy command</button>}
          {isFlowSkill && <button className={override ? 'secondary compact' : 'primary compact'} onClick={async () => {
            if (override) {
              setCategory('repository');
              chooseResource(override, 'skill');
              return;
            }
            const customized = await customizeFlowSkill(current);
            if (customized) setCategory('repository');
          }}>{override ? 'Edit repository customization' : 'Customize for this repository'}</button>}
          {!isFlowSkill && <button className="ghost compact" onClick={() => importResource(current.worldModelBuilder ? 'world-prompt' : current.planningPrompt ? 'planner-prompt' : isRepositorySkill ? 'skill' : 'prompt')}>Import</button>}
          {!isFlowSkill && !current.missing && <button className="secondary compact" onClick={() => downloadFile(current.path)}>Download</button>}
          {isRepositorySkill && <button className="ghost compact danger-text" onClick={() => deleteFile(current)}>Delete</button>}
          {current.worldModelBuilder && current.missing && <button className="primary compact" onClick={() => materializeWorldModelPrompt(editor.path === current.path ? editor.content : current.content)}>Create repository copy</button>}
          {current.planningPrompt && current.missing && <button className="primary compact" onClick={() => materializePlanningPrompt(editor.path === current.path ? editor.content : current.content)}>Create repository copy</button>}
        </div>
      </div>
      {isFlowSkill && <div className="skill-precedence-note"><span>Protected product source</span><p>The installed plugin is read-only. A repository customization with the same skill name is committed under <code>{current.repositoryPath}</code> and takes precedence in Copilot for this project.</p></div>}
      <SourceEditor
        path={current.path}
        value={editor.path === current.path ? editor.content : current.content}
        dirty={editor.path === current.path && editor.content !== editor.original}
        readOnly={isFlowSkill}
        onChange={(content) => setEditor({ path: current.path, content, original: current.content, kind: isRepositorySkill ? 'skill' : 'prompt' })}
        onSave={current.worldModelBuilder && current.missing ? () => materializeWorldModelPrompt(editor.content) : current.planningPrompt && current.missing ? () => materializePlanningPrompt(editor.content) : saveEditor}
        onDownload={!isFlowSkill && !current.missing ? () => downloadFile(current.path) : null}
        onImport={!isFlowSkill ? () => importResource(current.worldModelBuilder ? 'world-prompt' : current.planningPrompt ? 'planner-prompt' : isRepositorySkill ? 'skill' : 'prompt') : null}
        height={isFlowSkill ? 'calc(100vh - 365px)' : 'calc(100vh - 315px)'}
      />
    </> : <Empty title={isRepositorySkill ? 'No repository skills yet' : 'No resources found'} detail={isRepositorySkill ? 'Create a new project skill or customize one of the bundled Flow skills.' : 'Clear the search to see available Markdown.'} action={isRepositorySkill && <button className="primary" onClick={() => setModal({ kind: 'skill', id: '', error: null })}>Create first skill</button>} />}</main>
    {modal?.kind === 'skill' && <DesignerModal title="Create repository skill" detail="The skill is stored as .github/skills/<id>/SKILL.md and is loaded by Copilot for this repository." submitLabel="Create skill" error={modal.error} onCancel={() => setModal(null)} onSubmit={submitSkill}><label><span>Skill ID</span><input autoFocus value={modal.id} placeholder="security-review" onChange={(event) => setModal({ ...modal, id: event.target.value, error: null })} /></label></DesignerModal>}
  </div>;
}

function WorldModel({ data, editor, setEditor, saveEditor, downloadFile, importResource, materializeWorldModelPrompt, generateWorldModel, addView, removeView }) {
  const [selected, setSelected] = useState('registry');
  const [modal, setModal] = useState(null);
  // wm build accepts --views; the desktop never passed it, so a rebuild from here could only
  // produce whatever `views: auto` routed to and the views the phases need were never generated.
  const builtViews = useMemo(
    () => data.worldModel.files.filter((file) => file.path.includes('/views/')).map((file) => file.path.split('/').pop().replace(/\.md$/, '')),
    [data.worldModel.files]
  );
  const [buildViews, setBuildViews] = useState(() => {
    const referenced = data.worldModel.views.filter((view) => (view.structuredReferences ?? []).length).map((view) => view.id);
    return [...new Set([...referenced, ...data.worldModel.files.filter((file) => file.path.includes('/views/')).map((file) => file.path.split('/').pop().replace(/\.md$/, ''))])];
  });
  const current = data.worldModel.files.find((file) => file.path === selected) ?? null;
  const prompt = data.worldModelPrompt;
  const activeStoryBranch = data.workflow?.workItem?.branch === data.repository.branch;
  function selectPrompt() {
    setSelected('prompt');
    setEditor({ path: prompt.path, content: prompt.content, original: prompt.content, kind: 'prompt' });
  }
  async function submitView() {
    const result = await addView(modal.id.trim());
    if (result) setModal(null);
  }
  return <div className="template-layout"><aside className="file-list world-model-list"><header><span className="eyebrow">Story-branch grounding</span><h2>World model</h2><div className="repo-only"><StatusDot status={activeStoryBranch ? 'approved' : 'not_started'} /><span>{activeStoryBranch ? 'Story branch active' : 'Available after Story intake'}</span></div></header><button className={selected === 'registry' ? 'active' : ''} onClick={() => setSelected('registry')}><span>VW</span><div><strong>View registry</strong><small>{data.worldModel.views.length} governed views</small></div></button><button className={selected === 'prompt' ? 'active' : ''} onClick={selectPrompt}><span>PR</span><div><strong>Builder prompt</strong><small>{prompt.missing ? 'create repository copy' : 'editable repository source'}</small></div></button><div className="file-list-divider"><span>Generated outputs</span></div>{data.worldModel.files.map((file) => <button key={file.path} className={current?.path === file.path ? 'active' : ''} onClick={() => setSelected(file.path)}><span>{file.name.endsWith('.md') ? 'MD' : 'JS'}</span><div><strong>{file.name.split('/').at(-1)}</strong><small>{file.name.includes('/') ? file.name.slice(0, file.name.lastIndexOf('/')) : 'root'}</small></div></button>)}</aside>
    <main className="template-main">{selected === 'registry' ? <><div className="world-model-banner"><div><span className="eyebrow">Governed repository context</span><h1>Repository-owned world model</h1><p>Configure the approved views now. Generation unlocks after Jira Story intake creates the canonical Story branch, so the resulting model is committed and pushed with that Story instead of changing <code>main</code>.</p></div><dl><div><dt>Output</dt><dd>{data.worldModel.root}</dd></div><div><dt>Grounding</dt><dd>{activeStoryBranch ? data.definition.worldModel?.grounding ?? 'off' : 'waiting for Story intake'}</dd></div><div><dt>Builder</dt><dd>{data.definition.worldModel?.promptSource ?? 'builtin'}</dd></div><div><dt>Generated</dt><dd>{data.worldModel.generatedAt ? new Date(data.worldModel.generatedAt).toLocaleString() : 'Not generated'}</dd></div></dl><div className="row"><button className="secondary compact" disabled={!activeStoryBranch || !buildViews.length} onClick={() => generateWorldModel?.(false, undefined, buildViews)} title={!activeStoryBranch ? 'Start or resume a Jira Story first' : buildViews.length ? `Build ${buildViews.join(', ')} and push it with ${data.repository.branch}` : 'Choose at least one view to build'}>{activeStoryBranch ? (buildViews.length === builtViews.length && buildViews.every((view) => builtViews.includes(view)) ? 'Rebuild & push selected views' : `Build & push ${buildViews.length} view${buildViews.length === 1 ? '' : 's'}`) : 'Available after Story intake'}</button><button className="primary compact" onClick={() => setModal({ id: '', error: null })}>＋ Add view</button></div>
<div className="view-picker">
  <span className="view-picker-label">Views to build</span>
  <div className="view-picker-options">{data.worldModel.views.map((view) => {
    const built = builtViews.includes(view.id);
    const needed = (view.structuredReferences ?? []).length > 0;
    return <label key={view.id} className={`view-pick ${built ? 'built' : ''}`} title={needed ? `Referenced by ${(view.structuredReferences ?? []).join(', ')}` : 'Not referenced by any phase or persona'}>
      <input type="checkbox" checked={buildViews.includes(view.id)} onChange={(event) => setBuildViews((current) => event.target.checked ? [...current, view.id] : current.filter((id) => id !== view.id))} />
      <span><b>{view.id}</b><small>{built ? 'built' : needed ? 'needed · not built' : 'not built'}</small></span>
    </label>;
  })}</div>
</div></div><section className="view-registry"><header><div><span className="eyebrow">Dependency-safe catalog</span><h2>World-model views</h2></div><Pill tone="accent">Validated on every save</Pill></header><div className="view-table"><div className="view-table-head"><span>View</span><span>Structured use</span><span>Markdown prompt use</span><span>Action</span></div>{data.worldModel.views.map((view) => <div className="view-row" key={view.id}><div><span className="view-glyph">{view.id.slice(0, 2).toUpperCase()}</span><strong>{view.id}</strong></div><div className="dependency-list">{view.structuredReferences.length ? view.structuredReferences.map((item) => <code key={item}>{item}</code>) : <span>Not referenced</span>}</div><div className="dependency-list">{view.promptReferences.length ? view.promptReferences.map((item) => <code key={item}>{item}</code>) : <span>Not referenced</span>}</div><button className="ghost compact danger-text" disabled={view.references.length > 0} title={view.references.length ? `Used by ${view.references.join(', ')}` : 'Remove unused view'} onClick={() => removeView(view)}>Remove</button></div>)}</div><div className="dependency-note"><strong>Safe deletion policy</strong><span>Update stage, persona, workflow, injection-rule, and Markdown references first. Invalid YAML or prompt edits are rejected and rolled back atomically.</span></div></section></> : selected === 'prompt' ? <><div className="resource-summary"><div><Pill tone="accent">Editable builder prompt</Pill><span>This prompt controls how repository evidence becomes the governed views above.</span></div><div className="row"><button className="ghost compact" onClick={() => importResource('world-prompt')}>Import</button>{!prompt.missing && <button className="secondary compact" onClick={() => downloadFile(prompt.path)}>Download</button>}{prompt.missing && <button className="primary compact" onClick={() => materializeWorldModelPrompt(editor.path === prompt.path ? editor.content : prompt.content)}>Create repository copy</button>}</div></div><SourceEditor path={prompt.path} value={editor.path === prompt.path ? editor.content : prompt.content} dirty={editor.path === prompt.path && editor.content !== editor.original} onChange={(content) => setEditor({ path: prompt.path, content, original: prompt.content, kind: 'prompt' })} onSave={prompt.missing ? () => materializeWorldModelPrompt(editor.content) : saveEditor} onDownload={prompt.missing ? null : () => downloadFile(prompt.path)} onImport={() => importResource('world-prompt')} /></> : current ? <><div className="resource-summary"><div><Pill>Generated view</Pill><span>Read-only repository snapshot; regenerate it through the world-model lifecycle.</span></div><button className="secondary compact" onClick={() => downloadFile(current.path)}>Download</button></div><SourceEditor path={current.path} value={current.content} readOnly onChange={() => {}} onDownload={() => downloadFile(current.path)} /></> : <Empty title="World model output not found" detail="Run singularity-flow wm build to generate repository-grounded Markdown and evidence." />}</main>
    {modal && <DesignerModal title="Add world-model view" detail="Use a stable lower-case kebab-case ID. Once referenced by a stage, persona, rule, or prompt, the view is protected from deletion." submitLabel="Add view" error={modal.error} onCancel={() => setModal(null)} onSubmit={submitView}><label><span>View ID</span><input autoFocus value={modal.id} placeholder="data-governance" onChange={(event) => setModal({ ...modal, id: event.target.value, error: null })} /></label></DesignerModal>}
  </div>;
}

function AgentWorkbench({ data, action }) {
  const repository = data.repository.root;
  const [status, setStatus] = useState(null);
  const [selectedAgent, setSelectedAgent] = useState('copilot');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const next = await window.singularity.agentWorkbenchStatus(repository);
      setStatus(next);
      const available = next.agents.find((agent) => agent.available !== false);
      setSelectedAgent((current) => next.agents.some((agent) => agent.id === current && agent.available !== false)
        ? current
        : available?.id ?? next.agents[0]?.id ?? 'copilot');
    } catch (caught) {
      setError(caught?.message || String(caught));
    } finally {
      setLoading(false);
    }
  }, [repository]);

  useEffect(() => { void refresh(); }, [refresh]);

  const agents = status?.agents ?? [];
  const selected = agents.find((agent) => agent.id === selectedAgent);
  const workspaceSessions = (status?.sessions ?? []).filter((session) => session.cwd === repository);
  const initiative = data.initiative;
  const workflow = data.workflow;
  const work = initiative ? {
    kind: 'epic',
    id: initiative.state.initiative.id,
    title: initiative.state.initiative.title,
    phase: initiative.state.currentPhase,
    status: initiative.state.status,
    progress: initiative.progress?.percentage ?? null,
    parentId: null
  } : workflow ? {
    kind: 'story',
    id: workflow.workItem.id,
    title: workflow.workItem.title,
    phase: workflow.currentPhase,
    status: workflow.status,
    progress: data.progress?.percentage ?? null,
    parentId: workflow.workItem.parentStoryId ?? workflow.workItem.epicId ?? null
  } : {
    kind: 'repository',
    id: null,
    title: repository.split('/').at(-1),
    phase: null,
    status: null,
    progress: null,
    parentId: null
  };
  const flowContext = {
    version: 1,
    generatedAt: new Date().toISOString(),
    workspace: {
      id: data.workspace?.workspace?.id ?? null,
      name: data.workspace?.workspace?.name ?? repository.split('/').at(-1),
      path: data.workspace?.workspace?.path ?? null
    },
    repository: {
      id: null,
      name: repository.split('/').at(-1),
      root: repository,
      branch: data.repository.branch,
      role: data.workspace ? 'lead' : 'standalone'
    },
    work,
    persona: data.session?.persona ?? null,
    documents: (initiative?.documents ?? data.documents ?? []).slice(0, 50).map((document) => ({
      id: document.id ?? document.path,
      label: document.label ?? document.title ?? document.path?.split('/').at(-1) ?? 'Document',
      phase: document.phase ?? null,
      path: document.path,
      status: document.status ?? null
    })).filter((document) => document.path),
    nextActions: (initiative?.nextActions ?? []).slice(0, 10).map((item) => ({
      label: item.reason ?? item.action,
      command: item.command ?? null
    })),
    revision: data.repository.commit ?? data.repository.head ?? null
  };

  async function openWorkbench() {
    const result = await action(
      () => window.singularity.openAgentWorkbench(repository, selectedAgent, flowContext),
      `${selected?.name ?? 'Agent'} opened in Event Horizon`
    );
    if (result) await refresh();
  }

  return <section className="agent-workbench-page">
    <header className="agent-workbench-hero">
      <div className="event-horizon-mark" aria-hidden="true"><span /></div>
      <div>
        <span className="eyebrow">Singularity agent runtime</span>
        <h1>Event Horizon</h1>
        <p>Work with Copilot or another ACP-compatible coding agent in a permission-gated desktop session. Every command, edit, diff, question, and approval stays visible in the transcript.</p>
      </div>
      <Pill tone="accent">Bundled with Flow</Pill>
    </header>

    <div className="agent-workbench-grid">
      <section className="panel agent-launch-panel">
        <header className="panel-heading">
          <div><span className="eyebrow">Current project context</span><h2>Open this repository in an agent session</h2><p>Flow passes the active repository to Event Horizon. The workbench does not change Epic approvals or advance governed phases by itself.</p></div>
          <Pill tone={workspaceSessions.length ? 'good' : 'neutral'}>{workspaceSessions.length} session{workspaceSessions.length === 1 ? '' : 's'}</Pill>
        </header>
        <div className="agent-workbench-repository">
          <span className="agent-repository-icon">{repository.split('/').at(-1)?.slice(0, 1).toUpperCase()}</span>
          <div><strong>{repository.split('/').at(-1)}</strong><small>{repository}</small></div>
        </div>
        {loading ? <div className="agent-workbench-loading">Discovering ACP agents on this computer…</div> : error ? <div className="notice bad">{error}</div> : <>
          <label className="agent-workbench-picker">
            <span>Agent</span>
            <select value={selectedAgent} onChange={(event) => setSelectedAgent(event.target.value)}>
              {agents.map((agent) => <option key={agent.id} value={agent.id} disabled={agent.available === false}>{agent.name}{agent.available === false ? ' — not installed' : ''}</option>)}
            </select>
          </label>
          <div className="agent-runtime-list">
            {agents.map((agent) => <div className={agent.id === selectedAgent ? 'selected' : ''} key={agent.id}>
              <i className={agent.available === false ? 'offline' : 'online'} />
              <span><strong>{agent.name}</strong><small>{agent.available === false ? `Install ${agent.command} to enable this runtime` : `${agent.command} ${agent.args.join(' ')}`}</small></span>
              <Pill tone={agent.available === false ? 'neutral' : 'good'}>{agent.available === false ? 'Unavailable' : 'Ready'}</Pill>
            </div>)}
          </div>
          <div className="agent-workbench-actions">
            <button className="secondary" onClick={refresh}>Refresh agents</button>
            <button className="primary" disabled={!selected || selected.available === false} onClick={openWorkbench}>Open Event Horizon</button>
          </div>
        </>}
      </section>

      <aside className="agent-workbench-capabilities">
        {[
          ['Permission gates', 'Approve or deny every shell command and file operation inline.'],
          ['Live agent controls', 'Switch model, mode, and reasoning effort when the selected agent advertises them.'],
          ['Flow skills', 'Repository, user, and installed-plugin skills appear in slash completion.'],
          ['Rich evidence', 'See streaming reasoning, tool output, plans, attachments, diffs, context, and token usage.']
        ].map(([title, detail], index) => <article key={title}><span>{String(index + 1).padStart(2, '0')}</span><div><h3>{title}</h3><p>{detail}</p></div></article>)}
      </aside>
    </div>

    <footer className="agent-workbench-boundary">
      <strong>Governance boundary</strong>
      <span>Event Horizon is an execution surface. Singularity Flow remains the source of truth for artifacts, lineage, publication, approvals, and phase progress.</span>
    </footer>
  </section>;
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

function InitiativeDocuments({ data, downloadFile }) {
  const documents = data.initiative?.documents ?? [];
  const [query, setQuery] = useState('');
  const [phase, setPhase] = useState('all');
  const phases = data.initiative?.state.phaseOrder ?? [];
  const visible = documents.filter((document) => {
    const matchesPhase = phase === 'all' || document.phase === phase;
    const text = `${document.label} ${document.id} ${document.phase} ${artifactPath(document)} ${document.status}`.toLowerCase();
    return matchesPhase && text.includes(query.trim().toLowerCase());
  });
  const generated = documents.filter((document) => document.status !== 'not_generated' && (document.sha256 || document.content != null));
  const approved = generated.filter((document) => document.status === 'approved');
  const { openArtifact, artifactViewer } = useArtifactViewer({ repository: data.repository.root, downloadFile });
  return <div className="page initiative-document-library">
    <header className="page-heading row-between"><div><span className="eyebrow">Governed document center</span><h1>Epic artifacts</h1><p>Read every generated Markdown, JSON, YAML, image, and report across the Epic lifecycle from one place.</p></div><div className="row"><Pill tone="good">{generated.length} generated</Pill><Pill>{approved.length} approved</Pill></div></header>
    <section className="initiative-document-toolbar panel">
      <label><span>Search artifacts</span><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Name, phase, status, or repository path…" /></label>
      <label><span>Phase</span><select value={phase} onChange={(event) => setPhase(event.target.value)}><option value="all">All phases</option>{phases.map((id) => <option key={id} value={id}>{data.initiative.state.phases[id]?.label ?? id}</option>)}</select></label>
      <div><span>Visible</span><strong>{visible.length}</strong><small>of {documents.length} configured outputs</small></div>
    </section>
    <div className="initiative-document-groups">
      {(phase === 'all' ? phases : [phase]).map((phaseId) => {
        const phaseDocuments = visible.filter((document) => document.phase === phaseId);
        if (!phaseDocuments.length) return null;
        const phaseState = data.initiative.state.phases[phaseId];
        return <section className="panel initiative-document-group" key={phaseId}>
          <header className="panel-heading"><div><span className="eyebrow">{phaseId}</span><h2>{phaseState?.label ?? phaseId}</h2></div><Pill tone={phaseState?.status === 'approved' ? 'good' : 'neutral'}>{phaseState?.status?.replaceAll('_', ' ') ?? 'not started'}</Pill></header>
          <div>{phaseDocuments.map((document) => <button type="button" className={document.status === 'not_generated' ? 'initiative-document-card pending' : 'initiative-document-card'} key={`${document.phase}:${document.id}`} onClick={() => openArtifact(document)}>
            <span className={`artifact-reader-icon ${artifactFormat(document)}`}>{kindTag(document.path ?? document.kind)}</span>
            <span className="initiative-document-card-copy"><small>{document.id} · generation {document.generation ?? 0}</small><strong>{document.label}</strong><code>{artifactPath(document) ?? 'not written yet'}</code></span>
            <span className="initiative-document-card-meta"><Pill tone={document.status === 'approved' ? 'good' : document.status === 'not_generated' ? 'neutral' : 'accent'}>{businessStatusLabel(document.status)}</Pill><small>{document.sha256 ? `${document.sha256.slice(0, 12)} · ${document.bytes ? formatBytes(document.bytes) : 'hash-bound'}` : 'awaiting generation'}</small><em>Open artifact →</em></span>
          </button>)}</div>
        </section>;
      })}
      {!visible.length && <Empty title="No matching artifacts" detail={documents.length ? 'Change the search or phase filter to see other configured outputs.' : 'This Epic has no configured artifacts yet.'} />}
    </div>
    {artifactViewer}
  </div>;
}

function Documents({ data, action, reload, downloadFile, focusDocumentId = null }) {
  const [url, setUrl] = useState('');
  const [label, setLabel] = useState('');
  const [preview, setPreview] = useState(null);
  const [lightbox, setLightbox] = useState(null);
  const [selectedId, setSelectedId] = useState(data.documents[0]?.id ?? '');
  const [openingId, setOpeningId] = useState(null);
  const storageProviders = Object.entries(data.definition?.storage?.providers ?? {}).filter(([, item]) => item.type === 'sharepoint');
  const [remoteProvider, setRemoteProvider] = useState(storageProviders[0]?.[0] ?? '');
  const [remoteEntries, setRemoteEntries] = useState(null);
  const handledFocus = useRef(null);
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
  useEffect(() => {
    if (!focusDocumentId || handledFocus.current === focusDocumentId) return;
    const record = data.documents.find((item) => item.id === focusDocumentId);
    if (!record) return;
    handledFocus.current = focusDocumentId;
    void inspect(record);
  }, [focusDocumentId, data.documents, data.selectedWorkId]);
  async function selectPersona(event) { await action(() => window.singularity.selectPersona(data.repository.root, data.selectedWorkId, event.target.value), 'Persona selected'); await reload(); }
  async function upload() { const result = await action(() => window.singularity.uploadDocuments(data.repository.root), 'Documents uploaded'); if (result && !result.canceled) await reload(); }
  async function uploadDirectory() { const result = await action(() => window.singularity.uploadDocumentDirectory(data.repository.root), 'Design package imported and indexed'); if (result && !result.canceled) await reload(); }
  async function addUrl() { if (!url.trim()) return; await action(() => window.singularity.addDocumentUrl(data.repository.root, url.trim(), label.trim()), 'Document link added'); setUrl(''); setLabel(''); await reload(); }
  async function connectOneDrive() { await action(() => window.singularity.connectDocumentSharePoint(data.repository.root, remoteProvider), 'OneDrive connected through delegated OAuth'); }
  async function browseOneDrive() { const result = await action(() => window.singularity.listSharePointDocuments(data.repository.root, remoteProvider, '')); if (result) setRemoteEntries(result.entries ?? []); }
  async function fetchOneDrive(entry) { const result = await action(() => window.singularity.fetchSharePointDocument(data.repository.root, remoteProvider, entry.id, entry.name, entry.name), `Fetched ${entry.name} into the work item`); if (result) { setRemoteEntries(null); await reload(); } }
  async function inspect(record) {
    setSelectedId(record.id);
    setPreview(null);
    setOpeningId(record.id);
    const result = await action(() => window.singularity.previewDocument(data.repository.root, data.selectedWorkId, record.id));
    setOpeningId(null);
    if (result) setPreview(result);
  }
  async function openSelected() { await action(() => window.singularity.openDocument(data.repository.root, data.selectedWorkId, selectedRecord)); }
  if (!data.workflow) return <div className="page"><Empty title="Choose a work item" detail="Documents are cataloged per work item and branch." /></div>;
  return <div className="requirement-workspace"><header className="requirement-toolbar"><div><span className="eyebrow">Requirement workspace</span><h1>{data.workflow.workItem.title}</h1><p>{data.workflow.workItem.id} · {data.workflow.workItem.branch}</p></div><div className="session-control"><label>Session persona</label><select value={data.session?.workId === data.selectedWorkId ? data.session.persona : ''} onChange={selectPersona} disabled={!canMutate}><option value="">Choose persona</option>{Object.entries(data.definition.personas).map(([id, persona]) => <option value={id} key={id}>{persona.label}</option>)}</select></div></header>
    {!canMutate && <div className="notice warn">Work item {data.selectedWorkId} is on branch <strong>{activeBranch}</strong>. Resume that branch before uploading documents.</div>}
    <section className="workspace-uploadbar"><button className="primary" onClick={upload} disabled={!canMutate || data.session?.workId !== data.selectedWorkId}>＋ Upload files</button><button className="secondary" onClick={uploadDirectory} disabled={!canMutate || data.session?.workId !== data.selectedWorkId}>Import design folder</button><div className="workspace-url"><input value={url} onChange={(event) => setUrl(event.target.value)} placeholder="Figma or reference URL" disabled={!canMutate} /><input value={label} onChange={(event) => setLabel(event.target.value)} placeholder="Label" disabled={!canMutate} /><button className="secondary" onClick={addUrl} disabled={!canMutate || !url.trim()}>Add</button></div>{storageProviders.length > 0 && <div className="workspace-url"><select value={remoteProvider} onChange={(event) => setRemoteProvider(event.target.value)} disabled={!canMutate}>{storageProviders.map(([id, item]) => <option value={id} key={id}>{id} · {item.type}</option>)}</select><button className="secondary" onClick={connectOneDrive} disabled={!canMutate || !remoteProvider}>Connect OneDrive</button><button className="secondary" onClick={browseOneDrive} disabled={!canMutate || !remoteProvider}>Browse OneDrive</button></div>}</section>
    {remoteEntries && <section className="workspace-onedrive-list panel">{remoteEntries.length ? remoteEntries.map((entry) => <div className="artifact-repository-row" key={entry.id}><div><span className="studio-file-icon">{entry.folder ? 'DIR' : 'DOC'}</span><strong>{entry.name}</strong></div><code>{entry.folder ? 'folder' : `${entry.size ?? 0} bytes`}</code>{!entry.folder && <button className="ghost compact" onClick={() => fetchOneDrive(entry)} disabled={!canMutate || data.session?.workId !== data.selectedWorkId}>Fetch</button>}</div>) : <div className="inline-empty">No items in this OneDrive drive.</div>}</section>}
    <div className="requirement-layout">
      <aside className="requirement-tree">
        <header><span className="eyebrow">Artifacts</span><h2>Repository documents</h2><small>{data.documents.length} registered</small></header>
        {data.progress.phases.map((phase) => { const records = data.documents.filter((record) => record.phase === phase.id); return <section key={phase.id}><div className="tree-phase"><StatusDot status={phase.status} /><strong>{phase.label}</strong><span>{records.length}</span></div>{records.map((record) => <button className={selectedRecord?.id === record.id ? 'active' : ''} key={record.id} onClick={() => inspect(record)}><span className="doc-icon">{record.mimeType?.startsWith('image/') ? 'IMG' : record.type === 'url' ? 'URL' : 'MD'}</span><span><strong>{record.label}</strong><small>{record.kind}</small></span></button>)}</section>; })}
        {data.documents.filter((record) => !record.phase).map((record) => <button className={selectedRecord?.id === record.id ? 'active' : ''} key={record.id} onClick={() => inspect(record)}><span className="doc-icon">DOC</span><span><strong>{record.label}</strong><small>supporting evidence</small></span></button>)}
      </aside>
      <main className="requirement-document">
        {selectedRecord ? <><header><div><span className="eyebrow">{selectedRecord.id}</span><h2>{selectedRecord.label}</h2><p>{selectedRecord.path ?? selectedRecord.url}</p></div><div className="row"><Pill>{selectedRecord.kind}</Pill>{selectedRecord.path && <button className="secondary compact" onClick={() => downloadFile(selectedRecord.path)}>Download</button>}</div></header><PinnedMediaStrip repository={data.repository.root} workId={data.selectedWorkId} records={data.documents} selectedId={selectedRecord.id} onSelect={inspect} />{preview?.record?.id === selectedRecord.id && preview.dataUrl ? <div className="requirement-media-preview"><GovernedMedia record={selectedRecord} preview={preview} onZoom={(record, media) => setLightbox({ record, preview: media })} /></div> : preview?.record?.id === selectedRecord.id && preview.content != null ? <TemplatePreview className="requirement-preview" content={preview.content} /> : preview?.record?.id === selectedRecord.id && selectedRecord.type === 'url' ? <div className="live-design-card"><span className="live-design-mark">↗</span><h3>{selectedRecord.kind === 'figma' ? 'Open in Figma' : 'Open external reference'}</h3><p><strong>Live design — may differ from the pinned intake.</strong> Use committed image exports for approval; open this link only as current-design context.</p><code>{selectedRecord.url}</code><button className="primary" onClick={openSelected}>{selectedRecord.kind === 'figma' ? 'Open in Figma' : 'Open HTTPS link'}</button></div> : preview?.record?.id === selectedRecord.id && preview.previewable === false ? <div className="native-document-card"><span>DOC</span><h3>Use the desktop viewer</h3><p>This governed binary file cannot render safely inside Singularity. Its catalog record was resolved successfully; open it with the operating system’s default application.</p><code>{selectedRecord.sha256?.slice(0, 12)} · {selectedRecord.mimeType}</code><button className="primary" onClick={openSelected}>Open in default app</button></div> : <div className="document-placeholder"><span>{selectedRecord.mimeType?.startsWith('image/') ? 'IMG' : selectedRecord.type === 'url' ? 'URL' : 'MD'}</span><h3>{openingId === selectedRecord.id ? 'Opening governed document…' : 'Open the governed document'}</h3><p>Markdown, source, images, and PDFs preview inside Singularity with their committed SHA. Other binary files use their native viewer.</p><button className="primary" disabled={openingId === selectedRecord.id} onClick={() => inspect(selectedRecord)}>{openingId === selectedRecord.id ? 'Loading…' : 'Open document'}</button></div>}<MediaLightbox item={lightbox} onClose={() => setLightbox(null)} /></> : <Empty title="No documents yet" detail="Upload source material or generate the current phase artifact to populate this workspace." />}
      </main>
      <aside className="requirement-inspector">
        <section><span className="eyebrow">Git status</span><dl><div><dt>Branch</dt><dd>{data.repository.branch}</dd></div><div><dt>Workflow</dt><dd>{data.workflow.status}</dd></div><div><dt>Phase</dt><dd>{selectedRecord?.phase ?? 'supporting'}</dd></div><div><dt>Persona</dt><dd>{data.session?.persona ?? 'not selected'}</dd></div></dl></section>
        <section><span className="eyebrow">Document metadata</span><dl><div><dt>Kind</dt><dd>{selectedRecord?.kind ?? '—'}</dd></div><div><dt>Size</dt><dd>{selectedRecord?.size ? `${Math.ceil(selectedRecord.size / 1024)} KB` : '—'}</dd></div><div><dt>Reference</dt><dd>{selectedRecord?.id ?? '—'}</dd></div><div><dt>SHA-256</dt><dd>{selectedRecord?.sha256?.slice(0, 12) ?? '—'}</dd></div><div><dt>Integrity</dt><dd>{preview?.record?.id === selectedRecord?.id && (preview.integrity === 'verified' || preview.binary === false) ? 'matches record ✓' : 'verify on preview'}</dd></div></dl></section>
        <section className="document-outline"><span className="eyebrow">Outline</span>{headings.length ? headings.map((heading, index) => <span style={{ paddingLeft: `${(heading.depth - 1) * 12}px` }} key={`${heading.label}:${index}`}>{heading.label}</span>) : <p>Open a Markdown artifact to see its governed section outline.</p>}</section>
      </aside>
    </div>
    <div className="workspace-command"><span className="ai-orb">✦</span><div><strong>Continue in Copilot CLI</strong><small>The skill loads this requirement with its complete governed context.</small></div><code>/sflow-next</code></div>
  </div>;
}

export default function App() {
  const [data, setData] = useState(null);
  const [workspaceDraft, setWorkspaceDraft] = useState(null);
  const [onboarding, setOnboarding] = useState(null);
  const [onboardingLoading, setOnboardingLoading] = useState(true);
  const [onboardingError, setOnboardingError] = useState(null);
  const [onboardingAttempt, setOnboardingAttempt] = useState(0);
  const [page, setPage] = useState('dashboard');
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState(null);
  const [standaloneHelp, setStandaloneHelp] = useState(false);
  const [standaloneHowItWorks, setStandaloneHowItWorks] = useState(false);
  const [recentWorkspaces, setRecentWorkspaces] = useState([]);
  const [repositoryMenu, setRepositoryMenu] = useState(false);
  const [worldModelRun, setWorldModelRun] = useState(null);
  // Which phase a Copilot CLI handoff should explain.
  const [planningFocus, setPlanningFocus] = useState(null);
  // 'new' when the user asked for a fresh Epic while inside an Epic workspace.
  const [epicIntent, setEpicIntent] = useState(null);
  const [jiraSetupOpen, setJiraSetupOpen] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => window.localStorage.getItem('singularity.sidebar.collapsed') === 'true');
  const [editor, setEditor] = useState({ path: '', content: '', original: '', kind: 'workflow' });
  const [focusedDocumentId, setFocusedDocumentId] = useState(null);
  const [screensaverReturnPage, setScreensaverReturnPage] = useState('dashboard');
  const [showStartupIntro, setShowStartupIntro] = useState(true);
  const dismissStartupIntro = useCallback(() => setShowStartupIntro(false), []);

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
    const openJiraSetup = () => setJiraSetupOpen(true);
    window.addEventListener('singularity:setup-jira', openJiraSetup);
    return () => window.removeEventListener('singularity:setup-jira', openJiraSetup);
  }, []);
  useEffect(() => {
    if (!window.singularity?.onWorldModelProgress) return undefined;
    return window.singularity.onWorldModelProgress((event) => {
      if (!event || (event.repository && data?.repository?.root && event.repository !== data.repository.root)) return;
      setWorldModelRun((current) => {
        if (!current) return current;
        const now = Date.now();
        const next = { ...current, phase: event.phase ?? current.phase, phaseLabel: event.message ?? current.phaseLabel };
        if (event.type === 'output' && event.message) next.logs = [...current.logs, { time: now, message: event.message }].slice(-80);
        if (event.type === 'phase' && event.message) next.logs = [...current.logs, { time: now, message: event.message }].slice(-80);
        if (event.type === 'phase' && event.phase && !next.steps.includes(event.phase)) next.steps = [...next.steps, event.phase];
        if (event.type === 'complete') { next.status = 'success'; next.phase = 'complete'; next.phaseLabel = event.message || 'World model generated and committed'; next.finishedAt = now; next.steps = [...new Set([...next.steps, 'complete'])]; }
        if (event.type === 'error') { next.status = 'error'; next.phase = 'error'; next.phaseLabel = 'Build failed'; next.error = event.message; next.finishedAt = now; next.logs = [...current.logs, { time: now, message: event.message }].slice(-80); }
        return next;
      });
    });
  }, [data?.repository?.root]);
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
  const initiativeProfile = data?.initiative?.state?.initiative?.profile ?? null;
  const currentInitiativePhaseId = data?.initiative?.state?.currentPhase
    ?? data?.initiative?.state?.phaseOrder?.at(-1)
    ?? null;
  const currentInitiativePhaseLabel = data?.initiative?.state?.resolution?.phases
    ?.find((phase) => phase.id === currentInitiativePhaseId)?.label
    ?? currentInitiativePhaseId
    ?? 'Current phase';
  const navigationSections = useMemo(() => {
    if (!data?.initiative || initiativeProfile === 'epic-planning') return navSections;
    // Requirements, Planning and Create Stories are contracts of the compact Epic-planning
    // profile. Showing them for enterprise initiatives routed the user to phase IDs that do not
    // exist. Enterprise profiles expose their resolved current phase instead.
    return navSections.map((section) => section.label !== 'Epic planning'
      ? section
      : {
          label: 'Initiative delivery',
          items: [
            ['epics', 'Initiative overview'],
            ['business-requirements', `${currentInitiativePhaseLabel} workspace`],
            ['templates', 'Artifact templates']
          ]
        });
  }, [data?.initiative, initiativeProfile, currentInitiativePhaseLabel]);
  const activeNavigation = useMemo(() => navigationSections
    .flatMap((section) => section.items.map(([id, label]) => ({ id, label, section: section.label })))
    .find((item) => item.id === page)
    // The phase workspace is reached from the journey rail, not the sidebar, so it names itself
    // after the phase it is showing rather than reading 'Workspace'.
    ?? (page === 'phase' && planningFocus?.phase
      ? { id: page, label: data?.initiative?.state.phases?.[planningFocus.phase]?.label ?? planningFocus.phase, section: data?.initiative?.state.initiative.id ?? 'Epic phase' }
      : { id: page, label: 'Workspace', section: 'Singularity' }), [page, planningFocus, data?.initiative, navigationSections]);
  const configurationChanges = data?.repository.configurationChanges ?? [];
  const unrelatedChanges = data?.repository.unrelatedChanges ?? [];
  const publishReady = data?.repository.publishReady === true;
  const publishHint = !configurationChanges.length ? 'No workflow, template, persona, prompt, skill, or agent changes are ready to publish.' : unrelatedChanges.length ? `Blocked by ${unrelatedChanges.length} non-configuration working-tree change(s).` : 'Commit and push desktop configuration changes.';
  async function action(task, success) { setBusy(true); setToast(null); try { const result = await task(); if (success && result != null) setToast({ tone: 'good', text: success }); return result; } catch (error) { setToast({ tone: 'bad', text: error?.message || String(error) }); return null; } finally { setBusy(false); } }
  async function resetAllJiraCredentials() {
    if (!window.confirm('Reset every saved Jira connection for this OS account? Workspace routing and Git state will not be changed.')) return;
    setRepositoryMenu(false);
    const result = await action(
      () => window.singularity.resetJiraCredentials(data.repository.root),
      'All saved Jira credentials were reset'
    );
    if (result) setJiraSetupOpen(true);
  }
  async function refreshRecentWorkspaces() {
    try { const items = await window.singularity.recentWorkspaces(); setRecentWorkspaces(items); return items; }
    catch (error) { setToast({ tone: 'bad', text: `Could not load recent workspaces: ${error.message}` }); return []; }
  }
  function acceptOpened(result, nextPage = null) {
    if (!result?.repository) {
      setWorkspaceDraft(result);
      setRepositoryMenu(false);
      if (nextPage) setPage(nextPage);
      return;
    }
    setWorkspaceDraft(null);
    setData(result);
    setEditor({ path: result.definitionPath, content: result.definitionText, original: result.definitionText, kind: 'workflow' });
    setRepositoryMenu(false);
    if (nextPage) setPage(nextPage);
  }
  async function openWorkspace(workspacePath = null) {
    const result = await action(() => workspacePath ? window.singularity.openWorkspace(workspacePath) : window.singularity.chooseWorkspace());
    if (!result) return;
    acceptOpened(result, workspaceLandingPage(result));
    await refreshRecentWorkspaces();
    if (result.workspaceSetup?.message) setToast({ tone: 'good', text: result.workspaceSetup.message });
  }
  function openRequirementWorkspace(document = null) {
    if (!data?.workflow) {
      setPage('documents');
      return;
    }
    setFocusedDocumentId(document?.id ?? null);
    setPage('documents');
  }
  async function completeOnboarding(result) {
    setOnboarding(result);
    await refreshRecentWorkspaces();
    if (result.profile.workspacePath) await openWorkspace(result.profile.workspacePath);
    if (result.notices?.length) {
      setToast({ tone: 'warning', text: result.notices.map((notice) => notice.message).join(' ') });
    }
  }
  async function forgetWorkspace(event, workspacePath) {
    event.stopPropagation();
    const items = await action(() => window.singularity.forgetWorkspace(workspacePath), 'Workspace forgotten; no local files were deleted');
    if (items) setRecentWorkspaces(items);
  }
  async function archiveWorkspace(workspacePath, confirmation) {
    const items = await action(
      () => window.singularity.archiveWorkspace(workspacePath, confirmation),
      'Workspace archived locally; no folders, repositories, documents, or Git history were deleted'
    );
    if (!items) return null;
    setRecentWorkspaces(items);
    setWorkspaceDraft(null);
    setData(null);
    setPage('epics');
    return items;
  }
  async function restoreWorkspace(workspacePath) {
    const items = await action(
      () => window.singularity.restoreWorkspace(workspacePath),
      'Workspace restored to active selection'
    );
    if (items) setRecentWorkspaces(items);
    return items;
  }
  async function reload(workId = data?.selectedWorkId, initiativeId = data?.selectedInitiativeId) { if (!data) return null; const result = await action(() => window.singularity.snapshot(data.repository.root, workId, initiativeId)); if (result) setData(result); return result; }
  async function refreshInbox() { const result = await action(() => window.singularity.refreshInbox(data.repository.root), 'Remote approval inbox refreshed'); if (result) setData(result); return result; }
  async function attachInboxItem(workId) { const result = await action(() => window.singularity.attachInboxItem(data.repository.root, workId), `Attached to ${workId} at the latest remote commit`); if (result) { setData(result); setPage('review'); } return result; }
  async function selectWorkItem(event) { await reload(event.target.value || null); }
  async function selectInitiative(event) {
    const initiativeId = event.target.value || null;
    const result = initiativeId
      ? await action(() => window.singularity.openInitiative(data.repository.root, initiativeId))
      : await reload(null, null);
    if (result) setData(result);
    if (result && initiativeId) setToast(result.repository.openMode === 'local-edits'
      ? { tone: 'warn', text: result.repository.openMessage }
      : { tone: 'good', text: `Opened latest ${initiativeId} branch` });
    if (result && initiativeId) setPage('epics');
  }
  async function openEpic(initiativeId) {
    const result = await action(
      () => window.singularity.openInitiative(data.repository.root, initiativeId)
    );
    if (result) setData(result);
    if (result) setToast(result.repository.openMode === 'local-edits'
      ? { tone: 'warn', text: result.repository.openMessage }
      : { tone: 'good', text: `Opened latest ${initiativeId} branch` });
    if (result) setPage('epics');
  }
  function openEpicJourneyStage(stage) {
    const pageForStage = {
      intake: 'epics',
      requirements: 'business-requirements',
      planning: 'business-planning',
      stories: 'business-stories',
      complete: 'epics'
    }[stage] ?? 'epics';
    setPage(pageForStage);
  }
  // The single place journey actions that are not phase transitions are handled. Anything
  // unrecognised is reported rather than absorbed: the previous fallback navigated to the stage the
  // user was already on, so an unmapped action produced a clickable button that changed nothing and
  // left no trace.
  function continueEpicJourney(next) {
    const actionId = normalizeNextActionId(next?.id ?? next?.action);
    if (actionId === NEXT_ACTIONS.MATERIALIZE) return setPage('business-stories');
    if (actionId === NEXT_ACTIONS.REPORT) return setPage('epics');
    if (actionId === NEXT_ACTIONS.SOURCES) return openEpicJourneyStage('intake');
    if ([NEXT_ACTIONS.AUTHOR, NEXT_ACTIONS.PUBLISH, NEXT_ACTIONS.APPROVE, NEXT_ACTIONS.EVIDENCE].includes(actionId)) {
      const phaseId = next?.phaseId ?? data?.initiative?.state?.currentPhase ?? null;
      if (phaseId) openStudio(phaseId);
      revealPhaseAction(actionId);
      return;
    }
    if (actionId === NEXT_ACTIONS.STATUS || actionId === NEXT_ACTIONS.ADVANCE) {
      return void reload(null, data?.initiative?.state?.initiative?.id ?? null);
    }
    if (actionId === NEXT_ACTIONS.BLOCKED || actionId === NEXT_ACTIONS.COMPLETE) {
      return openEpicJourneyStage(data?.initiative?.journey?.stage ?? 'intake');
    }
    setToast({
      tone: 'bad',
      text: `No action is wired for '${next?.sourceId ?? next?.id ?? 'unknown'}'. Nothing was changed — please report this.`
    });
  }
  async function saveEditor() { const result = await action(() => window.singularity.saveFile(data.repository.root, editor.path, editor.content), `${editor.path} saved and validated`); if (result) { setEditor({ ...editor, original: editor.content }); await reload(); } }
  async function validate() { await action(() => window.singularity.validate(data.repository.root), 'Configuration is valid'); }
  // The message is a parameter because configuration is now publishable from the Epic workspace
  // too, where the branch and the reason for the change are both in front of the reader; a fixed
  // 'Configure Singularity Flow desktop workflow' told the branch history nothing about why.
  async function publish(message) {
    if (!publishReady) return setToast({ tone: 'bad', text: publishHint });
    const subject = typeof message === 'string' && message.trim() ? message.trim() : 'Configure Singularity Flow desktop workflow';
    const result = await action(() => window.singularity.publish(data.repository.root, subject), `Configuration committed and pushed to ${data.repository.branch}`);
    if (result) await reload();
    return result;
  }
  function workflowPage() { setPage('workflow'); setEditor({ path: data.definitionPath, content: data.definitionText, original: data.definitionText, kind: 'workflow' }); }
  function initiativePage() { setPage('initiatives'); if (data.portfolioText) setEditor({ path: data.portfolioPath, content: data.portfolioText, original: data.portfolioText, kind: 'portfolio' }); }
  // Open Copilot Studio already framed on the phase the caller was working in. Without this the
  // studio defaults to the current phase and its first output, so a hand-off from Requirements
  // could compose against Intake and promote the result into the wrong artifact.
  // Clear the selected Epic so the Epics page shows the list again. `intent` of 'new' asks
  // EpicsHome to open the start wizard directly rather than the list.
  function showAllEpics(intent = null) {
    setEpicIntent(intent);
    setData((current) => ({ ...current, initiative: null, selectedInitiativeId: null }));
    setPage('epics');
  }
  function openStudio(phase = null, target = null) {
    setPlanningFocus(phase ? { phase, target } : null);
    if (data?.initiative) {
      // Requirements, Planning and Create Stories are pages *about the Epic-planning phases* —
      // EpicPlanningPage is hard-wired to epic-planning, down to its heading and its 'locked until
      // Requirements is approved' notice. Sending another profile's phase there opened Planning
      // for a phase the Epic does not have. Those phases get the generic phase workspace instead.
      const epicPage = phase === 'epic-planning'
        ? 'business-planning'
        : phase === 'epic-requirements'
          ? 'business-requirements'
          : phase === 'epic-publish'
            ? 'business-stories'
            : null;
      // Everything else opens the workspace for that phase. Falling back to business-planning for
      // any unmapped epic- phase is why 'Compose in Copilot Studio' on the Epic intake panel opened
      // Planning: epic-intake has no dedicated page, and the fallback was a page about epic-planning.
      setPage(epicPage ?? (phase ? 'phase' : 'business-planning'));
      return;
    }
    // Legacy story workflows still have a planning surface, but it is no longer exposed as a
    // primary Epic destination. Existing deep links continue to work for those work items.
    setPage('planning');
  }
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
  async function createTemplate(name, suppliedContent = null) {
    const content = suppliedContent ?? '# {{work.id}} — {{phase.label}}\n\n## Purpose\n\nDescribe the artifact outcome.\n\n{{inputs}}\n\n## Evidence\n\nAdd traceable evidence here.\n';
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
    const file = data.personaPrompts[0] ?? data.worldModelPrompt ?? data.flowSkills?.[0] ?? data.repositorySkills[0];
    if (file) chooseResource(file, data.repositorySkills.includes(file) ? 'skill' : data.flowSkills?.includes(file) ? 'flow-skill' : 'prompt');
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
  async function customizeFlowSkill(skill) {
    if (!skill?.id || !skill?.content) return null;
    let skillPath;
    try { skillPath = repositorySkillPath(skill.id); }
    catch (error) { setToast({ tone: 'bad', text: error.message }); return null; }
    const existing = data.repositorySkills.find((item) => item.path === skillPath);
    if (existing) {
      chooseResource(existing, 'skill');
      return existing;
    }
    const result = await action(
      () => window.singularity.saveFile(data.repository.root, skillPath, skill.content),
      `${skill.command} is now customized for this repository`
    );
    if (!result) return null;
    const snapshot = await reload();
    const file = snapshot?.repositorySkills.find((item) => item.path === skillPath);
    if (file) chooseResource(file, 'skill');
    return file ?? result;
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
  /**
   * The views this repository's phases actually consume, plus any already built.
   *
   * `wm build` with no --views falls back to `views: auto`, which routes to core plus development.
   * A rebuild from the offer card therefore *replaced* a five-view model with a one-view one —
   * installWorldModel clears the output directory — and every phase whose persona reads business
   * or architecture then reported the model unavailable. A rebuild must not be able to lose views.
   */
  function requiredWorldModelViews() {
    const fromPersonas = Object.values(data?.definition?.personas ?? {}).flatMap((persona) => persona.worldModelViews ?? []);
    const built = (data?.worldModel?.files ?? [])
      .filter((file) => file.path.includes('/views/'))
      .map((file) => file.path.split('/').pop().replace(/\.md$/, ''));
    return [...new Set([...fromPersonas, ...built])].filter(Boolean);
  }

  async function generateWorldModel(repositoryOrLocal = true, localArgument = undefined, views = null, explicitInitiativeId = null) {
    // Both of these cross the IPC boundary, so both must be primitives. A bare onClick hands this
    // function a React event as its first argument; that used to land in `local` and fail
    // structured clone with 'An object could not be cloned.' — a message that says nothing about
    // the button that was pressed, reported as a world-model build failure at 0m00s.
    const repository = typeof repositoryOrLocal === 'string' ? repositoryOrLocal : data?.repository?.root;
    const local = typeof repositoryOrLocal === 'string'
      ? (typeof localArgument === 'boolean' ? localArgument : true)
      : (typeof repositoryOrLocal === 'boolean' ? repositoryOrLocal : true);
    if (!repository || worldModelRun?.status === 'running') return null;
    // An explicit choice wins; otherwise never build fewer views than the repository already has.
    const requested = views?.length ? views : requiredWorldModelViews();
    const prompt = data.worldModelPrompt ?? {};
    const startedAt = Date.now();
    setWorldModelRun({
      status: 'running',
      phase: 'starting',
      phaseLabel: requested.length ? `Building ${requested.length} view${requested.length === 1 ? '' : 's'}: ${requested.join(', ')}` : 'Preparing the governed world-model prompt',
      repository,
      promptPath: prompt.path ?? 'singularity/prompts/worldmodel-builder.md',
      prompt: prompt.content ?? '',
      local,
      startedAt,
      steps: [],
      logs: []
    });
    setBusy(true);
    setToast(null);
    try {
      const initiativeId = explicitInitiativeId ?? data?.selectedInitiativeId ?? data?.initiative?.state?.initiative?.id ?? null;
      const result = await window.singularity.generateWorldModel(repository, local, requested, initiativeId);
      setWorldModelRun((current) => current ? { ...current, status: 'success', phase: 'complete', phaseLabel: local ? 'World model committed locally' : 'World model committed and pushed', finishedAt: Date.now(), steps: [...new Set([...(current.steps ?? []), 'complete'])] } : current);
      setToast({ tone: 'good', text: local ? 'World model generated and committed locally (not pushed)' : 'World model generated and pushed with the Story branch' });
      await reload();
      return result;
    } catch (error) {
      setWorldModelRun((current) => current ? { ...current, status: 'error', phase: 'error', phaseLabel: 'World-model build failed', error: error?.message || String(error), finishedAt: Date.now() } : current);
      setToast({ tone: 'bad', text: error?.message || String(error) });
      return null;
    } finally { setBusy(false); }
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
  function openScreensaver() {
    setScreensaverReturnPage(page === 'screensaver' ? screensaverReturnPage : page);
    setPage('screensaver');
  }
  function closeScreensaver() {
    setPage(data ? screensaverReturnPage : 'dashboard');
  }

  if (showStartupIntro) return <StartupIntro onDone={dismissStartupIntro} />;
  if (onboardingLoading) return <div className="onboarding-loading"><FlowBrand className="brand large flow-brand-welcome" context="Preparing desktop setup" /><span className="onboarding-loading-orb">✦</span></div>;
  if (!data && standaloneHowItWorks) return <div className="standalone-guide"><button className="ghost help-back" onClick={() => setStandaloneHowItWorks(false)}>← Back</button><HowItWorks onDocumentation={() => { setStandaloneHowItWorks(false); setStandaloneHelp(true); }} /></div>;
  if (!data && standaloneHelp) return <div className="standalone-help"><button className="ghost help-back" onClick={() => setStandaloneHelp(false)}>← Back</button><Help /></div>;
  if (onboardingError) return <OnboardingLoadFailure error={onboardingError} retry={() => setOnboardingAttempt((current) => current + 1)} help={() => setStandaloneHelp(true)} />;
  if (!onboarding?.profile?.completed) return <><OnboardingWizard initial={onboarding.profile} jira={onboarding.jira} onComplete={completeOnboarding} onHelp={() => setStandaloneHelp(true)} /><Toast toast={toast} onClose={() => setToast(null)} /></>;
  if (page === 'screensaver') return <Screensaver onExit={closeScreensaver} />;
  if (!data && workspaceDraft) return <div className="standalone-workspace">
    <header className="welcome-nav">
      <FlowBrand className="brand large flow-brand-welcome" context="Workspace setup" />
      <nav><button className="ghost" onClick={() => setWorkspaceDraft(null)} disabled={busy}>← Back</button><button onClick={() => setStandaloneHelp(true)}>Documentation</button></nav>
    </header>
    <main className="standalone-workspace-main">
      <WorkspaceStudio
        data={workspaceDraft}
        action={action}
        defaultBaseDirectory={workspaceDraft.workspaceSetup?.baseDirectory ?? onboarding?.profile?.workspacePath ?? ''}
        recentWorkspaces={recentWorkspaces}
        onOpenWorkspace={openWorkspace}
        onForgetWorkspace={forgetWorkspace}
        onArchiveWorkspace={archiveWorkspace}
        onRestoreWorkspace={restoreWorkspace}
        onSetupJira={() => setToast({ tone: 'warning', text: 'Save the workspace and initialize its lead repository before configuring Jira.' })}
        onOpened={(result, nextPage) => { acceptOpened(result, nextPage); void refreshRecentWorkspaces(); }}
      />
    </main>
    <Toast toast={toast} onClose={() => setToast(null)} />
  </div>;
  if (!data) return <div className={`welcome ${busy ? 'busy' : ''}`}>
    <header className="welcome-nav">
      <FlowBrand className="brand large flow-brand-welcome" context="Git-native delivery" />
      <nav><button onClick={openScreensaver}>Screensaver</button><button onClick={() => setStandaloneHowItWorks(true)}>How it works</button><button onClick={() => setStandaloneHelp(true)}>Documentation</button><button className="primary" onClick={() => openWorkspace()} disabled={busy}>Open workspace</button></nav>
    </header>
    <main className="welcome-hero">
      <section>
        <Pill tone="accent">Plan · govern · deliver</Pill>
        <h1>Start with your<br /><em>Epic and requirements.</em></h1>
        <p>Open a project workspace, bring in the Epic and source documents, then move through requirements, Story planning, specification, and governed publication. The workspace carries every repository and its Jira routing.</p>
        <div className="welcome-actions"><button className="primary large-button" onClick={() => openWorkspace()} disabled={busy}>{busy ? 'Opening workspace…' : 'Open project workspace'}</button><button className="ghost large-button" onClick={() => setStandaloneHowItWorks(true)} disabled={busy}>See the workflow</button></div>
        <details className="welcome-advanced">
          <summary><span><strong>Workspace configuration</strong><small>Local directory · repositories · Jira boards · App IDs</small></span><b>＋</b></summary>
          <div><p>Create an isolated project workspace with exactly one lead Git repository for Epic artifacts. Repository-specific Jira routing and metadata are configured together.</p><button className="secondary" onClick={() => openWorkspace()} disabled={busy}>Open or create workspace</button></div>
        </details>
        {busy && <p className="opening-state" role="status">Opening the selected project context…</p>}
      </section>
      <section className="welcome-visual" aria-label="Singularity Flow workflow preview"><div className="visual-glow" /><div className="visual-window"><header><span>SINGULARITY · FLOW</span><i /><i /><i /></header><div className="visual-body"><aside><span className="active">Epic intake</span><span>Requirements</span><span>Story plan</span><span>Specification</span></aside><main><span className="eyebrow">Governed planning</span><h3>Epic to approved Stories</h3><div className="visual-flow"><b className="done">✓</b><i /><b className="done">✓</b><i /><b>3</b><i /><b>4</b></div><div className="visual-cards"><span /><span /><span /></div></main></div></div></section>
    </main>
    <section className="welcome-recent"><RecentWorkspaces items={recentWorkspaces} busy={busy} onOpen={openWorkspace} onForget={forgetWorkspace} /><ArchivedWorkspaces items={recentWorkspaces} busy={busy} onRestore={restoreWorkspace} /></section>
    <Toast toast={toast} onClose={() => setToast(null)} />
  </div>;
  return <div className={`shell ${sidebarCollapsed ? 'sidebar-collapsed' : ''}`}>
    <aside className="sidebar"><FlowBrand className="brand flow-brand-sidebar" context={data.workspace ? data.workspace.workspace.anchor.key : 'Workspace'} /><button className="sidebar-edge-toggle" type="button" title={`${sidebarCollapsed ? 'Expand' : 'Collapse'} navigation (⌘/Ctrl+B)`} aria-label={sidebarCollapsed ? 'Expand navigation' : 'Collapse navigation'} aria-expanded={!sidebarCollapsed} aria-controls="primary-navigation" onClick={() => setSidebarCollapsed((current) => !current)}><NavIcon name={sidebarCollapsed ? 'expand' : 'collapse'} /></button><nav id="primary-navigation" aria-label="Primary navigation">{navigationSections.map((section) => <section key={section.label} className={`nav-section nav-section-${section.label.toLowerCase().replaceAll(' ', '-')}`}><span className="nav-section-label">{section.label}</span>{section.items.map(([id, label]) => <button key={id} title={sidebarCollapsed ? label : undefined} aria-label={label} className={page === id ? 'active' : ''} onClick={() => id === 'workflow' ? workflowPage() : id === 'initiatives' ? initiativePage() : id === 'planning' ? openStudio() : id === 'resources' ? resourcesPage() : id === 'agents' ? agentsPage() : id === 'screensaver' ? openScreensaver() : setPage(id)}><i><NavIcon name={id} /></i><span className="nav-label">{label}</span>{id === 'inbox' && data.approvalInbox.count > 0 && <span className="nav-badge">{data.approvalInbox.count}</span>}</button>)}</section>)}</nav><div className="sidebar-bottom"><div className={`connection ${data.repository.changes.length ? 'dirty' : ''}`}><span /><em>{data.repository.changes.length ? `${data.repository.changes.length} uncommitted change(s)` : data.workspace ? `${data.workspace.counts.ready}/${data.workspace.counts.repositories} repositories ready` : 'Workspace required'}</em></div></div></aside>
    <main className="content"><header className="topbar"><div className="topbar-leading"><div className="page-context"><span>{activeNavigation.section}</span><strong>{activeNavigation.label}</strong></div><div className="context-selectors"><select aria-label="Work item" value={data.selectedWorkId ?? ''} onChange={selectWorkItem}><option value="">Story work item</option>{data.workItems.map((item) => <option value={item.id} key={item.id}>{item.id} — {item.title}</option>)}</select>{data.portfolio && <select aria-label="Epic" value={data.selectedInitiativeId ?? ''} onChange={selectInitiative}><option value="">Choose Epic</option>{/* Every Epic, whatever its delivery profile: this selector is how you switch Epics, and filtering it by profile hid started work from the only control that switches to it. */}{data.initiatives.map((item) => <option value={item.id} key={item.id}>{item.id} — {item.title}</option>)}</select>}{data.workflow && <Pill tone="accent">{data.workflow.currentPhase ?? 'complete'}</Pill>}{data.initiative && <Pill tone="accent">{data.initiative.state.currentPhase ?? 'complete'}</Pill>}</div></div><div className="topbar-title" aria-live="polite"><span>{activeNavigation.section}</span><strong>{activeNavigation.label}</strong></div><div className="topbar-actions"><TopbarWorkspace data={data} repoName={repoName} repositoryMenu={repositoryMenu} setRepositoryMenu={setRepositoryMenu} recentWorkspaces={recentWorkspaces} busy={busy} openWorkspace={openWorkspace} onResetJira={resetAllJiraCredentials} /><button className="ghost icon-action" onClick={() => reload()} disabled={busy} title="Refresh workspace"><NavIcon name="refresh" /><span>Refresh</span></button><button className="ghost icon-action" onClick={exportBundle} disabled={busy} title="Download configuration"><NavIcon name="download" /><span>Download config</span></button><button className="secondary icon-action" onClick={validate} disabled={busy}><NavIcon name="validate" /><span>Validate</span></button><button className="primary icon-action" onClick={() => publish()} disabled={busy || !publishReady} title={publishHint}><NavIcon name="publish" /><span>Commit &amp; push</span></button></div></header>
      {data.worldModel?.rebuildReason && page !== 'world-model' && <WorldModelPrompt
        reason={data.worldModel.rebuildReason}
        busy={busy || worldModelRun?.status === 'running'}
        onGenerate={generateWorldModel}
      />}
      <div className={busy ? 'busy view' : 'view'}><div className="page-stage" key={page}>{page === 'epics' && (data.initiative ? <InitiativeStudio publishConfiguration={publish} busy={busy} generateWorldModel={generateWorldModel} openEpic={openEpic} reportProblem={(text) => setToast({ tone: 'bad', text })} onStagePage={openEpicJourneyStage} data={data} editor={editor} setEditor={setEditor} saveEditor={saveEditor} downloadFile={downloadFile} action={action} reload={reload} bootstrapPortfolio={acceptPortfolioBootstrap} openPlanning={openStudio} localRole={onboarding?.profile?.role} onAllEpics={showAllEpics} /> : <EpicsHome data={data} action={action} reload={reload} openEpic={openEpic} generateWorldModel={generateWorldModel} startNew={epicIntent === 'new'} onSetupJira={() => setJiraSetupOpen(true)} />)}{page === 'story-intake' && <JiraStoryIntake data={data} action={action} onStarted={(result) => acceptOpened(result, 'dashboard')} onSetupJira={() => setJiraSetupOpen(true)} />}{page === 'agent-workbench' && <AgentWorkbench data={data} action={action} />}{page === 'business-requirements' && (data.initiative
        ? <PhaseCliWorkspace requestedPhaseId={initiativeProfile === 'epic-planning' ? 'epic-requirements' : currentInitiativePhaseId} data={data} selected={data.initiative} action={action} reload={reload} downloadFile={downloadFile} onJourneyStage={openEpicJourneyStage} onJourneyNext={continueEpicJourney} />
        : <EpicsHome data={data} action={action} reload={reload} openEpic={openEpic} generateWorldModel={generateWorldModel} onSetupJira={() => setJiraSetupOpen(true)} />)}{page === 'phase' && (data.initiative && planningFocus?.phase
        ? <PhaseCliWorkspace requestedPhaseId={planningFocus.phase} data={data} selected={data.initiative} action={action} reload={reload} downloadFile={downloadFile} onJourneyStage={openEpicJourneyStage} onJourneyNext={continueEpicJourney} />
        : <EpicsHome data={data} action={action} reload={reload} openEpic={openEpic} generateWorldModel={generateWorldModel} onSetupJira={() => setJiraSetupOpen(true)} />)}{page === 'business-planning' && (data.initiative
        ? <EpicPlanningCliPage downloadFile={downloadFile} data={data} action={action} reload={reload} />
        : <EpicsHome data={data} action={action} reload={reload} openEpic={openEpic} generateWorldModel={generateWorldModel} onSetupJira={() => setJiraSetupOpen(true)} />)}{page === 'business-stories' && <InitiativeStudio publishConfiguration={publish} busy={busy} generateWorldModel={generateWorldModel} openEpic={openEpic} reportProblem={(text) => setToast({ tone: 'bad', text })} onStagePage={openEpicJourneyStage} data={data} editor={editor} setEditor={setEditor} saveEditor={saveEditor} downloadFile={downloadFile} action={action} reload={reload} bootstrapPortfolio={acceptPortfolioBootstrap} openPlanning={(phase) => openStudio(phase ?? 'epic-publish')} localRole={onboarding?.profile?.role} entryTab="publish" />}{page === 'initiatives' && <InitiativeStudio publishConfiguration={publish} busy={busy} generateWorldModel={generateWorldModel} openEpic={openEpic} reportProblem={(text) => setToast({ tone: 'bad', text })} onStagePage={openEpicJourneyStage} data={data} editor={editor} setEditor={setEditor} saveEditor={saveEditor} downloadFile={downloadFile} action={action} reload={reload} bootstrapPortfolio={acceptPortfolioBootstrap} openPlanning={openStudio} localRole={onboarding?.profile?.role} />}{page === 'dashboard' && <Dashboard data={data} downloadFile={downloadFile} />}{page === 'studio' && <ArtifactStudio data={data} openWorkspace={() => openRequirementWorkspace()} downloadFile={downloadFile} />}{page === 'impact' && <ImpactStudio data={data} openPlanning={openStudio} />}{page === 'workspaces' && <WorkspaceStudio data={data} action={action} defaultBaseDirectory={data.workspaceSetup?.baseDirectory ?? onboarding?.profile?.workspacePath ?? ''} recentWorkspaces={recentWorkspaces} onOpenWorkspace={openWorkspace} onForgetWorkspace={forgetWorkspace} onArchiveWorkspace={archiveWorkspace} onRestoreWorkspace={restoreWorkspace} onSetupJira={() => setJiraSetupOpen(true)} onOpened={(result, nextPage) => { acceptOpened(result, nextPage); void refreshRecentWorkspaces(); }} />}{page === 'session-choices' && <SessionChoices data={data} openPortfolio={initiativePage} openWorkflow={workflowPage} openPersonas={() => setPage('personas')} />}{page === 'planning' && <CopilotCliPage data={data} phaseId={planningFocus?.phase} />}{page === 'inbox' && <ApprovalInbox data={data} busy={busy} refresh={refreshInbox} attach={attachInboxItem} />}{page === 'workflow' && <Workflow data={data} editor={editor} setEditor={setEditor} saveEditor={saveEditor} downloadFile={downloadFile} importWorkflow={importWorkflow} />}{page === 'personas' && <Personas data={data} openPrompt={openPrompt} savePersona={savePersona} createPersonaConfig={createPersonaConfig} deletePersonaConfig={deletePersonaConfig} downloadFile={downloadFile} />}{page === 'templates' && <Templates data={data} editor={editor.kind !== 'template' ? { path: data.templates[0]?.path, content: data.templates[0]?.content ?? '', original: data.templates[0]?.content ?? '', kind: 'template' } : editor} setEditor={setEditor} chooseTemplate={chooseTemplate} saveEditor={saveEditor} createTemplate={createTemplate} deleteTemplate={deleteTemplate} downloadFile={downloadFile} importTemplate={importTemplate} />}{page === 'resources' && <Resources data={data} editor={editor} setEditor={setEditor} chooseResource={chooseResource} saveEditor={saveEditor} createSkill={createSkill} customizeFlowSkill={customizeFlowSkill} deleteFile={deleteFile} downloadFile={downloadFile} importResource={importResource} materializeWorldModelPrompt={materializeWorldModelPrompt} materializePlanningPrompt={materializePlanningPrompt} />}{page === 'agents' && <Agents data={data} editor={editor} setEditor={setEditor} chooseAgent={chooseAgent} saveEditor={saveEditor} createAgent={createAgent} deleteFile={deleteFile} downloadFile={downloadFile} importAgent={importAgent} />}{page === 'world-model' && <WorldModel data={data} editor={editor} setEditor={setEditor} saveEditor={saveEditor} downloadFile={downloadFile} importResource={importResource} materializeWorldModelPrompt={materializeWorldModelPrompt} generateWorldModel={generateWorldModel} addView={addWorldModelViewConfig} removeView={removeWorldModelViewConfig} />}{page === 'review' && <Review data={data} downloadFile={downloadFile} />}{page === 'documents' && (data.initiative ? <InitiativeDocuments data={data} downloadFile={downloadFile} /> : <Documents data={data} action={action} reload={reload} downloadFile={downloadFile} focusDocumentId={focusedDocumentId} />)}{page === 'help' && <Help />}</div></div>
    </main>{jiraSetupOpen && <div className="jira-setup-overlay" role="dialog" aria-modal="true" aria-label="Set up Jira"><JiraWorkspace data={data} action={action} reload={reload} bootstrapPortfolio={acceptPortfolioBootstrap} onConfigure={() => { setJiraSetupOpen(false); initiativePage(); }} onDone={() => setJiraSetupOpen(false)} /></div>}{worldModelRun && <WorldModelRunDialog run={worldModelRun} onClose={() => setWorldModelRun(null)} />}<Toast toast={toast} onClose={() => setToast(null)} />
  </div>;
}
