/* eslint-disable @typescript-eslint/no-var-requires */
exports.shorthands = undefined;

exports.up = (pgm) => {
  // Add is_reset column to position_snapshot table
  pgm.addColumn('position_snapshot', {
    is_reset: {
      type: 'boolean',
      notNull: true,
      default: false,
      comment: 'Marks the start of a new APY tracking period after partial exit/addition',
    },
  });

  // Create index for efficient querying of reset points
  pgm.createIndex('position_snapshot', ['position_id', 'is_reset']);

  // Create index for finding most recent reset
  pgm.createIndex('position_snapshot', ['position_id', 'ts', 'is_reset']);
};

exports.down = (pgm) => {
  pgm.dropIndex('position_snapshot', ['position_id', 'ts', 'is_reset']);
  pgm.dropIndex('position_snapshot', ['position_id', 'is_reset']);
  pgm.dropColumn('position_snapshot', 'is_reset');
};
