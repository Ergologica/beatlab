# BeatLab

Drum machine e synth nel browser, con un'anima sarda. Nessun sample: cassa,
launeddas, chitarra hardcore — ogni suono è sintetizzato in tempo reale con la
Web Audio API.

**▶ Prova subito: <https://ergologica.github.io/beatlab/>**

Si installa come app (menu del browser → *Installa BeatLab*) e da lì funziona
anche offline.

![icona](icons/icon-192.png)

## Cosa fa

- **Drum machine** a 8 tracce — cassa, rullante, clap, due hi-hat (il chiuso
  strozza l'aperto), tom, rim, **tumbarinu** (tamburo a cornice sardo, modi di
  membrana inarmonici + ronzio del cordino). Si disegna trascinando, con mouse
  o dita; pennello a quattro stati (colpo / accento / ghost / gomma).
- **Suddivisione per traccia**: 8, 12, 16 o 24 passi per battuta — 12 e 24 sono
  terzine vere, così il tumbarinu va in 12/8 sopra il 4/4.
- **5 strumenti melodici** su griglia vincolata alla scala: basso saturo,
  chitarra power chord con palm mute, synth lead, **launeddas** (monofoniche e
  legate: l'articolazione è un calo d'ampiezza, non un silenzio) e **canto a
  tenore** (raddoppio di periodo + formanti). Più il **bordone tumbu**
  attivabile per pattern.
- **Generatore di pattern** in cinque stili — boom bap, breakbeat hiphop,
  d-beat hardcore, ethno sardo, trap — con progressioni estratte dal modo
  scelto. Ogni generazione ha un **seed** riproducibile; **Variazione** crea
  una sezione B credibile dal pattern corrente.
- **Song mode**: 4 slot di pattern con lunghezze indipendenti + una catena
  (`AABA`, `AABACD`…).
- **Mix**: mixer per traccia, sidechain sulla cassa, due riverberi a
  convoluzione, bitcrush + riduzione di sample rate sul bus batteria,
  umanizzazione deterministica di tempo e dinamica.
- **Export**: MP3, WAV, **MIDI** (tipo 1, 480 PPQ, batteria General MIDI sul
  canale 10 — aprilo nel tuo DAW), JSON. Undo/redo a 60 passi e salvataggio
  automatico nel browser.
- **Modo leggero**, acceso da solo su telefoni e macchine modeste: voci con
  meno oscillatori e riverberi a rete di ritardi invece che a convoluzione.
  L'interruttore è in alto a destra. L'export resta sempre a qualità piena.

## Prestazioni

Il motore riusa le voci invece di crearle a ogni colpo: gli oscillatori di
cassa, rullante, hi-hat, tumbarinu, basso e chitarra restano accesi e ogni nota
riprogramma solo inviluppi e frequenze. Le catene fisse — cabinet, formanti,
filtri — sono costruite una volta e condivise. Lo scheduler batte in un Web
Worker, così i timer rallentati dal browser non aprono buchi nell'audio.

Misurato su un render offline di un pattern fitto (batteria a sedicesimi,
tumbarinu in 12/8, chitarra a ottavi, bordone):

| | prima | ora |
|---|---|---|
| modo pieno | 0,7× tempo reale | **6,2×** |
| modo leggero | — | **11,4×** |

Sotto 1× il telefono non sta dietro: era quello il problema.

## Il motore Python

In [`py/beatlab_render.py`](py/beatlab_render.py) c'è un renderer offline ad
alta qualità che legge il JSON esportato dalla app: oscillatori a banda
limitata (niente aliasing), filtri biquad RBJ, riverbero a convoluzione FFT,
stem separati, export MIDI.

```bash
pip install numpy scipy

python3 py/beatlab_render.py examples/demo-pattern.json -o beat.mp3
python3 py/beatlab_render.py pattern.json -o beat.wav --sr 48000 --chain AABACD
python3 py/beatlab_render.py pattern.json -o beat.flac --repeat 4 --stems
python3 py/beatlab_render.py pattern.json --midi-only --midi beat.mid
```

L'estensione decide il formato (`.wav` nativo; `.mp3`/`.flac`/`.ogg` via
ffmpeg). L'anteprima del browser e il render Python condividono i **dati**, non
il suono: il browser è la bozza, Python il master.

## Formato dati

Tutto passa per un JSON di testo, `beatlab/2` — pattern, suddivisioni, mixer,
effetti, seed. Documentato in [`docs/FORMATO.md`](docs/FORMATO.md). Si può
scrivere a mano o generare da script.

## Sviluppo

Niente build, niente dipendenze: moduli ES nativi.

```bash
git clone https://github.com/Ergologica/beatlab
cd beatlab
python3 -m http.server 8000   # i moduli ES non si caricano da file://
# → http://localhost:8000
```

I file: `js/engine.js` (sintesi), `js/state.js` (progetto, undo, autosave),
`js/audio.js` (scheduler e render offline), `js/generator.js`,
`js/exporters.js` (WAV/MP3/MIDI), `js/ui.js`, `sw.js` (offline).

## Licenze

Codice di BeatLab: **MIT** ([LICENSE](LICENSE)).
L'encoder MP3 è **LAME** nel port JavaScript
[lamejs](https://github.com/zhuker/lamejs) (LGPL —
<https://lame.sourceforge.net>), incluso non modificato come file separato
`lame.min.js`, come chiede la licenza.
