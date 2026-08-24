import { UniswapV4WbtcUsdcRewardsAdapter } from '../../src/adapters/uniswap-v4-wbtc-usdc-rewards';
import { Position } from '../../src/types';

const PROTOCOL_KEY = 'uniswap-v4-wbtc-usdc-rewards';
const POSITION_MANAGER = '0xd88F38F930b7952f2DB2432Cb002E7abbF3dD869';
const RAW_STATE_VIEW = '0x76FD297E2D437Cd7F76d50F01afe6160f86e9990';
const STATE_VIEW = '0x76fd297e2d437cd7f76d50f01afe6160f86e9990';
const WBTC = '0x2f2a2543B76A4166549F7aab2e75Bef0aefC5B0f';
const USDC = '0xaf88d065e77c8cC2239327C5EDb3A432268e5831';
const ARBITRUM_CHAIN_ID = 42161;
const Q128 = 2n ** 128n;
const WALLET_ADDRESS = '0x80D0d54050C15971b21e877D95441800f5AA9ee8';

jest.mock('../../src/utils/config', () => ({
  getProtocolConfig: jest.fn(),
  getAbi: jest.fn().mockReturnValue([]),
  getStablePriceOverrides: jest.fn(),
}));

jest.mock('../../src/utils/ethereum', () => ({
  ETHEREUM_CHAIN_ID: 1,
  ARBITRUM_CHAIN_ID: 42161,
  getContract: jest.fn(),
  getProviderForChain: jest.fn(),
  getScanCapableProviderForChain: jest.fn(),
  normalizeAddress: jest.fn((address: string) => {
    if (address === RAW_STATE_VIEW) {
      return STATE_VIEW;
    }
    return address;
  }),
  toChecksumAddress: (address: string) => address,
  formatUnits: jest.fn(),
}));

jest.mock('../../src/utils/uniswap-v4-inventory', () => ({
  getWalletUniswapV4Inventory: jest.fn(),
}));

import { getAbi, getProtocolConfig, getStablePriceOverrides } from '../../src/utils/config';
import {
  formatUnits,
  getContract,
  getProviderForChain,
  getScanCapableProviderForChain,
} from '../../src/utils/ethereum';
import { getWalletUniswapV4Inventory } from '../../src/utils/uniswap-v4-inventory';

const CONFIG = {
  [PROTOCOL_KEY]: {
    name: 'Uniswap v4 WBTC/USDC',
    chainId: ARBITRUM_CHAIN_ID,
    positionManager: POSITION_MANAGER,
    stateView: RAW_STATE_VIEW,
    currency0: WBTC,
    currency1: USDC,
    currency0Decimals: 8,
    currency1Decimals: 6,
    rewardToken: USDC,
    rewardDecimals: 6,
    baseAsset: 'USDC',
    abiKeys: ['UniswapV4PositionManager', 'UniswapV4StateView'],
    deployBlock: 297842893,
  },
};

function createInventoryEntry() {
  return {
    tokenId: '146749',
    poolId: '0xpool',
    tickLower: -10,
    tickUpper: 10,
    poolKey: {
      currency0: WBTC,
      currency1: USDC,
      fee: 500n,
      tickSpacing: 10n,
      hooks: '0x0000000000000000000000000000000000000000',
    },
  };
}

const POSITION: Position = {
  id: 'position-1',
  walletId: 'wallet-1',
  protocolId: 'protocol-1',
  protocolPositionKey: `${POSITION_MANAGER}:146749`,
  displayName: 'Uniswap v4 WBTC/USDC #146749',
  baseAsset: 'USDC',
  stablecoinId: 'stablecoin-1',
  countingMode: 'partial',
  measureMethod: 'rewards',
  metadata: {
    walletAddress: WALLET_ADDRESS,
    tokenId: '146749',
    positionManager: POSITION_MANAGER,
    stateView: RAW_STATE_VIEW,
    poolId: '0xpool',
    tickLower: -10,
    tickUpper: 10,
    rewardTokenIndex: 1,
    rewardDecimals: 6,
    chainId: ARBITRUM_CHAIN_ID,
  },
  isActive: true,
  createdAt: new Date(),
};

