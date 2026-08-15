/* BeatLab — motore di sintesi (Web Audio API).
   Nessun sample: ogni suono è generato da oscillatori e rumore. */

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
export function shaper(ctx, amount, asym=0){
  const n=2048, c=new Float32Array(n), k=amount;
  for(let i=0;i<n;i++){ const x=i*2/n-1; const xa=x+asym*x*x*0.4;
    c[i]=Math.tanh(k*xa)/Math.tanh(k); }
  const w=ctx.createWaveShaper(); w.curve=c; w.oversample='4x'; return w;
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
  const N = {ctx, tr:{}, persist:{}};
  const master = ctx.createGain(); master.gain.value=0.9;
  const lim = ctx.createDynamicsCompressor();
  lim.threshold.value=-8; lim.knee.value=6; lim.ratio.value=12;
  lim.attack.value=0.003; lim.release.value=0.12;
  master.connect(lim); lim.connect(dest);
  N.master=master;

  const revS = ctx.createConvolver(); revS.buffer = impulse(ctx,0.6,3.2,0.45);
  const revL = ctx.createConvolver(); revL.buffer = impulse(ctx,2.2,2.4,0.18);
  const revSG = ctx.createGain(), revLG = ctx.createGain();
  revS.connect(revSG); revSG.connect(master);
  revL.connect(revLG); revLG.connect(master);
  N.revS=revS; N.revL=revL; N.revSG=revSG; N.revLG=revLG;

  let decim=null;
  if(await addDecimModule(ctx)){
    try{ decim=new AudioWorkletNode(ctx,'decim',
      {numberOfInputs:1,numberOfOutputs:1,outputChannelCount:[2]}); }catch(e){ decim=null; }
  }
  const drumIn=ctx.createGain(), crush=crushCurve(ctx,13), drive=shaper(ctx,1.6,0.15);
  const drumComp=ctx.createDynamicsCompressor();
  drumComp.threshold.value=-16; drumComp.ratio.value=4; drumComp.attack.value=0.004; drumComp.release.value=0.14;
  const drumOut=ctx.createGain();
  if(decim){ drumIn.connect(decim); decim.connect(crush); } else { drumIn.connect(crush); }
  crush.connect(drive); drive.connect(drumComp); drumComp.connect(drumOut); drumOut.connect(master);
  N.drum=drumIn; N.crush=crush; N.drive=drive; N.drumOut=drumOut; N.decim=decim;

  const duck=ctx.createGain(), bassduck=ctx.createGain();
  duck.connect(master); bassduck.connect(master);
  N.duck=duck; N.bassduck=bassduck;

  for(const t of TRACKS){
    const g=ctx.createGain(), p=ctx.createStereoPanner(), sd=ctx.createGain();
    g.connect(p);
    p.connect(t.bus==='drum'?drumIn : t.bus==='bassduck'?bassduck : duck);
    p.connect(sd); sd.connect(t.bus==='drum'?revS:revL);
    sd.gain.value=t.rev;
    N.tr[t.id]={g,p,sd};
  }
  N.droneG = ctx.createGain(); N.droneG.gain.value=0; N.droneG.connect(duck);
  N.droneSend = ctx.createGain(); N.droneSend.gain.value=0.25;
  N.droneG.connect(N.droneSend); N.droneSend.connect(revL);
  return N;
}

