import { query, queryOne } from '../utils/db';

/**
 * Checkpoint for a user-filtered historical log scan.
 *
 * `scannedFromBlock..scannedToBlock` is the contiguous, inclusive block range
 * already scanned (both null when nothing has been scanned yet). `foundKeys`
 * holds event-derived identifiers that still need on-chain verification.
 */
export interface WalletLogScanState {
  scannedFromBlock: number | null;
  scannedToBlock: number | null;
  foundKeys: string[];
}

interface WalletLogScanStateRow {
  scannedFromBlock: string | number | null;
  scannedToBlock: string | number | null;
  foundKeys: unknown;
}

function parseBlockNumber(value: string | number | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

function parseFoundKeys(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((key): key is string => typeof key === 'string' && key.length > 0))];
}

export async function getWalletLogScanState(
  walletAddress: string,
  chainId: number,
  scanKey: string
): Promise<WalletLogScanState> {
  const row = await queryOne<WalletLogScanStateRow>(
    `SELECT
       s.scanned_from_block as "scannedFromBlock",
       s.scanned_to_block as "scannedToBlock",
       s.found_keys as "foundKeys"
     FROM wallet_log_scan_state s
     JOIN wallet w ON w.id = s.wallet_id
     WHERE lower(w.address) = lower($1)
       AND s.chain_id = $2
       AND s.scan_key = $3`,
    [walletAddress, chainId, scanKey]
  );

  const scannedFromBlock = parseBlockNumber(row?.scannedFromBlock);
  const scannedToBlock = parseBlockNumber(row?.scannedToBlock);
  const hasValidRange = scannedFromBlock !== null && scannedToBlock !== null && scannedFromBlock <= scannedToBlock;

  return {
    scannedFromBlock: hasValidRange ? scannedFromBlock : null,
    scannedToBlock: hasValidRange ? scannedToBlock : null,
    foundKeys: parseFoundKeys(row?.foundKeys),
  };
}

export async function saveWalletLogScanState(
  walletAddress: string,
  chainId: number,
  scanKey: string,
  state: WalletLogScanState
): Promise<void> {
  await query(
    `INSERT INTO wallet_log_scan_state (
       wallet_id,
       chain_id,
       scan_key,
       scanned_from_block,
       scanned_to_block,
       found_keys,
       updated_at
     )
     SELECT w.id, $2, $3, $4, $5, $6::jsonb, now()
     FROM wallet w
     WHERE lower(w.address) = lower($1)
     ON CONFLICT (wallet_id, chain_id, scan_key)
     DO UPDATE SET
       scanned_from_block = EXCLUDED.scanned_from_block,
       scanned_to_block = EXCLUDED.scanned_to_block,
       found_keys = EXCLUDED.found_keys,
       updated_at = now()`,
    [
      walletAddress,
      chainId,
      scanKey,
      state.scannedFromBlock,
      state.scannedToBlock,
      JSON.stringify([...new Set(state.foundKeys)]),
    ]
  );
}
