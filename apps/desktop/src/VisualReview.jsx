import React, { useEffect, useMemo, useState } from 'react';
import { classifyVisualEvidence, extractVisualDifference, isPreviewImage } from './visual-evidence.mjs';

function shortHash(value) {
  return value ? value.slice(0, 12) : 'unavailable';
}

function usePreviews(repository, workId, records) {
  const [state, setState] = useState({});
  const key = records.map((record) => `${record.id}:${record.sha256}`).join('|');
  useEffect(() => {
    let active = true;
    setState({});
    for (const record of records) {
      window.singularity.previewDocument(repository, workId, record.id)
        .then((preview) => { if (active) setState((current) => ({ ...current, [record.id]: { preview } })); })
        .catch((error) => { if (active) setState((current) => ({ ...current, [record.id]: { error: error.message } })); });
    }
    return () => { active = false; };
  }, [repository, workId, key]);
  return state;
}

function IntegrityCaption({ record, preview }) {
  return <div className="media-integrity"><span>matches committed record ✓</span><code>{shortHash(preview?.sha256 ?? record.sha256)}</code></div>;
}

export function GovernedMedia({ record, preview, onZoom }) {
  if (preview?.mime === 'application/pdf') {
    return <div className="governed-pdf"><iframe title={record.label} src={preview.dataUrl} /><IntegrityCaption record={record} preview={preview} /></div>;
  }
  if (preview?.dataUrl) {
    return <figure className="governed-image"><button type="button" onClick={() => onZoom?.(record, preview)} title="Open full-size pinned preview"><img src={preview.dataUrl} alt={record.label} /></button><figcaption><strong>{record.label}</strong><IntegrityCaption record={record} preview={preview} /></figcaption></figure>;
  }
  return <div className="media-loading">Loading governed preview…</div>;
}

export function MediaLightbox({ item, onClose }) {
  useEffect(() => {
    if (!item) return undefined;
    const close = (event) => { if (event.key === 'Escape') onClose(); };
    document.addEventListener('keydown', close);
    return () => document.removeEventListener('keydown', close);
  }, [item, onClose]);
  if (!item) return null;
  return <div className="media-lightbox" role="dialog" aria-modal="true" aria-label={`${item.record.label} full-size preview`} onClick={onClose}><div onClick={(event) => event.stopPropagation()}><header><div><strong>{item.record.label}</strong><small>Pinned intake · SHA-256 {item.preview.sha256}</small></div><button onClick={onClose} aria-label="Close">×</button></header><img src={item.preview.dataUrl} alt={item.record.label} /></div></div>;
}

export function PinnedMediaStrip({ repository, workId, records, selectedId, onSelect }) {
  const images = records.filter(isPreviewImage);
  const selected = images.find((record) => record.id === selectedId);
  const thumbnailRecords = [...images.slice(0, 24), ...(selected && !images.slice(0, 24).includes(selected) ? [selected] : [])];
  const previews = usePreviews(repository, workId, thumbnailRecords);
  if (!images.length) return null;
  return <section className="pinned-media-strip"><header><div><span className="eyebrow">Canonical previews</span><strong>Pinned design exports</strong></div><small>{images.length} hash-recorded image{images.length === 1 ? '' : 's'}</small></header><div>{images.map((record) => <button className={selectedId === record.id ? 'active' : ''} key={record.id} onClick={() => onSelect(record)}><span>{previews[record.id]?.preview?.dataUrl ? <img src={previews[record.id].preview.dataUrl} alt="" /> : 'IMG'}</span><strong>{record.label}</strong><small>{shortHash(record.sha256)} ✓</small></button>)}</div></section>;
}

function EvidenceSelect({ label, value, records, onChange }) {
  return <label><span>{label}</span><select value={value} onChange={(event) => onChange(event.target.value)}><option value="">Not available</option>{records.map((record) => <option value={record.id} key={record.id}>{record.label}</option>)}</select></label>;
}

function PreviewPane({ title, record, entry, onZoom }) {
  return <section className="comparison-pane"><header><span>{title}</span>{record && <code>{shortHash(record.sha256)}</code>}</header>{record ? entry?.error ? <div className="media-error">{entry.error}</div> : <GovernedMedia record={record} preview={entry?.preview} onZoom={onZoom} /> : <div className="media-empty">No {title.toLowerCase()} evidence is registered.</div>}</section>;
}

