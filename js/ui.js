/* BeatLab — interfaccia */
import { NOTE_NAMES, DRUMS, MELS, TID, clamp } from './engine.js';
import { proj, P, DIVS, emptyPattern, divOf, scaleRows, barDur, audible,
         pushUndo, undo, redo, histSizes, markDirty, clearDirty,
         loadAutosave, dropAutosave, toJSON, fromJSON, hooks } from './state.js';
import { isPlaying, getA, getQueued, play, stop, applyMix, resetAudio, outLatency,
         setCrush, setDrive, setSrDiv, renderBuffer, renderStems, preview } from './audio.js';
import { generate, variation } from './generator.js';
import { encodeWav, ensureLame, encodeMp3, midiBlob, makeZip, fileStem, download } from './exporters.js';
import { shareLink, loadFromHash, clearHash, copyLink } from './share.js';
import { $, toast } from './dom.js';

/* Larghezza di una battuta. Col dito le celle devono essere più larghe: sotto i
   30 px circa si sbaglia bersaglio, e la griglia scorre comunque in orizzontale
   con la colonna dei nomi che resta ferma. */
const isNarrow = () => window.innerWidth <= 900;
const barWidth = () => isNarrow() ? 544 : 416;
const cellW = div => (barWidth()/div)-2;
let melSel='bass';
const BRUSHES={ hit:{nm:'Colpo',v:0.9,c:'var(--on)'}, acc:{nm:'Accento',v:1.25,c:'var(--acc)'},
  gh:{nm:'Ghost',v:0.42,c:'var(--ghost)'}, era:{nm:'Gomma',v:0,c:'#39424f'} };
let brush='hit';
let paint=null;
let audioPreview=true;          // audizione mentre si disegna

function velOf(e){
  if(e.shiftKey) return 1.25;
  if(e.altKey) return 0.42;
  return BRUSHES[brush].v;
}
function paintClass(c,v){
  c.classList.remove('on','acc','gh');
  if(v>0){ c.classList.add('on'); if(v>=1.1)c.classList.add('acc'); else if(v<=0.5)c.classList.add('gh'); }
}

/* ---------- griglia di batteria ---------- */
function buildDrumGrid(){
  const p=P(), g=$('drumgrid'); g.innerHTML='';
  for(const t of DRUMS){
    const d=divOf(p,t.id), n=p.bars*d, w=cellW(d);
    const row=document.createElement('div'); row.className='grow';
    const lab=document.createElement('div'); lab.className='glabel';
    const nm=document.createElement('span'); nm.className='nm';
    nm.textContent = isNarrow() ? (t.nmS||t.nm) : t.nm;   // sul telefono il nome è abbreviato
    const ds=document.createElement('select');
    ds.className = (d===12||d===24)?'tri':'';
    ds.title='suddivisione per battuta (12 e 24 = terzine)';
    for(const v of DIVS){ const o=document.createElement('option');
      o.value=v; o.textContent=v; if(v===d)o.selected=true; ds.appendChild(o); }
    ds.onchange=()=>{ pushUndo(); setDivision(t.id,+ds.value); };
    const mb=document.createElement('button'); mb.className='mini'+(proj.mix[t.id].mute?' act':''); mb.textContent='M';
    const sb=document.createElement('button'); sb.className='mini solo'+(proj.mix[t.id].solo?' act':''); sb.textContent='S';
    mb.onclick=()=>{proj.mix[t.id].mute=!proj.mix[t.id].mute; if(getA())applyMix(getA().N); buildDrumGrid(); buildMixer();};
    sb.onclick=()=>{proj.mix[t.id].solo=!proj.mix[t.id].solo; if(getA())applyMix(getA().N); buildDrumGrid(); buildMixer();};
    lab.append(nm,ds,mb,sb);
    const cells=document.createElement('div'); cells.className='cells';
    const beat=Math.max(Math.round(d/4),1);
    for(let i=0;i<n;i++){
      const c=document.createElement('div');
      c.className='cell'+(i%beat===0?' beat':'')+(i%d===0&&i>0?' bar':'');
      c.style.width=w+'px';
      c.dataset.grid='d'; c.dataset.tr=t.id; c.dataset.i=i;
      paintClass(c, p.tr[t.id][i]);
      cells.appendChild(c);
    }
    row.append(lab,cells); g.appendChild(row);
  }
  const ph=$('playhead'); ph.innerHTML=''; lastStep=-2;
  const sp=document.createElement('div'); sp.className='phspacer'; ph.appendChild(sp);
  for(let i=0;i<p.bars*16;i++){ const d=document.createElement('div');
    d.className='ph'; d.style.width=cellW(16)+'px'; ph.appendChild(d); }
}
function setDivision(id, d){
  const p=P(), old=divOf(p,id), a=p.tr[id], nb=new Array(p.bars*d).fill(0);
  for(let i=0;i<a.length;i++){ if(!a[i]) continue;
    const j=Math.round(i*d/old); if(j<nb.length) nb[j]=Math.max(nb[j],a[i]); }
  p.div[id]=d; p.tr[id]=nb; buildDrumGrid();
}

