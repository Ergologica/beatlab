/* BeatLab dentro il guscio desktop: gli stessi pannelli, ma i comandi partono.

   Tutto questo file è dietro un solo controllo: se `window.beatlabHost` non
   c'è — cioè ovunque tranne che dentro BeatLab Studio — `initHost()` esce
   subito e la app resta *identica* a quella su GitHub Pages. È una condizione
   voluta, non una precauzione: la versione pubblica non deve poter cambiare
   comportamento per colpa di un file che parla con un processo che non esiste.

   Quello che si guadagna qui dentro: le dipendenze si vedono invece di
   scoprirle sbagliando, l'estrazione parte da un pulsante, la coda macina
   mentre si lavora al beat, e quando un lavoro finisce il progetto e la voce
   entrano nella app da soli — senza il giro «apri la cartella, trova il file,
   caricalo». */

export const hasHost = () => typeof window !== 'undefined' && !!window.beatlabHost;

const el = (tag, attrs = {}, ...figli) => {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') n.className = v;
    else if (k === 'style') n.style.cssText = v;
    else if (k.startsWith('on')) n[k] = v;
    else n.setAttribute(k, v);
  }
  for (const f of figli.flat()) if (f != null) n.append(f);
  return n;
};

const durata = ms => {
  const s = Math.round(ms / 1000);
  return s < 60 ? s + ' s' : Math.floor(s / 60) + ' m ' + String(s % 60).padStart(2, '0') + ' s';
};

const DIP = [
  ['python', 'Python'], ['numpy', 'numpy'], ['scipy', 'scipy'],
  ['ytdlp', 'yt-dlp'], ['demucs', 'Demucs'], ['ffmpeg', 'ffmpeg'],
  ['jsruntime', 'motore JS'],
];

/* Il rimedio per ogni assenza, scritto una volta sola. Sono le righe che
   servivano davvero quando l'estrazione non partiva: sapere *quale* pezzo
   manca conta meno che sapere cosa scrivere per averlo. */
const RIMEDI = {
  numpy: 'pip install numpy scipy',
  scipy: 'pip install numpy scipy',
  ytdlp: 'pip install -U "yt-dlp[default]"',
  demucs: 'pip install demucs',
  ffmpeg: 'sudo apt install -y ffmpeg',
  jsruntime: 'sudo apt install -y unzip && curl -fsSL https://deno.land/install.sh | sh -s -- -y',
  python: 'indica qui sopra il python dell\'ambiente giusto',
};

