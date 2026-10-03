/**
 * Confluence after-step actions: one page per Story and step under a parent page, written once
 * per delivery, never over a newer generation, with the artifact's text escaped.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { escapeStorageText, markdownToConfluenceStorage } from '../src/confluence-storage.mjs';
import { CONFLUENCE_DELIVERY_PROPERTY, confluencePageBody, deliverToConfluence } from '../src/step-action-confluence.mjs';
import { normalizeIntegrations, renderConfluenceTitle } from '../src/step-actions.mjs';

const ENV = { SFLOW_SECRET_WIKI_TOKEN: 'wiki-token' };
const key = (digit) => `sad_${String(digit).repeat(40)}`;

/** A small Confluence speaking Cloud REST v2 or Data Center REST v1 for one space. */
function fakeConfluence({ deployment = 'cloud' } = {}) {
  const pages = new Map([['100', { id: '100', title: 'Team home', parentId: null, spaceId: '9', version: 1, body: '' }]]);
  const properties = new Map();
  const calls = [];
  let script = [];
  let nextId = 200;
  const json = (status, value) => ({ status, headers: {}, text: value === undefined ? '' : JSON.stringify(value) });
  const request = async ({ url, method, headers, body }) => {
    const target = new URL(url);
    calls.push(`${method} ${target.pathname}${target.search}`);
    if (script.length) { const next = script.shift(); if (next) return next === 'timeout' ? { transport: { outcome: 'retry', code: 'STEP_ACTION_TIMEOUT', detail: 'No answer within 10 seconds.' } } : json(next, { message: `scripted ${next}` }); }
    const expected = deployment === 'cloud' ? `Basic ${Buffer.from('flow@example.com:wiki-token').toString('base64')}` : 'Bearer wiki-token';
    if (headers.authorization !== expected) return json(401, { message: 'Unauthorized' });
    const input = body ? JSON.parse(body) : null;
    if (deployment === 'cloud') {
      const route = target.pathname.replace(/^\/wiki\/api\/v2/, '');
      let match;
      if ((match = /^\/pages\/(\d+)$/.exec(route)) && method === 'GET') {
        const page = pages.get(match[1]);
        return page ? json(200, { id: page.id, title: page.title, parentId: page.parentId, spaceId: page.spaceId, version: { number: page.version } }) : json(404, { message: 'Not found' });
      }
      if (route === '/pages' && method === 'GET') {
        const title = target.searchParams.get('title');
        return json(200, { results: [...pages.values()].filter((page) => page.title === title && page.spaceId === target.searchParams.get('space-id')).map((page) => ({ id: page.id, title: page.title, parentId: page.parentId })) });
      }
      if (route === '/pages' && method === 'POST') {
        const id = String(nextId++);
        pages.set(id, { id, title: input.title, parentId: input.parentId, spaceId: input.spaceId, version: 1, body: input.body.value });
        return json(200, { id, title: input.title });
      }
      if ((match = /^\/pages\/(\d+)$/.exec(route)) && method === 'PUT') {
        const page = pages.get(match[1]);
        if (input.version.number !== page.version + 1) return json(409, { message: 'Version conflict' });
        Object.assign(page, { title: input.title, version: input.version.number, body: input.body.value });
        return json(200, { id: page.id });
      }
      if ((match = /^\/pages\/(\d+)\/properties$/.exec(route)) && method === 'GET') {
        const property = properties.get(match[1]);
        return json(200, { results: property && property.key === target.searchParams.get('key') ? [property] : [] });
      }
      if ((match = /^\/pages\/(\d+)\/properties$/.exec(route)) && method === 'POST') {
        properties.set(match[1], { id: `p${match[1]}`, key: input.key, value: input.value, version: { number: 1 } });
        return json(200, {});
      }
      if ((match = /^\/pages\/(\d+)\/properties\/(p\d+)$/.exec(route)) && method === 'PUT') {
        const property = properties.get(match[1]);
        if (input.version.number !== property.version.number + 1) return json(409, { message: 'Version conflict' });
        Object.assign(property, { value: input.value, version: input.version });
        return json(200, {});
      }
      return json(404, { message: `No route ${method} ${route}` });
    }
    const route = target.pathname.replace(/^\/rest\/api/, '');
    let match;
    if ((match = /^\/content\/(\d+)$/.exec(route)) && method === 'GET') {
      const page = pages.get(match[1]);
      return page ? json(200, { id: page.id, title: page.title, space: { key: 'TEAM' } }) : json(404, { message: 'Not found' });
    }
    if (route === '/content' && method === 'GET') {
      const title = target.searchParams.get('title');
      return json(200, { results: [...pages.values()].filter((page) => page.title === title).map((page) => ({ id: page.id, title: page.title, version: { number: page.version }, ancestors: page.parentId ? [{ id: page.parentId }] : [] })) });
    }
    if (route === '/content' && method === 'POST') {
      const id = String(nextId++);
      pages.set(id, { id, title: input.title, parentId: input.ancestors[0].id, spaceId: '9', version: 1, body: input.body.storage.value });
      return json(200, { id });
    }
    if ((match = /^\/content\/(\d+)$/.exec(route)) && method === 'PUT') {
      const page = pages.get(match[1]);
      Object.assign(page, { version: input.version.number, body: input.body.storage.value });
      return json(200, { id: page.id });
    }
    if ((match = /^\/content\/(\d+)\/property\/([\w-]+)$/.exec(route)) && method === 'GET') {
      const property = properties.get(match[1]);
      return property ? json(200, property) : json(404, { message: 'No property' });
    }
    if ((match = /^\/content\/(\d+)\/property$/.exec(route)) && method === 'POST') {
      properties.set(match[1], { key: input.key, value: input.value, version: { number: 1 } });
      return json(200, {});
    }
    if ((match = /^\/content\/(\d+)\/property\/([\w-]+)$/.exec(route)) && method === 'PUT') {
      Object.assign(properties.get(match[1]), { value: input.value, version: input.version });
      return json(200, {});
    }
    return json(404, { message: `No route ${method} ${route}` });
  };
  return { pages, properties, calls, request, script: (codes) => { script = [...codes]; } };
}

