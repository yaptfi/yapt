import Fastify, { FastifyInstance } from 'fastify';
import adminRoutes from '../../src/routes/admin';
import { getUserById } from '../../src/models/user';
import {
  createRPCProvider,
  getRPCProviderById,
  updateRPCProvider,
  updateRPCProviderProbeResults,
} from '../../src/models/rpc-provider';
import { probeRPCProviderUrls } from '../../src/services/rpc-provider-probe';
import { reloadRPCProviders } from '../../src/utils/ethereum';
import { RPCProviderProbeResult } from '../../src/types/rpc-provider';
import { RPCProviderConfig } from '../../src/utils/rpc-manager';

jest.mock('../../src/models/user', () => ({
  getUserById: jest.fn(),
}));

jest.mock('../../src/utils/db', () => ({
  query: jest.fn(),
  queryOne: jest.fn(),
  withTransaction: jest.fn(),
  queryOnClient: jest.fn(),
}));

jest.mock('../../src/models/rpc-provider', () => ({
  getAllRPCProviders: jest.fn(),
  createRPCProvider: jest.fn(),
  deleteRPCProvider: jest.fn(),
  getRPCProviderById: jest.fn(),
  updateRPCProvider: jest.fn(),
  updateRPCProviderProbeResults: jest.fn(),
}));

jest.mock('../../src/services/rpc-provider-probe', () => ({
  probeRPCProviderUrls: jest.fn(),
}));

jest.mock('../../src/utils/ethereum', () => ({
  reloadRPCProviders: jest.fn(),
  getRPCStatus: jest.fn(() => null),
}));

const PROBE: RPCProviderProbeResult = {
  ethereum: {
    chainId: 1,
    chainName: 'Ethereum',
    checkedAt: '2026-08-24T12:00:00.000Z',
    basic: { ok: true, blockNumber: 1, latencyMs: 10, message: 'Connected at block 1' },
    blockScan: {
      compatible: true,
      incrementalCompatible: true,
      conclusive: true,
      status: 'supported',
      latencyMs: 20,
      testedBlockRange: 500_000,
      estimatedFullScanQueries: 1,
      message: 'Historical logs supported for at least 500,000 blocks',
    },
  },
  arbitrum: {
    chainId: 42161,
    chainName: 'Arbitrum',
    checkedAt: '2026-08-24T12:00:00.000Z',
    basic: { ok: true, blockNumber: 2, latencyMs: 10, message: 'Connected at block 2' },
    blockScan: {
      compatible: true,
      incrementalCompatible: true,
      conclusive: true,
      status: 'range-limited',
      latencyMs: 20,
      testedBlockRange: 10_000,
      maxBlockRange: 10_000,
      message: 'Historical logs supported with a 10,000-block range limit',
    },
  },
  canSave: true,
};

const PROVIDER: RPCProviderConfig = {
  id: 7,
  name: 'Secondary',
  url: 'https://ethereum.example/rpc/secret',
  arbitrumUrl: 'https://arbitrum.example/rpc/secret',
  callsPerSecond: 10,
  priority: 0,
  isActive: true,
  supportsLargeBlockScans: true,
  supportsEthereumBlockScans: true,
  supportsArbitrumBlockScans: true,
  supportsENS: true,
  ethereumProbe: PROBE.ethereum,
  arbitrumProbe: PROBE.arbitrum,
};

