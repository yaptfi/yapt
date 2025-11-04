# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

This is a DeFi passive income tracker that automatically discovers and tracks yield positions from Ethereum wallets. The system runs hourly updates to calculate true APY from realized value changes (excluding deposits/withdrawals) and projects stablecoin-denominated income.

**Core Purpose**: Answer "Can I live off this?" by tracking liquid, spendable stablecoin yield across DeFi protocols.

**Development Focus**: Currently prioritizing backend service functionality and data accuracy. The frontend is a minimal interface for testing and monitoring - polished client experiences will be added once the core service is proven useful.

**User Management**: Implemented using WebAuthn (passkeys) for passwordless authentication. Each user can register with a username and passkey, add multiple devices, and only sees their own wallets and positions. Session-based authentication with secure HTTP-only cookies.

## Development Commands

```bash
# Development
npm run dev              # Start server with hot reload (tsx watch)
npm run build           # Compile TypeScript to dist/
npm start               # Run production build

# Database
npm run migrate         # Run pending migrations
npm run migrate:down    # Rollback last migration

# Testing & Quality
npm test                # Run Jest tests
npm run typecheck       # Run TypeScript compiler without emit
npm run lint            # Run ESLint on src/

# Docker (recommended for local development)
docker compose up -d    # Start PostgreSQL + Redis + app
docker compose down     # Stop all services
docker compose logs app --tail 50  # Check app logs
docker compose exec postgres psql -U defi_user -d defi_tracker  # Access database
```

### Docker Setup Notes

**First-time setup with Docker:**
1. Copy `.env.example` to `.env` and configure:
   - `ETH_RPC_URL` - Your Ethereum RPC endpoint (Alchemy/Infura)
   - `SESSION_SECRET` - Generate with `openssl rand -base64 32`
   - `DATABASE_URL`, `REDIS_URL` - Already configured for Docker
2. Start Docker Desktop
3. Run `docker compose up -d`
4. **Important**: Migrations must be run manually from host machine (the migrations container has a missing dependency issue):
   ```bash
   DATABASE_URL=postgresql://defi_user:defi_password@localhost:5432/defi_tracker npm run migrate
   ```

**Known Issues:**
- The Dockerfile uses `npm ci --only=production` which excludes `node-pg-migrate` (devDependency), so migrations can't run inside containers
- To check if positions were discovered: `docker compose exec postgres psql -U defi_user -d defi_tracker -c "SELECT display_name, base_asset, value_usd FROM position p JOIN position_snapshot ps ON p.id = ps.position_id;"`

## Architecture Overview

### Core Concepts

**Protocol Adapters** (`src/adapters/`): Modular discovery and measurement engines for each DeFi protocol. Each adapter implements:
- `discover(walletAddress)`: Scans wallet for yield positions
- `readCurrentValue(position)`: Fetches current USD value from blockchain
- `calcNetFlows(position, fromBlock, toBlock)`: Detects deposits/withdrawals via Transfer events

**APY Calculation** (`src/utils/apy.ts`): Simple two‑point method with flows correction:
- 4h (“recent”) APY: Compare latest snapshot to the snapshot closest to 4 hours earlier (reference must be ≥59 minutes old). Let `base = V_ref + Flows(ref→latest)`; `g = (V_latest − base) / base`; `APY = (1 + g)^(8760 / window_hours) − 1`.
- 7d APY: Same method but target reference is 7 days earlier, anchored at the most recent reset if it occurred within the window.
- 30d APY: Same method with a 30‑day target, also anchored at the most recent reset.
- Display rule: hide 7d if it rounds to the same percent (2 decimals) as 4h; hide 30d if it rounds to the same as displayed 7d.

**Position Discovery Flow** (`src/services/discovery.ts`):
1. Authenticated user adds wallet address via API (POST /api/wallets)
2. System runs all protocol adapters concurrently
3. Creates position records for non-zero balances
4. Takes initial snapshot with zero flows
5. Wallet is linked to user's session and isolated from other users
6. If wallet already exists in database, discovery is skipped and wallet is added to user's account

