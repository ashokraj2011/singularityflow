import { createHash } from 'node:crypto';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { currentSchemaVersion } from './schema-migrations.mjs';
import { posix, writeJson } from './util.mjs';
import { deriveRepositoryFacts, renderFactsDigest, repositoryFactsBlock } from './repository-facts.mjs';

const MAX_PACKAGE_MANIFEST_BYTES = 256 * 1024;

const SOURCE_EXTENSIONS = new Map([
  ['.c', 'C'], ['.cc', 'C++'], ['.cpp', 'C++'], ['.cs', 'C#'], ['.dart', 'Dart'],
  ['.go', 'Go'], ['.java', 'Java'], ['.js', 'JavaScript'], ['.jsx', 'JavaScript'],
  ['.kt', 'Kotlin'], ['.kts', 'Kotlin'], ['.php', 'PHP'], ['.py', 'Python'],
  ['.rb', 'Ruby'], ['.rs', 'Rust'], ['.scala', 'Scala'], ['.sh', 'Shell'],
  ['.swift', 'Swift'], ['.ts', 'TypeScript'], ['.tsx', 'TypeScript'], ['.vue', 'Vue']
]);

const BUILD_FILES = new Set([
  'build.gradle', 'build.gradle.kts', 'cargo.toml', 'composer.json', 'dockerfile',
  'gemfile', 'go.mod', 'makefile', 'package.json', 'pom.xml', 'pyproject.toml',
  'requirements.txt', 'settings.gradle', 'settings.gradle.kts'
]);

const DEPLOYMENT_PATTERN = /(^|\/)(\.github\/workflows|\.gitlab-ci|azure-pipelines|charts?|deploy|docker|helm|k8s|kubernetes|terraform)(\/|\.|$)/i;
const TEST_PATTERN = /(^|\/)(__tests__|test|tests|spec|specs)(\/|$)|(?:^|[._-])(test|spec)\.[^/]+$/i;
const CONFIG_PATTERN = /(^|\/)(\.env[^/]*|\.github|config|configuration)(\/|$)|\.(?:json|ya?ml|toml|properties|config\.[cm]?js)$/i;
const DOC_PATTERN = /(^|\/)(docs?|readme(?:\.[^/]*)?|architecture|adr)(\/|$)/i;
const ENTRY_PATTERN = /(^|\/)(app|cli|index|main|server)\.(?:c|cc|cpp|cs|dart|go|java|js|jsx|kt|php|py|rb|rs|scala|swift|ts|tsx|vue)$/i;

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function unique(values, limit = values.length) {
  return [...new Set(values)].sort().slice(0, limit);
}

function markdownPaths(paths, empty = 'No path was identified from repository metadata.') {
  return paths.length ? paths.map((file) => `- \`${file}\``).join('\n') : `- ${empty}`;
}

function repositoryInventory(sourceState) {
  const files = sourceState.files.filter((file) => file.status === 'present').map((file) => posix(file.path)).sort();
  const source = files.filter((file) => SOURCE_EXTENSIONS.has(path.extname(file).toLowerCase()));
  const tests = files.filter((file) => TEST_PATTERN.test(file));
  const deployment = files.filter((file) => DEPLOYMENT_PATTERN.test(file));
  const configuration = files.filter((file) => CONFIG_PATTERN.test(file));
  const documentation = files.filter((file) => DOC_PATTERN.test(file));
  const manifests = files.filter((file) => BUILD_FILES.has(path.basename(file).toLowerCase()));
  const entryPoints = files.filter((file) => ENTRY_PATTERN.test(file));
  const languageCounts = {};
  for (const file of source) {
    const language = SOURCE_EXTENSIONS.get(path.extname(file).toLowerCase());
    languageCounts[language] = (languageCounts[language] ?? 0) + 1;
  }
  const topDirectories = {};
  for (const file of files) {
    const segment = file.includes('/') ? file.split('/')[0] : '(root)';
    topDirectories[segment] = (topDirectories[segment] ?? 0) + 1;
  }
  return {
    files, source, tests, deployment, configuration, documentation, manifests, entryPoints,
    languages: Object.entries(languageCounts).sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0])),
    topDirectories: Object.entries(topDirectories).sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
  };
}

async function packageSignals(root, manifests) {
  const packages = [];
  for (const relative of manifests.filter((file) => path.basename(file) === 'package.json').slice(0, 8)) {
    try {
      const absolute = path.join(root, relative);
      if ((await stat(absolute)).size > MAX_PACKAGE_MANIFEST_BYTES) continue;
      const parsed = JSON.parse(await readFile(absolute, 'utf8'));
      packages.push({
        path: relative,
        name: typeof parsed.name === 'string' ? parsed.name : null,
        scripts: Object.keys(parsed.scripts ?? {}).sort().slice(0, 20),
        dependencies: unique([
          ...Object.keys(parsed.dependencies ?? {}),
          ...Object.keys(parsed.devDependencies ?? {})
        ], 30)
      });
    } catch {
      // A malformed package file is still listed as a build file; light mode never guesses its contents.
    }
  }
  return packages;
}

