# BuyTop - Server

Express + MongoDB backend for the BuyTop resale marketplace. Auth is
verified server-side against Firebase ID tokens (see `verifyFirebaseToken`
in `index.js`) - the server never trusts a client-supplied email/role
without checking it against Firebase and/or the database.

## Requirements

- Node.js 18+
- A MongoDB cluster (Atlas recommended)
- A Firebase project (Authentication enabled, service account key generated)
- bKash merchant credentials (sandbox for development, live for production)

## Environment variables

Copy `.env.example` to `.env` and fill in real values. At minimum,
`DB_USER`, `DB_PASSWORD`, `ACCESS_TOKEN`, and `FIREBASE_SERVICE_ACCOUNT_KEY`
are required at startup - the server will refuse to start without them and
will tell you exactly which ones are missing.

`FIREBASE_SERVICE_ACCOUNT_KEY` is the full service-account JSON (Firebase
Console -> Project Settings -> Service Accounts -> Generate new private
key), stored as a single-line JSON string.

## Running locally

```
npm install
npm start
```

## API Reference

See `API_REFERENCE.md` for every route, grouped by domain, with its
auth requirements.

## Currency

Product prices are stored and charged in BDT (Bangladeshi Taka) directly -
there is no USD/BDT conversion anywhere in this codebase. `bkash.js`
passes the stored price straight through to bKash's checkout API.

## Payments

- bKash Tokenized Checkout for the mandatory 10% booking deposit and for
  paying the remaining balance.
- Hand cash, flagged by the buyer and confirmed by the seller
  (`POST /bookings/:id/pay-cash` then `POST /bookings/:id/confirm-cash-payment`).

## Admin access

There is no seeded/default admin account. Promote the first Admin by
setting `role: "Admin"` directly on a user document in MongoDB; every
Admin account after that can be promoted from the Dashboard.