export function VisualComparisonReview({ repository, workId, records, artifactContent = '' }) {
  const evidence = useMemo(() => classifyVisualEvidence(records), [records]);
  const [designId, setDesignId] = useState(evidence.pinnedDesigns[0]?.id ?? '');
  const [buildId, setBuildId] = useState(evidence.builds[0]?.id ?? '');
  const [diffId, setDiffId] = useState(evidence.diffs[0]?.id ?? '');
  const [mode, setMode] = useState('side-by-side');
  const [position, setPosition] = useState(50);
  const [lightbox, setLightbox] = useState(null);
  useEffect(() => {
    if (!evidence.pinnedDesigns.some((item) => item.id === designId)) setDesignId(evidence.pinnedDesigns[0]?.id ?? '');
    if (!evidence.builds.some((item) => item.id === buildId)) setBuildId(evidence.builds[0]?.id ?? '');
    if (!evidence.diffs.some((item) => item.id === diffId)) setDiffId(evidence.diffs[0]?.id ?? '');
  }, [evidence, designId, buildId, diffId]);
  const design = evidence.pinnedDesigns.find((item) => item.id === designId);
  const build = evidence.builds.find((item) => item.id === buildId);
  const diff = evidence.diffs.find((item) => item.id === diffId);
  const previews = usePreviews(repository, workId, [design, build, diff].filter(Boolean));
  const metric = extractVisualDifference(artifactContent);
  const zoom = (record, preview) => preview?.dataUrl && setLightbox({ record, preview });
  if (!evidence.pinnedDesigns.length && !evidence.builds.length && !evidence.diffs.length) return null;
  return <section className="panel visual-comparison-review">
    <header className="panel-heading"><div><span className="eyebrow">Visual-verification evidence</span><h2>Design-to-build comparison</h2></div><div className="comparison-result">{metric ? <span className={metric.verdict === 'matched' ? 'good' : ''}>{metric.percent}% difference{metric.verdict === 'matched' ? ' ✓' : ''}</span> : <span>Difference not reported</span>}</div></header>
    <div className="governance-callout"><strong>Approval baseline: pinned intake</strong><span>The committed, SHA-recorded export is canonical. A live Figma file may have changed after intake.</span></div>
    <div className="comparison-controls"><EvidenceSelect label="Design" value={designId} records={evidence.pinnedDesigns} onChange={setDesignId} /><EvidenceSelect label="Build" value={buildId} records={evidence.builds} onChange={setBuildId} /><EvidenceSelect label="Diff" value={diffId} records={evidence.diffs} onChange={setDiffId} /><div className="comparison-modes">{[['side-by-side', 'Side by side'], ['slider', 'Overlay slider'], ['diff', 'Diff highlight']].map(([id, label]) => <button className={mode === id ? 'active' : ''} key={id} onClick={() => setMode(id)}>{label}</button>)}</div></div>
    {mode === 'side-by-side' && <div className="comparison-side-by-side"><PreviewPane title="Pinned design" record={design} entry={previews[designId]} onZoom={zoom} /><PreviewPane title="Implementation" record={build} entry={previews[buildId]} onZoom={zoom} /></div>}
    {mode === 'slider' && <div className="comparison-slider"><div>{design && previews[designId]?.preview?.dataUrl && <img src={previews[designId].preview.dataUrl} alt={design.label} />}{build && previews[buildId]?.preview?.dataUrl && <img className="comparison-overlay" style={{ clipPath: `inset(0 ${100 - position}% 0 0)` }} src={previews[buildId].preview.dataUrl} alt={build.label} />}<span style={{ left: `${position}%` }} /></div><label>Reveal implementation<input type="range" min="0" max="100" value={position} onChange={(event) => setPosition(Number(event.target.value))} /></label></div>}
    {mode === 'diff' && <div className="comparison-diff"><PreviewPane title="Diff highlight" record={diff} entry={previews[diffId]} onZoom={zoom} /></div>}
    <MediaLightbox item={lightbox} onClose={() => setLightbox(null)} />
  </section>;
}
