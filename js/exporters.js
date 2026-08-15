/* BeatLab — export: WAV, MP3 (LAME/lamejs, LGPL), MIDI, JSON */
import { DRUMS, MELS, NOTE_NAMES, clamp } from './engine.js';
import { proj, divOf, chainList, clearDirty } from './state.js';
import { $ } from './dom.js';

export function encodeWav(buf){
  const nCh=buf.numberOfChannels, n=buf.length, sr=buf.sampleRate;
  const data=new DataView(new ArrayBuffer(44+n*nCh*2));
  const w=(o,s)=>{for(let i=0;i<s.length;i++)data.setUint8(o+i,s.charCodeAt(i));};
  w(0,'RIFF'); data.setUint32(4,36+n*nCh*2,true); w(8,'WAVE'); w(12,'fmt ');
  data.setUint32(16,16,true); data.setUint16(20,1,true); data.setUint16(22,nCh,true);
  data.setUint32(24,sr,true); data.setUint32(28,sr*nCh*2,true);
  data.setUint16(32,nCh*2,true); data.setUint16(34,16,true); w(36,'data');
  data.setUint32(40,n*nCh*2,true);
  const chs=[]; for(let c=0;c<nCh;c++) chs.push(buf.getChannelData(c));
  let o=44;
  for(let i=0;i<n;i++) for(let c=0;c<nCh;c++){
    const s=clamp(chs[c][i],-1,1); data.setInt16(o,s<0?s*0x8000:s*0x7fff,true); o+=2; }
  return new Blob([data],{type:'audio/wav'});
}

/* MP3: encoder LAME (lamejs, LGPL — lame.sourceforge.net) caricato come file
   separato accanto alla app; in mancanza, dal CDN. */
function loadScript(src){
  return new Promise(res=>{
    const s=document.createElement('script');
    s.src=src; s.onload=()=>res(!!window.lamejs); s.onerror=()=>res(false);
    setTimeout(()=>res(!!window.lamejs), 15000);
    document.head.appendChild(s);
  });
}
export async function ensureLame(){
  if(window.lamejs) return true;
  if(await loadScript('lame.min.js')) return true;
  return await loadScript('https://cdnjs.cloudflare.com/ajax/libs/lamejs/1.2.0/lame.min.js');
}
export async function encodeMp3(buf, kbps=192, onProg){
  const enc=new lamejs.Mp3Encoder(2, buf.sampleRate, kbps);
  const l=buf.getChannelData(0), r=buf.numberOfChannels>1?buf.getChannelData(1):buf.getChannelData(0);
  const n=buf.length, block=1152, parts=[];
  const li=new Int16Array(block), ri=new Int16Array(block);
  for(let i=0;i<n;i+=block){
    const m=Math.min(block,n-i);
    for(let j=0;j<m;j++){ li[j]=clamp(l[i+j],-1,1)*32767; ri[j]=clamp(r[i+j],-1,1)*32767; }
    const d=enc.encodeBuffer(li.subarray(0,m), ri.subarray(0,m));
    if(d.length) parts.push(new Uint8Array(d));
    if((i/block)%400===0){ if(onProg) onProg(i/n); await new Promise(r2=>setTimeout(r2,0)); }
  }
  const end=enc.flush(); if(end.length) parts.push(new Uint8Array(end));
  return new Blob(parts,{type:'audio/mpeg'});
}

/* ---------- export MIDI (tipo 1, 480 PPQ — le terzine cadono esatte) ---------- */
export function midiBlob(reps=1){
  const PPQ=480, BAR=PPQ*4;
  const one = proj.song ? chainList() : [proj.cur];
  const list=[]; for(let r=0;r<reps;r++) list.push(...one);
  const vlq=(a,n)=>{ let b=n&0x7f; while(n>>=7){ b<<=8; b|=((n&0x7f)|0x80); }
    for(;;){ a.push(b&0xff); if(b&0x80) b>>=8; else break; } };
  const str=(a,s)=>{ for(let i=0;i<s.length;i++) a.push(s.charCodeAt(i)); };
  const chunk=(name,data)=>{ const o=[]; str(o,name);
    o.push((data.length>>24)&255,(data.length>>16)&255,(data.length>>8)&255,data.length&255);
    return o.concat(data); };
  const vel=v=>Math.round(clamp(v*100,1,127));

  const tracks=[];
  const tempo=Math.round(60000000/proj.bpm), c=[];
  vlq(c,0); c.push(0xFF,0x51,0x03,(tempo>>16)&255,(tempo>>8)&255,tempo&255);
  vlq(c,0); c.push(0xFF,0x58,0x04,4,2,24,8);
  vlq(c,0); c.push(0xFF,0x03,7); str(c,'BeatLab');
  vlq(c,0); c.push(0xFF,0x2F,0x00);
  tracks.push(chunk('MTrk',c));

  const mk=(name,ch,prog,events)=>{
    if(!events.length) return null;
    events.sort((a,b)=>a.tk-b.tk || a.k-b.k);
    const d=[]; vlq(d,0); d.push(0xFF,0x03,name.length); str(d,name);
    if(prog!=null){ vlq(d,0); d.push(0xC0|ch, prog); }
    let last=0;
    for(const e of events){ vlq(d, e.tk-last); last=e.tk;
      d.push((e.k?0x90:0x80)|ch, e.n, e.k? e.v : 0x40); }
    vlq(d,0); d.push(0xFF,0x2F,0x00);
    return chunk('MTrk',d);
  };
  const dev=[]; let off=0;
  for(const pi of list){ const p=proj.patterns[pi];
    for(const tr of DRUMS){
      const dv=divOf(p,tr.id), row=p.tr[tr.id];
      for(let i=0;i<p.bars*dv;i++){ const v=row[i]; if(!v) continue;
        const tk=off+Math.round(i*BAR/dv);
        dev.push({tk,k:1,n:tr.gm,v:vel(v)}); dev.push({tk:tk+60,k:0,n:tr.gm,v:0}); }
    }
    off += p.bars*BAR;
  }
  const dt=mk('Batteria',9,null,dev); if(dt) tracks.push(dt);
  for(const tr of MELS){
    const ev=[]; let o2=0;
    for(const pi of list){ const p=proj.patterns[pi];
      for(const nt of p.tr[tr.id]){ if(nt.s>=p.bars*16) continue;
        const tk=o2+nt.s*(BAR/16);
        ev.push({tk,k:1,n:nt.n,v:vel(nt.v||1)});
        ev.push({tk:tk+Math.max(nt.d*(BAR/16)-6,12),k:0,n:nt.n,v:0}); }
      o2 += p.bars*BAR;
    }
    const t=mk(tr.nm,tr.midich,tr.prog,ev); if(t) tracks.push(t);
  }
  const head=chunk('MThd',[0,1,0,tracks.length,(PPQ>>8)&255,PPQ&255]);
  const all=head.concat(...tracks);
  return new Blob([new Uint8Array(all)],{type:'audio/midi'});
}

export function fileStem(){
  const st=$('style');
  return 'beatlab-'+(st?st.value:'beat')+'-'+proj.bpm+'bpm-'+NOTE_NAMES[proj.root].toLowerCase();
}
export function download(blob,name){
  const u=URL.createObjectURL(blob), a=document.createElement('a');
  a.href=u; a.download=name; a.click(); setTimeout(()=>URL.revokeObjectURL(u),4000);
  clearDirty(); const el=$('savestate'); if(el) el.textContent='esportato';
}
