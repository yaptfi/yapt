# DeFi Passive Income Tracker (Backend)

A DeFi passive income tracker that automatically discovers and tracks yield positions from Ethereum wallets. The system runs hourly updates to calculate true APY from realized value changes (excluding deposits/withdrawals) and projects stablecoin-denominated income.

Core Purpose: Answer "Can I live off this?" by tracking liquid, spendable stablecoin yield across DeFi protocols.

Development Focus: Backend service functionality and data accuracy. The frontend is a minimal interface for testing and monitoring and now lives under `frontend/` as a separate static app.

User Management: ⚠️ NOT IMPLEMENTED YET. Currently all users see all wallets and positions (no session isolation). This is intentional for MVP - proper authentication and multi-tenancy will be added later.

## Features

- Auto-discovery: Scans Ethereum wallets for yield positions across supported protocols
- True APY Calculation: Computes actual APY from realized value changes, excluding deposits/withdrawals
- Income Projections: Provides daily/monthly/yearly income estimates at position and portfolio level
- Time-series Tracking: Maintains historical data for charts and APY trends
- Hourly Updates: Automatically updates all positions every hour
- Stablecoin-focused: Tracks only liquid, spendable stablecoin yield

## Supported Protocols

- Aave v3: USDC, USDT, DAI, crvUSD lending positions
- Curve Savings: sCrvUSD (rebase token)
- Convex cvxCRV: Staked cvxCRV earning crvUSD rewards (partial counting - only stable rewards tracked)
- Convex Curve Vaults: 8 cvcrvUSD vaults with different collateral: sDOLA, sfrxUSD, sUSDe, fxSAVE, WBTC, sreUSD, wstETH, WETH

## Tech Stack

- Backend: Node.js + TypeScript + Fastify
- Database: PostgreSQL
- Blockchain: ethers.js v6 (Ethereum mainnet)
- Job Queue: BullMQ + Redis
- Session: Cookie-based anonymous sessions

## Quick Start with Docker 🐳 (Recommended)

Easiest way to run the backend stack. No need to install Node.js, PostgreSQL, or Redis separately.

```bash
# 1. Create .env file
cp .env.docker .env
# Edit .env and add your ETH_RPC_URL and SESSION_SECRET

# 2. Start everything
docker compose up -d

# 3. Run migrations manually from host machine
# (Known issue: migrations container is missing dependencies)
DATABASE_URL=postgresql://defi_user:defi_password@localhost:5432/defi_tracker npm run migrate

# 4. Done! API is running at http://localhost:3000
```

To run the lightweight frontend separately, see `frontend/README.md`.

Known Docker Issues
- The Dockerfile uses `npm ci --only=production` which excludes `node-pg-migrate` (devDependency), so migrations must be run from the host machine
- To check discovered positions: `docker compose exec postgres psql -U defi_user -d defi_tracker -c "SELECT display_name, base_asset, value_usd FROM position p JOIN position_snapshot ps ON p.id = ps.position_id;"`

See DOCKER_DEPLOY.md for the complete Docker deployment guide.

---

## Manual Setup (Without Docker)

### Prerequisites

- Node.js >= 20.0.0
- PostgreSQL >= 13
- Redis >= 6.0
- Ethereum RPC endpoint (Alchemy/Infura)

### Setup

1) Install Dependencies

```bash
npm install
```

2) Configure Environment

```bash
cp .env.example .env
```

Edit `.env` with your configuration:

```env
# Server
PORT=3000
NODE_ENV=development
SESSION_SECRET=your-secret-key-here-change-in-production

# Database
DATABASE_URL=postgresql://user:password@localhost:5432/defi_tracker

# Ethereum RPC
ETH_RPC_URL=https://eth-mainnet.g.alchemy.com/v2/YOUR_API_KEY

# Redis
REDIS_URL=redis://localhost:6379
```

3) Set Up Database

```bash
createdb defi_tracker
npm run migrate
```

4) Start Redis

