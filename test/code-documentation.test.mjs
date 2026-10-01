import test from 'node:test';
import assert from 'node:assert/strict';
import {
  changedDeclarations, documentationLanguage, publicDeclarations, unsupportedSourceLanguage
} from '../src/code-documentation.mjs';

const summary = (source, language) => publicDeclarations(source, language)
  .map((entry) => `${entry.kind}:${entry.name}:${entry.documented ? 'doc' : 'none'}`);

test('languages are chosen by extension, and declaration files and unknown languages are left alone', () => {
  assert.equal(documentationLanguage('src/payments/retry.ts'), 'typescript');
  assert.equal(documentationLanguage('src/a.mjs'), 'javascript');
  assert.equal(documentationLanguage('types/index.d.ts'), null);
  assert.equal(documentationLanguage('app/models/user.rb'), 'ruby');
  assert.equal(documentationLanguage('README.md'), null);
  assert.equal(unsupportedSourceLanguage('native/codec.cpp'), true);
  assert.deepEqual(publicDeclarations('int main() {}', null), []);
});

test('JavaScript and TypeScript: exported functions, classes and their public methods need JSDoc', () => {
  const source = `import x from 'y';
const pattern = /\\/\\*not a comment/;

/**
 * Retry a failed payment once.
 * @param {string} id
 */
export async function retryPayment(id) {
  return id;
}

/** @clause:PAY-1:REQ-001 */
export function tagOnly() {}

export const settle = async (id) => id;

// A line comment is not a doc comment.
export default class Ledger {
  /** Post one entry. */
  post(entry) { return entry; }
  refund(entry) { if (entry) { return entry; } }
  private audit() {}
  #secret() {}
  _internal() {}
  static get total() { return 0; }
}

class Hidden { visible() {} }

@Injectable()
export class Service {}

/** Decorated and documented. */
@Component({ selector: 'x' })
export class Widget {}
`;
  assert.deepEqual(summary(source, 'typescript'), [
    'function:retryPayment:doc', 'function:tagOnly:none', 'function:settle:none', 'class:Ledger:none',
    'method:post:doc', 'method:refund:none', 'method:total:none', 'class:Service:none', 'class:Widget:doc'
  ]);
});

test('Python: public functions, classes and methods need a docstring as their first statement', () => {
  const source = `import os

def fetch(
    url: str,
    timeout: int = 5,
) -> str:
    """Fetch a URL and return its body."""
    return url


def _helper():
    return 1


async def stream():
    return 2


class Ledger:
    '''A ledger of entries.'''

    def post(self, entry):
        """Post one entry.

        Longer description.
        """
        return entry

    def refund(self, entry):
        return entry

    def __repr__(self):
        return 'Ledger'


class _Private:
    def hidden(self):
        pass
`;
  assert.deepEqual(summary(source, 'python'), [
    'function:fetch:doc', 'function:stream:none', 'class:Ledger:doc', 'method:post:doc', 'method:refund:none'
  ]);
});

test('Java, Kotlin, C# and PHP: public API needs a doc block above any annotations', () => {
  const java = `package x;

/** Accounts for payments. */
public class Ledger {
  /** Post one entry. */
  @Override
  public void post(Entry entry) {}

  public int total() { return 0; }

  private void audit() {}
}
`;
  assert.deepEqual(summary(java, 'java'), ['class:Ledger:doc', 'method:post:doc', 'method:total:none']);

  const kotlin = `/** A ledger. */
class Ledger {
    fun post(entry: Entry) {}

    /** Refund an entry. */
    suspend fun refund(entry: Entry) {}

    private fun audit() {}
    internal fun hidden() {}
}
`;
  assert.deepEqual(summary(kotlin, 'kotlin'), ['class:Ledger:doc', 'function:post:none', 'function:refund:doc']);

  const csharp = `/// <summary>A ledger.</summary>
public class Ledger
{
    /// <summary>Post one entry.</summary>
    [HttpPost]
    public async Task<int> Post(Entry entry) { return 0; }

    public void Refund() {}

    private void Audit() {}
}
`;
  assert.deepEqual(summary(csharp, 'csharp'), ['class:Ledger:doc', 'method:Post:doc', 'method:Refund:none']);

  const php = `<?php
/** A ledger. */
final class Ledger {
    /** Post one entry. */
    public function post($entry) {}
    public static function total() {}
    private function audit() {}
}
function helper() {}
`;
  assert.deepEqual(summary(php, 'php'), ['class:Ledger:doc', 'function:post:doc', 'function:total:none', 'function:helper:none']);
});

