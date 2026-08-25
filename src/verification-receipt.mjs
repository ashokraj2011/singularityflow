/** Independently verifiable clean-checkout release evidence for installations without hosted CI. */
import {
  createHash, createPrivateKey, createPublicKey, sign as signBytes, verify as verifyBytes
} from 'node:crypto';

import { canonicalJson } from './records.mjs';
import { SingularityFlowError } from './util.mjs';

function sha256(value) { return createHash('sha256').update(value).digest('hex'); }

function publicKeyDer(key) {
  const publicKey = key?.type === 'public' ? key : createPublicKey(key);
  return publicKey.export({ type: 'spki', format: 'der' });
}

function payload(receipt) {
  const copy = structuredClone(receipt);
  delete copy.signature;
  return canonicalJson(copy);
}

export function signVerificationReceipt(unsignedReceipt, privateKeyPem, verifierIdentity) {
  const privateKey = createPrivateKey(privateKeyPem);
  if (privateKey.asymmetricKeyType !== 'ed25519') {
    throw new SingularityFlowError('Verification receipts require an Ed25519 signing key.', {
      code: 'VERIFICATION_SIGNING_KEY_INVALID'
    });
  }
  const publicDer = publicKeyDer(privateKey);
  const receipt = {
    ...structuredClone(unsignedReceipt),
    verifierIdentity: String(verifierIdentity ?? '').trim()
  };
  if (!receipt.verifierIdentity) {
    throw new SingularityFlowError('Verification receipt requires a verifier identity.', {
      code: 'VERIFICATION_RECEIPT_INVALID'
    });
  }
  const canonical = payload(receipt);
  return {
    ...receipt,
    signature: {
      algorithm: 'ed25519',
      publicKeySpki: publicDer.toString('base64'),
      publicKeySha256: `sha256:${sha256(publicDer)}`,
      payloadSha256: `sha256:${sha256(canonical)}`,
      value: signBytes(null, Buffer.from(canonical), privateKey).toString('base64')
    }
  };
}

export function verifyVerificationReceipt(receipt, {
  trustedPublicKeyPem,
  expectedCommit = null,
  expectedTree = null,
  expectedPackageSha256 = null
} = {}) {
  if (!receipt || typeof receipt !== 'object' || Array.isArray(receipt)) {
    throw new SingularityFlowError('Verification receipt must be an object.', { code: 'VERIFICATION_RECEIPT_INVALID' });
  }
  const signature = receipt.signature;
  if (signature?.algorithm !== 'ed25519' || !trustedPublicKeyPem) {
    throw new SingularityFlowError('Verification receipt requires an Ed25519 signature and an explicitly trusted public key.', {
      code: 'VERIFICATION_RECEIPT_UNTRUSTED'
    });
  }
  const trusted = createPublicKey(trustedPublicKeyPem);
  const trustedDer = publicKeyDer(trusted);
  const embedded = Buffer.from(String(signature.publicKeySpki ?? ''), 'base64');
  if (!embedded.equals(trustedDer)
      || signature.publicKeySha256 !== `sha256:${sha256(trustedDer)}`) {
    throw new SingularityFlowError('Verification receipt signing key is not the trusted release verifier key.', {
      code: 'VERIFICATION_RECEIPT_UNTRUSTED'
    });
  }
  const canonical = payload(receipt);
  if (signature.payloadSha256 !== `sha256:${sha256(canonical)}`
      || !verifyBytes(null, Buffer.from(canonical), trusted, Buffer.from(String(signature.value ?? ''), 'base64'))) {
    throw new SingularityFlowError('Verification receipt signature or payload digest is invalid.', {
      code: 'VERIFICATION_RECEIPT_SIGNATURE_INVALID'
    });
  }
  const failures = [];
  if (receipt.cleanCheckout !== true) failures.push('cleanCheckout is not true');
  if (receipt.npmCi !== 'passed') failures.push('npmCi did not pass');
  if (receipt.npmRunCheck?.passed !== true) failures.push('npmRunCheck did not pass');
  if (receipt.npmTest?.failed !== 0 || receipt.npmTest?.passed < 1) failures.push('npmTest has no passing zero-failure result');
  if (receipt.vscodeBuild !== 'passed') failures.push('vscodeBuild did not pass');
  if (!Array.isArray(receipt.platforms) || !receipt.platforms.length) failures.push('platforms are absent');
  if (!Array.isArray(receipt.nodeVersions) || !receipt.nodeVersions.length) failures.push('nodeVersions are absent');
  if (!/^sha256:[a-f0-9]{64}$/.test(String(receipt.packageSha256 ?? ''))) failures.push('packageSha256 is invalid');
  if (expectedCommit && receipt.commit !== expectedCommit) failures.push('commit does not match release HEAD');
  if (expectedTree && receipt.tree !== expectedTree) failures.push('tree does not match release HEAD');
  if (expectedPackageSha256 && receipt.packageSha256 !== expectedPackageSha256) failures.push('package digest does not match release artifact');
  if (failures.length) {
    throw new SingularityFlowError(`Verification receipt cannot authorize release: ${failures.join('; ')}.`, {
      code: 'VERIFICATION_RECEIPT_REJECTED', details: { failures }
    });
  }
  return {
    valid: true,
    verifierIdentity: receipt.verifierIdentity,
    publicKeySha256: signature.publicKeySha256,
    commit: receipt.commit,
    tree: receipt.tree,
    packageSha256: receipt.packageSha256
  };
}
