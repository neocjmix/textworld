// Geometry-only exposure experiment: fixed 80x24 views at seeded locations.
import { remesh } from '../server/topology.js';
import { coherentSeams } from '../server/coherent-seams.js';
import { localContinuity } from '../server/local-continuity.js';
import { viewRectangle } from '../server/visibility.js';
import { writeFileSync, mkdirSync } from 'node:fs';

let random=42;
const next=n=>{random=(Math.imul(random,1664525)+1013904223)>>>0;return Math.floor(random/4294967296*n);};
const results=[];
for(const width of [64,128,256,512,896]){
  const from={width,height:width/2},to={...from,width:width+Math.floor(width/8)};
  const requested={cols:80,rows:24},cells=new Map();
  // Sparse rectangular paragraphs, with blank gutters.
  for(let y=8;y<from.height-8;y+=24)for(let x=12;x<from.width-24;x+=64)
    for(let row=0;row<4;row++)for(let col=0;col<20;col++)cells.set(`${x+col},${y+row}`,{x:x+col,y:y+row,text:'A',width:1,version:1});
  let preserved=0,total=0,oldPreserved=0;
  for(let seed=0;seed<4;seed++){
    const seams=coherentSeams(cells,from,'width',to.width-from.width,seed);
    const plan=remesh(cells,from,to,seed,{seams}),old=remesh(cells,from,to,seed);
    for(let n=0;n<250;n++){
      const peer={x:next(from.width),y:next(from.height)},before={peer,requested,view:viewRectangle(from,peer,requested)};
      const policy={recent:new Map(),carets:new Map(),origins:new Set([peer.x])},writing={lineStartX:peer.x,trail:[]};
      if(localContinuity(before,plan.cursor(peer),{...to,from,mapping:plan.point},policy,writing))preserved++;
      if(localContinuity(before,old.cursor(peer),{...to,from,mapping:old.point},policy,writing))oldPreserved++;
      total++;
    }
  }
  const result={width:from.width,height:from.height,views:total,preservedFraction:preserved/total,independentSeamsPreservedFraction:oldPreserved/total};
  results.push(result);console.log(JSON.stringify(result));
}
mkdirSync('artifacts',{recursive:true});writeFileSync('artifacts/local-continuity.json',JSON.stringify(results,null,2));
