/**
 * Where a person takes each of their own steps (person-step-catalog.mjs OWN_TERMINAL_STEPS, which every chat turn refuses), and
 * why the few left in their own terminal stay there [owner, 2026-11-28: "terminal-only steps move to the card"; "no one should
 * get stuck, and every decision should be easy for people to understand why"]. A chat never runs these; it opens the card or
 * page (/sf-decide opens the Decide card), or names the terminal line.
 *
 *   card      the Decide card records it, or runs its row's step on "Do this now" (decide-card.ts); /sf-decide opens the card
 *   page      a VS Code page takes it with one press; `page` is its command (apps/vscode/package.json)
 *   terminal  only the person's own terminal takes it today; `why` says so in one plain line, and `kept` says whether that is
 *             for good (a secret, a key, someone else's word, the owner's 2026-11-19 list) or only until a screen has a row for it
 *
 * Pure data, read by test/person-step-routes.test.mjs, which keeps it complete and true against the catalog, the card's routes
 * and the extension's commands. Nothing on a hook loads it.
 */
const card = (why) => Object.freeze({ where: 'card', why });
const page = (command, why) => Object.freeze({ where: 'page', page: command, why });
const terminal = (kept, why) => Object.freeze({ where: 'terminal', kept, why });

export const OWN_STEP_ROUTES = Object.freeze({
  witness: page('singularityFlow.reviewWitness', 'You sign off evidence after looking at it: the review page shows the file, and the card opens it.'),
  'adjudication-answers': page('singularityFlow.adjudicate', 'Each convergence answer is yours: the Adjudicate page records them all at once.'),
  'adjudication-table': page('singularityFlow.adjudicate', 'The same table, a row at a time: the Adjudicate page answers every row.'),
  risk: card('Accepting an evidence gap as a dated risk is a choice on its row, with your date and reason.'),
  'witness-exception-renewal': card('A witness exception whose date passed has its own row: renew it with a date and your reason.'),
  'witness-deferral': terminal('until-row', 'Handing a sign-off to a later step is offered only where the approval is refused, not yet as a row.'),
  'visual-risk': terminal('until-row', 'Accepting a failed screen comparison is offered only by the Story\'s final check, not yet as a row.'),
  'visual-screenshot': card('The card\'s Take the screenshot opens SFlow\'s browser for you to capture the screen.'),
  'test-run-risk': card('Test-run, narrowing, reuse and screen-size choices are rows it records; a finding\'s risk runs on Do this now.'),
  'test-command-decision': card('Accepting a test command is a choice on its row; revoking one stays a terminal step until it has a row.'),
  'decision-list-record': card('The card is this list: one press records what its rows show.'),
  'set-aside': terminal('until-row', 'Leaving a change out shows what it sets aside first, then asks you; that preview has no row yet.'),
  'refactor-behaviour': card('Keeping or accepting what a refactor changed is a choice on its row.'),
  'publication-set-aside': terminal('for-good', 'Setting a published commit aside changes the shared branch for everyone; rare and severe (owner, 2026-11-19).'),
  'workflow-delete': page('singularityFlow.openWorkflowStudio', 'Deleting a workflow is Workflow Studio\'s, which shows what goes and keeps a copy.'),
  'test-run-set-aside': terminal('for-good', 'Only you can check that the process holding a test run is really gone.'),
  'target-origin-pin': terminal('until-row', 'Pinning the web address the Story\'s checks trust has no screen yet.'),
  'intent-amendment-decision': card('Approving or rejecting an intent amendment is a choice on its row, recorded on its own.'),
  'knowledge-confirmation': page('singularityFlow.reviewRepositoryKnowledge', 'Confirming what SFlow learnt about the repository is the Review Repository Knowledge page\'s.'),
  'spec-drift-decision': terminal('until-row', 'Deciding a specification\'s drift has no screen yet.'),
  'spec-library-decision': page('singularityFlow.openSpecStudio', 'Taking proposals, settling and publishing a specification is Spec Studio\'s.'),
  'person-specification-view': page('singularityFlow.openSpecStudio', 'Values that look like secrets are shown only on your own Spec Studio page.'),
  'product-update': page('singularityFlow.updateSflow', 'Updating SFlow is its own command, which runs the updater for you.'),
  'browser-workspace': page('singularityFlow.openBrowserWorkspace', 'Your browser access is yours: Open SFlow in browser starts it.'),
  'spec-slice-change': terminal('until-row', 'Dropping a clause from a Story\'s specification has no screen yet.'),
  'spec-split-publication': page('singularityFlow.openSpecStudio', 'Publishing a split is Spec Studio\'s, which shows every child it creates.'),
  'clarification-answer': terminal('for-good', 'Another approver answers from their own clone, under their own name (owner, 2026-11-19).'),
  'live-terminal-review': terminal('for-good', 'Its command shows you its exact card and asks you in your own terminal (owner, 2026-11-19).'),
  'approval-evidence-confirmation': page('singularityFlow.openApprovals', 'The approval page signs off each file with the approval, one press each.'),
  'upstream-amendment-decision': card('Approving or rejecting a forward amendment is a choice on its row.'),
  'environment-binding': terminal('for-good', 'Secret values come only from your own input, never from a screen or a chat.'),
  'apm-install': terminal('for-good', 'It changes which agents run in this repository; the Agent Packages page types it in for you (owner, 2026-11-19).'),
  'apm-organisation': page('singularityFlow.openApmPackages', 'Publishing is the Agent Packages page\'s; the marketplace and its policy stay terminal steps.'),
  'lock-release': terminal('for-good', 'Only you can check that the process holding the lock is really gone.'),
  'configuration-approve': page('singularityFlow.openConfigurationCenter', 'Approving configuration is the Configuration Center\'s, which shows the change.'),
  'workflow-activate': page('singularityFlow.openWorkflowStudio', 'Activating a workflow is the same decision: Workflow Studio\'s Review and activate.'),
  'sf-guard-person-step': terminal('for-good', 'SF Guard\'s key steps take your Touch ID, which only your own terminal can ask for.')
});