function confluenceRecord({ deployment = 'cloud', send = 'artifact', generation = 1, deliveryKey = key(1), markdown = '# Intake\n\nApproved scope with <script>alert(1)</script>.\n', title } = {}) {
  const { targets } = normalizeIntegrations({ targets: { wiki: {
    kind: 'confluence', url: deployment === 'cloud' ? 'https://example.atlassian.net/wiki' : 'https://confluence.example.com',
    deployment, parentPage: '100', ...(deployment === 'cloud' ? { user: 'flow@example.com' } : {}), tokenSecret: 'SFLOW_SECRET_WIKI_TOKEN', ...(title ? { title } : {})
  } } });
  return {
    key: deliveryKey, workId: 'STORY-9', phaseId: 'intake', generation, trigger: 'approved',
    action: { id: 'publish', on: ['approved'], target: 'wiki', send, targetSpec: targets.wiki },
    event: {
      story: { id: 'STORY-9', title: 'Checkout retry', branch: 'STORY-9' }, step: { id: 'intake', label: 'Intake', generation },
      actor: 'ada', at: '2026-10-04T10:00:00.000Z', commit: { sha: 'c'.repeat(40), remote: null },
      artifacts: [{ path: 'singularity/work-items/STORY-9/artifacts/intake/intake.md', sha256: 'b'.repeat(64) }],
      summary: send === 'summary' ? { title: 'Checkout retry', acceptanceCriteria: ['A failed charge is retried once.'] } : undefined
    },
    ...(send === 'artifact' ? { artifact: { path: 'singularity/work-items/STORY-9/artifacts/intake/intake.md', sha256: 'b'.repeat(64), mediaType: 'text/markdown', base64: Buffer.from(markdown).toString('base64') } } : {})
  };
}

test('a confluence target names its site, parent page, account and token secret, and a title template', () => {
  assert.equal(renderConfluenceTitle(undefined, { workId: 'STORY-9', stepLabel: 'Intake' }), 'STORY-9 — Intake');
  assert.equal(renderConfluenceTitle('{storyTitle} ({story})', { workId: 'STORY-9', storyTitle: 'Checkout\nretry' }), 'Checkout retry (STORY-9)');
  const code = (target) => { try { normalizeIntegrations({ targets: { one: { kind: 'confluence', url: 'https://example.atlassian.net/wiki', parentPage: '100', user: 'flow@example.com', tokenSecret: 'SFLOW_SECRET_WIKI_TOKEN', ...target } } }); return null; } catch (error) { return error.code; } };
  assert.equal(code({}), null);
  for (const target of [{ parentPage: 'home' }, { parentPage: 100 }, { user: 'not-an-email' }, { deployment: 'server' }, { title: '{secret}' }, { url: 'http://example.atlassian.net/wiki' }]) {
    assert.ok(code(target), JSON.stringify(target));
  }
  assert.equal(code({ deployment: 'data-center' }), 'INTEGRATION_TARGET_INVALID', 'Data Center signs in with the token alone');
  assert.equal(code({ tokenSecret: 'CONFLUENCE_TOKEN' }), 'INTEGRATION_SECRET_NAME_INVALID');
});

test('the page body escapes everything the artifact says and keeps its structure', () => {
  const body = confluencePageBody(confluenceRecord());
  assert.match(body, /<strong>STORY-9<\/strong> — Checkout retry<br\/>Intake, generation 1, approved by ada at 2026-10-04T10:00:00.000Z/);
  assert.match(body, /<h1>Intake<\/h1>\n<p>Approved scope with &lt;script&gt;alert\(1\)&lt;\/script&gt;\.<\/p>/);
  assert.doesNotMatch(body, /<script>/);
  assert.match(body, new RegExp(`delivery ${key(1)}</em>`));
  assert.match(confluencePageBody(confluenceRecord({ send: 'summary' })), /<h2>Checkout retry<\/h2><ul><li>A failed charge is retried once\.<\/li><\/ul>/);
  assert.equal(markdownToConfluenceStorage('```\n]]><script>\n```'), '<ac:structured-macro ac:name="code"><ac:plain-text-body><![CDATA[]]]]><![CDATA[><script>]]></ac:plain-text-body></ac:structured-macro>');
  assert.equal(markdownToConfluenceStorage('[x](javascript:alert(1))'), '<p>x)</p>', 'only http(s) and mailto links become links');
  assert.equal(escapeStorageText(`<a href="x">'`), '&lt;a href=&quot;x&quot;&gt;&#39;');
});

