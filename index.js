const express = require("express");
const cors = require("cors");
require("dotenv").config();
const Sentry = require("@sentry/node");
const { sendEmail } = require("./mailer");

// Error monitoring is opt-in: without a SENTRY_DSN, Sentry.init is simply
// never called and every Sentry.* call below becomes a documented no-op
// (that's how the SDK is designed to behave when uninitialized) - so
// there's no behavior difference for anyone who hasn't set this up yet.
// Get a free DSN at https://sentry.io (Node/Express project) and set
// SENTRY_DSN in .env to turn this on.
if (process.env.SENTRY_DSN) {
  Sentry.init({
    dsn: process.env.SENTRY_DSN,
    environment: process.env.NODE_ENV || "development",
    tracesSampleRate: 0.1,
  });
}

const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
const jwt = require("jsonwebtoken");
const admin = require("firebase-admin");
const { MongoClient, ServerApiVersion, ObjectId } = require("mongodb");
const dns = require("dns");
const crypto = require("crypto");
const bkash = require("./bkash");
const { streamInvoicePDF } = require("./invoice");
const { validateBody, addProductSchema } = require("./validation");
const {
  escapeRegex,
  DEPOSIT_RATE,
  round2,
  STAFF_ROLES,
  conversationId,
  isActivityVisible,
  isActiveTo,
} = require("./utils");
const createAuthMiddleware = require("./middleware");
const createUserSelfRoutes = require("./routes/users-self");
const createActivityStatusRoutes = require("./routes/activity-status");
const createUserAccountRoutes = require("./routes/user-account");
const createWishlistRoutes = require("./routes/wishlist");
const createSavedSearchRoutes = require("./routes/saved-searches");
const { createSecurityRoutes, describeUserAgent } = require("./routes/security");
const createAICompanionRoutes = require("./routes/ai-companion");
const createSystemTestRoutes = require("./routes/system-tests");
const createContentRoutes = require("./routes/content");
const createProductRoutes = require("./routes/products");
const createAdvertisementRoutes = require("./routes/advertisements");
const createBookingRoutes = require("./routes/bookings");
const createPaymentRoutes = require("./routes/payments");
const createSellerProfileRoutes = require("./routes/seller-profile");
const createSellerEarningsRoutes = require("./routes/seller-earnings");
const createMessageRoutes = require("./routes/messages");
const createNotificationRoutes = require("./routes/notifications");
const createDeveloperToolsRoutes = require("./routes/developer-tools");
const createBugReportRoutes = require("./routes/bug-reports");
const createDatabaseAdminRoutes = require("./routes/database-admin");
const createAdminManagementRoutes = require("./routes/admin-management");
const createAdminAnalyticsRoutes = require("./routes/admin-analytics");
const createUserReportRoutes = require("./routes/user-reports");
const createBanAppealRoutes = require("./routes/ban-appeals");

dns.setServers(["8.8.8.8", "8.8.4.4", "1.1.1.1"]);

// ---- Process-level safety net --------------------------------------------
//
// Every route in this file is wrapped in asyncHandler (see below), so
// request-scoped errors already go through Express's error middleware and
// respond with a clean 4xx/5xx - they never reach here. These two handlers
// are the last line of defense for anything that manages to throw or
// reject *outside* that request/response cycle: a bug in a dependency's
// internal callback, a stray unhandled promise, a timer, a webhook
// callback, etc. Node's default behavior for either of these is to crash
// the whole process - which would drop every other in-flight request and
// take the entire site down over one bad edge case. Logging and staying up
// is deliberately chosen over that: one broken request should never be
// able to take everyone else down with it. Placed first, before any other
// code runs, so it's in effect for the whole file.
process.on("uncaughtException", (err) => {
  console.error("\n[uncaughtException] Server kept running. Error:", err);
  Sentry.captureException(err);
});

process.on("unhandledRejection", (reason) => {
  console.error("\n[unhandledRejection] Server kept running. Reason:", reason);
  Sentry.captureException(reason instanceof Error ? reason : new Error(String(reason)));
});

const REQUIRED_ENV = ["DB_USER", "DB_PASSWORD", "ACCESS_TOKEN", "FIREBASE_SERVICE_ACCOUNT_KEY"];
const missingEnv = REQUIRED_ENV.filter((key) => !process.env[key]);

if (missingEnv.length > 0) {
  console.error("\n========================================================");
  console.error(" STARTUP FAILED - missing required .env values:");
  missingEnv.forEach((key) => console.error("  - " + key));
  console.error("");
  console.error(" Copy .env.example to .env in the server-buytop folder");
  console.error(" and fill in real values, then restart the server.");
  console.error("========================================================\n");
  process.exit(1);
}

