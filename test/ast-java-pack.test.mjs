/**
 * The bundled Java semantic pack: the machine's JDK resolves calls and overrides, the answers join
 * the Java structural preview's declarations, and repository knowledge follows a call through an
 * interface to its implementations (dependency injection in Spring or Micronaut).
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { bundledAstAdapters } from '../src/ast-adapter-contract.mjs';
import { astCommand, buildAstCache } from '../src/ast-intelligence.mjs';
import { bindingForFile } from '../src/ast-project-binding.mjs';
import { astSemanticWarmCommand } from '../src/ast-semantic-warm.mjs';
import { javaSourceRoot, parseResolverOutput } from '../src/ast-packs/java-core.mjs';
import { joinSemanticEdges } from '../src/ast-packs/semantic-join.mjs';
import { extractPolyglotSyntax } from '../src/ast-packs/polyglot-syntax-core.mjs';
import { buildKnowledge } from '../src/knowledge/store.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const jdk = spawnSync('javac', ['-version'], { encoding: 'utf8' }).status === 0;

function git(cwd, ...args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1' } });
  if (result.status !== 0) throw new Error(`git ${args.join(' ')}\n${result.stderr}`);
  return result.stdout.trim();
}

async function repository(t, files) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'sflow-ast-java-'));
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

const API = 'api/src/main/java/com/acme/api';
const SERVICE = 'service/src/main/java/com/acme/service';

// A two-module build: a Micronaut controller in one module calls a service interface in the other,
// whose implementation is injected at run time. No framework jar is present, as in a fresh clone.
const FILES = {
  'pom.xml': '<project><artifactId>shop</artifactId><packaging>pom</packaging><modules><module>api</module><module>service</module></modules></project>\n',
  'api/pom.xml': '<project><artifactId>api</artifactId><dependencies><dependency><groupId>io.micronaut</groupId><artifactId>micronaut-http-server-netty</artifactId></dependency></dependencies></project>\n',
  'service/pom.xml': '<project><artifactId>service</artifactId></project>\n',
  [`${API}/OrderController.java`]: `package com.acme.api;

import com.acme.service.Order;
import com.acme.service.OrderService;
import io.micronaut.http.annotation.Body;
import io.micronaut.http.annotation.Controller;
import io.micronaut.http.annotation.Post;

@Controller("/orders")
public class OrderController {
    private final OrderService service;
    private final AuditClient audit;

    public OrderController(OrderService service, AuditClient audit) {
        this.service = service;
        this.audit = audit;
    }

    @Post("/place")
    public Order place(
            @Body Order order,
            String channel) {
        audit.record(order.getId());
        return service.place(order);
    }

    public java.util.List<String> ids(java.util.List<Order> orders) {
        return orders.stream().map(Order::getId).map(this::normalize).toList();
    }

    private String normalize(String id) {
        return id.trim();
    }
}
`,
  [`${API}/AuditClient.java`]: `package com.acme.api;

import io.micronaut.http.annotation.Post;
import io.micronaut.http.client.annotation.Client;

@Client("/audit")
public interface AuditClient {
    @Post("/record")
    void record(String orderId);
}
`,
  [`${SERVICE}/OrderService.java`]: `package com.acme.service;

public interface OrderService {
    Order place(Order order);
}
`,
  [`${SERVICE}/OrderServiceImpl.java`]: `package com.acme.service;

import jakarta.inject.Singleton;

@Singleton
public class OrderServiceImpl extends BaseService implements OrderService {
    private final OrderRepository repository;

    public OrderServiceImpl(OrderRepository repository) {
        this.repository = repository;
    }

    @Override
    public Order place(Order order) {
        check(order);
        Order saved = repository.save(order);
        repository.findByCustomer(order.getCustomer()).forEach(previous -> log(previous.getId()));
        return saved;
    }

    @Override
    protected void check(Order order) {
        if (order.getId() == null) throw new IllegalArgumentException("id");
    }
}
`,
  [`${SERVICE}/BaseService.java`]: `package com.acme.service;

public abstract class BaseService {
    protected abstract void check(Order order);

    protected void log(String message) {
        System.out.println(message);
    }
}
`,
  [`${SERVICE}/OrderRepository.java`]: `package com.acme.service;

import java.util.List;
import org.springframework.data.jpa.repository.JpaRepository;

public interface OrderRepository extends JpaRepository<Order, String> {
    List<Order> findByCustomer(String customer);
}
`,
  [`${SERVICE}/Order.java`]: `package com.acme.service;

public class Order {
    private String id;
    private String customer;

    public String getId() {
        return id;
    }

    public String getCustomer() {
        return customer;
    }
}
`
};

function symbols(source) {
  return extractPolyglotSyntax(Buffer.from(source), 'java').facts.filter((fact) => fact.kind === 'symbol')
    .map((fact) => `${fact.line} ${fact.declarationKind} ${fact.qualifiedName}`);
}

test('the Java preview records members, not statements, across multi-line, late-brace and anonymous declarations', () => {
  assert.deepEqual(symbols(`package p;
public interface Interceptor
extends Callback
{
  Object intercept(Object target,
      Proxy proxy) throws Throwable;
}
class Cart {
  static final Hook EMPTY = new Hook(Object.class, java.util.List.of()) {
    public void run() {
      throw new IllegalStateException("never");
    }
  };
  Cart(Store store) {
    this.total = total(store);
  }
  @Override
  public int total(
      @Valid Store store) {
    return store.sum(new Line(1));
  }
}
`), [
    '2 interface p.Interceptor',
    '5 method p.Interceptor.intercept',
    '8 class p.Cart',
    '10 method p.Cart.run',
    '14 constructor p.Cart.Cart',
    '18 method p.Cart.total'
  ]);
});

test('resolver answers join the preview by name and line, and ends the preview lacks contribute nothing', async () => {
  const cart = 'package p;\nclass Cart {\n  void add() { save(); }\n  void save() {}\n}\n';
  const output = [
    ['call', 'src/p/Cart.java', 'add', 3, 'src/p/Cart.java', 'save', 4, 3, 16, 3, 22],
    ['call', 'src/p/Cart.java', 'add', 3, 'src/p/Cart.java', 'save', 4, 3, 30, 3, 36],
    ['override', 'src/p/Cart.java', 'save', 4, 'src/p/Store.java', 'save', 2, 4, 8, 4, 12],
    ['call', 'src/p/Cart.java', 'add', 3, 'src/p/Gone.java', 'missing', 9, 3, 1, 3, 2],
    ['bogus line']
  ].map((fields) => fields.join('\t')).join('\n');
  const edges = parseResolverOutput(output);
  assert.deepEqual(edges.map((edge) => edge.type), ['calls', 'calls', 'overrides', 'calls']);
  const skeletons = {
    'src/p/Cart.java': extractPolyglotSyntax(Buffer.from(cart), 'java').facts,
    'src/p/Store.java': extractPolyglotSyntax(Buffer.from('package p;\ninterface Store {\n  void save();\n}\n'), 'java').facts
  };
  // The interface method is on line 3 of Store.java, not 2: an end the preview does not have.
  const { byPath, unjoined } = await joinSemanticEdges(edges, ['src/p/Cart.java'], async (relative) => skeletons[relative] ?? null);
  const facts = byPath.get('src/p/Cart.java');
  assert.equal(unjoined, 2);
  assert.equal(facts.length, 1, 'one edge per caller and callee');
  assert.equal(facts[0].type, 'calls');
  assert.match(facts[0].sourceId, /^java:p\.Cart\.add#method:/);
  assert.match(facts[0].target, /^java:p\.Cart\.save#method:/);
  assert.equal(facts[0].assurance, 'semantic');

  assert.equal(javaSourceRoot('api/src/main/java/com/acme/api/OrderController.java', 'com.acme.api'), 'api/src/main/java');
  assert.equal(javaSourceRoot('com/acme/Cart.java', 'com.acme'), '.');
  assert.equal(javaSourceRoot('Cart.java', ''), '.');
  assert.equal(javaSourceRoot('src/elsewhere/Cart.java', 'com.acme'), null);
});

test('a module file is analyzed in the warmed project that contains it', () => {
  const binding = (root, complete) => ({ projectKind: 'maven', root, complete });
  const parent = binding('.', true);
  const module = binding('api', false);
  assert.equal(bindingForFile([parent, module], 'api/src/A.java', ['maven']), parent, 'a warmed parent covers its modules');
  const warmedModule = binding('api', true);
  assert.equal(bindingForFile([parent, warmedModule], 'api/src/A.java', ['maven']), warmedModule, 'a warmed module takes precedence');
  assert.equal(bindingForFile([binding('.', false), module], 'api/src/A.java', ['maven']), module, 'otherwise the innermost project');
});

test('the JDK resolves calls across modules, lambdas, method references and overrides, after an explicit warm-up', { skip: !jdk }, async (t) => {
  const adapters = await bundledAstAdapters();
  assert.deepEqual(adapters.filter((adapter) => adapter.id === 'sflow-java').map((adapter) => `${adapter.stage}:${adapter.languages}`), ['semantic:java']);
  const directory = await repository(t, FILES);
  const before = await buildAstCache(directory, { all: true });
  assert.equal(before.status, 'complete', 'an unwarmed Java project is not a degradation');
  assert.equal(before.facts.filter((fact) => fact.assurance === 'semantic').length, 0);

  const plan = await astSemanticWarmCommand(directory, { semantic: true, provider: 'sflow-java', profile: 'default', project: 'maven:.', 'dry-run': true });
  assert.equal(plan.ready, true);
  assert.deepEqual(plan.commands.map((command) => `${command.kind}:${command.executable}`), ['toolchain-version:java']);
  assert.equal(plan.effects.executesRepositoryConfiguration, false, 'Maven is never run');
  assert.equal(plan.effects.network, 'none');
  await astSemanticWarmCommand(directory, { semantic: true, provider: 'sflow-java', profile: 'default', project: 'maven:.', confirm: plan.confirmation });

  const built = await buildAstCache(directory, { all: true });
  assert.equal(built.status, 'complete');
  const names = new Map(built.facts.filter((fact) => fact.kind === 'symbol').map((fact) => [fact.id, fact.qualifiedName.replace('com.acme.', '')]));
  const edges = built.facts.filter((fact) => fact.kind === 'relationship' && fact.assurance === 'semantic')
    .map((fact) => `${fact.type} ${names.get(fact.sourceId)} -> ${names.get(fact.target)}`).sort();
  assert.deepEqual(edges, [
    'calls api.OrderController.ids -> api.OrderController.normalize',
    'calls api.OrderController.ids -> service.Order.getId',
    'calls api.OrderController.place -> api.AuditClient.record',
    'calls api.OrderController.place -> service.Order.getId',
    // The declared method: which implementation runs is decided by injection.
    'calls api.OrderController.place -> service.OrderService.place',
    'calls service.OrderServiceImpl.check -> service.Order.getId',
    // `repository.save` is JpaRepository's, a library method: left out. The finder is the repository's own.
    'calls service.OrderServiceImpl.place -> service.BaseService.log',
    'calls service.OrderServiceImpl.place -> service.Order.getCustomer',
    'calls service.OrderServiceImpl.place -> service.Order.getId',
    'calls service.OrderServiceImpl.place -> service.OrderRepository.findByCustomer',
    'calls service.OrderServiceImpl.place -> service.OrderServiceImpl.check',
    'overrides service.OrderServiceImpl.check -> service.BaseService.check',
    'overrides service.OrderServiceImpl.place -> service.OrderService.place'
  ]);
});

test('knowledge follows a call through an interface to its implementation, and reads Micronaut routes and clients', { skip: !jdk }, async (t) => {
  const directory = await repository(t, FILES);
  const unwarmed = (await buildKnowledge(directory, { history: false })).knowledge;
  assert.equal(unwarmed.metrics.callResolution.status, 'not-warmed');
  assert.deepEqual(unwarmed.repository.frameworks, ['Micronaut']);

  const plan = await astSemanticWarmCommand(directory, { semantic: true, provider: 'sflow-java', profile: 'default', project: 'maven:.', 'dry-run': true });
  await astSemanticWarmCommand(directory, { semantic: true, provider: 'sflow-java', profile: 'default', project: 'maven:.', confirm: plan.confirmation });
  const { metrics, graph, items } = (await buildKnowledge(directory, { history: false })).knowledge;
  assert.deepEqual(metrics.callResolution.providers, ['sflow-java']);
  assert.equal(metrics.callsMatchedByName, 0);
  assert.ok(graph.calls.some(([from, to, how]) => from === 'OrderController.place' && to === 'OrderServiceImpl.place' && how === 'resolved'),
    JSON.stringify(graph.calls));
  assert.ok(graph.calls.every(([from, to]) => from !== to), 'an entry point leading into its handler is not a call');
  const entries = items.filter((item) => item.kind === 'entry-point').map((item) => item.statement.label);
  assert.deepEqual(entries, ['POST /orders/place'], 'the @Client interface declares a call out, not a served endpoint');
  assert.equal(metrics.invalidCitations, 0);
});

test('pack list reports the Java pack as bundled', async () => {
  const listed = await astCommand(root, ['pack', 'list'], {});
  assert.equal(listed.packs.find((pack) => pack.id === 'sflow-java')?.source, 'bundled');
});
