/**
 * Read-only helpers over rendered Change Explorer HTML. They parse only the attributes and blocks
 * the renderer itself emits, so an assertion fails loudly if the page shape changes.
 */
import { changeExplorerBody, visibleText } from '../../apps/vscode/src/views/change-explorer.ts';
import { escape as escapeHtml } from '../../apps/vscode/src/views/webview.ts';

export function decodeAttribute(value) {
  return value.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}

/** The first value of a data attribute, decoded. */
export function attribute(html, name) {
  const match = new RegExp(`${name}="([^"]*)"`, 'u').exec(html);
  return match ? decodeAttribute(match[1]) : null;
}

/** What the page shows for a text value: visible-inert, then HTML-escaped. */
export function shown(value) {
  return escapeHtml(visibleText(value));
}

export function renderExplorer(view, {
  patch = null, patchFiles = [], timeline = null, audience = 'reviewer', newerSnapshot = false,
  token = 'fixture-nonce', unavailableReason = null, focus = null
} = {}) {
  return changeExplorerBody({ view, unavailableReason, patch, patchFiles, timeline, audience, newerSnapshot, token, focus });
}

/** The map block: columns, clusters and the edge list, without the rail or inspector. */
export function mapBlock(html) {
  const start = html.indexOf('<div class="xpl-map"');
  const end = html.indexOf('id="xpl-edge-note"');
  if (start < 0 || end < 0) throw new Error('The rendered page has no change map.');
  return html.slice(start, end);
}

/** Every node button in a block, in document order. */
export function nodeButtons(block) {
  return [...block.matchAll(/<button type="button" class="xpl-node([^"]*)" id="([^"]+)" data-node="([^"]+)" data-column="([^"]+)" data-index="(\d+)"/gu)]
    .map((match) => ({ classes: match[1], domId: match[2], node: decodeAttribute(match[3]), column: match[4], index: Number(match[5]) }));
}

/** Remove every <details> cluster so only the initially visible nodes remain. */
export function withoutClusters(block) {
  return block.replace(/<details class="xpl-cluster">[\s\S]*?<\/details>/gu, '');
}

/** The inspector pane for one node, or null. */
export function pane(html, nodeId) {
  const marker = `<section class="xpl-pane" data-pane="${shown(nodeId)}" hidden>`;
  const start = html.indexOf(marker);
  if (start < 0) return null;
  return html.slice(start, html.indexOf('</section>', start));
}

/** Rows of the Relationships table body. */
export function relationshipRows(html) {
  const start = html.indexOf('<caption>Every relationship in the computed view');
  if (start < 0) return [];
  const body = html.slice(start, html.indexOf('</tbody>', start));
  return [...body.matchAll(/<tr><td><button type="button" class="link" data-node="([^"]+)">[\s\S]*?<\/td><td>([^<\s]+)[\s\S]*?<td><button type="button" class="link" data-node="([^"]+)">/gu)]
    .map((match) => ({ from: decodeAttribute(match[1]), type: match[2], to: decodeAttribute(match[3]) }));
}
