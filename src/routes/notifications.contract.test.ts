import Fastify, { FastifyInstance } from 'fastify';
import notificationRoutes from './notifications';
import { getUserById } from '../models/user';
import { getNotificationSettings } from '../models/notificationSettings';
import { getNotificationLogsWithCount } from '../models/notificationLog';

interface SettingsContractResponse {
  settings: {
    depegEnabled: boolean;
    apyThreshold: number;
  };
  depegEnabled: boolean;
  apyThreshold: number;
}

interface HistoryContractResponse {
  notifications: Array<{
    type: string;
    notificationType: string;
    createdAt: string;
    sentAt: string;
  }>;
}

jest.mock('../models/user', () => ({
  getUserById: jest.fn(),
}));

jest.mock('../models/notificationSettings', () => ({
  getNotificationSettings: jest.fn(),
  upsertNotificationSettings: jest.fn(),
  deleteNotificationSettings: jest.fn(),
}));

jest.mock('../models/notificationLog', () => ({
  getNotificationLogsWithCount: jest.fn(),
}));

jest.mock('../models/device', () => ({
  createDevice: jest.fn(),
  deleteDevice: jest.fn(),
}));

describe('notifications route response contracts', () => {
  const mockGetUserById = getUserById as jest.MockedFunction<typeof getUserById>;
  const mockGetNotificationSettings = getNotificationSettings as jest.MockedFunction<typeof getNotificationSettings>;
  const mockGetNotificationLogsWithCount = getNotificationLogsWithCount as jest.MockedFunction<typeof getNotificationLogsWithCount>;

  let app: FastifyInstance;

  beforeEach(async () => {
    jest.clearAllMocks();

    mockGetUserById.mockResolvedValue({
      id: 'user-1',
      username: 'user',
      displayName: 'User',
      isAdmin: false,
      createdAt: new Date('2025-01-01T00:00:00.000Z'),
    });

    mockGetNotificationSettings.mockResolvedValue({
      id: 'settings-1',
      userId: 'user-1',
      depegEnabled: true,
      depegSeverity: 'default',
      depegLowerThreshold: '0.99',
      depegUpperThreshold: '1.02',
      depegSymbols: ['USDC'],
      apyEnabled: true,
      apySeverity: 'high',
      apyThreshold: '0.07',
      apyWindow: '7d',
      ntfyTopic: 'yapt-topic',
      createdAt: new Date('2025-01-01T00:00:00.000Z'),
      updatedAt: new Date('2025-01-01T00:00:00.000Z'),
    });

    mockGetNotificationLogsWithCount.mockResolvedValue({
      notifications: [
        {
          id: 'notif-1',
          userId: 'user-1',
          notificationType: 'apy_drop',
          severity: 'high',
          title: 'Low APY',
          message: 'APY dropped',
          metadata: { currentApy: 0.01 },
          sentAt: new Date('2025-01-02T00:00:00.000Z'),
        },
      ],
      total: 1,
    });

    app = Fastify({ logger: false });
    app.addHook('onRequest', async (request) => {
      request.session = {
        userId: 'user-1',
        destroy: (cb: () => void) => cb(),
      } as unknown as typeof request.session;
    });

    await app.register(notificationRoutes);
  });

  afterEach(async () => {
    await app.close();
  });

  test('GET /settings returns wrapped and flat compatibility fields', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/settings',
    });

    expect(response.statusCode).toBe(200);
    const payload = response.json() as SettingsContractResponse;

    expect(payload.settings).toBeDefined();
    expect(payload.settings.depegEnabled).toBe(true);
    expect(payload.settings.apyThreshold).toBeCloseTo(0.07);
    expect(payload.depegEnabled).toBe(true);
    expect(payload.apyThreshold).toBeCloseTo(0.07);
  });

  test('GET /history returns current and legacy fields for type/time', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/history',
    });

    expect(response.statusCode).toBe(200);
    const payload = response.json() as HistoryContractResponse;
    expect(payload.notifications).toHaveLength(1);

    const notification = payload.notifications[0];
    expect(notification.type).toBe('apy');
    expect(notification.notificationType).toBe('apy_drop');
    expect(notification.createdAt).toBeDefined();
    expect(notification.sentAt).toBeDefined();
  });

  test('GET /history rejects invalid pagination input', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/history?limit=abc&offset=-1',
    });

    expect(response.statusCode).toBe(400);
    const payload = response.json() as { error: string };
    expect(payload.error).toContain('Invalid limit');
  });
});
