const express = require("express");

// Same idea as Facebook/YouTube's report flow: a fixed set of reasons,
// plus "Other" which requires the reporter to type their own explanation.
const REPORT_REASONS = [
  "Spam",
  "Harassment or bullying",
  "Hate speech",
  "Impersonation or fake profile",
  "Scam or fraud",
  "Inappropriate or explicit content",
  "Violence or dangerous behavior",
  "Other",
];

// Once a user has this many reports open against them at the same time,
// the moderation queue flags them as high priority - same pattern most
// platforms use to surface a likely-bad-actor account instead of making
// staff spot it by eye.
const HIGH_PRIORITY_THRESHOLD = 3;

function createUserReportRoutes({
  verifyJWT,
  verifyAdmin,
  mutationLimiter,
  asyncHandler,
  userReportsCollection,
  usersCollection,
  createNotification,
  STAFF_ROLES,
  logAudit,
  ObjectId,
}) {
  const router = express.Router();

  // Any signed-in user can report another user's profile. This never
  // touches the reported account by itself - it only ever lands in the
  // Admin/Moderator queue below for a human to actually review.
  router.post(
    "/user-reports",
    mutationLimiter,
    verifyJWT,
    asyncHandler(async (req, res) => {
      const { reportedEmail, reason, details } = req.body || {};
      if (!reportedEmail || !REPORT_REASONS.includes(reason)) {
        return res.status(400).send({ message: "A valid reportedEmail and reason are required" });
      }
      if (reportedEmail === req.decoded.email) {
        return res.status(400).send({ message: "You can't report your own account" });
      }
      if (reason === "Other" && !String(details || "").trim()) {
        return res.status(400).send({ message: "Please describe the reason for reporting" });
      }
      const reportedUser = await usersCollection.findOne({ email: reportedEmail });
      if (!reportedUser) {
        return res.status(404).send({ message: "That user could not be found" });
      }

      // Same UX every major platform uses: you can't spam-report the same
      // account over and over - one open report per reporter at a time.
      // Once staff resolve or dismiss it, they're free to report again if
      // something new comes up.
      const existing = await userReportsCollection.findOne({
        reportedEmail,
        reporterEmail: req.decoded.email,
        status: "pending",
      });
      if (existing) {
        return res.status(409).send({
          message: "You've already reported this account - our team is reviewing it.",
        });
      }

      const doc = {
        reportedEmail,
        reporterEmail: req.decoded.email,
        reason,
        details: reason === "Other" ? String(details).trim().slice(0, 1000) : "",
        status: "pending",
        createdAt: new Date(),
      };
      const result = await userReportsCollection.insertOne(doc);

      // Let Admins/Moderators know a new report is waiting, same as any
      // other item in their queue - they don't have to keep the page open
      // and refresh to notice one came in.
      const staff = await usersCollection
        .find({ role: { $in: STAFF_ROLES } })
        .project({ email: 1 })
        .toArray();
      await Promise.all(
        staff.map((s) =>
          createNotification({
            email: s.email,
            type: "report",
            title: "New user report",
            body: `${reportedEmail} was reported for ${reason.toLowerCase()}`,
            link: "/dashboard/reportedusers",
          })
        )
      );

      res.status(201).send({ ...doc, _id: result.insertedId });
    })
  );

  // A reporter checking on what happened to reports they personally filed.
  // Confidential in the other direction too - this never shows who else
  // reported the same account, only the requester's own submissions.
  router.get(
    "/user-reports/mine",
    verifyJWT,
    asyncHandler(async (req, res) => {
      const reports = await userReportsCollection
        .find({ reporterEmail: req.decoded.email })
        .sort({ createdAt: -1 })
        .toArray();
      const emails = [...new Set(reports.map((r) => r.reportedEmail))];
      const users = emails.length
        ? await usersCollection.find({ email: { $in: emails } }).toArray()
        : [];
      const byEmail = {};
      users.forEach((u) => {
        byEmail[u.email] = u;
      });
      res.send(
        reports.map((r) => ({
          ...r,
          reportedName: byEmail[r.reportedEmail]?.name || "Deleted user",
        }))
      );
    })
  );

  // Admin & Moderator moderation queue. Enriched with each reported
  // user's current name/photo/role/status, plus how many total reports
  // that account has ever had filed against it - used to flag repeat
  // offenders as high priority.
  router.get(
    "/user-reports",
    verifyJWT,
    verifyAdmin,
    asyncHandler(async (req, res) => {
      const reports = await userReportsCollection.find({}).sort({ createdAt: -1 }).toArray();
      const emails = [...new Set(reports.map((r) => r.reportedEmail))];
      const users = emails.length
        ? await usersCollection.find({ email: { $in: emails } }).toArray()
        : [];
      const byEmail = {};
      users.forEach((u) => {
        byEmail[u.email] = u;
      });
      const countsByEmail = {};
      reports.forEach((r) => {
        countsByEmail[r.reportedEmail] = (countsByEmail[r.reportedEmail] || 0) + 1;
      });
      const enriched = reports.map((r) => {
        const u = byEmail[r.reportedEmail];
        const reportCount = countsByEmail[r.reportedEmail] || 1;
        return {
          ...r,
          reportedName: u?.name || "Deleted user",
          reportedPhoto: u?.photo || "",
          reportedRole: u?.role || "",
          reportedStatus: u?.status || "active",
          reportedBannedUntil: u?.bannedUntil || null,
          reportCount,
          highPriority: reportCount >= HIGH_PRIORITY_THRESHOLD,
        };
      });
      // Surface the accounts with the most reports against them first, so
      // staff triage likely repeat offenders before one-off complaints.
      enriched.sort((a, b) => {
        if (a.highPriority !== b.highPriority) return a.highPriority ? -1 : 1;
        return new Date(b.createdAt) - new Date(a.createdAt);
      });
      res.send(enriched);
    })
  );

  // Admin & Moderator: dismiss a report with no action against the
  // account (turned out unfounded). Kept (not deleted) so the reporter
  // can see the outcome via /user-reports/mine.
  router.patch(
    "/user-reports/:id/dismiss",
    verifyJWT,
    verifyAdmin,
    asyncHandler(async (req, res) => {
      const result = await userReportsCollection.updateOne(
        { _id: new ObjectId(req.params.id), status: "pending" },
        { $set: { status: "dismissed", reviewedBy: req.decoded.email, reviewedAt: new Date() } }
      );
      if (result.matchedCount === 0) {
        return res.status(404).send({ message: "Report not found or already resolved" });
      }
      res.send(result);
    })
  );

  // Ban a user for a fixed number of days/months/years, or permanently
  // (durationUnit: "permanent"). Admin & Moderator both allowed. Can be
  // called straight from a report (reportId resolves it, and every other
  // pending report against the same account too) or directly from All
  // Users with no report attached.
  router.post(
    "/users/:email/ban",
    verifyJWT,
    verifyAdmin,
    asyncHandler(async (req, res) => {
      const { email } = req.params;
      const { durationValue, durationUnit, reason, reportId } = req.body || {};

      const target = await usersCollection.findOne({ email });
      if (!target) {
        return res.status(404).send({ message: "User not found" });
      }
      if (["Admin", "Moderator"].includes(target.role)) {
        return res.status(400).send({
          message: "Staff accounts can't be banned from here - change their role first.",
        });
      }

      let bannedUntil = null;
      if (durationUnit !== "permanent") {
        const amount = Number(durationValue);
        if (!amount || amount <= 0) {
          return res.status(400).send({ message: "Enter a valid ban duration" });
        }
        const until = new Date();
        if (durationUnit === "days") until.setDate(until.getDate() + amount);
        else if (durationUnit === "months") until.setMonth(until.getMonth() + amount);
        else if (durationUnit === "years") until.setFullYear(until.getFullYear() + amount);
        else return res.status(400).send({ message: "Invalid duration unit" });
        bannedUntil = until;
      }

      const banReason = (reason || "Violation of community guidelines").slice(0, 500);

      await usersCollection.updateOne(
        { email },
        {
          $set: {
            status: "banned",
            bannedUntil,
            banReason,
            bannedBy: req.decoded.email,
            bannedAt: new Date(),
          },
        }
      );

      // Resolve every pending report against this account, not just the
      // one that happened to trigger the ban - a single action addresses
      // all outstanding complaints about the same person.
      await userReportsCollection.updateMany(
        { reportedEmail: email, status: "pending" },
        { $set: { status: "resolved", reviewedBy: req.decoded.email, reviewedAt: new Date() } }
      );
      void reportId; // kept in the request shape for the client; resolution above already covers it

      await createNotification({
        email,
        type: "ban",
        title: bannedUntil ? "Your account has been temporarily banned" : "Your account has been banned",
        body: banReason,
        link: "/settings",
      });

      logAudit(req, "user_banned", { targetEmail: email, bannedUntil, reason: banReason });
      res.send({
        message: bannedUntil
          ? `${email} banned until ${bannedUntil.toLocaleDateString()}`
          : `${email} permanently banned`,
        bannedUntil,
      });
    })
  );

  // Lift a ban early.
  router.post(
    "/users/:email/unban",
    verifyJWT,
    verifyAdmin,
    asyncHandler(async (req, res) => {
      const result = await usersCollection.updateOne(
        { email: req.params.email },
        {
          $set: { status: "active" },
          $unset: { bannedUntil: "", banReason: "", bannedBy: "", bannedAt: "" },
        }
      );
      if (result.matchedCount === 0) {
        return res.status(404).send({ message: "User not found" });
      }
      await createNotification({
        email: req.params.email,
        type: "ban",
        title: "Your ban has been lifted",
        body: "You can sign back in now.",
        link: "/login",
      });
      logAudit(req, "user_unbanned", { targetEmail: req.params.email });
      res.send(result);
    })
  );

  return router;
}

module.exports = createUserReportRoutes;
