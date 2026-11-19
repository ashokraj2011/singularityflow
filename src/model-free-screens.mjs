/**
 * The VS Code screen that runs a person's own command with no chat model, on the window's Story; the screen asks for the
 * rest itself [audit 2026-11-19, entry 4]. model-free-commands.mjs loads this only for the words it maps.
 * Each row: [Command Palette title, words, verbs it takes, flags it does not take, the only flags it takes].
 */
const OWN = /^--(?:story|repository)$/u;
const SCREENS = [['Approvals, then Request changes…', 'reject', 0, /^--(?:clause|repair|yes)$/u], ['Request Changes to a Closed Story', 'reopen'],
  ['Cancel and Archive Story', 'cancel', 0, /^--release$/u], ['Start Work', 'start', /^\w[\w.-]*$/u, 0, /^--(?:from-branch|title|description|fetch|spec|work-type|jira|github|json)$/u],
  ['Attach Copilot Session to Workspace', 'session workspace', 0, OWN], ['Work in This Workspace', 'workspace use', 0, OWN],
  ['Configuration Approvals', 'configuration', /^(?:approve|reject)$/u, /^--(?:pick|lead)$/u],
  ['Review Story Test Policy and Recovery', 'story test-policy', /^(?:show|amend|attest|risks|(?:accept|revoke|attest)-risk)$/u],
  ['Resolve Phase Issues and Appeals', 'appeal', /^(?:preflight|resolve(?:-resume|-run)?|checkpoint|risk-(?:prepare|accept)|repair-(?:plan|run|resume)|list|show|attest|decide)$/u,
    /^--(?:evidence-file|clause|transition)$/u]];
export function vscodeScreenForArgv(tokens) {
  for (const [title, words, verb, refused, only] of SCREENS) {
    const head = words.split(' ');
    if (head.some((word, index) => tokens[index] !== word) || (verb && !verb.test(tokens[head.length] ?? ''))) continue;
    const flags = tokens.filter((value) => value.startsWith('--'));
    return flags.some((flag) => (refused && refused.test(flag)) || (only && !only.test(flag))) ? null : `Command Palette: Singularity Flow: ${title}`;
  }
  return null;
}
