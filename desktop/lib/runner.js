/* Dove gira davvero il lavoro pesante.

   BeatLab Studio è una finestra Electron, ma yt-dlp, Demucs e numpy non stanno
   dentro Electron: stanno in un Python. Su Linux e su macOS quel Python è lì,
   a portata di spawn. Su Windows quasi mai: chi usa Demucs lo ha installato in
   WSL, perché è lì che le ruote compilate esistono e ffmpeg si installa con una
   riga. Quindi questo modulo ha un solo compito, e conviene che sia l'unico
   posto del programma che se ne preoccupa: prendere un comando scritto in
   POSIX e farlo arrivare dove il Python vive.

   La differenza fra i due casi è tutta in due righe (`bash -lc` contro
   `wsl.exe -e bash -lc`) più la traduzione dei percorsi. Il resto del
   programma non deve sapere su quale dei due si trova. */

const { spawn, execFileSync } = require('node:child_process');
const os = require('node:os');
const path = require('node:path');

const isWin = process.platform === 'win32';

/* `bash -lc` e non `bash -c`: la shell di login legge ~/.profile e ~/.bashrc,
   ed è lì che finiscono i PATH aggiunti a mano — Deno sotto ~/.deno/bin, per
   dirne uno che ci è costato mezz'ora. Con una shell non di login il comando
   funziona nel terminale e fallisce qui, che è il tipo di differenza che fa
   impazzire. */
function argv(cmd, distro) {
  if (!isWin) return ['bash', ['-lc', cmd]];
  const pre = distro ? ['-d', distro] : [];
  return ['wsl.exe', [...pre, '-e', 'bash', '-lc', cmd]];
}

/* Un percorso di Windows non significa niente dentro WSL. `wslpath` fa la
   traduzione meglio di qualunque espressione regolare: conosce le unità
   montate, i collegamenti e i casi strani come i percorsi UNC. */
function toPosixPath(p, distro) {
  if (!isWin) return p;
  try {
    const pre = distro ? ['-d', distro] : [];
    return execFileSync('wsl.exe', [...pre, 'wslpath', '-a', p],
      { encoding: 'utf8', windowsHide: true }).trim();
  } catch (e) {
    /* ripiego grezzo: C:\x\y → /mnt/c/x/y */
    const m = /^([A-Za-z]):[\\/](.*)$/.exec(p);
    return m ? '/mnt/' + m[1].toLowerCase() + '/' + m[2].replace(/\\/g, '/') : p;
  }
}

function listDistros() {
  if (!isWin) return [];
  try {
    /* wsl.exe --list parla UTF-16LE: letto come UTF-8 esce un nome ogni due
       caratteri nulli, e il confronto fallisce senza dire perché */
    const raw = execFileSync('wsl.exe', ['--list', '--quiet'], { windowsHide: true });
    return raw.toString('utf16le').split(/\r?\n/).map(s => s.trim()).filter(Boolean);
  } catch (e) { return []; }
}

/* Il singolo apice è l'unico modo affidabile di infilare un percorso dentro
   `bash -lc`: dentro non c'è espansione di nessun tipo. L'unico carattere che
   non può stare dentro è l'apice stesso, e si chiude e si riapre. */
const q = s => "'" + String(s).replace(/'/g, `'\\''`) + "'";

/* Lancia un comando e ne restituisce le righe man mano che escono, non alla
   fine: un Demucs che macina per otto minuti in silenzio è indistinguibile da
   un Demucs bloccato. */
function run(cmd, opts = {}) {
  const { cwd, distro, onLine = () => {}, env } = opts;
  const full = cwd ? `cd ${q(cwd)} && ${cmd}` : cmd;
  const [bin, args] = argv(full, distro);

  const child = spawn(bin, args, {
    windowsHide: true,
    /* gruppo di processi separato: Demucs si porta dietro dei figli, e
       ammazzare solo la shell li lascerebbe a macinare CPU a vuoto */
    detached: !isWin,
    env: { ...process.env, ...(env || {}) },
  });

  let buf = { out: '', err: '' };
  const feed = (which, chunk) => {
    buf[which] += chunk.toString();
    const parts = buf[which].split(/\r?\n/);
    buf[which] = parts.pop();
    for (const line of parts) onLine(line, which);
  };
  child.stdout.on('data', c => feed('out', c));
  child.stderr.on('data', c => feed('err', c));

  const done = new Promise(resolve => {
    child.on('close', code => {
      /* la coda senza a capo finale è comunque una riga */
      for (const which of ['out', 'err']) if (buf[which]) onLine(buf[which], which);
      resolve(code);
    });
    child.on('error', err => { onLine('impossibile avviare: ' + err.message, 'err'); resolve(-1); });
  });

  return { child, done };
}

function kill(child) {
  if (!child || child.exitCode !== null) return;
  try {
    if (isWin) execFileSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true });
    else process.kill(-child.pid, 'SIGTERM');
  } catch (e) { try { child.kill('SIGKILL'); } catch (e2) {} }
}

/* Il Python giusto quasi mai è `python3` e basta: le dipendenze di BeatLab
   stanno in un ambiente virtuale, e fuori di lì mancano tutte. Si cercano i
   posti dove di solito sta, in ordine di quanto è probabile che sia quello. */
function guessPythons(repoPosix, homePosix) {
  const c = [
    `${repoPosix}/.venv/bin/python3`,
    `${repoPosix}/venv/bin/python3`,
    `${homePosix}/.venv-beatlab/bin/python3`,
    `${homePosix}/.venv/bin/python3`,
    'python3',
  ];
  return [...new Set(c)];
}

module.exports = { isWin, run, kill, q, toPosixPath, listDistros, guessPythons };
