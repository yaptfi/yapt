import { query, queryOne } from '../utils/db';

export interface UniswapV4InventoryState {
  tokenIds: string[];
  lastScannedBlock: number | null;
  nextTokenId: string | null;
  coldScanCursor: string | null;
  isComplete: boolean;
}

interface InventoryStateRow {
  tokenIds: unknown;
  lastScannedBlock: string | number | null;
  nextTokenId: string | null;
  coldScanCursor: string | null;
  isComplete: boolean;
}

interface PositionTokenRow {
  tokenId: string;
}

function isTokenId(value: unknown): value is string {
  return typeof value === 'string' && /^\d+$/.test(value) && BigInt(value) > 0n;
}

function parseBlockNumber(value: string | number | null): number | null {
  if (value === null) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

function parseTokenIds(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter(isTokenId);
}

export async function getUniswapV4InventoryState(
  walletAddress: string,
  chainId: number,
  positionManager: string
): Promise<UniswapV4InventoryState> {
  const [state, positionTokens] = await Promise.all([
    queryOne<InventoryStateRow>(
      `SELECT
         token_ids as "tokenIds",
         last_scanned_block as "lastScannedBlock",
         next_token_id::text as "nextTokenId",
         cold_scan_cursor::text as "coldScanCursor",
         is_complete as "isComplete"
       FROM uniswap_v4_inventory_state s
       JOIN wallet w ON w.id = s.wallet_id
       WHERE lower(w.address) = lower($1)
         AND s.chain_id = $2
         AND lower(s.position_manager) = lower($3)`,
      [walletAddress, chainId, positionManager]
    ),
    query<PositionTokenRow>(
      `SELECT DISTINCT p.metadata->>'tokenId' as "tokenId"
       FROM position p
       JOIN wallet w ON w.id = p.wallet_id
       WHERE p.is_active = true
         AND lower(w.address) = lower($1)
         AND lower(COALESCE(p.metadata->>'positionManager', '')) = lower($2)
         AND COALESCE(p.metadata->>'chainId', '1') = $3
         AND COALESCE(p.metadata->>'tokenId', '') ~ '^[0-9]+$'`,
      [walletAddress, positionManager, String(chainId)]
    ),
  ]);

  const tokenIds = new Set<string>(parseTokenIds(state?.tokenIds));
  for (const row of positionTokens) {
    if (isTokenId(row.tokenId)) tokenIds.add(row.tokenId);
  }

  return {
    tokenIds: [...tokenIds],
    lastScannedBlock: parseBlockNumber(state?.lastScannedBlock ?? null),
    nextTokenId: state?.nextTokenId ?? null,
    coldScanCursor: state?.coldScanCursor ?? null,
    isComplete: state?.isComplete ?? false,
  };
}

export async function saveUniswapV4InventoryState(
  walletAddress: string,
  chainId: number,
  positionManager: string,
  state: UniswapV4InventoryState
): Promise<void> {
  await query(
    `INSERT INTO uniswap_v4_inventory_state (
       wallet_id,
       chain_id,
       position_manager,
       token_ids,
       last_scanned_block,
       next_token_id,
       cold_scan_cursor,
       is_complete,
       updated_at
     )
     SELECT
       w.id,
       $2,
       lower($3),
       $4::jsonb,
       $5,
       $6,
       $7,
       $8,
       now()
     FROM wallet w
     WHERE lower(w.address) = lower($1)
     ON CONFLICT (wallet_id, chain_id, position_manager)
     DO UPDATE SET
       token_ids = EXCLUDED.token_ids,
       last_scanned_block = EXCLUDED.last_scanned_block,
       next_token_id = EXCLUDED.next_token_id,
       cold_scan_cursor = EXCLUDED.cold_scan_cursor,
       is_complete = EXCLUDED.is_complete,
       updated_at = now()`,
    [
      walletAddress,
      chainId,
      positionManager,
      JSON.stringify(state.tokenIds),
      state.lastScannedBlock,
      state.nextTokenId,
      state.coldScanCursor,
      state.isComplete,
    ]
  );
}
