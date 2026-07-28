/**
 * RGM Explorer — a navigable, dark-themed visualization of the repository world model.
 *
 * Binds to real data only: `buildExplorerModel` normalizes the world-model files the snapshot
 * already delivered (manifest.json, per-view Markdown + `## Facts` YAML, domains, task guides,
 * evidence.jsonl). Every widget degrades gracefully — where a build did not capture a fact, the UI
 * says so rather than inventing numbers. Prose is rendered with the app's own `markdownBlocks`
 * (passed in as `renderMarkdown`) so we add no markdown dependency and stay inside the CSP.
 */
import React, { useEffect, useMemo, useState } from 'react';
import './explorer.css';
import { buildExplorerModel } from './parse.mjs';

/* ── Small inline icon set (no external font; CSP-safe) ──────────────────── */
const ICONS = {
  core: 'M6 3h8l4 4v14H6z M14 3v5h5 M9 12h6 M9 16h6',
  business: 'M4 8h16v11H4z M9 8V5h6v3 M4 13h16',
  architecture: 'M5 4h5v4H5z M14 16h5v4h-5z M14 4h5v4h-5z M10 6h4 M8 8v10h6',
  development: 'M8 8l-4 4 4 4 M16 8l4 4-4 4 M13 5l-2 14',
  testing: 'M9 3h6 M10 3v6l-5 9a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1l-5-9V3',
  release: 'M12 3c3 2 5 6 5 10l-5 4-5-4c0-4 2-8 5-10z M9 21l3-2 3 2',
  operations: 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z M19 12l2 1-1 3-2-1 M5 12l-2 1 1 3 2-1',
  security: 'M12 3l8 4v5c0 5-3.5 8-8 9-4.5-1-8-4-8-9V7z M9 12l2 2 4-4',
  domains: 'M3 21V7l6-4 6 4v14 M9 21v-6h4v6 M19 21V11l-4-2',
  taskguides: 'M4 4h11l5 5v11H4z M15 4v5h5 M8 13h8 M8 17h5',
  evidence: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z M8 12l2.5 2.5L16 9',
  spark: 'M12 3l1.4 4.8L18 9l-4.6 1.2L12 15l-1.4-4.8L6 9l4.6-1.2z',
  warn: 'M12 3l9 16H3z M12 9v5 M12 17h.01',
  arrow: 'M5 12h14 M13 6l6 6-6 6'
};

function Glyph({ name, className = 'rgm-tab-glyph' }) {
  const path = ICONS[name] ?? ICONS.core;
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {path.split(' M').map((segment, index) => <path key={index} d={(index ? 'M' : '') + segment} />)}
    </svg>
  );
}

/* ── Value normalization for the generic fact renderer ───────────────────── */
function asArray(value) { return Array.isArray(value) ? value : value == null ? [] : [value]; }

function pick(object, keys) { for (const key of keys) if (object?.[key] != null && object[key] !== '') return object[key]; return null; }

function normalizeItem(item) {
  if (item == null) return { label: '' };
  if (typeof item !== 'object') return { label: String(item) };
  const label = pick(item, ['name', 'id', 'title', 'label', 'term', 'interface', 'command', 'component', 'path']);
  const location = pick(item, ['path', 'location', 'file', 'schema', 'schema_location', 'source']);
  const line = pick(item, ['line', 'lines']);
  const detail = pick(item, ['description', 'purpose', 'reason', 'role', 'definition', 'note', 'summary', 'invocation']);
  const type = pick(item, ['type', 'kind', 'method']);
  const confidence = pick(item, ['confidence']);
  const status = pick(item, ['status']);
  const extra = pick(item, ['steps', 'flow', 'entities', 'endpoints', 'compliance', 'owner', 'relevant_views']);
  return { label: label != null ? String(label) : '', location: location != null ? String(location) : null, line, detail: detail != null ? String(detail) : null, type: type != null ? String(type) : null, confidence: confidence ? String(confidence).toLowerCase() : null, status: status ? String(status).toLowerCase() : null, extra, raw: item };
}