/* ---------- griglia melodica ---------- */
function buildNoteGrid(){
  const p=P(), t=TID[melSel], len=p.bars*16, w=cellW(16);
  const rows=scaleRows(t,2).slice().reverse();
  const g=$('notegrid'); g.innerHTML='';
  const occ={}; for(const n of p.tr[melSel]) for(let k=0;k<n.d;k++)
    occ[n.n+':'+(n.s+k)] = (k===0? n.v||1 : -1);
  for(const m of rows){
    const row=document.createElement('div'); row.className='grow'+(((m-proj.root)%12+12)%12===0?' root':'');
    const lab=document.createElement('div'); lab.className='glabel';
    lab.textContent=NOTE_NAMES[((m%12)+12)%12]+(Math.floor(m/12)-1);
    const cells=document.createElement('div'); cells.className='cells';
    for(let i=0;i<len;i++){
      const c=document.createElement('div');
      c.className='cell'+(i%4===0?' beat':'')+(i%16===0&&i>0?' bar':'');
      c.style.width=w+'px';
      c.dataset.grid='n'; c.dataset.n=m; c.dataset.i=i;
      const st=occ[m+':'+i];
      if(st===-1) c.classList.add('on','tail');
      else if(st!=null) paintClass(c,st);
      cells.appendChild(c);
    }
    row.append(lab,cells); g.appendChild(row);
  }
}
function noteAt(m,i){ return P().tr[melSel].findIndex(n=>n.n===m && i>=n.s && i<n.s+n.d); }
function addNote(m,i,v){
  const arr=P().tr[melSel];
  if(TID[melSel].mono) for(let k=arr.length-1;k>=0;k--)
    if(i>=arr[k].s && i<arr[k].s+arr[k].d) arr.splice(k,1);
  if(noteAt(m,i)<0){ arr.push({s:i,n:m,d:1,v}); arr.sort((a,b)=>a.s-b.s); return true; }
  return false;
}
function delNote(m,i){
  const arr=P().tr[melSel], k=noteAt(m,i);
  if(k<0) return false; arr.splice(k,1); return true;
}

