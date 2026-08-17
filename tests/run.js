#!/usr/bin/env node
/* BeatLab — suite di test.
 *
 *   node tests/run.js [http://localhost:8000]
 *
 * Serve un server sulla cartella del progetto (i moduli ES non si caricano da
 * file://) e Playwright con Chromium. Esce con codice 1 se qualcosa fallisce,
 * così la CI se ne accorge.
 */
const { chromium } = require('playwright');
const fs = require('fs');
const os = require('os');
const path = require('path');

const BASE = process.argv[2] || 'http://localhost:8000';
let pass = 0, fail = 0;
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log('  \x1b[32m✓\x1b[0m ' + name); }
  else { fail++; console.log('  \x1b[31m✗\x1b[0m ' + name + (detail ? '  → ' + detail : '')); }
};
const near = (a, b, tol) => Math.abs(a - b) <= tol;

(async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ acceptDownloads: true });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push('pageerror: ' + e.message));
  page.on('console', m => { if (m.type() === 'error') errors.push('console: ' + m.text()); });

  await page.goto(BASE + '/');
  await page.waitForTimeout(800);

  // ---------------------------------------------------------------- interfaccia
  console.log('\ninterfaccia');
  const dom = await page.evaluate(() => ({
    drums: document.querySelectorAll('#drumgrid .grow').length,
    notes: document.querySelectorAll('#notegrid .grow').length,
    mixer: document.querySelectorAll('#mixer .ctl').length,
    fx: document.querySelectorAll('#fx .ctl').length,
    slots: document.querySelectorAll('#slots .slot').length,
    share: !!document.getElementById('share'),
    stems: !!document.getElementById('expstems'),
    light: !!document.getElementById('lightmode'),
  }));
  ok('8 tracce di batteria', dom.drums === 8, 'trovate ' + dom.drums);
  ok('15 righe nella griglia melodica', dom.notes === 15, 'trovate ' + dom.notes);
  ok('13 canali nel mixer', dom.mixer === 13, 'trovati ' + dom.mixer);
  ok('8 controlli di effetto', dom.fx === 8, 'trovati ' + dom.fx);
  ok('4 slot di pattern', dom.slots === 4);
  ok('tasti Condividi, Stem e Modo leggero presenti', dom.share && dom.stems && dom.light);

  // ---------------------------------------------------------------- generatore
  console.log('\ngeneratore');
  const gen = await page.evaluate(async () => {
    const st = await import('./js/state.js');
    const g = await import('./js/generator.js');
    st.proj.cur = 0;
    g.generate('breakbeat', 0, 4242);
    const a = JSON.stringify(st.proj.patterns[0].tr);
    g.generate('breakbeat', 0, 4242);
    const b = JSON.stringify(st.proj.patterns[0].tr);
    g.generate('breakbeat', 0, 9999);
    const c = JSON.stringify(st.proj.patterns[0].tr);
    const styles = {};
    for (const s of ['boombap', 'breakbeat', 'dbeat', 'ethno', 'trap']) {
      g.generate(s, 0, 100);
      styles[s] = st.proj.patterns[0].tr.kick.filter(x => x > 0).length;
    }
    return { stesso: a === b, diverso: a !== c, styles };
  });
  ok('stesso seed = stesso pattern', gen.stesso);
  ok('seed diverso = pattern diverso', gen.diverso);
  for (const [s, n] of Object.entries(gen.styles)) ok('stile ' + s + ' produce colpi di cassa', n > 0);

  // ---------------------------------------------------------------- undo/redo
  console.log('\nmodifica e annullamento');
  const undo = await page.evaluate(async () => {
    const st = await import('./js/state.js');
    const g = await import('./js/generator.js');
    st.proj.cur = 0; g.generate('breakbeat', 0, 111); st.hooks.refresh();
    const before = JSON.stringify(st.proj.patterns[0].tr.kick);
    st.pushUndo(); st.proj.patterns[0].tr.kick.fill(0); st.hooks.refresh();
    const cleared = JSON.stringify(st.proj.patterns[0].tr.kick);
    st.undo(); const back = JSON.stringify(st.proj.patterns[0].tr.kick);
    st.redo(); const again = JSON.stringify(st.proj.patterns[0].tr.kick);
    return { undo: back === before, redo: again === cleared };
  });
  ok('annulla ripristina lo stato precedente', undo.undo);
  ok('rifai riapplica la modifica', undo.redo);

  const paint = await page.evaluate(() => {
    const c = document.querySelector('#drumgrid [data-tr=clap]');
    const was = c.classList.contains('on');
    c.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    document.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }));
    return { cambiato: c.classList.contains('on') !== was };
  });
  ok('il click accende una cella', paint.cambiato);

  // ---------------------------------------------------------------- terzine
  console.log('\nsuddivisioni');
  const div = await page.evaluate(async () => {
    const st = await import('./js/state.js');
    const bar = st.barDur();
    return {
      terzine: [0, 1, 2, 3].map(i => +(st.stepTime(0, i, 12) / bar).toFixed(4)),
      sedic: [0, 2].map(i => +(st.stepTime(0, i, 16) / bar).toFixed(4)),
    };
  });
  ok('12 passi cadono sulle terzine', near(div.terzine[1], 1 / 12, 1e-4),
    'passo 1 a ' + div.terzine[1] + ' di battuta');
  ok('16 passi cadono sui sedicesimi', near(div.sedic[1], 2 / 16, 1e-4));

  // ---------------------------------------------------------------- audio
  console.log('\naudio');
  const silence = await page.evaluate(async () => {
    const st = await import('./js/state.js');
    const aud = await import('./js/audio.js');
    st.proj.cur = 0;
    st.proj.patterns[0] = st.emptyPattern(2);
    const buf = await aud.renderBuffer(1);
    const d = buf.getChannelData(0);
    let s = 0; for (let i = 0; i < d.length; i++) s += d[i] * d[i];
    return 20 * Math.log10(Math.sqrt(s / d.length) + 1e-12);
  });
  // Un pattern vuoto deve tacere davvero. È l'invariante che scopre sia gli LFO
  // collegati per sbaglio a parametri sempre vivi, sia le componenti continue
  // lasciate dalle tabelle dei waveshaper.
  ok('un pattern vuoto è silenzioso', silence < -90, silence.toFixed(1) + ' dBFS');

  const audio = await page.evaluate(async () => {
    const st = await import('./js/state.js');
    const g = await import('./js/generator.js');
    const aud = await import('./js/audio.js');
    st.proj.cur = 0; g.generate('breakbeat', 0, 4242);
    st.proj.patterns[0].drone = true;
    const t0 = performance.now();
    const buf = await aud.renderBuffer(1);
    const ms = performance.now() - t0;
    const d = buf.getChannelData(0), e = buf.getChannelData(1);
    let peak = 0, sum = 0, dc = 0;
    for (let i = 0; i < d.length; i++) {
      const a = Math.abs(d[i]); if (a > peak) peak = a;
      sum += d[i] * d[i]; dc += d[i];
    }
    return {
      secs: buf.duration, peak, rms: Math.sqrt(sum / d.length),
      dc: dc / d.length, stereo: !d.every((v, i) => v === e[i]),
      xrt: buf.duration * 1000 / ms,
    };
  });
  ok('il render produce audio', audio.rms > 0.01, 'rms ' + audio.rms.toFixed(4));
  ok('nessuna saturazione', audio.peak <= 1.0, 'picco ' + audio.peak.toFixed(3));
  ok('niente componente continua', Math.abs(audio.dc) < 0.01, 'dc ' + audio.dc.toFixed(5));
  ok('uscita stereo', audio.stereo);
  ok('render più veloce del tempo reale', audio.xrt > 1.5, audio.xrt.toFixed(1) + '×');

  const choke = await page.evaluate(async () => {
    const st = await import('./js/state.js');
    const aud = await import('./js/audio.js');
    // L'aperto parte al passo 0, il chiuso al passo 1 (0,15 s dopo). Il chiuso
    // è muto, così nella misura resta solo la coda dell'aperto — e il choke
    // deve scattare lo stesso, perché il mixer decide cosa si sente, non cosa
    // succede.
    const revS = st.proj.fx.revS, revL = st.proj.fx.revL;
    const mis = async (conChiuso) => {
      st.proj.cur = 0;
      const p = st.emptyPattern(1);
      p.tr.hho[0] = 1; if (conChiuso) p.tr.hhc[1] = 1;
      st.proj.patterns[0] = p;
      st.proj.hum.t = 0; st.proj.hum.v = 0;
      st.proj.fx.revS = 0; st.proj.fx.revL = 0;
      st.proj.mix.hhc.mute = true;
      const buf = await aud.renderBuffer(1);
      st.proj.mix.hhc.mute = false;
      const d = buf.getChannelData(0), sr = buf.sampleRate;
      let s = 0, n = 0;
      for (let i = Math.floor(0.24 * sr); i < Math.floor(0.40 * sr); i++) { s += d[i] * d[i]; n++; }
      return Math.sqrt(s / n);
    };
    const r = { senza: await mis(false), con: await mis(true) };
    st.proj.fx.revS = revS; st.proj.fx.revL = revL;
    return r;
  });
  ok('il chiuso strozza l\'aperto', choke.con < choke.senza * 0.5,
    'coda ' + choke.senza.toExponential(2) + ' → ' + choke.con.toExponential(2));

  // ---------------------------------------------------------------- condivisione
  console.log('\ncondivisione e formato');
  const share = await page.evaluate(async () => {
    const st = await import('./js/state.js');
    const g = await import('./js/generator.js');
    const sh = await import('./js/share.js');
    st.proj.cur = 0; g.generate('ethno', 0, 31337);
    st.proj.bpm = 123; st.proj.patterns[0].drone = true;
    const prima = JSON.stringify(st.toJSON());
    const url = await sh.shareLink();
    // sporco lo stato, poi ricarico dal link
    g.generate('trap', 0, 1); st.proj.bpm = 90;
    location.hash = url.split('#')[1];
    const caricato = await sh.loadFromHash();
    sh.clearHash();
    return { url, caricato, uguale: JSON.stringify(st.toJSON()) === prima, len: url.length };
  });
  ok('il link viene generato', share.url.includes('#p='));
  ok('il link si rilegge', share.caricato);
  ok('il progetto sopravvive al giro completo', share.uguale);
  ok('link di dimensione ragionevole', share.len < 8000, share.len + ' caratteri');

  const json = await page.evaluate(async () => {
    const st = await import('./js/state.js');
    const j = st.toJSON();
    const before = JSON.stringify(j);
    st.fromJSON(JSON.parse(before));
    return { formato: j.format, round: JSON.stringify(st.toJSON()) === before,
             div: j.patterns[0].div.tumb, bars: j.patterns[0].bars };
  });
  ok('formato beatlab/2', json.formato === 'beatlab/2');
  ok('JSON stabile al giro completo', json.round);
  ok('suddivisioni salvate nel JSON', typeof json.div === 'number');

  // ---------------------------------------------------------------- export
  console.log('\nexport');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'beatlab-'));
  const grab = async (sel, timeout = 240000) => {
    const dl = page.waitForEvent('download', { timeout });
    await page.click(sel);
    const d = await dl;
    const f = path.join(tmp, d.suggestedFilename());
    await d.saveAs(f);
    return { name: d.suggestedFilename(), size: fs.statSync(f).size, file: f };
  };
  await page.selectOption('#reps', '1');
  const mid = await grab('#expmidi');
  ok('MIDI esportato', mid.size > 200 && mid.name.endsWith('.mid'), mid.size + ' byte');
  const head = fs.readFileSync(mid.file).subarray(0, 4).toString('latin1');
  ok('MIDI con intestazione valida', head === 'MThd', head);

  const wav = await grab('#expwav');
  ok('WAV esportato', wav.size > 100000 && wav.name.endsWith('.wav'), wav.size + ' byte');
  const wh = fs.readFileSync(wav.file).subarray(0, 12).toString('latin1');
  ok('WAV con intestazione valida', wh.startsWith('RIFF') && wh.includes('WAVE'));

  const zip = await grab('#expstems');
  ok('stem esportati', zip.size > 100000 && zip.name.endsWith('.zip'), zip.size + ' byte');
  const zh = fs.readFileSync(zip.file).subarray(0, 2).toString('latin1');
  ok('zip con intestazione valida', zh === 'PK');

  const mixOk = await page.evaluate(async () => {
    const st = await import('./js/state.js');
    return !Object.values(st.proj.mix).some(m => m.solo || m.mute);
  });
  ok('il mixer torna com\'era dopo gli stem', mixOk);

  // ---------------------------------------------------------------- riproduzione
  console.log('\nriproduzione');
  await page.click('#play');
  await page.waitForTimeout(1800);
  const live = await page.evaluate(async () => {
    const aud = await import('./js/audio.js');
    return { playing: aud.isPlaying(), coda: aud.getQueued().length,
             testina: document.querySelectorAll('#playhead .ph.a').length };
  });
  ok('il trasporto parte', live.playing);
  ok('i pattern vengono programmati in anticipo', live.coda >= 1);
  ok('la testina si muove', live.testina === 1);
  await page.click('#stop');
  await page.waitForTimeout(400);

  console.log('\nerrori di pagina');
  ok('nessun errore in console', errors.length === 0, errors.slice(0, 3).join(' | '));

  fs.rmSync(tmp, { recursive: true, force: true });
  await browser.close();

  console.log('\n' + (fail === 0
    ? `\x1b[32mtutto a posto: ${pass} verifiche superate\x1b[0m`
    : `\x1b[31m${fail} verifiche fallite\x1b[0m su ${pass + fail}`));
  process.exit(fail === 0 ? 0 : 1);
})().catch(e => { console.error('\nla suite si è interrotta:', e); process.exit(1); });
