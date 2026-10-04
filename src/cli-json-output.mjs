/** Keep legacy progress/review prose from preceding a failed --json command's terminal object. */
const MAX_OUTPUT_BYTES = 64 * 1024 * 1024;

export async function withCliJsonOutput(json, execute) {
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
  for (const chunk of chunks) write.call(stream, chunk);
  return value;
}
