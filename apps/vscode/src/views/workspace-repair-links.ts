/**
 * Repair workspace's links in VS Code (SPEC-SCF stage 5, SCF:REQ-022).
 *
 * `workspace repair <DIRECTORY> --json` clones what is missing as before, and previews the rest: saving a moved
 * workspace where it is, re-linking its Story checkouts, making a deleted one again from its branch. The person reads
 * that preview in the same words the terminal prints and confirms it here; the CLI applies it only while it is still
 * the same plan (its plan ID, which `workspace repair --confirm` takes in a terminal too). No vscode import: the
 * editor's modal and the CLI are passed in, so the flow is checked without an extension host.
 */

/** What `workspace repair --json` says about the links, beside the clones it made. */
export interface WorkspaceRepairLinks {
  status: 'preview' | 'blocked' | 'repaired' | 'nothing-to-repair';
  plan?: { planId?: string; folder?: string; refusals?: Array<{ code?: string; message: string; command: string }> };
  lines?: string[];
  confirmCommand?: string;
}

export interface WorkspaceRepairResult {
  links?: WorkspaceRepairLinks;
}

/** Repair: clone what is missing, and preview the links. */
export function workspaceRepairCommand(directory: string): string[] {
  return ['workspace', 'repair', directory, '--json'];
}

/** Apply exactly the plan the preview showed; the CLI refuses it if the workspace changed since. */
export function workspaceRepairConfirmCommand(directory: string, planId: string): string[] {
  return ['workspace', 'repair', directory, '--confirm', planId, '--json'];
}

export interface WorkspaceRepairPorts {
  /** A modal with the plan; true when the person chose `action`. */
  ask(title: string, detail: string, action: string): Promise<boolean>;
  /** A modal that only informs. */
  inform(title: string, detail: string): Promise<void>;
  run(args: string[]): Promise<WorkspaceRepairResult>;
}

export type WorkspaceRepairOutcome =
  | { outcome: 'none' }
  | { outcome: 'cancelled' }
  | { outcome: 'blocked'; refusals: Array<{ code?: string; message: string; command: string }> }
  | { outcome: 'repaired'; result: WorkspaceRepairResult };

export const REPAIR_LINKS_ACTION = 'Repair links';

/** After a repair's preview: nothing to do, the person's confirmation and the confirmed repair, or work to save first. */
export async function confirmWorkspaceRepairLinks(
  directory: string, preview: WorkspaceRepairResult, ports: WorkspaceRepairPorts
): Promise<WorkspaceRepairOutcome> {
  const links = preview?.links;
  if (!links || links.status === 'nothing-to-repair' || links.status === 'repaired') return { outcome: 'none' };
  const detail = (links.lines ?? []).join('\n');
  if (links.status === 'blocked') {
    await ports.inform('This workspace has work to save before its Story checkouts can be repaired.', detail);
    return { outcome: 'blocked', refusals: links.plan?.refusals ?? [] };
  }
  const planId = links.plan?.planId;
  if (!planId) return { outcome: 'none' };
  if (!await ports.ask('Repair this workspace\'s Story checkouts and registration?', detail, REPAIR_LINKS_ACTION)) {
    return { outcome: 'cancelled' };
  }
  return { outcome: 'repaired', result: await ports.run(workspaceRepairConfirmCommand(links.plan?.folder ?? directory, planId)) };
}
