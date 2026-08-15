/* BeatLab — generatore di pattern (seminato: stesso seed = stesso pattern) e variazione */
import { SCALES, TID, mulberry32, clamp } from './engine.js';
import { proj, P, emptyPattern, divOf, rootMidiFor, scaleRows, pushUndo, hooks } from './state.js';
import { toast } from './dom.js';

let GR = mulberry32(1);
const ch=p=>GR()<p, pick=a=>a[Math.floor(GR()*a.length)];

const PROGS = {
  dorian:[[0,0,10,7],[0,0,3,7],[0,10,0,7],[0,3,10,7]],
  minor:[[0,0,8,10],[0,5,8,10],[0,10,8,7]],
  phrygian:[[0,1,0,10],[0,0,1,10]],
  minorpent:[[0,0,10,7],[0,10,0,5]],
  major:[[0,5,7,7],[0,9,5,7],[0,7,9,5]],
  harmminor:[[0,0,8,7],[0,5,8,7]]
};
function chordProg(bars){
  const p=pick(PROGS[proj.scale]||PROGS.dorian), out=[];
  for(let i=0;i<bars;i++) out.push(p[i%p.length]);
  return out;
}
function nearestScale(m, base){
  const sc=SCALES[proj.scale]; let best=m, bd=99;
  for(let o=-2;o<=3;o++) for(const s of sc){ const c=base+o*12+s;
    if(Math.abs(c-m)<bd){bd=Math.abs(c-m); best=c;} }
  return best;
}
export function newSeed(){ return (Math.random()*1e9)|0; }

export function generate(style, pi=proj.cur, seed=null){
  const bars = proj.patterns[pi] ? proj.patterns[pi].bars : 2;
  const s = (seed==null) ? newSeed() : (seed|0);
  GR = mulberry32(s||1);
  const p = emptyPattern(bars); p.seed=s; proj.patterns[pi]=p;
  const prog = chordProg(bars);
  const tumbTri = (style==='ethno'||style==='breakbeat');
  p.div.tumb = tumbTri?12:16;
  p.tr.tumb = new Array(bars*p.div.tumb).fill(0);
  const put=(id,i,v)=>{ const a=p.tr[id]; if(i>=0&&i<a.length) a[i]=Math.max(a[i]||0,v); };

  for(let b=0;b<bars;b++){
    const o=b*16, ot=b*p.div.tumb, last=(b===bars-1);
    if(style==='boombap'){
      put('kick',o,1.0); put('kick',o+10,0.95); if(ch(.5))put('kick',o+11,0.6);
      put('snare',o+4,1.0); put('snare',o+12,1.0);
      if(ch(.6))put('snare',o+7,0.4); if(ch(.4))put('snare',o+14,0.38);
      for(let i=0;i<16;i+=2) put('hhc',o+i, i%4===0?0.9:0.62);
      if(ch(.5))put('hho',o+14,0.7);
      if(last&&ch(.6)){put('tom',o+13,0.8);put('tom',o+15,0.9);}
    } else if(style==='breakbeat'){
      put('kick',o,1.0); put('kick',o+3,0.55); put('kick',o+10,0.95);
      if(ch(.5))put('kick',o+6,0.5);
      put('snare',o+4,1.0); put('snare',o+12,1.0);
      put('snare',o+7,0.35); if(ch(.6))put('snare',o+11,0.32); if(ch(.5))put('snare',o+15,0.4);
      for(let i=0;i<16;i++){ if(i%2===0) put('hhc',o+i, i%4===0?0.9:0.6);
        else if(ch(.35)) put('hhc',o+i,0.35); }
      if(ch(.55))put('hho',o+10,0.6);
      if(last&&ch(.5)){put('tom',o+14,0.8);put('tom',o+15,0.95);}
    } else if(style==='dbeat'){
      put('kick',o,1.0); put('kick',o+6,0.9); put('kick',o+8,1.0); put('kick',o+14,0.9);
      put('snare',o+4,1.0); put('snare',o+12,1.0);
      for(let i=0;i<16;i+=2) put('hhc',o+i,0.75);
      put('hho',o+2,0.55); put('hho',o+10,0.55);
      if(last){ put('tom',o+13,0.9); put('tom',o+14,0.9); put('snare',o+15,1.0); }
    } else if(style==='ethno'){
      put('kick',o,0.95); if(ch(.6))put('kick',o+11,0.7);
      put('snare',o+8,0.7);
      if(ch(.5))put('rim',o+6,0.5); if(ch(.5))put('rim',o+14,0.45);
      for(let i=0;i<16;i+=4) if(ch(.4)) put('hhc',o+i,0.4);
    } else if(style==='trap'){
      put('kick',o,1.0); put('kick',o+7,0.85); put('kick',o+10,0.8); if(ch(.5))put('kick',o+13,0.6);
      put('clap',o+4,1.0); put('clap',o+12,1.0);
      for(let i=0;i<16;i++) put('hhc',o+i, i%4===0?0.85:0.5);
      if(ch(.6)){ put('hhc',o+6,0.7); put('hhc',o+7,0.7); }
      if(ch(.4))put('hho',o+15,0.6);
    }
    // tumbarinu
    if(tumbTri){
      // rullo in 12/8; in ethno il ciclo di accenti dura 9 unità e va contro la
      // battuta, ricomponendosi ogni 3 battute (come in "Tumbu")
      const loose = (style==='ethno');
      for(let i=0;i<p.div.tumb;i++){
        const g=b*p.div.tumb+i;
        const acc = loose ? (g%9===0) : (i%3===0);
        put('tumb', ot+i, acc?1.0:(i%3===0?0.6:0.42));
      }
    } else if(ch(.3)){
      for(let i=0;i<16;i+=4) if(ch(.5)) put('tumb',o+i,0.5);
    }
  }
  // ---- melodie ----
  const baseB=rootMidiFor(TID.bass);
  for(let b=0;b<bars;b++){
    const o=b*16, r=baseB+prog[b];
    if(style==='trap'){
      p.tr.bass.push({s:o,n:r,d:8,v:1}); p.tr.bass.push({s:o+10,n:r,d:6,v:0.9});
    } else if(style==='dbeat'){
      for(let i=0;i<16;i+=2) p.tr.bass.push({s:o+i,n:r,d:2,v:i%4===0?1:0.8});
    } else {
      p.tr.bass.push({s:o,n:r,d:3,v:1});
      p.tr.bass.push({s:o+6,n:r,d:2,v:0.8});
      if(ch(.7)) p.tr.bass.push({s:o+10,n:nearestScale(r+(ch(.5)?7:5),baseB),d:2,v:0.85});
      if(ch(.5)) p.tr.bass.push({s:o+14,n:r,d:2,v:0.7});
    }
  }
  if(style==='dbeat'||(style==='breakbeat'&&ch(.45))){
    const baseG=rootMidiFor(TID.guitar);
    for(let b=0;b<bars;b++){ const o=b*16, r=baseG+prog[b];
      for(let i=0;i<16;i+=2) p.tr.guitar.push({s:o+i,n:r,d:2,v:i%8===0?1:0.85}); }
  }
  if(style==='ethno'||style==='breakbeat'||ch(.3)){
    const rows=scaleRows(TID.laun,2), baseL=rootMidiFor(TID.laun);
    let s2=0, idx=2, len=bars*16;
    while(s2<len){
      const d=pick([2,2,3,4,4,6]);
      idx=clamp(idx+pick([-2,-1,-1,0,1,1,2,3]),0,rows.length-3);
      let n=rows[idx];
      if(s2%16===0) n=nearestScale(baseL+prog[Math.floor(s2/16)%bars]+(ch(.5)?0:7),baseL);
      p.tr.laun.push({s:s2,n,d:Math.min(d,len-s2),v:s2%16===0?1:0.85});
      s2+=d;
    }
  }
  if(style==='ethno'||ch(.25)){
    const baseT=rootMidiFor(TID.ten);
    for(let b=0;b<bars;b++) p.tr.ten.push({s:b*16,n:baseT+prog[b],d:16,v:0.9});
  }
  if(style==='boombap'||style==='trap'||ch(.25)){
    const rows=scaleRows(TID.lead,2); let idx=4;
    for(let b=0;b<bars;b++){ const o=b*16;
      for(const h of pick([[0,6,10],[0,4,8,12],[2,6,12],[0,3,6,10,13]])){
        idx=clamp(idx+pick([-3,-2,-1,0,1,2,3]),0,rows.length-1);
        p.tr.lead.push({s:o+h,n:rows[idx],d:pick([1,2,2,3]),v:0.85}); }
    }
  }
  p.drone = (style==='ethno') || (style==='breakbeat'&&ch(.6));
  return p;
}

