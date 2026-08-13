const express = require("express");

// A saved search is scoped to one category (BuyTop's browsing is
// category-first, see Pages/Categories/Products.js) plus an optional
// keyword and an optional "alert me under this price" ceiling. Matching
// happens once, at the moment a new product is listed (see
// notifyMatchingSavedSearches() in products.js) - not on a schedule -
// so an alert fires within moments of a matching listing going up
// instead of on some polling delay.
function createSavedSearchRoutes({
  verifyJWT,
  verifySelf,
  asyncHandler,
  savedSearchesCollection,
  ObjectId,
}) {
  const router = express.Router();

  router.get(
    "/saved-searches/:email",
    verifyJWT,
    verifySelf,
    asyncHandler(async (req, res) => {
      const result = await savedSearchesCollection
        .find({ email: req.params.email })
        .sort({ createdAt: -1 })
        .toArray();
      res.send(result);
    })
  );

  router.post(
    "/saved-searches",
    verifyJWT,
    asyncHandler(async (req, res) => {
      const { categoryName, keyword, maxPrice } = req.body || {};
      if (!categoryName || typeof categoryName !== "string") {
        return res.status(400).send({ message: "categoryName is required" });
      }
      const doc = {
        email: req.decoded.email,
        categoryName,
        keyword: typeof keyword === "string" ? keyword.trim().slice(0, 100) : "",
        maxPrice: maxPrice ? Number(maxPrice) : null,
        createdAt: new Date(),
      };
      const result = await savedSearchesCollection.insertOne(doc);
      res.send({ ...result, savedSearch: doc });
    })
  );

  router.delete(
    "/saved-searches/:id",
    verifyJWT,
    asyncHandler(async (req, res) => {
      if (!ObjectId.isValid(req.params.id)) {
        return res.status(400).send({ message: "Invalid id" });
      }
      const result = await savedSearchesCollection.deleteOne({
        _id: new ObjectId(req.params.id),
        email: req.decoded.email,
      });
      if (result.deletedCount === 0) {
        return res.status(403).send({ message: "forbidden access" });
      }
      res.send(result);
    })
  );

  return router;
}

module.exports = createSavedSearchRoutes;
