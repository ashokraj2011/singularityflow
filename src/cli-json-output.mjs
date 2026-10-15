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

export async function withCliJsonOutput(json, execute, { forAgent = false } = {}) {
  if (!json) return execute();
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
  const { agentOutputGoverned, boundedAgentOutput } = forAgent ? await import('./agent-output.mjs') : {};
  if (forAgent && agentOutputGoverned()) write.call(stream, await boundedAgentOutput(Buffer.concat(chunks).toString('utf8')));
  else for (const chunk of chunks) write.call(stream, chunk);
  return value;
}