/* variazione: copia il pattern nello slot successivo e lo sposta di poco */
export function variation(){
  const src=P(), dst=(proj.cur+1)%4;
  pushUndo();
  const p=JSON.parse(JSON.stringify(src));
  p.seed=newSeed(); GR=mulberry32(p.seed||1);
  const bars=p.bars;
  for(const id of ['hhc','tumb']){
    const a=p.tr[id], d=divOf(p,id);
    for(let i=0;i<a.length;i++){
      if(a[i] && a[i]<0.7 && ch(.25)) a[i]=0;
      else if(!a[i] && ch(.10)) a[i]=0.35;
    }
    if(d===16) for(let i=1;i<a.length;i+=2) if(!a[i]&&ch(.12)) a[i]=0.32;
  }
  const K=p.tr.kick, hits=[]; K.forEach((v,i)=>{ if(v&&i%4!==0) hits.push(i); });
  if(hits.length&&ch(.7)){ const i=pick(hits), j=i+(ch(.5)?1:-1);
    if(j>0&&j<K.length&&!K[j]){ K[j]=K[i]; K[i]=0; } }
  if(ch(.5)){ const free=[]; K.forEach((v,i)=>{ if(!v&&i%2===0) free.push(i); });
    if(free.length) K[pick(free)]=0.6; }
  if(ch(.75)){
    const o=(bars-1)*16;
    if(ch(.5)){ for(const [i,v] of [[12,0.7],[13,0.8],[14,0.9],[15,1.0]]) p.tr.tom[o+i]=v; }
    else { for(const [i,v] of [[13,0.5],[14,0.75],[15,1.0]]) p.tr.snare[o+i]=v;
           if(ch(.5)) p.tr.snare[o+12]=0.4; }
    p.tr.hhc[o+15]=0; if(ch(.6)) p.tr.hho[o+15]=0.7;
  }
  for(const id of ['lead','laun','bass']){
    const a=p.tr[id]; if(!a.length) continue;
    const base=rootMidiFor(TID[id]);
    for(const n of a) if(ch(id==='bass'?0.12:0.3)) n.n=nearestScale(n.n+pick([-2,-1,1,2]),base);
    if(ch(.3)) a.splice(Math.floor(GR()*a.length),1);
  }
  if(ch(.35)) p.drone=!p.drone;
  proj.patterns[dst]=p; proj.cur=dst;
  hooks.refresh();
  toast('Variazione nello slot '+String.fromCharCode(65+dst));
}
