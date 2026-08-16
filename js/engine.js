/* BeatLab — motore di sintesi (Web Audio API).
   Nessun sample: ogni suono è generato da oscillatori e rumore.

   Nota sulle prestazioni: le catene fisse (filtri, cabinet, formanti,
   distorsioni) sono costruite una volta sola e condivise da tutte le note.
   Ogni voce crea solo gli oscillatori e il proprio inviluppo, e vive esattamente
   quanto dura il suono. In "modo leggero" i riverberi a convoluzione lasciano il
   posto a una rete di ritardi, e le voci usano meno oscillatori. */

export const mtof = m => 440 * Math.pow(2, (m - 69) / 12);
export const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
export const NOTE_NAMES = ['DO','DO#','RE','RE#','MI','FA','FA#','SOL','SOL#','LA','LA#','SI'];
export const SCALES = {
  dorian:[0,2,3,5,7,9,10], minor:[0,2,3,5,7,8,10], phrygian:[0,1,3,5,7,8,10],
  minorpent:[0,3,5,7,10], major:[0,2,4,5,7,9,11], harmminor:[0,2,3,5,7,8,11]
};

/* PRNG seminato: stessa sequenza = stesso pattern */
export function mulberry32(a){ return function(){
  a|=0; a=a+0x6D2B79F5|0;
  let t=Math.imul(a^a>>>15,1|a); t=t+Math.imul(t^t>>>7,61|t)^t;
  return ((t^t>>>14)>>>0)/4294967296; }; }

/* manopole di taratura: usate dai test per allineare il timbro alle voci
   create sul momento, che partivano tutte in fase */
export const TUNE = { tumbModes: 1.0, tumbBuzz: 4.0 };

/* ---------- modo leggero ---------- */
let LIGHT = false;
export const isLight = () => LIGHT;
export function setLight(v){ LIGHT = !!v; }
export function suggestLight(){
  try{
    const cores = navigator.hardwareConcurrency || 2;
    const coarse = window.matchMedia && matchMedia('(pointer:coarse)').matches;
    return cores <= 4 || !!coarse;
  }catch(e){ return false; }
}

/* ---------- tracce ---------- */
export const TRACKS = [
  {id:'kick',  nm:'Cassa',     type:'drum', bus:'drum', rev:0.05, gm:36},
  {id:'snare', nm:'Rullante',  type:'drum', bus:'drum', rev:0.22, gm:38},
  {id:'clap',  nm:'Clap',      type:'drum', bus:'drum', rev:0.28, gm:39},
  {id:'hhc',   nm:'HH chiuso', type:'drum', bus:'drum', rev:0.06, gm:42},
  {id:'hho',   nm:'HH aperto', type:'drum', bus:'drum', rev:0.14, gm:46},
  {id:'tom',   nm:'Tom',       type:'drum', bus:'drum', rev:0.18, gm:45},
  {id:'rim',   nm:'Rim/perc',  type:'drum', bus:'drum', rev:0.20, gm:37},
  {id:'tumb',  nm:'Tumbarinu', type:'drum', bus:'drum', rev:0.26, gm:41},
  {id:'bass',  nm:'Basso',     type:'note', bus:'bassduck', rev:0.02, oct:-2, prog:38, midich:0},
  {id:'guitar',nm:'Chitarra',  type:'note', bus:'duck', rev:0.12, oct:-1, prog:30, midich:1},
  {id:'lead',  nm:'Lead',      type:'note', bus:'duck', rev:0.22, oct:0,  prog:81, midich:2},
  {id:'laun',  nm:'Launeddas', type:'note', bus:'duck', rev:0.30, oct:0,  prog:68, midich:3, mono:true},
  {id:'ten',   nm:'Tenore',    type:'note', bus:'duck', rev:0.34, oct:-1, prog:52, midich:4},
];
export const TID = Object.fromEntries(TRACKS.map(t=>[t.id,t]));
export const DRUMS = TRACKS.filter(t=>t.type==='drum');
export const MELS  = TRACKS.filter(t=>t.type==='note');

/* ---------- sorgenti di base ---------- */
function noiseBuf(ctx){
  if(ctx.__noise) return ctx.__noise;
  const n = Math.floor(ctx.sampleRate*2), b = ctx.createBuffer(1,n,ctx.sampleRate), d=b.getChannelData(0);
  let s=12345; for(let i=0;i<n;i++){ s=(s*1103515245+12345)&0x7fffffff; d[i]=(s/0x3fffffff)-1; }
  return ctx.__noise=b;
}
function noise(ctx){ const s=ctx.createBufferSource(); s.buffer=noiseBuf(ctx); s.loop=true;
  s.playbackRate.value=0.85+Math.random()*0.3; return s; }

