#!/bin/bash
# firetv - mirror a Fire TV Stick to this Mac over USB with scrcpy
# Usage: firetv start [--profile <name|fps>] | stop | status | profiles | -h

SCRCPY_DIR="/Users/finnvignon/Documents/tools/scrcpy-macos-x86_64-v4.1"
SCRCPY="$SCRCPY_DIR/scrcpy"
LOG="/tmp/firetv-scrcpy.log"
STATE="/tmp/firetv-profile"

# Use the adb bundled with scrcpy so versions always match
export ADB="$SCRCPY_DIR/adb"

# Profiles, tuned for the stick's software H.264 encoder (Baseline only, ignores
# bitrate targets above ~2-3 Mb/s, so detail comes from resolution).
# Measured on 60 fps video and on scrolling the home screen:
#   responsive  30 fps holds 100%, lag p95 ~40-60 ms
#   clear       20 fps holds 90%, lag p95 ~150-170 ms
#   native      1:1 pixels; ~20 fps but 1-1.5 s behind whenever the screen moves,
#               catches up once it is still. For photos and reading, not video.
# 1408-1536 px lag 0.5-1 s or drop to ~15 fps on motion, so there is no step between.
DEFAULT_PROFILE="responsive"
PROFILES="responsive clear native"

# profile <name|fps> -> sets NAME FPS SIZE BITRATE ALIAS DESC; returns 1 if unknown
profile() {
  case "$1" in
    responsive|30) NAME=responsive FPS=30 SIZE=896  BITRATE=6M ALIAS=30 DESC="lowest lag, smooth menus and video" ;;
    clear|20)      NAME=clear      FPS=20 SIZE=1280 BITRATE=6M ALIAS=20 DESC="noticeably more detail, a bit more lag" ;;
    native)        NAME=native     FPS=20 SIZE=1920 BITRATE=6M ALIAS=-  DESC="full 1080p for still images; lags 1-1.5 s on motion" ;;
    *) return 1 ;;
  esac
}

usb_state() {
  # First USB device (network devices have ":" in their serial)
  "$ADB" devices 2>/dev/null | awk 'NR>1 && NF==2 && $1 !~ /:/ {print $2; exit}'
}

is_running() {
  pgrep -f "$SCRCPY" >/dev/null 2>&1
}

profiles() {
  printf "%-13s %-6s %-4s %-10s %-8s %s\n" PROFILE ALIAS FPS SIZE BITRATE NOTES
  for p in $PROFILES; do
    profile "$p"
    mark=""; [ "$p" = "$DEFAULT_PROFILE" ] && mark=" *"
    printf "%-13s %-6s %-4s %-10s %-8s %s\n" "$NAME$mark" "$ALIAS" "$FPS" "${SIZE}x$((SIZE * 9 / 16))" "$BITRATE" "$DESC"
  done
  echo "* default. Usage: firetv start --profile <name|fps>"
}

usage() {
  cat <<EOF
firetv - mirror the Fire TV Stick to this Mac over USB (scrcpy)

Usage:
  firetv start [--profile <name|fps>]   open the mirror window (default: $DEFAULT_PROFILE)
  firetv stop                           close it and stop adb
  firetv status                         show whether it's running, which profile, USB state
  firetv profiles                       list the profiles
  firetv -h | --help                    show this help

Profiles:
EOF
  profiles | sed 's/^/  /'
  cat <<EOF

Examples:
  firetv start                  # $DEFAULT_PROFILE
  firetv start --profile 20     # clear
  firetv start -p native

Controls (click the Fire TV window first; MOD = left Option or left Cmd):
  Remote
    Arrow keys                  navigate (D-pad)
    Enter                       OK / select
    MOD+b, MOD+Backspace        Back          (or right-click)
    MOD+h                       Home          (or middle-click)
    MOD+m                       Menu (the ≡ button)
    MOD+Up / MOD+Down           volume up / down
    MOD+p                       sleep / wake the Fire TV
  Typing
    letters, numbers            type into a focused search or text field
    MOD+v                       paste the Mac clipboard into the field
    MOD+Shift+v                 type the Mac clipboard as keystrokes (if paste fails)
  Window
    MOD+f                       fullscreen on / off
    MOD+g                       1:1 pixel size (sharpest, best with native)
    MOD+w                       remove black borders
    MOD+q                       close the window (then run 'firetv stop')
EOF
}

start() {
  requested="$DEFAULT_PROFILE"
  title="Fire TV"
  while [ $# -gt 0 ]; do
    case "$1" in
      -h|--help) usage; exit 0 ;;
      --profile|-p)
        [ -z "$2" ] && { echo "--profile needs a value. See 'firetv profiles'."; exit 1; }
        requested="$2"; explicit=1; shift 2 ;;
      --profile=*) requested="${1#--profile=}"; explicit=1; shift ;;
      *) echo "Unknown option: $1"; echo "Usage: firetv start [--profile <name|fps>]"; exit 1 ;;
    esac
  done

  if ! profile "$requested"; then
    echo "Unknown profile: $requested"
    echo
    profiles
    exit 1
  fi
  [ -n "$explicit" ] && title="Fire TV - $NAME"

  if [ ! -x "$SCRCPY" ]; then
    echo "scrcpy not found at: $SCRCPY"
    exit 1
  fi

  if is_running; then
    echo "Fire TV mirroring is already running."
    exit 0
  fi

  echo "Starting adb..."
  "$ADB" start-server >/dev/null 2>&1

  echo "Looking for the Fire TV on USB..."
  state=""
  for _ in $(seq 1 15); do
    state=$(usb_state)
    [ "$state" = "device" ] && break
    [ "$state" = "unauthorized" ] && break
    sleep 1
  done

  case "$state" in
    device)
      echo "Fire TV found. Opening screen ($NAME: ${SIZE}px, $FPS fps, $BITRATE)..."
      ;;
    unauthorized)
      echo "The Fire TV is connected but hasn't authorized this Mac."
      echo "Connect it to a TV once and accept the 'Allow USB debugging' prompt."
      exit 1
      ;;
    *)
      echo "No Fire TV found on USB. Check the cable and that ADB debugging is on."
      exit 1
      ;;
  esac

  echo "$NAME" >"$STATE"
  nohup "$SCRCPY" -d --window-title "$title" \
    --video-codec=h264 --max-size "$SIZE" --max-fps "$FPS" --video-bit-rate "$BITRATE" --no-audio \
    >"$LOG" 2>&1 &
  sleep 2

  if is_running; then
    echo "Running. Use 'firetv stop' to close it."
  else
    echo "scrcpy failed to start. Last log lines:"
    tail -n 15 "$LOG"
    rm -f "$STATE"
    exit 1
  fi
}

stop() {
  if is_running; then
    echo "Closing screen..."
    pkill -f "$SCRCPY"
  else
    echo "Screen wasn't open."
  fi
  rm -f "$STATE"
  echo "Stopping adb..."
  "$ADB" kill-server >/dev/null 2>&1
  echo "Stopped."
}

status() {
  if is_running; then
    echo "Mirroring: running (profile: $(cat "$STATE" 2>/dev/null || echo unknown))"
  else
    echo "Mirroring: stopped"
  fi
  state=$(usb_state)
  echo "Fire TV (USB): ${state:-not connected}"
}

case "$1" in
  start)    shift; start "$@" ;;
  stop)     stop ;;
  status)   status ;;
  profiles) profiles ;;
  -h|--help|help) usage ;;
  *)
    echo "Usage: firetv start [--profile <name|fps>] | stop | status | profiles"
    echo "Run 'firetv -h' for help."
    exit 1
    ;;
esac
