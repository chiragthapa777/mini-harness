import { query } from "@mini-agent/db";

export type UserRole = "user" | "admin";

export interface UserRow {
  id: string;
  email: string;
  password_hash: string;
  role: UserRole;
  failed_login_attempts: number;
  locked_until: Date | null;
  created_at: Date;
}

/** There is no self-registration: every account is created by an admin (or the startup bootstrap). */
export async function createUser(
  email: string,
  passwordHash: string,
  role: UserRole = "user",
): Promise<UserRow> {
  const [row] = await query<UserRow>(
    `INSERT INTO users (email, password_hash, role)
     VALUES ($1, $2, $3)
     RETURNING id::text, email, password_hash, role, failed_login_attempts, locked_until, created_at`,
    [email, passwordHash, role],
  );
  if (!row) throw new Error("failed to create user");
  return row;
}

export type PublicUser = Omit<UserRow, "password_hash">;

/**
 * Paginated, and always with the total: the admin table needs to know how many
 * pages there are, and the user pickers on the other admin pages need enough
 * rows to fill a dropdown. Both read the same endpoint with different limits
 * rather than there being two ways to list users.
 */
export async function listUsers({
  limit = 50,
  offset = 0,
}: { limit?: number; offset?: number } = {}): Promise<{ users: PublicUser[]; total: number }> {
  const [users, countRows] = await Promise.all([
    query<PublicUser>(
      `SELECT id::text, email, role, failed_login_attempts, locked_until, created_at
         FROM users
        ORDER BY created_at ASC
        LIMIT $1 OFFSET $2`,
      [limit, offset],
    ),
    query<{ count: string }>(`SELECT count(*)::text FROM users`),
  ]);

  return { users, total: Number(countRows[0]?.count ?? 0) };
}

export async function findUserByEmail(email: string): Promise<UserRow | undefined> {
  const [row] = await query<UserRow>(
    `SELECT id::text, email, password_hash, role, failed_login_attempts, locked_until, created_at
       FROM users
      WHERE email = $1`,
    [email],
  );
  return row;
}

export async function findUserById(id: string): Promise<UserRow | undefined> {
  const [row] = await query<UserRow>(
    `SELECT id::text, email, password_hash, role, failed_login_attempts, locked_until, created_at
       FROM users
      WHERE id = $1`,
    [id],
  );
  return row;
}

/**
 * One failed login. Locks the account once `maxAttempts` is reached, for
 * `lockoutMinutes` from now — a fresh window, not stacked on top of any
 * existing lock.
 */
export async function recordFailedLogin(
  id: string,
  maxAttempts: number,
  lockoutMinutes: number,
): Promise<void> {
  await query(
    `UPDATE users
        SET failed_login_attempts = failed_login_attempts + 1,
            locked_until = CASE
              WHEN failed_login_attempts + 1 >= $2
                THEN now() + ($3 * interval '1 minute')
              ELSE locked_until
            END
      WHERE id = $1`,
    [id, maxAttempts, lockoutMinutes],
  );
}

/** A successful login clears both the counter and any lock. */
export async function recordSuccessfulLogin(id: string): Promise<void> {
  await query(`UPDATE users SET failed_login_attempts = 0, locked_until = NULL WHERE id = $1`, [
    id,
  ]);
}

/** Admin control: promote/demote a role. */
export async function setUserRole(id: string, role: UserRole): Promise<void> {
  await query(`UPDATE users SET role = $2 WHERE id = $1`, [id, role]);
}

/** Admin control: clear a lockout without waiting it out. */
export async function unlockUser(id: string): Promise<void> {
  await query(`UPDATE users SET failed_login_attempts = 0, locked_until = NULL WHERE id = $1`, [
    id,
  ]);
}
