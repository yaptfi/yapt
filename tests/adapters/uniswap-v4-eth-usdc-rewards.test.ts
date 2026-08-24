import { UniswapV4EthUsdcEthereumRewardsAdapter } from '../../src/adapters/uniswap-v4-eth-usdc-ethereum-rewards';
import { UniswapV4EthUsdcArbitrumRewardsAdapter } from '../../src/adapters/uniswap-v4-eth-usdc-arbitrum-rewards';
import protocolConfig from '../../config/protocols.json';

const ETHEREUM_PROTOCOL_KEY = 'uniswap-v4-eth-usdc-ethereum-rewards';
const ARBITRUM_PROTOCOL_KEY = 'uniswap-v4-eth-usdc-arbitrum-rewards';
const ETHEREUM_POSITION_MANAGER = '0xbd216513d74c8cf14cf4747e6aaa6420ff64ee9e';
const ARBITRUM_POSITION_MANAGER = '0xd88F38F930b7952f2DB2432Cb002E7abbF3dD869';
const ETHEREUM_STATE_VIEW = '0x7ffe42c4a5deea5b0fec41c94c136cf115597227';
const ARBITRUM_STATE_VIEW = '0x76fd297e2d437cd7f76d50f01afe6160f86e9990';
const NATIVE_ETH = '0x0000000000000000000000000000000000000000';
const WETH = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2';
const ETHEREUM_USDC = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48';
const ARBITRUM_USDC = '0xaf88d065e77c8cC2239327C5EDb3A432268e5831';
const WALLET_ADDRESS = '0x80D0d54050C15971b21e877D95441800f5AA9ee8';

jest.mock('../../src/utils/config', () => ({
  getProtocolConfig: jest.fn(),
  getAbi: jest.fn().mockReturnValue([]),
  getStablePriceOverrides: jest.fn().mockReturnValue({ USDC: 1 }),
}));

jest.mock('../../src/utils/ethereum', () => ({
  ETHEREUM_CHAIN_ID: 1,
  ARBITRUM_CHAIN_ID: 42161,
  getContract: jest.fn(),
  getProviderForChain: jest.fn(),
  getScanCapableProviderForChain: jest.fn(),
  normalizeAddress: jest.fn((address: string) => address),
  toChecksumAddress: (address: string) => address,
  formatUnits: jest.fn(),
}));

jest.mock('../../src/utils/uniswap-v4-inventory', () => ({
  getWalletUniswapV4Inventory: jest.fn(),
}));

import { getProtocolConfig } from '../../src/utils/config';
import {
  getContract,
  getProviderForChain,
  getScanCapableProviderForChain,
} from '../../src/utils/ethereum';
import { getWalletUniswapV4Inventory } from '../../src/utils/uniswap-v4-inventory';

const CONFIG = {
  [ETHEREUM_PROTOCOL_KEY]: {
    name: 'Uniswap v4 ETH/USDC (Ethereum)',
    chainId: 1,
    positionManager: ETHEREUM_POSITION_MANAGER,
    stateView: ETHEREUM_STATE_VIEW,
    currency0: NATIVE_ETH,
    currency1: ETHEREUM_USDC,
    currency0Decimals: 18,
    currency1Decimals: 6,
    rewardToken: ETHEREUM_USDC,
    rewardDecimals: 6,
    baseAsset: 'USDC',
    countingMode: 'partial',
    abiKeys: ['UniswapV4PositionManager', 'UniswapV4StateView'],
    deployBlock: 21688823,
  },
  [ARBITRUM_PROTOCOL_KEY]: {
    name: 'Uniswap v4 ETH/USDC (Arbitrum)',
    chainId: 42161,
    positionManager: ARBITRUM_POSITION_MANAGER,
    stateView: ARBITRUM_STATE_VIEW,
    currency0: NATIVE_ETH,
    currency1: ARBITRUM_USDC,
    currency0Decimals: 18,
    currency1Decimals: 6,
    rewardToken: ARBITRUM_USDC,
    rewardDecimals: 6,
    baseAsset: 'USDC',
    countingMode: 'partial',
    abiKeys: ['UniswapV4PositionManager', 'UniswapV4StateView'],
    deployBlock: 297842893,
  },
};

function createInventoryEntry(usdc: string, fee: bigint) {
  return {
    tokenId: '123',
    poolId: '0xpool',
    tickLower: -10,
    tickUpper: 10,
    poolKey: {
      currency0: NATIVE_ETH,
      currency1: usdc,
      fee,
      tickSpacing: 10n,
      hooks: '0x0000000000000000000000000000000000000000',
    },
  };
}

