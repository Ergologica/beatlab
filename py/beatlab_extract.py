#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
beatlab_extract.py — dal link a un progetto BeatLab.

Scarica l'audio di un video, separa la voce dalla base, misura il tempo,
trascrive la batteria in una griglia BeatLab e taglia le fette da campionare.

    python3 beatlab_extract.py "https://www.youtube.com/watch?v=..." -o estratto
    python3 beatlab_extract.py URL --two-stems --start 1:12 --duration 30
    python3 beatlab_extract.py brano.wav --no-separate --slices hits

Esce con:

    estratto/originale.wav      l'audio scaricato (o l'ingresso convertito)
    estratto/voce.wav           la voce sola
    estratto/base.wav           tutto tranne la voce      (--two-stems)
    estratto/batteria.wav       batteria, basso, altro    (separazione a 4)
    estratto/progetto.json      pattern pronto: si carica in BeatLab
    estratto/fette/…            battute o colpi singoli, numerati
    estratto/estrazione.md      cosa ha trovato e con quanta sicurezza

Serve:
    pip install yt-dlp demucs          (più numpy e scipy, già usati dal render)
    ffmpeg nel PATH

La separazione la fa Demucs (Meta, licenza MIT), il download yt-dlp. Nessuno
dei due è incluso qui: si installano a parte. L'analisi — tempo, onset,
trascrizione, fette — è tutta in questo file, con numpy e scipy soltanto.

