const express = require("express");

// Sellers currently have no view of their own revenue - only Admin can see
// platform-wide RevenueAnalytics. This gives a Seller the same kind of
// breakdown, scoped to just their own listings: gross sales, the flat
// platform fee charged per completed sale, net earnings, a month-by-month
// trend, and what's still expected from bookings that have a deposit down
// but haven't been paid off yet.
function createSellerEarningsRoutes({
  verifyJWT,
  verifySeller,
  asyncHandler,
  productsCollection,
  bookingCollection,
  paymentCollection,
  platformFeeCollection,
  round2,
  ObjectId,
}) {
  const router = express.Router();

  router.get(
    "/seller/earnings",
    verifyJWT,
    verifySeller,
    asyncHandler(async (req, res) => {
      const email = req.decoded.email;

      const myProducts = await productsCollection
        .find({ email })
        .project({ _id: 1 })
        .toArray();
      const productIds = myProducts.map((p) => String(p._id));

      if (productIds.length === 0) {
        return res.send({
          totalGrossSales: 0,
          totalPlatformFees: 0,
          netEarnings: 0,
          completedOrders: 0,
          pendingOrders: 0,
          pendingValue: 0,
          byMethod: { bKash: 0, Cash: 0 },
          monthly: [],
          recent: [],
        });
      }

      // A completed sale is the "Full" payment record that closes out a
      // booking (bKash remaining-balance payment, or the seller-confirmed
      // cash payment) - see routes/payments.js. Its own `price` is only
      // the remaining balance though, not the total sale price, so the
      // actual sale amount is read off the booking (`booking.price`,
      // fixed at booking time from the product's resalePrice).
      const [fullPayments, pendingBookings, fees] = await Promise.all([
        paymentCollection
          .find({ type: "Full", status: "Paid", productId: { $in: productIds } })
          .sort({ createdAt: -1 })
          .toArray(),
        bookingCollection
          .find({ productId: { $in: productIds }, status: "Booked", depositPaid: true })
          .toArray(),
        platformFeeCollection.find({ sellerEmail: email }).toArray(),
      ]);

      const bookingIds = fullPayments
        .map((p) => p.bookingId)
        .filter((id) => id && ObjectId.isValid(id));
      const bookings = bookingIds.length
        ? await bookingCollection
            .find({ _id: { $in: bookingIds.map((id) => new ObjectId(id)) } })
            .toArray()
        : [];
      const bookingById = new Map(bookings.map((b) => [String(b._id), b]));

      const sales = fullPayments
        .map((p) => {
          const booking = bookingById.get(String(p.bookingId));
          if (!booking) return null;
          return {
            bookingId: String(p.bookingId),
            productId: p.productId,
            productName: booking.productName || "",
            amount: Number(booking.price) || 0,
            method: p.method,
            date: p.createdAt,
          };
        })
        .filter(Boolean);

      const totalGrossSales = round2(sales.reduce((sum, s) => sum + s.amount, 0));
      const totalPlatformFees = round2(fees.reduce((sum, f) => sum + Number(f.amount || 0), 0));
      const netEarnings = round2(totalGrossSales - totalPlatformFees);

      const byMethod = sales.reduce(
        (acc, s) => {
          acc[s.method] = round2((acc[s.method] || 0) + s.amount);
          return acc;
        },
        { bKash: 0, Cash: 0 }
      );

      // Month-by-month trend, oldest to newest, keyed "YYYY-MM" so the
      // client can sort/label without re-parsing dates.
      const monthlyMap = new Map();
      for (const s of sales) {
        const d = new Date(s.date);
        const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
        monthlyMap.set(key, round2((monthlyMap.get(key) || 0) + s.amount));
      }
      const monthly = Array.from(monthlyMap.entries())
        .sort(([a], [b]) => (a < b ? -1 : 1))
        .map(([month, total]) => ({ month, total }));

      const pendingValue = round2(pendingBookings.reduce((sum, b) => sum + (Number(b.price) || 0), 0));

      res.send({
        totalGrossSales,
        totalPlatformFees,
        netEarnings,
        completedOrders: sales.length,
        pendingOrders: pendingBookings.length,
        pendingValue,
        byMethod,
        monthly,
        recent: sales.slice(0, 10),
      });
    })
  );

  return router;
}

module.exports = createSellerEarningsRoutes;
