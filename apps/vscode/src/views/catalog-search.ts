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

export function workflowFavourites(value: unknown): string[] {
  return Array.isArray(value) ? [...new Set(value.filter((id): id is string =>
    typeof id === 'string' && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(id) && id.length <= 128))].slice(0, 200) : [];
}
