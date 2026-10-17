/** Local, literal catalog search shared by the intake and Studio webviews. */
export const CATALOG_SEARCH_SCRIPT = String.raw`
  function catalogText(value) {
    return String(value == null ? '' : value).normalize('NFC').toLowerCase();
  }
  function catalogMatches(query, values) {
    var text = catalogText(values.join(' '));
    return catalogText(query).trim().split(/\s+/).filter(Boolean).every(function (term) {
      return text.indexOf(term) >= 0;
    });
  }
`;

/** Stored locally in VS Code, never in a workflow definition or Story start request. */
export const WORKFLOW_FAVOURITES_KEY = 'singularityFlow.intake.workflowFavourites.v1';

/** Per repository: whether the Start form lists the demo, benchmark and POC workflows `init` seeds. */
export const SAMPLE_WORKFLOWS_KEY = 'singularityFlow.intake.sampleWorkflows.v1';

/**
 * The workflows `init` seeds into every repository for demos, benchmarks and proofs of concept.
 * Exact packaged IDs, so a team's own workflow is never hidden for the way it is named.
 */
export const SAMPLE_STORY_WORKFLOWS: ReadonlySet<string> = new Set([
  'demo-web-e2e-testing', 'demo-check-repair-close', 'demo-instruction-test-loop',
  'poc-lite', 'poc-workflow', 'benchmarking-a', 'benchmarking-b'
]);

export function workflowFavourites(value: unknown): string[] {
  return Array.isArray(value) ? [...new Set(value.filter((id): id is string =>
    typeof id === 'string' && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(id) && id.length <= 128))].slice(0, 200) : [];
}