// FIREBASE_SERVICE_ACCOUNT_KEY holds the full service-account JSON (from
// Firebase Console -> Project Settings -> Service Accounts -> Generate new
// private key), stored as a single-line JSON string in .env. This lets the
// server verify Firebase ID tokens itself instead of trusting whatever
// email a client claims to be - see verifyFirebaseToken below.
let firebaseServiceAccount;
try {
  firebaseServiceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_KEY);
} catch (err) {
  console.error("\n========================================================");
  console.error(" STARTUP FAILED - FIREBASE_SERVICE_ACCOUNT_KEY is not valid JSON.");
  console.error(" Paste the full contents of the service-account key file");
  console.error(" as a single-line JSON string in .env.");
  console.error("========================================================\n");
  process.exit(1);
}
admin.initializeApp({ credential: admin.cert(firebaseServiceAccount) });
// firebase-admin v14 dropped admin.auth() from the default export - auth
// now only exists as a separate modular import (firebase-admin/auth).
// Rather than rewriting every admin.auth().xyz() call site across this
// codebase (middleware.js, routes/developer-tools.js, routes/user-account.js),
// wire the old namespace method back onto `admin` right here so every
// existing call site keeps working unchanged.
const { getAuth } = require("firebase-admin/auth");
admin.auth = () => getAuth();

const app = express();
const port = process.env.PORT || 5000;

const CLIENT_URL = process.env.CLIENT_URL || "http://localhost:3000";
const SERVER_URL = process.env.SERVER_URL || `http://localhost:${port}`;

app.use(helmet());
app.use(
  cors({
    origin: CLIENT_URL,
    credentials: true,
  })
);

// If something downstream hangs (a slow/lost DB connection, a stalled
// third-party call) without this the request just sits open forever and
// the page looks frozen/crashed to whoever's waiting on it. This caps any
// single request at 30s and responds with a clean 503 instead of hanging
// - the process itself was never in danger, but an open-ended hang reads
// exactly like a crash to the person on the other end.
app.use((req, res, next) => {
  res.setTimeout(30000, () => {
    if (!res.headersSent) {
      res.status(503).send({ message: "The server took too long to respond. Please try again." });
    }
  });
  next();
});
// Default express.json() caps requests at 100kb - fine for every normal
// route here, but /admin/database/:key/import (see below) accepts a whole
// exported collection back as JSON, which can comfortably exceed that for
// a site with a lot of products/messages/orders. Raised just enough to
// cover that without opening the door to huge unrelated payloads.
app.use(express.json({ limit: "25mb" }));

// Health check for uptime monitors (UptimeRobot, Vercel health checks,
// load balancer probes, etc). Deliberately placed before the rate limiter
// below and does no DB work, so it stays cheap and available even if
// something else is under load.
app.get("/", (req, res) => {
  res.status(200).send({ status: "ok", service: "buytop-server" });
});

const generalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 300,
  standardHeaders: true,
  legacyHeaders: false,
});
app.use(generalLimiter);

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
});

// Guards content-creation endpoints (products, bookings, messages,
// reviews, bug reports) from being scripted for spam - looser than
// authLimiter since these are normal, repeatable user actions, but still
// bounded per IP.
const mutationLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
});

// AI companion endpoints call Groq's free-tier API on every request -
// much tighter than mutationLimiter so a scripted loop can't burn through
// Groq's free rate limit (organization-wide, not per key) and starve real
// users of the feature. 20 requests/15min is generous for an actual person
// chatting.
const aiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
});

const asyncHandler = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// Escapes regex metacharacters in user-supplied search text before it's used
// to build a MongoDB $regex filter - see utils.js for details.

// Buyers must pay this fraction of the price up front to secure a booking -
// see utils.js for the value.

// Product "status" values have historically been written with inconsistent
// casing (e.g. "Available" vs "available"), which made case-sensitive
// $in/equality checks silently fail and misreport already-available items
// as booked. statusMatch() builds a case-insensitive filter for one or more
// status values so reads work no matter how the value was cased when it was
// written, and CANONICAL_STATUS is used so every write from now on is
// consistent.
const statusMatch = (...values) => ({
  $regex: new RegExp(`^(${values.join("|")})$`, "i"),
});
const CANONICAL_STATUS = {
  AVAILABLE: "Available",
  ADVERTISED: "Advertised",
  BOOKED: "Booked",
};

