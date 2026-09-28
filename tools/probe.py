#!/usr/bin/env python3
"""probe.py <max_fps> <max_size> <bitrate> [--secs N] [--ui] [--opts CODEC_OPTIONS]

Runs scrcpy-server with the given encoder settings, reads the raw video stream,
records per frame (Mac arrival - device capture PTS), and reports:
  - lag above the run's floor latency (p50 / p95 / max, first vs last 10 s)
  - motion smoothness: gaps between consecutive frames that are part of motion
    (gap < 95 ms; scrcpy re-sends a still frame every 100 ms, so those are excluded)
  - video mode: per-second fps vs cap
--ui drives the Fire TV home screen with arrow keys (never OK/Select) during the run.
"""
import argparse, csv, random, socket, struct, subprocess, sys, time, statistics as st

D = "/Users/finnvignon/Documents/tools/scrcpy-macos-x86_64-v4.1"
ADB = f"{D}/adb"
ap = argparse.ArgumentParser()
ap.add_argument("fps", type=int); ap.add_argument("size", type=int); ap.add_argument("br")
ap.add_argument("--secs", type=int, default=60); ap.add_argument("--ui", action="store_true")
ap.add_argument("--opts", default="")
ap.add_argument("--read", action="store_true", help="bursts of 4 arrow keys, then 8 s still")
ap.add_argument("--audio", action="store_true", help="also stream the device's sound (Opus), like StickPilot's sound option")
a = ap.parse_args()
WARMUP = 8
bps = int(float(a.br.rstrip("Mm")) * 1_000_000)
scid = random.randint(0, 0x7FFFFFFF)
port = 27199

def adb(*args):
    return subprocess.run([ADB, *args], capture_output=True, text=True)

adb("push", f"{D}/scrcpy-server", "/data/local/tmp/scrcpy-server.jar")
adb("forward", f"tcp:{port}", f"localabstract:scrcpy_{scid:08x}")
cmd = [ADB, "shell", "CLASSPATH=/data/local/tmp/scrcpy-server.jar", "app_process", "/",
       "com.genymobile.scrcpy.Server", "4.1", f"scid={scid:08x}", "log_level=info",
       "tunnel_forward=true", f"audio={'true' if a.audio else 'false'}", "audio_codec=opus", "audio_bit_rate=128000",
       "control=false", "video_codec=h264",
       f"max_size={a.size}", f"max_fps={a.fps}", f"video_bit_rate={bps}",
       "send_device_meta=false", "send_stream_meta=false", "send_frame_meta=true",
       "cleanup=false", "power_on=false"]
if a.opts:
    cmd.append(f"video_codec_options={a.opts}")
server = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)

def read_exact(s, n):
    buf = b""
    while len(buf) < n:
        chunk = s.recv(n - len(buf))
        if not chunk:
            raise EOFError
        buf += chunk
    return buf

sock = None
for _ in range(100):  # adb forward accepts before the server listens: wait for the dummy byte
    try:
        sock = socket.create_connection(("127.0.0.1", port)); read_exact(sock, 1); break
    except (OSError, EOFError):
        if sock: sock.close()
        sock = None; time.sleep(0.1)
if not sock:
    server.kill(); print("could not connect:", server.stdout.read()[-500:]); sys.exit(1)

audio_bytes = [0]
if a.audio:
    # Sockets open in the server's order: video, then audio. Drain audio in the background.
    import threading
    asock = socket.create_connection(("127.0.0.1", port))
    def drain():
        try:
            while True:
                chunk = asock.recv(65536)
                if not chunk: break
                audio_bytes[0] += len(chunk)
        except OSError:
            pass
    threading.Thread(target=drain, daemon=True).start()

keys = None
if a.read:
    keys = subprocess.Popen([ADB, "shell",
        f"sleep {WARMUP}; while true; do for k in 22 22 21 21; do input keyevent $k; sleep 0.3; done; sleep 8; done"],
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
if a.ui:
    # 4 right, down, 4 left, up: stays within the first two home rows. Arrow keys only.
    pattern = "22 22 22 22 20 21 21 21 21 19"
    keys = subprocess.Popen([ADB, "shell",
        f"sleep {WARMUP}; while true; do for k in {pattern}; do input keyevent $k; sleep 0.3; done; done"],
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)

frames = []  # (arrival_s, pts_s, bytes)
t0 = time.monotonic()
try:
    while time.monotonic() - t0 < a.secs + WARMUP:
        pts_flags, length = struct.unpack(">QI", read_exact(sock, 12))
        read_exact(sock, length)
        if pts_flags & (1 << 62):  # config packet (scrcpy 4.1: bit 62 config, bit 61 key frame)
            continue
        frames.append((time.monotonic() - t0, (pts_flags & ((1 << 61) - 1)) / 1e6, length))
except EOFError:
    print("stream ended early:", server.stdout.read()[-800:] if server.poll() is not None else "")
finally:
    if keys: keys.kill(); adb("shell", "pkill -f 'input keyevent'; true")
    sock.close(); server.kill(); adb("forward", "--remove", f"tcp:{port}")
    time.sleep(2)

tag = f"{a.fps}_{a.size}_{a.br}{'_audio' if a.audio else ''}{'_ui' if a.ui else ''}{'_read' if a.read else ''}{'_' + a.opts.replace(':', '-').replace(',', '+') if a.opts else ''}"
with open(f"runs/probe_{tag}_{int(time.time())}.csv", "w") as fh:
    csv.writer(fh).writerows(frames)

f = [x for x in frames if x[0] >= WARMUP]
if len(f) < 10:
    print(tag, "too few frames:", len(frames)); sys.exit(1)
lat = sorted(p_a - p_p for p_a, p_p, _ in f)
base = lat[len(lat) // 100]
exc = [(x[0] - x[1] - base) * 1000 for x in f]
s = sorted(exc); q = lambda v, p: v[min(len(v) - 1, int(p * len(v)))]
end = f[-1][0]
first = st.mean(e for x, e in zip(f, exc) if x[0] < WARMUP + 10)
last = st.mean(e for x, e in zip(f, exc) if x[0] >= end - 10)
gaps = sorted((f[i][1] - f[i - 1][1]) * 1000 for i in range(1, len(f)))
motion = [g for g in gaps if g < 95]
per_s = [sum(1 for x in f if int(x[0]) == t) for t in range(WARMUP, WARMUP + a.secs)]
nz = [x for x in per_s if x > 0]
ok = sum(1 for x in nz if x >= a.fps - 2)
mbps = sum(x[2] for x in f) * 8 / a.secs / 1e6
out = f"{tag:28s} lag p50={q(s,.5):4.0f} p95={q(s,.95):4.0f} max={s[-1]:4.0f} ms (first10 {first:3.0f} / last10 {last:3.0f})"
if motion:
    out += f" | motion gap p50={q(motion,.5):3.0f} p90={q(motion,.9):3.0f} ms (~{1000/q(motion,.5):.0f} fps)"
if not (a.ui or a.read):
    out += f" | fps avg={st.mean(nz):.1f} within2={100*ok/len(nz):.0f}%"
print(out + f" | {mbps:.1f} Mb/s" + (f" | sound {audio_bytes[0] * 8 / (a.secs + WARMUP) / 1000:.0f} kb/s" if a.audio else ""))