```bash
# Using Docker
docker run -d -p 6379:6379 redis:latest

# Or using Homebrew (macOS)
brew services start redis
```

5) Start the Server

Development mode (with hot reload):

```bash
npm run dev
```

Production mode:

```bash
npm run build
npm start
```

API is available at http://localhost:3000. To run the UI, see `frontend/README.md` and serve it separately.

## API Usage

### Add a Wallet

```bash
curl -X POST http://localhost:3000/api/wallets \
  -H "Content-Type: application/json" \
  -d '{"address": "0x742d35Cc6634C0532925a3b844Bc9e7595f0bEb"}'
```

### Get Portfolio Summary

```bash
curl http://localhost:3000/api/portfolio/summary
```

### Other Endpoints

- `GET /api/positions`
- `GET /api/positions/{id}/snapshots?from=YYYY-MM-DD&to=YYYY-MM-DD`
- `PATCH /api/positions/{id}`
- `POST /api/portfolio/refresh`
- `GET /api/plugins`

## How It Works

### Discovery Process

1. User adds wallet address via API
2. System scans wallet across all protocol adapters
3. For each protocol:
   - Checks token balances for known yield tokens
   - Creates position records if balance > 0
   - Takes initial snapshot with zero flows

### Hourly Update Cycle

Every hour (at minute 0), the system:

1. Fetches all wallets from database (no per-user filtering)
2. For each active position:
   - Fetches current value from blockchain
   - Detects net flows (deposits/withdrawals) via Transfer events
   - Computes yield-only delta = current value - (previous value + net flows)
   - Calculates per-window APY (hourly) using geometric compounding
   - Stores snapshot with all metrics
3. Income projections (daily/monthly/yearly) are calculated on-demand when API is called, not stored
4. Manual refresh available via POST /api/portfolio/refresh (rate-limited to once per 5 minutes)

### APY Calculation

- Per-snapshot APY (hourly cadence): `(1 + g)^(8760 / window_hours) - 1` where `g = yield_delta / (prev_value + net_flows)` and `window_hours` is the elapsed time between snapshots (minimum 59 minutes to compute APY)
- 7d APY: Geometric chain of recent per-snapshot APY values (up to 168 when available)
- 30d APY: Geometric chain of recent per-snapshot APY values (up to 720 when available)

### Counting Modes

- count: Position fully counts toward portfolio (stablecoin principal + yield)
- partial: Only stable yield leg counts (used for Convex cvxCRV - only crvUSD rewards tracked, ignoring volatile cvxCRV principal)
- ignore: Position excluded from portfolio calculations

## Project Structure

```
src/
├── adapters/           # Protocol adapters (implementation logic)
├── plugins/            # Protocol plugins (manifests + wiring)
├── jobs/               # Background jobs (scheduler)
├── models/             # Database models
├── routes/             # API routes
├── services/           # Business logic
├── types/              # TypeScript types
├── utils/              # Utilities
└── index.ts            # Main server

frontend/               # Simple frontend (minimal, for testing only)
├── index.html          # Single-page UI
├── styles.css          # Dark theme styling
├── app.js              # Vanilla JS API integration
├── config.js           # API base configuration
└── server.js           # Lightweight static server

config/
├── protocols.json      # Contract addresses, decimals
├── abis/               # Core ABIs (JSON)
└── plugins.json        # Third-party plugin specifiers (optional)
```

## Tests

```bash
npm test
```

## Production Considerations

- Use strong `SESSION_SECRET`
- Enable HTTPS behind a reverse proxy
- Configure database backups
- Monitor RPC reliability and rate limits
- Keep Redis persistent if needed

## Adding New Protocols (Plugins)

See `protocol-plugin.md` for plugin architecture and examples. Built-ins live under `src/plugins/builtin/<protocol-key>/`.

## Troubleshooting

- Positions not discovered: check RPC endpoint and protocol config
- APY null: need at least 2 snapshots (~1 hour apart)
- Jobs not processing: ensure Redis is running
- Docker migration issues: run migrations from host machine

## License

MIT