/* ---------- pittura: mouse e touch insieme ---------- */
function onDown(e){
  const c=e.target.closest?e.target.closest('.cell'):null;
  if(!c) return;
  e.preventDefault();
  pushUndo();
  const v=velOf(e), erase = (brush==='era' && !e.shiftKey && !e.altKey);
  if(c.dataset.grid==='d'){
    const id=c.dataset.tr, i=+c.dataset.i, cur=P().tr[id][i];
    let tv = erase ? 0 : (Math.abs(cur-v)<0.01 ? 0 : v);
    paint={grid:'d', v:tv};
    applyPaint(c);
  } else {
    const m=+c.dataset.n, i=+c.dataset.i, k=noteAt(m,i);
    if(e.shiftKey && k>=0){                    // shift = cambia durata
      const cyc=[1,2,3,4,6,8], arr=P().tr[melSel];
      arr[k].d = cyc[(cyc.indexOf(arr[k].d)+1)%cyc.length];
      paint=null; buildNoteGrid(); buildTabs(); markDirty(); return;
    }
    const del = erase || k>=0;
    paint={grid:'n', v, del};
    applyPaint(c);
  }
}
function applyPaint(c){
  if(!paint || c.dataset.grid!==paint.grid) return;
  if(paint.grid==='d'){
    const id=c.dataset.tr, i=+c.dataset.i;
    if(P().tr[id][i]===paint.v) return;
    P().tr[id][i]=paint.v; paintClass(c,paint.v);
    if(paint.v>0 && audioPreview) preview(id,{v:paint.v});
  } else {
    const m=+c.dataset.n, i=+c.dataset.i;
    const changed = paint.del ? delNote(m,i) : addNote(m,i,paint.v);
    if(changed){
      buildNoteGrid(); buildTabs();
      if(!paint.del && audioPreview) preview(melSel,{n:m, v:paint.v, dur:stepDurSec()*1.5});
    }
  }
  markDirty();
}
const stepDurSec = () => barDur()/16;
document.addEventListener('pointerdown', onDown);
document.addEventListener('pointermove', e=>{
  if(!paint) return;
  const el=document.elementFromPoint(e.clientX,e.clientY);
  if(el && el.classList.contains('cell')) applyPaint(el);
});
for(const ev of ['pointerup','pointercancel','pointerleave'])
  document.addEventListener(ev, ()=>{ paint=null; });

