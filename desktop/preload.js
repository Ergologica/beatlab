/* Il ponte, e nient'altro.

   Questo è l'unico punto in cui la pagina tocca il mondo fuori, quindi è
   scritto per essere piccolo abbastanza da leggerlo tutto d'un fiato. La
   pagina non riceve né `require`, né il modulo `fs`, né la possibilità di
   costruirsi un comando: riceve delle domande già formate, e il processo
   principale decide come rispondere. Anche i percorsi che passa vengono
   verificati di là — qui non c'è nessun controllo, per non dare l'impressione
   che ce ne sia uno.

   Il nome `beatlabHost` è anche il segnale: `js/host.js` esiste solo per
   cercarlo. Su GitHub Pages non c'è, e la app resta quella di prima. */

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('beatlabHost', {
  info: () => ipcRenderer.invoke('host:info'),
  conf: patch => ipcRenderer.invoke('host:conf', patch),
  dipendenze: () => ipcRenderer.invoke('host:dipendenze'),

  estrai: o => ipcRenderer.invoke('host:estrai', o),
  render: o => ipcRenderer.invoke('host:render', o),

  lavori: () => ipcRenderer.invoke('host:lavori'),
  righe: id => ipcRenderer.invoke('host:righe', id),
  annulla: id => ipcRenderer.invoke('host:annulla', id),
  pulisci: () => ipcRenderer.invoke('host:pulisci'),

  risultato: dir => ipcRenderer.invoke('host:risultato', dir),
  audio: rel => ipcRenderer.invoke('host:audio', rel),
  apri: rel => ipcRenderer.invoke('host:apri', rel),
  scegliFile: o => ipcRenderer.invoke('host:scegliFile', o),

  /* un solo canale di ritorno, con l'evento dentro: aggiungere una tappa non
     deve voler dire aggiungere un canale e ricordarsi di ripulirlo */
  ascolta: cb => {
    const h = (_e, ev) => cb(ev);
    ipcRenderer.on('host:evento', h);
    return () => ipcRenderer.removeListener('host:evento', h);
  },
});
