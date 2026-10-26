/**
 * Handing a capability's whole `application` block to the engine. [RUN amendment 3; IntelliJ amendment 2]
 *
 * The Suggest page and the Run/Debug Configurations editor both write the block the same way: the
 * capability page's route (a reviewed `capability edit --lead … --mode set` proposal, or `capability
 * set` in this checkout), with the block in a private file that exists only while one command reads
 * it: 0600 inside a fresh 0700 directory, removed afterwards. `app config preview` reads its block
 * the same way. The log names the file as `<private temporary file>`, never its path.
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import * as vscode from 'vscode';
import type { SingularityFlowClient } from '../cli/client.ts';
import { displayCommand } from './run-and-test-model.ts';
import {
  applicationRoute, applicationWriteArgv, applicationWriteOutcome, TEMPORARY_FILE_WORDS, type ApplicationRoute
} from './run-suggestions-model.ts';

export interface ApplicationWriteHost {
  client: SingularityFlowClient;
  localRunConfiguration?: boolean;
  output?: { appendLine(line: string): void };
  /** The capability map's mode and approved authority, as the capability page reads them. */
  capabilityAuthority?(): { mode: string | null; authorityRepository: string | null };
}

/** Run `use(file)` with `yaml` in a private file; the file and its directory are gone afterwards. */
export async function withPrivateApplicationFile<T>(yaml: string, use: (file: string) => Promise<T>): Promise<T> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'sflow-application-'));
  try {
    const file = path.join(directory, 'application.yml');
    await writeFile(file, yaml, { mode: 0o600, flag: 'wx' });
    return await use(file);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

/** Where the block goes, by the capability page's rule; several registered leads ask which. Null: cancelled. */
export async function chooseApplicationRoute(host: ApplicationWriteHost): Promise<ApplicationRoute | null> {
  if (host.localRunConfiguration) return { kind: 'personal' };
  const { mode = null, authorityRepository = null } = host.capabilityAuthority?.() ?? {};
  let leads: string[] = [];
  if (mode !== 'implicit' && !authorityRepository?.trim()) {
    const answer = await host.client.run<Array<{ url?: unknown }>>(['capability', 'leads', '--json']);
    leads = (Array.isArray(answer) ? answer : []).flatMap((entry) => typeof entry?.url === 'string' && entry.url ? [entry.url] : []);
  }
  const route = applicationRoute(mode, authorityRepository, leads);
  if (route.kind !== 'pick') return route;
  const picked = await vscode.window.showQuickPick(route.leads.map((lead) => ({ label: lead, lead })), {
    title: 'Choose capability-map authority', placeHolder: 'The repository that owns the capability map', ignoreFocusOut: true
  });
  return picked ? { kind: 'proposal', lead: picked.lead } : null;
}

/** `capability set|edit … --application-file <private file> --json`, and what the engine answered. */
export async function writeApplicationBlock(host: ApplicationWriteHost, route: ApplicationRoute, capability: string, yaml: string):
  Promise<ReturnType<typeof applicationWriteOutcome>> {
  return withPrivateApplicationFile(yaml, async (file) => {
    const argv = applicationWriteArgv(route, capability, file);
    host.output?.appendLine(`\n$ ${displayCommand(applicationWriteArgv(route, capability, TEMPORARY_FILE_WORDS))}`);
    return applicationWriteOutcome(route, await host.client.run(argv));
  });
}