/* ---------- pannelli ---------- */
function buildBrush(){
  const b=$('brush'); b.innerHTML='';
  for(const k of ['hit','acc','gh','era']){
    const d=document.createElement('button');
    d.className='bb'+(brush===k?' sel':'');
    d.innerHTML='<span class="sw" style="background:'+BRUSHES[k].c+'"></span>'+BRUSHES[k].nm;
    d.onclick=()=>{ brush=k; buildBrush(); };
    b.appendChild(d);
  }
  const ap=document.createElement('button');
  ap.className='bb'+(audioPreview?' sel':'');
  ap.title='Fa sentire il suono mentre disegni, anche a trasporto fermo';
  ap.textContent = audioPreview ? '🔊 Ascolto' : '🔇 Ascolto';
  ap.onclick=()=>{ audioPreview=!audioPreview; buildBrush(); };
  b.appendChild(ap);
}
function buildTabs(){
  const tb=$('meltabs'); tb.innerHTML='';
  for(const t of MELS){
    const b=document.createElement('div'); b.className='tab'+(melSel===t.id?' sel':'');
    const n=P().tr[t.id].length;
    b.textContent=t.nm+(n?' ·'+n:'');
    b.onclick=()=>{melSel=t.id; buildTabs(); buildNoteGrid(); buildMelOpts();};
    tb.appendChild(b);
  }
}
function buildMelOpts(){
  const o=$('melopts'); o.innerHTML='';
  const dr=document.createElement('button');
  dr.className='btn sm'+(P().drone?' on':''); dr.textContent='Bordone tumbu: '+(P().drone?'ON':'off');
  dr.onclick=()=>{ pushUndo(); P().drone=!P().drone; buildMelOpts();
    const a=getA();
    if(a&&a.N.persist.drone) a.N.persist.drone.set(a.ctx.currentTime,P().drone,1); };
  o.appendChild(dr);
  if(melSel==='lead'){
    const w=document.createElement('div'); w.className='field';
    w.innerHTML='<label>onda lead</label>';
    const s=document.createElement('select');
    for(const v of ['sawtooth','square','triangle','sine','pulse']){
      const op=document.createElement('option'); op.value=v; op.textContent=v;
      if(v===proj.leadWave)op.selected=true; s.appendChild(op); }
    s.onchange=()=>{proj.leadWave=s.value; markDirty();}; w.appendChild(s); o.appendChild(w);
  }
  if(melSel==='guitar'){
    const b=document.createElement('button'); b.className='btn sm'+(proj.gtrPm?' on':'');
    b.textContent='Palm mute: '+(proj.gtrPm?'ON':'off');
    b.onclick=()=>{proj.gtrPm=!proj.gtrPm; buildMelOpts(); markDirty();}; o.appendChild(b);
  }
  const cl=document.createElement('button'); cl.className='btn sm';
  cl.textContent='Svuota '+TID[melSel].nm;
  cl.onclick=()=>{ pushUndo(); P().tr[melSel]=[]; buildNoteGrid(); buildTabs(); };
  o.appendChild(cl);
  const hint={bass:'Basso saturo con filtro a inviluppo.',
    guitar:'Power chord (fondamentale + quinta + ottava), distorsione asimmetrica e cabinet.',
    lead:'Synth lead a due oscillatori scordati con vibrato.',
    laun:'Monofonica e legata: l\'articolazione è un calo d\'ampiezza, non un silenzio. Due canne (mancosa manna + mancosedda una quinta sopra).',
    ten:'Bassu/contra: raddoppio di periodo per il gutturale + filtri di formante.'}[melSel];
  $('melhint').textContent='trascina per disegnare · shift+click su una nota = cambia durata · '+hint;
}
function buildMixer(){
  const mx=$('mixer'); mx.innerHTML='';
  for(const t of TRACKS_ALL){
    const m=proj.mix[t.id];
    const d=document.createElement('div'); d.className='ctl';
    d.innerHTML='<div class="t"><b>'+t.nm+'</b><span>'+Math.round(m.g*100)+'</span></div>';
    const gs=document.createElement('input'); gs.type='range'; gs.min=0; gs.max=140; gs.value=m.g*100;
    gs.oninput=()=>{ m.g=gs.value/100; d.querySelector('.t span').textContent=gs.value;
      const a=getA(); if(a) a.N.tr[t.id].g.gain.value = audible(t.id)?m.g:0; markDirty(); };
    const pl=document.createElement('div'); pl.className='t'; pl.innerHTML='<span>pan</span>';
    const ps=document.createElement('input'); ps.type='range'; ps.min=-100; ps.max=100; ps.value=m.pan*100;
    ps.oninput=()=>{ m.pan=ps.value/100; const a=getA(); if(a) a.N.tr[t.id].p.pan.value=m.pan; markDirty(); };
    const btns=document.createElement('div'); btns.style.cssText='display:flex;gap:5px;margin-top:6px';
    const mb=document.createElement('button'); mb.className='mini'+(m.mute?' act':''); mb.textContent='M';
    const sb=document.createElement('button'); sb.className='mini solo'+(m.solo?' act':''); sb.textContent='S';
    mb.onclick=()=>{m.mute=!m.mute; const a=getA(); if(a)applyMix(a.N); buildMixer(); buildDrumGrid();};
    sb.onclick=()=>{m.solo=!m.solo; const a=getA(); if(a)applyMix(a.N); buildMixer(); buildDrumGrid();};
    btns.append(mb,sb);
    d.append(gs,pl,ps,btns); mx.appendChild(d);
  }
}
import { TRACKS as TRACKS_ALL } from './engine.js';
function buildFx(){
  const f=$('fx'); f.innerHTML='';
  const items=[
    ['bits','Bitcrush batteria',4,16,1,v=>v+' bit',v=>{proj.fx.bits=v; const a=getA(); if(a)setCrush(a.N,v);}],
    ['srDiv','Riduzione sample rate',1,16,1,v=>v===1?'off':'÷'+v,v=>{proj.fx.srDiv=v; const a=getA(); if(a)setSrDiv(a.N,v);}],
    ['drive','Saturazione batteria',10,60,1,v=>(v/10).toFixed(1),v=>{proj.fx.drive=v/10; const a=getA(); if(a)setDrive(a.N,v/10);}],
    ['revS','Riverbero corto',0,100,1,v=>v+'%',v=>{proj.fx.revS=v/100; const a=getA(); if(a)a.N.revSG.gain.value=v/100;}],
    ['revL','Riverbero lungo',0,100,1,v=>v+'%',v=>{proj.fx.revL=v/100; const a=getA(); if(a)a.N.revLG.gain.value=v/100;}],
    ['duck','Sidechain sulla cassa',0,12,1,v=>v+' dB',v=>{proj.fx.duck=v;}],
    ['bassDuck','Sidechain basso',0,100,1,v=>v+'%',v=>{proj.fx.bassDuck=v/100;}],
    ['master','Master',0,120,1,v=>v+'%',v=>{proj.fx.master=v/100; const a=getA(); if(a)a.N.master.gain.value=v/100;}],
  ];
  const cur={bits:proj.fx.bits, srDiv:proj.fx.srDiv, drive:proj.fx.drive*10,
    revS:proj.fx.revS*100, revL:proj.fx.revL*100, duck:proj.fx.duck,
    bassDuck:proj.fx.bassDuck*100, master:proj.fx.master*100};
  for(const [k,nm,mn,mx2,st,fmt,set] of items){
    const d=document.createElement('div'); d.className='ctl';
    d.innerHTML='<div class="t"><b>'+nm+'</b><span>'+fmt(cur[k])+'</span></div>';
    const s=document.createElement('input'); s.type='range'; s.min=mn; s.max=mx2; s.step=st; s.value=cur[k];
    s.oninput=()=>{ d.querySelector('.t span').textContent=fmt(+s.value); set(+s.value); markDirty(); };
    d.appendChild(s); f.appendChild(d);
  }
}
function buildSlots(){
  const s=$('slots'); s.innerHTML='';
  for(let i=0;i<4;i++){
    const b=document.createElement('button');
    b.className='slot'+(proj.cur===i?' sel':'');
    b.innerHTML=String.fromCharCode(65+i)+'<i>'+proj.patterns[i].bars+'</i>';
    b.onclick=()=>{ proj.cur=i; refresh(); };
    s.appendChild(b);
  }
}
function refresh(){
  buildSlots(); buildDrumGrid(); buildTabs(); buildMelOpts(); buildNoteGrid();
  $('bars').value=P().bars; $('seed').value=P().seed||'';
  const h=histSizes();
  $('undo').disabled=!h.u; $('redo').disabled=!h.r;
}
hooks.refresh = refresh;

