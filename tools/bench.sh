#!/bin/bash
# bench.sh <fps|0=uncapped> <max-size> <bitrate> [seconds]
# Runs scrcpy with --print-fps, then prints stats (startup + 0-fps samples excluded).
D=/Users/finnvignon/Documents/tools/scrcpy-macos-x86_64-v4.1
export ADB="$D/adb"
FPS=$1; SIZE=$2; BR=$3; DUR=${4:-60}; WARMUP=8; TARGET=${5:-$FPS}
OUT="$(dirname "$0")/runs"; mkdir -p "$OUT"
LOG="$OUT/fps${FPS}_${SIZE}_${BR}_$(date +%H%M%S).log"

args=(--window-title "bench" --video-codec=h264 --max-size "$SIZE" --video-bit-rate "$BR" --no-audio --print-fps)
[ "$FPS" != 0 ] && args+=(--max-fps "$FPS")

"$D/scrcpy" "${args[@]}" >"$LOG" 2>&1 &
pid=$!
sleep $((DUR + WARMUP))
kill "$pid" 2>/dev/null; wait "$pid" 2>/dev/null
sleep 2   # let the device-side encoder shut down before the next run

res=$(grep -m1 -oE 'Texture: [0-9]+x[0-9]+|[0-9]{3,4}x[0-9]{3,4}' "$LOG" | tail -1)
awk -v t="$TARGET" -v w="$WARMUP" -v label="cap=$FPS target=$TARGET size=$SIZE br=$BR ${res}" '
  /[0-9]+ fps/ {
    n++; if (n <= w) next
    match($0, /[0-9]+ fps/); f = substr($0, RSTART, RLENGTH) + 0
    sk = 0; if (match($0, /\+[0-9]+ frames? skipped/)) sk = substr($0, RSTART+1, RLENGTH) + 0
    if (f == 0) { idle++; next }
    c++; s += f; skip += sk
    if (min == "" || f < min) min = f
    if (t > 0 && (f >= t - 2)) ok++
    hist[f]++
  }
  END {
    if (!c) { print label ": NO SAMPLES"; exit }
    printf "%s | samples=%d idle=%d | avg=%.1f min=%d", label, c, idle, s/c, min
    if (t > 0) printf " within2=%.0f%%", 100*ok/c
    printf " skipped=%d\n  dist:", skip
    for (k = 0; k <= 70; k++) if (k in hist) printf " %d:%d", k, hist[k]
    print ""
  }' "$LOG"
grep -iE 'error|warn' "$LOG" | head -3
