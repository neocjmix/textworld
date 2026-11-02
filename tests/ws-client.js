import { WebSocket } from 'ws';

export function connect(url) {
  const socket = new WebSocket(url), messages = [], waiters = [];
  const state = { cells: new Map(), peers: [], world: null, selfId: null, view: null };
  socket.on('error', () => {});
  socket.on('message', raw => {
    const message = JSON.parse(raw.toString()); messages.push(message);
    if (message.type === 'snapshot') {
      state.cells = new Map(message.cells.map(cell => [`${cell.x},${cell.y}`, cell]));
      Object.assign(state, { peers: message.peers, world: message.world, selfId: message.selfId, view: message.view });
    } else if (message.type === 'view') {
      const observation = message.observation;
      if (observation.reset) state.cells.clear();
      for (const cell of observation.forget) state.cells.delete(`${cell.x},${cell.y}`);
      for (const cell of observation.cells) state.cells.set(`${cell.x},${cell.y}`, cell);
      Object.assign(state, { peers: observation.peers, world: message.world, view: observation.view });
    }
    for (const waiter of [...waiters]) if (messages.length > waiter.after && waiter.predicate(message)) {
      waiters.splice(waiters.indexOf(waiter), 1); clearTimeout(waiter.timer); waiter.resolve(message);
    }
  });
  const next = (predicate, after = 0, timeout = 3000) => new Promise((resolve, reject) => {
    const existing = messages.slice(after).find(predicate);
    if (existing) return resolve(existing);
    const waiter = { predicate, after, resolve, timer: setTimeout(() => {
      waiters.splice(waiters.indexOf(waiter), 1);
      reject(new Error(`Timed out waiting for protocol message; recent: ${JSON.stringify(messages.slice(-3))}`));
    }, timeout) };
    waiters.push(waiter);
  });
  const send = value => socket.send(JSON.stringify({ layout: 2, ...value }));
  const sync = async () => {
    const after = messages.length; send({ type: 'sync' });
    return next(message => message.type === 'snapshot', after);
  };
  const locate = async (x, y, epoch = state.world.epoch) => {
    send({ type: 'move', epoch, x, y });
    return sync();
  };
  return { socket, messages, next, send, state, sync, locate };
}

export const observationOf = message => message.type === 'view' ? message.observation
  : message.type === 'snapshot' ? message : null;
export const hasCell = (message, x, y, text, version) => observationOf(message)?.cells.some(cell =>
  cell.x === x && cell.y === y && cell.text === text && (version === undefined || cell.version === version));
export const hasPeer = (message, id, x, y) => observationOf(message)?.peers.some(peer =>
  peer.id === id && (x === undefined || peer.x === x) && (y === undefined || peer.y === y));
