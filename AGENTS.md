# AGENTS.md

Guidance for coding agents working in this repository. This file applies to the entire repo (root scope).

## Project Overview
- Purpose: Backend service that discovers DeFi yield positions for Ethereum wallets and tracks stablecoin-denominated income and APY.
- Stack: Node.js 20+, TypeScript, Fastify, ethers v6, PostgreSQL, BullMQ (Redis), Jest, ESLint.
- Entrypoint: `src/index.ts` (serves REST API under `/api`). Frontend now lives under `frontend/` and is served separately.
- Jobs: Hourly updates scheduled via BullMQ in `src/jobs/scheduler.ts`.

Recent updates (Oct 2025)
- Aave v3 optimizations: Multicall3 batching + per‑wallet cache for aToken balances (cuts duplicate RPCs); in‑memory last‑scanned block cursor to shrink log windows; global RPC throttling to respect provider per‑second caps.
- Yearn V3 improvements: support for gauge share tokens via `gaugeToken` in protocol config; distinct `shareDecimals` vs underlying `decimals`; more robust net‑flow + value paths for ERC4626 vaults.
- Rewards positions (e.g., Convex cvxCRV): APY disabled by design; snapshots store yield‑only deltas; UI/API hide APY and show absolute yield projections.
- New protocol adapter: Morpheus Gauntlet USDC Prime (gtUSDC) as ERC4626 (config key `morpheus-gtusdc-prime`).
- Frontend: Login screen now exposes a "View as guest" link pointing to a predefined wallet (resolves via `/api/admin/wallets`).
- **RPC Provider Routing** (Nov 2025): Capability-based routing system directs block scans to capable providers (Infura) while load-balancing normal calls across all providers (including Alchemy free tier). Providers have `supportsLargeBlockScans` flag. See `docs/rpc-provider-routing.md` for full details.

Useful docs: `backend/README.md` (backend usage), `frontend/README.md` (UI), `DOCKER_DEPLOY.md` (containerized), `CLAUDE.md` (system architecture + adapter tips).

## Runbook
- Install deps: `npm install`
- Configure env: copy `.env.example` to `.env` and set `ETH_RPC_URL`, `DATABASE_URL`, `REDIS_URL`, `SESSION_SECRET`.
- DB migrations: `npm run migrate` (uses `node-pg-migrate`).
- Dev server: `npm run dev` (tsx watch).
- Build/start: `npm run build` then `npm start`.
- Tests: `npm test` (Jest via ts-jest).
- Lint/typecheck: `npm run lint` and `npm run typecheck`.

Docker notes
- Quick start: `docker compose up -d` with `.env` prepared. API at http://localhost:3000
- Known caveat: Migrations run from host, not container, because `node-pg-migrate` is a devDependency and the production image uses `npm ci --only=production`.

## Code Conventions
- TypeScript strict mode; keep types precise. Prefer explicit types on exported functions.
- Use `BigInt` for on-chain quantities; convert with `formatUnits`/`parseUnits` in `src/utils/ethereum.ts`.
- Never rely on JS floating-point for DB writes of monetary values. When writing numeric to Postgres `NUMERIC`, convert to strings (see `createSnapshot`).
- Environment access goes through `getEnvVar` in `src/utils/config.ts` for fail-fast behavior.
- Don’t hardcode addresses/decimals/ABIs. Use `config/protocols.json` and `config/abis/*`. Load via `getProtocolConfig()` and `getAbi()`.
- Rate limiting: Discovery and updates throttle with `sleep(1000)` between items to respect RPC rate limits. Preserve or justify any changes.
- RPC throttling (new): In addition to the above sleeps, use the global `rpcThrottle()` helper in `src/utils/ethereum.ts` before issuing multiple JSON‑RPC calls in the same code path (e.g., back‑to‑back `queryFilter`, `balanceOf` + `convertToAssets`). Default interval is 1000ms (override with `RPC_MIN_INTERVAL_MS`).
- Logging: Use Fastify logger (`server.log`) in routes; `console` is acceptable in adapter/service internals but avoid logging secrets or full payloads. Avoid noisy logs in hot paths.
- Errors: Fail soft for per-protocol/per-position operations; log and continue so one failure doesn’t stop the batch.

