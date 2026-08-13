# Courier / Delivery Setup

The delivery system supports two couriers - **Steadfast** and **Pathao** -
and two ways an order gets shipped:

1. **Seller ships directly** (Dashboard -> Orders (Ship) -> "Ship Now"):
   for an order the buyer already paid for in full online.
2. **Buyer requests delivery** (Dashboard -> My Orders -> "Request
   Delivery"): available once the buyer's booking deposit is paid. The
   buyer pays a small flat fee upfront (see `DELIVERY_FEE_BDT` below),
   enters their own address, the seller reviews and confirms it (picking
   the courier), and the courier collects the **remaining balance** as
   Cash on Delivery when the parcel arrives. Once the courier reports the
   parcel `delivered`, the order is automatically marked Paid and a "Cash
   on Delivery" payment record is added - no extra action needed.

Neither courier is required for the app to run - with no credentials set,
both simply show as "Not configured" and can't be selected. Add either or
both independently.

## Delivery request fee

```
DELIVERY_FEE_BDT=100
```

Optional - defaults to `100` if unset. This is the flat, non-refundable
amount charged via bKash before a buyer's delivery request is sent to the
seller (see `POST /bookings/:id/delivery-request` and
`POST /bkash/create-delivery-fee` in `index.js`). It's shown to the buyer
before they pay, and is not refunded automatically whether the seller
confirms, declines, or the buyer ends up not accepting the parcel - it
covers the courier's trip, not the product itself.

## Steadfast

1. Log into your Steadfast merchant dashboard and grab your API key/secret
   (Settings -> API, or similar).
2. Add to `server/server-buytop/.env`:
   ```
   STEADFAST_API_KEY=your_api_key
   STEADFAST_SECRET_KEY=your_secret_key
   # optional, only if your base URL differs from the default:
   # STEADFAST_BASE_URL=https://portal.packzy.com/api/v1
   ```
3. **Optional but recommended - webhook (real-time status updates):** in
   your Steadfast dashboard, set the delivery-status webhook URL to:
   ```
   https://YOUR_SERVER_DOMAIN/webhooks/steadfast
   ```
   If Steadfast lets you set a bearer token for that webhook, set the same
   value as `STEADFAST_WEBHOOK_TOKEN` in `.env` - without it, anyone who
   finds that URL could send fake status updates. Without a webhook at
   all, statuses still update whenever someone clicks "Refresh" on an
   order (buyer, seller, or Admin), just not automatically.

## Pathao

Pathao needs a few more pieces because delivery addresses are picked from
its own City/Zone/Area lists rather than free text.

1. Get your `client_id` / `client_secret` and your merchant
   `username` / `password` from your Pathao merchant account.
2. Add to `server/server-buytop/.env`:
   ```
   PATHAO_CLIENT_ID=your_client_id
   PATHAO_CLIENT_SECRET=your_client_secret
   PATHAO_USERNAME=your_merchant_username
   PATHAO_PASSWORD=your_merchant_password
   # optional, only if you're using Pathao's sandbox instead of production:
   # PATHAO_BASE_URL=https://courier-api-sandbox.pathao.com
   ```
3. Once those are set, restart the server and call `GET /api/v1/stores`
   yourself (e.g. with `curl`/Postman, using a token from
   `POST /aut/issue-token`) to find your `store_id`, then add:
   ```
   PATHAO_STORE_ID=your_store_id
   ```
4. **Optional - webhook:** in your Pathao merchant dashboard, set the
   webhook URL to:
   ```
   https://YOUR_SERVER_DOMAIN/webhooks/pathao
   ```
   and set the same signing secret as `PATHAO_WEBHOOK_SECRET` in `.env`.
   Pathao signs each webhook call with `X-PATHAO-Signature`
   (HMAC-SHA256 of the raw body); without `PATHAO_WEBHOOK_SECRET` set,
   the signature isn't checked at all, which is fine for local testing
   but shouldn't be left that way in production.

## A note on accuracy

`courier-steadfast.js` and `courier-pathao.js` are written against each
courier's confirmed API shape (endpoint paths, field names, auth), cross
-checked against multiple independent third-party integrations since
neither courier publishes fully public docs. The **create-order** flow for
both is the best-confirmed part. Two pieces are comparatively less
certain and worth a quick sanity check once you have real credentials:

- Pathao's order-status-check endpoint (`getStatus` in
  `courier-pathao.js`, currently `GET /api/v1/orders/:id/info`)
- The webhook signature header/scheme for each courier

If either behaves unexpectedly, everything else (delivery creation,
tracking display, manual override, per-collection backups in Database
Management) still works regardless - "Refresh" and the Admin's manual
status override in **Deliveries** are exactly the fallback for a
status-check endpoint or webhook that doesn't match.

## Where things live

- `server/server-buytop/courier-steadfast.js` / `courier-pathao.js` - the
  actual API calls, each independently swappable.
- `deliveries` MongoDB collection - one document per shipment (full
  history); a compact summary is also mirrored onto the order itself
  (`booking.delivery`) so buyer/seller order lists don't need an extra
  lookup. A pending/in-review delivery *request* (before a courier is
  actually booked) lives on `booking.deliveryRequest`.
- `payments` collection now has three types tied to an order's balance:
  `"Full"`/`"Deposit"` (Stripe/bKash, unchanged), and the new `"Delivery
  Fee"` (the flat upfront fee) and `"COD"` (the remaining balance,
  recorded automatically once a courier reports the parcel delivered).
- Buyer: **Dashboard -> My Orders** - request delivery, pay the fee, see
  live tracking once the seller confirms.
- Seller: **Dashboard -> Orders (Ship)** - ship a fully-paid order
  directly, or review/confirm/decline a buyer's delivery request.
- Admin: **Dashboard -> Deliveries** - see everything, manually refresh or
  override any shipment's status.
- Both couriers' webhook URLs are public (courier servers call them
  directly, so they can't require your app's login) but are protected by
  the shared-secret/signature checks above when configured.
