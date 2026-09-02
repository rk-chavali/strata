import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    /*
      Runs before every suite in this package.

      Its whole job is allowing loopback through the SSRF guard, because the dispatch and watcher
      suites talk to a real HTTP server on 127.0.0.1 instead of mocking `fetch`. See
      `src/test-setup.ts` for why that is the right trade.
    */
    setupFiles: ["./src/test-setup.ts"],
    /*
      Git operations against temporary repositories are genuinely slow on Windows, where the
      bootstrap and watcher suites each clone several times. The default five seconds fails on a
      cold filesystem cache and passes on a warm one, which is the worst kind of flaky.
    */
    testTimeout: 30_000,
  },
});