/* ---------- voci: batteria ---------- */
function vKick(ctx,N,t,v,par={}){
  const out=N.tr.kick.g;
  const o=ctx.createOscillator(), g=ctx.createGain();
  o.type='sine';
  o.frequency.setValueAtTime(par.f0||150,t);
  o.frequency.exponentialRampToValueAtTime(par.f1||47,t+0.055);
  decayTo0(g.gain,t,v*0.95,par.dec||0.42,0.001);
  o.connect(g); g.connect(out); o.start(t); o.stop(t+0.9);
  const n=noise(ctx), nf=ctx.createBiquadFilter(), ng=ctx.createGain();
  nf.type='highpass'; nf.frequency.value=1800;
  decayTo0(ng.gain,t,v*0.22,0.012,0.001);
  n.connect(nf); nf.connect(ng); ng.connect(out); n.start(t); n.stop(t+0.06);
}
function vSnare(ctx,N,t,v){
  const out=N.tr.snare.g;
  const n=noise(ctx), bp=ctx.createBiquadFilter(), hp=ctx.createBiquadFilter(), g=ctx.createGain();
  bp.type='bandpass'; bp.frequency.value=1750; bp.Q.value=0.6;
  hp.type='highpass'; hp.frequency.value=420;
  decayTo0(g.gain,t,v*0.62,0.16,0.001);
  n.connect(bp); bp.connect(hp); hp.connect(g); g.connect(out); n.start(t); n.stop(t+0.4);
  for(const [f,a,d] of [[188,0.35,0.10],[332,0.20,0.07]]){
    const o=ctx.createOscillator(), og=ctx.createGain();
    o.type='triangle'; o.frequency.setValueAtTime(f,t);
    o.frequency.exponentialRampToValueAtTime(f*0.82,t+0.08);
    decayTo0(og.gain,t,v*a,d,0.001);
    o.connect(og); og.connect(out); o.start(t); o.stop(t+0.3);
  }
}
function vClap(ctx,N,t,v){
  const out=N.tr.clap.g, bp=ctx.createBiquadFilter(), hp=ctx.createBiquadFilter();
  bp.type='bandpass'; bp.frequency.value=1150; bp.Q.value=1.3;
  hp.type='highpass'; hp.frequency.value=700;
  bp.connect(hp); hp.connect(out);
  for(let i=0;i<3;i++){
    const n=noise(ctx), g=ctx.createGain(), tt=t+i*0.0095;
    decayTo0(g.gain,tt,v*(0.5-i*0.09),0.014,0.0008);
    n.connect(g); g.connect(bp); n.start(tt); n.stop(tt+0.05);
  }
  const n=noise(ctx), g=ctx.createGain();
  decayTo0(g.gain,t+0.028,v*0.42,0.14,0.002);
  n.connect(g); g.connect(bp); n.start(t+0.028); n.stop(t+0.3);
}
/* restituisce il gain, così il chiuso può strozzare l'aperto */
function vHat(ctx,N,t,v,open){
  const out=N.tr[open?'hho':'hhc'].g, dur=open?0.34:0.048;
  const hp=ctx.createBiquadFilter(), bp=ctx.createBiquadFilter(), g=ctx.createGain();
  hp.type='highpass'; hp.frequency.value=7200;
  bp.type='bandpass'; bp.frequency.value=10500; bp.Q.value=0.8;
  decayTo0(g.gain,t,v*(open?0.30:0.34),dur,0.001);
  hp.connect(bp); bp.connect(g); g.connect(out);
  const n=noise(ctx); n.connect(hp); n.start(t); n.stop(t+dur+0.3);
  for(const r of [1,1.34,1.61,2.13]){
    const o=ctx.createOscillator(), og=ctx.createGain();
    o.type='square'; o.frequency.value=317*r; og.gain.value=0.14;
    o.connect(og); og.connect(hp); o.start(t); o.stop(t+dur+0.3);
  }
  return g;
}
function vTom(ctx,N,t,v,par={}){
  const out=N.tr.tom.g, f=par.f||190;
  const o=ctx.createOscillator(), g=ctx.createGain();
  o.type='sine'; o.frequency.setValueAtTime(f,t);
  o.frequency.exponentialRampToValueAtTime(f*0.6,t+0.16);
  decayTo0(g.gain,t,v*0.6,0.34,0.002);
  o.connect(g); g.connect(out); o.start(t); o.stop(t+0.6);
  const n=noise(ctx), bp=ctx.createBiquadFilter(), ng=ctx.createGain();
  bp.type='bandpass'; bp.frequency.value=f*2.4; bp.Q.value=1.2;
  decayTo0(ng.gain,t,v*0.16,0.05,0.001);
  n.connect(bp); bp.connect(ng); ng.connect(out); n.start(t); n.stop(t+0.2);
}
function vRim(ctx,N,t,v){
  const out=N.tr.rim.g;
  for(const [f,a] of [[1720,0.5],[2540,0.3]]){
    const o=ctx.createOscillator(), g=ctx.createGain();
    o.type='triangle'; o.frequency.value=f;
    decayTo0(g.gain,t,v*a,0.028,0.0008);
    o.connect(g); g.connect(out); o.start(t); o.stop(t+0.1);
  }
  const n=noise(ctx), bp=ctx.createBiquadFilter(), g=ctx.createGain();
  bp.type='bandpass'; bp.frequency.value=3200; bp.Q.value=2;
  decayTo0(g.gain,t,v*0.2,0.02,0.0006);
  n.connect(bp); bp.connect(g); g.connect(out); n.start(t); n.stop(t+0.08);
}
/* tumbarinu: tamburo a cornice, modi inarmonici + ronzio del cordino */
function vTumb(ctx,N,t,v,par={}){
  const out=N.tr.tumb.g, f=par.f||118;
  for(const [r,a,d] of [[1,0.55,0.30],[1.59,0.34,0.17],[2.14,0.22,0.11],[2.30,0.16,0.08],[2.65,0.10,0.06]]){
    const o=ctx.createOscillator(), g=ctx.createGain();
    o.type='sine'; o.frequency.setValueAtTime(f*r,t);
    o.frequency.exponentialRampToValueAtTime(f*r*0.93,t+d);
    decayTo0(g.gain,t,v*a,d,0.0015);
    o.connect(g); g.connect(out); o.start(t); o.stop(t+d+0.2);
  }
  const n=noise(ctx), bp=ctx.createBiquadFilter(), g=ctx.createGain();
  bp.type='bandpass'; bp.frequency.value=430; bp.Q.value=0.9;
  decayTo0(g.gain,t,v*0.30,0.055,0.001);
  n.connect(bp); bp.connect(g); g.connect(out); n.start(t); n.stop(t+0.2);
  const n2=noise(ctx), bp2=ctx.createBiquadFilter(), g2=ctx.createGain();
  const lfo=ctx.createOscillator(), lg=ctx.createGain();
  bp2.type='bandpass'; bp2.frequency.value=2600; bp2.Q.value=1.6;
  lfo.type='sine'; lfo.frequency.value=62; lg.gain.value=0.5;
  decayTo0(g2.gain,t,v*0.16,0.19,0.002);
  lfo.connect(lg); lg.connect(g2.gain);
  n2.connect(bp2); bp2.connect(g2); g2.connect(out);
  n2.start(t); n2.stop(t+0.4); lfo.start(t); lfo.stop(t+0.4);
}

