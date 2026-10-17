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
export function interpretsForAgent([command] = []) {
  return ['phase', 'approve', 'nextsteps', 'inputs', 'review-source', 'session'].includes(command);
}

/** The argv a command sees when --for-agent only shapes its output; tokens after `--` are data. */
export function withoutAgentFlag(argv) {
  const end = argv.indexOf('--');
  return argv.filter((token, index) => (end >= 0 && index > end) || !/^--for-agent(?:=.*)?$/u.test(token));
}

export async function withCliJsonOutput(json, execute, { forAgent = false, kind = 'text', utilityEntry = null } = {}) {
  if (!json) return forAgent ? withAgentText(execute, kind) : execute();
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
  const serializedAt = timed ? performance.now() : 0;
  const { agentOutputGoverned, boundedAgentOutput } = forAgent ? await import('./agent-output.mjs') : {};
  const compact = forAgent && agentOutputGoverned();
  const rendered = compact ? await boundedAgentOutput(output) : output;
  const renderedAt = timed ? performance.now() : 0;
  if (compact) write.call(stream, rendered);
  else if (utilityEntry) write.call(stream, output);
  else for (const chunk of chunks) write.call(stream, chunk);
  if (timed) process.stderr.write('@@sflow-output/v1 ' + JSON.stringify({
    serializeMs: serializedAt - outputStarted, renderMs: renderedAt - serializedAt,
    emitMs: performance.now() - renderedAt, inputBytes: bytes, outputBytes: Buffer.byteLength(rendered)
  }) + '\n');
  return value;
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
    write.call(stream, await boundedAgentText(Buffer.concat(chunks).toString('utf8'), { kind }));
  };
  let value;
  try { value = await execute(); }
  catch (error) { await flush(); throw error; }
  await flush();
  return value;
}