**Hourly Update Cycle** (`src/jobs/scheduler.ts`):
1. BullMQ cron job triggers automatically every hour at minute 0 (pattern: '0 * * * *')
2. Fetches all wallets from database (updates all positions regardless of user)
3. For each active position: fetch current value from blockchain, detect deposits/withdrawals via Transfer events, compute yield delta
4. Store a new snapshot with value, net flows, and yield delta; APY metrics are calculated on demand using the two‑point method above when serving API responses.
5. Store new snapshot in position_snapshot table
6. Income projections (daily/monthly/yearly) are calculated on-demand when API is called, not stored
7. Manual refresh available via POST /api/portfolio/refresh (requires authentication, rate-limited to once per 5 minutes per user)

**Authentication System** (`src/routes/auth.ts`):
- **WebAuthn/Passkeys**: Passwordless authentication using SimpleWebAuthn library
- **Registration**: New users create account with username + passkey (public key stored in database)
- **Login**: Challenge-response authentication without passwords
- **Multi-Device Support**: Users can add multiple passkeys (phones, security keys, etc.) via authenticated endpoint
- **Session Management**: HTTP-only secure cookies with server-side session storage
- **Rate Limiting**: 5 requests per 15 minutes for registration, 10 per 15 minutes for login
- **Device Management**: Users can list and remove devices (minimum 1 device required)
- **Security**: CORS configured for credentials, database-level filtering prevents data leakage between users

**RPC Provider Management** (`src/utils/rpc-manager.ts`, `src/utils/rpc-proxy-provider.ts`):
- **Capability-Based Routing**: Routes different RPC call types to appropriate providers based on their capabilities
- **Load Balancing**: Normal calls (balanceOf, current state) distributed across ALL active providers via round-robin
- **Specialized Routing**: Block scans (eth_getLogs, queryFilter) routed ONLY to providers with `supportsLargeBlockScans=true`
- **Rate Limiting**: Token bucket algorithm per provider respects individual rate limits (calls per second/day)
- **Health Tracking**: Consecutive error counting with exponential backoff for unhealthy providers
- **Concurrent Processing**: Queue-based worker pattern supports up to 50 parallel RPC requests
- **Graceful Degradation**: Adapters can fallback or skip protocols when no capable providers available
- **Database-Backed**: Providers configured via `rpc_provider` table with live admin panel management
- **Why This Matters**: Allows mixing free-tier providers (Alchemy: fast, 10-block limit) with generous providers (Infura: slow, 100k+ blocks) for optimal cost/performance

### Key Design Patterns

**Counting Modes**: Positions can be:
- `count`: Fully included in portfolio (stablecoin principal + yield)
- `partial`: Only stable yield leg counts (reserved for future multi-asset positions)
- `ignore`: Excluded from calculations

**High-Precision Math**: All USD values stored as PostgreSQL `NUMERIC(38,18)` to avoid floating-point errors. Never use JavaScript `Number` for financial calculations.

**Idempotent Updates**: Position upserts use `ON CONFLICT` to handle re-discovery. Snapshots use timestamp + position_id for deduplication.

**Configuration-Driven**: All contract addresses, decimals, and ABIs defined in `config/protocols.json`. Never hardcode addresses.

## Adding New Protocol Adapters

1. Create `src/adapters/your-protocol.ts`:
```typescript
import { BaseProtocolAdapter } from './base';

export class YourProtocolAdapter extends BaseProtocolAdapter {
  protocolKey = 'your-protocol' as const;
  protocolName = 'Your Protocol';

  async discover(walletAddress: string) {
    // Scan wallet for positions, return DiscoveredPosition[]
  }

  async readCurrentValue(position: Position): Promise<number> {
    // Read current USD value from blockchain
  }

  async calcNetFlows(position: Position, fromBlock: number, toBlock: number): Promise<number> {
    // Detect deposits (+) and withdrawals (-) via events
  }
}
```

2. Add protocol config to `config/protocols.json`:
```json
{
  "your-protocol": {
    "name": "Your Protocol",
    "token": "0x...",
    "decimals": 18,
    "abiKeys": ["ERC20"]
  }
}
```

