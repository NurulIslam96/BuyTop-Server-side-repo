const express = require("express");

// Saving something already saved is a no-op rather than an error (see the
// upsert below), so the client's heart-toggle button doesn't need to
// track local state to avoid a duplicate-key error.
function createWishlistRoutes({
  verifyJWT,
  asyncHandler,
  wishlistCollection,
  productsCollection,
  usersCollection,
  createNotification,
  ObjectId,
}) {
  const router = express.Router();

  // Lightweight list of just the saved product ids, so pages that render a
  // grid of products (category pages, home) can cheaply mark which ones
  // are already saved without fetching full product docs twice.
  router.get(
    "/wishlist/ids",
    verifyJWT,
    asyncHandler(async (req, res) => {
      const entries = await wishlistCollection
        .find({ email: req.decoded.email })
        .project({ productId: 1 })
        .toArray();
      res.send(entries.map((e) => e.productId.toString()));
    })
  );

  router.get(
    "/wishlist",
    verifyJWT,
    asyncHandler(async (req, res) => {
      const entries = await wishlistCollection
        .find({ email: req.decoded.email })
        .sort({ createdAt: -1 })
        .toArray();
      const ids = entries.map((e) => e.productId);
      const products = await productsCollection
        .find({ _id: { $in: ids } })
        .toArray();
      const productsById = new Map(products.map((p) => [p._id.toString(), p]));
      // Preserve save order and quietly drop entries whose product has
      // since been deleted, rather than surfacing a null/broken card.
      const result = entries
        .map((e) => {
          const product = productsById.get(e.productId.toString());
          return product ? { ...product, savedAt: e.createdAt } : null;
        })
        .filter(Boolean);
      res.send(result);
    })
  );

  router.post(
    "/wishlist",
    verifyJWT,
    asyncHandler(async (req, res) => {
      const { productId } = req.body || {};
      if (!productId || !ObjectId.isValid(productId)) {
        return res.status(400).send({ message: "Invalid product id" });
      }
      const product = await productsCollection.findOne({ _id: new ObjectId(productId) });
      if (!product) {
        return res.status(404).send({ message: "Product not found" });
      }
      const upsertResult = await wishlistCollection.updateOne(
        { email: req.decoded.email, productId: new ObjectId(productId) },
        { $setOnInsert: { email: req.decoded.email, productId: new ObjectId(productId), createdAt: new Date() } },
        { upsert: true }
      );
      // Only notify on a genuinely new save (not a no-op re-save), and
      // never when the seller wishlists their own listing.
      if (upsertResult.upsertedCount && product.email && product.email !== req.decoded.email) {
        const saver = await usersCollection.findOne({ email: req.decoded.email });
        await createNotification({
          email: product.email,
          type: "wishlist",
          title: "Your item was saved",
          body: `${saver?.name || req.decoded.email} saved "${product.productName}" to their wishlist`,
          link: `/product/${product._id}`,
        });
      }
      res.send({ saved: true });
    })
  );

  router.delete(
    "/wishlist/:productId",
    verifyJWT,
    asyncHandler(async (req, res) => {
      const { productId } = req.params;
      if (!ObjectId.isValid(productId)) {
        return res.status(400).send({ message: "Invalid product id" });
      }
      await wishlistCollection.deleteOne({
        email: req.decoded.email,
        productId: new ObjectId(productId),
      });
      res.send({ saved: false });
    })
  );

  return router;
}

module.exports = createWishlistRoutes;
