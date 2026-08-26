/**
 * The Story service: everything `sflow story` does.
 *
 * Lifted out of `cli.mjs`, which had grown to 8,578 lines and 124 eager top-level imports — so
 * `sflow status` parsed the Story convergence engine, the amendment differ and the GitHub evidence
 * recorder before printing one line about a phase. Nothing here is new; this is the same code behind
 * a boundary, imported by the dispatcher only when a `story` command is actually run.
 *
 * The measured effect: six modules — work-intervals, github-evidence, continuation-packet,
 * amendment, convergence and assisted-convergence — leave `cli.mjs`'s eager graph entirely.
 *
 * The four handlers this calls back into (`start`, `status`, `submit`, `finalize`) are commands in
 * their own right and will become their own services. Until they do, they are reached through a
 * lazy import of the router rather than a static one: `cli.mjs` is always fully evaluated before any
 * service runs, so the call is safe, and keeping it dynamic is what stops the import cycle from
 * pulling the router's whole graph back in here.
 */
import readline from 'node:readline/promises';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import YAML from 'yaml';

import { amendmentChurn, amendmentRecap, blastRadius, clauseDiff } from '../amendment.mjs';
import { assistedConvergencePrompt, assistedConvergenceRelative, buildAssistedConvergenceRecord, parseConvergenceCandidates, serializeAssistedConvergence, unknownReferences } from '../assisted-convergence.mjs';
import { unwrapProviderLineBreaks } from '../assisted-quality.mjs';
import { resolveWorkType } from '../config.mjs';
import { continuationPacket, submissionBlockedByAmendment } from '../continuation-packet.mjs';
import { advancementBlocked, convergenceBindings, convergenceFacts, convergenceProjection, serializeConvergence } from '../convergence.mjs';
import { assertClean, branch, changedFiles, changes, checkout, commit, identity, repoRoot } from '../git.mjs';
import { runAndRecordStoryChecks } from '../github-evidence.mjs';
import { loadPortfolio } from '../initiative-config.mjs';
import { LIFECYCLE_EVENT } from '../lifecycle-event.mjs';
import { sameRepositoryRemote } from '../initiative-repositories.mjs';
import { getIssue, getIssueProperty, listMyIssues } from '../jira.mjs';
import { invokeModel, resolveModelProvider } from '../model-runner.mjs';
import { loadSession } from '../session.mjs';
import { evaluateSpecAcceptance, extractClauses, loadActiveSpecRecords, loadSpecRecords } from '../specifications.mjs';
import {
  StoryStateStore, acknowledgeIntentAmendment, actorKey, commitAndPublish, createWorkflow,
  currentPhase, decideIntentAmendment, loadConfig, loadStoryAggregate, rejectPhase, workDir
} from '../state-stores.mjs';
import { attachStoryBranch, createStoryBranch, promoteStoryBranch, storyBranchStatus } from '../story-lineage.mjs';
import { SingularityFlowError, exists, nowIso, optionBoolean, optionNumber, optionString, optionStrings, posix, readJson, requirePositional, run, snapshot, table, writeJson, writeText } from '../util.mjs';
import { runRemoteGit } from '../git-execution.mjs';
import { acknowledgeAmendment, createLocalCheckpoint, escalationPlan, reconcileWorkInterval } from '../work-intervals.mjs';
import { existsSync } from 'node:fs';
import { currentSchemaVersion, readRecord } from '../schema-migrations.mjs';
import { mkdir, readFile } from 'node:fs/promises';
import { stdin as input, stdout as output } from 'node:process';
import { STORY_LINEAGE_PROPERTY, activatePhaseAgent, activeActionContext, confirm, summary } from './kernel.mjs';
import { capabilityBaseForRepository, prepareCapabilityRepositories, printCapabilityBase } from '../capability-start.mjs';
import { withApprovedConfigurationRead } from '../approved-configuration-reader.mjs';

/**
 * Commands this service delegates to that still live in the router. Dynamic so the cycle stays
 * inert: by the time any of these run, `cli.mjs` has finished evaluating.
 */
async function router() {
  return import('../cli.mjs');
}

export async function storyInboxCommand(options) {
  const root = repoRoot();
  const portfolio = await withApprovedConfigurationRead(root, () => loadPortfolio(root));
  if (!portfolio.jira?.enabled) {
    throw new SingularityFlowError('Story inbox requires the workspace Jira connection configured in singularity/portfolio.yml.');
  }
  const project = optionString(options, 'project', portfolio.jira.projectKey);
  if (!project) throw new SingularityFlowError('Story inbox requires a configured Jira project key or --project.');
  const assigned = optionBoolean(options, 'assigned-to-me');
  const result = await listMyIssues({
    project,
    issueType: portfolio.jira.storyIssueType ?? 'Story',
    limit: optionNumber(options, 'limit', 50),
    ...(assigned ? {} : {
      jql: `project = "${project}" AND issuetype = "${portfolio.jira.storyIssueType ?? 'Story'}" AND statusCategory != Done ORDER BY priority DESC, updated DESC`
    })
  });
  const stories = (await Promise.all(result.issues.map(async (issue) => {
    try {
      const stored = await getIssueProperty(issue.key, STORY_LINEAGE_PROPERTY);
      if (!stored) return null;
      const lineage = readRecord('story-lineage', stored).record;
      return {
        key: issue.key,
        title: issue.title,
        status: issue.status,
        assignee: issue.assignee ?? null,
        planId: lineage.story?.planId ?? null,
        repository: lineage.deliveryRepository?.id ?? lineage.story?.repository ?? null,
        branch: lineage.deliveryRepository?.branch ?? lineage.story?.canonicalBranch ?? issue.key,
        epic: lineage.epic?.jiraKey ?? lineage.epic?.id ?? null
      };
    } catch (error) {
      if (String(error?.code ?? '').startsWith('SCHEMA_')) throw error;
      // Jira returns 404 when an ordinary Story has no Singularity issue property.
      return null;
    }
  }))).filter(Boolean);
  if (optionBoolean(options, 'json')) return console.log(JSON.stringify({ stories, jql: result.jql }, null, 2));
  if (!stories.length) return console.log(`No active Singularity Stories found in Jira project ${project}.`);
  console.log(table(stories, [
    { key: 'key', label: 'STORY' },
    { key: 'planId', label: 'PLAN ID' },
    { key: 'title', label: 'TITLE' },
    { key: 'repository', label: 'REPOSITORY', kind: 'path' },
    { key: 'branch', label: 'BRANCH' },
    { key: 'status', label: 'JIRA STATUS' }
  ]));
}

async function verifyFetchedStoryContext(target, storyKey, property) {
  const seedFile = path.join(target, 'singularity', 'seeds', `${storyKey}.yml`);
  if (!existsSync(seedFile)) {
    throw new SingularityFlowError(`Fetched branch '${storyKey}' has no governed seed at singularity/seeds/${storyKey}.yml.`);
  }
  const seed = YAML.parse(await readFile(seedFile, 'utf8'));
  if (seed?.story?.workId !== storyKey || seed?.story?.jiraKey !== storyKey) {
    throw new SingularityFlowError(`Fetched seed does not belong to Jira Story '${storyKey}'.`);
  }
  const expectedPlan = property.story?.planId ?? null;
  if (expectedPlan && seed.story.planId !== expectedPlan) {
    throw new SingularityFlowError(`Jira lineage says plan '${expectedPlan}', but the governed seed says '${seed.story.planId}'.`);
  }
  for (const record of seed.governedContext ?? []) {
    const current = await snapshot(path.join(target, record.path));
    if (!current.exists || current.sha256 !== record.sha256) {
      throw new SingularityFlowError(
        `Governed Story input '${record.id}' failed verification. Expected ${record.sha256}; `
        + `found ${current.exists ? current.sha256 : 'missing'}.`
      );
    }
  }
  const expectedStoryHash = property.specification?.storySha256 ?? null;
  const actualStory = (seed.governedContext ?? []).find((record) => record.id === 'story-specification');
  if (expectedStoryHash && actualStory?.sha256 !== expectedStoryHash) {
    throw new SingularityFlowError(
      `Jira lineage Story specification hash ${expectedStoryHash} does not match the governed seed hash ${actualStory?.sha256 ?? 'missing'}.`
    );
  }
  return seed;
}