for (const deployment of ['cloud', 'data-center']) {
  test(`Confluence ${deployment}: a delivery creates the page once, updates it for a later generation, and never goes back`, async () => {
    const wiki = fakeConfluence({ deployment });
    const first = await deliverToConfluence(confluenceRecord({ deployment }), { env: ENV, request: wiki.request });
    assert.deepEqual([first.outcome, first.detail], ['delivered', 'Created "STORY-9 — Intake".']);
    const page = [...wiki.pages.values()].find((entry) => entry.title === 'STORY-9 — Intake');
    assert.equal(page.parentId, '100');
    assert.match(page.body, /&lt;script&gt;/);
    assert.equal(wiki.properties.get(page.id).value.key, key(1));
    assert.equal(wiki.properties.get(page.id).key, CONFLUENCE_DELIVERY_PROPERTY);

    const again = await deliverToConfluence(confluenceRecord({ deployment }), { env: ENV, request: wiki.request });
    assert.deepEqual([again.outcome, again.detail], ['delivered', '"STORY-9 — Intake" already holds this delivery.']);
    assert.equal(page.version, 1, 'a retry writes nothing');

    const later = await deliverToConfluence(confluenceRecord({ deployment, generation: 2, deliveryKey: key(2), markdown: '# Intake\n\nRevised.\n' }), { env: ENV, request: wiki.request });
    assert.deepEqual([later.outcome, later.detail], ['delivered', 'Updated "STORY-9 — Intake".']);
    assert.equal(page.version, 2);
    assert.match(page.body, /Revised\./);
    assert.equal(wiki.properties.get(page.id).value.generation, 2);

    const stale = await deliverToConfluence(confluenceRecord({ deployment, generation: 1, deliveryKey: key(3) }), { env: ENV, request: wiki.request });
    assert.deepEqual([stale.outcome, stale.detail], ['delivered', '"STORY-9 — Intake" already holds generation 2.']);
    assert.equal(page.version, 2, 'an older generation never writes over a newer one');
  });
}

test('a Confluence delivery says what a person has to do, and retries only what may pass by itself', async () => {
  const wiki = fakeConfluence();
  assert.deepEqual(await deliverToConfluence(confluenceRecord(), { env: {}, request: wiki.request }), {
    outcome: 'unavailable', code: 'STEP_ACTION_SECRET_MISSING', detail: 'Secret SFLOW_SECRET_WIKI_TOKEN is not set on this machine.'
  });
  const refused = await deliverToConfluence(confluenceRecord(), { env: { SFLOW_SECRET_WIKI_TOKEN: 'wrong' }, request: wiki.request });
  assert.deepEqual([refused.outcome, refused.code, refused.status], ['failed', 'STEP_ACTION_CONFLUENCE_REFUSED', 401]);
  wiki.script([503]);
  assert.equal((await deliverToConfluence(confluenceRecord(), { env: ENV, request: wiki.request })).outcome, 'retry');
  wiki.script(['timeout']);
  assert.equal((await deliverToConfluence(confluenceRecord(), { env: ENV, request: wiki.request })).code, 'STEP_ACTION_TIMEOUT');
  wiki.script([302]);
  assert.equal((await deliverToConfluence(confluenceRecord(), { env: ENV, request: wiki.request })).code, 'STEP_ACTION_REDIRECT_REFUSED');

  const missingParent = await deliverToConfluence({ ...confluenceRecord(), action: { ...confluenceRecord().action, targetSpec: { ...confluenceRecord().action.targetSpec, parentPage: '999' } } }, { env: ENV, request: wiki.request });
  assert.deepEqual([missingParent.outcome, missingParent.code], ['failed', 'STEP_ACTION_CONFLUENCE_NOT_FOUND']);
  assert.match(missingParent.detail, /^Parent page 999: HTTP 404/);

  // A page with the same title elsewhere in the space is never taken over.
  wiki.pages.set('150', { id: '150', title: 'STORY-9 — Intake', parentId: '1', spaceId: '9', version: 4, body: 'someone else' });
  const taken = await deliverToConfluence(confluenceRecord(), { env: ENV, request: wiki.request });
  assert.deepEqual([taken.outcome, taken.code], ['failed', 'STEP_ACTION_CONFLUENCE_TITLE_TAKEN']);
  assert.equal(wiki.pages.get('150').version, 4);

  const unrecorded = await deliverToConfluence({ ...confluenceRecord(), artifact: { path: 'a.md', sha256: null, problem: 'a.md is larger than 4 MiB, so it is not sent.' } }, { env: ENV, request: wiki.request });
  assert.deepEqual([unrecorded.outcome, unrecorded.code], ['failed', 'STEP_ACTION_ARTIFACT_UNAVAILABLE']);
});
