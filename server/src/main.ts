import { createPool, configFromEnv } from './db.js';
import { createApp } from './http.js';
import { closeAll } from './sse.js';
import { runTimerSweep } from './timer.js';

/** Entry point. Listens on localhost only: Apache is the only thing that
 * should be able to reach this, and binding to 127.0.0.1 makes that true
 * at the socket rather than relying on a firewall rule. */

const PORT = Number(process.env.PORT ?? 3001);
const pool = createPool(configFromEnv());
const app = createApp(pool);

const server = app.listen(PORT, '127.0.0.1', () => {
  console.log(`roborally server listening on 127.0.0.1:${PORT}`);
});

// The On the Clock timer. Nothing else notices a deadline passing, since
// the server is otherwise purely request-driven.
const sweep = setInterval(() => {
  runTimerSweep(pool).catch((err) => console.error('timer sweep failed:', err));
}, 1000);

function shutdown() {
  clearInterval(sweep);
  closeAll();
  server.close(() => {
    pool.end().finally(() => process.exit(0));
  });
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