export async function storyFetchCommand(positionals, options) {
  const leadRoot = repoRoot();
  const storyKey = requirePositional(positionals, 2, 'Jira Story key').toUpperCase();
  if (!/^[A-Z][A-Z0-9_-]*-\d+$/.test(storyKey)) throw new SingularityFlowError('story fetch requires a Jira Story key such as MOB-123.');
  // Fetch starts on an application branch, which deliberately may not carry shared configuration.
  // Read and release the approved overlay before checkout so the fetched Story's pinned snapshot,
  // not a temporary latest-policy overlay, owns every lifecycle operation after attachment.
  const portfolio = await withApprovedConfigurationRead(leadRoot, () => loadPortfolio(leadRoot));
  const issue = await getIssue(storyKey);
  const storedProperty = await getIssueProperty(storyKey, STORY_LINEAGE_PROPERTY);
  if (!storedProperty) {
    throw new SingularityFlowError(`Jira Story ${storyKey} has no Singularity Flow lineage property. Publish it from an approved Epic plan first.`);
  }
  const property = readRecord('story-lineage', storedProperty).record;
  const repositoryId = property.deliveryRepository?.id ?? property.story?.repository;
  const repository = portfolio.repositories?.[repositoryId];
  if (!repository) {
    throw new SingularityFlowError(
      `Story ${storyKey}'s lineage names repository '${repositoryId ?? 'unknown'}', which is not configured in this workspace. `
      + `Configured: ${Object.keys(portfolio.repositories ?? {}).join(', ') || 'none'}.`
    );
  }
  const propertyUrl = property.deliveryRepository?.url;
  if (propertyUrl && !sameRepositoryRemote(propertyUrl, repository.url)) {
    throw new SingularityFlowError(
      `Story ${storyKey}'s lineage names repository ${propertyUrl}, which does not match configured repository ${repository.url}. `
      + 'Correct the workspace deliberately; an unlisted Jira URL is never fetched.'
    );
  }

  const currentRemote = run('git', ['remote', 'get-url', 'origin'], { cwd: leadRoot, allowFailure: true });
  const currentIsDelivery = currentRemote.status === 0 && sameRepositoryRemote(currentRemote.stdout, repository.url);
  const explicitDirectory = optionString(options, 'directory');
  if (!currentIsDelivery && !explicitDirectory) {
    throw new SingularityFlowError(
      `Story ${storyKey} belongs to repository '${repositoryId}'. Re-run with --directory <local-path>; `
      + `Singularity will clone only the configured URL ${repository.url}.`
    );
  }
  const target = path.resolve(explicitDirectory ?? leadRoot);
  if (!existsSync(target)) {
    await mkdir(path.dirname(target), { recursive: true });
    const cloned = runRemoteGit(['clone', '--', repository.url, target], {
      cwd: path.dirname(target), operation: 'remote-configuration'
    });
    if (cloned.status !== 0) throw new SingularityFlowError(`Unable to clone configured repository '${repositoryId}': ${(cloned.stderr || cloned.stdout).trim()}`);
  }
  const targetRoot = repoRoot(target);
  if (targetRoot !== target) throw new SingularityFlowError(`Story target must be the repository root: ${targetRoot}.`);
  const targetRemote = run('git', ['remote', 'get-url', 'origin'], { cwd: target, allowFailure: true });
  if (targetRemote.status !== 0 || !sameRepositoryRemote(targetRemote.stdout, repository.url)) {
    throw new SingularityFlowError(`Target repository origin does not match configured URL ${repository.url}.`);
  }
  assertClean(target);

  /**
   * The base this Story is fetched onto.
   *
   * `story fetch` pulled the delivery repository onto the Story branch cut from that repository's own
   * default, which is the same single-repository assumption `start` used to make: fetching an
   * approved Story into a capability of five repositories left the other four wherever they happened
   * to be. `--from-branch` resolves one base across the capability, refusing before anything is
   * touched if any repository lacks it.
   *
   * Nothing changes without the flag in a non-interactive run, and nothing changes at all outside a
   * workspace — the default stays this repository's own default branch.
   */
  const capabilityBase = await capabilityBaseForRepository(target, {
    values: optionStrings(options, 'from-branch'),
    interactive: !optionBoolean(options, 'json') && !optionBoolean(options, 'yes')
  });
  checkout(target, storyKey, {
    base: capabilityBase?.localBase ?? repository.defaultBranch,
    fetch: true,
    existingOnly: true
  });
  if (capabilityBase) {
    // After the delivery repository, for the same reason `start` does it in this order: if the Story
    // cannot be fetched here there is no reason to have moved its siblings.
    const prepared = prepareCapabilityRepositories(
      capabilityBase.workspaceRoot, capabilityBase.plan, storyKey
    );
    if (!optionBoolean(options, 'json')) printCapabilityBase(capabilityBase.plan, prepared);
  }
  const seed = await verifyFetchedStoryContext(target, storyKey, property);

  const config = await loadConfig(target);
  let workflow;
  try {
    workflow = await loadStoryAggregate(target, config, storyKey);
  } catch {
    const workType = seed.story.suggestedWorkType;
    if (!config.workTypes?.[workType]) {
      throw new SingularityFlowError(`Approved Story plan pins workflow '${workType}', but repository '${repositoryId}' does not configure it.`);
    }
    const resolvedWorkType = resolveWorkType(config, workType);
    const agent = await activatePhaseAgent(
      target, config, storyKey, resolvedWorkType.phases[0], optionString(options, 'agent') ?? null
    );
    workflow = await createWorkflow(target, config, {
      id: storyKey,
      title: issue.title || seed.story.title || storyKey,
      source: {
        ...issue,
        type: 'jira',
        key: storyKey,
        id: issue.id ?? seed.story.jiraIssueId ?? null,
        epicId: property.epic?.jiraKey ?? property.epic?.id ?? seed.initiative?.id ?? null,
        planId: seed.story.planId,
        parentBranch: seed.story.parentBranch,
        branchCompletionPolicy: seed.story.branchCompletionPolicy,
        requiredChecks: seed.story.requiredChecks
      },
      baseBranch: seed.story.parentBranch ?? repository.defaultBranch,
      workType,
      agent: agent.agent,
      resolved: resolvedWorkType,
      capabilityId: optionString(options, 'capability')
    });
    await commitAndPublish(target, config, workflow, { type: LIFECYCLE_EVENT.BINDING }, `[${storyKey}][init] start governed Story workflow`);
  }
  if (optionBoolean(options, 'json')) {
    return console.log(JSON.stringify({ storyKey, repository: repositoryId, directory: target, workflow: workflow.workItem, property }, null, 2));
  }
  console.log(`Story ${storyKey} is ready in ${target}.`);
  console.log(`Lineage: ${property.epic?.jiraKey ?? property.epic?.id} → ${seed.story.planId} → ${storyKey}`);
  console.log(`Workflow: ${workflow.workItem.workType} · current phase ${workflow.currentPhase ?? 'complete'}`);
  console.log('Run: singularity-flow next');
  console.log('In Copilot: /sf-next');
}

