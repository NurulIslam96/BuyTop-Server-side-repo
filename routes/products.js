const express = require("express");
const { savedSearchMatches } = require("../validation");

function createProductRoutes({
  verifyJWT,
  verifySeller,
  verifyDeveloper,
  mutationLimiter,
  validateBody,
  addProductSchema,
  asyncHandler,
  productsCollection,
  categoriesCollection,
  usersCollection,
  savedSearchesCollection,
  createNotification,
  sendEmail,
  CLIENT_URL,
  ObjectId,
}) {
  const router = express.Router();

  // A new listing going live is checked against every saved search in its
  // category. isDemo listings are skipped - they never appear on the real
  // storefront, so alerting on them would be misleading. Runs after the
  // response is already sent (fire-and-forget from the caller's point of
  // view), same "side effect that shouldn't block or fail the main
  // request" reasoning as createNotification itself.
  const notifyMatchingSavedSearches = async (product) => {
    if (product.isDemo) return;
    try {
      const candidates = await savedSearchesCollection
        .find({ categoryName: product.category })
        .toArray();
      const price = Number(product.resalePrice);
      const matches = candidates.filter((s) => savedSearchMatches(product, s));
      for (const match of matches) {
        await createNotification({
          email: match.email,
          type: "saved-search",
          title: "A new listing matches your saved search",
          body: `"${product.productName}" was just listed in ${product.category} for ৳${price.toLocaleString("en-BD")}`,
          link: `/product/${product._id}`,
        });
        await sendEmail({
          to: match.email,
          subject: `New match: ${product.productName}`,
          heading: "A new listing matches your saved search",
          body: `"${product.productName}" was just listed in ${product.category} for ৳${price.toLocaleString("en-BD")} - matching the search you saved.`,
          ctaText: "View listing",
          ctaUrl: `${CLIENT_URL}/product/${product._id}`,
        });
      }
    } catch (err) {
      console.error("notifyMatchingSavedSearches failed:", err.message);
    }
  };

  // Emails of currently-banned accounts, so browse/search surfaces can
  // exclude their listings. Banning a seller is meant to actually stop
  // buyers from finding and booking their stuff, not just block them from
  // signing back in - a direct link (GET /product/:id) still works on
  // purpose, same tradeoff most platforms make for a suspended account's
  // content.
  const bannedSellerEmails = async () =>
    (await usersCollection.find({ status: "banned" }).project({ email: 1 }).toArray()).map(
      (u) => u.email
    );

  router.get(
    "/product/:id",
    verifyJWT,
    asyncHandler(async (req, res) => {
      const { id } = req.params;
      if (!ObjectId.isValid(id)) {
        return res.status(400).send({ message: "Invalid product id" });
      }
      const product = await productsCollection.findOne({ _id: new ObjectId(id) });
      if (!product) {
        return res.status(404).send({ message: "Product not found" });
      }
      // Demo products (added by a Developer test account) are hidden from
      // the storefront/category listings, but someone could still have the
      // direct link/id. Keep it fully invisible to real buyers/sellers -
      // only its own Developer owner, another Developer test account (the
      // sandbox is a shared test space so one Developer can book another's
      // demo listing), or staff (Admin/Moderator) can open it.
      if (product.isDemo) {
        const requester = await usersCollection.findOne({ email: req.decoded.email });
        const isOwner = requester?.email === product.email;
        const isDeveloper = requester?.role === "Developer";
        const isStaff = requester && ["Admin", "Moderator"].includes(requester.role);
        if (!isOwner && !isDeveloper && !isStaff) {
          return res.status(404).send({ message: "Product not found" });
        }
      }
      // product.category stores the category NAME (see AddProduct.js), but
      // the category page is keyed by categoriesCollection's _id - look
      // that up so the client can link straight back to the right category.
      const category = await categoriesCollection.findOne({ Category: product.category });
      res.send({ ...product, categoryId: category?._id || null });
    })
  );

  router.get(
    "/category/:id",
    verifyJWT,
    asyncHandler(async (req, res) => {
      const id = req.params.id;
      if (!ObjectId.isValid(id)) {
        return res.status(400).send({ message: "Invalid category id" });
      }
      const category = await categoriesCollection.findOne({ _id: new ObjectId(id) });
      if (!category) {
        return res.status(404).send({ message: "Category not found" });
      }
      const excludedEmails = await bannedSellerEmails();
      const result = await productsCollection
        .find({
          category: category.Category,
          isDemo: { $ne: true },
          email: { $nin: excludedEmails },
        })
        .sort({ _id: -1 })
        .toArray();
      res.send({ result, category });
    })
  );

  // Developer-only sandbox: every isDemo product, from any category, in one
  // place. isDemo products are hidden from /category/:id and everywhere
  // else on the real storefront on purpose - this is the one page that
  // deliberately shows them, so a Developer test account has somewhere to
  // find and book its own test listings. Shaped exactly like /category/:id's
  // response so the client can reuse the same
  // ProductBanner/ProductFilterBar/ProductsDetails components.
  router.get(
    "/developer/sandbox",
    verifyJWT,
    verifyDeveloper,
    asyncHandler(async (req, res) => {
      const result = await productsCollection
        .find({ isDemo: true })
        .sort({ _id: -1 })
        .toArray();
      res.send({
        result,
        category: {
          _id: "dev-sandbox",
          Category: "Developer Test Sandbox",
          heading: "Developer Test Sandbox",
          subtitle:
            "Every demo listing across all categories, in one place. Anything booked here stays off the real storefront and out of site analytics.",
        },
      });
    })
  );

  router.post(
    "/addproduct",
    mutationLimiter,
    verifyJWT,
    verifySeller,
    validateBody(addProductSchema),
    asyncHandler(async (req, res) => {
      // Previously insertOne(req.body) trusted the whole payload, including
      // fields that authorize things downstream - "email" ties the listing
      // to a seller for ownership checks elsewhere (MyProducts, delete,
      // etc.), "status" controls whether it's live/bookable, and
      // "isVerified" drives the trust badge shown to buyers. A tampered
      // request could set any of those to whatever it wanted (impersonate
      // another seller, skip straight to "Booked", or fake a verified
      // badge). Those three are forced from server-side truth here; the
      // rest of the body (name, photos, description, price, etc.) is only
      // ever displayed, not used for authorization, so it's fine to pass
      // through as-is.
      const product = {
        ...req.body,
        email: req.decoded.email,
        status: "Available",
        isVerified: req.sellerUser.verified === true,
        // Anything a Developer test account lists is demo inventory only -
        // it never appears on the storefront, homepage, or in analytics,
        // and only its own owner or staff can open its product page directly.
        isDemo: req.sellerUser.role === "Developer",
      };
      const result = await productsCollection.insertOne(product);
      res.send(result);
      notifyMatchingSavedSearches({ ...product, _id: result.insertedId });
    })
  );

  // Bulk-list many products at once from a CSV a seller uploads (parsed to
  // an array of row objects client-side with papaparse). Every row is
  // validated with the exact same schema/rules as a single /addproduct
  // call - a bad row is skipped and reported back, it never blocks the
  // rows around it, so a seller with 50 rows and 2 typos still gets 48
  // listings instead of nothing.
  router.post(
    "/products/bulk-import",
    mutationLimiter,
    verifyJWT,
    verifySeller,
    asyncHandler(async (req, res) => {
      const rows = Array.isArray(req.body?.rows) ? req.body.rows : [];
      if (rows.length === 0) {
        return res.status(400).send({ message: "No rows to import" });
      }
      // A single mistaken paste shouldn't be able to spam-create thousands
      // of listings in one request - same order of magnitude as a seller
      // reasonably managing their own catalog by hand.
      if (rows.length > 200) {
        return res.status(400).send({ message: "Import is limited to 200 rows at a time" });
      }

      const categoryNames = new Set(
        (await categoriesCollection.find({}).project({ Category: 1 }).toArray()).map(
          (c) => c.Category
        )
      );

      const toImport = [];
      const results = [];

      rows.forEach((rawRow, index) => {
        // CSV cells arrive as strings, and a multi-image column is a
        // single "url1|url2|url3" cell rather than a real array - split
        // that out before handing the row to the same schema /addproduct
        // uses, so validation behaves identically either way.
        const images = String(rawRow.images || rawRow.productPhoto || "")
          .split(/[|,]/)
          .map((s) => s.trim())
          .filter(Boolean);

        const candidate = {
          ...rawRow,
          images,
          productPhoto: images[0] || undefined,
        };

        const parsed = addProductSchema.safeParse(candidate);
        if (!parsed.success) {
          const issue = parsed.error.issues[0];
          results.push({
            row: index + 1,
            success: false,
            message: `${issue.path.join(".") || "row"} - ${issue.message}`,
          });
          return;
        }
        if (!categoryNames.has(parsed.data.category)) {
          results.push({
            row: index + 1,
            success: false,
            message: `Unknown category "${parsed.data.category}"`,
          });
          return;
        }
        toImport.push({ index, product: parsed.data });
      });

      if (toImport.length > 0) {
        const docs = toImport.map(({ product }) => ({
          ...product,
          email: req.decoded.email,
          status: "Available",
          isVerified: req.sellerUser.verified === true,
          isDemo: req.sellerUser.role === "Developer",
        }));
        const insertResult = await productsCollection.insertMany(docs);
        toImport.forEach(({ index }, i) => {
          results.push({
            row: index + 1,
            success: true,
            id: insertResult.insertedIds[i],
          });
        });
        docs.forEach((doc, i) => {
          notifyMatchingSavedSearches({ ...doc, _id: insertResult.insertedIds[i] });
        });
      }

      results.sort((a, b) => a.row - b.row);
      res.send({
        imported: toImport.length,
        failed: results.length - toImport.length,
        results,
      });
    })
  );

  router.delete(
    "/myproducts/:id",
    verifyJWT,
    verifySeller,
    asyncHandler(async (req, res) => {
      const result = await productsCollection.deleteOne({
        _id: new ObjectId(req.params.id),
        email: req.decoded.email,
      });
      if (result.deletedCount === 0) {
        return res.status(403).send({ message: "forbidden access" });
      }
      res.send(result);
    })
  );

  router.get(
    "/myproducts/:email",
    verifyJWT,
    verifySeller,
    asyncHandler(async (req, res) => {
      // verifySeller only checks the caller's *role*, not which account
      // they're asking about - it never validated req.params.email against
      // who's actually signed in. That meant any Seller/Developer account
      // could list *any other seller's* complete, unfiltered product
      // history (including Paid/private records the public seller profile
      // deliberately excludes) just by changing the email in the URL.
      // Ignoring the URL param entirely and always querying by the
      // token's own email closes that off regardless of what's passed in.
      const result = await productsCollection
        .find({ email: req.decoded.email })
        .sort({ _id: -1 })
        .toArray();
      res.send(result);
    })
  );

  return router;
}

module.exports = createProductRoutes;