3. Register adapter in `src/adapters/index.ts`:
```typescript
adapters.set('your-protocol', new YourProtocolAdapter());
```

4. Insert protocol into database:
```sql
INSERT INTO protocol (key, name) VALUES ('your-protocol', 'Your Protocol');
```

### RPC Provider Usage in Adapters

When writing protocol adapters, use the appropriate RPC access pattern based on the operation type:

**For Normal Calls** (balance checks, current state queries):
```typescript
import { getContract } from '../utils/ethereum';

const contract = getContract(address, abi); // Uses load-balanced provider
const balance = await contract.balanceOf(walletAddress);
```

**For Historical Event Scanning** (queryFilter, getLogs):
```typescript
import { ethers } from 'ethers';
import { getAbi } from '../utils/config';

async discover(walletAddress: string): Promise<Partial<Position>[]> {
  const { getProvider } = await import('../utils/ethereum');
  const proxyProvider = getProvider();

  // Check if RPC manager is available
  let scanProvider;
  if ('getRPCManager' in proxyProvider && typeof proxyProvider.getRPCManager === 'function') {
    const manager = (proxyProvider as any).getRPCManager();
    scanProvider = manager.getScanCapableProvider();

    if (!scanProvider) {
      console.warn('[YourProtocol] No scan-capable RPC provider available - skipping discovery');
      console.warn('[YourProtocol] Configure an RPC provider with supportsLargeBlockScans=true');
      return []; // Gracefully skip this protocol
    }
  } else {
    // Fallback for single-provider setups (no RPC manager)
    scanProvider = proxyProvider;
  }

  // Create contract with scan-capable provider
  const abi = getAbi('YourContract');
  const contract = new ethers.Contract(address, abi, scanProvider);

  // This will work even with large block ranges
  const events = await contract.queryFilter(transferFilter);
  // ... process events
}
```

**Why This Matters:**
- Alchemy free tier restricts `eth_getLogs` to 10 blocks max
- Uniswap v4 discovery needs to scan millions of blocks for Transfer events
- By using `getScanCapableProvider()`, you ensure scans use Infura/QuickNode while normal calls can still use Alchemy
- Result: 99% of fast calls use Alchemy, 1% of heavy scans use Infura

**Error Handling Pattern:**
```typescript
try {
  stakedBalance = await stakingContract.balanceOf(checksumAddress);
} catch (error: any) {
  // Handle BAD_DATA error (empty return) - contract doesn't exist or wrong address
  if (error.code === 'BAD_DATA' && error.value === '0x') {
    console.warn(`[${this.protocolKey}] Contract at ${contractAddress} returned no data - likely wrong address or network mismatch`);
    return positions; // Return empty array instead of throwing
  }
  throw error; // Re-throw other errors
}
```

## Database Schema Notes

**Critical Tables**:
- `user`: User accounts with username (unique) and timestamps
- `authenticator`: WebAuthn credentials (public keys, counter, device names) linked to users
- `wallet`: Wallet storage with user_id field for isolation
- `position`: Links wallet → protocol with metadata (contract addresses, decimals)
- `position_snapshot`: Time-series data points (value, flows, yield delta, APY) - core data for tracking
- `portfolio_hourly`: Reserved for future aggregated metrics (not currently used)
- `rpc_provider`: RPC provider configurations with capabilities, rate limits, and health status (added Nov 2025)

**Metadata Pattern**: `position.metadata` (JSONB) stores protocol-specific data:
- `walletAddress`: Used by adapters for event filtering
- `tokenAddress`, `aTokenAddress`: Contract addresses
- `decimals`: Token decimals for unit conversion

**Snapshot Timestamps**: Always use full precision `TIMESTAMPTZ` and query with ranges (`ts >= ? AND ts < ?`) to avoid off-by-one errors.

**Column Naming**: Database uses snake_case (e.g., `display_name`, `created_at`) but TypeScript interfaces use camelCase. All SQL queries that return data to the API must alias columns with double-quoted camelCase (e.g., `display_name as "displayName"`) to match the interface definitions.