/**
 * `sflow story return` — the briefing, with the reconciliation it was missing. `[DHR:REQ-040]`
 *
 * The `work.return` envelope is the only projection. It carries lifecycle progress, repository
 * state and reconciliation evidence together, so the CLI cannot disagree with VS Code by scanning
 * and ordering the same Story a second time `[UXH:C2]`.
 */
async function storyReturnCommand(positionals, options, root) {
  const [{ createHostGateway }, { gatewayPlanners }, { message }] = await Promise.all([
    import('../gateway/host.mjs'), import('../gateway/planners/index.mjs'), import('../gateway/messages.mjs')
  ]);

  const workId = positionals[2] ?? optionString(options, 'work-id');
  if (!workId) throw new SingularityFlowError('story return requires a Story ID.');

  /**
   * A fresh session per invocation, as everywhere else a command builds a kernel.
   *
   * Handles are session-bound and this process ends when the command does, so reusing an ID across
   * runs would let one printed here verify against a later invocation in a different tree.
   */
  const { kernel } = createHostGateway({
    root,
    hostSessionId: optionString(options, 'host-session') ?? `cli_${randomUUID()}`,
    planners: gatewayPlanners(),
    plannerContext: { storyId: workId }
  });
  const resolution = await kernel.resolve({ utterance: 'what changed while I was away', arguments: { workId } });
  const envelope = resolution.kind === 'read' && resolution.next.length === 1
    ? await kernel.read({ resolutionId: resolution.next[0].handle })
    : resolution;

  if (optionBoolean(options, 'json')) {
    return console.log(JSON.stringify(envelope, null, 2));
  }

  const work = envelope.data?.workItem ?? { id: workId, title: workId, rail: [] };
  const repository = envelope.data?.repository ?? {};
  const local = envelope.data?.localChanges;
  console.log(`Singularity Flow return — ${workId}`);
  console.log(`${work.id} returns to ${work.phaseLabel ?? work.phase ?? 'its workflow'} (${work.status ?? 'active'}).`);
  console.log(`Branch: ${repository.branch ?? 'unavailable'} @ ${(repository.head ?? 'unavailable').slice(0, 12)}`);
  console.log(`Working tree: ${local === null ? 'unread' : local?.dirty ? `${local.files} changed path(s)` : 'clean'}`);
  console.log(`Progress: ${envelope.data?.lifecycle?.approved ?? 0}/${envelope.data?.lifecycle?.total ?? 0} phases approved`);
  if (envelope.data?.recovery?.required) console.warn('Recovery: a pending publication must be resolved first.');

  /**
   * The reconciliation, in the reader's words rather than as codes.
   *
   * Printed from `why[]` because that is where the planner put its reasoning, and rendering it here
   * from the shared catalog is what keeps this command and the card saying the same thing.
   */
  console.log('');
  for (const entry of envelope.why) {
    const said = message(entry.code, entry.slots);
    console.log(`${said.label}${said.detail ? ` — ${said.detail}` : ''}`);
  }
  for (const row of envelope.checklist ?? []) {
    const said = message(row.code, row.slots);
    console.log(`  ${row.state === 'met' ? '✓' : row.state === 'unmet' ? '✗' : '○'} ${said.label}`);
  }

  if (envelope.next.length) {
    console.log('\nNext choices:');
    envelope.next.forEach((choice, index) => {
      const said = message(choice.reasonCode, choice.slots);
      console.log(`${index + 1}. ${choice.label} — ${said.label}`);
    });
  }
}

