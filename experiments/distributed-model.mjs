// Executable semantic model, NOT a distributed server or performance benchmark.
// Tests a mergeable slot register, whole-glyph visibility, bounded expiry floor,
// and an address-to-layout directory on a rectangular torus.
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';

const checks=[];
const check=(name,run)=>{run();checks.push(name);console.log(`PASS ${name}`);};
const permutations=items=>items.length?items.flatMap((item,i)=>permutations(items.filter((_,j)=>j!==i)).map(tail=>[item,...tail])):[[]];
// A totally ordered server-issued stamp is represented by a number here.
// Production must include server HLC, issuer identity and unique operation ID.
function merge(...registers) {
  const result=new Map();
  for(const register of registers)for(const [slot,op]of register)if(!result.has(slot)||result.get(slot).stamp<op.stamp)result.set(slot,op);
  return result;
}
const write=op=>new Map(op.slots.map(slot=>[slot,op]));
const canonical=register=>[...register].sort(([a],[b])=>a.localeCompare(b)).map(([slot,op])=>[slot,op.id]);
function visible(register, {floor=0, killed=new Set(), adjacent=()=>true}={}) {
  return [...new Set(register.values())].filter(op=>op.text && op.cohort>=floor && !killed.has(op.id)
    && op.slots.every(slot=>register.get(slot)?.id===op.id)
    && (op.slots.length===1||adjacent(...op.slots))).map(op=>op.id).sort();
}
const a={id:'wide-A',stamp:1,cohort:0,text:'한',slots:['s0','s1']};
const b={id:'narrow-B',stamp:2,cohort:1,text:'B',slots:['s1']};
const c={id:'wide-C',stamp:3,cohort:2,text:'글',slots:['s1','s2']};
const d={id:'delete-D',stamp:4,cohort:3,text:'',slots:['s2']};

check('all delivery orders and duplicates converge to the same winning slots',()=>{
  const expected=canonical(merge(...[a,b,c,d].map(write)));
  for(const order of permutations([a,b,c,d]))assert.deepEqual(canonical(merge(...[...order,order[0],order[1]].map(write))),expected);
});
check('partial overwrite removes the entire old wide glyph, without resurrecting older glyphs',()=>{
  assert.deepEqual(visible(merge(write(a),write(b))),['narrow-B']);
  assert.deepEqual(visible(merge(write(a),write(b),write(c))),['wide-C']);
  assert.deepEqual(visible(merge(write(a),write(b),write(c),write(d))),[]);
});
check('grouped reduction is associative, commutative and idempotent',()=>{
  const A=write(a),B=write(b),C=write(c);
  assert.deepEqual(canonical(merge(merge(A,B),C)),canonical(merge(A,merge(B,C))));
  assert.deepEqual(canonical(merge(A,B)),canonical(merge(B,A)));
  assert.deepEqual(canonical(merge(A,A)),canonical(A));
});
check('retiring an old cohort preserves a newer overwrite and rejects delayed expired records',()=>{
  const floor=1, admit=op=>op.cohort>=floor?write(op):new Map();
  const compacted=new Map([...merge(write(a),write(b))].filter(([,op])=>op.cohort>=floor));
  assert.deepEqual(visible(merge(compacted,admit(a)),{floor}),['narrow-B']);
});
check('a receiver with only half a wide operation displays neither half',()=>{
  assert.deepEqual(visible(new Map([['s0',a]])),[]);
  assert.deepEqual(visible(write(a)),['wide-A']);
});

