import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { COMMAND_REGISTRY } from '../src/command-registry.mjs';
import {
  COMMAND_LINE_SKILL_ROUTES, COMMAND_SKILLS, primarySkillForCommand, renderCommandSkillTable,
  skillForCommandLine, skillsForCommand
} from '../src/command-skills.mjs';
import { loadHelpDocument } from '../src/help.mjs';
import {
  renderChangeDirectoryCommand, renderCommandPromptCommand, renderPlatformCommand,
  safeCommandGuidance
} from '../src/safe-command-guidance.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('every registered command maps to at least one packaged direct Copilot skill', async () => {
  const registered = COMMAND_REGISTRY.map((entry) => entry.name);
  assert.deepEqual(Object.keys(COMMAND_SKILLS).sort(), [...registered].sort());
  for (const command of registered) {
    const skills = skillsForCommand(command);
    assert.ok(skills.length > 0, `${command} has no Copilot route`);
    assert.equal(primarySkillForCommand(command), skills[0]);
    assert.equal(new Set(skills).size, skills.length, `${command} repeats a skill`);
    for (const skill of skills) {
      assert.match(skill, /^sf-[a-z0-9]+(?:-[a-z0-9]+)*$/);
      const file = path.join(root, 'plugin', 'skills', skill.replace(/^sf-/, 'sflow-'), 'SKILL.md');
      assert.equal(await stat(file).then(() => true).catch(() => false), true,
        `${command} maps to missing /${skill}`);
      const source = await readFile(file, 'utf8');
      assert.match(source, new RegExp(`^name: ${skill.replace(/^sf-/, 'sflow-')}$`, 'm'));
    }
  }
});

test('the Help Center crosswalk is generated from the checked catalog', async () => {
  const help = await loadHelpDocument('cli-to-copilot-skill-mapping');
  assert.match(help.content, /\| Terminal command \| Copilot skill \|/);
  assert.doesNotMatch(help.content, /command-skill-map/);
  for (const { name } of COMMAND_REGISTRY) {
    assert.ok(help.content.includes(`| \`singularity-flow ${name}\` |`), name);
    for (const skill of skillsForCommand(name)) assert.ok(help.content.includes(`\`/${skill}\``), skill);
  }
  assert.equal(renderCommandSkillTable().split('\n').length, COMMAND_REGISTRY.length + 2);
});

test('journey mappings keep low-level plumbing behind the guided skill', () => {
  assert.equal(primarySkillForCommand('intent'), 'sf-sgos');
  assert.ok(skillsForCommand('intent').includes('sf-sgos-create'));
  assert.equal(primarySkillForCommand('process'), 'sf-sgos');
  assert.equal(primarySkillForCommand('program'), 'sf-sgos');
  assert.equal(primarySkillForCommand('task'), 'sf-sgos');
  assert.equal(primarySkillForCommand('candidate'), 'sf-sgos');
  assert.equal(primarySkillForCommand('pack'), 'sf-sgos');
  assert.equal(primarySkillForCommand('learn'), 'sf-learn');
  assert.equal(primarySkillForCommand('workflow'), 'sf-workflows');
  assert.equal(primarySkillForCommand('auto'), 'sf-auto');
  assert.equal(primarySkillForCommand('prepare'), 'sf-phase');
  assert.ok(skillsForCommand('prepare').includes('sf-converge'));
  assert.equal(primarySkillForCommand('artifact'), 'sf-phase');
  assert.deepEqual(skillsForCommand('choices'), ['sf-start', 'sf-approve']);
  assert.equal(primarySkillForCommand('converge'), 'sf-converge');
  assert.equal(primarySkillForCommand('cockpit'), 'sf-home');
  assert.equal(primarySkillForCommand('explain'), 'sf-docs');
  assert.ok(skillsForCommand('explain').includes('sf-explain-code'));
  assert.equal(skillForCommandLine('singularity-flow explain approvals'), 'sf-docs');
  assert.equal(skillForCommandLine('singularity-flow explain code --since HEAD'), 'sf-explain-code');
});