**RPC Provider Table Schema**:
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

Key fields:
- `supports_large_block_scans`: Whether provider can handle eth_getLogs with large block ranges (10k+ blocks)
  - Set to `false` for Alchemy free tier (10 block limit)
  - Set to `true` for Infura, QuickNode, Ankr, paid tiers, self-hosted nodes
  - Default: `true` (backwards compatible)
- `priority`: Higher values are preferred for load-balanced calls (0-100 range)
- `calls_per_second`: Rate limit enforced via token bucket algorithm
- `is_active`: Allows disabling providers without deleting configuration

## Environment Configuration

Required variables (see `.env.example`):
- `ETH_RPC_URL`: Ethereum mainnet RPC (Alchemy/Infura recommended)
- `DATABASE_URL`: PostgreSQL connection string
- `REDIS_URL`: Redis for BullMQ job queue
- `SESSION_SECRET`: Secure random key for cookie sessions (use `openssl rand -base64 32`)

**WebAuthn Configuration** (required for production):
- `RP_NAME`: Human-readable name (e.g., "Yapt")
- `RP_ID`: Domain name without protocol/port (e.g., "yapt.local" or "example.com")
  - **IMPORTANT**: Cannot be an IP address (e.g., 192.168.1.1) - use `.local` domain or hosts file
- `ORIGIN`: Full URL where frontend is served (e.g., "https://yapt.local:8080")
  - Must match the actual URL users access in their browser
  - Must use HTTPS in production (WebAuthn requires secure context for non-localhost)

**HTTPS Configuration** (recommended for production):
- `HTTPS_ENABLED`: Set to "true" to enable HTTPS for both API and frontend
- `HTTPS_CERT`: Path to SSL certificate file (e.g., "/app/cert.pem")
- `HTTPS_KEY`: Path to SSL private key file (e.g., "/app/key.pem")
- `PORT`: API server port (3000 for HTTP, 3443 for HTTPS)
- `FRONTEND_PORT`: Frontend server port (typically 8080)

**Production Deployment Notes**:
- WebAuthn **requires HTTPS** for non-localhost domains (use self-signed certs for local network)
- Generate self-signed certs: `openssl req -x509 -newkey rsa:4096 -nodes -keyout key.pem -out cert.pem -days 365`
- For local network deployment, add `/etc/hosts` entry on all client machines (e.g., `192.168.1.100  yapt.local`)
- Change `SESSION_SECRET` in production - never use default values

## Testing Strategy

**APY Calculations**: Unit tests in `src/utils/apy.test.ts` verify:
- APY computation with various growth rates
- Geometric chaining for 7d/30d windows
- Edge cases (negative yields, zero base values)

**Run a single test**:
```bash
npm test -- apy.test.ts
```

**Integration Testing**: Simulated position sequences with known deposits/withdrawals to validate end-to-end APY accuracy (±0.5% target).

## Common Pitfalls

1. **Token Decimals**: Always normalize balances using token decimals before storing. Check `position.metadata.decimals`.

2. **Net Flow Direction**: Transfer events where wallet is `from` are withdrawals (negative), `to` are deposits (positive).

3. **Stablecoin Assumption**: MVP assumes $1.00 peg for all stables (USDC, USDT, DAI, crvUSD). Price feeds not yet implemented.

4. **First Snapshot**: Initial snapshot always has `netFlowsUsd=0` and `apy=null` (no previous data to compare).

5. **Block Ranges**: When querying events, use `getLatestSnapshot().ts` as `fromBlock` (converted to block number) to avoid re-processing.

6. **Database Column Aliases**: When writing SQL queries in model files, always alias snake_case columns to camelCase for API responses (e.g., `created_at as "createdAt"`). Never use `SELECT *` for queries that return to the API.

7. **RPC Provider Selection**: When scanning historical events (queryFilter, getLogs), always use `getScanCapableProvider()` instead of regular `getProvider()`. This ensures your adapter works with Alchemy free tier in the mix. See "RPC Provider Usage in Adapters" section above.