Una nota che non è un cavillo: scaricare da YouTube va contro i termini di
servizio del sito, e quello che esce da qui resta materiale di qualcun altro.
Per lavorarci sopra sul serio servono i diritti — un brano tuo, una base
libera, un pezzo autorizzato — o la licenza del campione. Lo strumento non
sa distinguere: lo sai tu.
"""
import argparse, json, math, os, re, shutil, subprocess, sys, tempfile
from collections import Counter

import numpy as np

SR = 44100
HOP = 512
WIN = 2048

# bande di analisi: ogni strumento della batteria si annuncia in una zona sua
BANDS = {
    'kick':  (25.0, 130.0),
    'snare': (180.0, 1800.0),
    'hat':   (6000.0, 15000.0),
}


# ----------------------------------------------------------------------------
# utilità di sistema
# ----------------------------------------------------------------------------
def have(cmd):
    return shutil.which(cmd) is not None


def run(cmd, what, binary=False):
    """esegue e, se fallisce, dice cosa mancava invece di un traceback.

    binary=True quando l'uscita è audio grezzo: decodificarla come testo la
    rompe al primo campione che non è UTF-8."""
    try:
        p = subprocess.run(cmd, capture_output=True, text=not binary)
    except FileNotFoundError:
        sys.exit(f"manca «{cmd[0]}»: serve per {what}.")
    if p.returncode != 0:
        err = p.stderr if not binary else (p.stderr or b'').decode('utf-8', 'replace')
        tail = (err or '').strip().splitlines()[-12:]
        sys.exit(f"{what} non è riuscito:\n  " + "\n  ".join(tail))
    return p


def timecode(s):
    """accetta 75, 1:15, 00:01:15.5"""
    if s is None:
        return None
    s = str(s).strip()
    if not s:
        return None
    parts = s.split(':')
    try:
        v = 0.0
        for p in parts:
            v = v * 60.0 + float(p)
    except ValueError:
        raise argparse.ArgumentTypeError(f"tempo non valido: {s}")
    return v


# ----------------------------------------------------------------------------
# audio
# ----------------------------------------------------------------------------
def load_audio(path, sr=SR):
    """decodifica con ffmpeg: qualunque formato entra, esce float stereo"""
    cmd = ['ffmpeg', '-v', 'error', '-i', str(path),
           '-f', 'f32le', '-acodec', 'pcm_f32le', '-ac', '2', '-ar', str(sr), '-']
    p = run(cmd, 'la lettura dell\'audio', binary=True)
    x = np.frombuffer(p.stdout, dtype='<f4').astype(np.float64)
    if x.size == 0:
        sys.exit(f"{path}: audio vuoto o illeggibile.")
    return x.reshape(-1, 2)


def save_wav(path, x, sr=SR):
    """WAV 16 bit; x è (n,) mono o (n,2) stereo"""
    x = np.asarray(x, dtype=np.float64)
    if x.ndim == 1:
        x = x[:, None]
    peak = float(np.max(np.abs(x))) if x.size else 0.0
    if peak > 1.0:
        x = x / peak
    d = np.clip(x, -1.0, 1.0)
    pcm = (d * 32767.0).astype('<i2')
    n, ch = pcm.shape
    hdr = bytearray()
    hdr += b'RIFF' + (36 + n * ch * 2).to_bytes(4, 'little') + b'WAVE'
    hdr += b'fmt ' + (16).to_bytes(4, 'little') + (1).to_bytes(2, 'little')
    hdr += ch.to_bytes(2, 'little') + sr.to_bytes(4, 'little')
    hdr += (sr * ch * 2).to_bytes(4, 'little') + (ch * 2).to_bytes(2, 'little')
    hdr += (16).to_bytes(2, 'little')
    hdr += b'data' + (n * ch * 2).to_bytes(4, 'little')
    os.makedirs(os.path.dirname(os.path.abspath(path)) or '.', exist_ok=True)
    with open(path, 'wb') as f:
        f.write(bytes(hdr))
        f.write(pcm.tobytes())


def mono(x):
    return x.mean(axis=1) if x.ndim > 1 else x


# ----------------------------------------------------------------------------
# spettro, energie di banda, novità
# ----------------------------------------------------------------------------
def stft_mag(x, win=WIN, hop=HOP):
    """spettrogramma di ampiezza, finestra di Hann, senza dipendenze esterne"""
    x = np.asarray(x, dtype=np.float64)
    if x.size < win:
        x = np.pad(x, (0, win - x.size))
    n = 1 + (x.size - win) // hop
    idx = np.arange(win)[None, :] + hop * np.arange(n)[:, None]
    frames = x[idx] * np.hanning(win)[None, :]
    return np.abs(np.fft.rfft(frames, axis=1))


def frame_time(p, sr=SR, hop=HOP, win=WIN):
    """il tempo di un fotogramma è il suo centro, non il suo inizio.

    Con la finestra di Hann il flusso culmina quando il colpo passa per il
    centro della finestra: contare dall'inizio lo anticipa di 23 ms, che a 96
    BPM è un sesto di sedicesimo — abbastanza per far slittare tutta la griglia."""
    return (np.asarray(p) * hop + win / 2.0) / sr


def band_energy(mag, lo, hi, sr=SR, win=WIN):
    freqs = np.fft.rfftfreq(win, 1.0 / sr)
    sel = (freqs >= lo) & (freqs <= hi)
    if not sel.any():
        return np.zeros(mag.shape[0])
    return (mag[:, sel] ** 2).sum(axis=1)


def novelty(e, k=21):
    """crescita dell'energia, in scala logaritmica e senza la linea di fondo.

    Il logaritmo mette sullo stesso piano un colpo piano e uno forte; togliere
    la media mobile evita che un pezzo denso alzi la soglia fino ad annegare i
    colpi deboli."""
    m = np.log1p(e / (np.median(e[e > 0]) if np.any(e > 0) else 1.0))
    d = np.maximum(np.diff(m, prepend=m[:1]), 0.0)
    base = np.convolve(d, np.ones(k) / k, mode='same')
    return np.maximum(d - base, 0.0)


def pick_peaks(f, min_gap, thresh_k=1.6):
    """picchi sopra mediana + k·MAD, con distanza minima fra loro"""
    if f.size == 0:
        return np.array([], dtype=int)
    med = np.median(f)
    mad = np.median(np.abs(f - med)) or (f.std() or 1e-9)
    thr = med + thresh_k * 1.4826 * mad
    cand = np.where((f > thr) & (f >= np.roll(f, 1)) & (f > np.roll(f, -1)))[0]
    out = []
    for i in cand:
        if out and i - out[-1] < min_gap:
            if f[i] > f[out[-1]]:
                out[-1] = i
            continue
        out.append(int(i))
    return np.array(out, dtype=int)


# ----------------------------------------------------------------------------
# riconoscimento dei colpi
# ----------------------------------------------------------------------------
def detect_hits(mag, hat_gate=0.06, snare_gate=0.22, sr=SR, hop=HOP):
    """Cassa, rullante e hi-hat, ognuno con la sua banda.

    Il flusso da solo non basta: la cassa sfonda in tutte le bande (la coda del
    riverbero, la saturazione del bus) e finirebbe scritta anche sulle righe
    degli altri. Quello che separa davvero è **come si distribuisce l'energia**:
    una cassa mette il 95% sotto i 140 Hz, un rullante il 70% fra 200 e 2000, un
    hi-hat quasi tutto sopra i 5 kHz. Il picco lo trova il flusso, la riga la
    decide la frazione."""
    E = {
        'low': band_energy(mag, 20.0, 140.0),
        'mid': band_energy(mag, 200.0, 2000.0),
        'hi':  band_energy(mag, 5000.0, 16000.0),
    }
    tot = E['low'] + E['mid'] + E['hi'] + 1e-12
    gap = max(int(0.045 * sr / hop), 1)
    out = {}
    rules = {  # banda, frazione minima sua, frazione massima dei bassi
        'kick':  ('low', 0.50, 1.01),
        'snare': ('mid', snare_gate, 0.80),
        'hat':   ('hi',  hat_gate, 1.01),
    }
    for name, (band, frac_min, low_max) in rules.items():
        nv = novelty(E[band])
        peaks = pick_peaks(nv, gap, 1.5)
        keep, vel = [], []
        for p in peaks:
            w = slice(p, min(p + 5, len(tot)))
            e = {k: float(E[k][w].max()) for k in E}
            s = e['low'] + e['mid'] + e['hi'] + 1e-12
            if e[band] / s < frac_min or e['low'] / s > low_max:
                continue
            keep.append(int(p))
            vel.append(e[band])
        if not keep:
            out[name] = {'frames': np.array([], dtype=int), 'energy': np.array([])}
            continue
        vel = np.array(vel)
        # colpi ridicolmente più deboli del resto: quasi sempre rimbombo altrui
        floor = 0.02 * np.percentile(vel, 90)
        sel = vel >= floor
        out[name] = {'frames': np.array(keep)[sel], 'energy': vel[sel]}
    out['_bands'] = E
    return out


def open_hat_mask(E_hi, frames, sr=SR, hop=HOP):
    """Aperto o chiuso, dalla coda: 110 ms dopo, l'aperto suona ancora.

    La soglia non può essere fissa — dipende da quanto è brillante il disco — ma
    relativa alla mediana degli hi-hat di quel pezzo. E resta severa di
    proposito: un aperto scritto per sbaglio continua a ronzare sotto tutto,
    mentre un aperto scritto chiuso si sente subito e si corregge con un click."""
    if len(frames) == 0:
        return np.array([], dtype=bool)
    span = max(int(0.11 * sr / hop), 2)
    r = np.array([float(E_hi[min(p + span, E_hi.size - 1)]) / max(float(E_hi[p]), 1e-9)
                  for p in frames])
    thr = max(8.0 * float(np.median(r)), 0.06)
    return r > thr


# ----------------------------------------------------------------------------
# tempo e griglia
# ----------------------------------------------------------------------------
def estimate_bpm(env, sr=SR, hop=HOP, lo=60.0, hi=200.0):
    """autocorrelazione della curva di onset, poi scelta dell'ottava giusta.

    L'autocorrelazione da sola sbaglia spesso di un fattore due: mezzo tempo e
    doppio tempo hanno picchi quasi identici. Il pettine di conferma guarda
    quanto la curva si accende davvero sui battiti, e una preferenza morbida per
    la fascia in cui vive quasi tutto l'hiphop rompe la parità."""
    e = env - env.mean()
    n = int(2 ** math.ceil(math.log2(max(e.size * 2, 2))))
    ac = np.fft.irfft(np.abs(np.fft.rfft(e, n)) ** 2)[:e.size]
    if ac[0] > 0:
        ac /= ac[0]
    fps = sr / hop
    lag_lo = max(int(fps * 60.0 / hi), 2)
    lag_hi = min(int(fps * 60.0 / lo), max(ac.size - 1, 3))
    if lag_hi <= lag_lo:
        return 100.0, 0.0
    seg = ac[lag_lo:lag_hi]
    order = np.argsort(seg)[::-1]

    def ac_at(bpm, slack=1):
        """valore dell'autocorrelazione al ritardo di questo tempo.

        Il ritardo è un numero intero di fotogrammi: fra un ritardo e il
        successivo, a 90 BPM, ballano più di un BPM. La finestrella recupera
        quello che l'arrotondamento butterebbe via."""
        lag = fps * 60.0 / bpm
        a, z = int(lag) - slack, int(lag) + slack + 1
        a, z = max(a, 1), min(z, ac.size)
        return float(ac[a:z].max()) if z > a else 0.0

    cands = set()
    for k in order[:14]:
        bpm = 60.0 * fps / (lag_lo + k)
        for mult in (0.5, 1.0, 2.0):
            b = bpm * mult
            if lo <= b <= hi:
                cands.add(round(b, 2))
    if not cands:
        return 100.0, 0.0
    scored = []
    for b in cands:
        # preferenza morbida per la fascia in cui vive quasi tutto l'hiphop:
        # serve solo a rompere la parità fra un tempo e il suo doppio
        pref = 1.0 - 0.28 * min(abs(math.log(b / 112.0)) / math.log(2.0), 1.0)
        scored.append((ac_at(b) * pref, b))
    scored.sort(reverse=True)
    top = scored[0][0]
    # il secondo che conta è quello di un'altra famiglia, non il vicino di ritardo
    second = 0.0
    for s, b in scored[1:]:
        if abs(b - scored[0][1]) / scored[0][1] > 0.04:
            second = s
            break
    conf = 0.0 if top <= 0 else float(min(1.0, max((top - second) / top, 0.0) + 0.3))
    return float(scored[0][1]), conf