export async function storyCommand(positionals, options) {
  const subcommand = positionals[1] ?? 'status';
  const root = repoRoot();
  if (subcommand === 'return') return storyReturnCommand(positionals, options, root);
  if (subcommand === 'start') {
    const storyKey = requirePositional(positionals, 2, 'Jira Story key');
    return (await router()).startCommand(['start', storyKey], { ...options, jira: true });
  }
  if (subcommand === 'inbox') return storyInboxCommand(options);
  if (subcommand === 'fetch') return storyFetchCommand(positionals, options);
  const config = await loadConfig(root);
  if (subcommand === 'interval') {
    const action = positionals[2] ?? 'status';
    const workflow = await loadStoryAggregate(root, config, optionString(options, 'parent'));
    const current = workflow.workIntervals?.current ?? null;
    if (action === 'status') {
      /**
       * The continuation packet `[AMD:REQ-041]`: what was pinned, what has moved, what is stale, and
       * what the specification changed underneath you. This is the surface the packet was built for
       * — computed once in `continuation-packet.mjs` and rendered here, so the JSON a tool reads and
       * the prose a person reads cannot describe different states.
       */
      /**
       * The developer's planned claims, so AMENDED can say what each changed clause means for
       * *their* work rather than in the abstract.
       *
       * Read with `loadSpecRecords`, not `loadActiveSpecRecords`. "Active" means the current
       * generation, and an amendment has just moved that — so the claims the developer actually
       * made, under the generation they were working in, are precisely the ones the active filter
       * discards. Taking the latest planned map and naming its generation is the honest read; the
       * alternative reports "not claimed by you" about work they are holding in their hands.
       */
      const planned = current
        ? (await loadSpecRecords(workDir(root, config, workflow.workItem.id))).planned.at(-1) ?? null
        : null;
      const packet = current
        ? continuationPacket({
          interval: current,
          claims: planned ?? {},
          claimsGeneration: planned?.generation ?? null,
          // `changedFiles`, not `changes`: the latter returns porcelain text, and spreading a
          // string would iterate its characters into the packet as if each were a path.
          changedPaths: changedFiles(root),
          acknowledgedGeneration: current.acknowledgedGeneration ?? null
        })
        : null;
      const result = { workId: workflow.workItem.id, workType: workflow.workItem.workType, current, packet };
      if (optionBoolean(options, 'json')) return console.log(JSON.stringify(result, null, 2));
      if (!current) return console.log(`Story ${workflow.workItem.id} has no open governed work interval in phase ${workflow.currentPhase ?? 'complete'}.`);
      console.log(`Story ${workflow.workItem.id} · ${current.phaseId} generation ${current.generation}`);
      console.log(`Baseline: ${current.baselineSha256.slice(0, 12)} · source ${current.sourceBaseCommit.slice(0, 12)} · ${current.status}`);
      if (current.finalReconciliation) console.log(`Final reconciliation: ${current.finalReconciliation.reconciliationSha256.slice(0, 12)}`);
      // Each section says "quiet" rather than printing an empty list, so a calm return reads as calm.
      console.log(`Since you left: ${packet.sinceYouLeft.quiet ? 'nothing changed' : `${packet.sinceYouLeft.changedPaths.length} path(s) changed`}`);
      console.log(`Stale: ${packet.stale.quiet ? 'nothing drifted' : packet.stale.drift.map((entry) => entry.fact).join(', ')}`);
      if (!packet.amended.quiet) {
        console.log(`Amended: ${packet.amended.clauses.map((clause) => clause.clauseId).join(', ')}`);
        for (const clause of packet.amended.clauses) {
          const under = packet.amended.claimsGeneration != null ? ` under generation ${packet.amended.claimsGeneration}` : '';
          console.log(`  ${clause.clauseId} — ${clause.claimed ? `you claimed this${under} (${clause.artifacts.join(', ') || 'no paths'})` : 'not claimed by you'}`);
        }
      }
      // The recap tells the story once, so a reader is not reconstructing it from the sections
      // above `[AMD:REQ-052]`, and the churn floor says when a requirement has stopped settling
      // `[AMD:REQ-051]`.
      const churn = amendmentChurn(current.amendments ?? []);
      if (!packet.amended.quiet) console.log(amendmentRecap({ amendments: current.amendments ?? [], churn }));
      const blocked = submissionBlockedByAmendment(packet);
      if (blocked) console.warn(blocked);
      return;
    }
    if (action === 'acknowledge') {
      const result = await acknowledgeAmendment(root, workflow, {
        throughGeneration: optionNumber(options, 'through'),
        actor: identity(root).email ?? 'unknown'
      });
      if (!result) return console.log(`Story ${workflow.workItem.id} has no open interval to acknowledge.`);
      // Local, uncommitted state: an acknowledgment is a note that a human read something, not a
      // governed publication. `saveDraft` is the same door every other in-phase mutation uses.
      await new StoryStateStore(root, config).saveDraft(workflow);
      if (optionBoolean(options, 'json')) return console.log(JSON.stringify(result, null, 2));
      return console.log(result.acknowledged
        ? `Acknowledged the amendment through generation ${result.acknowledgedGeneration}. Submission is no longer blocked by it.`
        : `Already acknowledged through generation ${result.acknowledgedGeneration}; nothing to record.`);
    }
    if (action === 'checkpoint') {
      const result = await createLocalCheckpoint(root, workflow, {
        name: optionString(options, 'name'),
        note: optionString(options, 'note')
      });
      if (optionBoolean(options, 'json')) return console.log(JSON.stringify(result, null, 2));
      console.log(`Local checkpoint ${result.checkpointSha256.slice(0, 12)} recorded for ${workflow.workItem.id}.`);
      console.log(`Files fingerprinted: ${result.files.length}. No source file was staged, committed, or pushed.`);
      console.log(`Record: ${result.path}`);
      return;
    }
    if (action === 'reconcile') {
      const result = await reconcileWorkInterval(root, config, workflow, {
        itemDirectory: workDir(root, config, workflow.workItem.id)
      });
      if (optionBoolean(options, 'json')) return console.log(JSON.stringify(result, null, 2));
      console.log(`Reconciliation ${result.reconciliationSha256.slice(0, 12)} · ${result.decision.status}`);
      console.log(`Changed: ${result.summary.changedPaths} · planned: ${result.summary.planned} · unplanned: ${result.summary.unplanned} · protected: ${result.summary.protected}`);
      result.decision.reasons.forEach((reason) => console.warn(`Escalation: ${reason}`));
      console.log(`Local report: ${result.localPath}`);
      console.log('This preview changed no governed state. Submission records the final reconciliation atomically.');
      return;
    }
    if (action === 'escalate') {
      const result = escalationPlan(config, workflow, { target: optionString(options, 'to') });
      if (optionBoolean(options, 'json')) return console.log(JSON.stringify(result, null, 2));
      console.log(`Escalation plan ${result.planSha256.slice(0, 12)}: ${result.fromWorkType} → ${result.toWorkType}`);
      console.log(`Preserves: ${result.preserves.join(', ')}.`);
      console.log(`Next: ${result.action}.`);
      console.log('No branch, source, workflow state, commit, or remote was changed.');
      return;
    }
    throw new SingularityFlowError(`Unknown Story interval action '${action}'.`);
  }
  if (subcommand === 'branch') {
    const action = positionals[2] ?? 'status';
    if (action === 'create') {
      const result = await createStoryBranch(root, config, {
        parentStoryId: optionString(options, 'parent'),
        branchName: requirePositional(positionals, 3, 'child branch name')
      });
      console.log(`Created and registered child branch ${result.branch} for Story ${result.workflow.workItem.id}.`);
      return;
    }
    if (action === 'attach') {
      const result = await attachStoryBranch(root, config, { parentStoryId: optionString(options, 'parent') });
      console.log(`${result.created ? 'Registered' : 'Using'} ${result.canonical ? 'canonical' : 'child'} branch ${result.branch} for Story ${result.workflow.workItem.id}.`);
      return;
    }
    if (action === 'promote') {
      const workflow = await loadStoryAggregate(root, config, optionString(options, 'parent'));
      const result = await promoteStoryBranch(root, config, workflow, { mode: optionString(options, 'mode') });
      if (result.requiresPullRequest) console.log(`Open a pull request from ${result.branch} to ${result.canonicalBranch}. Epic progress advances only after merge.`);
      else console.log(`Promoted ${result.branch} to ${result.canonicalBranch} at ${result.commit.slice(0, 8)}.`);
      return;
    }
    if (action !== 'status') throw new SingularityFlowError(`Unknown Story branch action '${action}'.`);
    const status = await storyBranchStatus(root, config, optionString(options, 'parent'));
    if (optionBoolean(options, 'json')) return console.log(JSON.stringify(status, null, 2));
    console.log(`Story: ${status.workId} · Epic: ${status.epicId ?? 'unlinked'}`);
    console.log(`Current: ${status.currentBranch} (${status.kind}) · Canonical: ${status.canonicalBranch}`);
    return;
  }
  if (subcommand === 'submit') return (await router()).submitCommand(['submit', positionals[2]], options);
  if (subcommand === 'finalize') return (await router()).finalizeCommand(options);
  if (subcommand === 'checks') {
    const workflow = await loadStoryAggregate(root, config, optionString(options, 'parent'));
    const result = await runAndRecordStoryChecks(root, config, workflow, {
      packetSha256: optionString(options, 'packet'),
      requiredChecks: optionStrings(options, 'required-check')
    });
    if (optionBoolean(options, 'json')) console.log(JSON.stringify(result, null, 2));
    else {
      console.log(`Story checks ${result.evidence.ready ? 'passed' : 'need attention'} for ${result.evidence.packetSha256.slice(0, 12)}.`);
      console.log(`Repository checks: ${result.evidence.github.required.map((entry) => `${entry.name}=${entry.status}`).join(', ') || 'no required checks configured'}`);
      result.evidence.governance.errors.forEach((error) => console.warn(`BLOCK: ${error}`));
      console.log(`Evidence committed ${result.publication.sha.slice(0, 8)}${result.publication.pushed ? ' and pushed' : ''}.`);
    }
    // This is the pipeline's gate command. Printing BLOCK lines and exiting 0 let a red build pass.
    if (!result.evidence.ready) process.exitCode = 2;
    return;
  }
  if (subcommand === 'converge') return storyConvergeCommand(positionals, options);
  if (subcommand === 'adjudicate') return storyAdjudicateCommand(positionals, options);
  if (subcommand === 'intent-amendment') return storyIntentAmendmentCommand(positionals, options);
  if (subcommand === 'rework') return storyReworkCommand(positionals, options);
  if (subcommand === 'advance') return storyAdvanceCommand(positionals, options);
  if (subcommand === 'status') return (await router()).statusCommand([positionals[0], positionals[2]], options);
  throw new SingularityFlowError(`Unknown Story subcommand '${subcommand}'.`);
}

/**
 * The convergence subject: the implementation generation being closed, and everything bound to it.
 *
 * Gathered in one place because `[SPK:REQ-072]` asks that an iteration bind all of it — and because
 * the failure mode of scattering this is a record that binds whichever inputs the code path happened
 * to touch, which is indistinguishable from binding all of them until someone needs to re-check one.
 */