function commands(packages) {
  return unique(packages.flatMap((entry) => entry.scripts.map((script) => `npm run ${script}`)), 16);
}

function representativePaths(view, inventory) {
  const common = unique([...inventory.entryPoints, ...inventory.manifests], 12);
  const byView = {
    business: inventory.documentation,
    architecture: [...inventory.entryPoints, ...inventory.manifests, ...inventory.configuration],
    development: [...inventory.entryPoints, ...inventory.source],
    testing: [...inventory.tests, ...inventory.manifests],
    security: [...inventory.configuration, ...inventory.manifests, ...inventory.deployment],
    operations: [...inventory.deployment, ...inventory.configuration, ...inventory.manifests],
    release: [...inventory.deployment, ...inventory.manifests],
  };
  return unique([...(byView[view] ?? common), ...common], 18);
}

function viewText(view, inventory, observedCommands, metadata) {
  const paths = representativePaths(view, inventory);
  const facts = {
    business: `${inventory.documentation.length} documentation path(s) and ${inventory.source.length} source path(s) were indexed. Product intent must be confirmed from governed requirements.`,
    architecture: `${inventory.topDirectories.length} top-level area(s) and ${inventory.entryPoints.length} likely entry point(s) were found from path structure. Runtime boundaries are not inferred.`,
    development: `${inventory.source.length} source path(s) across ${inventory.languages.length} detected language(s) were indexed. Symbol and call-graph semantics were not analyzed.`,
    testing: `${inventory.tests.length} test-like path(s) and ${observedCommands.length} package script command(s) were observed. Test coverage and pass status were not inferred.`,
    security: `${inventory.configuration.length} configuration path(s) and ${inventory.deployment.length} deployment path(s) were indexed. No vulnerability or secret scan was performed.`,
    operations: `${inventory.deployment.length} deployment/operations path(s) were indexed. Runtime topology and production state remain unknown.`,
    release: `${inventory.deployment.length} delivery path(s) and ${inventory.manifests.length} build manifest(s) were indexed. Release readiness remains unknown.`,
  };
  return `# ${view} — light repository view

> Generated ${metadata.generated_date} (${metadata.generated_at}) · deterministic light mode · source \`${metadata.repository_commit}\`

## Observed

${facts[view] ?? `${paths.length} representative path(s) were selected deterministically for this view.`}

${markdownPaths(paths)}

## Commands observed in package metadata

${observedCommands.length ? observedCommands.map((command) => `- \`${command}\``).join('\n') : '- None. Inspect the repository build manifest before choosing a command.'}

## Limits

This view was generated without an AI model and consumed **zero model tokens**. It is a repository inventory, not semantic analysis. Confirm behavior, ownership, contracts, risks, and test sufficiency against source and approved artifacts before making a governed decision.
`;
}

function briefText(view, inventory, metadata) {
  const paths = representativePaths(view, inventory).slice(0, 5);
  return `# ${view} — light brief

> ${metadata.generated_date} · zero model tokens · source \`${metadata.repository_commit.slice(0, 12)}\`

${markdownPaths(paths)}

Deterministic path inventory only; semantic behavior and risk remain unverified.
`;
}

export async function generateLightWorldModel({ root, staging, metadata, sourceState, views, task = null }) {
  const inventory = repositoryInventory(sourceState);
  // Facts the repository can be asked for directly: entry points from the manifests that declare
  // them, exported symbols with their line, the import graph, per-file churn from Git. This model
  // previously classified paths by regex and stopped there, so its "facts" were counts of files.
  const facts = await deriveRepositoryFacts(root, sourceState);
  const factsDigest = renderFactsDigest(facts);
  const packages = await packageSignals(root, inventory.manifests);
  const observedCommands = commands(packages);
  const title = packages.find((entry) => entry.name)?.name ?? path.basename(root);
  const languageSummary = inventory.languages.length
    ? inventory.languages.slice(0, 8).map(([language, count]) => `${language} (${count})`).join(', ')
    : 'none detected from file extensions';
  const directorySummary = inventory.topDirectories.slice(0, 10)
    .map(([directory, count]) => `${directory} (${count})`).join(', ') || 'empty repository';

  await mkdir(path.join(staging, 'core'), { recursive: true });
  await mkdir(path.join(staging, 'views'), { recursive: true });
  await mkdir(path.join(staging, 'index'), { recursive: true });
  await mkdir(path.join(staging, 'evidence'), { recursive: true });

  await writeFile(path.join(staging, 'core/summary.brief.md'), `# ${title} — light repository brief

> Generated ${metadata.generated_date} · zero model tokens · source \`${metadata.repository_commit.slice(0, 12)}\`

- Files indexed: ${inventory.files.length}
- Languages: ${languageSummary}
- Likely entry points: ${inventory.entryPoints.slice(0, 5).map((file) => `\`${file}\``).join(', ') || 'none identified'}
- Validation commands: ${observedCommands.slice(0, 4).map((command) => `\`${command}\``).join(', ') || 'none identified'}

