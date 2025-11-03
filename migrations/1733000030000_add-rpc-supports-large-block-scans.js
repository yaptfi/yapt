/**
 * Add supportsLargeBlockScans column to rpc_provider table
 *
 * This column indicates whether an RPC provider can handle eth_getLogs requests
 * with large block ranges (10k+ blocks). Providers with restrictive limits
 * (like Alchemy free tier: 10 blocks max) should have this set to false.
 *
 * Providers with generous limits (like Infura: 100k+ blocks) should set to true.
 */

exports.up = (pgm) => {
  pgm.addColumn('rpc_provider', {
    supports_large_block_scans: {
      type: 'boolean',
      notNull: true,
      default: true, // Default to true for backwards compatibility
      comment: 'Can handle eth_getLogs with large block ranges (10k+ blocks)',
    },
  });

  // Update comment on table
  pgm.sql(`
    COMMENT ON COLUMN rpc_provider.supports_large_block_scans IS
    'Whether provider supports eth_getLogs with large block ranges. False for Alchemy free tier (10 block limit), true for Infura/others.';
  `);
};

exports.down = (pgm) => {
  pgm.dropColumn('rpc_provider', 'supports_large_block_scans');
};
