import React, { useEffect, useMemo, useState } from 'react';
import Editor from '@monaco-editor/react';
import YAML from 'yaml';
import helpMarkdown from '../../../HELP.md?raw';
import {
  addPhaseToWorkType,
  createPhase,
  createWorkType,
  deleteUnusedPhase,
  removePhaseFromWorkType,
  removeWorkType,
  setWorkTypeInputs,
  templateRepositoryPath
} from './workflow-designer.mjs';

const nav = [
  ['dashboard', 'Overview', '⌁'],
  ['workflow', 'Workflow', '◇'],
  ['personas', 'Personas & approvals', '◎'],
  ['templates', 'Artifact templates', '▤'],
  ['agents', 'Agents & remote Markdown', '⌬'],
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

function Toast({ toast, onClose }) {
  if (!toast) return null;
  return <div className={`toast ${toast.tone}`} role={toast.tone === 'bad' ? 'alert' : 'status'} aria-live="polite"><span>{toast.text}</span><button type="button" aria-label="Dismiss message" onClick={onClose}>×</button></div>;
}

function ProgressRing({ value = 0 }) {
  return <div className="ring" style={{ '--progress': `${value * 3.6}deg` }}><div><strong>{value}%</strong><span>complete</span></div></div>;
}

function StatusDot({ status }) { return <span className={`status-dot ${String(status).replaceAll('_', '-')}`} title={status} />; }

function SourceEditor({ path, value, onChange, language = 'markdown', dirty, onSave }) {
  return <section className="editor-panel">
    <header className="editor-header"><div><span className="eyebrow">Repository source</span><strong>{path}</strong></div><div className="row"><Pill tone={dirty ? 'warn' : 'good'}>{dirty ? 'Unsaved' : 'Saved'}</Pill><button className="primary compact" disabled={!dirty} onClick={onSave}>Save</button></div></header>
    <Editor height="calc(100vh - 245px)" language={language} theme="vs-dark" value={value} onChange={(next) => onChange(next ?? '')} options={{ minimap: { enabled: false }, fontSize: 13, lineHeight: 21, wordWrap: 'on', padding: { top: 16 }, scrollBeyondLastLine: false, automaticLayout: true }} />
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
  return <div className="page dashboard-page">
    <div className="hero-card">
      <div><div className="row gap"><Pill tone="accent">{data.workflow.workItem.workTypeLabel}</Pill><Pill>{data.workflow.status}</Pill></div><h1>{data.workflow.workItem.title}</h1><p className="muted">{data.workflow.workItem.id} · branch {data.workflow.workItem.branch}</p></div>
      <ProgressRing value={p.percentage} />
    </div>
    <div className="metrics">
      <div className="metric"><span>Current phase</span><strong>{current?.label ?? 'Complete'}</strong><small>{p.currentPosition} of {p.totalPhases}</small></div>
      <div className="metric"><span>Approvals</span><strong>{p.approvedPhases}</strong><small>approved phases</small></div>
      <div className="metric"><span>Documents</span><strong>{p.documents}</strong><small>evidence items</small></div>
      <div className="metric"><span>Token usage</span><strong>{p.tokens.totalTokens || '—'}</strong><small>{p.tokens.totalTokens ? 'exact tokens' : 'unavailable'}</small></div>
    </div>
    {!!data.workflow.sequenceOverrides?.length && <div className="notice">⚠ {data.workflow.sequenceOverrides.length} confirmed soft sequence override(s) are recorded. Review the work-item report before final approval.</div>}
    <section className="panel"><header className="panel-heading"><div><span className="eyebrow">Lifecycle</span><h2>Phase progress</h2></div></header><div className="phase-list">
      {p.phases.map((phase) => <div className={`phase-row ${phase.id === p.currentPhase ? 'active' : ''}`} key={phase.id}><StatusDot status={phase.status} /><div className="phase-copy"><strong>{phase.label}</strong><span>{phase.id}</span></div><Pill>{phase.generation ? `Generation ${phase.generation}` : 'Not generated'}</Pill><span className="approval-count">{phase.approvals}/{phase.approvalsRequired} approvals</span><span className="phase-status">{phase.status.replaceAll('_', ' ')}</span></div>)}
    </div></section>
  </div>;
}

function Workflow({ data, editor, setEditor, saveEditor }) {
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
    <SourceEditor path={data.definitionPath} value={editor.content} dirty={editor.content !== editor.original} onChange={(content) => setEditor({ ...editor, content })} language="yaml" onSave={saveEditor} />
    {modal?.kind === 'new-workflow' && <DesignerModal title="Create workflow" detail={`Create a new profile by copying ${profile.label}, then adjust its stages.`} submitLabel="Create workflow" error={modal.error} onCancel={() => setModal(null)} onSubmit={submitModal}><label><span>Workflow ID</span><input autoFocus value={modal.values.id} placeholder="security-review" onChange={(event) => field('id', event.target.value)} /></label><label><span>Display name</span><input value={modal.values.label} placeholder="Security review" onChange={(event) => field('label', event.target.value)} /></label></DesignerModal>}
    {modal?.kind === 'delete-workflow' && <DesignerModal title={`Delete ${profile.label}?`} detail="The workflow profile will be removed from the YAML draft. Shared stage definitions and templates remain available." submitLabel="Delete workflow" danger error={modal.error} onCancel={() => setModal(null)} onSubmit={submitModal} />}
    {modal?.kind === 'add-stage' && <DesignerModal title="Add an existing stage" detail="The stage is appended and receives the current last stage as its initial input." submitLabel="Add stage" error={modal.error} onCancel={() => setModal(null)} onSubmit={submitModal}><label><span>Available stage</span><select value={modal.values.phaseId} onChange={(event) => field('phaseId', event.target.value)}>{inactivePhases.map((id) => <option key={id} value={id}>{draft.phases[id].label} · {id}</option>)}</select></label></DesignerModal>}
    {modal?.kind === 'new-stage' && <DesignerModal title="Create a stage and artifact contract" detail="The stage is added to this workflow. Its ID, artifact location, approval authority, and template become governed YAML." submitLabel="Create stage" error={modal.error} onCancel={() => setModal(null)} onSubmit={submitModal}><div className="modal-grid"><label><span>Stage ID</span><input autoFocus value={modal.values.id} placeholder="security-review" onChange={(event) => field('id', event.target.value)} /></label><label><span>Stage name</span><input value={modal.values.label} placeholder="Security review" onChange={(event) => field('label', event.target.value)} /></label><label><span>Artifact filename</span><input value={modal.values.artifactFile} placeholder="security-review.md" onChange={(event) => field('artifactFile', event.target.value)} /></label><label><span>Artifact kind</span><input value={modal.values.kind} placeholder="security-review" onChange={(event) => field('kind', event.target.value)} /></label><label><span>Template</span><select value={modal.values.template} onChange={(event) => field('template', event.target.value)}>{templateNames.map((name) => <option key={name} value={name}>{name}</option>)}</select></label><label><span>Approval persona</span><select value={modal.values.persona} onChange={(event) => field('persona', event.target.value)}>{Object.entries(draft.personas).map(([id, persona]) => <option key={id} value={id}>{persona.label}</option>)}</select></label><label><span>Write scope</span><select value={modal.values.writeScope} onChange={(event) => field('writeScope', event.target.value)}><option value="artifact-only">Artifact only</option><option value="source-and-artifact">Source and artifact</option></select></label><label><span>Minimum bytes</span><input type="number" min="1" value={modal.values.minimumBytes} onChange={(event) => field('minimumBytes', event.target.value)} /></label></div></DesignerModal>}
    {modal?.kind === 'remove-stage' && <DesignerModal title={`Remove ${phase.label}?`} detail={`This removes the stage from ${profile.label} and cleans its profile-specific inputs.`} submitLabel="Remove stage" danger error={modal.error} onCancel={() => setModal(null)} onSubmit={submitModal}><label className="check-row"><input type="checkbox" checked={modal.values.deleteDefinition} onChange={(event) => field('deleteDefinition', event.target.checked)} /><span>Also delete the global stage definition if no other workflow uses it. Templates are never deleted automatically.</span></label></DesignerModal>}
  </div>;
}

function Personas({ data, openPrompt }) {
  const [selected, setSelected] = useState(Object.keys(data.definition.personas)[0]);
  const persona = data.definition.personas[selected];
  const prompt = data.personaPrompts.find((item) => item.name === persona.prompt);
  return <div className="page"><header className="page-heading"><span className="eyebrow">Identity and authority</span><h1>Personas & approvals</h1><p>Personas guide generation and grant approval authority. Any contributor may assume any persona.</p></header>
    <div className="persona-grid">{Object.entries(data.definition.personas).map(([id, item]) => <button key={id} className={`persona-card ${selected === id ? 'selected' : ''}`} onClick={() => setSelected(id)}><span className="avatar">{item.label.slice(0, 2).toUpperCase()}</span><strong>{item.label}</strong><small>{item.description}</small><div className="tags">{item.worldModelViews?.map((view) => <Pill key={view}>{view}</Pill>)}</div></button>)}</div>
    <div className="two-column"><section className="panel persona-detail"><header className="panel-heading"><div><span className="eyebrow">Persona contract</span><h2>{persona.label}</h2></div>{prompt && <button className="secondary" onClick={() => openPrompt(prompt)}>Edit prompt</button>}</header><p>{persona.description}</p><dl><div><dt>Suggested phases</dt><dd>{persona.suggestedPhases?.join(', ') || 'None'}</dd></div><div><dt>Approval authority</dt><dd>{persona.mayApprove?.join(', ') || 'None'}</dd></div><div><dt>Additional world-model views</dt><dd>{persona.worldModelViews?.join(', ') || 'None'}</dd></div><div><dt>Prompt file</dt><dd>{persona.prompt}</dd></div></dl></section>
      <section className="panel"><header className="panel-heading"><div><span className="eyebrow">Approval coverage</span><h2>Configured rules</h2></div></header><div className="rule-list">{Object.entries(data.definition.phases).filter(([, phase]) => phase.approval?.personas?.includes(selected)).map(([id, phase]) => <div key={id}><StatusDot status="approved" /><span><strong>{phase.label}</strong><small>{phase.approval.minimum} required · reject to {phase.approval.rejectTo?.join(', ')}</small></span></div>)}</div></section></div>
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

function Templates({ data, editor, setEditor, chooseTemplate, saveEditor, createTemplate, deleteTemplate }) {
  const [search, setSearch] = useState('');
  const [preview, setPreview] = useState(false);
  const [modal, setModal] = useState(null);
  const files = data.templates.filter((item) => item.name.toLowerCase().includes(search.toLowerCase()));
  const current = data.templates.find((file) => file.path === editor.path) ?? null;
  async function submitCreate() { if (!modal.name.trim()) return setModal({ ...modal, error: 'Enter a relative Markdown filename.' }); const result = await createTemplate(modal.name.trim()); if (result) setModal(null); }
  async function submitDelete() { const result = await deleteTemplate(current); if (result) setModal(null); }
  return <div className="template-layout"><aside className="file-list"><header><div className="row-between"><div><span className="eyebrow">Artifact library</span><h2>Templates</h2></div><button className="icon-button" title="Create template" onClick={() => setModal({ kind: 'create', name: '', error: null })}>＋</button></div><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Filter templates…" /></header>{files.map((file) => <button key={file.path} className={editor.path === file.path ? 'active' : ''} onClick={() => chooseTemplate(file)}><span>MD</span><div><strong>{file.name.split('/').at(-1)}</strong><small>{file.name.includes('/') ? file.name.slice(0, file.name.lastIndexOf('/')) : 'root'}</small></div></button>)}</aside>
    <main className="template-main"><header className="template-toolbar"><div><span className="eyebrow">Template studio</span><h1>{editor.path?.split('/').at(-1)}</h1></div><div className="row"><div className="segmented small"><button className={!preview ? 'active' : ''} onClick={() => setPreview(false)}>Source</button><button className={preview ? 'active' : ''} onClick={() => setPreview(true)}>Preview</button></div><Pill tone={editor.content !== editor.original ? 'warn' : 'good'}>{editor.content !== editor.original ? 'Unsaved' : 'Saved'}</Pill><button className="primary compact" disabled={editor.content === editor.original} onClick={saveEditor}>Save</button></div></header>
      <div className="template-contract-bar"><span>Templates define the generated artifact structure and may use <code>{'{{work.id}}'}</code>, <code>{'{{phase.label}}'}</code>, and <code>{'{{inputs}}'}</code>.</span><button className="ghost compact" disabled={!current} onClick={() => setModal({ kind: 'delete', error: null })}>Delete template</button></div>
      {preview ? <TemplatePreview content={editor.content} /> : <Editor height="calc(100vh - 186px)" language="markdown" theme="vs-dark" value={editor.content} onChange={(content) => setEditor({ ...editor, content: content ?? '' })} options={{ minimap: { enabled: false }, fontSize: 13, lineHeight: 21, wordWrap: 'on', padding: { top: 20 }, scrollBeyondLastLine: false, automaticLayout: true }} />}
    </main>
    {modal?.kind === 'create' && <DesignerModal title="Create artifact template" detail="Create repository Markdown under the configured templates root. You can assign it to a stage from the Workflow page." submitLabel="Create template" error={modal.error} onCancel={() => setModal(null)} onSubmit={submitCreate}><label><span>Relative template path</span><input autoFocus value={modal.name} placeholder="security/security-review.md" onChange={(event) => setModal({ ...modal, name: event.target.value, error: null })} /></label></DesignerModal>}
    {modal?.kind === 'delete' && <DesignerModal title={`Delete ${current?.name}?`} detail="Deletion is allowed only when no stage or workflow profile references this template." submitLabel="Delete template" danger error={modal.error} onCancel={() => setModal(null)} onSubmit={submitDelete} />}
  </div>;
}

function Agents({ data, editor, setEditor, chooseAgent, saveEditor }) {
  const [lockView, setLockView] = useState(false);
  const current = data.agents.find((agent) => agent.path === editor.path) ?? data.agents[0];
  const status = data.agentStatus.find((entry) => entry.id === current?.id);
  return <div className="template-layout"><aside className="file-list"><header><span className="eyebrow">Agent registry</span><h2>Agents</h2><p className="muted">Remote links are inert until explicitly locked.</p></header>{data.agents.map((agent) => <button key={`${agent.scope}:${agent.path}`} className={!lockView && current?.path === agent.path ? 'active' : ''} onClick={() => { setLockView(false); chooseAgent(agent); }}><span>AG</span><div><strong>{agent.id}</strong><small>{agent.scope} · {agent.remoteResources} remote</small></div></button>)}<button className={lockView ? 'active' : ''} onClick={() => setLockView(true)}><span>RO</span><div><strong>agents.lock.yml</strong><small>read-only · refresh with CLI</small></div></button></aside>
    <main className="template-main">{lockView ? <><header className="template-toolbar"><div><span className="eyebrow">Pinned trust state</span><h1>{data.agentsLock.path}</h1></div><Pill>Read only</Pill></header><pre className="lock-preview">{data.agentsLock.content}</pre></> : current ? <><header className="agent-summary"><span><Pill tone={status?.status === 'ready' || status?.status === 'local-only' ? 'good' : 'warn'}>{status?.status ?? 'unknown'}</Pill><small>{current.sha256.slice(0, 12)} · {current.editable ? 'repository Markdown' : 'bundled plugin agent'}</small></span><code>singularity-flow agents {status?.locked ? 'sync' : 'lock'} {current.id}</code></header><SourceEditor path={current.path} value={editor.path === current.path ? editor.content : current.content} dirty={current.editable && editor.content !== editor.original} onChange={(content) => current.editable && setEditor({ ...editor, content })} onSave={saveEditor} /></> : <Empty title="No agents found" detail="Add agent Markdown under .github/agents or .claude/agents." />}</main>
  </div>;
}

function Documents({ data, action, reload }) {
  const [url, setUrl] = useState('');
  const [label, setLabel] = useState('');
  const [preview, setPreview] = useState(null);
  const currentBranch = data.repository.branch;
  const activeBranch = data.workflow?.workItem.branch;
  const canMutate = data.workflow && currentBranch === activeBranch;
  async function selectPersona(event) { await action(() => window.singularity.selectPersona(data.repository.root, data.selectedWorkId, event.target.value), 'Persona selected'); await reload(); }
  async function upload() { const result = await action(() => window.singularity.uploadDocuments(data.repository.root), 'Documents uploaded'); if (result && !result.canceled) await reload(); }
  async function addUrl() { if (!url.trim()) return; await action(() => window.singularity.addDocumentUrl(data.repository.root, url.trim(), label.trim()), 'Document link added'); setUrl(''); setLabel(''); await reload(); }
  async function inspect(record) { const result = await action(() => window.singularity.previewDocument(data.repository.root, data.selectedWorkId, record.id)); if (!result) return; if (result.content != null) setPreview(result); else await action(() => window.singularity.openDocument(data.repository.root, record)); }
  if (!data.workflow) return <div className="page"><Empty title="Choose a work item" detail="Documents are cataloged per work item and branch." /></div>;
  return <div className="page"><header className="page-heading row-between"><div><span className="eyebrow">Evidence ledger</span><h1>Documents</h1><p>Uploaded files, design links, generated artifacts, and system state.</p></div><div className="session-control"><label>Acting as</label><select value={data.session?.workId === data.selectedWorkId ? data.session.persona : ''} onChange={selectPersona} disabled={!canMutate}><option value="">Choose persona</option>{Object.entries(data.definition.personas).map(([id, persona]) => <option value={id} key={id}>{persona.label}</option>)}</select></div></header>
    {!canMutate && <div className="notice warn">Work item {data.selectedWorkId} is on branch <strong>{activeBranch}</strong>. Resume that branch before uploading documents.</div>}
    <section className="upload-panel"><button className="primary" onClick={upload} disabled={!canMutate || data.session?.workId !== data.selectedWorkId}>＋ Upload files</button><span>or</span><input value={url} onChange={(event) => setUrl(event.target.value)} placeholder="Paste a Figma or reference URL" disabled={!canMutate} /><input value={label} onChange={(event) => setLabel(event.target.value)} placeholder="Label (optional)" disabled={!canMutate} /><button className="secondary" onClick={addUrl} disabled={!canMutate || !url.trim()}>Add link</button></section>
    <section className="panel document-panel"><div className="document-header"><span>Document</span><span>Phase</span><span>Type</span><span>Size</span><span /></div>{data.documents.map((record) => <button className="document-row" key={record.id} onClick={() => inspect(record)}><div><span className="doc-icon">{record.mimeType?.startsWith('image/') ? 'IMG' : record.type === 'url' ? 'URL' : 'DOC'}</span><span><strong>{record.label}</strong><small>{record.id} · {record.path ?? record.url}</small></span></div><span>{record.phase ?? 'system'}</span><Pill>{record.kind}</Pill><span>{record.size ? `${Math.ceil(record.size / 1024)} KB` : '—'}</span><span>View →</span></button>)}</section>
    {preview && <div className="modal-backdrop" onClick={() => setPreview(null)}><div className="preview-modal" onClick={(event) => event.stopPropagation()}><header><div><span className="eyebrow">{preview.record.id}</span><h2>{preview.record.label}</h2></div><button onClick={() => setPreview(null)}>×</button></header><pre>{preview.content}</pre></div></div>}
  </div>;
}

export default function App() {
  const [data, setData] = useState(null);
  const [page, setPage] = useState('dashboard');
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState(null);
  const [standaloneHelp, setStandaloneHelp] = useState(false);
  const [editor, setEditor] = useState({ path: '', content: '', original: '', kind: 'workflow' });

  useEffect(() => { if (data && !editor.path) setEditor({ path: data.definitionPath, content: data.definitionText, original: data.definitionText, kind: 'workflow' }); }, [data, editor.path]);
  useEffect(() => { if (toast?.tone !== 'good') return undefined; const timer = setTimeout(() => setToast(null), 5000); return () => clearTimeout(timer); }, [toast]);
  const repoName = useMemo(() => data?.repository.root.split('/').at(-1), [data]);
  const configurationChanges = data?.repository.configurationChanges ?? [];
  const unrelatedChanges = data?.repository.unrelatedChanges ?? [];
  const publishReady = data?.repository.publishReady === true;
  const publishHint = !configurationChanges.length ? 'No workflow, template, persona, or agent changes are ready to publish.' : unrelatedChanges.length ? `Blocked by ${unrelatedChanges.length} non-configuration working-tree change(s).` : 'Commit and push desktop configuration changes.';
  async function action(task, success) { setBusy(true); setToast(null); try { const result = await task(); if (success && result != null) setToast({ tone: 'good', text: success }); return result; } catch (error) { setToast({ tone: 'bad', text: error?.message || String(error) }); return null; } finally { setBusy(false); } }
  async function openRepository() { const result = await action(() => window.singularity.chooseRepository()); if (result) { setData(result); setEditor({ path: result.definitionPath, content: result.definitionText, original: result.definitionText, kind: 'workflow' }); } }
  async function reload(workId = data?.selectedWorkId) { if (!data) return null; const result = await action(() => window.singularity.snapshot(data.repository.root, workId)); if (result) setData(result); return result; }
  async function selectWorkItem(event) { await reload(event.target.value || null); }
  async function saveEditor() { const result = await action(() => window.singularity.saveFile(data.repository.root, editor.path, editor.content), `${editor.path} saved and validated`); if (result) { setEditor({ ...editor, original: editor.content }); await reload(); } }
  async function validate() { await action(() => window.singularity.validate(data.repository.root), 'Configuration is valid'); }
  async function publish() { if (!publishReady) return setToast({ tone: 'bad', text: publishHint }); const result = await action(() => window.singularity.publish(data.repository.root, 'Configure Singularity Flow desktop workflow'), 'Configuration committed and published'); if (result) await reload(); }
  function workflowPage() { setPage('workflow'); setEditor({ path: data.definitionPath, content: data.definitionText, original: data.definitionText, kind: 'workflow' }); }
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
  function chooseAgent(agent) { setEditor({ path: agent.path, content: agent.content, original: agent.content, kind: 'agent' }); }
  function openPrompt(file) { setEditor({ path: file.path, content: file.content, original: file.content, kind: 'persona' }); setPage('templates'); }
  function agentsPage() { setPage('agents'); if (data.agents[0]) chooseAgent(data.agents[0]); }

  if (!data && standaloneHelp) return <div className="standalone-help"><button className="ghost help-back" onClick={() => setStandaloneHelp(false)}>← Back</button><Help /></div>;
  if (!data) return <div className={`welcome ${busy ? 'busy' : ''}`}><div className="brand large"><span>S</span><div><strong>Singularity</strong><small>Flow Studio</small></div></div><Empty title="Design governed workflows visually" detail="Open the Git repository folder that contains .singularity/workflow.yml. Configuration stays in .singularity and every runtime transition remains controlled by the CLI." action={<><div className="row"><button className="primary large-button" onClick={openRepository} disabled={busy}>{busy ? 'Opening repository…' : 'Open repository'}</button><button className="secondary large-button" onClick={() => setStandaloneHelp(true)} disabled={busy}>Open help</button></div>{busy && <p className="opening-state" role="status">Validating the repository and loading workflow state…</p>}</>} /><Toast toast={toast} onClose={() => setToast(null)} /></div>;
  return <div className="shell">
    <aside className="sidebar"><div className="brand"><span>S</span><div><strong>Singularity</strong><small>Flow Studio</small></div></div><nav>{nav.map(([id, label, icon]) => <button key={id} className={page === id ? 'active' : ''} onClick={() => id === 'workflow' ? workflowPage() : id === 'agents' ? agentsPage() : setPage(id)}><i>{icon}</i>{label}</button>)}</nav><div className="sidebar-bottom"><div className="repo-card"><span className="repo-icon">⌘</span><div><strong>{repoName}</strong><small>{data.repository.branch}</small></div><button onClick={openRepository}>⋯</button></div><div className={`connection ${data.repository.changes.length ? 'dirty' : ''}`}><span />{data.repository.changes.length ? `${data.repository.changes.length} uncommitted change(s)` : 'Working tree clean'}</div></div></aside>
    <main className="content"><header className="topbar"><div><select value={data.selectedWorkId ?? ''} onChange={selectWorkItem}><option value="">Configuration only</option>{data.workItems.map((item) => <option value={item.id} key={item.id}>{item.id} — {item.title}</option>)}</select>{data.workflow && <Pill tone="accent">{data.workflow.currentPhase ?? 'complete'}</Pill>}</div><div className="row"><button className="ghost" onClick={() => reload()} disabled={busy}>↻ Refresh</button><button className="secondary" onClick={validate} disabled={busy}>Validate</button><button className="primary" onClick={publish} disabled={busy || !publishReady} title={publishHint}>Commit & push</button></div></header>
      {!!unrelatedChanges.length && <div className="publish-scope-notice" role="status"><strong>Desktop publishing is configuration-only.</strong><span>{unrelatedChanges.length} source, runtime, or work-item change(s) remain under their normal Singularity Flow or Git lifecycle.</span><code>{unrelatedChanges.slice(0, 3).join(', ')}{unrelatedChanges.length > 3 ? `, +${unrelatedChanges.length - 3} more` : ''}</code></div>}
      <div className={busy ? 'busy view' : 'view'}>{page === 'dashboard' && <Dashboard data={data} />}{page === 'workflow' && <Workflow data={data} editor={editor} setEditor={setEditor} saveEditor={saveEditor} />}{page === 'personas' && <Personas data={data} openPrompt={openPrompt} />}{page === 'templates' && <Templates data={data} editor={editor.kind === 'workflow' ? { path: data.templates[0]?.path, content: data.templates[0]?.content ?? '', original: data.templates[0]?.content ?? '', kind: 'template' } : editor} setEditor={setEditor} chooseTemplate={chooseTemplate} saveEditor={saveEditor} createTemplate={createTemplate} deleteTemplate={deleteTemplate} />}{page === 'agents' && <Agents data={data} editor={editor} setEditor={setEditor} chooseAgent={chooseAgent} saveEditor={saveEditor} />}{page === 'documents' && <Documents data={data} action={action} reload={reload} />}{page === 'help' && <Help />}</div>
    </main><Toast toast={toast} onClose={() => setToast(null)} />
  </div>;
}
