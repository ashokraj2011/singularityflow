import { codePageSafeJson } from './code-page-safe-json.mjs';

/** Keep legacy progress/review prose from preceding a failed --json command's terminal object. */
const MAX_OUTPUT_BYTES = 64 * 1024 * 1024;

/**
 * Whether this JSON result is read by an agent or a person rather than a program: `--for-agent`, or
 * JSON written to a terminal. A host agent runs commands in a terminal and saved a long result to a
 * file outside the workspace its own tools could not open (a /sf-session agent then reached for
 * `jq` on that file). Programs read through pipes and files and keep the whole result.
 */
export function agentViewRequested(options, { stream = process.stdout, env = process.env } = {}) {
  if (options?.['for-agent'] === true || options?.['for-agent'] === 'true') return true;
  const json = options?.json === true || options?.json === 'true';
  return json && stream?.isTTY === true && env.SINGULARITY_FLOW_AGENT_OUTPUT !== 'full';
}

/**
 * Commands that read `--for-agent` themselves. Their compact agent entries are deliberately strict
 * (`session attach` or `review-source submit` with it is refused), so they keep their own rules. For
 * every other command it only shapes the output, and the CLI removes it before the command sees its
 * options: appeal, environment, sgos and others refuse an option they do not know.
 */
export function interpretsForAgent([command, subcommand] = []) {
  // Output-only here: bounded and kept for `result last`. Context, stage and decide own the flag.
  if (command === 'review-source' && ['check', 'status', 'submit', 'decision-context'].includes(subcommand)) return false;
  return ['phase', 'approve', 'nextsteps', 'inputs', 'review-source', 'session', 'app-review'].includes(command);
}

/** The argv a command sees when --for-agent only shapes its output; tokens after `--` are data. */
export function withoutAgentFlag(argv) {
  const end = argv.indexOf('--');
  return argv.filter((token, index) => (end >= 0 && index > end) || !/^--for-agent(?:=.*)?$/u.test(token));
}

export async function withCliJsonOutput(json, execute, { forAgent = false, kind = 'text', utilityEntry = null, argv = null } = {}) {
  if (!json) return forAgent ? withAgentText(execute, kind) : execute();
  // An agent's result is kept whole, refusals too (cli-failure.mjs), for `result last` to return
  // when its host cut it off or returned while it still ran (agent-result-keeper.mjs).
  // A composite's nested step keeps nothing and never replaces the composite's own run.
  const nested = globalThis.__SINGULARITY_FLOW_CLI_STEP_DEPTH > 0;
  const keeper = forAgent && argv && kind !== 'result' && !nested ? await import('./agent-result-keeper.mjs') : null;
  const kept = keeper?.beginAgentResult(argv, { cwd: globalThis.__SFLOW_INVOCATION_CWD ?? process.cwd() }) ?? null;
  if (!nested) globalThis.__SFLOW_AGENT_RESULT_RUN = kept;
  const stream = process.stdout;
  const write = stream.write;
  const chunks = [];
  let bytes = 0;
  let overflow = false;
  stream.write = function (chunk, encoding, callback) {
    const buffer = Buffer.isBuffer(chunk) ? Buffer.from(chunk) : Buffer.from(chunk, typeof encoding === 'string' ? encoding : 'utf8');
    bytes += buffer.length;
    if (bytes <= MAX_OUTPUT_BYTES) chunks.push(buffer);
    else { overflow = true; chunks.length = 0; }
    const done = typeof encoding === 'function' ? encoding : callback;
    if (done) queueMicrotask(done);
    return true;
  };
  let value;
  globalThis.__SFLOW_STORY_ROUTE = null;
  try {
    value = await execute();
    if (overflow) throw Object.assign(new Error('CLI JSON output exceeded the 64 MiB bound. Inspect the command journal before retrying; effects are not inferred from an output failure.'), {
      code: 'CLI_JSON_OUTPUT_TOO_LARGE'
    });
  } finally {
    // On refusal all partial output is dropped; reportCliFailure writes exactly one object after
    // this restoration. Human mode and child Git diagnostics on stderr are unchanged.
    stream.write = write;
  }
  // An agent reads `act` first and never more than its host shows (agent-output.mjs).
  const timed = process.env.SINGULARITY_FLOW_OUTPUT_TIMING === 'stderr-v1';
  const outputStarted = timed ? performance.now() : 0;
  let output = Buffer.concat(chunks).toString('utf8');
  if (utilityEntry) {
    const { utilityResult } = await import('./utility-entry.mjs');
    output = JSON.stringify(utilityResult(utilityEntry, JSON.parse(output)), null, 2) + '\n';
  }
  // A command that ran in another Story's checkout says where (story-routing.mjs).
  const route = globalThis.__SFLOW_STORY_ROUTE;
  if (route) try {
    const parsed = JSON.parse(output);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) output = `${JSON.stringify({ ...parsed, storyRoute: route }, null, 2)}\n`;
  } catch { /* Not one JSON object: written unchanged. */ }
  const serializedAt = timed ? performance.now() : 0;
  const { agentOutputGoverned, boundedAgentOutput } = forAgent ? await import('./agent-output.mjs') : {};
  const compact = forAgent && agentOutputGoverned();
  const rendered = compact ? await agentViewOrOutput(boundedAgentOutput, output) : output;
  const renderedAt = timed ? performance.now() : 0;
  keeper?.keepAgentResult(kept, output);
  const safe = codePageSafeJson(rendered);
  if (compact || safe !== rendered) write.call(stream, safe);
  else if (utilityEntry || route) write.call(stream, output);
  else for (const chunk of chunks) write.call(stream, chunk);
  if (timed) process.stderr.write('@@sflow-output/v1 ' + JSON.stringify({
    serializeMs: serializedAt - outputStarted, renderMs: renderedAt - serializedAt,
    emitMs: performance.now() - renderedAt, inputBytes: bytes, outputBytes: Buffer.byteLength(rendered)
  }) + '\n');
  return value;
}

/**
 * The agent view of output a command already produced, or that output as it is when the view
 * cannot be made: showing a result never turns a command that ran into a refusal.
 */
export async function agentViewOrOutput(view, output, options) {
  try { return await view(output, options); }
  catch (error) {
    process.stderr.write(`Warning: the agent view could not be made (${error?.code ?? error?.message}); the whole output follows.\n`);
    return output;
  }
}

/** Plain text an agent reads: whole when it fits the host, otherwise its start and the file holding it all. */
async function withAgentText(execute, kind) {
  const { agentOutputGoverned, boundedAgentText } = await import('./agent-output.mjs');
  if (!agentOutputGoverned()) return execute();
  const stream = process.stdout;
  const write = stream.write;
  const chunks = [];
  let bytes = 0;
  stream.write = function (chunk, encoding, callback) {
    const buffer = Buffer.isBuffer(chunk) ? Buffer.from(chunk) : Buffer.from(chunk, typeof encoding === 'string' ? encoding : 'utf8');
    if ((bytes += buffer.length) <= MAX_OUTPUT_BYTES) chunks.push(buffer);
    const done = typeof encoding === 'function' ? encoding : callback;
    if (done) queueMicrotask(done);
    return true;
  };
  // A refusal still prints what came before it, bounded the same way, ahead of the error.
  const flush = async () => {
    stream.write = write;
    write.call(stream, await agentViewOrOutput(boundedAgentText, Buffer.concat(chunks).toString('utf8'), { kind }));
  };
  let value;
  try { value = await execute(); }
  catch (error) { await flush(); throw error; }
  await flush();
  return value;
}
