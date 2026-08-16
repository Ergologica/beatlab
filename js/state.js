/* BeatLab — stato del progetto, undo/redo, autosave, formato beatlab/2 */
import { TRACKS, DRUMS, MELS, SCALES, NOTE_NAMES, clamp, suggestLight } from './engine.js';
import { $ } from './dom.js';

export const DIVS=[8,12,16,24];

export function emptyPattern(bars){
  const p={bars, len:bars*16, tr:{}, div:{}, drone:false, seed:0};
  for(const t of TRACKS){
    if(t.type==='drum'){ p.div[t.id] = (t.id==='tumb')?12:16;
      p.tr[t.id]=new Array(bars*p.div[t.id]).fill(0); }
    else p.tr[t.id]=[];
  }
  return p;
}

export const proj = {
  bpm:100, swing:14, root:2, scale:'dorian',
  hum:{t:35, v:30},
  patterns:[emptyPattern(2),emptyPattern(2),emptyPattern(2),emptyPattern(2)],
  cur:0, chain:'AABA', song:false, seed:0,
  mix:Object.fromEntries(TRACKS.map(t=>[t.id,{g:0.85,pan:0,mute:false,solo:false}])),
  fx:{bits:13, srDiv:1, drive:1.6, revS:0.85, revL:0.85, duck:3.5, bassDuck:0.45, master:0.9},
  leadWave:'sawtooth', gtrPm:true,
  /* modo leggero: acceso da solo su telefoni e macchine modeste */
  light: suggestLight()
};
proj.mix.kick.g=1.0; proj.mix.bass.g=0.95; proj.mix.laun.g=0.8;
proj.mix.tumb.g=0.95; proj.mix.ten.g=0.6; proj.mix.guitar.g=0.7;
proj.mix.tumb.pan=-0.35; proj.mix.hhc.pan=0.18; proj.mix.rim.pan=-0.25;

/* la UI registra qui il proprio refresh, così evitiamo import circolari */
export const hooks = { refresh: ()=>{} };

export const P = () => proj.patterns[proj.cur];
export const divOf = (p,id) => p.div[id]||16;
export const rootMidiFor = tr => 60 + proj.root + (tr.oct||0)*12;
export function scaleRows(tr, octs=2){
  const sc=SCALES[proj.scale], base=rootMidiFor(tr), out=[];
  for(let o=0;o<octs;o++) for(const s of sc) out.push(base+o*12+s);
  out.push(base+octs*12);
  return out;
}
export const barDur = () => 4*60/proj.bpm;
export const stepDur = () => barDur()/16;
export function stepTime(t0, i, div){
  let t = t0 + (i/div)*barDur();
  if(div===16 && i%2===1) t += (proj.swing/100)*(barDur()/16)*0.66;
  return t;
}
export function audible(id){
  const anySolo = TRACKS.some(t=>proj.mix[t.id].solo);
  const m=proj.mix[id];
  return anySolo ? m.solo : !m.mute;
}
export function chainList(){
  const c=(proj.chain||'A').toUpperCase().replace(/[^A-D]/g,'');
  return (c||'A').split('').map(ch=>ch.charCodeAt(0)-65);
}

/* ---------- undo / redo ---------- */
const HIST={u:[],r:[],max:60};
const snap = () => JSON.stringify({p:proj.patterns, c:proj.cur});
export function pushUndo(){
  HIST.u.push(snap()); if(HIST.u.length>HIST.max) HIST.u.shift();
  HIST.r.length=0; markDirty();
}
function applySnap(s){
  const o=JSON.parse(s); proj.patterns=o.p; proj.cur=o.c;
  hooks.refresh(); markDirty();
}
export function undo(){ if(!HIST.u.length) return false;
  HIST.r.push(snap()); applySnap(HIST.u.pop()); return true; }
export function redo(){ if(!HIST.r.length) return false;
  HIST.u.push(snap()); applySnap(HIST.r.pop()); return true; }
export const histSizes = () => ({u:HIST.u.length, r:HIST.r.length});

/* ---------- salvataggio automatico ---------- */
let dirty=false, saveTimer=null;
function store(k,v){ try{ localStorage.setItem(k,v); return true; }catch(e){ return false; } }
function loadKey(k){ try{ return localStorage.getItem(k); }catch(e){ return null; } }
export function markDirty(){
  dirty=true; clearTimeout(saveTimer);
  saveTimer=setTimeout(()=>{
    const ok=store('beatlab.autosave', JSON.stringify(toJSON(true)));
    const el=$('savestate');
    if(el) el.textContent = ok? 'salvato nel browser' : 'salvataggio non disponibile';
  }, 1200);
}
export function clearDirty(){ dirty=false; }
export function isDirty(){ return dirty; }
export function loadAutosave(){ return loadKey('beatlab.autosave'); }
export function dropAutosave(){ try{ localStorage.removeItem('beatlab.autosave'); }catch(e){} }
window.addEventListener('beforeunload', e=>{
  if(!dirty) return;
  e.preventDefault(); e.returnValue='';
});

