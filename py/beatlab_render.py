#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
beatlab_render.py — motore di render offline per i pattern di BeatLab.

Legge il JSON esportato dalla web app (formati "beatlab/2" e "beatlab/1") e lo
risintetizza ad alta qualità: oscillatori a banda limitata (sintesi additiva,
niente alias), filtri biquad RBJ, riverbero a convoluzione, sidechain, choke
dell'hi-hat, umanizzazione, decimazione e bitcrush.

    python3 beatlab_render.py pattern.json -o beat.mp3
    python3 beatlab_render.py pattern.json -o beat.wav --sr 48000 --repeat 4
    python3 beatlab_render.py pattern.json --chain AABACD --stems
    python3 beatlab_render.py pattern.json --midi-only --midi beat.mid

Nessun sample: ogni suono è generato.
"""
import argparse, json, math, os, sys
import numpy as np
from scipy.signal import lfilter, fftconvolve

# ----------------------------------------------------------------------------
# utilità
# ----------------------------------------------------------------------------
def mtof(m):
    return 440.0 * 2.0 ** ((m - 69) / 12.0)

def db(x):
    return 10.0 ** (x / 20.0)

def env_ad(n, sr, attack, decay, peak=1.0, curve=4.0):
    """attacco lineare + decadimento esponenziale"""
    e = np.empty(n, dtype=np.float64)
    a = max(int(attack * sr), 1)
    a = min(a, n)
    e[:a] = np.linspace(0.0, 1.0, a, endpoint=False)
    d = n - a
    if d > 0:
        t = np.arange(d) / sr
        e[a:] = np.exp(-curve * t / max(decay, 1e-4))
    return e * peak

def env_adsr(n, sr, a, d, s, r, peak=1.0):
    e = np.zeros(n)
    ai = min(int(a * sr), n)
    di = min(int(d * sr), n - ai)
    ri = min(int(r * sr), n)
    si = max(n - ai - di - ri, 0)
    idx = 0
    if ai: e[idx:idx+ai] = np.linspace(0, 1, ai); idx += ai
    if di: e[idx:idx+di] = np.linspace(1, s, di); idx += di
    if si: e[idx:idx+si] = s; idx += si
    if ri: e[idx:idx+ri] = np.linspace(e[idx-1] if idx else s, 0, ri)
    return e * peak

def noise(n, rng):
    return rng.standard_normal(n) * 0.35

# --- oscillatori a banda limitata (sintesi additiva) ------------------------
def phase_of(freq, n, sr, phase0=0.0):
    if np.isscalar(freq):
        return phase0 + 2 * np.pi * freq * np.arange(n) / sr
    return phase0 + 2 * np.pi * np.cumsum(freq) / sr

def bl_osc(phase, fmax, sr, kind='saw', tilt=1.0):
    """somma additiva limitata a Nyquist: nessun aliasing."""
    nyq = sr * 0.45
    kmax = max(int(nyq / max(fmax, 1e-6)), 1)
    kmax = min(kmax, 64)
    out = np.zeros_like(phase)
    if kind == 'saw':
        for k in range(1, kmax + 1):
            out += np.sin(k * phase) / k
        return out * (2 / np.pi)
    if kind == 'square':
        for k in range(1, kmax + 1, 2):
            out += np.sin(k * phase) / k
        return out * (4 / np.pi)
    if kind == 'pulse':          # ancia semplice: dispari forti + traccia di pari
        for k in range(1, kmax + 1):
            amp = 1.0 / k ** tilt if k % 2 else 0.06 / k ** (tilt + 1)
            out += amp * np.sin(k * phase)
        return out * 1.2
    if kind == 'tri':
        for i, k in enumerate(range(1, kmax + 1, 2)):
            out += ((-1) ** i) * np.sin(k * phase) / (k * k)
        return out * (8 / np.pi ** 2)
    return np.sin(phase)

# --- filtri biquad RBJ ------------------------------------------------------
def _bq(b0, b1, b2, a0, a1, a2):
    return np.array([b0, b1, b2]) / a0, np.array([1.0, a1 / a0, a2 / a0])

def coef(kind, f0, sr, Q=0.707, gain_db=0.0):
    f0 = min(max(f0, 20.0), sr * 0.47)
    w = 2 * np.pi * f0 / sr
    c, s = np.cos(w), np.sin(w)
    al = s / (2 * Q)
    if kind == 'lp':
        return _bq((1 - c) / 2, 1 - c, (1 - c) / 2, 1 + al, -2 * c, 1 - al)
    if kind == 'hp':
        return _bq((1 + c) / 2, -(1 + c), (1 + c) / 2, 1 + al, -2 * c, 1 - al)
    if kind == 'bp':
        return _bq(al, 0, -al, 1 + al, -2 * c, 1 - al)
    if kind == 'notch':
        return _bq(1, -2 * c, 1, 1 + al, -2 * c, 1 - al)
    if kind == 'peak':
        A = 10 ** (gain_db / 40)
        return _bq(1 + al * A, -2 * c, 1 - al * A, 1 + al / A, -2 * c, 1 - al / A)
    raise ValueError(kind)

def filt(x, kind, f0, sr, Q=0.707, gain_db=0.0):
    b, a = coef(kind, f0, sr, Q, gain_db)
    return lfilter(b, a, x)

def morph_filter(x, sr, f_start, f_end, tmorph, kind='lp', Q=2.0):
    """filtro a inviluppo approssimato: crossfade fra due versioni statiche."""
    bright = filt(x, kind, f_start, sr, Q)
    dark = filt(x, kind, f_end, sr, Q)
    n = len(x)
    t = np.arange(n) / sr
    w = np.exp(-3.0 * t / max(tmorph, 1e-3))
    return bright * w + dark * (1 - w)

def sat(x, drive=2.0, asym=0.0):
    y = x + asym * x * x * 0.4
    return np.tanh(drive * y) / np.tanh(drive)

def bitcrush(x, bits):
    lv = 2 ** (bits - 1)
    return np.round(np.clip(x, -1, 1) * lv) / lv


def decimate(x, div):
    """sample & hold: riduce la frequenza di campionamento senza cambiare la durata"""
    if div <= 1:
        return x
    n = len(x)
    return x[(np.arange(n) // div) * div]

def compress(x, sr, thr_db=-16, ratio=4.0, att=0.004, rel=0.14, makeup=1.0):
    eps = 1e-9
    atk = math.exp(-1.0 / (att * sr))
    rls = math.exp(-1.0 / (rel * sr))
    # inviluppo con decimazione (fattore 8) per velocità, poi interpolato
    D = 8
    xa = np.abs(x[::D])
    env = np.empty_like(xa)
    e = 0.0
    for i, v in enumerate(xa):
        c = atk if v > e else rls
        e = c * e + (1 - c) * v
        env[i] = e
    env = np.interp(np.arange(len(x)), np.arange(len(env)) * D, env)
    edb = 20 * np.log10(env + eps)
    over = np.maximum(edb - thr_db, 0.0)
    gain = db(-over * (1 - 1 / ratio))
    return x * gain * makeup

def synth_ir(sr, dur, decay, bright, seed=7):
    rng = np.random.default_rng(seed)
    n = int(sr * dur)
    t = np.linspace(0, 1, n)
    ir = np.empty((2, n))
    for ch in range(2):
        w = rng.standard_normal(n) * (1 - t) ** decay
        w = lfilter([bright], [1, -(1 - bright)], w)
        w[:60] *= np.linspace(0, 1, 60)
        ir[ch] = w
    ir /= np.max(np.abs(ir)) + 1e-9
    return ir

# ----------------------------------------------------------------------------
# voci di batteria
# ----------------------------------------------------------------------------
class Voices:
    def __init__(self, sr, rng):
        self.sr, self.rng = sr, rng

    def kick(self, v=1.0):
        sr = self.sr
        n = int(0.55 * sr)
        t = np.arange(n) / sr
        f = 47 + (150 - 47) * np.exp(-t / 0.018)
        body = np.sin(phase_of(f, n, sr)) * env_ad(n, sr, 0.001, 0.13, v * 0.95, 3.2)
        m = int(0.02 * sr)
        click = filt(noise(m, self.rng), 'hp', 1800, sr) * env_ad(m, sr, 0.0004, 0.004, v * 0.5)
        out = body
        out[:m] += click
        return sat(out, 1.4) * 0.95

    def snare(self, v=1.0):
        sr = self.sr
        n = int(0.35 * sr)
        nz = filt(filt(noise(n, self.rng), 'bp', 1750, sr, 0.6), 'hp', 420, sr)
        out = nz * env_ad(n, sr, 0.001, 0.055, v * 0.62)
        for f, a, d in ((188, 0.35, 0.035), (332, 0.20, 0.024)):
            ff = f * (0.82 + 0.18 * np.exp(-np.arange(n) / sr / 0.03))
            out += np.sin(phase_of(ff, n, sr)) * env_ad(n, sr, 0.001, d, v * a)
        return out

    def clap(self, v=1.0):
        sr = self.sr
        n = int(0.32 * sr)
        out = np.zeros(n)
        for i in range(3):
            off = int(i * 0.0095 * sr)
            m = n - off
            out[off:] += noise(m, self.rng) * env_ad(m, sr, 0.0005, 0.005, v * (0.5 - i * 0.09))
        off = int(0.028 * sr); m = n - off
        out[off:] += noise(m, self.rng) * env_ad(m, sr, 0.001, 0.045, v * 0.42)
        return filt(filt(out, 'bp', 1150, sr, 1.3), 'hp', 700, sr)

    def hat(self, v=1.0, open_=False, maxdur=None):
        """maxdur: il colpo successivo strozza l'aperto, come su una vera 808"""
        sr = self.sr
        dur = 0.36 if open_ else 0.06
        n = int((dur + 0.05) * sr)
        ph = np.arange(n) / sr
        metal = np.zeros(n)
        for r in (2.0, 3.0, 4.16, 5.43, 6.79, 8.21):
            metal += np.sign(np.sin(2 * np.pi * 40 * r * ph))
        src = metal * 0.12 + noise(n, self.rng) * 0.9
        y = filt(filt(src, 'hp', 7200, sr), 'bp', 10500, sr, 0.8)
        y = y * env_ad(n, sr, 0.0004, dur * 0.32, v * (0.30 if open_ else 0.34))
        if maxdur is not None:
            k = int(maxdur * sr)
            if 0 < k < n:
                fade = max(int(0.008 * sr), 1)
                a = max(k - fade, 0)
                y = y[:k].copy()
                y[a:] *= np.linspace(1.0, 0.0, k - a)
        return y

    def tom(self, v=1.0, f=190):
        sr = self.sr
        n = int(0.5 * sr)
        t = np.arange(n) / sr
        ff = f * (0.6 + 0.4 * np.exp(-t / 0.05))
        out = np.sin(phase_of(ff, n, sr)) * env_ad(n, sr, 0.002, 0.11, v * 0.6)
        m = int(0.08 * sr)
        out[:m] += filt(noise(m, self.rng), 'bp', f * 2.4, sr, 1.2) * env_ad(m, sr, 0.001, 0.016, v * 0.18)
        return out

    def rim(self, v=1.0):
        sr = self.sr
        n = int(0.09 * sr)
        out = np.zeros(n)
        for f, a in ((1720, 0.5), (2540, 0.3)):
            out += bl_osc(phase_of(f, n, sr), f, sr, 'tri') * env_ad(n, sr, 0.0005, 0.009, v * a)
        out += filt(noise(n, self.rng), 'bp', 3200, sr, 2.0) * env_ad(n, sr, 0.0004, 0.006, v * 0.22)
        return out

    def tumbarinu(self, v=1.0, f=118):
        """tamburo a cornice: modi di membrana inarmonici + ronzio del cordino"""
        sr = self.sr
        n = int(0.6 * sr)
        t = np.arange(n) / sr
        out = np.zeros(n)
        for r, a, d in ((1, .55, .10), (1.59, .34, .055), (2.14, .22, .035),
                        (2.30, .16, .026), (2.65, .10, .02), (2.92, .07, .015)):
            ff = f * r * (0.93 + 0.07 * np.exp(-t / (d * 1.5)))
            out += np.sin(phase_of(ff, n, sr)) * env_ad(n, sr, 0.0015, d, v * a)
        m = int(0.2 * sr)
        out[:m] += filt(noise(m, self.rng), 'bp', 430, sr, 0.9) * env_ad(m, sr, 0.001, 0.018, v * 0.30)
        buzz = filt(noise(n, self.rng), 'bp', 2600, sr, 1.6)
        trem = 0.5 + 0.5 * np.sin(2 * np.pi * 62 * t)
        out += buzz * trem * env_ad(n, sr, 0.002, 0.062, v * 0.18)
        return out

    # ---------------- melodiche ----------------
    def bass(self, midi, dur, v=1.0, drive=2.2):
        sr = self.sr
        n = int((dur + 0.16) * sr)
        f = mtof(midi)
        ph = phase_of(f, n, sr)
        x = (bl_osc(ph, f, sr, 'saw') * 0.55
             + bl_osc(ph * (1 - 0.0052), f, sr, 'square') * 0.30
             + np.sin(ph * 0.5) * 0.42)
        y = morph_filter(x, sr, min(f * 7, 4200), max(min(f * 2.2, 1200), 90),
                         min(dur * 0.8, 0.35), 'lp', 4.0)
        e = env_adsr(n, sr, 0.006, 0.05, 0.85, 0.09, v * 0.5)
        return sat(y * e, drive, 0.2)

    def lead(self, midi, dur, v=1.0, wave='saw'):
        sr = self.sr
        n = int((dur + 0.22) * sr)
        f = mtof(midi)
        t = np.arange(n) / sr
        vib = 1 + 0.003 * np.sin(2 * np.pi * 5.2 * t) * np.clip(t / 0.15, 0, 1)
        x = np.zeros(n)
        for det in (-6, 6):
            fd = f * 2 ** (det / 1200) * vib
            x += bl_osc(phase_of(fd, n, sr, self.rng.random() * 6), f, sr, wave) * 0.4
        y = morph_filter(x, sr, min(f * 10, 9000), min(f * 3.2, 5000), min(dur, 0.5), 'lp', 3.0)
        e = env_adsr(n, sr, 0.012, min(dur * 0.6, 0.25), 0.7, 0.16, v * 0.34)
        return y * e

    def guitar(self, midi, dur, v=1.0, palm=True, gain=9.0):
        """power chord: fondamentale + quinta + ottava, distorsione asimmetrica + cabinet"""
        sr = self.sr
        d = min(dur, 0.115) if palm else dur
        n = int((d + 0.2) * sr)
        x = np.zeros(n)
        for semi, a, det in ((0, .6, -4), (7, .5, 5), (12, .34, -8), (0, .3, 10)):
            f = mtof(midi + semi) * 2 ** (det / 1200)
            kind = 'square' if semi == 12 else 'saw'
            x += bl_osc(phase_of(f, n, sr, self.rng.random() * 6), f, sr, kind) * a
        pre = env_ad(n, sr, 0.003, d * 0.6 if palm else max(d, 0.05), 1.0, 2.2)
        y = sat(x * (0.9 + 0.6 * pre), gain, 0.5)
        y = filt(y, 'lp', 3000 if palm else 4400, sr, 0.8)
        y = filt(y, 'peak', 750, sr, 1.1, -6)
        y = filt(y, 'peak', 2400, sr, 1.2, 4)
        y = filt(y, 'hp', 95, sr)
        e = env_adsr(n, sr, 0.004, d * 0.5, 0.55 if not palm else 0.15, 0.1, v * 0.3)
        return y * e

    def tenore(self, midi, dur, v=1.0):
        """bassu/contra: raddoppio di periodo (subarmonica) + formanti su vocale chiusa"""
        sr = self.sr
        n = int((dur + 0.3) * sr)
        f = mtof(midi)
        t = np.arange(n) / sr
        vib = 1 + 0.0035 * np.sin(2 * np.pi * 4.6 * t)
        src = (bl_osc(phase_of(f * 0.5 * vib, n, sr), f * 0.5, sr, 'saw') * 0.85
               + bl_osc(phase_of(f * vib * 0.9959, n, sr), f, sr, 'saw') * 0.5
               + bl_osc(phase_of(f * vib * 1.0052, n, sr), f, sr, 'square') * 0.2)
        y = np.zeros(n)
        for fr, q, g in ((330, 7, 1.0), (760, 9, 0.7), (2450, 11, 0.28)):
            y += filt(src, 'bp', fr, sr, q) * g
        y += src * 0.16
        y = sat(y, 2.4, 0.55)
        e = env_adsr(n, sr, 0.09, 0.12, 0.85, 0.22, v * 0.5)
        return y * e


