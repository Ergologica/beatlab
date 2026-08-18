/* La coda.

   Un'estrazione su CPU costa minuti, e due Demucs contemporanei non vanno il
   doppio più veloci: si contendono gli stessi core e finiscono più tardi di
   quanto ci avrebbero messo in fila. Quindi **uno alla volta**, sul serio, e
   l'attesa la si spende mettendo in coda il resto invece di stare a guardare.

   Ogni lavoro tiene le proprie righe di output. Non è per bellezza: quando
   qualcosa va storto — un 403, un modello che non si scarica, un formato che
   ffmpeg non digerisce — la riga che lo dice è l'unica cosa che serve, e
   ritrovarla in un unico registro comune è impossibile. */

const { run, kill, q } = require('./runner');

/* Le tappe che `beatlab_extract.py` annuncia stampandole. Riconoscerle serve a
   dire «sta separando» invece di «sta lavorando»: la differenza fra un'attesa
   che si capisce e una che preoccupa. */
const TAPPE = [
  [/^scarico/i, 'scarico il video'],
  [/^separo le tracce/i, 'separo voce e base (Demucs)'],
  [/^separazione saltata/i, 'analizzo'],
  [/^analizzo/i, 'analizzo'],
  [/fette in /i, 'taglio le fette'],
  [/BPM/, 'finisco'],
];

let seq = 0;

class Coda {
  constructor({ onChange }) {
    this.lavori = [];
    this.attivo = null;
    this.onChange = onChange;
  }

  aggiungi(job) {
    const j = {
      id: ++seq,
      tipo: job.tipo,              // 'estrazione' | 'render'
      titolo: job.titolo,
      cmd: job.cmd,
      cwd: job.cwd,
      distro: job.distro,
      outDir: job.outDir || '',
      stato: 'in attesa',          // in attesa | in corso | fatto | fallito | annullato
      tappa: '',
      righe: [],
      creato: Date.now(),
      iniziato: 0, finito: 0,
      codice: null,
    };
    this.lavori.push(j);
    this.onChange({ tipo: 'coda', lavori: this.spoglia() });
    this.avvia();
    return j.id;
  }

  spoglia() {
    /* verso la finestra va il riassunto, non i megabyte di registro: le righe
       si chiedono a parte, per il lavoro che si sta guardando */
    return this.lavori.map(j => ({
      id: j.id, tipo: j.tipo, titolo: j.titolo, stato: j.stato, tappa: j.tappa,
      outDir: j.outDir, creato: j.creato, iniziato: j.iniziato, finito: j.finito,
      codice: j.codice, righe: j.righe.length, cmd: j.cmd,
    }));
  }

  righe(id) {
    const j = this.lavori.find(x => x.id === id);
    return j ? j.righe : [];
  }

  avvia() {
    if (this.attivo) return;
    const j = this.lavori.find(x => x.stato === 'in attesa');
    if (!j) return;

    this.attivo = j;
    j.stato = 'in corso'; j.iniziato = Date.now(); j.tappa = 'avvio';
    this.onChange({ tipo: 'coda', lavori: this.spoglia() });

    const { child, done } = run(j.cmd, {
      cwd: j.cwd, distro: j.distro,
      onLine: (riga, dove) => {
        j.righe.push({ t: Date.now(), dove, riga });
        /* il registro non cresce all'infinito: Demucs stampa una barra di
           avanzamento che da sola fa migliaia di righe */
        if (j.righe.length > 4000) j.righe.splice(0, 1000);
        for (const [re, nome] of TAPPE) {
          if (re.test(riga)) { j.tappa = nome; break; }
        }
        this.onChange({ tipo: 'riga', id: j.id, riga, dove, tappa: j.tappa });
      },
    });
    j._child = child;

    done.then(codice => {
      j.codice = codice;
      j.finito = Date.now();
      if (j.stato !== 'annullato') j.stato = codice === 0 ? 'fatto' : 'fallito';
      j.tappa = '';
      j._child = null;
      this.attivo = null;
      this.onChange({ tipo: 'coda', lavori: this.spoglia() });
      this.onChange({ tipo: 'fine', id: j.id, stato: j.stato, outDir: j.outDir });
      this.avvia();
    });
  }

  annulla(id) {
    const j = this.lavori.find(x => x.id === id);
    if (!j) return false;
    if (j.stato === 'in attesa') { j.stato = 'annullato'; }
    else if (j.stato === 'in corso') { j.stato = 'annullato'; kill(j._child); }
    else return false;
    this.onChange({ tipo: 'coda', lavori: this.spoglia() });
    return true;
  }

  pulisci() {
    this.lavori = this.lavori.filter(j => j.stato === 'in corso' || j.stato === 'in attesa');
    this.onChange({ tipo: 'coda', lavori: this.spoglia() });
  }
}

/* ---------- costruzione dei comandi ----------
   Un solo posto in cui si decide come si chiama lo script, così le opzioni non
   si sparpagliano fra finestra e processo principale. Tutto ciò che arriva
   dalla finestra passa da `q()`: sono dati, non pezzi di shell. */

function cmdEstrazione(o) {
  const py = o.python || 'python3';
  const parts = [q(py), q('py/beatlab_extract.py'), q(o.source), '-o', q(o.out || 'estratto')];
  if (o.sep === '2') parts.push('--two-stems');
  else if (o.sep === '0') parts.push('--no-separate');
  if (o.start) parts.push('--start', q(o.start));
  if (o.duration) parts.push('--duration', q(String(Math.round(+o.duration))));
  if (+o.bars && +o.bars !== 2) parts.push('--bars', q(String(+o.bars)));
  if (o.slices && o.slices !== 'none') parts.push('--slices', q(o.slices));
  if (o.hatGate) parts.push('--hat-gate', q(String(+o.hatGate)));
  /* il motore JavaScript indicato per esteso: è quello che ha risolto il 403,
     e non dipendere dal PATH lo rende ripetibile */
  if (o.jsRuntime) parts.push('--ytdlp-arg=--js-runtimes', `--ytdlp-arg=${q(o.jsRuntime)}`);
  return parts.join(' ');
}

function cmdRender(o) {
  const py = o.python || 'python3';
  const parts = [q(py), q('py/beatlab_render.py'), q(o.json)];
  if (o.midiOnly) parts.push('--midi-only');
  else parts.push('-o', q(o.out || 'render.wav'));
  if (o.chain) parts.push('--chain', q(o.chain));
  if (o.stems) parts.push('--stems');
  if (o.midi) parts.push('--midi', q(o.midiFile || 'render.mid'));
  if (o.sf2) parts.push('--sf2', q(o.sf2));
  if (o.seed) parts.push('--seed', q(String(+o.seed)));
  return parts.join(' ');
}

module.exports = { Coda, cmdEstrazione, cmdRender };
