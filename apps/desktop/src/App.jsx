import React, { useEffect, useMemo, useState } from 'react';
import Editor from '@monaco-editor/react';
import YAML from 'yaml';
import helpMarkdown from '../../../HELP.md?raw';

const nav = [
  ['dashboard', 'Overview', '⌁'],
  ['workflow', 'Workflow', '◇'],
  ['personas', 'Personas & approvals', '◎'],
  ['templates', 'Artifact templates', '▤'],
  ['documents', 'Documents', '▣'],
  ['help', 'Help', '?']
];

function Pill({ children, tone = 'neutral' }) { return <span className={`pill ${tone}`}>{children}</span>; }

function Empty({ title, detail, action }) {
  return <div className="empty"><div className="empty-mark">S</div><h2>{title}</h2><p>{detail}</p>{action}</div>;
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
    <section className="panel"><header className="panel-heading"><div><span className="eyebrow">Lifecycle</span><h2>Phase progress</h2></div></header><div className="phase-list">
      {p.phases.map((phase) => <div className={`phase-row ${phase.id === p.currentPhase ? 'active' : ''}`} key={phase.id}><StatusDot status={phase.status} /><div className="phase-copy"><strong>{phase.label}</strong><span>{phase.id}</span></div><Pill>{phase.generation ? `Generation ${phase.generation}` : 'Not generated'}</Pill><span className="approval-count">{phase.approvals}/{phase.approvalsRequired} approvals</span><span className="phase-status">{phase.status.replaceAll('_', ' ')}</span></div>)}
    </div></section>
  </div>;
}

