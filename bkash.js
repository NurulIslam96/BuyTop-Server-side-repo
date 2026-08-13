const axios = require("axios");

/**
 * bKash Tokenized Checkout (Payment Gateway) integration.
 * Docs: https://developer.bka.sh/docs/tokenized-checkout-url-flow
 *
 * Required env vars (see .env.example):
 *   BKASH_BASE_URL   - sandbox: https://tokenized.sandbox.bka.sh/v1.2.0-beta
 *                       live:    https://tokenized.pay.bka.sh/v1.2.0-beta
 *   BKASH_USERNAME
 *   BKASH_PASSWORD
 *   BKASH_APP_KEY
 *   BKASH_APP_SECRET
 *
 * NOTE: bKash charges in BDT (Bangladeshi Taka). Product prices in this
 * project are stored and entered directly in BDT (see client Add Product
 * form and price displays, which use the ৳ symbol) - so the numeric price
 * on a product/booking is passed straight through to createPayment with
 * no currency conversion needed.
 */

const BASE_URL = process.env.BKASH_BASE_URL || "https://tokenized.sandbox.bka.sh/v1.2.0-beta";

let cachedToken = null; // { idToken, refreshToken, expiresAt }

function extractErrorDetail(error) {
  // axios errors carry the real bKash error body in error.response.data;
  // fall back to the raw message for network-level failures (DNS, timeout).
  if (error.response?.data) {
    return typeof error.response.data === "string"
      ? error.response.data
      : JSON.stringify(error.response.data);
  }
  return error.message;
}

async function grantToken() {
  let data;
  try {
    ({ data } = await axios.post(
      `${BASE_URL}/tokenized/checkout/token/grant`,
      {
        app_key: process.env.BKASH_APP_KEY,
        app_secret: process.env.BKASH_APP_SECRET,
      },
      {
        headers: {
          username: process.env.BKASH_USERNAME,
          password: process.env.BKASH_PASSWORD,
          "Content-Type": "application/json",
        },
      }
    ));
  } catch (error) {
    throw new Error("bKash: grant token request failed - " + extractErrorDetail(error));
  }

  if (!data?.id_token) {
    throw new Error("bKash: failed to obtain token - " + JSON.stringify(data));
  }

  cachedToken = {
    idToken: data.id_token,
    refreshToken: data.refresh_token,
    // id_token is valid ~1hr; refresh a bit early to be safe
    expiresAt: Date.now() + (Number(data.expires_in || 3600) - 60) * 1000,
  };
  return cachedToken.idToken;
}

async function getToken() {
  if (cachedToken && cachedToken.expiresAt > Date.now()) {
    return cachedToken.idToken;
  }
  return grantToken();
}

async function bkashHeaders() {
  const token = await getToken();
  return {
    Authorization: token,
    "X-App-Key": process.env.BKASH_APP_KEY,
    "Content-Type": "application/json",
  };
}

/**
 * Creates a bKash payment session and returns the checkout URL to redirect
 * the buyer to.
 * @param {number} amount - amount in BDT (see currency note above)
 * @param {string} invoiceNumber - your own unique order/booking id
 * @param {string} callbackURL - where bKash redirects back after checkout
 */
async function createPayment(amount, invoiceNumber, callbackURL) {
  const headers = await bkashHeaders();
  try {
    const { data } = await axios.post(
      `${BASE_URL}/tokenized/checkout/create`,
      {
        mode: "0011",
        payerReference: invoiceNumber,
        callbackURL,
        amount: String(amount),
        currency: "BDT",
        intent: "sale",
        merchantInvoiceNumber: invoiceNumber,
      },
      { headers }
    );
    return data; // includes paymentID, bkashURL
  } catch (error) {
    throw new Error("bKash: create payment failed - " + extractErrorDetail(error));
  }
}

/** Executes (confirms) a payment after the buyer approves it in the bKash flow. */
async function executePayment(paymentID) {
  const headers = await bkashHeaders();
  try {
    const { data } = await axios.post(
      `${BASE_URL}/tokenized/checkout/execute`,
      { paymentID },
      { headers }
    );
    return data;
  } catch (error) {
    throw new Error("bKash: execute payment failed - " + extractErrorDetail(error));
  }
}

/** Looks up the current status of a payment - useful for reconciliation. */
async function queryPayment(paymentID) {
  const headers = await bkashHeaders();
  try {
    const { data } = await axios.post(
      `${BASE_URL}/tokenized/checkout/payment/status`,
      { paymentID },
      { headers }
    );
    return data;
  } catch (error) {
    throw new Error("bKash: query payment failed - " + extractErrorDetail(error));
  }
}

module.exports = { createPayment, executePayment, queryPayment };