function pulseWave(ctx, nH=26, tilt=1.0){
  const key='__pw'+nH+'_'+tilt;
  if(ctx[key]) return ctx[key];
  const re=new Float32Array(nH+1), im=new Float32Array(nH+1);
  for(let h=1;h<=nH;h++){ im[h] = (h%2===1) ? 1/Math.pow(h,tilt) : 0.06/Math.pow(h,tilt+1); }
  return ctx[key]=ctx.createPeriodicWave(re,im,{disableNormalization:false});
}

/* le curve dei waveshaper costano 2048 tanh: calcolate una volta e riusate */
const CURVES = new Map();
function shaperCurve(amount, asym){
  const k = amount+'|'+asym;
  let c = CURVES.get(k);
  if(!c){
    const n=2048; c=new Float32Array(n);
    for(let i=0;i<n;i++){ const x=i*2/n-1, xa=x+asym*x*x*0.4;
      c[i]=Math.tanh(amount*xa)/Math.tanh(amount); }
    CURVES.set(k,c);
  }
  return c;
}
export function shaper(ctx, amount, asym=0, over){
  const w=ctx.createWaveShaper();
  w.curve=shaperCurve(amount,asym);
  w.oversample = over || (LIGHT?'none':'2x');
  return w;
}
export function crushCurve(ctx, bits){
  const n=4096, c=new Float32Array(n), lv=Math.pow(2,bits-1);
  for(let i=0;i<n;i++){ const x=i*2/n-1; c[i]=Math.round(x*lv)/lv; }
  const w=ctx.createWaveShaper(); w.curve=c; return w;
}
function impulse(ctx, dur, decay, bright){
  const sr=ctx.sampleRate, n=Math.floor(sr*dur), b=ctx.createBuffer(2,n,sr);
  for(let ch=0; ch<2; ch++){ const d=b.getChannelData(ch); let lp=0;
    for(let i=0;i<n;i++){ const t=i/n; const e=Math.pow(1-t, decay);
      const w=(Math.random()*2-1)*e; lp += (w-lp)*bright; d[i]=lp*(i<40?i/40:1); } }
  return b;
}
/* riverbero: convoluzione se c'è potenza, rete di ritardi se no */
function makeVerb(ctx, dur, decay, bright){
  if(!LIGHT){
    const c=ctx.createConvolver(); c.buffer=impulse(ctx,dur,decay,bright);
    return {in:c, out:c};
  }
  const long = dur>1;
  const input=ctx.createGain(), out=ctx.createGain();
  const times = long ? [0.0431,0.0567,0.0783,0.1013] : [0.0117,0.0193,0.0271,0.0353];
  const fb = long ? 0.70 : 0.45;
  for(let i=0;i<times.length;i++){
    const d=ctx.createDelay(0.2); d.delayTime.value=times[i];
    const g=ctx.createGain(); g.gain.value=fb;
    const lp=ctx.createBiquadFilter(); lp.type='lowpass'; lp.frequency.value= long?3000:5400;
    const pan=ctx.createStereoPanner(); pan.pan.value = (i%2? 0.65 : -0.65);
    input.connect(d); d.connect(lp); lp.connect(g); g.connect(d);
    lp.connect(pan); pan.connect(out);
  }
  return {in:input, out};
}

function adsr(p, t, a, d, s, peak){
  p.cancelScheduledValues(t); p.setValueAtTime(0.0001, t);
  p.linearRampToValueAtTime(peak, t+a);
  p.exponentialRampToValueAtTime(Math.max(peak*s,0.0001), t+a+d);
}
function decayTo0(p, t, peak, dur, a=0.002){
  p.cancelScheduledValues(t); p.setValueAtTime(0.0001, t);
  p.linearRampToValueAtTime(peak, t+a);
  p.exponentialRampToValueAtTime(0.0001, t+a+dur);
}
/* come sopra, ma per una voce riusata: prima una dissolvenza di 0,8 ms, così
   ribattere sulla stessa voce non produce un clic */
function reDecay(p, t, peak, dur, a=0.002){
  try{ p.cancelAndHoldAtTime(t); }catch(e){ p.cancelScheduledValues(t); }
  p.linearRampToValueAtTime(0.0001, t+0.0008);
  p.linearRampToValueAtTime(peak, t+0.0008+a);
  p.exponentialRampToValueAtTime(0.0001, t+0.0008+a+dur);
  p.setValueAtTime(0, t+0.0009+a+dur);
}
function reFreq(p, t, f0, f1, tau){
  try{ p.cancelAndHoldAtTime(t); }catch(e){ p.cancelScheduledValues(t); }
  p.setValueAtTime(f0, t);
  p.exponentialRampToValueAtTime(f1, t+tau);
}
const bq=(ctx,type,f,q,g)=>{ const b=ctx.createBiquadFilter(); b.type=type; b.frequency.value=f;
  if(q!=null) b.Q.value=q; if(g!=null) b.gain.value=g; return b; };

