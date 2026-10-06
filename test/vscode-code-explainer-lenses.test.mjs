/**
 * Code Explainer lenses: concepts, entities, data flow and logic, read from the same harvest the
 * Code lens draws. The fixtures are shaped like what the language services answer (a Java server
 * names methods with their parameter types and, in its call hierarchy, their return types; the
 * TypeScript server reports a component bound to an arrow as a variable), so the lenses are tested
 * on the shapes they meet in the editor.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { buildCodeExplainerModel, displayName, SYMBOL_KIND } from '../apps/vscode/src/views/code-explainer-model.ts';
import { buildLenses, classifyModule, conceptWords, fieldType, maskRegexLiterals } from '../apps/vscode/src/views/code-explainer-lenses.ts';

function baseInput(overrides = {}) {
  return {
    repository: { name: 'repo', branch: 'main', head: 'abc1234' },
    story: null,
    change: { view: null, patch: null, patchFiles: [], base: null },
    files: [], calls: [], callStatus: {}, references: [], referenceStatus: {}, hovers: {},
    focus: null, depth: 1, view: 'full', modelEnabled: false,
    ...overrides
  };
}

/** The line a brace opened on the given line closes on. */
function blockEnd(lines, start) {
  let depth = 0;
  let opened = false;
  for (let index = start - 1; index < lines.length; index += 1) {
    for (const character of lines[index]) {
      if (character === '{') { depth += 1; opened = true; }
      else if (character === '}') { depth -= 1; if (opened && depth === 0) return index + 1; }
    }
  }
  return start;
}

const parameterTypes = (params) => params.split(',').map((part) => part.trim().replace(/@\w+\s+/g, ''))
  .filter(Boolean).map((part) => part.slice(0, part.lastIndexOf(' ')).trim()).join(', ');

/** An outline as a Java language server answers it: packages, classes, fields, typed method names. */
function javaOutline(text) {
  const lines = text.split('\n');
  const symbols = [];
  let container = null;
  lines.forEach((line, index) => {
    const at = index + 1;
    const pack = line.match(/^package\s+([\w.]+);/);
    if (pack) { symbols.push({ name: pack[1], kind: SYMBOL_KIND.Package, range: { start: at, end: at }, selection: { line: at, character: 8 }, children: [] }); return; }
    const type = line.match(/^public\s+(class|enum)\s+(\w+)/);
    if (type) {
      let first = at;
      while (first > 1 && /^\s*@/.test(lines[first - 2])) first -= 1;
      container = { name: type[2], kind: type[1] === 'enum' ? SYMBOL_KIND.Enum : SYMBOL_KIND.Class, range: { start: first, end: blockEnd(lines, at) }, selection: { line: at, character: line.indexOf(type[2]) }, children: [] };
      symbols.push(container);
      return;
    }
    if (!container || at > container.range.end) return;
    const field = line.match(/^\s+private\s+(?:final\s+)?[\w<>, ]+\s+(\w+);/);
    if (field) { container.children.push({ name: field[1], kind: SYMBOL_KIND.Field, range: { start: at, end: at }, selection: { line: at, character: line.indexOf(field[1]) }, children: [] }); return; }
    const method = line.match(/^\s+(?:public|private|protected)\s+(?:static\s+)?(?:([\w<>, [\]]+)\s+)?(\w+)\s*\(([^)]*)\)\s*\{/);
    if (method) {
      const constructor = method[2] === container.name;
      container.children.push({
        name: `${method[2]}(${parameterTypes(method[3])})`, kind: constructor ? SYMBOL_KIND.Constructor : SYMBOL_KIND.Method,
        detail: constructor ? '' : ` : ${method[1]}`, range: { start: at, end: blockEnd(lines, at) }, selection: { line: at, character: line.indexOf(`${method[2]}(`) }, children: []
      });
      return;
    }
    if (container.kind === SYMBOL_KIND.Enum) {
      for (const value of line.replace(/\/\/.*$/, '').split(',')) {
        const name = value.trim().match(/^([a-z_]\w*)$/i)?.[1];
        if (name) container.children.push({ name, kind: SYMBOL_KIND.EnumMember, range: { start: at, end: at }, selection: { line: at, character: line.indexOf(name) }, children: [] });
      }
    }
  });
  return symbols;
}

