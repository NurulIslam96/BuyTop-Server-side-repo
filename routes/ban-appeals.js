const express = require("express");

// A banned account has no working JWT to prove who's asking (that's the
// whole point of the ban), so appeal submission instead verifies the
// person's identity straight from the Firebase ID token captured client-
// side at the moment their sign-in was blocked (see Login.js) - a one-shot
// identity check, not a session. Everything else here is Admin/Moderator-only.
function createBanAppealRoutes({
  admin,
  authLimiter,
  verifyJWT,
  verifyAdmin,
  asyncHandler,
  usersCollection,
  banAppealsCollection,
  createNotification,
  logAudit,
  ObjectId,
}) {
  const router = express.Router();

  router.post(
    "/ban-appeals",
    authLimiter,
    asyncHandler(async (req, res) => {
      const { idToken, message } = req.body || {};
      if (!idToken || !String(message || "").trim()) {
        return res.status(400).send({ message: "An appeal message is required" });
      }
      let decoded;
      try {
        decoded = await admin.auth().verifyIdToken(idToken);
      } catch {
        return res.status(401).send({
          message: "Your session has expired - please try logging in again to appeal.",
        });
      }
      const email = decoded.email;
      const target = await usersCollection.findOne({ email });
      if (!target || target.status !== "banned") {
        return res.status(400).send({ message: "This account isn't currently banned." });
      }
      const existing = await banAppealsCollection.findOne({ email, status: "pending" });
      if (existing) {
        return res.status(409).send({
          message: "You already have a pending appeal - our team will get back to you.",
        });
      }
      const doc = {
        email,
        message: String(message).trim().slice(0, 1000),
        banReason: target.banReason || "",
        bannedUntil: target.bannedUntil || null,
        status: "pending",
        createdAt: new Date(),
      };
      await banAppealsCollection.insertOne(doc);

      const staff = await usersCollection
        .find({ role: { $in: ["Admin", "Moderator"] } })
        .project({ email: 1 })
        .toArray();
      await Promise.all(
        staff.map((s) =>
          createNotification({
            email: s.email,
            type: "ban-appeal",
            title: "New ban appeal",
            body: `${email} is appealing their ban`,
            link: "/dashboard/banappeals",
          })
        )
      );

      res.status(201).send({ message: "Appeal submitted" });
    })
  );

  // Admin & Moderator queue.
  router.get(
    "/ban-appeals",
    verifyJWT,
    verifyAdmin,
    asyncHandler(async (req, res) => {
      const appeals = await banAppealsCollection.find({}).sort({ createdAt: -1 }).toArray();
      res.send(appeals);
    })
  );

  router.post(
    "/ban-appeals/:id/approve",
    verifyJWT,
    verifyAdmin,
    asyncHandler(async (req, res) => {
      const appeal = await banAppealsCollection.findOne({ _id: new ObjectId(req.params.id) });
      if (!appeal) return res.status(404).send({ message: "Appeal not found" });
      await usersCollection.updateOne(
        { email: appeal.email },
        {
          $set: { status: "active" },
          $unset: { bannedUntil: "", banReason: "", bannedBy: "", bannedAt: "" },
        }
      );
      await banAppealsCollection.updateOne(
        { _id: appeal._id },
        { $set: { status: "approved", reviewedBy: req.decoded.email, reviewedAt: new Date() } }
      );
      await createNotification({
        email: appeal.email,
        type: "ban-appeal",
        title: "Your appeal was approved",
        body: "Your ban has been lifted - you can sign back in now.",
        link: "/login",
      });
      logAudit(req, "ban_appeal_approved", { targetEmail: appeal.email });
      res.send({ message: `${appeal.email} unbanned` });
    })
  );

  router.post(
    "/ban-appeals/:id/reject",
    verifyJWT,
    verifyAdmin,
    asyncHandler(async (req, res) => {
      const appeal = await banAppealsCollection.findOne({ _id: new ObjectId(req.params.id) });
      if (!appeal) return res.status(404).send({ message: "Appeal not found" });
      await banAppealsCollection.updateOne(
        { _id: appeal._id },
        { $set: { status: "rejected", reviewedBy: req.decoded.email, reviewedAt: new Date() } }
      );
      await createNotification({
        email: appeal.email,
        type: "ban-appeal",
        title: "Your appeal was reviewed",
        body: "Your ban stays in place. Contact support if you believe this is a mistake.",
        link: "/login",
      });
      logAudit(req, "ban_appeal_rejected", { targetEmail: appeal.email });
      res.send({ message: "Appeal rejected" });
    })
  );

  return router;
}

module.exports = createBanAppealRoutes;
