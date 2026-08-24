import { ethers } from 'ethers';
import { getProtocolConfig } from '../utils/config';
import {
  RPCBasicProbeResult,
  RPCBlockScanProbeResult,
  RPCChainProbeResult,
  RPCProbeErrorCategory,
  RPCProviderProbeResult,
} from '../types/rpc-provider';
import {
  getUniswapV4MaxLogQueries,
  getUniswapV4ScanChunkSize,
} from '../utils/uniswap-v4-scan-config';

const ETHEREUM_CHAIN_ID = 1;
const ARBITRUM_CHAIN_ID = 42161;
const MINIMUM_INCREMENTAL_SCAN_RANGE = 1_000;
const PROBE_TIMEOUT_MS = 8_000;
const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
// An indexed address topic always has twelve leading zero bytes, so this topic
// cannot match a valid ERC-721 `from` address. It keeps capability probes small
// while still forcing the provider to execute the requested historical range.
const IMPOSSIBLE_ADDRESS_TOPIC = `0x${'f'.repeat(64)}`;
const NEXT_TOKEN_ID_CALL_DATA = ethers.id('nextTokenId()').slice(0, 10);

interface ProbeTarget {
  chainId: number;
  chainName: string;
  protocolKey: string;
}

interface JsonRpcErrorPayload {
  code?: number;
  message?: string;
  data?: unknown;
}

class RPCProbeRequestError extends Error {
  constructor(
    message: string,
    readonly category: RPCProbeErrorCategory,
    readonly rpcError?: JsonRpcErrorPayload
  ) {
    super(message);
    this.name = 'RPCProbeRequestError';
  }
}

const PROBE_TARGETS: Record<number, ProbeTarget> = {
  [ETHEREUM_CHAIN_ID]: {
    chainId: ETHEREUM_CHAIN_ID,
    chainName: 'Ethereum',
    protocolKey: 'uniswap-v4-eth-usdc-ethereum-rewards',
  },
  [ARBITRUM_CHAIN_ID]: {
    chainId: ARBITRUM_CHAIN_ID,
    chainName: 'Arbitrum',
    protocolKey: 'uniswap-v4-eth-usdc-arbitrum-rewards',
  },
};

function validateRPCUrl(rawUrl: string): string {
  const trimmed = rawUrl.trim();
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error('RPC URL must be a valid HTTP or HTTPS URL');
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('RPC URL must use HTTP or HTTPS');
  }
  return trimmed;
}

