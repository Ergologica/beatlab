#!/usr/bin/env bash
# Cosa c'è e cosa manca, detto in JSON.
#
# Gira dalla parte del Python (dentro WSL, se siamo su Windows) perché è l'unico
# posto da cui la domanda ha senso: che `ffmpeg` esista in Windows non serve a
# niente se poi Demucs lo cerca in Linux. Uso: probe.sh /percorso/di/python3
#
# Non fallisce mai: ogni sonda che va male diventa "ok": false con il motivo.
# Un controllo dipendenze che si interrompe alla prima assenza è inutile —
# serve proprio quando manca tutto.

PY="${1:-python3}"
BIN="$(dirname "$PY")"
[ -d "$BIN" ] && PATH="$BIN:$PATH"

esc() { printf '%s' "$1" | tr -d '\000-\037' | sed 's/\\/\\\\/g; s/"/\\"/g'; }

first=1
row() { # id  ok  versione  nota
  [ $first -eq 1 ] && first=0 || printf ',\n'
  printf '  "%s": {"ok": %s, "version": "%s", "note": "%s"}' \
    "$1" "$2" "$(esc "$3")" "$(esc "$4")"
}

printf '{\n'

# --- Python ---
if v="$("$PY" -c 'import sys;print("%d.%d.%d"%sys.version_info[:3])' 2>&1)"; then
  row python true "$v" "$PY"
else
  row python false "" "non eseguibile: $PY"
fi

# --- numpy e scipy: il cuore dell'analisi, senza non si misura niente ---
for m in numpy scipy; do
  if v="$("$PY" -c "import $m;print($m.__version__)" 2>&1)"; then
    row "$m" true "$v" ""
  else
    row "$m" false "" "manca nell'ambiente di $PY"
  fi
done

# --- yt-dlp: lo script lo chiama come eseguibile, non come modulo ---
if v="$(yt-dlp --version 2>&1)"; then
  row ytdlp true "$v" "$(command -v yt-dlp)"
else
  row ytdlp false "" "serve solo per i link; con un file audio locale non occorre"
fi

# --- Demucs: come modulo, che è come lo lancia beatlab_extract.py ---
if "$PY" -m demucs --help >/dev/null 2>&1; then
  v="$("$PY" -c 'import demucs;print(getattr(demucs,"__version__","?"))' 2>/dev/null)"
  row demucs true "$v" ""
else
  row demucs false "" "senza, resta --no-separate (niente voce staccata dalla base)"
fi

# --- ffmpeg: taglia, converte, e yt-dlp ci passa sempre ---
# `command -v` prima di tutto: in una pipeline conta l'uscita dell'ultimo
# comando, quindi `ffmpeg ... | head` riesce anche quando ffmpeg non esiste.
if command -v ffmpeg >/dev/null 2>&1; then
  row ffmpeg true "$(ffmpeg -version 2>/dev/null | head -1 | awk '{print $3}')" ""
else
  row ffmpeg false "" "non trovato"
fi

# --- motore JavaScript: novità del 2026, YouTube non si scarica più senza ---
jsr=""
if command -v deno >/dev/null 2>&1; then
  jsr="deno $(deno --version 2>/dev/null | head -1 | awk '{print $2}')"
elif [ -x "$HOME/.deno/bin/deno" ]; then
  jsr="deno $("$HOME/.deno/bin/deno" --version 2>/dev/null | head -1 | awk '{print $2}') (fuori dal PATH)"
elif command -v node >/dev/null 2>&1; then
  jsr="node $(node --version 2>/dev/null)"
fi
if [ -n "$jsr" ]; then
  row jsruntime true "$jsr" "yt-dlp lo usa per firmare le richieste a YouTube"
else
  row jsruntime false "" "senza, YouTube risponde 403 anche con yt-dlp aggiornato"
fi

printf '\n}\n'
