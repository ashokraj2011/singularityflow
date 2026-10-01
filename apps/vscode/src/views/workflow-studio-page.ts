/**
 * Workflow Studio's page: one webview that holds the person's draft of workflows, steps, agents and
 * approval groups, and turns it into one change set for the engine.
 *
 * The draft lives in the page, not the host. Every earlier designer re-rendered the whole page on
 * each click, so text being typed was lost and focus jumped; here the host sends the model once,
 * the page renders and re-renders itself, and the host only checks (`--dry-run`) and publishes.
 * The change set is computed by comparing the draft with the model it came from, so undoing an
 * edit is just editing it back, and nothing accumulates stale operations.
 */

const STUDIO_STYLE = `
.studio{display:grid;grid-template-columns:200px minmax(0,1fr);min-height:calc(100vh - 80px);gap:0}
.studio-nav{border-right:1px solid var(--sf-border);padding:var(--sf-space-4) var(--sf-space-3);display:flex;flex-direction:column;gap:4px}
.studio-nav .brand{font-size:11px;letter-spacing:2px;font-weight:600;color:var(--sf-accent);padding:0 var(--sf-space-2) var(--sf-space-3)}
.studio-nav button.nav-item{display:flex;justify-content:space-between;align-items:center;gap:8px;text-align:left;padding:8px 10px;border-radius:6px;border:0;background:transparent;color:inherit;font:inherit;cursor:pointer}
.studio-nav button.nav-item[aria-current=page]{background:var(--sf-accent-quiet);font-weight:600}
.studio-nav button.nav-item:hover{background:var(--vscode-list-hoverBackground)}
.studio-nav .count{font-size:11px;opacity:.8}
.studio-nav .count.attention{background:var(--sf-wait);color:var(--vscode-editor-background);border-radius:9px;padding:0 7px;font-weight:700;opacity:1}
.studio-nav .note{margin-top:auto;font-size:11px;opacity:.75;line-height:1.5;border-top:1px solid var(--sf-border);padding-top:var(--sf-space-3)}
.studio-main{padding:var(--sf-space-4) var(--sf-space-5);display:flex;flex-direction:column;gap:var(--sf-space-4);min-width:0}
.studio-main h1{margin:0;font-size:22px}
.studio-main h2{margin:0;font-size:15px}
.studio-lede{margin:0;opacity:.85;max-width:760px;line-height:1.5}
.studio-card{border:1px solid var(--sf-border);border-radius:10px;padding:var(--sf-space-3) var(--sf-space-4);background:var(--sf-surface);display:flex;flex-direction:column;gap:var(--sf-space-2)}
.studio-row{display:flex;align-items:center;gap:var(--sf-space-2);flex-wrap:wrap}
.studio-row.spread{justify-content:space-between}
.check-row{display:grid;grid-template-columns:24px minmax(0,1fr) auto;gap:var(--sf-space-2);align-items:center;padding:6px 0;border-top:1px solid var(--sf-border)}
.check-row:first-of-type{border-top:0}
.mark{width:20px;height:20px;border-radius:10px;display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:700}
.mark.ok{background:var(--sf-ok);color:var(--vscode-editor-background)}
.mark.wait{background:var(--sf-wait);color:var(--vscode-editor-background)}
.mark.bad{background:var(--sf-bad);color:var(--vscode-editor-background)}
.mark.dim{border:1px solid var(--sf-border)}
.muted{opacity:.75;font-size:12px}
.pill{display:inline-flex;align-items:center;gap:6px;font-size:11px;padding:3px 8px;border-radius:12px;border:1px solid var(--sf-border)}
.pill.new{background:var(--sf-accent-quiet);font-weight:700}
.rail{display:flex;flex-wrap:wrap;gap:6px;align-items:center}
.rail .stop{display:inline-flex;align-items:center;gap:6px;font-size:12px;padding:3px 8px 3px 3px;border-radius:12px;border:1px solid var(--sf-border)}
.avatar{width:20px;height:20px;border-radius:10px;display:inline-flex;align-items:center;justify-content:center;font-size:9px;font-weight:700;background:var(--vscode-badge-background);color:var(--vscode-badge-foreground)}
.avatar.large{width:28px;height:28px;border-radius:14px;font-size:11px}
.blueprints{display:grid;grid-template-columns:repeat(auto-fill,minmax(240px,1fr));gap:var(--sf-space-3)}
.blueprint{text-align:left;font:inherit;color:inherit;background:var(--sf-surface);border:1px solid var(--sf-border);border-radius:10px;padding:var(--sf-space-3);display:flex;flex-direction:column;gap:8px;cursor:pointer;min-height:150px}
.blueprint[aria-pressed=true]{border:2px solid var(--sf-accent)}
.board{display:grid;grid-template-columns:minmax(0,1fr) 340px;gap:var(--sf-space-4);align-items:start}
.lanes-legend{display:flex;gap:var(--sf-space-3);font-size:12px;opacity:.85;align-items:center}
.swatch{display:inline-block;width:10px;height:10px;border-radius:3px;margin-right:6px}
.swatch.agent{background:var(--vscode-charts-blue,#3794ff)}
.swatch.people{background:var(--vscode-charts-orange,#d18616)}
.lanes{display:grid;grid-auto-flow:column;grid-auto-columns:minmax(150px,1fr);gap:var(--sf-space-2);overflow-x:auto;padding-bottom:6px}
.column{display:flex;flex-direction:column;min-width:150px}
.column.dragging{opacity:.5}
.column.drop-target .agent-card{outline:2px dashed var(--sf-accent)}
.agent-card,.sign-card{text-align:left;font:inherit;color:inherit;cursor:pointer;display:flex;flex-direction:column;gap:6px;padding:10px}
.agent-card{border:1px solid color-mix(in srgb,var(--vscode-charts-blue,#3794ff) 50%,transparent);background:color-mix(in srgb,var(--vscode-charts-blue,#3794ff) 12%,transparent);border-radius:10px 10px 3px 3px;min-height:118px}
.sign-card{border:1px solid color-mix(in srgb,var(--vscode-charts-orange,#d18616) 50%,transparent);background:color-mix(in srgb,var(--vscode-charts-orange,#d18616) 12%,transparent);border-radius:3px 3px 10px 10px}
.sign-card.blocked{border-color:var(--sf-bad)}
.column[aria-current=step] .agent-card{outline:2px solid var(--vscode-focusBorder)}
.connector{height:10px;display:flex;justify-content:center}
.connector span{width:2px;background:var(--sf-border)}
.step-tools{display:flex;flex-wrap:wrap;justify-content:center;gap:2px;padding-top:4px}
.step-tools button{padding:3px 6px;font-size:11px}
.lane-label{font-size:10px;letter-spacing:1px;font-weight:700;opacity:.8}
.add-column{border:1px dashed var(--sf-border);border-radius:10px;display:flex;flex-direction:column;gap:8px;padding:10px;min-width:170px;justify-content:center}
.inspector{border:1px solid var(--sf-border);border-radius:10px;padding:var(--sf-space-3);display:flex;flex-direction:column;gap:var(--sf-space-3);position:sticky;top:8px}
.field{display:flex;flex-direction:column;gap:4px}
.field label,.field .label{font-size:12px;font-weight:600}
.field input[type=text],.field input[type=email],.field select,.field textarea{font:inherit;padding:6px 8px;border-radius:4px;border:1px solid var(--vscode-input-border,var(--sf-border));background:var(--vscode-input-background);color:var(--vscode-input-foreground)}
.field textarea{min-height:110px;resize:vertical}
.field .hint{font-size:11px;opacity:.8;line-height:1.4}
.checks{display:flex;flex-direction:column;gap:4px}
.checks label{display:flex;gap:6px;align-items:center;font-size:13px;font-weight:400}
.grid-2{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:var(--sf-space-2)}
.grid-3{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:var(--sf-space-2)}
.callout{font-size:12px;line-height:1.45;padding:8px 10px;border-radius:6px;border:1px solid var(--sf-border)}
.callout.wait{border-color:var(--sf-wait)}
.callout.bad{border-color:var(--sf-bad)}
.callout.ok{border-color:var(--sf-ok)}
.agents-grid,.groups-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(300px,1fr));gap:var(--sf-space-3)}
.member{display:inline-flex;align-items:center;gap:6px;font-size:12px;padding:2px 4px 2px 8px;border-radius:12px;border:1px solid var(--sf-border)}
.member button{padding:0 6px;font-size:11px}
.change-list{display:flex;flex-direction:column;gap:6px;margin:0;padding:0;list-style:none}
.change-list li{border:1px solid var(--sf-border);border-radius:8px;padding:8px 10px;font-size:13px}
.diff{font-family:var(--vscode-editor-font-family);font-size:12px;white-space:pre;overflow:auto;max-height:320px;border:1px solid var(--sf-border);border-radius:6px;padding:8px;margin:0}
.diff .add{color:var(--vscode-gitDecoration-addedResourceForeground,#73c991)}
.diff .del{color:var(--vscode-gitDecoration-deletedResourceForeground,#c74e39)}
.studio-status{min-height:1.2em;font-size:12px}
.swatch.decide{background:var(--vscode-charts-purple,#b180d7)}
.decide-card{text-align:left;font:inherit;color:inherit;cursor:pointer;display:flex;flex-direction:column;gap:4px;padding:8px 10px;margin-top:6px;border-radius:10px;border:1px solid color-mix(in srgb,var(--vscode-charts-purple,#b180d7) 55%,transparent);background:color-mix(in srgb,var(--vscode-charts-purple,#b180d7) 12%,transparent)}
.decide-card[aria-pressed=true]{outline:2px solid var(--vscode-focusBorder)}
.decide-card .lane-label{display:flex;align-items:center;gap:6px}
.diamond{display:inline-block;width:9px;height:9px;transform:rotate(45deg);background:var(--vscode-charts-purple,#b180d7)}
.decision-box{border:1px solid var(--sf-border);border-radius:8px;padding:8px 10px;margin:0;display:flex;flex-direction:column;gap:6px}
.decision-row{display:flex;flex-wrap:wrap;gap:6px;align-items:center}
.preview-text{font-family:var(--vscode-editor-font-family);font-size:12px;white-space:pre-wrap;overflow:auto;max-height:280px;border:1px solid var(--sf-border);border-radius:6px;padding:8px;margin:0}
.decision-row select,.decision-row input[type=text]{font:inherit;padding:4px 6px;border-radius:4px;border:1px solid var(--vscode-input-border,var(--sf-border));background:var(--vscode-input-background);color:var(--vscode-input-foreground);max-width:100%}
@media (max-width:900px){.studio{grid-template-columns:minmax(0,1fr)}.studio-nav{border-right:0;border-bottom:1px solid var(--sf-border);flex-direction:row;flex-wrap:wrap}.studio-nav .note{display:none}.board{grid-template-columns:minmax(0,1fr)}.inspector{position:static}}
`;

/**
 * The page's logic. Plain browser JavaScript: it renders with DOM calls (text is never parsed as
 * HTML), keeps the draft, and exposes its pure parts on `window.__workflowStudio` so they can be
 * exercised without a browser.
 */
