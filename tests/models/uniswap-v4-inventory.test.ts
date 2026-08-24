jest.mock('../../src/utils/db', () => ({
  query: jest.fn(),
  queryOne: jest.fn(),
}));

import { query, queryOne } from '../../src/utils/db';
import {
  getUniswapV4InventoryState,
  saveUniswapV4InventoryState,
} from '../../src/models/uniswap-v4-inventory';

describe('Uniswap v4 inventory state model', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('merges checkpoint IDs with active position metadata and normalizes block values', async () => {
    (queryOne as jest.Mock).mockResolvedValue({
      tokenIds: ['10', '20', 'invalid'],
      lastScannedBlock: '497925700',
      nextTokenId: '199208',
      coldScanCursor: null,
      isComplete: true,
    });
    (query as jest.Mock).mockResolvedValue([{ tokenId: '20' }, { tokenId: '199076' }]);

    const state = await getUniswapV4InventoryState(
      '0xwallet',
      42161,
      '0xposition-manager'
    );

    expect(state).toEqual({
      tokenIds: ['10', '20', '199076'],
      lastScannedBlock: 497925700,
      nextTokenId: '199208',
      coldScanCursor: null,
      isComplete: true,
    });
    expect((query as jest.Mock).mock.calls[0][0]).toContain("p.metadata->>'tokenId'");
    expect((query as jest.Mock).mock.calls[0][1]).toEqual([
      '0xwallet',
      '0xposition-manager',
      '42161',
    ]);
  });

  it('returns a cold-start state when no checkpoint or positions exist', async () => {
    (queryOne as jest.Mock).mockResolvedValue(null);
    (query as jest.Mock).mockResolvedValue([]);

    await expect(getUniswapV4InventoryState('0xwallet', 1, '0xmanager')).resolves.toEqual({
      tokenIds: [],
      lastScannedBlock: null,
      nextTokenId: null,
      coldScanCursor: null,
      isComplete: false,
    });
  });

  it('upserts JSON-safe token IDs and resumable cursors', async () => {
    (query as jest.Mock).mockResolvedValue([]);

    await saveUniswapV4InventoryState('0xwallet', 42161, '0xManager', {
      tokenIds: ['199076', '146749'],
      lastScannedBlock: null,
      nextTokenId: '199208',
      coldScanCursor: '140000',
      isComplete: false,
    });

    const [sql, params] = (query as jest.Mock).mock.calls[0];
    expect(sql).toContain('ON CONFLICT (wallet_id, chain_id, position_manager)');
    expect(params).toEqual([
      '0xwallet',
      42161,
      '0xManager',
      '["199076","146749"]',
      null,
      '199208',
      '140000',
      false,
    ]);
  });
});
