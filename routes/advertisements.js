const express = require("express");

function createAdvertisementRoutes({
  verifyJWT,
  verifySeller,
  asyncHandler,
  productsCollection,
  categoriesCollection,
  platformFeeCollection,
  usersCollection,
  CANONICAL_STATUS,
  PLATFORM_FEES,
  statusMatch,
  ObjectId,
}) {
  const router = express.Router();

  router.patch(
    "/addAdv/:id",
    verifyJWT,
    verifySeller,
    asyncHandler(async (req, res) => {
      if (!ObjectId.isValid(req.params.id)) {
        return res.status(400).send({ message: "Invalid product id" });
      }
      const product = await productsCollection.findOne({ _id: new ObjectId(req.params.id), email: req.decoded.email });
      if (!product) {
        return res.status(403).send({ message: "forbidden access" });
      }
      // Only charge the 100tk ad fee on the transition INTO Advertised, so
      // re-saving/toggling on an already-advertised listing never double
      // charges the seller.
      const alreadyAdvertised = String(product.status || "").toLowerCase() === "advertised";

      // wasAdvertised is set once and never cleared - unlike status, which
      // moves on to Booked/Paid once the item sells - so it's still
      // possible later to tell a sold item that was once advertised apart
      // from one that never was (see GET /admin/analytics/inventory).
      const result = await productsCollection.updateOne(
        { _id: new ObjectId(req.params.id), email: req.decoded.email },
        { $set: { status: CANONICAL_STATUS.ADVERTISED, wasAdvertised: true } }
      );
      if (result.matchedCount === 0) {
        return res.status(403).send({ message: "forbidden access" });
      }
      if (!alreadyAdvertised) {
        await platformFeeCollection.insertOne({
          type: "AdFee",
          amount: PLATFORM_FEES.ADVERTISEMENT,
          productId: req.params.id,
          sellerEmail: product.email,
          category: product.category || "Uncategorized",
          createdAt: new Date(),
        });
      }
      res.send(result);
    })
  );

  router.patch(
    "/rmvadvertise/:id",
    verifyJWT,
    verifySeller,
    asyncHandler(async (req, res) => {
      const result = await productsCollection.updateOne(
        { _id: new ObjectId(req.params.id), email: req.decoded.email },
        { $set: { status: CANONICAL_STATUS.AVAILABLE } }
      );
      if (result.matchedCount === 0) {
        return res.status(403).send({ message: "forbidden access" });
      }
      res.send(result);
    })
  );

  router.get(
    "/alladv",
    asyncHandler(async (req, res) => {
      // Same reasoning as /category/:id in routes/products.js - a banned
      // seller's listing shouldn't keep showing up somewhere as prominent
      // as the homepage carousel.
      const bannedEmails = (
        await usersCollection.find({ status: "banned" }).project({ email: 1 }).toArray()
      ).map((u) => u.email);
      const result = await productsCollection
        .find({
          status: statusMatch("Advertised"),
          isDemo: { $ne: true },
          email: { $nin: bannedEmails },
        })
        .sort({ _id: -1 })
        .toArray();
      // Attach each product's category id so the client can link straight
      // through to that category page from the advertisement.
      const categories = await categoriesCollection.find({}).toArray();
      const categoryIdByName = {};
      categories.forEach((c) => {
        categoryIdByName[c.Category] = c._id;
      });
      const withCategoryId = result.map((product) => ({
        ...product,
        categoryId: categoryIdByName[product.category] || null,
      }));
      res.send(withCategoryId);
    })
  );

  return router;
}

module.exports = createAdvertisementRoutes;
