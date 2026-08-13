# BuyTop API Reference

Base URL: `SERVER_URL` from your environment (e.g. `http://localhost:5000`
in dev). All request/response bodies are JSON unless noted.

This is a reference of routes and access control, not a full OpenAPI spec
with request/response schemas for every field - for exact payload shapes,
the route handler in `index.js` is still the source of truth. Everything
below was extracted directly from the actual middleware chains in the
code, so the auth column is accurate as of this document's generation.

## Authentication model

Almost every route requires a Firebase ID token in the `Authorization:
Bearer <token>` header. Two layers exist:

- **`verifyFirebaseToken`** - verifies the token against Firebase directly
  and attaches `req.firebaseUser`. Used only pre-login (account
  creation/sync), since the user doesn't have a DB role yet at that point.
- **`verifyJWT`** - the standard check used everywhere else: verifies the
  token, then looks up the corresponding user in MongoDB and attaches
  `req.decoded`.

On top of one of those, most routes add a role check:

| Middleware | Who gets through |
|---|---|
| `verifySelf` | Only the account matching the `:email` URL param - stops anyone from probing another user's role/verified/admin status. |
| `verifyAdmin` | `Admin` or `Moderator` role. |
| `verifyMainAdmin` | `Admin` role only - `Moderator` is explicitly excluded. Used for staff management, revenue analytics, and destructive database actions. |
| `verifySeller` | `Seller` role, or a `Developer` account in seller test mode. |
| `verifyBuyer` | `Buyer` role, or a `Developer` account in buyer test mode. |
| `verifyDeveloper` | Strictly `Developer` role - nothing else admitted. |
| `verifyStaffOrDeveloper` | `Admin`, `Moderator`, or `Developer`. |
| `verifySelfBuyerOrSeller` | The account owner, and only if they're a `Buyer` or `Seller`. |

Rate-limit tiers (`authLimiter`, `mutationLimiter`, `dbAdminLimiter`) apply
extra throttling on top of the general limiter, on top of the specific
sensitivity of that route (login/OTP, anything that writes data, and
destructive database admin actions, respectively).

---

## Users & Auth

