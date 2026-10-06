export const WORKFLOW_TRANSFER_BODY = `
<main><h1>Import or duplicate a workflow</h1>
<p>Review every agent and skill, then choose unique destination identities. References are rewritten together; existing objects are not overwritten.</p>
<p id="transfer-status" role="status" aria-live="polite">Loading dependencies…</p>
<div id="transfer-inventory"></div><div id="transfer-identities"></div>
<h2>Exact plan</h2><pre id="transfer-plan"></pre>
<div class="actions"><button id="transfer-preview">Validate names and preview</button>
<button id="transfer-apply" disabled>Create reviewed proposal</button><button id="transfer-cancel">Cancel</button></div></main>`;

export const WORKFLOW_TRANSFER_SCRIPT = String.raw`
(function () {
  var api = window.__sfVscode, plan = null, choices = {}, revision = 0, pending = true, initialized = false;
  var status = document.getElementById('transfer-status'), apply = document.getElementById('transfer-apply');
  function node(tag, text) { var el = document.createElement(tag); if (text != null) el.textContent = String(text); return el; }
  function sendPreview() { pending = true; apply.disabled = true; status.textContent = 'Validating the complete dependency graph…';
    api.postMessage({ type: 'transfer.preview', choices: choices, revision: ++revision }); }
  function table(title, headers, rows) { var section = node('section'); section.appendChild(node('h2', title));
    var table = node('table'), head = node('tr'); headers.forEach(function (text) { head.appendChild(node('th', text)); }); table.appendChild(head);
    rows.forEach(function (row) { var tr = node('tr'); row.forEach(function (entry) { var td = node('td');
      if (entry instanceof window.Node) td.appendChild(entry); else td.textContent = String(entry || '—'); tr.appendChild(td); }); table.appendChild(tr); });
    if (!rows.length) section.appendChild(node('p', 'None in this workflow.')); else section.appendChild(table); return section; }
  function validation(rows) { var seen = {}, errors = [];
    rows.forEach(function (row) { var target = row.renameable ? choices[row.subject] && choices[row.subject].to || row.sourceId : row.targetId || row.sourceId;
      var namespace = row.kind.indexOf('workflow') >= 0 ? 'workflow' : row.kind;
      var key = namespace + ':' + target;
      if (row.renameable && !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(target)) errors.push('Use lower-case kebab-case for ' + row.subject);
      if (seen[key]) errors.push('Duplicate destination: ' + key); seen[key] = true;
      if (target !== row.sourceId && (row.occupiedIds || []).indexOf(target) >= 0) errors.push('Already exists: ' + key);
    }); return errors; }
  function render() {
    var rows = plan.identities || [], inventory = document.getElementById('transfer-inventory'); inventory.replaceChildren();
    inventory.appendChild(table('Agents included', ['Agent', 'Source ID', 'Attached skills', 'Remote resources'], rows.filter(function (row) { return row.kind === 'agent'; }).map(function (row) {
      return [row.label || row.sourceId, row.sourceId, (row.skills || []).map(function (skill) { return skill.id; }).join(', '),
        (row.resources || []).map(function (resource) { return resource.type + ': ' + resource.id + (resource.url ? ' — ' + resource.url : ''); }).join('\n')]; })));
    var skills = rows.filter(function (row) { return row.kind === 'skill' || row.kind === 'compiled-skill'; }).map(function (row) { return [row.label || row.sourceId, row.sourceId, row.description || row.reason]; });
    rows.filter(function (row) { return row.kind === 'agent'; }).forEach(function (row) { (row.resources || []).filter(function (resource) { return resource.type === 'skill'; }).forEach(function (resource) {
      var agent = choices[row.subject] && choices[row.subject].to || row.sourceId;
      skills.push([resource.id, row.sourceId + '/' + resource.id, 'Agent-scoped → ' + agent + '/' + resource.id + '. ' + (resource.url || '')]);
    }); });
    inventory.appendChild(table('Skills included', ['Skill', 'Source ID', 'Purpose / destination'], skills));
    var identities = document.getElementById('transfer-identities'); identities.replaceChildren();
    identities.appendChild(table('Destination identities', ['Object', 'Source identity', 'Rename to', 'Disposition'], rows.map(function (row) {
      var value = row.renameable ? choices[row.subject] && choices[row.subject].to || row.sourceId : row.targetId || row.sourceId;
      var input = node('input'); input.type = 'text'; input.value = value; input.disabled = !row.renameable;
      input.setAttribute('aria-label', 'Destination for ' + row.subject);
      input.addEventListener('input', function () { var to = input.value.trim();
        if (to === row.sourceId) delete choices[row.subject]; else choices[row.subject] = { action: 'rename', to: to };
        pending = true; apply.disabled = true; revision += 1;
        var errors = validation(rows); status.textContent = errors.length ? errors.join('; ') : 'Names changed. Validate the plan before continuing.';
      });
      return [row.kind, row.sourceId, input, !row.renameable ? row.reason || 'Shared, read-only contract' : value !== row.sourceId ? 'Independent identity' : (row.occupiedIds || []).indexOf(value) >= 0 ? 'Reuse exact only; rename to keep independent' : 'Will add'];
    })));
    document.getElementById('transfer-plan').textContent = JSON.stringify({ status: plan.status, operations: plan.operations, renamed: plan.renamed,
      changedPaths: plan.changedPaths, destination: plan.destinationAuthority, confirmation: plan.planSha256, unresolved: plan.unresolved }, null, 2);
    var errors = validation(rows); apply.disabled = pending || errors.length > 0 || plan.status !== 'ready' || !plan.planSha256;
    status.textContent = errors.length ? errors.join('; ') : pending ? 'Names changed. Validate the plan.' : plan.status === 'ready'
      ? 'Ready. Review all identities and changes before creating the proposal.' : 'Blocked. The exact plan below explains what needs to change.';
  }
  document.getElementById('transfer-preview').onclick = sendPreview;
  document.getElementById('transfer-cancel').onclick = function () { api.postMessage({ type: 'transfer.cancel' }); };
  apply.onclick = function () { if (!apply.disabled) { apply.disabled = true; api.postMessage({ type: 'transfer.apply', revision: revision, planSha256: plan.planSha256 }); } };
  window.addEventListener('message', function (event) { var message = event.data;
    if (message.revision !== revision) return;
    if (message.type === 'transfer.failed') { pending = true; apply.disabled = true; status.textContent = message.message; return; }
    if (message.type !== 'transfer.plan') return;
    plan = message.plan; pending = false;
    if (!initialized) { initialized = true; choices = Object.assign({}, plan.resolutions || {});
      (plan.identities || []).forEach(function (row) { if (!choices[row.subject] && row.renameable && (row.occupiedIds || []).indexOf(row.sourceId) >= 0 && row.kind.indexOf('approval-group') < 0) {
        choices[row.subject] = { action: 'rename', to: row.suggestedId }; } });
      render(); if (Object.keys(choices).length) sendPreview(); return;
    }
    choices = Object.assign({}, choices, plan.resolutions || {});
    render();
  });
  sendPreview();
})();`;