function locationLabel(item) {
  if (!item.location) return null;
  return item.line != null ? `${item.location}:${item.line}` : item.location;
}

/* Compact "path:start-end" for an evidence location object; falls back to JSON for unknown shapes. */
function formatLocation(value) {
  if (value == null) return '';
  if (typeof value !== 'object') return String(value);
  const path = pick(value, ['path', 'file', 'location', 'symbol']);
  const start = pick(value, ['start_line', 'startLine', 'line']);
  const end = pick(value, ['end_line', 'endLine']);
  if (!path) return JSON.stringify(value);
  if (start && end && start !== end) return `${path}:${start}-${end}`;
  if (start) return `${path}:${start}`;
  return String(path);
}

function Badges({ item }) {
  return (
    <>
      {item.status === 'inferred' && <span className="rgm-badge inferred">inferred</span>}
      {item.confidence && <span className={`rgm-badge ${item.confidence}`}>{item.confidence}</span>}
    </>
  );
}

/* ── Fact key → widget shape ─────────────────────────────────────────────── */
const NODE_KEYS = new Set(['components', 'modules', 'services']);
const ROW_KEYS = new Set(['entrypoints', 'entry_points', 'key_symbols', 'symbols', 'actors', 'workflows', 'core_workflows', 'data_stores', 'data_ownership', 'hotspots', 'risks', 'unknowns', 'debt', 'architectural_debt', 'flows', 'implementation_flows']);
const TABLE_KEYS = new Set(['contracts', 'interfaces', 'apis', 'endpoints']);
const TAG_KEYS = new Set(['languages', 'frameworks', 'infrastructure', 'stack', 'dependencies', 'boundaries', 'labels', 'tags', 'technologies']);
const DEF_KEYS = new Set(['ubiquitous_language', 'glossary', 'terms', 'definitions']);
const CARD_KEYS = new Set(['capabilities', 'bounded_contexts', 'contexts', 'domains']);
const RISK_KEYS = new Set(['hotspots', 'risks', 'unknowns', 'debt', 'architectural_debt']);

function humanize(key) { return key.replace(/[_-]+/g, ' ').replace(/\b\w/g, (character) => character.toUpperCase()); }

