// NOT ACTIVE


const axios = require("axios");

/**
 * Pathao Courier (Merchant) API integration (Bangladesh).
 *
 * Pathao's own docs are only visible once logged into the merchant portal.
 * This mirrors the shape confirmed consistently across several independent
 * third-party Pathao packages (PyPI pathao-courier-api, Packagist
 * enan/pathao-courier and codeboxr/pathao-courier, nayemuf/pathao-courier).
 *
 * Auth:  OAuth2 "password" grant against POST /aut/issue-token, cached
 *        here and re-issued automatically once it's close to expiring.
 *        (Pathao does also support a refresh_token grant, but simply
 *        re-issuing with the same credentials is one call either way and
 *        avoids tracking a second expiry.)
 *
 * Required env vars (see SETUP-COURIERS.md):
 *   PATHAO_BASE_URL       (optional; defaults to production below)
 *   PATHAO_CLIENT_ID
 *   PATHAO_CLIENT_SECRET
 *   PATHAO_USERNAME
 *   PATHAO_PASSWORD
 *   PATHAO_STORE_ID       - your registered pickup store's ID
 *                           (GET /api/v1/stores once you're authenticated)
 *   PATHAO_WEBHOOK_SECRET (optional - see POST /webhooks/pathao in index.js)
 *
 * A NOTE ON THE TWO LEAST-CERTAIN PIECES HERE: the token/city/zone/area/
 * order-create shape below is confirmed against multiple independent
 * integrations and is very unlikely to have changed. The exact path for
 * *checking* an existing order's status (getStatus, below) and the
 * webhook signature header name are individually less-independently
 * confirmed - once you have real credentials, sanity-check both of those
 * against the current docs in your Pathao merchant dashboard and adjust
 * here (and the /webhooks/pathao route in index.js) if they differ.
 */

const BASE_URL = process.env.PATHAO_BASE_URL || "https://courier-api-sandbox.pathao.com";

const isConfigured = () =>
  Boolean(
    process.env.PATHAO_CLIENT_ID &&
      process.env.PATHAO_CLIENT_SECRET &&
      process.env.PATHAO_USERNAME &&
      process.env.PATHAO_PASSWORD &&
      process.env.PATHAO_STORE_ID
  );

let cachedToken = null; // { accessToken, expiresAt }

const extractErrorDetail = (error) => {
  if (error.response?.data) {
    return typeof error.response.data === "string"
      ? error.response.data
      : JSON.stringify(error.response.data);
  }
  return error.message;
};

async function issueToken() {
  const { data } = await axios.post(`${BASE_URL}/aut/issue-token`, {
    client_id: process.env.PATHAO_CLIENT_ID,
    client_secret: process.env.PATHAO_CLIENT_SECRET,
    username: process.env.PATHAO_USERNAME,
    password: process.env.PATHAO_PASSWORD,
    grant_type: "password",
  });
  cachedToken = {
    accessToken: data.access_token,
    // Refresh a minute early rather than cutting it exactly at expiry -
    // Pathao's tokens are typically long-lived (days), so this is cheap.
    expiresAt: Date.now() + (Number(data.expires_in) || 432000) * 1000 - 60000,
  };
  return cachedToken.accessToken;
}

async function getToken() {
  if (cachedToken && cachedToken.expiresAt > Date.now()) {
    return cachedToken.accessToken;
  }
  return issueToken();
}

async function authedClient() {
  const token = await getToken();
  return axios.create({
    baseURL: BASE_URL,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    timeout: 15000,
  });
}

// Pathao wraps list responses as { message, type, code, data: { data: [...] } }
// (and sometimes just { data: [...] }) depending on the endpoint - this
// unwraps whichever shape comes back.
const unwrapList = (payload) => payload?.data?.data ?? payload?.data ?? [];

const STATUS_MAP = {
  pending: "pending",
  picked: "picked_up",
  "picked up": "picked_up",
  "at the sorting hub": "in_transit",
  "in transit": "in_transit",
  "received at last mile hub": "in_transit",
  "assigned for delivery": "in_transit",
  delivered: "delivered",
  partial_delivered: "partial_delivered",
  "partial delivered": "partial_delivered",
  return: "returned",
  "delivery failed": "returned",
  "on hold": "hold",
  cancelled: "cancelled",
};
const mapStatus = (raw) => STATUS_MAP[String(raw || "").toLowerCase()] || "unknown";

async function getCities() {
  const http = await authedClient();
  const { data } = await http.get("/api/v1/city-list");
  return unwrapList(data);
}

async function getZones(cityId) {
  const http = await authedClient();
  const { data } = await http.get(`/api/v1/cities/${cityId}/zone-list`);
  return unwrapList(data);
}

async function getAreas(zoneId) {
  const http = await authedClient();
  const { data } = await http.get(`/api/v1/zones/${zoneId}/area-list`);
  return unwrapList(data);
}

async function createDelivery({
  invoice,
  recipientName,
  recipientPhone,
  recipientAddress,
  city,
  zone,
  area,
  weightKg,
  itemDescription,
  codAmount,
  note,
}) {
  if (!isConfigured()) {
    throw new Error("Pathao isn't configured - add PATHAO_CLIENT_ID/SECRET/USERNAME/PASSWORD/STORE_ID to .env");
  }
  if (!city || !zone || !area) {
    throw new Error("Pathao requires a City/Zone/Area selected from its own location list");
  }
  try {
    const http = await authedClient();
    const { data } = await http.post("/api/v1/orders", {
      store_id: Number(process.env.PATHAO_STORE_ID),
      merchant_order_id: invoice,
      recipient_name: recipientName,
      recipient_phone: recipientPhone,
      recipient_address: recipientAddress,
      recipient_city: Number(city),
      recipient_zone: Number(zone),
      recipient_area: Number(area),
      delivery_type: 48, // 48 = normal delivery; 12 = on-demand
      item_type: 2, // 2 = parcel; 1 = document
      special_instruction: note || "",
      item_quantity: 1,
      item_weight: Number(weightKg) || 0.5,
      amount_to_collect: Number(codAmount) || 0,
      item_description: itemDescription || "",
    });
    const d = data?.data || data || {};
    return {
      consignmentId: d.consignment_id || null,
      trackingCode: d.consignment_id || null, // Pathao tracks by consignment_id directly
      trackingUrl: null, // Pathao has no public tracking-by-code URL like Steadfast's
      status: mapStatus(d.order_status),
      raw: data,
    };
  } catch (error) {
    throw new Error(`Pathao: ${extractErrorDetail(error)}`);
  }
}

async function getStatus(consignmentId) {
  if (!isConfigured()) {
    throw new Error("Pathao isn't configured - add PATHAO_CLIENT_ID/SECRET/USERNAME/PASSWORD/STORE_ID to .env");
  }
  try {
    const http = await authedClient();
    const { data } = await http.get(`/api/v1/orders/${consignmentId}/info`);
    const d = data?.data || data || {};
    return { status: mapStatus(d.order_status), raw: data };
  } catch (error) {
    throw new Error(`Pathao: ${extractErrorDetail(error)}`);
  }
}

module.exports = { isConfigured, createDelivery, getStatus, getCities, getZones, getAreas, mapStatus };
