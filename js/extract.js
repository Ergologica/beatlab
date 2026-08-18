/* BeatLab — estrazione da un video: il comando da lanciare e la traccia di
   riferimento da riascoltare qui dentro.

   Lo scaricamento e la separazione voce/base non possono avvenire nel browser:
   servono yt-dlp e un modello di separazione (Demucs) che pesa centinaia di
   megabyte e gira su CPU o GPU. E la app sta su GitHub Pages, che è un
   server di file: non c'è nessun posto dove far girare quel lavoro.

   Quindi la divisione è questa: qui si compone il comando e si riascolta il
   risultato, il lavoro pesante lo fa `py/beatlab_extract.py` sul computer di
   chi lo usa. Nessun file esce da questa pagina. */

export const EXTRACT_DEFAULTS = {
  url: '', sep: '2', start: '', duration: '', bars: 2, slices: 'none',
};

/* virgolette e barre rovesciate in un URL incollato: quasi sempre un errore di
   copiatura, sempre un guaio nella riga di comando */
const clean = s => String(s || '').trim().replace(/[""'`\\]/g, '');

/* «1:12», «72», «1:02:30» → si lasciano passare; il resto si scarta */
const isTime = s => /^\d{1,2}(:\d{1,2}){0,2}(\.\d+)?$/.test(String(s || '').trim());

export function buildCommand(o = {}) {
  const p = { ...EXTRACT_DEFAULTS, ...o };
  const url = clean(p.url) || 'INCOLLA-QUI-IL-LINK';
  const parts = ['python3 py/beatlab_extract.py', `"${url}"`, '-o estratto'];
  if (p.sep === '2') parts.push('--two-stems');
  else if (p.sep === '0') parts.push('--no-separate');
  if (isTime(p.start)) parts.push('--start ' + String(p.start).trim());
  const d = parseFloat(p.duration);
  if (isFinite(d) && d > 0) parts.push('--duration ' + Math.round(d));
  if (+p.bars !== 2) parts.push('--bars ' + (+p.bars || 2));
  if (p.slices && p.slices !== 'none') parts.push('--slices ' + p.slices);
  return parts.join(' ');
}

/* ---------- traccia di riferimento ----------
   La voce estratta serve a una cosa sola ma importante: sentire se il beat
   regge *sotto qualcuno che canta*. Si carica qui, si sente sopra il pattern e
   non entra nell'export — è un metro, non un ingrediente. */
export const ref = { buf: null, name: '', gain: 0.9, offset: 0, on: true };

/* Un WAV decodificato occupa in memoria il doppio di quanto pesa su disco: sono
   float a 32 bit, non interi a 16. Tre minuti stereo fanno una sessantina di
   megabyte, e su un telefono è lì che Safari molla. */
export const REF_MAX_MB = 40;
export const refTooBig = file => file && file.size > REF_MAX_MB * 1024 * 1024;

export async function decodeReference(file) {
  return decodeReferenceData(await file.arrayBuffer(), file.name);
}

/* Stessa strada, partendo dai byte invece che da un File: dentro BeatLab Studio
   la voce non passa da un selettore, la porge il guscio appena l'estrazione
   finisce. Una sola funzione che decodifica, quindi un solo posto dove il
   riferimento può rompersi. */
export async function decodeReferenceData(data, name) {
  const Ctx = window.OfflineAudioContext || window.webkitOfflineAudioContext;
  const tmp = new Ctx(2, 1, 44100);
  const buf = await tmp.decodeAudioData(data);
  ref.buf = buf; ref.name = name;
  return buf;
}

export function clearReference() {
  ref.buf = null; ref.name = '';
}

export function refDuration() {
  return ref.buf ? ref.buf.duration : 0;
}