function FactValue({ name, value }) {
  const key = name.toLowerCase();
  const items = asArray(value).map(normalizeItem).filter((item) => item.label || item.detail || item.location);

  if (!items.length && value != null && typeof value !== 'object') {
    return <div className="rgm-tag">{String(value)}</div>;
  }
  if (!items.length) return null;

  if (NODE_KEYS.has(key)) {
    return <div className="rgm-nodes">{items.map((item, index) => (
      <div className="rgm-node" key={index}>
        <div className="rgm-node-name">{item.label}</div>
        {(item.type || item.detail) && <div className="rgm-node-sub">{item.type || item.detail}</div>}
      </div>
    ))}</div>;
  }
  if (TAG_KEYS.has(key)) {
    return <div className="rgm-anchors">{items.map((item, index) => (
      <span className="rgm-tag" key={index}>{item.label}{item.detail ? ` · ${item.detail}` : ''}</span>
    ))}</div>;
  }
  if (DEF_KEYS.has(key)) {
    return <dl className="rgm-kv">{items.map((item, index) => (
      <React.Fragment key={index}><dt>{item.label}</dt><dd>{item.detail || <span className="rgm-muted">—</span>}</dd></React.Fragment>
    ))}</dl>;
  }
  if (TABLE_KEYS.has(key)) {
    return <table className="rgm-table"><thead><tr><th>{humanize(key).replace(/s$/, '')}</th><th>Type</th><th>Location</th><th>Confidence</th></tr></thead><tbody>
      {items.map((item, index) => (
        <tr key={index}>
          <td>{item.label}</td>
          <td className="rgm-muted" style={{ fontFamily: 'var(--rgm-mono)', fontSize: 12 }}>{item.type || '—'}</td>
          <td>{locationLabel(item) ? <span className="rgm-path">{locationLabel(item)}</span> : <span className="rgm-muted">{item.detail || '—'}</span>}</td>
          <td>{item.confidence ? <span className={`rgm-badge ${item.confidence}`}>{item.confidence}</span> : (item.status === 'inferred' ? <span className="rgm-badge inferred">inferred</span> : <span className="rgm-muted">—</span>)}</td>
        </tr>
      ))}
    </tbody></table>;
  }
  if (CARD_KEYS.has(key)) {
    return <div className="rgm-two">{items.map((item, index) => (
      <div className="rgm-card accent-amber" key={index}>
        <div className="rgm-card-body">
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
            <strong style={{ fontSize: 15 }}>{item.label}</strong><Badges item={item} />
          </div>
          {item.detail && <div className="rgm-row-sub" style={{ fontFamily: 'var(--rgm-sans)' }}>{item.detail}</div>}
          {locationLabel(item) && <div className="rgm-path" style={{ marginTop: 8 }}>{locationLabel(item)}</div>}
        </div>
      </div>
    ))}</div>;
  }
  if (RISK_KEYS.has(key)) {
    return <div>{items.map((item, index) => (
      <div className={`rgm-risk ${RISK_KEYS.has(key) && key !== 'risks' ? 'warn' : ''}`} key={index}>
        <div className="rgm-risk-head"><Glyph name="warn" className="rgm-head-accent" />{item.label || item.location}</div>
        {(item.detail || item.location) && <div className="rgm-risk-detail">{item.detail}{item.detail && item.location ? ' · ' : ''}{item.location && <span className="rgm-path">{locationLabel(item)}</span>}</div>}
      </div>
    ))}</div>;
  }
  // Default: labeled rows.
  return <div className="rgm-list">{items.map((item, index) => (
    <div className="rgm-row" key={index}>
      <div className="rgm-row-main">
        <div className="rgm-row-title" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>{item.label || locationLabel(item)}<Badges item={item} /></div>
        {item.detail && <div className="rgm-row-sub" style={{ fontFamily: 'var(--rgm-sans)' }}>{item.detail}</div>}
        {locationLabel(item) && item.label && <div className="rgm-path" style={{ marginTop: 4 }}>{locationLabel(item)}</div>}
        {Array.isArray(item.extra) && item.extra.length > 0 && <div className="rgm-anchors" style={{ marginTop: 6 }}>{item.extra.map((step, stepIndex) => <span className="rgm-tag" key={stepIndex}>{typeof step === 'object' ? (pick(step, ['name', 'label', 'id']) ?? JSON.stringify(step)) : String(step)}</span>)}</div>}
      </div>
    </div>
  ))}</div>;
}

function FactsCard({ facts, accent }) {
  const entries = Object.entries(facts).filter(([, value]) => value != null && (!Array.isArray(value) || value.length));
  if (!entries.length) return null;
  return (
    <div className={`rgm-card accent-${accent}`}>
      <header><Glyph name="spark" className="rgm-head-accent" /><h3>Facts</h3><span className="rgm-spacer" /><span className="rgm-badge observed">observed</span></header>
      <div className="rgm-card-body" style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
        {entries.map(([name, value]) => (
          <section key={name}>
            <div className="rgm-section-title">{humanize(name)}</div>
            <FactValue name={name} value={value} />
          </section>
        ))}
      </div>
    </div>
  );
}

