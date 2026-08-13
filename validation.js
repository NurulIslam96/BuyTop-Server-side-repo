const { z } = require("zod");

// Express middleware factory: validates + whitelists req.body against a
// Zod schema before the route handler ever sees it. On failure, responds
// 400 with the first validation issue instead of letting a malformed or
// malicious payload reach a MongoDB write. On success, req.body is
// *replaced* with the parsed result - so only fields the schema knows
// about survive (Zod strips anything not listed unless .passthrough() is
// used), which closes off arbitrary-field injection into insertOne/etc.
const validateBody = (schema) => (req, res, next) => {
  const result = schema.safeParse(req.body);
  if (!result.success) {
    const issue = result.error.issues[0];
    return res.status(400).send({
      message: `Invalid request: ${issue.path.join(".") || "body"} - ${issue.message}`,
    });
  }
  req.body = result.data;
  next();
};

// A positive number, coerced from string (HTML number inputs / form data
// can arrive as strings), capped at a sane upper bound so nobody can
// stuff a 10^300 value into a price field.
const money = z.coerce.number().finite().positive().max(100_000_000);

const nonEmptyString = (max) => z.string().trim().min(1).max(max);

// POST /addproduct - a seller listing a product. This is matched against
// the exact field set client/.../Pages/Dashboard/Seller/AddProduct.js
// actually sends. email/status/isVerified are accepted here (so they
// don't get stripped and log noise from "unknown field") but are still
// force-overwritten from server-side truth in the route handler itself -
// this schema only rejects bad *shapes/types*, it doesn't grant trust.
const addProductSchema = z.object({
  email: z.string().trim().email().optional(),
  userPhoto: z.string().url().optional().or(z.literal("")),
  userName: nonEmptyString(100).optional(),
  productName: nonEmptyString(150),
  purchaseYear: z.coerce.number().int().min(1990).max(new Date().getFullYear()),
  condition: nonEmptyString(50),
  postDate: z.string().optional(),
  location: nonEmptyString(60),
  phone: nonEmptyString(30),
  description: nonEmptyString(2000),
  productPhoto: z.string().url().optional(),
  images: z.array(z.string().url()).min(1).max(10),
  originalPrice: money,
  resalePrice: money,
  status: z.string().optional(),
  category: nonEmptyString(60),
  isVerified: z.boolean().optional(),
});

// Fields no client should ever receive on any endpoint that returns a
// user document wholesale: twoFactor holds the live TOTP secret and
// backup-code hashes (see routes/security.js) - sending those out would
// let whoever reads them generate valid 2FA codes for someone else's
// account. Shared here (not just admin-management.js) so /system-tests
// can assert this projection is actually being applied.
const SENSITIVE_USER_FIELDS = {
  "twoFactor.secret": 0,
  "twoFactor.pendingSecret": 0,
  "twoFactor.backupCodeHashes": 0,
};

// Pure predicate for "does this new listing match this saved search" -
// pulled out of routes/products.js so the exact same logic backs the
// live notifyMatchingSavedSearches() side effect, the unit tests in
// __tests__/, and the /system-tests health check. One definition, no
// risk of the three drifting apart from each other over time.
function savedSearchMatches(product, savedSearch) {
  if (savedSearch.email === product.email) return false; // don't alert sellers on their own listing
  const keyword = (savedSearch.keyword || "").toLowerCase();
  const matchesKeyword =
    !keyword ||
    product.productName?.toLowerCase().includes(keyword) ||
    product.description?.toLowerCase().includes(keyword);
  const matchesPrice = !savedSearch.maxPrice || Number(product.resalePrice) <= Number(savedSearch.maxPrice);
  return matchesKeyword && matchesPrice;
}

module.exports = { validateBody, addProductSchema, money, nonEmptyString, savedSearchMatches, SENSITIVE_USER_FIELDS };
