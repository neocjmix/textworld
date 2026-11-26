import http from 'node:http';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { maxActors } from './scenario.mjs';

// Only a driver launched by the world can use this temporary loopback listener.
// The public HTTP/WS listener never reads a client-supplied household identity.
export function createPlaytestIngress(upgrade, households) {
  const credential = randomBytes(32).toString('base64url');
  const server = http.createServer((_req, res) => res.writeHead(404).end());
  const sockets = new Set();
  let admitted = 0;
  server.on('connection', socket => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });
  server.on('upgrade', (req, socket, head) => {
    if (req.headers.authorization !== 'Bearer ' + credential || req.url !== '/ws') return socket.destroy();
    households.set(req, 'playtest-' + admitted++ % Math.ceil(maxActors / 4));
    upgrade(req, socket, head);
  });
  return {
    credential,
    async listen() {
      const ready = once(server, 'listening');
      server.listen(0, '127.0.0.1');
      await ready;
      return server.address().port;
    },
    async close() {
      const done = new Promise(resolve => server.close(resolve));
      for (const socket of sockets) socket.destroy();
      await done;
    },
  };
}
