import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const skill = name => readFile(new URL(`../plugin/skills/${name}/SKILL.md`, import.meta.url), 'utf8');

test('code author opens the exact generation before composition and verifies permission before native edits', async () => {
  const code = await skill('sflow-code');
  const begin = code.indexOf('singularity-flow phase begin <phase> --json');
  const compose = code.indexOf('rerun it once with `<phase> --work-id <WORK-ID> --compose`');
  const permission = code.indexOf('Source edits need `codeAuthoringReady: true`');
  const edit = code.indexOf('6. Native file-edit tool:');
  assert.ok(begin > 0 && begin < compose);
  assert.ok(permission > compose && permission < edit);
  assert.match(code, /binding is not source permission/);
  assert.match(code, /kernel-only `\/sf-next` cannot author/);
  assert.match(code, /adoption\/confirmation before edits\/composition; never auto-adopt/);
  assert.match(code, /Successful begin: refresh entry once/);
  assert.match(code, /Consumed intent requires `\/sf-recover`/);
  assert.match(code, /record before code mutation; refresh entry once/i);
  assert.match(code, /Remove staging only on success/);
  assert.match(code, /Stage JSON, never governed records/);
});

test('existing implementation is completed through summary, planned assertions and publication, not discarded or inferred complete', async () => {
  const code = await skill('sflow-code');
  assert.match(code, /Preserve code\/tests; prepare missing artifact via `authoringProgress`/);
  assert.match(code, /finish behavior\/tests\/artifact\/Agent brief and bindings/);
  assert.match(code, /Keep planned tests; assert behavior, never fake tags/);
  assert.match(code, /`argvWithheld: true` means configured, not missing/);
  // Development test runs are allowed while authoring (d6074584); they never replace publication's.
  assert.match(code, /Development tests allowed/);
  assert.match(code, /Publication still runs fresh governed tests; manual passes never advance/);
  assert.match(code, /commands\.publish` once when ready/);
  assert.match(code, /--publish-if-ready/);
  assert.match(code, /once when ready unless `publishIfReady\.published`/);
  assert.match(code, /Published: read `outcomeReview\.agentCommand` once/);
  assert.match(code, /ask `validation\.question`\/`choices` now/);
  assert.match(code, /sflowDeliveryValidation` or `ask_user/);
  assert.match(code, /Only the chosen route may run; no acceptance\/submission\/approval/);
  assert.match(code, /Missing capture: ask start\/setup\/upload/);
  assert.match(code, /`afterReview`=lifecycle/);
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
