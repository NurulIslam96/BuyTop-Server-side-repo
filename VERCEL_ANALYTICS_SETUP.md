# Vercel Web Analytics Setup Guide

## Overview
This document provides instructions for integrating Vercel Web Analytics with the BuyTop application. Since this repository contains the **backend API server**, the Web Analytics package needs to be configured on the **frontend client application** that consumes this API.

## Backend Setup (Completed)
✅ The `@vercel/analytics` package has been installed in this backend project (version ^2.0.1)
✅ Package dependencies updated in package.json and package-lock.json

## Frontend Integration Required

Vercel Web Analytics tracks page views and user interactions in the browser. To enable analytics for the BuyTop application, you need to integrate the analytics component in your **frontend application**.

### For Next.js Frontend (App Router)
If your frontend uses Next.js with the App Router, add the Analytics component to your root layout:

```typescript
import { Analytics } from '@vercel/analytics/next';

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body>
        {children}
        <Analytics />
      </body>
    </html>
  );
}
```

### For Next.js Frontend (Pages Router)
If your frontend uses Next.js with the Pages Router, add to `_app.js` or `_app.tsx`:

```typescript
import { Analytics } from '@vercel/analytics/next';

function MyApp({ Component, pageProps }) {
  return (
    <>
      <Component {...pageProps} />
      <Analytics />
    </>
  );
}

export default MyApp;
```

### For React Frontend
If your frontend is a React application:

```typescript
import { Analytics } from '@vercel/analytics/react';

export default function App() {
  return (
    <div>
      {/* Your app content */}
      <Analytics />
    </div>
  );
}
```

### For Vue Frontend
If your frontend uses Vue:

```vue
<script setup>
import { Analytics } from '@vercel/analytics/vue';
</script>

<template>
  <Analytics />
  <!-- Your app content -->
</template>
```

### For Vanilla JavaScript/HTML Frontend
If your frontend is plain HTML/JavaScript:

```html
<script>
  window.va = window.va || function () { (window.vaq = window.vaq || []).push(arguments); };
</script>
<script defer src="/_vercel/insights/script.js"></script>
```

## Vercel Dashboard Configuration

1. **Enable Web Analytics** in your Vercel project dashboard:
   - Navigate to your project on Vercel
   - Go to the Analytics tab
   - Click "Enable Web Analytics"
   - This adds routes at `/_vercel/insights/*` after deployment

2. **Deploy** your frontend application to Vercel

3. **Verify** the integration:
   - Visit your deployed application
   - Open browser DevTools → Network tab
   - Look for requests to `/_vercel/insights/view` or similar endpoints
   - Check the Vercel Analytics dashboard for incoming data

## Custom Events (Optional)
Once basic analytics are working, you can track custom events from your frontend:

```typescript
import { track } from '@vercel/analytics';

// Track custom events
track('purchase_completed', { product: 'Product Name', amount: 99.99 });
track('user_signup', { method: 'email' });
```

## Backend API Considerations
This backend API server doesn't directly use Web Analytics, but it can:
- Serve analytics configuration to the frontend via API endpoints
- Log server-side events that complement frontend analytics
- Provide data for custom analytics dashboards

## Additional Resources
- [Vercel Web Analytics Documentation](https://vercel.com/docs/analytics)
- [Vercel Analytics Quickstart Guide](https://vercel.com/docs/analytics/quickstart)
- [Analytics Package API Reference](https://vercel.com/docs/analytics/package)

## Notes
- Analytics data appears in the Vercel dashboard after deployment
- The free tier includes basic analytics; paid plans offer advanced features
- Analytics respect user privacy and comply with GDPR
- No cookies are used for tracking
