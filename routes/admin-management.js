const express = require("express");
const { SENSITIVE_USER_FIELDS } = require("../validation");

function createAdminManagementRoutes({
  verifyJWT,
  verifyAdmin,
  verifyMainAdmin,
  asyncHandler,
  productsCollection,
  bookingCollection,
  paymentCollection,
  reportCollection,
  usersCollection,
  STAFF_ROLES,
  escapeRegex,
  round2,
  CANONICAL_STATUS,
  logAudit,
  client,
  ObjectId,
}) {
  const router = express.Router();

  // ---- Admin content views -----------------------------------------------

  // Admin & Moderator: view every product regardless of status, so they
  // can manage (add/remove) advertisements on any seller's listing.
  router.get(
    "/admin/allproducts",
    verifyJWT,
    verifyAdmin,
    asyncHandler(async (req, res) => {
      const result = await productsCollection.find({}).sort({ _id: -1 }).toArray();
      res.send(result);
    })
  );

  // Admin & Moderator: add/remove an advertisement on any product, no
  // ownership (email) check and no payment required.
  router.patch(
    "/admin/addAdv/:id",
    verifyJWT,
    verifyAdmin,
    asyncHandler(async (req, res) => {
      const result = await productsCollection.updateOne(
        { _id: new ObjectId(req.params.id) },
        { $set: { status: CANONICAL_STATUS.ADVERTISED } }
      );
      if (result.matchedCount === 0) {
        return res.status(404).send({ message: "Product not found" });
      }
      res.send(result);
    })
  );

  router.patch(
    "/admin/rmvadvertise/:id",
    verifyJWT,
    verifyAdmin,
    asyncHandler(async (req, res) => {
      const result = await productsCollection.updateOne(
        { _id: new ObjectId(req.params.id) },
        { $set: { status: CANONICAL_STATUS.AVAILABLE } }
      );
      if (result.matchedCount === 0) {
        return res.status(404).send({ message: "Product not found" });
      }
      res.send(result);
    })
  );

  // Admin & Moderator: every order (booking) in the system, newest first,
  // so the dashboard can list/filter Paid vs Unpaid orders. "Paid" here
  // means the booking's remaining balance has fully cleared
  // (booking.status === "Paid"); everything else ("Awaiting Deposit" or
  // "Booked") is unpaid/partially paid and still has money outstanding.
  router.get(
    "/admin/orders",
    verifyJWT,
    verifyAdmin,
    asyncHandler(async (req, res) => {
      const result = await bookingCollection.find({}).sort({ _id: -1 }).toArray();
      const withRemaining = result.map((booking) => {
        const price = Number(booking.price) || 0;
        const depositAmount = booking.depositPaid ? Number(booking.depositAmount || 0) : 0;
        const isClosed = booking.status === "Paid" || booking.status === "Cancelled";
        const amountPaid = booking.status === "Paid" ? price : depositAmount;
        const amountRemaining = isClosed ? 0 : round2(Math.max(price - depositAmount, 0));
        return { ...booking, amountPaid: round2(amountPaid), amountRemaining };
      });
      res.send(withRemaining);
    })
  );

  // Admin & Moderator: permanently remove an order record (housekeeping /
  // spam / test-data cleanup). This does not touch the related product's
  // status - use Manage Advertisements or the product list to change that
  // separately if the listing itself also needs to go back to Available.
  router.delete(
    "/admin/orders/:id",
    verifyJWT,
    verifyAdmin,
    asyncHandler(async (req, res) => {
      if (!ObjectId.isValid(req.params.id)) {
        return res.status(400).send({ message: "Invalid order id" });
      }
      const result = await bookingCollection.deleteOne({ _id: new ObjectId(req.params.id) });
      if (result.deletedCount === 0) {
        return res.status(404).send({ message: "Order not found" });
      }
      res.send(result);
    })
  );

  // Admin: list every pending cancellation request platform-wide (the
  // seller-facing GET /seller/cancel-requests/:email in routes/bookings.js
  // only ever sees requests for that one seller's own products).
  router.get(
    "/admin/cancel-requests",
    verifyJWT,
    verifyAdmin,
    asyncHandler(async (req, res) => {
      const result = await bookingCollection
        .find({ "cancelRequest.status": "Pending" })
        .sort({ "cancelRequest.requestedAt": -1 })
        .toArray();
      res.send(result);
    })
  );

  // Admin override for a pending cancellation request. Normally only the
  // seller who owns the product can approve/reject (see
  // /seller/cancel-requests/:id in routes/bookings.js) - this exists for
  // cases where the seller account can no longer act (dead/unreachable
  // email, banned, etc.) and the request would otherwise sit stuck as
  // "Pending" forever. Same effect as the seller-side route, just without
  // the ownership check, and audit-logged since it's bypassing the
  // seller's own sign-off.
  router.patch(
    "/admin/cancel-requests/:id",
    verifyJWT,
    verifyAdmin,
    asyncHandler(async (req, res) => {
      const decision = req.body?.decision;
      if (!["Approved", "Rejected"].includes(decision)) {
        return res.status(400).send({ message: "decision must be Approved or Rejected" });
      }
      if (!ObjectId.isValid(req.params.id)) {
        return res.status(400).send({ message: "Invalid booking id" });
      }
      const booking = await bookingCollection.findOne({ _id: new ObjectId(req.params.id) });
      if (!booking || booking.cancelRequest?.status !== "Pending") {
        return res.status(404).send({ message: "No pending cancellation request found" });
      }

      if (decision === "Approved") {
        // Same non-refundable-deposit behavior as the seller-approval
        // path: preserve the pre-cancellation status, mark Cancelled, and
        // free up the product listing again.
        await bookingCollection.updateOne(
          { _id: booking._id },
          {
            $set: {
              preCancelStatus: booking.status,
              status: "Cancelled",
              cancelledAt: new Date(),
              "cancelRequest.status": "Approved",
              "cancelRequest.resolvedAt": new Date(),
            },
            $unset: { isActiveBooking: "" },
          }
        );
        if (ObjectId.isValid(booking.productId)) {
          await productsCollection.updateOne(
            { _id: new ObjectId(booking.productId) },
            { $set: { status: CANONICAL_STATUS.AVAILABLE } }
          );
        }
        logAudit(req, "admin_cancel_request_approved", {
          bookingId: String(booking._id),
          productId: booking.productId,
        });
        return res.send({ message: "Cancellation approved. The listing is available again." });
      }

      await bookingCollection.updateOne(
        { _id: booking._id },
        {
          $set: {
            "cancelRequest.status": "Rejected",
            "cancelRequest.resolvedAt": new Date(),
          },
        }
      );
      logAudit(req, "admin_cancel_request_rejected", {
        bookingId: String(booking._id),
        productId: booking.productId,
      });
      res.send({ message: "Cancellation request rejected." });
    })
  );

  // Admin & Moderator: every payment transaction on file (deposits and
  // full/remaining-balance payments alike), newest first, enriched with
  // the product's name/photo so the ledger is readable without a second
  // lookup.
  router.get(
    "/admin/payments",
    verifyJWT,
    verifyAdmin,
    asyncHandler(async (req, res) => {
      const payments = await paymentCollection.find({}).sort({ createdAt: -1 }).toArray();
      const productIds = [
        ...new Set(payments.map((p) => p.productId).filter((id) => id && ObjectId.isValid(id))),
      ];
      const products = productIds.length
        ? await productsCollection
            .find({ _id: { $in: productIds.map((id) => new ObjectId(id)) } })
            .toArray()
        : [];
      const productById = {};
      products.forEach((p) => {
        productById[p._id.toString()] = p;
      });
      const enriched = payments.map((payment) => {
        const product = productById[payment.productId];
        return {
          ...payment,
          productName: product?.productName || "Deleted product",
          productPhoto: product?.productPhoto || null,
        };
      });
      res.send(enriched);
    })
  );

  router.get(
    "/reporteditems",
    verifyJWT,
    verifyAdmin,
    asyncHandler(async (req, res) => {
      const result = await reportCollection.find({}).toArray();
      res.send(result);
    })
  );

  // ---- User & staff management --------------------------------------------

  router.get(
    "/allsellers",
    verifyJWT,
    verifyAdmin,
    asyncHandler(async (req, res) => {
      const result = await usersCollection
        .find({ role: "Seller" })
        .project(SENSITIVE_USER_FIELDS)
        .sort({ _id: -1 })
        .toArray();
      res.send(result);
    })
  );

  router.get(
    "/allbuyers",
    verifyJWT,
    verifyAdmin,
    asyncHandler(async (req, res) => {
      const result = await usersCollection
        .find({ role: "Buyer" })
        .project(SENSITIVE_USER_FIELDS)
        .sort({ _id: -1 })
        .toArray();
      res.send(result);
    })
  );

  // Admin: merged listing of both Sellers and Buyers, used by the "All
  // Users" dashboard page so the admin can filter role (Seller/Buyer/All)
  // and verification status from a single table.
  router.get(
    "/allusers",
    verifyJWT,
    verifyAdmin,
    asyncHandler(async (req, res) => {
      const result = await usersCollection
        .find({ role: { $in: ["Seller", "Buyer"] } })
        .project(SENSITIVE_USER_FIELDS)
        .sort({ _id: -1 })
        .toArray();
      res.send(result);
    })
  );

  router.patch(
    "/verifyuser/:email",
    verifyJWT,
    verifyAdmin,
    asyncHandler(async (req, res) => {
      const verified = req.body.verified === true;
      const updateVerify = await productsCollection.updateMany(
        { email: req.params.email },
        { $set: { isVerified: verified } }
      );
      const result = await usersCollection.updateOne(
        { email: req.params.email },
        { $set: { verified } }
      );
      res.send({ result, updateVerify });
    })
  );

  router.delete(
    "/allusers/:id",
    verifyJWT,
    verifyAdmin,
    asyncHandler(async (req, res) => {
      const result = await usersCollection.deleteOne({ _id: new ObjectId(req.params.id) });
      res.send(result);
    })
  );

  router.delete(
    "/itemdelete/:id",
    verifyJWT,
    verifyAdmin,
    asyncHandler(async (req, res) => {
      const result = await productsCollection.deleteOne({ _id: new ObjectId(req.params.id) });
      res.send(result);
    })
  );

  router.delete(
    "/reportdelete/:id",
    verifyJWT,
    verifyAdmin,
    asyncHandler(async (req, res) => {
      const result = await reportCollection.deleteOne({ _id: new ObjectId(req.params.id) });
      res.send(result);
    })
  );

  // ---- Staff management: Admin can promote/demote Admins & Moderators. ---
  // Only a main Admin (never a Moderator) can call these.

  router.get(
    "/allstaff",
    verifyJWT,
    verifyAdmin,
    asyncHandler(async (req, res) => {
      const result = await usersCollection
        .find({ role: { $in: STAFF_ROLES } })
        .sort({ _id: -1 })
        .toArray();
      res.send(result);
    })
  );

  router.get(
    "/users/search",
    verifyJWT,
    verifyAdmin,
    asyncHandler(async (req, res) => {
      const q = (req.query.q || "").trim();
      if (!q) return res.send([]);
      const safeQ = escapeRegex(q);
      const result = await usersCollection
        .find({
          $or: [
            { email: { $regex: safeQ, $options: "i" } },
            { name: { $regex: safeQ, $options: "i" } },
          ],
        })
        .limit(10)
        .toArray();
      res.send(result);
    })
  );

  router.patch(
    "/users/role",
    verifyJWT,
    verifyMainAdmin,
    asyncHandler(async (req, res) => {
      const { email, role } = req.body || {};
      // "Admin" (root) is intentionally left out here. There is exactly
      // one root Admin at a time, and the only way to hand that role to
      // someone else is the atomic /users/transfer-admin endpoint below -
      // it demotes the current Admin in the same operation, so we never
      // end up with two.
      const VALID_ROLES = ["Buyer", "Seller", "Moderator"];
      if (!email || !VALID_ROLES.includes(role)) {
        return res.status(400).send({
          message:
            role === "Admin"
              ? "Use Transfer Admin to hand off the root Admin role."
              : "A valid email and role are required",
        });
      }
      if (email === req.decoded.email) {
        return res.status(400).send({ message: "You can't change your own role" });
      }
      const updateDoc = { $set: { role } };
      if (STAFF_ROLES.includes(role)) {
        updateDoc.$set.promotedBy = req.decoded.email;
        updateDoc.$set.promotedAt = new Date();
      } else {
        updateDoc.$unset = { promotedBy: "", promotedAt: "" };
      }
      const result = await usersCollection.updateOne({ email }, updateDoc);
      logAudit(req, "role_change", { targetEmail: email, newRole: role });
      res.send(result);
    })
  );

  // Hand off the root Admin role to an existing Sub Admin. This is the
  // ONLY way a new Admin gets created - it demotes the current Admin to
  // Moderator in the same operation, so the "exactly one root Admin"
  // invariant always holds. Requires a session/transaction so we never
  // end up with 0 or 2 Admins if one of the two writes fails partway
  // through.
  router.post(
    "/users/transfer-admin",
    verifyJWT,
    verifyMainAdmin,
    asyncHandler(async (req, res) => {
      const { newAdminEmail } = req.body || {};
      if (!newAdminEmail) {
        return res.status(400).send({ message: "newAdminEmail is required" });
      }
      if (newAdminEmail === req.decoded.email) {
        return res.status(400).send({ message: "You're already the Admin" });
      }
      const target = await usersCollection.findOne({ email: newAdminEmail });
      if (!target || target.role !== "Moderator") {
        return res.status(400).send({
          message: "Only an existing Sub Admin can be handed the root Admin role.",
        });
      }

      const now = new Date();
      const session = client.startSession();
      try {
        await session.withTransaction(async () => {
          await usersCollection.updateOne(
            { email: newAdminEmail },
            { $set: { role: "Admin", promotedBy: req.decoded.email, promotedAt: now } },
            { session }
          );
          await usersCollection.updateOne(
            { email: req.decoded.email },
            { $set: { role: "Moderator", promotedBy: newAdminEmail, promotedAt: now } },
            { session }
          );
        });
      } catch (err) {
        // Standalone (non-replica-set) MongoDB doesn't support
        // transactions. Fall back to sequential writes with a
        // best-effort rollback so we still avoid ending up with two
        // Admins.
        const targetUpdate = await usersCollection.updateOne(
          { email: newAdminEmail },
          { $set: { role: "Admin", promotedBy: req.decoded.email, promotedAt: now } }
        );
        try {
          await usersCollection.updateOne(
            { email: req.decoded.email },
            { $set: { role: "Moderator", promotedBy: newAdminEmail, promotedAt: now } }
          );
        } catch (innerErr) {
          if (targetUpdate.modifiedCount) {
            await usersCollection.updateOne(
              { email: newAdminEmail },
              { $set: { role: "Moderator", promotedBy: req.decoded.email, promotedAt: now } }
            );
          }
          throw innerErr;
        }
      } finally {
        await session.endSession();
      }

      logAudit(req, "admin_transfer", { newAdminEmail, previousAdminEmail: req.decoded.email });
      res.send({ message: `Admin role transferred to ${newAdminEmail}` });
    })
  );

  return router;
}

module.exports = createAdminManagementRoutes;
