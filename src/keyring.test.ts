import { describe, expect, it } from "vitest";
import { KEYRING_SERVICE } from "./auth.ts";
import { KEYRING_ENTRY_OPTIONS } from "./keyring.ts";

describe("keyring", () => {
  it("uses the requested service and sets secret-service on Linux", () => {
    expect(KEYRING_SERVICE).toBe("copilot-agents-mcp:github.com");
    expect(KEYRING_ENTRY_OPTIONS.linux?.store).toBe("secret-service");
  });
});
