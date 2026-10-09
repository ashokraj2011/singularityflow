/**
 * The bundled Python semantic pack: Pyright (shipped with Singularity Flow, run without any Python
 * interpreter) resolves calls and overrides, the answers join the structural preview, and
 * repository knowledge follows a call through an abstract service to its implementations.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { bundledAstAdapters } from '../src/ast-adapter-contract.mjs';
import { astCommand, buildAstCache } from '../src/ast-intelligence.mjs';
import { discoverProjectBindings } from '../src/ast-project-binding.mjs';
import { astSemanticWarmCommand } from '../src/ast-semantic-warm.mjs';
import { LanguageServerConnection, repositoryPath } from '../src/ast-packs/python-core.mjs';
import { buildKnowledge } from '../src/knowledge/store.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pyright = (() => { try { return createRequire(import.meta.url).resolve('pyright/package.json'); } catch { return null; } })();

function git(cwd, ...args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1' } });
  if (result.status !== 0) throw new Error(`git ${args.join(' ')}\n${result.stderr}`);
  return result.stdout.trim();
}

async function repository(t, files) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'sflow-ast-python-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  for (const [relative, text] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(directory, relative)), { recursive: true });
    await writeFile(path.join(directory, relative), text);
  }
  git(directory, 'init', '-q', '-b', 'main');
  git(directory, 'add', '-A');
  git(directory, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.com', 'commit', '-qm', 'Fixture');
  return directory;
}

// A FastAPI route depends on an abstract service; which implementation runs is injected.
const FILES = {
  'pyproject.toml': '[project]\nname = "shop"\nversion = "0"\ndependencies = ["fastapi"]\n',
  'shop/__init__.py': '',
  'shop/ports.py': `from abc import ABC, abstractmethod


class OrderService(ABC):
    @abstractmethod
    def place(self, order: "Order") -> "Order":
        ...

    def describe(self) -> str:
        return type(self).__name__


class Order:
    def __init__(self, sku: str, quantity: int) -> None:
        self.sku = sku
        self.quantity = quantity

    def total(self) -> int:
        return self.quantity * 10
`,
  'shop/service.py': `from shop.ports import Order, OrderService
from shop import audit


class StandardOrderService(OrderService):
    def place(self, order: Order) -> Order:
        self._check(order)
        audit.record(order.sku)
        return order

    def _check(self, order: Order) -> None:
        if order.total() <= 0:
            raise ValueError("empty order")


class VipOrderService(StandardOrderService):
    def place(self, order: Order) -> Order:
        return super().place(order)
`,
  'shop/audit.py': `import logging

log = logging.getLogger(__name__)


def record(sku: str) -> None:
    log.info("placed %s", sku)
`,
  'shop/api.py': `from fastapi import APIRouter, Depends

from shop.ports import Order, OrderService
from shop.service import StandardOrderService

router = APIRouter()


def get_service() -> OrderService:
    return StandardOrderService()


@router.post("/orders")
def create_order(sku: str, quantity: int, service: OrderService = Depends(get_service)) -> dict:
    order = service.place(Order(sku, quantity))
    return {"sku": order.sku, "by": service.describe()}
`
};

async function warm(directory, project = 'python:.') {
  const options = { semantic: true, provider: 'sflow-python-pyright', profile: 'default', project };
  const plan = await astSemanticWarmCommand(directory, { ...options, 'dry-run': true });
  await astSemanticWarmCommand(directory, { ...options, confirm: plan.confirmation });
  return plan;
}

test('the language-server connection frames requests and answers the server\'s own requests', async () => {
  const toServer = new PassThrough();
  const fromServer = new PassThrough();
  const connection = new LanguageServerConnection(toServer, fromServer, { respond: (method) => (method === 'workspace/configuration' ? [{}] : null) });
  const frame = (message) => {
    const body = Buffer.from(JSON.stringify({ jsonrpc: '2.0', ...message }));
    return Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`), body]);
  };
  const sent = [];
  toServer.on('data', (chunk) => sent.push(chunk.toString()));
  const answer = connection.request('initialize', {});
  // A server request and the answer arrive split across chunks.
  const bytes = Buffer.concat([frame({ id: 7, method: 'workspace/configuration', params: { items: [{}] } }), frame({ id: 1, result: { ok: true } })]);
  fromServer.write(bytes.subarray(0, 25));
  fromServer.write(bytes.subarray(25));
  assert.deepEqual(await answer, { ok: true });
  assert.ok(sent.join('').includes('"id":7,"result":[{}]'));
  assert.equal(repositoryPath('/repo', 'file:///repo/shop/api.py'), 'shop/api.py');
  assert.equal(repositoryPath('/repo', 'file:///elsewhere/typeshed/builtins.pyi'), null);
  assert.equal(repositoryPath('/repo', 'file:///repo/.venv/lib/x.py'), null);
});

test('Pyright resolves calls, constructors, super() and overrides after an explicit warm-up', { skip: !pyright }, async (t) => {
  const adapters = await bundledAstAdapters();
  assert.deepEqual(adapters.filter((adapter) => adapter.id === 'sflow-python-pyright').map((adapter) => `${adapter.stage}:${adapter.languages}`), ['semantic:python']);
  const directory = await repository(t, FILES);
  const before = await buildAstCache(directory, { all: true });
  assert.equal(before.status, 'complete', 'an unwarmed Python project is not a degradation');
  assert.equal(before.facts.filter((fact) => fact.assurance === 'semantic').length, 0);

  const plan = await warm(directory);
  assert.deepEqual(plan.commands.map((command) => `${command.kind}:${command.executable}`), ['toolchain-version:node'], 'no Python interpreter or pip is run');
  assert.equal(plan.effects.network, 'none');
  const built = await buildAstCache(directory, { all: true });
  assert.equal(built.status, 'complete');
  const names = new Map(built.facts.filter((fact) => fact.kind === 'symbol').map((fact) => [fact.id, fact.qualifiedName]));
  const edges = built.facts.filter((fact) => fact.kind === 'relationship' && fact.assurance === 'semantic')
    .map((fact) => `${fact.type} ${names.get(fact.sourceId)} -> ${names.get(fact.target)}`).sort();
  assert.deepEqual(edges, [
    'calls StandardOrderService._check -> Order.total',
    'calls StandardOrderService.place -> StandardOrderService._check',
    // `logging` and the FastAPI decorator are library code: left out.
    'calls StandardOrderService.place -> record',
    'calls VipOrderService.place -> StandardOrderService.place',
    'calls create_order -> Order',
    'calls create_order -> OrderService.describe',
    'calls create_order -> OrderService.place',
    'calls get_service -> StandardOrderService',
    'overrides StandardOrderService.place -> OrderService.place',
    'overrides VipOrderService.place -> OrderService.place',
    'overrides VipOrderService.place -> StandardOrderService.place'
  ]);
});

test('knowledge follows an injected abstract service to its implementations', { skip: !pyright }, async (t) => {
  const directory = await repository(t, FILES);
  await warm(directory);
  const { metrics, graph, repository: info } = (await buildKnowledge(directory, { history: false })).knowledge;
  assert.deepEqual(info.frameworks, ['FastAPI']);
  assert.deepEqual(metrics.callResolution.providers, ['sflow-python-pyright']);
  assert.equal(metrics.callsMatchedByName, 0);
  for (const target of ['OrderService.place', 'StandardOrderService.place', 'VipOrderService.place']) {
    assert.ok(graph.calls.some(([from, to, how]) => from === 'create_order' && to === target && how === 'resolved'), `${target}: ${JSON.stringify(graph.calls)}`);
  }
  assert.equal(metrics.invalidCitations, 0);
});

test('Python files without project metadata form a standalone project the pack can warm', { skip: !pyright }, async (t) => {
  const directory = await repository(t, {
    'tools/report.py': 'def total(values):\n    return sum(values)\n\n\ndef main():\n    print(total([1, 2]))\n'
  });
  const discovered = await discoverProjectBindings(directory);
  assert.deepEqual(discovered.bindings.map((binding) => `${binding.projectKind}:${binding.root}`), ['python-standalone:.']);
  await warm(directory, 'python-standalone:.');
  const built = await buildAstCache(directory, { all: true });
  assert.equal(built.facts.filter((fact) => fact.type === 'calls' && fact.assurance === 'semantic').length, 1);
});

test('pack list reports the Python pack as bundled', async () => {
  const listed = await astCommand(root, ['pack', 'list'], {});
  assert.equal(listed.packs.find((pack) => pack.id === 'sflow-python-pyright')?.source, pyright ? 'bundled' : undefined);
});