/* decimatore: riduzione della frequenza di campionamento (carattere campionatore) */
const DECIM_SRC = `class Decim extends AudioWorkletProcessor{
  static get parameterDescriptors(){return [{name:'div',defaultValue:1,minValue:1,maxValue:64,automationRate:'k-rate'}]}
  constructor(){super();this.hold=[0,0];this.cnt=0}
  process(i,o,p){
    const I=i[0],O=o[0];
    if(!I||!I.length){return true}
    const div=Math.max(1,Math.round(p.div[0])), n=O[0].length;
    for(let s=0;s<n;s++){
      if(this.cnt<=0){for(let c=0;c<O.length;c++)this.hold[c]=I[c]?I[c][s]:0;this.cnt=div}
      this.cnt--;
      for(let c=0;c<O.length;c++)O[c][s]=this.hold[c];
    }
    return true}
}
registerProcessor('decim',Decim);`;
/* i blob: non si caricano come worklet da file://, i data: sì */
const DECIM_URLS = [
  'data:application/javascript,'+encodeURIComponent(DECIM_SRC),
  () => URL.createObjectURL(new Blob([DECIM_SRC],{type:'application/javascript'}))
];
async function addDecimModule(ctx){
  for(const u of DECIM_URLS){
    try{ await ctx.audioWorklet.addModule(typeof u==='function'?u():u); return true; }catch(e){}
  }
  return false;
}

