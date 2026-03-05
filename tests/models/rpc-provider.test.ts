jest.mock('../../src/utils/db', () => ({
  query: jest.fn(),
  queryOne: jest.fn(),
}));

import { query } from '../../src/utils/db';
import { getActiveRPCProvidersForChain } from '../../src/models/rpc-provider';

const ROW = {
  id: 1,
  name: 'Infura',
  url: 'https://mainnet.infura.io/v3/key',
  arbitrum_url: 'https://arbitrum-mainnet.infura.io/v3/key',
  calls_per_second: '2',
  calls_per_day: null,
  priority: 0,
  is_active: true,
  supports_ethereum: true,
  supports_arbitrum: true,
  supports_large_block_scans: true,
  supports_ens: true,
  created_at: new Date('2026-03-05T00:00:00.000Z'),
  updated_at: new Date('2026-03-05T00:00:00.000Z'),
};

describe('rpc-provider chain selection', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('uses arbitrum_url for Arbitrum providers', async () => {
    (query as jest.Mock).mockResolvedValue([ROW]);

    const providers = await getActiveRPCProvidersForChain(42161);

    expect(query).toHaveBeenCalledTimes(1);
    expect((query as jest.Mock).mock.calls[0][0]).toContain('arbitrum_url IS NOT NULL');
    expect(providers).toHaveLength(1);
    expect(providers[0]?.url).toBe('https://arbitrum-mainnet.infura.io/v3/key');
    expect(providers[0]?.arbitrumUrl).toBe('https://arbitrum-mainnet.infura.io/v3/key');
    expect(providers[0]?.supportsArbitrum).toBe(true);
  });

  it('uses the main URL for Ethereum providers', async () => {
    (query as jest.Mock).mockResolvedValue([ROW]);

    const providers = await getActiveRPCProvidersForChain(1);

    expect(providers).toHaveLength(1);
    expect(providers[0]?.url).toBe('https://mainnet.infura.io/v3/key');
    expect(providers[0]?.arbitrumUrl).toBe('https://arbitrum-mainnet.infura.io/v3/key');
  });

  it('returns no providers for unsupported chains', async () => {
    const providers = await getActiveRPCProvidersForChain(10);

    expect(providers).toEqual([]);
    expect(query).not.toHaveBeenCalled();
  });
});
