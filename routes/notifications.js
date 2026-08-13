const express = require("express");

// Feeds the bell icon: bookings, wishlist saves, and reviews someone else
// triggered on this user's stuff. See createNotification() in index.js for
// how entries get created.
function createNotificationRoutes({
  verifyJWT,
  verifySelf,
  asyncHandler,
  notificationsCollection,
  ObjectId,
}) {
  const router = express.Router();

  router.get(
    "/notifications/:email",
    verifyJWT,
    verifySelf,
    asyncHandler(async (req, res) => {
      const notifications = await notificationsCollection
        .find({ email: req.params.email })
        .sort({ createdAt: -1 })
        .limit(50)
        .toArray();
      res.send(notifications);
    })
  );

  router.get(
    "/notifications/:email/unread-count",
    verifyJWT,
    verifySelf,
    asyncHandler(async (req, res) => {
      const count = await notificationsCollection.countDocuments({
        email: req.params.email,
        read: false,
      });
      res.send({ count });
    })
  );

  router.patch(
    "/notifications/:id/read",
    verifyJWT,
    asyncHandler(async (req, res) => {
      if (!ObjectId.isValid(req.params.id)) {
        return res.status(400).send({ message: "Invalid notification id" });
      }
      const notification = await notificationsCollection.findOne({ _id: new ObjectId(req.params.id) });
      if (!notification) {
        return res.status(404).send({ message: "Notification not found" });
      }
      if (notification.email !== req.decoded.email) {
        return res.status(403).send({ message: "forbidden access" });
      }
      await notificationsCollection.updateOne(
        { _id: notification._id },
        { $set: { read: true } }
      );
      res.send({ read: true });
    })
  );

  router.patch(
    "/notifications/:email/read-all",
    verifyJWT,
    verifySelf,
    asyncHandler(async (req, res) => {
      await notificationsCollection.updateMany(
        { email: req.params.email, read: false },
        { $set: { read: true } }
      );
      res.send({ message: "All notifications marked as read" });
    })
  );

  return router;
}

module.exports = createNotificationRoutes;
