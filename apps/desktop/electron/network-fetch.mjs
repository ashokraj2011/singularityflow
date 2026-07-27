export function installElectronNetworkFetch(netModule, target = globalThis) {
  if (!netModule || typeof netModule.fetch !== 'function') {
    throw new TypeError('Electron net.fetch is unavailable.');
  }
  if (!target || (typeof target !== 'object' && typeof target !== 'function')) {
    throw new TypeError('A global fetch target is required.');
  }

  const electronFetch = (...args) => netModule.fetch(...args);
  Object.defineProperty(target, 'fetch', {
    configurable: true,
    enumerable: true,
    writable: true,
    value: electronFetch
  });
  return electronFetch;
}
