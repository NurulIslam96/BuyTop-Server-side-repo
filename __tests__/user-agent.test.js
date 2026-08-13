const { describeUserAgent } = require("../routes/security");

// Feeds the login-activity table on Settings > Security (see
// logLoginActivity in index.js) - wrong output here doesn't break
// anything functionally, but it does make the "does this login look like
// me?" check less useful, which is the whole point of that page.

describe("describeUserAgent", () => {
  test("identifies Chrome on Windows", () => {
    const ua =
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
    expect(describeUserAgent(ua)).toBe("Chrome on Windows");
  });

  test("identifies Safari on macOS (and doesn't misdetect it as Chrome)", () => {
    const ua =
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15";
    expect(describeUserAgent(ua)).toBe("Safari on macOS");
  });

  test("identifies Firefox on Linux", () => {
    const ua = "Mozilla/5.0 (X11; Linux x86_64; rv:109.0) Gecko/20100101 Firefox/115.0";
    expect(describeUserAgent(ua)).toBe("Firefox on Linux");
  });

  test("identifies Chrome on Android", () => {
    const ua =
      "Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36";
    expect(describeUserAgent(ua)).toBe("Chrome on Android");
  });

  test("identifies Edge distinctly from Chrome, since Edge UAs also contain 'Chrome/'", () => {
    const ua =
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 Edg/120.0.0.0";
    expect(describeUserAgent(ua)).toBe("Edge on Windows");
  });

  test("falls back gracefully on an empty or unrecognized user agent", () => {
    expect(describeUserAgent("")).toBe("Unknown browser on Unknown OS");
    expect(describeUserAgent("SomeWeirdBot/1.0")).toBe("Unknown browser on Unknown OS");
  });
});