async function convergenceSubject(root, config, workflow) {
  const phase = workflow.phases.convergence;
  if (!phase) throw new SingularityFlowError(`Work type '${workflow.workItem.workType}' has no convergence phase.`);
  const implementation = workflow.phases.implementation;
  if (!implementation) throw new SingularityFlowError(`Work type '${workflow.workItem.workType}' has no implementation phase to converge.`);
  const reconciliationRef = implementation.workIntervalReconciliation;
  if (!reconciliationRef?.path) {
    throw new SingularityFlowError(
      'Convergence operates on the reconciliation record for the implementation generation, and none exists yet. '
      + 'Run singularity-flow submit implementation first.'
    );
  }
  const itemDirectory = workDir(root, config, workflow.workItem.id);
  const itemRelative = posix(path.relative(root, itemDirectory));
  // The full record, not the summary the phase keeps: `[SPK:CON-032]` says convergence consumes the
  // exact reconciliation output, and the summary has no `findings`.
  const reconciliation = readRecord('work-reconciliation', await readJson(path.join(root, reconciliationRef.path))).record;
  reconciliation.path = reconciliationRef.path;
  const records = await loadActiveSpecRecords(itemDirectory, workflow);
  const policy = workflow.resolution?.spec ?? config.spec;
  return {
    phase,
    implementation,
    itemDirectory,
    itemRelative,
    reconciliation,
    records,
    policy,
    acceptance: evaluateSpecAcceptance(records, policy, {
      workId: workflow.workItem.id,
      phase: implementation.id,
      generation: implementation.generation
    }),
    // One iteration per implementation generation `[SPK:REQ-083]`: a new generation opens a new one,
    // and re-running convergence against the same generation refreshes it rather than counting up.
    iteration: Math.max(1, Number(implementation.generation ?? 1))
  };
}

/**
 * One governed relay turn for convergence candidates. `[SPK:REQ-076]`
 *
 * `tools: none`, like the specification-quality pass. A model that could read the repository would
 * be re-deriving what reconciliation already owns, at a different altitude, with nothing recording
 * what it looked at — and `[SPK:CON-034]` would have no way to hold.
 */
async function runAssistedConvergence(root, config, workflow, subject, { facts, bindings, model = null }) {
  const clauses = subject.records.indexes.flatMap((index) => index.clauses ?? []);
  const observedClaims = Object.assign({}, ...subject.records.observed.map((map) => map.claims ?? {}));
  const prompt = assistedConvergencePrompt({
    clauses,
    observedClaims,
    changedPaths: subject.reconciliation.findings ?? [],
    facts,
    namespace: subject.policy?.namespace ?? null
  });
  const provider = resolveModelProvider(config);
  const invocation = await invokeModel({
    provider: provider.provider,
    providerConfig: provider.providerConfig,
    model: model ?? provider.model,
    cwd: root,
    allowedRoots: [root],
    prompt: { text: prompt },
    channel: 'convergence-assisted',
    subject: { kind: 'convergence', id: workflow.workItem.id, iteration: bindings.iteration },
    tools: { mode: 'none' },
    limits: { timeoutMs: 5 * 60 * 1000, outputBytes: 256 * 1024 }
  });
  const candidates = parseConvergenceCandidates(invocation.output, { unwrap: unwrapProviderLineBreaks });
  const record = buildAssistedConvergenceRecord({
    workId: workflow.workItem.id,
    bindings,
    facts,
    candidates,
    invocation,
    prompt,
    unknown: unknownReferences(candidates, { factIds: facts.map((item) => item.id), clauseIds: clauses.map((clause) => clause.id) }),
    generatedAt: invocation.completedAt ?? new Date().toISOString()
  });
  const relative = assistedConvergenceRelative(subject.itemRelative, bindings.iteration);
  await writeText(path.join(root, relative), serializeAssistedConvergence(record));
  for (const id of record.unknownReferences.factIds) console.warn(`Warning: a candidate cites deterministic fact '${id}', which this iteration does not contain.`);
  for (const id of record.unknownReferences.clauseIds) console.warn(`Warning: a candidate cites clause '${id}', which the approved specification does not contain.`);
  return { record, path: relative };
}

function convergenceRecordRelative(itemRelative, iteration) {
  return posix(path.join(itemRelative, 'context', 'convergence', `iteration-${iteration}.json`));
}

async function readConvergence(root, itemRelative, iteration) {
  const relative = convergenceRecordRelative(itemRelative, iteration);
  if (!(await exists(path.join(root, relative)))) return null;
  try { return readRecord('convergence-record', await readJson(path.join(root, relative))).record; }
  catch (error) {
    if (String(error?.code ?? '').startsWith('SCHEMA_')) throw error;
    return null;
  }
}

/**
 * `story converge` — the canonical kernel operation `[SPK:REQ-070]`.
 *
 * Deterministic by default `[SPK:REQ-073]`. It computes facts, carries forward any adjudications
 * already recorded for this iteration, and writes the projection. It never approves anything,
 * changes a specification, opens a change request or advances the phase `[SPK:CON-036]` — those are
 * `story adjudicate`, `reject` and `story advance`, each of which needs a human.
 */
export async function storyConvergeCommand(positionals, options) {
  const root = repoRoot();
  const config = await loadConfig(root);
  const workflow = await loadStoryAggregate(root, config, optionString(options, 'work-id'));
  const subject = await convergenceSubject(root, config, workflow);
  const facts = convergenceFacts({
    reconciliation: subject.reconciliation,
    indexes: subject.records.indexes,
    planned: subject.records.planned,
    observed: subject.records.observed,
    acceptance: subject.acceptance,
    /**
     * Clauses amended during this interval `[AMD:REQ-050]`. Convergence cannot know which clauses
     * moved — it holds claims, not two generations of specification text — so the interval's own
     * amendment log is the source. Without this the check exists and never fires, which is the
     * shape of defect this repository keeps finding.
     */
    amendedClauses: [...new Set((workflow.workIntervals?.current?.amendments ?? [])
      .flatMap((entry) => entry.clauses ?? []))]
  });
  const bindings = convergenceBindings({
    iteration: subject.iteration,
    configurationSha256: workflow.resolution?.configSha256 ?? null,
    configurationRevision: workflow.resolution?.configurationSource?.commit ?? null,
    specification: convergenceSourceRef(workflow.phases.specification),
    planning: convergenceSourceRef(workflow.phases.planning),
    indexes: subject.records.indexes,
    reconciliation: subject.reconciliation,
    planned: subject.records.planned,
    observed: subject.records.observed,
    evidence: subject.records.acceptance
  });

  const previous = await readConvergence(root, subject.itemRelative, subject.iteration);
  const assisted = optionBoolean(options, 'assisted')
    ? await runAssistedConvergence(root, config, workflow, subject, { facts, bindings, model: optionString(options, 'model') })
    : null;
  const candidates = assisted?.record.candidates ?? previous?.candidateSnapshot ?? [];
  const projection = convergenceProjection({
    workId: workflow.workItem.id,
    bindings,
    facts,
    candidates,
    candidateRecords: [...(previous?.candidateRecords ?? []), ...(assisted ? [assisted.path] : [])],
    // Carried forward, because a disposition survives a re-run of the facts it was about.
    adjudications: previous?.findings?.map((finding) => ({
      itemId: finding.itemId,
      disposition: finding.disposition,
      classification: finding.classification,
      clauseIds: finding.clauseIds,
      reason: finding.decision?.reason,
      actor: finding.decision?.actor,
      at: finding.decision?.at
    })) ?? []
  });
  const relative = convergenceRecordRelative(subject.itemRelative, subject.iteration);
  await writeText(path.join(root, relative), serializeConvergence({ ...projection, candidateSnapshot: candidates }));

  if (optionBoolean(options, 'json')) return console.log(JSON.stringify(projection, null, 2));
  console.log(`Convergence iteration ${projection.iteration} — ${workflow.workItem.id}`);
  console.log(`  bound to: reconciliation ${bindings.reconciliation.sha256.slice(0, 12)}, source ${String(bindings.sourceTargetCommit ?? '').slice(0, 8)}, ${bindings.clauseIndexSha256.length} clause index/es`);
  console.log(`  facts:    ${facts.length}`);
  for (const item of facts) console.log(`    ${item.id} ${item.kind}: ${item.detail}`);
  if (assisted) {
    console.log(`  candidates: ${assisted.record.candidates.length} (${assisted.path})`);
    for (const candidate of assisted.record.candidates) console.log(`    ${candidate.id} ${candidate.classification}${candidate.clauseIds.length ? ` (${candidate.clauseIds.join(', ')})` : ''}: ${candidate.text}`);
  }
  console.log(`  findings: ${projection.findings.length} recorded, ${projection.unresolvedBlockers.length} blocking`);
  console.log(`  record:   ${relative}`);
  console.log('\nAn absent claim or unclaimed path is missing trace evidence. It is not a finding that the requirement');
  console.log('is unimplemented or the change unplanned — only a human can say that.');
  console.log(`\nAllowed next: ${projection.allowedNext.join(', ') || 'none'}`);
  if (projection.allowedNext.includes('adjudicate')) {
    console.log(`  singularity-flow story adjudicate <ITEM-ID> --disposition rework|update-intent|accepted-deviation|dismissed|deferred [--reason TEXT]`);
  }
  if (projection.allowedNext.includes('create-rework')) {
    // `story rework`, not `reject convergence`. Convergence is `in_progress` when its findings are
    // adjudicated, and `reject` requires a submitted phase — so the instruction printed here used
    // to be one the reader could not carry out, which is worse than printing nothing.
    console.log('  singularity-flow story rework --confirm');
  }
  if (projection.allowedNext.includes('propose-intent-amendment')) {
    console.log('  singularity-flow story intent-amendment propose --file <AMENDED-SPEC.md> --reason <TEXT>');
  }
  if (projection.allowedNext.includes('advance-to-verification')) console.log('  singularity-flow story advance --confirm');
}

