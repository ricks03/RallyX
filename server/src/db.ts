import mysql from 'mysql2/promise';
import type { Pool } from 'mysql2/promise';

/**
 * STATUS: real, complete. Connection pool setup.
 *
 * `dateStrings` is deliberately left off so DATETIME columns arrive as JS
 * Date objects, which is what `phase_deadline` comparisons want. Note that
 * mysql2 interprets those in the connection's timezone; set the server and
 * the pool to UTC and there is nothing to think about. `timezone: 'Z'`
 * does that here.
 */

export interface DbConfig {
  host: string;
  port?: number;
  user: string;
  password: string;
  database: string;
  connectionLimit?: number;
}

export function createPool(config: DbConfig): Pool {
  return mysql.createPool({
    host: config.host,
    port: config.port ?? 3306,
    user: config.user,
    password: config.password,
    database: config.database,
    connectionLimit: config.connectionLimit ?? 10,
    timezone: 'Z',
    // Every query in this server is parameterised; named placeholders are
    // not used, so this stays off.
    namedPlaceholders: false,
    charset: 'utf8mb4',
  });
}

export function configFromEnv(): DbConfig {
  const { DB_HOST, DB_USER, DB_PASSWORD, DB_NAME, DB_PORT } = process.env;
  if (!DB_HOST || !DB_USER || !DB_NAME) {
    throw new Error('DB_HOST, DB_USER and DB_NAME must be set');
  }
  return {
    host: DB_HOST,
    port: DB_PORT ? Number(DB_PORT) : undefined,
    user: DB_USER,
    password: DB_PASSWORD ?? '',
    database: DB_NAME,
  };
}
