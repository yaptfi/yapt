import { ConvexCvxCrvAdapter } from '../../src/adapters/convex-cvxcrv';
import { Position } from '../../src/types';

const CRV_USD_ADDRESS = '0xf939E0A03FB07F59A73314E73794Be0E57ac1b4E';
const STAKING_CONTRACT = '0xaa0C3f5F7DFD688C6E646F66CD2a6B66ACdbE434';

// Mock entire modules — factory must not reference outer-scope variables.
jest.mock('../../src/utils/config', () => ({
  getAbi: jest.fn().mockReturnValue([]),
  getStablePriceOverrides: jest.fn(),
}));

jest.mock('../../src/utils/ethereum', () => ({
  getContract: jest.fn(),
  toChecksumAddress: (a: string) => a,
  formatUnits: (_amount: bigint, _decimals: number) => '1.0',
}));

import { getStablePriceOverrides } from '../../src/utils/config';
import { getContract } from '../../src/utils/ethereum';

const POSITION: Position = {
  id: 'pos-1',
  walletId: 'wallet-1',
  protocolId: 'proto-1',
  stablecoinId: 'stable-1',
  protocolPositionKey: `${STAKING_CONTRACT}:cvxCRV`,
  displayName: 'Convex cvxCRV → crvUSD',
  baseAsset: 'crvUSD',
  countingMode: 'partial',
  measureMethod: 'rewards',
  isActive: true,
  createdAt: new Date(),
  metadata: {
    walletAddress: '0xUserAddress',
    stakingContract: STAKING_CONTRACT,
    rewardToken: CRV_USD_ADDRESS,
    rewardDecimals: 18,
    cvxCrvDecimals: 18,
  },
};

describe('ConvexCvxCrvAdapter.readCurrentValue', () => {
  let mockEarned: jest.Mock;

  beforeEach(() => {
    mockEarned = jest.fn().mockResolvedValue([
      { token: CRV_USD_ADDRESS, amount: 1000000000000000000n }, // 1.0 crvUSD
    ]);
    (getContract as jest.Mock).mockReturnValue({ earned: mockEarned });
    (getStablePriceOverrides as jest.Mock).mockReturnValue({ crvUSD: 0.97 });
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  it('applies the stable price override instead of hardcoded 1.0 (depegged scenario)', async () => {
    // getStablePriceOverrides returns { crvUSD: 0.97 } (depegged)
    // 1.0 crvUSD * 0.97 price = 0.97 USD
    const adapter = new ConvexCvxCrvAdapter();
    const value = await adapter.readCurrentValue(POSITION);
    expect(value).toBeCloseTo(0.97, 5);
  });

  it('returns full value when price override is 1.0', async () => {
    (getStablePriceOverrides as jest.Mock).mockReturnValue({ crvUSD: 1.0 });

    const adapter = new ConvexCvxCrvAdapter();
    const value = await adapter.readCurrentValue(POSITION);
    expect(value).toBeCloseTo(1.0, 5);
  });

  it('returns 0 when crvUSD is not in earned rewards', async () => {
    mockEarned.mockResolvedValue([
      { token: '0xOtherToken', amount: 1000000000000000000n },
    ]);

    const adapter = new ConvexCvxCrvAdapter();
    const value = await adapter.readCurrentValue(POSITION);
    expect(value).toBe(0);
  });
});