export function initHost(api) {
  if (!hasHost()) return false;
  const H = window.beatlabHost;
  const sez = document.querySelector('section[data-sec="esporta"]');
  if (!sez) return false;

  document.body.classList.add('in-studio');
  stile();

  let info = {}, lavori = [], apertoId = 0;

  /* ---------- 1. dipendenze ---------- */
  const dipRiga = el('div', { class: 'row', id: 'dipriga' }, el('span', { class: 'chip' }, 'controllo…'));
  const dipNota = el('p', { class: 'hint', id: 'dipnota' });
  const pyCampo = el('input', { type: 'text', id: 'hostpy', spellcheck: 'false', style: 'min-width:280px' });
  const pannelloDip = el('div', { class: 'panel' },
    el('h2', {}, 'Studio', el('span', { class: 'chip hide-sm', id: 'hostdove' }, '—')),
    el('div', { class: 'row' },
      el('div', { class: 'field', style: 'flex:1 1 320px' },
        el('label', {}, 'Python da usare (dove stanno numpy, Demucs e yt-dlp)'), pyCampo),
      el('button', { class: 'btn', onclick: salvaPython }, 'Usa questo'),
      el('button', { class: 'btn', onclick: () => controlla(true) }, '↻ Ricontrolla'),
      el('span', { class: 'spacer' }),
      el('button', { class: 'btn sm', onclick: () => H.apri('.') }, 'Apri la cartella')),
    dipRiga, dipNota);

  /* ---------- 2. coda ---------- */
  const codaLista = el('div', { id: 'codalista' });
  const codaLog = el('pre', { class: 'cmd', id: 'codalog', style: 'display:none;max-height:230px;overflow:auto' });
  const pannelloCoda = el('div', { class: 'panel' },
    el('h2', {}, 'Coda', el('span', { class: 'chip hide-sm' }, 'uno alla volta: due Demucs insieme non vanno più veloci')),
    codaLista, codaLog,
    el('div', { class: 'row' },
      el('button', { class: 'btn sm', onclick: () => H.pulisci().then(aggiornaLavori) }, 'Togli i finiti'),
      el('span', { class: 'spacer' })));

  /* ---------- 3. render ---------- */
  const rChain = el('input', { type: 'text', id: 'rchain', placeholder: 'come nel progetto', style: 'width:120px' });
  const rStems = el('input', { type: 'checkbox', id: 'rstems' });
  const rMidi = el('input', { type: 'checkbox', id: 'rmidi' });
  const rSf2 = el('input', { type: 'text', id: 'rsf2', placeholder: 'nessuno', style: 'min-width:180px' });
  const pannelloRender = el('div', { class: 'panel' },
    el('h2', {}, 'Render con il motore Python',
      el('span', { class: 'chip hide-sm' }, 'il browser è la bozza, Python il master')),
    el('div', { class: 'row' },
      el('div', { class: 'field' }, el('label', {}, 'Catena'), rChain),
      el('label', { class: 'ctl', style: 'flex-direction:row;gap:7px;align-items:center' }, rStems, 'stem separati'),
      el('label', { class: 'ctl', style: 'flex-direction:row;gap:7px;align-items:center' }, rMidi, 'anche MIDI'),
      el('div', { class: 'field', style: 'flex:1 1 200px' }, el('label', {}, 'SoundFont (.sf2)'), rSf2),
      el('button', { class: 'btn sm', onclick: scegliSf2 }, '…'),
      el('button', { class: 'btn primary', onclick: renderizza }, '⚙ Renderizza')),
    el('p', { class: 'hint' }, 'Renderizza il progetto aperto adesso, non un file su disco: '
      + 'lo Studio lo scrive in render/progetto.json e ci lancia sopra beatlab_render.py. '
      + 'Con un SoundFont il MIDI viene suonato da FluidSynth invece che dal motore di sintesi.'));

  sez.append(pannelloDip, pannelloCoda, pannelloRender);
  potenziaEstrazione();

  /* ---------- avvio ---------- */
  H.info().then(i => {
    info = i;
    pyCampo.value = i.python || '';
    document.getElementById('hostdove').textContent =
      (i.tramiteWSL ? 'Windows → WSL' + (i.distro ? ' (' + i.distro + ')' : '') : i.piattaforma)
      + ' · Electron ' + i.electron;
    controlla();
  });
  H.ascolta(ev => {
    if (ev.tipo === 'coda') { lavori = ev.lavori; disegnaCoda(); }
    else if (ev.tipo === 'riga') { if (ev.id === apertoId) aggiungiRiga(ev.riga, ev.dove); segnaTappa(ev.id, ev.tappa); }
    else if (ev.tipo === 'fine') finito(ev);
  });
  aggiornaLavori();

  /* ---------- dipendenze ---------- */
  async function salvaPython() {
    await H.conf({ python: pyCampo.value.trim() });
    api.toast('Python impostato. Ricontrollo…');
    controlla(true);
  }

  async function controlla(rumoroso) {
    dipRiga.replaceChildren(el('span', { class: 'chip' }, 'controllo…'));
    const r = await H.dipendenze();
    if (!r.ok) {
      dipRiga.replaceChildren(el('span', { class: 'chip bad' }, 'sonda fallita'));
      dipNota.textContent = r.grezzo || r.errore;
      return;
    }
    const mancano = [];
    dipRiga.replaceChildren(...DIP.map(([id, nome]) => {
      const d = r.dip[id] || { ok: false };
      if (!d.ok) mancano.push(id);
      return el('span', {
        class: 'chip ' + (d.ok ? 'good' : 'bad'),
        title: (d.note || '') + (d.version ? ' · ' + d.version : ''),
      }, (d.ok ? '✓ ' : '✗ ') + nome + (d.ok && d.version ? ' ' + d.version : ''));
    }));
    dipNota.replaceChildren(...(mancano.length
      ? [el('span', {}, 'Manca qualcosa. Nel terminale, con l’ambiente attivo:'),
         el('span', { class: 'cmd', style: 'display:block' },
           [...new Set(mancano.map(m => RIMEDI[m]).filter(Boolean))].join('\n')),
         el('span', {}, r.dip.demucs && !r.dip.demucs.ok
           ? 'Senza Demucs l’estrazione funziona lo stesso, ma con «separazione: nessuna».' : '')]
      : [el('span', {}, 'Tutto a posto: l’estrazione può partire da qui.')]));
    if (rumoroso) api.toast(mancano.length ? mancano.length + ' dipendenze mancano' : 'Tutto a posto');
  }

  /* ---------- estrazione ---------- */
  function potenziaEstrazione() {
    const copia = document.getElementById('ytcopy');
    if (!copia) return;
    /* il tasto «copia» resta, in fondo: serve ancora a chi vuole lanciarlo a
       mano o mandarselo altrove. Ma non è più la cosa principale. */
    copia.classList.remove('primary');
    copia.textContent = '⧉ Copia';
    const dopo = el('span', {},
      el('button', { class: 'btn primary', id: 'ytgo', onclick: () => accoda(true) }, '▶ Estrai'),
      el('button', { class: 'btn', id: 'ytqueue', onclick: () => accoda(false) }, '＋ In coda'),
      el('button', { class: 'btn', id: 'ytlocal', onclick: fileLocale }, '📂 File locale…'));
    copia.parentNode.insertBefore(dopo, copia);
    const chip = copia.parentNode.querySelector('.chip');
    if (chip) chip.remove();
  }

  const v = id => (document.getElementById(id) || {}).value || '';

  function cartellaLibera() {
    const usate = new Set(lavori.map(j => j.outDir));
    if (!usate.has('estratto')) return 'estratto';
    for (let n = 2; ; n++) if (!usate.has('estratto-' + n)) return 'estratto-' + n;
  }

  async function accoda(subito) {
    const source = v('yturl').trim();
    if (!source) { api.toast('Serve un link, oppure scegli un file locale.'); return; }
    const id = await H.estrai({
      source, sep: v('ytsep'), start: v('ytstart'), duration: v('ytdur'),
      bars: v('ytbars'), slices: v('ytslices'), out: cartellaLibera(),
      titolo: source.length > 60 ? source.slice(0, 57) + '…' : source,
    });
    apertoId = subito ? id : apertoId;
    api.toast(subito ? 'Estrazione avviata: la vedi nella coda qui sotto.' : 'Messa in coda.');
  }

  async function fileLocale() {
    const p = await H.scegliFile({ titolo: 'Scegli un file audio da analizzare' });
    if (!p) return;
    const campo = document.getElementById('yturl');
    campo.value = p;
    campo.dispatchEvent(new Event('input'));
    api.toast('File scelto. Premi ▶ Estrai.');
  }

  /* ---------- coda ---------- */
  async function aggiornaLavori() { lavori = await H.lavori(); disegnaCoda(); }

  function segnaTappa(id, tappa) {
    const n = document.getElementById('tappa-' + id);
    if (n && tappa) n.textContent = tappa;
  }

  const COLORE = { 'in attesa': '', 'in corso': 'good', fatto: 'good', fallito: 'bad', annullato: '' };

  function disegnaCoda() {
    if (!lavori.length) {
      codaLista.replaceChildren(el('p', { class: 'hint' },
        'Niente in coda. Un’estrazione da un video di tre minuti, su CPU, costa qualche minuto: '
        + 'mettine in fila più d’una e intanto lavora al beat.'));
      return;
    }
    codaLista.replaceChildren(...lavori.slice().reverse().map(j => {
      const attivo = j.stato === 'in corso';
      const tempo = j.finito ? durata(j.finito - j.iniziato) : (j.iniziato ? durata(Date.now() - j.iniziato) : '');
      return el('div', { class: 'row lavoro' + (attivo ? ' attivo' : '') },
        el('span', { class: 'chip ' + (COLORE[j.stato] || '') }, j.stato),
        el('b', { style: 'font-size:12px;font-weight:600' }, (j.tipo === 'render' ? '⚙ ' : '↓ ') + j.titolo),
        el('span', { class: 'chip', id: 'tappa-' + j.id }, j.tappa || ''),
        tempo ? el('span', { class: 'chip' }, tempo) : null,
        el('span', { class: 'spacer' }),
        j.stato === 'fatto' && j.tipo === 'estrazione'
          ? el('button', { class: 'btn sm primary', onclick: () => raccogli(j.outDir) }, '↥ Porta nella app') : null,
        j.stato === 'fatto'
          ? el('button', { class: 'btn sm', onclick: () => H.apri(j.outDir) }, 'Apri') : null,
        el('button', { class: 'btn sm', onclick: () => mostraLog(j.id) }, 'Registro'),
        (j.stato === 'in corso' || j.stato === 'in attesa')
          ? el('button', { class: 'btn sm', onclick: () => H.annulla(j.id) }, 'Annulla') : null);
    }));
  }

  async function mostraLog(id) {
    apertoId = id;
    const righe = await H.righe(id);
    codaLog.style.display = '';
    codaLog.textContent = righe.map(r => r.riga).join('\n') || '(ancora niente)';
    codaLog.scrollTop = codaLog.scrollHeight;
  }
  function aggiungiRiga(riga) {
    if (codaLog.style.display === 'none') return;
    const attaccato = codaLog.scrollTop + codaLog.clientHeight >= codaLog.scrollHeight - 8;
    codaLog.textContent += (codaLog.textContent ? '\n' : '') + riga;
    if (attaccato) codaLog.scrollTop = codaLog.scrollHeight;
  }

  function finito(ev) {
    if (ev.stato === 'fatto') {
      api.toast('Fatto: ' + ev.outDir + '. Premi «Porta nella app» per caricarlo.');
      /* non si carica da soli: se stai lavorando a un pattern, vedertelo
         sostituire da sotto le mani sarebbe un agguato */
    } else if (ev.stato === 'fallito') {
      api.toast('Un lavoro è fallito. Guarda il registro: quasi sempre lo dice in chiaro.');
      mostraLog(ev.id);
    }
    aggiornaLavori();
  }

  /* ---------- dal risultato alla app ---------- */
  async function raccogli(dir) {
    const r = await H.risultato(dir);
    if (r.progetto) {
      api.applyProject(r.progetto);
      api.toast('Progetto caricato da ' + dir + '.');
    } else {
      api.toast('In ' + dir + ' non c’è progetto.json.');
    }
    const voce = (r.file || []).find(f => /^(voce|vocals)\.wav$/i.test(f.nome));
    if (voce) {
      if (voce.byte > 90 * 1024 * 1024) {
        api.toast('La voce pesa ' + Math.round(voce.byte / 1048576) + ' MB: la carico solo su richiesta.');
      } else {
        try {
          const buf = await H.audio(dir + '/' + voce.nome);
          await api.setReference(buf, voce.nome);
          api.toast('Voce caricata come riferimento: premi Play e la senti sopra il pattern.');
        } catch (e) { api.toast('La voce non si è caricata: ' + e.message); }
      }
    }
  }

  /* ---------- render ---------- */
  async function scegliSf2() {
    const p = await H.scegliFile({ titolo: 'Scegli un SoundFont', filtri: [{ name: 'SoundFont', extensions: ['sf2'] }] });
    if (p) rSf2.value = p;
  }

  async function renderizza() {
    const progetto = api.currentProject();
    await H.render({
      progetto, json: 'render/progetto.json', out: 'render/beat.wav',
      chain: rChain.value.trim(), stems: rStems.checked,
      midi: rMidi.checked, midiFile: 'render/beat.mid',
      sf2: rSf2.value.trim(), titolo: 'render/beat.wav',
    });
    api.toast('Render in coda.');
  }

  return true;
}

/* Poche regole, e tutte dentro la finestra: nel browser questo file non arriva
   mai a chiamarle. */
function stile() {
  const s = document.createElement('style');
  s.textContent = `
  .chip.good{background:#16311f;color:#7ee3a4;border-color:#245c37}
  .chip.bad{background:#341a1c;color:#ffa3a3;border-color:#6b2d31}
  .lavoro{padding:6px 0;border-bottom:1px solid var(--line);align-items:center}
  .lavoro:last-child{border-bottom:0}
  .lavoro.attivo{background:linear-gradient(90deg,rgba(90,200,255,.07),transparent)}
  #dipnota .cmd{margin:7px 0 0}`;
  document.head.append(s);
}
