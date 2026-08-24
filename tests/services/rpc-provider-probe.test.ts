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
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('detects a provider that accepts the full historical scan range', async () => {
    const fetchSpy = jest.spyOn(global, 'fetch')
      .mockResolvedValueOnce(rpcResult('0x1'))
      .mockResolvedValueOnce(rpcResult('0x1500000'))
      .mockResolvedValueOnce(rpcResult([]));

    const result = await probeRPCChain('https://provider.example/key', 1);

    expect(result.basic.ok).toBe(true);
    expect(result.blockScan).toMatchObject({
      compatible: true,
      conclusive: true,
      status: 'supported',
      testedBlockRange: 50_000,
    });
    const logRequest = JSON.parse(String(fetchSpy.mock.calls[2]?.[1]?.body));
    expect(logRequest.method).toBe('eth_getLogs');
    expect(logRequest.params[0]).toMatchObject({
      address: '0xbd216513d74c8cf14cf4747e6aaa6420ff64ee9e',
      fromBlock: '0x14af1f7',
    });
  });

  it('accepts and records a reported 10,000-block range limit after retrying it', async () => {
    const fetchSpy = jest.spyOn(global, 'fetch')
      .mockResolvedValueOnce(rpcResult('0xa4b1'))
      .mockResolvedValueOnce(rpcResult('0x1dadbe44'))
      .mockResolvedValueOnce(rpcError(-32602, 'range 49999 exceeds limit of 10000'))
      .mockResolvedValueOnce(rpcResult([]));

    const result = await probeRPCChain('https://provider.example/arbitrum-key', 42161);

    expect(result.basic.ok).toBe(true);
    expect(result.blockScan).toMatchObject({
      compatible: true,
      conclusive: true,
      status: 'range-limited',
      testedBlockRange: 10_000,
      maxBlockRange: 10_000,
    });
    const retryRequest = JSON.parse(String(fetchSpy.mock.calls[3]?.[1]?.body));
    const retryFilter = retryRequest.params[0];
    expect(parseInt(retryFilter.toBlock, 16) - parseInt(retryFilter.fromBlock, 16) + 1).toBe(10_000);
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
      .mockResolvedValueOnce(rpcError(-32005, 'Too Many Requests'));

    const result = await probeRPCProviderUrls('https://provider.example/rate-limited');

    expect(result.ethereum.blockScan).toMatchObject({
      compatible: false,
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
      .mockResolvedValueOnce(rpcError(-32602, 'block range exceeds limit of 10 blocks'));

    const result = await probeRPCChain('https://provider.example/tiny-range', 1);

    expect(result.blockScan).toMatchObject({
      compatible: false,
      conclusive: true,
      status: 'unsupported',
      maxBlockRange: 10,
    });
  });
});
