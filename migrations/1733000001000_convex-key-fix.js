/* eslint-disable @typescript-eslint/no-var-requires */
exports.shorthands = undefined;

exports.up = (pgm) => {
  // Idempotent fix to ensure only one protocol row exists with key 'convex-cvxcrv'
  // and migrate any references from legacy 'convex' key.
  pgm.sql(`
    DO $$
    DECLARE
      v_convex_id uuid;
      v_cvx_id uuid;
    BEGIN
      SELECT id INTO v_convex_id FROM protocol WHERE key = 'convex';
      SELECT id INTO v_cvx_id FROM protocol WHERE key = 'convex-cvxcrv';

      IF v_convex_id IS NULL AND v_cvx_id IS NULL THEN
        -- Neither exists: insert the correct one
        INSERT INTO protocol (key, name) VALUES ('convex-cvxcrv', 'Convex Staked cvxCRV');
      ELSIF v_convex_id IS NOT NULL AND v_cvx_id IS NULL THEN
        -- Only legacy exists: rename in place
        UPDATE protocol SET key = 'convex-cvxcrv', name = 'Convex Staked cvxCRV' WHERE id = v_convex_id;
      ELSIF v_convex_id IS NOT NULL AND v_cvx_id IS NOT NULL THEN
        -- Both exist: migrate positions to the correct one, then delete legacy
        UPDATE position SET protocol_id = v_cvx_id WHERE protocol_id = v_convex_id;
        DELETE FROM protocol WHERE id = v_convex_id;
        -- Ensure name is correct
        UPDATE protocol SET name = 'Convex Staked cvxCRV' WHERE id = v_cvx_id;
      ELSE
        -- Only correct exists: ensure name is correct
        UPDATE protocol SET name = 'Convex Staked cvxCRV' WHERE id = v_cvx_id;
      END IF;
    END
    $$;
  `);
};

exports.down = (pgm) => {
  // Best-effort revert: prefer keeping a single 'convex' row
  pgm.sql(`
    DO $$
    DECLARE
      v_convex_id uuid;
      v_cvx_id uuid;
    BEGIN
      SELECT id INTO v_convex_id FROM protocol WHERE key = 'convex';
      SELECT id INTO v_cvx_id FROM protocol WHERE key = 'convex-cvxcrv';

      IF v_cvx_id IS NULL THEN
        RETURN; -- nothing to do
      END IF;

      IF v_convex_id IS NULL THEN
        -- Simple rename back
        UPDATE protocol SET key = 'convex', name = 'Convex' WHERE id = v_cvx_id;
      ELSE
        -- Move positions back and remove the 'convex-cvxcrv' row
        UPDATE position SET protocol_id = v_convex_id WHERE protocol_id = v_cvx_id;
        DELETE FROM protocol WHERE id = v_cvx_id;
        UPDATE protocol SET name = 'Convex' WHERE id = v_convex_id;
      END IF;
    END
    $$;
  `);
};