/* ---------- formato beatlab/2 (legge anche /1) ---------- */
export function toJSON(full=false){
  const j={
    format:'beatlab/2', app:'BeatLab', bpm:proj.bpm, swing:proj.swing/100,
    stepsPerBar:16, humanize:{time:proj.hum.t/100, velocity:proj.hum.v/100},
    root:proj.root, rootName:NOTE_NAMES[proj.root], scale:proj.scale, seed:proj.seed,
    chain: proj.song ? proj.chain.toUpperCase() : String.fromCharCode(65+proj.cur),
    patterns: proj.patterns.map((p,i)=>({
      name:String.fromCharCode(65+i), bars:p.bars, len:p.bars*16,
      drone:p.drone, droneNote:60+proj.root-24, seed:p.seed||0,
      div:Object.fromEntries(DRUMS.map(t=>[t.id,divOf(p,t.id)])),
      drums:Object.fromEntries(DRUMS.map(t=>[t.id,p.tr[t.id].map(v=>+(v||0).toFixed(2))])),
      notes:Object.fromEntries(MELS.map(t=>[t.id,p.tr[t.id].map(n=>({s:n.s,n:n.n,d:n.d,v:+(n.v||1).toFixed(2)}))]))
    })),
    mixer:Object.fromEntries(TRACKS.map(t=>[t.id,{gain:+proj.mix[t.id].g.toFixed(3),
      pan:+proj.mix[t.id].pan.toFixed(2), mute:proj.mix[t.id].mute, solo:proj.mix[t.id].solo,
      reverb:t.rev, bus:t.bus}])),
    fx:{bits:proj.fx.bits, srDiv:proj.fx.srDiv, drive:proj.fx.drive,
        reverbShort:proj.fx.revS, reverbLong:proj.fx.revL,
        sidechainDb:proj.fx.duck, bassDuck:proj.fx.bassDuck, master:proj.fx.master},
    synth:{leadWave:proj.leadWave, guitarPalmMute:proj.gtrPm}
  };
  if(full) j.ui={cur:proj.cur, song:proj.song, chain:proj.chain, light:proj.light};
  return j;
}
export function fromJSON(j){
  proj.bpm=j.bpm||100; proj.swing=Math.round((j.swing||0)*100);
  proj.root=j.root??2; proj.scale=j.scale||'dorian'; proj.seed=j.seed||0;
  if(j.humanize){ proj.hum.t=Math.round((j.humanize.time||0)*100);
                  proj.hum.v=Math.round((j.humanize.velocity||0)*100); }
  proj.chain=(j.ui&&j.ui.chain)||j.chain||'A';
  proj.patterns=(j.patterns||[]).slice(0,4).map(p=>{
    const bars = p.bars || Math.max(Math.round((p.len||32)/16),1);
    const q=emptyPattern(bars); q.drone=!!p.drone; q.seed=p.seed||0;
    for(const t of DRUMS){
      const d = (p.div && p.div[t.id]) || 16;
      q.div[t.id]=d;
      const src=(p.drums&&p.drums[t.id])||[];
      const arr=new Array(bars*d).fill(0);
      for(let i=0;i<Math.min(src.length,arr.length);i++) arr[i]=src[i]||0;
      q.tr[t.id]=arr;
    }
    for(const t of MELS) if(p.notes&&p.notes[t.id])
      q.tr[t.id]=p.notes[t.id].filter(n=>n.s<bars*16).map(n=>({s:n.s,n:n.n,d:n.d||1,v:n.v||1}));
    return q;
  });
  while(proj.patterns.length<4) proj.patterns.push(emptyPattern(2));
  if(j.mixer) for(const t of TRACKS) if(j.mixer[t.id]){
    proj.mix[t.id].g=j.mixer[t.id].gain; proj.mix[t.id].pan=j.mixer[t.id].pan;
    proj.mix[t.id].mute=!!j.mixer[t.id].mute; proj.mix[t.id].solo=!!j.mixer[t.id].solo; }
  if(j.fx){ const f=j.fx;
    proj.fx.bits=f.bits??13; proj.fx.srDiv=f.srDiv??1; proj.fx.drive=f.drive??1.6;
    proj.fx.revS=f.reverbShort??0.85; proj.fx.revL=f.reverbLong??0.85;
    proj.fx.duck=f.sidechainDb??3.5; proj.fx.bassDuck=f.bassDuck??0.45; proj.fx.master=f.master??0.9; }
  if(j.synth){ proj.leadWave=j.synth.leadWave||'sawtooth'; proj.gtrPm=j.synth.guitarPalmMute!==false; }
  if(j.ui){ proj.cur=clamp(j.ui.cur|0,0,3); proj.song=!!j.ui.song;
            if(typeof j.ui.light==='boolean') proj.light=j.ui.light; }
}
