const express = require("express");

// Simple "is this account X?" lookups a logged-in user makes about their
// own account (terms acceptance, admin/seller/buyer/verified status).
// Every route here is guarded by verifySelf, so a token can only ever
// look up the account it belongs to - see middleware.js for why that
// matters (this used to be openly enumerable by email before that check
// was added).
function createUserSelfRoutes({ usersCollection, verifyJWT, verifySelf, asyncHandler, STAFF_ROLES }) {
  const router = express.Router();

  // Checked on every login so first-time Google sign-ins (and any legacy
  // account from before this feature existed) get routed to /accept-terms.
  router.get(
    "/users/terms/:email",
    verifyJWT,
    verifySelf,
    asyncHandler(async (req, res) => {
      const user = await usersCollection.findOne({ email: req.params.email });
      res.send({ termsAccepted: user?.termsAccepted === true });
    })
  );

  // The /accept-terms page's "I Accept" button.
  router.patch(
    "/user/accept-terms",
    verifyJWT,
    asyncHandler(async (req, res) => {
      const result = await usersCollection.updateOne(
        { email: req.decoded.email },
        { $set: { termsAccepted: true, termsAcceptedAt: new Date() } }
      );
      // If no user document matched, the flag was never actually persisted -
      // let the client know so it doesn't treat this as a success.
      if (result.matchedCount === 0) {
        return res.status(404).send({ message: "User not found", ...result });
      }
      res.send({ termsAccepted: true, ...result });
    })
  );

  router.get(
    "/users/admin/:email",
    verifyJWT,
    verifySelf,
    asyncHandler(async (req, res) => {
      const user = await usersCollection.findOne({ email: req.params.email });
      res.send({ isAdmin: STAFF_ROLES.includes(user?.role) });
    })
  );

  router.get(
    "/users/role/:email",
    verifyJWT,
    verifySelf,
    asyncHandler(async (req, res) => {
      const user = await usersCollection.findOne({ email: req.params.email });
      res.send({ role: user?.role || null });
    })
  );

  router.get(
    "/users/seller/:email",
    verifyJWT,
    verifySelf,
    asyncHandler(async (req, res) => {
      const user = await usersCollection.findOne({ email: req.params.email });
      res.send({ isSeller: user?.role === "Seller" });
    })
  );

  router.get(
    "/users/buyer/:email",
    verifyJWT,
    verifySelf,
    asyncHandler(async (req, res) => {
      const user = await usersCollection.findOne({ email: req.params.email });
      res.send({ isBuyer: user?.role === "Buyer" });
    })
  );

  router.get(
    "/users/verify/:email",
    verifyJWT,
    verifySelf,
    asyncHandler(async (req, res) => {
      const user = await usersCollection.findOne({ email: req.params.email });
      res.send({ isVerified: user?.verified === true });
    })
  );

  return router;
}

module.exports = createUserSelfRoutes;