Database conventions
- Model files live in `src/models/*` and must use parameterized queries.
- For any data returned to API, alias snake_case columns to camelCase using explicit `SELECT ... AS "camelCase"`. Do not `SELECT *` in API-facing queries.
- Schema evolves via `migrations/*.js` with `node-pg-migrate`. Prefer idempotent, reversible changes and safe data migrations.
- UUIDs: The initial migration enables `uuid-ossp`. Be aware that `gen_random_uuid()` requires `pgcrypto` (not enabled here). If you add a down migration relying on it, also enable `pgcrypto` or use `uuid_generate_v4()` consistently.

Testing
- Unit tests live under `src/**` and use ts-jest. Existing coverage focuses on APY utilities (`src/utils/apy.test.ts`).
- Add tests for pure logic (math, helpers). Avoid networked/E2E tests that require Ethereum or external services.
- Keep tests deterministic and fast; no sleeps and no RPC by default.

## API & Routing
- REST routes in `src/routes/*` register under `/api`. Maintain response shapes shown in `README.md` examples.
- Prefer enriching data in service layer (`src/services/*`). Keep route handlers thin.
- Rewards positions in API responses: For positions with `measureMethod: 'rewards'`, the API omits APY fields (`apy`, `apy7d`, `apy30d`) and provides absolute yield projections (avg daily, projected monthly/yearly) when available. This is reflected in both authenticated and guest routes.
- Rate limit manual refreshes in `src/routes/portfolio.ts` (5-minute cooldown). Preserve this guard.

## Scheduler & Jobs
- BullMQ queue name: `position-updates`. A repeatable job runs hourly (`'0 * * * *'`).
- Worker concurrency is 5; leave conservative unless you’ve validated provider limits.
- Updating a wallet enqueues per-wallet jobs and calls `updateWallet` with a 1s delay between positions.
- Global throttling & cursors (new):
  - `src/services/update.ts` fetches `currentBlock` once per position and reuses it.
  - Maintains an in‑memory `lastScannedBlocks` cursor per position to bound log windows for net‑flows; adapters should return `toBlock` to advance the cursor.
  - Combined with `rpcThrottle()`, this keeps provider calls within per‑second caps.

## Protocol Adapters
- Location: `src/adapters/*`. Implement `BaseProtocolAdapter` with methods:
  - `discover(walletAddress)`: Return `Partial<Position>[]` for non-zero balances; include `metadata` with everything needed later (addresses, decimals, type, walletAddress).
  - `readCurrentValue(position)`: Return USD value. For ERC4626 vaults, convert shares to assets via `convertToAssets`. Use stable price overrides from `getStablePriceOverrides()`; default to 1.0 for stables.
  - `calcNetFlows(position, fromBlock, toBlock)`: Prefer `detectNetFlowsFromTransfers` over bespoke event parsing when possible. Treat incoming transfers as deposits (+) and outgoing as withdrawals (-). For reward-only positions, treat claims as withdrawals on the reward token.
- Register new adapters in `src/adapters/index.ts` and add config/ABI entries:
  - `config/protocols.json`: Add addresses/decimals/type and `abiKeys`.
  - `config/abis/<Key>.json`: Include required ABI fragments.
- Database `protocol` row: Either insert manually or add a migration that upserts the protocol (`key`, `name`). Ensure positions upsert on `(wallet_id, protocol_position_key)`.

