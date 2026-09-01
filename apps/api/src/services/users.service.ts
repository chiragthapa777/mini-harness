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

export async function listUsers(): Promise<Omit<UserRow, "password_hash">[]> {
  return query<Omit<UserRow, "password_hash">>(
    `SELECT id::text, email, role, failed_login_attempts, locked_until, created_at
       FROM users
      ORDER BY created_at ASC`,
  );
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
