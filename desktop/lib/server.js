/* Un server statico minuscolo, sul solo indirizzo di casa.

   Perché non caricare la app da `file://` e basta: i moduli ES non si caricano
   da file — è la stessa ragione per cui in locale BeatLab ha sempre chiesto un
   server. Servirla da http://127.0.0.1 ha anche un secondo pregio, meno
   ovvio: dentro la finestra la app gira *esattamente* come su GitHub Pages,
   stesso protocollo e stesse regole. Quello che funziona qui funziona lì. */

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const TIPI = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',   // obbligatorio: se sbagli qui i moduli non partono
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml',
  '.wav': 'audio/wav', '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg',
  '.webmanifest': 'application/manifest+json',
};

function serve(root) {
  const srv = http.createServer((req, res) => {
    let rel = decodeURIComponent(req.url.split('?')[0]);
    if (rel.endsWith('/')) rel += 'index.html';
    /* niente risalite fuori dalla radice, nemmeno per sbaglio */
    const file = path.join(root, path.normalize(rel).replace(/^([/\\])+/, ''));
    if (!file.startsWith(root)) { res.writeHead(403).end('fuori radice'); return; }

    fs.readFile(file, (err, data) => {
      if (err) { res.writeHead(404).end('non trovato'); return; }
      res.writeHead(200, {
        'Content-Type': TIPI[path.extname(file).toLowerCase()] || 'application/octet-stream',
        /* la finestra è il posto dove si sviluppa: una cache qui vorrebbe dire
           modificare un file e non vedere niente cambiare */
        'Cache-Control': 'no-store',
      });
      res.end(data);
    });
  });

  return new Promise(resolve => {
    srv.listen(0, '127.0.0.1', () => resolve({ srv, port: srv.address().port }));
  });
}

module.exports = { serve };
