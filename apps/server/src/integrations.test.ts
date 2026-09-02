import { describe, expect, it } from "vitest";
import {
  PROVIDERS,
  isReady,
  providerById,
  secretFields,
  secretKey,
  testProvider,
} from "./integrations.js";

/**
 * The provider registry.
 *
 * Two things here are worth guarding. **Readiness**, because a provider that reports itself ready
 * while half-configured fails at the moment it is needed, on a merge, when nobody is watching.
 * And the **webhook test**, because the only way to genuinely test an incoming webhook is to post
 * to it, and a test that wrote into someone's Slack channel to prove it could would be a
 * genuinely unpleasant surprise.
 */

describe("the registry", () => {
  it("gives every provider at least one event to fire on", () => {
    // A provider that responds to no event is a button, and a button is export with extra steps.
    for (const provider of PROVIDERS) {
      expect(provider.events.length).toBeGreaterThan(0);
    }
  });

  it("states capabilities for every provider", () => {
    for (const provider of PROVIDERS) {
      expect(provider.capabilities.length).toBeGreaterThan(0);
    }
  });

  it("resolves a provider by id and nothing by a bad one", () => {
    expect(providerById("jira")?.name).toBe("Jira");
    expect(providerById("nope")).toBeUndefined();
  });

  it("namespaces secrets per provider", () => {
    // Two providers both storing `token` must not collide in the secret store.
    expect(secretKey("jira", "token")).toBe("jira.token");
    expect(secretKey("github", "token")).toBe("github.token");
  });

  it("treats a webhook URL as a secret, not a setting", () => {
    const webhook = providerById("webhook")!;

    // An incoming webhook URL *is* a credential: anyone holding it can post to the channel. Put
    // in config it would be committed to the repo in plain text.
    expect(secretFields(webhook).map((field) => field.key)).toContain("url");
  });
});

describe("isReady", () => {
  const jira = providerById("jira")!;

  it("is false when a required text field is missing", () => {
    expect(
      isReady(jira, { baseUrl: "https://acme.atlassian.net" }, { token: { configured: true } }),
    ).toBe(false);
  });

  it("is false when a required secret is missing", () => {
    expect(
      isReady(jira, { baseUrl: "https://acme.atlassian.net", email: "a@b.c" }, { token: { configured: false } }),
    ).toBe(false);
  });

  it("is true once every required field is present", () => {
    expect(
      isReady(jira, { baseUrl: "https://acme.atlassian.net", email: "a@b.c" }, { token: { configured: true } }),
    ).toBe(true);
  });

  it("ignores optional fields", () => {
    // `projectKeys` is optional; a provider must not be held back by it.
    expect(
      isReady(jira, { baseUrl: "https://x", email: "a@b.c" }, { token: { configured: true } }),
    ).toBe(true);
  });

  it("treats whitespace as missing", () => {
    expect(
      isReady(jira, { baseUrl: "   ", email: "a@b.c" }, { token: { configured: true } }),
    ).toBe(false);
  });
});

describe("connection tests", () => {
  const webhook = providerById("webhook")!;

  it("does not call the webhook URL", async () => {
    /*
      No network stub needed, and that is the assertion: if this implementation ever started
      posting, this test would hang or fail against an unroutable host rather than passing.
    */
    const result = await testProvider(webhook, {}, { url: "https://hooks.slack.com/services/T/B/xyz123456" });
    expect(result.ok).toBe(true);
    expect(result.message).toContain("Not called");
  });

  it("rejects a webhook URL that is not https", async () => {
    const result = await testProvider(webhook, {}, { url: "http://hooks.example.com/abc" });

    // A webhook URL is a credential; over http it is sent in clear.
    expect(result.ok).toBe(false);
    expect(result.message).toContain("https");
  });

  it("rejects a malformed webhook URL", async () => {
    const result = await testProvider(webhook, {}, { url: "not a url" });
    expect(result.ok).toBe(false);
  });

  it("asks for the URL rather than guessing when it is absent", async () => {
    const result = await testProvider(webhook, {}, {});
    expect(result.ok).toBe(false);
    expect(result.message).toContain("required");
  });

  it("redacts the long path segments when describing where it would post", async () => {
    const result = await testProvider(webhook, {}, { url: "https://hooks.slack.com/services/T00/B00/aVeryLongSecretToken" });

    // The detail line ends up in screenshots and bug reports; the host is the useful part and
    // the token-shaped segment is not.
    expect(result.detail).toContain("hooks.slack.com");
    expect(result.detail).not.toContain("aVeryLongSecretToken");
  });

  it("reports missing credentials for Atlassian rather than attempting a call", async () => {
    const result = await testProvider(providerById("confluence")!, {}, {});
    expect(result.ok).toBe(false);
    expect(result.message).toContain("required");
  });

  it("reports a missing GitHub token rather than attempting a call", async () => {
    const result = await testProvider(providerById("github")!, {}, {});
    expect(result.ok).toBe(false);
    expect(result.message).toContain("token is required");
  });
});
