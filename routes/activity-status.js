const express = require("express");

// "Active now" presence, in the same spirit as Facebook/Messenger's
// Active Status: a lightweight heartbeat while the app is open keeps
// `lastActiveAt` fresh, and a user can turn the whole thing off (either
// indefinitely or for a set number of hours via `hiddenForMinutes`) from
// Settings > Privacy. Turning it off is reciprocal - see isActiveTo in
// utils.js - so opting out also stops showing you everyone else's status.
function createActivityStatusRoutes({
  usersCollection,
  verifyJWT,
  verifySelf,
  asyncHandler,
  isActivityVisible,
  jwt,
}) {
  const router = express.Router();

  // Called every ~20s by useActivityHeartbeat while a signed-in user has
  // the app open, focused, and isn't idle. Deliberately not behind
  // mutationLimiter - it fires often by design, and generalLimiter
  // (300/15min, applied to every route) is already generous enough to
  // catch real abuse.
  router.patch(
    "/users/:email/heartbeat",
    verifyJWT,
    verifySelf,
    asyncHandler(async (req, res) => {
      const user = await usersCollection.findOne(
        { email: req.params.email },
        { projection: { activityStatus: 1 } }
      );
      const update = { lastActiveAt: new Date() };
      // A timed "off for N hours" that has since expired flips back on
      // the next time this account is seen active - same as it would
      // read as back-on to everyone else already (see isActiveTo), this
      // just makes the stored flag match so Settings shows it correctly.
      const status = user?.activityStatus;
      if (status?.visible === false && status.hiddenUntil && new Date(status.hiddenUntil) <= new Date()) {
        update.activityStatus = { visible: true, hiddenUntil: null };
      }
      await usersCollection.updateOne({ email: req.params.email }, { $set: update });
      res.send({ ok: true });
    })
  );

  // Current state for the Settings > Privacy toggle.
  router.get(
    "/users/:email/activity-status",
    verifyJWT,
    verifySelf,
    asyncHandler(async (req, res) => {
      const user = await usersCollection.findOne({ email: req.params.email });
      const status = user?.activityStatus;
      const expired = status?.hiddenUntil && new Date(status.hiddenUntil) <= new Date();
      res.send({
        visible: isActivityVisible(user),
        hiddenUntil: expired ? null : status?.hiddenUntil || null,
      });
    })
  );

  // Turning it on/off, optionally with a timer. Body:
  //   { visible: true }                     - back on immediately
  //   { visible: false }                    - off until turned back on
  //   { visible: false, hiddenForMinutes }   - off for that long, then auto-on
  router.patch(
    "/users/:email/activity-status",
    verifyJWT,
    verifySelf,
    asyncHandler(async (req, res) => {
      const visible = req.body?.visible !== false;
      let hiddenUntil = null;
      if (!visible) {
        const minutes = Number(req.body?.hiddenForMinutes);
        if (Number.isFinite(minutes) && minutes > 0) {
          hiddenUntil = new Date(Date.now() + minutes * 60 * 1000);
        }
      }
      await usersCollection.updateOne(
        { email: req.params.email },
        { $set: { activityStatus: { visible, hiddenUntil } } }
      );
      res.send({ visible, hiddenUntil });
    })
  );

  // Ends the active window early - called from two places (see
  // useActivityHeartbeat): the idle timer (2 min with no real
  // interaction), as a normal authenticated fetch, and tab
  // close/navigate-away, via navigator.sendBeacon. A beacon can't attach
  // an Authorization header, so unlike every other route here this one
  // isn't behind verifyJWT/verifySelf - it takes the token from the
  // header when present (idle case) and falls back to the request body
  // (beacon case), verifying it by hand either way. Still just as safe:
  // the signature check is the same one verifyJWT does, we've just moved
  // where the token is allowed to come from.
  router.post(
    "/users/:email/go-offline",
    asyncHandler(async (req, res) => {
      const headerToken = req.headers.authorization?.split(" ")[1];
      const bodyToken = typeof req.body === "object" ? req.body?.token : undefined;
      const token = headerToken || bodyToken;
      if (!token) {
        return res.status(401).send({ message: "Unauthorized Access" });
      }
      let decoded;
      try {
        decoded = jwt.verify(token, process.env.ACCESS_TOKEN);
      } catch (err) {
        return res.status(403).send({ message: "forbidden access" });
      }
      if (decoded.email !== req.params.email) {
        return res.status(403).send({ message: "forbidden access" });
      }
      await usersCollection.updateOne(
        { email: req.params.email },
        { $set: { wentOfflineAt: new Date() } }
      );
      res.send({ ok: true });
    })
  );

  return router;
}

module.exports = createActivityStatusRoutes;
