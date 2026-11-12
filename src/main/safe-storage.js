'use strict';
// Robust safeStorage helpers. The async availability probe can hang or reject
// on headless Linux (no secret service), so we race it against a timeout and
// swallow errors, falling back to "not available" (plaintext store).
const { safeStorage } = require('electron');

async function encryptionAvailable() {
  try {
    const probe = safeStorage.isAsyncEncryptionAvailable
      ? safeStorage.isAsyncEncryptionAvailable()
      : Promise.resolve(safeStorage.isEncryptionAvailable());
    return await Promise.race([
      Promise.resolve(probe).catch(() => false),
      new Promise((resolve) => setTimeout(() => resolve(false), 2000)),
    ]);
  } catch {
    return false;
  }
}

async function buildCipher() {
  if (!(await encryptionAvailable())) return null;
  return {
    encrypt: (s) => safeStorage.encryptString(s).toString('base64'),
    decrypt: (s) => safeStorage.decryptString(Buffer.from(s, 'base64')),
  };
}

module.exports = { encryptionAvailable, buildCipher };
