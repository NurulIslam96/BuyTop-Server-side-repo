"# BuyTop-Server-side-repo

## Backend API Server for BuyTop Application

This is the Express.js backend server for the BuyTop e-commerce platform.

### Features
- User authentication with JWT
- MongoDB database integration
- Stripe payment processing
- Product and category management
- Booking system
- Admin and seller verification
- Product reporting system

### Analytics Integration
✅ **Vercel Web Analytics** has been configured for this project.

**Note:** Since this is a backend API server, the actual Web Analytics component needs to be integrated in your frontend application. See [VERCEL_ANALYTICS_SETUP.md](./VERCEL_ANALYTICS_SETUP.md) for detailed frontend integration instructions.

### Environment Variables
Required environment variables:
- `DB_USER` - MongoDB username
- `DB_PASSWORD` - MongoDB password
- `ACCESS_TOKEN` - JWT secret key
- `STRIPE_KEY` - Stripe API key
- `PORT` - Server port (defaults to 5000)

### Installation
```bash
npm install
```

### Running the Server
```bash
npm start
```

### Deployment
This server is configured for deployment on Vercel using the Node.js runtime." 
