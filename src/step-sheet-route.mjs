/**
 * How the step sheet's next step reads as a route, for the surfaces that give one: nextsteps, the
 * approval packet and `act`. A leaf, so they read a sheet they were handed without loading it.
 */

/** A blank in a sheet's command as a person reads it in a command they will type. */
export const shownCommand = (command) => String(command).replace(/\{([a-z0-9-]+)\}/gu, '<$1>');

/** What stands between the person and recording: an answer the form takes, or a signature in their terminal, is part of approving. */
export const blockingHolds = (sheet) => (sheet?.holds ?? []).filter((hold) => hold.clearedBy?.kind !== 'viewer-form' && hold.code !== 'PSS_CARD_NOT_SHOWN');

const sentence = (text) => String(text ?? '').replace(/[.:\s]+$/u, '');

/** A sheet as an agent shows it: who clears each hold, and what comes next. The options stay on the list. */
export function sheetForAgent(sheet) {
  return { step: sheet.step?.id ?? null, holds: blockingHolds(sheet).map((hold) => ({ code: hold.code, title: hold.title, who: hold.clearedBy?.words ?? '' })),
    approval: { needed: sheet.approval?.needed ?? null, recorded: sheet.approval?.recorded?.length ?? 0, mayApproveNow: sheet.approval?.mayApproveNow === true },
    ...(sheet.waitingFor ? { waitingFor: sheet.waitingFor.words, share: sheet.waitingFor.share ?? null } : {}),
    owedLater: (sheet.owedLater ?? []).map((hold) => hold.title) };
}

/**
 * The sheet's one next step as `{ command, skill, copilotCommand, label, reason }`, or null when it
 * has none. `skill` is null where no turn takes it: the person's own terminal.
 */
export function sheetRoute(sheet) {
  const next = sheet?.next;
  if (!next?.command) return null;
  const blocking = blockingHolds(sheet);
  const [first] = blocking;
  const lead = first ? `${blocking.length > 1 ? `${blocking.length} holds on this approval; first: ` : ''}${sentence(first.title)}. ` : '';
  const copilotCommand = next.where?.copilot ?? null;
  return { command: shownCommand(next.command), skill: copilotCommand?.split(' ')[0] ?? null, copilotCommand, label: next.label,
    reason: `${lead}${sheet.waitingFor?.words ?? first?.clearedBy?.words ?? ''}`.trim() || next.label };
}