function Workflow({ data, editor, setEditor, saveEditor }) {
  const draft = useMemo(() => { try { return YAML.parse(editor.content); } catch { return data.definition; } }, [editor.content, data.definition]);
  const [workType, setWorkType] = useState(Object.keys(draft.workTypes)[0]);
  const [phaseId, setPhaseId] = useState(draft.workTypes[workType]?.phases[0]);
  useEffect(() => { const first = draft.workTypes[workType]?.phases[0]; if (!draft.workTypes[workType]?.phases.includes(phaseId)) setPhaseId(first); }, [workType, draft, phaseId]);
  const profile = draft.workTypes[workType];
  const phase = draft.phases[phaseId];
  function change(mutator) { const next = structuredClone(draft); mutator(next); setEditor({ ...editor, content: YAML.stringify(next) }); }
  function toggleApprovalPersona(personaId) { change((next) => { const values = next.phases[phaseId].approval.personas ??= []; const index = values.indexOf(personaId); if (index >= 0) values.splice(index, 1); else { values.push(personaId); const capability = next.personas[personaId].mayApprove ??= []; if (!capability.includes(phaseId)) capability.push(phaseId); } }); }
  function toggleRejectTarget(target) { change((next) => { const values = next.phases[phaseId].approval.rejectTo ??= []; const index = values.indexOf(target); if (index >= 0) values.splice(index, 1); else values.push(target); }); }
  function movePhase(offset) { change((next) => { const phases = next.workTypes[workType].phases; const index = phases.indexOf(phaseId); const target = index + offset; if (target >= 0 && target < phases.length) [phases[index], phases[target]] = [phases[target], phases[index]]; }); }
  const phaseIndex = profile.phases.indexOf(phaseId);
  const templateNames = data.templates.map((item) => item.name);
  return <div className="split-page">
    <div className="design-pane"><header className="page-heading"><span className="eyebrow">Visual configuration</span><h1>Workflow designer</h1><p>Inspect phase order, approval authority, rejection paths, and template resolution.</p></header>
      <div className="segmented">{Object.entries(draft.workTypes).map(([id, item]) => <button className={id === workType ? 'active' : ''} key={id} onClick={() => setWorkType(id)}>{item.label}</button>)}</div>
      <div className="flow-canvas">{profile.phases.map((id, index) => <React.Fragment key={id}><button className={`phase-node ${id === phaseId ? 'selected' : ''}`} onClick={() => setPhaseId(id)}><span>{String(index + 1).padStart(2, '0')}</span><strong>{draft.phases[id].label}</strong><small>{draft.workTypes[workType].templateOverrides?.[id] ?? draft.phases[id].defaultTemplate}</small></button>{index < profile.phases.length - 1 && <div className="connector">↓</div>}</React.Fragment>)}</div>
      {phase && <section className="inspector"><div className="inspector-title"><div><span className="eyebrow">Selected phase</span><h2>{phase.label}</h2></div><div className="row"><button className="icon-button" disabled={phaseIndex === 0} onClick={() => movePhase(-1)}>↑</button><button className="icon-button" disabled={phaseIndex === profile.phases.length - 1} onClick={() => movePhase(1)}>↓</button><Pill tone="accent">{phase.writeScope}</Pill></div></div>
        <div className="control-grid"><label><span>Approval threshold</span><input type="number" min="0" max="10" value={phase.approval?.minimum ?? 0} onChange={(event) => change((next) => { next.phases[phaseId].approval.minimum = Number(event.target.value); })} /></label><label><span>Artifact template</span><select value={profile.templateOverrides?.[phaseId] ?? phase.defaultTemplate} onChange={(event) => change((next) => { next.workTypes[workType].templateOverrides ??= {}; next.workTypes[workType].templateOverrides[phaseId] = event.target.value; })}>{templateNames.map((name) => <option value={name} key={name}>{name}</option>)}</select></label><label className="full"><span>World-model views</span><input value={phase.worldModel?.views?.join(', ') ?? ''} onChange={(event) => change((next) => { next.phases[phaseId].worldModel.views = event.target.value.split(',').map((item) => item.trim()).filter(Boolean); })} /></label></div>
        <div className="choice-group"><span>Approval personas</span><div>{Object.entries(draft.personas).map(([id, persona]) => <label key={id} className={phase.approval?.personas?.includes(id) ? 'checked' : ''}><input type="checkbox" checked={phase.approval?.personas?.includes(id)} onChange={() => toggleApprovalPersona(id)} />{persona.label}</label>)}</div></div>
        <div className="choice-group"><span>Allowed rejection targets</span><div>{profile.phases.slice(0, phaseIndex + 1).map((id) => <label key={id} className={phase.approval?.rejectTo?.includes(id) ? 'checked' : ''}><input type="checkbox" checked={phase.approval?.rejectTo?.includes(id)} onChange={() => toggleRejectTarget(id)} />{draft.phases[id].label}</label>)}</div></div>
      </section>}
    </div>
    <SourceEditor path={data.definitionPath} value={editor.content} dirty={editor.content !== editor.original} onChange={(content) => setEditor({ ...editor, content })} language="yaml" onSave={saveEditor} />
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

function Templates({ data, editor, setEditor, chooseTemplate, saveEditor }) {
  const [search, setSearch] = useState('');
  const [preview, setPreview] = useState(false);
  const files = data.templates.filter((item) => item.name.toLowerCase().includes(search.toLowerCase()));
  return <div className="template-layout"><aside className="file-list"><header><span className="eyebrow">Artifact library</span><h2>Templates</h2><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Filter templates…" /></header>{files.map((file) => <button key={file.path} className={editor.path === file.path ? 'active' : ''} onClick={() => chooseTemplate(file)}><span>MD</span><div><strong>{file.name.split('/').at(-1)}</strong><small>{file.name.includes('/') ? file.name.slice(0, file.name.lastIndexOf('/')) : 'root'}</small></div></button>)}</aside>
    <main className="template-main"><header className="template-toolbar"><div><span className="eyebrow">Template studio</span><h1>{editor.path?.split('/').at(-1)}</h1></div><div className="row"><div className="segmented small"><button className={!preview ? 'active' : ''} onClick={() => setPreview(false)}>Source</button><button className={preview ? 'active' : ''} onClick={() => setPreview(true)}>Preview</button></div><Pill tone={editor.content !== editor.original ? 'warn' : 'good'}>{editor.content !== editor.original ? 'Unsaved' : 'Saved'}</Pill><button className="primary compact" disabled={editor.content === editor.original} onClick={saveEditor}>Save</button></div></header>
      {preview ? <TemplatePreview content={editor.content} /> : <Editor height="calc(100vh - 186px)" language="markdown" theme="vs-dark" value={editor.content} onChange={(content) => setEditor({ ...editor, content: content ?? '' })} options={{ minimap: { enabled: false }, fontSize: 13, lineHeight: 21, wordWrap: 'on', padding: { top: 20 }, scrollBeyondLastLine: false, automaticLayout: true }} />}
    </main></div>;
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
  const repoName = useMemo(() => data?.repository.root.split('/').at(-1), [data]);
  async function action(task, success) { setBusy(true); try { const result = await task(); if (success) setToast({ tone: 'good', text: success }); return result; } catch (error) { setToast({ tone: 'bad', text: error.message }); return null; } finally { setBusy(false); setTimeout(() => setToast(null), 5000); } }
  async function openRepository() { const result = await action(() => window.singularity.chooseRepository()); if (result) { setData(result); setEditor({ path: result.definitionPath, content: result.definitionText, original: result.definitionText, kind: 'workflow' }); } }
  async function reload(workId = data?.selectedWorkId) { if (!data) return; const result = await action(() => window.singularity.snapshot(data.repository.root, workId)); if (result) setData(result); }
  async function selectWorkItem(event) { await reload(event.target.value || null); }
  async function saveEditor() { const result = await action(() => window.singularity.saveFile(data.repository.root, editor.path, editor.content), `${editor.path} saved and validated`); if (result) { setEditor({ ...editor, original: editor.content }); await reload(); } }
  async function validate() { await action(() => window.singularity.validate(data.repository.root), 'Configuration is valid'); }
  async function publish() { const result = await action(() => window.singularity.publish(data.repository.root, 'Configure Singularity Flow desktop workflow'), 'Configuration committed and published'); if (result) await reload(); }
  function workflowPage() { setPage('workflow'); setEditor({ path: data.definitionPath, content: data.definitionText, original: data.definitionText, kind: 'workflow' }); }
  function chooseTemplate(file) { setEditor({ path: file.path, content: file.content, original: file.content, kind: 'template' }); }
  function openPrompt(file) { setEditor({ path: file.path, content: file.content, original: file.content, kind: 'persona' }); setPage('templates'); }

  if (!data && standaloneHelp) return <div className="standalone-help"><button className="ghost help-back" onClick={() => setStandaloneHelp(false)}>← Back</button><Help /></div>;
  if (!data) return <div className="welcome"><div className="brand large"><span>S</span><div><strong>Singularity</strong><small>Flow Studio</small></div></div><Empty title="Design governed workflows visually" detail="Open a Git repository initialized with Singularity Flow. Configuration stays in .singularity and every runtime transition remains controlled by the CLI." action={<div className="row"><button className="primary large-button" onClick={openRepository}>Open repository</button><button className="secondary large-button" onClick={() => setStandaloneHelp(true)}>Open help</button></div>} /></div>;
  return <div className="shell">
    <aside className="sidebar"><div className="brand"><span>S</span><div><strong>Singularity</strong><small>Flow Studio</small></div></div><nav>{nav.map(([id, label, icon]) => <button key={id} className={page === id ? 'active' : ''} onClick={() => id === 'workflow' ? workflowPage() : setPage(id)}><i>{icon}</i>{label}</button>)}</nav><div className="sidebar-bottom"><div className="repo-card"><span className="repo-icon">⌘</span><div><strong>{repoName}</strong><small>{data.repository.branch}</small></div><button onClick={openRepository}>⋯</button></div><div className={`connection ${data.repository.changes.length ? 'dirty' : ''}`}><span />{data.repository.changes.length ? `${data.repository.changes.length} uncommitted change(s)` : 'Working tree clean'}</div></div></aside>
    <main className="content"><header className="topbar"><div><select value={data.selectedWorkId ?? ''} onChange={selectWorkItem}><option value="">Configuration only</option>{data.workItems.map((item) => <option value={item.id} key={item.id}>{item.id} — {item.title}</option>)}</select>{data.workflow && <Pill tone="accent">{data.workflow.currentPhase ?? 'complete'}</Pill>}</div><div className="row"><button className="ghost" onClick={() => reload()} disabled={busy}>↻ Refresh</button><button className="secondary" onClick={validate} disabled={busy}>Validate</button><button className="primary" onClick={publish} disabled={busy || !data.repository.changes.length}>Commit & push</button></div></header>
      <div className={busy ? 'busy view' : 'view'}>{page === 'dashboard' && <Dashboard data={data} />}{page === 'workflow' && <Workflow data={data} editor={editor} setEditor={setEditor} saveEditor={saveEditor} />}{page === 'personas' && <Personas data={data} openPrompt={openPrompt} />}{page === 'templates' && <Templates data={data} editor={editor.kind === 'workflow' ? { path: data.templates[0]?.path, content: data.templates[0]?.content ?? '', original: data.templates[0]?.content ?? '', kind: 'template' } : editor} setEditor={setEditor} chooseTemplate={chooseTemplate} saveEditor={saveEditor} />}{page === 'documents' && <Documents data={data} action={action} reload={reload} />}{page === 'help' && <Help />}</div>
    </main>{toast && <div className={`toast ${toast.tone}`}>{toast.text}</div>}
  </div>;
}
