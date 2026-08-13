const { savedSearchMatches } = require("../validation");

// This is the exact function that decides whether a buyer gets a
// price-alert notification/email when a new product is listed (see
// notifyMatchingSavedSearches in routes/products.js) - a false positive
// spams buyers, a false negative means an alert silently never fires.
// Worth pinning down precisely.

describe("savedSearchMatches", () => {
  const product = {
    email: "seller@example.com",
    productName: "ThinkPad X1 Carbon",
    description: "Lightly used ultrabook, great battery life",
    resalePrice: 45000,
  };

  test("matches when the search has no keyword or price ceiling", () => {
    expect(savedSearchMatches(product, { email: "buyer@example.com" })).toBe(true);
  });

  test("matches a keyword found in the product name", () => {
    expect(
      savedSearchMatches(product, { email: "buyer@example.com", keyword: "thinkpad" })
    ).toBe(true);
  });

  test("matches a keyword found only in the description", () => {
    expect(
      savedSearchMatches(product, { email: "buyer@example.com", keyword: "battery" })
    ).toBe(true);
  });

  test("keyword matching is case-insensitive", () => {
    expect(
      savedSearchMatches(product, { email: "buyer@example.com", keyword: "THINKPAD" })
    ).toBe(true);
  });

  test("rejects when the keyword isn't in name or description", () => {
    expect(
      savedSearchMatches(product, { email: "buyer@example.com", keyword: "gaming desktop" })
    ).toBe(false);
  });

  test("matches when the price is at or under the ceiling", () => {
    expect(savedSearchMatches(product, { email: "buyer@example.com", maxPrice: 45000 })).toBe(true);
    expect(savedSearchMatches(product, { email: "buyer@example.com", maxPrice: 50000 })).toBe(true);
  });

  test("rejects when the price is over the ceiling", () => {
    expect(savedSearchMatches(product, { email: "buyer@example.com", maxPrice: 30000 })).toBe(false);
  });

  test("never matches the seller's own saved search on their own listing", () => {
    expect(
      savedSearchMatches(product, { email: "seller@example.com", maxPrice: 999999 })
    ).toBe(false);
  });

  test("requires both keyword and price conditions to pass when both are set", () => {
    const search = { email: "buyer@example.com", keyword: "thinkpad", maxPrice: 30000 };
    expect(savedSearchMatches(product, search)).toBe(false); // name matches, price doesn't
  });
});
