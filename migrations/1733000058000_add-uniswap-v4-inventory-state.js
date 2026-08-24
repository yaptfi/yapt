/**
 * Persist verified Uniswap v4 NFT inventory and resumable discovery cursors.
 * This avoids rebuilding every wallet's ownership from PositionManager
 * deployment logs on each discovery run.
 */

exports.up = (pgm) => {
  pgm.createTable('uniswap_v4_inventory_state', {
    wallet_id: {
      type: 'uuid',
      notNull: true,
      references: 'wallet',
      onDelete: 'CASCADE',
    },
    chain_id: {
      type: 'integer',
      notNull: true,
    },
    position_manager: {
      type: 'text',
      notNull: true,
    },
    token_ids: {
      type: 'jsonb',
      notNull: true,
      default: pgm.func("'[]'::jsonb"),
    },
    last_scanned_block: {
      type: 'bigint',
      notNull: false,
    },
    next_token_id: {
      type: 'numeric(78,0)',
      notNull: false,
    },
    cold_scan_cursor: {
      type: 'numeric(78,0)',
      notNull: false,
    },
    is_complete: {
      type: 'boolean',
      notNull: true,
      default: false,
    },
    updated_at: {
      type: 'timestamptz',
      notNull: true,
      default: pgm.func('now()'),
    },
  });

  pgm.addConstraint(
    'uniswap_v4_inventory_state',
    'uniswap_v4_inventory_state_pkey',
    { primaryKey: ['wallet_id', 'chain_id', 'position_manager'] }
  );
  pgm.addConstraint(
    'uniswap_v4_inventory_state',
    'uniswap_v4_inventory_state_token_ids_array',
    { check: "jsonb_typeof(token_ids) = 'array'" }
  );
  pgm.createIndex('uniswap_v4_inventory_state', ['chain_id', 'position_manager']);
};

exports.down = (pgm) => {
  pgm.dropTable('uniswap_v4_inventory_state');
};