const CONTROLLER = `package org.example.api;

import org.example.rules.RuleEngineService;

@RestController
@RequestMapping(path = "/api/v1/rule-engine", produces = MediaType.APPLICATION_JSON_VALUE)
public class RuleEngineController {

    private final RuleEngineService ruleEngineService;

    public RuleEngineController(RuleEngineService ruleEngineService) {
        this.ruleEngineService = ruleEngineService;
    }

    @PostMapping(path = "/evaluate", consumes = MediaType.APPLICATION_JSON_VALUE)
    public EvaluateResponse evaluate(@Valid @RequestBody EvaluateRequest request) {
        boolean result = ruleEngineService.evaluate(request.getData(), request.getRule());
        return new EvaluateResponse(result);
    }
}`;

const SERVICE = `package org.example.rules;

@Service
public class RuleEngineService {

    public boolean evaluate(Map<String, Object> data, JsonNode rule) {
        if (rule == null || rule.isNull()) {
            throw new IllegalArgumentException("Rule cannot be null");
        }
        if (rule.isObject()) {
            ObjectNode obj = (ObjectNode) rule;
            if (obj.has("all")) {
                return evalGroup(data, obj.get("all"), true);
            } else if (obj.has("not")) {
                return !evaluate(data, obj.get("not"));
            } else {
                return evalCondition(data, obj);
            }
        }
        throw new IllegalArgumentException("Unsupported rule type");
    }

    private boolean evalGroup(Map<String, Object> data, JsonNode arrNode, boolean andLogic) {
        for (JsonNode child : arrNode) {
            boolean childRes = evaluate(data, child);
            if (andLogic && !childRes) return false;
        }
        return andLogic;
    }

    private boolean evalCondition(Map<String, Object> data, ObjectNode cond) {
        Object left = data.get(cond.get("field").asText());
        Object right = jsonToJava(cond.get("value"));
        switch (cond.get("op").asText()) {
            case "eq":
                return compare(left, right) == 0;
            case "gt":
                return compare(left, right) > 0;
            default:
                throw new IllegalArgumentException("Unknown operator");
        }
    }

    private Object jsonToJava(JsonNode node) {
        if (node.isIntegralNumber()) return node.asLong();
        return node.decimalValue();
    }

    private int compare(Object a, Object b) {
        BigDecimal na = toBigDecimalOrNull(a);
        BigDecimal nb = toBigDecimalOrNull(b);
        return na.compareTo(nb);
    }

    private BigDecimal toBigDecimalOrNull(Object obj) {
        if (obj instanceof BigDecimal bd) return bd;
        if (obj instanceof Number n) return new BigDecimal(n.doubleValue());
        return null;
    }
}`;

const REQUEST = `package org.example.api.dto;

public class EvaluateRequest {
    @NotNull
    private Map<String, Object> data;

    @NotNull
    private JsonNode rule;

    public Map<String, Object> getData() {
        return data;
    }

    public void setData(Map<String, Object> data) {
        this.data = data;
    }

    public JsonNode getRule() {
        return rule;
    }
}`;

const RESPONSE = `package org.example.api.dto;

public class EvaluateResponse {
    private boolean result;

    public EvaluateResponse(boolean result) {
        this.result = result;
    }

    public boolean isResult() {
        return result;
    }
}`;

const HANDLER = `package org.example.api;

@RestControllerAdvice
public class GlobalExceptionHandler {

    @ExceptionHandler(IllegalArgumentException.class)
    public ResponseEntity<Map<String, Object>> handleIllegalArgument(IllegalArgumentException ex) {
        Map<String, Object> body = new HashMap<>();
        body.put("message", ex.getMessage());
        return ResponseEntity.status(HttpStatus.BAD_REQUEST).body(body);
    }
}`;

const OPERATOR = `package org.example.rules;

public enum Operator {
    // Comparison
    eq, ne, gt,
    // Range
    between
}`;

const JAVA_FILES = {
  'src/main/java/org/example/api/RuleEngineController.java': CONTROLLER,
  'src/main/java/org/example/rules/RuleEngineService.java': SERVICE,
  'src/main/java/org/example/api/dto/EvaluateRequest.java': REQUEST,
  'src/main/java/org/example/api/dto/EvaluateResponse.java': RESPONSE,
  'src/main/java/org/example/api/GlobalExceptionHandler.java': HANDLER,
  'src/main/java/org/example/rules/Operator.java': OPERATOR
};

