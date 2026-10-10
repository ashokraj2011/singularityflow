/**
 * Validation constraints declared on request and data types: Java/Kotlin Bean Validation
 * (`@NotNull`, `@Min`, `@Size`, `@Pattern`, …, on fields, record components and Kotlin `@field:`),
 * pydantic (`Field(gt=…)`, `conint`, `constr`), zod (`z.object({ … })` chains) and class-validator
 * decorators. Each field yields its constraints as data (`required`, `min`, `max`, `length-min`,
 * `length-max`, `pattern`, `email`, …) with the line it came from.
 *
 * A Bean Validation constraint is enforced only where an endpoint asks for it (`@Valid` /
 * `@Validated` on a request body); `validatedTypes` reports those types, so a constraint on a type no
 * endpoint validates can be reported as declared but not enforced. Like the other readers these are
 * pattern readers over masked source, with values read back from the original line.
 */
import path from 'node:path';

import { isTestPath } from '../code-intelligence/generated/code-explainer-model.mjs';
import { maskedLines } from './producers.mjs';

const MODIFIERS = /\b(?:private|protected|public|final|static|transient|volatile|readonly|declare|override|lateinit|open)\s+/gu;
const ANNOTATION = /@(?:field:|get:|param:)?([A-Z]\w*)(\s*\((?:[^()]|\([^()]*\))*\))?/gu;