# ----------------------------------------------------------------------------
# voci continue: launeddas e bordone tumbu
# ----------------------------------------------------------------------------
def render_launeddas(events, total, sr, rng):
    """
    Monofonica e legata: la respirazione circolare fa sì che lo strumento non
    taccia mai. L'articolazione è un calo d'ampiezza, non un silenzio.
    Due canne: mancosa manna (melodia) e mancosedda (quinta sopra).
    """
    if not events:
        return np.zeros((2, total))
    events = sorted(events, key=lambda e: e['t'])
    freq = np.zeros(total)
    amp = np.zeros(total)
    cur = mtof(events[0]['n'])
    idx = 0
    for i, ev in enumerate(events):
        s = int(ev['t'] * sr)
        e = min(int((ev['t'] + ev['dur']) * sr), total)
        if s >= total:
            break
        freq[idx:s] = cur
        cur = mtof(ev['n'])
        freq[s:e] = cur
        idx = e
        # articolazione: dip d'ampiezza in ingresso, mai a zero se legato
        a = np.ones(e - s) * ev['v']
        d1 = min(int(0.012 * sr), len(a))
        d2 = min(int(0.055 * sr), len(a))
        a[:d1] *= np.linspace(0.45, 0.55, d1)
        if d2 > d1:
            a[d1:d2] *= np.linspace(0.55, 1.0, d2 - d1)
        amp[s:e] = np.maximum(amp[s:e], a)
    freq[idx:] = cur
    # code: rilascio dolce dopo l'ultima nota
    rel = int(0.18 * sr)
    if idx < total:
        k = min(rel, total - idx)
        amp[idx:idx + k] = np.linspace(amp[idx - 1] if idx else 0, 0, k)
    # deriva d'intonazione lenta
    t = np.arange(total) / sr
    drift = 1 + 0.0022 * np.sin(2 * np.pi * 0.11 * t + 1.3) + 0.0012 * np.sin(2 * np.pi * 0.037 * t)
    # smussa i salti di frequenza (portamento minimo dell'ancia)
    k = max(int(0.004 * sr), 1)
    freq = np.convolve(freq * drift, np.ones(k) / k, mode='same')
    amp = np.convolve(amp, np.ones(k * 3) / (k * 3), mode='same')

    out = np.zeros((2, total))
    for semi, pan, lvl in ((0, -0.25, 1.0), (7, 0.28, 0.72)):
        f = freq * 2 ** (semi / 12)
        pwm = 1 + 0.004 * np.sin(2 * np.pi * (0.13 + rng.random() * 0.1) * t)
        ph = phase_of(f * pwm, total, sr, rng.random() * 6)
        src = bl_osc(ph, float(np.max(f)), sr, 'pulse', 1.05)
        y = src * 0.45
        for fr, q, g in ((900, 4.5, 1.0), (1550, 6, 0.62), (2600, 7, 0.4)):
            y += filt(src, 'bp', fr, sr, q) * g
        y = y * amp * 0.16 * lvl
        y += filt(noise(total, rng), 'hp', 2600, sr) * amp * 0.012 * lvl  # soffio
        out[0] += y * math.sqrt((1 - pan) / 2)
        out[1] += y * math.sqrt((1 + pan) / 2)
    return out


