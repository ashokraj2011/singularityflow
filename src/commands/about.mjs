import { ABOUT } from '../about.mjs';
import { aboutBuilds, aboutBuildsMarkdown } from '../about-builds.mjs';
import { optionBoolean, optionString, SingularityFlowError } from '../util.mjs';

export async function run(_argv, { positionals = ['about'], options = {} } = {}) {
  const allowed = new Set(['json', 'markdown', 'for-agent', 'extension-path', 'timings']);
  if (positionals.length > 1 || Object.keys(options).some(key => !allowed.has(key))) {
    throw new SingularityFlowError('Use about [--json | --markdown] [--extension-path DIRECTORY].');
  }
  if (optionBoolean(options, 'json') && optionBoolean(options, 'markdown')) {
    throw new SingularityFlowError('Choose --json or --markdown, not both.');
  }
  if (optionBoolean(options, 'for-agent') && !optionBoolean(options, 'json')) {
    throw new SingularityFlowError('about --for-agent requires --json.');
  }
  const report = await aboutBuilds({ extensionPath: optionString(options, 'extension-path') ?? null });
  const markdown = `${aboutBuildsMarkdown(report)}\n\n## About the product\n\n${ABOUT.split('\n').slice(2).join('\n')}`;
  console.log(optionBoolean(options, 'json') ? JSON.stringify({ ...report, markdown }, null, 2) : markdown);
  return report;
}
