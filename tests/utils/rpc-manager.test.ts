let mockSendByUrl = new Map<string, jest.Mock>();

jest.mock('ethers', () => ({
  ethers: {
    JsonRpcProvider: jest.fn().mockImplementation((url: string) => ({
      send: (method: string, params: unknown[]) => {
        const send = mockSendByUrl.get(url);
        if (!send) {
          throw new Error(`No mock RPC sender configured for ${url}`);
        }
        return send(method, params);
      },
    })),
  },
}));

import { ethers } from 'ethers';
import { RPCManager, RPCProviderConfig } from '../../src/utils/rpc-manager';

function createConfig(
  name: string,
  url: string,
  priority: number,
  supportsLargeBlockScans: boolean
): RPCProviderConfig {
  return {
    name,
    url,
    callsPerSecond: 100,
    priority,
    isActive: true,
    supportsLargeBlockScans,
  };
}

describe('RPCManager scan routing', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockSendByUrl = new Map<string, jest.Mock>();
    jest.spyOn(console, 'log').mockImplementation(() => undefined);
    jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('fails a throttled scan call over to the next scan-capable provider', async () => {
    const primarySend = jest.fn().mockRejectedValue(new Error('Too Many Requests'));
    const normalOnlySend = jest.fn().mockResolvedValue(['wrong-provider']);
    const backupSend = jest.fn().mockResolvedValue([{ blockNumber: '0x1' }]);
    mockSendByUrl.set('https://primary.example', primarySend);
    mockSendByUrl.set('https://normal.example', normalOnlySend);
    mockSendByUrl.set('https://backup.example', backupSend);

    const manager = new RPCManager([
      createConfig('Primary', 'https://primary.example', 30, true),
      createConfig('Normal only', 'https://normal.example', 20, false),
      createConfig('Backup', 'https://backup.example', 10, true),
    ]);

    await expect(manager.sendScan('eth_getLogs', [{ fromBlock: '0x1', toBlock: '0x2' }]))
      .resolves.toEqual([{ blockNumber: '0x1' }]);

    expect(primarySend).toHaveBeenCalledTimes(1);
    expect(normalOnlySend).not.toHaveBeenCalled();
    expect(backupSend).toHaveBeenCalledTimes(1);
    expect(manager.getStatus().map(({ name, dailyCallCount }) => ({ name, dailyCallCount })))
      .toEqual([
        { name: 'Primary', dailyCallCount: 1 },
        { name: 'Normal only', dailyCallCount: 0 },
        { name: 'Backup', dailyCallCount: 1 },
      ]);
  });

  it('disables ethers request batching for managed provider connections', () => {
    mockSendByUrl.set('https://primary.example', jest.fn());

    new RPCManager([
      createConfig('Primary', 'https://primary.example', 10, true),
    ]);

    expect(ethers.JsonRpcProvider).toHaveBeenCalledWith(
      'https://primary.example',
      undefined,
      { batchMaxCount: 1 }
    );
  });

  it('pins a configured network without chain-id detection calls', () => {
    mockSendByUrl.set('https://arbitrum.example', jest.fn());
    const network = { chainId: 42161n } as any;

    new RPCManager(
      [createConfig('Arbitrum', 'https://arbitrum.example', 10, true)],
      { network }
    );

    expect(ethers.JsonRpcProvider).toHaveBeenCalledWith(
      'https://arbitrum.example',
      network,
      { batchMaxCount: 1, staticNetwork: true }
    );
  });

  it('rejects scan calls when no provider is configured for scans', async () => {
    const normalOnlySend = jest.fn();
    mockSendByUrl.set('https://normal.example', normalOnlySend);
    const manager = new RPCManager([
      createConfig('Normal only', 'https://normal.example', 10, false),
    ]);

    expect(manager.hasScanCapableProviders()).toBe(false);
    await expect(manager.sendScan('eth_getLogs', [])).rejects.toThrow(
      'No scan-capable RPC providers configured'
    );
    expect(normalOnlySend).not.toHaveBeenCalled();
  });

  it('supports configured rates below half a call per second', () => {
    mockSendByUrl.set('https://slow.example', jest.fn());
    const slowConfig = createConfig('Slow', 'https://slow.example', 10, true);
    slowConfig.callsPerSecond = 0.1;

    const manager = new RPCManager([slowConfig]);

    expect(manager.getStatus()[0]?.availableTokens).toBeCloseTo(1);
  });
});
