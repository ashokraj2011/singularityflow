/**
 * Validation constraints (World Model v5, M1b): Bean Validation, pydantic, zod and class-validator
 * read as data, whether an endpoint validates the type, and the constraints as rule records linked
 * to the docs.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cp, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { readDocumentation } from '../src/knowledge/brief.mjs';
import { buildRuleRecords, ruleQuestions, ruleStatusWords } from '../src/knowledge/records/rules.mjs';
import { buildKnowledge } from '../src/knowledge/store.mjs';
import { constraintText, validatedTypes, validationConstraints } from '../src/knowledge/validation.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const file = (relative, language, text) => ({ path: relative, language, lines: text.split('\n') });
const read = (entry) => validationConstraints(entry).map((field) => [`${field.type}.${field.field}`, field.framework, constraintText(field.constraints), field.line]);

test('constraints are read from Bean Validation fields, records and Kotlin, pydantic, zod and class-validator', () => {
  assert.deepEqual(read(file('src/OrderRequest.java', 'java', [
    'public class OrderRequest {', '    @NotNull', '    @Size(min = 1, max = 20, message = "An order has 1 to 20 lines")', '    private List<String> lines;',
    '    @DecimalMin("10.00") private BigDecimal total;', '    private String note;', '}'
  ].join('\n'))), [
    ['OrderRequest.lines', 'bean-validation', 'required, at least 1 long, at most 20 long', 2],
    ['OrderRequest.total', 'bean-validation', 'at least 10', 5]
  ]);
  assert.deepEqual(read(file('src/Refund.java', 'java', 'public record Refund(@NotBlank String reason, @Positive BigDecimal amount) {}')), [
    ['Refund.reason', 'bean-validation', 'required, not blank', 1], ['Refund.amount', 'bean-validation', 'more than 0', 1]
  ]);
  assert.deepEqual(read(file('src/Signup.kt', 'kotlin', 'data class Signup(\n  @field:NotBlank val name: String,\n  @field:Min(18) val age: Int\n)')), [
    ['Signup.name', 'bean-validation', 'required, not blank', 2], ['Signup.age', 'bean-validation', 'at least 18', 3]
  ]);
  assert.deepEqual(read(file('app/models.py', 'python', [
    'class Item(BaseModel):', '    name: str = Field(..., min_length=1, max_length=50)', '    price: float = Field(gt=0)', '    note: Optional[str] = None', '    size: int = Field(default=1, le=10)'
  ].join('\n'))), [
    ['Item.name', 'pydantic', 'required, at least 1 long, at most 50 long', 2], ['Item.price', 'pydantic', 'required, more than 0', 3], ['Item.size', 'pydantic', 'at most 10', 5]
  ]);
  assert.deepEqual(read(file('web/schema.ts', 'typescript', "export const SignupSchema = z.object({\n  email: z.string().email(),\n  age: z.number().int().min(18).optional(),\n});")), [
    ['Signup.email', 'zod', 'required, an email address', 2], ['Signup.age', 'zod', 'at least 18', 3]
  ]);
  assert.deepEqual(read(file('web/dto.ts', 'typescript', "import { IsNotEmpty } from 'class-validator';\nexport class CreateUserDto {\n  @IsNotEmpty()\n  @Length(3, 30)\n  name: string;\n  @IsOptional() @Min(0) credit?: number;\n}")), [
    ['CreateUserDto.name', 'class-validator', 'required, not empty, at least 3 long, at most 30 long', 3], ['CreateUserDto.credit', 'class-validator', 'at least 0', 6]
  ]);
  assert.deepEqual(validatedTypes(file('src/C.java', 'java', 'public String create(@Valid @RequestBody OrderRequest request) {}\npublic String refund(@RequestBody Refund refund) {}')), ['OrderRequest']);
  assert.deepEqual(read(file('src/test/OrderRequestTest.java', 'java', 'class T {\n @NotNull private String a;\n}')), [], 'tests are not product rules');
});

test('constraints become rule records: agreed, conflicting with the docs, or declared where no endpoint validates them', async (t) => {
  const repository = await mkdtemp(path.join(os.tmpdir(), 'sflow-validation-'));
  t.after(() => rm(repository, { recursive: true, force: true }));
  await cp(path.join(root, 'test', 'fixtures', 'knowledge', 'validation-mix'), repository, { recursive: true });
  for (const args of [['init', '-q', '-b', 'main'], ['add', '-A'], ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.com', 'commit', '-qm', 'Fixture']]) {
    assert.equal(spawnSync('git', args, { cwd: repository, encoding: 'utf8' }).status, 0);
  }
  const result = await buildKnowledge(repository, {});
  const validation = result.knowledge.items.filter((item) => item.kind === 'validation');
  const validated = Object.fromEntries(validation.map((item) => [item.subject.symbol, item.statement.validated]));
  assert.equal(validated['OrderRequest.lines'], true, 'POST /orders validates OrderRequest');
  assert.equal(validated['Refund.amount'], false, 'POST /refunds takes Refund without @Valid');
  assert.equal(validated['Signup.email'], null, 'zod validates when the value is parsed');
  assert.ok(validation.every((item) => item.citations.length && item.assurance === 'observed'));
  const records = buildRuleRecords(result.knowledge, readDocumentation(repository));
  const record = (symbol) => records.find((entry) => entry.origin === 'validation' && entry.text.startsWith(`${symbol}:`));
  assert.equal(record('OrderRequest.lines').status, 'agreed', '"at most 20 lines" meets @Size(max = 20)');
  assert.equal(ruleStatusWords(record('OrderRequest.lines')), 'Documented, enforced by bean-validation.');
  assert.equal(record('OrderRequest.total').status, 'agreed', '"at least 10.00" meets @DecimalMin("10.00")');
  assert.equal(record('Refund.amount').status, 'agreed', '"must be positive" meets @Positive');
  assert.match(ruleStatusWords(record('Refund.amount')), /declared on Refund, but no endpoint validates it \(@Valid is missing\)/u);
  assert.equal(record('CreateUserDto.name').status, 'conflict');
  assert.equal(record('CreateUserDto.name').conflict, 'the docs say at most 40; the code allows at most 30');
  const questions = ruleQuestions(records).map((entry) => entry.text);
  assert.ok(questions.some((text) => /Docs and code disagree on "CreateUserDto\.name/u.test(text)));
  assert.ok(questions.some((text) => /Refund\.(?:amount|reason) is declared .+ but no endpoint validates Refund/u.test(text)));
});
