// Stores/retrieves each server's secret in the macOS Keychain via keytar:
// its login password, or its SSH key's passphrase.
// Retrieval is ALWAYS gated by Touch ID at the call site (ipc-handlers.ts) —
// this module itself has no biometric check, so never call getSecret()
// without a preceding successful requestTouchId().

import keytar from "keytar";

// A Keychain service per kind of secret, so each item says what it holds.
// Still named after MacSCP, the app's old name: renaming them would lose
// every saved password and passphrase.
const SERVICES = {
  passphrase: "MacSCP:ssh-key-passphrase",
  password: "MacSCP:ssh-password",
} as const;

export type SecretKind = keyof typeof SERVICES;

export async function setSecret(
  kind: SecretKind,
  connectionId: string,
  secret: string
): Promise<void> {
  await keytar.setPassword(SERVICES[kind], connectionId, secret);
}

export async function getSecret(
  kind: SecretKind,
  connectionId: string
): Promise<string | null> {
  return keytar.getPassword(SERVICES[kind], connectionId);
}

export async function deleteSecret(
  kind: SecretKind,
  connectionId: string
): Promise<void> {
  await keytar.deletePassword(SERVICES[kind], connectionId);
}