This model was generated locally and consumed **zero model tokens**. It records only deterministic repository metadata. It does not claim runtime behavior, business meaning, ownership, security, test coverage, or architectural intent. Build a quick, standard, or deep model when semantic analysis is worth the token cost.
`);
  await writeFile(path.join(staging, 'core/summary.md'), `# ${title} — deterministic light world model

> Generated ${metadata.generated_date} (${metadata.generated_at}) · source \`${metadata.repository_commit}\` · branch \`${metadata.repository_branch}\`

## Repository shape

- Files indexed: ${inventory.files.length}
- Source-like files: ${inventory.source.length}
- Test-like files: ${inventory.tests.length}
- Build manifests: ${inventory.manifests.length}
- Deployment/operations files: ${inventory.deployment.length}
- Languages: ${languageSummary}
- Top-level areas: ${directorySummary}

## Facts {#core.facts}

${repositoryFactsBlock(factsDigest)}

## Likely entry points

${markdownPaths(unique([...inventory.entryPoints, ...inventory.manifests], 15))}

## Observed commands

${observedCommands.length ? observedCommands.map((command) => `- \`${command}\``).join('\n') : '- No package scripts were observed.'}

## Grounding boundary

This model was generated locally without Copilot or another AI model and consumed **zero model tokens**. It intentionally records only deterministic repository metadata. It does not claim runtime behavior, business meaning, ownership, security, test coverage, or architectural intent. Deeper phases can replace it with a quick, standard, or deep model when semantic analysis is worth the token cost.
`);

  await writeJson(path.join(staging, 'core/model.json'), {
    schemaVersion: currentSchemaVersion('worldmodel-light-model'),
    mode: 'deterministic-light',
    title,
    repository: { commit: metadata.repository_commit, branch: metadata.repository_branch },
    counts: {
      files: inventory.files.length,
      source: inventory.source.length,
      tests: inventory.tests.length,
      manifests: inventory.manifests.length,
      deployment: inventory.deployment.length
    },
    languages: Object.fromEntries(inventory.languages),
    topDirectories: Object.fromEntries(inventory.topDirectories.slice(0, 30)),
    packages,
    commands: observedCommands
  });
  const indexedPaths = unique([
    ...inventory.entryPoints,
    ...inventory.manifests,
    ...inventory.tests,
    ...inventory.documentation,
    ...inventory.deployment,
    ...inventory.source
  ], 100);
  await writeJson(path.join(staging, 'index/path-map.json'), {
    schemaVersion: currentSchemaVersion('worldmodel-light-index'),
    mode: 'bounded-light-index',
    totalPaths: inventory.files.length,
    representativePaths: indexedPaths,
    omittedPathCount: Math.max(0, inventory.files.length - indexedPaths.length)
  });

  const manifestViews = {};
  for (const view of views) {
    const fullPath = `views/${view}.md`;
    const briefPath = `views/${view}.brief.md`;
    await writeFile(path.join(staging, fullPath), viewText(view, inventory, observedCommands, metadata));
    await writeFile(path.join(staging, briefPath), briefText(view, inventory, metadata));
    manifestViews[view] = { path: fullPath, brief_path: briefPath, generated: true };
  }

  const taskGuides = [];
  if (task) {
    await mkdir(path.join(staging, 'task-guides'), { recursive: true });
    const taskPath = `task-guides/${sha256(task).slice(0, 16)}.md`;
    await writeFile(path.join(staging, taskPath), `# Light task guide

Task: ${task}

Use the repository paths in the selected light views as starting points. This deterministic guide does not assert the task's impact or solution. Confirm both from source, approved requirements, and tests before implementation.
`);
    taskGuides.push({ id: `task-${sha256(task).slice(0, 12)}`, path: taskPath, task });
  }

  const evidence = {
    id: 'E-LIGHT-001',
    kind: 'deterministic-repository-inventory',
    source_tree_sha256: sourceState.sha256,
    repository_commit: metadata.repository_commit,
    generated_at: metadata.generated_at,
    files_indexed: inventory.files.length,
    model_tokens: 0,
    limitations: ['path-and-manifest-metadata-only', 'no-source-semantics', 'no-runtime-observation']
  };
  await writeFile(path.join(staging, 'evidence/evidence.jsonl'), `${JSON.stringify(evidence)}\n`);

  await writeJson(path.join(staging, 'manifest.json'), {
    schema_version: '2.0',
    ...metadata,
    analysis_depth: 'light',
    source_tree_sha256: sourceState.sha256,
    generator: { type: 'deterministic-local', model: null, model_tokens: 0 },
    core: { brief: 'core/summary.brief.md', summary: 'core/summary.md', model: 'core/model.json' },
    path_index: { path: 'index/path-map.json' },
    views: manifestViews,
    views_generated: views,
    requested_views: views,
    domains: [],
    task_guides: taskGuides,
    evidence: { path: 'evidence/evidence.jsonl' },
    generation: {
      parallel: false,
      strategy: 'deterministic-light',
      max_workers: 0,
      discovery_views: [],
      degraded_views: [],
      resumed_views: [],
      pending_views_at_start: []
    }
  });
}
