import { wrap, cellKey, graphemes, gpsToCell, writePlan } from '/shared/world.js';

const $ = id => document.getElementById(id);
const canvas = $('field'), ctx = canvas.getContext('2d'), input = $('input');
const map = $('minimap'), mctx = map.getContext('2d');
let world = null, selfId = null, cells = new Map(), peers = [], cursor = {x:0,y:0};
let camera = {x:0,y:0}, zoom = 1, size = {width:1,height:1}, socket, connected = false;
let firstSnapshot = true, composing = false, compositionTail = null, compositionSession = null, id = 0, pending = new Map();
let gpsRequest = 0, drag = null, frame = null, reconnectTimer, navigationRevision = 0;
let moveTimer = null, queuedMove = null, lastSentPosition = null;
const baseCell = {width:24,height:30};
const dimensions = () => ({width:baseCell.width*zoom,height:baseCell.height*zoom});
const visible = () => {const d=dimensions(); return {cols:size.width/d.width,rows:size.height/d.height};};
const notice = message => {$('notice').textContent = message;};
function send(message) {if (!connected || socket.readyState !== WebSocket.OPEN) return false; socket.send(JSON.stringify(message)); return true;}
function schedule() {if(!frame)frame=requestAnimationFrame(()=>{frame=null;draw();});}
function center() {const v=visible();camera={x:cursor.x-v.cols/2+.5,y:cursor.y-v.rows/2+.5};schedule();}
function position() {$('coordinates').textContent=`${cursor.x}, ${cursor.y}`; schedule();}
function cancelMove() {clearTimeout(moveTimer);moveTimer=null;queuedMove=null;}
function queueMove() {
  queuedMove={type:'move',...cursor,epoch:world.epoch};
  if(moveTimer)return;
  moveTimer=setTimeout(()=>{moveTimer=null;const next=queuedMove;queuedMove=null;if(next&&JSON.stringify(next)!==lastSentPosition&&send(next))lastSentPosition=JSON.stringify(next);},40);
}
function move(x,y,{recenter=false,manual=true}={}) {
  if(!world)return;
  if(compositionSession)compositionSession.cancelled=true;
  cursor={x:wrap(x,world.width),y:wrap(y,world.height)};
  if(manual)navigationRevision++;
  if(recenter)center();else keepCursorVisible();
  queueMove();position();
}
function lifted(value, start, length) {return value+Math.round((start-value)/length)*length;}
function keepCursorVisible() {
  const v=visible();let x=lifted(cursor.x,camera.x+v.cols/2,world.width),y=lifted(cursor.y,camera.y+v.rows/2,world.height);
  if(x<camera.x)camera.x=x;if(x+1>camera.x+v.cols)camera.x=x+1-v.cols;
  if(y<camera.y)camera.y=y;if(y+1>camera.y+v.rows)camera.y=y+1-v.rows;
}
// Panning exposes the nearest fully visible cell as presence, even without typing.
function couplePan() {
  if(!world)return;
  const v=visible();let x=lifted(cursor.x,camera.x+v.cols/2,world.width),y=lifted(cursor.y,camera.y+v.rows/2,world.height);
  x=Math.max(Math.ceil(camera.x),Math.min(Math.floor(camera.x+v.cols-1),x));
  y=Math.max(Math.ceil(camera.y),Math.min(Math.floor(camera.y+v.rows-1),y));
  move(x,y);schedule();
}
function setZoom(value) {zoom=Math.min(2,Math.max(.6,value));$('zoom-level').textContent=`${Math.round(zoom*100)}%`;$('zoom-out').disabled=zoom<=.6;$('zoom-in').disabled=zoom>=2;if(world)keepCursorVisible();schedule();}
function paintCursor(peer,x,y,d) {
  const own=peer.id===selfId, color=own?'#287054':peer.color||'#b17640';
  ctx.fillStyle=color;ctx.globalAlpha=own?.14:.19;ctx.fillRect(x+1,y+1,d.width-2,d.height-2);ctx.globalAlpha=1;
  ctx.strokeStyle=color;ctx.lineWidth=own?2:1.5;ctx.strokeRect(x+1.5,y+1.5,d.width-3,d.height-3);
  ctx.fillStyle=color;ctx.fillRect(x+2,y+d.height-4,d.width-4,2);
  if(!own){ctx.font='10px Arial';const label=peer.name||'방문자',w=ctx.measureText(label).width+8;ctx.fillRect(x,y-15,w,14);ctx.fillStyle='#fff';ctx.fillText(label,x+4,y-4);}
}
function draw() {
  const d=dimensions();ctx.clearRect(0,0,size.width,size.height);ctx.fillStyle='#fbfaf5';ctx.fillRect(0,0,size.width,size.height);
  if(!world)return;
  const v=visible(), startX=Math.floor(camera.x),startY=Math.floor(camera.y);
  ctx.lineWidth=1;ctx.strokeStyle='#e9ebe2';ctx.beginPath();
  for(let x=startX;x<=camera.x+v.cols;x++){const px=(x-camera.x)*d.width;ctx.moveTo(px+.5,0);ctx.lineTo(px+.5,size.height);}
  for(let y=startY;y<=camera.y+v.rows;y++){const py=(y-camera.y)*d.height;ctx.moveTo(0,py+.5);ctx.lineTo(size.width,py+.5);}ctx.stroke();
  const displayedPeers=peers.filter(p=>p.id!==selfId).concat([{id:selfId,...cursor}]);
  for(let y=startY;y<=camera.y+v.rows;y++)for(let x=startX;x<=camera.x+v.cols;x++){
    const wx=wrap(x,world.width),wy=wrap(y,world.height),px=(x-camera.x)*d.width,py=(y-camera.y)*d.height;
    if(wx===0||wy===0){ctx.strokeStyle='#c7d1c0';ctx.setLineDash([3,4]);ctx.beginPath();if(wx===0){ctx.moveTo(px,py);ctx.lineTo(px,py+d.height);}if(wy===0){ctx.moveTo(px,py);ctx.lineTo(px+d.width,py);}ctx.stroke();ctx.setLineDash([]);}
    const cell=cells.get(cellKey(wx,wy));
    if(cell?.text){ctx.fillStyle='#314137';ctx.font=`${Math.round(17*zoom)}px ui-monospace, "Apple SD Gothic Neo", monospace`;ctx.textAlign='center';ctx.textBaseline='middle';ctx.fillText(cell.text,px+d.width/2,py+d.height/2+1,d.width-3);ctx.textAlign='left';ctx.textBaseline='alphabetic';}
  }
  // Labels are painted last so adjacent cells cannot cover them.
  for(const peer of displayedPeers)for(let y=startY;y<=camera.y+v.rows;y++)if(wrap(y,world.height)===peer.y)for(let x=startX;x<=camera.x+v.cols;x++)if(wrap(x,world.width)===peer.x)paintCursor(peer,(x-camera.x)*d.width,(y-camera.y)*d.height,d);
  $('welcome').hidden=cells.size>0 || peers.length>1 || navigationRevision>0;
  mctx.clearRect(0,0,map.width,map.height);mctx.fillStyle='#edf0e6';mctx.fillRect(0,0,map.width,map.height);
  mctx.fillStyle='#a5b39a';for(const c of cells.values())if(c.text)mctx.fillRect(c.x/world.width*map.width,c.y/world.height*map.height,2,2);
  for(const p of displayedPeers){mctx.fillStyle=p.id===selfId?'#287054':p.color||'#b17640';mctx.fillRect(p.x/world.width*map.width-2,p.y/world.height*map.height-2,4,4);}
}
function resizeCanvas() {const r=canvas.getBoundingClientRect(),dpr=window.devicePixelRatio||1;size={width:r.width,height:r.height};canvas.width=Math.round(r.width*dpr);canvas.height=Math.round(r.height*dpr);ctx.setTransform(dpr,0,0,dpr,0,0);if(world)keepCursorVisible();schedule();}
new ResizeObserver(resizeCanvas).observe($('viewport'));
function localEnd(text) {return writePlan(text,cursor.x,cursor.y,world).cursor;}
function write(text) {
  if(!connected||!world){notice('연결 후 다시 입력해 주세요. 오프라인 입력은 전송하지 않습니다.');return;}
  text=text.replace(/\r\n?/g,'\n');if(!text)return;
  if(text.length>4096 || /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/u.test(text) || graphemes(text).length>512){notice('한 번에 입력 문자 512개까지 가능합니다. 탭은 공백 4칸이며 제어 문자는 지원하지 않습니다.');return;}
  cancelMove();lastSentPosition=null;
  const opId=`${selfId}:${++id}`,end=localEnd(text);
  if(send({type:'write',id:opId,epoch:world.epoch,...cursor,text})){pending.set(opId,text);cursor=end;navigationRevision++;keepCursorVisible();position();$('write-state').textContent='글자를 보내는 중';}
}
function erase(backward) {if(!connected||!world)return;if(backward)move(cursor.x-1,cursor.y);cancelMove();lastSentPosition=null;const opId=`${selfId}:${++id}`;pending.set(opId,'');send({type:'erase',id:opId,epoch:world.epoch,...cursor});}
function resetComposition(){composing=false;compositionSession=null;compositionTail=null;input.value='';}
input.addEventListener('compositionstart',()=>{composing=true;compositionTail=null;compositionSession={epoch:world?.epoch,cancelled:false};});
input.addEventListener('compositionend',event=>{
  composing=false;const text=input.value||event.data||'';
  if(compositionSession&&!compositionSession.cancelled&&compositionSession.epoch===world?.epoch)write(text);
  else notice('입력 중 위치나 세계가 바뀌었습니다. 선택한 칸에서 다시 입력해 주세요.');
  compositionSession=null;input.value='';
  // Some engines emit a final input event after compositionend; consume that event once.
  compositionTail=text;
  setTimeout(()=>{compositionTail=null;},0);
});
input.addEventListener('beforeinput',event=>{
  if(composing||event.isComposing||!event.cancelable)return;
  if(event.inputType==='deleteContentBackward'||event.inputType==='deleteContentForward'){event.preventDefault();erase(event.inputType==='deleteContentBackward');}
});
input.addEventListener('input',event=>{
  if(composing||event.isComposing)return;
  if(compositionTail!==null&&(event.inputType==='insertCompositionText'||event.inputType==='insertFromComposition'||event.data===compositionTail)){input.value='';compositionTail=null;return;}
  if(event.inputType==='deleteContentBackward'){erase(true);input.value='';return;}
  if(event.inputType==='deleteContentForward'){erase(false);input.value='';return;}
  write(input.value);input.value='';
});
input.addEventListener('keydown',event=>{
  if(event.isComposing||composing||event.keyCode===229)return;
  if(!world||event.metaKey||event.ctrlKey||event.altKey)return;
  const delta={ArrowLeft:[-1,0],ArrowRight:[1,0],ArrowUp:[0,-1],ArrowDown:[0,1]}[event.key];
  if(delta){event.preventDefault();move(cursor.x+delta[0],cursor.y+delta[1]);}
  else if(event.key==='Enter'){event.preventDefault();move(cursor.x,cursor.y+1);}
  else if(event.key==='Backspace'||event.key==='Delete'){event.preventDefault();erase(event.key==='Backspace');}
});
input.addEventListener('paste',event=>{if(composing)return;event.preventDefault();write(event.clipboardData.getData('text/plain'));});
canvas.addEventListener('pointerdown',event=>{if(!world)return;drag={id:event.pointerId,x:event.clientX,y:event.clientY,startX:event.clientX,startY:event.clientY,moved:false};canvas.setPointerCapture(event.pointerId);});
canvas.addEventListener('pointermove',event=>{if(!drag||drag.id!==event.pointerId)return;const dx=event.clientX-drag.x,dy=event.clientY-drag.y;drag.moved ||= Math.hypot(event.clientX-drag.startX,event.clientY-drag.startY)>6;if(drag.moved){const d=dimensions();camera.x-=dx/d.width;camera.y-=dy/d.height;couplePan();}drag.x=event.clientX;drag.y=event.clientY;});
canvas.addEventListener('pointerup',event=>{if(!drag||drag.id!==event.pointerId)return;if(!drag.moved){const r=canvas.getBoundingClientRect(),d=dimensions();move(Math.floor(camera.x+(event.clientX-r.left)/d.width),Math.floor(camera.y+(event.clientY-r.top)/d.height));input.focus({preventScroll:true});}drag=null;});
canvas.addEventListener('pointercancel',()=>{drag=null;});
canvas.addEventListener('wheel',event=>{event.preventDefault();if(!world)return;if(event.ctrlKey||event.metaKey){setZoom(zoom*(event.deltaY>0?.9:1.1));return;}const d=dimensions(),factor=event.deltaMode===1?16:event.deltaMode===2?size.height:1;camera.x+=(event.shiftKey?event.deltaY:event.deltaX)*factor/d.width;camera.y+=(event.shiftKey?0:event.deltaY)*factor/d.height;couplePan();},{passive:false});
$('zoom-out').onclick=()=>setZoom(zoom-.2);$('zoom-in').onclick=()=>setZoom(zoom+.2);
$('help-toggle').onclick=()=>{const open=$('help').hidden;$('help').hidden=!open;$('help-toggle').setAttribute('aria-expanded',String(open));};
async function locate(initial=false) {
  if(!world)return;
  const request=++gpsRequest,revision=navigationRevision;
  if(!navigator.geolocation){notice('GPS를 사용할 수 없어 함께 만나는 기본 위치에서 시작합니다.');return;}
  notice('GPS 위치를 찾는 중입니다. 정확한 좌표는 브라우저 밖으로 보내지 않습니다.');
  navigator.geolocation.getCurrentPosition(result=>{
    if(request!==gpsRequest || (initial&&revision!==navigationRevision))return;
    const point=gpsToCell(result.coords.latitude,result.coords.longitude,world);
    move(point.x,point.y,{recenter:true,manual:false});notice('GPS에 해당하는 칸으로 이동했습니다. 크기 변경 후 착지점은 달라질 수 있습니다.');
  },()=>{if(request===gpsRequest)notice('GPS 권한 또는 위치를 얻지 못했습니다. 현재 자리에서도 자유롭게 쓸 수 있습니다.');},{enableHighAccuracy:false,timeout:8000,maximumAge:initial?60000:0});
}
$('gps').onclick=()=>locate();
$('share').onclick=async()=>{if(!world)return;const url=new URL(location.href);url.hash=new URLSearchParams(cursor).toString();try{await navigator.clipboard.writeText(url.href);notice('이곳의 링크를 복사했습니다. 친구에게 보내 함께 만나세요.');}catch{history.replaceState(null,'',url);notice('주소창에 이곳의 위치를 넣었습니다. 주소를 복사해 주세요.');}};
function connection(value) {connected=value;input.disabled=!value;$('connection').textContent=value?'실시간 연결':'재연결 중';$('connection-dot').classList.toggle('online',value);}
function connect() {
  socket=new WebSocket(`${location.protocol==='https:'?'wss':'ws'}://${location.host}/ws`);
  socket.onmessage=event=>{
    const message=JSON.parse(event.data);
    if(message.type==='snapshot'){
      const oldEpoch=world?.epoch,wasConnected=connected,previousCursor={...cursor};cancelMove();lastSentPosition=null;world=message.world;selfId=message.selfId;
      cells=new Map(message.cells.filter(c=>c.text).map(c=>[cellKey(c.x,c.y),c]));peers=message.peers;
      const me=peers.find(p=>p.id===selfId);cursor=me?{x:me.x,y:me.y}:{x:0,y:0};
      if(pending.size){notice('세계가 갱신됐습니다. 확정되지 않은 입력은 다시 확인해 주세요.');pending.clear();}
      resetComposition();connection(true);$('write-state').textContent='한 칸에 한 글자';
      $('extent').textContent=`${world.width} × ${world.height} · TORUS ${world.epoch}`;
      if(firstSnapshot){firstSnapshot=false;center();if(!goToHash())locate(true);}
      else if(oldEpoch!==world.epoch){center();notice(`세계의 크기가 ${world.width} × ${world.height}칸으로 바뀌었습니다.`);}
      else if(!wasConnected){move(previousCursor.x,previousCursor.y,{recenter:true,manual:false});notice('다시 연결했습니다. 최신 세계에서 이전 위치로 돌아왔습니다.');}
      keepCursorVisible();position();
    }else if(message.type==='cells'){
      if(message.epoch!==world?.epoch)return;
      for(const c of message.cells){if(c.text)cells.set(cellKey(c.x,c.y),c);else cells.delete(cellKey(c.x,c.y));}schedule();
    }else if(message.type==='presence'){peers=message.peers;schedule();}
    else if(message.type==='ack'){pending.delete(message.id);$('write-state').textContent=pending.size?'글자를 보내는 중':'모두에게 보입니다';}
    else if(message.type==='error'){pending.delete(message.id);if(message.code!=='STALE_EPOCH')send({type:'sync'});notice(`입력 미반영: ${message.message}`);$('write-state').textContent='입력을 확인해 주세요';}
    $('population').textContent=`${peers.length}명 접속`;
  };
  socket.onclose=()=>{cancelMove();connection(false);resetComposition();if(pending.size)notice('연결이 끊겼습니다. 전송 중이던 글자는 재접속 후 확인해 주세요.');else notice('연결이 끊겼습니다. 자동으로 다시 연결합니다.');pending.clear();clearTimeout(reconnectTimer);reconnectTimer=setTimeout(connect,1000);};
  socket.onerror=()=>socket.close();
}
function goToHash() {
  const params=new URLSearchParams(location.hash.slice(1)),x=Number(params.get('x')),y=Number(params.get('y'));
  if(world&&params.has('x')&&params.has('y')&&Number.isSafeInteger(x)&&Number.isSafeInteger(y)){move(x,y,{recenter:true});notice('공유된 위치에 도착했습니다.');return true;}return false;
}
window.addEventListener('hashchange',goToHash);
connect();
// Read-only diagnostics for repeatable browser verification; no mutation shortcut.
window.textworld={inspect:()=>({world,cursor:{...cursor},camera:{...camera},viewport:visible(),peers:structuredClone(peers),cells:[...cells.values()],connected,pending:pending.size,zoom})};