/* ── Generic per-view panel (Business / Architecture / Development / …) ───── */
function ViewPanel({ view, renderMarkdown }) {
  return (
    <div className="rgm-grid">
      <div className="rgm-col">
        {view.tldr && (
          <div className={`rgm-card accent-${view.accent}`}>
            <header><Glyph name={view.icon} className="rgm-head-accent" /><h3>{view.label} — TL;DR</h3>
              <span className="rgm-spacer" />
              {view.header?.tier && <span className="rgm-tag">{view.header.tier}</span>}
            </header>
            <div className="rgm-card-body rgm-prose">{renderMarkdown(view.tldr)}</div>
          </div>
        )}
        {view.facts && <FactsCard facts={view.facts} accent={view.accent} />}
        {!view.facts && (
          <div className="rgm-note"><Glyph name="warn" className="rgm-note-mark" /><span>This build did not capture a structured <code>## Facts</code> block for the {view.label} view. Showing the narrative below.</span></div>
        )}
        {view.sections.map((section, index) => (
          <div className="rgm-card" key={index}>
            <header><h3>{section.title}</h3></header>
            <div className="rgm-card-body rgm-prose">{renderMarkdown(section.body)}</div>
          </div>
        ))}
      </div>
      <div className="rgm-col">
        <ViewMetaCard view={view} />
      </div>
    </div>
  );
}

