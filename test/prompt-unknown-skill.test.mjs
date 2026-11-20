/**
 * A typed `/sf-<word>` no SFlow skill has is said back to the person with the nearest names, never run as a turn under the
 * typo's name [owner, 2026-11-20, VS Code, hardening C]: `/sf-mext` (for /sf-next) started a read turn, "SFlow turn
 * boundary (sf-mext)", and the model went to the gateway, whose answer then refused for its size.
 */
import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { explicitSflowSkill, unknownSkillReason } from '../src/copilot-repository-boundary.mjs';
import { copilotTurn, journeyRepository } from './helpers/route-follower.mjs';

// Nothing here reads the person's own home: every case names the folders it reads.
const NOWHERE = { cwd: os.tmpdir(), env: {}, homeDirectory: path.join(os.tmpdir(), 'sflow-no-home-at-all') };
const reason = (prompt, options = NOWHERE) => unknownSkillReason(prompt, explicitSflowSkill(prompt), options);
const skillAt = async (folder, name, declared = name) => {
  await mkdir(path.join(folder, name), { recursive: true });
  await writeFile(path.join(folder, name, 'SKILL.md'), `---\nname: ${declared}\ndescription: A team skill.\n---\n# ${declared}\n`);
};

test('an unknown /sf- word names the nearest skills; a known one, an alias and a host-expanded skill are turns as before', () => {
  assert.equal(reason('/sf-mext'), 'No SFlow command /sf-mext. Did you mean /sf-next? Type it again with the right name; nothing was run.');
  assert.equal(reason('/sf-aprove planning'), 'No SFlow command /sf-aprove. Did you mean /sf-approve? Type it again with the right name; nothing was run.');
  assert.equal(reason('/sf-zzzzqq'), 'No SFlow command /sf-zzzzqq. /sf-help lists them. Type it again with the right name; nothing was run.');
  for (const prompt of ['/sf-next', '/sf-next W-1', '/sflow-code', '/sf-decide W-1', '<skill-context name="sf-mext">x</skill-context>', 'plain words /sf-mext']) {
    assert.equal(reason(prompt), null, prompt);
  }
});

test('when the installed skills cannot be listed, nothing is refused', async (t) => {
  const empty = await mkdtemp(path.join(os.tmpdir(), 'sflow-no-skills-'));
  t.after(() => rm(empty, { recursive: true, force: true }));
  assert.equal(unknownSkillReason('/sf-mext', 'sf-mext', { ...NOWHERE, skillsRoot: path.join(empty, 'missing') }), null);
  await mkdir(path.join(empty, 'skills'));
  assert.equal(unknownSkillReason('/sf-mext', 'sf-mext', { ...NOWHERE, skillsRoot: path.join(empty, 'skills') }), null);
});

test('a skill that exists anywhere Copilot loads one from is never held: the repository\'s, the person\'s, a plugin\'s', async (t) => {
  // [coordinator, 2026-11-20] The hold must never block a skill that exists.
  const base = await mkdtemp(path.join(os.tmpdir(), 'sflow-skill-places-'));
  t.after(async () => { await chmod(path.join(base, 'repository', '.othertool', 'skills'), 0o700).catch(() => {}); await rm(base, { recursive: true, force: true }); });
  const repository = path.join(base, 'repository');
  const home = path.join(base, 'home');
  await mkdir(path.join(repository, '.git'), { recursive: true });
  await mkdir(path.join(repository, 'src', 'deep'), { recursive: true });
  const at = { cwd: path.join(repository, 'src', 'deep'), env: {}, homeDirectory: home };
  assert.match(reason('/sf-team-thing', at), /^No SFlow command \/sf-team-thing\./u, 'held while it is nowhere');
  // The repository's own skill, found from a folder inside it.
  await skillAt(path.join(repository, '.github', 'skills'), 'sf-team-thing');
  assert.equal(reason('/sf-team-thing', at), null);
  assert.equal(reason('/sf-team-thing do it', at), null);
  // Its agents, prompt files and a skill whose SKILL.md names it otherwise.
  await mkdir(path.join(repository, 'singularity', 'agents'), { recursive: true });
  await writeFile(path.join(repository, 'singularity', 'agents', 'sf-team-agent.agent.md'), '# agent\n');
  await mkdir(path.join(repository, '.github', 'prompts'), { recursive: true });
  await writeFile(path.join(repository, '.github', 'prompts', 'sf-team-prompt.prompt.md'), '# prompt\n');
  await skillAt(path.join(repository, 'skills'), 'team-folder', 'sf-team-named');
  for (const name of ['sf-team-agent', 'sf-team-prompt', 'sf-team-named']) assert.equal(reason(`/${name}`, at), null, name);
  // The person's own skills (Copilot's skills folder, where SFlow's /sf- aliases are written), and a plugin's.
  await skillAt(path.join(home, '.copilot', 'skills'), 'sf-personal-thing');
  await skillAt(path.join(home, '.copilot', 'installed-plugins', 'market', 'team-plugin', 'skills'), 'sflow-plugin-thing');
  await skillAt(path.join(home, '.othertool', 'skills'), 'sf-other-tool-thing');
  for (const name of ['sf-personal-thing', 'sf-plugin-thing', 'sf-other-tool-thing']) assert.equal(reason(`/${name}`, at), null, name);
  const moved = path.join(base, 'copilot-home');
  await skillAt(path.join(moved, 'skills'), 'sf-moved-thing');
  assert.equal(reason('/sf-moved-thing', { ...at, env: { COPILOT_HOME: moved } }), null, 'COPILOT_HOME moves the person\'s skills');
  // Still a typo of SFlow's own, after all of them were read.
  assert.equal(reason('/sf-mext', at), 'No SFlow command /sf-mext. Did you mean /sf-next? Type it again with the right name; nothing was run.');
  // A place that is there but cannot be read: nothing is held.
  if (process.platform !== 'win32' && process.getuid?.() !== 0) {
    await mkdir(path.join(repository, '.othertool', 'skills'), { recursive: true });
    await chmod(path.join(repository, '.othertool', 'skills'), 0o000);
    assert.equal(reason('/sf-mext', at), null, 'fails open');
  }
});