function number(value) {
  const parsed = Number(String(value ?? '').replace(/^["']|["']$/gu, '').replace(/[lLfFdD]$/u, ''));
  return Number.isFinite(parsed) ? parsed : null;
}

/** `(min = 1, max = 20, message = "…")` or `("10.00")` as `{ min: '1', max: '20', message: '…', 0: '10.00' }`. */
function annotationArguments(text) {
  const inner = String(text ?? '').trim().replace(/^\(|\)$/gu, '');
  const args = {};
  if (!inner.trim()) return args;
  const parts = [];
  let depth = 0; let quote = null; let current = '';
  for (const character of inner) {
    if (quote) { current += character; if (character === quote) quote = null; continue; }
    if (character === '"' || character === "'") { quote = character; current += character; continue; }
    if (character === '(' || character === '[' || character === '{') depth += 1;
    if (character === ')' || character === ']' || character === '}') depth -= 1;
    if (character === ',' && depth === 0) { parts.push(current); current = ''; continue; }
    current += character;
  }
  if (current.trim()) parts.push(current);
  parts.forEach((part, index) => {
    const pair = /^\s*([A-Za-z_]\w*)\s*=\s*([\s\S]+?)\s*$/u.exec(part);
    const unquote = (value) => value.trim().replace(/^"([\s\S]*)"$|^'([\s\S]*)'$/u, (_, a, b) => a ?? b);
    if (pair) args[pair[1]] = unquote(pair[2]);
    else args[index] = unquote(part);
  });
  return args;
}

const BEAN_CONSTRAINTS = Object.freeze({
  NotNull: () => [{ kind: 'required' }],
  NotBlank: () => [{ kind: 'required' }, { kind: 'not-blank' }],
  NotEmpty: () => [{ kind: 'required' }, { kind: 'not-empty' }],
  Min: (args) => [{ kind: 'min', value: number(args.value ?? args[0]), inclusive: true }],
  Max: (args) => [{ kind: 'max', value: number(args.value ?? args[0]), inclusive: true }],
  DecimalMin: (args) => [{ kind: 'min', value: number(args.value ?? args[0]), inclusive: args.inclusive !== 'false' }],
  DecimalMax: (args) => [{ kind: 'max', value: number(args.value ?? args[0]), inclusive: args.inclusive !== 'false' }],
  Positive: () => [{ kind: 'min', value: 0, inclusive: false }],
  PositiveOrZero: () => [{ kind: 'min', value: 0, inclusive: true }],
  Negative: () => [{ kind: 'max', value: 0, inclusive: false }],
  NegativeOrZero: () => [{ kind: 'max', value: 0, inclusive: true }],
  Size: (args) => [
    ...(args.min != null ? [{ kind: 'length-min', value: number(args.min) }] : []),
    ...(args.max != null ? [{ kind: 'length-max', value: number(args.max) }] : [])
  ],
  Length: (args) => BEAN_CONSTRAINTS.Size(args),
  Pattern: (args) => [{ kind: 'pattern', value: args.regexp ?? args[0] ?? null }],
  Email: () => [{ kind: 'email' }],
  Past: () => [{ kind: 'past' }], PastOrPresent: () => [{ kind: 'past' }],
  Future: () => [{ kind: 'future' }], FutureOrPresent: () => [{ kind: 'future' }],
  Digits: (args) => [{ kind: 'digits', value: `${args.integer ?? '?'}.${args.fraction ?? '?'}` }]
});

const DECORATOR_CONSTRAINTS = Object.freeze({
  IsNotEmpty: () => [{ kind: 'required' }, { kind: 'not-empty' }],
  IsDefined: () => [{ kind: 'required' }],
  Min: (args) => [{ kind: 'min', value: number(args[0]), inclusive: true }],
  Max: (args) => [{ kind: 'max', value: number(args[0]), inclusive: true }],
  IsPositive: () => [{ kind: 'min', value: 0, inclusive: false }],
  IsNegative: () => [{ kind: 'max', value: 0, inclusive: false }],
  Length: (args) => [{ kind: 'length-min', value: number(args[0]) }, ...(args[1] != null ? [{ kind: 'length-max', value: number(args[1]) }] : [])],
  MinLength: (args) => [{ kind: 'length-min', value: number(args[0]) }],
  MaxLength: (args) => [{ kind: 'length-max', value: number(args[0]) }],
  IsEmail: () => [{ kind: 'email' }],
  Matches: (args) => [{ kind: 'pattern', value: args[0] ?? null }]
});

/** Constraints and the message from every annotation in `text`, read with `table`. */
function annotationsIn(text, table) {
  const constraints = [];
  let message = null;
  let optional = false;
  for (const match of text.matchAll(ANNOTATION)) {
    if (match[1] === 'IsOptional') optional = true;
    const reader = table[match[1]];
    if (!reader) continue;
    const args = annotationArguments(match[2]);
    constraints.push(...reader(args).filter((entry) => !('value' in entry) || entry.value != null));
    message ??= args.message ?? null;
  }
  return { constraints, message, optional };
}

function typeName(declaration) {
  return /\b(?:class|record|interface|object)\s+([A-Z]\w*)/u.exec(declaration)?.[1] ?? null;
}

/** Split `a, b<c, d>, e` at depth zero. */
function splitTopLevel(text) {
  const parts = [];
  let depth = 0; let current = '';
  for (const character of text) {
    if ('(<[{'.includes(character)) depth += 1;
    if (')>]}'.includes(character)) depth -= 1;
    if (character === ',' && depth === 0) { parts.push(current); current = ''; continue; }
    current += character;
  }
  if (current.trim()) parts.push(current);
  return parts;
}

function beanFields(file) {
  const masked = maskedLines(file);
  const out = [];
  let owner = null;
  let pending = '';
  let pendingLine = null;
  for (let index = 0; index < masked.length; index += 1) {
    const code = masked[index];
    const original = file.lines[index];
    const declared = typeName(code);
    if (declared) {
      owner = declared;
      // Record and Kotlin data class components: `record X(@NotNull String a, @Min(1) int b)`.
      if (/\brecord\s+[A-Z]\w*\s*\(|\bdata\s+class\s+[A-Z]\w*\s*\(/u.test(code)) {
        let joined = original; let end = index;
        while (!/\)\s*(?:implements[^{]*)?(?:\{|$)/u.test(masked.slice(index, end + 1).join(' ').replace(/\([^()]*\)/gu, '')) && end < Math.min(masked.length - 1, index + 30)) {
          end += 1; joined += ` ${file.lines[end]}`;
        }
        const inner = joined.slice(joined.indexOf('(') + 1, joined.lastIndexOf(')'));
        for (const component of splitTopLevel(inner)) {
          const { constraints, message } = annotationsIn(component, BEAN_CONSTRAINTS);
          const bare = component.replace(ANNOTATION, '').replace(MODIFIERS, '').replace(/\b(?:val|var)\s+/u, '').trim();
          const kotlin = /^([a-zA-Z_]\w*)\s*:\s*([^=]+)/u.exec(bare);
          const java = /^([\w.<>,?\[\]\s]+?)\s+([a-zA-Z_]\w*)$/u.exec(bare);
          const field = kotlin ? kotlin[1] : java?.[2];
          const fieldType = kotlin ? kotlin[2].trim() : java?.[1].trim();
          const own = field ? file.lines.slice(index, end + 1).findIndex((line) => new RegExp(`\\b${field}\\b`, 'u').test(line.replace(/^[^(]*\(/u, (head) => (head.includes('record') || head.includes('class') ? ' '.repeat(head.length) : head)))) : -1;
          if (field && constraints.length) out.push({ type: owner, field, fieldType, constraints, message, framework: 'bean-validation', line: index + 1 + Math.max(0, own) });
        }
        index = end;
      }
      continue;
    }
    const onlyAnnotations = /^\s*(?:@[\w.:]+(?:\s*\((?:[^()]|\([^()]*\))*\))?\s*)+$/u.test(code);
    if (onlyAnnotations) { pending += ` ${original}`; pendingLine ??= index + 1; continue; }
    const field = /^\s*((?:@[\w.:]+(?:\s*\((?:[^()]|\([^()]*\))*\))?\s*)*)(?:(?:private|protected|public|final|static|transient|volatile)\s+)*([\w.<>,?[\]\s]+?)\s+([a-zA-Z_]\w*)\s*(?:=[^;]*)?;\s*$/u.exec(code);
    const kotlinProperty = /^\s*((?:@[\w.:]+(?:\s*\((?:[^()]|\([^()]*\))*\))?\s*)*)(?:(?:private|protected|public|override|lateinit|open)\s+)*(?:val|var)\s+([a-zA-Z_]\w*)\s*:\s*([^=\n]+)/u.exec(code);
    if ((field || kotlinProperty) && owner) {
      const { constraints, message } = annotationsIn(`${pending} ${original}`, BEAN_CONSTRAINTS);
      const name = field ? field[3] : kotlinProperty[2];
      const fieldType = field ? field[2].trim() : kotlinProperty[3].trim();
      if (constraints.length) out.push({ type: owner, field: name, fieldType, constraints, message, framework: 'bean-validation', line: pendingLine ?? index + 1 });
    }
    pending = ''; pendingLine = null;
  }
  return out;
}

function pydanticFields(file) {
  const out = [];
  let owner = null;
  let indent = null;
  file.lines.forEach((original, index) => {
    const model = /^(\s*)class\s+([A-Z]\w*)\s*\(([^)]*)\)\s*:/u.exec(original);
    if (model) {
      owner = /\b(?:BaseModel|BaseSettings|SQLModel|Schema)\b/u.test(model[3]) ? model[2] : null;
      indent = model[1].length;
      return;
    }
    if (!owner) return;
    if (original.trim() && /^\s*/u.exec(original)[0].length <= indent) { owner = null; return; }
    const field = /^\s+([a-zA-Z_]\w*)\s*:\s*([^=#]+?)\s*(?:=\s*(.+?))?\s*(?:#.*)?$/u.exec(original);
    if (!field) return;
    const [, name, annotation, defaultValue] = field;
    const constraints = [];
    const read = (text) => {
      for (const [key, kind, inclusive] of [['ge', 'min', true], ['gt', 'min', false], ['le', 'max', true], ['lt', 'max', false]]) {
        const match = new RegExp(`\\b${key}\\s*=\\s*(-?[\\d.]+)`, 'u').exec(text);
        if (match) constraints.push({ kind, value: number(match[1]), inclusive });
      }
      for (const [key, kind] of [['min_length', 'length-min'], ['max_length', 'length-max']]) {
        const match = new RegExp(`\\b${key}\\s*=\\s*(\\d+)`, 'u').exec(text);
        if (match) constraints.push({ kind, value: number(match[1]) });
      }
      const pattern = /\b(?:pattern|regex)\s*=\s*r?(["'])(.+?)\1/u.exec(text);
      if (pattern) constraints.push({ kind: 'pattern', value: pattern[2] });
    };
    read(`${annotation} ${defaultValue ?? ''}`);
    if (/\bEmailStr\b/u.test(annotation)) constraints.push({ kind: 'email' });
    const optional = /\bOptional\[|\|\s*None\b|=\s*None\b/u.test(`${annotation} = ${defaultValue ?? ''}`);
    // Required when there is no default: `Field(...)` and `Field(gt=0)` set none; `Field(default=1)` or `Field(1)` do.
    const declaredDefault = defaultValue?.trim() ?? '';
    const required = !optional && (!declaredDefault || (/^Field\(\s*(?:\.\.\.|[a-z_]\w*\s*=|\))/u.test(declaredDefault) && !/\bdefault(?:_factory)?\s*=/u.test(declaredDefault)));
    if (required && constraints.length) constraints.unshift({ kind: 'required' });
    if (constraints.length) out.push({ type: owner, field: name, fieldType: annotation.trim(), constraints, message: null, framework: 'pydantic', line: index + 1 });
  });
  return out;
}

function zodFields(file) {
  const out = [];
  const masked = maskedLines(file);
  let owner = null;
  let depth = 0;
  masked.forEach((code, index) => {
    const original = file.lines[index];
    const start = /\b(?:const|let)\s+([A-Za-z_]\w*)\s*=\s*z\.object\(\s*\{/u.exec(code);
    if (start) { owner = start[1].replace(/Schema$/u, '') || start[1]; depth = 0; }
    if (!owner) return;
    for (const character of code) { if (character === '{') depth += 1; if (character === '}') depth -= 1; }
    const field = /^\s*([A-Za-z_]\w*)\s*:\s*(z\.[\s\S]+?),?\s*$/u.exec(original);
    if (field) {
      const chain = field[2];
      const base = /^z\.(\w+)/u.exec(chain)?.[1] ?? null;
      const constraints = [];
      for (const call of chain.matchAll(/\.(\w+)\(([^()]*)\)/gu)) {
        const [, method, argument] = call;
        const value = number(argument);
        if (method === 'min' && value != null) constraints.push(base === 'number' ? { kind: 'min', value, inclusive: true } : { kind: 'length-min', value });
        else if (method === 'max' && value != null) constraints.push(base === 'number' ? { kind: 'max', value, inclusive: true } : { kind: 'length-max', value });
        else if (method === 'length' && value != null) constraints.push({ kind: 'length-min', value }, { kind: 'length-max', value });
        else if (method === 'gt' && value != null) constraints.push({ kind: 'min', value, inclusive: false });
        else if (method === 'gte' && value != null) constraints.push({ kind: 'min', value, inclusive: true });
        else if (method === 'lt' && value != null) constraints.push({ kind: 'max', value, inclusive: false });
        else if (method === 'lte' && value != null) constraints.push({ kind: 'max', value, inclusive: true });
        else if (method === 'positive') constraints.push({ kind: 'min', value: 0, inclusive: false });
        else if (method === 'nonnegative') constraints.push({ kind: 'min', value: 0, inclusive: true });
        else if (method === 'negative') constraints.push({ kind: 'max', value: 0, inclusive: false });
        else if (method === 'email') constraints.push({ kind: 'email' });
        else if (method === 'regex') constraints.push({ kind: 'pattern', value: argument.trim() || null });
      }
      if (!/\.(?:optional|nullable|nullish)\(\)/u.test(chain) && constraints.length) constraints.unshift({ kind: 'required' });
      if (constraints.length) out.push({ type: owner, field: field[1], fieldType: base, constraints, message: null, framework: 'zod', line: index + 1 });
    }
    if (depth <= 0 && !start) owner = null;
  });
  return out;
}

function decoratorFields(file) {
  const out = [];
  const masked = maskedLines(file);
  let owner = null;
  let pending = '';
  let pendingLine = null;
  masked.forEach((code, index) => {
    const original = file.lines[index];
    const declared = /\bclass\s+([A-Z]\w*)/u.exec(code);
    if (declared) { owner = declared[1]; pending = ''; pendingLine = null; return; }
    if (/^\s*(?:@\w+\s*\((?:[^()]|\([^()]*\))*\)\s*)+$/u.test(code)) { pending += ` ${original}`; pendingLine ??= index + 1; return; }
    const property = /^\s*((?:@\w+\s*\((?:[^()]|\([^()]*\))*\)\s*)*)(?:(?:public|private|protected|readonly)\s+)*([a-zA-Z_]\w*)([?!])?\s*:\s*([^;=]+)/u.exec(code);
    if (property && owner) {
      const { constraints, message, optional } = annotationsIn(`${pending} ${original}`, DECORATOR_CONSTRAINTS);
      if (constraints.length) {
        out.push({
          type: owner, field: property[2], fieldType: property[4].trim(),
          constraints: optional || property[3] === '?' ? constraints.filter((entry) => entry.kind !== 'required') : constraints,
          message, framework: 'class-validator', line: pendingLine ?? index + 1
        });
      }
    }
    pending = ''; pendingLine = null;
  });
  return out;
}

/** Every validated field in one source file. */
export function validationConstraints(file) {
  if (isTestPath(file.path)) return [];
  const extension = path.posix.extname(file.path).toLowerCase();
  const text = file.lines.join('\n');
  if (['.java', '.kt'].includes(extension) && /@(?:field:)?(?:NotNull|NotBlank|NotEmpty|Min|Max|DecimalMin|DecimalMax|Size|Pattern|Email|Positive|PositiveOrZero|Negative|NegativeOrZero|Past|Future|Digits|Length)\b/u.test(text)) return beanFields(file);
  if (extension === '.py' && /\b(?:BaseModel|BaseSettings|SQLModel)\b/u.test(text)) return pydanticFields(file);
  if (['.ts', '.tsx', '.js', '.mjs', '.jsx'].includes(extension)) {
    return [
      ...(/\bz\.object\(/u.test(text) ? zodFields(file) : []),
      ...(/from\s+['"]class-validator['"]/u.test(text) ? decoratorFields(file) : [])
    ];
  }
  return [];
}

/** Types an endpoint validates: `@Valid @RequestBody OrderRequest request` (or `@Validated`, either order). */
export function validatedTypes(file) {
  if (isTestPath(file.path)) return [];
  const types = new Set();
  const text = maskedLines(file).join('\n');
  for (const match of text.matchAll(/@(?:Valid|Validated)\b(?:\s*\([^)]*\))?\s+(?:@\w+(?:\([^)]*\))?\s+)*(?:final\s+)?([A-Z]\w*)\s+\w+|@RequestBody\s+(?:@\w+\s+)*@(?:Valid|Validated)\b\s+([A-Z]\w*)/gu)) {
    types.add(match[1] ?? match[2]);
  }
  return [...types];
}

/** Constraints in words: "required, at least 1, at most 20 characters, email". */
export function constraintText(constraints) {
  return constraints.map((entry) => ({
    required: 'required', 'not-blank': 'not blank', 'not-empty': 'not empty', email: 'an email address', past: 'in the past', future: 'in the future',
    min: entry.inclusive === false ? `more than ${entry.value}` : `at least ${entry.value}`,
    max: entry.inclusive === false ? `less than ${entry.value}` : `at most ${entry.value}`,
    'length-min': `at least ${entry.value} long`, 'length-max': `at most ${entry.value} long`,
    pattern: `matching ${entry.value ?? 'a pattern'}`, digits: `digits ${entry.value}`
  })[entry.kind] ?? entry.kind).join(', ');
}
