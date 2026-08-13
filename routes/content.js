const express = require("express");

// Homepage/browsing content that staff manage directly: categories, the
// homepage carousel, community blog posts (with moderation), and the
// site-wide maintenance-mode toggle.
function createContentRoutes({
  verifyJWT,
  verifyAdmin,
  verifyMainAdmin,
  asyncHandler,
  categoriesCollection,
  blogsCollection,
  settingsCollection,
  carouselCollection,
  usersCollection,
  STAFF_ROLES,
  logAudit,
  ObjectId,
}) {
  const router = express.Router();

  // ---- Categories --------------------------------------------------------

  router.get(
    "/categories",
    asyncHandler(async (req, res) => {
      const result = await categoriesCollection.find({}).toArray();
      res.send(result);
    })
  );

  // Admin & Moderator: create a new category shown on the homepage / category browser.
  router.post(
    "/categories",
    verifyJWT,
    verifyAdmin,
    asyncHandler(async (req, res) => {
      const { Category, image, banner, heading, subtitle } = req.body || {};
      if (!Category?.trim()) {
        return res.status(400).send({ message: "A category name is required" });
      }
      const category = {
        Category: Category.trim(),
        image: typeof image === "string" ? image.trim() : "",
        banner: typeof banner === "string" ? banner.trim() : "",
        heading: typeof heading === "string" ? heading.trim() : "",
        subtitle: typeof subtitle === "string" ? subtitle.trim() : "",
        addedBy: req.decoded.email,
        createdAt: new Date(),
      };
      const result = await categoriesCollection.insertOne(category);
      res.send(result);
    })
  );

  // Admin & Moderator: edit a category's name, homepage tile image, category-page
  // banner image, and the banner's heading/subtitle text.
  router.patch(
    "/categories/:id",
    verifyJWT,
    verifyAdmin,
    asyncHandler(async (req, res) => {
      const { Category, image, banner, heading, subtitle } = req.body || {};
      const updateDoc = {};
      if (typeof Category === "string" && Category.trim()) updateDoc.Category = Category.trim();
      if (typeof image === "string") updateDoc.image = image.trim();
      if (typeof banner === "string") updateDoc.banner = banner.trim();
      if (typeof heading === "string") updateDoc.heading = heading.trim();
      if (typeof subtitle === "string") updateDoc.subtitle = subtitle.trim();
      if (Object.keys(updateDoc).length === 0) {
        return res.status(400).send({ message: "Nothing to update" });
      }
      const result = await categoriesCollection.updateOne(
        { _id: new ObjectId(req.params.id) },
        { $set: updateDoc }
      );
      res.send(result);
    })
  );

  router.delete(
    "/categories/:id",
    verifyJWT,
    verifyAdmin,
    asyncHandler(async (req, res) => {
      const result = await categoriesCollection.deleteOne({ _id: new ObjectId(req.params.id) });
      res.send(result);
    })
  );

  // ---- Blogs --------------------------------------------------------------

  router.get(
    "/blogs",
    asyncHandler(async (req, res) => {
      const result = await blogsCollection
        .find({ $or: [{ status: "approved" }, { status: { $exists: false } }] })
        .sort({ _id: -1 })
        .toArray();
      res.send(result);
    })
  );

  // Admin & Moderator: the moderation queue of not-yet-approved posts.
  router.get(
    "/blogs/pending",
    verifyJWT,
    verifyAdmin,
    asyncHandler(async (req, res) => {
      const result = await blogsCollection
        .find({ status: "pending" })
        .sort({ _id: -1 })
        .toArray();
      res.send(result);
    })
  );

  // Any logged-in user can submit a blog post. Admin/Moderator posts publish
  // immediately (they don't need to review their own writing); everyone
  // else's goes to the moderation queue until approved.
  router.post(
    "/blogs",
    verifyJWT,
    asyncHandler(async (req, res) => {
      const { question, answer, banner } = req.body || {};
      if (!question?.trim() || !answer?.trim()) {
        return res.status(400).send({ message: "Question and answer are required" });
      }
      if (question.trim().length > 300) {
        return res.status(400).send({ message: "Question must be 300 characters or fewer" });
      }
      if (answer.trim().length > 20000) {
        return res.status(400).send({ message: "Answer must be 20,000 characters or fewer" });
      }
      const author = await usersCollection.findOne({ email: req.decoded.email });
      const isStaff = STAFF_ROLES.includes(author?.role);
      const blog = {
        question: question.trim(),
        answer: answer.trim(),
        banner: typeof banner === "string" ? banner.trim().slice(0, 2000) : "",
        date: new Date(),
        authorEmail: req.decoded.email,
        authorName: author?.name || "",
        status: isStaff ? "approved" : "pending",
        ...(isStaff && { approvedBy: req.decoded.email, approvedAt: new Date() }),
      };
      const result = await blogsCollection.insertOne(blog);
      res.send(result);
    })
  );

  // Admin & Moderator: approve a pending post so it shows up publicly.
  router.patch(
    "/blogs/:id/approve",
    verifyJWT,
    verifyAdmin,
    asyncHandler(async (req, res) => {
      const result = await blogsCollection.updateOne(
        { _id: new ObjectId(req.params.id) },
        {
          $set: {
            status: "approved",
            approvedBy: req.decoded.email,
            approvedAt: new Date(),
          },
        }
      );
      res.send(result);
    })
  );

  // The blog's own author can edit it later. This keeps whatever approval
  // status the post already had - it doesn't force a re-review, so an
  // author editing their live post doesn't suddenly see it vanish from
  // the public list.
  router.patch(
    "/blogs/:id",
    verifyJWT,
    asyncHandler(async (req, res) => {
      if (!ObjectId.isValid(req.params.id)) {
        return res.status(400).send({ message: "Invalid blog id" });
      }
      const blog = await blogsCollection.findOne({ _id: new ObjectId(req.params.id) });
      if (!blog) {
        return res.status(404).send({ message: "Blog not found" });
      }
      if (blog.authorEmail !== req.decoded.email) {
        return res.status(403).send({ message: "You can only edit your own blog posts" });
      }
      const { question, answer, banner } = req.body || {};
      if (!question?.trim() || !answer?.trim()) {
        return res.status(400).send({ message: "Question and answer are required" });
      }
      if (question.trim().length > 300) {
        return res.status(400).send({ message: "Question must be 300 characters or fewer" });
      }
      if (answer.trim().length > 20000) {
        return res.status(400).send({ message: "Answer must be 20,000 characters or fewer" });
      }
      const updateDoc = {
        $set: {
          question: question.trim(),
          answer: answer.trim(),
          banner: typeof banner === "string" ? banner.trim().slice(0, 2000) : "",
          editedAt: new Date(),
        },
      };
      const result = await blogsCollection.updateOne(
        { _id: new ObjectId(req.params.id) },
        updateDoc
      );
      res.send(result);
    })
  );

  // Admin & Moderator: reject a pending post, or remove an already-published
  // one. A blog's own author can also delete their own post (the client
  // makes them re-enter their password first via Firebase reauthentication
  // before calling this).
  router.delete(
    "/blogs/:id",
    verifyJWT,
    asyncHandler(async (req, res) => {
      if (!ObjectId.isValid(req.params.id)) {
        return res.status(400).send({ message: "Invalid blog id" });
      }
      const blog = await blogsCollection.findOne({ _id: new ObjectId(req.params.id) });
      if (!blog) {
        return res.status(404).send({ message: "Blog not found" });
      }
      const requester = await usersCollection.findOne({ email: req.decoded.email });
      const isStaff = STAFF_ROLES.includes(requester?.role);
      const isOwner = blog.authorEmail === req.decoded.email;
      if (!isStaff && !isOwner) {
        return res.status(403).send({ message: "forbidden access" });
      }
      const result = await blogsCollection.deleteOne({ _id: new ObjectId(req.params.id) });
      res.send(result);
    })
  );

  // ---- Site status / maintenance mode --------------------------------------

  // Public: current maintenance status. No auth required - this has to be
  // readable by logged-out visitors (and by every page before we even know
  // who's logged in) so the storefront can show the "under construction"
  // state instead of the normal site.
  router.get(
    "/site-status",
    asyncHandler(async (req, res) => {
      const settings = await settingsCollection.findOne({ _id: "site" });
      res.send({
        maintenanceMode: !!settings?.maintenanceMode,
        maintenanceMessage:
          settings?.maintenanceMessage ||
          "We're currently performing scheduled maintenance. Please check back soon.",
      });
    })
  );

  // Main Admin only: flip the whole site into/out of maintenance mode. While
  // on, sellers/buyers/sub-admins are locked out of everything except the
  // login page - only a full Admin can still get in, so there's always a
  // way to turn it back off.
  router.patch(
    "/admin/maintenance",
    verifyJWT,
    verifyMainAdmin,
    asyncHandler(async (req, res) => {
      const { maintenanceMode, maintenanceMessage } = req.body || {};
      const update = {
        updatedAt: new Date(),
        updatedBy: req.decoded.email,
      };
      if (typeof maintenanceMode === "boolean") update.maintenanceMode = maintenanceMode;
      if (typeof maintenanceMessage === "string") update.maintenanceMessage = maintenanceMessage.trim();
      const result = await settingsCollection.updateOne(
        { _id: "site" },
        { $set: update },
        { upsert: true }
      );
      logAudit(req, "maintenance_mode_changed", {
        maintenanceMode: update.maintenanceMode,
        maintenanceMessage: update.maintenanceMessage,
      });
      res.send(result);
    })
  );

  // ---- Homepage carousel ---------------------------------------------------

  router.get(
    "/carousel",
    asyncHandler(async (req, res) => {
      const result = await carouselCollection.find({}).sort({ _id: 1 }).toArray();
      res.send(result);
    })
  );

  // Admin & Moderator: manage the homepage carousel images.
  router.post(
    "/carousel",
    verifyJWT,
    verifyAdmin,
    asyncHandler(async (req, res) => {
      const { image, title, subtitle } = req.body || {};
      if (!image?.trim()) {
        return res.status(400).send({ message: "An image URL is required" });
      }
      const slide = {
        image: image.trim(),
        title: typeof title === "string" ? title.trim() : "",
        subtitle: typeof subtitle === "string" ? subtitle.trim() : "",
        addedBy: req.decoded.email,
        createdAt: new Date(),
      };
      const result = await carouselCollection.insertOne(slide);
      res.send(result);
    })
  );

  router.delete(
    "/carousel/:id",
    verifyJWT,
    verifyAdmin,
    asyncHandler(async (req, res) => {
      const result = await carouselCollection.deleteOne({ _id: new ObjectId(req.params.id) });
      res.send(result);
    })
  );

  return router;
}

module.exports = createContentRoutes;
