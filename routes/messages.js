const express = require("express");

// A conversation is identified by productId + buyerEmail (the seller is
// whoever owns that product), so a buyer gets one running thread per
// listing they've messaged about, and a seller sees each buyer separately.
function createMessageRoutes({
  mutationLimiter,
  verifyJWT,
  verifySelf,
  asyncHandler,
  productsCollection,
  usersCollection,
  messagesCollection,
  hiddenConversationsCollection,
  conversationMetaCollection,
  conversationId,
  isActiveTo,
  ObjectId,
  sendEmail,
  createNotification,
  CLIENT_URL,
}) {
  const router = express.Router();

  router.post(
    "/messages",
    mutationLimiter,
    verifyJWT,
    asyncHandler(async (req, res) => {
      const { productId, text } = req.body || {};
      if (!productId || !ObjectId.isValid(productId)) {
        return res.status(400).send({ message: "Invalid product id" });
      }
      const trimmed = typeof text === "string" ? text.trim().slice(0, 2000) : "";
      if (!trimmed) {
        return res.status(400).send({ message: "Message can't be empty" });
      }
      const product = await productsCollection.findOne({ _id: new ObjectId(productId) });
      if (!product) {
        return res.status(404).send({ message: "Product not found" });
      }
      const sellerEmail = product.email;
      const sender = req.decoded.email;
      // The buyer side of a conversation is always explicit - the seller
      // sends `buyerEmail` (they're picking a thread from their inbox), a
      // buyer just messaging in for the first time is implicitly themself.
      const buyerEmail = sender === sellerEmail ? req.body?.buyerEmail : sender;
      if (!buyerEmail) {
        return res.status(400).send({ message: "buyerEmail is required" });
      }
      if (sender !== sellerEmail && sender !== buyerEmail) {
        return res.status(403).send({ message: "forbidden access" });
      }
      if (sellerEmail === buyerEmail) {
        return res.status(400).send({ message: "A seller can't message themselves" });
      }
      const message = {
        conversationId: conversationId(productId, buyerEmail),
        productId,
        sellerEmail,
        buyerEmail,
        senderEmail: sender,
        text: trimmed,
        createdAt: new Date(),
      };
      const result = await messagesCollection.insertOne(message);
      // New activity should bring the thread back for anyone who'd deleted
      // it - a fresh message from either side un-hides it for both.
      await hiddenConversationsCollection.deleteMany({
        conversationId: message.conversationId,
      });
      const recipient = sender === sellerEmail ? buyerEmail : sellerEmail;
      const conversationLink = `/messages/${productId}/${encodeURIComponent(buyerEmail)}`;
      await createNotification({
        email: recipient,
        type: "message",
        title: "New message",
        body: `${sender} sent you a message about "${product.productName}"`,
        link: conversationLink,
      });
      await sendEmail({
        to: recipient,
        subject: `New message about ${product.productName}`,
        heading: "You've got a new message",
        body: `${sender} sent you a message about "${product.productName}": "${trimmed.slice(0, 140)}${trimmed.length > 140 ? "…" : ""}"`,
        ctaText: "Reply",
        ctaUrl: `${CLIENT_URL}${conversationLink}`,
      });
      res.send({ ...result, message });
    })
  );

  // A participant deleting a conversation from their own inbox. This
  // hides it for them only (the other person's inbox is untouched) - same
  // "delete for me" behavior as the individual message delete below, not
  // a hard delete of the underlying messages. If either side sends a new
  // message afterward, the thread reappears (see the un-hide in
  // POST /messages).
  router.delete(
    "/conversations/:productId/:buyerEmail",
    verifyJWT,
    asyncHandler(async (req, res) => {
      const { productId, buyerEmail } = req.params;
      if (!ObjectId.isValid(productId)) {
        return res.status(400).send({ message: "Invalid product id" });
      }
      // Authorize off the conversation's own thread, not the product - a
      // listing can be sold/removed long after the conversation about it
      // happened, and the thread (and the ability to clear it from your
      // inbox) should outlive the product. Same reasoning already applied
      // to GET /conversations/:email's "Listing no longer available"
      // fallback; this just brings delete in line with it.
      const anyMessage = await messagesCollection.findOne({
        conversationId: conversationId(productId, buyerEmail),
      });
      if (!anyMessage) {
        return res.status(404).send({ message: "Conversation not found" });
      }
      if (req.decoded.email !== anyMessage.sellerEmail && req.decoded.email !== anyMessage.buyerEmail) {
        return res.status(403).send({ message: "forbidden access" });
      }
      await hiddenConversationsCollection.updateOne(
        { email: req.decoded.email, conversationId: conversationId(productId, buyerEmail) },
        { $set: { hiddenAt: new Date() } },
        { upsert: true }
      );
      res.send({ message: "Conversation removed" });
    })
  );

  // A sender can delete their own message - soft delete (keep the row,
  // clear the text, flag it) rather than a hard delete, so the thread on
  // the other person's screen doesn't just have a silent gap where a
  // message used to be; it shows "This message was deleted" instead, same
  // idea as most chat apps.
  router.delete(
    "/messages/:id",
    verifyJWT,
    asyncHandler(async (req, res) => {
      if (!ObjectId.isValid(req.params.id)) {
        return res.status(400).send({ message: "Invalid message id" });
      }
      const message = await messagesCollection.findOne({ _id: new ObjectId(req.params.id) });
      if (!message) {
        return res.status(404).send({ message: "Message not found" });
      }
      if (message.senderEmail !== req.decoded.email) {
        return res.status(403).send({ message: "You can only delete your own messages" });
      }
      if (message.deleted) {
        return res.status(400).send({ message: "This message is already deleted" });
      }
      await messagesCollection.updateOne(
        { _id: message._id },
        { $set: { deleted: true, deletedAt: new Date(), text: "" } }
      );
      res.send({ message: "Message deleted" });
    })
  );

  // The message thread for one product+buyer pair. Only the two people in
  // it (that buyer, or the product's seller) can read it.
  router.get(
    "/messages/:productId/:buyerEmail",
    verifyJWT,
    asyncHandler(async (req, res) => {
      const { productId, buyerEmail } = req.params;
      if (!ObjectId.isValid(productId)) {
        return res.status(400).send({ message: "Invalid product id" });
      }
      const product = await productsCollection.findOne({ _id: new ObjectId(productId) });
      if (!product) {
        return res.status(404).send({ message: "Product not found" });
      }
      const sellerEmail = product.email;
      if (req.decoded.email !== sellerEmail && req.decoded.email !== buyerEmail) {
        return res.status(403).send({ message: "forbidden access" });
      }
      const messages = await messagesCollection
        .find({ conversationId: conversationId(productId, buyerEmail) })
        .sort({ createdAt: 1 })
        .toArray();
      // Opening a thread reads it - clears its unread badge for this
      // user. Fire-and-forget: shouldn't block or fail the actual message
      // fetch.
      conversationMetaCollection
        .updateOne(
          { email: req.decoded.email, conversationId: conversationId(productId, buyerEmail) },
          { $set: { lastReadAt: new Date() } },
          { upsert: true }
        )
        .catch((err) => console.error("mark-read failed:", err.message));
      const otherEmail = req.decoded.email === sellerEmail ? buyerEmail : sellerEmail;
      const [otherUser, viewerUser] = await Promise.all([
        usersCollection.findOne({ email: otherEmail }),
        usersCollection.findOne({ email: req.decoded.email }),
      ]);
      res.send({
        messages,
        product: {
          _id: product._id,
          productName: product.productName,
          productPhoto: product.productPhoto || product.images?.[0] || "",
          status: product.status,
        },
        otherUser: otherUser
          ? {
              email: otherUser.email,
              name: otherUser.name,
              photo: otherUser.photo,
              active: isActiveTo(otherUser, viewerUser),
            }
          : { email: otherEmail, name: otherEmail, photo: "", active: false },
      });
    })
  );

  // Inbox: every conversation this user is part of (as buyer or seller),
  // newest activity first, with the last message and the other person's
  // info attached so the list can render without N follow-up requests.
  router.get(
    "/conversations/:email",
    verifyJWT,
    verifySelf,
    asyncHandler(async (req, res) => {
      const email = req.params.email;
      const hidden = await hiddenConversationsCollection.find({ email }).toArray();
      const hiddenIds = hidden.map((h) => h.conversationId);
      const threads = await messagesCollection
        .aggregate([
          {
            $match: {
              $or: [{ buyerEmail: email }, { sellerEmail: email }],
              conversationId: { $nin: hiddenIds },
            },
          },
          { $sort: { createdAt: -1 } },
          {
            $group: {
              _id: "$conversationId",
              productId: { $first: "$productId" },
              buyerEmail: { $first: "$buyerEmail" },
              sellerEmail: { $first: "$sellerEmail" },
              lastText: { $first: "$text" },
              lastDeleted: { $first: "$deleted" },
              lastSender: { $first: "$senderEmail" },
              lastAt: { $first: "$createdAt" },
            },
          },
          { $sort: { lastAt: -1 } },
        ])
        .toArray();

      const metas = await conversationMetaCollection.find({ email }).toArray();
      const metaByConv = new Map(metas.map((m) => [m.conversationId, m]));
      // Fetched once and reused for every thread below (rather than a
      // per-thread lookup) since it's the same viewer for the whole list -
      // needed for the reciprocal half of isActiveTo (see utils.js).
      const viewerUser = await usersCollection.findOne({ email });

      const results = await Promise.all(
        threads.map(async (t) => {
          const otherEmail = t.buyerEmail === email ? t.sellerEmail : t.buyerEmail;
          const [product, otherUser] = await Promise.all([
            ObjectId.isValid(t.productId)
              ? productsCollection.findOne({ _id: new ObjectId(t.productId) })
              : null,
            usersCollection.findOne({ email: otherEmail }),
          ]);
          const meta = metaByConv.get(t._id);
          const lastIsMine = t.lastSender === email;
          const unread = !lastIsMine && (!meta?.lastReadAt || new Date(t.lastAt) > new Date(meta.lastReadAt));
          return {
            productId: t.productId,
            buyerEmail: t.buyerEmail,
            otherEmail,
            otherName: otherUser?.name || otherEmail,
            otherPhoto: otherUser?.photo || "",
            otherActive: isActiveTo(otherUser, viewerUser),
            productName: product?.productName || "Listing no longer available",
            productPhoto: product?.productPhoto || product?.images?.[0] || "",
            lastText: t.lastText,
            lastDeleted: !!t.lastDeleted,
            lastIsMine,
            lastAt: t.lastAt,
            unread: !!unread,
            spam: !!meta?.spam,
          };
        })
      );
      res.send(results);
    })
  );

  // How many of this user's conversations have activity they haven't seen
  // yet - powers the badge on the Messages nav icon. A thread counts as
  // unread when the newest message wasn't sent by this user and either
  // they've never opened it or a new message has landed since they last
  // did.
  router.get(
    "/conversations/:email/unread-count",
    verifyJWT,
    verifySelf,
    asyncHandler(async (req, res) => {
      const email = req.params.email;
      const hidden = await hiddenConversationsCollection.find({ email }).toArray();
      const hiddenIds = hidden.map((h) => h.conversationId);
      const threads = await messagesCollection
        .aggregate([
          {
            $match: {
              $or: [{ buyerEmail: email }, { sellerEmail: email }],
              conversationId: { $nin: hiddenIds },
            },
          },
          { $sort: { createdAt: -1 } },
          {
            $group: {
              _id: "$conversationId",
              lastSender: { $first: "$senderEmail" },
              lastAt: { $first: "$createdAt" },
            },
          },
        ])
        .toArray();
      const metas = await conversationMetaCollection.find({ email }).toArray();
      const metaByConv = new Map(metas.map((m) => [m.conversationId, m]));
      const count = threads.filter((t) => {
        if (t.lastSender === email) return false; // last word was mine
        const meta = metaByConv.get(t._id);
        if (meta?.spam) return false;
        if (!meta?.lastReadAt) return true;
        return new Date(t.lastAt) > new Date(meta.lastReadAt);
      }).length;
      res.send({ count });
    })
  );

  // Mark a conversation as read (or unread again) for the current user.
  // Setting lastReadAt to now clears the unread badge for this thread;
  // passing { read: false } clears lastReadAt so it counts as unread
  // again, mirroring the "mark as unread" affordance in most inboxes.
  router.patch(
    "/conversations/:productId/:buyerEmail/read",
    verifyJWT,
    asyncHandler(async (req, res) => {
      const { productId, buyerEmail } = req.params;
      const email = req.decoded.email;
      const convId = conversationId(productId, buyerEmail);
      const anyMessage = await messagesCollection.findOne({ conversationId: convId });
      if (!anyMessage) {
        return res.status(404).send({ message: "Conversation not found" });
      }
      if (email !== anyMessage.sellerEmail && email !== anyMessage.buyerEmail) {
        return res.status(403).send({ message: "forbidden access" });
      }
      const markUnread = req.body?.read === false;
      await conversationMetaCollection.updateOne(
        { email, conversationId: convId },
        { $set: { lastReadAt: markUnread ? null : new Date() } },
        { upsert: true }
      );
      res.send({ read: !markUnread });
    })
  );

  // Flag/unflag a conversation as spam, for this user's inbox only.
  // Purely a client-side-visible label (like "delete for me") - it
  // doesn't affect the other participant's copy of the thread.
  router.patch(
    "/conversations/:productId/:buyerEmail/spam",
    verifyJWT,
    asyncHandler(async (req, res) => {
      const { productId, buyerEmail } = req.params;
      const email = req.decoded.email;
      const convId = conversationId(productId, buyerEmail);
      const anyMessage = await messagesCollection.findOne({ conversationId: convId });
      if (!anyMessage) {
        return res.status(404).send({ message: "Conversation not found" });
      }
      if (email !== anyMessage.sellerEmail && email !== anyMessage.buyerEmail) {
        return res.status(403).send({ message: "forbidden access" });
      }
      const spam = req.body?.spam !== false;
      await conversationMetaCollection.updateOne(
        { email, conversationId: convId },
        { $set: { spam } },
        { upsert: true }
      );
      res.send({ spam });
    })
  );

  return router;
}

module.exports = createMessageRoutes;
