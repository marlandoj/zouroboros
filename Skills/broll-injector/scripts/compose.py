#!/usr/bin/env python3
"""
compose.py - deterministic b-roll compositor for talking-head spines.

Takes a presenter "spine" video plus a b-roll plan and intercuts each b-roll
clip over the spine using the proven ffmpeg formula hardened on the Zouroboros
Academy renders:

  * setpts time-shift so each cutaway's t=0 lands at its window start
  * gated overlay (enable='between(t,start,end)') instead of concat
  * audio always copied straight from the spine (input 0)
  * forced -r 25 -pix_fmt yuv420p so segments stay concat-compatible
  * eof_action=pass + hold clamped to clip duration  -> no frozen/dark tail

All b-roll inputs are expected to be silent mp4 clips (the generate stage turns
stills into Ken Burns clips, so compose only ever deals with video).

Usage:
  python3 compose.py --base SPINE.mp4 --plan PLAN.json --broll-dir DIR --out FINAL.mp4
                     [--mode fullframe|pip] [--crossfade] [--margin 40] [--pip-scale 0.42]

The plan is the conductor's broll-plan.json. Per-moment `mode` overrides the
global --mode; per-moment `hold` is clamped to the generated clip's duration.
"""
import argparse
import json
import os
import subprocess
import sys


def probe(path, entries, stream=None):
    cmd = ["ffprobe", "-v", "error"]
    if stream is not None:
        cmd += ["-select_streams", stream]
    cmd += ["-show_entries", entries, "-of", "default=noprint_wrappers=1:nokey=1", path]
    out = subprocess.run(cmd, capture_output=True, text=True).stdout.strip().splitlines()
    return out


def probe_dims(path):
    vals = probe(path, "stream=width,height", stream="v:0")
    return int(vals[0]), int(vals[1])


def probe_duration(path):
    vals = probe(path, "format=duration")
    try:
        return float(vals[0])
    except (IndexError, ValueError):
        return 0.0


def has_audio(path):
    vals = probe(path, "stream=index", stream="a:0")
    return bool(vals)


def build_filter(base_w, base_h, moments, defaults):
    """Return (filter_complex_string, final_label)."""
    margin = defaults["margin"]
    pip_scale = defaults["pip_scale"]
    crossfade = defaults["crossfade"]
    fade = 0.35  # seconds, only used when crossfade is on

    def scale_expr(mode):
        if mode == "pip":
            return f"scale=iw*{pip_scale}:-2"
        # fullframe: cover the frame, then center-crop to exact dims
        return (f"scale={base_w}:{base_h}:force_original_aspect_ratio=increase,"
                f"crop={base_w}:{base_h}")

    parts = []
    # Prepare each overlay input (ffmpeg input index = moment index + 1).
    for i, m in enumerate(moments):
        idx = i + 1
        start = float(m["start"])
        end = float(m["_end"])
        mode = m.get("mode", defaults["mode"])
        if crossfade:
            # alpha fade in/out; yuva so the base shows through during the fade
            fout_st = round(max(0.0, (end - start) - fade), 3)
            chain = (f"[{idx}:v]format=yuva420p,{scale_expr(mode)},"
                     f"fade=t=in:st=0:d={fade}:alpha=1,"
                     f"fade=t=out:st={fout_st}:d={fade}:alpha=1,"
                     f"setpts=PTS+{start}/TB[ov{idx}]")
        else:
            chain = f"[{idx}:v]{scale_expr(mode)},setpts=PTS+{start}/TB[ov{idx}]"
        parts.append(chain)

    # Chain the overlays onto the base.
    cur = "[0:v]"
    for i, m in enumerate(moments):
        idx = i + 1
        start = float(m["start"])
        end = float(m["_end"])
        mode = m.get("mode", defaults["mode"])
        out_label = "[vout]" if i == len(moments) - 1 else f"[s{idx}]"
        if mode == "pip":
            pos = f"x={base_w}-w-{margin}:y={base_h}-h-{margin}"
        else:
            pos = "x=0:y=0"
        enable = f"enable='between(t\\,{start}\\,{end})'"
        parts.append(f"{cur}[ov{idx}]overlay={pos}:eof_action=pass:{enable}{out_label}")
        cur = out_label

    return ";".join(parts), "[vout]"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--base", required=True)
    ap.add_argument("--plan", required=True)
    ap.add_argument("--broll-dir", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--mode", default="fullframe", choices=["fullframe", "pip"])
    ap.add_argument("--crossfade", action="store_true")
    ap.add_argument("--margin", type=int, default=40)
    ap.add_argument("--pip-scale", type=float, default=0.42)
    ap.add_argument("--fps", type=int, default=25)
    ap.add_argument("--dry-run", action="store_true",
                    help="print the ffmpeg command without running it")
    args = ap.parse_args()

    if not os.path.exists(args.base):
        sys.exit(f"compose: base not found: {args.base}")
    with open(args.plan) as f:
        plan = json.load(f)
    moments = plan.get("moments", [])
    if not moments:
        sys.exit("compose: plan has no moments")

    base_w, base_h = probe_dims(args.base)

    # Resolve each moment's clip + clamp hold to clip duration.
    inputs = ["-i", args.base]
    resolved = []
    for m in moments:
        clip = os.path.join(args.broll_dir, f"{m['id']}.mp4")
        if not os.path.exists(clip):
            sys.exit(f"compose: missing b-roll clip for moment {m['id']}: {clip}")
        dur = probe_duration(clip)
        hold = float(m.get("hold", dur))
        hold = min(hold, dur) if dur > 0 else hold
        m = dict(m)
        m["_end"] = round(float(m["start"]) + hold, 3)
        resolved.append(m)
        inputs += ["-i", clip]

    defaults = {
        "mode": args.mode,
        "crossfade": args.crossfade,
        "margin": args.margin,
        "pip_scale": args.pip_scale,
    }
    fcomplex, final_label = build_filter(base_w, base_h, resolved, defaults)

    cmd = ["ffmpeg", "-y", *inputs, "-filter_complex", fcomplex, "-map", final_label]
    if has_audio(args.base):
        cmd += ["-map", "0:a", "-c:a", "copy"]
    cmd += ["-r", str(args.fps), "-pix_fmt", "yuv420p",
            "-c:v", "libx264", "-preset", "fast", "-crf", "18", args.out]

    if args.dry_run:
        print("DRY-RUN ffmpeg command:")
        print(" ".join(f"'{c}'" if (" " in c or ";" in c) else c for c in cmd))
        print(f"\nbase: {base_w}x{base_h}  moments: {len(resolved)}")
        for m in resolved:
            print(f"  {m['id']}: {m['start']}s -> {m['_end']}s "
                  f"[{m.get('mode', args.mode)}] {m.get('prompt','')[:60]}")
        return

    print(f"compose: {base_w}x{base_h} spine + {len(resolved)} b-roll moments -> {args.out}")
    r = subprocess.run(cmd, capture_output=True, text=True)
    if r.returncode != 0:
        sys.stderr.write(r.stderr[-3000:])
        sys.exit(f"compose: ffmpeg failed (exit {r.returncode})")
    size = os.path.getsize(args.out) if os.path.exists(args.out) else 0
    print(f"compose: ✅ wrote {args.out} ({size/1e6:.1f} MB)")


if __name__ == "__main__":
    main()