Adapter guidance (recent patterns)
- ERC4626 vaults: Distinguish between underlying `decimals` and vault share `shareDecimals`; read shares via `balanceOf`, convert with `convertToAssets`, price via stable override when applicable.
- Yearn V3 vaults: You may specify an optional `gaugeToken` in `config/protocols.json` for gauge‑wrapped shares. The adapter detects balances on gauge or vault share token and tracks transfers on the chosen share token.
- Aave v3: Use the built‑in per‑wallet aToken balance cache (populated via Multicall3) to avoid duplicate `balanceOf` calls in discover and read; prefer the cache and batch fetch on cache miss.
- Net‑flows: Prefer a single log scan per token per window; the service maintains a last‑scanned block cursor. Avoid issuing two separate requests when one can be filtered client‑side.
- NFT-based LP positions (Uniswap v3/v4): See detailed guidance below for discovery, ownership model, tick math, and serialization.

NFT-based LP position adapters (Uniswap v3/v4)
- **Discovery**: Scan Transfer events on Position Manager NFT contract (not ERC721Enumerable). Query both received (`Transfer(null, wallet)`) and sent (`Transfer(wallet, null)`) events to filter out transferred-away NFTs. Verify current ownership with `ownerOf(tokenId)`.
- **Ownership model**: Position Manager contract owns the actual liquidity in the pool; users own NFT tokens that represent claims on that liquidity. When querying pool state (e.g., `getPositionInfo`), use Position Manager address as owner, NOT the wallet address.
- **Tick unpacking**: For packed position data, use proper two's complement conversion for int24 ticks:
  ```typescript
  const tickUint = Number((info >> 8n) & 0xFFFFFFn);
  const tick = tickUint >= (1 << 23) ? tickUint - (1 << 24) : tickUint;
  ```
- **Liquidity value**: Use proper Uniswap tick math to calculate token amounts from liquidity. Get current pool price (`getSlot0`), calculate sqrt prices at tick bounds (`getSqrtRatioAtTick`), then use `getAmountsForLiquidity` formula. For stablecoin pairs near 1:1, this is critical for accuracy.
- **Fee calculation**: Use formula `(feeGrowthCurrent - feeGrowthLast) * liquidity / Q128` where Q128 = 2^128. Query both current fee growth (`getFeeGrowthInside`) and last recorded fee growth (`getPositionInfo`) for each token.
- **BigInt serialization**: Position metadata may contain BigInt values (fees, tick spacing, etc.). Convert to strings before storing in database: `fee: poolKey.fee.toString()`. JavaScript's JSON.stringify cannot handle BigInt and will throw "Do not know how to serialize a BigInt".
- **Net flows**: Track `IncreaseLiquidity` (deposits) and `DecreaseLiquidity` (withdrawals) events on Position Manager, filtering by tokenId. Sum token amounts assuming $1.00 for stablecoins.
- **RPC Provider Routing**: IMPORTANT - Use `getScanCapableProvider()` for historical event queries (see below).

RPC Provider Routing for Adapters
- **Normal calls** (balanceOf, convertToAssets, current state): Use regular `getProvider()` or `getContract()` - these route through the load balancer.
- **Block scanning** (queryFilter, getLogs for historical events): Use scan-capable provider to avoid hitting provider limits:
  ```typescript
  const { getProvider } = await import('../utils/ethereum');
  const proxyProvider = getProvider();
  let scanProvider;

  if ('getRPCManager' in proxyProvider && typeof proxyProvider.getRPCManager === 'function') {
    const manager = (proxyProvider as any).getRPCManager();
    scanProvider = manager.getScanCapableProvider();

    if (!scanProvider) {
      console.warn('[ProtocolName] No scan-capable RPC provider available - skipping discovery');
      return [];
    }
  } else {
    scanProvider = proxyProvider; // Fallback for single-provider setups
  }

  const contract = new ethers.Contract(address, abi, scanProvider);
  const events = await contract.queryFilter(filter); // Uses scan-capable provider
  ```
- **Why this matters**: Alchemy free tier limits eth_getLogs to 10 blocks. Infura supports 100k+ blocks. By routing scans to capable providers, we can use Alchemy for fast balance checks while Infura handles heavy historical scans.
- **Graceful degradation**: If no scan-capable providers available, skip the protocol and log a warning. Don't throw errors that stop discovery for other protocols.

Position semantics
- `countingMode`:
  - `count`: principal + yield count toward portfolio.
  - `partial`: only stable-yield leg counts (e.g., reward-only adapters).
  - `ignore`: excluded from totals.