/** A call as the Java server's call hierarchy reports it: return types in names, ranges, the site. */
function javaCall(files, fromPath, fromName, toPath, toName, siteNeedle) {
  const find = (path, name) => {
    const outline = javaOutline(files[path]);
    for (const symbol of outline) for (const child of symbol.children ?? []) if (displayName(child.name) === name) return child;
    throw new Error(`${path}: no ${name}`);
  };
  const from = find(fromPath, fromName);
  const to = find(toPath, toName);
  const lines = files[fromPath].split('\n');
  const line = lines.findIndex((text, index) => index + 1 >= from.range.start && text.includes(siteNeedle)) + 1;
  const character = lines[line - 1].indexOf(`${toName}(`);
  const end = (path, symbol) => ({ path, name: `${symbol.name}${symbol.detail ?? ''}`, kind: symbol.kind, range: symbol.range, selection: symbol.selection, detail: path.replace(/^src\/main\/java\//, '').replace(/\.java$/, '').replace(/\//g, '.') });
  return { from: end(fromPath, from), to: end(toPath, to), sites: [line], positions: [{ line, character }] };
}

function javaInput(withCalls = true) {
  const files = Object.entries(JAVA_FILES).map(([path, text]) => ({ path, language: 'java', lines: text.split('\n'), symbols: javaOutline(text) }));
  const C = 'src/main/java/org/example/api/RuleEngineController.java';
  const S = 'src/main/java/org/example/rules/RuleEngineService.java';
  const calls = withCalls ? [
    javaCall(JAVA_FILES, C, 'evaluate', S, 'evaluate', 'ruleEngineService.evaluate('),
    javaCall(JAVA_FILES, S, 'evaluate', S, 'evalGroup', 'evalGroup(data'),
    javaCall(JAVA_FILES, S, 'evaluate', S, 'evalCondition', 'evalCondition(data'),
    javaCall(JAVA_FILES, S, 'evalGroup', S, 'evaluate', 'evaluate(data, child)'),
    javaCall(JAVA_FILES, S, 'evalCondition', S, 'jsonToJava', 'jsonToJava('),
    javaCall(JAVA_FILES, S, 'evalCondition', S, 'compare', 'compare(left, right) == 0'),
    javaCall(JAVA_FILES, S, 'compare', S, 'toBigDecimalOrNull', 'toBigDecimalOrNull(a)')
  ] : [];
  return baseInput({ files, calls });
}

function lensesOf(input) {
  const model = buildCodeExplainerModel(input, 'cx-test');
  return { model, lenses: buildLenses(input, model) };
}

test('names read as a person reads them, and a package line is not a class', () => {
  assert.equal(displayName('evaluate(Map<String, Object>, JsonNode)'), 'evaluate');
  assert.equal(displayName('testIsNull() : void'), 'testIsNull');
  assert.equal(displayName("test('adds')"), "test('adds')", 'a test title in parentheses is the name');
  const { model } = lensesOf(javaInput());
  const controller = model.symbols.filter((symbol) => symbol.file === 'src/main/java/org/example/api/RuleEngineController.java');
  assert.deepEqual(controller.map((symbol) => symbol.qualifiedName).sort(), ['RuleEngineController', 'RuleEngineController.RuleEngineController', 'RuleEngineController.evaluate']);
  // The call hierarchy's `evaluate(…) : boolean` is the outline's `evaluate(…)`: one symbol, with the edge.
  const evaluate = controller.find((symbol) => symbol.name === 'evaluate');
  assert.equal(evaluate.callees.length, 1);
  assert.equal(model.symbols.find((symbol) => symbol.id === evaluate.callees[0]).qualifiedName, 'RuleEngineService.evaluate');
});

test('a lambda reported on its own folds into its method, and one test reported at every call is one row', () => {
  const S = 'src/main/java/org/example/rules/RuleEngineService.java';
  const input = javaInput();
  const outline = javaOutline(SERVICE);
  const jsonToJava = outline[1].children.find((child) => child.name.startsWith('jsonToJava'));
  const lambda = { path: S, name: 'accept(JsonNode) : void', kind: SYMBOL_KIND.Method, range: { start: jsonToJava.range.start + 1, end: jsonToJava.range.start + 1 }, selection: { line: jsonToJava.range.start + 1, character: 20 }, detail: 'org.example.rules.RuleEngineService$1' };
  input.calls.push({ from: lambda, to: { path: S, name: `${jsonToJava.name}${jsonToJava.detail}`, kind: SYMBOL_KIND.Method, range: jsonToJava.range, selection: jsonToJava.selection, detail: 'org.example.rules.RuleEngineService' }, sites: [jsonToJava.range.start + 1] });
  const testFile = 'src/test/java/org/example/rules/RuleEngineServiceTest.java';
  for (const line of [12, 18, 24]) {
    input.calls.push({
      from: { path: testFile, name: 'testIsNull() : void', kind: SYMBOL_KIND.Method, range: { start: 10, end: 26 }, selection: { line, character: 8 }, detail: 'org.example.rules.RuleEngineServiceTest' },
      to: { path: S, name: 'evaluate(Map<String, Object>, JsonNode) : boolean', kind: SYMBOL_KIND.Method, range: outline[1].children[0].range, selection: outline[1].children[0].selection, detail: 'org.example.rules.RuleEngineService' },
      sites: [line]
    });
  }
  const { model } = lensesOf(input);
  assert.ok(!model.symbols.some((symbol) => /\$\d|accept/.test(symbol.qualifiedName)), 'no lambda row');
  const tests = model.symbols.filter((symbol) => symbol.file === testFile);
  assert.deepEqual(tests.map((symbol) => symbol.qualifiedName), ['RuleEngineServiceTest.testIsNull']);
});

test('concepts: each file placed in the architecture by the evidence it names, and the words the code is about', () => {
  const { lenses } = lensesOf(javaInput());
  const placed = Object.fromEntries(lenses.concepts.layers.flatMap((layer) => layer.modules.map((entry) => [entry.id.split('/').pop(), `${layer.id}: ${entry.reason}`])));
  assert.match(placed['RuleEngineController.java'], /^entry: declares HTTP routes \(@RestController\)$/);
  assert.match(placed['GlobalExceptionHandler.java'], /^cross-cutting: handles errors .*@RestControllerAdvice/);
  assert.match(placed['RuleEngineService.java'], /^logic: a service \(@Service\)$/);
  assert.match(placed['EvaluateRequest.java'], /^data: its name ends in Request$/);
  assert.match(placed['Operator.java'], /^data: it only declares fields, values and their accessors$/);
  const links = lenses.concepts.layerLinks.map((link) => `${link.from}>${link.to}`);
  assert.ok(links.includes('entry>logic'), links.join(', '));
  const words = lenses.concepts.concepts.map((concept) => concept.term);
  assert.ok(words.includes('rule') && words.includes('evaluate'), words.join(', '));
  assert.ok(!words.includes('eval'), 'a stem folds into its word');
  assert.match(lenses.concepts.summary, /^Its declarations talk most about .*Rule.*\. It has 1 entry-point file, 1 logic file, 3 data-shape files\.$/);
  assert.deepEqual(conceptWords('RuleEngineServiceTests'), ['rule', 'engine', 'service'], 'a generic word is kept (it only counts less), a plumbing word is dropped');
  assert.deepEqual(conceptWords('handleUserAccounts'), ['user', 'account'], 'plumbing words are dropped and plurals singular');
  assert.equal(classifyModule('src/components/Keypad.jsx', 'javascriptreact', 'export const Keypad = () => <div/>;', null).layer, 'ui');
  assert.equal(classifyModule('app/models/order.py', 'python', 'class Order:\n  id: int', null).layer, 'data');
  assert.equal(classifyModule('server/routes.js', 'javascript', "app.post('/orders', createOrder)", null).layer, 'entry');
});

test('entities: fields with their types, accessors folded in, enum values, links and who uses them', () => {
  const { lenses } = lensesOf(javaInput());
  const byName = Object.fromEntries(lenses.entities.entities.map((entity) => [entity.name, entity]));
  assert.deepEqual(Object.keys(byName).sort(), ['EvaluateRequest', 'EvaluateResponse', 'Operator'], 'services and controllers are behaviour, not entities');
  assert.deepEqual(byName.EvaluateRequest.fields.map((field) => [field.name, field.type, field.accessors.join('/')]), [['data', 'Map<String,Object>', 'get/set'], ['rule', 'JsonNode', 'get']]);
  assert.deepEqual(byName.EvaluateResponse.fields.map((field) => [field.name, field.type, field.accessors.join('/')]), [['result', 'boolean', 'is']]);
  assert.deepEqual(byName.Operator.values, ['eq', 'ne', 'gt', 'between']);
  assert.ok(byName.EvaluateRequest.usedBy.some((use) => use.how === 'takes' && use.symbol.includes('RuleEngineController.java')), 'the handler takes the request');
  assert.ok(byName.EvaluateResponse.usedBy.some((use) => use.symbol.includes('RuleEngineController.java')), 'and returns or builds the response');
  assert.equal(fieldType('    private List<Order> orders;', 'orders', 'java', null), 'List<Order>');
  assert.equal(fieldType('  total?: number;', 'total', 'typescript', null), 'number');
  assert.equal(fieldType('    val owner: Account', 'owner', 'kotlin', null), 'Account');
  assert.equal(fieldType('\tName string', 'Name', 'go', null), 'string');
});

test('data flow: from the route, what each call hands over, where it changes form, and where errors leave', () => {
  const { lenses } = lensesOf(javaInput());
  const flow = lenses.flow;
  const entry = flow.entries.find((item) => item.kind === 'http');
  assert.equal(entry.label, 'POST /api/v1/rule-engine/evaluate', 'the class prefix and the method route');
  const label = (id) => flow.nodes.find((node) => node.id === id)?.label;
  const path = flow.paths[entry.id].edges.map((id) => flow.edges.find((edge) => edge.id === id)).map((edge) => `${label(edge.from)} -${edge.kind}-> ${label(edge.to)}${edge.label ? ` [${edge.label}]` : ''}`);
  for (const expected of [
    'POST /api/v1/rule-engine/evaluate -call-> RuleEngineController.evaluate [request ← JSON body]',
    'RuleEngineController.evaluate -io-> HTTP response [returns EvaluateResponse]',
    'RuleEngineController.evaluate -call-> RuleEngineService.evaluate [data ← request.getData(), rule ← request.getRule() → result]',
    'RuleEngineService.evaluate -call-> RuleEngineService.evalCondition [data, cond ← obj → returned]',
    'RuleEngineService.compare -call-> RuleEngineService.toBigDecimalOrNull [obj ← a → na]',
    'RuleEngineService.evaluate -error-> GlobalExceptionHandler.handleIllegalArgument [throws IllegalArgumentException]',
    'GlobalExceptionHandler.handleIllegalArgument -io-> HTTP 400 response [status 400]'
  ]) assert.ok(path.includes(expected), `${expected}\n in\n${path.join('\n')}`);
  assert.ok(!path.some((line) => /getData|getRule|isNull|asText/.test(line.split(' [')[0])), 'accessors and library calls are not steps');
  const convert = flow.nodes.find((node) => node.label === 'RuleEngineService.toBigDecimalOrNull');
  assert.deepEqual(convert.conversions.map((entry) => entry.text), ['new BigDecimal(n.doubleValue())', '.doubleValue()']);
});

test('data flow without a language service: calls are matched by name and marked, and a bare call stays in its class', () => {
  const { lenses } = lensesOf(javaInput(false));
  const flow = lenses.flow;
  const label = (id) => flow.nodes.find((node) => node.id === id)?.label;
  const inferred = flow.edges.filter((edge) => edge.inferred).map((edge) => `${label(edge.from)} -> ${label(edge.to)}`);
  assert.ok(inferred.includes('RuleEngineController.evaluate -> RuleEngineService.evaluate'), 'the receiver names the service');
  assert.ok(!inferred.includes('RuleEngineService.evaluate -> RuleEngineController.evaluate'), 'a recursive evaluate(…) is not the controller\'s');
  assert.ok(!inferred.some((line) => /getData|getRule/.test(line)), 'accessors are not steps');
  assert.match(flow.notes[0], /matched by name in the text/);
});

test('logic: decisions, else-if chains, loops, switches, returns and throws, in order', () => {
  const { model, lenses } = lensesOf(javaInput());
  const steps = (name) => lenses.logic.flows[model.symbols.find((symbol) => symbol.qualifiedName === name).id].steps;
  const outline = (items, depth = 0) => items.flatMap((step) => {
    const pad = '  '.repeat(depth);
    if (step.k === 'step') return step.lines.map((line) => `${pad}${line.text}`);
    if (step.k === 'if') return [`${pad}if ${step.cond}`, ...outline(step.then, depth + 1), ...(step.else ? [`${pad}else`, ...outline(step.else, depth + 1)] : [])];
    if (step.k === 'loop') return [`${pad}${step.head}`, ...outline(step.body, depth + 1)];
    if (step.k === 'switch') return [`${pad}switch ${step.subject}`, ...step.cases.flatMap((entry) => [`${pad} case ${entry.label}`, ...outline(entry.body, depth + 2)])];
    return [`${pad}${step.k} ${step.text}`];
  });
  assert.deepEqual(outline(steps('RuleEngineService.evaluate')), [
    'if rule == null || rule.isNull()',
    '  throw new IllegalArgumentException("Rule cannot be null")',
    'if rule.isObject()',
    '  ObjectNode obj = (ObjectNode) rule',
    '  if obj.has("all")',
    '    return evalGroup(data, obj.get("all"), true)',
    '  else',
    '    if obj.has("not")',
    '      return !evaluate(data, obj.get("not"))',
    '    else',
    '      return evalCondition(data, obj)',
    'throw new IllegalArgumentException("Unsupported rule type")'
  ]);
  assert.deepEqual(outline(steps('RuleEngineService.evalGroup')), [
    'for JsonNode child : arrNode',
    '  boolean childRes = evaluate(data, child)',
    '  if andLogic && !childRes',
    '    return false',
    'return andLogic'
  ]);
  assert.deepEqual(outline(steps('RuleEngineService.evalCondition')).slice(2), [
    'switch cond.get("op").asText()',
    ' case "eq"',
    '    return compare(left, right) == 0',
    ' case "gt"',
    '    return compare(left, right) > 0',
    ' case otherwise',
    '    throw new IllegalArgumentException("Unknown operator")'
  ]);
});

const APP = `import { useState, useEffect, useCallback } from 'react';
import { Keypad } from './Keypad';
import { Display } from './Display';
import { evaluateExpression } from './evaluator';

export default function App() {
  const [expression, setExpression] = useState('');
  const [history, setHistory] = useState(() => JSON.parse(localStorage.getItem('history')) || []);

  useEffect(() => {
    localStorage.setItem('history', JSON.stringify(history));
  }, [history]);

  const handleDigit = useCallback(
    (digit) => {
      setExpression((prev) => prev + digit);
    },
    []
  );

  const handleEquals = useCallback(() => {
    const evalRes = evaluateExpression(expression);
    const entry = { expression: expression, result: evalRes.result };
    setHistory((prev) => [entry, ...prev]);
  }, [expression]);

  return (
    <main>
      <Display expression={expression} />
      <Keypad onDigit={handleDigit} onEquals={handleEquals} />
    </main>
  );
}`;

const KEYPAD = `export const Keypad = ({
  onDigit,
  onEquals,
}) => {
  const handleBtn = (fn, value) => {
    fn(value);
  };
  return (
    <div>
      <button onClick={() => handleBtn(onDigit, '7')}>7</button>
      <button onClick={() => handleBtn(onEquals)}>=</button>
    </div>
  );
};`;

const DISPLAY = `export const Display = ({ expression }) => {
  return <output>{expression || ' '}</output>;
};`;

const EVALUATOR = `export const evaluateExpression = (expr) => {
  if (!expr || expr.trim() === '') return { result: '0', error: null };
  try {
    const sanitized = expr
      .replace(/×/g, '*')
      .replace(/√\\(([^)]+)\\)/g, 'sqrt($1)');
    return { result: String(sanitized.length), error: null };
  } catch (err) {
    return { result: 'Error', error: err.message };
  }
};`;

/** An outline as the TypeScript server answers it: arrow components and hooks are variables. */
function reactInput() {
  const variable = (name, start, end, children = []) => ({ name, kind: SYMBOL_KIND.Variable, range: { start, end }, selection: { line: start, character: 0 }, children });
  const at = (text, needle) => text.split('\n').findIndex((line) => line.includes(needle)) + 1;
  const callback = (name, start, end) => ({ name, kind: SYMBOL_KIND.Function, range: { start, end }, selection: { line: start, character: 0 }, children: [] });
  const named = (text, name, needle, end) => { const line = at(text, needle); const value = variable(name, line, end ?? line); value.selection.character = text.split('\n')[line - 1].indexOf(name); return value; };
  const appSymbols = [{
    name: 'App', kind: SYMBOL_KIND.Function, range: { start: at(APP, 'export default function App'), end: APP.split('\n').length }, selection: { line: at(APP, 'export default function App'), character: 24 },
    children: [
      named(APP, 'expression', 'const [expression'), named(APP, 'setExpression', 'const [expression'),
      named(APP, 'history', 'const [history'), named(APP, 'setHistory', 'const [history'),
      callback('useEffect() callback', at(APP, 'useEffect(() =>'), at(APP, '}, [history]);')),
      { ...named(APP, 'handleDigit', 'const handleDigit', at(APP, '    []') + 1), children: [callback('useCallback() callback', at(APP, '(digit) =>'), at(APP, '    []') - 1)] },
      { ...named(APP, 'handleEquals', 'const handleEquals', at(APP, '}, [expression]);')), children: [callback('useCallback() callback', at(APP, 'const handleEquals'), at(APP, '}, [expression]);'))] }
    ]
  }];
  const keypad = [{ ...named(KEYPAD, 'Keypad', 'export const Keypad', KEYPAD.split('\n').length), children: [named(KEYPAD, 'handleBtn', 'const handleBtn', at(KEYPAD, '  };')), named(KEYPAD, 'onDigit', '  onDigit,'), named(KEYPAD, 'onEquals', '  onEquals,')] }];
  const display = [{ ...named(DISPLAY, 'Display', 'export const Display', 3), children: [named(DISPLAY, 'expression', 'export const Display')] }];
  const evaluator = [named(EVALUATOR, 'evaluateExpression', 'export const evaluateExpression', EVALUATOR.split('\n').length)];
  const files = [
    { path: 'src/App.jsx', language: 'javascriptreact', lines: APP.split('\n'), symbols: appSymbols },
    { path: 'src/Keypad.jsx', language: 'javascriptreact', lines: KEYPAD.split('\n'), symbols: keypad },
    { path: 'src/Display.jsx', language: 'javascriptreact', lines: DISPLAY.split('\n'), symbols: display },
    { path: 'src/evaluator.js', language: 'javascript', lines: EVALUATOR.split('\n'), symbols: evaluator }
  ];
  return baseInput({ files });
}

test('React: a component whose props span lines is a function, and a hook-wrapped handler is one too', () => {
  const { model } = lensesOf(reactInput());
  const names = model.symbols.map((symbol) => symbol.qualifiedName);
  for (const name of ['Keypad', 'Keypad.handleBtn', 'App.handleDigit', 'App.handleEquals', 'Display', 'evaluateExpression']) assert.ok(names.includes(name), `${name} in ${names.join(', ')}`);
});

test('React data flow: a click reaches the parent handler through its prop, sets state, and state reaches the screen and storage', () => {
  const { lenses } = lensesOf(reactInput());
  const flow = lenses.flow;
  const click = flow.entries.find((entry) => entry.label === 'click in Keypad');
  assert.ok(click, flow.entries.map((entry) => entry.label).join(', '));
  const label = (id) => flow.nodes.find((node) => node.id === id)?.label;
  const path = flow.paths[click.id].edges.map((id) => flow.edges.find((edge) => edge.id === id)).map((edge) => `${label(edge.from)} -${edge.kind}-> ${label(edge.to)}${edge.label ? ` [${edge.label}]` : ''}`);
  for (const expected of [
    'click -call-> Keypad.handleBtn',
    'click -prop-> App.handleDigit [onDigit (prop)]',
    'click -prop-> App.handleEquals [onEquals (prop)]',
    'App.handleDigit -writes-> expression [setExpression((prev) => prev + digit)]',
    'App.handleEquals -writes-> history [setHistory((prev) => [entry, ...prev])]',
    'expression -renders-> Display [as expression]',
    'history -io-> Browser storage [when it changes (useEffect)]',
    'Display -renders-> The screen [renders]',
    'Browser storage -reads-> history [initial value]'
  ]) assert.ok(path.includes(expected), `${expected}\n in\n${path.join('\n')}`);
  const equals = flow.edges.find((edge) => label(edge.from) === 'App.handleEquals' && label(edge.to) === 'evaluateExpression');
  assert.ok(equals?.inferred, 'an imported function the service did not resolve is matched by name');
  assert.equal(equals.label, 'expr ← expression → evalRes');
});

test('React entities: component inputs, objects built in code, and the object a function returns', () => {
  const { lenses } = lensesOf(reactInput());
  const shown = lenses.entities.entities.map((entity) => `${entity.kind} ${entity.name}: ${entity.fields.map((field) => field.name + (field.type ? `:${field.type}` : '')).join(', ')}`);
  for (const expected of ['props Keypad props: onDigit, onEquals', 'props Display props: expression', 'shape handleEquals: entry: expression, result', 'shape evaluateExpression result: result:string, error:null']) {
    assert.ok(shown.includes(expected), `${expected}\n in\n${shown.join('\n')}`);
  }
});

test('regular expressions are blanked so their brackets never unbalance a parser, and division is left alone', () => {
  assert.equal(maskRegexLiterals("x.replace(/\\((.*)\\)/g, 'a')"), "x.replace(/        /g, 'a')");
  assert.equal(maskRegexLiterals('const half = total / 2 / count;'), 'const half = total / 2 / count;');
  const { model, lenses } = lensesOf(reactInput());
  const evaluate = lenses.logic.flows[model.symbols.find((symbol) => symbol.qualifiedName === 'evaluateExpression').id].steps;
  assert.deepEqual(evaluate.map((step) => step.k), ['if', 'try']);
  assert.equal(evaluate[1].catches[0].label, 'err');
  assert.equal(evaluate[1].body.at(-1).k, 'return');
});

test('logic in Python and Go: indentation blocks, elif chains, loops, try/except, match, and conditions without parentheses', () => {
  const python = `def classify(order):
    if order.total > 100:
        tier = "gold"
    elif order.total > 10:
        tier = "silver"
    else:
        tier = "basic"
    for item in order.items:
        if not item.ok:
            raise ValueError("bad item")
    try:
        save(order)
    except IOError as error:
        log(error)
    match tier:
        case "gold":
            return 2
        case _:
            return 1
`;
  const go = `package shop

func Discount(total int) int {
	if total > 100 {
		return 10
	} else if total > 50 {
		return 5
	}
	for i := 0; i < 3; i++ {
		total -= i
	}
	switch total {
	case 1:
		return 1
	default:
		return 0
	}
}
`;
  const input = baseInput({
    files: [
      { path: 'shop/orders.py', language: 'python', lines: python.split('\n'), symbols: null },
      { path: 'shop/discount.go', language: 'go', lines: go.split('\n'), symbols: null }
    ]
  });
  const { model, lenses } = lensesOf(input);
  const kinds = (items) => items.map((step) => step.k === 'if' ? `if(${kinds(step.then)}${step.else ? `|${kinds(step.else)}` : ''})`
    : step.k === 'loop' ? `loop(${kinds(step.body)})` : step.k === 'switch' ? `switch(${step.cases.map((entry) => `${entry.label}:${kinds(entry.body)}`).join(';')})`
      : step.k === 'try' ? `try(${kinds(step.body)}/${step.catches.map((entry) => `${entry.label}:${kinds(entry.body)}`).join(';')})` : step.k).join(',');
  const classify = lenses.logic.flows[model.symbols.find((symbol) => symbol.name === 'classify').id];
  assert.equal(kinds(classify.steps), 'if(step|if(step|step)),loop(if(throw)),try(step/IOError as error:step),switch("gold":return;otherwise:return)');
  const discount = lenses.logic.flows[model.symbols.find((symbol) => symbol.name === 'Discount').id];
  assert.equal(kinds(discount.steps), 'if(return|if(return)),loop(step),switch(1:return;otherwise:return)');
  assert.equal(discount.steps[0].cond, 'total > 100');
});
