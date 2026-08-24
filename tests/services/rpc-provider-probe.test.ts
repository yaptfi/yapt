import { probeRPCChain, probeRPCProviderUrls } from '../../src/services/rpc-provider-probe';

function rpcResult(result: unknown, status = 200): Response {
  return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result }), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function rpcError(code: number, message: string, status = 200): Response {
  return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, error: { code, message } }), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('RPC provider capability probe', () => {
  beforeEach(() => {
    delete process.env.UNISWAP_V4_SCAN_CHUNK_SIZE;
    delete process.env.UNISWAP_V4_MAX_LOG_QUERIES;
  });

  afterEach(() => {
    jest.restoreAllMocks();
    delete process.env.UNISWAP_V4_SCAN_CHUNK_SIZE;
    delete process.env.UNISWAP_V4_MAX_LOG_QUERIES;
  });

  it('detects a provider that accepts the full historical scan range', async () => {
    const fetchSpy = jest.spyOn(global, 'fetch')
      .mockResolvedValueOnce(rpcResult('0x1'))
      .mockResolvedValueOnce(rpcResult('0x1500000'))
      .mockResolvedValueOnce(rpcResult('0x01'))
      .mockResolvedValueOnce(rpcResult([]));

    const result = await probeRPCChain('https://provider.example/key', 1);

    expect(result.basic.ok).toBe(true);
    expect(result.blockScan).toMatchObject({
      compatible: true,
      incrementalCompatible: true,
      conclusive: true,
      status: 'supported',
      testedBlockRange: 500_000,
    });
    const stateRequest = JSON.parse(String(fetchSpy.mock.calls[2]?.[1]?.body));
    expect(stateRequest.method).toBe('eth_call');
    const logRequest = JSON.parse(String(fetchSpy.mock.calls[3]?.[1]?.body));
    expect(logRequest.method).toBe('eth_getLogs');
    expect(logRequest.params[0]).toMatchObject({
      address: '0xbd216513d74c8cf14cf4747e6aaa6420ff64ee9e',
      fromBlock: '0x14af1f7',
    });
  });

  it('rejects an Arbitrum endpoint whose range limit would require thousands of calls', async () => {
    const fetchSpy = jest.spyOn(global, 'fetch')
      .mockResolvedValueOnce(rpcResult('0xa4b1'))
      .mockResolvedValueOnce(rpcResult('0x1dadbe44'))
      .mockResolvedValueOnce(rpcResult('0x030a28'))
      .mockResolvedValueOnce(rpcError(-32602, 'range 49999 exceeds limit of 10000'))
      .mockResolvedValueOnce(rpcResult([]));

    const result = await probeRPCChain('https://provider.example/arbitrum-key', 42161);

    expect(result.basic.ok).toBe(true);
    expect(result.blockScan).toMatchObject({
      compatible: false,
      incrementalCompatible: true,
      conclusive: true,
      status: 'unsupported',
      testedBlockRange: 10_000,
      maxBlockRange: 10_000,
      estimatedFullScanQueries: 20_009,
    });
    const retryRequest = JSON.parse(String(fetchSpy.mock.calls[4]?.[1]?.body));
    const retryFilter = retryRequest.params[0];
    expect(parseInt(retryFilter.toBlock, 16) - parseInt(retryFilter.fromBlock, 16) + 1).toBe(10_000);
  });

  it('still accepts a 10,000-block limit when the chain history fits the call budget', async () => {
    jest.spyOn(global, 'fetch')
      .mockResolvedValueOnce(rpcResult('0x1'))
      .mockResolvedValueOnce(rpcResult('0x1500000'))
      .mockResolvedValueOnce(rpcResult('0x01'))
      .mockResolvedValueOnce(rpcError(-32602, 'range exceeds limit of 10000'))
      .mockResolvedValueOnce(rpcResult([]));

    const result = await probeRPCChain('https://provider.example/ethereum-key', 1);

    expect(result.blockScan).toMatchObject({
      compatible: true,
      incrementalCompatible: true,
      conclusive: true,
      status: 'range-limited',
      testedBlockRange: 10_000,
      estimatedFullScanQueries: 34,
    });
  });

  it('reports a wrong-chain URL without attempting historical logs', async () => {
    const fetchSpy = jest.spyOn(global, 'fetch').mockResolvedValueOnce(rpcResult('0x1'));

    const result = await probeRPCChain('https://provider.example/wrong-chain', 42161);

    expect(result.basic).toMatchObject({ ok: false, errorCategory: 'wrong-chain' });
    expect(result.blockScan).toMatchObject({ status: 'not-tested', conclusive: true });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('treats a temporarily unavailable basic RPC as inconclusive', async () => {
    jest.spyOn(global, 'fetch')
      .mockResolvedValueOnce(rpcError(-32603, 'service temporarily unavailable'));

    const result = await probeRPCChain('https://provider.example/unavailable', 1);

    expect(result.basic).toMatchObject({ ok: false, errorCategory: 'network' });
    expect(result.blockScan).toMatchObject({ status: 'not-tested', conclusive: false });
  });

  it('does not expose endpoint URLs or keys in probe errors', async () => {
    jest.spyOn(global, 'fetch').mockRejectedValueOnce(
      new Error('network failure for https://provider.example/rpc/super-secret-key')
    );

    const result = await probeRPCChain('https://provider.example/rpc/super-secret-key', 1);

    expect(result.basic.message).toContain('[RPC endpoint]');
    expect(result.basic.message).not.toContain('super-secret-key');
  });

  it('keeps a rate-limited scan inconclusive so the wizard requires a retry', async () => {
    jest.spyOn(global, 'fetch')
      .mockResolvedValueOnce(rpcResult('0x1'))
      .mockResolvedValueOnce(rpcResult('0x1500000'))
      .mockResolvedValueOnce(rpcResult('0x01'))
      .mockResolvedValueOnce(rpcError(-32005, 'Too Many Requests'));

    const result = await probeRPCProviderUrls('https://provider.example/rate-limited');

    expect(result.ethereum.blockScan).toMatchObject({
      compatible: false,
      incrementalCompatible: false,
      conclusive: false,
      status: 'failed',
      errorCategory: 'rate-limited',
    });
    expect(result.canSave).toBe(false);
  });

  it('rejects a block limit below the useful discovery minimum', async () => {
    jest.spyOn(global, 'fetch')
      .mockResolvedValueOnce(rpcResult('0x1'))
      .mockResolvedValueOnce(rpcResult('0x1500000'))
      .mockResolvedValueOnce(rpcResult('0x01'))
      .mockResolvedValueOnce(rpcError(-32602, 'block range exceeds limit of 10 blocks'));

    const result = await probeRPCChain('https://provider.example/tiny-range', 1);

    expect(result.blockScan).toMatchObject({
      compatible: false,
      incrementalCompatible: false,
      conclusive: true,
      status: 'unsupported',
      maxBlockRange: 10,
    });
  });

  it('accepts a 6,250-block Arbitrum endpoint for incremental v4 discovery', async () => {
    jest.spyOn(global, 'fetch')
      .mockResolvedValueOnce(rpcResult('0xa4b1'))
      .mockResolvedValueOnce(rpcResult('0x1dadbe44'))
      .mockResolvedValueOnce(rpcResult('0x030a28'))
      .mockResolvedValueOnce(rpcError(-32602, 'range exceeds limit of 6250'))
      .mockResolvedValueOnce(rpcResult([]));

    const result = await probeRPCChain('https://provider.example/narrow-arbitrum', 42161);

    expect(result.probeVersion).toBe(3);
    expect(result.blockScan).toMatchObject({
      compatible: false,
      incrementalCompatible: true,
      conclusive: true,
      status: 'unsupported',
      testedBlockRange: 6_250,
      maxBlockRange: 6_250,
    });
    expect(result.blockScan.message).toContain('Incremental Uniswap v4 discovery is supported');
  });
});