def fit_grid(times, weights, bpm0, span=0.05, steps=16):
    """Affina tempo e fase sui colpi veri, non sui fotogrammi.

    Se tutti i colpi cadono su multipli del sedicesimo, i loro vettori
    exp(2πi·t/T) puntano nella stessa direzione: il T che allunga di più la
    somma è il passo giusto, e l'angolo che ne esce è la fase. Mezzo per cento
    di errore sul tempo, su tre minuti, è mezza battuta di scarto: questa
    seconda passata serve a togliere proprio quello."""
    t = np.asarray(times, dtype=np.float64)
    w = np.asarray(weights, dtype=np.float64)
    if t.size < 4:
        return bpm0, 0.0, 0.0
    w = np.sqrt(np.maximum(w, 0.0))
    w = w / (w.max() or 1.0)
    best = (-1.0, bpm0, 0.0)
    for bpm in np.linspace(bpm0 * (1 - span), bpm0 * (1 + span), 801):
        T = 60.0 / bpm / (steps / 4.0)
        z = np.sum(w * np.exp(2j * np.pi * t / T))
        if abs(z) > best[0]:
            phase = (math.atan2(z.imag, z.real) / (2 * math.pi)) * T
            best = (abs(z), float(bpm), float(phase % T))
    strength, bpm, phase = best
    return bpm, phase, float(strength / (w.sum() or 1.0))


