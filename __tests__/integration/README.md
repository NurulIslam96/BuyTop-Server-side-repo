# Integration tests

These hit the **real Express app** - real routes, real middleware, real
Mongo queries - through `supertest`, against a throwaway MongoDB spun up
fresh for each test file. Nothing here is a hand-rolled substitute for
production code; if a route changes, these break for real reasons.

## Running them

```bash
npm test
```

Runs both the plain unit tests (`__tests__/*.test.js`) and these
integration tests (`__tests__/integration/*.test.js`) together.

**First run needs internet access.** `mongodb-memory-server` downloads a
real `mongod` binary (~100-400MB) from MongoDB's own CDN the first time
it's used, then caches it locally - every run after that is fast and
fully offline. If your machine is behind a firewall that blocks
`fastdl.mongodb.org`, see "Alternative: a real test database" below.

## How auth works in these tests

BuyTop has two auth layers (see `API_REFERENCE.md`):
1. A real Firebase ID token, checked only by `PUT /user/:email` (login/signup).
2. The app's own JWT (signed with `ACCESS_TOKEN`), checked by `verifyJWT` on
   almost everything else.

There's no way to mint a real, verifiable Firebase ID token for a
throwaway test user without an actual Firebase project - so **`PUT
/user/:email` (the login/signup route itself) is intentionally not
covered by these tests.** `firebase-admin` is mocked (see `__mocks__/`)
just enough that requiring the app doesn't crash on startup; it's not a
working fake Firebase.

Every other route is tested the real way: `test-support/setupApp.js`
mints a real app JWT with `signTestJWT(email)` / `authHeader(email)`,
using the exact same `ACCESS_TOKEN` the running app checks against - this
is exactly what a real client would present after actually logging in,
not a bypass around auth.

## Adding a new integration test

```js
jest.mock("firebase-admin");
jest.mock("firebase-admin/auth");

const request = require("supertest");
const { startTestApp, authHeader } = require("../../test-support/setupApp");

describe("...", () => {
  let ctx;

  beforeAll(async () => {
    ctx = await startTestApp();
    // seed whatever users/products/bookings this test needs directly:
    await ctx.db.collection("users").insertOne({ email: "buyer@test.com", role: "Buyer" });
  }, 60000); // mongod startup can be slow on a cold cache - give it room

  afterAll(async () => {
    if (ctx) await ctx.cleanup();
  });

  test("...", async () => {
    const res = await request(ctx.app).get("/some-route").set(authHeader("buyer@test.com"));
    expect(res.status).toBe(200);
  });
});
```

The `jest.mock(...)` calls **must** be the first two lines - Jest hoists
them above the `require`s below, but only within the same file, and only
if they're actually present before anything imports `index.js`
(indirectly, via `setupApp.js`).

## Alternative: a real test database

If `mongodb-memory-server` can't download its binary in your environment,
point `MONGO_URI` (in `setupApp.js`, or via env before running tests) at
any real, disposable MongoDB instance instead - a local `mongod`, a free
Atlas cluster used only for tests, or a Docker container. The app itself
doesn't care where `MONGO_URI` points; `mongodb-memory-server` is just the
zero-setup default.
