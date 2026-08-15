# Il formato `beatlab/2`

Tutto lo stato di un progetto BeatLab sta in un file JSON di testo: lo esporta
la app (**↓ JSON**), lo legge la app (**↑ Carica JSON**) e lo legge il renderer
Python. Si può anche scrivere a mano o generare da script.

```jsonc
{
  "format": "beatlab/2",
  "bpm": 100,
  "swing": 0.14,                       // 0–0.6, applicato ai sedicesimi in levare
  "stepsPerBar": 16,
  "humanize": { "time": 0.35, "velocity": 0.30 },
  "root": 2,                           // 0=DO … 11=SI
  "rootName": "RE",
  "scale": "dorian",                   // dorian | minor | phrygian | minorpent | major | harmminor
  "seed": 0,
  "chain": "ABAC",                     // sequenza degli slot in song mode

  "patterns": [
    {
      "name": "A",
      "bars": 2,                       // ogni pattern ha la SUA lunghezza (1–8)
      "drone": true,                   // bordone tumbu acceso in questo pattern
      "droneNote": 38,                 // midi del bordone (tonica − 2 ottave)
      "seed": 1001,                    // seed con cui è stato generato (0 = a mano)
      "div":   { "kick": 16, "snare": 16, "tumb": 12 },   // passi per battuta, per traccia
      "drums": { "kick": [1, 0, 0, 0.55] },               // velocity per passo, lunghezza = bars × div
      "notes": { "bass": [ {"s": 0, "n": 38, "d": 3, "v": 1} ] }
      // s = passo (sedicesimi), n = nota midi, d = durata in passi, v = velocity
    }
  ],

  "mixer": {
    "kick": { "gain": 1.0, "pan": 0, "mute": false, "solo": false,
              "reverb": 0.05, "bus": "drum" }
    // bus: "drum" (batteria), "bassduck" (basso), "duck" (tutto il resto)
  },

  "fx": {
    "bits": 13,            // bitcrush del bus batteria (16 = off)
    "srDiv": 1,            // riduzione di sample rate (1 = off, 2–16 = divisore)
    "drive": 1.6,          // saturazione del bus batteria
    "reverbShort": 0.85,   // mandata riverbero corto (batteria)
    "reverbLong": 0.85,    // mandata riverbero lungo (melodici)
    "sidechainDb": 3.5,    // profondità del duck sulla cassa
    "bassDuck": 0.45,      // quota del duck applicata al basso
    "master": 0.9
  },

  "synth": { "leadWave": "sawtooth", "guitarPalmMute": true }
}
```

## Le tracce

| id | traccia | nota GM (MIDI) |
|---|---|---|
| `kick` | cassa | 36 |
| `snare` | rullante | 38 |
| `clap` | clap | 39 |
| `hhc` | hi-hat chiuso | 42 |
| `hho` | hi-hat aperto | 46 |
| `tom` | tom | 45 |
| `rim` | rim/percussione | 37 |
| `tumb` | tumbarinu | 41 |
| `bass` | basso | canale 1, program 38 |
| `guitar` | chitarra | canale 2, program 30 |
| `lead` | lead | canale 3, program 81 |
| `laun` | launeddas | canale 4, program 68 |
| `ten` | canto a tenore | canale 5, program 52 |

Le velocity di batteria sono numeri liberi (tipicamente 0.42 = ghost,
0.9 = colpo, 1.25 = accento). `laun` è monofonica: le note non si sovrappongono.

## Suddivisioni e terzine

`div` dà a ogni traccia di batteria i suoi passi per battuta: 8, 12, 16 o 24.
Con 12 (o 24) i passi cadono sulle terzine — un array `tumb` di 24 valori su
2 battute con `div.tumb = 12` è un ritmo in 12/8 sopra il 4/4 delle altre
tracce. Gli strumenti melodici restano sempre sui sedicesimi.

## Retrocompatibilità

I file `beatlab/1` (senza `div` e `bars`, con `len` in sedicesimi) vengono
letti sia dalla app sia dal renderer, assumendo 16 passi per battuta.