test('every exact command-line route belongs to its family and names a packaged skill', async () => {
  for (const [command, route] of Object.entries(COMMAND_LINE_SKILL_ROUTES)) {
    const expected = [route.defaultSkill, ...Object.values(route.subcommands)].filter(Boolean);
    for (const skill of new Set(expected)) {
      assert.ok(skillsForCommand(command).includes(skill), `${command} omits exact route /${skill}`);
      const file = path.join(root, 'plugin', 'skills', skill.replace(/^sf-/, 'sflow-'), 'SKILL.md');
      assert.equal(await stat(file).then(() => true).catch(() => false), true,
        `${command} exact route maps to missing /${skill}`);
    }
    if (route.defaultSkill) {
      assert.equal(skillForCommandLine(`singularity-flow ${command}`), route.defaultSkill);
    }
    for (const [subcommand, skill] of Object.entries(route.subcommands)) {
      assert.equal(skillForCommandLine(`singularity-flow ${command} ${subcommand} trailing arguments`), skill);
    }
  }
});

test('every command family with several Copilot journeys has an explicit exact-route policy', () => {
  for (const [command, skills] of Object.entries(COMMAND_SKILLS)) {
    if (skills.length < 2) continue;
    assert.ok(COMMAND_LINE_SKILL_ROUTES[command],
      `${command} has several Copilot journeys but no exact-route policy`);
  }
});

test('the exact resolver accepts both executable names and never changes an SGOS family', () => {
  const families = [
    'intent', 'program', 'process', 'policy', 'task', 'request', 'evidence', 'candidate',
    'execution-unit', 'device', 'authority-store', 'pack', 'memory', 'meta-tool'
  ];
  for (const family of families) {
    assert.equal(skillForCommandLine(`singularity-flow ${family} status`), 'sf-sgos', family);
    assert.equal(skillForCommandLine(`sflow ${family} status`), 'sf-sgos', `sflow ${family}`);
  }
  assert.equal(skillForCommandLine('singularity-flow learn list'), 'sf-learn');
  assert.equal(skillForCommandLine('singularity-flow workflow list'), 'sf-workflows');
  assert.equal(skillForCommandLine('not-singularity-flow process status'), null);
  assert.equal(skillForCommandLine('singularity-flow not-a-command status'), null);
});

test('root help and version flags map to their real Copilot journeys', () => {
  assert.equal(skillForCommandLine('singularity-flow'), 'sf-help');
  assert.equal(skillForCommandLine('singularity-flow --help'), 'sf-help');
  assert.equal(skillForCommandLine('sflow -h'), 'sf-help');
  assert.equal(skillForCommandLine('singularity-flow --version'), 'sf-about');
  assert.equal(skillForCommandLine('sflow -v'), 'sf-about');
});

test('specialized workspace, choice, world-model, document and Story routes are exact', () => {
  const cases = new Map([
    ['singularity-flow workspace prepare https://example.test/repo.git --id demo', 'sf-workspace-bootstrap'],
    ['singularity-flow workspace bootstrap status bst_demo', 'sf-workspace-bootstrap'],
    ['singularity-flow workspace doctor --json', 'sf-workspace-bootstrap'],
    ['singularity-flow workspace reinitialize demo --dry-run --json', 'sf-admin'],
    ['singularity-flow workspace list --json', 'sf-workspaces'],
    ['singularity-flow workspace current --json', 'sf-workspaces'],
    ['singularity-flow workspace copilot demo', 'sf-workspace-session'],
    ['singularity-flow workspace impact list /tmp/demo --json', 'sf-workspace-impact'],
    ['singularity-flow choices begin start WRK-1 --json', 'sf-start'],
    ['singularity-flow choices begin approve WRK-1 --json', 'sf-approve'],
    ['singularity-flow wm show-prompt --phase intake', 'sf-show-prompt'],
    ['singularity-flow documents upload evidence.pdf', 'sf-upload'],
    ['singularity-flow documents add evidence.pdf', 'sf-upload'],
    ['singularity-flow story start WRK-1 --from-branch main', 'sf-story-start'],
    ['singularity-flow story inbox --assigned-to-me', 'sf-story-inbox'],
    ['singularity-flow story fetch WRK-1', 'sf-story-fetch'],
    ['singularity-flow story branch status --parent WRK-1', 'sf-story-branch'],
    ['singularity-flow story checks --parent WRK-1', 'sf-story-checks'],
    ['singularity-flow story interval reconcile --parent WRK-1', 'sf-work-interval'],
    ['singularity-flow story return WRK-1', 'sf-return'],
    ['singularity-flow story rework WRK-1', 'sf-reject'],
    ['singularity-flow story intent-amendment propose --file amended.md', 'sf-reject'],
    ['singularity-flow story adjudicate WRK-1 --disposition rework', 'sf-converge'],
    ['singularity-flow story converge --work-id WRK-1', 'sf-converge'],
    ['singularity-flow story submit', 'sf-submit'],
    ['singularity-flow story advance --work-id WRK-1', 'sf-submit'],
    ['singularity-flow story finalize --json', 'sf-finalize'],
    ['singularity-flow capability add search --owns src/search', 'sf-capability-add'],
    ['singularity-flow capability protect src/auth --approver security', 'sf-capability-protect'],
    ['singularity-flow capability depend payments@v1', 'sf-capability-depend'],
    ['singularity-flow capability leads --json', 'sf-capability-doctor'],
    ['singularity-flow capability fsck --lead https://example.test/platform.git --json', 'sf-capability-doctor'],
    ['singularity-flow capabilities doctor --json', 'sf-capability-doctor']
  ]);
  for (const [command, expected] of cases) {
    assert.equal(skillForCommandLine(command), expected, command);
  }
});

