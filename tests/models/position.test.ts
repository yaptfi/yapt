jest.mock('../../src/utils/db', () => ({
  query: jest.fn(),
  queryOne: jest.fn(),
  withTransaction: jest.fn(),
  queryOnClient: jest.fn(),
  queryOneOnClient: jest.fn(),
}));

jest.mock('../../src/utils/config', () => ({
  getProtocolConfig: jest.fn(),
}));

jest.mock('../../src/plugins/registry', () => ({
  getLoadedPlugins: jest.fn(),
}));

import { queryOne } from '../../src/utils/db';
import { getProtocolConfig } from '../../src/utils/config';
import { getLoadedPlugins } from '../../src/plugins/registry';
import { createPosition } from '../../src/models/position';

describe('createPosition', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (getProtocolConfig as jest.Mock).mockReturnValue({});
    (getLoadedPlugins as jest.Mock).mockReturnValue([]);
  });

  it('creates a missing protocol row from config metadata before inserting the position', async () => {
    const createdPosition = {
      id: 'position-1',
      walletId: 'wallet-1',
      protocolId: 'protocol-1',
      protocolPositionKey: 'token-1',
      displayName: 'Uniswap v4 WBTC/USDC #1',
      baseAsset: 'USDC',
      stablecoinId: 'stablecoin-1',
      countingMode: 'partial',
      measureMethod: 'rewards',
      metadata: {},
      isActive: true,
      createdAt: new Date('2026-03-06T00:00:00.000Z'),
    };

    (getProtocolConfig as jest.Mock).mockReturnValue({
      'uniswap-v4-wbtc-usdc-rewards': {
        name: 'Uniswap v4 WBTC/USDC',
        abiKeys: [],
      },
    });

    (queryOne as jest.Mock)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ id: 'protocol-1' })
      .mockResolvedValueOnce({ id: 'stablecoin-1' })
      .mockResolvedValueOnce(createdPosition);

    const result = await createPosition('wallet-1', 'uniswap-v4-wbtc-usdc-rewards', {
      protocolPositionKey: 'token-1',
      displayName: 'Uniswap v4 WBTC/USDC #1',
      baseAsset: 'USDC',
      countingMode: 'partial',
      measureMethod: 'rewards',
      metadata: {},
      isActive: true,
    });

    expect(result).toBe(createdPosition);
    expect(queryOne).toHaveBeenCalledTimes(4);
    expect((queryOne as jest.Mock).mock.calls[1][0]).toContain('INSERT INTO protocol (key, name)');
    expect((queryOne as jest.Mock).mock.calls[1][1]).toEqual([
      'uniswap-v4-wbtc-usdc-rewards',
      'Uniswap v4 WBTC/USDC',
    ]);
  });

  it('falls back to loaded plugin metadata when the protocol is not in config', async () => {
    const createdPosition = {
      id: 'position-2',
      walletId: 'wallet-1',
      protocolId: 'protocol-2',
      protocolPositionKey: 'token-2',
      displayName: 'Third Party Protocol',
      baseAsset: 'USDC',
      stablecoinId: 'stablecoin-1',
      countingMode: 'count',
      measureMethod: 'balance',
      metadata: {},
      isActive: true,
      createdAt: new Date('2026-03-06T00:00:00.000Z'),
    };

    (getLoadedPlugins as jest.Mock).mockReturnValue([
      {
        key: 'third-party-protocol',
        name: 'Third Party Protocol',
        source: 'third-party',
      },
    ]);

    (queryOne as jest.Mock)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ id: 'protocol-2' })
      .mockResolvedValueOnce({ id: 'stablecoin-1' })
      .mockResolvedValueOnce(createdPosition);

    const result = await createPosition('wallet-1', 'third-party-protocol', {
      protocolPositionKey: 'token-2',
      displayName: 'Third Party Protocol',
      baseAsset: 'USDC',
      countingMode: 'count',
      measureMethod: 'balance',
      metadata: {},
      isActive: true,
    });

    expect(result).toBe(createdPosition);
    expect((queryOne as jest.Mock).mock.calls[1][1]).toEqual([
      'third-party-protocol',
      'Third Party Protocol',
    ]);
  });

  it('still throws when the protocol key cannot be resolved anywhere', async () => {
    (queryOne as jest.Mock).mockResolvedValueOnce(null);

    await expect(
      createPosition('wallet-1', 'missing-protocol', {
        protocolPositionKey: 'token-3',
        displayName: 'Missing Protocol',
        baseAsset: 'USDC',
        countingMode: 'count',
        measureMethod: 'balance',
        metadata: {},
        isActive: true,
      })
    ).rejects.toThrow('Protocol not found: missing-protocol');

    expect(queryOne).toHaveBeenCalledTimes(1);
  });
});
