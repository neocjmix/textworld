// Rebuild one ordinary socket's visible state. An explicit sync fences its
// pending views; the full server observation is an independent reconciliation.
import { isDeepStrictEqual } from 'node:util';
const key = p => p.x + ',' + p.y;
const byCell = records => new Map(records.map(p => [key(p),p]));
const byPeer = records => new Map(records.map(p => [p.id,p]));
const full = m => ({ cells:byCell(m.cells), marks:byCell(m.marks), peers:byPeer(m.peers),
  freshness:{...m.freshness}, colors:{...m.colors}, view:m.view });

export class ObservationAudit {
  constructor(totals) { this.totals = totals; }

  receive(message) {
    if (message.type === 'snapshot' && !message.patch) {
      const expected = full(message);
      if (this.requested && !message.reason && this.state) {
        const sameRevision = message.world.epoch === this.epoch && this.revision === message.viewRevision;
        // A full read may advance the coarse clock before the next five-second
        // wake. Compare all dimensions at an identical revision, and also check
        // cells, peer positions and the view at these intervening clock reads.
        const dimensions = sameRevision ? Object.keys(expected) : ['cells','peers','view'];
        if (sameRevision) this.totals.sameRevision++;
        else this.totals.advancedOnRead++;
        for (const field of dimensions) if (!isDeepStrictEqual(this.state[field], expected[field])) {
          this.totals.differences[field] = (this.totals.differences[field] || 0) + 1;
        }
        this.requested = false;
      }
      this.state = expected;
      this.revision = message.viewRevision;
    } else {
      const change = message.patch || message.observation;
      if (!change || !this.state) return;
      const s = this.state;
      if (message.basis && (message.basis.dx || message.basis.dy)) {
        const {dx,dy} = message.basis;
        const shift = p => ({...p,x:p.x+dx,y:p.y+dy,...(Number.isInteger(p.leadX) ? {leadX:p.leadX+dx} : {})});
        s.cells = byCell([...s.cells.values()].map(shift));
        s.marks = byCell([...s.marks.values()].map(shift));
        s.peers = byPeer([...s.peers.values()].map(shift));
      }
      if (change.reset) s.cells.clear();
      for (const c of change.forget) s.cells.delete(key(c));
      for (const c of change.cells) s.cells.set(key(c), c);
      if (change.partial) {
        for (const p of change.unmark) s.marks.delete(key(p));
        for (const p of change.marks) s.marks.set(key(p),p);
        for (const id of change.departed) s.peers.delete(id);
        for (const p of change.peers) s.peers.set(p.id,p);
        for (const id of change.forgetVersions) { delete s.freshness[id]; delete s.colors[id]; }
        Object.assign(s.freshness,change.freshness); Object.assign(s.colors,change.colors);
      } else {
        s.marks = byCell(change.marks); s.peers = byPeer(change.peers);
        s.freshness = {...change.freshness}; s.colors = {...change.colors};
      }
      s.view = change.view;
      this.revision = change.revision;
    }
    this.epoch = message.world.epoch;
  }
}