// The two ways BuyTop actually earns money. Everything else that flows
// through payments (deposits, remaining-balance payments) is money that
// passes through to the seller - BuyTop never keeps it. These platform
// fees are the only real company income and are tracked separately in
// platformFeeCollection so revenue analytics can tell "money that moved
// through the platform" apart from "money the platform actually earned".
const PLATFORM_FEES = {
  SALE: 150, // charged to the seller once a listing is fully sold
  ADVERTISEMENT: 100, // charged to the seller each time a listing is advertised
};

const uri =
  process.env.MONGO_URI ||
  `mongodb+srv://${process.env.DB_USER}:${process.env.DB_PASSWORD}@cluster0.yfy0tas.mongodb.net/?retryWrites=true&w=majority`;
const client = new MongoClient(uri, {
  serverApi: ServerApiVersion.v1,
});
// Driver-level connection hiccups (a dropped connection, a topology
// change) emit here - without a listener, Node treats an unhandled
// 'error' event as fatal. Individual queries already fail through their
// own try/catch → asyncHandler → error middleware, so this is just
// visibility into the underlying connection, not a second error path.
client.on("error", (err) => {
  console.error("MongoDB client error:", err);
});

const usersCollection = client.db("dbBuyTop").collection("users");
const productsCollection = client.db("dbBuyTop").collection("products");
const categoriesCollection = client.db("dbBuyTop").collection("categories");
const bookingCollection = client.db("dbBuyTop").collection("bookings");
const reportCollection = client.db("dbBuyTop").collection("reported");
const paymentCollection = client.db("dbBuyTop").collection("payments");
const otpCollection = client.db("dbBuyTop").collection("otps");
const blogsCollection = client.db("dbBuyTop").collection("blogs");
const carouselCollection = client.db("dbBuyTop").collection("carousel");
const settingsCollection = client.db("dbBuyTop").collection("settings");
const reviewsCollection = client.db("dbBuyTop").collection("reviews");
const messagesCollection = client.db("dbBuyTop").collection("messages");
const developerEmailsCollection = client.db("dbBuyTop").collection("developerEmails");
const wishlistCollection = client.db("dbBuyTop").collection("wishlist");
const bugReportsCollection = client.db("dbBuyTop").collection("bugReports");
const auditLogCollection = client.db("dbBuyTop").collection("auditLog");
const hiddenConversationsCollection = client.db("dbBuyTop").collection("hiddenConversations");
const notificationsCollection = client.db("dbBuyTop").collection("notifications");
const savedSearchesCollection = client.db("dbBuyTop").collection("savedSearches");
const loginActivityCollection = client.db("dbBuyTop").collection("loginActivity");
const conversationMetaCollection = client.db("dbBuyTop").collection("conversationMeta");
// Company income only: one doc per sale-fee (150tk) or ad-fee (100tk)
// charge. Kept separate from paymentCollection, which records buyer ->
// seller money (deposits/full payments) that BuyTop never keeps.
const platformFeeCollection = client.db("dbBuyTop").collection("platformFees");
// Reports filed against a user's account (see routes/user-reports.js) -
// separate from reportCollection above, which is only ever about a
// reported *product* listing.
const userReportsCollection = client.db("dbBuyTop").collection("userReports");
// Appeals a banned user files against their own ban (see routes/ban-appeals.js).
const banAppealsCollection = client.db("dbBuyTop").collection("banAppeals");

// Fire-and-forget audit trail for sensitive staff actions (role changes,
// admin transfer, developer account/allowlist management, maintenance
// mode, bug-report triage, bulk demo-data purges). Never blocks or fails
// the actual request if logging itself has a hiccup - an audit log that
// can break the action it's logging defeats its own purpose.
const logAudit = (req, action, details = {}) => {
  auditLogCollection
    .insertOne({
      actorEmail: req.decoded?.email || "unknown",
      action,
      details,
      createdAt: new Date(),
    })
    .catch(() => {
      // Logging is best-effort only - never let it surface as a user-facing error.
    });
};

let isDbConnected = false;