def downbeat(kick_t, snare_t, phase, bpm):
    """Quale dei quattro battiti è l'uno.

    Non basta «dove batte la cassa»: la cassa sta volentieri anche sul tre, e
    pesarla con un coseno di periodo quattro punisce il tre come se fosse un
    errore. Il segno vero è la coppia: cassa su uno e tre, rullante su due e
    quattro. Quando il pattern è simmetrico resta un'ambiguità di mezza battuta
    che nessun conto risolve — lì si sceglie la prima e si scrive nel resoconto."""
    beat = 60.0 / bpm
    if len(kick_t) == 0 and len(snare_t) == 0:
        return 0

    def classes(ts, b):
        if len(ts) == 0:
            return np.zeros(4, dtype=int)
        pos = (np.asarray(ts) - phase) / beat - b
        near = np.abs(pos - np.round(pos)) < 0.25
        c = (np.round(pos[near]).astype(int)) % 4
        return np.bincount(c, minlength=4)

    scores = []
    for b in range(4):
        k, s = classes(kick_t, b), classes(snare_t, b)
        scores.append(1.0 * k[0] + 0.5 * k[2] - 0.5 * (k[1] + k[3])
                      + 1.0 * (s[1] + s[3]) - 1.0 * s[0])
    # senza un vantaggio netto si resta sul primo: su un pattern simmetrico un
    # colpo perso al bordo del file basterebbe a far ruotare la battuta
    best = 0
    for b in range(1, 4):
        if scores[b] > scores[best] + max(1.0, 0.05 * abs(scores[best])):
            best = b
    return best


# ----------------------------------------------------------------------------
# trascrizione
# ----------------------------------------------------------------------------
def quantize(times, energy, t0, bpm, steps=16):
    """dai secondi ai passi di sedicesimo, con la velocity normalizzata"""
    T = 60.0 / bpm / (steps / 4.0)
    if T <= 0 or len(times) == 0:
        return {}, []
    ref = float(np.percentile(energy, 88)) or 1.0
    out, devs = {}, []
    for t, e in zip(times, energy):
        pos = (t - t0) / T
        s = int(round(pos))
        if s < 0:
            continue
        devs.append((s, pos - s))
        v = float(np.clip(math.sqrt(max(e, 0.0) / ref), 0.30, 1.40))
        if s not in out or v > out[s]:
            out[s] = round(v, 2)
    return out, devs


def estimate_swing(devs, steps=16):
    """quanto sono in ritardo i sedicesimi dispari.

    BeatLab sposta il passo dispari di swing/100 · 0,66 di un sedicesimo:
    questa è la sua inversa. Sotto il 4% è rumore di misura, non swing."""
    late = [d for (s, d) in devs if s % 2 == 1 and abs(d) < 0.4]
    if len(late) < 8:
        return 0
    med = float(np.median(late))
    if abs(med) < 0.04:
        return 0
    sw = med * 100.0 / 0.66
    return int(np.clip(round(sw), 0, 60))


