const express = require("express");
const jwt = require("jsonwebtoken");
const { addProductSchema, savedSearchMatches, SENSITIVE_USER_FIELDS } = require("../validation");

// Each check is a small, self-contained async function: read-only against
// the real database and config, never writes anything, never calls a
// third-party API (bKash, SMTP, Groq) for real - those are checked by
// config presence only, not by actually sending something. That's what
// makes this safe to run in production, on demand, as many times as
// someone wants, without side effects or cost.
//
// A check returns { passed, message }. The route wraps each with timing
// and error handling before sending results back.

function createSystemTestRoutes({
  verifyJWT,
  asyncHandler,
  usersCollection,
  productsCollection,
  categoriesCollection,
  bookingCollection,
  platformFeeCollection,
  admin,
}) {
  const router = express.Router();

  // Deliberately narrower than verifyAdmin/verifyMainAdmin: exactly
  // role === "Developer" or role === "Admin" (the single root Admin, not
  // Moderators) - this runs real queries against production data and
  // reports on internal config, so it stays as tight as the person asking
  // for it specified, not "any staff member."
  const verifyDeveloperOrMainAdmin = asyncHandler(async (req, res, next) => {
    const user = await usersCollection.findOne({ email: req.decoded.email });
    if (user?.role !== "Developer" && user?.role !== "Admin") {
      return res.status(403).send({ message: "forbidden access" });
    }
    next();
  });

  const timed = async (fn) => {
    const start = Date.now();
    const result = await fn();
    return { ...result, ms: Date.now() - start };
  };

  const checks = {
    async database_connectivity() {
      await usersCollection.estimatedDocumentCount();
      return { passed: true, message: "Connected." };
    },

    async validation_schema_sanity() {
      const good = addProductSchema.safeParse({
        productName: "Test Item",
        purchaseYear: new Date().getFullYear(),
        condition: "Used - Good",
        location: "Dhaka",
        phone: "01700000000",
        description: "A test description long enough to pass validation.",
        images: ["https://example.com/a.jpg"],
        originalPrice: 1000,
        resalePrice: 500,
        category: "Test",
      });
      const bad = addProductSchema.safeParse({ productName: "" });
      if (!good.success || bad.success) {
        return { passed: false, message: "Schema accepted bad input or rejected good input." };
      }
      return { passed: true, message: "Accepts valid listings, rejects invalid ones." };
    },

    async saved_search_matcher_logic() {
      const product = { email: "seller@test", productName: "Test Laptop", description: "", resalePrice: 1000 };
      const shouldMatch = savedSearchMatches(product, { email: "buyer@test", keyword: "laptop", maxPrice: 1500 });
      const shouldNotMatch = savedSearchMatches(product, { email: "seller@test", maxPrice: 999999 });
      if (!shouldMatch || shouldNotMatch) {
        return { passed: false, message: "Matcher returned an unexpected result for known inputs." };
      }
      return { passed: true, message: "Matches real listings, skips sellers alerting on themselves." };
    },

    async jwt_round_trip() {
      if (!process.env.ACCESS_TOKEN) {
        return { passed: false, message: "ACCESS_TOKEN is not set." };
      }
      const token = jwt.sign({ email: "healthcheck@test" }, process.env.ACCESS_TOKEN, { expiresIn: "1m" });
      const decoded = jwt.verify(token, process.env.ACCESS_TOKEN);
      if (decoded.email !== "healthcheck@test") {
        return { passed: false, message: "Signed and verified payload didn't match." };
      }
      return { passed: true, message: "Sign/verify round-trip works." };
    },

    // Direct regression guard for a real vulnerability fixed in this
    // codebase: /allsellers, /allbuyers, and /allusers used to send the
    // full raw user document - including live 2FA secrets - to any
    // Admin/Moderator session. This confirms the shared projection
    // actually strips those fields from a real query result.
    async admin_user_list_excludes_2fa_secrets() {
      const sample = await usersCollection
        .find({})
        .project(SENSITIVE_USER_FIELDS)
        .limit(5)
        .toArray();
      const leaked = sample.some((u) => u.twoFactor?.secret || u.twoFactor?.backupCodeHashes);
      if (leaked) {
        return { passed: false, message: "A 2FA secret or backup code hash was present in a projected result!" };
      }
      return { passed: true, message: "twoFactor secrets are correctly excluded from list projections." };
    },

    async category_integrity() {
      const knownCategories = new Set(
        (await categoriesCollection.find({}).project({ Category: 1 }).toArray()).map((c) => c.Category)
      );
      const orphaned = await productsCollection
        .find({ category: { $nin: Array.from(knownCategories) } })
        .project({ productName: 1, category: 1 })
        .limit(5)
        .toArray();
      if (orphaned.length > 0) {
        return {
          passed: false,
          message: `${orphaned.length} listing(s) reference a category that no longer exists, e.g. "${orphaned[0].productName}" -> "${orphaned[0].category}".`,
        };
      }
      return { passed: true, message: "Every listing's category exists in the categories collection." };
    },

    async booking_price_sanity() {
      const bookings = await bookingCollection
        .find({ status: { $in: ["Booked", "Paid"] } })
        .project({ price: 1, depositAmount: 1 })
        .limit(50)
        .toArray();
      const broken = bookings.filter(
        (b) => !(Number(b.price) > 0) || (b.depositAmount && Number(b.depositAmount) > Number(b.price))
      );
      if (broken.length > 0) {
        return { passed: false, message: `${broken.length} of ${bookings.length} sampled bookings have an invalid price/deposit.` };
      }
      return { passed: true, message: `Sampled ${bookings.length} active bookings - all have sane price/deposit values.` };
    },

    async platform_fee_consistency() {
      const [paidCount, feeCount] = await Promise.all([
        bookingCollection.countDocuments({ status: "Paid" }),
        platformFeeCollection.countDocuments({ type: "SaleFee" }),
      ]);
      // Not expected to match exactly forever (fee tracking was added
      // after some early Paid orders may have gone through), so this is
      // a soft flag rather than a hard failure - only complain on a big
      // gap, which would suggest the fee-charging code path broke.
      const gap = Math.abs(paidCount - feeCount);
      if (paidCount > 5 && gap > Math.max(3, paidCount * 0.2)) {
        return {
          passed: false,
          message: `${paidCount} Paid orders vs ${feeCount} platform-fee records - gap looks too large to be historical.`,
        };
      }
      return { passed: true, message: `${paidCount} Paid orders, ${feeCount} platform-fee records - roughly in line.` };
    },

    async firebase_admin_reachable() {
      await admin.auth().listUsers(1);
      return { passed: true, message: "Firebase service account credentials are valid." };
    },
  };

  // Config presence only - never actually sends an email, calls bKash, or
  // calls Groq. These are informational: reported in the response,
  // but never flip the overall run to "failed" the way a real check does,
  // since running without them is a valid, supported configuration.
  const configStatus = () => ({
    smtp: !!(process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS),
    bkash: !!(process.env.BKASH_USERNAME && process.env.BKASH_APP_KEY && process.env.BKASH_APP_SECRET),
    groq: !!process.env.GROQ_API_KEY,
    sentry: !!process.env.SENTRY_DSN,
  });

  router.get(
    "/system-tests/run",
    verifyJWT,
    verifyDeveloperOrMainAdmin,
    asyncHandler(async (req, res) => {
      const results = [];
      for (const [name, fn] of Object.entries(checks)) {
        try {
          const result = await timed(() => fn());
          results.push({ name, ...result });
        } catch (err) {
          results.push({ name, passed: false, message: err.message, ms: 0 });
        }
      }
      const passed = results.filter((r) => r.passed).length;
      res.send({
        results,
        summary: { passed, failed: results.length - passed, total: results.length },
        config: configStatus(),
        ranAt: new Date(),
      });
    })
  );

  return router;
}

module.exports = createSystemTestRoutes;