let random=41,nextID=0;
const rand=n=>{random=(Math.imul(random,1664525)+1013904223)>>>0;return random%n;};
const slot=()=>`place-${++nextID}`;
let grid=Array.from({length:8},()=>Array.from({length:16},slot));
const data=new Map();
for(let y=0;y<grid.length;y++)for(let x=0;x<grid[0].length;x++)if((x+3*y)%5===0)data.set(grid[y][x],`text-${x}-${y}`);
const originalData=JSON.stringify([...data]),initialIDs=new Set(grid.flat());
const coords=()=>new Map(grid.flatMap((row,y)=>row.map((id,x)=>[id,{x,y}])));
const isBlank=id=>!data.has(id);
function choose(values){const blank=values.map((id,i)=>isBlank(id)?i:-1).filter(i=>i>=0);return blank.length?blank[rand(blank.length)]:rand(values.length);}
function resize(axis,grow){
  const removed=new Map(),seams=[];
  if(axis==='x')grid=grid.map(row=>{
    const at=choose(row),next=[...row];seams.push(at);
    if(grow)next.splice(at,0,slot());else{const [old]=next.splice(at,1);removed.set(old,next[at%next.length]);}
    return next;
  });
  else {
    const columns=grid[0].map((_,x)=>grid.map(row=>row[x]));
    for(const column of columns){const at=choose(column);seams.push(at);if(grow)column.splice(at,0,slot());else{const [old]=column.splice(at,1);removed.set(old,column[at%column.length]);}}
    grid=Array.from({length:columns[0].length},(_,y)=>columns.map(column=>column[y]));
  }
  return {removed,seams};
}
let cursor=grid[3][4],cursorCorrections=0,geometryChanges=0;
check('alternating scattered x/y growth and shrink retains a rectangular torus and stable data addresses',()=>{
  for(let n=0;n<200;n++){
    const axis=n%2?'y':'x',grow=Math.floor(n/2)%2===0;
    const before=new Set(grid.flat()),change=resize(axis,grow);geometryChanges++;
    if(change.removed.has(cursor)){cursor=change.removed.get(cursor);cursorCorrections++;}
    const location=coords(),width=grid[0].length,height=grid.length;
    assert.equal(new Set(grid.flat()).size,width*height);
    assert.ok(grid.every(row=>row.length===width));assert.ok(location.has(cursor));
    for(let y=0;y<height;y++)for(let x=0;x<width;x++){
      assert.equal(grid[y][((x+1)%width+width-1)%width],grid[y][x]);
      assert.equal(grid[((y+1)%height+height-1)%height][x],grid[y][x]);
    }
    for(const id of before)assert.ok(location.has(id)||change.removed.has(id));
    assert.equal(JSON.stringify([...data]),originalData,'geometry edits do not rewrite text storage');
  }
});
check('a removed cursor redirects to a surviving neighbour and the next input uses that place',()=>{
  const row=grid[0];cursor=row[0];const survivor=row[1];
  for(const r of grid)r.splice(0,1);
  cursor=survivor;assert.ok(coords().has(cursor));
  const register=write({id:'after-cut',stamp:20,cohort:4,text:'가',slots:[cursor]});
  assert.deepEqual(visible(register),['after-cut']);
});
check('a cut wide glyph stays destroyed even if its slots become adjacent again later',()=>{
  const killed=new Set();
  const register=write(a);
  assert.deepEqual(visible(register,{adjacent:()=>true}),['wide-A']);
  if(!visible(register,{adjacent:()=>false}).length)killed.add(a.id);
  assert.deepEqual(visible(register,{killed,adjacent:()=>true}),[]);
});
check('fully occupied rows still admit growth and forced removal',()=>{
  for(const id of grid.flat())data.set(id,'occupied');
  const width=grid[0].length;resize('x',true);assert.equal(grid[0].length,width+1);
  for(const id of grid.flat())data.set(id,'occupied');
  const cut=resize('x',false);assert.equal(grid[0].length,width);assert.equal(cut.removed.size,grid.length);
});
const report={at:new Date().toISOString(),kind:'semantic toy model; no distributed runtime or performance validation',passed:checks.length,checks,
  geometryChanges,cursorCorrections,initialPlaces:initialIDs.size,remainingOriginalPlaces:grid.flat().filter(id=>initialIDs.has(id)).length,
  limitations:['dense in-process geometry directory; no distributed index implementation','scalar stamps stand in for server-issued HLC/order keys','cohort admission floor is assumed agreed and is not a consensus implementation','geometry fracture detection is explicit; incremental distributed detection is unimplemented','no network partitions, lease handover, real browser, GPS projection or throughput validation']};
await mkdir('artifacts',{recursive:true});await writeFile('artifacts/distributed-model.json',JSON.stringify(report,null,2));
console.log(JSON.stringify(report));
