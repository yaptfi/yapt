jest.mock('../../src/utils/db', () => ({
  query: jest.fn(),
  queryOne: jest.fn(),
  withTransaction: jest.fn(),
  queryOnClient: jest.fn(),
  queryOneOnClient: jest.fn(),
}));

import { queryOne } from '../../src/utils/db';
import { createPosition } from '../../src/models/position';

describe('createPosition', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('throws when the protocol row is missing instead of auto-creating it', async () => {
    (queryOne as jest.Mock).mockResolvedValueOnce(null);

    await expect(
      createPosition('wallet-1', 'uniswap-v4-wbtc-usdc-rewards', {
        protocolPositionKey: 'token-1',
        displayName: 'Uniswap v4 WBTC/USDC #1',
        baseAsset: 'USDC',
        countingMode: 'partial',
        measureMethod: 'rewards',
        metadata: {},
        isActive: true,
      })
    ).rejects.toThrow('Protocol not found: uniswap-v4-wbtc-usdc-rewards');

    expect(queryOne).toHaveBeenCalledTimes(1);
  });

  it('creates the position when the protocol row already exists', async () => {
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

    (queryOne as jest.Mock)
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
    expect(queryOne).toHaveBeenCalledTimes(3);
  });
});