/* ---------- voci: melodiche ---------- */
function vBass(ctx,N,t,midi,dur,v,par={}){
  const out=N.tr.bass.g, f=mtof(midi);
  const g=ctx.createGain(), lp=ctx.createBiquadFilter(), dr=shaper(ctx,par.drive||2.2,0.2);
  lp.type='lowpass'; lp.Q.value=par.q||5;
  lp.frequency.setValueAtTime(clamp(f*(par.co||7),120,4200),t);
  lp.frequency.exponentialRampToValueAtTime(clamp(f*2.2,90,1200),t+Math.min(dur*0.8,0.35));
  for(const [ty,det,a] of [['sawtooth',0,0.55],['square',-9,0.30],['sine',-1212,0.42]]){
    const o=ctx.createOscillator(), og=ctx.createGain();
    o.type=ty; o.frequency.value=f; o.detune.value=det; og.gain.value=a;
    o.connect(og); og.connect(lp); o.start(t); o.stop(t+dur+0.25);
  }
  lp.connect(dr); dr.connect(g); g.connect(out);
  g.gain.setValueAtTime(0.0001,t);
  g.gain.linearRampToValueAtTime(v*0.5,t+0.008);
  g.gain.setValueAtTime(v*0.5,t+Math.max(dur-0.05,0.02));
  g.gain.exponentialRampToValueAtTime(0.0001,t+dur+0.09);
}
function vLead(ctx,N,t,midi,dur,v,par={}){
  const out=N.tr.lead.g, f=mtof(midi);
  const g=ctx.createGain(), lp=ctx.createBiquadFilter();
  lp.type='lowpass'; lp.Q.value=par.q||3.5;
  lp.frequency.setValueAtTime(clamp(f*10,300,9000),t);
  lp.frequency.exponentialRampToValueAtTime(clamp(f*3.2,220,5000),t+Math.min(dur,0.5));
  const wave=par.wave||'sawtooth';
  for(const det of [-6,6]){
    const o=ctx.createOscillator(), og=ctx.createGain();
    if(wave==='pulse') o.setPeriodicWave(pulseWave(ctx,20,1.0)); else o.type=wave;
    o.frequency.value=f; o.detune.value=det; og.gain.value=0.4;
    const lfo=ctx.createOscillator(), lg=ctx.createGain();
    lfo.frequency.value=5.2; lg.gain.value=5; lfo.connect(lg); lg.connect(o.detune);
    lfo.start(t+0.12); lfo.stop(t+dur+0.3);
    o.connect(og); og.connect(lp); o.start(t); o.stop(t+dur+0.3);
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
    for(const [fr,q,gn] of [[900,4.5,1.0],[1550,6,0.62],[2600,7,0.4]]){
      const bp=ctx.createBiquadFilter(); bp.type='bandpass'; bp.frequency.value=fr; bp.Q.value=q;
      const bg=ctx.createGain(); bg.gain.value=gn;
      o.connect(bp); bp.connect(bg); bg.connect(mix);
    }
    const dir=ctx.createGain(); dir.gain.value=0.45; o.connect(dir); dir.connect(mix);
    mix.connect(pre); pre.connect(pn); pn.connect(sum);
    o.start(); pwm.start();
    chans.push({o,semi});
  }
  const n=noise(ctx), hp=ctx.createBiquadFilter(), ng=ctx.createGain();
  hp.type='highpass'; hp.frequency.value=2600; ng.gain.value=0.03;
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
  const hp=ctx.createBiquadFilter(); hp.type='highpass'; hp.frequency.value=130;
  const nt=ctx.createBiquadFilter(); nt.type='peaking'; nt.frequency.value=1400; nt.Q.value=1.1; nt.gain.value=-4.5;
  const lp=ctx.createBiquadFilter(); lp.type='lowpass'; lp.frequency.value=2600;
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
  const n=noise(ctx), nf=ctx.createBiquadFilter(), ng=ctx.createGain();
  nf.type='bandpass'; nf.frequency.value=1900; nf.Q.value=0.7; ng.gain.value=0.012;
  n.connect(nf); nf.connect(ng); ng.connect(hp); n.start();
  return { set(t,on,v){ g.gain.cancelScheduledValues(t);
      g.gain.setValueAtTime(Math.max(g.gain.value,0.0001),t);
      g.gain.linearRampToValueAtTime(on? v*0.30 : 0.0001, t+(on?0.5:0.6)); },
    setNote(t,m){ for(const o of oscs) o.frequency.setValueAtTime(mtof(m),t); } };
}
/* canto a tenore: bassu/contra — raddoppio di periodo + formanti */
function vTenore(ctx,N,t,midi,dur,v){
  const out=N.tr.ten.g, f=mtof(midi);
  const sum=ctx.createGain(), g=ctx.createGain();
  for(const [mult,ty,a,det] of [[0.5,'sawtooth',0.85,0],[1,'sawtooth',0.5,-7],[1,'square',0.2,9]]){
    const o=ctx.createOscillator(), og=ctx.createGain();
    o.type=ty; o.frequency.value=f*mult; o.detune.value=det; og.gain.value=a;
    const vib=ctx.createOscillator(), vg=ctx.createGain();
    vib.frequency.value=4.6; vg.gain.value=6; vib.connect(vg); vg.connect(o.detune);
    vib.start(t); vib.stop(t+dur+0.4);
    o.connect(og); og.connect(sum); o.start(t); o.stop(t+dur+0.4);
  }
  const mix=ctx.createGain();
  for(const [fr,q,gn] of [[330,7,1.0],[760,9,0.7],[2450,11,0.28]]){
    const bp=ctx.createBiquadFilter(); bp.type='bandpass'; bp.frequency.value=fr; bp.Q.value=q;
    const bg=ctx.createGain(); bg.gain.value=gn;
    sum.connect(bp); bp.connect(bg); bg.connect(mix);
  }
  const dir=ctx.createGain(); dir.gain.value=0.16; sum.connect(dir); dir.connect(mix);
  const dr=shaper(ctx,2.4,0.55); mix.connect(dr); dr.connect(g); g.connect(out);
  g.gain.setValueAtTime(0.0001,t);
  g.gain.linearRampToValueAtTime(v*0.5,t+0.09);
  g.gain.setValueAtTime(v*0.5,t+Math.max(dur-0.08,0.1));
  g.gain.exponentialRampToValueAtTime(0.0001,t+dur+0.22);
}
/* chitarra hardcore: power chord, distorsione asimmetrica, cabinet */
function vGuitar(ctx,N,t,midi,dur,v,par={}){
  const out=N.tr.guitar.g, pm=par.pm!==false;
  const pre=ctx.createGain(); pre.gain.value=1;
  for(const [semi,a,det] of [[0,0.6,-4],[7,0.5,5],[12,0.34,-8],[0,0.3,10]]){
    const o=ctx.createOscillator(), og=ctx.createGain();
    o.type= semi===12?'square':'sawtooth';
    o.frequency.value=mtof(midi+semi); o.detune.value=det; og.gain.value=a;
    o.connect(og); og.connect(pre); o.start(t); o.stop(t+dur+0.25);
  }
  const g=ctx.createGain();
  const dist=shaper(ctx, par.gainAmt||9, 0.5);
  const cab=ctx.createBiquadFilter(); cab.type='lowpass'; cab.frequency.value=pm?3000:4400; cab.Q.value=0.8;
  const scoop=ctx.createBiquadFilter(); scoop.type='peaking'; scoop.frequency.value=750; scoop.Q.value=1.1; scoop.gain.value=-6;
  const pres=ctx.createBiquadFilter(); pres.type='peaking'; pres.frequency.value=2400; pres.Q.value=1.2; pres.gain.value=4;
  const hp=ctx.createBiquadFilter(); hp.type='highpass'; hp.frequency.value=95;
  pre.connect(dist); dist.connect(cab); cab.connect(scoop); scoop.connect(pres); pres.connect(hp); hp.connect(g); g.connect(out);
  const d = pm? Math.min(dur,0.115) : dur;
  g.gain.setValueAtTime(0.0001,t);
  g.gain.linearRampToValueAtTime(v*0.3,t+0.004);
  if(pm){ g.gain.exponentialRampToValueAtTime(0.0001,t+d+0.05); }
  else { g.gain.setValueAtTime(v*0.3,t+Math.max(d-0.05,0.05));
         g.gain.exponentialRampToValueAtTime(0.0001,t+d+0.12); }
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
    case 'laun': if(N.persist.laun) N.persist.laun.note(t,midi,dur,v); break;
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