test('the SGOS relay preserves the selected CLI family and keeps adjacent journeys separate', async () => {
  const skill = await readFile(path.join(root, 'plugin', 'skills', 'sflow-sgos', 'SKILL.md'), 'utf8');
  assert.match(skill, /^name: sflow-sgos$/m);
  assert.match(skill, /disable-model-invocation:\s*true/);
  assert.match(skill, /Run `singularity-flow \$ARGUMENTS`/);
  assert.match(skill, /Never prepend `workflow`/);
  assert.match(skill, /\/sf-sgos-create/);
  assert.match(skill, /\/sf-learn/);
  assert.match(skill, /\/sf-workflows/);
  assert.doesNotMatch(skill, /Run `singularity-flow workflow \$ARGUMENTS`/);
});

test('safe guidance preserves Windows paths and marks incomplete ellipses display-only', () => {
  const windows = safeCommandGuidance('singularity-flow onboard C:\\work\\rule-engine');
  assert.ok(windows);
  assert.equal(windows.argv[1], 'C:\\work\\rule-engine');
  assert.match(windows.platformCommands.win32, /C:\\work\\rule-engine/);

  const quoted = safeCommandGuidance('singularity-flow onboard "C:\\Program Files\\rule-engine"');
  assert.ok(quoted);
  assert.equal(quoted.argv[1], 'C:\\Program Files\\rule-engine');

  const incomplete = safeCommandGuidance(
    'singularity-flow initiative outputs planning --include plan --reason "..."'
  );
  assert.ok(incomplete);
  assert.equal(incomplete.copyable, false);
  assert.equal(incomplete.platformCommands, null);
});

test('platform command rendering keeps substitutions, quotes, and spaces inside argv', () => {
  const adversarial = [
    '$(printf SUBSTITUTED)', '`printf BACKTICK`', "single'quote", 'two words', '"double"'
  ];
  const command = renderPlatformCommand([
    process.execPath, '-e', 'process.stdout.write(JSON.stringify(process.argv.slice(1)))',
    ...adversarial
  ], 'linux');
  const result = spawnSync('/bin/sh', ['-c', command], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), adversarial);

  const windows = renderPlatformCommand([
    'C:\\Program Files\\SFlow\\install.cmd', ...adversarial
  ], 'win32');
  assert.match(windows, /^& 'C:\\Program Files\\SFlow\\install\.cmd'/u);
  assert.match(windows, /'\$\(printf SUBSTITUTED\)'/u);
  assert.match(windows, /'single''quote'/u);
  const commandPrompt = renderCommandPromptCommand([
    'C:\\Program Files\\SFlow\\install.cmd', ...adversarial
  ]);
  assert.match(commandPrompt, /^powershell\.exe -NoLogo -NoProfile -NonInteractive -EncodedCommand [A-Za-z0-9+/]+=*$/u);
  const encoded = commandPrompt.split(' ').at(-1);
  assert.equal(Buffer.from(encoded, 'base64').toString('utf16le'), windows);
  assert.throws(() => renderPlatformCommand(['sf-install', 'line\nbreak']), /control characters/u);
  assert.throws(() => renderCommandPromptCommand(['sf-install', 'line\nbreak']), /control characters/u);
  assert.equal(
    renderChangeDirectoryCommand('/tmp/a path/$(not-run)', 'linux'),
    "'cd' '--' '/tmp/a path/$(not-run)'"
  );
  assert.equal(
    renderChangeDirectoryCommand('C:\\Work Folder\\Story', 'win32'),
    "& 'Set-Location' '-LiteralPath' 'C:\\Work Folder\\Story'"
  );
  assert.throws(() => renderChangeDirectoryCommand('line\nbreak'), /control characters/u);
});

