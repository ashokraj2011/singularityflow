import { developerHome } from '../developer-home.mjs';
import { optionBoolean, optionString } from '../util.mjs';

function render(result) {
  console.log(`Singularity Flow home — ${result.context.workspace.name}`);
  console.log(`Actor: ${result.actor.name}${result.actor.email ? ` <${result.actor.email}>` : ''}`);
  console.log(`Repository: ${result.context.repository.repositoryId} · ${result.context.repository.branch} @ ${(result.context.repository.head ?? 'unavailable').slice(0, 12)}`);
  console.log(`Freshness: ${result.context.freshness.capturedAt} · local only`);
  console.log(`\n${result.briefing.headline}`);
  console.log('\nWhat is on your mind today?');
  result.choices.forEach((choice, index) => console.log(`${index + 1}. ${choice.label} — ${choice.detail}`));
  if (result.notices.length) console.log(`\nNotices:\n- ${result.notices.join('\n- ')}`);
}

export async function run(_argv, { options }) {
  const result = await developerHome({
    workspaceReference: optionString(options, 'workspace'),
    hostSession: optionString(options, 'host-session')
  });
  if (optionBoolean(options, 'json')) return console.log(JSON.stringify(result, null, 2));
  render(result);
}
