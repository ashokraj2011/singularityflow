import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { classifyWorkflowAttachment, inspectWorkflowAttachments } from '../src/workflow-intent-attachments.mjs';
import { WorkflowAttachmentStore } from '../apps/vscode/src/views/workflow-attachment-store.ts';
import { withWorkflowIntentCatalog, workflowIntentExample } from '../src/workflow-intent-catalog.mjs';
import { compileWorkflowMarkup } from '../src/workflow-markup.mjs';

async function fixture(t) { const root=await mkdtemp(path.join(os.tmpdir(),'sflow-local-guidance-')); t.after(()=>rm(root,{recursive:true,force:true})); return root; }
test('classification distinguishes recognized definitions from proposals and does not turn ambient guidance global',()=>{
  assert.equal(classifyWorkflowAttachment('owner.agent.md','---\nname: owner\n---\nRead the scope.').kind,'agent');
  assert.equal(classifyWorkflowAttachment('SKILL.md','---\nname: checks\ndescription: Check behavior\n---\n## Steps\nRun tests.').confidence,'recognized');
  assert.equal(classifyWorkflowAttachment('INSTRUCTIONS.md','Use accessible controls.').kind,'instruction');
  assert.equal(classifyWorkflowAttachment('coding-standards.md','Prefer small functions.').confidence,'suggested');
  assert.equal(classifyWorkflowAttachment('notes.md','A document about the project.').kind,'auto');
  const scoped=classifyWorkflowAttachment('ui.instructions.md','---\napplyTo: "src/**/*.tsx"\n---\nCheck contrast.');
  assert.equal(scoped.scope,'src/**/*.tsx');
  assert.equal(classifyWorkflowAttachment('ui.mdc','---\nglobs: ["src/**/*.tsx"]\nalwaysApply: false\n---\nKeep keyboard access.').kind,'instruction');
  assert.equal(classifyWorkflowAttachment('broken.md','---\nname: [\n---\nText').confidence,'needs-review');
});
test('only explicit files are read, captures are stable, and exact retrieval refuses changed bytes',async t=>{
  const root=await fixture(t),file=path.join(root,'SKILL.md'); await writeFile(file,'---\nname: checks\ndescription: UI checks\n---\nCheck the screenshot.\n');
  const first=await inspectWorkflowAttachments({files:[file]}); const again=await inspectWorkflowAttachments({files:[file]});
  assert.equal(first.sourceSha256,again.sourceSha256);assert.equal(first.items[0].available,true);
  const exact=await inspectWorkflowAttachments({files:[file],expectedSource:first.sourceSha256,id:first.items[0].id});assert.equal(exact.items.length,1);
  await writeFile(file,'Changed guidance.');await assert.rejects(inspectWorkflowAttachments({files:[file],expectedSource:first.sourceSha256}),/changed/u);
  await assert.rejects(inspectWorkflowAttachments({files:[]}));await assert.rejects(inspectWorkflowAttachments({files:['/not-selected.txt'],folders:[]}));
});
test('credentials, waiver comments, symlinks, binary text, oversize files and unsafe folder roots never become model content',async t=>{
  const root=await fixture(t),file=path.join(root,'guide.md'),credential=`ghp_${'Z'.repeat(36)}`;
  await writeFile(file,credential+' // sflow-allow-secret: not an import authority');
  const captured=await inspectWorkflowAttachments({files:[file]});assert.equal(captured.items[0].available,false);assert.ok(!JSON.stringify(captured).includes(credential));
  const link=path.join(root,'linked.md');await symlink(file,link);await assert.rejects(inspectWorkflowAttachments({files:[link]}),/regular/u);
  await writeFile(file,Buffer.from([0xff,0xfe,0]));await assert.rejects(inspectWorkflowAttachments({files:[file]}));
  await writeFile(file,'x'.repeat(262145));await assert.rejects(inspectWorkflowAttachments({files:[file]}),/256 KiB/u);
  await assert.rejects(inspectWorkflowAttachments({folders:[path.parse(root).root]}),/guidance folder/u);
  const key=path.join(root,'credentials.md');await writeFile(key,credential);const blocked=await inspectWorkflowAttachments({files:[key]});assert.equal(blocked.items[0].classification.confidence,'blocked');
});
test('folder capture excludes dependencies and follows no references beyond the explicit selection',async t=>{
  const root=await fixture(t);await mkdir(path.join(root,'.github/agents'),{recursive:true});await mkdir(path.join(root,'node_modules/hidden'),{recursive:true});
  await writeFile(path.join(root,'.github/agents/reviewer.agent.md'),'---\nname: reviewer\n---\nRead [outside](../../../outside.md).');await writeFile(path.join(root,'node_modules/hidden/guide.md'),'Do not read this.');
  const result=await inspectWorkflowAttachments({folders:[root]});assert.equal(result.items.length,1);assert.equal(result.items[0].classification.kind,'agent');assert.ok(result.notices.length);
});
test('private designer storage reveals only summaries, retains captured bytes, and requires every exact mapping',async t=>{
  const root=await fixture(t),file=path.join(root,'INSTRUCTIONS.md');await writeFile(file,'Keep the UI keyboard accessible.');
  const captured=await inspectWorkflowAttachments({files:[file]}),store=new WorkflowAttachmentStore();
  await store.capture({run:async()=>captured},[file],false);const item=store.list()[0];
  assert.equal(item.content,undefined);assert.ok(!JSON.stringify(store.list()).includes(root));assert.match(store.read(item.id).content,/keyboard/u);
  assert.throws(()=>store.verify([]),/Every available attachment/u);
  const mapping={id:item.id,sha256:item.sha256,kind:'instruction',targets:['instruction:flow-rule']};store.verify([mapping]);
  assert.throws(()=>store.verify([{...mapping,kind:'skill'}]),/different type/u);assert.throws(()=>store.verify([{...mapping,sha256:'wrong'}]),/stale/u);
  store.setKind(item.id,'skill');store.verify([{...mapping,kind:'skill'}]);store.remove(item.id);assert.throws(()=>store.read(item.id),/removed/u);
  const stale=new WorkflowAttachmentStore();await assert.rejects(stale.capture({run:async()=>captured},[file],false,()=>false),/changed/u);assert.equal(stale.size,0);
});
test('attachment mapping survives native compilation and bundle provenance without claiming approval',async()=>{
  const example=await withWorkflowIntentCatalog(null,{source:'installed'},workflowIntentExample);
  const source=example.source.replace('</workflow>','<attachment id="local-team-rule" sha256="sha256:'+ 'a'.repeat(64)+'" kind="agent" maps-to="agent:demo-intent-tester"/></workflow>');
  const compiled=await compileWorkflowMarkup(source);assert.equal(compiled.attachmentMappings[0].kind,'agent');assert.match(compiled.bundle.objects.story.workTypes['demo-intent'].description,/Local source mapping/u);assert.equal(compiled.effects.approvalRecorded,false);
  await assert.rejects(compileWorkflowMarkup(source.replace('kind="agent" maps-to','kind="instruction" maps-to')),/proposed type/u);
});
test('captured local guidance becomes a dependency-complete skill/instruction pair linked to its agent',async t=>{
  const root=await fixture(t),rule=path.join(root,'INSTRUCTIONS.md'),skill=path.join(root,'SKILL.md');
  await writeFile(rule,'Keep every interactive control keyboard accessible.');await writeFile(skill,'Compare actual browser behavior against the supplied screenshot.');
  const capture=await inspectWorkflowAttachments({files:[rule,skill]}),example=await withWorkflowIntentCatalog(null,{source:'installed'},workflowIntentExample);
  const instruction=capture.items.find(item=>item.name.endsWith('/INSTRUCTIONS.md')),procedure=capture.items.find(item=>item.name.endsWith('/SKILL.md'));
  const source=example.source.replace('<agent id="demo-intent-tester" from="demo-instruction-tester" />','<agent id="demo-intent-tester" from="demo-instruction-tester"><skill ref="demo-intent-local-check"/></agent>')
    .replace('</workflow>',`<instruction id="demo-intent-local-rule" description="Keyboard access">${instruction.content}</instruction>
      <skill id="demo-intent-local-check" description="Screenshot checks">${procedure.content} Apply <instruction>demo-intent-local-rule</instruction> at the keyboard check.</skill>
      <attachment id="${instruction.id}" sha256="${instruction.sha256}" kind="instruction" maps-to="instruction:demo-intent-local-rule"/>
      <attachment id="${procedure.id}" sha256="${procedure.sha256}" kind="skill" maps-to="skill:demo-intent-local-check"/></workflow>`);
  const result=await compileWorkflowMarkup(source),store=new WorkflowAttachmentStore();await store.capture({run:async()=>capture},[rule,skill],false);store.verify(result.attachmentMappings);
  assert.ok(result.bundle.assets.some(item=>item.kind==='skill'&&item.id==='demo-intent-local-check'));
  assert.ok(result.bundle.assets.some(item=>item.kind==='instruction'&&item.id==='demo-intent-local-rule'));
  assert.ok(result.bundle.assets.some(item=>item.kind==='agent'&&item.id==='demo-intent-tester'));
  assert.match(await readFile(rule,'utf8'),/^Keep every/u);assert.equal(result.effects.configurationChanged,false);
});
test('CLI capture is model-free outside a repository and returns only the requested exact body',async t=>{
  const root=await fixture(t),file=path.join(root,'guide.md');await writeFile(file,'## Steps\nCheck behavior.');
  const cli=new URL('../bin/singularity-flow.mjs',import.meta.url);const result=spawnSync(process.execPath,[cli.pathname,'workflow','intent','attachments','--file',file,'--json'],{cwd:root,encoding:'utf8'});
  assert.equal(result.status,0,result.stderr||result.stdout);assert.equal(JSON.parse(result.stdout).items[0].classification.kind,'skill');assert.equal(await readFile(file,'utf8'),'## Steps\nCheck behavior.');
  assert.match(JSON.parse(result.stdout).readGuidance.command,/--id '<CAPTURE-ID>'/u);
});
test('long names yield portable source IDs and excluded captures require explicit removal before import',async t=>{
  const root=await fixture(t),file=path.join(root,'guidance-'.repeat(10)+'.md');await writeFile(file,'## Steps\nCheck the current revision.');
  const result=await inspectWorkflowAttachments({files:[file]});assert.ok(result.items[0].id.length<=64);assert.match(result.items[0].id,/^[a-z0-9]+(?:-[a-z0-9]+)*$/u);
  const store=new WorkflowAttachmentStore();await store.capture({run:async()=>({...result,items:[{...result.items[0],available:false,content:undefined}]})},[file],false);
  assert.throws(()=>store.verify([]),/Remove or replace/u);store.remove(result.items[0].id);store.verify([]);
});
test('native metadata contains no body or laptop path and fallback read guidance is shared per capture',async t=>{
  const root=await fixture(t),first=path.join(root,'one.instructions.md'),second=path.join(root,'two.instructions.md');
  await writeFile(first,'First private body.');await writeFile(second,'Second private body.');
  const capture=await inspectWorkflowAttachments({files:[first,second]}),store=new WorkflowAttachmentStore();
  const guidance={command:"singularity-flow workflow intent attachments --file 'explicit quoted selection' --id '<CAPTURE-ID>' --json"};
  await store.capture({run:async()=>({...capture,readGuidance:guidance})},[first,second],false);
  assert.ok(!JSON.stringify(store.prompt()).includes(root));assert.ok(!JSON.stringify(store.prompt()).includes('private body'));
  assert.equal(store.fallback().length,1);assert.deepEqual(store.fallback()[0].guidance,guidance);
  store.remove(store.list()[0].id);assert.equal(store.fallback().length,1);
  store.remove(store.list()[0].id);assert.deepEqual(store.fallback(),[]);
});
