import { describe, expect, it } from "vitest";

describe("route census", () => {
  it("enumerates every route express actually has", async () => {
    const { app } = await import("./index.js");
    const found: string[] = [];
    const walk = (stack: unknown[]): void => {
      for (const layer of stack) {
        const e = layer as { route?: { path: string; methods: Record<string, boolean> }; handle?: { stack?: unknown[] } };
        if (e.route?.path) {
          for (const [m, on] of Object.entries(e.route.methods)) if (on) found.push(`${m.toUpperCase()} ${e.route.path}`);
          continue;
        }
        if (Array.isArray(e.handle?.stack)) walk(e.handle.stack);
      }
    };
    walk((app as unknown as { _router: { stack: unknown[] } })._router.stack);
    console.log("RUNTIME_ROUTE_COUNT=" + found.length);
    console.log(found.sort().join("\n"));
    expect(found.length).toBeGreaterThan(0);
  });
});
