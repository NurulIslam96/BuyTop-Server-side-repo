const express = require("express");

// Same categorized-reason pattern as reporting a user (see
// routes/user-reports.js), applied to a product listing instead.
const PRODUCT_REPORT_REASONS = [
  "Prohibited or illegal item",
  "Counterfeit or fake product",
  "Misleading description or photos",
  "Suspected scam",
  "Spam or duplicate listing",
  "Inappropriate content",
  "Other",
];

function createBookingRoutes({
  mutationLimiter,
  verifyJWT,
  verifyBuyer,
  verifySeller,
  verifySelf,
  asyncHandler,
  productsCollection,
  bookingCollection,
  reportCollection,
  usersCollection,
  createNotification,
  statusMatch,
  CANONICAL_STATUS,
  round2,
  DEPOSIT_RATE,
  ObjectId,
  sendEmail,
  CLIENT_URL,
}) {
  const router = express.Router();

  router.post(
    "/mybooking",
    mutationLimiter,
    verifyJWT,
    verifyBuyer,
    asyncHandler(async (req, res) => {
      const { productId } = req.body;
      if (!productId || !ObjectId.isValid(productId)) {
        return res.status(400).send({ message: "Invalid product id" });
      }

      // Read-only check up front for a fast, friendly error message. This
      // is NOT what actually prevents two buyers racing onto the same
      // item - see the unique index on bookingCollection ({ productId },
      // partial on isActiveBooking: true) created in index.js, which is
      // what really enforces "at most one active booking per product".
      // The product's own status is deliberately left alone here
      // (still "Available"/"Advertised") - a buyer opening the booking
      // modal isn't a completed sale yet, and other buyers should still
      // be able to see and book the item if this buyer never actually
      // pays the deposit. It only flips to "Booked" once the deposit
      // clears (see /bkash/callback in routes/payments.js).
      const product = await productsCollection.findOne({
        _id: new ObjectId(productId),
        status: statusMatch("Available", "Advertised"),
      });
      if (!product) {
        return res.status(409).send({ message: "This item has already been booked" });
      }

      // A Developer test account ("Buyer test mode") may only book demo
      // inventory - never a real seller's real product.
      const isDeveloperBuyer = req.buyerUser.role === "Developer";
      if (isDeveloperBuyer && !product.isDemo) {
        return res.status(403).send({
          message: "Developer test accounts can only book demo products - add one from Seller test mode first.",
        });
      }

      // If the seller's account has since been banned, don't let a new
      // booking go through against a listing that's effectively frozen.
      // This is what actually makes banning a scam/fraud seller mean
      // something: without it, their existing live listings stayed fully
      // bookable the whole time they were banned.
      const seller = await usersCollection.findOne({ email: product.email });
      if (seller?.status === "banned") {
        return res.status(409).send({ message: "This listing is no longer available." });
      }

      // The client used to send along whatever status the product had
      // *before* this booking (e.g. "Available"), and that value then sat
      // in the booking record forever - MyOrders would show that stale
      // status instead of the real one. A booking record only ever gets
      // created for something that's just been booked.
      //
      // Bookings now require a 10% deposit before they're considered
      // secured. Status starts at "Awaiting Deposit" - the buyer can still
      // cancel freely from here since no money has changed hands yet. Once
      // the deposit clears (see /bkash/callback) it flips to "Booked", at
      // which point cancelling requires the seller's approval (see
      // /myorders/:id/cancel-request).
      // email/productName/etc below come straight from the booking form
      // and are only ever used for display (receipts, MyOrders) - except
      // email, which is also used later to authorize cancel/refund actions
      // (see /bookstatus/:id and /myorders/:id/cancel-request). That one
      // field can't be trusted from the client - a submitted form value
      // could be any string - so it's forced to the token's own email here
      // rather than spread in from req.body.
      // SECURITY: price must come from the product record above, never
      // from req.body. The client's booking form sends its own "price"
      // field, but that's just a *disabled* input pre-filled from the
      // product for display - disabled only stops the browser UI from
      // letting someone edit it, it does nothing to stop a direct API
      // call with a fabricated body. Trusting req.body.price here would
      // let any buyer book any item for whatever amount they choose,
      // since this value drives both the deposit and the final bKash
      // charge.
      const price = Number(product.resalePrice) || 0;
      const booking = {
        ...req.body,
        price,
        email: req.decoded.email,
        status: "Awaiting Deposit",
        depositAmount: round2(price * DEPOSIT_RATE),
        depositPaid: false,
        cancelRequest: { status: "None" },
        createdAt: new Date(),
        // Backs the partial unique index on bookingCollection (see
        // index.js) that enforces "at most one active booking per
        // product" - cleared the moment this booking is cancelled (see
        // both /cancel-requests/:id approval routes).
        isActiveBooking: true,
        // Demo if either side of the transaction is: a Developer test
        // buyer (guarded above to only ever book demo products anyway),
        // or a demo product being test-booked by its own Developer owner.
        isDemo: isDeveloperBuyer || product.isDemo === true,
      };

      let result;
      try {
        result = await bookingCollection.insertOne(booking);
      } catch (err) {
        // Duplicate key on the partial unique index above means someone
        // else's active booking on this product beat this request here.
        if (err?.code === 11000) {
          return res.status(409).send({ message: "This item has already been booked" });
        }
        throw err;
      }

      if (!booking.isDemo) {
        await createNotification({
          email: product.email,
          type: "booking",
          title: "Someone started booking your item",
          body: `${booking.userName || req.decoded.email} started booking "${product.productName}" - it's reserved once they pay the deposit.`,
          link: `/dashboard/my-orders`,
        });
        await sendEmail({
          to: product.email,
          subject: `New booking: ${product.productName}`,
          heading: "You've got a new booking",
          body: `${booking.userName || req.decoded.email} just booked "${product.productName}". It's reserved once they pay the deposit - you'll get another email when that happens.`,
          ctaText: "View order",
          ctaUrl: `${CLIENT_URL}/dashboard/orders`,
        });
      }
      res.send({ ...result, depositAmount: booking.depositAmount });
    })
  );

  router.patch(
    "/bookstatus/:id",
    verifyJWT,
    verifyBuyer,
    asyncHandler(async (req, res) => {
      // Cancelled bookings are now kept for reporting rather than deleted
      // (see /seller/cancel-requests/:id), so a product can have more than
      // one booking doc over its lifetime. Excluding Cancelled and taking
      // the most recent one makes sure this always resolves to the current
      // live booking, not a stale cancelled record from an earlier buyer.
      const booking = await bookingCollection.findOne(
        { productId: req.params.id, status: { $ne: "Cancelled" } },
        { sort: { _id: -1 } }
      );
      if (!booking || booking.email !== req.decoded.email) {
        return res.status(403).send({ message: "forbidden access" });
      }
      // The product only ever becomes "Booked" once its deposit has
      // actually cleared (see /bkash/callback) - this legacy fallback
      // used to flip it to Booked unconditionally, which is exactly the
      // "booked before payment" bug this route now has to avoid too.
      if (!booking.depositPaid) {
        return res.status(400).send({ message: "The deposit for this booking hasn't been paid yet." });
      }
      const result = await productsCollection.updateOne(
        { _id: new ObjectId(req.params.id), status: statusMatch("Available", "Advertised", "Booked") },
        { $set: { status: CANONICAL_STATUS.BOOKED } }
      );
      res.send(result);
    })
  );

  router.put(
    "/reported/:id",
    verifyJWT,
    asyncHandler(async (req, res) => {
      // Only ever write the specific fields this feature needs, as the
      // right type - previously `{ $set: req.body }` wrote whatever keys
      // and values a caller sent, letting anyone overwrite arbitrary
      // fields on any product's report record (e.g. a fabricated
      // "resolved"/"status" field an admin view might trust).
      const productName = typeof req.body?.productName === "string" ? req.body.productName : "";
      const resalePrice = Number(req.body?.resalePrice) || 0;
      const productPhoto = typeof req.body?.productPhoto === "string" ? req.body.productPhoto : "";
      const userEmail = typeof req.body?.userEmail === "string" ? req.body.userEmail : "";
      const reason = PRODUCT_REPORT_REASONS.includes(req.body?.reason) ? req.body.reason : "Other";
      const details =
        typeof req.body?.details === "string" ? req.body.details.trim().slice(0, 1000) : "";
      if (reason === "Other" && !details) {
        return res.status(400).send({ message: "Please describe the reason for reporting" });
      }
      const filter = { productId: req.params.id };
      const options = { upsert: true };
      const updatedDoc = {
        $set: {
          productId: req.params.id,
          productName,
          resalePrice,
          productPhoto,
          userEmail,
          reason,
          details: reason === "Other" ? details : "",
          reportedBy: req.decoded.email,
          reportedAt: new Date(),
        },
      };
      const result = await reportCollection.updateOne(filter, updatedDoc, options);
      res.send(result);
    })
  );

  router.get(
    "/myorders/:email",
    verifyJWT,
    verifyBuyer,
    asyncHandler(async (req, res) => {
      // Same class of bug as /myproducts/:email in routes/products.js -
      // verifyBuyer checks the caller's role, not which account the :email
      // param names. Ignoring the param and always querying by the
      // token's own email means a buyer can only ever see their own orders.
      const result = await bookingCollection.find({ email: req.decoded.email }).toArray();
      res.send(result);
    })
  );

  router.patch(
    "/myorders/:id",
    verifyJWT,
    verifyBuyer,
    asyncHandler(async (req, res) => {
      const booking = await bookingCollection.findOne(
        { productId: req.params.id, status: { $ne: "Cancelled" } },
        { sort: { _id: -1 } }
      );
      if (!booking || booking.email !== req.decoded.email) {
        return res.status(403).send({ message: "forbidden access" });
      }
      // Once a deposit (or full payment) has actually cleared, the buyer
      // can no longer cancel unilaterally - the seller has to sign off.
      // See POST /myorders/:id/cancel-request for that path.
      if (booking.depositPaid || booking.status === "Paid") {
        return res.status(400).send({
          message:
            "A payment is already on file for this order. Please request a cancellation instead so the seller can approve it.",
        });
      }
      await bookingCollection.deleteOne({ productId: req.params.id });
      const result = await productsCollection.updateOne(
        { _id: new ObjectId(req.params.id) },
        { $set: { status: CANONICAL_STATUS.AVAILABLE } }
      );
      res.send(result);
    })
  );

  // Buyer requests to cancel an order that already has money on it
  // (deposit or full payment). This does NOT cancel anything by itself -
  // it just flags the booking for the seller to approve or reject.
  router.post(
    "/myorders/:id/cancel-request",
    verifyJWT,
    verifyBuyer,
    asyncHandler(async (req, res) => {
      const booking = await bookingCollection.findOne(
        { productId: req.params.id, status: { $ne: "Cancelled" } },
        { sort: { _id: -1 } }
      );
      if (!booking || booking.email !== req.decoded.email) {
        return res.status(403).send({ message: "forbidden access" });
      }
      if (!booking.depositPaid && booking.status !== "Paid") {
        return res.status(400).send({
          message: "Nothing has been paid on this order yet - use Cancel Order instead.",
        });
      }
      if (booking.cancelRequest?.status === "Pending") {
        return res.status(400).send({ message: "A cancellation request is already pending." });
      }
      const reason = typeof req.body?.reason === "string" ? req.body.reason.slice(0, 500) : "";
      await bookingCollection.updateOne(
        { _id: booking._id },
        {
          $set: {
            cancelRequest: {
              status: "Pending",
              reason,
              requestedAt: new Date(),
            },
          },
        }
      );
      res.send({ message: "Cancellation request sent to the seller." });
    })
  );

  // Seller: list pending cancellation requests for their own products.
  router.get(
    "/seller/cancel-requests/:email",
    verifyJWT,
    verifySeller,
    asyncHandler(async (req, res) => {
      const products = await productsCollection
        .find({ email: req.decoded.email })
        .project({ _id: 1 })
        .toArray();
      const productIds = products.map((p) => String(p._id));
      const result = await bookingCollection
        .find({ productId: { $in: productIds }, "cancelRequest.status": "Pending" })
        .sort({ "cancelRequest.requestedAt": -1 })
        .toArray();
      res.send(result);
    })
  );

  // Seller: approve or reject a pending cancellation request.
  router.patch(
    "/seller/cancel-requests/:id",
    verifyJWT,
    verifySeller,
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
      // Confirm the product actually belongs to this seller.
      const product = await productsCollection.findOne({
        _id: new ObjectId(booking.productId),
        email: req.decoded.email,
      });
      if (!product) {
        return res.status(403).send({ message: "forbidden access" });
      }

      if (decision === "Approved") {
        // Deposits (and, for orders that were already fully paid, the full
        // payment too) are non-refundable once a cancellation is approved -
        // there's no refund call anywhere in this codebase, so that money
        // was always being kept; the only thing that changed is that the
        // booking used to be deleted outright, which threw away any record
        // of *why* that revenue stuck around. Cancelled bookings are now
        // kept (status: "Cancelled", with the status they held right
        // before cancellation preserved as preCancelStatus) so
        // cancellation-rate and retained-revenue reporting has something
        // to read. The product still goes back on the market immediately
        // either way.
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
        await productsCollection.updateOne(
          { _id: new ObjectId(booking.productId) },
          { $set: { status: CANONICAL_STATUS.AVAILABLE } }
        );
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
      res.send({ message: "Cancellation request rejected." });
    })
  );

  // Delivery is arranged manually between buyer and seller (using the
  // phone number/contact left on the order) - there's no courier
  // integration.
  //
  // Seller: every order on their own products (not just pending
  // cancellations like /seller/cancel-requests above) - this is what the
  // Orders page reads.
  router.get(
    "/seller/orders/:email",
    verifyJWT,
    verifySelf,
    verifySeller,
    asyncHandler(async (req, res) => {
      const products = await productsCollection
        .find({ email: req.decoded.email })
        .project({ _id: 1 })
        .toArray();
      const productIds = products.map((p) => String(p._id));
      const result = await bookingCollection
        .find({ productId: { $in: productIds } })
        .sort({ _id: -1 })
        .toArray();
      res.send(result);
    })
  );

  return router;
}

module.exports = createBookingRoutes;