export const WORKFLOW_STUDIO_SCRIPT = String.raw`
(function () {
  'use strict';
  var vscodeApi = window.__sfVscode;
  var state = { model: null, draft: null, view: 'home', workflow: null, step: null, decision: null, plan: null, planKey: null, busy: null, error: null, wizard: null, agentForm: null, status: '' };

  function clone(value) { return JSON.parse(JSON.stringify(value)); }
  function same(a, b) { return JSON.stringify(a) === JSON.stringify(b); }
  function kebab(text) { return String(text || '').toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60); }
  function initials(label) { var parts = String(label || '?').replace(/\(.*?\)/g, '').trim().split(/\s+/); return ((parts[0] || '?')[0] + (parts[1] ? parts[1][0] : (parts[0] || '?')[1] || '')).toUpperCase(); }

  // ---- The draft and the change set ---------------------------------------------------------

  function initialDraft(model) {
    var draft = { workflows: {}, steps: {}, phases: {}, agents: {}, groups: {}, order: [], imports: [] };
    (model.workflows || []).forEach(function (workflow) {
      draft.order.push(workflow.id);
      draft.workflows[workflow.id] = { id: workflow.id, label: workflow.label, description: workflow.description || '', phases: workflow.phases.slice(), reworkLoops: clone(workflow.reworkLoops || []), decisions: clone(workflow.decisions || []), isNew: false, installFrom: null };
      draft.steps[workflow.id] = {};
      (workflow.steps || []).forEach(function (step) {
        draft.steps[workflow.id][step.id] = { approval: step.approval && step.approval.mode !== 'none' ? { group: step.approval.authorities[0] || null, minimum: step.approval.minimum || 1 } : { group: null, minimum: 1 }, inputs: (step.inputs || []).slice(), output: step.output, overridden: Boolean(step.overridden) };
      });
    });
    (model.phases || []).forEach(function (phase) {
      draft.phases[phase.id] = { id: phase.id, label: phase.label, output: phase.output, baseOutput: phase.output, views: (phase.views || []).slice(), clarification: phase.clarification || 'off', agent: phase.agent, usedBy: (phase.usedBy || []).slice(), isNew: false, fromBlueprint: null, approval: phase.approval && phase.approval.mode !== 'none' ? { group: phase.approval.authorities[0] || null, minimum: phase.approval.minimum || 1 } : { group: null, minimum: 1 }, inputs: (phase.inputs || []).slice() };
    });
    (model.agents || []).forEach(function (agent) {
      draft.agents[agent.id] = { id: agent.id, label: agent.label, description: agent.description, tools: agent.tools.slice(), views: agent.views.slice(), instructions: agent.instructions || '', scope: agent.scope, isNew: false, role: null };
    });
    (model.groups || []).forEach(function (group) {
      draft.groups[group.id] = { id: group.id, label: group.label, members: clone(group.members || []), status: group.status, isNew: false };
    });
    return draft;
  }

  function approvalChange(step) {
    return step.approval.group ? { group: step.approval.group, minimum: step.approval.minimum || 1 } : 'none';
  }

  /** The engine change set that turns the model into the draft. */
  function changeSetFrom(model, draft) {
    var base = initialDraft(model);
    var changes = [];
    Object.keys(draft.groups).forEach(function (id) {
      var group = draft.groups[id]; var before = base.groups[id];
      if (!before) { changes.push({ op: 'group.create', id: id, label: group.label, members: group.members }); return; }
      var patch = { op: 'group.update', id: id };
      if (before.label !== group.label) patch.label = group.label;
      if (!same(before.members, group.members)) patch.members = group.members;
      if (Object.keys(patch).length > 2) changes.push(patch);
    });
    Object.keys(draft.agents).forEach(function (id) {
      var agent = draft.agents[id]; var before = base.agents[id];
      if (!before) { changes.push({ op: 'agent.create', id: id, label: agent.label, description: agent.description, role: agent.role || 'blank', tools: agent.tools, views: agent.views, instructions: agent.instructions }); return; }
      var patch = { op: 'agent.update', id: id };
      ['label', 'description', 'instructions'].forEach(function (key) { if (before[key] !== agent[key]) patch[key] = agent[key]; });
      ['tools', 'views'].forEach(function (key) { if (!same(before[key], agent[key])) patch[key] = agent[key]; });
      if (Object.keys(patch).length > 2) changes.push(patch);
    });
    var installs = {};
    Object.keys(draft.workflows).forEach(function (id) { var from = draft.workflows[id].installFrom; if (from && !installs[from]) { installs[from] = true; changes.push({ op: 'workflow.install', id: from }); } });
    Object.keys(draft.phases).forEach(function (id) {
      var phase = draft.phases[id];
      if (phase.isNew) {
        var home = Object.keys(draft.workflows).find(function (workflowId) { return draft.workflows[workflowId].phases.indexOf(id) >= 0; });
        var step = home && draft.steps[home][id] ? draft.steps[home][id] : { approval: phase.approval, inputs: phase.inputs };
        var create = { op: 'phase.create', id: id, label: phase.label, output: phase.output, inputs: step.inputs, approval: approvalChange(step), views: phase.views, agent: phase.agent };
        if (phase.copyOf) create.copyOf = phase.copyOf;
        changes.push(create);
        return;
      }
      var baseline = base.phases[id] || (phase.fromBlueprint ? phase.blueprintBase : null);
      if (!baseline) return;
      var patch = { op: 'phase.update', id: id };
      if (baseline.label !== phase.label) patch.label = phase.label;
      if (baseline.output !== phase.output) patch.output = phase.output;
      if (!same(baseline.views, phase.views)) patch.views = phase.views;
      if ((baseline.clarification || 'off') !== phase.clarification) patch.clarification = phase.clarification;
      if (Object.keys(patch).length > 2) changes.push(patch);
      if (baseline.agent !== phase.agent && phase.agent) changes.push({ op: 'phase.agent', phase: id, agent: phase.agent });
    });
    Object.keys(draft.workflows).forEach(function (id) {
      var workflow = draft.workflows[id]; var before = base.workflows[id];
      // A duplicate is created from its source, which must still exist as it was loaded.
      var copySource = workflow.isNew && workflow.copyOf && base.workflows[workflow.copyOf] && draft.workflows[workflow.copyOf] && !draft.workflows[workflow.copyOf].isNew ? workflow.copyOf : null;
      if (workflow.isNew) { var create = { op: 'workflow.create', id: id, label: workflow.label, description: workflow.description, phases: workflow.phases }; if (copySource) create.copyOf = copySource; changes.push(create); }
      else if (before) {
        var patch = { op: 'workflow.update', id: id };
        if (before.label !== workflow.label) patch.label = workflow.label;
        if (before.description !== workflow.description) patch.description = workflow.description;
        if (!same(before.phases, workflow.phases)) patch.phases = workflow.phases;
        if (!same(before.reworkLoops, workflow.reworkLoops)) patch.reworkLoops = workflow.reworkLoops;
        if (!same(before.decisions, workflow.decisions || [])) patch.decisions = workflow.decisions || [];
        if (Object.keys(patch).length > 2) changes.push(patch);
      } else if (workflow.installFrom) {
        var installed = { op: 'workflow.update', id: id };
        if (workflow.label !== workflow.blueprintLabel) installed.label = workflow.label;
        if (!same(workflow.phases, workflow.blueprintPhases)) installed.phases = workflow.phases;
        if (workflow.reworkLoops.length) installed.reworkLoops = workflow.reworkLoops;
        if ((workflow.decisions || []).length) installed.decisions = workflow.decisions;
        if (Object.keys(installed).length > 2) changes.push(installed);
      }
      if (workflow.isNew) {
        // A copy already has its source's rules; only rules changed since copying are sent.
        var sourceRules = copySource ? base.workflows[copySource] : { reworkLoops: [], decisions: [] };
        var follow = { op: 'workflow.update', id: id };
        if (!same(workflow.reworkLoops, sourceRules.reworkLoops || [])) follow.reworkLoops = workflow.reworkLoops;
        if (!same(workflow.decisions || [], sourceRules.decisions || [])) follow.decisions = workflow.decisions || [];
        if (Object.keys(follow).length > 2) changes.push(follow);
      }
      workflow.phases.forEach(function (phaseId) {
        var phase = draft.phases[phaseId];
        if (!phase || phase.isNew) return;
        var step = draft.steps[id] && draft.steps[id][phaseId];
        var reference = before && base.steps[id] && base.steps[id][phaseId] ? base.steps[id][phaseId]
          : copySource && base.steps[copySource] && base.steps[copySource][phaseId] ? base.steps[copySource][phaseId]
            : { approval: (base.phases[phaseId] || phase).approval, inputs: (base.phases[phaseId] || phase).inputs };
        if (!step) return;
        var update = { op: 'phase.update', id: phaseId, workflow: id };
        if (!same(reference.approval, step.approval)) update.approval = approvalChange(step);
        if (!same(reference.inputs, step.inputs)) update.inputs = step.inputs;
        if (Object.keys(update).length > 3) changes.push(update);
      });
    });
    // Imports and marketplace trust are explicit operations the person queued; the engine orders them.
    (draft.imports || []).forEach(function (change) { changes.push(clone(change)); });
    return { schema: 'sflow-studio-change-set@1', base: model.base, changes: changes };
  }

  /** Plain words for one change, shown before the engine checks it. */
  function describe(change, draft) {
    function phaseName(id) { return (draft.phases[id] || {}).label || id; }
    function agentName(id) { return (draft.agents[id] || {}).label || id; }
    switch (change.op) {
      case 'workflow.create': return 'New workflow ' + change.label + (change.copyOf ? ', a copy of ' + ((draft.workflows[change.copyOf] || {}).label || change.copyOf) : '') + ': ' + change.phases.map(phaseName).join(' → ');
      case 'workflow.install': return 'Add the packaged ' + (((state.model && state.model.blueprints) || []).find(function (bp) { return bp.id === change.id; }) || { label: change.id }).label + ' workflow';
      case 'workflow.update': return (change.label || (draft.workflows[change.id] || {}).label || change.id) + ': ' + Object.keys(change).filter(function (key) { return ['op', 'id'].indexOf(key) < 0; }).map(function (key) { return { label: 'name', description: 'description', phases: 'steps', reworkLoops: 'send-back rules', decisions: 'decisions' }[key] || key; }).join(', ') + ' changed';
      case 'phase.create': return 'New step ' + change.label + ', drafted by ' + agentName(change.agent);
      case 'phase.update': return phaseName(change.id) + ': ' + Object.keys(change).filter(function (key) { return ['op', 'id', 'workflow'].indexOf(key) < 0; }).map(function (key) { return { label: 'name', output: 'output', views: 'knowledge', clarification: 'questions', approval: 'sign-off', inputs: 'what it reads' }[key] || key; }).join(', ') + ' changed' + (change.workflow && (change.approval !== undefined || change.inputs !== undefined) ? ' in ' + ((draft.workflows[change.workflow] || {}).label || change.workflow) : '');
      case 'phase.agent': return phaseName(change.phase) + ' is now drafted by ' + agentName(change.agent);
      case 'agent.create': return 'New agent ' + change.label;
      case 'agent.update': return 'Agent ' + agentName(change.id) + ' changed';
      case 'group.create': return 'New approval group ' + change.label;
      case 'group.update': return ((draft.groups[change.id] || {}).label || change.id) + ': ' + (change.members ? 'people' : 'name') + ' changed';
      case 'import.skill': return (change.replace ? 'Update skill ' : 'Skill ') + change.id + ' for ' + agentName(change.agent) + (change.phases && change.phases.length ? ' in ' + change.phases.map(phaseName).join(', ') : '') + ', from ' + change.source;
      case 'import.template': return (change.replace ? 'Update template ' : 'Template ') + (change.label || change.id) + ' from ' + change.source + (change.phases && change.phases.length ? ', used by ' + change.phases.map(phaseName).join(', ') : '');
      case 'import.agent': return (change.replace ? 'Update an agent' : 'Agent') + ' from ' + change.source + (change.withoutDefaults ? ', without taking over steps' : '');
      case 'import.generated': return agentName(change.agent) + ' fetches ' + change.target + ' for ' + phaseName(change.phase);
      case 'import.mcpServer': return (change.replace ? 'Update MCP server' : 'MCP server') + ' from ' + change.source + (change.agents && change.agents.length ? ' for ' + change.agents.map(agentName).join(', ') : ', for imports only');
      case 'import.remove': return 'Remove ' + change.key;
      case 'marketplace.add': return 'Trust marketplace ' + (change.label || change.id);
      case 'marketplace.remove': return 'Stop trusting marketplace ' + change.id;
      default: return change.op;
    }
  }

  window.__workflowStudio = { initialDraft: initialDraft, changeSetFrom: changeSetFrom, describe: describe, kebab: kebab,
    newDecision: function () { return newDecision.apply(null, arguments); }, convertDecision: function () { return convertDecision.apply(null, arguments); },
    decisionLines: function () { return decisionLines.apply(null, arguments); }, reachOf: function () { return reachOf.apply(null, arguments); },
    targetOptions: function () { return targetOptions.apply(null, arguments); }, pruneDecisions: function () { return pruneDecisions.apply(null, arguments); },
    relabelRules: function () { return relabelRules.apply(null, arguments); }, buildTest: function () { return buildTest.apply(null, arguments); },
    importKey: function () { return importKey.apply(null, arguments); }, linkId: function () { return linkId.apply(null, arguments); } };

  // ---- Rendering helpers ---------------------------------------------------------------------

  function el(tag, attrs) {
    var node = document.createElement(tag);
    Object.keys(attrs || {}).forEach(function (key) {
      var value = attrs[key];
      if (value === null || value === undefined || value === false) return;
      if (key === 'text') node.textContent = value;
      else if (key === 'class') node.className = value;
      // The page's CSP admits only nonce'd styles, so a style attribute would be dropped; the CSSOM is allowed.
      else if (key === 'style') node.style.cssText = value;
      else if (key.slice(0, 2) === 'on') node.addEventListener(key.slice(2).toLowerCase(), value);
      else if (key === 'checked' || key === 'selected' || key === 'disabled' || key === 'value') node[key] = value;
      else node.setAttribute(key, value === true ? '' : String(value));
    });
    for (var index = 2; index < arguments.length; index += 1) append(node, arguments[index]);
    return node;
  }
  function append(node, child) {
    if (child === null || child === undefined || child === false) return;
    if (Array.isArray(child)) { child.forEach(function (item) { append(node, item); }); return; }
    node.appendChild(typeof child === 'string' ? document.createTextNode(child) : child);
  }
  function button(label, onClick, attrs) { return el('button', Object.assign({ type: 'button', onclick: onClick }, attrs || {}), label); }
  function select(id, options, value, onChange, attrs) {
    return el('select', Object.assign({ id: id, 'data-key': id, onchange: function (event) { onChange(event.target.value); } }, attrs || {}),
      options.map(function (option) { return el('option', { value: option.value, selected: option.value === value, disabled: option.disabled }, option.label); }));
  }
  function field(id, label, control, hint) {
    return el('div', { class: 'field' }, el('label', { for: id }, label), control, hint ? el('span', { class: 'hint' }, hint) : null);
  }
  function textInput(id, value, onChange, attrs) {
    return el('input', Object.assign({ type: 'text', id: id, 'data-key': id, value: value || '', onchange: function (event) { onChange(event.target.value); } }, attrs || {}));
  }

  function post(message) { vscodeApi.postMessage(message); }
  function setStatus(text) { state.status = text; var node = document.getElementById('studio-status'); if (node) node.textContent = text; }

  // ---- Draft operations ----------------------------------------------------------------------

  function workflowSteps(workflowId) { var workflow = state.draft.workflows[workflowId]; return workflow ? workflow.phases : []; }
  function stepSettings(workflowId, phaseId) {
    var steps = state.draft.steps[workflowId] || (state.draft.steps[workflowId] = {});
    if (!steps[phaseId]) {
      var phase = state.draft.phases[phaseId] || {};
      steps[phaseId] = { approval: clone(phase.approval || { group: null, minimum: 1 }), inputs: (phase.inputs || []).filter(function (input) { return workflowSteps(workflowId).indexOf(input) >= 0; }) };
    }
    return steps[phaseId];
  }
  /** What a step produces in one workflow: that workflow's own value, unless the step itself was edited. */
  function stepOutput(workflowId, phaseId) {
    var phase = state.draft.phases[phaseId] || { output: 'document' };
    var settings = state.draft.steps[workflowId] && state.draft.steps[workflowId][phaseId];
    if (!settings || !settings.output || phase.output !== phase.baseOutput) return phase.output;
    return settings.output;
  }
  function changesNow() { return state.draft && state.model ? changeSetFrom(state.model, state.draft).changes : []; }
  function changed() { state.plan = null; state.planKey = null; requestRender(); }

  // A text field commits on blur, which happens on the mousedown of whatever is clicked next. Re-
  // rendering right then would replace the very button being clicked and swallow the click, so a
  // render requested while a pointer is down waits until that click has been handled.
  var pointerDown = false; var renderQueued = false;
  // Deferred a tick even without a pointer, so a Tab move finishes and focus is restored where it went.
  function requestRender() { if (pointerDown) { renderQueued = true; return; } setTimeout(render, 0); }
  function flushRender() { pointerDown = false; if (renderQueued) { renderQueued = false; render(); } }

  function addExistingStep(workflowId, phaseId) {
    var workflow = state.draft.workflows[workflowId];
    if (!workflow || workflow.phases.indexOf(phaseId) >= 0) return;
    workflow.phases.push(phaseId);
    stepSettings(workflowId, phaseId);
    state.step = phaseId;
    changed();
  }

  function createStep(workflowId, label, output, agent) {
    var id = kebab(label);
    if (!id) { setStatus('Give the new step a name.'); return; }
    if (state.draft.phases[id]) { setStatus('A step called ' + label + ' already exists; add it from the list instead.'); return; }
    var firstGroup = Object.keys(state.draft.groups)[0] || null;
    var previous = workflowSteps(workflowId).slice(-1);
    state.draft.phases[id] = { id: id, label: label, output: output, views: [], clarification: 'off', agent: agent, usedBy: [workflowId], isNew: true, fromBlueprint: null, approval: { group: firstGroup, minimum: 1 }, inputs: previous };
    state.draft.workflows[workflowId].phases.push(id);
    state.draft.steps[workflowId][id] = { approval: { group: firstGroup, minimum: 1 }, inputs: previous };
    state.step = id;
    changed();
  }

  function copyStepForWorkflow(workflowId, phaseId) {
    var source = state.draft.phases[phaseId];
    var id = kebab(phaseId + '-' + workflowId);
    if (state.draft.phases[id]) { setStatus('A copy already exists: ' + state.draft.phases[id].label + '.'); return; }
    state.draft.phases[id] = Object.assign(clone(source), { id: id, label: source.label + ' (' + state.draft.workflows[workflowId].label + ')', isNew: true, copyOf: phaseId, usedBy: [workflowId] });
    var workflow = state.draft.workflows[workflowId];
    workflow.phases = workflow.phases.map(function (phase) { return phase === phaseId ? id : phase; });
    state.draft.steps[workflowId][id] = clone(stepSettings(workflowId, phaseId));
    delete state.draft.steps[workflowId][phaseId];
    workflow.phases.forEach(function (other) { var settings = state.draft.steps[workflowId][other]; if (settings) settings.inputs = settings.inputs.map(function (input) { return input === phaseId ? id : input; }); });
    workflow.reworkLoops = workflow.reworkLoops.map(function (loop) {
      var copy = { from: loop.from === phaseId ? id : loop.from, to: loop.to === phaseId ? id : loop.to, maxAttempts: loop.maxAttempts };
      if (loop.resetOnPhase) copy.resetOnPhase = loop.resetOnPhase === phaseId ? id : loop.resetOnPhase;
      return copy;
    });
    renameDecisionSteps(workflow, phaseId, id);
    state.step = id;
    setStatus('This workflow now uses its own copy of ' + source.label + '; choose its agent freely.');
    changed();
  }

  function moveStep(workflowId, phaseId, delta) {
    var phases = state.draft.workflows[workflowId].phases;
    var index = phases.indexOf(phaseId); var target = index + delta;
    if (index < 0 || target < 0 || target >= phases.length) return;
    phases.splice(index, 1); phases.splice(target, 0, phaseId);
    pruneInputs(workflowId);
    changed();
  }

  function removeStep(workflowId, phaseId) {
    var workflow = state.draft.workflows[workflowId];
    if (workflow.phases.length <= 1) { setStatus('A workflow needs at least one step.'); return; }
    workflow.phases = workflow.phases.filter(function (phase) { return phase !== phaseId; });
    workflow.reworkLoops = workflow.reworkLoops.filter(function (loop) { return loop.from !== phaseId && loop.to !== phaseId && loop.resetOnPhase !== phaseId; });
    var droppedDecisions = pruneDecisions(workflow, phaseId);
    if (droppedDecisions.length) setStatus('Removed the decision ' + droppedDecisions.join(', ') + ', which used that step.');
    if (state.draft.phases[phaseId] && state.draft.phases[phaseId].isNew && !Object.keys(state.draft.workflows).some(function (id) { return state.draft.workflows[id].phases.indexOf(phaseId) >= 0; })) delete state.draft.phases[phaseId];
    pruneInputs(workflowId);
    if (state.step === phaseId) state.step = workflow.phases[0];
    changed();
  }

  /** A step can only read steps that come before it in this workflow. */
  function pruneInputs(workflowId) {
    var phases = workflowSteps(workflowId);
    phases.forEach(function (phaseId, index) {
      var settings = state.draft.steps[workflowId][phaseId];
      if (settings) settings.inputs = settings.inputs.filter(function (input) { return phases.indexOf(input) >= 0 && phases.indexOf(input) < index; });
    });
    state.draft.workflows[workflowId].reworkLoops = state.draft.workflows[workflowId].reworkLoops.filter(function (loop) { return phases.indexOf(loop.to) >= 0 && phases.indexOf(loop.to) < phases.indexOf(loop.from); });
  }

  // ---- Views ---------------------------------------------------------------------------------

  function groupHint(group) {
    if (!group) return '';
    if (group.members.length) return group.members.length + (group.members.length === 1 ? ' person' : ' people');
    return { anyone: 'anyone with Git access', teams: 'GitHub teams', auto: 'empty: the first person to start a Story is added', blocked: 'nobody yet' }[group.status] || 'nobody yet';
  }
  function groupBlocked(groupId) { var group = state.draft.groups[groupId]; return Boolean(group && !group.members.length && group.status === 'blocked'); }
  function agentOptions(selected) {
    var options = Object.keys(state.draft.agents).sort(function (a, b) { return state.draft.agents[a].label.localeCompare(state.draft.agents[b].label); })
      .map(function (id) { var agent = state.draft.agents[id]; return { value: id, label: agent.label + (agent.isNew ? ' (new)' : '') }; });
    if (!selected) options.unshift({ value: '', label: 'Choose an agent…' });
    options.push({ value: '__new__', label: 'Create a new agent…' });
    return options;
  }
  function groupOptions() {
    return Object.keys(state.draft.groups).map(function (id) { var group = state.draft.groups[id]; return { value: id, label: group.label + ' · ' + groupHint(group) }; }).concat([{ value: '', label: 'No sign-off' }]);
  }

  function renderNav(root) {
    var pending = changesNow().length;
    var blocked = Object.keys(state.draft.groups).filter(groupBlocked).length;
    function item(view, label, count, attention) {
      return el('button', { type: 'button', class: 'nav-item', 'aria-current': state.view === view || (view === 'home' && (state.view === 'board' || state.view === 'new')) ? 'page' : null, onclick: function () { state.view = view; render(); } },
        el('span', { text: label }), count !== null ? el('span', { class: 'count' + (attention ? ' attention' : ''), text: String(count) }) : null);
    }
    root.appendChild(el('nav', { class: 'studio-nav', 'aria-label': 'Workflow Studio' },
      el('div', { class: 'brand', text: 'WORKFLOW STUDIO' }),
      item('home', 'Workflows', Object.keys(state.draft.workflows).length, false),
      item('agents', 'Agents', Object.keys(state.draft.agents).length, false),
      item('library', 'Library', (state.model.imports || []).length || null, false),
      item('people', 'People & approvals', blocked || null, blocked > 0),
      item('changes', 'Changes', pending, pending > 0),
      el('p', { class: 'note', text: 'Running Stories keep the workflow they started with. What you publish applies to new Stories after review.' })));
  }

  function rail(phases) {
    return el('div', { class: 'rail' }, phases.map(function (phaseId) {
      var phase = state.draft.phases[phaseId] || { label: phaseId };
      var agent = state.draft.agents[phase.agent] || null;
      return el('span', { class: 'stop' }, el('span', { class: 'avatar', title: agent ? agent.label : 'No agent', text: agent ? initials(agent.label) : '?' }), phase.label);
    }));
  }

  function renderHome(main) {
    var workflows = state.draft.order.concat(Object.keys(state.draft.workflows).filter(function (id) { return state.draft.order.indexOf(id) < 0; }));
    var noAgent = Object.keys(state.draft.phases).filter(function (id) { return !state.draft.phases[id].agent && workflows.some(function (workflowId) { return workflowSteps(workflowId).indexOf(id) >= 0; }); });
    var blocked = Object.keys(state.draft.groups).filter(groupBlocked);
    var pending = changesNow().length;
    main.appendChild(el('header', { class: 'studio-card', style: 'border:0;background:transparent;padding:0' },
      el('h1', { text: 'Design how your team works' }),
      el('p', { class: 'studio-lede', text: 'A workflow is the list of steps a Story goes through. In each step an agent drafts the work and people sign it off. Arrange the steps, pick who does what from the lists, then publish once.' })));
    function check(kind, title, detail, action) {
      return el('div', { class: 'check-row' }, el('span', { class: 'mark ' + kind, 'aria-hidden': 'true', text: kind === 'ok' ? '✓' : kind === 'dim' ? '' : '!' }),
        el('div', null, el('div', { text: title, style: 'font-weight:600' }), el('div', { class: 'muted', text: detail })), action || el('span'));
    }
    main.appendChild(el('section', { class: 'studio-card', 'aria-label': 'Ready for new Stories' },
      el('div', { class: 'studio-row spread' }, el('h2', { text: 'Ready for new Stories?' })),
      check('ok', workflows.length + (workflows.length === 1 ? ' workflow' : ' workflows'), 'Any of them can start a Story once published.'),
      blocked.length ? check('bad', blocked.length + (blocked.length === 1 ? ' approval group can never approve' : ' approval groups can never approve'), 'Add people to ' + blocked.map(function (id) { return state.draft.groups[id].label; }).join(', ') + ', or steps they sign off can never finish.', button('Add people', function () { state.view = 'people'; render(); })) : check('ok', 'Every approval group can sign off', 'Empty groups enrol whoever starts a Story, unless your repository requires named people.'),
      noAgent.length ? check('bad', noAgent.length + ' step(s) have no agent', noAgent.map(function (id) { return state.draft.phases[id].label; }).join(', '), null) : check('ok', 'Every step has an agent', 'Each step has exactly one agent that drafts it.'),
      pending ? check('wait', pending + (pending === 1 ? ' change' : ' changes') + ' not published yet', 'Check and publish them together from Changes.', button('Review changes', function () { state.view = 'changes'; render(); }, { class: 'primary' })) : check('dim', 'No unpublished changes', 'Edits you make collect here until you publish them.')));
    main.appendChild(el('div', { class: 'studio-row spread' }, el('h2', { text: 'Your workflows' }), button('New workflow', function () { state.view = 'new'; state.wizard = { label: '', from: null }; render(); }, { class: 'primary' })));
    workflows.forEach(function (id) {
      var workflow = state.draft.workflows[id];
      var code = workflow.phases.some(function (phaseId) { return stepOutput(id, phaseId) === 'code'; });
      main.appendChild(el('article', { class: 'studio-card' },
        el('div', { class: 'studio-row spread' },
          el('div', { class: 'studio-row' }, el('strong', { text: workflow.label }), workflow.isNew || workflow.installFrom ? el('span', { class: 'pill new', text: 'NEW' }) : null),
          el('div', { class: 'studio-row' },
            button('Open', function () { state.workflow = id; state.step = workflow.phases[0]; state.view = 'board'; render(); }, { class: 'secondary', 'aria-label': 'Open ' + workflow.label }),
            button('Duplicate', function () { state.view = 'new'; state.wizard = { label: workflow.label + ' copy', from: 'workflow:' + id }; render(); }, { class: 'secondary', 'aria-label': 'Duplicate ' + workflow.label }))),
        el('span', { class: 'muted', text: workflow.phases.length + ' steps' + (code ? ' · writes code' : '') }),
        rail(workflow.phases)));
    });
  }

  function renderWizard(main) {
    var wizard = state.wizard;
    var choices = Object.keys(state.draft.workflows).map(function (id) { var workflow = state.draft.workflows[id]; return { key: 'workflow:' + id, label: workflow.label, description: 'Copy the steps of your ' + workflow.label + ' workflow.', phases: workflow.phases }; })
      .concat((state.model.blueprints || []).filter(function (bp) { return !bp.installed && !state.draft.workflows[bp.id]; }).map(function (bp) { return { key: 'blueprint:' + bp.id, label: bp.label, description: (bp.description || 'A packaged workflow.') + ' Adds its steps and agents.', phases: bp.phases, blueprint: bp }; }))
      .concat([{ key: 'blank', label: 'Blank', description: 'Start with one step and add what you need. Good for analysis or review work with no code.', phases: [Object.keys(state.draft.phases).indexOf('intake') >= 0 ? 'intake' : Object.keys(state.draft.phases)[0]] }]);
    if (!wizard.from) wizard.from = 'blank';
    var id = kebab(wizard.label);
    main.appendChild(el('header', null, el('h1', { text: 'New workflow' }), el('p', { class: 'studio-lede', text: 'Name it and pick the closest starting point. You can add, remove and reorder steps next.' })));
    main.appendChild(el('div', { class: 'grid-2', style: 'max-width:820px' },
      field('wizard-name', 'Workflow name', textInput('wizard-name', wizard.label, function (value) { wizard.label = value; requestRender(); }, { placeholder: 'Vendor assessment' }),
        id ? 'ID ' + id + (state.draft.workflows[id] ? ' is already used: choose another name' : '') : 'The ID is made from the name.'),
      field('wizard-description', 'What is it for? (optional)', textInput('wizard-description', wizard.description, function (value) { wizard.description = value; }))));
    main.appendChild(el('div', { class: 'blueprints', role: 'group', 'aria-label': 'Start from' }, choices.map(function (choice) {
      return el('button', { type: 'button', class: 'blueprint', 'aria-pressed': wizard.from === choice.key ? 'true' : 'false', onclick: function () { wizard.from = choice.key; if (!wizard.label && choice.blueprint) wizard.label = choice.label; render(); } },
        el('strong', { text: choice.label }), el('span', { class: 'muted', text: choice.description }),
        el('span', { class: 'rail' }, choice.phases.slice(0, 7).map(function (phaseId) { return el('span', { class: 'pill', text: ((state.draft.phases[phaseId] || (state.model.blueprintPhases || {})[phaseId] || { label: phaseId }).label) }); })));
    })));
    var blocked = !id || Boolean(state.draft.workflows[id]);
    main.appendChild(el('div', { class: 'studio-row' },
      button('Shape the steps', function () { createWorkflowFromWizard(choices.find(function (choice) { return choice.key === wizard.from; }), id); }, { class: 'primary', disabled: blocked }),
      button('Cancel', function () { state.view = 'home'; render(); })));
  }

  function createWorkflowFromWizard(choice, id) {
    var label = state.wizard.label.trim();
    var workflow = { id: id, label: label, description: (state.wizard.description || '').trim(), phases: choice.phases.slice(), reworkLoops: [], decisions: [], isNew: true, installFrom: null };
    if (choice.blueprint) {
      workflow.installFrom = choice.blueprint.id;
      choice.blueprint.phases.forEach(function (phaseId) {
        if (state.draft.phases[phaseId]) return;
        var packaged = (state.model.blueprintPhases || {})[phaseId] || { label: phaseId, output: 'document', agent: null };
        state.draft.phases[phaseId] = { id: phaseId, label: packaged.label, output: packaged.output, views: [], clarification: 'off', agent: packaged.agent, usedBy: [], isNew: false, fromBlueprint: choice.blueprint.id, blueprintBase: { label: packaged.label, output: packaged.output, views: [], clarification: 'off', agent: packaged.agent, approval: packaged.approval, inputs: [] }, approval: packaged.approval, inputs: [] };
      });
      if (id === choice.blueprint.id) { workflow.isNew = false; workflow.blueprintLabel = choice.blueprint.label; workflow.blueprintPhases = choice.blueprint.phases.slice(); }
    } else if (choice.key.indexOf('workflow:') === 0) {
      workflow.copyOf = choice.key.slice(9);
      workflow.reworkLoops = clone(state.draft.workflows[workflow.copyOf].reworkLoops);
      workflow.decisions = clone(state.draft.workflows[workflow.copyOf].decisions || []);
    }
    state.draft.workflows[id] = workflow;
    state.draft.steps[id] = {};
    var sourceSteps = choice.key.indexOf('workflow:') === 0 ? state.draft.steps[choice.key.slice(9)] : null;
    workflow.phases.forEach(function (phaseId) { state.draft.steps[id][phaseId] = sourceSteps && sourceSteps[phaseId] ? clone(sourceSteps[phaseId]) : stepSettings(id, phaseId); });
    state.workflow = id; state.step = workflow.phases[0]; state.view = 'board';
    changed();
  }

  // ---- Decisions -----------------------------------------------------------------------------
  //
  // A decision is edited in the shape it is written in workflow.yml, so the change set carries it
  // as authored and the engine validates the whole workflow: the same rules apply here and in YAML.

  var DECISION_KINDS = [
    { value: 'branch', label: 'If / else: rules choose the next step' },
    { value: 'loop', label: 'Loop until a goal' },
    { value: 'ask', label: 'Ask a person' }
  ];

  function decisionAfterStep(workflow, phaseId) {
    return (workflow.decisions || []).find(function (decision) { return decision.after === phaseId; }) || null;
  }
  function decisionById(workflow, id) {
    return (workflow.decisions || []).find(function (decision) { return decision.id === id; }) || null;
  }
  function stepLabel(id) {
    if (id === 'end') return 'Finish the Story';
    if (id === 'next') return 'Next step';
    return ((state.draft && state.draft.phases[id]) || { label: id }).label;
  }
  function uniqueId(base, taken) {
    var root = base || 'route'; var id = root; var count = 2;
    while (taken.indexOf(id) >= 0) { id = root + '-' + count; count += 1; }
    return id;
  }
  /** A value name the engine accepts: starts with a letter, then letters, digits and hyphens. */
  function inputName(label, taken) {
    var base = kebab(label) || 'value';
    if (!/^[a-z]/.test(base)) base = 'v-' + base;
    return uniqueId(base.slice(0, 40), taken);
  }

  /** Where a route leads from the step before the decision. */
  function reachOf(workflow, after, to) {
    var phases = workflow.phases; var from = phases.indexOf(after);
    if (to === 'next') return { kind: from + 1 < phases.length ? 'next' : 'end', target: phases[from + 1] || null, skips: [] };
    if (to === 'end') return { kind: 'end', target: null, skips: phases.slice(from + 1) };
    var at = phases.indexOf(to);
    if (at < 0) return { kind: 'missing', target: to, skips: [] };
    if (at <= from) return { kind: 'back', target: to, skips: [] };
    return { kind: at === from + 1 ? 'next' : 'forward', target: to, skips: phases.slice(from + 1, at) };
  }
  function targetText(workflow, after, to) {
    var reach = reachOf(workflow, after, to);
    if (reach.kind === 'end') return reach.skips.length ? 'Finish (skips ' + reach.skips.map(stepLabel).join(', ') + ')' : 'Finish';
    if (reach.kind === 'back') return '↩ ' + stepLabel(reach.target);
    if (reach.kind === 'missing') return stepLabel(reach.target) + ' (not in this workflow)';
    return stepLabel(reach.target) + (reach.skips.length ? ' (skips ' + reach.skips.map(stepLabel).join(', ') + ')' : '');
  }

  function inputOf(decision, name) {
    return (decision.inputs || []).find(function (input) { return input.name === name; }) || null;
  }
  /** One comparison in plain words, from the YAML shorthand. */
  function testText(label, test) {
    if (test === undefined || test === null) return label + ' is unset';
    if (typeof test === 'string' || typeof test === 'number') return label + ' is ' + test;
    if (Array.isArray(test)) return label + ' is ' + test.join(' or ');
    if (test.not !== undefined) return label + ' is not ' + [].concat(test.not).join(' or ');
    var parts = [];
    if (test.atLeast !== undefined) parts.push('at least ' + test.atLeast);
    if (test.above !== undefined) parts.push('above ' + test.above);
    if (test.atMost !== undefined) parts.push('at most ' + test.atMost);
    if (test.below !== undefined) parts.push('below ' + test.below);
    return label + ' is ' + parts.join(' and ');
  }
  function whenText(decision, when) {
    return Object.keys(when || {}).map(function (name) {
      var input = inputOf(decision, name);
      return testText(input ? (input.label || input.name) : name, when[name]);
    }).join(' and ');
  }

  /** The routes of a decision in plain words, one line each, for the board and its inspector. */
  function decisionLines(workflow, decision) {
    if (decision.kind === 'loop') {
      return ['↩ ' + stepLabel(decision.back) + ' until ' + whenText(decision, decision.goal) + ' (at most ' + (decision.maxRounds || 3) + ')',
        'Then ' + targetText(workflow, decision.after, 'next')];
    }
    if (decision.kind === 'ask') {
      return ['A person chooses:'].concat((decision.routes || []).map(function (route) { return route.label + ' → ' + targetText(workflow, decision.after, route.to); }));
    }
    return (decision.routes || []).map(function (route) {
      return (route.when ? 'If ' + whenText(decision, route.when) : 'Otherwise') + ' → ' + targetText(workflow, decision.after, route.to);
    });
  }

  /** A new decision after a step with sensible routes for its kind, ready to edit. */
  function newDecision(workflow, phaseId, kind) {
    var phases = workflow.phases; var at = phases.indexOf(phaseId);
    var last = at === phases.length - 1;
    var taken = (workflow.decisions || []).map(function (decision) { return decision.id; });
    var decision = { id: uniqueId(kebab('decide-after-' + phaseId), taken), after: phaseId, kind: kind };
    if (kind === 'loop') {
      decision.label = 'Repeat until it is done';
      decision.inputs = [{ name: 'done', label: 'Done', values: ['yes', 'no'] }];
      decision.goal = { done: 'yes' };
      decision.back = at > 0 ? phases[at - 1] : phaseId;
      decision.maxRounds = 3;
      return decision;
    }
    if (kind === 'ask') {
      decision.label = 'What should happen next?';
      // After the last step there is no next one: offer another round or finishing.
      decision.routes = last
        ? [{ id: 'again', label: 'Another round', to: phaseId }, { id: 'finish', label: 'Finish here', to: 'end' }]
        : [{ id: 'continue', label: 'Continue', to: 'next' }, { id: 'finish', label: 'Finish here', to: 'end' }];
      return decision;
    }
    decision.label = 'Which way next?';
    decision.inputs = [{ name: 'outcome', label: 'Outcome', values: ['yes', 'no'] }];
    decision.routes = [{ id: 'rule-1', label: 'Outcome is yes', when: { outcome: 'yes' }, to: last ? 'end' : 'next' },
      { id: 'otherwise', label: 'Otherwise', to: phases[at + 2] ? phases[at + 2] : 'end' }];
    return decision;
  }

  /** Change a decision's kind, keeping its name, values and who decides where they still apply. */
  function convertDecision(workflow, decision, kind) {
    var fresh = newDecision(workflow, decision.after, kind);
    fresh.id = decision.id;
    fresh.label = decision.label || fresh.label;
    if (decision.by) fresh.by = clone(decision.by);
    if (kind !== 'ask' && decision.inputs && decision.inputs.length) {
      fresh.inputs = clone(kind === 'loop' ? decision.inputs.slice(0, 1) : decision.inputs);
      var first = fresh.inputs[0];
      var value = first.type === 'number' ? { atLeast: first.minimum !== undefined && first.minimum !== null ? first.minimum : 0 } : first.values[0];
      var when = {}; when[first.name] = value;
      if (kind === 'loop') fresh.goal = when;
      else { fresh.routes[0].when = when; fresh.routes[0].label = capitalize(whenText(fresh, when)); }
    }
    return fresh;
  }
  function capitalize(text) { text = String(text || ''); return text.charAt(0).toUpperCase() + text.slice(1); }

  function setDecision(workflow, decision, replacement) {
    workflow.decisions = (workflow.decisions || []).map(function (entry) { return entry === decision ? replacement : entry; });
    return replacement;
  }
  function removeDecision(workflow, decision) {
    workflow.decisions = (workflow.decisions || []).filter(function (entry) { return entry !== decision; });
  }

  /** Keep branch rule ids and labels in step with their rules, so nothing needs naming by hand. */
  function relabelRules(decision) {
    if (decision.kind !== 'branch') return;
    var last = decision.routes.length - 1;
    decision.routes.forEach(function (route, index) {
      if (index === last) { route.id = 'otherwise'; route.label = 'Otherwise'; delete route.when; return; }
      route.id = 'rule-' + (index + 1);
      route.label = capitalize(whenText(decision, route.when)).slice(0, 120) || 'Rule ' + (index + 1);
    });
  }

  // Comparisons as the inspector offers them, and their YAML shorthand.
  function operatorOptions(input) {
    if (input && input.type === 'number') return [{ value: 'is', label: 'is' }, { value: 'atLeast', label: 'is at least' }, { value: 'atMost', label: 'is at most' }, { value: 'above', label: 'is above' }, { value: 'below', label: 'is below' }];
    return [{ value: 'is', label: 'is' }, { value: 'not', label: 'is not' }];
  }
  function testOperator(test) {
    if (test && typeof test === 'object' && !Array.isArray(test)) {
      if (test.not !== undefined) return 'not';
      return ['atLeast', 'atMost', 'above', 'below'].find(function (key) { return test[key] !== undefined; }) || 'is';
    }
    return 'is';
  }
  function testValue(test) {
    if (test === undefined || test === null) return '';
    if (Array.isArray(test)) return String(test[0]);
    if (typeof test === 'object') { var key = testOperator(test); return String([].concat(key === 'not' ? test.not : test[key])[0]); }
    return String(test);
  }
  function buildTest(input, operator, value) {
    if (input.type === 'number') {
      var number = Number(value);
      if (!isFinite(number)) number = 0;
      if (operator === 'is') return number;
      var bound = {}; bound[operator] = number; return bound;
    }
    var choice = input.values.indexOf(value) >= 0 ? value : input.values[0];
    return operator === 'not' ? { not: choice } : choice;
  }

  /** The three controls of one comparison: which value, how it compares, and to what. */
  function conditionControls(decision, when, onChange, key) {
    var name = Object.keys(when || {})[0];
    var input = inputOf(decision, name) || (decision.inputs || [])[0];
    if (!input) return [el('span', { class: 'muted', text: 'Add a value the step records first.' })];
    var test = when ? when[input.name] : undefined;
    var operator = testOperator(test); var value = testValue(test);
    function commit(nextInput, nextOperator, nextValue) {
      var chosen = inputOf(decision, nextInput) || input;
      var operators = operatorOptions(chosen).map(function (option) { return option.value; });
      var updated = {}; updated[chosen.name] = buildTest(chosen, operators.indexOf(nextOperator) >= 0 ? nextOperator : 'is', nextValue);
      onChange(updated);
    }
    return [
      select(key + '-input', (decision.inputs || []).map(function (entry) { return { value: entry.name, label: entry.label || entry.name }; }), input.name, function (next) { commit(next, operator, value); }, { 'aria-label': 'Value to check' }),
      select(key + '-op', operatorOptions(input), operator, function (next) { commit(input.name, next, value); }, { 'aria-label': 'Comparison' }),
      input.type === 'number'
        ? textInput(key + '-value', value, function (next) { commit(input.name, operator, next); }, { 'aria-label': 'Number', style: 'width:72px' })
        : select(key + '-value', input.values.map(function (choice) { return { value: choice, label: choice }; }), value, function (next) { commit(input.name, operator, next); }, { 'aria-label': 'Choice' })
    ];
  }

  /** Where a route may go: the next step, a later one (naming what it skips), back, or the end. */
  function targetOptions(workflow, after, current) {
    var phases = workflow.phases; var from = phases.indexOf(after);
    var options = [];
    if (from + 1 < phases.length) options.push({ value: 'next', label: 'Next step: ' + stepLabel(phases[from + 1]) });
    phases.forEach(function (id, index) {
      if (index === from + 1) { if (current === id) options.push({ value: id, label: stepLabel(id) }); return; }
      if (index > from) options.push({ value: id, label: stepLabel(id) + ' (skips ' + phases.slice(from + 1, index).map(stepLabel).join(', ') + ')' });
      else options.push({ value: id, label: (index === from ? '↩ Redo ' : '↩ Back to ') + stepLabel(id) });
    });
    options.push({ value: 'end', label: 'Finish the Story' });
    if (current && !options.some(function (option) { return option.value === current; })) options.push({ value: current, label: stepLabel(current) + ' (not in this workflow)' });
    return options;
  }

  /** Rename a value and every rule that reads it, or change its choices and keep rules valid. */
  function renameInput(decision, index, label) {
    var input = decision.inputs[index];
    var taken = decision.inputs.filter(function (entry, at) { return at !== index; }).map(function (entry) { return entry.name; });
    var name = inputName(label, taken);
    var before = input.name;
    input.label = String(label).trim().slice(0, 120) || name;
    input.name = name;
    function rekey(when) { if (when && when[before] !== undefined) { when[name] = when[before]; if (name !== before) delete when[before]; } }
    (decision.routes || []).forEach(function (route) { rekey(route.when); });
    rekey(decision.goal);
  }
  function setChoices(decision, index, text) {
    var input = decision.inputs[index];
    var values = []; String(text || '').split(',').forEach(function (part) { var choice = part.trim(); if (choice && values.map(function (v) { return v.toLowerCase(); }).indexOf(choice.toLowerCase()) < 0) values.push(choice); });
    if (!values.length) return false;
    input.values = values.slice(0, 20);
    function keep(when) { if (when && when[input.name] !== undefined) when[input.name] = buildTest(input, testOperator(when[input.name]), testValue(when[input.name])); }
    (decision.routes || []).forEach(function (route) { keep(route.when); });
    keep(decision.goal);
    return true;
  }
  function setInputType(decision, index, type) {
    var input = decision.inputs[index];
    if (type === 'number') { delete input.values; input.type = 'number'; }
    else { delete input.type; delete input.minimum; delete input.maximum; input.values = ['yes', 'no']; }
    function reset(when) { if (when && when[input.name] !== undefined) when[input.name] = buildTest(input, 'is', type === 'number' ? '0' : input.values[0]); }
    (decision.routes || []).forEach(function (route) { reset(route.when); });
    reset(decision.goal);
  }

  /**
   * The people rules, checked as the person edits so the route that would be refused is visible
   * here: a rule may send work back, or skip a step people sign off, only after a step people
   * sign off. The engine applies the same rules when the change is checked.
   */
  function decisionWarnings(workflowId, workflow, decision) {
    var warnings = [];
    var signed = Boolean(stepSettings(workflowId, decision.after).approval.group);
    var routes = decision.kind === 'loop' ? [{ to: decision.back }, { to: 'next' }] : (decision.routes || []);
    var reaches = routes.map(function (route) { return reachOf(workflow, decision.after, route.to); });
    var goesBack = reaches.some(function (reach) { return reach.kind === 'back'; });
    if (decision.kind !== 'ask' && !signed) {
      if (goesBack) warnings.push('A rule can send work back only after a step people sign off. Give ' + stepLabel(decision.after) + ' a sign-off, or make this an Ask a person decision.');
      var gated = [];
      reaches.forEach(function (reach) { reach.skips.forEach(function (id) { if (stepSettings(workflowId, id).approval.group && gated.indexOf(id) < 0) gated.push(id); }); });
      if (gated.length) warnings.push('A rule can skip ' + gated.map(stepLabel).join(', ') + ', which people sign off, only after a step people sign off. Give ' + stepLabel(decision.after) + ' a sign-off, or make this an Ask a person decision.');
    }
    if ((decision.kind === 'ask' || goesBack) && !signed && !decision.by) warnings.push('Choose who decides: ' + stepLabel(decision.after) + ' has no sign-off to take people from.');
    reaches.forEach(function (reach) { if (reach.kind === 'missing') warnings.push(stepLabel(reach.target) + ' is not in this workflow any more; choose another step.'); });
    return warnings;
  }

  /** Drop or re-aim decisions that name a step the workflow no longer has. */
  function pruneDecisions(workflow, removedId) {
    var dropped = [];
    workflow.decisions = (workflow.decisions || []).filter(function (decision) {
      var uses = decision.after === removedId || decision.back === removedId
        || (decision.routes || []).some(function (route) { return route.to === removedId; });
      if (uses && decision.after !== removedId && decision.kind !== 'loop') {
        decision.routes.forEach(function (route) { if (route.to === removedId) route.to = 'next'; });
        return true;
      }
      if (uses) dropped.push(decision.label);
      return !uses;
    });
    return dropped;
  }

  function renameDecisionSteps(workflow, from, to) {
    (workflow.decisions || []).forEach(function (decision) {
      if (decision.after === from) decision.after = to;
      if (decision.back === from) decision.back = to;
      (decision.routes || []).forEach(function (route) { if (route.to === from) route.to = to; });
    });
  }

  function decisionCard(workflow, phaseId) {
    var decision = decisionAfterStep(workflow, phaseId);
    if (!decision) return null;
    return el('button', { type: 'button', class: 'decide-card', 'aria-pressed': state.decision === decision.id ? 'true' : 'false', onclick: function () { state.step = phaseId; state.decision = decision.id; render(); } },
      el('span', { class: 'lane-label' }, el('span', { class: 'diamond', 'aria-hidden': 'true' }), 'THEN DECIDE'),
      el('strong', { text: decision.label }),
      decisionLines(workflow, decision).map(function (line) { return el('span', { class: 'muted', text: line }); }));
  }

  function inputsEditor(decision) {
    var box = el('fieldset', { class: 'field decision-box' }, el('legend', { class: 'label', text: 'What ' + stepLabel(decision.after) + ' records' }));
    (decision.inputs || []).forEach(function (input, index) {
      box.appendChild(el('div', { class: 'decision-row' },
        textInput('dec-input-name-' + index, input.label || input.name, function (value) { if (value.trim()) { renameInput(decision, index, value); relabelRules(decision); changed(); } }, { 'aria-label': 'Name of the value', style: 'width:120px' }),
        select('dec-input-type-' + index, [{ value: 'choice', label: 'one of' }, { value: 'number', label: 'a number' }], input.type === 'number' ? 'number' : 'choice', function (value) { setInputType(decision, index, value); relabelRules(decision); changed(); }, { 'aria-label': 'Kind of value' }),
        input.type === 'number' ? null : textInput('dec-input-values-' + index, (input.values || []).join(', '), function (value) { if (setChoices(decision, index, value)) { relabelRules(decision); changed(); } else setStatus('List at least one choice, separated by commas.'); }, { 'aria-label': 'Choices separated by commas', placeholder: 'low, medium, high' }),
        decision.kind === 'branch' && decision.inputs.length > 1 ? button('Remove', function () {
          var name = input.name;
          decision.inputs.splice(index, 1);
          decision.routes.forEach(function (route) { if (route.when && route.when[name] !== undefined) { route.when = {}; route.when[decision.inputs[0].name] = buildTest(decision.inputs[0], 'is', ''); } });
          relabelRules(decision); changed();
        }, { class: 'secondary', 'aria-label': 'Remove ' + (input.label || input.name) }) : null));
    });
    if (decision.kind === 'branch' && decision.inputs.length < 10) {
      box.appendChild(button('Add a value', function () {
        var taken = decision.inputs.map(function (entry) { return entry.name; });
        decision.inputs.push({ name: inputName('value', taken), label: 'Value ' + (decision.inputs.length + 1), values: ['yes', 'no'] });
        changed();
      }, { class: 'secondary' }));
    }
    box.appendChild(el('span', { class: 'hint', text: 'The agent records these when it submits the step, and the person who signs it off sees them.' }));
    return box;
  }

  function renderDecisionInspector(workflowId, decision) {
    var workflow = state.draft.workflows[workflowId];
    var aside = el('aside', { class: 'inspector', 'aria-label': 'Decision settings' });
    aside.appendChild(el('div', null, el('div', { class: 'lane-label', text: 'DECISION AFTER ' + stepLabel(decision.after).toUpperCase() }), el('h2', { text: decision.label })));
    aside.appendChild(field('dec-name', 'Question', textInput('dec-name', decision.label, function (value) { if (value.trim()) { decision.label = value.trim().slice(0, 120); changed(); } })));
    aside.appendChild(field('dec-kind', 'Kind', select('dec-kind', DECISION_KINDS, decision.kind, function (value) {
      var converted = setDecision(workflow, decision, convertDecision(workflow, decision, value));
      relabelRules(converted); state.decision = converted.id; changed();
    }), decision.kind === 'branch' ? 'Rules read values the step records and choose the next step; the last one takes everything else.'
      : decision.kind === 'loop' ? 'Goes back until the goal is met. When the rounds are used up, a person chooses.'
        : 'The Story waits, and someone you choose picks one of the options.'));
    if (decision.kind !== 'ask') aside.appendChild(inputsEditor(decision));
    if (decision.kind === 'branch') {
      var rules = el('fieldset', { class: 'field decision-box' }, el('legend', { class: 'label', text: 'Rules, checked in order' }));
      decision.routes.slice(0, -1).forEach(function (route, index) {
        rules.appendChild(el('div', { class: 'decision-row' },
          el('span', { class: 'muted', text: index === 0 ? 'If' : 'Else if' }),
          conditionControls(decision, route.when, function (when) { route.when = when; relabelRules(decision); changed(); }, 'dec-rule-' + index),
          el('span', { class: 'muted', text: 'go to' }),
          select('dec-rule-' + index + '-to', targetOptions(workflow, decision.after, route.to), route.to, function (value) { route.to = value; changed(); }, { 'aria-label': 'Next step when this rule holds' }),
          decision.routes.length > 2 ? button('Remove', function () { decision.routes.splice(index, 1); relabelRules(decision); changed(); }, { class: 'secondary', 'aria-label': 'Remove this rule' }) : null));
      });
      if (decision.routes.length < 10) {
        rules.appendChild(button('Add a rule', function () {
          var first = decision.inputs[0]; var when = {}; when[first.name] = buildTest(first, 'is', first.type === 'number' ? '0' : first.values[first.values.length - 1]);
          decision.routes.splice(decision.routes.length - 1, 0, { id: 'rule', label: 'Rule', when: when, to: 'next' });
          relabelRules(decision); changed();
        }, { class: 'secondary' }));
      }
      var otherwise = decision.routes[decision.routes.length - 1];
      rules.appendChild(el('div', { class: 'decision-row' }, el('span', { class: 'muted', text: 'Otherwise go to' }),
        select('dec-otherwise', targetOptions(workflow, decision.after, otherwise.to), otherwise.to, function (value) { otherwise.to = value; changed(); }, { 'aria-label': 'Next step otherwise' })));
      aside.appendChild(rules);
    }
    if (decision.kind === 'loop') {
      var phases = workflow.phases; var from = phases.indexOf(decision.after);
      aside.appendChild(el('fieldset', { class: 'field decision-box' }, el('legend', { class: 'label', text: 'Goal' }),
        el('div', { class: 'decision-row' }, el('span', { class: 'muted', text: 'Until' }),
          conditionControls(decision, decision.goal, function (when) { decision.goal = when; changed(); }, 'dec-goal'))));
      aside.appendChild(el('div', { class: 'grid-2' },
        field('dec-back', 'Otherwise go back to', select('dec-back', phases.slice(0, Math.max(0, from) + 1).map(function (id) { return { value: id, label: id === decision.after ? 'Redo ' + stepLabel(id) : stepLabel(id) }; }), decision.back, function (value) { decision.back = value; changed(); })),
        field('dec-rounds', 'At most', select('dec-rounds', [1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map(function (count) { return { value: String(count), label: count + (count === 1 ? ' round' : ' rounds') }; }), String(decision.maxRounds || 3), function (value) { decision.maxRounds = Number(value); changed(); }))));
    }
    if (decision.kind === 'ask') {
      var options = el('fieldset', { class: 'field decision-box' }, el('legend', { class: 'label', text: 'Options the person chooses from' }));
      decision.routes.forEach(function (route, index) {
        options.appendChild(el('div', { class: 'decision-row' },
          textInput('dec-option-' + index, route.label, function (value) {
            if (!value.trim()) return;
            route.label = value.trim().slice(0, 120);
            route.id = uniqueId(kebab(value) || 'option', decision.routes.filter(function (other) { return other !== route; }).map(function (other) { return other.id; }));
            changed();
          }, { 'aria-label': 'Option name', style: 'width:140px' }),
          el('span', { class: 'muted', text: 'goes to' }),
          select('dec-option-' + index + '-to', targetOptions(workflow, decision.after, route.to), route.to, function (value) { route.to = value; changed(); }, { 'aria-label': 'Where this option goes' }),
          decision.routes.length > 2 ? button('Remove', function () { decision.routes.splice(index, 1); changed(); }, { class: 'secondary', 'aria-label': 'Remove ' + route.label }) : null));
      });
      if (decision.routes.length < 10) {
        options.appendChild(button('Add an option', function () {
          var taken = decision.routes.map(function (route) { return route.id; });
          decision.routes.push({ id: uniqueId('option', taken), label: 'Option ' + (decision.routes.length + 1), to: 'next' });
          changed();
        }, { class: 'secondary' }));
      }
      options.appendChild(el('label', { style: 'display:flex;gap:6px;align-items:center;font-size:13px' },
        el('input', { type: 'checkbox', 'data-key': 'dec-any-step', checked: decision.anyStep === true, onchange: function (event) { if (event.target.checked) decision.anyStep = true; else delete decision.anyStep; changed(); } }),
        'They may also pick any other step'));
      aside.appendChild(options);
    }
    var goesBack = decision.kind === 'loop' || (decision.routes || []).some(function (route) { return reachOf(workflow, decision.after, route.to).kind === 'back'; });
    if (decision.kind === 'branch' && goesBack) {
      aside.appendChild(field('dec-branch-rounds', 'Going back at most', select('dec-branch-rounds', [1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map(function (count) { return { value: String(count), label: count + (count === 1 ? ' time' : ' times') }; }), String(decision.maxRounds || 3), function (value) { decision.maxRounds = Number(value); changed(); }), 'Then a person chooses.'));
    } else if (decision.kind === 'branch' && decision.maxRounds) {
      delete decision.maxRounds;
    }
    if (decision.kind === 'ask' || goesBack) {
      var by = decision.by ? [].concat(decision.by)[0] : '';
      var owner = stepSettings(workflowId, decision.after).approval.group;
      aside.appendChild(field('dec-by', decision.kind === 'ask' ? 'Who chooses' : 'Who chooses when the rounds are used up',
        select('dec-by', [{ value: '', label: owner ? 'Whoever signs off ' + stepLabel(decision.after) : 'Choose a group…' }].concat(Object.keys(state.draft.groups).map(function (id) { return { value: id, label: state.draft.groups[id].label }; })), by, function (value) { if (value) decision.by = [value]; else delete decision.by; changed(); })));
    }
    decisionWarnings(workflowId, workflow, decision).forEach(function (warning) { aside.appendChild(el('div', { class: 'callout bad', text: warning })); });
    aside.appendChild(el('div', { class: 'callout' }, decisionLines(workflow, decision).map(function (line) { return el('div', { text: line }); })));
    aside.appendChild(el('div', { class: 'studio-row' },
      button('Back to the step', function () { state.decision = null; render(); }, { class: 'secondary' }),
      button('Remove decision', function () { removeDecision(workflow, decision); state.decision = null; changed(); }, { class: 'secondary' })));
    return aside;
  }

  function renderBoard(main) {
    var workflowId = state.workflow;
    var workflow = state.draft.workflows[workflowId];
    if (!workflow) { state.view = 'home'; render(); return; }
    var phases = workflow.phases;
    if (phases.indexOf(state.step) < 0) state.step = phases[0];
    main.appendChild(el('div', { class: 'studio-row spread' },
      el('div', { class: 'studio-row' },
        button('Workflows', function () { state.view = 'home'; render(); }, { class: 'secondary', 'aria-label': 'Back to workflows' }),
        el('label', { for: 'board-workflow', class: 'muted', text: 'Workflow' }),
        select('board-workflow', Object.keys(state.draft.workflows).map(function (id) { return { value: id, label: state.draft.workflows[id].label }; }), workflowId, function (value) { state.workflow = value; state.step = state.draft.workflows[value].phases[0]; render(); }),
        workflow.isNew || workflow.installFrom ? el('span', { class: 'pill new', text: 'New · not published' }) : null),
      button('Review changes (' + changesNow().length + ')', function () { state.view = 'changes'; render(); }, { class: 'primary' })));
    main.appendChild(el('div', { class: 'grid-2', style: 'max-width:820px' },
      field('board-label', 'Workflow name', textInput('board-label', workflow.label, function (value) { if (value.trim()) { workflow.label = value.trim(); changed(); } })),
      field('board-description', 'What it is for', textInput('board-description', workflow.description, function (value) { workflow.description = value.trim(); changed(); }))));
    var board = el('div', { class: 'board' });
    var left = el('div', { style: 'display:flex;flex-direction:column;gap:12px;min-width:0' });
    left.appendChild(el('div', { class: 'lanes-legend' }, el('span', null, el('span', { class: 'swatch agent' }), 'Agent drafts'), el('span', null, el('span', { class: 'swatch people' }), 'People sign off'), el('span', null, el('span', { class: 'swatch decide' }), 'Decides what comes next'), el('span', { class: 'muted', text: 'Select a step to edit it. Drag a step, or use the arrows, to reorder.' })));
    var lanes = el('div', { class: 'lanes', role: 'list', 'aria-label': 'Steps of ' + workflow.label });
    phases.forEach(function (phaseId, index) {
      var phase = state.draft.phases[phaseId] || { label: phaseId, output: 'document' };
      var agent = state.draft.agents[phase.agent];
      var settings = stepSettings(workflowId, phaseId);
      var group = settings.approval.group ? state.draft.groups[settings.approval.group] : null;
      var blockedGroup = settings.approval.group && groupBlocked(settings.approval.group);
      var column = el('div', { class: 'column', role: 'listitem', draggable: 'true', 'aria-current': state.step === phaseId ? 'step' : null, 'data-phase': phaseId,
        ondragstart: function (event) { event.dataTransfer.setData('text/plain', phaseId); column.classList.add('dragging'); },
        ondragend: function () { column.classList.remove('dragging'); },
        ondragover: function (event) { event.preventDefault(); column.classList.add('drop-target'); },
        ondragleave: function () { column.classList.remove('drop-target'); },
        ondrop: function (event) { event.preventDefault(); column.classList.remove('drop-target'); var moved = event.dataTransfer.getData('text/plain'); var from = phases.indexOf(moved); if (from >= 0 && from !== index) moveStep(workflowId, moved, index - from); } },
        el('button', { type: 'button', class: 'agent-card', 'aria-pressed': state.step === phaseId ? 'true' : 'false', onclick: function () { state.step = phaseId; state.decision = null; render(); } },
          el('span', { class: 'lane-label', text: 'STEP ' + (index + 1) }),
          el('strong', { text: phase.label }),
          el('span', { class: 'studio-row' }, el('span', { class: 'avatar large', 'aria-hidden': 'true', text: agent ? initials(agent.label) : '?' }),
            el('span', null, el('div', { text: agent ? agent.label : 'Choose an agent' }), el('div', { class: 'muted', text: ({ document: 'Writes a document', analysis: 'Writes an analysis', code: 'Changes code', none: 'Sign-off only' })[stepOutput(workflowId, phaseId)] || '' }))),
          phase.isNew || phase.fromBlueprint ? el('span', { class: 'pill new', text: 'NEW' }) : null),
        el('div', { class: 'connector', 'aria-hidden': 'true' }, el('span')),
        el('button', { type: 'button', class: 'sign-card' + (blockedGroup ? ' blocked' : ''), onclick: function () { state.step = phaseId; state.decision = null; render(); } },
          el('span', { class: 'lane-label', text: 'SIGN-OFF' }),
          el('span', { text: group ? group.label : 'No sign-off' }),
          el('span', { class: 'muted', text: !group ? 'Goes straight to the next step' : blockedGroup ? 'Nobody can approve yet'
            : group.members.length ? settings.approval.minimum + ' of ' + group.members.length + ' must approve' : groupHint(group).replace(/^./, function (first) { return first.toUpperCase(); }) })),
        decisionCard(workflow, phaseId),
        el('div', { class: 'step-tools' },
          decisionAfterStep(workflow, phaseId) ? null : button('Decide', function () {
            // After the last step the useful question is 'another round or finish?', which a person answers.
            var decision = newDecision(workflow, phaseId, index === phases.length - 1 ? 'ask' : 'branch');
            workflow.decisions = (workflow.decisions || []).concat([decision]);
            state.step = phaseId; state.decision = decision.id; changed();
          }, { class: 'secondary', 'aria-label': 'Add a decision after ' + phase.label, title: 'Decide what happens after this step' }),
          button('Earlier', function () { moveStep(workflowId, phaseId, -1); }, { class: 'secondary', 'aria-label': 'Move ' + phase.label + ' earlier', title: 'Move earlier', disabled: index === 0 }),
          button('Later', function () { moveStep(workflowId, phaseId, 1); }, { class: 'secondary', 'aria-label': 'Move ' + phase.label + ' later', title: 'Move later', disabled: index === phases.length - 1 }),
          button('Remove', function () { removeStep(workflowId, phaseId); }, { class: 'secondary', 'aria-label': 'Remove ' + phase.label + ' from this workflow', title: 'Remove from this workflow' })));
      lanes.appendChild(column);
    });
    var library = Object.keys(state.draft.phases).filter(function (id) { return phases.indexOf(id) < 0; }).sort(function (a, b) { return state.draft.phases[a].label.localeCompare(state.draft.phases[b].label); });
    var adding = state.adding || (state.adding = { phase: library[0] || '', label: '', output: 'document', agent: '' });
    if (library.indexOf(adding.phase) < 0) adding.phase = library[0] || '';
    lanes.appendChild(el('div', { class: 'add-column' },
      el('span', { class: 'lane-label', text: 'ADD A STEP' }),
      library.length ? field('add-existing', 'Existing step', select('add-existing', library.map(function (id) { var phase = state.draft.phases[id]; var agent = state.draft.agents[phase.agent]; return { value: id, label: phase.label + (agent ? ' · ' + agent.label : '') }; }), adding.phase, function (value) { adding.phase = value; })) : null,
      library.length ? button('Add', function () { addExistingStep(workflowId, adding.phase); }, { class: 'secondary', 'aria-label': 'Add the chosen step' }) : null,
      field('add-new-name', 'Or a new step', textInput('add-new-name', adding.label, function (value) { adding.label = value; }, { placeholder: 'Vendor analysis' })),
      select('add-new-output', (state.model.choices.outputs || []).map(function (output) { return { value: output.id, label: output.label }; }), adding.output, function (value) { adding.output = value; }, { 'aria-label': 'What the new step produces' }),
      select('add-new-agent', agentOptions(adding.agent), adding.agent, function (value) { if (value === '__new__') { openAgentForm({ returnTo: 'board-add' }); return; } adding.agent = value; }, { 'aria-label': 'Agent for the new step' }),
      button('Create step', function () { if (!adding.agent) { setStatus('Choose the agent that drafts the new step.'); return; } createStep(workflowId, adding.label.trim(), adding.output, adding.agent); adding.label = ''; }, { class: 'secondary' })));
    left.appendChild(lanes);
    var loops = workflow.reworkLoops;
    if (loops.length) {
      left.appendChild(el('div', { class: 'callout' }, loops.map(function (loop) { return el('div', { text: 'If ' + (state.draft.phases[loop.from] || { label: loop.from }).label + ' is rejected it goes back to ' + (state.draft.phases[loop.to] || { label: loop.to }).label + ', at most ' + loop.maxAttempts + ' times.' }); })));
    }
    board.appendChild(left);
    var selectedDecision = state.decision ? decisionById(workflow, state.decision) : null;
    if (!selectedDecision) state.decision = null;
    board.appendChild(selectedDecision ? renderDecisionInspector(workflowId, selectedDecision) : renderInspector(workflowId, state.step));
    main.appendChild(board);
  }

  function renderInspector(workflowId, phaseId) {
    var workflow = state.draft.workflows[workflowId];
    var phase = state.draft.phases[phaseId];
    var aside = el('aside', { class: 'inspector', 'aria-label': 'Step settings' });
    if (!phase) { aside.appendChild(el('p', { class: 'muted', text: 'Select a step.' })); return aside; }
    var index = workflow.phases.indexOf(phaseId);
    var settings = stepSettings(workflowId, phaseId);
    var users = Object.keys(state.draft.workflows).filter(function (id) { return state.draft.workflows[id].phases.indexOf(phaseId) >= 0 && id !== workflowId; });
    var agent = state.draft.agents[phase.agent];
    aside.appendChild(el('div', null, el('div', { class: 'lane-label', text: 'STEP ' + (index + 1) + ' OF ' + workflow.phases.length }), el('h2', { text: phase.label })));
    aside.appendChild(field('step-name', 'Name', textInput('step-name', phase.label, function (value) { if (value.trim()) { phase.label = value.trim(); changed(); } }), users.length ? 'Renames it in ' + users.map(function (id) { return state.draft.workflows[id].label; }).join(', ') + ' too.' : null));
    aside.appendChild(field('step-agent', 'Drafted by', select('step-agent', agentOptions(phase.agent), phase.agent || '', function (value) {
      if (value === '__new__') { openAgentForm({ returnTo: 'step', phase: phaseId }); return; }
      phase.agent = value; changed();
    }), agent ? agent.description : 'Every step needs exactly one agent.'));
    if (users.length && !phase.isNew) {
      aside.appendChild(el('div', { class: 'callout wait' },
        el('div', { text: phase.label + ' is also used by ' + users.map(function (id) { return state.draft.workflows[id].label; }).join(', ') + '. Its agent, name and output change there too.' }),
        button('Use a copy in this workflow', function () { copyStepForWorkflow(workflowId, phaseId); }, { class: 'secondary', style: 'margin-top:6px' })));
    }
    var ownOutput = settings.overridden && settings.output && settings.output !== phase.output && phase.output === phase.baseOutput;
    aside.appendChild(field('step-output', 'Produces', select('step-output', (state.model.choices.outputs || []).map(function (output) { return { value: output.id, label: output.label }; }), stepOutput(workflowId, phaseId), function (value) { phase.output = value; changed(); }, { disabled: ownOutput }),
      ownOutput ? 'This workflow sets what this step produces itself; change it in the Workflow Designer.'
        : stepOutput(workflowId, phaseId) === 'code' ? 'A code step needs a requirements or implementation-spec step before it; the check below says so if one is missing.' : null));
    var earlier = workflow.phases.slice(0, Math.max(0, index));
    aside.appendChild(el('fieldset', { class: 'field', style: 'border:0;margin:0;padding:0' }, el('legend', { class: 'label', text: 'Reads from earlier steps' }),
      earlier.length ? el('div', { class: 'checks' }, earlier.map(function (input) {
        return el('label', null, el('input', { type: 'checkbox', 'data-key': 'reads-' + input, checked: settings.inputs.indexOf(input) >= 0, onchange: function (event) {
          settings.inputs = event.target.checked ? settings.inputs.concat([input]) : settings.inputs.filter(function (id) { return id !== input; });
          settings.inputs.sort(function (a, b) { return workflow.phases.indexOf(a) - workflow.phases.indexOf(b); }); changed();
        } }), (state.draft.phases[input] || { label: input }).label);
      })) : el('span', { class: 'hint', text: 'This is the first step; it reads the Story itself.' })));
    aside.appendChild(el('div', { class: 'grid-2' },
      field('step-group', 'Signed off by', select('step-group', groupOptions(), settings.approval.group || '', function (value) { settings.approval.group = value || null; if (!value) { workflow.reworkLoops = workflow.reworkLoops.filter(function (loop) { return loop.from !== phaseId; }); } changed(); })),
      field('step-minimum', 'Approvals', select('step-minimum', [1, 2, 3, 4, 5].map(function (count) { return { value: String(count), label: String(count) }; }), String(settings.approval.minimum || 1), function (value) { settings.approval.minimum = Number(value); changed(); }, { disabled: !settings.approval.group }))));
    if (settings.approval.group && groupBlocked(settings.approval.group)) {
      aside.appendChild(el('div', { class: 'callout bad' }, 'Nobody is in this group, so this step could never be approved. ', button('Add people', function () { state.view = 'people'; render(); }, { class: 'secondary' })));
    }
    var loop = workflow.reworkLoops.find(function (entry) { return entry.from === phaseId; });
    var loopCount = workflow.reworkLoops.filter(function (entry) { return entry.from === phaseId; }).length;
    aside.appendChild(field('step-back', 'If rejected, send back to', select('step-back', [{ value: '', label: 'This step (redo it)' }].concat(earlier.map(function (id) { return { value: id, label: (state.draft.phases[id] || { label: id }).label }; })), loop ? loop.to : '', function (value) {
      workflow.reworkLoops = workflow.reworkLoops.filter(function (entry) { return entry.from !== phaseId; });
      if (value) {
        var kept = { from: phaseId, to: value, maxAttempts: loop ? loop.maxAttempts : 3 };
        if (loop && loop.resetOnPhase && workflow.phases.indexOf(loop.resetOnPhase) < workflow.phases.indexOf(value)) kept.resetOnPhase = loop.resetOnPhase;
        workflow.reworkLoops.push(kept);
      }
      changed();
    }, { disabled: !settings.approval.group || !earlier.length || loopCount > 1 }), loopCount > 1 ? 'This step has ' + loopCount + ' send-back rules; change them in the Workflow Designer.'
      : !settings.approval.group ? 'Only a step with a sign-off can send work back.'
        : 'Sending work back repeats the steps in between, at most ' + (loop ? loop.maxAttempts : 3) + ' times' + (loop && loop.resetOnPhase ? ', counted again after ' + stepLabel(loop.resetOnPhase) + ' runs again' : '') + '.'));
    var after = decisionAfterStep(workflow, phaseId);
    aside.appendChild(field('step-decision', 'After this step', after
      ? button(after.label + ' →', function () { state.decision = after.id; render(); }, { class: 'secondary', id: 'step-decision', 'aria-label': 'Open the decision ' + after.label })
      : select('step-decision', [{ value: '', label: 'Go to the next step' }].concat(DECISION_KINDS), '', function (value) {
        if (!value) return;
        var created = newDecision(workflow, phaseId, value);
        workflow.decisions = (workflow.decisions || []).concat([created]);
        state.decision = created.id; changed();
      }), after ? 'A decision chooses what happens after ' + phase.label + '.' : 'Add a decision to branch, loop until a goal, or let a person choose.'));
    var more = el('details', null, el('summary', { text: 'More settings' }));
    var views = (state.model.choices.views || []);
    if (views.length) {
      more.appendChild(el('fieldset', { class: 'field', style: 'border:0;margin:8px 0 0;padding:0' }, el('legend', { class: 'label', text: 'Knowledge it can use' }),
        el('div', { class: 'grid-2' }, views.map(function (view) {
          return el('label', { style: 'display:flex;gap:6px;align-items:center;font-size:13px' }, el('input', { type: 'checkbox', 'data-key': 'view-' + view, checked: phase.views.indexOf(view) >= 0, onchange: function (event) {
            phase.views = event.target.checked ? phase.views.concat([view]) : phase.views.filter(function (entry) { return entry !== view; }); changed();
          } }), view);
        }))));
    }
    more.appendChild(field('step-questions', 'Ask clarifying questions', select('step-questions', (state.model.choices.clarification || []).map(function (mode) { return { value: mode.id, label: mode.label }; }), phase.clarification, function (value) { phase.clarification = value; changed(); })));
    aside.appendChild(more);
    return aside;
  }

  function openAgentForm(context) {
    var role = (state.model.choices.roles || [])[0];
    state.agentForm = { mode: 'create', role: role ? role.id : 'blank', label: '', description: '', tools: role ? role.tools.slice() : ['read', 'search', 'edit'], views: role ? role.views.slice() : [], instructions: role ? role.instructions : '', defaults: context && context.phase ? [context.phase] : [], context: context || null };
    state.view = 'agents';
    render();
  }

  function renderAgents(main) {
    main.appendChild(el('div', { class: 'studio-row spread' }, el('div', null, el('h1', { text: 'Agents' }), el('p', { class: 'studio-lede', text: 'An agent drafts the work in the steps it is the default for. Start a new one from a role; no files to edit.' })),
      button('New agent', function () { openAgentForm(null); }, { class: 'primary' })));
    if (state.agentForm) main.appendChild(renderAgentForm());
    var grid = el('div', { class: 'agents-grid' });
    Object.keys(state.draft.agents).sort(function (a, b) { return state.draft.agents[a].label.localeCompare(state.draft.agents[b].label); }).forEach(function (id) {
      var agent = state.draft.agents[id];
      var drafts = Object.keys(state.draft.phases).filter(function (phaseId) { return state.draft.phases[phaseId].agent === id; }).map(function (phaseId) { return state.draft.phases[phaseId].label; });
      grid.appendChild(el('article', { class: 'studio-card' },
        el('div', { class: 'studio-row spread' }, el('div', { class: 'studio-row' }, el('span', { class: 'avatar large', 'aria-hidden': 'true', text: initials(agent.label) }), el('strong', { text: agent.label })),
          el('span', { class: 'pill' + (agent.isNew ? ' new' : ''), text: agent.isNew ? 'NEW' : agent.scope === 'repository' ? 'This repository' : 'Packaged' })),
        el('span', { class: 'muted', text: agent.description }),
        el('span', { style: 'font-size:12px', text: drafts.length ? 'Drafts: ' + drafts.join(', ') : 'Not the default for any step yet' }),
        el('div', { class: 'rail' }, agent.tools.map(function (tool) { return el('span', { class: 'pill', text: toolLabel(tool) }); })),
        agentResources(id).length ? el('span', { style: 'font-size:12px', text: 'Skills and sources: ' + agentResources(id).map(function (resource) { return resource.id; }).join(', ') }) : null,
        button('Add a skill', function () { var lib = library(); lib.as = 'skill'; lib.pendingAgent = id; lib.preview = null; lib.target = null; state.view = 'library'; render(); }, { class: 'secondary', 'aria-label': 'Add a skill to ' + agent.label }),
        button('Edit', function () { state.agentForm = { mode: 'edit', id: id, role: null, label: agent.label, description: agent.description, tools: agent.tools.slice(), views: agent.views.slice(), instructions: agent.instructions, defaults: [], context: null }; render(); }, { class: 'secondary', 'aria-label': 'Edit ' + agent.label })));
    });
    main.appendChild(grid);
  }

  function agentResources(id) { var agent = (state.model.agents || []).find(function (entry) { return entry.id === id; }); return (agent && agent.resources) || []; }

  function toolLabel(tool) { var entry = (state.model.choices.tools || []).find(function (item) { return item.id === tool; }); return entry ? entry.label : tool; }

  function renderAgentForm() {
    var form = state.agentForm;
    var roles = state.model.choices.roles || [];
    var card = el('section', { class: 'studio-card', 'aria-label': form.mode === 'create' ? 'Create an agent' : 'Edit agent' });
    card.appendChild(el('h2', { text: form.mode === 'create' ? 'Create an agent' : 'Edit ' + form.label }));
    if (form.mode === 'create') {
      card.appendChild(field('agent-role', 'Start from a role', select('agent-role', roles.map(function (role) { return { value: role.id, label: role.label + ': ' + role.hint }; }), form.role, function (value) {
        var role = roles.find(function (entry) { return entry.id === value; });
        form.role = value; if (role) { form.tools = role.tools.slice(); form.views = role.views.slice(); form.instructions = role.instructions; }
        render();
      })));
    }
    var id = form.mode === 'create' ? kebab(form.label) : form.id;
    card.appendChild(el('div', { class: 'grid-2' },
      field('agent-name', 'Name', textInput('agent-name', form.label, function (value) { form.label = value; requestRender(); }, { placeholder: 'Vendor analyst' }), form.mode === 'create' ? (id ? 'ID ' + id + (state.draft.agents[id] ? ' is already used' : '') : 'The ID is made from the name.') : null),
      field('agent-description', 'What it does', textInput('agent-description', form.description, function (value) { form.description = value; }, { placeholder: 'Compares vendor options against the approved intake.' }))));
    card.appendChild(el('fieldset', { class: 'field', style: 'border:0;margin:0;padding:0' }, el('legend', { class: 'label', text: 'What it may use' }),
      el('div', { class: 'grid-3' }, (state.model.choices.tools || []).map(function (tool) {
        return el('label', { style: 'display:flex;gap:6px;align-items:center;font-size:13px' }, el('input', { type: 'checkbox', 'data-key': 'tool-' + tool.id, checked: form.tools.indexOf(tool.id) >= 0, onchange: function (event) {
          form.tools = event.target.checked ? form.tools.concat([tool.id]) : form.tools.filter(function (entry) { return entry !== tool.id; });
        } }), tool.label);
      }))));
    if (form.mode === 'create') {
      card.appendChild(el('fieldset', { class: 'field', style: 'border:0;margin:0;padding:0' }, el('legend', { class: 'label', text: 'Drafts these steps by default' }),
        el('div', { class: 'grid-3' }, Object.keys(state.draft.phases).sort(function (a, b) { return state.draft.phases[a].label.localeCompare(state.draft.phases[b].label); }).map(function (phaseId) {
          return el('label', { style: 'display:flex;gap:6px;align-items:center;font-size:13px' }, el('input', { type: 'checkbox', 'data-key': 'default-' + phaseId, checked: form.defaults.indexOf(phaseId) >= 0, onchange: function (event) {
            form.defaults = event.target.checked ? form.defaults.concat([phaseId]) : form.defaults.filter(function (entry) { return entry !== phaseId; });
          } }), state.draft.phases[phaseId].label);
        })), el('span', { class: 'hint', text: 'A step has one default agent; choosing it here moves the step from its current agent.' })));
    }
    card.appendChild(field('agent-instructions', 'Instructions', el('textarea', { id: 'agent-instructions', 'data-key': 'agent-instructions', onchange: function (event) { form.instructions = event.target.value; } }, form.instructions || ''),
      form.mode === 'create' ? 'The shared operating rules every agent follows are added for you.' : null));
    card.appendChild(el('div', { class: 'studio-row' },
      button(form.mode === 'create' ? 'Add agent to changes' : 'Keep changes', function () { saveAgentForm(); }, { class: 'primary' }),
      button('Cancel', function () { var context = form.context; state.agentForm = null; if (context) { state.view = 'board'; } render(); })));
    return card;
  }

  function saveAgentForm() {
    var form = state.agentForm;
    var label = String(form.label || '').trim(); var description = String(form.description || '').trim();
    if (!label || !description) { setStatus('An agent needs a name and one sentence saying what it does.'); return; }
    if (form.mode === 'create') {
      var id = kebab(label);
      if (!id || state.draft.agents[id]) { setStatus('Choose a different name; that agent ID is taken.'); return; }
      state.draft.agents[id] = { id: id, label: label, description: description, tools: form.tools.slice(), views: form.views.slice(), instructions: form.instructions, scope: 'repository', isNew: true, role: form.role };
      form.defaults.forEach(function (phaseId) { if (state.draft.phases[phaseId]) state.draft.phases[phaseId].agent = id; });
      if (form.context && form.context.returnTo === 'board-add' && state.adding) state.adding.agent = id;
      var context = form.context;
      state.agentForm = null;
      if (context) state.view = 'board';
      setStatus('Agent ' + label + ' added to your changes.');
    } else {
      var agent = state.draft.agents[form.id];
      agent.label = label; agent.description = description; agent.tools = form.tools.slice(); agent.views = form.views.slice(); agent.instructions = form.instructions;
      state.agentForm = null;
    }
    changed();
  }

  // ---- Library: skills, templates and agents from a link or a trusted marketplace ------------

  var IMPORT_KINDS = [
    { value: 'skill', label: 'A skill for one of your agents' },
    { value: 'template', label: 'A document template for steps' },
    { value: 'agent', label: 'A whole agent' },
    { value: 'mcp-server', label: 'An MCP server for your agents' }
  ];
  var KIND_WORDS = { skill: 'Skill', template: 'Template', agent: 'Agent', generated: 'Generated artifact', workflow: 'Workflow', 'mcp-server': 'MCP server' };

  function library() {
    return state.library || (state.library = { reference: '', as: 'skill', preview: null, busy: null, error: null, target: null, market: null, entries: null, check: null, newMarket: null });
  }

  /** The link or marketplace entry to preview, as the engine names it. */
  function importReference(entry, marketplaceId) { return 'market:' + marketplaceId + '/' + entry.id + '@' + entry.version; }

  /** The ID an import suggests: its own name, the marketplace entry's ID, or the link's file name. */
  function suggestedId(preview) {
    return preview.id || (preview.marketplace && preview.marketplace.entry) || linkId(preview.reference);
  }

  function linkId(reference) {
    var match = /\/([^\/?#]+?)(?:\.agent)?(?:\.md|\.markdown|\.txt)?(?:[?#].*)?$/.exec(String(reference || ''));
    var name = match ? match[1] : '';
    if (/^(skill|readme|index)$/i.test(name)) { var parts = String(reference).split('?')[0].split('/'); name = parts[parts.length - 2] || name; }
    return kebab(name);
  }

  /** Start a preview: the engine fetches, checks and stages the exact bytes. */
  function previewImport(reference, as, target) {
    var lib = library();
    // The link box keeps what the person typed; a marketplace entry is previewed by its reference.
    if (reference.indexOf('market:') !== 0) { lib.reference = reference; lib.as = as; }
    lib.preview = null; lib.error = null; lib.busy = 'preview'; lib.target = target || null;
    render();
    post({ type: 'studio.importPreview', reference: reference, as: as });
  }

  function agentSteps(agentId) {
    return Object.keys(state.draft.phases).filter(function (phaseId) { return state.draft.phases[phaseId].agent === agentId; });
  }

  function stepChecks(prefix, selected, phaseIds, onChange) {
    return el('div', { class: 'grid-3' }, phaseIds.map(function (phaseId) {
      return el('label', { style: 'display:flex;gap:6px;align-items:center;font-size:13px' }, el('input', { type: 'checkbox', 'data-key': prefix + phaseId, checked: selected.indexOf(phaseId) >= 0, onchange: function (event) {
        onChange(event.target.checked ? selected.concat([phaseId]) : selected.filter(function (entry) { return entry !== phaseId; }));
      } }), (state.draft.phases[phaseId] || { label: phaseId }).label);
    }));
  }

  function queueImport(change, message) {
    var lib = library();
    state.draft.imports = (state.draft.imports || []).filter(function (existing) { return importKey(existing) !== importKey(change); }).concat([change]);
    lib.preview = null; lib.target = null; lib.reference = ''; lib.error = null;
    setStatus(message);
    changed();
  }

  function importKey(change) {
    if (change.op === 'import.skill' || change.op === 'import.generated') return change.op + ':' + change.agent + '/' + change.id;
    if (change.op === 'import.agent') return change.op + ':' + change.sha256;
    if (change.op === 'import.remove') return change.op + ':' + change.key;
    return change.op + ':' + change.id;
  }

  function renderPreviewCard(lib) {
    var preview = lib.preview;
    var target = lib.target || (lib.target = { agent: '', id: suggestedId(preview), phases: (preview.marketplace && preview.marketplace.phases) || [], optional: false, label: '', withoutDefaults: false, replace: false });
    var card = el('section', { class: 'studio-card', 'aria-label': 'Import preview' });
    card.appendChild(el('div', { class: 'studio-row spread' },
      el('h2', { text: (KIND_WORDS[preview.as] || preview.as) + (preview.marketplace ? ': ' + preview.marketplace.label + ' ' + preview.marketplace.version : preview.source && preview.source.kind === 'mcp' ? ' from an MCP server' : ' from a link') }),
      el('span', { class: 'pill', title: preview.sha256, text: 'SHA-256 ' + preview.sha256.slice(0, 12) + ' · ' + preview.bytes + ' bytes' })));
    card.appendChild(el('span', { class: 'muted', text: 'From ' + preview.reference + (preview.source && preview.source.resolvedUrl && preview.source.resolvedUrl !== preview.reference ? ', served from ' + preview.source.resolvedUrl : '') }));
    if (preview.source && preview.source.kind === 'mcp') {
      card.appendChild(el('span', { class: 'muted', text: 'Read from MCP server ' + preview.source.server + (preview.source.serverInfo && preview.source.serverInfo.name ? ' (' + preview.source.serverInfo.name + ' ' + (preview.source.serverInfo.version || '') + ')' : '') + Object.keys(preview.source.arguments || {}).map(function (name) { return ' · ' + name + '=' + preview.source.arguments[name]; }).join('') }));
    }
    if (preview.details && preview.details.description) card.appendChild(el('span', { text: preview.details.description }));
    (preview.warnings || []).forEach(function (warning) { card.appendChild(el('div', { class: 'callout wait', text: warning })); });
    card.appendChild(el('pre', { class: 'preview-text', 'aria-label': 'Exact content', text: preview.text + (preview.truncated ? '\n…' : '') }));
    card.appendChild(el('p', { class: 'muted', text: 'This exact content is what gets added. It is copied into your configuration, so Stories never fetch it again.' }));
    if (preview.as === 'skill') {
      var agents = Object.keys(state.draft.agents).sort(function (a, b) { return state.draft.agents[a].label.localeCompare(state.draft.agents[b].label); });
      var phaseIds = target.agent ? (agentSteps(target.agent).length ? agentSteps(target.agent) : Object.keys(state.draft.phases)) : [];
      card.appendChild(el('div', { class: 'grid-2' },
        field('import-agent', 'Which agent uses it', select('import-agent', [{ value: '', label: 'Choose an agent' }].concat(agents.map(function (id) { return { value: id, label: state.draft.agents[id].label }; })), target.agent, function (value) { target.agent = value; target.phases = target.phases.filter(function (phaseId) { return agentSteps(value).indexOf(phaseId) >= 0; }); render(); })),
        field('import-id', 'Skill ID', textInput('import-id', target.id, function (value) { target.id = kebab(value); requestRender(); }), 'Shown in the agent\'s skills table.')));
      if (target.agent) card.appendChild(el('fieldset', { class: 'field', style: 'border:0;margin:0;padding:0' }, el('legend', { class: 'label', text: 'In which of its steps (none chosen: every step it drafts)' }),
        stepChecks('import-step-', target.phases, phaseIds, function (phases) { target.phases = phases; })));
      card.appendChild(el('label', { style: 'display:flex;gap:6px;align-items:center;font-size:13px' }, el('input', { type: 'checkbox', 'data-key': 'import-optional', checked: target.optional, onchange: function (event) { target.optional = event.target.checked; } }), 'Optional: the agent works without it'));
    } else if (preview.as === 'template') {
      card.appendChild(el('div', { class: 'grid-2' },
        field('import-id', 'Template ID', textInput('import-id', target.id, function (value) { target.id = kebab(value); requestRender(); })),
        field('import-label', 'Name', textInput('import-label', target.label, function (value) { target.label = value; }, { placeholder: 'From its first heading' }))));
      card.appendChild(el('fieldset', { class: 'field', style: 'border:0;margin:0;padding:0' }, el('legend', { class: 'label', text: 'Use it as the template for' }),
        stepChecks('import-step-', target.phases, Object.keys(state.draft.phases).sort(function (a, b) { return state.draft.phases[a].label.localeCompare(state.draft.phases[b].label); }), function (phases) { target.phases = phases; })));
    } else if (preview.as === 'mcp-server') {
      renderMcpServerTarget(card, preview, target);
    } else if (preview.as === 'agent') {
      var details = preview.details || {};
      card.appendChild(el('span', { text: 'Agent ' + (details.label || preview.id) + (details.tools ? ' · may use ' + details.tools.map(toolLabel).join(', ') : '') }));
      if ((details.defaultFor || []).length) {
        card.appendChild(el('label', { style: 'display:flex;gap:6px;align-items:center;font-size:13px' }, el('input', { type: 'checkbox', 'data-key': 'import-without-defaults', checked: target.withoutDefaults, onchange: function (event) { target.withoutDefaults = event.target.checked; } }),
          'Do not let it take over ' + details.defaultFor.map(function (phaseId) { return (state.draft.phases[phaseId] || { label: phaseId }).label; }).join(', ')));
      }
    }
    if (lib.replace) card.appendChild(el('div', { class: 'callout wait', text: 'This replaces what was imported before; the change shows the difference.' }));
    card.appendChild(el('div', { class: 'studio-row' },
      button('Add to changes', function () { addPreviewedImport(); }, { class: 'primary' }),
      button('Cancel', function () { lib.preview = null; lib.target = null; render(); }, { class: 'secondary' })));
    return card;
  }

  function addPreviewedImport() {
    var lib = library(); var preview = lib.preview; var target = lib.target;
    var replace = Boolean(lib.replace);
    if (preview.as === 'skill') {
      if (!target.agent) { setStatus('Choose the agent that uses this skill.'); return; }
      if (!target.id) { setStatus('Give the skill an ID.'); return; }
      queueImport({ op: 'import.skill', agent: target.agent, id: target.id, source: preview.reference, sha256: preview.sha256, phases: target.phases.slice(), optional: target.optional, replace: replace },
        'Skill ' + target.id + ' for ' + state.draft.agents[target.agent].label + ' added to your changes.');
    } else if (preview.as === 'template') {
      if (!target.id) { setStatus('Give the template an ID.'); return; }
      var change = { op: 'import.template', id: target.id, source: preview.reference, sha256: preview.sha256, phases: target.phases.slice(), replace: replace };
      if (String(target.label || '').trim()) change.label = String(target.label).trim();
      queueImport(change, 'Template ' + target.id + ' added to your changes.');
    } else if (preview.as === 'mcp-server') {
      queueImport({ op: 'import.mcpServer', source: preview.reference, sha256: preview.sha256, agents: (target.agents || []).slice(), phases: target.phases.slice(), replace: replace },
        'MCP server ' + ((preview.details && preview.details.label) || preview.id) + ' added to your changes.');
    } else {
      queueImport({ op: 'import.agent', source: preview.reference, sha256: preview.sha256, withoutDefaults: target.withoutDefaults, replace: replace },
        'Agent ' + ((preview.details && preview.details.label) || preview.id) + ' added to your changes.');
    }
    lib.replace = false;
  }

  function renderGeneratedForm(lib) {
    var entry = lib.generated; var marketplace = lib.market;
    var agents = Object.keys(state.draft.agents).filter(function (id) { return agentSteps(id).indexOf(entry.phase) >= 0; });
    var card = el('section', { class: 'studio-card', 'aria-label': 'Generated artifact source' });
    card.appendChild(el('h2', { text: 'Generated artifact: ' + entry.label }));
    card.appendChild(el('span', { class: 'muted', text: 'Fetched for each Story from ' + entry.urlTemplate + ' into ' + entry.target + ' when ' + ((state.draft.phases[entry.phase] || { label: entry.phase }).label) + ' starts.' }));
    if (!agents.length) card.appendChild(el('div', { class: 'callout wait', text: 'No agent drafts ' + ((state.draft.phases[entry.phase] || { label: entry.phase }).label) + ' in your workflows, so nothing would fetch it.' }));
    lib.generatedAgent = lib.generatedAgent && agents.indexOf(lib.generatedAgent) >= 0 ? lib.generatedAgent : (agents[0] || '');
    card.appendChild(field('generated-agent', 'Which agent fetches it', select('generated-agent', agents.map(function (id) { return { value: id, label: state.draft.agents[id].label }; }), lib.generatedAgent, function (value) { lib.generatedAgent = value; })));
    card.appendChild(el('div', { class: 'studio-row' },
      button('Add to changes', function () {
        if (!lib.generatedAgent) { setStatus('Choose the agent that fetches it.'); return; }
        queueImport({ op: 'import.generated', agent: lib.generatedAgent, id: entry.id, urlTemplate: entry.urlTemplate, phase: entry.phase, target: entry.target, origin: { marketplace: marketplace.id, index: marketplace.index, entry: entry.id, version: entry.version } },
          'Generated artifact ' + entry.label + ' added to your changes.');
        lib.generated = null;
      }, { class: 'primary', disabled: !agents.length }),
      button('Cancel', function () { lib.generated = null; render(); }, { class: 'secondary' })));
    return card;
  }

  function renderMarketplaces(lib) {
    var section = el('section', { class: 'studio-card', 'aria-label': 'Marketplaces' });
    section.appendChild(el('div', { class: 'studio-row spread' }, el('h2', { text: 'Marketplaces this repository trusts' }),
      button('Trust a marketplace', function () { lib.newMarket = { id: '', label: '', index: '', origins: '' }; render(); }, { class: 'secondary' })));
    var trusted = (state.model.marketplaces || []).filter(function (market) { return !(state.draft.imports || []).some(function (change) { return change.op === 'marketplace.remove' && change.id === market.id; }); });
    var pending = (state.draft.imports || []).filter(function (change) { return change.op === 'marketplace.add'; });
    if (!trusted.length && !pending.length) section.appendChild(el('p', { class: 'muted', text: 'None yet. A marketplace is a catalog your team publishes; each entry pins its file by hash, and its index can only list files from origins you allow here.' }));
    trusted.forEach(function (market) {
      section.appendChild(el('div', { class: 'check-row' }, el('span', { class: 'mark ok', text: '✓' }),
        el('div', null, el('strong', { text: market.label }), el('div', { class: 'muted', text: market.index + (market.allowedOrigins.length ? ' · files also from ' + market.allowedOrigins.join(', ') : '') })),
        el('div', { class: 'studio-row' },
          button(lib.busy === 'browse:' + market.id ? 'Opening…' : 'Browse', function () { lib.busy = 'browse:' + market.id; lib.market = market; lib.entries = null; lib.error = null; render(); post({ type: 'studio.marketplaceBrowse', id: market.id }); }, { class: 'secondary', 'aria-label': 'Browse ' + market.label }),
          button('Stop trusting', function () { queueImport({ op: 'marketplace.remove', id: market.id }, market.label + ' will no longer be trusted once you publish.'); }, { class: 'secondary', 'aria-label': 'Stop trusting ' + market.label }))));
    });
    pending.forEach(function (change) { section.appendChild(el('div', { class: 'check-row' }, el('span', { class: 'mark wait', text: '…' }), el('div', null, el('strong', { text: change.label || change.id }), el('div', { class: 'muted', text: change.index + ' · trusted once you publish' })), el('span', null))); });
    if (lib.newMarket) section.appendChild(renderNewMarketplace(lib));
    if (lib.market && lib.entries) section.appendChild(renderEntries(lib));
    return section;
  }

  function renderNewMarketplace(lib) {
    var form = lib.newMarket;
    var box = el('div', { class: 'decision-box' });
    box.appendChild(el('div', { class: 'grid-2' },
      field('market-label', 'Name', textInput('market-label', form.label, function (value) { form.label = value; if (!form.id) form.id = kebab(value); requestRender(); }, { placeholder: 'Engineering catalog' })),
      field('market-id', 'ID', textInput('market-id', form.id, function (value) { form.id = kebab(value); }))));
    box.appendChild(field('market-index', 'Index link (sflow-marketplace@1 JSON)', textInput('market-index', form.index, function (value) { form.index = value.trim(); }, { placeholder: 'https://catalog.example.org/sflow-marketplace.json' })));
    box.appendChild(field('market-origins', 'Other places its files may come from (optional)', textInput('market-origins', form.origins, function (value) { form.origins = value; }, { placeholder: 'https://cdn.example.org' }), 'Comma-separated origins. Files from anywhere else are refused.'));
    box.appendChild(el('div', { class: 'studio-row' },
      button('Add to changes', function () {
        if (!form.id || !/^https:\/\//.test(form.index)) { setStatus('A marketplace needs an ID and an https:// index link.'); return; }
        var origins = String(form.origins || '').split(',').map(function (value) { return value.trim(); }).filter(Boolean);
        var change = { op: 'marketplace.add', id: form.id, index: form.index, allowedOrigins: origins };
        if (String(form.label || '').trim()) change.label = String(form.label).trim();
        lib.newMarket = null;
        queueImport(change, 'Marketplace ' + (change.label || change.id) + ' will be trusted once you publish.');
      }, { class: 'primary' }),
      button('Cancel', function () { lib.newMarket = null; render(); }, { class: 'secondary' })));
    return box;
  }

  function renderEntries(lib) {
    var market = lib.market; var result = lib.entries;
    var box = el('div', { class: 'decision-box', 'aria-label': 'Entries in ' + market.label });
    box.appendChild(el('div', { class: 'studio-row spread' }, el('strong', { text: (result.marketplace.name || market.label) + (result.marketplace.publisher ? ' by ' + result.marketplace.publisher : '') }),
      textInput('market-search', lib.search || '', function (value) { lib.search = value; render(); }, { placeholder: 'Search entries', 'aria-label': 'Search entries' })));
    var query = String(lib.search || '').toLowerCase();
    var entries = result.entries.filter(function (entry) { return !query || [entry.id, entry.label, entry.description || ''].concat(entry.tags || []).some(function (value) { return String(value).toLowerCase().indexOf(query) >= 0; }); });
    if (!entries.length) box.appendChild(el('p', { class: 'muted', text: 'No entries match.' }));
    var grid = el('div', { class: 'agents-grid' });
    entries.forEach(function (entry) {
      grid.appendChild(el('article', { class: 'studio-card' },
        el('div', { class: 'studio-row spread' }, el('strong', { text: entry.label }), el('span', { class: 'pill', text: (KIND_WORDS[entry.kind] || entry.kind) + ' ' + entry.version })),
        entry.description ? el('span', { class: 'muted', text: entry.description }) : null,
        (entry.tags || []).length ? el('div', { class: 'rail' }, entry.tags.map(function (tag) { return el('span', { class: 'pill', text: tag }); })) : null,
        entry.importable
          ? button(entry.kind === 'generated' ? 'Set up' : 'Preview', function () {
            if (entry.kind === 'generated') { lib.generated = entry; lib.preview = null; render(); return; }
            previewImport(importReference(entry, market.id), entry.kind, null);
          }, { class: 'secondary', 'aria-label': (entry.kind === 'generated' ? 'Set up ' : 'Preview ') + entry.label })
          : el('span', { class: 'muted', text: 'This version of Singularity Flow cannot import ' + (KIND_WORDS[entry.kind] || entry.kind).replace(/^[A-Z][a-z]/, function (start) { return start.toLowerCase(); }) + ' entries yet.' })));
    });
    box.appendChild(grid);
    return box;
  }

  function renderImported(lib) {
    var section = el('section', { class: 'studio-card', 'aria-label': 'Imported' });
    section.appendChild(el('div', { class: 'studio-row spread' }, el('h2', { text: 'Imported into this repository' }),
      button(lib.busy === 'check' ? 'Checking…' : 'Check for updates', function () { lib.busy = 'check'; lib.check = null; render(); post({ type: 'studio.importsCheck' }); }, { class: 'secondary', disabled: !(state.model.imports || []).length || Boolean(lib.busy) })));
    var rows = state.model.imports || [];
    if (!rows.length) section.appendChild(el('p', { class: 'muted', text: 'Nothing yet. What you import is listed here with where it came from.' }));
    rows.forEach(function (row) {
      var removing = (state.draft.imports || []).some(function (change) { return change.op === 'import.remove' && change.key === row.key; });
      var checked = lib.check && lib.check.find(function (entry) { return entry.key === row.key; });
      section.appendChild(el('div', { class: 'check-row' },
        el('span', { class: 'mark ' + (row.status === 'current' ? 'ok' : row.status === 'missing' || row.status.indexOf('edited (') === 0 ? 'bad' : 'wait'), text: row.status === 'current' ? '✓' : '!' }),
        el('div', null, el('strong', { text: row.key }), el('div', { class: 'muted', text: row.source + ' · ' + row.status + (checked ? ' · ' + checked.status + (checked.detail ? ' (' + checked.detail + ')' : '') : '') })),
        el('div', { class: 'studio-row' },
          checked && checked.updateCommand ? button('Review update', function () { reviewUpdate(row, checked); }, { class: 'primary', 'aria-label': 'Review the update to ' + row.key }) : null,
          row.kind === 'mcp-server' && row.status === 'current' ? button('Add host entry', function () { post({ type: 'studio.mcpHostAdd', id: row.target.id }); }, { class: 'secondary', 'aria-label': 'Add the host entry for ' + row.target.id }) : null,
          removing ? el('span', { class: 'pill', text: 'Removed once you publish' }) : button('Remove', function () { queueImport({ op: 'import.remove', key: row.key }, row.key + ' will be removed once you publish.'); }, { class: 'secondary', 'aria-label': 'Remove ' + row.key }))));
    });
    return section;
  }

  /** An update is a fresh preview of the changed source, added with replace and the same target. */
  function reviewUpdate(row, checked) {
    var match = /^singularity-flow import add "([^"]+)"/.exec(checked.updateCommand || '');
    if (!match) return;
    var target = row.target || {};
    library().replace = true;
    previewImport(match[1], row.kind, { agent: target.agent || '', id: target.id || '', phases: (target.phases || []).slice(), optional: false, label: '', withoutDefaults: false });
  }

  // ---- Library: from an approved MCP server -----------------------------------------------

  function renderMcpSources(lib) {
    var servers = state.model.mcpSources || [];
    var section = el('section', { class: 'studio-card', 'aria-label': 'From an MCP server' });
    section.appendChild(el('h2', { text: 'From an MCP server' }));
    if (!servers.length) {
      section.appendChild(el('p', { class: 'muted', text: 'No MCP server allows imports yet. A server allows them when its governed policy lists what may be read (mcpServers.<id>.sources), or when you install one from a marketplace.' }));
      return section;
    }
    section.appendChild(el('p', { class: 'muted', text: 'Read a prompt, a resource or a tool\'s answer from an approved server. Singularity Flow starts or contacts the server only after you allow it, and stops it as soon as the import is read.' }));
    servers.forEach(function (server) {
      section.appendChild(el('div', { class: 'check-row' }, el('span', { class: 'mark ok', text: '✓' }),
        el('div', null, el('strong', { text: server.label }), el('div', { class: 'muted', text: [server.sources.prompts.length ? 'prompts ' + server.sources.prompts.join(', ') : null, server.sources.resources.length ? 'resources ' + server.sources.resources.join(', ') : null, server.sources.tools.length ? 'tools ' + server.sources.tools.join(', ') : null].filter(Boolean).join(' · ') })),
        button(lib.busy === 'mcp:' + server.id ? 'Asking…' : 'Show what it offers', function () { lib.busy = 'mcp:' + server.id; lib.mcp = null; lib.error = null; render(); post({ type: 'studio.mcpSources', id: server.id }); }, { class: 'secondary', 'aria-label': 'Show what ' + server.label + ' offers' })));
    });
    if (lib.mcp) section.appendChild(renderMcpOffer(lib));
    return section;
  }

  function renderMcpOffer(lib) {
    var offer = lib.mcp;
    var box = el('div', { class: 'decision-box', 'aria-label': 'Offered by ' + offer.server.label });
    box.appendChild(el('strong', { text: offer.server.label + (offer.serverInfo && offer.serverInfo.name ? ' (' + offer.serverInfo.name + (offer.serverInfo.version ? ' ' + offer.serverInfo.version : '') + ')' : '') }));
    var items = [];
    offer.prompts.forEach(function (prompt) { items.push({ kind: 'Prompt', name: prompt.name, description: prompt.description, arguments: prompt.arguments, reference: prompt.reference, as: 'skill' }); });
    offer.resources.forEach(function (resource) { items.push({ kind: 'Resource', name: resource.name, description: resource.description || resource.uri, arguments: [], reference: resource.reference, as: 'template' }); });
    offer.tools.forEach(function (tool) { items.push({ kind: 'Tool', name: tool.name, description: tool.description, arguments: tool.arguments, reference: tool.reference, as: 'skill' }); });
    if (!items.length) box.appendChild(el('p', { class: 'muted', text: 'It offers nothing its policy allows importing.' }));
    lib.mcpForms = lib.mcpForms || {};
    items.forEach(function (item) {
      var form = lib.mcpForms[item.reference] || (lib.mcpForms[item.reference] = { as: item.as, values: {} });
      var card = el('article', { class: 'studio-card' },
        el('div', { class: 'studio-row spread' }, el('strong', { text: item.name }), el('span', { class: 'pill', text: item.kind })),
        item.description ? el('span', { class: 'muted', text: item.description }) : null);
      item.arguments.forEach(function (argument) {
        var key = 'mcp-arg-' + kebab(item.reference) + '-' + argument.name;
        card.appendChild(field(key, argument.name + (argument.required ? '' : ' (optional)'), textInput(key, form.values[argument.name] || '', function (value) { form.values[argument.name] = value; }), argument.description));
      });
      card.appendChild(el('div', { class: 'studio-row' },
        select('mcp-as-' + kebab(item.reference), [{ value: 'skill', label: 'Use as a skill' }, { value: 'template', label: 'Use as a document template' }], form.as, function (value) { form.as = value; }),
        button('Preview', function () {
          var missing = item.arguments.filter(function (argument) { return argument.required && !String(form.values[argument.name] || '').trim(); });
          if (missing.length) { setStatus('Fill in ' + missing.map(function (argument) { return argument.name; }).join(', ') + ' first.'); return; }
          var values = {};
          Object.keys(form.values).forEach(function (name) { if (String(form.values[name]).trim()) values[name] = String(form.values[name]).trim(); });
          var lib2 = library(); lib2.replace = false;
          lib2.preview = null; lib2.error = null; lib2.busy = 'preview'; lib2.target = null; render();
          post({ type: 'studio.importPreview', reference: item.reference, as: form.as, arguments: values });
        }, { class: 'secondary', 'aria-label': 'Preview ' + item.name })));
      box.appendChild(card);
    });
    return box;
  }

  function renderMcpServerTarget(card, preview, target) {
    var details = preview.details || {};
    var host = details.host || {};
    card.appendChild(el('span', { text: host.type === 'stdio' ? 'Starting it runs: ' + [host.command].concat(host.args || []).join(' ') : 'It connects to: ' + host.url }));
    var policy = details.policy || {};
    card.appendChild(el('span', { class: 'muted', text: (policy.tools && policy.tools.length ? 'Tools for agents: ' + policy.tools.join(', ') : 'No tools listed: chosen agents may use all its tools') + (policy.sources ? ' · imports allowed from it' : '') }));
    target.agents = target.agents || [];
    card.appendChild(el('fieldset', { class: 'field', style: 'border:0;margin:0;padding:0' }, el('legend', { class: 'label', text: 'Which agents may use it' }),
      el('div', { class: 'grid-3' }, Object.keys(state.draft.agents).sort(function (a, b) { return state.draft.agents[a].label.localeCompare(state.draft.agents[b].label); }).map(function (agentId) {
        return el('label', { style: 'display:flex;gap:6px;align-items:center;font-size:13px' }, el('input', { type: 'checkbox', 'data-key': 'mcp-agent-' + agentId, checked: target.agents.indexOf(agentId) >= 0, onchange: function (event) {
          target.agents = event.target.checked ? target.agents.concat([agentId]) : target.agents.filter(function (entry) { return entry !== agentId; });
        } }), state.draft.agents[agentId].label);
      }))));
    card.appendChild(el('fieldset', { class: 'field', style: 'border:0;margin:0;padding:0' }, el('legend', { class: 'label', text: 'In which steps (none chosen: every step)' }),
      stepChecks('mcp-step-', target.phases, Object.keys(state.draft.phases).sort(function (a, b) { return state.draft.phases[a].label.localeCompare(state.draft.phases[b].label); }), function (phases) { target.phases = phases; })));
    card.appendChild(el('p', { class: 'muted', text: 'Publishing adds its governed policy and grants the chosen agents its tools. Its host entry is added to your VS Code workspace afterwards, when you choose to.' }));
  }

  function renderLibrary(main) {
    var lib = library();
    main.appendChild(el('header', null, el('h1', { text: 'Library' }),
      el('p', { class: 'studio-lede', text: 'Add skills, document templates, agents and MCP servers from a link, a marketplace your repository trusts, or an approved MCP server. You see the exact content before it is added; it is copied into your configuration and published with your other changes.' })));
    var form = el('section', { class: 'studio-card', 'aria-label': 'Add from a link' });
    form.appendChild(el('h2', { text: 'Add from a link' }));
    form.appendChild(el('div', { class: 'grid-2' },
      field('import-link', 'Link to the raw file', textInput('import-link', lib.reference, function (value) { lib.reference = value.trim(); }, { placeholder: 'https://example.org/skills/security-review/SKILL.md' })),
      field('import-as', 'Use it as', select('import-as', IMPORT_KINDS, lib.as, function (value) { lib.as = value; }))));
    form.appendChild(el('div', { class: 'studio-row' },
      button(lib.busy === 'preview' ? 'Fetching…' : 'Preview', function () {
        if (!/^https:\/\//.test(lib.reference || '')) { lib.error = 'Paste a public https:// link to the raw file.'; render(); return; }
        lib.replace = false;
        previewImport(lib.reference, lib.as, null);
      }, { class: 'primary', disabled: Boolean(lib.busy) }),
      el('span', { class: 'muted', text: 'Only public HTTPS links; nothing is sent with the request.' })));
    if (lib.error) form.appendChild(el('div', { class: 'callout bad', role: 'alert', text: lib.error }));
    main.appendChild(form);
    if (lib.preview) main.appendChild(renderPreviewCard(lib));
    if (lib.generated) main.appendChild(renderGeneratedForm(lib));
    var queued = (state.draft.imports || []);
    if (queued.length) {
      main.appendChild(el('section', { class: 'studio-card', 'aria-label': 'Waiting to be published' }, el('h2', { text: 'Waiting to be published' }),
        el('ul', { class: 'change-list' }, queued.map(function (change) {
          return el('li', { class: 'studio-row spread' }, el('span', { text: describe(change, state.draft) }),
            button('Undo', function () { state.draft.imports = state.draft.imports.filter(function (entry) { return entry !== change; }); changed(); }, { class: 'secondary', 'aria-label': 'Undo: ' + describe(change, state.draft) }));
        })),
        button('Review changes', function () { state.view = 'changes'; render(); }, { class: 'primary' })));
    }
    main.appendChild(renderMarketplaces(lib));
    main.appendChild(renderMcpSources(lib));
    main.appendChild(renderImported(lib));
  }

  function renderPeople(main) {
    main.appendChild(el('header', null, el('h1', { text: 'People & approvals' }), el('p', { class: 'studio-lede', text: 'An approval group is the list of people who may sign off a step. A step can only be approved by someone in its group.' })));
    var grid = el('div', { class: 'groups-grid' });
    Object.keys(state.draft.groups).forEach(function (id) {
      var group = state.draft.groups[id];
      var approves = Object.keys(state.draft.workflows).reduce(function (list, workflowId) { workflowSteps(workflowId).forEach(function (phaseId) { var settings = state.draft.steps[workflowId][phaseId]; if (settings && settings.approval.group === id && list.indexOf(phaseId) < 0) list.push(phaseId); }); return list; }, []);
      var draftPerson = group.adding || (group.adding = { name: '', email: '' });
      grid.appendChild(el('article', { class: 'studio-card', 'aria-label': group.label },
        el('div', { class: 'studio-row spread' }, el('strong', { text: group.label }), el('span', { class: 'muted', text: groupHint(group) })),
        el('span', { class: 'muted', text: approves.length ? 'Signs off: ' + approves.map(function (phaseId) { return (state.draft.phases[phaseId] || { label: phaseId }).label; }).join(', ') : 'Signs off no step yet' }),
        groupBlocked(id) && approves.length ? el('div', { class: 'callout bad', text: 'Nobody can approve these steps until someone is added.' }) : null,
        !group.members.length && group.status === 'auto' ? el('div', { class: 'callout', text: 'Empty: whoever starts a Story is added automatically. Add people here for independent review.' }) : null,
        el('div', { class: 'rail' }, group.members.map(function (member, index) {
          var name = member.name || member.email || member.githubLogin;
          return el('span', { class: 'member' }, name, button('Remove', function () { group.members.splice(index, 1); changed(); }, { class: 'secondary', 'aria-label': 'Remove ' + name, title: 'Remove' }));
        })),
        el('div', { class: 'grid-3' },
          textInput('person-name-' + id, draftPerson.name, function (value) { draftPerson.name = value; }, { placeholder: 'Name', 'aria-label': 'Name' }),
          textInput('person-mail-' + id, draftPerson.email, function (value) { draftPerson.email = value; }, { placeholder: 'Email or GitHub login', 'aria-label': 'Email or GitHub login' }),
          button('Add', function () {
            var contact = String(draftPerson.email || '').trim();
            if (!contact) { setStatus('Give an email address or a GitHub login.'); return; }
            var member = contact.indexOf('@') > 0 ? { name: draftPerson.name.trim() || null, email: contact.toLowerCase(), githubLogin: null } : { name: draftPerson.name.trim() || null, email: null, githubLogin: contact.toLowerCase() };
            if (group.members.some(function (existing) { return (member.email && existing.email === member.email) || (member.githubLogin && existing.githubLogin === member.githubLogin); })) { setStatus(contact + ' is already in ' + group.label + '.'); return; }
            group.members.push(member); group.adding = { name: '', email: '' }; changed();
          }, { 'aria-label': 'Add person to ' + group.label }))));
    });
    main.appendChild(grid);
    var adding = state.newGroup || (state.newGroup = { label: '' });
    main.appendChild(el('div', { class: 'studio-row' }, textInput('new-group', adding.label, function (value) { adding.label = value; }, { placeholder: 'New approval group name', 'aria-label': 'New approval group name' }),
      button('New approval group', function () {
        var id = kebab(adding.label);
        if (!id || state.draft.groups[id]) { setStatus('Choose a different group name.'); return; }
        state.draft.groups[id] = { id: id, label: adding.label.trim(), members: [], status: 'blocked', isNew: true };
        adding.label = ''; changed();
      })));
  }

  function renderChanges(main) {
    var changeSet = changeSetFrom(state.model, state.draft);
    var key = JSON.stringify(changeSet);
    main.appendChild(el('header', null, el('h1', { text: changeSet.changes.length ? changeSet.changes.length + (changeSet.changes.length === 1 ? ' change ready' : ' changes ready') : 'No changes yet' }),
      el('p', { class: 'studio-lede', text: 'Changes are published together as one change, so nothing is ever half-applied. Check them first; Singularity Flow validates the whole configuration.' })));
    if (!changeSet.changes.length) { main.appendChild(el('p', { class: 'muted', text: 'Edit a workflow, an agent or an approval group and your changes collect here.' })); return; }
    main.appendChild(el('ol', { class: 'change-list' }, changeSet.changes.map(function (change) { return el('li', { text: describe(change, state.draft) }); })));
    var fresh = state.plan && state.planKey === key;
    main.appendChild(el('div', { class: 'studio-row' },
      button(state.busy === 'check' ? 'Checking…' : 'Check changes', function () { state.busy = 'check'; render(); post({ type: 'studio.preview', changeSet: key }); }, { class: fresh && state.plan.valid ? 'secondary' : 'primary', disabled: Boolean(state.busy) }),
      button(state.busy === 'publish' ? 'Publishing…' : publishLabel(), function () { state.busy = 'publish'; render(); post({ type: 'studio.publish', changeSet: key, count: changeSet.changes.length }); }, { class: fresh && state.plan.valid ? 'primary' : 'secondary', disabled: !fresh || !state.plan.valid || Boolean(state.busy) }),
      button('Discard all changes', function () { state.draft = initialDraft(state.model); state.plan = null; state.planKey = null; state.view = 'home'; render(); }, { class: 'secondary', disabled: Boolean(state.busy) })));
    if (state.plan && !fresh) main.appendChild(el('p', { class: 'muted', text: 'You changed something since the last check. Check again before publishing.' }));
    if (fresh) main.appendChild(renderPlan(state.plan));
  }

  function publishLabel() {
    var kind = state.model.authority && state.model.authority.kind;
    return kind && kind !== 'working-tree' ? 'Publish for review' : 'Write to this repository';
  }

  function renderPlan(plan) {
    var section = el('section', { class: 'studio-card', 'aria-label': 'Check result' });
    section.appendChild(el('h2', { text: plan.valid ? 'Checked: ready to publish' : 'Checked: fix these first' }));
    plan.problems.forEach(function (problem) { section.appendChild(el('div', { class: 'callout bad', text: problem.message })); });
    plan.warnings.forEach(function (warning) { section.appendChild(el('div', { class: 'callout wait', text: warning.message })); });
    if (plan.valid) plan.summary.forEach(function (line) { section.appendChild(el('div', { class: 'callout ok', text: line })); });
    if (plan.files.length) {
      var files = el('details', null, el('summary', { text: 'Files this changes (' + plan.files.length + ')' }));
      plan.files.forEach(function (file) {
        files.appendChild(el('div', { style: 'margin-top:8px' }, el('code', { text: file.path }), el('span', { class: 'muted', text: file.action === 'create' ? '  new' : '  changed' })));
        var pre = el('pre', { class: 'diff' });
        String(file.diff || '').split('\n').forEach(function (line) { pre.appendChild(el('span', { class: line.charAt(0) === '+' && line.slice(0, 3) !== '+++' ? 'add' : line.charAt(0) === '-' && line.slice(0, 3) !== '---' ? 'del' : null, text: line + '\n' })); });
        files.appendChild(pre);
      });
      section.appendChild(files);
    }
    var kind = state.model.authority && state.model.authority.kind;
    section.appendChild(el('p', { class: 'muted', text: kind && kind !== 'working-tree'
      ? 'Publishing opens one review proposal on the approved configuration. Approved configuration and running Stories stay as they are until it is merged.'
      : 'Publishing writes these files to this repository. Review the diff and commit it through your usual review.' }));
    return section;
  }

  // ---- Frame ---------------------------------------------------------------------------------

  function render() {
    var root = document.getElementById('studio-root');
    if (!root) return;
    var active = document.activeElement && document.activeElement.getAttribute ? document.activeElement.getAttribute('data-key') : null;
    root.textContent = '';
    if (state.error && !state.model) { root.appendChild(el('div', { class: 'studio-main' }, el('h1', { text: 'Workflow Studio could not load' }), el('p', { class: 'callout bad', text: state.error }), button('Try again', function () { state.error = null; post({ type: 'studio.reload' }); }))); return; }
    if (!state.model) { root.appendChild(el('div', { class: 'studio-main' }, el('p', { text: 'Loading workflows, steps and agents…' }))); return; }
    var frame = el('div', { class: 'studio' });
    renderNav(frame);
    var main = el('main', { class: 'studio-main' });
    (state.model.problems || []).forEach(function (problem) { main.appendChild(el('div', { class: 'callout bad', text: 'The current configuration has a problem: ' + problem.message })); });
    if (state.view === 'board') renderBoard(main);
    else if (state.view === 'new') renderWizard(main);
    else if (state.view === 'agents') renderAgents(main);
    else if (state.view === 'library') renderLibrary(main);
    else if (state.view === 'people') renderPeople(main);
    else if (state.view === 'changes') renderChanges(main);
    else renderHome(main);
    main.appendChild(el('div', { id: 'studio-status', class: 'studio-status', role: 'status', 'aria-live': 'polite', text: state.status }));
    frame.appendChild(main);
    root.appendChild(frame);
    if (active) { var again = root.querySelector('[data-key="' + active.replace(/"/g, '') + '"]'); if (again) again.focus(); }
  }

  window.addEventListener('message', function (event) {
    var message = event.data || {};
    if (message.type === 'studio.model') {
      var keep = state.draft && state.model && changeSetFrom(state.model, state.draft).changes.length && !message.reset;
      state.model = message.model; state.error = null;
      if (!keep) state.draft = initialDraft(message.model);
      if (state.workflow && !state.draft.workflows[state.workflow]) state.workflow = null;
      state.busy = null; render();
    } else if (message.type === 'studio.plan') {
      state.plan = message.plan; state.planKey = message.changeSet; state.busy = null;
      setStatus(message.plan.valid ? 'Checked: ready to publish.' : 'Checked: some changes need fixing.');
      render();
    } else if (message.type === 'studio.published') {
      state.busy = null; state.plan = null; state.planKey = null; state.view = 'home';
      setStatus(message.summary || 'Published.');
    } else if (message.type === 'studio.failed') {
      state.busy = null; setStatus(message.message || 'That did not work.'); if (!state.model) state.error = message.message; render();
    } else if (message.type === 'studio.cancelled') {
      state.busy = null; render();
    } else if (message.type === 'studio.importPreviewed') {
      var lib = library(); lib.busy = null; lib.error = null; lib.preview = message.preview;
      if (!lib.target && lib.pendingAgent) lib.target = { agent: lib.pendingAgent, id: suggestedId(message.preview), phases: (message.preview.marketplace && message.preview.marketplace.phases) || [], optional: false, label: '', withoutDefaults: false };
      lib.pendingAgent = null; render();
    } else if (message.type === 'studio.marketplaceEntries') {
      var market = library(); market.busy = null; market.entries = message.result; market.search = ''; render();
    } else if (message.type === 'studio.importsChecked') {
      var checks = library(); checks.busy = null; checks.check = (message.result && message.result.imports) || [];
      setStatus(checks.check.some(function (entry) { return entry.updateCommand; }) ? 'Some imports changed at their source.' : 'Every import matches its source.'); render();
    } else if (message.type === 'studio.mcpSourcesListed') {
      var offered = library(); offered.busy = null; offered.mcp = message.result; offered.mcpForms = {}; render();
    } else if (message.type === 'studio.mcpHostAdded') {
      setStatus(message.summary || 'Host entry added.');
    } else if (message.type === 'studio.importFailed') {
      var failed = library(); failed.busy = null; failed.error = message.message || 'That did not work.'; failed.preview = null; render();
      var alert = document.querySelector('[role=alert]'); if (alert && alert.scrollIntoView) alert.scrollIntoView({ block: 'center' });
    }
  });

  if (document.getElementById('studio-root')) {
    document.addEventListener('pointerdown', function () { pointerDown = true; }, true);
    window.addEventListener('click', function () { setTimeout(flushRender, 0); });
    document.addEventListener('pointerup', function () { setTimeout(function () { if (pointerDown) flushRender(); }, 120); }, true);
    render();
    post({ type: 'studio.ready' });
  }
})();
`;

