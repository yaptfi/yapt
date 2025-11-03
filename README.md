# Yapt

Tracking stablecoin portfolios. Ignoring volatile crypto holdings. Checking for income streams denominated in stablecoins. "Can I live off this?" Yapt!

## Quick Start

### Using Docker (Recommended)

1. **Setup environment**:
   ```bash
   cp .env.example .env
   # Edit .env and add your ETH_RPC_URL and SESSION_SECRET
   ```

2. **Start services (dev)**:
   ```bash
   docker compose up -d
   ```

3. **Run migrations** (from host machine):
   ```bash
   DATABASE_URL=postgresql://defi_user:defi_password@localhost:5432/defi_tracker npm run migrate
   ```

4. **Access the application**:
   - Frontend: http://localhost:8080
   - API: http://localhost:3000/api
   - Admin Panel: http://localhost:8080/admin.html (requires admin user)
   - First visit: Register with username + passkey (WebAuthn)

5. **Configure RPC providers** (required):
   - Single provider: Set `ETH_RPC_URL` in `.env` (e.g., Infura, Alchemy)
   - Multiple providers: Use admin panel to add providers with different capabilities
   - See "RPC Provider Management" section below for details on capability-based routing

### Local Development

See `CLAUDE.md` for detailed development setup and architecture documentation.

## RPC Provider Management

Yapt uses a **capability-based RPC routing system** to work efficiently with different RPC providers that have varying limitations and features.

### The Problem

Different RPC providers have drastically different capabilities:
- **Alchemy Free Tier**: Fast and high rate limits, but restricts `eth_getLogs` to 10 block ranges
- **Infura**: Slower rate limits, but supports scanning 100k+ blocks for historical events
- **QuickNode, Ankr**: Generally support large block scans with varying rate limits

Some protocols (like Uniswap v4) require scanning millions of historical blocks for Transfer events to discover NFT-based positions. This is impossible with Alchemy's 10-block limit but works fine with Infura.

### The Solution: Provider-Specific Routing

The RPC manager routes different types of requests to appropriate providers based on their capabilities:

**Normal RPC Calls** (balance checks, contract calls, current state):
- Load balanced across **ALL** active providers
- Round-robin selection with automatic failover
- Uses token bucket rate limiting

**Block Scanning Calls** (`eth_getLogs`, `queryFilter` for historical events):
- Routed **ONLY** to providers with `supportsLargeBlockScans=true`
- Uses highest priority scan-capable provider
- No automatic failover (direct provider access)

### Configuration

#### Single Provider Setup

Add to `.env`:
```env
ETH_RPC_URL=https://mainnet.infura.io/v3/YOUR_KEY
```

**Result**: Works for all protocols including Uniswap v4 (if provider supports large scans)

#### Multiple Providers Setup

1. **Leave `ETH_RPC_URL` in `.env`** (used as fallback)

2. **Add providers via Admin Panel** at `http://localhost:8080/admin.html`:
   - **Infura** (scan-capable, low priority for normal calls):
     - Name: `Infura`
     - URL: `https://mainnet.infura.io/v3/YOUR_KEY`
     - Calls per Second: `10`
     - Priority: `0`
     - Active: ✓
     - **Supports Large Block Scans: ✓**

   - **Alchemy** (fast for normal calls, skip for scans):
     - Name: `Alchemy`
     - URL: `https://eth-mainnet.g.alchemy.com/v2/YOUR_KEY`
     - Calls per Second: `25`
     - Priority: `10`
     - Active: ✓
     - **Supports Large Block Scans: ✗** (free tier only!)

**Result**:
- 99% of requests (balance checks, current values) → Load balanced, Alchemy preferred (higher priority)
- 1% of requests (historical scans for Uniswap discovery) → Only Infura used

### Provider Capabilities

Each provider has a `supportsLargeBlockScans` flag that determines routing behavior:

| Provider | Free Tier Limit | Set Flag To | Why |
|----------|----------------|-------------|-----|
| Alchemy Free | 10 blocks | `false` | Cannot handle large scans |
| Alchemy Paid | ~10,000 blocks | `true` | Paid tier supports large scans |
| GetBlock.io | 2,000 blocks | `false` | Free tier too limited for Uniswap |
| Infura | 100,000+ blocks | `true` | Generous scan limits - recommended! |
| QuickNode | ~100,000 blocks | `true` | Enterprise-grade scanning |
| Ankr | ~100,000 blocks | `true` | Public RPC supports scans |
| Self-hosted | No limit | `true` | Your own node |

