// Manual mock for the firebase-admin/auth subpath - only used when a test
// file explicitly calls jest.mock("firebase-admin/auth"). index.js does
// `admin.auth = () => getAuth()`, so this is what admin.auth() actually
// resolves to at runtime once that reassignment has run. Same shared
// fakeAuth as __mocks__/firebase-admin.js, so both mocks agree.
const fakeAuth = require("../../test-support/fakeAuth");

module.exports = {
  getAuth: () => fakeAuth,
};