def render_drone(gate, midi, total, sr, rng):
    """bordone tumbu: due canne leggermente scordate, L/R, senza ritardo Haas"""
    if not np.any(gate):
        return np.zeros((2, total))
    t = np.arange(total) / sr
    out = np.zeros((2, total))
    f0 = mtof(midi)
    for det, pan in ((-5, -0.62), (6, 0.64)):
        drift = 1 + 0.0009 * np.sin(2 * np.pi * (0.07 + rng.random() * 0.06) * t + rng.random() * 6)
        f = f0 * 2 ** (det / 1200) * drift
        y = bl_osc(phase_of(f, total, sr, rng.random() * 6), f0 * 1.05, sr, 'pulse', 1.15) * 0.3
        y += filt(noise(total, rng), 'bp', 1900, sr, 0.7) * 0.012
        out[0] += y * math.sqrt((1 - pan) / 2)
        out[1] += y * math.sqrt((1 + pan) / 2)
    for c in range(2):
        out[c] = filt(out[c], 'hp', 130, sr)
        out[c] = filt(out[c], 'peak', 1400, sr, 1.1, -4.5)   # scavo per la voce
        out[c] = filt(out[c], 'lp', 2600, sr)
    return out * gate * 0.30


# ----------------------------------------------------------------------------
# render principale
# ----------------------------------------------------------------------------
DRUM_IDS = ['kick', 'snare', 'clap', 'hhc', 'hho', 'tom', 'rim', 'tumb']
MEL_IDS = ['bass', 'guitar', 'lead', 'laun', 'ten']
DEFAULT_REV = {'kick': .05, 'snare': .22, 'clap': .28, 'hhc': .06, 'hho': .14,
               'tom': .18, 'rim': .20, 'tumb': .26, 'bass': .02, 'guitar': .12,
               'lead': .22, 'laun': .30, 'ten': .34}
