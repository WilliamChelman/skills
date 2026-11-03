---
name: bun-browser-testing
description: Test or verify something in a live browser: navigate a page, click, type, screenshot, or assert on rendered DOM. Uses Bun 1.4's Bun.WebView to drive a real Chrome browser from a test. Prefer this over Chrome MCP.
---

# Bun live browser testing

`Bun.WebView` is a runtime API you call inside a normal `bun test` file. There is no browser test-runner mode and no `--browser` flag. It drives a real browser, so reach for it when you need to check an actually rendered page: navigate, click, type, screenshot, or assert on the live DOM. The API is experimental; this covers Bun 1.4.0 behavior.

## Working test

```ts
import { test, expect } from "bun:test";

test("live browser via Bun.WebView", async () => {
  // Serve the page under test locally instead of hitting the network
  using server = Bun.serve({
    port: 0,
    fetch: () =>
      new Response(`<button id="btn" onclick="document.title='clicked'">go</button>`, { headers: { "content-type": "text/html" } }),
  });

  await using view = new Bun.WebView({ backend: "chrome" });
  await view.navigate(`http://localhost:${server.port}/`);
  await view.click("#btn"); // hangs until the test timeout if #btn never renders
  expect(await view.evaluate("document.title")).toBe("clicked");
  await Bun.write("shot.png", await view.screenshot()); // screenshot() returns a Blob
}, 15_000); // explicit timeout is mandatory, see rules below
```

## Rules that keep it working

- Pass `backend: "chrome"` on every platform, macOS included, for consistent behavior. Chrome is auto-discovered with zero config. The macOS default is WebKit; do not use it.
- `click(selector)` auto-waits and does not throw when the selector never appears. The test hangs until its timeout. There is no `waitForSelector`, so always pass an explicit `test(name, fn, timeoutMs)` and only target selectors you know will render.
- `screenshot()` returns a `Blob`. Save it with `await Bun.write("shot.png", await view.screenshot())`.
- Serve the page with `Bun.serve({ port: 0 })` and navigate to `localhost:${server.port}` to avoid network flake.
- `await using view = ...` closes the view at the end of scope.

## Apps that are already running

- Navigate to the project's dev server URL; `Bun.serve()` only pages you build yourself.
- Check the project's docs (e.g. `docs/agents/browser-testing.md`) for URL and sign-in before treating auth as a blocker. Local builds usually have a dev login or none.
- Chrome starts with an empty profile: no cookies or logins from the user's browser.
- `evaluate()` takes one expression. Statements: `(() => { ...; return x; })()`.
- No `waitForSelector`: `Bun.sleep()` after `navigate()` for SPAs.
- `net::ERR_EMPTY_RESPONSE` on `navigate()`: dev server rebuilding, retry.