test('Go, Rust, Swift and Ruby follow their own conventions and visibility', () => {
  const go = `package ledger

// Post records one entry.
func Post(e Entry) error { return nil }

func (l *Ledger) Refund(e Entry) error { return nil }

func helper() {}

// Ledger holds entries.
type Ledger struct{}
`;
  assert.deepEqual(summary(go, 'go'), ['function:Post:doc', 'function:Refund:none', 'type:Ledger:doc']);

  const rust = `/// A ledger of entries.
#[derive(Debug)]
pub struct Ledger;

pub fn post(entry: Entry) {}

pub(crate) fn internal() {}

/// Refund an entry.
pub async fn refund(entry: Entry) {}
`;
  assert.deepEqual(summary(rust, 'rust'), ['type:Ledger:doc', 'function:post:none', 'function:refund:doc']);

  const swift = `/// A ledger.
public final class Ledger {
    /// Post one entry.
    @discardableResult
    public func post(_ entry: Entry) -> Bool { true }
    public func refund() {}
    func internal() {}
}
`;
  assert.deepEqual(summary(swift, 'swift'), ['type:Ledger:doc', 'function:post:doc', 'function:refund:none']);

  const ruby = `# frozen_string_literal: true

# A ledger of entries.
class Ledger
  # Post one entry.
  def post(entry)
    entry
  end

  def refund(entry)
    entry
  end

  private

  def audit
  end
end
`;
  assert.deepEqual(summary(ruby, 'ruby'), ['class:Ledger:doc', 'method:post:doc', 'method:refund:none']);
});

test('a change touches the declarations whose lines it edits, including their bodies', () => {
  const source = `/** One. */
export function one() {
  return 1;
}

export function two() {
  return 2;
}
`;
  const declarations = publicDeclarations(source, 'javascript');
  assert.deepEqual(changedDeclarations(declarations, new Set([7]), 9).map((entry) => entry.name), ['two']);
  assert.deepEqual(changedDeclarations(declarations, [3], 9).map((entry) => entry.name), ['one']);
  assert.deepEqual(changedDeclarations(declarations, [], 9), []);
});

test('traceability tag lines and decorators over several lines sit between a doc comment and its declaration', () => {
  const script = `/**
 * Settle one payment.
 */
// @clause:PAY-1:REQ-001
export function settle(id) { return id; }

/** Tags alone do not document. */
// @clause:PAY-1:REQ-002 @ac:PAY-1:AC-002
export function tagged(id) { return id; }

// @clause:PAY-1:REQ-003
export function undocumented(id) { return id; }

/**
 * A card that renders the ledger.
 */
@Component({
  selector: 'ledger-card',
  template: '<p>{{ total }}</p>'
})
export class LedgerCard {}
`;
  assert.deepEqual(summary(script, 'typescript'), [
    'function:settle:doc', 'function:tagged:doc', 'function:undocumented:none', 'class:LedgerCard:doc'
  ]);
  const csharp = `public class Ledger
{
    /// <summary>Posts one entry.</summary>
    // @clause:PAY-1:REQ-004
    public void Post(string entry) { }
}
`;
  assert.deepEqual(summary(csharp, 'csharp').filter((entry) => entry.startsWith('method')), ['method:Post:doc']);
  const go = `// Settle settles one payment.
// @clause:PAY-1:REQ-005
func Settle(id string) string { return id }
`;
  assert.deepEqual(summary(go, 'go'), ['function:Settle:doc']);
  // A minified line is not read for declarations at all.
  assert.deepEqual(summary(`export function minified(){return 1}${';'.repeat(3000)}\n`, 'javascript'), []);
});
