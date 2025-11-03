import { query, queryOne } from '../utils/db';
import { User } from '../types';

/**
 * Get all users
 */
export async function getAllUsers(): Promise<User[]> {
  return query<User>(
    `SELECT
      id,
      username,
      display_name as "displayName",
      is_admin as "isAdmin",
      created_at as "createdAt"
     FROM "user"
     ORDER BY created_at DESC`
  );
}

/**
 * Get a user by ID
 */
export async function getUserById(id: string): Promise<User | null> {
  return queryOne<User>(
    `SELECT
      id,
      username,
      display_name as "displayName",
      is_admin as "isAdmin",
      created_at as "createdAt"
     FROM "user"
     WHERE id = $1`,
    [id]
  );
}

/**
 * Get a user by username
 */
export async function getUserByUsername(username: string): Promise<User | null> {
  return queryOne<User>(
    `SELECT
      id,
      username,
      display_name as "displayName",
      is_admin as "isAdmin",
      created_at as "createdAt"
     FROM "user"
     WHERE username = $1`,
    [username]
  );
}

/**
 * Create a new user
 */
export async function createUser(data: {
  username: string;
  displayName?: string | null;
}): Promise<User> {
  const result = await queryOne<User>(
    `INSERT INTO "user" (username, display_name)
     VALUES ($1, $2)
     RETURNING
      id,
      username,
      display_name as "displayName",
      is_admin as "isAdmin",
      created_at as "createdAt"`,
    [data.username, data.displayName || null]
  );

  if (!result) {
    throw new Error('Failed to create user');
  }

  return result;
}

/**
 * Update a user
 */
export async function updateUser(
  id: string,
  data: {
    username?: string;
    displayName?: string | null;
  }
): Promise<User | null> {
  const updates: string[] = [];
  const values: any[] = [];
  let paramIndex = 1;

  if (data.username !== undefined) {
    updates.push(`username = $${paramIndex++}`);
    values.push(data.username);
  }
  if (data.displayName !== undefined) {
    updates.push(`display_name = $${paramIndex++}`);
    values.push(data.displayName);
  }

  if (updates.length === 0) {
    return getUserById(id);
  }

  values.push(id);

  return queryOne<User>(
    `UPDATE "user"
     SET ${updates.join(', ')}
     WHERE id = $${paramIndex}
     RETURNING
      id,
      username,
      display_name as "displayName",
      is_admin as "isAdmin",
      created_at as "createdAt"`,
    values
  );
}

/**
 * Delete a user
 */
export async function deleteUser(id: string): Promise<boolean> {
  const result = await query(
    `DELETE FROM "user" WHERE id = $1 RETURNING id`,
    [id]
  );
  return result.length > 0;
}