async function dbConnect() {
  try {
    await client.connect();
    isDbConnected = true;
    console.log("Database is Connected");
    await usersCollection.createIndex({ email: 1 }, { unique: true });
    await productsCollection.createIndex({ email: 1 });
    await productsCollection.createIndex({ category: 1 });
    await bookingCollection.createIndex({ email: 1 });
    // At most one *active* (non-cancelled) booking per product. This is
    // what makes it safe to leave the product's own status untouched
    // (still "Available"/"Advertised") while a booking is only pending
    // its deposit - two buyers can no longer both end up with a live
    // booking on the same item, because the second insertOne below just
    // throws a duplicate-key error instead of silently succeeding. The
    // product itself only flips to "Booked" once the deposit actually
    // clears (see /bkash/callback in routes/payments.js).
    //
    // MongoDB partial index filters only support a small allow-list of
    // operators (equality, $exists, $gt/$gte/$lt/$lte, $type, $and) -
    // { status: { $ne: "Cancelled" } } compiles to an unsupported $not
    // and fails at index-build time. isActiveBooking is a plain boolean
    // set true on every fresh booking (see POST /mybooking) and unset
    // the moment a booking is cancelled (see both cancel-request approval
    // routes), so a straight equality check works here instead.
    await bookingCollection.createIndex(
      { productId: 1 },
      { unique: true, partialFilterExpression: { isActiveBooking: true } }
    );
    await reportCollection.createIndex({ productId: 1 }, { unique: true });
    // One review per buyer per seller - posting again just updates it
    // (see PUT /reviews/:sellerEmail below), same upsert pattern as
    // reportCollection above.
    await reviewsCollection.createIndex({ sellerEmail: 1, buyerEmail: 1 }, { unique: true });
    await messagesCollection.createIndex({ conversationId: 1, createdAt: 1 });
    await messagesCollection.createIndex({ buyerEmail: 1 });
    await messagesCollection.createIndex({ sellerEmail: 1 });
    await developerEmailsCollection.createIndex({ email: 1 }, { unique: true });
    // One wishlist entry per buyer per product - saving something already
    // saved is a silent no-op rather than a duplicate row (see the upsert
    // in POST /wishlist below).
    await wishlistCollection.createIndex({ email: 1, productId: 1 }, { unique: true });
    await otpCollection.createIndex({ accountEmail: 1, purpose: 1 }, { unique: true });
    await otpCollection.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 });
    await userReportsCollection.createIndex({ reportedEmail: 1 });
    await banAppealsCollection.createIndex({ email: 1, status: 1 });
    // One hidden-conversation record per user per thread - "delete
    // conversation" just hides it from that person's inbox (see the
    // DELETE /conversations/:productId/:buyerEmail route below).
    await hiddenConversationsCollection.createIndex(
      { email: 1, conversationId: 1 },
      { unique: true }
    );
    // One-time rename: the old "SubAdmin" role string → "Moderator". Every
    // role check in this file now looks for "Moderator" - without this, an
    // account promoted before this rename would silently stop matching
    // STAFF_ROLES and lose dashboard access entirely. Safe to run on every
    // boot: it's a no-op once no documents still say "SubAdmin".
    await usersCollection.updateMany({ role: "SubAdmin" }, { $set: { role: "Moderator" } });
  } catch (error) {
    isDbConnected = false;
    console.error("\n========================================================");
    console.error(" DATABASE CONNECTION FAILED:");
    console.error(" " + error.message);
    console.error("");
    console.error(" Check in your .env file:");
    console.error("  - DB_USER / DB_PASSWORD are correct");
    console.error("  - The MongoDB Atlas user has correct read/write permissions");
    console.error("  - Atlas Network Access allows your current IP (or 0.0.0.0/0 for dev)");
    console.error("========================================================\n");
  }
}
dbConnect();

app.use((req, res, next) => {
  if (!isDbConnected) {
    return res.status(503).send({
      message: "Database is not connected. Check the server terminal for a DATABASE CONNECTION FAILED message and fix your .env DB_USER/DB_PASSWORD.",
    });
  }
  next();
});

const {
  verifyJWT,
  verifyFirebaseToken,
  verifyAdmin,
  verifyMainAdmin,
  verifyStaffOrDeveloper,
  verifySeller,
  verifyBuyer,
  verifyDeveloper,
  verifySelf,
  verifySelfBuyerOrSeller,
} = createAuthMiddleware({ jwt, admin, usersCollection, asyncHandler, STAFF_ROLES });
// See middleware.js for the implementation and reasoning behind each of
// these - kept here as a single import so every route below reads exactly
// as it did before this file was split up.

// ---- Notifications --------------------------------------------------------
//
// Lightweight activity feed for a user's bell icon: "someone booked /
// wishlisted / reviewed" your stuff. Kept separate from the messages inbox,
// which has its own unread badge (see /conversations/:email/unread-count).
// `type` drives which icon the client shows; `link` is where clicking the
// notification should take the user.
// ---- Login activity ---------------------------------------------------
//
// A record of successful sign-ins, so a user can review "was this really
// me?" from Settings > Security. Only ever called on an *actual* token
// issuance (normal login, or a completed 2FA challenge) - never on a
// failed or pending attempt, so the list stays meaningful.
const logLoginActivity = async ({ email, req, method = "password" }) => {
  try {
    const ip = req.headers["x-forwarded-for"]?.split(",")[0]?.trim() || req.ip || "unknown";
    const userAgent = req.headers["user-agent"] || "";
    await loginActivityCollection.insertOne({
      email,
      ip,
      userAgent,
      device: describeUserAgent(userAgent),
      method,
      createdAt: new Date(),
    });
  } catch (err) {
    console.error("logLoginActivity failed:", err.message);
  }
};

