/** Shared command input transport, without command-router dependencies. */
export async function readStdinText() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}
