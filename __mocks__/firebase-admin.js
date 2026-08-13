// Manual mock - only used when a test file explicitly calls
// jest.mock("firebase-admin"). See test-support/fakeAuth.js for
// why this exists and what it deliberately doesn't cover.
const fakeAuth = require("../test-support/fakeAuth");

module.exports = {
  initializeApp: jest.fn(),
  cert: jest.fn((serviceAccount) => serviceAccount),
  credential: {
    cert: jest.fn((serviceAccount) => serviceAccount),
  },
  // index.js immediately overwrites this with `admin.auth = () =>
  // getAuth()` (see __mocks__/firebase-admin/auth.js), but it's defined
  // here too so nothing breaks if some other file calls admin.auth()
  // before that reassignment happens to run.
  auth: () => fakeAuth,
};
