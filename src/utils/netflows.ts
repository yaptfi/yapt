import { Contract } from 'ethers';
import { TransferEvent, NetFlowResult } from '../types';
import { formatUnits, rpcThrottle } from './ethereum';

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function queryWithBackoff(
  contract: Contract,
  filter: any,
  fromBlock: number,
  toBlock: number
) {
  const MAX_ATTEMPTS = 4;
  let attempt = 0;
  let delayMs = 1000;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      await rpcThrottle();
      return await contract.queryFilter(filter, fromBlock, toBlock);
    } catch (err: any) {
      const msg = String(err?.shortMessage || err?.message || '');
      const isRateLimited = msg.includes('Too Many Requests') || msg.includes('-32005');
      if (isRateLimited && attempt < MAX_ATTEMPTS - 1) {
        await sleep(delayMs);
        attempt++;
        delayMs = Math.min(Math.floor(delayMs * 1.5), 5000);
        continue;
      }
      throw err;
    }
  }
}

/**
 * Detect net flows from ERC20 Transfer events
 *
 * Optimization: For short time windows (< 7200 blocks ≈ 24 hours), use a single
 * query with client-side filtering to reduce RPC calls from 2 to 1.
 *
 * @param tokenContract - The token contract to query
 * @param userAddress - The user's wallet address
 * @param decimals - Token decimals
 * @param fromBlock - Starting block
 * @param toBlock - Ending block
 * @param priceUsd - Price per token in USD (typically 1.0 for stablecoins)
 * @returns Net flows in USD and actual block range
 */
export async function detectNetFlowsFromTransfers(
  tokenContract: Contract,
  userAddress: string,
  decimals: number,
  fromBlock: number,
  toBlock: number | 'latest',
  priceUsd: number = 1.0
): Promise<NetFlowResult> {
  const actualToBlock = toBlock === 'latest'
    ? await tokenContract.runner?.provider?.getBlockNumber() || 0
    : toBlock;

  const blockRange = actualToBlock - fromBlock;
  const SHORT_WINDOW_THRESHOLD = 7200; // ~24 hours at 12s/block

  let netFlowTokens = 0n;

  // For short windows, use single scan with client-side filtering (1 RPC call)
  if (blockRange < SHORT_WINDOW_THRESHOLD) {
    // Query all Transfer events (no from/to filter)
    await rpcThrottle();
    const allTransfers = await queryWithBackoff(
      tokenContract,
      tokenContract.filters.Transfer(),
      fromBlock,
      actualToBlock
    );

    const userLower = userAddress.toLowerCase();

    // Client-side filtering: separate in/out transfers
    for (const event of allTransfers) {
      if ('args' in event) {
        const from = event.args[0]?.toLowerCase() || '';
        const to = event.args[1]?.toLowerCase() || '';
        const value = event.args[2];

        if (value === undefined) continue;

        const amount = BigInt(value.toString());

        // Incoming: user is recipient
        if (to === userLower && from !== userLower) {
          netFlowTokens += amount;
        }
        // Outgoing: user is sender
        else if (from === userLower && to !== userLower) {
          netFlowTokens -= amount;
        }
        // Self-transfers are ignored (neutral flow)
      }
    }
  } else {
    // For long windows, use two separate filtered queries (2 RPC calls)
    // This is more efficient when the block range is large

    // Get Transfer events where user is the recipient (deposits/mints)
    await rpcThrottle();
    const transfersIn = await queryWithBackoff(
      tokenContract,
      tokenContract.filters.Transfer(null, userAddress),
      fromBlock,
      actualToBlock
    );

    // Get Transfer events where user is the sender (withdrawals/burns)
    await rpcThrottle();
    const transfersOut = await queryWithBackoff(
      tokenContract,
      tokenContract.filters.Transfer(userAddress, null),
      fromBlock,
      actualToBlock
    );

    // Add incoming transfers
    for (const event of transfersIn) {
      if ('args' in event) {
        const value = event.args[2];
        if (value !== undefined) {
          netFlowTokens += BigInt(value.toString());
        }
      }
    }

    // Subtract outgoing transfers
    for (const event of transfersOut) {
      if ('args' in event) {
        const value = event.args[2];
        if (value !== undefined) {
          netFlowTokens -= BigInt(value.toString());
        }
      }
    }
  }

  // Convert to human-readable units and USD
  const netFlowsTokensReadable = parseFloat(formatUnits(netFlowTokens, decimals));
  const netFlowsUsd = netFlowsTokensReadable * priceUsd;

  return {
    netFlowsUsd,
    fromBlock,
    toBlock: actualToBlock,
  };
}

/**
 * Parse Transfer event from event log
 */
export function parseTransferEvent(log: any): TransferEvent {
  return {
    from: log.args?.[0] || '',
    to: log.args?.[1] || '',
    value: BigInt(log.args?.[2]?.toString() || '0'),
    blockNumber: log.blockNumber,
    transactionHash: log.transactionHash,
  };
}

/**
 * Detect if user made an exit transfer (complete position exit)
 * Checks for outgoing Transfer events where user sent their entire balance
 *
 * @param tokenContract - The token contract to query
 * @param userAddress - The user's wallet address
 * @param fromBlock - Starting block
 * @param toBlock - Ending block
 * @param expectedBalance - Expected transfer amount (previous balance)
 * @returns TransferEvent if exit detected, null otherwise
 */
export async function detectExitTransfer(
  tokenContract: Contract,
  userAddress: string,
  fromBlock: number,
  toBlock: number | 'latest',
  expectedBalance: bigint
): Promise<TransferEvent | null> {
  const actualToBlock = toBlock === 'latest'
    ? await tokenContract.runner?.provider?.getBlockNumber() || 0
    : toBlock;

  // Get Transfer events where user is the sender (potential exits)
  const transfersOut = await tokenContract.queryFilter(
    tokenContract.filters.Transfer(userAddress, null),
    fromBlock,
    actualToBlock
  );

  // Look for transfers that match the expected balance (with 1% tolerance for rebase tokens)
  const tolerance = expectedBalance / 100n; // 1% tolerance
  const minAcceptable = expectedBalance - tolerance;
  const maxAcceptable = expectedBalance + tolerance;

  for (const event of transfersOut) {
    if ('args' in event) {
      const value = BigInt(event.args[2]?.toString() || '0');
      const to = event.args[1];

      // Check if this is a full exit (not a self-transfer)
      if (to.toLowerCase() !== userAddress.toLowerCase() &&
          value >= minAcceptable &&
          value <= maxAcceptable) {
        return parseTransferEvent(event);
      }
    }
  }

  return null;
}
