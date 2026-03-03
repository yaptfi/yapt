# AGENTS.md

Guidance for coding agents working in this repository. Applies repo-wide.

## Project Purpose
- Yapt tracks stablecoin-focused DeFi yield for Ethereum wallets.
- Backend discovers positions, stores snapshots, computes APY/yield metrics, and serves REST APIs under `/api`.
- Frontend is a separate static app in `frontend/`.

## Engineering principles
Produce code that is correct, secure, clear, maintainable, and efficient. Follow existing project conventions unless clearly harmful. Prefer simple, explicit solutions over clever ones. Use strong typing wherever possible. Keep concerns separated and side effects at the boundaries. Remove real duplication, but do not over-abstract. Write code that is easy for other humans and agents to understand and extend. Validate all external input, use safe APIs, avoid hardcoded secrets, and do not log sensitive data. Handle errors explicitly and with useful context. Avoid obvious code smells. Keep changes focused and minimal. Add or update unit and integration tests where appropriate, including edge cases and regressions. Do not consider work complete unless the code builds, passes checks, and the changed behavior is adequately tested and documented.

## Stack
- Node.js 20+, TypeScript, Fastify, ethers v6
- PostgreSQL, Redis, BullMQ
- Jest, ESLint, ts-jest

## Key Paths
- `src/index.ts`: API entrypoint and plugin init
- `src/routes/*`: API route handlers
- `src/services/*`: business logic (discovery, updates, notifications)
- `src/adapters/*`: protocol adapters
- `src/plugins/*`: plugin loader/registry and built-in protocol plugin wrappers
- `src/models/*`: DB access layer
- `src/utils/*`: config, DB, APY, Ethereum/RPC helpers
- `config/protocols.json`, `config/abis/*`: protocol and ABI config
- `migrations/*.js`: schema/data migrations

## Runbook
- Install: `npm install`
- Configure env: copy `.env.example` to `.env`
- Required env in practice: `DATABASE_URL`, `REDIS_URL`, `SESSION_SECRET`, and at least one RPC source (`ETH_RPC_URL` or DB-configured providers)
- Migrate DB: `npm run migrate`
- Dev: `npm run dev`
- Build/start: `npm run build` then `npm start`
- Quality checks: `npm run typecheck`, `npm run lint`, `npm test`

Docker note:
- `docker compose up -d` is supported, but migrations run from host (production image installs only production deps).
- Production compose commands should use both files: `docker-compose.yml` + `docker-compose.prod.yml`.
- Docker is used for all human testing and deployment. Deployment is done by pushing to github and using github runners to run docker compose on the server, including running migrations.

## Auth and Access
- Auth is WebAuthn/passkey based (`src/routes/auth.ts`) with session cookies.
- Use `requireAuth`/`requireAdmin` middleware for protected routes.
- Preserve per-user data isolation: API reads must be scoped to the authenticated user (typically via `user_wallet` links), not global wallet/position tables.
- Guest endpoints under `/api/guest/*` are intentionally public and must remain read-only.

## Environment Notes
- WebAuthn env is important in production: `RP_NAME`, `RP_ID`, `ORIGIN` (plus `ALLOWED_ORIGINS` for CORS).
- `RP_ID` must be a domain (not an IP) for WebAuthn on non-localhost deployments.
- Optional iOS push support uses APNs env vars (`APNS_KEY_PATH`, `APNS_KEY_ID`, `APNS_TEAM_ID`, `APNS_BUNDLE_ID`).

## Coding Rules
- Keep TypeScript strict and types explicit on exported APIs.
- Use `BigInt` for on-chain quantities; convert with `formatUnits`/`parseUnits`.
- Do not write JS floating-point values directly to Postgres `NUMERIC`; convert to strings (see `createSnapshot`).
- Use `getEnvVar` from `src/utils/config.ts` for required env access.
- Do not hardcode protocol addresses/ABIs/decimals; use config + loaders.
- Keep route handlers thin; put data shaping/business logic in services/models.
- Log with `server.log` in routes; avoid secrets and noisy hot-path logging.
- Fail soft per protocol/position where possible (log and continue).

## Database Conventions
- Use parameterized SQL in `src/models/*`.
- For API-facing reads, alias snake_case to camelCase explicitly.
- Avoid `SELECT *` in API-facing queries.
- Use migrations for schema changes; keep them reversible and safe.
- UUIDs are based on `uuid-ossp`; use `uuid_generate_v4()` unless you explicitly enable `pgcrypto`.

