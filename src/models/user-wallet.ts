import { query, queryOne } from '../utils/db';
import { UserWallet, Wallet } from '../types';

/**
 * Add a wallet to a user (create user_wallet link)
 */
export async function addWalletToUser(userId: string, walletId: string): Promise<UserWallet> {
  const result = await queryOne<UserWallet>(
    `INSERT INTO user_wallet (user_id, wallet_id)
     VALUES ($1, $2)
     ON CONFLICT (user_id, wallet_id) DO NOTHING
     RETURNING
      id,
      user_id as "userId",
      wallet_id as "walletId",
      created_at as "createdAt"`,
    [userId, walletId]
  );

  if (!result) {
    // If ON CONFLICT did nothing, return existing relationship
    const existing = await queryOne<UserWallet>(
      `SELECT
        id,
        user_id as "userId",
        wallet_id as "walletId",
        created_at as "createdAt"
       FROM user_wallet
       WHERE user_id = $1 AND wallet_id = $2`,
      [userId, walletId]
    );

    if (existing) {
      return existing;
    }

    throw new Error('Failed to add wallet to user');
  }

  return result;
}

/**
 * Remove a wallet from a user (soft delete - removes link only)
 */
export async function removeWalletFromUser(userId: string, walletId: string): Promise<boolean> {
  const result = await query(
    `DELETE FROM user_wallet
     WHERE user_id = $1 AND wallet_id = $2
     RETURNING id`,
    [userId, walletId]
  );
  return result.length > 0;
}

/**
 * Get all wallets for a user
 */
export async function getUserWallets(userId: string): Promise<Wallet[]> {
  return query<Wallet>(
    `SELECT
      w.id,
      w.address,
      w.ens_name as "ensName",
      w.created_at as "createdAt"
     FROM wallet w
     JOIN user_wallet uw ON w.id = uw.wallet_id
     WHERE uw.user_id = $1
     ORDER BY uw.created_at DESC`,
    [userId]
  );
}

/**
 * Get all user IDs tracking a wallet
 */
export async function getWalletUsers(walletId: string): Promise<string[]> {
  const result = await query<{ userId: string }>(
    `SELECT user_id as "userId"
     FROM user_wallet
     WHERE wallet_id = $1`,
    [walletId]
  );
  return result.map((row) => row.userId);
}

/**
 * Check if a user is tracking a specific wallet
 */
export async function isWalletTrackedByUser(
  userId: string,
  walletId: string
): Promise<boolean> {
  const result = await queryOne<{ exists: boolean }>(
    `SELECT EXISTS(
      SELECT 1 FROM user_wallet
      WHERE user_id = $1 AND wallet_id = $2
    ) as exists`,
    [userId, walletId]
  );
  return result?.exists || false;
}

/**
 * Get all user_wallet relationships
 */
export async function getAllUserWallets(): Promise<UserWallet[]> {
  return query<UserWallet>(
    `SELECT
      id,
      user_id as "userId",
      wallet_id as "walletId",
      created_at as "createdAt"
     FROM user_wallet
     ORDER BY created_at DESC`
  );
}