8. **BAD_DATA Errors**: When contract calls return empty data (`0x`), catch and handle gracefully instead of crashing discovery. This happens when contracts don't exist at configured addresses or don't implement expected interfaces.

9. **CRITICAL - RPC Error Handling in Adapters**: Never catch RPC errors and silently return 0. RPC failures must throw exceptions, not return zero balances. The `updatePosition` logic relies on errors being thrown to skip updates rather than archiving positions. **Example of dangerous pattern:**
```typescript
// ❌ WRONG - silently returns 0 on RPC failure
try {
  balance = await contract.balanceOf(wallet);
} catch {
  balance = 0n; // This will cause positions to be archived on RPC errors!
}

// ✅ CORRECT - let errors propagate
try {
  balance = await contract.balanceOf(wallet);
} catch (error) {
  console.error(`RPC call failed for ${contract.address}:`, error);
  throw new Error(`RPC call failed: ${error}`); // Throw, don't return 0!
}
```
**How it works**: When an adapter throws an error, `updatePosition`'s try-catch (line 146) catches it and logs the failure. The position remains active and will be retried on the next update cycle. When an adapter successfully returns 0, the position is archived as a legitimate exit.

## Protocol-Specific Notes

### Aave v3
- Uses interest-bearing aTokens (e.g., aUSDC)
- `balanceOf()` already includes accrued interest (no need for exchange rate)
- Net flows detected via `Transfer(from, to, value)` events on aToken contract
- Supported assets: USDC, USDT, DAI

### Curve sCrvUSD
- Rebase token (balance increases automatically)
- `balanceOf()` reflects current value including yield
- Net flows via `Transfer` events on sCrvUSD token
- Type: `rebase` (vs. `exchangeRate` tokens)

### Convex cvxCRV
- Unique staking position for cvxCRV tokens earning crvUSD rewards
- Uses `partial` counting mode (only tracks stable crvUSD rewards, ignores volatile cvxCRV principal)
- Reads claimable rewards from staking contract's `earned()` function
- Tracks reward claims via `RewardPaid` events for net flow calculation
- Implementation: `src/adapters/convex-cvxcrv.ts`

### Convex Curve Vault (Generic)
- **Generic adapter** (`src/adapters/convex-curve-vault.ts`) supports multiple Convex-staked Curve vault positions
- Currently supports 8 cvcrvUSD vaults with different collateral types:
  - sDOLA (`convex-cvcrvusd-sdola`)
  - sfrxUSD (`convex-cvcrvusd-sfrxusd`)
  - sUSDe (`convex-cvcrvusd-susde`)
  - fxSAVE (`convex-cvcrvusd-fxsave`)
  - WBTC (`convex-cvcrvusd-wbtc`)
  - sreUSD (`convex-cvcrvusd-sreusd`)
  - wstETH (`convex-cvcrvusd-wsteth`)
  - WETH (`convex-cvcrvusd-weth`)
- All vaults share the same contract pattern:
  - Deposit token: Convex receipt token (0xF403C135812408BFbE8713b5A23a04b3D48AAE31 for most)
  - Staking contract: Unique rewards contract per vault
  - Underlying vault token: Curve vault token (ERC4626)
  - Reward token: crvUSD (0xf939E0A03FB07F59A73314E73794Be0E57ac1b4E)
- Value calculation:
  - Staked balance → converts to underlying crvUSD via ERC4626 `convertToAssets()`
  - Plus claimable crvUSD rewards from staking contract
- Net flows tracked on Convex deposit token (receipt token) via Transfer events
- Uses `count` mode (principal + yield both included)
- **Adding new Convex vaults**: Just add config to `protocols.json`, register in `src/adapters/index.ts`, update `ProtocolKey` type, and insert into database - no new adapter code needed!

## Production Considerations

- **Authentication**: WebAuthn/passkeys implemented with session-based isolation
  - HTTPS required for production (WebAuthn secure context requirement)
  - Use valid domain names, not IP addresses (add `/etc/hosts` entries for local network)
  - Rate limiting on auth endpoints (5 req/15min for registration, 10 req/15min for login)
