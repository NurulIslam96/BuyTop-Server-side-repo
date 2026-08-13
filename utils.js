// Pure helpers and shared constants used across route handlers. Nothing
// in this file touches the database or Express - it's safe to import
// from anywhere (routes, middleware, tests) with zero setup.

// Escapes user input before it's used inside a MongoDB regex filter (e.g.
// search-by-name). Without this, a search string containing regex
// metacharacters (., *, +, etc.) would be interpreted as a pattern
// instead of literal text - at best a confusing search, at worst a way
// to craft an expensive/catastrophic regex against the database.
const escapeRegex = (str) => str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// A booking's deposit is 10% of the item's price, paid via bKash to
// secure the item before the buyer pays (or hand-delivers cash for) the
// rest. Used when creating a booking and when validating a bKash deposit
// payment matches what's actually owed.
const DEPOSIT_RATE = 0.1;

// Rounds a money value to 2 decimal places, avoiding floating-point
// artifacts (e.g. 19.999999999998) in anything derived from a price
// calculation before it's stored or charged.
const round2 = (n) => Math.round(Number(n) * 100) / 100;

// Roles with admin-dashboard access. Full Admins and Moderators both get
// in; the finer-grained "Moderators can't do X" restrictions live in
// verifyMainAdmin instead (see index.js), not here.
const STAFF_ROLES = ["Admin", "Moderator"];

// Deterministic thread id for a product+buyer pair, so a conversation
// about the same product between the same buyer/seller always resolves
// to the same document regardless of which side opens it first.
const conversationId = (productId, buyerEmail) => `${productId}::${buyerEmail}`;

// A user counts as "Active now" if their last heartbeat landed within
// this window. The client pings roughly every 20s while a tab is open,
// focused, and the person is actually interacting with it (see
// useActivityHeartbeat), so 75s survives a couple of missed/slow pings
// without flickering, while still going stale quickly if they leave.
const ACTIVE_WINDOW_MS = 75 * 1000;

// Whether a user's activity status is visible to others right now - false
// once they've turned it off, unless they set a timer (hiddenUntil) that's
// since passed, in which case it's treated as back on (the actual flip
// back to visible:true happens lazily, on their next heartbeat).
const isActivityVisible = (userDoc) => {
  const status = userDoc?.activityStatus;
  if (!status || status.visible !== false) return true;
  if (status.hiddenUntil && new Date(status.hiddenUntil) <= new Date()) return true;
  return false;
};

// Whether `userDoc` should show as "Active now" to `viewerDoc`. Mirrors
// the reciprocity of Facebook's Active Status: turning your own status
// off also hides everyone else's from you, not just yours from them.
const isActiveTo = (userDoc, viewerDoc) => {
  if (!isActivityVisible(viewerDoc)) return false;
  if (!isActivityVisible(userDoc)) return false;
  if (!userDoc?.lastActiveAt) return false;
  // go-offline (idle timeout or tab close/sendBeacon - see
  // routes/activity-status.js) stamps this to end the active window
  // early instead of waiting for it to lapse on its own. A heartbeat
  // since then naturally overrides it without any extra bookkeeping.
  if (
    userDoc.wentOfflineAt &&
    new Date(userDoc.wentOfflineAt).getTime() >= new Date(userDoc.lastActiveAt).getTime()
  ) {
    return false;
  }
  return Date.now() - new Date(userDoc.lastActiveAt).getTime() <= ACTIVE_WINDOW_MS;
};

module.exports = {
  escapeRegex,
  DEPOSIT_RATE,
  round2,
  STAFF_ROLES,
  conversationId,
  ACTIVE_WINDOW_MS,
  isActivityVisible,
  isActiveTo,
};
