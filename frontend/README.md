# Yapt - Frontend

Simple, single-page frontend for Yapt, your friendly DeFi yield tracking companion.

## Features

- Add Ethereum wallet addresses
- View discovered yield positions
- See portfolio summary with income projections
- Contextual income insight: compares your estimated annual income to NYC occupations and suggests countries where that income is comfortable (illustrative)
- Manual refresh (rate-limited to once per 5 minutes)
- Session-based user management (no accounts needed)

## Tech Stack

- Vanilla HTML/CSS/JavaScript
- No build tools or frameworks required
- Responsive design with dark theme
- REST API integration

## Structure

- `index.html` - Public landing + login/register (no dashboard markup)
- `dashboard.html` - Authenticated dashboard (wallets, positions, charts)
- `guest.html` - Guest view for a predefined wallet
- `admin.html` - Admin tools
- `notifications.html` - Notification settings
- `styles.css` - Dark theme styling
- `auth.js` - Auth/session handling and redirects
- `app.js` - Dashboard logic and API integration
 - `data/nyc-salary-bands.json` - NYC occupation salary bands (10k increments)
 - `data/income-location-bands.json` - Countries grouped by average income bands (10k increments)

## Run Locally

This frontend is served independently from the backend.

1) Configure the API base (defaults to `http://localhost:3000/api`):

- Edit `frontend/config.js` if your backend runs elsewhere.

2) Start a simple static server for the UI:

```bash
cd frontend
npm start
```

Open http://localhost:5173 in your browser.

## API Endpoints Used

- `POST /api/wallets` - Add a new wallet
- `GET /api/wallets` - List user's wallets
- `GET /api/positions` - Get positions with metrics
- `GET /api/portfolio/summary` - Portfolio summary
- `POST /api/portfolio/refresh` - Manual refresh

Notes
- CORS is enabled on the backend, so serving the UI on a different port works out of the box.
- No build step required; this is plain static HTML/CSS/JS.
