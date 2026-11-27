import {empty,add,CLIENT_METRICS} from '/shared/measurement.js';
export function createBrowserMeasurements(send) {
 const pending=new Map();let metrics={},paintStart=null,draws=0;
 const record=(name,value)=>{const h=metrics[name]||=empty();if(h.count<2000)add(h,value);};
 let visibilityAt=null, visible=false;
 function sampleVisibility() {
   if (visibilityAt === null) return;
   const at = performance.now(), elapsed = at - visibilityAt;
   // Timers can stop while a tab or the device sleeps.
   if (elapsed > 0 && elapsed <= 300000) record(visible ? 'visible_ms' : 'hidden_ms', elapsed);
   visibilityAt = at; visible = document.visibilityState === 'visible';
 }
 return {
  connected(){visibilityAt=performance.now();visible=document.visibilityState==='visible';},
  visibilityChanged:sampleVisibility,
  begin(id){pending.set(id,performance.now());if(pending.size>256)pending.delete(pending.keys().next().value);paintStart??=performance.now();},
  ack(id){const start=pending.get(id);if(start!==undefined){record('ack_ms',performance.now()-start);pending.delete(id);}},
  draw(start,area,glyphs,paintFraction=1){if(paintStart!==null){record('submit_to_draw_ms',performance.now()-paintStart);paintStart=null;}if(++draws%10===1){record('draw_ms',performance.now()-start);record('viewport_cells',area);record('drawn_glyphs',glyphs);record('paint_fraction',paintFraction);}},
  flush(){sampleVisibility();record('dpr',devicePixelRatio||1);if(CLIENT_METRICS.some(n=>metrics[n]?.count)&&send({type:'telemetry',metrics}))metrics={};},
  reset(){pending.clear();paintStart=null;visibilityAt=null;delete metrics.visible_ms;delete metrics.hidden_ms;},
 };
}
