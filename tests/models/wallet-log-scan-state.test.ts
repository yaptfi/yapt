jest.mock('../../src/utils/db', () => ({
  query: jest.fn(),
  queryOne: jest.fn(),
}));

import { query, queryOne } from '../../src/utils/db';
import { getWalletLogScanState, saveWalletLogScanState } from '../../src/models/wallet-log-scan-state';

describe('wallet log scan state model', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('returns an empty state when no checkpoint exists', async () => {
    (queryOne as jest.Mock).mockResolvedValue(null);

    await expect(getWalletLogScanState('0xwallet', 1, 'scan')).resolves.toEqual({
      scannedFromBlock: null,
      scannedToBlock: null,
      foundKeys: [],
    });
  });

  it('normalizes bigint strings and filters invalid or duplicate keys', async () => {
    (queryOne as jest.Mock).mockResolvedValue({
      scannedFromBlock: '22540451',
      scannedToBlock: '26460000',
      foundKeys: ['1795180415', 42, '', '1795180415'],
    });

    await expect(getWalletLogScanState('0xwallet', 1, 'scan')).resolves.toEqual({
      scannedFromBlock: 22540451,
      scannedToBlock: 26460000,
      foundKeys: ['1795180415'],
    });
    expect((queryOne as jest.Mock).mock.calls[0][1]).toEqual(['0xwallet', 1, 'scan']);
  });

  it('discards an inverted block range so the scan restarts safely', async () => {
    (queryOne as jest.Mock).mockResolvedValue({ scannedFromBlock: '200', scannedToBlock: '100', foundKeys: [] });

    await expect(getWalletLogScanState('0xwallet', 1, 'scan')).resolves.toMatchObject({
      scannedFromBlock: null,
      scannedToBlock: null,
    });
  });

  it('upserts the checkpoint with deduplicated keys', async () => {
    await saveWalletLogScanState('0xwallet', 1, 'scan', {
      scannedFromBlock: 10,
      scannedToBlock: 20,
      foundKeys: ['a', 'a', 'b'],
    });

    const [sql, params] = (query as jest.Mock).mock.calls[0];
    expect(sql).toContain('ON CONFLICT (wallet_id, chain_id, scan_key)');
    expect(params).toEqual(['0xwallet', 1, 'scan', 10, 20, '["a","b"]']);
  });
});
