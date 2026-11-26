/**
 * Who owns a marketplace item [OMK:REQ-001, docs/SPEC-OMK-ORG-MARKETPLACE-v1.md §4.1]: the team its feedback goes to,
 * shown everywhere the item is.
 *
 * An item's `owner:` block in its apm.yml (an index entry's `owner`) names its team, the name people see, its code-owner
 * handle, a contact, where its issues go and the labels feedback carries. With no block, the owner is the first of: the
 * code owners of the item's folder (codeowners.mjs), its `maintainer-email`, the marketplace's own owner. The item says
 * which: "Owner: Web QA", or "Owner: maintainers@example.test (from maintainer-email)". An `issues` address that is not
 * https is dropped, and the item carries a `marketplace-metadata` finding. Pure.
 */
import { amongOwners } from './codeowners.mjs';

const ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const HTTPS = /^https:\/\/[^\s/@?#]+(?::\d+)?(?:\/[^\s]*)?$/u;
const LABEL = /^[\w .:/-]{1,50}$/u;
const FROM_WORDS = Object.freeze({ codeowners: 'CODEOWNERS', 'maintainer-email': 'maintainer-email', marketplace: "the marketplace's owner" });

const text = (value, max) => {
  if (value == null || typeof value === 'object') return null;
  const result = String(value).replace(/\s+/gu, ' ').trim();
  return result ? result.slice(0, max) : null;
};

/**
 * An `owner:` block as data: `{ owner, findings }`, `owner` `{ team, name, handle, contact, issues, feedbackLabels }` or
 * null. `camel` reads an index's keys (feedbackLabels). Nothing in it refuses the item: a bad value is left out, with a
 * marketplace-owned finding when feedback would go astray.
 */
export function parseOwnerBlock(value, { name = 'the item', camel = false } = {}) {
  if (value == null) return { owner: null, findings: [] };
  const findings = [];
  const where = `${name}'s owner`;
  if (typeof value !== 'object' || Array.isArray(value)) {
    return { owner: null, findings: [{ class: 'marketplace-metadata', owner: 'marketplace', item: name, words: `${where} is not a mapping, so it is not read.`,
      fix: `Write ${name}'s owner as a mapping with team, name, handle, contact and issues.` }] };
  }
  const team = text(value.team, 64);
  const issues = text(value.issues, 500);
  if (issues && !HTTPS.test(issues)) {
    findings.push({ class: 'marketplace-metadata', owner: 'marketplace', item: name, words: `${where} gives issues as '${issues.slice(0, 80)}', which is not an https address, so feedback does not go there.`,
      fix: `Give ${name}'s owner.issues the https address of the team's issues page.` });
  }
  const labels = camel ? value.feedbackLabels ?? value['feedback-labels'] : value['feedback-labels'] ?? value.feedbackLabels;
  const owner = {
    team: team && ID.test(team) ? team : null,
    name: text(value.name, 120), handle: text(value.handle, 200), contact: text(value.contact, 200),
    issues: issues && HTTPS.test(issues) ? issues : null,
    feedbackLabels: (Array.isArray(labels) ? labels : []).map((label) => text(label, 50)).filter((label) => label && LABEL.test(label)).slice(0, 10)
  };
  if (team && !owner.team) {
    findings.push({ class: 'marketplace-metadata', owner: 'marketplace', item: name, words: `${where}'s team '${team.slice(0, 64)}' is not a short lower-case kebab-case ID, so it is left out.`,
      fix: `Give ${name}'s owner.team as a short ID such as web-qa.` });
  }
  if (!owner.team && !owner.name && !owner.handle && !owner.contact) return { owner: null, findings };
  return { owner, findings };
}

/**
 * The owner an item shows [REQ-001]: `{ team, name, handle, contact, issues, feedbackLabels, from, words, confirmed,
 * confirmWords }`, or null when nothing names one. `own` is its parsed block, `folderOwners` the code owners of its
 * folder (or null when the marketplace has no CODEOWNERS), `maintainer` its maintainer-email, `marketplaceOwner` the
 * marketplace's `{ name, email }`.
 */
export function resolveOwner({ own = null, folderOwners = null, maintainer = null, marketplaceOwner = null } = {}) {
  let owner;
  if (own) owner = { ...own, from: 'apm.yml' };
  else if (folderOwners?.length) owner = { team: null, name: folderOwners.join(', '), handle: folderOwners[0], contact: null, issues: null, feedbackLabels: [], from: 'codeowners' };
  else if (maintainer) owner = { team: null, name: maintainer, handle: null, contact: maintainer, issues: null, feedbackLabels: [], from: 'maintainer-email' };
  else if (marketplaceOwner?.name || marketplaceOwner?.email) {
    owner = { team: null, name: marketplaceOwner.name ?? marketplaceOwner.email, handle: null, contact: marketplaceOwner.email ?? null, issues: null, feedbackLabels: [], from: 'marketplace' };
  } else return null;
  const shown = owner.name ?? owner.handle ?? owner.team ?? owner.contact;
  // Whether the team apm.yml names is a code owner of the item's folder: only when both are known.
  const confirmed = owner.from === 'apm.yml' && owner.handle && folderOwners ? amongOwners(owner.handle, folderOwners) : null;
  return { ...owner, name: shown, words: owner.from === 'apm.yml' ? `Owner: ${shown}` : `Owner: ${shown} (from ${FROM_WORDS[owner.from]})`, confirmed,
    confirmWords: confirmed === false ? 'Owner named in apm.yml; CODEOWNERS names someone else for its folder' : null };
}

/** The owner as a row carries it, without what only feedback needs. */
export const ownerSummary = (owner) => (owner ? { team: owner.team ?? null, name: owner.name ?? null, handle: owner.handle ?? null, contact: owner.contact ?? null,
  issues: owner.issues ?? null, from: owner.from ?? null, words: owner.words ?? null, confirmed: owner.confirmed ?? null, confirmWords: owner.confirmWords ?? null } : null);