DEFAULT_BUS = {**{k: 'drum' for k in DRUM_IDS},
               'bass': 'bassduck', 'guitar': 'duck', 'lead': 'duck',
               'laun': 'duck', 'ten': 'duck'}


def bars_of(p):
    return int(p.get('bars') or max(round(p.get('len', 32) / 16), 1))


def div_of(p, tid):
    return int((p.get('div') or {}).get(tid, 16))


def render(spec, sr=48000, chain=None, repeat=1, tail=3.0, seed=1234, stems=False):
    rng = np.random.default_rng(seed)
    hrng = np.random.default_rng(seed + 1)      # umanizzazione, separata
    V = Voices(sr, rng)
    bpm = float(spec.get('bpm', 100))
    swing = float(spec.get('swing', 0.0))
    bar = 4 * 60.0 / bpm
    sd = bar / 16.0
    hum = spec.get('humanize') or {}
    hum_t, hum_v = float(hum.get('time', 0.0)), float(hum.get('velocity', 0.0))
    pats = {p['name']: p for p in spec['patterns']}
    seq = list((chain or spec.get('chain') or 'A').upper().replace(' ', '')) * repeat
    seq = [c for c in seq if c in pats]
    if not seq:
        seq = [spec['patterns'][0]['name']]

    # durata totale
    t_cursor, plan = 0.02, []
    for name in seq:
        plan.append((name, t_cursor))
        t_cursor += bars_of(pats[name]) * bar
    total = int((t_cursor + tail) * sr)

    mixer = spec.get('mixer', {})
    fx = spec.get('fx', {})
    synth = spec.get('synth', {})
    wave = {'sawtooth': 'saw', 'square': 'square', 'triangle': 'tri',
            'sine': 'sine', 'pulse': 'pulse'}.get(synth.get('leadWave', 'sawtooth'), 'saw')
    palm = synth.get('guitarPalmMute', True)

    def mgain(tid):
        m = mixer.get(tid, {})
        if m.get('mute'):
            return 0.0
        return float(m.get('gain', 0.85))

    any_solo = any(m.get('solo') for m in mixer.values())
    def active(tid):
        if any_solo:
            return bool(mixer.get(tid, {}).get('solo'))
        return not mixer.get(tid, {}).get('mute', False)

    def pan_of(tid):
        return float(mixer.get(tid, {}).get('pan', 0.0))

    bufs = {tid: np.zeros((2, total)) for tid in DRUM_IDS + MEL_IDS}

    def add(tid, mono, t):
        s = int(t * sr)
        if s < 0:                      # l'umanizzazione può anticipare il primo colpo
            mono = mono[-s:]
            s = 0
        if s >= total or len(mono) == 0:
            return
        n = min(len(mono), total - s)
        p = pan_of(tid)
        bufs[tid][0, s:s + n] += mono[:n] * math.sqrt((1 - p) / 2)
        bufs[tid][1, s:s + n] += mono[:n] * math.sqrt((1 + p) / 2)

    kick_times = []
    laun_events = []
    drum_events = []          # (tid, t, v) — raccolti prima, per poter strozzare l'hi-hat
    drone_gate = np.zeros(total)
    drone_note = 38

    def jitter_t(t):
        return max(t + (hrng.random() - 0.5) * 0.012 * hum_t, 0.0)

    def jitter_v(v):
        return float(np.clip(v * (1 + (hrng.random() - 0.5) * 0.34 * hum_v), 0.05, 1.6))

    for name, t0 in plan:
        p = pats[name]
        B = bars_of(p)
        L = B * 16
        # batteria: ogni traccia ha la sua suddivisione (16 = sedicesimi, 12 = terzine)
        for tid in DRUM_IDS:
            row = p.get('drums', {}).get(tid) or []
            d = div_of(p, tid)
            for i, v in enumerate(row[:B * d]):
                if not v:
                    continue
                t = t0 + (i / d) * bar
                if d == 16 and i % 2:
                    t += sd * swing * 0.66
                drum_events.append((tid, jitter_t(t), jitter_v(v)))
        # melodiche (sempre sui sedicesimi)
        for tid in MEL_IDS:
            if not active(tid):
                continue
            for nt in (p.get('notes', {}).get(tid) or []):
                if nt['s'] >= L:
                    continue
                t = t0 + nt['s'] * sd + (sd * swing * 0.66 if nt['s'] % 2 else 0.0)
                t = jitter_t(t)
                dur = nt.get('d', 1) * sd * 0.98
                v = jitter_v(nt.get('v', 1.0))
                if tid == 'bass':    add(tid, V.bass(nt['n'], dur, v), t)
                elif tid == 'lead':  add(tid, V.lead(nt['n'], dur, v, wave), t)
                elif tid == 'guitar':add(tid, V.guitar(nt['n'], dur, v, palm), t)
                elif tid == 'ten':   add(tid, V.tenore(nt['n'], dur, v), t)
                elif tid == 'laun':  laun_events.append({'t': t, 'n': nt['n'], 'dur': dur, 'v': v})
        # bordone
        if p.get('drone'):
            drone_note = p.get('droneNote', 38)
            s, e = int(t0 * sr), min(int((t0 + B * bar) * sr), total)
            ramp = min(int(0.4 * sr), max(e - s, 1))
            drone_gate[s:e] = 1.0
            drone_gate[s:s + ramp] = np.minimum(drone_gate[s:s + ramp], np.linspace(0, 1, ramp))

    # il colpo di hi-hat successivo strozza l'aperto
    drum_events.sort(key=lambda e: e[1])
    hat_times = sorted(t for tid, t, v in drum_events if tid in ('hhc', 'hho'))
    def choke(t):
        i = np.searchsorted(hat_times, t + 1e-6)
        return (hat_times[i] - t) if i < len(hat_times) else None

    for tid, t, v in drum_events:
        if tid == 'kick':
            kick_times.append(t)
        if not active(tid):
            continue
        if tid == 'kick':   add(tid, V.kick(v), t)
        elif tid == 'snare':add(tid, V.snare(v), t)
        elif tid == 'clap': add(tid, V.clap(v), t)
        elif tid == 'hhc':  add(tid, V.hat(v, False), t)
        elif tid == 'hho':  add(tid, V.hat(v, True, choke(t)), t)
        elif tid == 'tom':  add(tid, V.tom(v), t)
        elif tid == 'rim':  add(tid, V.rim(v), t)
        elif tid == 'tumb': add(tid, V.tumbarinu(v), t)

    # coda del bordone
    last = np.nonzero(drone_gate)[0]
    if len(last):
        e = last[-1] + 1
        k = min(int(0.8 * sr), total - e)
        if k > 0:
            drone_gate[e:e + k] = np.linspace(1, 0, k)

    if active('laun'):
        bufs['laun'] += render_launeddas(laun_events, total, sr, rng)
    drone = render_drone(drone_gate, drone_note, total, sr, rng)

    # ---- sidechain -----------------------------------------------------
    duck_db = float(fx.get('sidechainDb', 3.5))
    bass_pct = float(fx.get('bassDuck', 0.45))
    duck = np.ones(total)
    if duck_db > 0 and kick_times:
        shape_n = int(0.2 * sr)
        shape = np.ones(shape_n)
        a = int(0.006 * sr)
        depth = db(-duck_db)
        shape[:a] = np.linspace(1, depth, a)
        shape[a:] = np.linspace(depth, 1, shape_n - a)
        for t in kick_times:
            s = int(t * sr)
            n = min(shape_n, total - s)
            if n > 0:
                duck[s:s + n] = np.minimum(duck[s:s + n], shape[:n])
    duck_bass = 1 - (1 - duck) * bass_pct

    # ---- bus -----------------------------------------------------------
    drum_bus = np.zeros((2, total))
    duck_bus = np.zeros((2, total))
    bass_bus = np.zeros((2, total))
    rev_short = np.zeros((2, total))
    rev_long = np.zeros((2, total))

    for tid in DRUM_IDS + MEL_IDS:
        g = mgain(tid)
        if g <= 0:
            continue
        y = bufs[tid] * g
        send = float(mixer.get(tid, {}).get('reverb', DEFAULT_REV[tid]))
        bus = mixer.get(tid, {}).get('bus', DEFAULT_BUS[tid])
        if bus == 'drum':
            drum_bus += y; rev_short += y * send
        elif bus == 'bassduck':
            bass_bus += y; rev_long += y * send
        else:
            duck_bus += y; rev_long += y * send
    duck_bus += drone
    rev_long += drone * 0.25

    duck_bus *= duck
    bass_bus *= duck_bass

    # bus batteria: decimazione + bitcrush + saturazione + compressione
    # (il carattere "campionato" viene soprattutto dalla riduzione di sample rate)
    bits = int(fx.get('bits', 13))
    srdiv = max(int(fx.get('srDiv', 1)), 1)
    drive = float(fx.get('drive', 1.6))
    for c in range(2):
        x = drum_bus[c]
        if srdiv > 1:
            x = decimate(x, srdiv)
        if bits < 16:
            x = bitcrush(x * 0.9, bits) / 0.9
        x = sat(x, drive, 0.15)
        drum_bus[c] = compress(x, sr, -16, 4.0, 0.004, 0.14)

    # ---- riverberi ------------------------------------------------------
    mix = drum_bus + duck_bus + bass_bus
    ir_s = synth_ir(sr, 0.6, 3.2, 0.45, seed=11)
    ir_l = synth_ir(sr, 2.2, 2.4, 0.18, seed=23)
    gs = float(fx.get('reverbShort', 0.85)) * 0.25
    gl = float(fx.get('reverbLong', 0.85)) * 0.22
    for c in range(2):
        if gs > 0 and np.any(rev_short[c]):
            mix[c] += fftconvolve(rev_short[c], ir_s[c])[:total] * gs
        if gl > 0 and np.any(rev_long[c]):
            mix[c] += fftconvolve(rev_long[c], ir_l[c])[:total] * gl

    # ---- master ---------------------------------------------------------
    mix *= float(fx.get('master', 0.9))
    # basse in mono (compatibilità mono, come nel mix di "Tumbu")
    lo = [filt(mix[c], 'lp', 140, sr) for c in range(2)]
    mono_lo = (lo[0] + lo[1]) / 2
    for c in range(2):
        mix[c] += mono_lo - lo[c]
    for c in range(2):
        mix[c] = filt(mix[c], 'hp', 24, sr)
        mix[c] = compress(mix[c], sr, -12, 2.5, 0.008, 0.18)
        mix[c] = sat(mix[c], 1.05)
    peak = np.max(np.abs(mix)) + 1e-9
    mix *= db(-0.5) / peak

    out = {'mix': mix}
    if stems:
        for tid in DRUM_IDS + MEL_IDS:
            if np.any(bufs[tid]):
                out[tid] = bufs[tid] * mgain(tid)
        if np.any(drone):
            out['drone'] = drone
    info = {'bpm': bpm, 'seconds': total / sr, 'patterns': ''.join(seq),
            'kicks': len(kick_times), 'sr': sr}
    return out, info


