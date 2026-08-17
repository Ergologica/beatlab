# Come pubblicare BeatLab su GitHub

Il repository è già pronto: git inizializzato, primo commit fatto. Mancano solo
tre passaggi, tutti dal tuo computer.

## 1. Crea il repository su GitHub

Su [github.com](https://github.com) → **+** in alto a destra → **New repository**:

- Nome: `beatlab`
- Visibilità: **Public** (serve per GitHub Pages sul piano gratuito)
- **Non** aggiungere README, .gitignore o licenza: il repo deve restare vuoto

## 2. Push

Scompatta lo zip, entra nella cartella e spingi:

```bash
cd beatlab
git remote add origin https://github.com/Ergologica/beatlab.git
git push -u origin main
```

(Se il branch locale si chiama `master`: `git branch -m master main` prima del push.)

## 3. Attiva GitHub Pages

Sul repo → **Settings** → **Pages** →
Source: *Deploy from a branch* → Branch: `main`, cartella `/ (root)` → **Save**.

Dopo un paio di minuti la app è online su:

**https://ergologica.github.io/beatlab/**

Da lì si installa anche come app (menu del browser → *Installa BeatLab*) e
funziona offline.

## Per lavorarci in locale

```bash
python3 -m http.server 8000
# → http://localhost:8000
```

(I moduli ES non si caricano aprendo index.html con doppio click: serve un
server, anche minimo come questo.)