describe('Uniswap v4 ETH/USDC protocol configuration', () => {
  it.each([
    {
      protocolKey: ETHEREUM_PROTOCOL_KEY,
      chainId: 1,
      positionManager: ETHEREUM_POSITION_MANAGER,
      stateView: ETHEREUM_STATE_VIEW,
      usdc: ETHEREUM_USDC,
      deployBlock: 21688823,
    },
    {
      protocolKey: ARBITRUM_PROTOCOL_KEY,
      chainId: 42161,
      positionManager: ARBITRUM_POSITION_MANAGER,
      stateView: ARBITRUM_STATE_VIEW,
      usdc: ARBITRUM_USDC,
      deployBlock: 297842893,
    },
  ])('uses the official $chainId deployment and native ETH currency', ({
    protocolKey,
    chainId,
    positionManager,
    stateView,
    usdc,
    deployBlock,
  }) => {
    const config = protocolConfig[protocolKey as keyof typeof protocolConfig];

    expect(config).toMatchObject({
      chainId,
      positionManager,
      stateView,
      currency0: NATIVE_ETH,
      currency1: usdc,
      rewardToken: usdc,
      baseAsset: 'USDC',
      countingMode: 'partial',
      deployBlock,
    });
    expect(config).not.toHaveProperty('fee');
  });
});

describe.each([
  {
    label: 'Ethereum',
    adapter: () => new UniswapV4EthUsdcEthereumRewardsAdapter(),
    protocolKey: ETHEREUM_PROTOCOL_KEY,
    protocolName: 'Uniswap v4 ETH/USDC (Ethereum)',
    chainId: 1,
    positionManager: ETHEREUM_POSITION_MANAGER,
    stateView: ETHEREUM_STATE_VIEW,
    usdc: ETHEREUM_USDC,
    deployBlock: 21688823,
  },
  {
    label: 'Arbitrum',
    adapter: () => new UniswapV4EthUsdcArbitrumRewardsAdapter(),
    protocolKey: ARBITRUM_PROTOCOL_KEY,
    protocolName: 'Uniswap v4 ETH/USDC (Arbitrum)',
    chainId: 42161,
    positionManager: ARBITRUM_POSITION_MANAGER,
    stateView: ARBITRUM_STATE_VIEW,
    usdc: ARBITRUM_USDC,
    deployBlock: 297842893,
  },
])('$label Uniswap v4 ETH/USDC adapter', ({
  adapter,
  protocolKey,
  protocolName,
  chainId,
  positionManager,
  stateView,
  usdc,
  deployBlock,
}) => {
  beforeEach(() => {
    jest.clearAllMocks();
    (getProtocolConfig as jest.Mock).mockReturnValue(CONFIG);
    (getProviderForChain as jest.Mock).mockReturnValue({ name: `provider-${chainId}` });
    (getScanCapableProviderForChain as jest.Mock).mockReturnValue({ name: `scan-provider-${chainId}` });
    (getContract as jest.Mock).mockReturnValue({
      getPositionInfo: jest.fn().mockResolvedValue([2n, 0n, 0n]),
    });
  });

  it('discovers native ETH/USDC positions across fee tiers with claimable USDC metadata', async () => {
    const scanProvider = { name: `scan-provider-${chainId}` };
    (getScanCapableProviderForChain as jest.Mock).mockReturnValue(scanProvider);
    (getWalletUniswapV4Inventory as jest.Mock).mockResolvedValue([
      createInventoryEntry(usdc, chainId === 1 ? 500n : 3000n),
    ]);

    const instance = adapter();
    const discovered = await instance.discover(WALLET_ADDRESS);

    expect(instance.protocolKey).toBe(protocolKey);
    expect(instance.protocolName).toBe(protocolName);
    expect(getProviderForChain).toHaveBeenCalledWith(chainId);
    expect(getScanCapableProviderForChain).toHaveBeenCalledWith(chainId);
    expect(getWalletUniswapV4Inventory).toHaveBeenCalledWith(
      WALLET_ADDRESS,
      positionManager,
      deployBlock,
      scanProvider
    );
    expect(getContract).toHaveBeenCalledWith(stateView, [], scanProvider);
    expect(discovered).toHaveLength(1);
    expect(discovered[0]).toMatchObject({
      displayName: `${protocolName} #123`,
      baseAsset: 'USDC',
      countingMode: 'partial',
      measureMethod: 'rewards',
      metadata: {
        chainId,
        currency0: NATIVE_ETH,
        currency1: usdc,
        rewardTokenIndex: 1,
        rewardDecimals: 6,
        allowZeroValueDiscovery: true,
      },
    });
  });

  it('does not treat wrapped WETH as the requested native ETH pool', async () => {
    (getWalletUniswapV4Inventory as jest.Mock).mockResolvedValue([
      {
        ...createInventoryEntry(usdc, 500n),
        poolKey: {
          ...createInventoryEntry(usdc, 500n).poolKey,
          currency0: WETH,
        },
      },
    ]);

    await expect(adapter().discover(WALLET_ADDRESS)).resolves.toEqual([]);
  });
});
