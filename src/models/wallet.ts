import { query, queryOne } from '../utils/db';
import { Wallet } from '../types';

export async function createWallet(address: string, ensName?: string | null): Promise<Wallet> {
  const result = await queryOne<Wallet>(
    `INSERT INTO wallet (address, ens_name)
     VALUES ($1, $2)
     RETURNING
       id,
       address,
       ens_name as "ensName",
       created_at as "createdAt"`,
    [address, ensName ?? null]
  );

  if (!result) {
    throw new Error('Failed to create wallet');
  }

  return result;
}

export async function getAllWallets(): Promise<Wallet[]> {
  return query<Wallet>(
    `SELECT
      id,
      address,
      ens_name as "ensName",
      created_at as "createdAt"
     FROM wallet ORDER BY created_at DESC`
  );
}

export async function getWalletById(id: string): Promise<Wallet | null> {
  return queryOne<Wallet>(
    `SELECT
      id,
      address,
      ens_name as "ensName",
      created_at as "createdAt"
     FROM wallet WHERE id = $1`,
    [id]
  );
}

export async function getWalletByAddress(address: string): Promise<Wallet | null> {
  return queryOne<Wallet>(
    `SELECT
      id,
      address,
      ens_name as "ensName",
      created_at as "createdAt"
     FROM wallet WHERE address = $1`,
    [address]
  );
}

export async function getOrCreateWalletByAddress(address: string, ensName?: string | null): Promise<Wallet> {
  // Try to get existing wallet
  const existing = await getWalletByAddress(address);
  if (existing) {
    // If ENS name is provided and different, update it
    if (ensName && ensName !== existing.ensName) {
      await setWalletEnsName(existing.id, ensName);
      return { ...existing, ensName };
    }
    return existing;
  }

  // Create new wallet
  return createWallet(address, ensName);
}

export async function deleteWallet(id: string): Promise<boolean> {
  const result = await query(
    `DELETE FROM wallet WHERE id = $1 RETURNING id`,
    [id]
  );
  return result.length > 0;
}

export async function setWalletEnsName(id: string, ensName: string | null): Promise<boolean> {
  const result = await query(
    `UPDATE wallet SET ens_name = $2 WHERE id = $1 RETURNING id`,
    [id, ensName]
  );
  return result.length > 0;
}
