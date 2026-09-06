/**
 * Help Center loaded independently from the complete panel graph. `[DXP:P2-002]`
 *
 * Help is a frequent, repository-independent surface. Keeping it in the aggregate panel bundle
 * made the first Help request parse and retain every configuration, organisation, SGOS, and
 * lifecycle panel, then pay a delayed garbage-collection pause after the command completed.
 */
export { HelpPanel } from './views/help.ts';