describe('UniswapV4WbtcUsdcRewardsAdapter', () => {
  let stateViewContract: {
    getPositionInfo: jest.Mock;
    getFeeGrowthInside: jest.Mock;
  };
  let positionManagerContract: {
    ownerOf: jest.Mock;
  };

  beforeEach(() => {
    jest.clearAllMocks();
    (getProtocolConfig as jest.Mock).mockReturnValue(CONFIG);
    (getAbi as jest.Mock).mockReturnValue([]);
    (getStablePriceOverrides as jest.Mock).mockReturnValue({ USDC: 1.0 });
    (getProviderForChain as jest.Mock).mockReturnValue({ name: 'arbitrum-provider' });
    (getScanCapableProviderForChain as jest.Mock).mockReturnValue({ name: 'arbitrum-scan-provider' });
    (formatUnits as jest.Mock).mockReturnValue('0');

    stateViewContract = {
      getPositionInfo: jest.fn().mockResolvedValue([2n, 0n, 0n]),
      getFeeGrowthInside: jest.fn().mockResolvedValue([0n, Q128]),
    };
    positionManagerContract = {
      ownerOf: jest.fn().mockResolvedValue(WALLET_ADDRESS),
    };
    (getContract as jest.Mock).mockImplementation((address: string) => {
      if (address === STATE_VIEW) {
        return stateViewContract;
      }
      return positionManagerContract;
    });
  });

  it('discovers Arbitrum positions with the configured chain scan provider only when liquidity remains', async () => {
    const scanProvider = { name: 'arbitrum-scan-provider' };
    (getScanCapableProviderForChain as jest.Mock).mockReturnValue(scanProvider);
    (getWalletUniswapV4Inventory as jest.Mock).mockResolvedValue([createInventoryEntry()]);
    stateViewContract.getPositionInfo.mockResolvedValue([3n, 0n, 0n]);

    const adapter = new UniswapV4WbtcUsdcRewardsAdapter();
    const discovered = await adapter.discover(WALLET_ADDRESS);

    expect(getScanCapableProviderForChain).toHaveBeenCalledWith(ARBITRUM_CHAIN_ID);
    expect(getWalletUniswapV4Inventory).toHaveBeenCalledWith(
      WALLET_ADDRESS,
      POSITION_MANAGER,
      297842893,
      scanProvider
    );
    expect(getContract).toHaveBeenCalledWith(STATE_VIEW, [], scanProvider);
    expect(discovered).toHaveLength(1);
    expect(discovered[0]?.metadata).toMatchObject({
      tokenId: '146749',
      rewardTokenIndex: 1,
      rewardDecimals: 6,
      chainId: ARBITRUM_CHAIN_ID,
      allowZeroValueDiscovery: true,
    });
  });

  it('skips zero-liquidity shells during discovery', async () => {
    const scanProvider = { name: 'arbitrum-scan-provider' };
    (getScanCapableProviderForChain as jest.Mock).mockReturnValue(scanProvider);
    (getWalletUniswapV4Inventory as jest.Mock).mockResolvedValue([createInventoryEntry()]);
    stateViewContract.getPositionInfo.mockResolvedValue([0n, 0n, 0n]);

    const adapter = new UniswapV4WbtcUsdcRewardsAdapter();
    const discovered = await adapter.discover(WALLET_ADDRESS);

    expect(discovered).toEqual([]);
  });

  it('propagates terminal inventory scan failures to the discovery service', async () => {
    (getWalletUniswapV4Inventory as jest.Mock).mockRejectedValue(
      new Error('all scan-capable providers failed')
    );

    const adapter = new UniswapV4WbtcUsdcRewardsAdapter();

    await expect(adapter.discover(WALLET_ADDRESS)).rejects.toThrow(
      'Uniswap v4 WBTC/USDC inventory scan failed: all scan-capable providers failed'
    );
  });

  it('reads rewards using the position chain provider instead of the default provider', async () => {
    const provider = { name: 'arbitrum-provider' };
    (getProviderForChain as jest.Mock).mockReturnValue(provider);
    (formatUnits as jest.Mock).mockImplementation((amount: bigint) => amount === 2n ? '0.000002' : '0');

    const adapter = new UniswapV4WbtcUsdcRewardsAdapter();
    const value = await adapter.readCurrentValue(POSITION);

    expect(getProviderForChain).toHaveBeenCalledWith(ARBITRUM_CHAIN_ID);
    expect(getContract).toHaveBeenCalledWith(STATE_VIEW, [], provider);
    expect(value).toBeCloseTo(0.000002, 12);
  });

  it('treats a transferred NFT as closed', async () => {
    positionManagerContract.ownerOf.mockResolvedValue('0x0000000000000000000000000000000000000001');

    const adapter = new UniswapV4WbtcUsdcRewardsAdapter();

    await expect(adapter.isPositionClosed(POSITION)).resolves.toBe(true);
  });

  it('keeps a wallet-owned position open while liquidity remains', async () => {
    stateViewContract.getPositionInfo.mockResolvedValue([5n, 0n, 0n]);

    const adapter = new UniswapV4WbtcUsdcRewardsAdapter();

    await expect(adapter.isPositionClosed(POSITION)).resolves.toBe(false);
  });

  it('treats a wallet-owned zero-liquidity position as closed', async () => {
    stateViewContract.getPositionInfo.mockResolvedValue([0n, 0n, 0n]);

    const adapter = new UniswapV4WbtcUsdcRewardsAdapter();

    await expect(adapter.isPositionClosed(POSITION)).resolves.toBe(true);
  });
});