test('a person\'s own VS Code prompt files are never held: each editor\'s User/prompts on every platform, and the folders its settings add', async (t) => {
  // [coordinator, 2026-11-20] VS Code keeps them in its User folder's `prompts`; settings.json may add chat.promptFilesLocations.
  const base = await mkdtemp(path.join(os.tmpdir(), 'sflow-editor-prompts-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const repository = path.join(base, 'repository');
  await mkdir(path.join(repository, '.git'), { recursive: true });
  const prompt = async (folder, name) => { await mkdir(folder, { recursive: true }); await writeFile(path.join(folder, `${name}.prompt.md`), '# prompt\n'); };
  const users = {
    darwin: (home, product) => path.join(home, 'Library', 'Application Support', product, 'User'),
    linux: (home, product) => path.join(home, '.config', product, 'User'),
    win32: (home, product) => path.join(home, 'AppData', 'Roaming', product, 'User')
  };
  for (const [platform, user] of Object.entries(users)) {
    for (const product of ['Code', 'Code - Insiders', 'VSCodium']) {
      const home = path.join(base, `${platform}-${product.replaceAll(' ', '')}`);
      const at = { cwd: repository, env: {}, homeDirectory: home, platform };
      assert.match(reason('/sf-my-prompt', at), /^No SFlow command \/sf-my-prompt\./u, `${platform} ${product}: held while it is nowhere`);
      await prompt(path.join(user(home, product), 'prompts'), 'sf-my-prompt');
      assert.equal(reason('/sf-my-prompt', at), null, `${platform} ${product}`);
    }
  }
  // Where Windows and Linux say the folder is: %APPDATA% and $XDG_CONFIG_HOME.
  await prompt(path.join(base, 'appdata', 'Code', 'User', 'prompts'), 'sf-appdata-prompt');
  assert.equal(reason('/sf-appdata-prompt', { cwd: repository, env: { APPDATA: path.join(base, 'appdata') }, homeDirectory: path.join(base, 'nobody'), platform: 'win32' }), null);
  await prompt(path.join(base, 'xdg', 'Code', 'User', 'prompts'), 'sf-xdg-prompt');
  assert.equal(reason('/sf-xdg-prompt', { cwd: repository, env: { XDG_CONFIG_HOME: path.join(base, 'xdg') }, homeDirectory: path.join(base, 'nobody'), platform: 'linux' }), null);
  // chat.promptFilesLocations, as VS Code's settings.json writes it (comments and a trailing comma): a workspace-relative
  // folder and one in the person's home; a location switched off is not read.
  const home = path.join(base, 'settings-home');
  const user = users.linux(home, 'Code');
  await mkdir(user, { recursive: true });
  await writeFile(path.join(user, 'settings.json'), ['{', '  // the team keeps its prompts here', '  "chat.promptFilesLocations": {',
    '    "team-prompts": true,', '    "~/my-prompts": true,', '    "switched-off": false,', '  },', '}', ''].join('\n'));
  await prompt(path.join(repository, 'team-prompts'), 'sf-team-prompt');
  await prompt(path.join(home, 'my-prompts'), 'sf-home-prompt');
  await prompt(path.join(repository, 'switched-off'), 'sf-off-prompt');
  const at = { cwd: repository, env: {}, homeDirectory: home, platform: 'linux' };
  assert.equal(reason('/sf-team-prompt', at), null);
  assert.equal(reason('/sf-home-prompt', at), null);
  assert.match(reason('/sf-off-prompt', at), /^No SFlow command \/sf-off-prompt\./u);
  // A settings file that does not parse holds nothing.
  await writeFile(path.join(user, 'settings.json'), '{ "chat.promptFilesLocations": { "team-prompts": true ');
  assert.equal(reason('/sf-mext', at), null, 'fails open');
});

test('through the real prompt hook: /sf-mext is held with the nearest name and starts no turn; /sf-next and a team\'s /sf-team-thing start their turns', { timeout: 300_000 }, async (t) => {
  const story = await journeyRepository(t);
  await story.write('.github/skills/sf-team-thing/SKILL.md', '---\nname: sf-team-thing\ndescription: A team skill.\n---\n# Team thing\n');
  for (const host of ['copilot-cli', 'vscode']) {
    const turn = copilotTurn(story, `unknown-skill-${host}`, { host });
    const held = turn.prompt('/sf-mext');
    assert.equal(held.decision, 'block', JSON.stringify(held));
    assert.equal(held.reason, 'No SFlow command /sf-mext. Did you mean /sf-next? Type it again with the right name; nothing was run.');
    assert.doesNotMatch(JSON.stringify(held), /SFlow turn boundary \(sf-mext\)/u);
    const next = turn.prompt('/sf-next');
    assert.notEqual(next.decision, 'block', JSON.stringify(next));
    const team = turn.prompt('/sf-team-thing');
    assert.notEqual(team.decision, 'block', JSON.stringify(team));
    assert.doesNotMatch(JSON.stringify(team), /No SFlow command/u);
  }
});
