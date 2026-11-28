/**
 * A stand-in model on this machine (127.0.0.1) that answers every chat request with one short reply, in the
 * OpenAI chat-completions shape, streamed or not. Copilot's runtime is pointed at it with its own
 * bring-your-own-model setting, so a chat runs with its hooks while no request leaves the machine and no premium
 * request is used.
 */
import http from 'node:http';

export async function startFakeModel({ reply = 'ok' } = {}) {
  let requests = 0;
  const server = http.createServer((request, response) => {
    let body = '';
    request.on('data', (chunk) => { if (body.length < 4_000_000) body += chunk; });
    request.on('end', () => {
      if (!/chat\/completions|responses/u.test(request.url ?? '')) {
        response.writeHead(request.url?.includes('models') ? 200 : 404, { 'content-type': 'application/json' });
        response.end(JSON.stringify(request.url?.includes('models') ? { object: 'list', data: [{ id: 'probe-model', object: 'model' }] } : {}));
        return;
      }
      requests += 1;
      let parsed = {};
      try { parsed = JSON.parse(body); } catch { /* answered anyway */ }
      const base = { id: `office-check-${requests}`, created: Math.floor(Date.now() / 1000), model: 'probe-model' };
      const usage = { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 };
      if (parsed.stream) {
        response.writeHead(200, { 'content-type': 'text/event-stream' });
        response.write(`data: ${JSON.stringify({ ...base, object: 'chat.completion.chunk', choices: [{ index: 0, delta: { role: 'assistant', content: reply }, finish_reason: null }] })}\n\n`);
        response.write(`data: ${JSON.stringify({ ...base, object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage })}\n\n`);
        response.end('data: [DONE]\n\n');
        return;
      }
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ ...base, object: 'chat.completion', choices: [{ index: 0, message: { role: 'assistant', content: reply }, finish_reason: 'stop' }], usage }));
    });
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const { port } = server.address();
  return {
    url: `http://127.0.0.1:${port}/v1`,
    get requests() { return requests; },
    close: () => new Promise((resolve) => { server.closeAllConnections?.(); server.close(() => resolve()); })
  };
}
