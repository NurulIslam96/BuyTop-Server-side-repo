const axios = require("axios");

// Groq (https://console.groq.com) instead of Anthropic - same AI-companion
// feature (shopping assistant, support/FAQ bot, seller listing helper), but
// on a genuinely free tier: no credit card, no trial period that expires,
// just a rate limit (30 requests/min, 14,400/day at last check - plenty for
// a feature like this). Grab a key at https://console.groq.com/keys and set
// GROQ_API_KEY in .env to turn the AI companion on.
//
// Groq's API is OpenAI-compatible (chat completions with the same
// messages/tools/tool_calls shapes), which is why createChatCompletion below
// talks in that shape rather than Anthropic's - the rest of ai-companion.js
// was rewritten to match.
const GROQ_API_KEY = process.env.GROQ_API_KEY;
const GROQ_BASE_URL = "https://api.groq.com/openai/v1";

// OpenAI's gpt-oss-20b - open-weight, natively trained for OpenAI-style
// function calling (it's an OpenAI model, just open-weight), still on
// Groq's free tier. Swapped in from Llama 3.3 70B: Llama 3.3's tool-calling
// has a well-documented failure mode on Groq where it occasionally wraps
// the call in non-JSON `<function=name{...}>` tags instead of a clean
// tool_calls object, which Groq's strict parser then 400s on with "Failed
// to call a function" - not something fixable via prompt or schema
// changes, since the malformed output never reaches your code. gpt-oss
// doesn't share that quirk. If you ever need more headroom or reasoning
// depth, "openai/gpt-oss-120b" is the larger sibling (same tool-calling
// behavior, still Groq-hosted).
const MODEL = "openai/gpt-oss-20b";

const isConfigured = () => !!GROQ_API_KEY;

/**
 * Sends a chat completion request to Groq. `messages` and `tools` follow
 * the standard OpenAI chat-completions shape (tools as
 * `{ type: "function", function: { name, description, parameters } }`).
 * `system`, if given, is prepended as a system message.
 */
async function createChatCompletion({ system, messages, tools, max_tokens }) {
  const chatMessages = system ? [{ role: "system", content: system }, ...messages] : messages;

  try {
    const { data } = await axios.post(
      `${GROQ_BASE_URL}/chat/completions`,
      {
        model: MODEL,
        max_tokens,
        messages: chatMessages,
        ...(tools ? { tools, tool_choice: "auto" } : {}),
      },
      {
        headers: {
          Authorization: `Bearer ${GROQ_API_KEY}`,
          "Content-Type": "application/json",
        },
      }
    );
    return data;
  } catch (error) {
    // axios errors carry the real, useful Groq error body in
    // error.response.data (e.g. {"error":{"message":"...","type":"...",
    // "code":"..."}}) - but that's 3+ levels deep, past what Node's default
    // console.error(err) depth prints, so it always looked like
    // `data: { error: [Object] }` in server logs with no way to tell what
    // was actually wrong. Re-throwing a plain Error with that message
    // pulled to the top makes the real reason show up in the logs (and in
    // the generic 500 body, for anyone testing with the network tab open)
    // instead of a multi-thousand-line dump of the Axios internals.
    const groqMessage = error.response?.data?.error?.message;
    throw new Error(
      groqMessage
        ? `Groq API error (${error.response.status}): ${groqMessage}`
        : `Groq API request failed: ${error.message}`
    );
  }
}

module.exports = { createChatCompletion, MODEL, isConfigured };
