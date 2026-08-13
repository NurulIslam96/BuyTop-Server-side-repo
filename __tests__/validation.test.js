const { addProductSchema, money, nonEmptyString } = require("../validation");

describe("money", () => {
  test("accepts a positive number", () => {
    expect(money.parse(500)).toBe(500);
  });

  test("coerces a numeric string (HTML number inputs arrive as strings)", () => {
    expect(money.parse("1500")).toBe(1500);
  });

  test("rejects zero and negative amounts", () => {
    expect(() => money.parse(0)).toThrow();
    expect(() => money.parse(-100)).toThrow();
  });

  test("rejects non-numeric input", () => {
    expect(() => money.parse("free")).toThrow();
  });

  test("rejects an absurdly large value", () => {
    expect(() => money.parse(1e20)).toThrow();
  });
});

describe("nonEmptyString", () => {
  test("accepts a normal string within the length cap", () => {
    expect(nonEmptyString(10).parse("hello")).toBe("hello");
  });

  test("rejects an empty string", () => {
    expect(() => nonEmptyString(10).parse("")).toThrow();
  });

  test("rejects a string over the length cap", () => {
    expect(() => nonEmptyString(5).parse("toolongforthis")).toThrow();
  });
});

describe("addProductSchema", () => {
  const validProduct = {
    productName: "ThinkPad X1 Carbon",
    purchaseYear: 2022,
    condition: "Used - Good",
    location: "Dhaka",
    phone: "01700000000",
    description: "A well-maintained laptop.",
    images: ["https://example.com/photo1.jpg"],
    originalPrice: 80000,
    resalePrice: 55000,
    category: "Laptop",
  };

  test("accepts a valid, complete product payload", () => {
    const result = addProductSchema.safeParse(validProduct);
    expect(result.success).toBe(true);
  });

  test("rejects a payload missing a required field", () => {
    const { productName, ...withoutName } = validProduct;
    const result = addProductSchema.safeParse(withoutName);
    expect(result.success).toBe(false);
  });

  test("rejects a non-positive resalePrice (the field an attacker would tamper with)", () => {
    const result = addProductSchema.safeParse({ ...validProduct, resalePrice: 0 });
    expect(result.success).toBe(false);
  });

  test("rejects an empty images array", () => {
    const result = addProductSchema.safeParse({ ...validProduct, images: [] });
    expect(result.success).toBe(false);
  });

  test("rejects a non-URL image entry", () => {
    const result = addProductSchema.safeParse({ ...validProduct, images: ["not-a-url"] });
    expect(result.success).toBe(false);
  });

  test("strips fields not defined in the schema instead of erroring", () => {
    const result = addProductSchema.safeParse({
      ...validProduct,
      someUnexpectedField: "should be dropped",
    });
    expect(result.success).toBe(true);
    expect(result.data.someUnexpectedField).toBeUndefined();
  });

  test("client-forgeable fields (email/status/isVerified) pass through only when well-formed - the route itself still overwrites them from server-side truth", () => {
    const result = addProductSchema.safeParse({
      ...validProduct,
      email: "seller@example.com",
      status: "Available",
      isVerified: true,
    });
    expect(result.success).toBe(true);
  });
});