**Default**: `true` (assumes providers support large scans for backwards compatibility)

### Managing Providers

Via **Admin Panel** (`/admin.html`):
- **Add Provider**: Form includes "Supports Large Block Scans" checkbox
- **View Status**: Table shows provider health and capabilities
- **Edit Provider**: Update rate limits, priority, or capabilities
- **Delete Provider**: Remove unused providers

### Behavior by Protocol

| Protocol | RPC Call Type | Routes To |
|----------|--------------|-----------|
| Aave v3 | `balanceOf()` | All providers (load balanced) |
| Curve sCrvUSD | `balanceOf()` | All providers (load balanced) |
| Yearn v3 | `convertToAssets()` | All providers (load balanced) |
| **Uniswap v4** | `queryFilter()` historical events | **Only scan-capable providers** |

### Graceful Degradation

If no scan-capable providers are configured:
- Normal protocols (Aave, Curve, Convex, etc.) work fine
- Uniswap v4 discovery skips with warning:
  ```
  [Uniswap v4] No scan-capable RPC provider available - skipping Uniswap discovery
  [Uniswap v4] Configure an RPC provider with supportsLargeBlockScans=true (e.g., Infura)
  ```

### Database Schema

Providers are stored in `rpc_provider` table:
```sql
CREATE TABLE rpc_provider (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  url TEXT NOT NULL,
  calls_per_second NUMERIC NOT NULL,
  calls_per_day INTEGER,
  priority INTEGER NOT NULL DEFAULT 0,
  is_active BOOLEAN NOT NULL DEFAULT true,
  supports_large_block_scans BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

Run migration to add `supports_large_block_scans`:
```bash
DATABASE_URL=postgresql://defi_user:defi_password@localhost:5432/defi_tracker npm run migrate
```

### Troubleshooting

**Error: "Under the Free tier plan, you can make eth_getLogs requests with up to a 10 block range"**
- Cause: Alchemy free tier provider has `supportsLargeBlockScans=true`
- Fix: Set `supportsLargeBlockScans=false` for Alchemy free tier in admin panel

**Warning: "No scan-capable RPC provider available"**
- Cause: All providers have `supportsLargeBlockScans=false` or are unhealthy
- Fix: Add at least one provider with scan support (Infura, QuickNode, etc.)

**Uniswap positions not discovered**
- Cause: No scan-capable providers available
- Fix: Uniswap requires historical event scanning - add a provider with `supportsLargeBlockScans=true`

## Authentication

- **Passwordless**: Uses WebAuthn (passkeys) for secure authentication
- **Multi-Device**: Add multiple passkeys to the same account
- **Session-Based**: HTTP-only secure cookies
- **HTTPS Required**: For production/non-localhost deployments

## Production Deployment

For production deployment with HTTPS:

1. **Generate SSL certificates** (self-signed for local network):
   ```bash
   openssl req -x509 -newkey rsa:4096 -nodes -keyout key.pem -out cert.pem -days 365
   ```

2. **Configure environment** (.env):
   ```env
   HTTPS_ENABLED=true
   HTTPS_CERT=/app/cert.pem
   HTTPS_KEY=/app/key.pem
   PORT=3443
   RP_ID=yourdomain.local
   ORIGIN=https://yourdomain.local:8080
   ```

3. **Important**: WebAuthn requires a valid domain name (not IP address). For local network:
   - Add `/etc/hosts` entry on all client machines: `192.168.x.x  yourdomain.local`
   - Or use a service like nip.io (e.g., `192.168.1.100.nip.io`)

## Environment & Config Management

This project uses a simple, portable env-file workflow so you don’t need to edit multiple files when adding new variables.

- Compose loads `.env` and injects all key/value pairs into the app container (see `env_file` in `docker-compose.yml`).
- The app also reads variables defined under the `environment:` block; however, new variables can be added directly to `.env` without touching `docker-compose.yml`.

Recommended patterns
- Separate per‑environment files:
  - `.env.dev`, `.env.prod` (keep secrets out of version control)
  - Dev: `docker compose --env-file .env.dev up -d`
  - Prod: `docker compose --env-file .env.prod up -d`
- Applying changes:
  - After editing your env file, recreate the app service to apply: `docker compose up -d --force-recreate app`
  - Verify inside the container: `docker compose exec app sh -lc 'env | grep -E "(ETH_RPC_URL|UPDATE_CRON_MINUTE|GUEST_DEFAULT_WALLET_ID)"'`
- Safe defaults in code:
  - Server code uses `getEnvVar` for defaults where appropriate; prefer setting values in `.env` for clarity.

Useful variables
- `ETH_RPC_URL`: Ethereum JSON‑RPC endpoint.
- `UPDATE_CRON_MINUTE`: Hourly update minute (e.g., prod=48, dev=43) to stagger environments.
- `GUEST_DEFAULT_WALLET_ID`: Default wallet ID for the login page’s “View as guest” link; used by `GET /api/guest/default-wallet`.

Notes
- For local dev without Docker, export variables in your shell: `set -a; source .env; set +a; npm run dev`.
- To change daily discovery scheduling, contact the maintainers or open an issue (the cron is currently fixed in code).

## Features

- **Auto-Discovery**: Scans Ethereum wallets for DeFi positions (Aave, Curve, Convex, Yearn, Uniswap)
- **APY Tracking**: Calculates true APY from realized value changes (excludes deposits/withdrawals)
- **Hourly Updates**: Automated position tracking and yield calculations
- **Stablecoin Focus**: Tracks USDC, USDT, DAI, crvUSD, USDS positions and income
- **Multi-Protocol**: Supports Aave v3, Curve, Convex, Yearn V3, Uniswap v4, and more
- **LP Positions**: Tracks Uniswap v4 liquidity positions with fee accrual
- **Guest View**: Share read-only portfolio views without requiring authentication
- **Admin Panel**: Manage wallets and view system-wide statistics (development only)

## Supported Protocols

### Lending & Savings
- **Aave v3**: USDC, USDT, DAI, crvUSD lending positions (aTokens)
- **Curve Savings**: crvUSD savings vault (sCrvUSD)
- **Sky Protocol**: USDS savings (sUSDS)
- **f(x) Protocol**: fxSAVE USDC vault
- **Infinifi**: Staked iUSD (siUSD)
- **Morpheus**: Gauntlet USDC Prime (gtUSDC)

### Yield Vaults
- **Yearn v3**: crvUSD, USDC, USDS vaults with optional gauge staking
- **Curve Lending**: WBTC vault (cvcrvUSD)
- **Convex**: Multiple cvcrvUSD vaults (sDOLA, sfrxUSD, sUSDe, fxSAVE, WBTC, sreUSD, wstETH, WETH)
- **Convex**: cvxCRV staking (rewards-only tracking)

### Liquidity Provision
- **Uniswap v4**: USDC/USDT 0.001% pool (NFT-based positions)
  - Tracks position liquidity value + uncollected trading fees
  - Supports multiple positions per wallet
  - See "Extending Uniswap Support" below for adding more pools

### Extending Uniswap Support

The current Uniswap v4 adapter supports the **USDC/USDT 0.001% fee tier** pool. To add support for:

**Other pools (same fee tier)**:
1. Add new protocol config in `config/protocols.json`:
   ```json
   "uniswap-v4-dai-usdc": {
     "name": "Uniswap v4 DAI/USDC",
     "positionManager": "0xbd216513d74c8cf14cf4747e6aaa6420ff64ee9e",
     "poolManager": "0x000000000004444c5dc75cB358380D2e3dE08A90",
     "stateView": "0x7ffe42c4a5deea5b0fec41c94c136cf115597227",
     "currency0": "0x6B175474E89094C44Da98b954EedeAC495271d0F",
     "currency1": "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
     "currency0Symbol": "DAI",
     "currency1Symbol": "USDC",
     "currency0Decimals": 18,
     "currency1Decimals": 6,
     "fee": 10,
     "tickSpacing": 1,
     "type": "lp-position",
     "countingMode": "count",
     "abiKeys": ["ERC721", "UniswapV4PositionManager", "UniswapV4StateView"]
   }
   ```

2. Create new adapter instance in `src/plugins/builtin/uniswap-v4-dai-usdc/index.ts`:
   ```typescript
   import { UniswapV4Adapter } from '../../../adapters/uniswap-v4';
   import { ProtocolPlugin } from '../../types';

   class UniswapV4DaiUsdcAdapter extends UniswapV4Adapter {
     readonly protocolKey = 'uniswap-v4-dai-usdc' as const;
     readonly protocolName = 'Uniswap v4 DAI/USDC';
   }

   export const plugin: ProtocolPlugin = {
     manifest: {
       key: 'uniswap-v4-dai-usdc',
       name: 'Uniswap v4 DAI/USDC',
       version: '0.0.1',
       sdkVersion: '^0.1.0',
     },
     createAdapter() {
       return new UniswapV4DaiUsdcAdapter();
     },
   };
   ```

3. Add migration to insert protocol record:
   ```javascript
   exports.up = (pgm) => {
     pgm.sql(`
       INSERT INTO protocol (key, name)
       VALUES ('uniswap-v4-dai-usdc', 'Uniswap v4 DAI/USDC')
       ON CONFLICT (key) DO UPDATE SET name = EXCLUDED.name;
     `);
   };
   ```

**Different fee tiers**: Change the `fee` value in config (e.g., `100` for 0.01%, `500` for 0.05%, `3000` for 0.3%)

**Uniswap v3**: The same adapter code works for v3! Just update contract addresses:
- Position Manager: `0xC36442b4a4522E871399CD717aBDD847Ab11FE88`
- No StateView needed (use Pool contract directly)
- Adjust ABI imports as needed

**Non-stablecoin pairs**: The current adapter assumes $1.00 pricing for both tokens. For volatile pairs, you'd need to:
1. Fetch real-time prices from an oracle (Chainlink, CoinGecko API)
2. Update `estimateLiquidityValueUSD()` to use actual token prices
3. Modify `calcNetFlows()` to price deposits/withdrawals correctly

## Guest View & Sharing

Yapt includes a guest view feature for sharing portfolio data without requiring authentication:

- **Access**: Navigate to Admin panel → Click "View as Guest" for any wallet
- **URL Format**: `/guest.html?wallet={walletId}`
- **Features**: Read-only view of positions, APY, and income projections
- **Use Cases**:
  - Share portfolio performance with friends/advisors
  - Preview the app before creating an account
  - Embed portfolio views in external dashboards

**Example**: `https://yourdomain.com/guest.html?wallet=abc123`

