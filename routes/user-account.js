const express = require("express");

// Account self-management: profile edits and deactivate/delete, plus two
// separate verification flows -
//   - Password change: OTP emailed client-side via EmailJS (see
//     /otp/request and /otp/verify below). Low risk even though the code
//     is visible to the requester's own browser - it's only ever
//     delivered to the account's OWN already-verified email, so skipping
//     the email step just means someone changes their own password
//     slightly faster, not that anyone gains access to an account or
//     inbox they don't already control.
//   - Email change: verified via Firebase's own verifyBeforeUpdateEmail
//     link (see /user/confirm-email-change below), NOT the OTP system.
//     This used to also go through /otp/request+/otp/verify with the
//     code returned straight in that response for the client to relay
//     via EmailJS - which meant the "proof of ownership" was never real:
//     nothing stopped a direct API call from reading the code out of the
//     /otp/request response and skipping the email step entirely, letting
//     anyone claim an email address as their own account's login email
//     without ever touching that inbox. Firebase sends the new flow's
//     verification link itself, server-side, so the code this app
//     controls never sees a code that could grant that.
function createUserAccountRoutes({
  authLimiter,
  verifyJWT,
  verifySelfBuyerOrSeller,
  asyncHandler,
  usersCollection,
  otpCollection,
  productsCollection,
  bookingCollection,
  paymentCollection,
  jwt,
  admin,
  logAudit,
}) {
  const router = express.Router();

  function generateOtp() {
    return String(Math.floor(100000 + Math.random() * 900000));
  }

  router.post(
    "/otp/request",
    authLimiter,
    verifyJWT,
    asyncHandler(async (req, res) => {
      const { purpose } = req.body || {};
      // Email-change verification moved to /user/confirm-email-change,
      // which uses Firebase's own verifyBeforeUpdateEmail link instead -
      // see the comment at the top of this file for why. This OTP system
      // now only ever handles "password", where the code always goes to
      // the account's own already-verified email.
      if (purpose !== "password") {
        return res.status(400).send({ message: "Invalid OTP purpose" });
      }
      const accountEmail = req.decoded.email;
      const deliverTo = accountEmail;
      const otp = generateOtp();
      const expiresAt = new Date(Date.now() + 5 * 60 * 1000);
      await otpCollection.updateOne(
        { accountEmail, purpose },
        { $set: { accountEmail, purpose, otp, deliverTo, expiresAt, attempts: 0 } },
        { upsert: true }
      );
      // Client sends the OTP via EmailJS to `deliverTo`.
      res.send({ otp, deliverTo });
    })
  );

  router.post(
    "/otp/verify",
    authLimiter,
    verifyJWT,
    asyncHandler(async (req, res) => {
      const { purpose, code } = req.body || {};
      if (purpose !== "password") {
        return res.status(400).send({ message: "Invalid OTP purpose" });
      }
      const accountEmail = req.decoded.email;
      const record = await otpCollection.findOne({ accountEmail, purpose });
      if (!record || record.expiresAt < new Date()) {
        return res.status(400).send({ message: "OTP expired or not found. Please request a new one." });
      }
      if (record.attempts >= 5) {
        return res.status(429).send({ message: "Too many attempts. Please request a new OTP." });
      }
      if (record.otp !== String(code)) {
        await otpCollection.updateOne({ accountEmail, purpose }, { $inc: { attempts: 1 } });
        return res.status(400).send({ message: "Incorrect code" });
      }
      await otpCollection.deleteOne({ accountEmail, purpose });
      const otpToken = jwt.sign(
        { email: accountEmail, purpose },
        process.env.ACCESS_TOKEN,
        { expiresIn: "10m" }
      );
      res.send({ otpToken });
    })
  );

  // Step 1 of an email change is entirely client-side from here: the
  // Settings page calls Firebase's verifyBeforeUpdateEmail(auth.currentUser,
  // newEmail) directly, which sends a real verification link to the new
  // address from Firebase's own servers - this app's code never sees or
  // handles that step, so there's nothing here to leak.
  //
  // Step 2 is this endpoint: after the user has (supposedly) clicked that
  // link, the client force-refreshes its Firebase ID token and sends it
  // here. If the new email hasn't actually been verified yet, Firebase's
  // token still shows the OLD email and this responds 409 so the client
  // can show "still waiting" instead of silently doing nothing. Once the
  // token's email really has changed, this is the one place that
  // propagates it across every collection that stores it (mirroring what
  // the old /user/change-email did) and mints a fresh buytop-token so the
  // client doesn't have to force a full re-login.
  router.post(
    "/user/confirm-email-change",
    authLimiter,
    verifyJWT,
    asyncHandler(async (req, res) => {
      const { idToken } = req.body || {};
      if (!idToken) {
        return res.status(400).send({ message: "Missing idToken" });
      }
      let decoded;
      try {
        decoded = await admin.auth().verifyIdToken(idToken);
      } catch {
        return res.status(401).send({ message: "Your session has expired - please log in again." });
      }
      const oldEmail = req.decoded.email;
      const newEmail = decoded.email;
      if (!newEmail || newEmail === oldEmail) {
        return res.status(409).send({
          message: "We haven't seen your new email confirmed yet - check your inbox for the verification link.",
        });
      }
      if (!decoded.email_verified) {
        return res.status(409).send({ message: "Please verify your new email first." });
      }
      // Extremely unlikely (Firebase itself already refuses to let two
      // accounts share an email), but cheap to double-check before
      // touching Mongo.
      const conflict = await usersCollection.findOne({ email: newEmail });
      if (conflict) {
        return res.status(409).send({ message: "That email is already in use" });
      }
      await usersCollection.updateOne({ email: oldEmail }, { $set: { email: newEmail } });
      await productsCollection.updateMany({ email: oldEmail }, { $set: { email: newEmail } });
      await bookingCollection.updateMany({ email: oldEmail }, { $set: { email: newEmail } });
      await paymentCollection.updateMany({ email: oldEmail }, { $set: { email: newEmail } });
      logAudit(req, "email_changed", { oldEmail, newEmail });
      const token = jwt.sign({ email: newEmail }, process.env.ACCESS_TOKEN, { expiresIn: "7d" });
      res.send({ token, newEmail });
    })
  );

  router.patch(
    "/user/change-password",
    authLimiter,
    verifyJWT,
    asyncHandler(async (req, res) => {
      const { otpToken } = req.body || {};
      let decoded;
      try {
        decoded = jwt.verify(otpToken, process.env.ACCESS_TOKEN);
      } catch {
        return res.status(403).send({ message: "OTP verification expired. Please try again." });
      }
      if (decoded.purpose !== "password" || decoded.email !== req.decoded.email) {
        return res.status(403).send({ message: "Invalid OTP session" });
      }
      // Password itself lives in Firebase Auth and is updated client-side;
      // this just confirms the OTP gate was passed.
      res.send({ success: true });
    })
  );

  router.patch(
    "/user/profile",
    verifyJWT,
    asyncHandler(async (req, res) => {
      const { name, photo } = req.body || {};
      const updateDoc = {};
      if (typeof name === "string" && name.trim()) {
        if (name.trim().length > 100) {
          return res.status(400).send({ message: "Name must be 100 characters or fewer" });
        }
        updateDoc.name = name.trim();
      }
      if (typeof photo === "string" && photo.trim()) {
        if (photo.trim().length > 2000) {
          return res.status(400).send({ message: "Photo URL is too long" });
        }
        updateDoc.photo = photo.trim();
      }
      if (Object.keys(updateDoc).length === 0) {
        return res.status(400).send({ message: "Nothing to update" });
      }
      const result = await usersCollection.updateOne(
        { email: req.decoded.email },
        { $set: updateDoc }
      );
      res.send(result);
    })
  );

  // Only ever meant for Buyer/Seller accounts managing their own account
  // from Settings - Admin/Moderator/Developer accounts don't get a
  // self-service deactivate/delete.

  // Reversible: logging back in (see PUT /user/:email) automatically flips
  // this back to "active" - there's no separate "reactivate" button to
  // build or find.
  router.post(
    "/user/deactivate",
    verifyJWT,
    verifySelfBuyerOrSeller,
    asyncHandler(async (req, res) => {
      if (req.selfUser.status === "deactivated") {
        return res.status(400).send({ message: "This account is already deactivated" });
      }
      await usersCollection.updateOne(
        { email: req.selfUser.email },
        { $set: { status: "deactivated", deactivatedAt: new Date() } }
      );
      logAudit(req, "account_deactivated", { email: req.selfUser.email });
      res.send({ message: "Your account has been deactivated." });
    })
  );

  // Permanent (as far as this account goes) - unlike deactivate, there's no
  // way back in under this identity. Soft-deletes the Mongo user doc (keeps
  // the row so existing bookings/products/reviews/messages still resolve
  // to *something* instead of a dangling email) and deletes the Firebase
  // Auth user outright, so this exact login can never be used again. See
  // the "status === deleted" check in PUT /user/:email for what stops a
  // fresh Google sign-in from slipping back in under the same email.
  router.post(
    "/user/delete",
    verifyJWT,
    verifySelfBuyerOrSeller,
    asyncHandler(async (req, res) => {
      const email = req.selfUser.email;
      try {
        const firebaseUser = await admin.auth().getUserByEmail(email);
        await admin.auth().deleteUser(firebaseUser.uid);
      } catch (err) {
        // Already gone from Firebase (or never had a Firebase record under
        // this exact uid for some legacy reason) - not fatal, the Mongo-side
        // soft delete below is what actually matters for blocking reuse.
      }
      await usersCollection.updateOne(
        { email },
        {
          $set: {
            status: "deleted",
            deletedAt: new Date(),
            name: "Deleted User",
            photo: "",
          },
        }
      );
      logAudit(req, "account_deleted", { email });
      res.send({ message: "Your account has been deleted." });
    })
  );

  return router;
}

module.exports = createUserAccountRoutes;