/* ---------- grafo ---------- */
export async function buildGraph(ctx, dest){
  const N = {ctx, tr:{}, strip:{}, persist:{}};
  const master = ctx.createGain(); master.gain.value=0.9;
  const lim = ctx.createDynamicsCompressor();
  lim.threshold.value=-8; lim.knee.value=6; lim.ratio.value=12;
  lim.attack.value=0.003; lim.release.value=0.12;
  master.connect(lim); lim.connect(dest);
  N.master=master;

  const revS = makeVerb(ctx, LIGHT?0.35:0.55, 3.2, 0.45);
  const revL = makeVerb(ctx, LIGHT?1.0:1.7, 2.4, 0.18);
  const revSG = ctx.createGain(), revLG = ctx.createGain();
  revS.out.connect(revSG); revSG.connect(master);
  revL.out.connect(revLG); revLG.connect(master);
  N.revSIn=revS.in; N.revLIn=revL.in; N.revSG=revSG; N.revLG=revLG;

  let decim=null;
  if(!LIGHT && await addDecimModule(ctx)){
    try{ decim=new AudioWorkletNode(ctx,'decim',
      {numberOfInputs:1,numberOfOutputs:1,outputChannelCount:[2]}); }catch(e){ decim=null; }
  }
  const drumIn=ctx.createGain(), crush=crushCurve(ctx,13), drive=shaper(ctx,1.6,0.15);
  const drumComp=ctx.createDynamicsCompressor();
  drumComp.threshold.value=-16; drumComp.ratio.value=4; drumComp.attack.value=0.004; drumComp.release.value=0.14;
  const drumOut=ctx.createGain();
  drumIn.connect(crush);                      // il decimatore entra solo se acceso
  crush.connect(drive); drive.connect(drumComp); drumComp.connect(drumOut); drumOut.connect(master);
  N.drum=drumIn; N.crush=crush; N.drive=drive; N.drumOut=drumOut; N.decim=decim; N.decimOn=false;

  const duck=ctx.createGain(), bassduck=ctx.createGain();
  duck.connect(master); bassduck.connect(master);
  N.duck=duck; N.bassduck=bassduck;

  for(const t of TRACKS){
    const g=ctx.createGain(), p=ctx.createStereoPanner(), sd=ctx.createGain();
    g.connect(p);
    p.connect(t.bus==='drum'?drumIn : t.bus==='bassduck'?bassduck : duck);
    p.connect(sd); sd.connect(t.bus==='drum'?revS.in:revL.in);
    sd.gain.value=t.rev;
    N.tr[t.id]={g,p,sd};
  }

  /* --- catene fisse, costruite una volta e condivise da tutte le note --- */
  const S=N.strip;
  // rullante: rumore in banda
  { const a=bq(ctx,'bandpass',1750,0.6), b=bq(ctx,'highpass',420);
    a.connect(b); b.connect(N.tr.snare.g); S.snare=a; }
  // clap
  { const a=bq(ctx,'bandpass',1150,1.3), b=bq(ctx,'highpass',700);
    a.connect(b); b.connect(N.tr.clap.g); S.clap=a; }
  // hi-hat (una catena per ciascuna delle due tracce)
  for(const id of ['hhc','hho']){
    const a=bq(ctx,'highpass',7200), b=bq(ctx,'bandpass',10500,0.8);
    a.connect(b); b.connect(N.tr[id].g); S[id]=a;
  }
  // tumbarinu: pelle e cordino
  { const a=bq(ctx,'bandpass',430,0.9); a.connect(N.tr.tumb.g); S.tumbSkin=a;
    const c=bq(ctx,'bandpass',2600,1.6); c.connect(N.tr.tumb.g); S.tumbBuzz=c; }
  // rim
  { const a=bq(ctx,'bandpass',3200,2); a.connect(N.tr.rim.g); S.rimN=a; }
  // chitarra: il cabinet è lineare, quindi si può condividere; la distorsione
  // resta per nota (curva in cache e senza sovracampionamento: costa poco)
  { const cab=bq(ctx,'lowpass',3000,0.8);
    const scoop=bq(ctx,'peaking',750,1.1,-6);
    const pres=bq(ctx,'peaking',2400,1.2,4);
    const hp=bq(ctx,'highpass',95);
    cab.connect(scoop); scoop.connect(pres); pres.connect(hp);
    hp.connect(N.tr.guitar.g);
    S.guitar=cab; N.gtrCab=cab; }
  // tenore: banco di formanti su vocale chiusa
  { const inn=ctx.createGain(), mix=ctx.createGain();
    for(const [fr,q,gn] of [[330,7,1.0],[760,9,0.7],[2450,11,0.28]]){
      const b=bq(ctx,'bandpass',fr,q), g2=ctx.createGain(); g2.gain.value=gn;
      inn.connect(b); b.connect(g2); g2.connect(mix);
    }
    const dir=ctx.createGain(); dir.gain.value=0.16; inn.connect(dir); dir.connect(mix);
    const sat=shaper(ctx,2.4,0.55); mix.connect(sat); sat.connect(N.tr.ten.g);
    S.ten=inn; }

  /* vibrati condivisi: un solo LFO per strumento invece di due nodi per nota */
  N.vib={};
  for(const [k,hz,depth] of [['lead',5.2,5],['ten',4.6,6]]){
    const o=ctx.createOscillator(), g=ctx.createGain();
    o.frequency.value=hz; g.gain.value=depth;
    o.connect(g); o.start();
    N.vib[k]=g;
  }

  /* --- voci riutilizzabili per la batteria fitta ---
     cassa, rullante, hi-hat e tumbarinu suonano molte volte al secondo: creare
     e distruggere una decina di nodi a ogni colpo è ciò che faceva arrancare i
     telefoni. Qui gli oscillatori restano accesi e ogni colpo riprogramma solo
     inviluppi e frequenze. */
  const pool = (size, build) => {
    const v=[]; for(let i=0;i<size;i++) v.push(build());
    let i=0; return { next(){ const x=v[i]; i=(i+1)%size; return x; } };
  };
  /* un solo generatore di rumore per tutta la batteria: ricampionare un buffer
     in loop costa, e ne bastava uno */
  const nz = noise(ctx); nz.playbackRate.value=1; nz.start();
  const liveNoise = () => nz;
  /* tremolo del cordino: il rumore passa da uno stadio modulato a 62 Hz.
     L'LFO va collegato QUI, non al guadagno d'inviluppo della voce: un LFO
     attaccato a un parametro sempre vivo suonerebbe anche a pattern fermo. */
  let buzzSrc = nz;
  if(!LIGHT){
    const trem=ctx.createGain(); trem.gain.value=0.5;
    const o=ctx.createOscillator(); o.type='sine'; o.frequency.value=62;
    const lg=ctx.createGain(); lg.gain.value=0.5;
    o.connect(lg); lg.connect(trem.gain); o.start();
    nz.connect(trem); buzzSrc=trem;
  }
  N.pool = {};

  N.pool.kick = pool(2, ()=>{
    const o=ctx.createOscillator(); o.type='sine'; o.frequency.value=47;
    const g=ctx.createGain(); g.gain.value=0;
    o.connect(g); g.connect(N.tr.kick.g); o.start();
    const ng=ctx.createGain(); ng.gain.value=0;
    const nf=bq(ctx,'highpass',1800);
    liveNoise().connect(nf); nf.connect(ng); ng.connect(N.tr.kick.g);
    return {o,g,ng};
  });
  N.pool.snare = pool(2, ()=>{
    const g=ctx.createGain(); g.gain.value=0;
    liveNoise().connect(g); g.connect(S.snare);
    const tones=[];
    for(const f of [188,332]){
      const o=ctx.createOscillator(); o.type='triangle'; o.frequency.value=f;
      const tg=ctx.createGain(); tg.gain.value=0;
      o.connect(tg); tg.connect(N.tr.snare.g); o.start();
      tones.push({o,g:tg,f});
    }
    return {g,tones};
  });
  for(const id of ['hhc','hho']){
    // il banco metallico è uno solo per traccia: 4 onde quadre sempre accese
    const bank=ctx.createGain(); bank.gain.value=1;
    const rat = LIGHT ? [1,1.61] : [1,1.34,1.61,2.13];
    for(const r of rat){
      const o=ctx.createOscillator(); o.type='square'; o.frequency.value=317*r;
      const og=ctx.createGain(); og.gain.value= LIGHT?0.16:0.11;
      o.connect(og); og.connect(bank); o.start();
    }
    N.pool[id]=pool(id==='hho'?2:3, ()=>{
      const g=ctx.createGain(); g.gain.value=0;
      bank.connect(g); nz.connect(g); g.connect(S[id]);
      return {g};
    });
  }
  N.pool.tumb = pool(3, ()=>{
    const modes=[];
    const ratios = LIGHT ? [[1,0.55,0.30],[1.59,0.34,0.17],[2.30,0.20,0.09]]
                         : [[1,0.55,0.30],[1.59,0.34,0.17],[2.14,0.22,0.11],[2.30,0.16,0.08],[2.65,0.10,0.06]];
    for(const [r,a,d] of ratios){
      const o=ctx.createOscillator(); o.type='sine'; o.frequency.value=118*r;
      const g=ctx.createGain(); g.gain.value=0;
      o.connect(g); g.connect(N.tr.tumb.g); o.start();
      modes.push({o,g,r,a,d});
    }
    const skin=ctx.createGain(); skin.gain.value=0;
    liveNoise().connect(skin); skin.connect(S.tumbSkin);
    const buzz=ctx.createGain(); buzz.gain.value=0;
    buzzSrc.connect(buzz); buzz.connect(S.tumbBuzz);
    return {modes,skin,buzz};
  });

  // chitarra e basso: anche loro suonano fitto, stesso trattamento
  N.pool.guitar = pool(3, ()=>{
    const dist=shaper(ctx,9,0.5);
    const g=ctx.createGain(); g.gain.value=0;
    const oscs=[];
    const voices = LIGHT ? [[0,0.7,-4],[7,0.6,5]] : [[0,0.6,-4],[7,0.5,5],[12,0.34,-8],[0,0.3,10]];
    for(const [semi,a,det] of voices){
      const o=ctx.createOscillator(); o.type= semi===12?'square':'sawtooth';
      o.detune.value=det; o.frequency.value=110;
      const og=ctx.createGain(); og.gain.value=a;
      o.connect(og); og.connect(dist); o.start();
      oscs.push({o,semi});
    }
    dist.connect(g); g.connect(S.guitar);
    return {oscs,g};
  });
  N.pool.bass = pool(3, ()=>{
    const lp=bq(ctx,'lowpass',800,5);
    const dr=shaper(ctx,2.2,0.2);
    const g=ctx.createGain(); g.gain.value=0;
    const oscs=[];
    const voices = LIGHT ? [['sawtooth',0,0.6],['sine',-1212,0.45]]
                         : [['sawtooth',0,0.55],['square',-9,0.30],['sine',-1212,0.42]];
    for(const [ty,det,a] of voices){
      const o=ctx.createOscillator(); o.type=ty; o.detune.value=det; o.frequency.value=55;
      const og=ctx.createGain(); og.gain.value=a;
      o.connect(og); og.connect(lp); o.start();
      oscs.push(o);
    }
    lp.connect(dr); dr.connect(g); g.connect(N.tr.bass.g);
    return {oscs,lp,g};
  });

  N.droneG = ctx.createGain(); N.droneG.gain.value=0; N.droneG.connect(duck);
  N.droneSend = ctx.createGain(); N.droneSend.gain.value=0.25;
  N.droneG.connect(N.droneSend); N.droneSend.connect(revL.in);
  return N;
}

