const express = require("express");

function createDeveloperToolsRoutes({
  verifyJWT,
  verifyMainAdmin,
  verifyFirebaseToken,
  verifySelf,
  asyncHandler,
  developerEmailsCollection,
  usersCollection,
  productsCollection,
  bookingCollection,
  admin,
  logAudit,
}) {
  const router = express.Router();

  // ---- Developer email allowlist ------------------------------------------
  //
  // An Admin can add a teammate's email here from the dashboard so that
  // account can sign up/log in without ever needing to click a real
  // activation link - useful for throwaway/unreachable test addresses
  // (e.g. "testing@gmail.com") and for onboarding other developers
  // quickly. This is the only sanctioned way to skip email verification.
  const isDeveloperEmail = async (email) =>
    !!(await developerEmailsCollection.findOne({ email: email.toLowerCase() }));

  // Root-Admin-only management, same sensitivity level as assigning
  // Admin/Moderator roles (verifyMainAdmin), since this controls who can
  // skip email verification entirely.
  router.get(
    "/developer-emails",
    verifyJWT,
    verifyMainAdmin,
    asyncHandler(async (req, res) => {
      const list = await developerEmailsCollection.find().sort({ createdAt: -1 }).toArray();
      res.send(list);
    })
  );

  router.post(
    "/developer-emails",
    verifyJWT,
    verifyMainAdmin,
    asyncHandler(async (req, res) => {
      const email = typeof req.body?.email === "string" ? req.body.email.trim().toLowerCase() : "";
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        return res.status(400).send({ message: "Enter a valid email address" });
      }
      const doc = { email, addedBy: req.staffUser.email, createdAt: new Date() };
      try {
        await developerEmailsCollection.insertOne(doc);
      } catch (err) {
        if (err.code === 11000) {
          return res.status(409).send({ message: "That email is already on the developer list" });
        }
        throw err;
      }
      // If this person already has a real Firebase account sitting
      // unverified, unblock it immediately rather than making them wait
      // for their next /verify-email visit.
      try {
        const firebaseUser = await admin.auth().getUserByEmail(email);
        if (!firebaseUser.emailVerified) {
          await admin.auth().updateUser(firebaseUser.uid, { emailVerified: true });
        }
      } catch (err) {
        // No Firebase account yet for this email - fine, it's picked up
        // the moment they actually sign up (see /developer-emails/activate).
      }
      logAudit(req, "developer_email_allowlisted", { email });
      res.send(doc);
    })
  );

  router.delete(
    "/developer-emails/:email",
    verifyJWT,
    verifyMainAdmin,
    asyncHandler(async (req, res) => {
      const result = await developerEmailsCollection.deleteOne({
        email: req.params.email.toLowerCase(),
      });
      logAudit(req, "developer_email_removed", { email: req.params.email.toLowerCase() });
      res.send(result);
    })
  );

  // Called automatically by the client's /verify-email page (not a
  // visible button) whenever the signed-in email isn't Firebase-verified
  // yet. Only does anything if that email is actually on the allowlist
  // above - for anyone else it's a no-op 403 and the normal "check your
  // inbox" flow continues untouched.
  router.post(
    "/developer-emails/activate",
    verifyFirebaseToken,
    asyncHandler(async (req, res) => {
      const email = req.firebaseUser.email;
      if (!(await isDeveloperEmail(email))) {
        return res.status(403).send({ message: "This email is not on the developer list" });
      }
      if (!req.firebaseUser.email_verified) {
        await admin.auth().updateUser(req.firebaseUser.uid, { emailVerified: true });
      }
      res.send({ message: "ok" });
    })
  );

  // Read-only version of the same check, used by the client to decide
  // whether to bypass maintenance mode for this signed-in email (see
  // Main.js) - separate from /activate above since this one must never
  // have the side effect of flipping Firebase's emailVerified flag. Also
  // true for a real "Developer"-role login (see /developer-accounts) -
  // otherwise a Developer account would be locked out of the exact
  // windows (maintenance/testing) it exists to test through.
  router.get(
    "/developer-emails/check/:email",
    verifyJWT,
    verifySelf,
    asyncHandler(async (req, res) => {
      const email = req.params.email;
      const [onAllowlist, user] = await Promise.all([
        isDeveloperEmail(email),
        usersCollection.findOne({ email }),
      ]);
      res.send({ isDeveloper: onAllowlist || user?.role === "Developer" });
    })
  );

  // ---- Developer test accounts ---------------------------------------------
  //
  // Distinct from the allowlist above: this actually creates the login (a
  // real Firebase account, pre-verified, with a password the Admin sets
  // here) rather than just letting an eventual self-signup skip
  // verification. The account is dropped straight into usersCollection
  // with role "Developer" - a role nothing else in this file treats as
  // Buyer, Seller, or staff, so a Developer account lands on the plain
  // dashboard welcome page with none of the seller/buyer nav and never
  // shows up in seller/buyer counts, All Sellers, etc. Root-Admin-only,
  // same sensitivity as assigning roles.
  router.get(
    "/developer-accounts",
    verifyJWT,
    verifyMainAdmin,
    asyncHandler(async (req, res) => {
      const list = await usersCollection
        .find({ role: "Developer" })
        .sort({ _id: -1 })
        .toArray();
      res.send(list);
    })
  );

  router.post(
    "/developer-accounts",
    verifyJWT,
    verifyMainAdmin,
    asyncHandler(async (req, res) => {
      const email = typeof req.body?.email === "string" ? req.body.email.trim().toLowerCase() : "";
      const password = typeof req.body?.password === "string" ? req.body.password : "";
      const name = typeof req.body?.name === "string" ? req.body.name.trim() : "";
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        return res.status(400).send({ message: "Enter a valid email address" });
      }
      if (password.length < 6) {
        return res.status(400).send({ message: "Password must be at least 6 characters" });
      }
      const existingUser = await usersCollection.findOne({ email });
      if (existingUser) {
        return res.status(409).send({ message: "That email already belongs to an existing account" });
      }

      let firebaseUser;
      try {
        firebaseUser = await admin.auth().createUser({
          email,
          password,
          emailVerified: true,
          displayName: name || undefined,
        });
      } catch (err) {
        if (err.code === "auth/email-already-exists") {
          return res.status(409).send({ message: "That email is already registered in Firebase" });
        }
        if (err.code === "auth/invalid-password") {
          return res.status(400).send({ message: "Password must be at least 6 characters" });
        }
        throw err;
      }

      const doc = {
        email,
        name: name || email.split("@")[0],
        photo: "",
        role: "Developer",
        verified: false,
        termsAccepted: true,
        createdAt: new Date(),
        createdBy: req.staffUser.email,
      };
      try {
        await usersCollection.insertOne(doc);
      } catch (err) {
        // Mongo write failed after the Firebase account was already made
        // - clean up so this email isn't stuck half-created.
        await admin.auth().deleteUser(firebaseUser.uid).catch(() => {});
        throw err;
      }
      logAudit(req, "developer_account_created", { email });
      res.send(doc);
    })
  );

  router.delete(
    "/developer-accounts/:email",
    verifyJWT,
    verifyMainAdmin,
    asyncHandler(async (req, res) => {
      const email = req.params.email.toLowerCase();
      const user = await usersCollection.findOne({ email, role: "Developer" });
      if (!user) {
        return res.status(404).send({ message: "No developer account found for that email" });
      }
      await usersCollection.deleteOne({ email, role: "Developer" });
      try {
        const firebaseUser = await admin.auth().getUserByEmail(email);
        await admin.auth().deleteUser(firebaseUser.uid);
      } catch (err) {
        // No matching Firebase account (or already gone) - the Mongo
        // side is still fully cleaned up above, which is what actually
        // revokes dashboard access, so this is fine to ignore.
      }
      logAudit(req, "developer_account_removed", { email });
      res.send({ message: "Developer account removed" });
    })
  );

  // ---- Demo data cleanup ---------------------------------------------------
  //
  // A Developer's test-mode products/bookings pile up over time (see
  // isDemo throughout this file); these let a Developer clear out their
  // own, or a root Admin clear out everyone's at once.

  router.delete(
    "/demo-data/mine",
    verifyJWT,
    asyncHandler(async (req, res) => {
      const requester = await usersCollection.findOne({ email: req.decoded.email });
      if (!requester || requester.role !== "Developer") {
        return res.status(403).send({ message: "forbidden access" });
      }
      const myDemoProducts = await productsCollection
        .find({ email: requester.email, isDemo: true })
        .toArray();
      const myDemoProductIds = myDemoProducts.map((p) => String(p._id));
      const bookingsResult = await bookingCollection.deleteMany({
        $or: [
          { email: requester.email, isDemo: true },
          { productId: { $in: myDemoProductIds } },
        ],
      });
      const productsResult = await productsCollection.deleteMany({
        email: requester.email,
        isDemo: true,
      });
      logAudit(req, "demo_data_purged_own", {
        productsDeleted: productsResult.deletedCount,
        bookingsDeleted: bookingsResult.deletedCount,
      });
      res.send({
        message: "Your demo data has been cleared",
        productsDeleted: productsResult.deletedCount,
        bookingsDeleted: bookingsResult.deletedCount,
      });
    })
  );

  router.delete(
    "/demo-data/all",
    verifyJWT,
    verifyMainAdmin,
    asyncHandler(async (req, res) => {
      const [bookingsResult, productsResult] = await Promise.all([
        bookingCollection.deleteMany({ isDemo: true }),
        productsCollection.deleteMany({ isDemo: true }),
      ]);
      logAudit(req, "demo_data_purged_all", {
        productsDeleted: productsResult.deletedCount,
        bookingsDeleted: bookingsResult.deletedCount,
      });
      res.send({
        message: "All demo data has been cleared",
        productsDeleted: productsResult.deletedCount,
        bookingsDeleted: bookingsResult.deletedCount,
      });
    })
  );

  return router;
}

module.exports = createDeveloperToolsRoutes;
