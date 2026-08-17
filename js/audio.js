/* BeatLab — runtime audio: playback live e render offline.

   L'orologio dello scheduler vive in un Web Worker: i timer della pagina
   vengono rallentati dai browser quando la scheda perde il fuoco (sui telefoni
   in modo aggressivo), e un timer in ritardo significa audio a buchi. */
import { TRACKS, TID, DRUMS, MELS, clamp, mulberry32, buildGraph, makeLaun, makeDrone,
         fireDrum, fireNote, duckAt, crushCurve, shaper, routeDecim,
         setLight, isLight, suggestLight } from './engine.js';
import { proj, divOf, audible, chainList, barDur, stepDur, stepTime } from './state.js';
import { $ } from './dom.js';

let A=null, playing=false, booting=false;
let chainIdx=0, queuedUntil=0, queuedPatterns=[], playRng=mulberry32(1);
let schedState={openHat:null};

export const isPlaying = () => playing;
export const getA = () => A;
export const getQueued = () => queuedPatterns;
export const outLatency = () => A ? (A.ctx.outputLatency || A.ctx.baseLatency || 0) : 0;

/* ---------- orologio: worker, con i timer della pagina come ripiego ---------- */
const CLOCK_SRC = `let id=null;onmessage=e=>{if(e.data==='start'){if(!id)id=setInterval(()=>postMessage(0),50)}else{clearInterval(id);id=null}};`;
let clockWorker=null, clockTimer=null;
function startClock(fn){
  stopClock();
  if(!clockWorker){
    try{ clockWorker=new Worker(URL.createObjectURL(new Blob([CLOCK_SRC],{type:'application/javascript'}))); }
    catch(e){ clockWorker=null; }
  }
  if(clockWorker){ clockWorker.onmessage=fn; clockWorker.postMessage('start'); }
  else { const loop=()=>{ fn(); clockTimer=setTimeout(loop,50); }; loop(); }
}
function stopClock(){
  if(clockWorker) clockWorker.postMessage('stop');
  if(clockTimer){ clearTimeout(clockTimer); clockTimer=null; }
}

export function setCrush(N,bits){ N.crush.curve = crushCurve(N.ctx,bits).curve; }
export function setDrive(N,amt){ N.drive.curve = shaper(N.ctx,amt,0.15).curve; }
export function setSrDiv(N,d){
  routeDecim(N, d>1);
  if(N.decim) N.decim.parameters.get('div').value=Math.max(d,1);
}

export function applyMix(N){
  for(const t of TRACKS){
    const m=proj.mix[t.id];
    N.tr[t.id].g.gain.value = audible(t.id) ? m.g : 0;
    N.tr[t.id].p.pan.value = m.pan;
  }
  N.master.gain.value = proj.fx.master;
  N.revSG.gain.value = proj.fx.revS;
  N.revLG.gain.value = proj.fx.revL;
  setCrush(N,proj.fx.bits); setDrive(N,proj.fx.drive); setSrDiv(N,proj.fx.srDiv);
}

async function initAudio(){
  if(A) return A;
  setLight(proj.light);
  /* un buffer più generoso: meglio 120 ms di latenza che un audio a scatti */
  let ctx;
  try{ ctx = new (window.AudioContext||window.webkitAudioContext)({latencyHint: proj.light?0.2:0.05}); }
  catch(e){ ctx = new (window.AudioContext||window.webkitAudioContext)(); }
  const N = await buildGraph(ctx, ctx.destination);
  applyMix(N);
  A={ctx,N};
  const dot=$('dot'), st=$('statustx');
  if(dot) dot.classList.add('live');
  if(st) st.textContent = 'audio attivo · '+Math.round(ctx.sampleRate/1000)+' kHz'
    + (isLight()?' · modo leggero':'');
  return A;
}
/* il grafo va ricostruito quando cambia il modo leggero */
export function resetAudio(){
  const wasPlaying = playing;
  stop();
  setTimeout(()=>{ if(wasPlaying) play(); }, 400);
}

/* programma un pattern intero a partire da t0 */
function schedulePattern(ctx,N,pi,t0,st,rng){
  const p=proj.patterns[pi];
  const hT=proj.hum.t/100, hV=proj.hum.v/100;
  /* anche il bordone nasce alla prima richiesta */
  if(p.drone && !N.persist.drone) N.persist.drone = makeDrone(ctx,N, 60+proj.root-24);
  if(N.persist.drone){
    N.persist.drone.setNote(t0, 60+proj.root-24);
    N.persist.drone.set(t0, p.drone, 1);
  }
  const evs=[];
  for(const tr of DRUMS){
    const d=divOf(p,tr.id), row=p.tr[tr.id];
    for(let i=0;i<p.bars*d;i++){
      const v=row[i]; if(!v) continue;
      evs.push({id:tr.id, t:stepTime(t0,i,d), v});
    }
  }
  evs.sort((a,b)=>a.t-b.t);
  for(const e of evs){
    const t = e.t + (rng()-0.5)*0.012*hT;
    const v = clamp(e.v*(1+(rng()-0.5)*0.34*hV), 0.05, 1.6);
    if(e.id==='kick') duckAt(N,t,proj.fx.duck,proj.fx.bassDuck);
    if(audible(e.id)) fireDrum(ctx,N,e.id,t,v,st);
  }
  for(const tr of MELS){
    if(!audible(tr.id)) continue;
    for(const nt of p.tr[tr.id]){
      if(nt.s>=p.bars*16) continue;
      const t=stepTime(t0,nt.s,16) + (rng()-0.5)*0.010*hT;
      const dur=nt.d*stepDur()*0.98;
      const v=clamp((nt.v||1)*(1+(rng()-0.5)*0.28*hV),0.05,1.5);
      const par = tr.id==='lead' ? {wave:proj.leadWave} : tr.id==='guitar' ? {pm:proj.gtrPm} : {};
      fireNote(ctx,N,tr.id,t,nt.n,dur,v,par);
    }
  }
  return t0 + p.bars*barDur();
}

