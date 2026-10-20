import assert from 'node:assert/strict';
import test from 'node:test';
import { artifactTextCheckoutMatches, authoredArtifactText, inspectManagedArtifactMetadata } from '../src/artifact-review-read.mjs';

test('artifact identity accepts only exact bytes or uniform LF/CRLF checkout text', () => {
  const lf = '# Evidence\n\nObservable result.\n';
  const crlf = lf.replaceAll('\n', '\r\n');
  assert.equal(artifactTextCheckoutMatches(lf, lf), true);
  assert.equal(artifactTextCheckoutMatches(lf, crlf), true);
  assert.equal(artifactTextCheckoutMatches(crlf, lf), true);
  for (const changed of [
    lf.replace('result', 'changed'), '\uFEFF' + lf, lf.trimEnd(), lf + '\n',
    lf.replace('result.', 'result. '), lf.replace('\n', '\r\n'), lf.replace('\n', '\r')
  ]) assert.equal(artifactTextCheckoutMatches(lf, changed), false, JSON.stringify(changed));
});

test('managed envelope recognition is portable without rewriting author-owned text', () => {
  const body = '# Evidence\r\n\r\nThe author owns these exact bytes.\r\n';
  const text = '<!-- singularity-flow:metadata\r\n{}\r\n-->\r\n\r\n' + body;
  assert.equal(inspectManagedArtifactMetadata(text).status, 'valid');
  assert.equal(authoredArtifactText(text), body);
  assert.equal(inspectManagedArtifactMetadata(text + '\r\n<!-- singularity-flow:metadata\r\n{}\r\n-->').status,
    'duplicate-or-misplaced');
});
