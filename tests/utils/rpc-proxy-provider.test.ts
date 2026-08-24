import { RPCProxyProvider } from '../../src/utils/rpc-proxy-provider';

function createManager(hasScanCapableProviders: boolean) {
  return {
    getConfigs: jest.fn().mockReturnValue([{ url: 'https://rpc.example' }]),
    hasScanCapableProviders: jest.fn().mockReturnValue(hasScanCapableProviders),
    send: jest.fn().mockResolvedValue('normal-result'),
    sendScan: jest.fn().mockResolvedValue('scan-result'),
    getStatus: jest.fn().mockReturnValue([]),
    getQueueStatus: jest.fn().mockReturnValue({}),
    getENSCapableProvider: jest.fn().mockReturnValue(null),
  };
}

describe('RPCProxyProvider scan routing', () => {
  it('returns a stable provider that sends calls through the scan queue', async () => {
    const manager = createManager(true);
    const provider = new RPCProxyProvider(manager as any);

    const firstScanProvider = provider.getScanCapableProvider();
    const secondScanProvider = provider.getScanCapableProvider();

    expect(firstScanProvider).not.toBeNull();
    expect(firstScanProvider).toBe(secondScanProvider);
    await expect(firstScanProvider!.send('eth_getLogs', [])).resolves.toBe('scan-result');
    expect(manager.sendScan).toHaveBeenCalledWith('eth_getLogs', []);
    expect(manager.send).not.toHaveBeenCalled();
  });

  it('returns null when no scan-capable provider is configured', () => {
    const manager = createManager(false);
    const provider = new RPCProxyProvider(manager as any);

    expect(provider.getScanCapableProvider()).toBeNull();
  });
});
