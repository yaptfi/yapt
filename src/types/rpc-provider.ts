export type RPCProbeErrorCategory =
  | 'authentication'
  | 'rate-limited'
  | 'timeout'
  | 'network'
  | 'wrong-chain'
  | 'rpc-error'
  | 'invalid-response';

export type RPCBlockScanStatus =
  | 'supported'
  | 'range-limited'
  | 'unsupported'
  | 'failed'
  | 'not-tested';

export interface RPCBasicProbeResult {
  ok: boolean;
  latencyMs: number;
  blockNumber?: number;
  errorCategory?: RPCProbeErrorCategory;
  message: string;
}

export interface RPCBlockScanProbeResult {
  compatible: boolean;
  conclusive: boolean;
  status: RPCBlockScanStatus;
  latencyMs: number;
  testedBlockRange?: number;
  maxBlockRange?: number;
  estimatedFullScanQueries?: number;
  errorCategory?: RPCProbeErrorCategory;
  message: string;
}

export interface RPCChainProbeResult {
  probeVersion?: number;
  chainId: number;
  chainName: string;
  checkedAt: string;
  basic: RPCBasicProbeResult;
  blockScan: RPCBlockScanProbeResult;
}

export interface RPCProviderProbeResult {
  ethereum: RPCChainProbeResult;
  arbitrum: RPCChainProbeResult | null;
  canSave: boolean;
}
