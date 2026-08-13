const express = require("express");
const { createChatCompletion, isConfigured } = require("../ai");

// Keeps every AI reply grounded in what's actually knowable about BuyTop,
// instead of the model improvising policy details (deposit %, fees,
// payment methods) that then don't match reality. Mirrors the content of
// Pages/HowItWorks/HowItWorks.js on the client - if that page changes,
// update this too.
const SUPPORT_SYSTEM_PROMPT = `You are the BuyTop support assistant. BuyTop is a resale marketplace (Bangladesh, BDT currency). Answer only questions about how BuyTop works, using these facts:

Buyer flow: browse/search a category, view a listing and the seller's profile/reviews, optionally message the seller, book the item by paying a 10% deposit via bKash (this reserves it), track the order in My Orders, meet the seller and pay the remaining 90% (bKash or cash - cash requires the seller to confirm receipt), then leave a review.

Seller flow: switch to a Seller account in Settings, add a listing (or use Bulk Upload for many at once via CSV) with photos/condition/price, respond to buyer messages, manage bookings in Orders, confirm cash payments when received, track earnings (gross sales, platform fee, net) in the Earnings dashboard, and build reputation through reviews.

Other real features: wishlist, saved searches with price-drop alerts, two-factor authentication in Settings > Security, cancellation requests (buyer requests, seller approves/declines), reporting a listing or user, blogs.

Rules:
- Keep answers short (2-4 sentences unless the question needs a list).
- If you don't know something or it's not covered above, say so plainly and suggest contacting support - never invent a policy, fee amount, or feature.
- Don't discuss anything unrelated to BuyTop.`;

const SHOPPING_SYSTEM_PROMPT = `You are BuyTop's shopping assistant, helping a buyer find real listings on the site. BuyTop is a resale marketplace (Bangladesh, BDT currency).

You have a search_products tool - use it to look up real, currently-available listings before recommending anything. Never invent a product, price, or seller - only mention items the tool actually returned, and refer to them by their exact productName. If the tool returns nothing relevant, say so honestly and suggest the buyer try different terms or browse a category instead.

Keep replies short and conversational (2-4 sentences). If useful, ask one clarifying question (budget, category) rather than guessing.`;