const createNotification = async ({ email, type, title, body = "", link = "" }) => {
  if (!email) return;
  try {
    await notificationsCollection.insertOne({
      email,
      type,
      title,
      body,
      link,
      read: false,
      createdAt: new Date(),
    });
  } catch (err) {
    // Notifications are a nice-to-have side effect - never let a failure
    // here take down the booking/wishlist/review request that triggered it.
    console.error("createNotification failed:", err.message);
  }
};

app.put(
  "/user/:email",
  authLimiter,
  verifyFirebaseToken,
  asyncHandler(async (req, res) => {
    // The URL param is only used to sanity-check the client isn't
    // confused about which account it's syncing - the actual write below
    // only ever trusts req.firebaseUser.email, which came from a Firebase
    // ID token verified server-side above. A client can no longer just
    // PUT an arbitrary email and receive a valid token for it.
    const email = req.firebaseUser.email;
    if (!email) {
      return res.status(400).send({ message: "Sign-in token has no verified email" });
    }
    if (req.params.email !== email) {
      return res.status(403).send({ message: "Token does not match the requested account" });
    }

    const existingUser = await usersCollection.findOne({ email });

    // A deleted account (see POST /user/delete) also has its Firebase Auth
    // user removed, so a password-based sign-in can't normally reach this
    // point again - but a Google sign-in regenerates a fresh Firebase Auth
    // user on demand, so the same email can still authenticate with
    // Google even after we've deleted our side of the account. This is
    // the backstop that keeps a deleted account deleted regardless of how
    // they signed back in.
    if (existingUser?.status === "deleted") {
      return res.status(403).send({
        message: "This account has been deleted. Sign up again to create a new account.",
        code: "ACCOUNT_DELETED",
      });
    }
    // A banned account (see POST /users/:email/ban) is blocked from
    // signing back in for as long as the ban lasts. A `bannedUntil` of
    // null means permanent; anything else is checked against the current
    // time. Once a temporary ban's date has passed, it's lifted right
    // here automatically - same "reversible just by logging back in"
    // philosophy as the deactivated-account reactivation just below.
    if (existingUser?.status === "banned") {
      const stillBanned = !existingUser.bannedUntil || new Date(existingUser.bannedUntil) > new Date();
      if (stillBanned) {
        return res.status(403).send({
          message: existingUser.bannedUntil
            ? `Your account has been banned until ${new Date(existingUser.bannedUntil).toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric" })}. Reason: ${existingUser.banReason || "violation of community guidelines"}.`
            : `Your account has been permanently banned. Reason: ${existingUser.banReason || "violation of community guidelines"}.`,
          code: "ACCOUNT_BANNED",
        });
      }
      await usersCollection.updateOne(
        { email },
        { $set: { status: "active" }, $unset: { bannedUntil: "", banReason: "", bannedBy: "", bannedAt: "" } }
      );
    }
    // A deactivated account (see POST /user/deactivate) is meant to be
    // reversible just by logging back in - no separate "reactivate" flow
    // to build/find. Flip it back to active right here, and let the
    // response say so (reactivated: true) so the client can surface it.
    const wasDeactivated = existingUser?.status === "deactivated";

    // This is the moment an account actually gets created (first ever
    // upsert for this email). If it's a brand new email/password signup
    // that hasn't clicked its activation link yet, don't create the
    // account row - Signup.js sends the verification email and routes the
    // user to /verify-email instead of calling this. `email_verified` is a
    // claim on the Firebase ID token itself (verified server-side above),
    // not something the client can fake. Google sign-ins always come
    // through with email_verified: true already, so this never affects
    // that flow, and any account that already exists here (a returning
    // user) is always allowed through regardless of this flag.
    if (!existingUser && !req.firebaseUser.email_verified) {
      return res.status(403).send({
        message:
          "Please verify your email before continuing - we sent an activation link to your inbox.",
        code: "EMAIL_NOT_VERIFIED",
      });
    }

    const requestedRole = ["Buyer", "Seller"].includes(req.body.role) ? req.body.role : "Buyer";
    const name = typeof req.body.name === "string" ? req.body.name : "";
    const photo = typeof req.body.photo === "string" ? req.body.photo : "";
    // Only true when the client explicitly says the signup form's required
    // "this is a demo" checkbox was checked (see Signup.js). Google sign-in
    // never sends this as true - those users get routed through the
    // /accept-terms page instead, see /user/accept-terms below.
    const termsAccepted = req.body.termsAccepted === true;

    const filter = { email };
    const updateDoc = {
      $set: { email, name, photo, ...(wasDeactivated ? { status: "active" } : {}) },
      $setOnInsert: {
        role: requestedRole,
        verified: false,
        termsAccepted,
        createdAt: new Date(),
      },
    };
    const options = { upsert: true };
    const result = await usersCollection.updateOne(filter, updateDoc, options);

    // If this account has 2FA enabled, don't hand out the real access
    // token yet - issue a short-lived challenge token instead. The client
    // exchanges it for the real token via POST /2fa/verify-login once the
    // user provides a valid authenticator/backup code. Nothing is logged
    // to login activity until that actually succeeds.
    if (existingUser?.twoFactor?.enabled) {
      const challengeToken = jwt.sign(
        { email, purpose: "2fa-challenge" },
        process.env.ACCESS_TOKEN,
        { expiresIn: "10m" }
      );
      return res.send({ result, requires2FA: true, challengeToken, reactivated: wasDeactivated });
    }

    const token = jwt.sign({ email }, process.env.ACCESS_TOKEN, { expiresIn: "7d" });
    await logLoginActivity({ email, req, method: "sign-in" });
    res.send({ result, token, reactivated: wasDeactivated });
  })
);

