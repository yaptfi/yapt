import { getAllAdapters, getAdapter } from '../plugins/registry';
import { createPosition } from '../models/position';
import { Position, ProtocolKey } from '../types';
import { createSnapshot, getLatestSnapshot } from '../models/snapshot';
import { toChecksumAddress } from '../utils/ethereum';
import { DISCOVERY_SLEEP_MS } from '../constants';

export type DiscoveryProgressCallback = (event: {
  type: 'start' | 'protocol_start' | 'position_found' | 'protocol_complete' | 'complete' | 'error';
  data: any;
}) => void;

/**
 * Sleep utility for rate limiting
 */
function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Core discovery logic - discovers positions with optional progress callbacks
 * Rate-limited to 1 protocol per second to respect RPC provider limits
 */
async function discoverPositionsCore(
  walletId: string,
  walletAddress: string,
  onProgress?: DiscoveryProgressCallback
): Promise<Position[]> {
  const checksumAddress = toChecksumAddress(walletAddress);
  const adapters = getAllAdapters();
  const discoveredPositions: Position[] = [];

  // Notify start if callback provided
  if (onProgress) {
    onProgress({ type: 'start', data: { totalProtocols: adapters.length } });
  } else {
    console.log(`Discovering positions for ${adapters.length} protocols (rate-limited: 1 protocol/second)...`);
  }

  for (let i = 0; i < adapters.length; i++) {
    const adapter = adapters[i];
    let positionsFoundForProtocol = 0;

    try {
      // Notify protocol start
      if (onProgress) {
        onProgress({
          type: 'protocol_start',
          data: {
            protocol: adapter.protocolName,
            index: i + 1,
            total: adapters.length,
          },
        });
      } else {
        console.log(`[${i + 1}/${adapters.length}] Discovering ${adapter.protocolName}...`);
      }

      const positions = await adapter.discover(checksumAddress);

      for (const positionData of positions) {
        try {
          // Add wallet address and protocol key to metadata for use in updates
          const enrichedMetadata = {
            ...positionData.metadata,
            walletAddress: checksumAddress,
            protocolKey: adapter.protocolKey,
          };

          // Create a temporary position object to check value before persisting
          const tempPosition = {
            ...positionData,
            metadata: enrichedMetadata,
          } as Position;

          // Read current value before creating position to filter out dust
          const currentValue = await adapter.readCurrentValue(tempPosition);

          // Skip positions with less than $10 value (likely dust from closed positions)
          if (currentValue < 10) {
            console.log(`Skipping ${adapter.protocolName} position with dust value $${currentValue.toFixed(2)}`);
            continue;
          }

          const position = await createPosition(walletId, adapter.protocolKey, {
            ...positionData,
            metadata: enrichedMetadata,
          });

          discoveredPositions.push(position);
          positionsFoundForProtocol++;

          // Only create initial snapshot if position doesn't already have one
          // (prevents daily discovery from overwriting APY-containing snapshots)
          const existingSnapshot = await getLatestSnapshot(position.id);

          if (!existingSnapshot) {
            try {
              await createSnapshot(
                position.id,
                new Date(),
                currentValue,
                0, // Initial snapshot has no net flows
                0, // Initial snapshot has no yield delta
                null // No APY for first snapshot
              );

              // Notify about found position if callback provided
              if (onProgress) {
                onProgress({
                  type: 'position_found',
                  data: {
                    protocol: adapter.protocolName,
                    displayName: position.displayName,
                    baseAsset: position.baseAsset,
                    valueUsd: currentValue,
                  },
                });
              }
            } catch (error) {
              console.error(`Failed to create initial snapshot for position ${position.id}:`, error);
            }
          } else {
            console.log(`Position ${position.id} already has snapshots - skipping initial snapshot creation`);
          }
        } catch (error) {
          console.error(`Failed to create position for ${adapter.protocolName}:`, error);
        }
      }

      // Notify protocol complete
      if (onProgress) {
        onProgress({
          type: 'protocol_complete',
          data: {
            protocol: adapter.protocolName,
            positionsFound: positionsFoundForProtocol,
          },
        });
      }

      // Add delay between protocols to respect RPC rate limits
      // Skip delay after the last protocol
      if (i < adapters.length - 1) {
        await sleep(DISCOVERY_SLEEP_MS);
      }
    } catch (error) {
      console.error(`Discovery failed for ${adapter.protocolName}:`, error);
      // Notify error if callback provided
      if (onProgress) {
        onProgress({
          type: 'protocol_complete',
          data: {
            protocol: adapter.protocolName,
            positionsFound: 0,
          },
        });
      }
      // Continue to next protocol even if this one fails
    }
  }

  // Notify completion
  if (onProgress) {
    onProgress({
      type: 'complete',
      data: { totalPositions: discoveredPositions.length },
    });
  } else {
    console.log(`Discovery complete: found ${discoveredPositions.length} positions`);
  }

  return discoveredPositions;
}

/**
 * Discover all positions for a wallet across all protocols
 * Rate-limited to 1 protocol per second to respect RPC provider limits
 */
export async function discoverPositions(
  walletId: string,
  walletAddress: string
): Promise<Position[]> {
  return discoverPositionsCore(walletId, walletAddress);
}

/**
 * Discover all positions for a wallet with progress callbacks
 * Used for SSE streaming to frontend
 */
export async function discoverPositionsWithProgress(
  walletId: string,
  walletAddress: string,
  onProgress: DiscoveryProgressCallback
): Promise<Position[]> {
  return discoverPositionsCore(walletId, walletAddress, onProgress);
}

/**
 * Discover positions for a specific protocol
 */
export async function discoverPositionsForProtocol(
  walletId: string,
  walletAddress: string,
  protocolKey: ProtocolKey
): Promise<Position[]> {
  const checksumAddress = toChecksumAddress(walletAddress);
  const adapter = getAdapter(protocolKey);
  const discoveredPositions: Position[] = [];

  try {
    const positions = await adapter.discover(checksumAddress);

    for (const positionData of positions) {
      const enrichedMetadata = {
        ...positionData.metadata,
        walletAddress: checksumAddress,
        protocolKey: adapter.protocolKey,
      };

      // Create a temporary position object to check value before persisting
      const tempPosition = {
        ...positionData,
        metadata: enrichedMetadata,
      } as Position;

      // Read current value before creating position to filter out dust
      const currentValue = await adapter.readCurrentValue(tempPosition);

      // Skip positions with less than $10 value (likely dust from closed positions)
      if (currentValue < 10) {
        console.log(`Skipping ${adapter.protocolName} position with dust value $${currentValue.toFixed(2)}`);
        continue;
      }

      const position = await createPosition(walletId, adapter.protocolKey, {
        ...positionData,
        metadata: enrichedMetadata,
      });

      discoveredPositions.push(position);

      // Only create initial snapshot if position doesn't already have one
      // (prevents daily discovery from overwriting APY-containing snapshots)
      const existingSnapshot = await getLatestSnapshot(position.id);

      if (!existingSnapshot) {
        try {
          await createSnapshot(
            position.id,
            new Date(),
            currentValue,
            0,
            0,
            null
          );
        } catch (error) {
          console.error(`Failed to create initial snapshot for position ${position.id}:`, error);
        }
      } else {
        console.log(`Position ${position.id} already has snapshots - skipping initial snapshot creation`);
      }
    }
  } catch (error) {
    console.error(`Discovery failed for ${protocolKey}:`, error);
  }

  return discoveredPositions;
}
