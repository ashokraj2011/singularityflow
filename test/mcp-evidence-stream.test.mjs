import assert from 'node:assert/strict';
import test from 'node:test';

import { readResponseWithLimit } from '../src/mcp-evidence.mjs';

function responseFrom(chunks) {
  return new Response(new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(Buffer.from(chunk));
      controller.close();
    }
  }));
}

test('MCP evidence output is accumulated only up to the configured byte limit', async () => {
  const bytes = await readResponseWithLimit(responseFrom(['abc', 'de']), 5);
  assert.equal(bytes.toString(), 'abcde');

  await assert.rejects(
    readResponseWithLimit(responseFrom(['abc', 'def']), 5),
    (error) => error.code === 'MCP_EVIDENCE_LIMIT' && /exceeds 5 bytes/.test(error.message)
  );
});
