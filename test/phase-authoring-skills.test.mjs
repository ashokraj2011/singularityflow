import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const skill = name => readFile(new URL(`../plugin/skills/${name}/SKILL.md`, import.meta.url), 'utf8');

test('code author opens the exact generation before composition and verifies permission before native edits', async () => {
  const code = await skill('sflow-code');
  const begin = code.indexOf('singularity-flow phase begin <phase> --json');
  const compose = code.indexOf('rerun it once with `<phase> --work-id <WORK-ID> --compose`');
  const permission = code.indexOf('Source edits require `codeAuthoringReady: true`');
  const edit = code.indexOf('6. Native file-edit tool:');
  assert.ok(begin > 0 && begin < compose);
  assert.ok(permission > compose && permission < edit);
  assert.match(code, /binding is not source permission/);
  assert.match(code, /kernel-only `\/sf-next` cannot inline authoring/);
  assert.match(code, /adoption\/confirmation before edits\/composition; never auto-adopt/);
  assert.match(code, /Successful begin: refresh entry once/);
  assert.match(code, /Consumed intent requires `\/sf-recover`/);
  assert.match(code, /record before code mutation; refresh entry once/i);
  assert.match(code, /Remove staging only on success/);
  assert.match(code, /Staging is JSON only, never handwritten governed records/);
});

test('existing implementation is completed through summary, planned assertions and publication, not discarded or inferred complete', async () => {
  const code = await skill('sflow-code');
  assert.match(code, /Preserve code\/tests; prepare missing artifact via `authoringProgress`/);
  assert.match(code, /Repair missing summary\/planned bindings in this draft/);
  assert.match(code, /finish behavior\/tests\/artifact\/Agent brief/);
  assert.match(code, /Planned test files cannot be replaced by utility tests/);
  assert.match(code, /verify assertions, never fabricate tags/);
  assert.match(code, /`argvWithheld: true` means configured, not missing/);
  assert.match(code, /Publication runs fresh tests, no pre-run/);
  assert.match(code, /commands\.publish` once when ready/);
  assert.match(code, /successful required tests continue publication/);
  assert.match(code, /Finish summary\/traceability\/prepublish\/publication/);
  assert.match(code, /Published: handoff, not \/sf-code again/);
  assert.match(code, /Never submit\/approve/);
});

test('document author and submitter preserve existing draft work and never equate preparation or manual tests with publication', async () => {
  const phase = await skill('sflow-phase');
  assert.match(phase, /unless prepared in step 2 or `authoringProgress\.draft\.draftExists`/);
  assert.match(phase, /Preparation is not authoring/);
  assert.match(phase, /finish artifact\/Agent brief\/TODOs/);
  const submit = await skill('sflow-submit');
  assert.match(submit, /Generation zero means unpublished, not missing code/);
  assert.match(submit, /authoringProgress\.stage/);
  assert.match(submit, /never redo existing code, infer publication from manual tests/);
  assert.match(submit, /use session UUID as WORK-ID or generate\/publish here/);
});
