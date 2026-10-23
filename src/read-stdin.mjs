/** Shared command input transport with no dependencies, so the router can import it statically. */
let provided = null;

/** Input for a command run in-process: `capability test-setup --confirm` saving through `configuration save`. */
export async function withStdinText(text, body) {
  provided = text;
  try { return await body(); } finally { provided = null; }
}

export async function readStdinText() {
  if (provided !== null) return provided;
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}
