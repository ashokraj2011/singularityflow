'use strict';

/**
 * Process-private reproducibility fixes for the pinned VSCE toolchain.
 *
 * VSCE 3.9.2 sorts archive paths with localeCompare, so identical paths have different ZIP order
 * under (for example) English and Turkish locales. Its yazl dependency also copies host stat mode
 * bits into ZIP entries, which makes the same checkout differ between POSIX and Windows. This file
 * is loaded only into the VSCE child: repository/runtime sorting and filesystem behavior are not
 * changed.
 */
const fs = require('node:fs');
const Module = require('node:module');
const nativeLocaleCompare = String.prototype.localeCompare;

function isVsixArchivePath(value) {
  return value === '[Content_Types].xml'
    || value === 'extension.vsixmanifest'
    || value.startsWith('extension/');
}

Object.defineProperty(String.prototype, 'localeCompare', {
  configurable: true,
  enumerable: false,
  writable: true,
  value(other, ...arguments_) {
    const left = String(this);
    const right = String(other);
    if (isVsixArchivePath(left) && isVsixArchivePath(right)) {
      return left < right ? -1 : left > right ? 1 : 0;
    }
    return nativeLocaleCompare.call(left, right, ...arguments_);
  }
});

function deterministicFileMode(realPath) {
  const descriptor = fs.openSync(realPath, 'r');
  try {
    const prefix = Buffer.alloc(2);
    const bytes = fs.readSync(descriptor, prefix, 0, prefix.length, 0);
    return bytes === 2 && prefix[0] === 0x23 && prefix[1] === 0x21
      ? 0o100755
      : 0o100644;
  } finally {
    fs.closeSync(descriptor);
  }
}

const originalLoad = Module._load;
const patched = new WeakSet();
Module._load = function reproducibleVsceLoad(request, parent, isMain) {
  const loaded = originalLoad.call(this, request, parent, isMain);
  if (request !== 'yazl' || !loaded?.ZipFile?.prototype || patched.has(loaded.ZipFile.prototype)) {
    return loaded;
  }
  const prototype = loaded.ZipFile.prototype;
  const addFile = prototype.addFile;
  Object.defineProperty(prototype, 'addFile', {
    configurable: true,
    enumerable: false,
    writable: true,
    value(realPath, metadataPath, options = {}) {
      return addFile.call(this, realPath, metadataPath, {
        ...options,
        mode: deterministicFileMode(realPath)
      });
    }
  });
  patched.add(prototype);
  return loaded;
};
