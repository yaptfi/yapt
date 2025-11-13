# Yapt

**"Can I live off this?"**

Yapt tracks stablecoin yield from DeFi protocols on Ethereum. It automatically discovers your positions, calculates true APY (excluding deposits/withdrawals), and projects your daily/monthly/yearly income in dollars.

Focus on stable yield. Skip the volatile crypto bags.

## Features

- **Auto-Discovery**: Scans Ethereum wallets for yield positions across multiple DeFi protocols
- **True APY Tracking**: Calculates actual APY from realized value changes, not advertised rates
- **Hourly Updates**: Automated position tracking with historical data
- **Income Projections**: Shows daily, monthly, and yearly income estimates
- **Stablecoin Focus**: Only tracks USDC, USDT, DAI, crvUSD, USDS positions and yield
- **Multi-Protocol Support**: Aave v3, Curve, Convex, Yearn V3, Uniswap v4, and more
- **Passwordless Auth**: WebAuthn (passkeys) for secure login without passwords
- **Guest View**: Share read-only portfolio views via URL

## Quick Start

### Using Docker (Recommended)

1. **Setup environment**:
   ```bash
   cp .env.example .env
   # Edit .env and add your ETH_RPC_URL and SESSION_SECRET
   ```

2. **Start services**:
   ```bash
   docker compose up -d
   ```

3. **Run migrations** (from host machine):
   ```bash
   DATABASE_URL=postgresql://defi_user:defi_password@localhost:5432/defi_tracker npm run migrate
   ```

4. **Access the app**:
   - Frontend: http://localhost:8080
   - API: http://localhost:3000/api
   - First visit: Register with username + passkey

5. **Configure RPC** (required):
   - Single provider: Set `ETH_RPC_URL` in `.env` (Infura or Alchemy recommended)
   - Multiple providers: Use admin panel at `/admin.html` (see CLAUDE.md for details)

### Local Development

See `CLAUDE.md` for detailed development setup and architecture documentation.

## Supported Protocols

### Lending & Savings
- **Aave v3**: USDC, USDT, DAI, crvUSD lending positions
- **Curve Savings**: sCrvUSD vault
- **Sky Protocol**: sUSDS savings
- **f(x) Protocol**: fxSAVE USDC vault
- **Infinifi**: siUSD staking
- **Morpheus**: gtUSDC Prime

### Yield Vaults
- **Yearn v3**: crvUSD, USDC, USDS vaults
- **Curve Lending**: WBTC/crvUSD vault
- **Convex**: Multiple cvcrvUSD vaults (sDOLA, sfrxUSD, sUSDe, fxSAVE, WBTC, sreUSD, wstETH, WETH)
- **Convex**: cvxCRV staking (rewards-only)

### Liquidity Provision
- **Uniswap v4**: USDC/USDT 0.001% pool (NFT-based LP positions with fee tracking)

## Authentication

- **Passwordless**: WebAuthn (passkeys) for secure authentication
- **Multi-Device**: Add multiple passkeys (phone, security key, etc.)
- **Session-Based**: HTTP-only secure cookies
- **HTTPS Required**: For production deployments (WebAuthn requirement)

## How It Works

### Discovery
1. Add your wallet address via the frontend
2. System scans all supported protocols for yield positions
3. Creates position records for any detected balances
4. Takes initial snapshot to start tracking

### Updates
- **Hourly**: BullMQ job updates all positions every hour
- **Manual**: Refresh button available (rate-limited to once per 5 minutes)
- **APY Calculation**: Two-point method with deposit/withdrawal correction
- **Income Projections**: Calculated on-demand from current APY

### Counting Modes
- **count**: Full position value (principal + yield)
- **partial**: Only stable yield counted (e.g., cvxCRV → crvUSD rewards)
- **ignore**: Excluded from portfolio

## For Developers

### Tech Stack

- **Backend**: Node.js + TypeScript + Fastify
- **Database**: PostgreSQL (time-series snapshots)
- **Job Queue**: BullMQ + Redis
- **Blockchain**: ethers.js v6 (Ethereum mainnet)
- **Auth**: WebAuthn (passkeys)
- **Frontend**: Vanilla JS + CSS

### Project Structure

```
src/
├── adapters/       # Protocol-specific logic
├── jobs/           # Hourly update scheduler
├── models/         # Database operations
├── routes/         # REST API endpoints
├── services/       # Business logic
└── utils/          # Helpers (APY, DB, RPC)

frontend/
├── index.html      # Landing page
├── dashboard.html  # Main app
├── guest.html      # Read-only view
├── admin.html      # Admin panel
├── app.js          # Dashboard logic
├── auth.js         # WebAuthn integration
└── utils.js        # Shared utilities

config/
├── protocols.json  # Contract addresses
└── abis/           # Contract ABIs
```

### Tests

```bash
npm test                # Run Jest tests
npm run typecheck       # TypeScript validation
npm run lint            # ESLint
npm run browse          # Playwright UI automation
```

### API Examples

All endpoints require authentication (session cookie):

```bash
# Add wallet
curl -X POST http://localhost:3000/api/wallets \
  -H "Content-Type: application/json" \
  -H "Cookie: sessionId=YOUR_SESSION" \
  -d '{"address": "0x742d35Cc6634C0532925a3b844Bc9e7595f0bEb"}'

# Get portfolio summary
curl http://localhost:3000/api/portfolio/summary \
  -H "Cookie: sessionId=YOUR_SESSION"

# List positions
curl http://localhost:3000/api/positions \
  -H "Cookie: sessionId=YOUR_SESSION"

# Manual refresh
curl -X POST http://localhost:3000/api/portfolio/refresh \
  -H "Cookie: sessionId=YOUR_SESSION"
```

### RPC Provider Management

Yapt uses capability-based routing to handle RPC provider limitations:

- **Normal calls** (balances, state): Load-balanced across all providers
- **Historical scans** (Uniswap discovery): Only providers with `supportsLargeBlockScans=true`

**Single Provider** (simplest):
```env
ETH_RPC_URL=https://mainnet.infura.io/v3/YOUR_KEY
```

**Multiple Providers** (optimal):
- Add via admin panel at `/admin.html`
- Configure Alchemy (fast, no scans) + Infura (slower, supports scans)
- See `CLAUDE.md` for detailed configuration

**Common Issue**: Alchemy free tier restricts `eth_getLogs` to 10 blocks. Set `supportsLargeBlockScans=false` for Alchemy free tier, or Uniswap discovery will fail.

### Production Deployment

1. **Generate SSL certificates**:
   ```bash
   openssl req -x509 -newkey rsa:4096 -nodes -keyout key.pem -out cert.pem -days 365
   ```

2. **Configure environment**:
   ```env
   HTTPS_ENABLED=true
   HTTPS_CERT=/app/cert.pem
   HTTPS_KEY=/app/key.pem
   PORT=3443
   RP_ID=yourdomain.local
   ORIGIN=https://yourdomain.local:8080
   ```

3. **Important**: WebAuthn requires a domain name (not IP). For local network, add `/etc/hosts` entry: `192.168.x.x yourdomain.local`

## Documentation

- **CLAUDE.md**: Complete architecture and development guide
- **Migrations**: Database schema in `migrations/` directory
- **Config**: Protocol contracts in `config/protocols.json`

## Guest View

Share portfolio views without authentication:

- Navigate to Admin panel → Click "View as Guest" for any wallet
- Share URL: `/guest.html?wallet={walletId}`
- Read-only view of positions, APY, and income projections

## License

MIT
