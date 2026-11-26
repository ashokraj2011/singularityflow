import { DOCS_BOUNDARY, sectionOf } from '../docs-topics.mjs';
import { resolveHelp } from '../help-service.mjs';

/** A recognized help question is answered from the installed, stamp-verified guide. */
export async function readAskHelp(question, story) {
  const result = await resolveHelp(question, { maxBytes: 1400, requireFullQuestionMatch: true });
  if (result.status !== 'resolved') return null;
  const { id, title, version } = result.topic;
  const sources = [{ type: 'help', id, title, citation: 'Guide v' + version }];
  const preview = result.served.text.replace(DOCS_BOUNDARY, '').trim();
  let answer = preview;
  if (id === 'starting-work') {
    answer = sectionOf(preview, 'Start a Story') ?? preview;
    if (story?.storyStatus === 'closed') answer = 'The selected Story is closed.\n\n' + answer;
    else if (story?.phase) answer = 'The selected Story has already started. To continue it, open the Story in Copilot and run `/sf-next`.\n\n' + answer;
    sources.unshift({ type: 'page', id: 'stories', title: 'Browse Stories' });
  }
  return { kind: 'chat', status: 'resolved', question, answeredBy: 'help', answer, sources };
}
