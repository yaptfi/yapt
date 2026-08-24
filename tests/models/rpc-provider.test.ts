jest.mock('../../src/utils/db', () => ({
  query: jest.fn(),
  queryOne: jest.fn(),
}));

import { query, queryOne } from '../../src/utils/db';
import {
  getActiveRPCProvidersForChain,
  updateRPCProvider,
  updateRPCProviderProbeResults,
} from '../../src/models/rpc-provider';

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
  supports_ethereum_block_scans: true,
  supports_arbitrum_block_scans: false,
  supports_ens: true,
  ethereum_probe: null,
  arbitrum_probe: null,
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
    expect(providers[0]?.supportsLargeBlockScans).toBe(false);
  });

  it('uses the main URL for Ethereum providers', async () => {
    (query as jest.Mock).mockResolvedValue([ROW]);

    const providers = await getActiveRPCProvidersForChain(1);

    expect(providers).toHaveLength(1);
    expect(providers[0]?.url).toBe('https://mainnet.infura.io/v3/key');
    expect(providers[0]?.arbitrumUrl).toBe('https://arbitrum-mainnet.infura.io/v3/key');
    expect(providers[0]?.supportsLargeBlockScans).toBe(true);
  });

  it('returns no providers for unsupported chains', async () => {
    const providers = await getActiveRPCProvidersForChain(10);

    expect(providers).toEqual([]);
    expect(query).not.toHaveBeenCalled();
  });

  it('only replaces a chain scan flag when its probe is conclusive', async () => {
    (queryOne as jest.Mock).mockResolvedValue(ROW);
    const ethereumProbe = {
      chainId: 1,
      chainName: 'Ethereum',
      checkedAt: '2026-08-24T12:00:00.000Z',
      basic: { ok: true, latencyMs: 1, message: 'Connected' },
      blockScan: {
        compatible: true,
        conclusive: true,
        status: 'range-limited' as const,
        latencyMs: 2,
        testedBlockRange: 10_000,
        maxBlockRange: 10_000,
        message: 'Historical logs supported',
      },
    };
    const arbitrumProbe = {
      chainId: 42161,
      chainName: 'Arbitrum',
      checkedAt: '2026-08-24T12:00:00.000Z',
      basic: { ok: true, latencyMs: 1, message: 'Connected' },
      blockScan: {
        compatible: false,
        conclusive: false,
        status: 'failed' as const,
        latencyMs: 2,
        errorCategory: 'rate-limited' as const,
        message: 'Too Many Requests',
      },
    };

    await updateRPCProviderProbeResults(1, {
      ethereum: ethereumProbe,
      arbitrum: arbitrumProbe,
      canSave: false,
    });

    expect(queryOne).toHaveBeenCalledWith(
      expect.stringContaining('CASE WHEN $6 THEN $7 ELSE supports_arbitrum_block_scans END'),
      [1, ethereumProbe, arbitrumProbe, true, true, false, false]
    );
  });

  it('updates edited URLs and their probe-derived capabilities in one statement', async () => {
    (queryOne as jest.Mock).mockResolvedValue(ROW);
    const ethereumProbe = {
      chainId: 1,
      chainName: 'Ethereum',
      checkedAt: '2026-08-24T12:00:00.000Z',
      basic: { ok: true, latencyMs: 1, message: 'Connected' },
      blockScan: {
        compatible: true,
        conclusive: true,
        status: 'supported' as const,
        latencyMs: 2,
        testedBlockRange: 50_000,
        message: 'Historical logs supported',
      },
    };

    await updateRPCProvider(1, {
      url: 'https://edited.example/key',
      callsPerDay: null,
      supportsLargeBlockScans: true,
      supportsEthereumBlockScans: true,
      supportsArbitrumBlockScans: false,
      ethereumProbe,
      arbitrumProbe: null,
    });

    const sql = (queryOne as jest.Mock).mock.calls[0][0] as string;
    expect(sql).toContain('url = $1');
    expect(sql).toContain('calls_per_day = $2');
    expect(sql).toContain('supports_ethereum_block_scans');
    expect(sql).toContain('ethereum_probe');
    expect(sql).toContain('arbitrum_probe');
    expect((queryOne as jest.Mock).mock.calls[0][1]).toContain(ethereumProbe);
  });
});