describe('admin RPC provider capability routes', () => {
  const mockGetUserById = getUserById as jest.MockedFunction<typeof getUserById>;
  const mockProbe = probeRPCProviderUrls as jest.MockedFunction<typeof probeRPCProviderUrls>;
  const mockCreate = createRPCProvider as jest.MockedFunction<typeof createRPCProvider>;
  const mockGetProvider = getRPCProviderById as jest.MockedFunction<typeof getRPCProviderById>;
  const mockUpdateProvider = updateRPCProvider as jest.MockedFunction<typeof updateRPCProvider>;
  const mockUpdateProbe = updateRPCProviderProbeResults as jest.MockedFunction<
    typeof updateRPCProviderProbeResults
  >;
  const mockReload = reloadRPCProviders as jest.MockedFunction<typeof reloadRPCProviders>;

  let app: FastifyInstance;
  let consoleWarnSpy: jest.SpyInstance;

  beforeEach(async () => {
    jest.clearAllMocks();
    consoleWarnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    mockGetUserById.mockResolvedValue({
      id: 'admin-1',
      username: 'admin',
      displayName: 'Admin',
      isAdmin: true,
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
    });
    mockProbe.mockResolvedValue(PROBE);
    mockCreate.mockResolvedValue(PROVIDER);
    mockGetProvider.mockResolvedValue(PROVIDER);
    mockUpdateProvider.mockResolvedValue(PROVIDER);
    mockUpdateProbe.mockResolvedValue(PROVIDER);

    app = Fastify({ logger: false });
    app.addHook('onRequest', async (request) => {
      request.session = {
        userId: 'admin-1',
        destroy: (callback: () => void) => callback(),
      } as unknown as typeof request.session;
    });
    await app.register(adminRoutes);
  });

  afterEach(async () => {
    consoleWarnSpy.mockRestore();
    await app.close();
  });

  test('wizard probes editable URLs without returning the URLs', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/rpc-providers/probe',
      payload: {
        url: PROVIDER.url,
        arbitrumUrl: PROVIDER.arbitrumUrl,
      },
    });

    expect(response.statusCode).toBe(200);
    expect(mockProbe).toHaveBeenCalledWith(PROVIDER.url, PROVIDER.arbitrumUrl);
    expect(response.json()).toEqual({ probe: PROBE });
    expect(response.payload).not.toContain(PROVIDER.url);
    expect(response.payload).not.toContain(PROVIDER.arbitrumUrl as string);
  });

  test('create derives scan routing from a fresh probe instead of client flags', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/rpc-providers',
      payload: {
        name: PROVIDER.name,
        url: PROVIDER.url,
        arbitrumUrl: PROVIDER.arbitrumUrl,
        callsPerSecond: 10,
        priority: 0,
        isActive: true,
        supportsLargeBlockScans: false,
      },
    });

    expect(response.statusCode).toBe(201);
    expect(mockCreate).toHaveBeenCalledWith(expect.objectContaining({
      supportsEthereumBlockScans: true,
      supportsArbitrumBlockScans: true,
      supportsLargeBlockScans: true,
      ethereumProbe: PROBE.ethereum,
      arbitrumProbe: PROBE.arbitrum,
    }));
    expect(mockReload).toHaveBeenCalledTimes(1);
  });

  test('create stays retryable when a capability test is inconclusive', async () => {
    mockProbe.mockResolvedValue({
      ...PROBE,
      canSave: false,
      arbitrum: {
        ...PROBE.arbitrum!,
        blockScan: {
          compatible: false,
          incrementalCompatible: false,
          conclusive: false,
          status: 'failed',
          latencyMs: 20,
          errorCategory: 'rate-limited',
          message: 'Too Many Requests',
        },
      },
    });

    const response = await app.inject({
      method: 'POST',
      url: '/rpc-providers',
      payload: {
        name: PROVIDER.name,
        url: PROVIDER.url,
        arbitrumUrl: PROVIDER.arbitrumUrl,
        callsPerSecond: 10,
        priority: 0,
        isActive: true,
      },
    });

    expect(response.statusCode).toBe(422);
    expect(response.json()).toEqual(expect.objectContaining({ probe: expect.any(Object) }));
    expect(mockCreate).not.toHaveBeenCalled();
  });

  test('existing-provider probe persists capabilities and reloads changed routing', async () => {
    mockGetProvider.mockResolvedValueOnce({
      ...PROVIDER,
      supportsArbitrumBlockScans: false,
    });

    const response = await app.inject({
      method: 'POST',
      url: '/rpc-providers/7/probe',
    });

    expect(response.statusCode).toBe(200);
    expect(mockProbe).toHaveBeenCalledWith(PROVIDER.url, PROVIDER.arbitrumUrl);
    expect(mockUpdateProbe).toHaveBeenCalledWith(7, PROBE);
    expect(mockReload).toHaveBeenCalledTimes(1);
    expect(response.json()).toEqual(expect.objectContaining({ routingChanged: true }));
  });

  test('wizard can update and re-probe an existing provider URL', async () => {
    const response = await app.inject({
      method: 'PATCH',
      url: '/rpc-providers/7',
      payload: {
        name: 'Secondary edited',
        url: 'https://ethereum.example/rpc/new-secret',
        arbitrumUrl: 'https://arbitrum.example/rpc/new-secret',
        callsPerSecond: 5,
        callsPerDay: null,
        priority: 2,
      },
    });

    expect(response.statusCode).toBe(200);
    expect(mockProbe).toHaveBeenCalledWith(
      'https://ethereum.example/rpc/new-secret',
      'https://arbitrum.example/rpc/new-secret'
    );
    expect(mockUpdateProvider).toHaveBeenCalledWith(7, expect.objectContaining({
      name: 'Secondary edited',
      callsPerDay: null,
      supportsEthereumBlockScans: true,
      supportsArbitrumBlockScans: true,
      ethereumProbe: PROBE.ethereum,
      arbitrumProbe: PROBE.arbitrum,
    }));
    expect(mockUpdateProbe).not.toHaveBeenCalled();
    expect(mockReload).toHaveBeenCalledTimes(1);
  });

  test('manual scan capability updates are rejected', async () => {
    const response = await app.inject({
      method: 'PATCH',
      url: '/rpc-providers/7',
      payload: { supportsLargeBlockScans: true },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error).toContain('detected automatically');
  });
});
