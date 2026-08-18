/* BeatLab Studio — la stessa app, con le mani.

   Nel browser BeatLab può solo *scrivere* il comando da lanciare: una pagina
   servita da GitHub Pages non ha modo di far girare yt-dlp o Demucs, e non
   l'avrà mai. Qui la pagina è la stessa — stesso index.html, stessi moduli —
   ma è ospitata da un processo che il computer ce l'ha davvero. La differenza
   la fa `preload.js`, che appende a `window` un ponte: se la app lo trova,
   `js/host.js` trasforma il pannello «copia il comando» in pulsanti che
   eseguono. Se non lo trova, non cambia una virgola.

   È questo il motivo per cui il guscio non è un fork della app: la versione su
   Pages resta l'originale, e questa è la stessa cosa con un permesso in più. */

const { app, BrowserWindow, ipcMain, dialog, shell, Menu } = require('electron');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');

const { serve } = require('./lib/server');
const { Coda, cmdEstrazione, cmdRender } = require('./lib/jobs');
const { isWin, run, toPosixPath, listDistros, guessPythons } = require('./lib/runner');

/* la radice del progetto è la cartella che contiene questo guscio */
const RADICE = path.resolve(__dirname, '..');

let win = null, srv = null, porta = 0, coda = null, conf = null, radicePosix = RADICE;

/* ---------- preferenze ----------
   Poche e tutte su «dove sta il Python»: è l'unica cosa che cambia da computer
   a computer e l'unica che, se sbagliata, fa fallire tutto senza spiegazioni. */
const confFile = () => path.join(app.getPath('userData'), 'config.json');

async function leggiConf() {
  try { return JSON.parse(await fsp.readFile(confFile(), 'utf8')); }
  catch (e) { return {}; }
}
async function scriviConf(patch) {
  conf = { ...conf, ...patch };
  await fsp.mkdir(path.dirname(confFile()), { recursive: true });
  await fsp.writeFile(confFile(), JSON.stringify(conf, null, 2));
  return conf;
}

/* Il primo Python che risponde e ha numpy dentro. Si prova, non si indovina:
   `~/.venv-beatlab/bin/python3` esiste su questo computer e su nessun altro. */
async function trovaPython() {
  if (conf.python) return conf.python;
  let home = '~';
  await new Promise(res => {
    const { done } = run('printf %s "$HOME"', {
      distro: conf.distro, onLine: l => { if (l.trim()) home = l.trim(); },
    });
    done.then(res);
  });
  for (const cand of guessPythons(radicePosix, home)) {
    let ok = false;
    const { done } = run(`${JSON.stringify(cand)} -c 'import numpy' 2>/dev/null && echo SI`, {
      distro: conf.distro, onLine: l => { if (l.trim() === 'SI') ok = true; },
    });
    await done;
    if (ok) { await scriviConf({ python: cand }); return cand; }
  }
  return 'python3';
}

