# BeatLab Studio

La stessa app, in una finestra che ha accesso al computer.

Nel browser BeatLab può soltanto **scrivere** il comando dell'estrazione: una
pagina servita da GitHub Pages non ha modo di far girare yt-dlp o un modello di
separazione da trecento megabyte. Qui la pagina è la stessa — stesso
`index.html`, stessi moduli, stesso motore — ma è ospitata da un processo che
quei programmi può lanciarli. Il pannello «copia il comando» diventa un pulsante
**Estrai**, i lavori si mettono in fila, e a fine corsa il progetto e la voce
entrano nella app da soli.

## Come parte

```bash
cd desktop
npm install
npm start
```

Su Windows conviene lanciarlo **da dentro WSL** se è lì che hai Python e Demucs:
il guscio si accorge da solo di dove si trova. Se invece lo avvii da Windows,
passa per `wsl.exe` per ogni comando, e la cartella del progetto viene tradotta
con `wslpath`.

## Cosa fa in più

**Controllo delle dipendenze.** All'avvio interroga il Python scelto e dice cosa
c'è e cosa manca — Python, numpy, scipy, yt-dlp, Demucs, ffmpeg e il motore
JavaScript — con accanto il comando per installare quello che manca. Il motore
JavaScript è il pezzo meno ovvio: da qualche versione yt-dlp non scarica più da
YouTube senza, e l'errore che si ottiene è un `403` che sembra tutt'altro.

**Il Python giusto.** Le dipendenze pesanti quasi sempre vivono in un ambiente
virtuale. Lo Studio ne prova alcuni (`.venv` nel progetto, `~/.venv-beatlab`,
`python3` di sistema) e tiene il primo che ha `numpy` dentro; il campo in cima
al pannello lo cambia a mano e la scelta resta.

**Coda.** Uno alla volta, di proposito: due Demucs contemporanei si contendono
gli stessi core e finiscono più tardi di quanto ci avrebbero messo in fila. Ogni
lavoro tiene il proprio registro — quando qualcosa va storto, la riga che lo
dice è l'unica cosa che serve.

**Render.** `beatlab_render.py` sul progetto **aperto in quel momento**, non su
un file da ritrovare: lo Studio lo scrive in `render/progetto.json` e ci lancia
sopra lo script. Stem, MIDI e SoundFont dalle stesse caselle.

## Com'è fatto

```
desktop/
  main.js          finestra, ponte IPC, preferenze
  preload.js       l'unico punto di contatto fra pagina e sistema
  probe.sh         la sonda delle dipendenze, che gira dalla parte del Python
  lib/runner.js    come si raggiunge il Python: bash -lc, oppure wsl.exe
  lib/jobs.js      la coda e la costruzione dei comandi
  lib/server.js    server statico interno su 127.0.0.1
```

Dalla parte della app c'è un solo file nuovo, [`js/host.js`](../js/host.js), ed
è tutto dietro una condizione: se `window.beatlabHost` non esiste — cioè ovunque
tranne che qui dentro — non fa nulla. È il motivo per cui la versione su GitHub
Pages resta parola per parola quella di prima, e le 73 verifiche della suite
continuano a passare senza sapere che lo Studio esiste.

## Note

- la pagina è servita da `http://127.0.0.1` e non da `file://`: i moduli ES non
  si caricano da file, ed è anche il motivo per cui la finestra si comporta
  esattamente come il sito
- `contextIsolation` acceso, `nodeIntegration` spento, `sandbox` acceso: la
  pagina non ha `require`, non ha `fs`, e non può costruirsi un comando — manda
  domande già formate e il processo principale decide
- niente esce dal computer: lo Studio non parla con nessun server se non con il
  proprio, e i comandi che lancia sono gli stessi che lanceresti a mano
