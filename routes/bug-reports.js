const express = require("express");

function createBugReportRoutes({
  mutationLimiter,
  verifyJWT,
  verifyStaffOrDeveloper,
  verifyAdmin,
  asyncHandler,
  bugReportsCollection,
  logAudit,
  ObjectId,
}) {
  const router = express.Router();

  router.post(
    "/bug-reports",
    mutationLimiter,
    verifyJWT,
    verifyStaffOrDeveloper,
    asyncHandler(async (req, res) => {
      const { title, description, severity, area, screenshotUrl, relatedId } = req.body || {};
      if (!title?.trim() || !description?.trim()) {
        return res.status(400).send({ message: "Title and description are required" });
      }
      const report = {
        title: title.trim(),
        description: description.trim(),
        severity: ["Low", "Medium", "High", "Critical"].includes(severity) ? severity : "Medium",
        area: area?.trim() || "",
        // Optional screenshot (uploaded client-side to imgbb, same as
        // product photos) and an optional product/order id the bug was
        // found on, so staff can jump straight to the exact demo item.
        screenshotUrl: typeof screenshotUrl === "string" ? screenshotUrl.trim() : "",
        relatedId: typeof relatedId === "string" && ObjectId.isValid(relatedId.trim()) ? relatedId.trim() : "",
        status: "Open",
        submittedBy: req.staffUser.email,
        submittedByRole: req.staffUser.role,
        createdAt: new Date(),
      };
      const result = await bugReportsCollection.insertOne(report);
      res.send({ ...report, _id: result.insertedId });
    })
  );

  router.get(
    "/bug-reports",
    verifyJWT,
    verifyStaffOrDeveloper,
    asyncHandler(async (req, res) => {
      // A Developer only sees their own submissions; Admin/Moderator (the
      // ones actually triaging and fixing bugs) see everything, optionally
      // narrowed by ?status= and/or ?severity= for the triage view.
      const query = req.staffUser.role === "Developer" ? { submittedBy: req.staffUser.email } : {};
      const { status, severity } = req.query || {};
      if (status && ["Open", "In Progress", "Resolved"].includes(status)) {
        query.status = status;
      }
      if (severity && ["Low", "Medium", "High", "Critical"].includes(severity)) {
        query.severity = severity;
      }
      const result = await bugReportsCollection.find(query).sort({ createdAt: -1 }).toArray();
      res.send(result);
    })
  );

  // Lightweight count for the sidebar badge - a Developer sees their own
  // open count, Admin/Moderator see the site-wide open count.
  router.get(
    "/bug-reports/open-count",
    verifyJWT,
    verifyStaffOrDeveloper,
    asyncHandler(async (req, res) => {
      const query = { status: "Open" };
      if (req.staffUser.role === "Developer") {
        query.submittedBy = req.staffUser.email;
      }
      const count = await bugReportsCollection.countDocuments(query);
      res.send({ count });
    })
  );

  router.patch(
    "/bug-reports/:id/status",
    verifyJWT,
    verifyAdmin,
    asyncHandler(async (req, res) => {
      const { status } = req.body || {};
      if (!["Open", "In Progress", "Resolved"].includes(status)) {
        return res.status(400).send({ message: "Invalid status" });
      }
      const result = await bugReportsCollection.updateOne(
        { _id: new ObjectId(req.params.id) },
        { $set: { status, resolvedAt: status === "Resolved" ? new Date() : null } }
      );
      if (result.matchedCount === 0) {
        return res.status(404).send({ message: "Bug report not found" });
      }
      logAudit(req, "bug_report_status_changed", { id: req.params.id, status });
      res.send(result);
    })
  );

  router.delete(
    "/bug-reports/:id",
    verifyJWT,
    verifyAdmin,
    asyncHandler(async (req, res) => {
      const result = await bugReportsCollection.deleteOne({ _id: new ObjectId(req.params.id) });
      if (result.deletedCount === 0) {
        return res.status(404).send({ message: "Bug report not found" });
      }
      res.send(result);
    })
  );

  return router;
}

module.exports = createBugReportRoutes;