/* ---------- playhead ----------
   si ridisegna solo quando il passo cambia: toccare centinaia di celle a ogni
   fotogramma ruba tempo al thread principale, e sui telefoni si sente */
let lastStep=-2, lastSlot=-2;
function drawPlayhead(step){
  if(step===lastStep) return;
  const ph=$('playhead').children;         // [0] è lo spaziatore fisso dei nomi
  if(lastStep>=0 && ph[lastStep+1]) ph[lastStep+1].classList.remove('a');
  if(step>=0 && ph[step+1]) ph[step+1].classList.add('a');
  lastStep=step;
}
function raf(){
  requestAnimationFrame(raf);
  const a=getA();
  if(!isPlaying()||!a){ return; }
  /* l'uscita audio ha una sua latenza: senza compensarla la testina va avanti */
  const now=a.ctx.currentTime - outLatency(), bd=barDur(), qp=getQueued();
  while(qp.length>1 && qp[0].t0 + qp[0].bars*bd < now) qp.shift();
  const q=qp.find(x=> now>=x.t0 && now < x.t0+x.bars*bd);
  if(!q){ drawPlayhead(-1); return; }
  drawPlayhead(q.pi===proj.cur ? Math.floor((now-q.t0)/(bd/16)) : -1);
  if(q.pi!==lastSlot){
    const slots=$('slots').children;
    for(let i=0;i<slots.length;i++) slots[i].classList.toggle('playing', i===q.pi);
    lastSlot=q.pi;
  }
}
raf();

