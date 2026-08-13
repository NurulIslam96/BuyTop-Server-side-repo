const express = require("express");

function createPaymentRoutes({
  verifyJWT,
  verifySeller,
  verifyBuyer,
  asyncHandler,
  bookingCollection,
  productsCollection,
  paymentCollection,
  platformFeeCollection,
  round2,
  PLATFORM_FEES,
  logAudit,
  bkash,
  SERVER_URL,
  CLIENT_URL,
  streamInvoicePDF,
  ObjectId,
  sendEmail,
  statusMatch,
}) {
  const router = express.Router();

  router.get(
    "/payment/:id",
    verifyJWT,
    asyncHandler(async (req, res) => {
      if (!ObjectId.isValid(req.params.id)) {
        return res.status(400).send({ message: "Invalid booking id" });
      }
      const result = await bookingCollection.findOne({ _id: new ObjectId(req.params.id) });
      if (!result) {
        return res.status(404).send({ message: "Booking not found" });
      }
      if (result.email !== req.decoded.email) {
        return res.status(403).send({ message: "forbidden access" });
      }
      // The checkout page should show what's actually owed right now, not
      // the original full price. Once the deposit is paid, that's the
      // remaining balance - the same figure /bkash/create and the
      // hand-cash flow already use for the real amount owed.
      const displayPrice = result.depositPaid
        ? round2(Number(result.price) - Number(result.depositAmount || 0))
        : Number(result.price);
      res.send({ ...result, price: displayPrice });
    })
  );

  router.post(
    "/bookings/:id/pay-cash",
    verifyJWT,
    asyncHandler(async (req, res) => {
      if (!ObjectId.isValid(req.params.id)) {
        return res.status(400).send({ message: "Invalid booking id" });
      }
      const booking = await bookingCollection.findOne({ _id: new ObjectId(req.params.id) });
      if (!booking || booking.email !== req.decoded.email) {
        return res.status(403).send({ message: "forbidden access" });
      }
      if (!booking.depositPaid) {
        return res.status(400).send({ message: "Please pay the 10% booking deposit first." });
      }
      if (booking.status === "Paid") {
        return res.status(400).send({ message: "This order is already marked as paid." });
      }
      // Just flags intent to pay hand-cash so the seller sees "Awaiting
      // cash payment" in Orders and knows to look out for it - the order
      // isn't marked Paid until the seller actually confirms they
      // received the cash (see /bookings/:id/confirm-cash-payment below).
      // This mirrors the cancel-request pattern (buyer proposes, seller
      // confirms) rather than trusting the buyer's word that money
      // changed hands.
      await bookingCollection.updateOne(
        { _id: booking._id },
        { $set: { "cashPayment.status": "pending_confirmation", "cashPayment.declaredAt": new Date() } }
      );
      if (ObjectId.isValid(booking.productId)) {
        const product = await productsCollection.findOne({ _id: new ObjectId(booking.productId) });
        if (product?.email) {
          await sendEmail({
            to: product.email,
            subject: `Cash payment pending: ${product.productName || "your listing"}`,
            heading: "A buyer says they've paid you in cash",
            body: `${booking.userName || booking.email} marked the remaining balance for "${product.productName || "this order"}" as paid by cash. Once you've actually received it, confirm the payment from your Orders page to close out the sale.`,
            ctaText: "Confirm payment",
            ctaUrl: `${CLIENT_URL}/dashboard/orders`,
          });
        }
      }
      res.send({ message: "Marked as pay-by-cash. The seller will confirm once they've received it in person." });
    })
  );

  router.post(
    "/bookings/:id/confirm-cash-payment",
    verifyJWT,
    verifySeller,
    asyncHandler(async (req, res) => {
      if (!ObjectId.isValid(req.params.id)) {
        return res.status(400).send({ message: "Invalid booking id" });
      }
      const booking = await bookingCollection.findOne({ _id: new ObjectId(req.params.id) });
      if (!booking) {
        return res.status(404).send({ message: "Booking not found" });
      }
      if (!ObjectId.isValid(booking.productId)) {
        return res.status(400).send({ message: "Invalid product on this booking" });
      }
      const product = await productsCollection.findOne({ _id: new ObjectId(booking.productId) });
      if (!product || product.email !== req.decoded.email) {
        return res.status(403).send({ message: "forbidden access" });
      }
      if (!booking.depositPaid) {
        return res.status(400).send({ message: "This booking's deposit hasn't been paid yet." });
      }
      if (booking.status === "Paid") {
        return res.status(400).send({ message: "This order is already marked as paid." });
      }
      const price = round2(Number(booking.price) - Number(booking.depositAmount || 0));
      await bookingCollection.updateOne(
        { _id: booking._id },
        { $set: { status: "Paid", "cashPayment.status": "confirmed", "cashPayment.confirmedAt": new Date() } }
      );
      await productsCollection.updateOne(
        { _id: new ObjectId(booking.productId) },
        { $set: { status: "Paid" } }
      );
      const result = await paymentCollection.insertOne({
        productId: booking.productId,
        bookingId: String(booking._id),
        price,
        type: "Full",
        status: "Paid",
        method: "Cash",
        transactionId: "",
        buyerEmail: booking.email,
        createdAt: new Date(),
      });
      await sendEmail({
        to: booking.email,
        subject: `Payment confirmed: ${product.productName || "your order"}`,
        heading: "Your order is complete",
        body: `The seller confirmed they received your cash payment for "${product.productName || "this order"}". The sale is now complete - thanks for using BuyTop!`,
        ctaText: "View order",
        ctaUrl: `${CLIENT_URL}/dashboard/myorders`,
      });
      // The product just sold - charge the seller the flat 150tk platform
      // fee for using BuyTop to make the sale. This (not the buyer's
      // payment, which passes through to the seller) is BuyTop's actual
      // earning on this order.
      await platformFeeCollection.insertOne({
        type: "SaleFee",
        amount: PLATFORM_FEES.SALE,
        productId: booking.productId,
        bookingId: String(booking._id),
        sellerEmail: product.email,
        category: product.category || "Uncategorized",
        createdAt: new Date(),
      });
      logAudit(req, "cash_payment_confirmed", { bookingId: String(booking._id), price });
      res.send(result);
    })
  );

  router.post(
    "/bkash/create",
    verifyJWT,
    verifyBuyer,
    asyncHandler(async (req, res) => {
      const { bookingId, productId } = req.body;
      if (!bookingId || !productId) {
        return res.status(400).send({ message: "bookingId and productId are required" });
      }
      const booking = await bookingCollection.findOne({ _id: new ObjectId(bookingId) });
      if (!booking || booking.email !== req.decoded.email) {
        return res.status(403).send({ message: "forbidden access" });
      }
      if (!booking.depositPaid) {
        return res.status(400).send({ message: "Please pay the 10% booking deposit first." });
      }
      const price = round2(Number(booking.price) - Number(booking.depositAmount || 0));
      if (!price || price <= 0) {
        return res.status(400).send({ message: "Invalid booking price" });
      }

      const invoiceNumber = `full:${bookingId}:${productId}`;
      const callbackURL = `${SERVER_URL}/bkash/callback`;

      const payment = await bkash.createPayment(price, invoiceNumber, callbackURL);
      if (!payment?.bkashURL) {
        return res.status(502).send({ message: "Could not start bKash payment", details: payment });
      }
      res.send({ bkashURL: payment.bkashURL, paymentID: payment.paymentID });
    })
  );

  // Starts the mandatory 10% deposit payment for a fresh booking. Until
  // this clears, the booking sits in "Awaiting Deposit" and the buyer can
  // still cancel it freely (no seller approval needed at that stage).
  router.post(
    "/bkash/create-deposit",
    verifyJWT,
    verifyBuyer,
    asyncHandler(async (req, res) => {
      const { bookingId, productId } = req.body;
      if (!bookingId || !productId) {
        return res.status(400).send({ message: "bookingId and productId are required" });
      }
      const booking = await bookingCollection.findOne({ _id: new ObjectId(bookingId) });
      if (!booking || booking.email !== req.decoded.email) {
        return res.status(403).send({ message: "forbidden access" });
      }
      if (booking.depositPaid) {
        return res.status(400).send({ message: "The deposit for this booking is already paid." });
      }
      const depositAmount = Number(booking.depositAmount);
      if (!depositAmount || depositAmount <= 0) {
        return res.status(400).send({ message: "Invalid deposit amount" });
      }

      const invoiceNumber = `dep:${bookingId}:${productId}`;
      const callbackURL = `${SERVER_URL}/bkash/callback`;

      // If bKash never even hands back a checkout URL, the deposit flow
      // never actually started - so the "Awaiting Deposit" booking created
      // by /mybooking a moment ago shouldn't stick around either. Rolling
      // it back here (rather than leaving it for the buyer to notice and
      // cancel manually) is what makes "no deposit -> nothing happened"
      // true even when bKash itself is the thing that failed, not the
      // buyer. depositPaid: { $ne: true } as a guard is just defense in
      // depth against a callback racing in and confirming the deposit
      // between the check above and this delete.
      let payment;
      try {
        payment = await bkash.createPayment(depositAmount, invoiceNumber, callbackURL);
      } catch (err) {
        await bookingCollection.deleteOne({ _id: booking._id, depositPaid: { $ne: true } });
        throw err;
      }
      if (!payment?.bkashURL) {
        await bookingCollection.deleteOne({ _id: booking._id, depositPaid: { $ne: true } });
        return res.status(502).send({
          message: "Could not start bKash payment. Please try booking again.",
          details: payment,
        });
      }
      res.send({ bkashURL: payment.bkashURL, paymentID: payment.paymentID });
    })
  );

  // Best-effort cleanup for a deposit checkout that didn't end in success -
  // buyer cancelled on bKash's page, the session expired, or the payment
  // was declined. Looks the pending booking back up from the payment's own
  // invoice number (rather than trusting anything from the client) and, if
  // it's still sitting unpaid, deletes it outright. That's what makes a
  // failed/abandoned deposit leave the product exactly as available as it
  // was before the buyer ever opened the booking form, instead of stuck
  // "Awaiting Deposit" forever under the partial unique index in index.js.
  async function cleanupUnpaidDeposit(paymentID, knownResult) {
    if (!paymentID) return;
    try {
      const info = knownResult || (await bkash.queryPayment(paymentID));
      const invoice = info?.merchantInvoiceNumber || info?.payerReference || "";
      const [kind, bookingId] = String(invoice).split(":");
      if (kind !== "dep" || !bookingId || !ObjectId.isValid(bookingId)) return;
      await bookingCollection.deleteOne({
        _id: new ObjectId(bookingId),
        depositPaid: { $ne: true },
      });
    } catch {
      // Cleanup is best-effort - if this fails, the booking just sits in
      // "Awaiting Deposit" where the buyer can still cancel it manually
      // from My Orders, same as before this cleanup existed.
    }
  }

  router.get(
    "/bkash/callback",
    asyncHandler(async (req, res) => {
      const { paymentID, status } = req.query;

      if (status !== "success" || !paymentID) {
        await cleanupUnpaidDeposit(paymentID);
        return res.redirect(`${CLIENT_URL}/dashboard/myorders?payment=failed`);
      }

      const executeResult = await bkash.executePayment(paymentID);

      if (executeResult?.transactionStatus !== "Completed") {
        await cleanupUnpaidDeposit(paymentID, executeResult);
        return res.redirect(`${CLIENT_URL}/dashboard/myorders?payment=failed`);
      }

      const [kind, bookingId, productId] = String(executeResult.merchantInvoiceNumber || "").split(":");
      if (bookingId && productId) {
        const booking = await bookingCollection.findOne({ _id: new ObjectId(bookingId) });
        if (kind === "dep") {
          await bookingCollection.updateOne(
            { _id: new ObjectId(bookingId) },
            {
              $set: {
                status: "Booked",
                depositPaid: true,
                depositTransactionId: executeResult.trxID,
              },
            }
          );
          // This is the one place the product actually becomes "Booked" -
          // deliberately not at /mybooking time (see the comment there).
          // Until the deposit clears, the product stays Available/Advertised
          // so other buyers can still see and book it; the partial unique
          // index on bookingCollection ({ productId }, isActiveBooking: true,
          // created in index.js) is what stops two buyers from both landing
          // an active booking on it in the meantime. CAS the status here for
          // the same reason - if it's somehow not Available/Advertised
          // anymore (e.g. an admin changed it), don't stomp on that; the
          // deposit is still recorded either way.
          await productsCollection.updateOne(
            { _id: new ObjectId(productId), status: statusMatch("Available", "Advertised") },
            { $set: { status: "Booked" } }
          );
          await paymentCollection.insertOne({
            productId,
            bookingId,
            price: executeResult.amount,
            type: "Deposit",
            status: "Paid",
            method: "bKash",
            transactionId: executeResult.trxID,
            paymentID: executeResult.paymentID,
            buyerEmail: booking?.email,
            createdAt: new Date(),
          });
          const bookedProduct = await productsCollection.findOne({ _id: new ObjectId(productId) });
          if (booking?.email) {
            await sendEmail({
              to: booking.email,
              subject: `Booking confirmed: ${bookedProduct?.productName || "your order"}`,
              heading: "Your deposit was received - booking confirmed",
              body: `Your deposit for "${bookedProduct?.productName || "this order"}" is paid and the item is reserved for you. Coordinate pickup with the seller, then pay the remaining balance when you collect it.`,
              ctaText: "View order",
              ctaUrl: `${CLIENT_URL}/dashboard/myorders`,
            });
          }
          if (bookedProduct?.email) {
            await sendEmail({
              to: bookedProduct.email,
              subject: `Deposit received: ${bookedProduct.productName}`,
              heading: "Deposit received - order confirmed",
              body: `${booking?.userName || booking?.email || "The buyer"} paid their deposit for "${bookedProduct.productName}". Coordinate handover with them, then confirm the remaining payment once it's received.`,
              ctaText: "View order",
              ctaUrl: `${CLIENT_URL}/dashboard/orders`,
            });
          }
        } else {
          // kind === "full": remaining-balance payment after the deposit.
          await bookingCollection.updateOne(
            { _id: new ObjectId(bookingId) },
            { $set: { status: "Paid" } }
          );
          await productsCollection.updateOne(
            { _id: new ObjectId(productId) },
            { $set: { status: "Paid" } }
          );
          await paymentCollection.insertOne({
            productId,
            bookingId,
            price: executeResult.amount,
            type: "Full",
            status: "Paid",
            method: "bKash",
            transactionId: executeResult.trxID,
            paymentID: executeResult.paymentID,
            buyerEmail: booking?.email,
            createdAt: new Date(),
          });
          // The product just sold - charge the seller the flat 150tk
          // platform fee for using BuyTop to make the sale. This (not the
          // buyer's payment, which passes through to the seller) is
          // BuyTop's actual earning on this order.
          const soldProduct = await productsCollection.findOne({ _id: new ObjectId(productId) });
          await platformFeeCollection.insertOne({
            type: "SaleFee",
            amount: PLATFORM_FEES.SALE,
            productId,
            bookingId,
            sellerEmail: soldProduct?.email || null,
            category: soldProduct?.category || "Uncategorized",
            createdAt: new Date(),
          });
          if (booking?.email) {
            await sendEmail({
              to: booking.email,
              subject: `Payment complete: ${soldProduct?.productName || "your order"}`,
              heading: "Your order is complete",
              body: `Your final payment for "${soldProduct?.productName || "this order"}" went through. The sale is now complete - thanks for using BuyTop!`,
              ctaText: "View order",
              ctaUrl: `${CLIENT_URL}/dashboard/myorders`,
            });
          }
          if (soldProduct?.email) {
            await sendEmail({
              to: soldProduct.email,
              subject: `Sale complete: ${soldProduct.productName}`,
              heading: "You've been paid in full",
              body: `${booking?.userName || booking?.email || "The buyer"} paid the remaining balance for "${soldProduct.productName}" via bKash. The sale is complete.`,
              ctaText: "View earnings",
              ctaUrl: `${CLIENT_URL}/dashboard/earnings`,
            });
          }
        }
      }

      res.redirect(
        `${CLIENT_URL}/dashboard/myorders?payment=success&kind=${kind || ""}&trxId=${executeResult.trxID}`
      );
    })
  );

  // Streams a PDF invoice covering every payment (deposit and/or full)
  // made so far on a booking. Available to the buyer who owns the booking.
  router.get(
    "/invoice/:bookingId",
    verifyJWT,
    asyncHandler(async (req, res) => {
      if (!ObjectId.isValid(req.params.bookingId)) {
        return res.status(400).send({ message: "Invalid booking id" });
      }
      const booking = await bookingCollection.findOne({ _id: new ObjectId(req.params.bookingId) });
      if (!booking || booking.email !== req.decoded.email) {
        return res.status(403).send({ message: "forbidden access" });
      }
      const payments = await paymentCollection
        .find({ bookingId: String(req.params.bookingId) })
        .sort({ createdAt: 1 })
        .toArray();
      if (payments.length === 0) {
        return res.status(404).send({ message: "No payment found for this order yet" });
      }
      streamInvoicePDF(res, {
        booking,
        payments,
        invoiceNumber: String(req.params.bookingId).slice(-8).toUpperCase(),
      });
    })
  );

  return router;
}

module.exports = createPaymentRoutes;