def write_wav(path, stereo, sr):
    import wave
    x = np.clip(stereo, -1, 1)
    data = (x.T * 32767).astype('<i2').tobytes()
    with wave.open(path, 'wb') as w:
        w.setnchannels(2); w.setsampwidth(2); w.setframerate(sr)
        w.writeframes(data)


# ----------------------------------------------------------------------------
# export MIDI (tipo 1, 480 PPQ — le terzine cadono esatte)
# ----------------------------------------------------------------------------
GM_DRUM = {'kick': 36, 'snare': 38, 'clap': 39, 'hhc': 42, 'hho': 46,
           'tom': 45, 'rim': 37, 'tumb': 41}
GM_PROG = {'bass': (0, 38), 'guitar': (1, 30), 'lead': (2, 81),
           'laun': (3, 68), 'ten': (4, 52)}
MEL_NAMES = {'bass': 'Basso', 'guitar': 'Chitarra', 'lead': 'Lead',
             'laun': 'Launeddas', 'ten': 'Tenore'}


def write_midi(spec, path, chain=None, repeat=1):
    PPQ, BAR = 480, 1920
    pats = {p['name']: p for p in spec['patterns']}
    seq = list((chain or spec.get('chain') or 'A').upper().replace(' ', '')) * repeat
    seq = [c for c in seq if c in pats] or [spec['patterns'][0]['name']]

    def vlq(n):
        out = bytearray([n & 0x7F])
        n >>= 7
        while n:
            out.insert(0, (n & 0x7F) | 0x80)
            n >>= 7
        return bytes(out)

    def chunk(name, data):
        return name + len(data).to_bytes(4, 'big') + bytes(data)

    def track(name, ch, prog, events):
        if not events:
            return None
        events.sort(key=lambda e: (e[0], e[1]))
        d = bytearray(vlq(0) + b'\xFF\x03' + bytes([len(name)]) + name.encode())
        if prog is not None:
            d += vlq(0) + bytes([0xC0 | ch, prog])
        last = 0
        for tk, on, note, vel in events:
            d += vlq(int(tk - last)) + bytes([(0x90 if on else 0x80) | ch, note, vel if on else 0x40])
            last = tk
        d += vlq(0) + b'\xFF\x2F\x00'
        return chunk(b'MTrk', d)

    tempo = int(60000000 / float(spec.get('bpm', 100)))
    c = bytearray(vlq(0) + b'\xFF\x51\x03' + tempo.to_bytes(3, 'big'))
    c += vlq(0) + b'\xFF\x58\x04\x04\x02\x18\x08'
    c += vlq(0) + b'\xFF\x03\x07BeatLab'
    c += vlq(0) + b'\xFF\x2F\x00'
    tracks = [chunk(b'MTrk', c)]

    vel = lambda v: int(np.clip(round(v * 100), 1, 127))
    dev, off = [], 0
    for name in seq:
        p = pats[name]
        for tid in DRUM_IDS:
            d = div_of(p, tid)
            for i, v in enumerate((p.get('drums', {}).get(tid) or [])[:bars_of(p) * d]):
                if not v:
                    continue
                tk = off + round(i * BAR / d)
                dev.append((tk, 1, GM_DRUM[tid], vel(v)))
                dev.append((tk + 60, 0, GM_DRUM[tid], 0))
        off += bars_of(p) * BAR
    t = track('Batteria', 9, None, dev)
    if t:
        tracks.append(t)

    for tid in MEL_IDS:
        ch_, prog = GM_PROG[tid]
        ev, off = [], 0
        for name in seq:
            p = pats[name]
            for nt in (p.get('notes', {}).get(tid) or []):
                if nt['s'] >= bars_of(p) * 16:
                    continue
                tk = off + nt['s'] * (BAR // 16)
                ev.append((tk, 1, nt['n'], vel(nt.get('v', 1))))
                ev.append((tk + max(nt.get('d', 1) * (BAR // 16) - 6, 12), 0, nt['n'], 0))
            off += bars_of(p) * BAR
        t = track(MEL_NAMES[tid], ch_, prog, ev)
        if t:
            tracks.append(t)

    head = chunk(b'MThd', bytes([0, 1, 0, len(tracks)]) + PPQ.to_bytes(2, 'big'))
    with open(path, 'wb') as f:
        f.write(head + b''.join(tracks))
    return len(tracks)


def render_sf2(spec, sf2, out, sr=48000, chain=None, repeat=1, bitrate='320k'):
    """Suona il MIDI del progetto con un SoundFont via FluidSynth.

    Non è il suono di BeatLab: è General MIDI di buona fattura, utile per
    ascoltare l'arrangiamento con timbri "classici" o come base di confronto.
    Banchi consigliati: GeneralUser GS, FluidR3_GM.
    """
    import shutil, subprocess, tempfile
    fl = shutil.which('fluidsynth')
    if not fl:
        print("! fluidsynth non trovato: installalo con 'apt install fluidsynth' "
              "o 'brew install fluid-synth'.", file=sys.stderr)
        return False
    if not os.path.exists(sf2):
        print(f"! SoundFont non trovato: {sf2}", file=sys.stderr)
        return False
    with tempfile.TemporaryDirectory() as td:
        mid = os.path.join(td, 'beat.mid')
        write_midi(spec, mid, chain=chain, repeat=repeat)
        wav = os.path.join(td, 'beat.wav')
        r = subprocess.run([fl, '-ni', '-g', '0.5', '-r', str(sr),
                            '-F', wav, sf2, mid],
                           capture_output=True, text=True)
        if r.returncode != 0 or not os.path.exists(wav):
            print('! fluidsynth è fallito:', (r.stderr or '').strip()[:300], file=sys.stderr)
            return False
        ext = os.path.splitext(out)[1].lower()
        if ext in ('.wav', ''):
            shutil.copy(wav, out)
        elif not convert(wav, out, bitrate):
            shutil.copy(wav, os.path.splitext(out)[0] + '.wav')
    return True


def convert(src_wav, dst, bitrate='320k'):
    """converte il WAV in mp3/flac/ogg con ffmpeg (o lame per l'mp3)."""
    import shutil, subprocess, tempfile
    ext = os.path.splitext(dst)[1].lower().lstrip('.')
    if ext in ('wav', ''):
        return True
    ff = shutil.which('ffmpeg')
    if ff:
        cmd = [ff, '-y', '-loglevel', 'error', '-i', src_wav]
        if ext == 'mp3':
            cmd += ['-codec:a', 'libmp3lame', '-b:a', bitrate]
        elif ext == 'flac':
            cmd += ['-codec:a', 'flac', '-compression_level', '8']
        elif ext == 'ogg':
            cmd += ['-codec:a', 'libvorbis', '-qscale:a', '7']
        cmd.append(dst)
        if subprocess.run(cmd).returncode == 0:
            return True
    if ext == 'mp3' and shutil.which('lame'):
        return subprocess.run(['lame', '--quiet', '-b', bitrate.rstrip('k'),
                               src_wav, dst]).returncode == 0
    print(f"! non riesco a scrivere .{ext}: serve ffmpeg (brew install ffmpeg / "
          f"apt install ffmpeg). Resta il WAV.", file=sys.stderr)
    return False


def main():
    ap = argparse.ArgumentParser(description='Render offline dei pattern BeatLab')
    ap.add_argument('json', help='file JSON esportato da BeatLab')
    ap.add_argument('-o', '--out', default='beat.wav',
                    help='file di uscita: .wav, .mp3, .flac o .ogg')
    ap.add_argument('--bitrate', default='320k', help='bitrate mp3 (default 320k)')
    ap.add_argument('--sr', type=int, default=48000)
    ap.add_argument('--chain', default=None, help='es. AABACD (sovrascrive il JSON)')
    ap.add_argument('--repeat', type=int, default=1)
    ap.add_argument('--tail', type=float, default=3.0)
    ap.add_argument('--seed', type=int, default=1234)
    ap.add_argument('--stems', action='store_true', help='esporta anche gli stem separati')
    ap.add_argument('--midi', metavar='FILE.mid', default=None,
                    help='scrive anche un file MIDI (batteria su canale 10)')
    ap.add_argument('--midi-only', action='store_true', help='solo MIDI, niente audio')
    ap.add_argument('--sf2', metavar='BANCO.sf2', default=None,
                    help='suona il MIDI con questo SoundFont via FluidSynth '
                         'invece di usare il motore di sintesi')
    a = ap.parse_args()

    with open(a.json) as f:
        spec = json.load(f)
    if spec.get('format') not in ('beatlab/1', 'beatlab/2'):
        print('attenzione: formato non riconosciuto, provo comunque', file=sys.stderr)

    if a.midi or a.midi_only:
        mp = a.midi or (os.path.splitext(a.out)[0] + '.mid')
        n = write_midi(spec, mp, chain=a.chain, repeat=a.repeat)
        print(f'✓ {mp}  —  {n} tracce, 480 PPQ')
        if a.midi_only:
            return

    if a.sf2:
        ok = render_sf2(spec, a.sf2, a.out, sr=a.sr, chain=a.chain,
                        repeat=a.repeat, bitrate=a.bitrate)
        if ok:
            print(f'✓ {a.out}  —  suonato con {os.path.basename(a.sf2)} (General MIDI)')
        else:
            sys.exit(1)
        return

    out, info = render(spec, sr=a.sr, chain=a.chain, repeat=a.repeat,
                       tail=a.tail, seed=a.seed, stems=a.stems)
    ext = os.path.splitext(a.out)[1].lower()
    wav_path = a.out if ext in ('.wav', '') else os.path.splitext(a.out)[0] + '.wav'
    write_wav(wav_path, out['mix'], a.sr)
    final = wav_path
    if wav_path != a.out:
        if convert(wav_path, a.out, a.bitrate):
            os.remove(wav_path)
            final = a.out
    print(f"✓ {final}  —  {info['seconds']:.1f}s  {info['bpm']:.0f} BPM  "
          f"catena {info['patterns']}  {info['sr']} Hz")
    if a.stems:
        d = os.path.splitext(a.out)[0] + '_stems'
        os.makedirs(d, exist_ok=True)
        for k, v in out.items():
            if k == 'mix':
                continue
            p = os.path.join(d, k + '.wav')
            write_wav(p, v / (np.max(np.abs(v)) + 1e-9) * 0.89, a.sr)
        print(f'✓ stem in {d}/')


if __name__ == '__main__':
    main()