/* ---------- sezioni ----------
   Su schermo stretto se ne mostra una alla volta, con la barra in basso: cinque
   destinazioni, etichette corte, bersagli alti 56 px nella zona del pollice.
   Su computer le sezioni restano tutte visibili e la barra sparisce. */
const SECTIONS = [
  {id:'ritmo',   ic:'🥁', nm:'Ritmo'},
  {id:'melodia', ic:'🎹', nm:'Melodia'},
  {id:'mix',     ic:'🎚', nm:'Mix'},
  {id:'brano',   ic:'✦',  nm:'Brano'},
  {id:'esporta', ic:'↓',  nm:'Esporta'},
];
let curSec = 'ritmo';
function showSection(id){
  curSec = id;
  for(const s of document.querySelectorAll('main>section'))
    s.classList.toggle('on', s.dataset.sec===id);
  for(const b of $('tabbar').children) b.classList.toggle('on', b.dataset.sec===id);
  try{ localStorage.setItem('beatlab.sec', id); }catch(e){}
  window.scrollTo({top:0});
}
function buildTabbar(){
  const bar=$('tabbar'); bar.innerHTML='';
  for(const s of SECTIONS){
    const b=document.createElement('button');
    b.dataset.sec=s.id;
    b.innerHTML='<i>'+s.ic+'</i>'+s.nm;
    b.setAttribute('aria-label', s.nm);
    b.onclick=()=>showSection(s.id);
    bar.appendChild(b);
  }
}
/* cambiando larghezza cambiano le celle: le griglie vanno ricostruite */
let lastNarrow=isNarrow(), resizeTimer=null;
window.addEventListener('resize', ()=>{
  clearTimeout(resizeTimer);
  resizeTimer=setTimeout(()=>{
    if(isNarrow()!==lastNarrow){ lastNarrow=isNarrow(); refresh(); }
  }, 180);
});

/* ---------- avvio ---------- */
function syncLight(){
  const b=$('lightmode');
  b.classList.toggle('on', proj.light);
  b.textContent = proj.light ? 'Modo leggero: ON' : 'Modo leggero: off';
}
function syncControls(){
  syncLight();
  $('bpm').value=proj.bpm; $('swing').value=proj.swing;
  $('humt').value=proj.hum.t; $('humv').value=proj.hum.v;
  $('root').value=proj.root; $('scale').value=proj.scale; $('chain').value=proj.chain;
  $('songmode').textContent='Song: '+(proj.song?'ON':'off');
  $('songmode').classList.toggle('on',proj.song);
}

