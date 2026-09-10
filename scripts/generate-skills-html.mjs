import { readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import YAML from 'yaml';

import { auditSkillPolicy } from './skill-policy.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const skillRoot = path.join(root, 'plugin', 'skills');
const target = path.join(root, 'docs', 'SINGULARITY-FLOW-SKILLS.html');
const write = process.argv.includes('--write');

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function splitSkill(text, file) {
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
  if (!match) throw new Error(`${file}: missing YAML frontmatter`);
  return { frontmatter: YAML.parse(match[1]) ?? {}, body: match[2] };
}

function option(value) {
  return `<option value="${escapeHtml(value)}">${escapeHtml(value)}</option>`;
}

const audit = await auditSkillPolicy(root);
if (audit.errors.length) {
  throw new Error(`Cannot publish an invalid skill catalog:\n- ${audit.errors.join('\n- ')}`);
}
const policyByName = new Map(audit.rows.map((row) => [row.name, row]));
const directories = (await readdir(skillRoot, { withFileTypes: true }))
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort((left, right) => left.localeCompare(right));
const skills = await Promise.all(directories.map(async (directory) => {
  const file = path.join(skillRoot, directory, 'SKILL.md');
  const source = await readFile(file, 'utf8');
  const parsed = splitSkill(source, file);
  const policy = policyByName.get(directory);
  if (!policy) throw new Error(`${directory}: missing audited policy row`);
  return {
    id: directory,
    source,
    ...parsed.frontmatter,
    body: parsed.body,
    policy
  };
}));

const classes = [...new Set(skills.map((skill) => skill.policy.class))].sort();
const boundaries = [...new Set(skills.map((skill) => skill.policy.executionBoundary))].sort();
const automaticCount = skills.filter((skill) => skill.policy.automatic).length;
const neverModelCount = skills.filter((skill) => skill.policy.kernelModelPolicy === 'never').length;

const navigation = skills.map((skill) => `
  <a href="#${escapeHtml(skill.id)}" data-skill-link="${escapeHtml(skill.id)}">
    <span>${escapeHtml(skill.name)}</span>
    <small>${escapeHtml(skill.policy.class)}</small>
  </a>`).join('');

const cards = skills.map((skill, index) => {
  const modelOperations = skill.policy.modelOperations.length
    ? skill.policy.modelOperations.join(', ')
    : 'none';
  return `
  <article class="skill-card" id="${escapeHtml(skill.id)}"
    data-name="${escapeHtml(skill.name)}"
    data-class="${escapeHtml(skill.policy.class)}"
    data-boundary="${escapeHtml(skill.policy.executionBoundary)}"
    data-invocation="${skill.policy.automatic ? 'automatic' : 'explicit'}"
    data-model="${escapeHtml(skill.policy.kernelModelPolicy)}">
    <details${index === 0 ? ' open' : ''}>
      <summary>
        <span class="skill-number">${String(index + 1).padStart(3, '0')}</span>
        <span class="skill-title"><strong>${escapeHtml(skill.name)}</strong><span>${escapeHtml(skill.description)}</span></span>
        <span class="chevron" aria-hidden="true"></span>
      </summary>
      <div class="skill-content">
        <div class="pills" aria-label="Skill policy">
          <span class="pill ${skill.policy.automatic ? 'accent' : ''}">${skill.policy.automatic ? 'automatic' : 'explicit only'}</span>
          <span class="pill">${escapeHtml(skill.policy.class)}</span>
          <span class="pill">${escapeHtml(skill.policy.executionBoundary)} boundary</span>
          <span class="pill">model: ${escapeHtml(skill.policy.kernelModelPolicy)}</span>
          <span class="pill">~${skill.policy.bodyTokens} body tokens</span>
        </div>
        <dl>
          <div><dt>Command</dt><dd><code>/${escapeHtml(skill.name)}</code></dd></div>
          <div><dt>Arguments</dt><dd><code>${escapeHtml(skill['argument-hint'] || 'none')}</code></dd></div>
          <div><dt>Model-capable operations</dt><dd>${escapeHtml(modelOperations)}</dd></div>
          <div><dt>Source</dt><dd><code>plugin/skills/${escapeHtml(skill.id)}/SKILL.md</code></dd></div>
        </dl>
        <div class="source-heading">
          <h3>Complete skill instructions</h3>
          <button type="button" class="copy" data-copy="${escapeHtml(skill.id)}">Copy Markdown</button>
        </div>
        <pre data-source="${escapeHtml(skill.id)}"><code>${escapeHtml(skill.source)}</code></pre>
      </div>
    </details>
  </article>`;
}).join('');

const content = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="color-scheme" content="light dark">
  <title>Singularity Flow Skill Catalog</title>
  <style>
    :root {
      --bg: #f6f7fb; --panel: #ffffff; --panel-2: #f0f3f9; --text: #152033;
      --muted: #5d6879; --line: #dce2eb; --accent: #3159d8; --accent-soft: #e8edff;
      --code: #111827; --code-text: #e5e7eb; --shadow: 0 12px 35px rgba(23, 36, 64, .08);
    }
    @media (prefers-color-scheme: dark) {
      :root {
        --bg: #0b1020; --panel: #121a2a; --panel-2: #182236; --text: #edf2ff;
        --muted: #a7b1c2; --line: #2b3850; --accent: #8da8ff; --accent-soft: #202f59;
        --code: #080d18; --code-text: #e5e7eb; --shadow: 0 12px 35px rgba(0, 0, 0, .28);
      }
    }
    * { box-sizing: border-box; }
    html { scroll-behavior: smooth; }
    body { margin: 0; background: var(--bg); color: var(--text); font: 15px/1.55 ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    button, input, select { font: inherit; }
    button:focus-visible, input:focus-visible, select:focus-visible, a:focus-visible, summary:focus-visible { outline: 3px solid var(--accent); outline-offset: 2px; }
    header { padding: 48px clamp(24px, 5vw, 72px) 32px; color: white; background: linear-gradient(125deg, #16285f, #3159d8 62%, #4b74ee); }
    header .eyebrow { margin: 0 0 10px; font-size: 12px; font-weight: 800; letter-spacing: .16em; text-transform: uppercase; opacity: .75; }
    header h1 { margin: 0; font-size: clamp(32px, 5vw, 56px); letter-spacing: -.04em; line-height: 1.04; }
    header p { max-width: 820px; margin: 18px 0 0; font-size: 18px; opacity: .88; }
    .stats { display: flex; flex-wrap: wrap; gap: 10px; margin-top: 24px; }
    .stat { padding: 8px 12px; border: 1px solid rgba(255,255,255,.25); border-radius: 999px; background: rgba(255,255,255,.10); }
    .toolbar { position: sticky; top: 0; z-index: 10; display: grid; grid-template-columns: minmax(220px, 1fr) repeat(3, minmax(130px, 180px)) auto; gap: 10px; padding: 14px clamp(18px, 4vw, 48px); border-bottom: 1px solid var(--line); background: color-mix(in srgb, var(--panel) 94%, transparent); backdrop-filter: blur(16px); }
    .toolbar input, .toolbar select, .toolbar button { min-height: 42px; border: 1px solid var(--line); border-radius: 9px; color: var(--text); background: var(--panel); padding: 8px 11px; }
    .toolbar button { cursor: pointer; font-weight: 700; }
    .layout { display: grid; grid-template-columns: 260px minmax(0, 1fr); gap: 28px; max-width: 1500px; margin: 0 auto; padding: 30px clamp(18px, 4vw, 48px) 70px; }
    nav { position: sticky; top: 86px; align-self: start; max-height: calc(100vh - 110px); overflow: auto; padding: 10px; border: 1px solid var(--line); border-radius: 14px; background: var(--panel); }
    nav h2 { margin: 6px 8px 10px; font-size: 13px; text-transform: uppercase; letter-spacing: .09em; color: var(--muted); }
    nav a { display: flex; justify-content: space-between; gap: 8px; padding: 7px 8px; border-radius: 7px; color: var(--text); text-decoration: none; }
    nav a:hover { background: var(--panel-2); }
    nav small { color: var(--muted); }
    main { min-width: 0; }
    .result-row { display: flex; align-items: baseline; justify-content: space-between; gap: 20px; margin: 0 0 14px; }
    .result-row h2 { margin: 0; font-size: 19px; }
    .result-row p { margin: 0; color: var(--muted); }
    .skill-card { margin-bottom: 12px; border: 1px solid var(--line); border-radius: 13px; background: var(--panel); box-shadow: var(--shadow); scroll-margin-top: 84px; overflow: hidden; }
    .skill-card[hidden] { display: none; }
    summary { display: grid; grid-template-columns: 48px minmax(0, 1fr) 18px; gap: 12px; align-items: start; cursor: pointer; padding: 18px 20px; list-style: none; }
    summary::-webkit-details-marker { display: none; }
    summary:hover { background: var(--panel-2); }
    .skill-number { padding-top: 2px; color: var(--muted); font: 12px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace; }
    .skill-title { display: grid; gap: 3px; }
    .skill-title strong { font-size: 17px; }
    .skill-title span { color: var(--muted); }
    .chevron { width: 10px; height: 10px; margin-top: 7px; border-right: 2px solid var(--muted); border-bottom: 2px solid var(--muted); transform: rotate(45deg); transition: transform .16s ease; }
    details[open] .chevron { transform: rotate(225deg); }
    .skill-content { padding: 0 20px 22px 80px; }
    .pills { display: flex; flex-wrap: wrap; gap: 7px; margin-bottom: 16px; }
    .pill { padding: 4px 9px; border: 1px solid var(--line); border-radius: 999px; color: var(--muted); background: var(--panel-2); font-size: 12px; font-weight: 700; }
    .pill.accent { color: var(--accent); border-color: var(--accent); background: var(--accent-soft); }
    dl { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 1px; overflow: hidden; border: 1px solid var(--line); border-radius: 9px; background: var(--line); }
    dl div { min-width: 0; padding: 10px 12px; background: var(--panel); }
    dt { color: var(--muted); font-size: 12px; font-weight: 800; text-transform: uppercase; letter-spacing: .05em; }
    dd { margin: 3px 0 0; overflow-wrap: anywhere; }
    code { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
    .source-heading { display: flex; align-items: center; justify-content: space-between; gap: 16px; margin-top: 20px; }
    .source-heading h3 { margin: 0; font-size: 15px; }
    .copy { padding: 7px 10px; border: 1px solid var(--line); border-radius: 8px; color: var(--text); background: var(--panel); cursor: pointer; }
    pre { max-height: 680px; overflow: auto; margin: 10px 0 0; padding: 18px; border-radius: 9px; color: var(--code-text); background: var(--code); font: 12px/1.6 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; white-space: pre-wrap; overflow-wrap: anywhere; }
    .empty { display: none; padding: 44px; border: 1px dashed var(--line); border-radius: 13px; color: var(--muted); text-align: center; background: var(--panel); }
    .empty.visible { display: block; }
    footer { padding: 22px; color: var(--muted); text-align: center; }
    @media (max-width: 900px) {
      .toolbar { grid-template-columns: 1fr 1fr; }
      .toolbar input { grid-column: 1 / -1; }
      .layout { grid-template-columns: 1fr; }
      nav { display: none; }
    }
    @media (max-width: 620px) {
      .toolbar { position: static; grid-template-columns: 1fr; }
      summary { grid-template-columns: 38px minmax(0, 1fr) 14px; padding: 15px; }
      .skill-content { padding: 0 15px 18px; }
      dl { grid-template-columns: 1fr; }
    }
    @media print {
      header { color: #111; background: none; padding: 20px 0; }
      .toolbar, nav, .copy, footer { display: none !important; }
      .layout { display: block; max-width: none; padding: 0; }
      .skill-card { break-inside: avoid; box-shadow: none; }
      details { display: block; }
      details > .skill-content { display: block !important; }
      pre { max-height: none; color: #111; background: #f4f4f4; }
    }
  </style>
</head>
<body>
  <header>
    <p class="eyebrow">Shareable offline reference</p>
    <h1>Singularity Flow Skill Catalog</h1>
    <p>Every packaged Copilot skill, its invocation and execution policy, and its complete reviewed instruction source. This file is generated from the repository and uses no external scripts, fonts, trackers, or network resources.</p>
    <div class="stats">
      <span class="stat"><strong>${skills.length}</strong> skills</span>
      <span class="stat"><strong>${automaticCount}</strong> automatic</span>
      <span class="stat"><strong>${skills.length - automaticCount}</strong> explicit only</span>
      <span class="stat"><strong>${neverModelCount}</strong> never-model operations</span>
    </div>
  </header>
  <section class="toolbar" aria-label="Catalog filters">
    <input id="search" type="search" placeholder="Search name, purpose, command, or instruction…" aria-label="Search skills">
    <select id="class-filter" aria-label="Filter by class"><option value="">All classes</option>${classes.map(option).join('')}</select>
    <select id="boundary-filter" aria-label="Filter by boundary"><option value="">All boundaries</option>${boundaries.map(option).join('')}</select>
    <select id="invocation-filter" aria-label="Filter by invocation"><option value="">All invocation modes</option><option value="automatic">Automatic</option><option value="explicit">Explicit only</option></select>
    <button id="expand" type="button">Expand visible</button>
  </section>
  <div class="layout">
    <nav aria-label="Skill index"><h2>Skill index</h2>${navigation}</nav>
    <main>
      <div class="result-row"><h2>Packaged skills</h2><p id="result-count" aria-live="polite">${skills.length} shown</p></div>
      <div id="empty" class="empty">No skill matches these filters.</div>
      <section id="catalog">${cards}
      </section>
    </main>
  </div>
  <footer>Generated by <code>npm run skills-html:generate</code>. Do not edit this catalog by hand.</footer>
  <script>
    (() => {
      const cards = [...document.querySelectorAll('.skill-card')];
      const links = [...document.querySelectorAll('[data-skill-link]')];
      const search = document.querySelector('#search');
      const classFilter = document.querySelector('#class-filter');
      const boundaryFilter = document.querySelector('#boundary-filter');
      const invocationFilter = document.querySelector('#invocation-filter');
      const count = document.querySelector('#result-count');
      const empty = document.querySelector('#empty');
      const expand = document.querySelector('#expand');
      let expanded = false;
      const apply = () => {
        const query = search.value.trim().toLocaleLowerCase();
        let visible = 0;
        for (const card of cards) {
          const show = (!query || card.textContent.toLocaleLowerCase().includes(query))
            && (!classFilter.value || card.dataset.class === classFilter.value)
            && (!boundaryFilter.value || card.dataset.boundary === boundaryFilter.value)
            && (!invocationFilter.value || card.dataset.invocation === invocationFilter.value);
          card.hidden = !show;
          if (show) visible += 1;
        }
        for (const link of links) link.hidden = document.getElementById(link.dataset.skillLink).hidden;
        count.textContent = visible + ' shown';
        empty.classList.toggle('visible', visible === 0);
      };
      for (const control of [search, classFilter, boundaryFilter, invocationFilter]) {
        control.addEventListener(control === search ? 'input' : 'change', apply);
      }
      expand.addEventListener('click', () => {
        expanded = !expanded;
        for (const card of cards) if (!card.hidden) card.querySelector('details').open = expanded;
        expand.textContent = expanded ? 'Collapse visible' : 'Expand visible';
      });
      document.addEventListener('click', async (event) => {
        const button = event.target.closest('[data-copy]');
        if (!button) return;
        const source = document.querySelector('[data-source="' + button.dataset.copy + '"]');
        try {
          await navigator.clipboard.writeText(source.textContent);
          button.textContent = 'Copied';
          setTimeout(() => { button.textContent = 'Copy Markdown'; }, 1200);
        } catch {
          button.textContent = 'Select text to copy';
        }
      });
    })();
  </script>
</body>
</html>
`;

if (write) {
  await writeFile(target, content, 'utf8');
  console.log(`Wrote ${path.relative(root, target)} with ${skills.length} skills.`);
} else {
  const current = await readFile(target, 'utf8').catch(() => '');
  if (current !== content) {
    console.error('Skill HTML catalog is stale. Run npm run skills-html:generate.');
    process.exitCode = 1;
  } else {
    console.log(`Skill HTML catalog is current: ${skills.length} skills.`);
  }
}