function convergenceSourceRef(phase) {
  if (!phase) return null;
  const requiredPath = phase.requiredArtifact?.path;
  const artifact = requiredPath
    ? (phase.artifacts ?? []).find((entry) => entry.path?.endsWith(requiredPath))
    : null;
  return { generation: phase.generation ?? null, sha256: artifact?.sha256 ?? null };
}

/**
 * `story adjudicate` — the human decision `[SPK:REQ-079]`.
 *
 * A separate command from `converge` on purpose. `[SPK:CON-036]` forbids the agent running
 * convergence from disposing of what it found, and the cleanest way to hold that line is for the
 * disposition to be a different invocation by a different identity.
 */
export async function storyAdjudicateCommand(positionals, options) {
  const root = repoRoot();
  const config = await loadConfig(root);
  const workflow = await loadStoryAggregate(root, config, optionString(options, 'work-id'));
  const subject = await convergenceSubject(root, config, workflow);
  const existing = await readConvergence(root, subject.itemRelative, subject.iteration);
  if (!existing) throw new SingularityFlowError(`Convergence iteration ${subject.iteration} has not been run. Run singularity-flow story converge first.`);

  const itemIds = [requirePositional(positionals, 2, 'convergence item ID'), ...optionStrings(options, 'item')];
  const session = await loadSession(root);
  const at = nowIso();
  const decisions = itemIds.map((id) => ({
    itemId: id,
    disposition: optionString(options, 'disposition'),
    classification: optionString(options, 'classification') ?? null,
    reason: optionString(options, 'reason'),
    clauseIds: optionStrings(options, 'clause'),
    actor: actorKey(session.actor),
    at
  }));
  const kept = (existing.findings ?? [])
    .filter((finding) => !itemIds.includes(finding.itemId))
    .map((finding) => ({
      itemId: finding.itemId, disposition: finding.disposition, classification: finding.classification,
      clauseIds: finding.clauseIds, reason: finding.decision?.reason, actor: finding.decision?.actor, at: finding.decision?.at
    }));
  const projection = convergenceProjection({
    workId: workflow.workItem.id,
    bindings: existing.bindings,
    facts: existing.facts ?? [],
    candidates: existing.candidateSnapshot ?? [],
    candidateRecords: existing.candidateRecords ?? [],
    adjudications: [...kept, ...decisions]
  });
  const relative = convergenceRecordRelative(subject.itemRelative, subject.iteration);
  await writeText(path.join(root, relative), serializeConvergence({ ...projection, candidateSnapshot: existing.candidateSnapshot ?? [] }));

  if (optionBoolean(options, 'json')) return console.log(JSON.stringify(projection, null, 2));
  for (const decision of decisions) console.log(`Recorded ${decision.disposition} on ${decision.itemId} by ${decision.actor}.`);
  console.log(`Blocking findings: ${projection.unresolvedBlockers.length ? projection.unresolvedBlockers.join(', ') : 'none'}`);
  console.log(`Allowed next: ${projection.allowedNext.join(', ') || 'none'}`);
}

function amendmentDirectoryRelative(root, config, workflow) {
  return posix(path.join(path.relative(root, workDir(root, config, workflow.workItem.id)),
    'context', 'intent-amendments'));
}