// User self-lookup routes (terms/accept-terms/admin/role/seller/buyer/
// verify status) have moved to routes/users-self.js - mounted below,
// right after the auth middleware they depend on is set up.
app.use(
  createUserSelfRoutes({ usersCollection, verifyJWT, verifySelf, asyncHandler, STAFF_ROLES })
);

// "Active now" heartbeat + the Settings > Privacy on/off toggle have
// moved to routes/activity-status.js - mounted below.
app.use(
  createActivityStatusRoutes({
    usersCollection,
    verifyJWT,
    verifySelf,
    asyncHandler,
    isActivityVisible,
    jwt,
  })
);

// Categories, blogs, homepage carousel, and site maintenance mode have
// moved to routes/content.js - mounted below.
app.use(
  createContentRoutes({
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
  })
);

// Core product routes (view/category listing/dev sandbox/create/delete/
// seller's own listings) have moved to routes/products.js - mounted below.
app.use(
  createProductRoutes({
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
  })
);

// Saved searches / price-drop alerts have moved to
// routes/saved-searches.js - mounted below.
app.use(
  createSavedSearchRoutes({
    verifyJWT,
    verifySelf,
    asyncHandler,
    savedSearchesCollection,
    ObjectId,
  })
);

// Two-factor auth (TOTP) and login-activity history have moved to
// routes/security.js - mounted below.
app.use(
  createSecurityRoutes({
    jwt,
    mutationLimiter,
    authLimiter,
    verifyJWT,
    verifySelf,
    asyncHandler,
    usersCollection,
    loginActivityCollection,
    logLoginActivity,
  })
);

// AI companion (shopping assistant, support/FAQ bot, seller listing
// helper) has moved to routes/ai-companion.js - mounted below. Fully
// opt-in via GROQ_API_KEY (Groq's free-tier, no-credit-card API) - see ai.js.
app.use(
  createAICompanionRoutes({
    aiLimiter,
    mutationLimiter,
    verifyJWT,
    verifySeller,
    asyncHandler,
    productsCollection,
    bookingCollection,
  })
);

// Live health-check / smoke-test runner, for Developer and root-Admin
// accounts only - see routes/system-tests.js. Read-only against real
// data, no side effects, safe to run in production on demand.
app.use(
  createSystemTestRoutes({
    verifyJWT,
    asyncHandler,
    usersCollection,
    productsCollection,
    categoriesCollection,
    bookingCollection,
    platformFeeCollection,
    admin,
  })
);

/* ------------------------------------------------------------------ */
/*  Wishlist: buyers can save products to look at again later without   */
/*  booking them. One entry per (email, productId) - see the unique    */
/*  index in dbConnect(). Saving something already saved is a no-op    */
/*  rather than an error, so the client's heart-toggle button doesn't  */
/*  need to track local state to avoid a duplicate-key error.          */
/* ------------------------------------------------------------------ */
// Wishlist routes have moved to routes/wishlist.js - mounted below.
app.use(
  createWishlistRoutes({
    verifyJWT,
    asyncHandler,
    wishlistCollection,
    productsCollection,
    usersCollection,
    createNotification,
    ObjectId,
  })
);