## Admin Panel

⚠️ Admin endpoints are protected by server‑side `is_admin` checks. Ensure your user has `is_admin=true` in the database to access `/admin.html` and related APIs.

- **Access**: Footer link on main dashboard or `/admin.html`
- **Features**:
  - View all wallets in the database
  - See user counts and position statistics
  - Hard delete wallets (removes all data permanently)
  - Launch guest views for any wallet

## Documentation

- **CLAUDE.md**: Complete architecture, development guide, and protocol details
- **Migrations**: Database schema in `migrations/` directory
- **Config**: Protocol contracts and ABIs in `config/` directory
### Docker: dev vs prod compose files

Dev (local):
- Uses `docker-compose.yml` only.
- Postgres data stored in a local named volume `pgdata`.
- Commands:
  - `docker compose up -d`
  - `docker compose exec postgres psql -U defi_user -d defi_tracker -c '\\dt'`

Prod (server/CI):
- Uses an override file to attach the existing external DB volume.
- Files: `docker-compose.yml` + `docker-compose.prod.yml`.
- Commands (manually on the server):
  - `docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d`
  - `docker compose -f docker-compose.yml -f docker-compose.prod.yml run --rm migrations`
- GitHub Actions is already configured to use the prod override.

Tip: If you ever see `external volume "yieldbuddy_postgres_data" not found` locally, it means you're applying the prod override on dev — run with the base file only: `docker compose -f docker-compose.yml up -d`.
### APY Calculation (simple, two‑point)

APY is computed on demand from snapshots using a two‑point method with flows correction:
- Recent APY (~4h): Compare the latest snapshot to the snapshot closest to 4 hours earlier (must be at least 59 minutes old). Sum `net_flows_usd` between those two timestamps, remove flows from the base, then annualize.
- 7D APY: Compare the latest snapshot to the snapshot closest to 7 days earlier (same flows correction), then annualize over the actual elapsed hours between those two points. If a reset occurred within the window, the baseline is anchored at the most recent reset instead.
- 30D APY: Same as above, using a target 30 days earlier; also anchored at the most recent reset when applicable.

Display rule to avoid duplicates:
- Don’t show 7D APY if it rounds to the same value as the 4h APY (to 2 decimals in percent).
- Don’t show 30D APY if it rounds to the same value as the displayed 7D APY (or the 4h APY if 7D is hidden).

Notes:
- Deposits/withdrawals during the window are accounted for by summing `net_flows_usd` between the reference and latest snapshot.
- If the position is newer than the target window (e.g., not 7 days old), the calculation uses the nearest available snapshot to the target time; if a reset is within the window, the calculation uses the reset as the baseline; if no suitable reference exists, the APY is omitted.