def steps_to_rows(hits, total_steps):
    row = [0.0] * total_steps
    for s, v in hits.items():
        if 0 <= s < total_steps:
            row[s] = v
    return row


def pick_patterns(rows, bars, steps=16, want=4, tol=0.14):
    """I blocchi di N battute che tornano più spesso, ripuliti a maggioranza.

    Un beat campionato è fatto di pochi blocchi che si ripetono. Contarli
    *identici* però non funziona: basta un colpo perso in una ripetizione e il
    blocco diventa unico, così alla fine si hanno quattro pattern quasi uguali e
    tutti sbagliati. Qui i blocchi che si somigliano finiscono nello stesso
    gruppo, e il pattern che esce è il voto di maggioranza del gruppo: un colpo
    sopravvive se c'era in più di metà delle ripetizioni. La ripetizione, che è
    l'unica cosa di cui un loop è ricco, diventa il filtro contro il rumore."""
    per_block = bars * steps
    ids = list(rows.keys())
    n = min((len(rows[i]) for i in ids), default=0)
    nb = n // per_block
    if nb == 0:
        return []
    blocks = []
    for b in range(nb):
        a, z = b * per_block, (b + 1) * per_block
        vel = np.array([rows[i][a:z] for i in ids], dtype=float)
        if vel.sum() == 0:
            continue
        blocks.append({'i': b, 'vel': vel, 'on': vel > 0})
    if not blocks:
        return []

    limit = max(int(tol * len(ids) * per_block), 1)
    groups = []
    for blk in blocks:
        for g in groups:
            if int(np.sum(g['on'] != blk['on'])) <= limit:
                g['members'].append(blk)
                break
        else:
            groups.append({'on': blk['on'], 'members': [blk]})

    groups.sort(key=lambda g: -len(g['members']))
    out = []
    for g in groups[:want]:
        ons = np.stack([m['on'] for m in g['members']])
        vels = np.stack([m['vel'] for m in g['members']])
        keep = ons.mean(axis=0) > 0.5
        tot = ons.sum(axis=0)
        med = np.divide(np.where(ons, vels, 0.0).sum(axis=0), np.maximum(tot, 1))
        vel = np.where(keep, np.where(tot > 0, med, 0.9), 0.0)
        if not vel.any():
            continue
        out.append({'block': g['members'][0]['i'], 'count': len(g['members']),
                    'rows': {t: list(vel[k]) for k, t in enumerate(ids)}})
    return out


def build_project(pats, bpm, swing, bars, source, steps=16):
    """formato beatlab/2 — quello che la app legge da «Carica JSON»"""
    names = 'ABCD'
    ALL = ('kick', 'snare', 'clap', 'hhc', 'hho', 'tom', 'rim', 'tumb')
    patterns = []
    for k, p in enumerate(pats[:4]):
        drums = {}
        for t in ALL:
            r = p['rows'].get(t)
            drums[t] = [round(float(v), 2) for v in r] if r else [0.0] * (bars * steps)
        patterns.append({
            'name': names[k], 'bars': bars, 'len': bars * steps,
            'drone': False, 'droneNote': 38, 'seed': 0,
            'div': {t: steps for t in ALL},
            'drums': drums,
            'notes': {t: [] for t in ('bass', 'guitar', 'lead', 'laun', 'ten')},
        })
    if not patterns:
        patterns.append({
            'name': 'A', 'bars': bars, 'len': bars * steps,
            'drone': False, 'droneNote': 38, 'seed': 0,
            'div': {t: steps for t in ALL},
            'drums': {t: [0.0] * (bars * steps) for t in ALL},
            'notes': {t: [] for t in ('bass', 'guitar', 'lead', 'laun', 'ten')},
        })
    return {
        'format': 'beatlab/2', 'app': 'BeatLab',
        'source': {'tool': 'beatlab_extract.py', 'from': source},
        'bpm': round(bpm, 2), 'swing': round(swing / 100.0, 3), 'stepsPerBar': steps,
        'humanize': {'time': 0.0, 'velocity': 0.0},
        'root': 2, 'rootName': 'RE', 'scale': 'dorian', 'seed': 0,
        'chain': ''.join(p['name'] for p in patterns),
        'patterns': patterns,
    }


# ----------------------------------------------------------------------------
# fette
# ----------------------------------------------------------------------------
def slice_bars(x, bpm, phase_s, outdir, bars_total=None, sr=SR):
    bar = 4 * 60.0 / bpm
    os.makedirs(outdir, exist_ok=True)
    n, k = x.shape[0], 0
    t = phase_s
    while t + bar <= n / sr and (bars_total is None or k < bars_total):
        a, z = int(t * sr), int((t + bar) * sr)
        seg = x[a:z].copy()
        fade(seg, sr)
        k += 1
        save_wav(os.path.join(outdir, f"battuta-{k:02d}.wav"), seg, sr)
        t += bar
    return k


