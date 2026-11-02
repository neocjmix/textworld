// Fixed cardinality and mergeable histograms; no event payloads or identities.
export const BOUNDS = Object.freeze(Array.from({length: 41}, (_,i)=>2**i));
export function empty() { return { count:0,sum:0,min:null,max:null,bins:Array(42).fill(0) }; }
export function add(h,value) { if(!Number.isFinite(value)||value<0)return; h.count++;h.sum+=value;h.min=h.min===null?value:Math.min(h.min,value);h.max=h.max===null?value:Math.max(h.max,value);const i=value<=1?0:Math.min(41,Math.ceil(Math.log2(value)));h.bins[i]++; }
export function merge(a,b) {if(!b.count)return a;a.count+=b.count;a.sum+=b.sum;a.min=a.min===null?b.min:Math.min(a.min,b.min);a.max=a.max===null?b.max:Math.max(a.max,b.max);for(let i=0;i<42;i++)a.bins[i]+=b.bins[i];return a;}
export function summary(h) { let n=0,p95Upper=null;for(let i=0;i<42;i++){n+=h.bins[i];if(n>=h.count*.95){p95Upper=BOUNDS[i]??null;break;}}return {...h,mean:h.count?h.sum/h.count:null,p95Upper}; }
export const CLIENT_METRICS = Object.freeze(['draw_ms','submit_to_draw_ms','ack_ms','viewport_cells','drawn_glyphs','dpr']);