| Method | Path | Auth | Purpose |
|---|---|---|---|
| PUT | `/user/:email` | Firebase token | Create/sync a user record on login. Trusts only the verified token email, not the URL param. If the account has 2FA enabled, returns `{ requires2FA: true, challengeToken }` instead of a real token - see `/2fa/verify-login` below. |
| GET | `/users/terms/:email` | Self | Terms-acceptance status. |
| PATCH | `/user/accept-terms` | Logged in | Record terms acceptance. |
| GET | `/users/admin/:email` | Self | Whether this account is Admin/Moderator. |
| GET | `/users/role/:email` | Self | This account's role. |
| GET | `/users/seller/:email` | Self | Whether this account is a Seller. |
| GET | `/users/buyer/:email` | Self | Whether this account is a Buyer. |
| GET | `/users/verify/:email` | Self | Verification status. |
| POST | `/otp/request` | Logged in, rate-limited | Request a password-change OTP (code goes to the account's own email). |
| POST | `/otp/verify` | Logged in, rate-limited | Verify that OTP code. |
| POST | `/user/confirm-email-change` | Logged in, rate-limited | Finish an email change after Firebase's `verifyBeforeUpdateEmail` link has been clicked - takes a fresh Firebase ID token, propagates the new email across every collection, and returns a new buytop-token. |
| PATCH | `/user/change-password` | Logged in, rate-limited | Change password (OTP-gated). |
| PATCH | `/user/profile` | Logged in | Update profile fields (name/photo/etc). |
| POST | `/user/deactivate` | Self, Buyer or Seller | Deactivate own account. |
| POST | `/user/delete` | Self, Buyer or Seller | Delete own account. |

## Two-Factor Auth & Login Activity

| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `/security/login-activity/:email` | Self | Last 20 successful sign-ins (time, device, method). |
| GET | `/2fa/status` | Logged in | Whether 2FA is enabled on this account. |
| POST | `/2fa/setup` | Logged in | Generate a pending TOTP secret + QR code (not yet enforced). |
| POST | `/2fa/enable` | Logged in | Confirm the pending secret with a real code from the authenticator app; turns 2FA on and returns 8 one-time backup codes (shown once, only hashes are stored). |
| POST | `/2fa/disable` | Logged in | Turn 2FA off (requires a valid TOTP or backup code). |
| POST | `/2fa/verify-login` | `challengeToken` from `/user/:email`, rate-limited | Exchange a valid code for the real access token. |

## AI Companion

Opt-in via `GROQ_API_KEY` in `.env` (see `ai.js`) - without it, every
route below returns `503` with a clear message instead of failing oddly.
Runs on [Groq](https://console.groq.com), which has a genuinely free tier
(no credit card - just a rate limit), using `llama-3.3-70b-versatile`. All
AI routes still share a rate limit (`aiLimiter`, 20 req/15min per IP) to
stay well under Groq's free-tier caps.

| Method | Path | Auth | Purpose |
|---|---|---|---|
| POST | `/ai/shop` | Public, rate-limited | Shopping assistant chat. Grounded with a real `search_products` tool query against live listings - never invents a product. Body: `{ messages: [...] }` (OpenAI/Groq message format). Returns `{ reply, products }`. |
| POST | `/ai/support` | Public, rate-limited | FAQ/support chat, grounded in BuyTop's actual buyer/seller flows (kept in sync with `Pages/HowItWorks/HowItWorks.js`). Body: `{ messages: [...] }`. Returns `{ reply }`. |
| POST | `/ai/seller-assist` | Seller, rate-limited | One-shot listing helper. Body: `{ productName, category, condition, originalPrice, notes }`. Suggested price is grounded against real recent completed sales in that category when available. Returns `{ title, description, suggestedPrice }`. |

## System Health Check

| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `/system-tests/run` | Developer or root Admin only (not Moderator) | Runs a set of read-only, side-effect-free checks against real data and config - DB connectivity, schema validation, saved-search matcher logic, JWT round-trip, a direct regression check that the 2FA-secret projection fix is still in place, category/booking data integrity, platform-fee consistency, and Firebase Admin SDK connectivity. Also reports (informational only) whether SMTP/bKash/Groq/Sentry are configured. Never sends a real email, calls bKash, or calls Groq - config presence only. |

## Products & Categories

| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `/categories` | Public | List categories. |
| POST | `/categories` | Admin | Create a category. |
| PATCH / DELETE | `/categories/:id` | Admin | Edit/remove a category. |
| GET | `/product/:id` | Logged in | Single product detail. |
| GET | `/category/:id` | Logged in | Products within a category. |
| POST | `/addproduct` | Seller, validated | Create a listing. Body validated against `validation.js`'s `addProductSchema`; `email`/`status`/`isVerified` are force-set server-side regardless of what's sent. |
| POST | `/products/bulk-import` | Seller, validated | Create up to 200 listings at once from `{ rows: [...] }` (a parsed CSV). Each row is validated independently - bad rows are skipped and reported, not fatal to the batch. |
| GET | `/myproducts/:email` | Seller | A seller's own listings. |
| DELETE | `/myproducts/:id` | Seller | Remove own listing. |
| PATCH | `/addAdv/:id` / `/rmvadvertise/:id` | Seller | Toggle a listing's own advertisement status. |
| GET | `/alladv` | Public | All currently advertised products. |
| GET | `/carousel` | Public | Homepage carousel items. |
| POST | `/carousel` | Admin | Add a carousel item. |
| DELETE | `/carousel/:id` | Admin | Remove a carousel item. |

## Wishlist

| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `/wishlist/ids` | Logged in | Just the product IDs (cheap check for heart-icon state). |
| GET | `/wishlist` | Logged in | Full wishlist with product details. |
| POST | `/wishlist` | Logged in | Add a product. |
| DELETE | `/wishlist/:productId` | Logged in | Remove a product. |

## Saved Searches / Price Alerts

| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `/saved-searches/:email` | Self | List your saved searches. |
| POST | `/saved-searches` | Logged in | Save a category + optional keyword + optional max price. Every new listing in that category is checked against it (see `notifyMatchingSavedSearches` in `routes/products.js`) - a match sends an in-app notification and, if SMTP is configured, an email. |
| DELETE | `/saved-searches/:id` | Owner | Remove a saved search. |

## Bookings, Orders & Cancellations

| Method | Path | Auth | Purpose |
|---|---|---|---|
| POST | `/mybooking` | Buyer, rate-limited | Create a booking. Price is derived server-side from the product record - see the comment in `index.js` and the fix log in `CHANGES.md`. |
| PATCH | `/bookstatus/:id` | Buyer | Update a booking's status. |
| GET | `/myorders/:email` | Buyer | Buyer's own orders. |
| PATCH | `/myorders/:id` | Buyer | Update own order. |
| POST | `/myorders/:id/cancel-request` | Buyer | Request cancellation. |
| GET | `/seller/cancel-requests/:email` | Seller | Cancellation requests on seller's items. |
| PATCH | `/seller/cancel-requests/:id` | Seller | Approve/deny a cancellation. |
| GET | `/seller/orders/:email` | Self + Seller | Seller's incoming orders. |
| PUT | `/reported/:id` | Logged in | Report a listing/order. |

## Payments

| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `/payment/:id` | Logged in | Payment record lookup. |
| POST | `/bookings/:id/pay-cash` | Logged in | Buyer flags a booking as paid by hand cash. |
| POST | `/bookings/:id/confirm-cash-payment` | Seller | Seller confirms the cash was received. |
| POST | `/bkash/create` | Buyer | Start a bKash checkout for the remaining balance. Amount is read from the booking record server-side. |
| POST | `/bkash/create-deposit` | Buyer | Start a bKash checkout for the booking deposit. |
| GET | `/bkash/callback` | Public (bKash calls this) | bKash's redirect/callback endpoint. |
| GET | `/invoice/:bookingId` | Logged in | Generate and stream a PDF invoice. |

## Seller Profile & Reviews

| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `/seller-profile/:email` | Logged in | Public seller profile + their active listings. |
| PUT | `/reviews/:sellerEmail` | Logged in, rate-limited | Leave/update a review. |
| DELETE | `/reviews/:sellerEmail` | Logged in | Remove own review. |

## Seller Earnings

| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `/seller/earnings` | Seller | Gross sales, platform fees, net earnings, monthly trend, and pending (deposit-only) order value for the signed-in seller's own listings. |

## Messages & Conversations

| Method | Path | Auth | Purpose |
|---|---|---|---|
| POST | `/messages` | Logged in, rate-limited | Send a message. Also notifies (in-app + email, if SMTP is configured) the recipient. |
| GET | `/messages/:productId/:buyerEmail` | Logged in | Thread history. |
| DELETE | `/messages/:id` | Logged in | Delete a single message. |
| GET | `/conversations/:email` | Self | Inbox list. |
| GET | `/conversations/:email/unread-count` | Self | Unread badge count. |
| PATCH | `/conversations/:productId/:buyerEmail/read` | Logged in | Mark thread read. |
| PATCH | `/conversations/:productId/:buyerEmail/spam` | Logged in | Flag/unflag as spam. |
| DELETE | `/conversations/:productId/:buyerEmail` | Logged in | Hide a conversation (per-user, not a hard delete - see `hiddenConversationsCollection`). |

## Notifications

| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `/notifications/:email` | Self | Notification feed. |
| GET | `/notifications/:email/unread-count` | Self | Unread badge count. |
| PATCH | `/notifications/:id/read` | Logged in | Mark one read. |
| PATCH | `/notifications/:email/read-all` | Self | Mark all read. |

## Transactional Email

Not a route - a side effect (`mailer.js`) triggered from other requests.
Opt-in via `SMTP_HOST`/`SMTP_USER`/`SMTP_PASS` in `.env`; without them the
server logs one warning and silently skips sending, same as `SENTRY_DSN`.
Sent on: new booking (to seller), deposit paid (to buyer + seller), cash
payment marked pending (to seller), cash payment confirmed (to buyer),
final bKash payment (to buyer + seller), new message (to the recipient).
A failed send never fails the request that triggered it.

## Blogs & Site Status

| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `/blogs` | Public | Approved blog posts. |
| GET | `/blogs/pending` | Admin | Posts awaiting approval. |
| POST | `/blogs` | Logged in | Submit a post. |
| PATCH | `/blogs/:id/approve` | Admin | Approve a post. |
| PATCH / DELETE | `/blogs/:id` | Logged in | Edit/remove own post. |
| GET | `/site-status` | Public | Maintenance-mode flag. |
| PATCH | `/admin/maintenance` | Main Admin | Toggle maintenance mode. |

## Admin - Users, Content & Reports

| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `/admin/allproducts` | Admin | All listings, any status. |
| PATCH | `/admin/addAdv/:id` / `/admin/rmvadvertise/:id` | Admin | Toggle any listing's advertisement status. |
| GET | `/admin/orders` | Admin | All orders. |
| DELETE | `/admin/orders/:id` | Admin | Remove an order. |
| GET | `/admin/payments` | Admin | All payment records. |
| GET | `/reporteditems` | Admin | Reported listings/orders queue. |
| GET | `/allsellers` / `/allbuyers` / `/allusers` / `/allstaff` | Admin | User lists by role. |
| GET | `/users/search` | Admin | Search users. |
| PATCH | `/verifyuser/:email` | Admin | Verify a user. |
| DELETE | `/allusers/:id` | Admin | Remove a user. |
| DELETE | `/itemdelete/:id` | Admin | Remove a listing. |
| DELETE | `/reportdelete/:id` | Admin | Dismiss a report. |
| PUT | `/reported/:id` | Any signed-in user | Report a product listing (reason + optional details for "Other"). |
| POST | `/user-reports` | Any signed-in user | Report another user's profile (reason + optional details for "Other"). One open report per reporter/account at a time. |
| GET | `/user-reports/mine` | Any signed-in user | Reports the caller has personally filed, with their current status. |
| GET | `/user-reports` | Admin | Moderation queue of reports filed against users, enriched with the reported user's current status and a `reportCount`/`highPriority` flag (3+ open reports). |
| PATCH | `/user-reports/:id/dismiss` | Admin | Dismiss a user report (status becomes "dismissed", kept for the reporter's history). |
| POST | `/ban-appeals` | Public (verifies a Firebase ID token instead of a JWT) | A banned user appeals their ban. One pending appeal per account at a time. |
| GET | `/ban-appeals` | Admin | Queue of ban appeals. |
| POST | `/ban-appeals/:id/approve` | Admin | Approve an appeal - lifts the ban. |
| POST | `/ban-appeals/:id/reject` | Admin | Reject an appeal - ban stays. |
| POST | `/users/:email/ban` | Admin | Ban a user for a number of days/months/years, or permanently (`durationUnit: "permanent"`). Optional `reportId` resolves that report too. |
| POST | `/users/:email/unban` | Admin | Lift a ban early. |
| PATCH | `/users/role` | Main Admin | Change a user's role (Moderator excluded from this action - see the route's own comment for why Admin/Developer aren't assignable through it). |
| POST | `/users/transfer-admin` | Main Admin | Hand off the main Admin role. |

## Admin - Analytics

All under `/admin/analytics*`. The base `/admin/analytics` is Admin-level;
every sub-route (`/revenue`, `/funnel`, `/sellers`, `/inventory`,
`/buyers`, `/cancellations`, `/pipeline`, `/reports-trend`, `/export`) is
restricted to Main Admin only - Moderators can see the dashboard but not
drill into financial/detailed breakdowns.

## Developer Tools (test/sandbox mode)

| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `/developer/sandbox` | Developer | Developer's own demo listings. |
| GET / POST / DELETE | `/developer-emails*` | Main Admin | Manage which emails can register as Developer accounts. |
| POST | `/developer-emails/activate` | Firebase token | Self-activate a Developer account from an approved email. |
| GET | `/developer-emails/check/:email` | Self | Check own eligibility. |
| GET / POST / DELETE | `/developer-accounts*` | Main Admin | Manage Developer accounts directly. |
| DELETE | `/demo-data/mine` | Logged in | Wipe own demo data. |
| DELETE | `/demo-data/all` | Main Admin | Wipe all demo data site-wide. |

## Bug Reports

| Method | Path | Auth | Purpose |
|---|---|---|---|
| POST | `/bug-reports` | Staff or Developer, rate-limited | File a bug found in sandbox testing. |
| GET | `/bug-reports` / `/bug-reports/open-count` | Staff or Developer | List / count open reports. |
| PATCH | `/bug-reports/:id/status` | Admin | Update status. |
| DELETE | `/bug-reports/:id` | Admin | Remove a report. |

## Admin - Audit & Database

| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `/admin/audit-log` | Main Admin | Staff action history. |
| GET | `/admin/database/summary` | Main Admin | Collection sizes/summary. |
| GET | `/admin/database/:key/export` | Main Admin | Export a collection. |
| DELETE | `/admin/database/:key` | Main Admin, rate-limited | **Destructive** - clears a collection. |
| POST | `/admin/database/:key/import` | Main Admin, rate-limited | **Destructive** - overwrites a collection from an import file. |
| GET | `/admin/database/:key/documents` | Main Admin | Paginated, filterable list of raw documents - the browse side of the document editor. |
| GET | `/admin/database/:key/documents/:id` | Main Admin | Fetch one document. |
| PATCH | `/admin/database/:key/documents/:id` | Main Admin, rate-limited | Edit one document's fields directly. `_id` is never editable; on the `users` collection, the root Admin's own account can't be touched and no document can be set to `role: "Admin"` here (use Transfer Admin). |
| PATCH | `/admin/database/:key/bulk-update` | Main Admin, rate-limited | Set one or more fields to a fixed value across every document matching a filter (or the whole collection with no filter). Same guardrails as the single-document editor. |

---

## Errors

Errors are returned as `{ "message": "..." }` with an appropriate HTTP
status code. The final error handler never leaks stack traces to the
client - only logged server-side (and to Sentry, if `SENTRY_DSN` is set).