def slice_hits(x, peaks, outdir, sr=SR, hop=HOP, maxlen=1.2):
    os.makedirs(outdir, exist_ok=True)
    n, k = x.shape[0], 0
    for i, p in enumerate(peaks):
        a = max(int(p * hop) - int(0.005 * sr), 0)
        nxt = int(peaks[i + 1] * hop) if i + 1 < len(peaks) else n
        z = min(nxt, a + int(maxlen * sr), n)
        if z - a < int(0.02 * sr):
            continue
        seg = x[a:z].copy()
        fade(seg, sr)
        k += 1
        save_wav(os.path.join(outdir, f"colpo-{k:03d}.wav"), seg, sr)
    return k


def fade(seg, sr=SR, ms=4.0):
    """qualche millisecondo in entrata e in uscita: senza, ogni fetta fa clic"""
    f = min(int(ms / 1000.0 * sr), max(seg.shape[0] // 2, 1))
    if f < 2:
        return
    ramp = np.linspace(0.0, 1.0, f)[:, None] if seg.ndim > 1 else np.linspace(0.0, 1.0, f)
    seg[:f] *= ramp
    seg[-f:] *= ramp[::-1]


# ----------------------------------------------------------------------------
# passi della pipeline
# ----------------------------------------------------------------------------
def download(url, outdir, extra):
    if not have('yt-dlp'):
        sys.exit("manca yt-dlp: «pip install yt-dlp» (serve anche ffmpeg).")
    os.makedirs(outdir, exist_ok=True)
    tmpl = os.path.join(outdir, 'originale.%(ext)s')
    cmd = ['yt-dlp', '--no-playlist', '-x', '--audio-format', 'wav',
           '--audio-quality', '0', '-o', tmpl] + list(extra) + [url]
    print('scarico…')
    run(cmd, 'il download')
    got = os.path.join(outdir, 'originale.wav')
    if not os.path.exists(got):
        sys.exit("yt-dlp non ha lasciato originale.wav nella cartella.")
    return got


def trim(path, start, dur, sr=SR):
    if start is None and dur is None:
        return path
    out = os.path.splitext(path)[0] + '-taglio.wav'
    cmd = ['ffmpeg', '-v', 'error', '-y']
    if start:
        cmd += ['-ss', str(start)]
    cmd += ['-i', path]
    if dur:
        cmd += ['-t', str(dur)]
    cmd += ['-ac', '2', '-ar', str(sr), out]
    run(cmd, 'il taglio del brano')
    return out


def separate(path, outdir, model='htdemucs', two=False, device=None):
    """Demucs. Restituisce {nome: file} con i nomi in italiano."""
    print('separo le tracce (Demucs: la prima volta scarica il modello)…')
    tmp = tempfile.mkdtemp(prefix='beatlab-demucs-')
    cmd = [sys.executable, '-m', 'demucs', '-n', model, '-o', tmp,
           '--filename', '{stem}.{ext}']
    if two:
        cmd += ['--two-stems=vocals']
    if device:
        cmd += ['-d', device]
    cmd += [path]
    p = subprocess.run(cmd)
    if p.returncode != 0:
        shutil.rmtree(tmp, ignore_errors=True)
        sys.exit("Demucs non è riuscito: «pip install demucs» e riprova.\n"
                 "Su CPU è lento: prova --start/--duration per lavorare su un pezzo.")
    src = os.path.join(tmp, model)
    names = {'vocals': 'voce.wav', 'no_vocals': 'base.wav', 'drums': 'batteria.wav',
             'bass': 'basso.wav', 'other': 'altro.wav'}
    out = {}
    for stem, nice in names.items():
        f = os.path.join(src, stem + '.wav')
        if os.path.exists(f):
            dst = os.path.join(outdir, nice)
            shutil.move(f, dst)
            out[nice] = dst
    shutil.rmtree(tmp, ignore_errors=True)
    if not out:
        sys.exit("Demucs non ha prodotto nessuna traccia.")
    return out


# ----------------------------------------------------------------------------
def main():
    ap = argparse.ArgumentParser(
        description='Estrae beat e voce da un link (o da un file) e ne fa un progetto BeatLab',
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog='Scaricare da YouTube viola i termini del sito e il materiale resta di chi lo\n'
               'ha fatto: usa questo strumento su roba tua, libera o autorizzata.')
    ap.add_argument('source', help='URL del video oppure un file audio locale')
    ap.add_argument('-o', '--out', default='estratto', help='cartella di uscita')
    ap.add_argument('--two-stems', action='store_true',
                    help='solo voce + base (più veloce della separazione a quattro)')
    ap.add_argument('--no-separate', action='store_true',
                    help='niente Demucs: analizza l\'audio così com\'è')
    ap.add_argument('--model', default='htdemucs', help='modello Demucs (default htdemucs)')
    ap.add_argument('--device', default=None, help='cpu oppure cuda')
    ap.add_argument('--start', type=timecode, default=None, help='da dove partire, es. 1:12')
    ap.add_argument('--duration', type=timecode, default=None, help='quanti secondi prendere')
    ap.add_argument('--bpm', type=float, default=None, help='impone il tempo invece di misurarlo')
    ap.add_argument('--bars', type=int, default=2, choices=(1, 2, 4, 8),
                    help='battute per pattern (default 2)')
    ap.add_argument('--slices', choices=('none', 'bars', 'hits'), default='none',
                    help='taglia anche le fette: per battuta o per colpo')
    ap.add_argument('--slices-from', choices=('mix', 'base', 'drums'), default='mix',
                    help='da quale traccia tagliare le fette')
    ap.add_argument('--hat-gate', type=float, default=0.06,
                    help='quanta acuta serve per chiamarlo hi-hat (0,02 = generoso, '
                         '0,15 = severo). Abbassalo se mancano gli hi-hat sotto la cassa, '
                         'alzalo se ne compaiono a ogni colpo')
    ap.add_argument('--snare-gate', type=float, default=0.22,
                    help='come --hat-gate, per il rullante')
    ap.add_argument('--no-project', action='store_true', help='niente progetto.json')
    ap.add_argument('--ytdlp-arg', action='append', default=[],
                    help='argomento in più per yt-dlp (ripetibile)')
    args = ap.parse_args()

    outdir = os.path.abspath(args.out)
    os.makedirs(outdir, exist_ok=True)

    # 1 — audio di partenza
    if os.path.exists(args.source):
        src = os.path.join(outdir, 'originale.wav')
        if os.path.abspath(args.source) != src:
            run(['ffmpeg', '-v', 'error', '-y', '-i', args.source,
                 '-ac', '2', '-ar', str(SR), src], 'la conversione dell\'ingresso')
        origine = os.path.basename(args.source)
    else:
        src = download(args.source, outdir, args.ytdlp_arg)
        origine = args.source
    src = trim(src, args.start, args.duration)

    # 2 — separazione
    stems = {}
    if args.no_separate:
        print('separazione saltata.')
    else:
        stems = separate(src, outdir, args.model, args.two_stems, args.device)
        print('  ' + ' · '.join(sorted(stems)))

    mix = load_audio(src)
    drums_path = stems.get('batteria.wav')
    drums = load_audio(drums_path) if drums_path else mix
    if drums_path:
        print('analizzo la traccia di batteria.')
    else:
        print('analizzo il mix (senza traccia di batteria separata è meno preciso).')

    # 3 — colpi, tempo, griglia
    steps = 16
    mag = stft_mag(mono(drums))
    hits = detect_hits(mag, args.hat_gate, args.snare_gate)
    E = hits.pop('_bands')
    times = {k: frame_time(v['frames']) for k, v in hits.items()}
    energy = {k: v['energy'] for k, v in hits.items()}

    # Il tempo si misura su cassa e rullante, non sugli hi-hat: un charleston in
    # sedicesimi è una periodicità quattro volte più fitta e regolarissima, e
    # l'autocorrelazione ci si aggancia volentieri restituendo il quadruplo del
    # tempo vero. Cassa e rullante, invece, il battito lo *definiscono*.
    env = novelty(E['low']) + novelty(E['mid'])
    if not np.any(env > 0):
        env = novelty(E['hi'])
    bpm0, conf = (float(args.bpm), 1.0) if args.bpm else estimate_bpm(env)

    all_t = np.concatenate([times[k] for k in ('kick', 'snare', 'hat')]) if any(
        len(times[k]) for k in times) else np.array([])
    all_w = np.concatenate([energy[k] / (np.percentile(energy[k], 90) or 1.0)
                            for k in ('kick', 'snare', 'hat') if len(energy[k])]) \
        if any(len(energy[k]) for k in energy) else np.array([])
    if args.bpm:
        _, phase, lock = fit_grid(all_t, all_w, bpm0, span=0.002, steps=steps)
        bpm = bpm0
    else:
        bpm, phase, lock = fit_grid(all_t, all_w, bpm0, steps=steps)

    # l'«uno» è il battito con la cassa: senza, la battuta parte dove capita
    beat = downbeat(times['kick'], times['snare'], phase, bpm)
    t0 = phase + beat * (60.0 / bpm)
    while t0 - 4 * 60.0 / bpm >= 0:
        t0 -= 4 * 60.0 / bpm          # arretra alla prima battuta intera

    hk, dk = quantize(times['kick'], energy['kick'], t0, bpm, steps)
    hs, ds = quantize(times['snare'], energy['snare'], t0, bpm, steps)
    hh, dh = quantize(times['hat'], energy['hat'], t0, bpm, steps)
    opened = open_hat_mask(E['hi'], hits['hat']['frames'])

    # L'hi-hat aperto va nella sua riga: nella app il chiuso lo strozza.
    # Dove batte anche un rullante o una cassa la coda non è dell'hi-hat, è la
    # loro: lì si scrive chiuso e non si discute.
    T = 60.0 / bpm / (steps / 4.0)
    busy = set(hk) | set(hs)
    hho, hhc = {}, {}
    for t, is_open in zip(times['hat'], opened):
        s = int(round((t - t0) / T))
        if s < 0 or s not in hh:
            continue
        (hho if (is_open and s not in busy) else hhc)[s] = hh[s]

    swing = estimate_swing(dk + ds + dh, steps)

    total = int(max((drums.shape[0] / SR - t0), 0) / T)
    total = max(total, steps * args.bars)
    rows = {
        'kick': steps_to_rows(hk, total),
        'snare': steps_to_rows(hs, total),
        'hhc': steps_to_rows(hhc, total),
        'hho': steps_to_rows(hho, total),
    }
    pats = pick_patterns(rows, args.bars, steps)

    # 4 — progetto
    proj_path = None
    if not args.no_project:
        proj = build_project(pats, bpm, swing, args.bars, origine, steps)
        proj_path = os.path.join(outdir, 'progetto.json')
        with open(proj_path, 'w', encoding='utf-8') as f:
            json.dump(proj, f, ensure_ascii=False, indent=1)

    # 5 — fette
    nfette = 0
    if args.slices != 'none':
        which = {'mix': src, 'base': stems.get('base.wav') or stems.get('altro.wav'),
                 'drums': drums_path}.get(args.slices_from) or src
        y = load_audio(which)
        fdir = os.path.join(outdir, 'fette')
        if args.slices == 'bars':
            nfette = slice_bars(y, bpm, t0, fdir)
        else:
            allf = [hits[k]['frames'] for k in ('kick', 'snare', 'hat') if len(hits[k]['frames'])]
            allp = np.unique(np.concatenate(allf)) if allf else np.array([], dtype=int)
            nfette = slice_hits(y, allp, fdir)
        print(f'{nfette} fette in {os.path.relpath(fdir, os.getcwd())}')

    # 6 — resoconto
    conf_tx = 'sicuro' if conf > 0.6 else ('probabile' if conf > 0.3 else 'incerto')
    lines = [
        '# Estrazione', '',
        f'- origine: `{origine}`',
        f'- tempo misurato: **{bpm:.1f} BPM** ({conf_tx})' + ('  — imposto a mano' if args.bpm else ''),
        f'- swing stimato: {swing}',
        f'- griglia agganciata al {lock * 100:.0f}%'
        f' · primo «uno» a {t0:.3f} s dall\'inizio del file',
        f'- colpi trovati: {len(times["kick"])} cassa · {len(times["snare"])} rullante · '
        f'{len(times["hat"])} hi-hat ({int(opened.sum()) if len(opened) else 0} aperti)',
        f'- blocchi di {args.bars} battute distinti: {len(pats)}'
        + (f' — il più ricorrente torna {pats[0]["count"]} volte' if pats else ''),
        '',
        '## File', '',
    ]
    for nice in sorted(stems):
        lines.append(f'- `{nice}`')
    if proj_path:
        lines.append('- `progetto.json` — caricalo in BeatLab da *Esporta → Carica JSON*')
    if nfette:
        lines.append(f'- `fette/` — {nfette} file')
    lines += ['', '## Attenzione', '',
              'La trascrizione è un punto di partenza, non un rilievo: i colpi deboli',
              'sfuggono e le mani sovrapposte si confondono. Aprila nella griglia e',
              'correggila a orecchio.', '',
              'Il materiale scaricato resta di chi lo ha fatto: per pubblicarci sopra',
              'servono i diritti o la licenza del campione.', '']
    with open(os.path.join(outdir, 'estrazione.md'), 'w', encoding='utf-8') as f:
        f.write('\n'.join(lines))

    print(f'\n{bpm:.1f} BPM ({conf_tx}) · swing {swing} · '
          f'{len(pats)} pattern da {args.bars} battute')
    print(f'tutto in {outdir}')


if __name__ == '__main__':
    main()
