const express = require("express");

function createDatabaseAdminRoutes({
  rateLimit,
  verifyJWT,
  verifyMainAdmin,
  asyncHandler,
  logAudit,
  ObjectId,
  auditLogCollection,
  usersCollection,
  productsCollection,
  categoriesCollection,
  bookingCollection,
  reportCollection,
  paymentCollection,
  blogsCollection,
  carouselCollection,
  settingsCollection,
  reviewsCollection,
  messagesCollection,
  developerEmailsCollection,
  wishlistCollection,
  bugReportsCollection,
  userReportsCollection,
  banAppealsCollection,
}) {
  const router = express.Router();

  // ---- Audit log ------------------------------------------------------------
  //
  // A running record of every sensitive staff action (see logAudit calls
  // throughout the route modules). Root-Admin-only: this is the one place
  // that shows what every Admin/Moderator/Developer has done.
  router.get(
    "/admin/audit-log",
    verifyJWT,
    verifyMainAdmin,
    asyncHandler(async (req, res) => {
      const limit = Math.min(Number(req.query.limit) || 200, 500);
      const result = await auditLogCollection.find({}).sort({ createdAt: -1 }).limit(limit).toArray();
      res.send(result);
    })
  );

  // ---- Database management ---------------------------------------------------
  //
  // Lets the root Admin export, clear, or restore any single collection
  // from the dashboard. Root-Admin only, same sensitivity as Manage
  // Admins/Audit Log. The client re-asks for the Admin's password
  // (Firebase reauthentication) immediately before calling clear/import -
  // a valid buytop-token only proves *a* logged-in Admin session earlier,
  // not that the person at the keyboard right now still knows the
  // password, and these actions are destructive enough to warrant asking
  // again.

  // ---- Per-collection filters for the Database Management page ----------
  //
  // Every row on that page can always Download/Clear its *whole*
  // collection. Some collections also offer a scoped filter so an Admin
  // can Download or Clear just a subset (e.g. only Seller-sent messages,
  // only Deposit payments) instead of everything. Three flavors cover
  // every case below:
  //
  //  - enumFilter: the field only ever holds one of a small fixed set of
  //    values (a role, a payment type, a status) - options and their
  //    counts are just one countDocuments per value.
  //  - distinctFilter: the field's value set isn't fixed in code
  //    (product/booking categories are whatever's currently in the
  //    Categories collection) - options are read live from the
  //    collection itself so a brand-new category shows up here
  //    automatically.
  //  - exprFilter: "which side" isn't its own stored field but derived
  //    by comparing two fields already on the document (a Messages row's
  //    Buyer-sent/Seller-sent split compares senderEmail against
  //    buyerEmail/sellerEmail) - options are given as raw Mongo match
  //    expressions instead of a single field/value pair.
  //
  // Each returns { kind, getOptions(collection), matchFor(value), labelFor(value) }.
  function enumFilter(field, options) {
    const normalized = options.map((o) => (typeof o === "string" ? { value: o, label: o } : o));
    return {
      kind: "enum",
      async getOptions(collection) {
        const counts = await Promise.all(normalized.map((o) => collection.countDocuments({ [field]: o.value })));
        return normalized.map((o, i) => ({ value: o.value, label: o.label, count: counts[i] }));
      },
      matchFor(value) {
        const opt = normalized.find((o) => o.value === value);
        return opt ? { [field]: opt.value } : null;
      },
      labelFor(value) {
        return normalized.find((o) => o.value === value)?.label || value;
      },
    };
  }

  function distinctFilter(field) {
    return {
      kind: "distinct",
      async getOptions(collection) {
        const values = (await collection.distinct(field)).filter((v) => typeof v === "string" && v.trim());
        values.sort((a, b) => a.localeCompare(b));
        const counts = await Promise.all(values.map((v) => collection.countDocuments({ [field]: v })));
        return values.map((v, i) => ({ value: v, label: v, count: counts[i] }));
      },
      matchFor(value) {
        return value ? { [field]: value } : null;
      },
      labelFor(value) {
        return value;
      },
    };
  }

  function exprFilter(options) {
    return {
      kind: "expr",
      async getOptions(collection) {
        const counts = await Promise.all(options.map((o) => collection.countDocuments(o.match)));
        return options.map((o, i) => ({ value: o.value, label: o.label, count: counts[i] }));
      },
      matchFor(value) {
        return options.find((o) => o.value === value)?.match || null;
      },
      labelFor(value) {
        return options.find((o) => o.value === value)?.label || value;
      },
    };
  }

  // "protectAdmins" is only true for users: clearing/restoring that
  // collection always keeps every account with role "Admin" untouched -
  // not just the one running the operation - so this tool can never wipe
  // out every Admin (including ones who aren't currently logged in) and
  // lock everyone out of the very site it's meant to help recover.
  const DB_COLLECTIONS = {
    // "Admin" is deliberately left out here - that role is already
    // always protected (see protectAdmins above), so it never needs its
    // own filter.
    users: {
      collection: usersCollection,
      label: "Users",
      protectAdmins: true,
      filter: enumFilter("role", ["Buyer", "Seller", "Moderator"]),
    },
    products: {
      collection: productsCollection,
      label: "Products",
      filter: distinctFilter("category"),
    },
    categories: { collection: categoriesCollection, label: "Categories" },
    bookings: {
      collection: bookingCollection,
      label: "Bookings",
      filter: distinctFilter("category"),
    },
    // Not filterable: one report per product (unique on productId, see
    // the index above), so there's no meaningful sub-category to scope on.
    reported: { collection: reportCollection, label: "Reported Items" },
    payments: {
      collection: paymentCollection,
      label: "Payments",
      filter: enumFilter("type", [
        { value: "Deposit", label: "Due (Deposit)" },
        { value: "Full", label: "Full" },
      ]),
    },
    // OTPs are intentionally not listed here - they're short-lived by
    // design (see the TTL index on otpCollection) and clear themselves
    // out, so there's nothing for this manual admin tool to usefully
    // manage.
    blogs: {
      collection: blogsCollection,
      label: "Blogs",
      filter: enumFilter("status", [
        { value: "pending", label: "Pending" },
        { value: "approved", label: "Approved" },
      ]),
    },
    // Not filterable: a single homepage carousel list, not a set of
    // records with a meaningful sub-category.
    carousel: { collection: carouselCollection, label: "Carousel" },
    // Not filterable: a single settings document, nothing to scope on.
    settings: { collection: settingsCollection, label: "Site Settings" },
    // Not filterable: reviews aren't grouped by anything an Admin would
    // want to Download/Clear separately (a 1-5 star rating isn't a
    // meaningful management split here).
    reviews: { collection: reviewsCollection, label: "Reviews" },
    messages: {
      collection: messagesCollection,
      label: "Messages",
      filter: exprFilter([
        { value: "Buyer", label: "Sent by Buyer", match: { $expr: { $eq: ["$senderEmail", "$buyerEmail"] } } },
        { value: "Seller", label: "Sent by Seller", match: { $expr: { $eq: ["$senderEmail", "$sellerEmail"] } } },
      ]),
    },
    // Not filterable: a flat allowlist of emails, nothing to scope on.
    developerEmails: { collection: developerEmailsCollection, label: "Developer Emails" },
    // Not filterable: each buyer's own saved-products list, not split
    // into categories worth managing separately here.
    wishlist: { collection: wishlistCollection, label: "Wishlist" },
    bugReports: {
      collection: bugReportsCollection,
      label: "Bug Reports",
      filter: enumFilter("status", ["Open", "In Progress", "Resolved"]),
    },
    // Not filterable: reports filed against a user's account (see
    // routes/user-reports.js) - distinct from the productReports-style
    // `reportCollection`, which is only ever about a listing.
    userReports: { collection: userReportsCollection, label: "User Reports" },
    banAppeals: { collection: banAppealsCollection, label: "Ban Appeals" },
    // Not filterable: this is the audit trail of actions taken on this
    // very page - always kept whole so it stays a reliable record.
    auditLog: { collection: auditLogCollection, label: "Audit Log" },
  };

  // Turns an arbitrary filter value (a role, a category name, a
  // status...) into a safe, readable filename fragment for exported JSON
  // downloads.
  const slugify = (value) =>
    String(value)
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/(^-+|-+$)/g, "") || "filtered";

  // Same shape as authLimiter - these are rare, sensitive,
  // manually-triggered actions, not something that should ever
  // legitimately fire 30+ times in 15 minutes.
  const dbAdminLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 30,
    standardHeaders: true,
    legacyHeaders: false,
  });

  // A collection exported via /export comes back through
  // JSON.stringify, which silently turns every ObjectId into a plain
  // 24-hex string and every Date into an ISO string. Re-importing that
  // as-is would leave "_id" as a string instead of a real ObjectId
  // (breaking every other route that does `new ObjectId(id)` to look a
  // document up) and every date field as a string Mongo can no longer
  // sort/filter as a date. This walks a document back into shape before
  // it's inserted.
  const OBJECT_ID_RE = /^[0-9a-fA-F]{24}$/;
  const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;
  const reviveDocument = (value, key) => {
    if (Array.isArray(value)) return value.map((v) => reviveDocument(v));
    if (value && typeof value === "object") {
      const out = {};
      for (const [k, v] of Object.entries(value)) {
        out[k] = reviveDocument(v, k);
      }
      return out;
    }
    if (typeof value === "string") {
      if (key === "_id" && OBJECT_ID_RE.test(value)) return new ObjectId(value);
      if (ISO_DATE_RE.test(value)) return new Date(value);
    }
    return value;
  };

  // Counts for the Database Management page's collection list.
  router.get(
    "/admin/database/summary",
    verifyJWT,
    verifyMainAdmin,
    asyncHandler(async (req, res) => {
      const summary = await Promise.all(
        Object.entries(DB_COLLECTIONS).map(async ([key, entry]) => {
          const row = { key, label: entry.label, count: await entry.collection.estimatedDocumentCount() };
          // Extra breakdown so a filterable row (Users by role, Messages
          // by Buyer/Seller, Payments by Due/Full, Products/Bookings by
          // category, ...) can offer its dropdown with live counts, all
          // in this same round trip.
          if (entry.filter) {
            row.filterKind = entry.filter.kind;
            row.filterOptions = await entry.filter.getOptions(entry.collection);
          }
          return row;
        })
      );
      res.send(summary);
    })
  );

  // Downloads one collection's full contents as a JSON file - the backup
  // a Clear/Import on that same collection can be restored from later.
  router.get(
    "/admin/database/:key/export",
    verifyJWT,
    verifyMainAdmin,
    asyncHandler(async (req, res) => {
      const entry = DB_COLLECTIONS[req.params.key];
      if (!entry) {
        return res.status(404).send({ message: "Unknown collection" });
      }
      let query = {};
      let filenameKey = req.params.key;
      if (req.query.filter) {
        if (!entry.filter) {
          return res.status(400).send({ message: "This collection can't be filtered" });
        }
        const match = entry.filter.matchFor(req.query.filter);
        if (!match) {
          return res.status(400).send({ message: "Invalid filter value" });
        }
        query = match;
        filenameKey = `${req.params.key}-${slugify(req.query.filter)}`;
      }
      const docs = await entry.collection.find(query).toArray();
      logAudit(req, "database_export", {
        collection: req.params.key,
        filter: req.query.filter || null,
        count: docs.length,
      });
      res.setHeader(
        "Content-Disposition",
        `attachment; filename="buytop-${filenameKey}-${new Date().toISOString().slice(0, 10)}.json"`
      );
      res.setHeader("Content-Type", "application/json");
      res.send(JSON.stringify(docs, null, 2));
    })
  );

  // Wipes every document in one collection. See DB_COLLECTIONS.protectAdmins -
  // clearing "users" always keeps every Admin-role account, not just the
  // one running the operation.
  router.delete(
    "/admin/database/:key",
    dbAdminLimiter,
    verifyJWT,
    verifyMainAdmin,
    asyncHandler(async (req, res) => {
      const entry = DB_COLLECTIONS[req.params.key];
      if (!entry) {
        return res.status(404).send({ message: "Unknown collection" });
      }
      let filter = entry.protectAdmins ? { role: { $ne: "Admin" } } : {};
      let scopeLabel = entry.label;
      if (req.query.filter) {
        if (!entry.filter) {
          return res.status(400).send({ message: "This collection can't be filtered" });
        }
        const match = entry.filter.matchFor(req.query.filter);
        if (!match) {
          return res.status(400).send({ message: "Invalid filter value" });
        }
        // protectAdmins (Users) is combined defensively even though the
        // Users filter's own values (Buyer/Seller/Moderator) can never
        // resolve to "Admin" in the first place - see USER_ROLE_FILTERS.
        filter = entry.protectAdmins ? { $and: [match, { role: { $ne: "Admin" } }] } : match;
        scopeLabel = `${entry.label} — ${entry.filter.labelFor(req.query.filter)}`;
      }
      const result = await entry.collection.deleteMany(filter);
      logAudit(req, "database_cleared", {
        collection: req.params.key,
        filter: req.query.filter || null,
        deletedCount: result.deletedCount,
      });
      res.send({
        message: entry.protectAdmins
          ? `Cleared ${scopeLabel}${
              !req.query.filter ? " (kept every Admin account so no one gets locked out)" : ""
            }`
          : `Cleared ${scopeLabel}`,
        deletedCount: result.deletedCount,
      });
    })
  );

  // Restores a collection from a previously-exported JSON file: clears
  // the collection, then inserts every document from the upload. Expects
  // the exact shape /export produces: { documents: [...] }.
  router.post(
    "/admin/database/:key/import",
    dbAdminLimiter,
    verifyJWT,
    verifyMainAdmin,
    asyncHandler(async (req, res) => {
      const entry = DB_COLLECTIONS[req.params.key];
      if (!entry) {
        return res.status(404).send({ message: "Unknown collection" });
      }
      const documents = req.body?.documents;
      if (!Array.isArray(documents)) {
        return res.status(400).send({
          message: "Expected { documents: [...] } - upload a JSON file exported from this same page",
        });
      }

      const revived = documents.map((doc) => reviveDocument(doc));
      // Same protection as Clear: no Admin account is ever touched by
      // this tool. That means skipping any Admin-role row in the
      // uploaded file (so importing an old/foreign backup can't
      // silently overwrite or introduce an Admin account) as well as
      // never deleting an existing one below.
      const toInsert = entry.protectAdmins ? revived.filter((doc) => doc?.role !== "Admin") : revived;
      const skippedAdmins = entry.protectAdmins ? revived.length - toInsert.length : 0;

      const clearFilter = entry.protectAdmins ? { role: { $ne: "Admin" } } : {};
      await entry.collection.deleteMany(clearFilter);

      let insertedCount = 0;
      if (toInsert.length > 0) {
        // ordered:false so one bad/duplicate row in a big backup doesn't
        // abort the whole restore - everything insertable still gets in.
        const result = await entry.collection.insertMany(toInsert, { ordered: false }).catch((err) => {
          if (err?.result?.insertedCount != null) return err.result;
          throw err;
        });
        insertedCount = result.insertedCount ?? 0;
      }

      logAudit(req, "database_imported", {
        collection: req.params.key,
        uploadedCount: documents.length,
        insertedCount,
        skippedAdmins,
      });
      res.send({
        message: entry.protectAdmins
          ? `Restored ${entry.label}: ${insertedCount} of ${documents.length} document(s) inserted (every Admin account was left untouched${
              skippedAdmins ? `, ${skippedAdmins} Admin row(s) in the file were skipped` : ""
            })`
          : `Restored ${entry.label}: ${insertedCount} of ${documents.length} document(s) inserted`,
        insertedCount,
      });
    })
  );

  // ---- Individual document browsing & editing --------------------------
  //
  // Paginated, optionally filtered list of raw documents in a collection -
  // the "browse" side of a document editor. Reuses the exact same filter
  // registry as export/clear above, so a filter option that exists there
  // works here too with no extra wiring per collection.
  router.get(
    "/admin/database/:key/documents",
    verifyJWT,
    verifyMainAdmin,
    asyncHandler(async (req, res) => {
      const entry = DB_COLLECTIONS[req.params.key];
      if (!entry) {
        return res.status(404).send({ message: "Unknown collection" });
      }
      let query = {};
      if (req.query.filter) {
        if (!entry.filter) {
          return res.status(400).send({ message: "This collection can't be filtered" });
        }
        const match = entry.filter.matchFor(req.query.filter);
        if (!match) {
          return res.status(400).send({ message: "Invalid filter value" });
        }
        query = match;
      }
      const page = Math.max(1, Number(req.query.page) || 1);
      const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 25));
      const [documents, total] = await Promise.all([
        entry.collection
          .find(query)
          .sort({ _id: -1 })
          .skip((page - 1) * limit)
          .limit(limit)
          .toArray(),
        entry.collection.countDocuments(query),
      ]);
      res.send({ documents, total, page, limit, totalPages: Math.max(1, Math.ceil(total / limit)) });
    })
  );

  router.get(
    "/admin/database/:key/documents/:id",
    verifyJWT,
    verifyMainAdmin,
    asyncHandler(async (req, res) => {
      const entry = DB_COLLECTIONS[req.params.key];
      if (!entry) {
        return res.status(404).send({ message: "Unknown collection" });
      }
      if (!ObjectId.isValid(req.params.id)) {
        return res.status(400).send({ message: "Invalid document id" });
      }
      const doc = await entry.collection.findOne({ _id: new ObjectId(req.params.id) });
      if (!doc) {
        return res.status(404).send({ message: "Document not found" });
      }
      res.send(doc);
    })
  );

  // Edits one document's fields directly. `_id` can never be part of the
  // edit (it's the document's identity, not a field), and - same
  // protectAdmins invariant as Clear/Import above - the root Admin's own
  // account can't be touched here at all, and no document can have its
  // role field set to "Admin" through this generic tool: that's only
  // ever allowed to happen through the atomic /users/transfer-admin flow,
  // which demotes the outgoing Admin in the same operation so there's
  // never a moment with zero or two Admins.
  router.patch(
    "/admin/database/:key/documents/:id",
    dbAdminLimiter,
    verifyJWT,
    verifyMainAdmin,
    asyncHandler(async (req, res) => {
      const entry = DB_COLLECTIONS[req.params.key];
      if (!entry) {
        return res.status(404).send({ message: "Unknown collection" });
      }
      if (!ObjectId.isValid(req.params.id)) {
        return res.status(400).send({ message: "Invalid document id" });
      }
      const fields = req.body?.fields;
      if (!fields || typeof fields !== "object" || Array.isArray(fields) || Object.keys(fields).length === 0) {
        return res.status(400).send({ message: "Expected { fields: { ... } } with at least one field to update" });
      }
      if ("_id" in fields) {
        return res.status(400).send({ message: "_id can't be edited" });
      }
      const existing = await entry.collection.findOne({ _id: new ObjectId(req.params.id) });
      if (!existing) {
        return res.status(404).send({ message: "Document not found" });
      }
      if (entry.protectAdmins && existing.role === "Admin") {
        return res.status(403).send({ message: "The root Admin account can't be edited from this tool." });
      }
      if (entry.protectAdmins && fields.role === "Admin") {
        return res.status(400).send({
          message: "Use Transfer Admin to hand off the root Admin role - it can't be set here.",
        });
      }
      // Same string -> ObjectId/Date revival as Import, so a value typed
      // into an edit form (which arrives as a plain string) lands in the
      // right type instead of turning a date field into a literal string.
      const revived = reviveDocument(fields);
      const result = await entry.collection.updateOne(
        { _id: new ObjectId(req.params.id) },
        { $set: revived }
      );
      logAudit(req, "database_document_edited", {
        collection: req.params.key,
        documentId: req.params.id,
        fields: Object.keys(fields),
      });
      res.send(result);
    })
  );

  // ---- Bulk field update -------------------------------------------------
  //
  // Sets one or more fields to a fixed value across every document
  // matching a filter (or the whole collection, if no filter is given) -
  // e.g. "set status=Available for every Advertised product" in one call
  // instead of editing each listing individually. Same filter registry,
  // same protectAdmins guard, same audit trail as everything else on this
  // page.
  router.patch(
    "/admin/database/:key/bulk-update",
    dbAdminLimiter,
    verifyJWT,
    verifyMainAdmin,
    asyncHandler(async (req, res) => {
      const entry = DB_COLLECTIONS[req.params.key];
      if (!entry) {
        return res.status(404).send({ message: "Unknown collection" });
      }
      const fields = req.body?.fields;
      if (!fields || typeof fields !== "object" || Array.isArray(fields) || Object.keys(fields).length === 0) {
        return res.status(400).send({ message: "Expected { fields: { ... } } with at least one field to update" });
      }
      if ("_id" in fields) {
        return res.status(400).send({ message: "_id can't be edited" });
      }
      if (entry.protectAdmins && fields.role === "Admin") {
        return res.status(400).send({
          message: "Use Transfer Admin to hand off the root Admin role - it can't be set here.",
        });
      }
      let filter = entry.protectAdmins ? { role: { $ne: "Admin" } } : {};
      let scopeLabel = entry.label;
      if (req.query.filter) {
        if (!entry.filter) {
          return res.status(400).send({ message: "This collection can't be filtered" });
        }
        const match = entry.filter.matchFor(req.query.filter);
        if (!match) {
          return res.status(400).send({ message: "Invalid filter value" });
        }
        filter = entry.protectAdmins ? { $and: [match, { role: { $ne: "Admin" } }] } : match;
        scopeLabel = `${entry.label} — ${entry.filter.labelFor(req.query.filter)}`;
      }
      const revived = reviveDocument(fields);
      const result = await entry.collection.updateMany(filter, { $set: revived });
      logAudit(req, "database_bulk_updated", {
        collection: req.params.key,
        filter: req.query.filter || null,
        fields: Object.keys(fields),
        matchedCount: result.matchedCount,
        modifiedCount: result.modifiedCount,
      });
      res.send({
        message: entry.protectAdmins
          ? `Updated ${result.modifiedCount} of ${result.matchedCount} matching document(s) in ${scopeLabel} (every Admin account was left untouched)`
          : `Updated ${result.modifiedCount} of ${result.matchedCount} matching document(s) in ${scopeLabel}`,
        matchedCount: result.matchedCount,
        modifiedCount: result.modifiedCount,
      });
    })
  );

  return router;
}

module.exports = createDatabaseAdminRoutes;