// Bookings, orders, cancellations, and reporting a listing/order have
// moved to routes/bookings.js - mounted below.
app.use(
  createBookingRoutes({
    mutationLimiter,
    verifyJWT,
    verifyBuyer,
    verifySeller,
    verifySelf,
    asyncHandler,
    productsCollection,
    bookingCollection,
    reportCollection,
    usersCollection,
    createNotification,
    statusMatch,
    CANONICAL_STATUS,
    round2,
    DEPOSIT_RATE,
    ObjectId,
    sendEmail,
    CLIENT_URL,
  })
);

// Seller-side ad toggling and the public "all advertised products" feed
// have moved to routes/advertisements.js - mounted below.
app.use(
  createAdvertisementRoutes({
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
  })
);

// Admin content views (products/orders/payments/reports) and user/staff
// management (roles, verification, admin transfer) have moved to
// routes/admin-management.js - mounted below.
app.use(
  createAdminManagementRoutes({
    verifyJWT,
    verifyAdmin,
    verifyMainAdmin,
    asyncHandler,
    productsCollection,
    bookingCollection,
    paymentCollection,
    reportCollection,
    usersCollection,
    STAFF_ROLES,
    escapeRegex,
    round2,
    CANONICAL_STATUS,
    logAudit,
    client,
    ObjectId,
  })
);

// Reporting another user's profile (Buyer/Seller-facing) and the Admin/
// Moderator queue that reviews those reports & bans accounts have moved
// to routes/user-reports.js - mounted below.
app.use(
  createUserReportRoutes({
    verifyJWT,
    verifyAdmin,
    mutationLimiter,
    asyncHandler,
    userReportsCollection,
    usersCollection,
    createNotification,
    STAFF_ROLES,
    logAudit,
    ObjectId,
  })
);

app.use(
  createBanAppealRoutes({
    admin,
    authLimiter,
    verifyJWT,
    verifyAdmin,
    asyncHandler,
    usersCollection,
    banAppealsCollection,
    createNotification,
    logAudit,
    ObjectId,
  })
);


/* ------------------------------------------------------------------ */
/*  OTP flow for changing email / password from Settings.              */
// OTP-gated email/password change, profile update, and deactivate/delete
// have moved to routes/user-account.js - mounted below.
app.use(
  createUserAccountRoutes({
    authLimiter,
    verifyJWT,
    verifySelfBuyerOrSeller,
    asyncHandler,
    usersCollection,
    otpCollection,
    productsCollection,
    bookingCollection,
    paymentCollection,
    jwt,
    admin,
    logAudit,
  })
);

// Admin analytics dashboard (overview, revenue, funnel, sellers,
// inventory, buyers, cancellations, pipeline, reports trend, CSV export)
// has moved to routes/admin-analytics.js - mounted below.
app.use(
  createAdminAnalyticsRoutes({
    verifyJWT,
    verifyAdmin,
    verifyMainAdmin,
    asyncHandler,
    usersCollection,
    productsCollection,
    reportCollection,
    bookingCollection,
    paymentCollection,
    platformFeeCollection,
    categoriesCollection,
    STAFF_ROLES,
    statusMatch,
    round2,
    PLATFORM_FEES,
  })
);

// Payments (checkout price lookup, hand-cash flow, bKash deposit/full
// payment, callback, invoice PDF) have moved to routes/payments.js -
// mounted below.
app.use(
  createPaymentRoutes({
    verifyJWT,
    verifySeller,
    verifyBuyer,
    asyncHandler,
    bookingCollection,
    productsCollection,
    paymentCollection,
    platformFeeCollection,
    round2,
    PLATFORM_FEES,
    logAudit,
    bkash,
    SERVER_URL,
    CLIENT_URL,
    streamInvoicePDF,
    ObjectId,
    sendEmail,
    statusMatch,
  })
);

// Seller profile, reviews & ratings have moved to routes/seller-profile.js
// - mounted below.
app.use(
  createSellerProfileRoutes({
    verifyJWT,
    mutationLimiter,
    asyncHandler,
    usersCollection,
    productsCollection,
    reviewsCollection,
    round2,
    createNotification,
  })
);

// Seller-facing earnings dashboard (gross sales, platform fees, net
// earnings, monthly trend) - routes/seller-earnings.js.
app.use(
  createSellerEarningsRoutes({
    verifyJWT,
    verifySeller,
    asyncHandler,
    productsCollection,
    bookingCollection,
    paymentCollection,
    platformFeeCollection,
    round2,
    ObjectId,
  })
);