function proposalDigest(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

async function proposeIntentAmendment(root, config, workflow, projection, options) {
  const findings = (projection.findings ?? []).filter((finding) => finding.disposition === 'update-intent');
  if (!findings.length) {
    throw new SingularityFlowError(
      'No convergence finding is dispositioned as update-intent, so there is no intent amendment to propose.',
      { code: 'INTENT_AMENDMENT_NOT_AUTHORIZED' }
    );
  }
  if ((workflow.intentAmendments ?? []).some((entry) => entry.status === 'proposed')) {
    throw new SingularityFlowError('An intent amendment is already awaiting an authority decision.', {
      code: 'INTENT_AMENDMENT_ALREADY_PENDING'
    });
  }
  const specification = workflow.phases.specification;
  if (!specification?.requiredArtifact?.path) {
    throw new SingularityFlowError(`Work type '${workflow.workItem.workType}' has no specification artifact to amend.`, {
      code: 'INTENT_AMENDMENT_UNSUPPORTED'
    });
  }
  const candidate = optionString(options, 'file');
  if (!candidate) {
    throw new SingularityFlowError(
      'Provide the proposed specification bytes with --file <MARKDOWN>. The existing specification is not edited until authority approval.',
      { code: 'INTENT_AMENDMENT_FILE_REQUIRED' }
    );
  }
  const reason = optionString(options, 'reason');
  if (!reason?.trim()) {
    throw new SingularityFlowError('An intent-amendment proposal requires --reason.', {
      code: 'INTENT_AMENDMENT_REASON_REQUIRED'
    });
  }
  const specificationPath = posix(path.join(
    path.relative(root, workDir(root, config, workflow.workItem.id)), specification.requiredArtifact.path
  ));
  const currentText = await readFile(path.join(root, specificationPath), 'utf8');
  const proposedText = await readFile(path.resolve(candidate), 'utf8');
  if (Buffer.byteLength(proposedText, 'utf8') > 2 * 1024 * 1024) {
    throw new SingularityFlowError('An intent-amendment specification may not exceed 2 MiB.', {
      code: 'INTENT_AMENDMENT_INVALID'
    });
  }
  const beforeClauses = extractClauses(currentText, { sourcePath: specificationPath });
  const afterClauses = extractClauses(proposedText, { sourcePath: specificationPath });
  const diff = clauseDiff(beforeClauses, afterClauses, {
    beforeMarkdown: currentText,
    afterMarkdown: proposedText
  });
  if (!diff.changed.length) {
    throw new SingularityFlowError('The proposed specification does not change any governed clause.', {
      code: 'INTENT_AMENDMENT_EMPTY'
    });
  }
  const requiredClauses = [...new Set(findings.flatMap((finding) => finding.clauseIds ?? []))].sort();
  const missed = requiredClauses.filter((clauseId) => !diff.changed.includes(clauseId));
  if (missed.length) {
    throw new SingularityFlowError(
      `The proposal does not revise the clause(s) named by update-intent: ${missed.join(', ')}.`,
      { code: 'INTENT_AMENDMENT_INCOMPLETE' }
    );
  }
  const records = await loadActiveSpecRecords(workDir(root, config, workflow.workItem.id), workflow);
  const plannedClaims = Object.assign({}, ...(records.planned ?? []).map((record) => record.claims ?? {}));
  const observedClaims = Object.assign({}, ...(records.observed ?? []).map((record) => record.claims ?? {}));
  const radius = blastRadius(diff, { claims: plannedClaims }, { observed: { claims: observedClaims } });
  const session = await loadSession(root);
  const index = (workflow.intentAmendments ?? []).length + 1;
  const id = `AMD-${String(index).padStart(3, '0')}`;
  const directory = amendmentDirectoryRelative(root, config, workflow);
  const beforePath = posix(path.join(directory, `${id}-before.md`));
  const proposedPath = posix(path.join(directory, `${id}-proposed.md`));
  const recordPath = posix(path.join(directory, `${id}.json`));
  const beforeSha256 = createHash('sha256').update(currentText).digest('hex');
  const proposedSha256 = createHash('sha256').update(proposedText).digest('hex');
  const proposedAt = nowIso();
  const core = {
    schemaVersion: currentSchemaVersion('intent-amendment-proposal'),
    resultType: 'intent-amendment-proposal',
    id,
    workId: workflow.workItem.id,
    status: 'proposed',
    proposedAt,
    proposedBy: structuredClone(session.actor),
    reason: reason.trim(),
    convergence: {
      iteration: projection.iteration,
      sha256: projection.convergenceSha256,
      findingIds: findings.map((finding) => finding.id),
      itemIds: findings.map((finding) => finding.itemId)
    },
    specification: {
      artifact: specificationPath,
      generation: specification.generation,
      beforePath,
      beforeSha256,
      proposedPath,
      proposedSha256
    },
    requiredClauses,
    diff,
    radius,
    decisions: []
  };
  const proposal = { ...core, proposalSha256: proposalDigest(core), recordPath };
  const summary = {
    id,
    status: 'proposed',
    proposedAt,
    proposedBy: structuredClone(session.actor),
    reason: reason.trim(),
    proposalSha256: proposal.proposalSha256,
    recordPath,
    changedClauses: diff.changed,
    findingIds: proposal.convergence.findingIds,
    affectedClaims: radius.totals.affected,
    acknowledgementRequired: false
  };
  const beforeWorkflow = structuredClone(workflow);
  const publication = await commitAndPublish(
    root,
    config,
    workflow,
    {
      type: LIFECYCLE_EVENT.INTENT_AMENDMENT_PROPOSED,
      phaseId: 'specification',
      generation: specification.generation,
      payload: { proposalId: id, proposalSha256: proposal.proposalSha256, changedClauses: diff.changed }
    },
    `[${workflow.workItem.id}][intent-amendment:propose] ${id}`,
    [],
    {
      rollbackWorkflow: beforeWorkflow,
      beforeStateWrite: async () => {
        await mkdir(path.join(root, directory), { recursive: true });
        await writeText(path.join(root, beforePath), currentText);
        await writeText(path.join(root, proposedPath), proposedText);
        await writeJson(path.join(root, recordPath), proposal);
        workflow.intentAmendments ??= [];
        workflow.intentAmendments.push(summary);
        workflow.history.push({
          at: proposedAt,
          actor: actorKey(session.actor),
          agent: session.agent,
          event: 'intent_amendment_proposed',
          phase: 'convergence',
          detail: `${id} proposes ${diff.changed.length} clause change(s): ${diff.changed.join(', ')}`
        });
      }
    }
  );
  return { proposal, summary, publication };
}

async function decideProposedIntentAmendment(root, config, workflow, proposalId, options) {
  const summary = (workflow.intentAmendments ?? []).find((entry) => entry.id === proposalId);
  if (!summary) throw new SingularityFlowError(`Unknown intent amendment '${proposalId}'.`);
  const proposal = readRecord('intent-amendment-proposal', await readJson(path.join(root, summary.recordPath))).record;
  const decision = optionString(options, 'decision');
  if (!['approve', 'reject'].includes(decision)) {
    throw new SingularityFlowError("Pass --decision approve or --decision reject.", {
      code: 'INTENT_AMENDMENT_DECISION_INVALID'
    });
  }
  const confirmation = options.confirm === true ? null : optionString(options, 'confirm');
  if (confirmation !== proposalId) {
    throw new SingularityFlowError(
      `Authority decision requires exact confirmation: --confirm ${proposalId}.`,
      { code: 'INTENT_AMENDMENT_CONFIRMATION_REQUIRED' }
    );
  }
  const beforeWorkflow = structuredClone(workflow);
  let transition;
  const publication = await commitAndPublish(
    root,
    config,
    workflow,
    {
      type: decision === 'approve' ? LIFECYCLE_EVENT.INTENT_AMENDMENT_APPROVED : LIFECYCLE_EVENT.INTENT_AMENDMENT_REJECTED,
      phaseId: 'specification',
      generation: workflow.phases.specification?.generation ?? null,
      payload: { proposalId, proposalSha256: proposal.proposalSha256, decision }
    },
    `[${workflow.workItem.id}][intent-amendment:${decision}] ${proposalId}`,
    [],
    {
      rollbackWorkflow: beforeWorkflow,
      beforeStateWrite: async () => {
        transition = await decideIntentAmendment(root, config, workflow, proposal, {
          decision,
          reason: optionString(options, 'reason'),
          channel: 'terminal',
          actionContext: activeActionContext()
        });
      }
    }
  );
  return { transition, publication };
}

async function acknowledgeApprovedIntentAmendment(root, config, workflow, proposalId) {
  const beforeWorkflow = structuredClone(workflow);
  let acknowledgement;
  const publication = await commitAndPublish(
    root,
    config,
    workflow,
    {
      type: LIFECYCLE_EVENT.INTENT_AMENDMENT_ACKNOWLEDGED,
      phaseId: workflow.currentPhase,
      generation: currentPhase(workflow)?.generation ?? null,
      payload: { proposalId: proposalId ?? null }
    },
    `[${workflow.workItem.id}][intent-amendment:acknowledge] ${proposalId ?? 'latest'}`,
    [],
    {
      rollbackWorkflow: beforeWorkflow,
      beforeStateWrite: async () => {
        acknowledgement = await acknowledgeIntentAmendment(root, config, workflow, proposalId);
      }
    }
  );
  return { acknowledgement, publication };
}

export async function storyIntentAmendmentCommand(positionals, options) {
  const root = repoRoot();
  const config = await loadConfig(root);
  const workflow = await loadStoryAggregate(root, config, optionString(options, 'work-id'));
  const action = positionals[2] ?? 'status';
  if (action === 'status') {
    const amendments = workflow.intentAmendments ?? [];
    if (optionBoolean(options, 'json')) return console.log(JSON.stringify(amendments, null, 2));
    if (!amendments.length) return console.log(`Story ${workflow.workItem.id} has no intent amendments.`);
    for (const amendment of amendments) {
      console.log(`${amendment.id}\t${amendment.status}\t${amendment.changedClauses?.join(', ') || 'no clauses'}`
        + `${amendment.acknowledgementRequired ? '\tacknowledgement required' : ''}`);
    }
    return;
  }
  if (action === 'propose') {
    const subject = await convergenceSubject(root, config, workflow);
    const projection = await readConvergence(root, subject.itemRelative, subject.iteration);
    if (!projection) throw new SingularityFlowError(`Convergence iteration ${subject.iteration} has not been run.`);
    const result = await proposeIntentAmendment(root, config, workflow, projection, options);
    if (optionBoolean(options, 'json')) return console.log(JSON.stringify(result, null, 2));
    console.log(`Proposed ${result.proposal.id} for ${result.proposal.diff.changed.join(', ')}; commit ${result.publication.sha.slice(0, 8)}.`);
    console.log(`Authority decision: singularity-flow story intent-amendment decide ${result.proposal.id} --decision approve|reject --confirm ${result.proposal.id}`);
    return;
  }
  if (action === 'decide') {
    const proposalId = requirePositional(positionals, 3, 'intent amendment ID');
    const result = await decideProposedIntentAmendment(root, config, workflow, proposalId, options);
    if (optionBoolean(options, 'json')) return console.log(JSON.stringify(result, null, 2));
    if (!result.transition.reached) {
      console.log(`Recorded approval for ${proposalId}; ${result.transition.proposal.approvals.reached}/${result.transition.proposal.approvals.required} authority decisions.`);
      return;
    }
    if (!result.transition.applied) {
      console.log(`Rejected ${proposalId}; the specification and existing evidence were not changed.`);
      return;
    }
    console.log(`Approved ${proposalId}; specification generation ${result.transition.proposal.application.toSpecificationGeneration} is active.`);
    console.log(`${result.transition.affectedPhases.length} phase(s) require revalidation; ${result.transition.preservedEvidence.length} unaffected evidence item(s) were preserved.`);
    console.log(`Acknowledge before submitting: singularity-flow story intent-amendment acknowledge ${proposalId}`);
    return;
  }
  if (action === 'acknowledge') {
    const proposalId = positionals[3] ?? null;
    const result = await acknowledgeApprovedIntentAmendment(root, config, workflow, proposalId);
    if (optionBoolean(options, 'json')) return console.log(JSON.stringify(result, null, 2));
    console.log(`Acknowledged ${result.acknowledgement.id}; downstream evidence can now be revalidated.`);
    return;
  }
  throw new SingularityFlowError(`Unknown Story intent-amendment action '${action}'.`);
}

/**
 * `story rework` — the transition a `rework` disposition earns. `[SPK:REQ-182]` `[SPK:REQ-082]`
 *
 * Deliberately a second command rather than a side effect of adjudicating. A reviewer disposing of
 * six items should be able to change their mind about the third without having already sent the
 * Story back, and `[SPK:CON-036]` is easier to keep true when the transition is its own act.
 *
 * The change request, the authority check, the approval invalidation and the phase transition are
 * all the existing rejection path `[SPK:REQ-182]`; nothing about rework is a parallel lifecycle.
 * Prior convergence records are files under `context/convergence/` and are never rewritten, so
 * every earlier iteration, finding and approval survives `[SPK:REQ-082]`.
 */
export async function storyReworkCommand(positionals, options) {
  const root = repoRoot();
  const config = await loadConfig(root);
  const workflow = await loadStoryAggregate(root, config, optionString(options, 'work-id'));
  const subject = await convergenceSubject(root, config, workflow);
  const projection = await readConvergence(root, subject.itemRelative, subject.iteration);
  if (!projection) throw new SingularityFlowError(`Convergence iteration ${subject.iteration} has not been run.`);
  const rework = (projection.findings ?? []).filter((finding) => finding.disposition === 'rework');
  if (!rework.length) {
    throw new SingularityFlowError('No convergence finding is dispositioned as rework, so there is nothing to send back.');
  }
  const clauseIds = [...new Set(rework.flatMap((finding) => finding.clauseIds ?? []))].sort();
  const reason = optionString(options, 'reason')
    ?? `Convergence iteration ${projection.iteration}: ${rework.length} finding(s) require rework${clauseIds.length ? ` for ${clauseIds.join(', ')}` : ''}.`;
  if (!optionBoolean(options, 'confirm')) {
    console.log(`Convergence iteration ${projection.iteration} would return ${workflow.workItem.id} to implementation:`);
    for (const finding of rework) console.log(`  ${finding.id} (${finding.itemId}) ${finding.clauseIds.join(', ') || 'no clause'}: ${finding.decision?.reason ?? 'no reason recorded'}`);
    console.log(`\nApprovals from implementation onward will be invalidated. Re-run with --confirm.`);
    return;
  }
  const workflowBeforeRework = structuredClone(workflow);
  const returned = await commitAndPublish(
    root,
    config,
    workflow,
    { type: LIFECYCLE_EVENT.PHASE_REJECTED, phaseId: subject.phase.id, generation: subject.phase.generation },
    `[${workflow.workItem.id}][converge:rework] iteration ${projection.iteration}`,
    [],
    {
      rollbackWorkflow: workflowBeforeRework,
      // Closes over `workflow`, like every other unit of work here: `beforeStateWrite` takes no
      // argument, and a parameter here is silently `undefined` rather than a compile error.
      beforeStateWrite: async () => rejectPhase(root, config, workflow, {
        phaseId: subject.phase.id,
        target: 'implementation',
        reason,
        clauseIds,
        // `[SPK:REQ-183]`'s sibling: the projection is what authorises rejecting an unsubmitted
        // phase, and it is re-checked inside `rejectPhase` rather than trusted from here.
        convergenceRework: {
          iteration: projection.iteration,
          convergenceSha256: projection.convergenceSha256,
          unresolvedBlockers: projection.unresolvedBlockers
        },
        channel: 'terminal',
        actionContext: activeActionContext()
      })
    }
  );
  console.log(`Returned ${workflow.workItem.id} to implementation for ${rework.length} convergence finding(s); commit ${returned.sha.slice(0, 8)}.`);
  console.log(`Clauses: ${clauseIds.join(', ') || 'none recorded'}`);
  console.log('Prior convergence records, findings and approvals are preserved. The next implementation publication opens iteration '
    + `${projection.iteration + 1}.`);
}

/**
 * `story advance` — leaving convergence `[SPK:REQ-183]`.
 *
 * Explicit, human, and refused while anything is open. Convergence is not verification
 * `[SPK:CON-038]`; passing through it is a claim that a person looked at every absence of evidence
 * and said what it meant, which is exactly the claim `--confirm` makes on their behalf.
 */
export async function storyAdvanceCommand(positionals, options) {
  const root = repoRoot();
  const config = await loadConfig(root);
  const workflow = await loadStoryAggregate(root, config, optionString(options, 'work-id'));
  const subject = await convergenceSubject(root, config, workflow);
  const projection = await readConvergence(root, subject.itemRelative, subject.iteration);
  const blocked = advancementBlocked(projection);
  if (blocked.length) {
    throw new SingularityFlowError(`Convergence cannot advance to verification:\n- ${blocked.join('\n- ')}`);
  }
  if (!optionBoolean(options, 'confirm')) {
    console.log(`Convergence iteration ${projection.iteration} has no unresolved blockers and every item is dispositioned.`);
    console.log(`Findings: ${projection.findings.length}. Bound to reconciliation ${projection.bindings.reconciliation.sha256.slice(0, 12)}.`);
    return console.log('Advancement is an explicit human action. Re-run with --confirm to submit convergence for approval.');
  }
  console.log(`Convergence iteration ${projection.iteration} confirmed by an authorized human; submitting the phase for approval.`);
  return (await router()).submitCommand(['submit', subject.phase.id], options);
}
