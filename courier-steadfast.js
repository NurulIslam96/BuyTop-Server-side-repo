// NOT ACTIVE

const axios = require("axios");

/**
 * Steadfast Courier integration (Bangladesh).
 *
 * Steadfast doesn't publish public docs, but this shape is confirmed
 * consistently across every third-party package/plugin built against it
 * (their own WordPress plugin, several Laravel packages, npm clients).
 *
 * Base URL:  https://portal.packzy.com/api/v1
 *            (portal.steadfast.com.bd/api/v1 is the same service under
 *            their newer domain - either works; override with
 *            STEADFAST_BASE_URL if yours differs)
 * Auth:      headers "Api-Key" / "Secret-Key", from your Steadfast
 *            merchant dashboard -> API
 *
 * Required env vars (see SETUP-COURIERS.md):
 *   STEADFAST_BASE_URL     (optional, defaults above)
 *   STEADFAST_API_KEY
 *   STEADFAST_SECRET_KEY
 *   STEADFAST_WEBHOOK_TOKEN (optional - see POST /webhooks/steadfast in index.js)
 */

const BASE_URL = process.env.STEADFAST_BASE_URL || "https://portal.packzy.com/api/v1";

const isConfigured = () =>
  Boolean(process.env.STEADFAST_API_KEY && process.env.STEADFAST_SECRET_KEY);

const client = () =>
  axios.create({
    baseURL: BASE_URL,
    headers: {
      "Api-Key": process.env.STEADFAST_API_KEY,
      "Secret-Key": process.env.STEADFAST_SECRET_KEY,
      "Content-Type": "application/json",
    },
    timeout: 15000,
  });

// axios errors carry the real Steadfast error body in error.response.data;
// fall back to the raw message for network-level failures (DNS, timeout).
const extractErrorDetail = (error) => {
  if (error.response?.data) {
    return typeof error.response.data === "string"
      ? error.response.data
      : JSON.stringify(error.response.data);
  }
  return error.message;
};

// Normalizes Steadfast's delivery_status values down to the small set this
// app displays/filters on. courier-pathao.js's mapStatus funnels into the
// same normalized set, so the rest of the app never has to know which
// courier a given shipment actually used.
const STATUS_MAP = {
  pending: "pending",
  in_review: "in_review",
  delivered: "delivered",
  partial_delivered: "partial_delivered",
  cancelled: "cancelled",
  hold: "hold",
};
const mapStatus = (raw) => STATUS_MAP[String(raw || "").toLowerCase()] || "unknown";

async function createDelivery({
  invoice,
  recipientName,
  recipientPhone,
  recipientAddress,
  itemDescription,
  codAmount,
  note,
}) {
  if (!isConfigured()) {
    throw new Error("Steadfast isn't configured - add STEADFAST_API_KEY/STEADFAST_SECRET_KEY to .env");
  }
  try {
    const { data } = await client().post("/create_order", {
      invoice,
      recipient_name: recipientName,
      recipient_phone: recipientPhone,
      recipient_address: recipientAddress,
      cod_amount: Number(codAmount) || 0,
      note: note || "",
      item_description: itemDescription || "",
    });
    const c = data?.consignment || {};
    return {
      consignmentId: c.consignment_id != null ? String(c.consignment_id) : null,
      trackingCode: c.tracking_code || null,
      trackingUrl: c.tracking_code ? `https://steadfast.com.bd/t/${c.tracking_code}` : null,
      status: mapStatus(c.status || "pending"),
      raw: data,
    };
  } catch (error) {
    throw new Error(`Steadfast: ${extractErrorDetail(error)}`);
  }
}

// consignmentId is preferred (status_by_cid); falls back to trackingCode
// (status_by_trackingcode) if that's all that's on hand.
async function getStatus(consignmentId, trackingCode) {
  if (!isConfigured()) {
    throw new Error("Steadfast isn't configured - add STEADFAST_API_KEY/STEADFAST_SECRET_KEY to .env");
  }
  try {
    const path = consignmentId
      ? `/status_by_cid/${consignmentId}`
      : `/status_by_trackingcode/${trackingCode}`;
    const { data } = await client().get(path);
    return { status: mapStatus(data?.delivery_status), raw: data };
  } catch (error) {
    throw new Error(`Steadfast: ${extractErrorDetail(error)}`);
  }
}

module.exports = { isConfigured, createDelivery, getStatus, mapStatus };
