import { query, queryOne } from '../utils/db';
import { Authenticator } from '../types';

/**
 * Get all authenticators for a user
 */
export async function getAuthenticatorsByUserId(userId: string): Promise<Authenticator[]> {
  return query<Authenticator>(
    `SELECT
      id,
      user_id as "userId",
      credential_id as "credentialId",
      credential_public_key as "credentialPublicKey",
      counter,
      credential_device_type as "credentialDeviceType",
      credential_backed_up as "credentialBackedUp",
      transports,
      created_at as "createdAt"
     FROM authenticator
     WHERE user_id = $1
     ORDER BY created_at DESC`,
    [userId]
  );
}

/**
 * Get an authenticator by credential ID
 */
export async function getAuthenticatorByCredentialId(
  credentialId: string
): Promise<Authenticator | null> {
  return queryOne<Authenticator>(
    `SELECT
      id,
      user_id as "userId",
      credential_id as "credentialId",
      credential_public_key as "credentialPublicKey",
      counter,
      credential_device_type as "credentialDeviceType",
      credential_backed_up as "credentialBackedUp",
      transports,
      created_at as "createdAt"
     FROM authenticator
     WHERE credential_id = $1`,
    [credentialId]
  );
}

/**
 * Create a new authenticator
 */
export async function createAuthenticator(data: {
  userId: string;
  credentialId: string;
  credentialPublicKey: Buffer;
  counter: number;
  credentialDeviceType: string;
  credentialBackedUp: boolean;
  transports?: string | null;
}): Promise<Authenticator> {
  const result = await queryOne<Authenticator>(
    `INSERT INTO authenticator (
      user_id, credential_id, credential_public_key, counter,
      credential_device_type, credential_backed_up, transports
    )
    VALUES ($1, $2, $3, $4, $5, $6, $7)
    RETURNING
      id,
      user_id as "userId",
      credential_id as "credentialId",
      credential_public_key as "credentialPublicKey",
      counter,
      credential_device_type as "credentialDeviceType",
      credential_backed_up as "credentialBackedUp",
      transports,
      created_at as "createdAt"`,
    [
      data.userId,
      data.credentialId,
      data.credentialPublicKey,
      data.counter,
      data.credentialDeviceType,
      data.credentialBackedUp,
      data.transports || null,
    ]
  );

  if (!result) {
    throw new Error('Failed to create authenticator');
  }

  return result;
}

/**
 * Update authenticator counter (for replay attack prevention)
 */
export async function updateAuthenticatorCounter(
  credentialId: string,
  newCounter: number
): Promise<boolean> {
  const result = await query(
    `UPDATE authenticator
     SET counter = $2
     WHERE credential_id = $1
     RETURNING id`,
    [credentialId, newCounter]
  );
  return result.length > 0;
}

/**
 * Delete an authenticator
 */
export async function deleteAuthenticator(id: string): Promise<boolean> {
  const result = await query(
    `DELETE FROM authenticator WHERE id = $1 RETURNING id`,
    [id]
  );
  return result.length > 0;
}
