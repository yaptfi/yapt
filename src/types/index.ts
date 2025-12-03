export type CountingMode = 'count' | 'partial' | 'ignore';
export type MeasureMethod = 'exchangeRate' | 'balance' | 'rebaseIndex' | 'subgraph' | 'rewards' | 'lp-position';
export type ProtocolKey = string;

export interface User {
  id: string;
  username: string;
  displayName: string | null;
  isAdmin: boolean;
  createdAt: Date;
}

export interface Authenticator {
  id: string;
  userId: string;
  credentialId: string;
  credentialPublicKey: Buffer;
  counter: number;
  credentialDeviceType: string;
  credentialBackedUp: boolean;
  transports: string | null;
  createdAt: Date;
}

export interface UserWallet {
  id: string;
  userId: string;
  walletId: string;
  createdAt: Date;
}

export interface Wallet {
  id: string;
  address: string;
  ensName?: string | null;
  createdAt: Date;
}

export interface Protocol {
  id: string;
  key: ProtocolKey;
  name: string;
}

export interface Stablecoin {
  id: string;
  symbol: string;
  name: string;
  coingeckoId: string | null;
  decimals: number;
  createdAt: Date;
}

export interface Position {
  id: string;
  walletId: string;
  protocolId: string;
  protocolPositionKey: string;
  displayName: string;
  baseAsset: string; // Deprecated: Use stablecoinId instead
  stablecoinId: string;
  countingMode: CountingMode;
  measureMethod: MeasureMethod;
  metadata: Record<string, any>;
  isActive: boolean;
  createdAt: Date;
}

export interface PositionSnapshot {
  id: number;
  position_id: string;
  ts: Date;
  value_usd: string;
  net_flows_usd: string;
  yield_delta_usd: string;
  apy: string | null;
}

// Camel case version for API responses
export interface PositionSnapshotCamelCase {
  id: number;
  positionId: string;
  ts: Date;
  valueUsd: string;
  netFlowsUsd: string;
  yieldDeltaUsd: string;
  apy: string | null;
}

export interface PortfolioHourly {
  id: number;
  sessionId: string;
  ts: Date;
  totalValueUsd: string;
  estDailyUsd: string;
  estMonthlyUsd: string;
  estYearlyUsd: string;
}

export interface PositionValue {
  valueUsd: number;
  netFlowsUsd: number;
  yieldDeltaUsd: number;
  apy?: number;
}

export interface PositionWithMetrics extends Position {
  valueUsd: number;
  apy?: number;
  apy7d?: number;
  apy30d?: number;
  estDailyUsd: number;
  estMonthlyUsd: number;
  estYearlyUsd: number;
}

export interface PortfolioProjection {
  asOf: string;
  totalValueUsd: number;
  estDailyUsd: number;
  estMonthlyUsd: number;
  estYearlyUsd: number;
  positions: PositionWithMetrics[];
}

export interface ProtocolConfig {
  [protocolKey: string]: {
    name?: string;
    poolId?: number;
    markets?: Array<{
      asset: string;
      aToken: string;
      decimals: number;
    }>;
    token?: string;
    decimals?: number; // Underlying asset decimals (for ERC4626, this is the asset token decimals)
    shareDecimals?: number; // Optional: ERC4626 share token decimals (defaults to decimals if omitted)
    type?: 'rebase' | 'exchangeRate' | 'vault' | 'staking-rewards' | 'staking-vault' | 'convex-curve-vault' | 'yearn-v3-vault' | 'lp-position';
    stakingContract?: string;
    depositToken?: string;
    curveVaultToken?: string;
    cvxCrvToken?: string;
    rewardToken?: string;
    depositDecimals?: number;
    rewardDecimals?: number;
    cvxCrvDecimals?: number;
    vaultToken?: string;
    gaugeToken?: string;
    underlyingToken?: string;
    baseAsset?: string;
    countingMode?: CountingMode;
    // Uniswap v4 LP position fields
    positionManager?: string;
    poolManager?: string;
    stateView?: string;
    currency0?: string;
    currency1?: string;
    currency0Symbol?: string;
    currency1Symbol?: string;
    currency0Decimals?: number;
    currency1Decimals?: number;
    fee?: number;
    tickSpacing?: number;
    abiKeys: string[];
  };
}

export interface TransferEvent {
  from: string;
  to: string;
  value: bigint;
  blockNumber: number;
  transactionHash: string;
}

export interface NetFlowResult {
  netFlowsUsd: number;
  fromBlock: number;
  toBlock: number;
}

// Session data for WebAuthn
export interface SessionData {
  userId?: string;
  challenge?: string;
  username?: string;
  addDeviceUserId?: string; // Used for add-device flow to verify user identity
}

// Fastify session augmentation
declare module 'fastify' {
  // eslint-disable-next-line @typescript-eslint/no-empty-object-type
  interface Session extends SessionData {}
}

// Fastify request augmentation for authenticated user
declare module 'fastify' {
  interface FastifyRequest {
    user?: User;
  }
}

// Notification types
export type NotificationSeverity = 'min' | 'low' | 'default' | 'high' | 'urgent';
export type NotificationType = 'depeg' | 'apy_drop';

export interface NotificationSettings {
  id: string;
  userId: string;
  depegEnabled: boolean;
  depegSeverity: NotificationSeverity;
  depegLowerThreshold: string; // Numeric as string
  depegUpperThreshold: string | null; // Numeric as string, nullable
  depegSymbols: string[] | null; // Null => all supported stablecoins
  apyEnabled: boolean;
  apySeverity: NotificationSeverity;
  apyThreshold: string; // Numeric as string
  ntfyTopic: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface NotificationLog {
  id: string;
  userId: string;
  notificationType: NotificationType;
  severity: NotificationSeverity;
  title: string;
  message: string;
  metadata: Record<string, any> | null;
  sentAt: Date;
}

export type DeviceType = 'ios' | 'android' | 'web';
export type ApnsEnvironment = 'production' | 'sandbox';

export interface DevicePushToken {
  id: string;
  userId: string;
  deviceType: DeviceType;
  deviceName: string | null;
  deviceId: string | null;
  pushToken: string;
  endpoint: string | null;
  isActive: boolean;
  environment: ApnsEnvironment | null;
  lastUsedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}