// Messaging (buyer <-> seller, per product) and inbox/conversation
// management have moved to routes/messages.js - mounted below.
app.use(
  createMessageRoutes({
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
  })
);

// Notifications (bell icon feed) have moved to routes/notifications.js -
// mounted below.
app.use(
  createNotificationRoutes({
    verifyJWT,
    verifySelf,
    asyncHandler,
    notificationsCollection,
    ObjectId,
  })
);

// Developer email allowlist, developer test-account management, and
// demo-data cleanup have moved to routes/developer-tools.js - mounted
// below.
app.use(
  createDeveloperToolsRoutes({
    verifyJWT,
    verifyMainAdmin,
    verifyFirebaseToken,
    verifySelf,
    asyncHandler,
    developerEmailsCollection,
    usersCollection,
    productsCollection,
    bookingCollection,
    admin,
    logAudit,
  })
);

// Bug reports (Developer submits from test mode, Admin/Moderator triage)
// have moved to routes/bug-reports.js - mounted below.
app.use(
  createBugReportRoutes({
    mutationLimiter,
    verifyJWT,
    verifyStaffOrDeveloper,
    verifyAdmin,
    asyncHandler,
    bugReportsCollection,
    logAudit,
    ObjectId,
  })
);

// Audit log and full database export/clear/import admin tooling have
// moved to routes/database-admin.js - mounted below.
app.use(
  createDatabaseAdminRoutes({
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
  })
);

app.use((req, res) => {
  res.status(404).send({ message: "Not found" });
});

// Captures anything reaching the error handler below to Sentry (a no-op
// if SENTRY_DSN isn't set - see the init check at the top of this file).
// Must be registered after all routes/middleware but before the final
// error handler, so it sees the error before we respond with it.
Sentry.setupExpressErrorHandler(app);

app.use((err, req, res, next) => {
  console.error(err);
  // A malformed id (not a valid 24-char Mongo ObjectId) throws here from
  // whichever route tried `new ObjectId(...)` - that happens in ~30
  // different routes across this file (:id params, bookingId/productId in
  // request bodies, etc). Rather than adding an ObjectId.isValid() guard
  // at every one of those call sites, it's handled once here: any request
  // with a bad id now gets a clean 400 instead of a generic 500.
  if (err?.name === "BSONError" || /ObjectId|24 hex characters/i.test(err?.message || "")) {
    return res.status(400).send({ message: "Invalid id" });
  }
  res.status(500).send({ message: "Something went wrong" });
});

// Starting the actual listener (and everything that depends on a live
// socket) only happens when this file is run directly - `node index.js`
// or `npm start`. When a test file does `require("../index.js")` instead,
// require.main !== module, so this whole block is skipped: no port is
// bound, no EADDRINUSE risk from running the suite twice, and the test
// can drive `app` straight through supertest instead. Nothing about how
// the real server starts in production changes - this only adds a guard
// around code that already ran unconditionally before.
if (require.main === module) {
  const server = app.listen(port, () => console.log("Server is running through port: ", port));

  // Everything above this point handles *runtime* errors by staying up.
  // A failure to bind the port at startup is different - there's no
  // listening socket, so there's nothing useful left running, and the
  // generic uncaughtException handler higher up would otherwise swallow
  // this into a silent, invisible non-server. Fail loudly and exit instead,
  // so a process manager (pm2, systemd, Docker) sees it and can restart or
  // alert.
  server.on("error", (err) => {
    console.error("\n========================================================");
    console.error(" SERVER FAILED TO START:", err.message);
    if (err.code === "EADDRINUSE") {
      console.error(` Port ${port} is already in use - stop whatever's using it, or set a different PORT in .env.`);
    }
    console.error("========================================================\n");
    process.exit(1);
  });
}

// Exposed on app.locals (the standard Express place for app-level
// references) so integration tests can close this connection in their
// own teardown - see test-support/setupApp.js's cleanup(). Without this,
// index.js's own MongoClient stays connected to a mongod that the test
// has already stopped, which is what was showing up as "a worker process
// has failed to exit gracefully" after a test run: a dangling connection
// with its own keep-alive timers, not an actual leak in the app itself.
app.locals.mongoClient = client;

// Exported so integration tests can drive the real Express app (real
// routes, real middleware, real Mongo queries against a throwaway test
// database) through supertest, without this file actually binding a
// port. See __tests__/integration/ for how this gets used.
module.exports = app;