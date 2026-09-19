/**
 * Test environment.
 *
 * **Loopback is allowed here, on purpose, and only here.** The dispatch and watcher suites post to
 * a real HTTP server on `127.0.0.1` rather than mocking `fetch`, because a real socket proves the
 * request is well formed and a mock only proves we called the function we wrote. The SSRF guard
 * refuses loopback by default, which is exactly correct in production and exactly wrong for a
 * test that deliberately points at a local server.
 *
 * Using the real escape hatch rather than a test-only bypass matters: it means the tests exercise
 * the same code path an operator with an internal Jira uses, so if `STRATA_SSRF_ALLOW` ever stops
 * working the suite notices.
 */
process.env.STRATA_SSRF_ALLOW = "127.0.0.1,localhost,[::1]";
