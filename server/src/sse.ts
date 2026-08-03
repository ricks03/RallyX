import type { Response } from 'express';

/**
 * STATUS: real, complete.
 *
 * Server-sent events. One HTTP connection per watching client, held open,
 * server pushes down it. Chosen over websockets because everything the
 * client SENDS is a discrete action that fits an ordinary POST, so the
 * upstream half of a duplex channel would go unused; and SSE reconnects on
 * its own, which a websocket does not.
 *
 * This hub is per-process and in-memory. That is correct for a single Node
 * process, which is the intended deployment. Running several processes
 * behind Apache would mean a client connected to process A never hearing
 * about an advance that happened on process B — at which point this needs
 * to become MariaDB polling of `games.version`, or Redis pub/sub. Noted
 * here rather than built, since the deployment is one process.
 */

interface Subscriber {
  res: Response;
  robotId: string | null;
  userId: number | null;
}

const rooms = new Map<number, Set<Subscriber>>();

/** Registers a response as a listener and wires up its own teardown. */
export function subscribe(
  gameId: number,
  res: Response,
  robotId: string | null,
  userId: number | null,
): void {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    // Tells Apache's proxy not to buffer. Without this, mod_proxy can hold
    // events until the buffer fills, which for small JSON payloads means
    // they never arrive.
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders?.();

  const subscriber: Subscriber = { res, robotId, userId };
  let room = rooms.get(gameId);
  if (!room) {
    room = new Set();
    rooms.set(gameId, room);
  }
  room.add(subscriber);

  // Opening comment forces the headers out through any intermediary that
  // is waiting for a first byte before committing the response.
  res.write(': connected\n\n');

  const heartbeat = setInterval(() => {
    res.write(': ping\n\n');
  }, 20000);

  res.on('close', () => {
    clearInterval(heartbeat);
    room?.delete(subscriber);
    if (room && room.size === 0) rooms.delete(gameId);
  });
}

/**
 * Sends an event to everyone watching a game. `build` is called once per
 * subscriber with that subscriber's robot id, so each client can be sent a
 * DIFFERENT payload — which is the whole point, since one player's hand
 * must not go to another.
 */
export function broadcast(
  gameId: number,
  event: string,
  build: (robotId: string | null) => unknown,
): void {
  const room = rooms.get(gameId);
  if (!room) return;

  for (const subscriber of room) {
    const payload = JSON.stringify(build(subscriber.robotId));
    subscriber.res.write(`event: ${event}\ndata: ${payload}\n\n`);
  }
}

export function subscriberCount(gameId: number): number {
  return rooms.get(gameId)?.size ?? 0;
}

/** Closes every stream. For shutdown. */
export function closeAll(): void {
  for (const room of rooms.values()) {
    for (const subscriber of room) subscriber.res.end();
  }
  rooms.clear();
}
