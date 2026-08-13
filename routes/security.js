const express = require("express");
const crypto = require("crypto");
const speakeasy = require("speakeasy");
const qrcode = require("qrcode");

// A very small user-agent parser - good enough to show "Chrome on
// Windows" in a login-activity list without pulling in a whole UA
// parsing library for what's ultimately a cosmetic detail.
const describeUserAgent = (ua = "") => {
  const browser = /Edg\//.test(ua)
    ? "Edge"
    : /Chrome\//.test(ua)
    ? "Chrome"
    : /Firefox\//.test(ua)
    ? "Firefox"
    : /Safari\//.test(ua) && !/Chrome/.test(ua)
    ? "Safari"
    : "Unknown browser";
  const os = /Windows/.test(ua)
    ? "Windows"
    : /Android/.test(ua)
    ? "Android"
    : /iPhone|iPad|iOS/.test(ua)
    ? "iOS"
    : /Mac OS X/.test(ua)
    ? "macOS"
    : /Linux/.test(ua)
    ? "Linux"
    : "Unknown OS";
  return `${browser} on ${os}`;
};

const hashCode = (code) => crypto.createHash("sha256").update(code).digest("hex");

function createSecurityRoutes({
  jwt,
  mutationLimiter,
  authLimiter,
  verifyJWT,
  verifySelf,
  asyncHandler,
  usersCollection,
  loginActivityCollection,
  logLoginActivity,
}) {
  const router = express.Router();

  router.get(
    "/security/login-activity/:email",
    verifyJWT,
    verifySelf,
    asyncHandler(async (req, res) => {
      const activity = await loginActivityCollection
        .find({ email: req.params.email })
        .sort({ createdAt: -1 })
        .limit(20)
        .toArray();
      res.send(activity);
    })
  );

  router.get(
    "/2fa/status",
    verifyJWT,
    asyncHandler(async (req, res) => {
      const user = await usersCollection.findOne({ email: req.decoded.email });
      res.send({ enabled: user?.twoFactor?.enabled === true });
    })
  );

  // Step 1 of enabling 2FA: generate a secret, store it as *pending*
  // (not yet trusted) until the user proves they've actually scanned it
  // by submitting a real code in /2fa/enable below.
  router.post(
    "/2fa/setup",
    mutationLimiter,
    verifyJWT,
    asyncHandler(async (req, res) => {
      const secret = speakeasy.generateSecret({
        name: `BuyTop (${req.decoded.email})`,
        length: 20,
      });
      await usersCollection.updateOne(
        { email: req.decoded.email },
        { $set: { "twoFactor.pendingSecret": secret.base32 } }
      );
      const qrDataUrl = await qrcode.toDataURL(secret.otpauth_url);
      res.send({ secret: secret.base32, qrDataUrl });
    })
  );

  // Step 2: confirm the user actually scanned it and their authenticator
  // app produces matching codes, before 2FA starts being enforced on
  // login. Also mints one-time backup codes, shown to the user exactly
  // once here - only their salted hashes are ever stored.
  router.post(
    "/2fa/enable",
    mutationLimiter,
    verifyJWT,
    asyncHandler(async (req, res) => {
      const { code } = req.body || {};
      const user = await usersCollection.findOne({ email: req.decoded.email });
      const pendingSecret = user?.twoFactor?.pendingSecret;
      if (!pendingSecret) {
        return res.status(400).send({ message: "Start setup first with /2fa/setup" });
      }
      const verified = speakeasy.totp.verify({
        secret: pendingSecret,
        encoding: "base32",
        token: String(code || ""),
        window: 1,
      });
      if (!verified) {
        return res.status(400).send({ message: "That code didn't match - check the app and try again." });
      }
      const backupCodes = Array.from({ length: 8 }, () =>
        crypto.randomBytes(5).toString("hex")
      );
      await usersCollection.updateOne(
        { email: req.decoded.email },
        {
          $set: {
            "twoFactor.enabled": true,
            "twoFactor.secret": pendingSecret,
            "twoFactor.backupCodeHashes": backupCodes.map(hashCode),
            "twoFactor.enabledAt": new Date(),
          },
          $unset: { "twoFactor.pendingSecret": "" },
        }
      );
      res.send({ enabled: true, backupCodes });
    })
  );

  router.post(
    "/2fa/disable",
    mutationLimiter,
    verifyJWT,
    asyncHandler(async (req, res) => {
      const { code } = req.body || {};
      const user = await usersCollection.findOne({ email: req.decoded.email });
      if (!user?.twoFactor?.enabled) {
        return res.status(400).send({ message: "2FA isn't enabled on this account." });
      }
      const verified = speakeasy.totp.verify({
        secret: user.twoFactor.secret,
        encoding: "base32",
        token: String(code || ""),
        window: 1,
      });
      const usedBackupHash = (user.twoFactor.backupCodeHashes || []).includes(hashCode(String(code || "")));
      if (!verified && !usedBackupHash) {
        return res.status(400).send({ message: "That code didn't match." });
      }
      await usersCollection.updateOne({ email: req.decoded.email }, { $unset: { twoFactor: "" } });
      res.send({ enabled: false });
    })
  );

  // The other half of the /user/:email login flow: when that route sees
  // twoFactor.enabled, it withholds the real access token and hands back
  // a short-lived challenge token instead. This exchanges a valid
  // authenticator code (or one-time backup code) for the real thing.
  router.post(
    "/2fa/verify-login",
    authLimiter,
    asyncHandler(async (req, res) => {
      const { challengeToken, code } = req.body || {};
      if (!challengeToken || !code) {
        return res.status(400).send({ message: "challengeToken and code are required" });
      }
      let decoded;
      try {
        decoded = jwt.verify(challengeToken, process.env.ACCESS_TOKEN);
      } catch (err) {
        return res.status(403).send({ message: "This login attempt has expired - please sign in again." });
      }
      if (decoded.purpose !== "2fa-challenge") {
        return res.status(403).send({ message: "Invalid challenge token" });
      }
      const email = decoded.email;
      const user = await usersCollection.findOne({ email });
      if (!user?.twoFactor?.enabled) {
        return res.status(400).send({ message: "2FA isn't enabled on this account." });
      }
      const verified = speakeasy.totp.verify({
        secret: user.twoFactor.secret,
        encoding: "base32",
        token: String(code),
        window: 1,
      });
      const codeHash = hashCode(String(code));
      const backupHashes = user.twoFactor.backupCodeHashes || [];
      const usedBackupIndex = backupHashes.indexOf(codeHash);

      if (!verified && usedBackupIndex === -1) {
        return res.status(401).send({ message: "Invalid code" });
      }
      // A backup code is single-use - remove it the moment it's spent so
      // it can't be replayed.
      if (usedBackupIndex !== -1) {
        const remaining = backupHashes.filter((_, i) => i !== usedBackupIndex);
        await usersCollection.updateOne(
          { email },
          { $set: { "twoFactor.backupCodeHashes": remaining } }
        );
      }
      const token = jwt.sign({ email }, process.env.ACCESS_TOKEN, { expiresIn: "7d" });
      await logLoginActivity({ email, req, method: usedBackupIndex !== -1 ? "backup-code" : "totp" });
      res.send({ token });
    })
  );

  return router;
}

module.exports = { createSecurityRoutes, describeUserAgent };