/* accende/spegne il decimatore: quando è off non deve nemmeno stare nel grafo,
   perché gira in JavaScript su ogni campione */
export function routeDecim(N, on){
  if(!N.decim || on===N.decimOn) return;
  try{
    if(on){ N.drum.disconnect(N.crush); N.drum.connect(N.decim); N.decim.connect(N.crush); }
    else  { N.drum.disconnect(N.decim); N.decim.disconnect(N.crush); N.drum.connect(N.crush); }
    N.decimOn=on;
  }catch(e){}
}

/* ---------- voci: batteria ----------
   ogni voce vive quanto il suo inviluppo, non un istante di più */
function vKick(ctx,N,t,v,par={}){
  const p=N.pool.kick.next();
  reFreq(p.o.frequency, t, par.f0||150, par.f1||47, 0.055);
  reDecay(p.g.gain, t, v*0.95, par.dec||0.42, 0.001);
  reDecay(p.ng.gain, t, v*0.22, 0.012, 0.001);
}
function vSnare(ctx,N,t,v){
  const p=N.pool.snare.next();
  reDecay(p.g.gain, t, v*0.62, 0.16, 0.001);
  for(let i=0;i<p.tones.length;i++){
    const tn=p.tones[i], [a,d] = i===0?[0.35,0.10]:[0.20,0.07];
    reFreq(tn.o.frequency, t, tn.f, tn.f*0.82, 0.08);
    reDecay(tn.g.gain, t, v*a, d, 0.001);
  }
}
function vClap(ctx,N,t,v){
  const dst=N.strip.clap;
  for(let i=0;i<3;i++){
    const n=noise(ctx), g=ctx.createGain(), tt=t+i*0.0095;
    decayTo0(g.gain,tt,v*(0.5-i*0.09),0.014,0.0008);
    n.connect(g); g.connect(dst); n.start(tt); n.stop(tt+0.03);
  }
  const n=noise(ctx), g=ctx.createGain();
  decayTo0(g.gain,t+0.028,v*0.42,0.14,0.002);
  n.connect(g); g.connect(dst); n.start(t+0.028); n.stop(t+0.19);
}
/* restituisce il gain, così il chiuso può strozzare l'aperto */
function vHat(ctx,N,t,v,open){
  const p=N.pool[open?'hho':'hhc'].next();
  reDecay(p.g.gain, t, v*(open?0.24:0.27), open?0.34:0.048, 0.001);
  return p.g;
}
function vTom(ctx,N,t,v,par={}){
  const out=N.tr.tom.g, f=par.f||190;
  const o=ctx.createOscillator(), g=ctx.createGain();
  o.type='sine'; o.frequency.setValueAtTime(f,t);
  o.frequency.exponentialRampToValueAtTime(f*0.6,t+0.16);
  decayTo0(g.gain,t,v*0.6,0.34,0.002);
  o.connect(g); g.connect(out); o.start(t); o.stop(t+0.38);
  if(!LIGHT){
    const n=noise(ctx), ng=ctx.createGain();
    const bp=bq(ctx,'bandpass',f*2.4,1.2);
    decayTo0(ng.gain,t,v*0.16,0.05,0.001);
    n.connect(bp); bp.connect(ng); ng.connect(out); n.start(t); n.stop(t+0.08);
  }
}
function vRim(ctx,N,t,v){
  const out=N.tr.rim.g;
  for(const [f,a] of [[1720,0.5],[2540,0.3]]){
    const o=ctx.createOscillator(), g=ctx.createGain();
    o.type='triangle'; o.frequency.value=f;
    decayTo0(g.gain,t,v*a,0.028,0.0008);
    o.connect(g); g.connect(out); o.start(t); o.stop(t+0.05);
  }
  const n=noise(ctx), g=ctx.createGain();
  decayTo0(g.gain,t,v*0.2,0.02,0.0006);
  n.connect(g); g.connect(N.strip.rimN); n.start(t); n.stop(t+0.04);
}
/* tumbarinu: tamburo a cornice, modi inarmonici + ronzio del cordino */
function vTumb(ctx,N,t,v,par={}){
  const p=N.pool.tumb.next(), f=par.f||118;
  /* le voci riutilizzate non ripartono in fase come quelle create sul momento:
     l'attacco perde coerenza, e va recuperato in ampiezza */
  for(const m of p.modes){
    reFreq(m.o.frequency, t, f*m.r, f*m.r*0.93, m.d);
    reDecay(m.g.gain, t, v*m.a*TUNE.tumbModes, m.d, 0.0015);
  }
  reDecay(p.skin.gain, t, v*0.30, 0.055, 0.001);
  reDecay(p.buzz.gain, t, v*TUNE.tumbBuzz, 0.19, 0.002);
}

