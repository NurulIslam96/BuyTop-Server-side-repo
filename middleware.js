// All auth/role-check middleware, extracted from index.js. Built as a
// factory function rather than requiring `usersCollection`/`admin`
// directly at the top of this file, because those are created inside
// index.js's own startup sequence - passing them in here keeps this
// module free of any assumption about *when* index.js finishes setting
// up its DB connection, and makes each middleware individually mockable
// for tests later (pass a fake usersCollection, no real Mongo needed).
function createAuthMiddleware({ jwt, admin, usersCollection, asyncHandler, STAFF_ROLES }) {
  // Verifies our own backend JWT (minted by PUT /user/:email after a real
  // Firebase login). This is what every route below other than that one
  // login route actually checks.
  function verifyJWT(req, res, next) {
    const authHeader = req.headers.authorization;
    if (!authHeader) {
      return res.status(401).send({ message: "Unauthorized Access" });
    }
    const token = authHeader.split(" ")[1];
    jwt.verify(token, process.env.ACCESS_TOKEN, function (err, decoded) {
      if (err) {
        return res.status(403).send({ message: "forbidden access" });
      }
      req.decoded = decoded;
      next();
    });
  }

  // Verifies a Firebase ID token (not our own backend JWT) sent from the
  // client right after a real Firebase sign-in/sign-up. This is the only
  // thing that should ever be trusted to say "this request really is from
  // the owner of this email" - a client-supplied email/URL param never is.
  // Used specifically for PUT /user/:email, which is the one route that
  // mints our backend JWT in the first place.
  const verifyFirebaseToken = asyncHandler(async (req, res, next) => {
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith("Bearer ")) {
      return res.status(401).send({ message: "Unauthorized Access" });
    }
    const idToken = authHeader.split(" ")[1];
    try {
      req.firebaseUser = await admin.auth().verifyIdToken(idToken);
    } catch (err) {
      return res.status(403).send({ message: "Invalid or expired sign-in token" });
    }
    next();
  });

  // Admin dashboard access: both full Admins and Moderators get in.
  const verifyAdmin = asyncHandler(async (req, res, next) => {
    const user = await usersCollection.findOne({ email: req.decoded.email });
    if (!user || !STAFF_ROLES.includes(user.role)) {
      return res.status(403).send({ message: "forbidden access" });
    }
    req.staffUser = user;
    next();
  });

  // Sensitive staff-management actions (assigning Admin/Moderator, removing staff):
  // restricted to full Admins only. Moderators do NOT have this authority.
  const verifyMainAdmin = asyncHandler(async (req, res, next) => {
    const user = await usersCollection.findOne({ email: req.decoded.email });
    if (!user || user.role !== "Admin") {
      return res.status(403).send({ message: "Only a main Admin can perform this action" });
    }
    req.staffUser = user;
    next();
  });

  // Bug reports: a Developer submits what they found while testing in
  // Seller/Buyer test mode; Admin & Moderator triage and manage them. Both
  // sides of that workflow share this one middleware; the route handlers
  // below narrow down what each role can actually see/do.
  const verifyStaffOrDeveloper = asyncHandler(async (req, res, next) => {
    const user = await usersCollection.findOne({ email: req.decoded.email });
    if (!user || !["Admin", "Moderator", "Developer"].includes(user.role)) {
      return res.status(403).send({ message: "forbidden access" });
    }
    req.staffUser = user;
    next();
  });

  // A Developer-role account (see /developer-accounts) is let through here
  // too, alongside a real Seller - this is what lets a Developer's "Seller
  // test mode" actually perform real seller actions instead of just looking
  // at the UI. It never grants Buyer/Seller status itself (the account's
  // role field stays "Developer"), so it still never appears in any
  // role: "Seller" count/list elsewhere in this file. Anything a Developer
  // creates through these routes gets tagged isDemo at the point of
  // creation (see /addproduct) and filtered out of every public/analytics
  // query.
  const verifySeller = asyncHandler(async (req, res, next) => {
    const user = await usersCollection.findOne({ email: req.decoded.email });
    if (!user || !["Seller", "Developer"].includes(user.role)) {
      return res.status(403).send({ message: "forbidden access" });
    }
    req.sellerUser = user;
    next();
  });

  // See verifySeller above for why "Developer" is admitted alongside the
  // real role this middleware is named for.
  const verifyBuyer = asyncHandler(async (req, res, next) => {
    const user = await usersCollection.findOne({ email: req.decoded.email });
    if (!user || !["Buyer", "Developer"].includes(user.role)) {
      return res.status(403).send({ message: "forbidden access" });
    }
    req.buyerUser = user;
    next();
  });

  // Strictly the "Developer" role - unlike verifySeller/verifyBuyer above,
  // nothing else is let through here. Used only for the sandbox listing,
  // which exists purely so a Developer test account has somewhere to find
  // and book its own isDemo products (they're deliberately invisible
  // everywhere else - see the isDemo filters throughout index.js).
  const verifyDeveloper = asyncHandler(async (req, res, next) => {
    const user = await usersCollection.findOne({ email: req.decoded.email });
    if (!user || user.role !== "Developer") {
      return res.status(403).send({ message: "forbidden access" });
    }
    req.developerUser = user;
    next();
  });

  // Restricts a :email-param route to the logged-in user checking their own
  // account. Used on the /users/*/:email lookup routes, which return
  // role/admin/verified/terms status - without this, those were reachable by
  // anyone with no login at all, letting a caller enumerate any email's role
  // or admin status just by guessing/looping through addresses.
  const verifySelf = (req, res, next) => {
    if (req.decoded.email !== req.params.email) {
      return res.status(403).send({ message: "forbidden access" });
    }
    next();
  };

  // Only ever meant for Buyer/Seller accounts managing their own account from
  // Settings - Admin/Moderator/Developer accounts don't get a self-service
  // deactivate/delete (removing staff access has its own, deliberately more
  // careful flow - see /users/role and /users/transfer-admin). Neither route
  // re-checks the password itself: the client already re-authenticated
  // against Firebase right before calling these (see PasswordConfirmModal),
  // the same pattern every other password-gated destructive action in this
  // app already uses.
  const verifySelfBuyerOrSeller = asyncHandler(async (req, res, next) => {
    const user = await usersCollection.findOne({ email: req.decoded.email });
    if (!user || !["Buyer", "Seller"].includes(user.role)) {
      return res.status(403).send({ message: "Only Buyer or Seller accounts can do this from Settings" });
    }
    req.selfUser = user;
    next();
  });

  return {
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
  };
}

module.exports = createAuthMiddleware;
