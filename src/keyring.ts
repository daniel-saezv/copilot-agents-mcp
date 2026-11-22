import { Entry } from "@napi-rs/keyring";
import { KEYRING_SERVICE, systemAccount, type SecretStore } from "./auth.ts";
import { KeyringError } from "./errors.ts";

export const KEYRING_ENTRY_OPTIONS = { linux: { store: "secret-service" as const } };

export function systemSecretStore(): SecretStore {
  let entry: Entry;
  try {
    entry = new Entry(KEYRING_SERVICE, systemAccount(), KEYRING_ENTRY_OPTIONS);
  } catch (error) {
    throw new KeyringError(error instanceof Error ? error.message : "no se pudo abrir el llavero");
  }
  return {
    read() {
      try {
        return entry.getPassword();
      } catch (error) {
        throw new KeyringError(error instanceof Error ? error.message : "no se pudo leer el llavero");
      }
    },
    write(value) {
      try {
        entry.setPassword(value);
      } catch (error) {
        throw new KeyringError(error instanceof Error ? error.message : "no se pudo escribir en el llavero");
      }
    },
    delete() {
      try {
        entry.deletePassword();
      } catch (error) {
        throw new KeyringError(error instanceof Error ? error.message : "no se pudo borrar el llavero");
      }
    },
  };
}