/* ---------- voci: melodiche ---------- */
function vBass(ctx,N,t,midi,dur,v,par={}){
  const f=mtof(midi), p=N.pool.bass.next();
  for(const o of p.oscs){ try{o.frequency.cancelAndHoldAtTime(t);}catch(e){}
    o.frequency.setValueAtTime(f,t); }
  reFreq(p.lp.frequency, t, clamp(f*(par.co||7),120,4200),
         clamp(f*2.2,90,1200), Math.min(dur*0.8,0.35));
  const g=p.g.gain;
  try{ g.cancelAndHoldAtTime(t); }catch(e){ g.cancelScheduledValues(t); }
  g.linearRampToValueAtTime(0.0001,t+0.0008);
  g.linearRampToValueAtTime(v*0.5,t+0.0088);
  g.setValueAtTime(v*0.5,t+Math.max(dur-0.05,0.02));
  g.exponentialRampToValueAtTime(0.0001,t+dur+0.09);
}
function vLead(ctx,N,t,midi,dur,v,par={}){
  const out=N.tr.lead.g, f=mtof(midi);
  const g=ctx.createGain(), lp=bq(ctx,'lowpass',clamp(f*10,300,9000),par.q||3.5);
  lp.frequency.setValueAtTime(clamp(f*10,300,9000),t);
  lp.frequency.exponentialRampToValueAtTime(clamp(f*3.2,220,5000),t+Math.min(dur,0.5));
  const wave=par.wave||'sawtooth';
  const dets = LIGHT ? [0] : [-6,6];
  for(const det of dets){
    const o=ctx.createOscillator(), og=ctx.createGain();
    if(wave==='pulse') o.setPeriodicWave(pulseWave(ctx,20,1.0)); else o.type=wave;
    o.frequency.value=f; o.detune.value=det; og.gain.value=LIGHT?0.7:0.4;
    N.vib.lead.connect(o.detune);              // vibrato condiviso
    o.connect(og); og.connect(lp); o.start(t); o.stop(t+dur+0.2);
  }
  lp.connect(g); g.connect(out);
  adsr(g.gain,t,0.012,Math.min(dur*0.6,0.25),0.7,v*0.34);
  g.gain.setValueAtTime(v*0.34*0.7,t+dur);
  g.gain.exponentialRampToValueAtTime(0.0001,t+dur+0.16);
}
/* launeddas: voce monofonica continua (respirazione circolare) */
export function makeLaun(ctx,N){
  const out=N.tr.laun.g;
  const sum=ctx.createGain(); sum.gain.value=0.0001;
  const chans=[];
  for(const [semi,pan,amp] of [[0,-0.25,1.0],[7,0.28,0.72]]){
    const o=ctx.createOscillator(); o.setPeriodicWave(pulseWave(ctx,28,1.05));
    const pwm=ctx.createOscillator(), pwg=ctx.createGain();
    pwm.frequency.value=0.13+Math.random()*0.1; pwg.gain.value=7;
    pwm.connect(pwg); pwg.connect(o.detune);
    const pre=ctx.createGain(); pre.gain.value=amp*0.34;
    const pn=ctx.createStereoPanner(); pn.pan.value=pan;
    const mix=ctx.createGain();
    const res = LIGHT ? [[900,4.5,1.0],[1550,6,0.62]] : [[900,4.5,1.0],[1550,6,0.62],[2600,7,0.4]];
    for(const [fr,q,gn] of res){
      const b=bq(ctx,'bandpass',fr,q), bg=ctx.createGain(); bg.gain.value=gn;
      o.connect(b); b.connect(bg); bg.connect(mix);
    }
    const dir=ctx.createGain(); dir.gain.value=0.45; o.connect(dir); dir.connect(mix);
    mix.connect(pre); pre.connect(pn); pn.connect(sum);
    o.start(); pwm.start();
    chans.push({o,semi});
  }
  const n=noise(ctx), ng=ctx.createGain();
  const hp=bq(ctx,'highpass',2600); ng.gain.value=0.03;
  n.connect(hp); hp.connect(ng); ng.connect(sum); n.start();
  sum.connect(out);
  return {
    note(t,midi,dur,v){
      for(const c of chans){
        c.o.frequency.cancelScheduledValues(t);
        c.o.frequency.setValueAtTime(mtof(midi+c.semi)*(1+(Math.random()-0.5)*0.004),t);
      }
      const g=sum.gain;
      g.cancelScheduledValues(t);
      g.setValueAtTime(Math.max(g.value,0.0001),t);
      g.linearRampToValueAtTime(0.45*v,t+0.012);   /* articolazione = calo, non silenzio */
      g.linearRampToValueAtTime(1.0*v,t+0.055);
      g.setValueAtTime(1.0*v,t+Math.max(dur-0.03,0.05));
      g.linearRampToValueAtTime(0.0001,t+dur+0.14);
    },
    stop(t){ try{ sum.gain.cancelScheduledValues(t); sum.gain.linearRampToValueAtTime(0.0001,t+0.2);}catch(e){} }
  };
}
/* bordone tumbu: due canne leggermente scordate, L/R, senza ritardo Haas */
export function makeDrone(ctx,N,midi){
  const g=N.droneG;
  const hp=bq(ctx,'highpass',130);
  const nt=bq(ctx,'peaking',1400,1.1,-4.5);
  const lp=bq(ctx,'lowpass',2600);
  hp.connect(nt); nt.connect(lp); lp.connect(g);
  const oscs=[];
  for(const [det,pan] of [[-5,-0.62],[6,0.64]]){
    const o=ctx.createOscillator(); o.setPeriodicWave(pulseWave(ctx,22,1.15));
    o.frequency.value=mtof(midi); o.detune.value=det;
    const pn=ctx.createStereoPanner(); pn.pan.value=pan;
    const gg=ctx.createGain(); gg.gain.value=0.3;
    const dr=ctx.createOscillator(), dg=ctx.createGain();
    dr.frequency.value=0.07+Math.random()*0.06; dg.gain.value=4;
    dr.connect(dg); dg.connect(o.detune); dr.start();
    o.connect(gg); gg.connect(pn); pn.connect(hp); o.start();
    oscs.push(o);
  }
  if(!LIGHT){
    const n=noise(ctx), ng=ctx.createGain();
    const nf=bq(ctx,'bandpass',1900,0.7); ng.gain.value=0.012;
    n.connect(nf); nf.connect(ng); ng.connect(hp); n.start();
  }
  return { set(t,on,v){ g.gain.cancelScheduledValues(t);
      g.gain.setValueAtTime(Math.max(g.gain.value,0.0001),t);
      g.gain.linearRampToValueAtTime(on? v*0.30 : 0.0001, t+(on?0.5:0.6)); },
    setNote(t,m){ for(const o of oscs) o.frequency.setValueAtTime(mtof(m),t); } };
}
/* canto a tenore: bassu/contra — raddoppio di periodo + formanti condivise */
function vTenore(ctx,N,t,midi,dur,v){
  const f=mtof(midi);
  const g=ctx.createGain();
  const oscs = LIGHT ? [[0.5,'sawtooth',0.9,0],[1,'sawtooth',0.5,-7]]
                     : [[0.5,'sawtooth',0.85,0],[1,'sawtooth',0.5,-7],[1,'square',0.2,9]];
  for(const [mult,ty,a,det] of oscs){
    const o=ctx.createOscillator(), og=ctx.createGain();
    o.type=ty; o.frequency.value=f*mult; o.detune.value=det; og.gain.value=a;
    N.vib.ten.connect(o.detune);               // vibrato condiviso
    o.connect(og); og.connect(g); o.start(t); o.stop(t+dur+0.3);
  }
  g.connect(N.strip.ten);
  g.gain.setValueAtTime(0.0001,t);
  g.gain.linearRampToValueAtTime(v*0.5,t+0.09);
  g.gain.setValueAtTime(v*0.5,t+Math.max(dur-0.08,0.1));
  g.gain.exponentialRampToValueAtTime(0.0001,t+dur+0.22);
}
/* chitarra hardcore: power chord nell'ampli condiviso */
function vGuitar(ctx,N,t,midi,dur,v,par={}){
  const pm=par.pm!==false;
  if(N.gtrCab) N.gtrCab.frequency.setValueAtTime(pm?3000:4400, t);
  const p=N.pool.guitar.next(), d = pm? Math.min(dur,0.115) : dur;
  for(const s of p.oscs){ try{s.o.frequency.cancelAndHoldAtTime(t);}catch(e){}
    s.o.frequency.setValueAtTime(mtof(midi+s.semi),t); }
  const g=p.g.gain;
  try{ g.cancelAndHoldAtTime(t); }catch(e){ g.cancelScheduledValues(t); }
  g.linearRampToValueAtTime(0.0001,t+0.0008);
  g.linearRampToValueAtTime(v*0.19,t+0.0048);
  if(pm){ g.exponentialRampToValueAtTime(0.0001,t+d+0.05); }
  else { g.setValueAtTime(v*0.19,t+Math.max(d-0.05,0.05));
         g.exponentialRampToValueAtTime(0.0001,t+d+0.12); }
}

