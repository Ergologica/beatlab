/* BeatLab — runtime audio: playback live e render offline */
import { TRACKS, DRUMS, MELS, clamp, mulberry32, buildGraph, makeLaun, makeDrone,
         fireDrum, fireNote, duckAt, crushCurve, shaper } from './engine.js';
import { proj, divOf, audible, chainList, barDur, stepDur, stepTime } from './state.js';
import { $ } from './dom.js';

let A=null, playing=false, timer=null, booting=false;
let chainIdx=0, queuedUntil=0, queuedPatterns=[], playRng=mulberry32(1);
let schedState={openHat:null};

export const isPlaying = () => playing;
export const getA = () => A;
export const getQueued = () => queuedPatterns;

export function setCrush(N,bits){ N.crush.curve = crushCurve(N.ctx,bits).curve; }
export function setDrive(N,amt){ N.drive.curve = shaper(N.ctx,amt,0.15).curve; }
export function setSrDiv(N,d){ if(N.decim) N.decim.parameters.get('div').value=d; }

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
  const ctx = new (window.AudioContext||window.webkitAudioContext)();
  const N = await buildGraph(ctx, ctx.destination);
  N.persist.laun = makeLaun(ctx,N);
  N.persist.drone = makeDrone(ctx,N, 60+proj.root-24);
  applyMix(N);
  A={ctx,N};
  const dot=$('dot'), st=$('statustx');
  if(dot) dot.classList.add('live');
  if(st) st.textContent = 'audio attivo · '+Math.round(ctx.sampleRate/1000)+' kHz'
    +(N.decim?'':' · decimatore non disponibile');
  return A;
}

/* programma un pattern intero a partire da t0 */
function schedulePattern(ctx,N,pi,t0,st,rng){
  const p=proj.patterns[pi];
  const hT=proj.hum.t/100, hV=proj.hum.v/100;
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
    queuedUntil = ctx.currentTime+0.14; queuedPatterns=[];
    tick();
  } finally { booting=false; }
}
function tick(){
  if(!playing||!A) return;
  const {ctx,N}=A, horizon=ctx.currentTime+1.2;
  let guard=0;
  while(queuedUntil < horizon && guard++<32){
    const list = proj.song ? chainList() : [proj.cur];
    const pi = list[chainIdx % list.length];
    const t0 = queuedUntil;
    queuedPatterns.push({pi,t0,bars:proj.patterns[pi].bars});
    queuedUntil = schedulePattern(ctx,N,pi,t0,schedState,playRng);
    chainIdx++;
  }
  timer=setTimeout(tick,60);
}
export function stop(){
  playing=false; if(timer) clearTimeout(timer);
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

/* render offline: stesso scheduler, contesto OfflineAudioContext */
export async function renderBuffer(reps=1){
  const sr=44100;
  const one = proj.song ? chainList() : [proj.cur];
  const list=[]; for(let r=0;r<reps;r++) list.push(...one);
  let bars=0; for(const pi of list) bars += proj.patterns[pi].bars;
  const dur = bars*barDur() + 2.6;
  const ctx = new OfflineAudioContext(2, Math.ceil(sr*dur), sr);
  const N = await buildGraph(ctx, ctx.destination);
  N.persist.laun = makeLaun(ctx,N);
  N.persist.drone = makeDrone(ctx,N, 60+proj.root-24);
  applyMix(N);
  const st={openHat:null}, rng=mulberry32((proj.seed||1)+7);
  let t=0.05;
  for(const pi of list) t = schedulePattern(ctx,N,pi,t,st,rng);
  N.persist.laun.stop(t);
  N.persist.drone.set(t,false,1);
  return await ctx.startRendering();
}
