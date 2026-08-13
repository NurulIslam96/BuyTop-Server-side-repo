jest.mock("firebase-admin");
jest.mock("firebase-admin/auth");

const request = require("supertest");
const { startTestApp, authHeader } = require("../../test-support/setupApp");

// Jest's 5s default per-test timeout is tight for HTTP requests hitting a
// real (if in-memory) MongoDB - especially the first query against a
// freshly-started mongod, and especially on Windows where process/IO
// startup is slower. 20s gives real headroom without masking an actual
// hang if something's genuinely broken.
jest.setTimeout(20000);

// Exercises the real fix for the double-booking race: two buyers hitting
// POST /mybooking for the same product at (as close to) the same instant
// as a test can manage. This only works because bookingCollection has a
// unique partial index on { productId }, filtered to isActiveBooking:
// true (created in index.js's dbConnect()) - without it, both requests
// would succeed and the product would end up with two active bookings.
describe("Booking concurrency - at most one active booking per product", () => {
  let ctx;
  let productId;

  beforeAll(async () => {
    ctx = await startTestApp();
    await ctx.db.collection("users").insertMany([
      { email: "buyer-a@test.com", role: "Buyer", name: "Buyer A" },
      { email: "buyer-b@test.com", role: "Buyer", name: "Buyer B" },
      { email: "seller@test.com", role: "Seller", name: "Seller" },
    ]);
    const product = await ctx.db.collection("products").insertOne({
      email: "seller@test.com",
      productName: "Race Condition Test Laptop",
      category: "Electronics",
      resalePrice: 20000,
      status: "Available",
      isDemo: false,
    });
    productId = product.insertedId;
  }, 60000);

  afterAll(async () => {
    if (ctx) await ctx.cleanup();
  });

  test("two simultaneous bookings on the same product: exactly one succeeds", async () => {
    const [resA, resB] = await Promise.all([
      request(ctx.app)
        .post("/mybooking")
        .set(authHeader("buyer-a@test.com"))
        .send({ productId: String(productId) }),
      request(ctx.app)
        .post("/mybooking")
        .set(authHeader("buyer-b@test.com"))
        .send({ productId: String(productId) }),
    ]);

    const statuses = [resA.status, resB.status].sort();
    // One booking is created (200), the other is rejected as already
    // booked (409) - never both 200 (double-booked) and never both
    // rejected (nobody got the item at all).
    expect(statuses).toEqual([200, 409]);

    const activeBookings = await ctx.db
      .collection("bookings")
      .find({ productId: String(productId), isActiveBooking: true })
      .toArray();
    expect(activeBookings).toHaveLength(1);
  });

  test("a third buyer is correctly turned away once the item is booked", async () => {
    await ctx.db.collection("users").insertOne({ email: "buyer-c@test.com", role: "Buyer", name: "Buyer C" });
    const res = await request(ctx.app)
      .post("/mybooking")
      .set(authHeader("buyer-c@test.com"))
      .send({ productId: String(productId) });
    expect([404, 409]).toContain(res.status);
  });

  test("booking price comes from the product record, not the request body", async () => {
    const product2 = await ctx.db.collection("products").insertOne({
      email: "seller@test.com",
      productName: "Price Tamper Test Item",
      category: "Electronics",
      resalePrice: 15000,
      status: "Available",
      isDemo: false,
    });
    await ctx.db.collection("users").insertOne({ email: "buyer-d@test.com", role: "Buyer", name: "Buyer D" });

    const res = await request(ctx.app)
      .post("/mybooking")
      .set(authHeader("buyer-d@test.com"))
      // Attempting to fabricate a much lower price than the real listing.
      .send({ productId: String(product2.insertedId), price: 1 });

    expect(res.status).toBe(200);
    const booking = await ctx.db.collection("bookings").findOne({
      productId: String(product2.insertedId),
    });
    expect(booking.price).toBe(15000);
  });
});