export async function play(){
  if(playing||booting) return;
  booting=true;
  try{
    const {ctx}=await initAudio();
    if(ctx.state==='suspended') await ctx.resume();
    playing=true; chainIdx=0; schedState={openHat:null};
    playRng=mulberry32((proj.seed||1)+7);
    queuedUntil = ctx.currentTime+0.18; queuedPatterns=[];
    tick();
    startClock(tick);
  } finally { booting=false; }
}
/* orizzonte largo: se la scheda viene rallentata, c'è margine prima del buco */
function tick(){
  if(!playing||!A) return;
  const {ctx,N}=A, horizon=ctx.currentTime+2.0;
  let guard=0;
  while(queuedUntil < horizon && guard++<32){
    const list = proj.song ? chainList() : [proj.cur];
    const pi = list[chainIdx % list.length];
    const t0 = queuedUntil;
    queuedPatterns.push({pi,t0,bars:proj.patterns[pi].bars});
    queuedUntil = schedulePattern(ctx,N,pi,t0,schedState,playRng);
    chainIdx++;
  }
}
export function stop(){
  playing=false; stopClock();
  if(A){ const {ctx,N}=A, t=ctx.currentTime;
    if(N.persist.laun) N.persist.laun.stop(t);
    if(N.persist.drone) N.persist.drone.set(t,false,1);
    const dead=A;
    setTimeout(()=>{ if(!playing && A===dead){ try{A.ctx.close();}catch(e){} A=null;
      const dot=$('dot'), st=$('statustx');
      if(dot) dot.classList.remove('live');
      if(st) st.textContent='audio in pausa'; } },320);
  }
  queuedPatterns=[];
}

/* Stem: una passata di render per ogni traccia in solo. Il sidechain della
   cassa agisce anche sugli stem degli altri strumenti (l'evento parte pur con
   la cassa muta), così la somma degli stem ricostruisce il mix. */
export async function renderStems(reps=1, onProg){
  const used=[...new Set(proj.song ? chainList() : [proj.cur])];
  const hasContent = id => used.some(pi=>{
    const a=proj.patterns[pi].tr[id];
    return TID[id].type==='drum' ? a.some(x=>x>0) : a.length>0;
  });
  const ids = TRACKS.filter(t=>hasContent(t.id)).map(t=>t.id);
  const hasDrone = used.some(pi=>proj.patterns[pi].drone);
  const total = ids.length + (hasDrone?1:0);
  const saved = JSON.parse(JSON.stringify(proj.mix));
  const out=[];
  try{
    for(let k=0;k<ids.length;k++){
      const id=ids[k];
      if(onProg) onProg(TID[id].nm, k, total);
      for(const t of TRACKS){ proj.mix[t.id].solo=(t.id===id); proj.mix[t.id].mute=false; }
      out.push({id, nm:TID[id].nm, buf:await renderBuffer(reps)});
    }
    if(hasDrone){
      if(onProg) onProg('Bordone', ids.length, total);
      for(const t of TRACKS){ proj.mix[t.id].solo=false; proj.mix[t.id].mute=true; }
      out.push({id:'drone', nm:'Bordone tumbu', buf:await renderBuffer(reps)});
    }
  } finally {
    for(const t of TRACKS) Object.assign(proj.mix[t.id], saved[t.id]);
  }
  return out;
}

/* Render offline: stesso scheduler, contesto OfflineAudioContext.
   Qui il tempo reale non conta, quindi si esporta sempre a qualità piena —
   anche se si sta suonando in modo leggero su un telefono. */
export async function renderBuffer(reps=1){
  const wasLight = isLight();
  setLight(false);
  try { return await renderInner(reps); }
  finally { setLight(wasLight); }
}
async function renderInner(reps){
  const sr=44100;
  const one = proj.song ? chainList() : [proj.cur];
  const list=[]; for(let r=0;r<reps;r++) list.push(...one);
  let bars=0; for(const pi of list) bars += proj.patterns[pi].bars;
  const dur = bars*barDur() + 2.6;
  const ctx = new OfflineAudioContext(2, Math.ceil(sr*dur), sr);
  const N = await buildGraph(ctx, ctx.destination);
  applyMix(N);
  const st={openHat:null}, rng=mulberry32((proj.seed||1)+7);
  let t=0.05;
  for(const pi of list) t = schedulePattern(ctx,N,pi,t,st,rng);
  if(N.persist.laun) N.persist.laun.stop(t);
  if(N.persist.drone) N.persist.drone.set(t,false,1);
  return await ctx.startRendering();
}