- `measureMethod` hints UI/API behavior:
  - `balance`/`exchangeRate`/`rebaseIndex`: APY shown; income from percentage-based estimate.
  - `rewards`: APY generally hidden; use absolute yield metrics from recent snapshots.

APY calculation and display
- APY is computed on demand from snapshots using a simple two‑point method with flows correction, anchored at resets:
  - 4h APY (“recent”): latest snapshot vs. snapshot closest to 4 hours earlier (reference must be ≥59 minutes old).
  - 7d APY: latest vs. snapshot closest to 7 days earlier; if a reset occurred within the window, use the most recent reset as the baseline.
  - 30d APY: latest vs. snapshot closest to 30 days earlier; likewise anchored at the most recent reset when applicable.
- Each APY uses the actual elapsed time between those two points and subtracts summed `net_flows_usd` within the window from the base before annualizing.
- Display rule: hide 7d APY when it rounds (2 decimals, percent) to the same value as 4h; hide 30d APY when it rounds to the same value as the displayed 7d APY (or 4h if 7d hidden).

APY reset rules
- The updater creates a reset snapshot (`is_reset = true`) when a position experiences a large change:
  - Large explained flow (big deposit/withdrawal in the window), or
  - Large unexplained change (value drift not explained by flows).
- Resets segment APY history; two‑point calculations never cross a reset boundary (they anchor to the most recent reset if it’s within the requested window).

## Public UI
- Static files live in `frontend/` and provide a minimal dashboard. Keep assets simple and framework-free.
- API base defaults to `/api`; configurable via `frontend/config.js` when served from a different origin.
- Do not introduce client build tooling or frameworks here.
- Guest view link (new): The login screen includes a “View as guest” link to a predefined wallet. It resolves the wallet ID via `/api/admin/wallets` and navigates to `guest.html?wallet=<id>`.

## Review Checklist (before opening a PR or finalizing changes)
- `npm run typecheck` passes.
- `npm run lint` passes (no unused vars; `_`-prefixed args allowed).
- `npm test` passes (and you added tests for new pure logic).
- `npm run build` produces a working `dist/`.
- No hard-coded secrets or RPC URLs. Uses `getEnvVar`.
- DB queries alias columns for API responses; no `SELECT *` leaks.
- New adapters wired into registry and `config/protocols.json` with ABIs present.
- Logs are informative but not noisy; no sensitive data.
- RPC optimization sanity:
  - `rpcThrottle()` used where high‑frequency calls might burst (e.g., consecutive `queryFilter` or paired value reads).
  - Multicall batching preferred over multiple sequential `eth_call`s when safe.

## Known Gaps / Caveats
- Single-user MVP: Session plugin is present, but wallets/positions are globally visible. Do not implement multi-tenancy unless explicitly requested.
- RPC resilience: Provider-specific routing is implemented (see above). Automatic failover works for load-balanced calls but not for direct scan-capable provider access. Health tracking with consecutive error counting and backoff periods is in place.
- RPC capping: Providers like Infura enforce per‑second caps. The codebase includes a global throttle and 1s inter‑item sleeps; avoid introducing new bursts. The capability-based routing system (Nov 2025) allows mixing providers with different limits (e.g., Alchemy free tier for fast calls, Infura for scans).
- Docker migration caveat as noted above; run migrations from host.
- Database schema: New `rpc_provider` table with `supports_large_block_scans` column. Run migration 1733000030000 to add the column.

## Safe Changes for Agents
- Add or tweak adapters following the interface and config patterns.
- Improve APY math/tests in `src/utils/apy.ts` and `src/utils/apy.test.ts`.
- Extend routes to expose additional read-only views of existing data.
- Add idempotent migrations for schema improvements and protocol seeds.
- Bug fixes that align with conventions above (avoid broad refactors).
- RPC efficiency tweaks consistent with the patterns above (e.g., batching via Multicall, adding `rpcThrottle()` around tight call sequences) are welcome.
