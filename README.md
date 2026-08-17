# Timvella Complete Store v3

## What is included
- Premium black storefront
- Product search/category filter
- Cart and checkout
- Cash on Delivery order creation
- SQLite database
- Secure-ish server-side admin session
- Password hashing with bcrypt
- Admin product add/delete
- Admin order list and status updates
- Helmet security headers
- Environment variable configuration

## Run
1. Install Node.js 20+.
2. Open this folder in Terminal.
3. Copy `.env.example` to `.env` and set strong values.
4. Run `npm install`
5. Run `npm start`
6. Open `http://localhost:3000`

## Important for production
- Use HTTPS.
- Set a long random SESSION_SECRET.
- Change the admin password before deployment.
- Put the app behind a production reverse proxy.
- Add rate limiting, CSRF protection where applicable, validation, backups and monitoring.
- Configure real payment using the official payment provider API/SDK on the server.
- Never put merchant secrets in `public/` or browser JavaScript.

## Payment
The project intentionally does not fake a successful online payment. A real gateway requires a merchant account and credentials. Once those are available, the payment initiation/callback flow can be connected server-side.
