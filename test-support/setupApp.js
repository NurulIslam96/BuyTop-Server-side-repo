const { MongoMemoryServer } = require("mongodb-memory-server");
const { MongoClient } = require("mongodb");
const jwt = require("jsonwebtoken");

const TEST_ACCESS_TOKEN = "integration-test-access-token-secret";

// Spins up a real, throwaway MongoDB (no Docker, no real Atlas - a real
// mongod binary downloaded once and cached by mongodb-memory-server),
// points index.js at it via the MONGO_URI override, and requires the
// real app fresh so every route, every middleware, and every Mongo query
// in this test run is the actual production code path - not a
// hand-rolled substitute for it.
//
// Call this from a fresh test file (jest resets the module registry per
// file by default) that has ALREADY called jest.mock("firebase-admin")
// and jest.mock("firebase-admin/auth") at its top, before any require -
// see test-support/fakeAuth.js for why that's necessary and
// what it deliberately doesn't cover.
async function startTestApp() {
  const mongod = await MongoMemoryServer.create();
  process.env.MONGO_URI = mongod.getUri();
  process.env.DB_USER = "unused-see-MONGO_URI";
  process.env.DB_PASSWORD = "unused-see-MONGO_URI";
  process.env.ACCESS_TOKEN = TEST_ACCESS_TOKEN;
  // Never touched for real - firebase-admin is mocked, so admin.cert()
  // just passes this through unread. Only needs to be valid JSON.
  process.env.FIREBASE_SERVICE_ACCOUNT_KEY = JSON.stringify({
    project_id: "test-project",
    client_email: "test@test-project.iam.gserviceaccount.com",
    private_key: "not-a-real-key",
  });
  process.env.CLIENT_URL = "http://localhost:3000";
  process.env.PORT = "0"; // irrelevant - app.listen() is skipped, see index.js's require.main guard

  jest.resetModules();
  const app = require("../index.js");

  // A second, independent connection to the same in-memory instance, for
  // tests to seed/inspect data directly - this is deliberately separate
  // from index.js's own internal connection (now exposed read-only via
  // app.locals.mongoClient, see index.js) so tests never reach into the
  // app's internals to query through it.
  const dbClient = new MongoClient(mongod.getUri());
  await dbClient.connect();
  const db = dbClient.db("dbBuyTop");

  // index.js's own dbConnect() (triggered by requiring it above) runs
  // async and unawaited - give it a moment to actually finish connecting
  // and creating indexes before the first request, or early requests
  // could hit the "database not ready yet" 503 middleware.
  await new Promise((resolve) => setTimeout(resolve, 300));

  return {
    app,
    db,
    dbClient,
    mongod,
    async cleanup() {
      // Close BOTH connections - this test's own, and index.js's
      // internal one (via app.locals.mongoClient). Leaving the app's own
      // client open after mongod.stop() below is what previously showed
      // up as "a worker process has failed to exit gracefully": a
      // dangling connection with its own keep-alive timers, not an
      // actual leak in the app itself.
      await Promise.all([dbClient.close(), app.locals.mongoClient?.close()]);
      await mongod.stop();
    },
  };
}

// Mints a real, valid app JWT the same way POST /2fa/verify-login or a
// normal login would - this is what every verifyJWT-protected route
// actually checks, so this is the correct way to act "as" a given user
// in a test, not a shortcut around real auth.
function signTestJWT(email) {
  return jwt.sign({ email }, TEST_ACCESS_TOKEN, { expiresIn: "1h" });
}

function authHeader(email) {
  return { Authorization: `Bearer ${signTestJWT(email)}` };
}

module.exports = { startTestApp, signTestJWT, authHeader };
