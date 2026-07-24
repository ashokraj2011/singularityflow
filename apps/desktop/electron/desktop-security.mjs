export function isTrustedRendererUrl(actualValue, expectedValue, { packaged = false } = {}) {
  let actual;
  let expected;
  try {
    actual = new URL(actualValue);
    expected = new URL(expectedValue);
  } catch {
    return false;
  }
  return packaged ? actual.href === expected.href : actual.origin === expected.origin;
}

export function safeExternalUrl(value) {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password) return null;
    return url.href;
  } catch {
    return null;
  }
}
