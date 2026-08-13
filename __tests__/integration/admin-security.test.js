jest.mock("firebase-admin");
jest.mock("firebase-admin/auth");

const request = require("supertest");
const { startTestApp, authHeader } = require("../../test-support/setupApp");

// See booking-concurrency.test.js for why this is raised from Jest's 5s
// default - real HTTP + real (if in-memory) MongoDB needs more headroom,
// especially on a cold mongod start.
jest.setTimeout(20000);

// HTTP-level version of the check in routes/system-tests.js
// (admin_user_list_excludes_2fa_secrets) - that one calls the projection
// logic directly, this one goes all the way through the real route,
// real middleware chain, and a real Mongo query, so it also catches a
// regression where someone removes .project(SENSITIVE_USER_FIELDS) from
// the route itself rather than the shared constant.
describe("Admin user lists never leak 2FA secrets over HTTP", () => {
  let ctx;

  beforeAll(async () => {
    ctx = await startTestApp();
    await ctx.db.collection("users").insertMany([
      {
        email: "root-admin@test.com",
        role: "Admin",
        name: "Root Admin",
      },
      {
        email: "seller-with-2fa@test.com",
        role: "Seller",
        name: "Seller With 2FA",
        twoFactor: {
          enabled: true,
          secret: "SUPERSECRETTOTPKEY",
          backupCodeHashes: ["deadbeef00", "deadbeef01"],
        },
      },
      {
        email: "buyer-with-2fa@test.com",
        role: "Buyer",
        name: "Buyer With 2FA",
        twoFactor: {
          enabled: true,
          secret: "ANOTHERSECRETKEY",
          backupCodeHashes: ["cafebabe00"],
        },
      },
    ]);
  }, 60000);

  afterAll(async () => {
    if (ctx) await ctx.cleanup();
  });

  test("GET /allsellers never includes twoFactor.secret or backupCodeHashes", async () => {
    const res = await request(ctx.app).get("/allsellers").set(authHeader("root-admin@test.com"));
    expect(res.status).toBe(200);
    const seller = res.body.find((u) => u.email === "seller-with-2fa@test.com");
    expect(seller).toBeDefined();
    expect(seller.twoFactor?.secret).toBeUndefined();
    expect(seller.twoFactor?.backupCodeHashes).toBeUndefined();
    expect(seller.twoFactor?.pendingSecret).toBeUndefined();
  });

  test("GET /allbuyers never includes twoFactor.secret or backupCodeHashes", async () => {
    const res = await request(ctx.app).get("/allbuyers").set(authHeader("root-admin@test.com"));
    expect(res.status).toBe(200);
    const buyer = res.body.find((u) => u.email === "buyer-with-2fa@test.com");
    expect(buyer).toBeDefined();
    expect(buyer.twoFactor?.secret).toBeUndefined();
    expect(buyer.twoFactor?.backupCodeHashes).toBeUndefined();
  });

  test("GET /allusers never includes twoFactor.secret or backupCodeHashes", async () => {
    const res = await request(ctx.app).get("/allusers").set(authHeader("root-admin@test.com"));
    expect(res.status).toBe(200);
    const leaked = res.body.some((u) => u.twoFactor?.secret || u.twoFactor?.backupCodeHashes);
    expect(leaked).toBe(false);
  });

  test("a non-staff account is rejected before it ever sees the list", async () => {
    await ctx.db.collection("users").insertOne({ email: "plain-buyer@test.com", role: "Buyer" });
    const res = await request(ctx.app).get("/allsellers").set(authHeader("plain-buyer@test.com"));
    expect(res.status).toBe(403);
  });
});