/* dispatch — st porta lo stato del choke fra un colpo e l'altro */
export function fireDrum(ctx,N,id,t,v,st){
  if(id==='hhc'||id==='hho'){
    if(st && st.openHat && t < st.openHat.end){
      const g=st.openHat.node.gain;
      try{ g.cancelAndHoldAtTime(t); }catch(e){ try{g.cancelScheduledValues(t);}catch(e2){} }
      g.exponentialRampToValueAtTime(0.0001, t+0.014);
    }
    const node=vHat(ctx,N,t,v,id==='hho');
    if(st) st.openHat = (id==='hho') ? {node, end:t+0.36} : null;
    return;
  }
  switch(id){
    case 'kick': vKick(ctx,N,t,v); break;
    case 'snare': vSnare(ctx,N,t,v); break;
    case 'clap': vClap(ctx,N,t,v); break;
    case 'tom': vTom(ctx,N,t,v); break;
    case 'rim': vRim(ctx,N,t,v); break;
    case 'tumb': vTumb(ctx,N,t,v); break;
  }
}
export function fireNote(ctx,N,id,t,midi,dur,v,par){
  switch(id){
    case 'bass': vBass(ctx,N,t,midi,dur,v,par); break;
    case 'lead': vLead(ctx,N,t,midi,dur,v,par); break;
    case 'guitar': vGuitar(ctx,N,t,midi,dur,v,par); break;
    case 'ten': vTenore(ctx,N,t,midi,dur,v); break;
    /* le launeddas costano anche in silenzio: si accendono alla prima nota */
    case 'laun':
      if(!N.persist.laun) N.persist.laun = makeLaun(ctx,N);
      N.persist.laun.note(t,midi,dur,v); break;
  }
}
export function duckAt(N,t,depthDb,bassPct){
  const d=Math.pow(10,-depthDb/20);
  for(const [node,amt] of [[N.duck,1],[N.bassduck,bassPct]]){
    const g=node.gain, val=1-(1-d)*amt;
    g.cancelScheduledValues(t); g.setValueAtTime(1,t);
    g.linearRampToValueAtTime(val,t+0.006);
    g.linearRampToValueAtTime(1,t+0.19);
  }
}
