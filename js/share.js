/* BeatLab — condivisione di un progetto dentro l'indirizzo.

   Il progetto viene compresso con deflate e infilato nel frammento dell'URL
   (dopo il #), che non viaggia mai verso il server: il link contiene tutto,
   non serve nessun archivio da nessuna parte. Se il browser non ha
   CompressionStream si ripiega sul JSON in chiaro, con un link più lungo. */
import { toJSON, fromJSON } from './state.js';

const b64enc = bytes => {
  let s=''; for(const b of bytes) s+=String.fromCharCode(b);
  return btoa(s).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
};
const b64dec = str => {
  const s=atob(str.replace(/-/g,'+').replace(/_/g,'/'));
  const out=new Uint8Array(s.length);
  for(let i=0;i<s.length;i++) out[i]=s.charCodeAt(i);
  return out;
};

async function deflate(text){
  if(typeof CompressionStream==='undefined') return null;
  const cs=new CompressionStream('deflate-raw');
  const stream=new Blob([new TextEncoder().encode(text)]).stream().pipeThrough(cs);
  return new Uint8Array(await new Response(stream).arrayBuffer());
}
async function inflate(bytes){
  if(typeof DecompressionStream==='undefined') throw new Error('DecompressionStream non disponibile');
  const ds=new DecompressionStream('deflate-raw');
  const stream=new Blob([bytes]).stream().pipeThrough(ds);
  return new TextDecoder().decode(await new Response(stream).arrayBuffer());
}

/* costruisce il link condivisibile per il progetto corrente */
export async function shareLink(){
  const json=JSON.stringify(toJSON(true));
  const packed=await deflate(json);
  const payload = packed ? 'z'+b64enc(packed)
                         : 'j'+b64enc(new TextEncoder().encode(json));
  const base=location.origin+location.pathname;
  return base+'#p='+payload;
}

/* legge un progetto dall'indirizzo, se c'è. Restituisce true se ha caricato. */
export async function loadFromHash(){
  const m=/[#&]p=([A-Za-z0-9\-_]+)/.exec(location.hash||'');
  if(!m) return false;
  try{
    const raw=m[1], kind=raw[0], bytes=b64dec(raw.slice(1));
    const json = kind==='z' ? await inflate(bytes) : new TextDecoder().decode(bytes);
    fromJSON(JSON.parse(json));
    return true;
  }catch(e){
    console.warn('link non leggibile:', e);
    return false;
  }
}

/* toglie il pattern dall'indirizzo senza ricaricare la pagina, così una
   modifica successiva non resta smentita da un link vecchio nella barra */
export function clearHash(){
  try{ history.replaceState(null,'',location.pathname+location.search); }catch(e){}
}

export async function copyLink(url){
  try{ await navigator.clipboard.writeText(url); return true; }
  catch(e){
    const ta=document.createElement('textarea');
    ta.value=url; ta.style.cssText='position:fixed;opacity:0';
    document.body.appendChild(ta); ta.select();
    let ok=false; try{ ok=document.execCommand('copy'); }catch(e2){}
    ta.remove(); return ok;
  }
}
