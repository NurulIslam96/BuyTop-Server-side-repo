const express = require("express");

function createSellerProfileRoutes({
  verifyJWT,
  mutationLimiter,
  asyncHandler,
  usersCollection,
  productsCollection,
  reviewsCollection,
  round2,
  createNotification,
}) {
  const router = express.Router();

  // Public-facing seller profile: basic info, review summary, and their
  // current listings. Anyone signed in can view it (not just buyers) - a
  // seller can look at their own page the same way a buyer would.
  router.get(
    "/seller-profile/:email",
    verifyJWT,
    asyncHandler(async (req, res) => {
      const email = req.params.email;
      const seller = await usersCollection.findOne({ email, role: { $in: ["Seller", "Developer"] } });
      if (!seller) {
        return res.status(404).send({ message: "Seller not found" });
      }
      const [listings, reviews] = await Promise.all([
        productsCollection.find({ email, status: { $ne: "Paid" } }).sort({ _id: -1 }).toArray(),
        reviewsCollection.find({ sellerEmail: email }).sort({ _id: -1 }).toArray(),
      ]);
      const reviewCount = reviews.length;
      const averageRating = reviewCount > 0
        ? round2(reviews.reduce((sum, r) => sum + r.rating, 0) / reviewCount)
        : 0;
      res.send({
        email: seller.email,
        name: seller.name,
        photo: seller.photo,
        verified: seller.verified === true,
        joinedAt: seller.createdAt || null,
        listings,
        reviews,
        averageRating,
        reviewCount,
      });
    })
  );

  // A buyer leaves (or edits) a review for a seller. Upserts by
  // sellerEmail+buyerEmail so submitting again just updates their existing
  // review instead of creating duplicates - same pattern as PUT /reported/:id.
  router.put(
    "/reviews/:sellerEmail",
    mutationLimiter,
    verifyJWT,
    asyncHandler(async (req, res) => {
      const sellerEmail = req.params.sellerEmail;
      const buyerEmail = req.decoded.email;
      if (sellerEmail === buyerEmail) {
        return res.status(400).send({ message: "You can't review yourself" });
      }
      const seller = await usersCollection.findOne({ email: sellerEmail, role: { $in: ["Seller", "Developer"] } });
      if (!seller) {
        return res.status(404).send({ message: "Seller not found" });
      }
      // Same rule as booking: a Developer test account may only leave demo
      // reviews on a demo (Developer) seller, never pollute a real
      // seller's real rating with a test review.
      const reviewer = await usersCollection.findOne({ email: buyerEmail });
      if (reviewer?.role === "Developer" && seller.role !== "Developer") {
        return res.status(403).send({
          message: "Developer test accounts can only review demo sellers.",
        });
      }
      const rating = Number(req.body?.rating);
      if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
        return res.status(400).send({ message: "Rating must be a whole number from 1 to 5" });
      }
      const comment = typeof req.body?.comment === "string" ? req.body.comment.trim().slice(0, 500) : "";
      const buyer = await usersCollection.findOne({ email: buyerEmail });
      const filter = { sellerEmail, buyerEmail };
      const updateDoc = {
        $set: {
          sellerEmail,
          buyerEmail,
          buyerName: buyer?.name || "Buyer",
          buyerPhoto: buyer?.photo || "",
          rating,
          comment,
          updatedAt: new Date(),
        },
        $setOnInsert: { createdAt: new Date() },
      };
      const result = await reviewsCollection.updateOne(filter, updateDoc, { upsert: true });
      await createNotification({
        email: sellerEmail,
        type: "review",
        title: result.upsertedCount ? "You got a new review" : "A review was updated",
        body: `${buyer?.name || buyerEmail} rated you ${rating}/5${comment ? `: "${comment.slice(0, 80)}"` : ""}`,
        link: `/profile`,
      });
      res.send(result);
    })
  );

  // A buyer removing their own review.
  router.delete(
    "/reviews/:sellerEmail",
    verifyJWT,
    asyncHandler(async (req, res) => {
      const result = await reviewsCollection.deleteOne({
        sellerEmail: req.params.sellerEmail,
        buyerEmail: req.decoded.email,
      });
      res.send(result);
    })
  );

  return router;
}

module.exports = createSellerProfileRoutes;