function ViewMetaCard({ view }) {
  return (
    <div className="rgm-card">
      <header><h3>View metadata</h3></header>
      <div className="rgm-card-body" style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        <dl className="rgm-kv">
          {view.header?.tier && <><dt>tier</dt><dd>{view.header.tier}</dd></>}
          {view.header?.depth && <><dt>depth</dt><dd>{view.header.depth}</dd></>}
          {view.header?.builder && <><dt>builder</dt><dd>{view.header.builder}</dd></>}
          {view.header?.generatedDate && <><dt>generated</dt><dd>{view.header.generatedDate}</dd></>}
        </dl>
        {view.references?.length > 0 && (
          <section>
            <div className="rgm-section-title">Consumed by</div>
            <div className="rgm-anchors">{view.references.map((reference, index) => <span className="rgm-tag azure" key={index}>{reference}</span>)}</div>
          </section>
        )}
        {view.anchors?.length > 0 && (
          <section>
            <div className="rgm-section-title">Sections</div>
            <div className="rgm-anchors">{view.anchors.map((entry, index) => <span className="rgm-anchor" key={index}>#{entry.anchor}</span>)}</div>
          </section>
        )}
      </div>
    </div>
  );
}

/* ── Core Summary (bespoke) ──────────────────────────────────────────────── */
function DepthStepper({ depth }) {
  const levels = { quick: 1, standard: 2, deep: 3 };
  const filled = levels[String(depth).toLowerCase()] ?? 0;
  return (
    <div className="rgm-depth" title={`Analysis depth: ${depth ?? 'unknown'}`}>
      {[0, 1, 2].map((index) => <span key={index} className={`rgm-depth-seg ${index < filled ? 'on' : ''}`} />)}
    </div>
  );
}

function Stat({ value, label, accent }) {
  return (
    <div className={`rgm-stat ${accent ? 'accent' : ''}`}>
      <div className="rgm-stat-num">{value == null ? '—' : value}</div>
      <div className="rgm-stat-label">{label}</div>
    </div>
  );
}

function HeroMotif() {
  return (
    <svg className="rgm-hero-svg" viewBox="0 0 800 300" preserveAspectRatio="xMidYMid slice" aria-hidden="true">
      <defs>
        <pattern id="rgmDots" width="26" height="26" patternUnits="userSpaceOnUse">
          <circle cx="1.5" cy="1.5" r="1.1" fill="#38bdf8" opacity="0.25" />
        </pattern>
      </defs>
      <rect width="800" height="300" fill="url(#rgmDots)" />
      <g stroke="#38bdf8" strokeWidth="1" fill="none" opacity="0.4">
        <path d="M520 40 L640 90 L720 60" /><path d="M600 160 L700 130 L780 170" />
        <path d="M560 220 L660 250" />
      </g>
      <g stroke="#4edea3" strokeWidth="1" fill="none" opacity="0.35">
        <path d="M480 120 L590 150 L690 110" /><path d="M520 250 L620 210" />
      </g>
      {[[640, 90], [720, 60], [700, 130], [590, 150], [660, 250]].map(([cx, cy], index) => (
        <circle key={index} cx={cx} cy={cy} r="3" fill="#8ed5ff" opacity="0.7" />
      ))}
    </svg>
  );
}

function CoreSummary({ model, renderMarkdown, onOpenView }) {
  const { provenance, stats, description, core, views } = model;
  const architecture = views.find((view) => view.id === 'architecture');
  const componentFacts = pick(architecture?.facts ?? {}, ['components', 'services', 'modules'])
    ?? pick(views.find((view) => view.facts?.components)?.facts ?? {}, ['components']);
  const stackView = views.find((view) => view.facts && (view.facts.languages || view.facts.frameworks || view.facts.stack || view.facts.technologies));
  const risks = collectRisks(model);

  return (
    <div className="rgm-grid">
      <div className="rgm-col">
        <div className="rgm-hero">
          <HeroMotif />
          <div className="rgm-eyebrow">
            <span className="rgm-eyebrow-caps">Repository Grounding Model</span>
            <span className="rgm-muted">·</span>
            <span className="rgm-tag azure">{provenance.stale ? 'Model stale' : 'Model active'}</span>
          </div>
          <h1>{provenance.name}</h1>
          {description
            ? <p>{firstParagraph(description)}</p>
            : <p className="rgm-muted">No repository summary was captured. Build or rebuild the world model to generate a <code>core/summary.md</code> orientation.</p>}
          <div className="rgm-hero-chips">
            {provenance.shortCommit && <span className="rgm-chip"><Glyph name="core" className="rgm-head-accent" style={{ width: 14 }} /> sha: {provenance.shortCommit}</span>}
            {provenance.branch && <span className="rgm-chip">⑂ {provenance.branch}</span>}
            {provenance.generatedDate && <span className="rgm-chip rgm-fresh">◷ {provenance.generatedDate}</span>}
          </div>
        </div>

        {componentFacts
          ? <div className="rgm-card accent-azure"><header><Glyph name="architecture" className="rgm-head-accent" /><h3>Component architecture</h3><span className="rgm-spacer" /><button className="rgm-tag azure" onClick={() => onOpenView('architecture')} style={{ cursor: 'pointer' }}>Expand ↗</button></header><div className="rgm-card-body"><FactValue name="components" value={componentFacts} /></div></div>
          : <div className="rgm-note"><Glyph name="warn" className="rgm-note-mark" /><span>Component topology not captured by this build. It appears once an <code>architecture</code> view with a <code>components</code> fact is generated.</span></div>}

        {stackView && (
          <div className="rgm-card"><header><Glyph name="development" className="rgm-head-accent" /><h3>Technology stack</h3></header>
            <div className="rgm-card-body" style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
              {['languages', 'frameworks', 'infrastructure', 'technologies', 'stack'].filter((key) => stackView.facts[key]).map((key) => (
                <section key={key}><div className="rgm-section-title">{humanize(key)}</div><FactValue name={key} value={stackView.facts[key]} /></section>
              ))}
            </div>
          </div>
        )}

        {core?.sections?.length > 0 && !description && (
          <div className="rgm-card"><header><h3>Orientation</h3></header><div className="rgm-card-body rgm-prose">{renderMarkdown(core.sections[0].body)}</div></div>
        )}
      </div>

      <div className="rgm-col">
        <div className="rgm-stats">
          <Stat value={stats.entryPoints} label="Entry points" accent />
          <Stat value={stats.components} label="Components" />
          <Stat value={stats.views} label="Views built" />
          <div className="rgm-stat">
            <div className="rgm-stat-num" style={{ fontSize: 16, textTransform: 'capitalize', marginBottom: 8 }}>{provenance.analysisDepth ?? 'unknown'}</div>
            <DepthStepper depth={provenance.analysisDepth} />
            <div className="rgm-stat-label" style={{ marginTop: 8 }}>Analysis depth</div>
          </div>
        </div>

        <div className={`rgm-card ${risks.length ? 'accent-ruby' : ''}`}>
          <header><Glyph name="warn" className="rgm-head-accent" /><h3>Risks &amp; unknowns</h3></header>
          <div className="rgm-card-body">
            {risks.length
              ? risks.map((risk, index) => (
                <div className={`rgm-risk ${risk.tone}`} key={index}>
                  <div className="rgm-risk-head">{risk.title}</div>
                  {risk.detail && <div className="rgm-risk-detail">{risk.detail}</div>}
                </div>
              ))
              : <div className="rgm-muted" style={{ fontSize: 13 }}>No risks or unknowns were flagged by this build.</div>}
          </div>
        </div>

        <div className="rgm-card">
          <header><Glyph name="arrow" className="rgm-head-accent" /><h3>Recommended actions</h3></header>
          <div className="rgm-card-body" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {['architecture', 'development', 'security'].filter((id) => views.some((view) => view.id === id)).map((id) => (
              <button className="rgm-btn ghost" key={id} onClick={() => onOpenView(id)} style={{ justifyContent: 'space-between', width: '100%' }}>
                <span style={{ textTransform: 'capitalize' }}>Open {id} view</span><Glyph name="arrow" className="rgm-head-accent" />
              </button>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

/* Derive honest risks: dirty tree, staleness, and low-confidence evidence — no fabrication. */
function collectRisks(model) {
  const risks = [];
  if (model.provenance.workingTreeClean === false) risks.push({ title: 'Working tree was not clean at build time', detail: 'The model describes uncommitted state; treat file locations as hints.', tone: 'warn' });
  if (model.provenance.stale) risks.push({ title: 'World model is stale', detail: model.rebuildReason || 'Rebuild it against the current commit before relying on it.', tone: '' });
  const lowConfidence = model.evidence.records.filter((record) => String(record.confidence ?? '').toLowerCase() === 'low');
  for (const record of lowConfidence.slice(0, 3)) risks.push({ title: `Low-confidence claim: ${record.claim ?? record.id ?? 'evidence record'}`, detail: record.path ?? record.location ?? null, tone: 'warn' });
  if (model.evidence.errors) risks.push({ title: `${model.evidence.errors} unparseable evidence record${model.evidence.errors === 1 ? '' : 's'}`, detail: 'The evidence ledger has malformed lines.', tone: 'warn' });
  return risks;
}

function firstParagraph(text) {
  return String(text).split(/\n\s*\n/)[0].replace(/\s+/g, ' ').trim();
}

/* ── Analysis panels ─────────────────────────────────────────────────────── */
function DocList({ docs, renderMarkdown, icon, emptyLabel }) {
  const [openId, setOpenId] = useState(docs[0]?.id ?? null);
  const active = docs.find((doc) => doc.id === openId) ?? docs[0] ?? null;
  if (!docs.length) return <div className="rgm-note"><Glyph name="warn" className="rgm-note-mark" /><span>{emptyLabel}</span></div>;
  return (
    <div className="rgm-grid">
      <div className="rgm-col">
        {active
          ? <div className="rgm-card"><header><Glyph name={icon} className="rgm-head-accent" /><h3>{active.id}{active.task ? ` — ${active.task}` : ''}</h3></header>
            <div className="rgm-card-body rgm-prose">
              {!active.present && <div className="rgm-note"><Glyph name="warn" className="rgm-note-mark" /><span>Document file <code>{active.path}</code> is referenced by the manifest but was not found in this snapshot.</span></div>}
              {active.tldr && <p>{firstParagraph(active.tldr)}</p>}
              {active.sections.map((section, index) => <div key={index}><h3>{section.title}</h3>{renderMarkdown(section.body)}</div>)}
            </div></div>
          : null}
      </div>
      <div className="rgm-col">
        <div className="rgm-card"><header><h3>{docs.length} {docs.length === 1 ? 'entry' : 'entries'}</h3></header>
          <div className="rgm-card-body rgm-list">
            {docs.map((doc) => (
              <button key={doc.id} className="rgm-row" style={{ background: 'none', border: 'none', textAlign: 'left', cursor: 'pointer', color: 'inherit', width: '100%' }} onClick={() => setOpenId(doc.id)}>
                <div className="rgm-row-main">
                  <div className="rgm-row-title" style={{ color: active?.id === doc.id ? 'var(--rgm-azure)' : undefined }}>{doc.id}</div>
                  {doc.task && <div className="rgm-row-sub" style={{ fontFamily: 'var(--rgm-sans)' }}>{doc.task}</div>}
                  {Array.isArray(doc.relevantViews) && doc.relevantViews.length > 0 && <div className="rgm-anchors" style={{ marginTop: 6 }}>{doc.relevantViews.map((view) => <span className="rgm-tag" key={view}>{view}</span>)}</div>}
                </div>
              </button>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

function EvidencePanel({ evidence }) {
  if (!evidence.records.length) return <div className="rgm-note"><Glyph name="warn" className="rgm-note-mark" /><span>No evidence ledger was captured by this build.</span></div>;
  const columns = [...new Set(evidence.records.flatMap((record) => Object.keys(record)))].slice(0, 6);
  return (
    <div className="rgm-card"><header><Glyph name="evidence" className="rgm-head-accent" /><h3>Evidence ledger</h3><span className="rgm-spacer" /><span className="rgm-tag">{evidence.records.length} records</span>{evidence.errors ? <span className="rgm-tag amber">{evidence.errors} malformed</span> : null}</header>
      <div className="rgm-card-body" style={{ overflowX: 'auto' }}>
        <table className="rgm-table">
          <thead><tr>{columns.map((column) => <th key={column}>{column}</th>)}</tr></thead>
          <tbody>
            {evidence.records.slice(0, 200).map((record, index) => (
              <tr key={index}>{columns.map((column) => {
                const value = record[column];
                if (column === 'confidence' && value) return <td key={column}><span className={`rgm-badge ${String(value).toLowerCase()}`}>{String(value)}</span></td>;
                if (value == null) return <td key={column}><span className="rgm-muted">{'—'}</span></td>;
                if (Array.isArray(value)) return <td key={column}><div className="rgm-anchors">{value.map((item, itemIndex) => <span className="rgm-path" key={itemIndex}>{formatLocation(item)}</span>)}</div></td>;
                if (typeof value === 'object') return <td key={column}><span className="rgm-path">{formatLocation(value)}</span></td>;
                if (column === 'path' || column === 'location') return <td key={column}><span className="rgm-path">{String(value)}</span></td>;
                return <td key={column}>{String(value)}</td>;
              })}</tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/* ── Empty state (no model at all) ───────────────────────────────────────── */
function EmptyState({ reason, onBuild }) {
  return (
    <div className="rgm-explorer"><div className="rgm-empty"><div className="rgm-empty-card">
      <div className="rgm-empty-mark"><Glyph name="core" className="rgm-head-accent" /></div>
      <h2>No world model yet</h2>
      <p>{reason || 'This repository has not been grounded. Build a repository world model to explore its architecture, business capabilities, source map, and evidence here.'}</p>
      {onBuild && <button className="rgm-btn" onClick={() => onBuild()}>Build world model</button>}
    </div></div></div>
  );
}

/* ── Root ────────────────────────────────────────────────────────────────── */
export default function WorldModelExplorer({ data, generateWorldModel, renderMarkdown }) {
  const worldModel = data?.worldModel ?? null;
  const model = useMemo(() => buildExplorerModel(worldModel, data?.repository ?? {}), [worldModel, data?.repository]);
  const [tab, setTab] = useState('core');

  const viewTabs = model.views;
  const analysisTabs = [
    model.availability.domains && { id: 'domains', label: 'Domains', icon: 'domains' },
    model.availability.taskGuides && { id: 'taskguides', label: 'Task Guides', icon: 'taskguides' },
    model.availability.evidence && { id: 'evidence', label: 'Evidence', icon: 'evidence' }
  ].filter(Boolean);

  // If the active tab disappears (repo switch), fall back to Core.
  useEffect(() => {
    const valid = new Set(['core', ...viewTabs.map((view) => view.id), ...analysisTabs.map((entry) => entry.id)]);
    if (!valid.has(tab)) setTab('core');
  }, [tab, viewTabs, analysisTabs]);

  if (!model.present) {
    return <EmptyState reason={model.rebuildReason} onBuild={generateWorldModel ? () => generateWorldModel(true) : null} />;
  }

  const activeView = viewTabs.find((view) => view.id === tab);

  return (
    <div className="rgm-explorer">
      <div className="rgm-topbar">
        <div className="rgm-logo"><Glyph name="architecture" className="rgm-head-accent" /></div>
        <div className="rgm-repo">
          <strong>{model.provenance.name}</strong>
          <div className="rgm-repo-meta">
            {model.provenance.branch && <span>⑂ {model.provenance.branch}</span>}
            {model.provenance.shortCommit && <span>sha: {model.provenance.shortCommit}</span>}
          </div>
        </div>
        <span className="rgm-spacer" />
        {model.provenance.generatedDate && <span className="rgm-chip"><span className="rgm-dot" /> {model.provenance.generatedDate}</span>}
        {model.provenance.workingTreeClean === false && <span className="rgm-chip rgm-dirty"><span className="rgm-dot" /> working tree dirty</span>}
        <span className={`rgm-chip ${model.provenance.stale ? 'rgm-stale' : 'rgm-fresh'}`}><span className={`rgm-dot ${model.provenance.stale ? '' : 'pulse'}`} />{model.provenance.stale ? 'Stale' : 'Fresh'}</span>
      </div>

      <div className="rgm-tabs">
        <button className={`rgm-tab ${tab === 'core' ? 'active' : ''}`} onClick={() => setTab('core')}><Glyph name="core" /> Core Summary</button>
        {viewTabs.length > 0 && <span className="rgm-tab-caps">Views</span>}
        {viewTabs.map((view) => (
          <button key={view.id} className={`rgm-tab ${tab === view.id ? 'active' : ''}`} onClick={() => setTab(view.id)}><Glyph name={view.icon} /> {view.label}</button>
        ))}
        {analysisTabs.length > 0 && <span className="rgm-tab-sep" />}
        {analysisTabs.length > 0 && <span className="rgm-tab-caps">Analysis</span>}
        {analysisTabs.map((entry) => (
          <button key={entry.id} className={`rgm-tab ${tab === entry.id ? 'active' : ''}`} onClick={() => setTab(entry.id)}><Glyph name={entry.icon} /> {entry.label}</button>
        ))}
      </div>

      <div className="rgm-body">
        {tab === 'core' && <CoreSummary model={model} renderMarkdown={renderMarkdown} onOpenView={(id) => setTab(id)} />}
        {activeView && <ViewPanel view={activeView} renderMarkdown={renderMarkdown} />}
        {tab === 'domains' && <DocList docs={model.domains} renderMarkdown={renderMarkdown} icon="domains" emptyLabel="No domain models were captured by this build." />}
        {tab === 'taskguides' && <DocList docs={model.taskGuides} renderMarkdown={renderMarkdown} icon="taskguides" emptyLabel="No task guides were captured by this build." />}
        {tab === 'evidence' && <EvidencePanel evidence={model.evidence} />}
      </div>
    </div>
  );
}
