import React, { useEffect, useMemo, useState } from 'react';
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

const nav = [
  ['dashboard', 'Overview', '⌁'],
  ['initiatives', 'Initiatives', '◈'],
  ['inbox', 'Approval inbox', '◫'],
  ['workflow', 'Workflow', '◇'],
  ['personas', 'Personas & approvals', '◎'],
  ['templates', 'Artifact templates', '▤'],
  ['resources', 'Prompts & skills', '✦'],
  ['agents', 'Agents & remote Markdown', '⌬'],
  ['world-model', 'Repository world model', '◉'],
  ['review', 'Review bundle', '✓'],
  ['documents', 'Documents', '▣'],
  ['help', 'Help', '?']
];

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

function Toast({ toast, onClose }) {
  if (!toast) return null;
  return <div className={`toast ${toast.tone}`} role={toast.tone === 'bad' ? 'alert' : 'status'} aria-live="polite"><span>{toast.text}</span><button type="button" aria-label="Dismiss message" onClick={onClose}>×</button></div>;
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

function InitiativeStudio({ data, editor, setEditor, saveEditor, downloadFile }) {
  const [tab, setTab] = useState('delivery');
  const portfolio = data.portfolio;
  const selected = data.initiative;
  if (!portfolio) return <div className="page"><Empty title="Initiative orchestration is not configured" detail="Add .singularity/portfolio.yml to define repositories, profiles, phase outputs, checklist evidence, approval authorities, contracts, and gates." /></div>;
  const profiles = Object.entries(portfolio.initiativeProfiles ?? {});
  const repositories = Object.entries(portfolio.repositories ?? {});
  const authorities = Object.entries(portfolio.approvalAuthorities ?? {});
  const state = selected?.state;
  const progress = selected?.progress;
  const report = selected?.report;
  const currentDefinition = state?.resolution.phases.find((phase) => phase.id === state.currentPhase) ?? state?.resolution.phases.at(-1);
  const currentChecks = selected?.phaseGate?.checklist ?? [];
  const children = report?.children.stories ?? [];
  const configValue = editor.path === data.portfolioPath ? editor.content : data.portfolioText;
  const configOriginal = editor.path === data.portfolioPath ? editor.original : data.portfolioText;
  return <div className="page initiative-page">
    <header className="page-heading initiative-heading"><div><span className="eyebrow">Cross-repository control plane</span><h1>Initiative orchestration</h1><p>Govern initiative outputs, evidence, contracts, and repository stories without changing the existing story workflow.</p></div><div className="segmented"><button className={tab === 'delivery' ? 'active' : ''} onClick={() => setTab('delivery')}>Delivery</button><button className={tab === 'configuration' ? 'active' : ''} onClick={() => setTab('configuration')}>Portfolio designer</button></div></header>
    {tab === 'configuration' ? <div className="initiative-config-layout">
      <aside className="initiative-config-summary">
        <section className="panel"><header className="panel-heading"><div><span className="eyebrow">Profiles</span><h2>{profiles.length} delivery models</h2></div></header><div className="initiative-mini-list">{profiles.map(([id, profile]) => <div key={id}><strong>{profile.label}</strong><span>{profile.phases.length} phases</span><small>{profile.phases.join(' → ')}</small></div>)}</div></section>
        <section className="panel"><header className="panel-heading"><div><span className="eyebrow">Repository registry</span><h2>{repositories.length} repositories</h2></div></header><div className="initiative-mini-list">{repositories.length ? repositories.map(([id, repository]) => <div key={id}><strong>{id}</strong><span>{repository.required ? 'Required' : 'Optional'}</span><small>{repository.defaultBranch} · {repository.url}</small></div>) : <div><strong>No repositories yet</strong><small>Add repository IDs, URLs, and default branches in portfolio.yml.</small></div>}</div></section>
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
      <section className="panel initiative-stories"><header className="panel-heading"><div><span className="eyebrow">Repository delivery graph</span><h2>Epics and stories</h2></div><span>{children.length} materialized</span></header>{!children.length ? <div className="inline-empty">No story branches have been materialized. Review breakdown.yml and run /sflow-initiative-materialize.</div> : <div className="story-grid">{children.map((story) => <div key={story.id} className={story.stale ? 'stale' : ''}><div><strong>{story.id}</strong><Pill tone={story.blocking ? 'accent' : 'neutral'}>{story.blocking ? 'blocking' : 'nonblocking'}</Pill></div><span>{story.repository} · {story.status}</span><small>{story.currentPhase ?? 'seeded'} · {story.observedCommit?.slice(0, 10) ?? 'not observed'}</small><div className="milestone-dots">{['implementationSpec', 'verification', 'conformance'].map((milestone) => <span className={story.milestones?.[milestone] ? 'done' : ''} key={milestone}>{milestone}</span>)}</div></div>)}</div>}</section>
      <div className="initiative-grid">
        <section className="panel initiative-contracts"><header className="panel-heading"><div><span className="eyebrow">Producer / consumer graph</span><h2>Interface contracts</h2></div><span>{selected.contracts.length}</span></header>{selected.contracts.length ? selected.contracts.map((contract) => <div key={contract.key}><div><strong>{contract.key}</strong><Pill tone={contract.integrity === 'verified' ? 'good' : 'warn'}>{contract.integrity}</Pill></div><span>{contract.format} · {contract.sha256.slice(0, 12)}</span><small>{contract.producers.join(', ') || 'external'} → {contract.consumers.join(', ') || 'no consumers'}</small></div>) : <div className="inline-empty">No interface contracts registered yet.</div>}</section>
        <section className="panel initiative-documents"><header className="panel-heading"><div><span className="eyebrow">Governed outputs</span><h2>Initiative documents</h2></div><span>{selected.documents.length}</span></header>{selected.documents.map((document) => <div key={`${document.phase}:${document.id}`}><span><strong>{document.label}</strong><small>{document.phase} · generation {document.generation}</small></span><Pill tone={document.status === 'approved' ? 'good' : document.status === 'stale' ? 'warn' : 'neutral'}>{document.status}</Pill><button className="ghost compact" disabled={!document.sha256} onClick={() => downloadFile(document.repositoryPath)}>Download</button></div>)}</section>
      </div>
    </>}
  </div>;
}

function Review({ data, downloadFile }) {
  if (!data.workflow || !data.review) return <div className="page"><Empty title="Choose a work item" detail="The review bundle combines the current artifact, provenance, checks, approvals, usage, source changes, and supporting evidence." /></div>;
  const phase = data.review.phase;
  return <div className="page review-page"><header className="page-heading row-between"><div><span className="eyebrow">Unified reviewer handoff</span><h1>{phase.label} review bundle</h1><p>{data.workflow.workItem.id} · generation {phase.generation} · {phase.status.replaceAll('_', ' ')}</p></div>{data.review.artifact && <button className="secondary" onClick={() => downloadFile(data.review.artifact.path)}>Download artifact</button>}</header>
    {data.review.selfApprovalWarning && <div className="notice warn">⚠ This phase contains self-approval and must not be presented as independent review.</div>}
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
  return <div className="split-page">
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

function Resources({ data, editor, setEditor, chooseResource, saveEditor, createSkill, deleteFile, downloadFile, importResource, materializeWorldModelPrompt }) {
  const [category, setCategory] = useState(editor.kind === 'skill' ? 'skills' : 'prompts');
  const [modal, setModal] = useState(null);
  const promptFiles = [...data.personaPrompts, { ...data.worldModelPrompt, name: `world-model/${data.worldModelPrompt.name}`, worldModelBuilder: true }];
  const files = category === 'skills' ? data.repositorySkills : promptFiles;
  const current = files.find((file) => file.path === editor.path) ?? files[0];
  useEffect(() => { if (current && editor.path !== current.path) chooseResource(current, category === 'skills' ? 'skill' : 'prompt'); }, [category]);
  async function submitSkill() { const result = await createSkill(modal.id.trim()); if (result) setModal(null); }
  return <div className="template-layout"><aside className="file-list"><header><div className="row-between"><div><span className="eyebrow">Repository Markdown</span><h2>Prompts & skills</h2></div><button className="icon-button" title={category === 'skills' ? 'Create skill' : 'Import prompt'} onClick={() => category === 'skills' ? setModal({ kind: 'skill', id: '', error: null }) : importResource('prompt')}>＋</button></div><div className="segmented resource-tabs"><button className={category === 'prompts' ? 'active' : ''} onClick={() => setCategory('prompts')}>Prompts</button><button className={category === 'skills' ? 'active' : ''} onClick={() => setCategory('skills')}>Skills</button></div></header>{files.map((file) => <button key={file.path} className={current?.path === file.path ? 'active' : ''} onClick={() => chooseResource(file, category === 'skills' ? 'skill' : 'prompt')}><span>{category === 'skills' ? 'SK' : 'PR'}</span><div><strong>{file.name.split('/').at(-1)}</strong><small>{file.worldModelBuilder ? 'world-model builder' : file.name.includes('/') ? file.name.slice(0, file.name.lastIndexOf('/')) : category === 'skills' ? 'repository skill' : 'persona prompt'}</small></div></button>)}</aside>
    <main className="template-main">{current ? <><div className="resource-summary"><div><Pill tone="accent">{current.worldModelBuilder ? 'Builder prompt' : category === 'skills' ? 'Repository skill' : 'Persona prompt'}</Pill><span>{current.worldModelBuilder ? 'Controls repository world-model generation.' : category === 'skills' ? 'Discovered by Copilot from .github/skills.' : 'Combined with phase and world-model context.'}</span></div><div className="row"><button className="ghost compact" onClick={() => importResource(current.worldModelBuilder ? 'world-prompt' : category === 'skills' ? 'skill' : 'prompt')}>Import</button>{!current.missing && <button className="secondary compact" onClick={() => downloadFile(current.path)}>Download</button>}{category === 'skills' && <button className="ghost compact" onClick={() => deleteFile(current)}>Delete</button>}{current.worldModelBuilder && current.missing && <button className="primary compact" onClick={() => materializeWorldModelPrompt(editor.path === current.path ? editor.content : current.content)}>Create repository copy</button>}</div></div><SourceEditor path={current.path} value={editor.path === current.path ? editor.content : current.content} dirty={editor.path === current.path && editor.content !== editor.original} onChange={(content) => setEditor({ path: current.path, content, original: current.content, kind: category === 'skills' ? 'skill' : 'prompt' })} onSave={current.worldModelBuilder && current.missing ? () => materializeWorldModelPrompt(editor.content) : saveEditor} onDownload={current.missing ? null : () => downloadFile(current.path)} onImport={() => importResource(current.worldModelBuilder ? 'world-prompt' : category === 'skills' ? 'skill' : 'prompt')} /></> : <Empty title={category === 'skills' ? 'No repository skills yet' : 'No prompts found'} detail={category === 'skills' ? 'Create or import Markdown skills under .github/skills.' : 'Persona and builder prompts live in the repository.'} action={category === 'skills' && <button className="primary" onClick={() => setModal({ kind: 'skill', id: '', error: null })}>Create first skill</button>} />}</main>
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
  const currentBranch = data.repository.branch;
  const activeBranch = data.workflow?.workItem.branch;
  const canMutate = data.workflow && currentBranch === activeBranch;
  async function selectPersona(event) { await action(() => window.singularity.selectPersona(data.repository.root, data.selectedWorkId, event.target.value), 'Persona selected'); await reload(); }
  async function upload() { const result = await action(() => window.singularity.uploadDocuments(data.repository.root), 'Documents uploaded'); if (result && !result.canceled) await reload(); }
  async function uploadDirectory() { const result = await action(() => window.singularity.uploadDocumentDirectory(data.repository.root), 'Design package imported and indexed'); if (result && !result.canceled) await reload(); }
  async function addUrl() { if (!url.trim()) return; await action(() => window.singularity.addDocumentUrl(data.repository.root, url.trim(), label.trim()), 'Document link added'); setUrl(''); setLabel(''); await reload(); }
  async function inspect(record) { const result = await action(() => window.singularity.previewDocument(data.repository.root, data.selectedWorkId, record.id)); if (!result) return; if (result.content != null) setPreview(result); else await action(() => window.singularity.openDocument(data.repository.root, record)); }
  if (!data.workflow) return <div className="page"><Empty title="Choose a work item" detail="Documents are cataloged per work item and branch." /></div>;
  return <div className="page"><header className="page-heading row-between"><div><span className="eyebrow">Evidence ledger</span><h1>Documents</h1><p>Uploaded files, design links, generated artifacts, and system state.</p></div><div className="session-control"><label>Acting as</label><select value={data.session?.workId === data.selectedWorkId ? data.session.persona : ''} onChange={selectPersona} disabled={!canMutate}><option value="">Choose persona</option>{Object.entries(data.definition.personas).map(([id, persona]) => <option value={id} key={id}>{persona.label}</option>)}</select></div></header>
    {!canMutate && <div className="notice warn">Work item {data.selectedWorkId} is on branch <strong>{activeBranch}</strong>. Resume that branch before uploading documents.</div>}
    <section className="upload-panel"><button className="primary" onClick={upload} disabled={!canMutate || data.session?.workId !== data.selectedWorkId}>＋ Upload files</button><button className="secondary" onClick={uploadDirectory} disabled={!canMutate || data.session?.workId !== data.selectedWorkId}>＋ Import design folder</button><span>or</span><input value={url} onChange={(event) => setUrl(event.target.value)} placeholder="Paste a Figma or reference URL" disabled={!canMutate} /><input value={label} onChange={(event) => setLabel(event.target.value)} placeholder="Label (optional)" disabled={!canMutate} /><button className="secondary" onClick={addUrl} disabled={!canMutate || !url.trim()}>Add link</button></section>
    <section className="panel document-panel"><div className="document-header"><span>Document</span><span>Phase</span><span>Type</span><span>Size</span><span /></div>{data.documents.map((record) => <button className="document-row" key={record.id} onClick={() => inspect(record)}><div><span className="doc-icon">{record.mimeType?.startsWith('image/') ? 'IMG' : record.type === 'url' ? 'URL' : 'DOC'}</span><span><strong>{record.label}</strong><small>{record.id} · {record.path ?? record.url}</small></span></div><span>{record.phase ?? 'system'}</span><Pill>{record.kind}</Pill><span>{record.size ? `${Math.ceil(record.size / 1024)} KB` : '—'}</span><span>View →</span></button>)}</section>
    {preview && <div className="modal-backdrop" onClick={() => setPreview(null)}><div className="preview-modal" onClick={(event) => event.stopPropagation()}><header><div><span className="eyebrow">{preview.record.id}</span><h2>{preview.record.label}</h2></div><div className="row">{preview.record.path?.startsWith(`${String(data.definition.workItemRoot ?? '.singularity/work-items').replace(/\/$/, '')}/`) && <button className="secondary compact" onClick={() => downloadFile(preview.record.path)}>Download</button>}<button onClick={() => setPreview(null)}>×</button></div></header><pre>{preview.content}</pre></div></div>}
  </div>;
}

export default function App() {
  const [data, setData] = useState(null);
  const [page, setPage] = useState('dashboard');
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState(null);
  const [standaloneHelp, setStandaloneHelp] = useState(false);
  const [recentRepositories, setRecentRepositories] = useState([]);
  const [repositoryMenu, setRepositoryMenu] = useState(false);
  const [editor, setEditor] = useState({ path: '', content: '', original: '', kind: 'workflow' });

  useEffect(() => { if (data && !editor.path) setEditor({ path: data.definitionPath, content: data.definitionText, original: data.definitionText, kind: 'workflow' }); }, [data, editor.path]);
  useEffect(() => { if (toast?.tone !== 'good') return undefined; const timer = setTimeout(() => setToast(null), 5000); return () => clearTimeout(timer); }, [toast]);
  useEffect(() => { let current = true; window.singularity.recentRepositories().then((items) => { if (current) setRecentRepositories(items); }).catch((error) => { if (current) setToast({ tone: 'bad', text: `Could not load recent repositories: ${error.message}` }); }); return () => { current = false; }; }, []);
  useEffect(() => {
    if (!repositoryMenu) return undefined;
    const closeOutside = (event) => { if (!event.target.closest?.('.repo-switcher')) setRepositoryMenu(false); };
    const closeEscape = (event) => { if (event.key === 'Escape') setRepositoryMenu(false); };
    document.addEventListener('mousedown', closeOutside); document.addEventListener('keydown', closeEscape);
    return () => { document.removeEventListener('mousedown', closeOutside); document.removeEventListener('keydown', closeEscape); };
  }, [repositoryMenu]);
  const repoName = useMemo(() => data?.repository.root.split('/').at(-1), [data]);
  const configurationChanges = data?.repository.configurationChanges ?? [];
  const unrelatedChanges = data?.repository.unrelatedChanges ?? [];
  const publishReady = data?.repository.publishReady === true;
  const publishHint = !configurationChanges.length ? 'No workflow, template, persona, prompt, skill, or agent changes are ready to publish.' : unrelatedChanges.length ? `Blocked by ${unrelatedChanges.length} non-configuration working-tree change(s).` : 'Commit and push desktop configuration changes.';
  async function action(task, success) { setBusy(true); setToast(null); try { const result = await task(); if (success && result != null) setToast({ tone: 'good', text: success }); return result; } catch (error) { setToast({ tone: 'bad', text: error?.message || String(error) }); return null; } finally { setBusy(false); } }
  async function refreshRecentRepositories() {
    try { const items = await window.singularity.recentRepositories(); setRecentRepositories(items); return items; }
    catch (error) { setToast({ tone: 'bad', text: `Could not load recent repositories: ${error.message}` }); return []; }
  }
  async function openRepository(repositoryPath = null) {
    const result = await action(() => repositoryPath ? window.singularity.openRepository(repositoryPath) : window.singularity.chooseRepository());
    if (result) {
      setData(result);
      setEditor({ path: result.definitionPath, content: result.definitionText, original: result.definitionText, kind: 'workflow' });
      setRepositoryMenu(false);
      await refreshRecentRepositories();
    }
  }
  async function forgetRepository(event, repositoryPath) {
    event.stopPropagation();
    const items = await action(() => window.singularity.forgetRepository(repositoryPath), 'Repository removed from recent locations');
    if (items) setRecentRepositories(items);
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
    const files = kind === 'skill' ? snapshot.repositorySkills : [...snapshot.personaPrompts, snapshot.worldModelPrompt];
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

  if (!data && standaloneHelp) return <div className="standalone-help"><button className="ghost help-back" onClick={() => setStandaloneHelp(false)}>← Back</button><Help /></div>;
  if (!data) return <div className={`welcome ${busy ? 'busy' : ''}`}><div className="brand large"><span>S</span><div><strong>Singularity</strong><small>Flow Studio</small></div></div><div className="welcome-content"><Empty title="Design governed workflows visually" detail="Open the Git repository folder that contains .singularity/workflow.yml. Configuration stays in .singularity and every runtime transition remains controlled by the CLI." action={<><div className="row"><button className="primary large-button" onClick={() => openRepository()} disabled={busy}>{busy ? 'Opening repository…' : 'Open another repository'}</button><button className="secondary large-button" onClick={() => setStandaloneHelp(true)} disabled={busy}>Open help</button></div>{busy && <p className="opening-state" role="status">Validating the repository and loading workflow state…</p>}</>} /><RecentRepositories items={recentRepositories} busy={busy} onOpen={openRepository} onForget={forgetRepository} /></div><Toast toast={toast} onClose={() => setToast(null)} /></div>;
  return <div className="shell">
    <aside className="sidebar"><div className="brand"><span>S</span><div><strong>Singularity</strong><small>Flow Studio</small></div></div><nav>{nav.map(([id, label, icon]) => <button key={id} className={page === id ? 'active' : ''} onClick={() => id === 'workflow' ? workflowPage() : id === 'initiatives' ? initiativePage() : id === 'resources' ? resourcesPage() : id === 'agents' ? agentsPage() : setPage(id)}><i>{icon}</i>{label}</button>)}</nav><div className="sidebar-bottom"><div className="repo-switcher"><div className="repo-card"><span className="repo-icon">⌘</span><div><strong>{repoName}</strong><small>{data.repository.branch}</small></div><button title="Switch repository" aria-label="Switch repository" onClick={() => setRepositoryMenu(!repositoryMenu)}>⋯</button></div>{repositoryMenu && <div className="repository-menu"><RecentRepositories items={recentRepositories} currentPath={data.repository.root} busy={busy} onOpen={openRepository} onForget={forgetRepository} compact /><button className="secondary repository-browse" onClick={() => openRepository()} disabled={busy}>＋ Open another repository</button></div>}</div><div className={`connection ${data.repository.changes.length ? 'dirty' : ''}`}><span />{data.repository.changes.length ? `${data.repository.changes.length} uncommitted change(s)` : 'Working tree clean'}</div></div></aside>
    <main className="content"><header className="topbar"><div><select aria-label="Work item" value={data.selectedWorkId ?? ''} onChange={selectWorkItem}><option value="">Story work item</option>{data.workItems.map((item) => <option value={item.id} key={item.id}>{item.id} — {item.title}</option>)}</select>{data.portfolio && <select aria-label="Initiative" value={data.selectedInitiativeId ?? ''} onChange={selectInitiative}><option value="">Initiative</option>{data.initiatives.map((item) => <option value={item.id} key={item.id}>{item.id} — {item.title}</option>)}</select>}{data.workflow && <Pill tone="accent">{data.workflow.currentPhase ?? 'complete'}</Pill>}{data.initiative && <Pill tone="accent">{data.initiative.state.currentPhase ?? 'complete'}</Pill>}</div><div className="row"><button className="ghost" onClick={() => reload()} disabled={busy}>↻ Refresh</button><button className="ghost" onClick={exportBundle} disabled={busy}>Download config</button><button className="secondary" onClick={validate} disabled={busy}>Validate</button><button className="primary" onClick={publish} disabled={busy || !publishReady} title={publishHint}>Commit & push</button></div></header>
      <div className={busy ? 'busy view' : 'view'}>{page === 'dashboard' && <Dashboard data={data} />}{page === 'initiatives' && <InitiativeStudio data={data} editor={editor} setEditor={setEditor} saveEditor={saveEditor} downloadFile={downloadFile} />}{page === 'inbox' && <ApprovalInbox data={data} busy={busy} refresh={refreshInbox} attach={attachInboxItem} />}{page === 'workflow' && <Workflow data={data} editor={editor} setEditor={setEditor} saveEditor={saveEditor} downloadFile={downloadFile} importWorkflow={importWorkflow} />}{page === 'personas' && <Personas data={data} openPrompt={openPrompt} savePersona={savePersona} createPersonaConfig={createPersonaConfig} deletePersonaConfig={deletePersonaConfig} downloadFile={downloadFile} />}{page === 'templates' && <Templates data={data} editor={editor.kind !== 'template' ? { path: data.templates[0]?.path, content: data.templates[0]?.content ?? '', original: data.templates[0]?.content ?? '', kind: 'template' } : editor} setEditor={setEditor} chooseTemplate={chooseTemplate} saveEditor={saveEditor} createTemplate={createTemplate} deleteTemplate={deleteTemplate} downloadFile={downloadFile} importTemplate={importTemplate} />}{page === 'resources' && <Resources data={data} editor={editor} setEditor={setEditor} chooseResource={chooseResource} saveEditor={saveEditor} createSkill={createSkill} deleteFile={deleteFile} downloadFile={downloadFile} importResource={importResource} materializeWorldModelPrompt={materializeWorldModelPrompt} />}{page === 'agents' && <Agents data={data} editor={editor} setEditor={setEditor} chooseAgent={chooseAgent} saveEditor={saveEditor} createAgent={createAgent} deleteFile={deleteFile} downloadFile={downloadFile} importAgent={importAgent} />}{page === 'world-model' && <WorldModel data={data} editor={editor} setEditor={setEditor} saveEditor={saveEditor} downloadFile={downloadFile} importResource={importResource} materializeWorldModelPrompt={materializeWorldModelPrompt} addView={addWorldModelViewConfig} removeView={removeWorldModelViewConfig} />}{page === 'review' && <Review data={data} downloadFile={downloadFile} />}{page === 'documents' && <Documents data={data} action={action} reload={reload} downloadFile={downloadFile} />}{page === 'help' && <Help />}</div>
    </main><Toast toast={toast} onClose={() => setToast(null)} />
  </div>;
}