- **CORS Security**: Configured to allow credentials from frontend origin only (not wildcard)
- **Data Isolation**: Database-level filtering ensures users only see their own wallets/positions
- **RPC Provider Management** (Nov 2025):
  - **Multiple Providers**: Configure via admin panel with individual rate limits and capabilities
  - **Capability-Based Routing**: Normal calls load-balanced across all providers; block scans use scan-capable only
  - **Health Monitoring**: Automatic health tracking with consecutive error counting and exponential backoff
  - **Cost Optimization**: Mix free tiers for different purposes (Alchemy for speed, Infura for scans)
  - **Graceful Degradation**: Protocols requiring scans skip with warnings if no capable providers available
  - **Database Schema**: `rpc_provider` table with `supports_large_block_scans` column (migration 1733000030000)
  - **Admin UI**: Live provider management at `/admin.html` with status monitoring and capability configuration
- **Rate Limiting**: Manual refresh limited to 1 per 5 minutes per user
- **Redis Persistence**: Configure `appendonly yes` to preserve job queue on restart
- **Database Backups**: Schedule regular `pg_dump` for time-series data
- **Monitoring**: Track per-job timings, RPC errors, missing ABIs in logs
- **Session Security**: HTTP-only cookies with secure flag when HTTPS enabled
- **Health Checks**: Simple wget-based health check script supports both HTTP and HTTPS

## File Organization

```
src/
├── adapters/         # Protocol-specific discovery & measurement
│   ├── base.ts      # IProtocolAdapter interface
│   ├── aave-v3.ts   # Aave v3 implementation
│   ├── curve-scrvusd.ts
│   ├── uniswap-v4.ts # NFT-based LP positions with scan-capable provider routing
│   └── index.ts     # Adapter registry
├── jobs/            # BullMQ scheduler (hourly updates)
├── models/          # Database CRUD (wallet, position, snapshot, user, authenticator, rpc-provider)
│   └── rpc-provider.ts # RPC provider configuration management
├── routes/          # Fastify REST API endpoints
│   ├── auth.ts      # WebAuthn authentication (register, login, add-device, logout)
│   ├── wallets.ts   # Wallet management (requires auth)
│   ├── positions.ts # Position listing (requires auth)
│   ├── portfolio.ts # Portfolio aggregation (requires auth)
│   └── admin.ts     # Admin endpoints including RPC provider management
├── services/        # Business logic (discovery, update)
├── types/           # TypeScript type definitions
├── utils/           # APY math, DB connection, Ethereum helpers
│   ├── rpc-manager.ts # RPC provider routing, rate limiting, health tracking
│   └── rpc-proxy-provider.ts # Custom ethers provider with queue-based processing
└── index.ts         # Main server with Fastify + HTTPS setup

frontend/            # Simple frontend (minimal, for testing only)
├── index.html       # Single-page UI with auth redirect
├── auth.html        # Authentication page (register/login)
├── auth.js          # WebAuthn browser integration
├── styles.css       # Dark theme styling
├── app.js           # Vanilla JS API integration
├── config.js        # API base configuration
└── server.js        # Static file server with HTTPS support

config/
├── protocols.json   # Contract addresses, decimals, ABIs
└── abis/           # Ethereum contract ABIs (JSON)

migrations/          # node-pg-migrate schema definitions

docs/                # Technical documentation
└── rpc-provider-routing.md # Comprehensive guide to capability-based RPC routing

docker-entrypoint.sh # Starts both API and frontend servers
healthcheck.sh       # Health check supporting HTTP and HTTPS
```

## Extending the System

**Multi-Chain Support**: Add `chainId` to protocol config and position metadata. Create separate Ethereum provider per chain.

**Partial Counting**: For LP positions with mixed assets, implement stable-only yield extraction logic in adapter's `readCurrentValue()`.

**Health Monitoring**: Add `/metrics` endpoint exposing Prometheus metrics for APY drift, discovery failures, RPC latencies.

**Webhooks**: Create `notification` table with triggers, poll for threshold crossings (APY drop >1%, large withdrawals).
