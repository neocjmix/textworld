import test from 'node:test';
import assert from 'node:assert/strict';
import { remesh } from '../server/topology.js';
import { coherentSeams } from '../server/coherent-seams.js';
import { cellKey } from '../shared/world.js';
import { World } from '../server/world.js';

test('coherent forced growth damages a narrow path instead of shearing every row',()=>{
  const from={width:64,height:32},to={width:72,height:32},cells=new Map();
  for(let y=0;y<32;y++)for(let x=0;x<64;x++)cells.set(cellKey(x,y),{x,y,text:'A',width:1,version:1});
  for(let seed=0;seed<12;seed++){
    const seams=coherentSeams(cells,from,'width',8,seed);
    assert.ok(new Set(seams.values).size>1,'never a straight stripe at zero or anywhere else');
    assert.deepEqual(seams,coherentSeams(cells,from,'width',8,seed));
    const a=remesh(cells,from,to,seed,{seams}),b=remesh(cells,from,to,seed);
    assert.equal(a.summary.lostTextCells,0);
    assert.ok(a.summary.brokenAdjacencies < b.summary.brokenAdjacencies/3);
  }
});

test('blank paths preserve a multi-line CJK paragraph through growth and shrink',t=>{
  const w=new World({width:128,height:64});t.after(()=>w.close());
  for(let row=0;row<5;row++)w.applyWrite({author:'a',id:'row'+row,epoch:1,x:40,y:25+row,text:'한글 문맥 ABC 日本語'});
  for(const [axis,delta]of [['width',16],['height',8],['width',-16],['height',-8]]){
    const from={width:w.width,height:w.height},to={...from,[axis]:from[axis]+delta};
    const seams=coherentSeams(w.cells,from,axis,delta,42);
    const plan=remesh(w.cells,from,to,42,{seams});
    assert.equal(plan.preservesText,true);
    assert.equal(plan.summary.lostTextCells,0);assert.equal(plan.summary.brokenAdjacencies,0);
    w.resize(to.width,to.height,[],{seed:42,seams});
  }
});

test('coherent forced paths never leave a half glyph after changes on both axes',()=>{
  for(let seed=0;seed<8;seed++){
    const w=new World({width:64,height:32});
    try{
      for(let y=0;y<32;y++)w.applyWrite({author:'a',id:'row'+y,epoch:1,x:0,y,text:y%2?'한'.repeat(32):'A'.repeat(64)});
      for(const [axis,delta]of [['width',8],['height',4],['width',-8],['height',-4]]){
        const from={width:w.width,height:w.height},to={...from,[axis]:from[axis]+delta};
        const seams=coherentSeams(w.cells,from,axis,delta,seed);
        w.resize(to.width,to.height,[],{seed,seams});
        for(const cell of w.cells.values())if(cell.width===2||cell.width===0){
          const span=w.spanAt(cell.x,cell.y);assert.equal(span.length,2);
          assert.equal(span[0].width,2);assert.equal(span[1].width,0);assert.equal(span[0].version,span[1].version);
        }
      }
    }finally{w.close();}
  }
});