## Position Categories

Positions have three semantic categories, derived at the service layer from the DB-persisted `measureMethod`:

| Category | measureMethod values | Behavior |
|---|---|---|
| `savings` | `balance`, `exchangeRate`, `rebaseIndex`, `subgraph`, `lp-position` | 2-point windowed APY; APY-based income projections; <$10 = exit |
| `fixed-income` | `fixed-income` | YTM APY (same for all windows); value-change detection skipped; income from YTM |
| `rewards` | `rewards` | No APY; absolute yield metrics; <$10 = normal post-claim |

- `measureMethod` is the value stored in DB and set by adapters. Do not change it.
- `positionType` (`PositionCategory`) is derived by `getPositionCategory()` in `src/utils/position-category.ts` and exposed in API responses.
- **Rule**: use `getPositionCategory()` in all service/route code. Do not add raw `measureMethod` string comparisons outside of adapters/migrations.
- The `default` case in `getPositionCategory()` maps to `'savings'` — forward-compatible with new savings-style protocols.

## Scheduler and Update Behavior
- Queue: `position-updates` (`src/jobs/scheduler.ts`).
- Worker concurrency is intentionally `1` (sequential wallet processing).
- Hourly update job is scheduled at `UPDATE_CRON_MINUTE` (default `38`), not necessarily minute `0`.
- Weekly cleanup runs Sunday 02:00 UTC.
- Discovery and update logic treat sub-$10 positions as dust/exit cases.
- Flow detection scans are removed in current update path; APY is snapshot-based and reset-aware.
- `measureMethod: 'rewards'` positions hide APY fields and use absolute yield projections.

## RPC and Provider Routing
- RPC rate limiting is primarily handled by `RPCManager` (not fixed sleep loops).
- `rpcThrottle()` is currently a compatibility no-op; keep existing callsites consistent with nearby code patterns.
- Normal calls (`balanceOf`, reads, etc.) should use `getProvider()`/`getContract()` (load-balanced path).
- Historical scans (`queryFilter`/`getLogs`) should use a scan-capable provider via `getScanCapableProvider()`.
- If no scan-capable provider is available, skip that protocol gracefully and log a warning.
- `supports_large_block_scans` comes from migration `1733000030000_add-rpc-supports-large-block-scans.js`.

## Adapter and Plugin Guidance
- Implement `IProtocolAdapter`/`BaseProtocolAdapter` in `src/sdk/adapter.ts`.
- Required methods: `discover(walletAddress)`, `readCurrentValue(position)`.
- `calcNetFlows` is optional/deprecated in current architecture.
- Built-in adapters are loaded via plugin wrappers in `src/plugins/builtin/*`.
- In adapter value reads, do not swallow RPC failures and return `0`; throw with context so updates retry instead of archiving positions as false exits.
- Return `0` only for confirmed on-chain zero balances/reward values.
- For a new protocol:
  - Add/extend adapter code.
  - Register/load via built-in plugin wrapper.
  - Add protocol config + ABI entries.
  - Ensure protocol DB row (`protocol.key`, `protocol.name`) exists via migration or seed.
- Metadata must stay JSON-serializable (convert `BigInt` to string before persistence).

Protocol-specific gotchas worth preserving:
- Yearn-style ERC4626 vaults can have different share vs asset decimals (`shareDecimals` vs `decimals`).
- Uniswap v4 discovery must scan NFT transfer events and verify current `ownerOf`.
- For Uniswap v4 pool reads, use the Position Manager as owner when querying position state.
- Decode packed int24 ticks with proper two's-complement conversion.

## API and Frontend Notes
- Routes in `src/routes/*` mount under `/api`.
- Guest API is under `/api/guest/*`; default guest wallet comes from `GUEST_DEFAULT_WALLET_ID`.
- Frontend remains framework-free static HTML/CSS/JS in `frontend/`; do not introduce build tooling.

## Testing Expectations
- Prefer deterministic unit tests for pure logic.
- Avoid network-dependent tests by default.
- Existing unit tests include APY utilities and selected adapter logic.

## Useful Docs
- `README.md`
- `docs/rpc-provider-routing.md`
- `docs/RPC_MANAGER.md`
- `docs/ios-client.md`
- `frontend/README.md`