test('a policy-selected custom code phase keeps the generic code-authoring Copilot route', () => {
  const guidance = safeCommandGuidance({
    command: 'singularity-flow phase publish build-api --authored governed-agent --channel copilot-host',
    skill: '/sflow-code'
  });
  assert.ok(guidance);
  assert.equal(guidance.skill, '/sf-code');
  assert.equal(guidance.copilotCommand, '/sf-code');
});

test('structured command argv is authoritative and disagreement fails closed', () => {
  const structured = safeCommandGuidance({
    executable: 'singularity-flow',
    argv: ['resume', 'WORK-123', '--fetch']
  });
  assert.ok(structured);
  assert.equal(structured.executable, 'singularity-flow');
  assert.deepEqual(structured.argv, ['resume', 'WORK-123', '--fetch']);
  assert.match(structured.command, /resume WORK-123 --fetch$/u);
  assert.equal(structured.copilotCommand, '/sf-resume');

  const matching = safeCommandGuidance({
    command: 'singularity-flow phase publish implementation --authored governed-agent --channel copilot-host',
    executable: 'singularity-flow',
    argv: ['phase', 'publish', 'implementation', '--authored', 'governed-agent', '--channel', 'copilot-host'],
    skill: '/sf-code'
  });
  assert.ok(matching);
  assert.equal(matching.argv.at(-1), 'copilot-host');
  assert.equal(matching.skill, '/sf-code');

  assert.equal(safeCommandGuidance({
    command: 'singularity-flow resume WORK-123 --fetch',
    executable: 'singularity-flow',
    argv: ['resume', 'WORK-123']
  }), null);
  assert.equal(safeCommandGuidance({
    executable: 'singularity-flow', argv: ['resume', 'WORK-123', '--token', 'secret']
  }), null);
});

test('full process argv recovery actions preserve exact POSIX and PowerShell arguments', () => {
  const argv = ['singularity-flow', 'workspace', 'reinitialize', "team's demo", '--dry-run', '--json'];
  const posix = safeCommandGuidance({
    argv,
    command: `singularity-flow workspace reinitialize 'team'"'"'s demo' --dry-run --json`,
    shell: 'posix',
    skill: '/sf-admin'
  });
  assert.ok(posix);
  assert.deepEqual(posix.argv, argv.slice(1));
  assert.equal(posix.copilotCommand, '/sf-admin');

  const powershell = safeCommandGuidance({
    argv,
    command: "singularity-flow workspace reinitialize 'team''s demo' --dry-run --json",
    shell: 'powershell',
    skill: '/sf-admin'
  });
  assert.ok(powershell);
  assert.deepEqual(powershell.argv, argv.slice(1));
  assert.equal(powershell.copilotCommand, '/sf-admin');
  assert.equal(safeCommandGuidance({
    ...powershell, shell: 'powershell',
    command: "singularity-flow workspace reinitialize 'different''s demo' --dry-run --json"
  }), null);
  assert.equal(safeCommandGuidance({
    argv, executable: 'sflow', shell: 'powershell',
    command: "singularity-flow workspace reinitialize 'team''s demo' --dry-run --json"
  }), null);
});

test('router and resolved phase actions cannot be presented as one equivalent pair', () => {
  const router = safeCommandGuidance('singularity-flow next');
  assert.ok(router);
  assert.equal(router.copilotCommand, '/sf-next');

  const phase = safeCommandGuidance('singularity-flow prepare planning');
  assert.ok(phase);
  assert.equal(phase.copilotCommand, '/sf-phase');

  assert.equal(safeCommandGuidance({
    command: 'singularity-flow next', skill: '/sf-phase'
  }), null);
  assert.equal(safeCommandGuidance({
    command: 'singularity-flow prepare planning', skill: '/sf-next'
  }), null);
});
