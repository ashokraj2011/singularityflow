/**
 * Who changed a file outside the plan, in the words every place shows it [WCB:REQ-014]: the code approval
 * (decision-list.mjs), its focus page (approval-focus.mjs), the change story page's section 6 (change-story-page.mjs) and
 * the settlement itself (code-outside-plan.mjs). No imports: the readers load it where they show the files.
 *
 *   "by Copilot: <reason>"     its recorded write; ", through a terminal command" when that is what SFlow's hooks saw
 *   "by you"                   anything else; with why no hook could tell, for a folder VS Code opened through a link
 *   "from main, merged in: …"  a file that holds what the base branch has: not changed in this Story
 *
 * A supporting change adds ", as a supporting change"; Copilot owes no reason for one [owner, 2026-11-28].
 */
export function outsidePlanWho({ writer, reason = null, basis = null, branch = null, supporting = null } = {}) {
  if (writer === 'base') return `from ${branch ?? 'the base branch'}, merged in: not changed in this Story`;
  const as = supporting ? ', as a supporting change' : '';
  if (writer === 'copilot') {
    const how = basis === 'shell-write' || basis === 'shell-call' ? ', through a terminal command' : '';
    return `by Copilot${how}${reason ? `: ${reason}` : supporting ? '' : ': no reason written'}${as}`;
  }
  return `by you${basis === 'linked-folder' ? ' (no SFlow hooks ran here: VS Code opened this folder through a link)' : ''}${as}`;
}