// The commands the host runs for this page. Here rather than in the host so they can be checked
// without the VS Code runtime.

/** The configuration authority the Studio's model was read from, as the engine reported it. */
export interface StudioAuthority {
  kind?: string | null;
  commit?: string | null;
  remoteFingerprint?: string | null;
  sourceCommit?: string | null;
}

/**
 * The publish command for the authority the model came from. An externally governed configuration
 * is changed through one review proposal bound to the exact authority revision the Studio read; a
 * working-tree authority is written directly; a recovery mirror is read-only.
 */
export function studioPublishArgs(authority: StudioAuthority | null | undefined): string[] {
  const kind = authority?.kind ?? 'working-tree';
  if (kind === 'verified-state-mirror') {
    throw new Error('This configuration is readable only from the verified state recovery mirror. Restore or reinitialize sflow/config before editing it.');
  }
  const base = ['workflow', 'studio', 'apply', '--change-set', '-'];
  if (kind === 'working-tree') return [...base, '--json'];
  return [
    ...base, '--propose',
    '--expected-authority-kind', kind,
    ...(authority?.commit ? ['--expected-authority-commit', authority.commit] : []),
    ...(authority?.remoteFingerprint ? ['--expected-authority-remote-fingerprint', authority.remoteFingerprint] : []),
    ...(authority?.sourceCommit ? ['--expected-authority-source-commit', authority.sourceCommit] : []),
    '--json'
  ];
}

export const STUDIO_PREVIEW_ARGS = Object.freeze(['workflow', 'studio', 'apply', '--change-set', '-', '--dry-run', '--json']);
export const STUDIO_MODEL_ARGS = Object.freeze(['workflow', 'studio', '--json']);

/**
 * The page body. The panel wraps it in the shared page shell, so the footer that shell draws and
 * the code that answers the footer's clicks live in the same file.
 */
export function workflowStudioBody(token: string): string {
  return `<style nonce="${token}">${STUDIO_STYLE}</style><div id="studio-root" class="studio-shell"></div>`;
}
