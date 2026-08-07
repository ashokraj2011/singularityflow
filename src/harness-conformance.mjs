export function questionPrecedesMutation(event) {
  const questions = new Map((event?.questions ?? []).map((item) => [item.questionId, item]));
  const actions = event?.actionsExecuted ?? [];
  if (!actions.length) return verdict('question-precedes-mutation', 'not-observed', ['No mutation action was observed.'], 0);
  const receipts = new Set();
  const missing = actions.filter((action) => {
    const question = questions.get(action.questionId);
    const reused = question?.answerReceipt && receipts.has(question.answerReceipt);
    if (question?.answerReceipt) receipts.add(question.answerReceipt);
    const expired = question?.expiresAt && Date.parse(question.expiresAt) <= Date.parse(event.startedAt);
    return !question?.answered
      || !action.answerReceipt
      || action.answerReceipt !== question.answerReceipt
      || !action.authorizationId
      || action.planId !== question.actionPlanId
      || action.actionId !== question.actionId
      || (question.consumedByInvocationId && question.consumedByInvocationId !== event.invocationId)
      || expired
      || reused;
  });
  return missing.length
    ? verdict('question-precedes-mutation', 'fail', [`${missing.length} mutation action(s) lack a matching answered question, receipt, and authorization.`], 1)
    : verdict('question-precedes-mutation', 'pass', ['Every mutation action is identifier-bound to an answered question and authorization.'], 1);
}

export function maximumActions(event, maximum = 1) {
  const succeeded = (event?.actionsExecuted ?? []).filter((item) => item.result === 'succeeded' && item.retryOf == null);
  if (!(event?.actionsExecuted ?? []).length) return verdict('maximum-actions', 'not-observed', ['No action execution evidence was observed.'], 0);
  return succeeded.length <= maximum
    ? verdict('maximum-actions', 'pass', [`${succeeded.length} successful action(s) observed; maximum ${maximum}.`], 1)
    : verdict('maximum-actions', 'fail', [`${succeeded.length} successful actions exceed maximum ${maximum}.`], 1);
}

function verdict(checkerId, result, reasons, coverage) {
  return { schemaVersion: 1, checkerId, checkerVersion: 1, coverage, verdict: result, reasons };
}

export function evaluateEngineConformance(event, { maximum = 1 } = {}) {
  return [questionPrecedesMutation(event), maximumActions(event, maximum)];
}