function createAICompanionRoutes({
  aiLimiter,
  mutationLimiter,
  verifyJWT,
  verifySeller,
  asyncHandler,
  productsCollection,
  bookingCollection,
}) {
  const router = express.Router();

  const notConfigured = (res) =>
    res.status(503).send({
      message: "The AI companion isn't set up on this server yet (missing GROQ_API_KEY).",
    });

  // The client stores extra display-only fields on assistant messages (e.g.
  // `products`, for rendering product cards under a reply) and, since it
  // keeps the whole running thread client-side, sends that same object
  // straight back as conversation history on the next turn. Anthropic's API
  // quietly ignored unknown fields on a message; Groq's OpenAI-compatible
  // API validates the shape strictly and 400s on anything beyond
  // role/content (and tool_calls/tool_call_id, for tool turns) - so those
  // extra fields have to be stripped before anything from the client is
  // forwarded on.
  const sanitizeMessages = (messages) =>
    messages
      .filter((m) => m && typeof m.role === "string" && typeof m.content === "string")
      .map((m) => ({ role: m.role, content: m.content }));

  // The one tool the shopping assistant gets - deliberately narrow (search
  // only, no way to see prices/sellers outside the normal product schema)
  // so the model can't be steered into leaking anything beyond what a
  // buyer could already see by browsing. Shaped as an OpenAI-style
  // function tool since that's what Groq's chat-completions API expects.
  //
  // `required: []` is deliberate, not a no-op: every param here is
  // genuinely optional (the model can search by keyword, category,
  // maxPrice, or any mix), but Groq's tool-schema validator 400s if
  // `required` is missing entirely rather than treating an absent key the
  // same as an empty one - every example in Groq's own tool-use docs
  // includes a `required` array, even single-parameter ones.
  const searchProductsTool = {
    type: "function",
    function: {
      name: "search_products",
      description: "Search current, available BuyTop listings by keyword, category, and/or max price.",
      parameters: {
        type: "object",
        properties: {
          keyword: { type: "string", description: "Search term to match against product name/description" },
          category: { type: "string", description: "Exact category name, if known" },
          // Groq's tool-call validator strictly enforces the declared type
          // server-side, before the call ever reaches this code - and
          // Llama 3.3 frequently emits numeric-looking args as JSON
          // strings (e.g. "5000" instead of 5000), which then fails a
          // `type: "number"` schema with a 400 we can't catch or coerce
          // after the fact. Accepting a string here (and describing the
          // expected format precisely) avoids that failure mode; the
          // value is coerced with Number(...) in runProductSearch either
          // way, so a numeric string still works correctly downstream.
          maxPrice: {
            type: "string",
            description: "Upper bound on resale price in BDT, as a plain digit string (e.g. \"5000\"). No currency symbol, commas, or units.",
          },
        },
        required: [],
      },
    },
  };

  const runProductSearch = async ({ keyword, category, maxPrice }) => {
    const filter = { status: "Available", isDemo: { $ne: true } };
    if (category) filter.category = category;
    if (maxPrice) filter.resalePrice = { $lte: Number(maxPrice) };
    if (keyword) {
      const safe = String(keyword).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      filter.$or = [
        { productName: { $regex: safe, $options: "i" } },
        { description: { $regex: safe, $options: "i" } },
      ];
    }
    const results = await productsCollection
      .find(filter)
      .project({ productName: 1, category: 1, resalePrice: 1, condition: 1, location: 1 })
      .limit(8)
      .toArray();
    return results;
  };

  // Shared tool-use loop: send messages, and if the model calls
  // search_products, run the real query and hand the results back for a
  // final answer. Capped at one round of tool calls - this is a chat
  // assistant, not an agent that needs to chain many lookups together.
  router.post(
    "/ai/shop",
    aiLimiter,
    asyncHandler(async (req, res) => {
      if (!isConfigured()) return notConfigured(res);
      const messages = sanitizeMessages(
        Array.isArray(req.body?.messages) ? req.body.messages.slice(-10) : []
      );
      if (messages.length === 0) {
        return res.status(400).send({ message: "messages is required" });
      }

      let data;
      try {
        data = await createChatCompletion({
          system: SHOPPING_SYSTEM_PROMPT,
          messages,
          tools: [searchProductsTool],
          max_tokens: 500,
        });
      } catch (err) {
        // Even a model well-suited to tool calling can occasionally emit a
        // malformed function call - Groq validates that server-side and
        // 400s before it ever reaches us, so there's nothing here to parse
        // or retry with corrected args. Retrying once with `tools` omitted
        // removes the chance of that failure mode entirely for this
        // attempt (the model can only respond with text) and still gets
        // the buyer a useful reply instead of a hard error. If this
        // second call also fails, that's a real problem (bad key, Groq
        // outage, etc.) and should surface normally.
        data = await createChatCompletion({
          system: SHOPPING_SYSTEM_PROMPT,
          messages,
          max_tokens: 500,
        });
      }
      let choice = data.choices?.[0];

      const products = [];
      const toolCall = choice?.message?.tool_calls?.[0];
      if (toolCall?.function?.name === "search_products") {
        let args = {};
        try {
          args = JSON.parse(toolCall.function.arguments || "{}");
        } catch {
          args = {};
        }
        const results = await runProductSearch(args);
        products.push(...results);
        // Deliberately NOT replaying the raw assistant tool_calls message +
        // a `role: "tool"` result back into the conversation here. That's
        // the standard OpenAI-shape pattern, but gpt-oss models use a
        // stricter internal format (separate channels for reasoning /
        // tool-calls / final text) and seeing a tool-call turn in history -
        // even with no `tools` declared this call - has been enough to
        // make the model try to route back into a tool call, which Groq
        // then rejects ("Tool choice is none, but model called a tool").
        // Folding the results into the system prompt as plain text instead
        // gives the model the same information with nothing shaped like a
        // tool exchange for it to misfire on.
        const resultsSummary = results.length
          ? JSON.stringify(
              results.map((r) => ({
                productName: r.productName,
                category: r.category,
                resalePrice: r.resalePrice,
                condition: r.condition,
              }))
            )
          : "[]";
        data = await createChatCompletion({
          system: `${SHOPPING_SYSTEM_PROMPT}\n\nYou already searched BuyTop's listings for this request. Here are the results as JSON (empty array means nothing matched): ${resultsSummary}\n\nAnswer the buyer using only these results - refer to items by their exact productName, and if the array is empty say so honestly.`,
          max_tokens: 500,
          messages,
        });
        choice = data.choices?.[0];
      }

      const text = choice?.message?.content || "";
      res.send({ reply: text, products });
    })
  );

  router.post(
    "/ai/support",
    aiLimiter,
    asyncHandler(async (req, res) => {
      if (!isConfigured()) return notConfigured(res);
      const messages = sanitizeMessages(
        Array.isArray(req.body?.messages) ? req.body.messages.slice(-10) : []
      );
      if (messages.length === 0) {
        return res.status(400).send({ message: "messages is required" });
      }
      const data = await createChatCompletion({
        system: SUPPORT_SYSTEM_PROMPT,
        messages,
        max_tokens: 400,
      });
      const text = data.choices?.[0]?.message?.content || "";
      res.send({ reply: text });
    })
  );

  // One-shot helper for sellers: rough notes in, a polished title,
  // description, and a suggested price out. Grounds the price against
  // real recent sales in the same category (not a guess) so it's a
  // genuinely useful number, not just plausible-sounding text.
  router.post(
    "/ai/seller-assist",
    mutationLimiter,
    verifyJWT,
    verifySeller,
    asyncHandler(async (req, res) => {
      if (!isConfigured()) return notConfigured(res);
      const { productName, category, condition, originalPrice, notes } = req.body || {};
      if (!productName || !category) {
        return res.status(400).send({ message: "productName and category are required" });
      }

      const comparableProductIds = (
        await productsCollection.find({ category }).project({ _id: 1 }).toArray()
      ).map((p) => String(p._id));
      const recentSales = comparableProductIds.length
        ? await bookingCollection
            .find({ productId: { $in: comparableProductIds }, status: "Paid" })
            .project({ price: 1 })
            .sort({ _id: -1 })
            .limit(20)
            .toArray()
        : [];
      const avgSalePrice = recentSales.length
        ? Math.round(recentSales.reduce((sum, b) => sum + Number(b.price || 0), 0) / recentSales.length)
        : null;

      const prompt = `Write a BuyTop listing for a seller. Respond with ONLY a JSON object, no other text, in this exact shape: {"title": string, "description": string (2-4 sentences, honest, no invented condition details), "suggestedPrice": number (BDT, integer)}.

Item: ${productName}
Category: ${category}
Condition: ${condition || "not specified"}
Original price: ${originalPrice ? `৳${originalPrice}` : "not specified"}
Seller's notes: ${notes || "none"}
${avgSalePrice ? `Recent completed sales in this category averaged ৳${avgSalePrice} - use this as a real reference point, don't ignore it.` : "No recent comparable sales data available - base the price on the original price and condition only."}`;

      const data = await createChatCompletion({
        messages: [{ role: "user", content: prompt }],
        max_tokens: 400,
      });
      const text = data.choices?.[0]?.message?.content || "{}";
      let parsed;
      try {
        parsed = JSON.parse(text.trim().replace(/^```json\s*|\s*```$/g, ""));
      } catch (err) {
        return res.status(502).send({ message: "The AI companion returned something unexpected - please try again." });
      }
      res.send(parsed);
    })
  );

  return router;
}

module.exports = createAICompanionRoutes;