(function init(){
  const rs=$('root');
  for(let i=0;i<12;i++){ const o=document.createElement('option');
    o.value=i; o.textContent=NOTE_NAMES[i]; if(i===proj.root)o.selected=true; rs.appendChild(o); }

  $('play').onclick=async()=>{
    if(isPlaying()){ stop(); drawPlayhead(-1); $('play').textContent='▶ Play'; }
    else { $('play').textContent='❚❚ Pausa'; await play();
           if(!isPlaying()) $('play').textContent='▶ Play'; }
  };
  $('stop').onclick=()=>{ stop(); drawPlayhead(-1); $('play').textContent='▶ Play'; };
  $('bpm').oninput=e=>{proj.bpm=clamp(+e.target.value||100,40,240); markDirty();};
  $('swing').oninput=e=>{proj.swing=+e.target.value; markDirty();};
  $('humt').oninput=e=>{proj.hum.t=+e.target.value; markDirty();};
  $('humv').oninput=e=>{proj.hum.v=+e.target.value; markDirty();};
  $('bars').onchange=e=>{
    pushUndo();
    const p=P(), nb=+e.target.value;
    for(const t of DRUMS){ const d=divOf(p,t.id), a=p.tr[t.id].slice(0,nb*d);
      while(a.length<nb*d) a.push(0); p.tr[t.id]=a; }
    for(const t of MELS) p.tr[t.id]=p.tr[t.id].filter(n=>n.s<nb*16);
    p.bars=nb; p.len=nb*16; refresh();
  };
  $('root').onchange=e=>{proj.root=+e.target.value; refresh(); markDirty();};
  $('scale').onchange=e=>{proj.scale=e.target.value; refresh(); markDirty();};
  $('chain').oninput=e=>{proj.chain=e.target.value.toUpperCase(); markDirty();};
  $('songmode').onclick=e=>{ proj.song=!proj.song;
    e.target.textContent='Song: '+(proj.song?'ON':'off');
    e.target.classList.toggle('on',proj.song); markDirty(); };
  $('gen').onclick=()=>{ pushUndo(); generate($('style').value); refresh(); };
  $('regen').onclick=()=>{ pushUndo();
    generate($('style').value, proj.cur, parseInt($('seed').value,10)||P().seed||1); refresh(); };
  $('seed').onchange=()=>{ const s=parseInt($('seed').value,10);
    if(!isNaN(s)){ pushUndo(); generate($('style').value, proj.cur, s); refresh(); } };
  $('vary').onclick=variation;
  $('genall').onclick=()=>{ pushUndo(); const s=$('style').value;
    for(let i=0;i<4;i++) generate(i===3?'ethno':s, i); proj.cur=0; refresh(); };
  $('clear').onclick=()=>{ pushUndo(); proj.patterns[proj.cur]=emptyPattern(P().bars); refresh(); };
  $('copy').onclick=()=>{ pushUndo(); const n=(proj.cur+1)%4;
    proj.patterns[n]=JSON.parse(JSON.stringify(P())); proj.cur=n; refresh(); };
  $('lightmode').onclick=()=>{
    proj.light=!proj.light; syncLight(); markDirty();
    resetAudio();          // il grafo va ricostruito: cambiano riverberi e voci
    toast(proj.light ? 'Modo leggero acceso: meno oscillatori, riverberi più semplici.'
                     : 'Modo pieno: tutte le voci e i riverberi a convoluzione.');
  };
  $('undo').onclick=()=>{ if(!undo()) toast('Niente da annullare'); };
  $('redo').onclick=()=>{ if(!redo()) toast('Niente da rifare'); };

  $('expjson').onclick=()=>download(new Blob([JSON.stringify(toJSON(),null,1)],
    {type:'application/json'}), fileStem()+'.json');
  $('expmidi').onclick=()=>download(midiBlob(+$('reps').value), fileStem()+'.mid');
  $('expwav').onclick=async()=>{
    const b=$('expwav'); b.textContent='rendering…'; b.disabled=true;
    try{ download(encodeWav(await renderBuffer(+$('reps').value)), fileStem()+'.wav'); }
    catch(err){ toast('Errore nel render: '+err.message); }
    b.textContent='↓ WAV'; b.disabled=false;
  };
  $('expmp3').onclick=async()=>{
    const b=$('expmp3'); b.disabled=true;
    try{
      b.textContent='rendering…';
      const buf=await renderBuffer(+$('reps').value);
      b.textContent='encoder…';
      if(await ensureLame()){
        download(await encodeMp3(buf,192,p=>{ b.textContent='mp3 '+Math.round(p*100)+'%'; }),
                 fileStem()+'.mp3');
      } else {
        download(encodeWav(buf), fileStem()+'.wav');
        toast('Encoder MP3 non trovato: tieni lame.min.js accanto alla app. Scaricato il WAV.');
      }
    } catch(err){ toast('Errore nel render: '+err.message); }
    b.textContent='↓ MP3'; b.disabled=false;
  };
  $('expstems').onclick=async()=>{
    const b=$('expstems'); b.disabled=true;
    try{
      const stems=await renderStems(+$('reps').value,
        (nm,k,tot)=>{ b.textContent='stem '+(k+1)+'/'+tot+' '+nm; });
      if(!stems.length){ toast('Non c\'è niente da esportare: il pattern è vuoto.'); }
      else{
        b.textContent='zip…';
        const files=[];
        for(let i=0;i<stems.length;i++){
          const wav=encodeWav(stems[i].buf);
          const nm=String(i+1).padStart(2,'0')+'-'+stems[i].id+'.wav';
          files.push({name:nm, data:new Uint8Array(await wav.arrayBuffer())});
        }
        download(makeZip(files), fileStem()+'-stems.zip');
        toast(stems.length+' stem esportati. La somma degli stem ricostruisce il mix.');
      }
    } catch(err){ toast('Errore negli stem: '+err.message); }
    b.textContent='↓ Stem'; b.disabled=false;
  };
  $('impjson').onclick=()=>$('file').click();
  $('file').onchange=e=>{ const f=e.target.files[0]; if(!f)return;
    const r=new FileReader();
    r.onload=()=>{ try{ pushUndo(); fromJSON(JSON.parse(r.result)); syncControls(); refresh();
        buildMixer(); buildFx(); toast('Caricato '+f.name); }
      catch(err){ toast('JSON non valido: '+err.message); } };
    r.readAsText(f); e.target.value=''; };

  buildTabbar();
  let sec='ritmo';
  try{ const s=localStorage.getItem('beatlab.sec');
       if(s && SECTIONS.some(x=>x.id===s)) sec=s; }catch(e){}
  showSection(sec);

  document.addEventListener('keydown',e=>{
    const tag=e.target.tagName;
    if(tag==='INPUT'||tag==='SELECT'||tag==='TEXTAREA') return;
    const mod=e.ctrlKey||e.metaKey;
    if(mod && e.key.toLowerCase()==='z'){ e.preventDefault();
      if(e.shiftKey){ if(!redo()) toast('Niente da rifare'); }
      else if(!undo()) toast('Niente da annullare');
      return; }
    if(mod && e.key.toLowerCase()==='y'){ e.preventDefault(); if(!redo()) toast('Niente da rifare'); return; }
    if(e.code==='Space'){ e.preventDefault(); $('play').click(); return; }
    if(e.key>='1'&&e.key<='4'){ proj.cur=+e.key-1; refresh(); }
    if(e.key==='q') { brush='hit'; buildBrush(); }
    if(e.key==='w') { brush='acc'; buildBrush(); }
    if(e.key==='e') { brush='gh'; buildBrush(); }
    if(e.key==='r') { brush='era'; buildBrush(); }
  });

  $('share').onclick=async()=>{
    const b=$('share'); b.disabled=true; b.textContent='…';
    try{
      const url=await shareLink();
      const ok=await copyLink(url);
      const kb=(url.length/1024).toFixed(1);
      if(ok) toast('Link copiato ('+kb+' kB). Contiene tutto il progetto: chi lo apre se lo trova già caricato.');
      else { prompt('Copia il link:', url); }
    }catch(err){ toast('Non riesco a creare il link: '+err.message); }
    b.textContent='🔗 Condividi'; b.disabled=false;
  };

  /* un progetto nell'indirizzo ha la precedenza sulla sessione salvata */
  (async ()=>{
    let from=null;
    if(await loadFromHash()) from='link';
    else {
      const saved=loadAutosave();
      if(saved){ try{ fromJSON(JSON.parse(saved)); from='sessione'; }catch(e){} }
    }
    if(!from) generate('breakbeat',0);
    syncControls(); buildBrush(); refresh(); buildMixer(); buildFx();
    clearDirty();
    $('savestate').textContent = from==='link' ? 'caricato dal link'
                              : from==='sessione' ? 'sessione ripristinata' : 'nuova sessione';
    if(from==='link'){
      clearHash();
      toast('Progetto caricato dal link. Modificalo pure: resta solo tuo finché non lo ricondividi.');
    } else if(from==='sessione'){
      toast('Ho ripristinato la sessione precedente.','Ricomincia da capo',()=>{
        dropAutosave(); location.reload();
      });
    }
  })();
})();
