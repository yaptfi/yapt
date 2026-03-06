jest.mock('../../src/models/rpc-provider', () => ({
  hasRPCProviders: jest.fn().mockResolvedValue(false),
  getActiveRPCProvidersForChain: jest.fn().mockResolvedValue([]),
}));

describe('ethereum RPC environment capabilities', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    jest.resetModules();
    process.env = {
      ...originalEnv,
      ETH_RPC_URL: 'https://mainnet.infura.io/v3/test-key',
      ARBITRUM_RPC_URL: 'https://arb-mainnet.infura.io/v3/test-key',
    };

    delete process.env.ETH_RPC_SUPPORTS_LARGE_BLOCK_SCANS;
    delete process.env.ARBITRUM_RPC_SUPPORTS_LARGE_BLOCK_SCANS;
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  it('treats env-configured providers as scan-capable by default', async () => {
    const { ETHEREUM_CHAIN_ID, getProviderForChain, initializeRPCProviders } = await import('../../src/utils/ethereum');

    await initializeRPCProviders();

    const provider = getProviderForChain(ETHEREUM_CHAIN_ID) as any;
    expect(typeof provider.getRPCManager).toBe('function');
    expect(provider.getRPCManager().getScanCapableProvider()).not.toBeNull();
  });

  it('supports opting env-configured providers out of large block scans', async () => {
    process.env.ETH_RPC_SUPPORTS_LARGE_BLOCK_SCANS = 'false';

    const { ETHEREUM_CHAIN_ID, getProviderForChain, initializeRPCProviders } = await import('../../src/utils/ethereum');

    await initializeRPCProviders();

    const provider = getProviderForChain(ETHEREUM_CHAIN_ID) as any;
    expect(typeof provider.getRPCManager).toBe('function');
    expect(provider.getRPCManager().getScanCapableProvider()).toBeNull();
  });

  it('normalizes trusted addresses even when the input checksum casing is wrong', async () => {
    const { normalizeAddress } = await import('../../src/utils/ethereum');

    expect(normalizeAddress('0x1F9840A85D5aF5bf1D1762F925BDADdC4201F984')).toBe(
      '0x1f9840a85d5aF5bf1D1762F925BDADdC4201F984'
    );
  });
});
