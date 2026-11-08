// Stores/retrieves SSH key passphrases in the macOS Keychain via keytar.
// Retrieval is ALWAYS gated by Touch ID at the call site (ipc-handlers.ts) —
// this module itself has no biometric check, so never call getPassphrase()
// without a preceding successful requestTouchId().

import keytar from "keytar";

const SERVICE = "MacSCP:ssh-key-passphrase";

export async function setPassphrase(
  connectionId: string,
  passphrase: string
): Promise<void> {
  await keytar.setPassword(SERVICE, connectionId, passphrase);
}

export async function getPassphrase(
  connectionId: string
): Promise<string | null> {
  return keytar.getPassword(SERVICE, connectionId);
}

export async function deletePassphrase(connectionId: string): Promise<void> {
  await keytar.deletePassword(SERVICE, connectionId);
}

export async function hasPassphrase(connectionId: string): Promise<boolean> {
  return (await keytar.getPassword(SERVICE, connectionId)) !== null;
}
