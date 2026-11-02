import {empty,add,CLIENT_METRICS} from '/shared/measurement.js';
export function createBrowserMeasurements(send) {
 const pending=new Map();let metrics={},paintStart=null,draws=0;
 const record=(name,value)=>{const h=metrics[name]||=empty();if(h.count<2000)add(h,value);};
 return {
  begin(id){pending.set(id,performance.now());if(pending.size>256)pending.delete(pending.keys().next().value);paintStart??=performance.now();},
  ack(id){const start=pending.get(id);if(start!==undefined){record('ack_ms',performance.now()-start);pending.delete(id);}},
  draw(start,area,glyphs){if(paintStart!==null){record('submit_to_draw_ms',performance.now()-paintStart);paintStart=null;}if(++draws%10===1){record('draw_ms',performance.now()-start);record('viewport_cells',area);record('drawn_glyphs',glyphs);}},
  flush(){record('dpr',devicePixelRatio||1);if(CLIENT_METRICS.some(n=>metrics[n]?.count)&&send({type:'telemetry',metrics}))metrics={};},
  reset(){pending.clear();paintStart=null;},
 };
}
