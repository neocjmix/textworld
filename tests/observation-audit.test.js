import test from 'node:test';
import assert from 'node:assert/strict';
import { ObservationAudit } from '../experiments/observation-audit.mjs';

test('the soak audit detects a missing visible cell and distinguishes a fresh clock read', () => {
  const totals = {sameRevision:0,advancedOnRead:0,differences:{}};
  const observer = new ObservationAudit(totals);
  const first = {type:'snapshot',world:{epoch:1},viewRevision:1,view:{x:0,y:0,cols:1,rows:1},
    cells:[{x:0,y:0,text:'가',width:2,version:9}],marks:[],peers:[],freshness:{9:'now'},colors:{9:'#123'}};
  observer.receive(first);
  observer.requested = true;
  observer.receive({...first,viewRevision:2,freshness:{9:'recent'}});
  assert.deepEqual(totals,{sameRevision:0,advancedOnRead:1,differences:{}});
  observer.state.cells.clear();
  observer.requested = true;
  observer.receive({...first,viewRevision:2,freshness:{9:'recent'}});
  assert.deepEqual(totals,{sameRevision:1,advancedOnRead:1,differences:{cells:1}});
});