function sanitizeMessage(message: string): string {
  const withoutUrls = message.replace(/https?:\/\/[^\s"')]+/gi, '[RPC endpoint]');
  return withoutUrls.length > 300 ? `${withoutUrls.slice(0, 297)}...` : withoutUrls;
}

function classifyError(
  message: string,
  httpStatus?: number,
  rpcCode?: number
): RPCProbeErrorCategory {
  const normalized = message.toLowerCase();
  if (
    httpStatus === 429 ||
    rpcCode === -32005 ||
    normalized.includes('too many requests') ||
    normalized.includes('rate limit')
  ) {
    return 'rate-limited';
  }
  if (
    httpStatus === 401 ||
    httpStatus === 403 ||
    normalized.includes('unauthorized') ||
    normalized.includes('forbidden') ||
    normalized.includes('invalid api key') ||
    normalized.includes('invalid project id')
  ) {
    return 'authentication';
  }
  if (normalized.includes('timeout') || normalized.includes('timed out') || normalized.includes('aborted')) {
    return 'timeout';
  }
  if (
    (httpStatus !== undefined && httpStatus >= 500) ||
    normalized.includes('fetch failed') ||
    normalized.includes('econn') ||
    normalized.includes('enotfound') ||
    normalized.includes('network') ||
    normalized.includes('temporarily unavailable') ||
    normalized.includes('service unavailable')
  ) {
    return 'network';
  }
  return 'rpc-error';
}

function isTransientErrorCategory(category: RPCProbeErrorCategory | undefined): boolean {
  return category === 'rate-limited' || category === 'timeout' || category === 'network';
}

async function rpcRequest<T>(url: string, method: string, params: unknown[]): Promise<T> {
  let response: Response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'RPC request failed';
    throw new RPCProbeRequestError(sanitizeMessage(message), classifyError(message));
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new RPCProbeRequestError(
      `RPC endpoint returned invalid JSON (HTTP ${response.status})`,
      response.status >= 400
        ? classifyError(`HTTP ${response.status}`, response.status)
        : 'invalid-response'
    );
  }

  const record = payload && typeof payload === 'object' && !Array.isArray(payload)
    ? payload as Record<string, unknown>
    : null;
  const rpcError = record?.error && typeof record.error === 'object'
    ? record.error as JsonRpcErrorPayload
    : undefined;

  if (!response.ok || rpcError) {
    const message = sanitizeMessage(
      rpcError?.message || `RPC endpoint returned HTTP ${response.status}`
    );
    throw new RPCProbeRequestError(
      message,
      classifyError(message, response.status, rpcError?.code),
      rpcError
    );
  }

  if (!record || !Object.prototype.hasOwnProperty.call(record, 'result')) {
    throw new RPCProbeRequestError('RPC response did not include a result', 'invalid-response');
  }

  return record.result as T;
}

function getErrorText(error: unknown): string {
  if (error instanceof RPCProbeRequestError) {
    return [error.message, error.rpcError?.message, JSON.stringify(error.rpcError?.data)]
      .filter(Boolean)
      .join(' ');
  }
  return error instanceof Error ? error.message : String(error);
}

function isRangeLimitError(error: unknown): boolean {
  const message = getErrorText(error).toLowerCase();
  return (
    message.includes('block range') ||
    message.includes('response size exceeded') ||
    /range.{0,120}exceeds.{0,40}limit/s.test(message) ||
    (message.includes('range') && message.includes('limit'))
  );
}

function getReportedRangeLimit(error: unknown): number | null {
  const normalized = getErrorText(error).replace(/,/g, '');
  const patterns = [
    /(?:block\s+)?range[^.\n]{0,120}?exceeds(?:\s+the)?\s+limit(?:\s+of)?\s+([\d]+)/i,
    /(?:maximum|max)(?:\s+allowed)?\s+(?:block\s+)?range(?:\s+is|\s+of|:)?\s+([\d]+)/i,
    /limited\s+to\s+(?:a\s+)?([\d]+)\s+blocks?/i,
    /limit(?:ed)?\s+(?:of|to)\s+([\d]+)\s+blocks?/i,
  ];

  for (const pattern of patterns) {
    const match = normalized.match(pattern);
    if (!match?.[1]) continue;
    const limit = Number(match[1]);
    if (Number.isSafeInteger(limit) && limit > 0) return limit;
  }
  return null;
}

function getProbeTargetConfig(target: ProbeTarget): { address: string; fromBlock: number } {
  const config = getProtocolConfig()[target.protocolKey];
  if (!config?.positionManager || config.deployBlock === undefined) {
    throw new Error(`Historical scan probe target is not configured for ${target.chainName}`);
  }
  return { address: config.positionManager, fromBlock: config.deployBlock };
}

async function probeBasic(url: string, target: ProbeTarget): Promise<RPCBasicProbeResult> {
  const startedAtMs = Date.now();
  try {
    const actualChainId = Number(BigInt(await rpcRequest<string>(url, 'eth_chainId', [])));
    if (actualChainId !== target.chainId) {
      return {
        ok: false,
        latencyMs: Date.now() - startedAtMs,
        errorCategory: 'wrong-chain',
        message: `Wrong chain: expected ${target.chainId}, received ${actualChainId}`,
      };
    }

    const blockNumber = Number(BigInt(await rpcRequest<string>(url, 'eth_blockNumber', [])));
    return {
      ok: true,
      latencyMs: Date.now() - startedAtMs,
      blockNumber,
      message: `Connected at block ${blockNumber}`,
    };
  } catch (error) {
    const requestError = error instanceof RPCProbeRequestError ? error : null;
    return {
      ok: false,
      latencyMs: Date.now() - startedAtMs,
      errorCategory: requestError?.category || 'rpc-error',
      message: sanitizeMessage(error instanceof Error ? error.message : String(error)),
    };
  }
}

async function probeBlockScan(
  url: string,
  target: ProbeTarget,
  latestBlock: number
): Promise<RPCBlockScanProbeResult> {
  const startedAtMs = Date.now();
  const { address, fromBlock } = getProbeTargetConfig(target);
  let range = getUniswapV4ScanChunkSize();
  const maxEstimatedFullScanQueries = getUniswapV4MaxLogQueries();
  let adapted = false;
  let usedReportedLimit = false;

  try {
    const nextTokenId = await rpcRequest<string>(url, 'eth_call', [{
      to: address,
      data: NEXT_TOKEN_ID_CALL_DATA,
    }, 'latest']);
    BigInt(nextTokenId);
  } catch (error) {
    const requestError = error instanceof RPCProbeRequestError ? error : null;
    return {
      compatible: false,
      incrementalCompatible: false,
      conclusive: !isTransientErrorCategory(requestError?.category),
      status: requestError?.category === 'rpc-error' ? 'unsupported' : 'failed',
      latencyMs: Date.now() - startedAtMs,
      errorCategory: requestError?.category || 'rpc-error',
      message: `Uniswap v4 state reads failed: ${sanitizeMessage(error instanceof Error ? error.message : String(error))}`,
    };
  }

  while (range >= MINIMUM_INCREMENTAL_SCAN_RANGE) {
    try {
      const logs = await rpcRequest<unknown[]>(url, 'eth_getLogs', [{
        address,
        fromBlock: `0x${fromBlock.toString(16)}`,
        toBlock: `0x${(fromBlock + range - 1).toString(16)}`,
        topics: [TRANSFER_TOPIC, IMPOSSIBLE_ADDRESS_TOPIC],
      }]);
      if (!Array.isArray(logs)) {
        throw new RPCProbeRequestError('eth_getLogs returned a non-array result', 'invalid-response');
      }

      const historyBlocks = Math.max(0, latestBlock - fromBlock + 1);
      const estimatedFullScanQueries = Math.ceil(historyBlocks / range);
      if (estimatedFullScanQueries > maxEstimatedFullScanQueries) {
        return {
          compatible: false,
          incrementalCompatible: true,
          conclusive: true,
          status: 'unsupported',
          latencyMs: Date.now() - startedAtMs,
          testedBlockRange: range,
          maxBlockRange: range,
          estimatedFullScanQueries,
          message:
            `Historical logs work at ${range.toLocaleString()} blocks, but a full-history scan would require ` +
            `about ${estimatedFullScanQueries.toLocaleString()} queries (maximum ${maxEstimatedFullScanQueries.toLocaleString()}). ` +
            'Incremental Uniswap v4 discovery is supported.',
        };
      }

      return {
        compatible: true,
        incrementalCompatible: true,
        conclusive: true,
        status: adapted ? 'range-limited' : 'supported',
        latencyMs: Date.now() - startedAtMs,
        testedBlockRange: range,
        maxBlockRange: adapted ? range : undefined,
        estimatedFullScanQueries,
        message: adapted
          ? usedReportedLimit
            ? `Historical logs supported with a ${range.toLocaleString()}-block range limit`
            : `Historical logs supported with a tested ${range.toLocaleString()}-block range`
          : `Historical logs supported for at least ${range.toLocaleString()} blocks`,
      };
    } catch (error) {
      if (!isRangeLimitError(error)) {
        const requestError = error instanceof RPCProbeRequestError ? error : null;
        return {
          compatible: false,
          incrementalCompatible: false,
          conclusive: !isTransientErrorCategory(requestError?.category),
          status: requestError?.category === 'rpc-error' ? 'unsupported' : 'failed',
          latencyMs: Date.now() - startedAtMs,
          errorCategory: requestError?.category || 'rpc-error',
          message: sanitizeMessage(error instanceof Error ? error.message : String(error)),
        };
      }

      const reportedLimit = getReportedRangeLimit(error);
      const nextRange = reportedLimit !== null && reportedLimit < range
        ? reportedLimit
        : Math.floor(range / 2);
      if (nextRange < MINIMUM_INCREMENTAL_SCAN_RANGE) {
        return {
          compatible: false,
          incrementalCompatible: false,
          conclusive: true,
          status: 'unsupported',
          latencyMs: Date.now() - startedAtMs,
          maxBlockRange: Math.max(0, nextRange),
          message: `Reported block range ${nextRange.toLocaleString()} is below the incremental minimum of ${MINIMUM_INCREMENTAL_SCAN_RANGE.toLocaleString()}`,
        };
      }
      usedReportedLimit = reportedLimit !== null && reportedLimit < range;
      range = nextRange;
      adapted = true;
    }
  }

  return {
    compatible: false,
    incrementalCompatible: false,
    conclusive: true,
    status: 'unsupported',
    latencyMs: Date.now() - startedAtMs,
    message: 'Historical log range is too small for wallet discovery',
  };
}

export async function probeRPCChain(url: string, chainId: number): Promise<RPCChainProbeResult> {
  const target = PROBE_TARGETS[chainId];
  if (!target) throw new Error(`Unsupported RPC probe chain: ${chainId}`);
  const normalizedUrl = validateRPCUrl(url);
  const basic = await probeBasic(normalizedUrl, target);
  const basicFailureIsConclusive = !basic.ok && !isTransientErrorCategory(basic.errorCategory);
  const blockScan = basic.ok
    ? await probeBlockScan(normalizedUrl, target, basic.blockNumber as number)
    : {
        compatible: false,
        incrementalCompatible: false,
        conclusive: basicFailureIsConclusive,
        status: 'not-tested' as const,
        latencyMs: 0,
        errorCategory: basic.errorCategory,
        message: 'Historical logs were not tested because the basic RPC check failed',
      };

  return {
    probeVersion: 3,
    chainId,
    chainName: target.chainName,
    checkedAt: new Date().toISOString(),
    basic,
    blockScan,
  };
}

export async function probeRPCProviderUrls(
  ethereumUrl: string,
  arbitrumUrl?: string | null
): Promise<RPCProviderProbeResult> {
  const normalizedArbitrumUrl = arbitrumUrl?.trim() || null;
  const [ethereum, arbitrum] = await Promise.all([
    probeRPCChain(ethereumUrl, ETHEREUM_CHAIN_ID),
    normalizedArbitrumUrl
      ? probeRPCChain(normalizedArbitrumUrl, ARBITRUM_CHAIN_ID)
      : Promise.resolve(null),
  ]);

  const results = [ethereum, arbitrum].filter((result): result is RPCChainProbeResult => result !== null);
  return {
    ethereum,
    arbitrum,
    canSave: results.every((result) => result.basic.ok && result.blockScan.conclusive),
  };
}
