// A single shared fake auth object, used by both __mocks__/firebase-admin.js
// and __mocks__/firebase-admin/auth.js so admin.auth() (see index.js's
// `admin.auth = () => getAuth()` rewiring for firebase-admin v14) resolves
// to the exact same mock instance real route code actually calls.
//
// Integration tests never talk to a real Firebase project - there's no way
// to mint a real, verifiable ID token for a throwaway test user without
// one. Instead, tests exercise the app's OWN JWT layer (verifyJWT, signed
// with ACCESS_TOKEN) directly, which is what the vast majority of routes
// actually require - only the initial /user/:email login/signup call
// needs a real Firebase ID token (verifyFirebaseToken), so that one route
// is intentionally out of scope for these tests. See
// __tests__/integration/README.md for the full explanation.
const fakeAuth = {
  verifyIdToken: jest.fn().mockRejectedValue(new Error("verifyIdToken is not mocked for this test")),
  getUserByEmail: jest.fn().mockRejectedValue(new Error("getUserByEmail is not mocked for this test")),
  getUser: jest.fn().mockRejectedValue(new Error("getUser is not mocked for this test")),
  listUsers: jest.fn().mockResolvedValue({ users: [] }),
  updateUser: jest.fn().mockResolvedValue({}),
  createUser: jest.fn().mockResolvedValue({}),
  deleteUser: jest.fn().mockResolvedValue({}),
  setCustomUserClaims: jest.fn().mockResolvedValue({}),
};

module.exports = fakeAuth;
