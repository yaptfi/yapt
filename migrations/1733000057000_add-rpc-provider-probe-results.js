/**
 * Persist independently detected RPC health and historical-log capability for
 * Ethereum and Arbitrum. The legacy aggregate scan flag is retained for
 * compatibility with older deployments and environment configuration.
 */

exports.up = (pgm) => {
  pgm.addColumns('rpc_provider', {
    supports_ethereum_block_scans: {
      type: 'boolean',
      notNull: true,
      default: false,
    },
    supports_arbitrum_block_scans: {
      type: 'boolean',
      notNull: true,
      default: false,
    },
    ethereum_probe: {
      type: 'jsonb',
      notNull: false,
    },
    arbitrum_probe: {
      type: 'jsonb',
      notNull: false,
    },
  });

  pgm.sql(`
    UPDATE rpc_provider
    SET supports_ethereum_block_scans = supports_large_block_scans,
        supports_arbitrum_block_scans = (
          supports_large_block_scans
          AND arbitrum_url IS NOT NULL
          AND length(trim(arbitrum_url)) > 0
        )
  `);

  pgm.sql(`
    COMMENT ON COLUMN rpc_provider.supports_ethereum_block_scans IS
    'Probe-derived eligibility for Ethereum historical eth_getLogs routing';
    COMMENT ON COLUMN rpc_provider.supports_arbitrum_block_scans IS
    'Probe-derived eligibility for Arbitrum historical eth_getLogs routing';
    COMMENT ON COLUMN rpc_provider.ethereum_probe IS
    'Latest sanitized Ethereum RPC capability probe result';
    COMMENT ON COLUMN rpc_provider.arbitrum_probe IS
    'Latest sanitized Arbitrum RPC capability probe result';
  `);
};

exports.down = (pgm) => {
  pgm.dropColumns('rpc_provider', [
    'supports_ethereum_block_scans',
    'supports_arbitrum_block_scans',
    'ethereum_probe',
    'arbitrum_probe',
  ]);
};
