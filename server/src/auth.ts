import { randomBytes, randomUUID, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import type { Pool, RowDataPacket } from 'mysql2/promise';

/**
 * STATUS: real, complete.
 *
 * Uses node's built-in scrypt rather than adding bcrypt or argon2. scrypt
 * is memory-hard, is in the standard library, and needs no native build
 * step — which matters when the same code has to run on a home box and on
 * a Linode instance. If a password-hashing dependency is acceptable,
 * argon2id is the stronger choice and this module is the only thing that
 * would change.
 *
 * Session tokens come from `randomUUID`, which is crypto-grade. NOTE: the
 * engine's `rng.ts` is NOT crypto-grade and must never be used here.
 */

const scryptAsync = promisify(scrypt) as (
  password: string, salt: Buffer, keylen: number,
) => Promise<Buffer>;

const KEY_LENGTH = 64;
const SESSION_DAYS = 30;

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const derived = await scryptAsync(password, salt, KEY_LENGTH);
  return `scrypt$${salt.toString('hex')}$${derived.toString('hex')}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [scheme, saltHex, hashHex] = stored.split('$');
  if (scheme !== 'scrypt' || !saltHex || !hashHex) return false;

  const expected = Buffer.from(hashHex, 'hex');
  const derived = await scryptAsync(password, Buffer.from(saltHex, 'hex'), expected.length);
  // Constant-time: a plain === leaks how many leading bytes matched.
  return derived.length === expected.length && timingSafeEqual(derived, expected);
}

export interface SessionUser {
  userId: number;
  username: string;
}

export async function createUser(
  pool: Pool, username: string, password: string,
): Promise<number> {
  const hash = await hashPassword(password);
  const [result] = await pool.execute(
    'INSERT INTO users (username, password_hash) VALUES (?, ?)',
    [username, hash],
  );
  return (result as { insertId: number }).insertId;
}

interface UserRow extends RowDataPacket {
  id: number;
  username: string;
  password_hash: string;
}

/** Returns a session token, or null if the credentials are wrong. The
 * caller must not distinguish "no such user" from "wrong password" in what
 * it tells the client. */
export async function login(
  pool: Pool, username: string, password: string,
): Promise<string | null> {
  const [rows] = await pool.query<UserRow[]>(
    'SELECT id, username, password_hash FROM users WHERE username = ?',
    [username],
  );
  const user = rows[0];
  if (!user) return null;
  if (!(await verifyPassword(password, user.password_hash))) return null;

  const token = randomUUID();
  const expires = new Date(Date.now() + SESSION_DAYS * 24 * 60 * 60 * 1000);
  await pool.execute(
    'INSERT INTO sessions (id, user_id, expires_at) VALUES (?, ?, ?)',
    [token, user.id, expires],
  );
  await pool.execute('UPDATE users SET last_seen_at = NOW() WHERE id = ?', [user.id]);
  return token;
}

export async function logout(pool: Pool, token: string): Promise<void> {
  await pool.execute('DELETE FROM sessions WHERE id = ?', [token]);
}

interface SessionRow extends RowDataPacket {
  user_id: number;
  username: string;
}

export async function resolveSession(
  pool: Pool, token: string | undefined,
): Promise<SessionUser | null> {
  if (!token) return null;
  const [rows] = await pool.query<SessionRow[]>(
    `SELECT s.user_id, u.username
       FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.id = ? AND s.expires_at > NOW()`,
    [token],
  );
  const row = rows[0];
  return row ? { userId: row.user_id, username: row.username } : null;
}

/** Deletes expired sessions. Call periodically; nothing depends on it for
 * correctness, since `resolveSession` already checks expiry. */
export async function pruneSessions(pool: Pool): Promise<void> {
  await pool.execute('DELETE FROM sessions WHERE expires_at <= NOW()');
}
