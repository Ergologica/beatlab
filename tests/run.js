#!/usr/bin/env node
/* BeatLab — suite di test.
 *
 *   node tests/run.js [http://localhost:8000]
 *
 * Serve un server sulla cartella del progetto (i moduli ES non si caricano da
 * file://) e Playwright con Chromium. Esce con codice 1 se qualcosa fallisce,
 * così la CI se ne accorge.
 */
const { chromium, devices } = require('playwright');
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

/* Dove un Chromium c'è già ma non è quello che Playwright si aspetta
   (container, CI con le immagini precotte), lo si indica invece di scaricarne
   un altro da mezzo giga. */
const EXE = process.env.BEATLAB_CHROMIUM || undefined;

(async () => {
  const browser = await chromium.launch(EXE ? { executablePath: EXE } : {});
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

  // ---------------------------------------------------------------- estrazione
  console.log('\nestrazione da un video');
  const cmd = await page.evaluate(async () => {
    const x = await import('./js/extract.js');
    return {
      vuoto: x.buildCommand({}),
      base: x.buildCommand({ url: 'https://youtu.be/abc123' }),
      tutto: x.buildCommand({
        url: 'https://youtu.be/abc123', sep: '4', start: '1:12',
        duration: '30', bars: 4, slices: 'hits',
      }),
      niente: x.buildCommand({ url: 'https://youtu.be/abc123', sep: '0' }),
      sporco: x.buildCommand({ url: '  "https://youtu.be/x"; rm -rf /  ' }),
      oraNo: x.buildCommand({ url: 'u', start: 'domani', duration: 'tanto' }),
    };
  });
  ok('il comando nomina lo script giusto', cmd.vuoto.startsWith('python3 py/beatlab_extract.py'));
  ok('senza link resta un segnaposto', cmd.vuoto.includes('INCOLLA-QUI-IL-LINK'));
  ok('voce + base è il default', cmd.base.includes('--two-stems') && !cmd.base.includes('--bars'));
  ok('quattro tracce tolgono --two-stems', !cmd.tutto.includes('--two-stems'));
  ok('le opzioni finiscono nel comando',
    cmd.tutto.includes('--start 1:12') && cmd.tutto.includes('--duration 30')
    && cmd.tutto.includes('--bars 4') && cmd.tutto.includes('--slices hits'), cmd.tutto);
  ok('«nessuna separazione» passa --no-separate', cmd.niente.includes('--no-separate'));
  ok('le virgolette incollate per sbaglio spariscono',
    !cmd.sporco.replace(/^[^"]*"|"[^"]*$/g, '').includes('"'), cmd.sporco);
  ok('un tempo che non è un tempo viene ignorato',
    !cmd.oraNo.includes('--start') && !cmd.oraNo.includes('--duration'), cmd.oraNo);

  const panel = await page.evaluate(() => ({
    url: !!document.getElementById('yturl'),
    copia: !!document.getElementById('ytcopy'),
    prog: !!document.getElementById('ytproj'),
    rif: !!document.getElementById('ytref'),
    ctl: getComputedStyle(document.getElementById('refctl')).display,
    cmd: document.getElementById('ytcmd').textContent,
  }));
  ok('il pannello di estrazione c\'è', panel.url && panel.copia && panel.prog && panel.rif);
  ok('i controlli del riferimento sono nascosti finché non se ne carica uno',
    panel.ctl === 'none');
  ok('il comando è già scritto all\'avvio', panel.cmd.includes('beatlab_extract.py'));

  // la voce di riferimento si sente, ma non deve finire nell'export
  const rif = await page.evaluate(async () => {
    const x = await import('./js/extract.js');
    const e = await import('./js/exporters.js');
    const a = await import('./js/audio.js');
    const st = await import('./js/state.js');
    /* mezzo secondo di rumore, impacchettato come farebbe un file vero */
    const oc = new OfflineAudioContext(2, 22050, 44100);
    const b = oc.createBuffer(2, 22050, 44100);
    for (let c = 0; c < 2; c++) {
      const d = b.getChannelData(c);
      for (let i = 0; i < d.length; i++) d[i] = Math.sin(i / 7) * 0.5;
    }
    const wav = e.encodeWav(b);
    const file = new File([wav], 'voce.wav', { type: 'audio/wav' });
    await x.decodeReference(file);
    const dur = x.ref.buf.duration;
    st.proj.patterns[st.proj.cur] = st.emptyPattern(1);
    st.proj.cur = 0; st.proj.song = false;
    const out = await a.renderBuffer(1);
    let peak = 0;
    const ch = out.getChannelData(0);
    for (let i = 0; i < ch.length; i++) peak = Math.max(peak, Math.abs(ch[i]));
    x.clearReference();
    return { dur, nome: x.ref.name, peak };
  });
  ok('la traccia di riferimento si decodifica', Math.abs(rif.dur - 0.5) < 0.02, rif.dur + ' s');
  ok('il riferimento non entra nell\'export', rif.peak === 0, 'picco ' + rif.peak);
  ok('togliere il riferimento lo toglie davvero', rif.nome === '');

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

  // ---------------------------------------------------------------- telefono
  console.log('\nlayout su telefono');
  const mob = await browser.newContext({ ...devices['iPhone 14'] });
  const mp = await mob.newPage();
  const mobErrors = [];
  mp.on('pageerror', e => mobErrors.push(e.message));
  await mp.goto(BASE + '/');
  await mp.waitForTimeout(800);
  const layout = await mp.evaluate(() => {
    const vis = el => el && getComputedStyle(el).display !== 'none';
    const tb = document.getElementById('tabbar');
    const btns = [...tb.querySelectorAll('button')];
    const secs = [...document.querySelectorAll('main>section')]
      .filter(s => getComputedStyle(s).display !== 'none');
    const cell = document.querySelector('#drumgrid .cell');
    const lab = document.querySelector('#drumgrid .glabel');
    const r = cell.getBoundingClientRect(), tr = tb.getBoundingClientRect();
    return {
      tabbar: vis(tb), tab: btns.length,
      tabMinH: Math.min(...btns.map(b => b.getBoundingClientRect().height)),
      sezioni: secs.length,
      cella: Math.min(r.width, r.height),
      nomiFissi: getComputedStyle(lab).position === 'sticky',
      barraInFondo: Math.abs(tr.bottom - innerHeight) < 2,
      scrollOrizzontale: document.documentElement.scrollWidth > innerWidth + 1,
    };
  });
  ok('barra di navigazione presente', layout.tabbar);
  ok('cinque destinazioni, non di più', layout.tab === 5, 'trovate ' + layout.tab);
  ok('bersagli di almeno 44 px', layout.tabMinH >= 44, layout.tabMinH + ' px');
  ok('una sola sezione alla volta', layout.sezioni === 1, layout.sezioni + ' visibili');
  ok('celle comode al tocco', layout.cella >= 30, layout.cella.toFixed(0) + ' px');
  ok('la colonna dei nomi resta ferma', layout.nomiFissi);
  ok('la barra tocca il fondo dello schermo', layout.barraInFondo);
  ok('la pagina non scorre in orizzontale', !layout.scrollOrizzontale);

  const nav = await mp.evaluate(() => {
    document.querySelector('#tabbar button[data-sec=mix]').click();
    const on = [...document.querySelectorAll('main>section')]
      .filter(s => getComputedStyle(s).display !== 'none').map(s => s.dataset.sec);
    const mixer = document.querySelectorAll('#mixer .ctl').length;
    return { on, mixer };
  });
  ok('la navigazione cambia sezione', nav.on.length === 1 && nav.on[0] === 'mix', nav.on.join(','));
  ok('il mixer è raggiungibile dal telefono', nav.mixer === 13);

  /* La regola dei 44 px vale per tutti i comandi, non solo per la barra in
     basso: erano fermi a 39 e nessuno li aveva mai misurati. */
  const file = await mp.evaluate(() => {
    document.querySelector('#tabbar button[data-sec=esporta]').click();
    const sec = document.querySelector('main>section[data-sec=esporta]');
    const els = [...sec.querySelectorAll('button, select, input[type=text], input[type=url], input[type=number]')]
      .filter(e => e.offsetParent !== null && !e.classList.contains('mini'));
    const h = els.map(e => ({ id: e.id || e.textContent.trim().slice(0, 12),
                              h: Math.round(e.getBoundingClientRect().height) }));
    return {
      n: h.length,
      minima: Math.min(...h.map(x => x.h)),
      piccoli: h.filter(x => x.h < 44).map(x => x.id + ':' + x.h).join(' '),
      scrollOrizzontale: document.documentElement.scrollWidth > innerWidth + 1,
      cmdDentro: (() => { const c = document.getElementById('ytcmd');
        return c.scrollWidth <= Math.ceil(c.getBoundingClientRect().width) + 1; })(),
      urlNonCorretto: (e => e.getAttribute('autocapitalize') === 'off'
        && e.getAttribute('spellcheck') === 'false')(document.getElementById('yturl')),
      acceptJson: document.getElementById('ytfp').accept.includes('application/json'),
      acceptAudio: document.getElementById('ytfr').accept.includes('.wav'),
    };
  });
  ok('comandi di almeno 44 px anche nella scheda File',
    file.minima >= 44, file.piccoli || file.minima + ' px su ' + file.n);
  ok('la scheda File non scorre in orizzontale', !file.scrollOrizzontale);
  ok('il comando va a capo invece di sbordare', file.cmdDentro);
  ok('il campo del link non viene corretto dalla tastiera', file.urlNonCorretto);
  ok('i selettori di file non filtrano via i file veri',
    file.acceptJson && file.acceptAudio);
  ok('nessun errore su telefono', mobErrors.length === 0, mobErrors.slice(0, 2).join(' | '));
  await mob.close();

  fs.rmSync(tmp, { recursive: true, force: true });
  await browser.close();

  console.log('\n' + (fail === 0
    ? `\x1b[32mtutto a posto: ${pass} verifiche superate\x1b[0m`
    : `\x1b[31m${fail} verifiche fallite\x1b[0m su ${pass + fail}`));
  process.exit(fail === 0 ? 0 : 1);
})().catch(e => { console.error('\nla suite si è interrotta:', e); process.exit(1); });