/* ---------- finestra ---------- */
async function creaFinestra() {
  const s = await serve(RADICE);
  srv = s.srv; porta = s.port;

  win = new BrowserWindow({
    width: 1420, height: 940, minWidth: 900, minHeight: 620,
    backgroundColor: '#0f1319',
    title: 'BeatLab Studio',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  coda = new Coda({
    onChange: ev => { if (win && !win.isDestroyed()) win.webContents.send('host:evento', ev); },
  });

  await win.loadURL(`http://127.0.0.1:${porta}/index.html`);
  win.on('closed', () => { win = null; });
}

function menu() {
  const modello = [
    { label: 'BeatLab', submenu: [
      { label: 'Apri la cartella del progetto', click: () => shell.openPath(RADICE) },
      { type: 'separator' },
      { role: 'reload', label: 'Ricarica' },
      { role: 'toggleDevTools', label: 'Strumenti di sviluppo' },
      { type: 'separator' },
      { role: 'quit', label: 'Esci' },
    ] },
    { role: 'editMenu', label: 'Modifica' },
    { role: 'windowMenu', label: 'Finestra' },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(modello));
}

/* ---------- ponte ---------- */
function ipc() {
  ipcMain.handle('host:info', async () => ({
    piattaforma: process.platform,
    tramiteWSL: isWin,
    distro: conf.distro || (isWin ? (listDistros()[0] || '') : ''),
    distros: listDistros(),
    radice: RADICE,
    radicePosix,
    python: conf.python || await trovaPython(),
    jsRuntime: conf.jsRuntime || '',
    versione: app.getVersion(),
    electron: process.versions.electron,
  }));

  ipcMain.handle('host:conf', async (_e, patch) => (patch ? scriviConf(patch) : conf));

  ipcMain.handle('host:dipendenze', async () => {
    const py = conf.python || await trovaPython();
    let testo = '';
    const { done } = run(`bash ${JSON.stringify(radicePosix + '/desktop/probe.sh')} ${JSON.stringify(py)}`, {
      cwd: radicePosix, distro: conf.distro,
      onLine: (l, dove) => { if (dove === 'out') testo += l + '\n'; },
    });
    await done;
    try { return { ok: true, dip: JSON.parse(testo) }; }
    catch (e) { return { ok: false, errore: 'sonda illeggibile', grezzo: testo.slice(0, 2000) }; }
  });

  ipcMain.handle('host:estrai', async (_e, o) => {
    const python = conf.python || await trovaPython();
    const jsRuntime = o.jsRuntime || conf.jsRuntime || '';
    const out = (o.out || 'estratto').replace(/[^\w.\-/]/g, '_');
    return coda.aggiungi({
      tipo: 'estrazione',
      titolo: o.titolo || o.source,
      cmd: cmdEstrazione({ ...o, out, python, jsRuntime }),
      cwd: radicePosix, distro: conf.distro, outDir: out,
    });
  });

  ipcMain.handle('host:render', async (_e, o) => {
    const python = conf.python || await trovaPython();
    /* Si renderizza il progetto *aperto adesso*, non un file scelto su disco:
       è quasi sempre quello che si vuole, e toglie di mezzo il passaggio
       «esporta il JSON, poi ricordati dove l'hai messo». Lo scriviamo noi. */
    if (o.progetto) {
      const dest = path.resolve(RADICE, o.json || 'render/progetto.json');
      if (!dest.startsWith(RADICE)) throw new Error('fuori dalla cartella del progetto');
      await fsp.mkdir(path.dirname(dest), { recursive: true });
      await fsp.writeFile(dest, JSON.stringify(o.progetto, null, 1));
    }
    return coda.aggiungi({
      tipo: 'render',
      titolo: o.titolo || path.basename(o.json || 'progetto.json'),
      cmd: cmdRender({ ...o, python }),
      cwd: radicePosix, distro: conf.distro,
      outDir: path.dirname(o.out || 'render.wav'),
    });
  });

  ipcMain.handle('host:lavori', () => coda.spoglia());
  ipcMain.handle('host:righe', (_e, id) => coda.righe(id));
  ipcMain.handle('host:annulla', (_e, id) => coda.annulla(id));
  ipcMain.handle('host:pulisci', () => { coda.pulisci(); return true; });

  /* Il risultato di un'estrazione: il progetto pronto da caricare e l'elenco
     di quello che c'è nella cartella, con i pesi — perché la voce da mettere
     come riferimento va scelta sapendo quanto occupa. */
  ipcMain.handle('host:risultato', async (_e, outDir) => {
    const dir = path.join(RADICE, outDir || 'estratto');
    const fuori = { progetto: null, file: [], dir, resoconto: '' };
    try {
      fuori.progetto = JSON.parse(await fsp.readFile(path.join(dir, 'progetto.json'), 'utf8'));
    } catch (e) {}
    try {
      fuori.resoconto = await fsp.readFile(path.join(dir, 'estrazione.md'), 'utf8');
    } catch (e) {}
    try {
      for (const nome of await fsp.readdir(dir)) {
        const st = await fsp.stat(path.join(dir, nome));
        if (st.isFile()) fuori.file.push({ nome, byte: st.size });
      }
    } catch (e) {}
    return fuori;
  });

  /* L'audio arriva come byte grezzi e lo decodifica la app con lo stesso
     percorso di un file scelto a mano: una via sola per la traccia di
     riferimento, quindi un solo posto dove può rompersi. */
  ipcMain.handle('host:audio', async (_e, rel) => {
    const file = path.resolve(RADICE, rel);
    if (!file.startsWith(RADICE)) throw new Error('fuori dalla cartella del progetto');
    const b = await fsp.readFile(file);
    return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
  });

  ipcMain.handle('host:apri', (_e, rel) => shell.openPath(path.resolve(RADICE, rel || '.')));

  ipcMain.handle('host:scegliFile', async (_e, o = {}) => {
    const r = await dialog.showOpenDialog(win, {
      title: o.titolo || 'Scegli un file',
      properties: ['openFile'],
      filters: o.filtri || [{ name: 'Audio', extensions: ['wav', 'mp3', 'm4a', 'flac', 'ogg', 'opus'] }],
    });
    if (r.canceled || !r.filePaths[0]) return '';
    /* dentro la cartella del progetto si usa il percorso relativo: il comando
       gira lì e resta leggibile */
    const p = r.filePaths[0];
    return p.startsWith(RADICE) ? path.relative(RADICE, p).replace(/\\/g, '/') : toPosixPath(p, conf.distro);
  });
}

app.whenReady().then(async () => {
  conf = await leggiConf();
  radicePosix = toPosixPath(RADICE, conf.distro);
  menu();
  ipc();
  await creaFinestra();

  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) creaFinestra(); });
});

app.on('window-all-closed', () => {
  if (srv) srv.close();
  if (process.platform !== 'darwin') app.quit();
});
