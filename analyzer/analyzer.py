"""
analyzer.py — entry point for podcast-cutter analyzer.

Usage:
    analyzer.exe <config.json>
"""

import sys
import io
import json
import os
from pathlib import Path

# Force UTF-8 on Windows (default codepage is cp1252 which drops em-dashes etc.)
if hasattr(sys.stdout, 'buffer'):
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8', errors='replace')
if hasattr(sys.stderr, 'buffer'):
    sys.stderr = io.TextIOWrapper(sys.stderr.buffer, encoding='utf-8', errors='replace')


def _progress(msg: str):
    print(msg, file=sys.stderr, flush=True)


def _fail(message: str, detail: str = ""):
    err = {"status": "error", "message": message}
    if detail:
        err["detail"] = detail
    print(json.dumps(err))
    sys.exit(1)


def _find_chapter_points(
    speakers:    list,
    host_id:     str,
    min_sec:     float,
    resolution:  float,
    bridge_sec:  float = 1.0,
) -> list[dict]:
    """
    Return times where the host speaker talks continuously for >= min_sec.

    Uses VAD activity (not the cut list) so chapter detection reflects when
    the host is actually speaking, regardless of which camera is on screen.

    bridge_sec: gaps in speech shorter than this are filled before checking
    run lengths. This compensates for tiny dominance-filter gaps that would
    otherwise fragment a 20-second speech into sub-threshold chunks.
    """
    import numpy as np

    if not host_id or min_sec <= 0:
        _progress(f"  Chapter skip: host_id={host_id!r} min_sec={min_sec}")
        return []

    host = next((s for s in speakers if s.id == host_id), None)
    _progress(f"  Chapter detection (VAD-based): host={host_id!r} "
              f"available_ids={[s.id for s in speakers]} min={min_sec}s "
              f"bridge={bridge_sec}s")

    if host is None:
        _progress(f"  Host speaker {host_id!r} not found")
        return []

    arr = host.activity.copy()
    n   = len(arr)

    # Bridge short gaps: fill runs of False shorter than bridge_frames with True
    bridge_frames = max(1, int(bridge_sec / resolution))
    in_false  = False
    false_start = 0
    for f in range(n):
        if not arr[f]:
            if not in_false:
                in_false    = True
                false_start = f
        else:
            if in_false:
                in_false = False
                gap_len  = f - false_start
                if gap_len <= bridge_frames:
                    arr[false_start:f] = True   # bridge the gap

    # Find runs of True >= min_frames, with a 60-second cooldown between markers
    # so that consecutive speech bursts within the same topic don't each get a marker.
    min_frames        = int(min_sec / resolution)
    cooldown_sec      = 60.0
    points:   list[dict] = []
    chapter_n         = 1
    in_speech         = False
    run_start         = 0
    last_chapter_time = -cooldown_sec  # allows first marker immediately

    def _try_add(t_start: float, run_sec: float, label: str):
        nonlocal chapter_n, last_chapter_time
        if t_start < last_chapter_time + cooldown_sec:
            _progress(f"      -> cooldown ({t_start - last_chapter_time:.1f}s since last), skip")
            return
        points.append({"time": t_start, "label": label})
        last_chapter_time = t_start
        chapter_n += 1

    for f in range(n):
        if arr[f]:
            if not in_speech:
                in_speech = True
                run_start = f
        else:
            if in_speech:
                in_speech = False
                run_len   = f - run_start
                t_start   = round(run_start * resolution, 3)
                t_end     = round(f * resolution, 3)
                run_sec   = run_len * resolution
                passes    = run_len >= min_frames
                _progress(f"    speech run {t_start:.1f}s-{t_end:.1f}s "
                          f"({run_sec:.1f}s) {'OK' if passes else 'skip'}")
                if passes:
                    _try_add(t_start, run_sec, f"Chapter {chapter_n}")

    # Handle run that reaches end of array
    if in_speech:
        run_len = n - run_start
        t_start = round(run_start * resolution, 3)
        run_sec = run_len * resolution
        passes  = run_len >= min_frames
        _progress(f"    speech run {t_start:.1f}s-end ({run_sec:.1f}s) {'OK' if passes else 'skip'}")
        if passes:
            _try_add(t_start, run_sec, f"Chapter {chapter_n}")

    _progress(f"  Chapter points found: {len(points)}")
    return points


def _snap_cuts_to_zero_crossings(
    cuts:            list,
    speakers_config: list[dict],
    duration:        float,
    window_sec:      float = 0.05,
) -> list:
    """
    Nudge each internal cut boundary by up to ±window_sec to the nearest
    audio zero-crossing in any speaker's channel.  Avoids clicks and
    breath-on-cut artefacts.
    """
    from vad import _read_audio_16k_segment

    if len(cuts) <= 1:
        return cuts

    SR = 16000
    window_samples = int(window_sec * SR)

    # Flat list of clips for fast lookup
    all_clips: list[dict] = []
    for spk in speakers_config:
        for clip in spk["clips"]:
            all_clips.append(clip)

    def find_zc(t: float) -> float:
        """Return snapped time; falls back to t if audio unavailable."""
        for clip in all_clips:
            if not (clip["seq_start"] <= t <= clip["seq_end"]):
                continue
            media_t    = clip["media_start"] + (t - clip["seq_start"])
            start_sec  = max(0.0, media_t - window_sec)
            end_sec    = media_t + window_sec
            try:
                wav = _read_audio_16k_segment(clip["path"], start_sec, end_sec)
                wav_np = wav.numpy()
                n = len(wav_np)
                if n < 2:
                    return t
                center_idx = int((media_t - start_sec) * SR)
                center_idx = max(0, min(center_idx, n - 1))

                best_idx  = center_idx
                best_dist = n  # large init value

                for idx in range(n - 1):
                    if wav_np[idx] * wav_np[idx + 1] <= 0:
                        dist = abs(idx - center_idx)
                        if dist < best_dist:
                            best_dist = dist
                            best_idx  = idx

                offset = (best_idx - center_idx) / SR
                new_t  = max(0.0, min(t + offset, duration))
                return round(new_t, 3)
            except Exception:
                return t
        return t

    # Adjust shared boundaries (cut[i].end == cut[i+1].start for internal edges)
    from cuts import Cut
    adjusted = list(cuts)
    for i in range(len(cuts) - 1):
        old_t = cuts[i].end         # == cuts[i+1].start
        new_t = find_zc(old_t)
        c_prev = adjusted[i]
        c_next = adjusted[i + 1]
        adjusted[i]     = Cut(start=c_prev.start, end=new_t,   camera_index=c_prev.camera_index)
        adjusted[i + 1] = Cut(start=new_t,        end=c_next.end, camera_index=c_next.camera_index)

    return [c for c in adjusted if c.end > c.start]


def run(config_path: str) -> dict:
    with open(config_path, "r", encoding="utf-8") as f:
        config = json.load(f)

    from vad import load_model, analyze_all_speakers
    from cuts import Speaker, Camera, CutConfig, generate_cuts, cuts_to_dict, find_silence_removals

    settings = config.get("settings", {})
    resolution = 0.05

    cut_config = CutConfig(
        min_shot_sec   = float(settings.get("min_shot_sec",   2.0)),
        max_shot_sec   = float(settings.get("max_shot_sec",   8.0)),
        wide_frequency = float(settings.get("wide_frequency", 0.15)),
        cut_delay_sec  = float(settings.get("cut_delay_sec",  0.0)),
        resolution     = resolution,
    )

    vad_threshold      = float(settings.get("vad_threshold",    0.45))
    dominance_db       = float(settings.get("dominance_db",     12.0))
    min_phrase_sec     = float(settings.get("min_phrase_sec",   1.5))
    min_silence_sec    = float(settings.get("min_silence_sec",  0.0))
    snap_zero_crossing = bool(settings.get("snap_zero_crossing", False))
    host_speaker_id    = str(settings.get("host_speaker_id",   ""))
    chapter_min_sec    = float(settings.get("chapter_min_sec",  10.0))

    # Validate all media paths up front for a clear error message
    for spk_cfg in config["speakers"]:
        for clip in spk_cfg["clips"]:
            if not os.path.exists(clip["path"]):
                raise FileNotFoundError(f"Media file not found: {clip['path']}")

    _progress("Loading VAD model...")
    model = load_model()

    _progress("Analyzing speakers (cross-channel dominance filter active)...")
    spk_results, duration = analyze_all_speakers(
        speakers_config=config["speakers"],
        model=model,
        resolution=resolution,
        vad_threshold=vad_threshold,
        dominance_db=dominance_db,
        min_phrase_sec=min_phrase_sec,
    )

    speakers = [
        Speaker(id=r["id"], activity=r["activity"])
        for r in spk_results
    ]

    cameras = []
    for cam_cfg in config["cameras"]:
        speaker_id = cam_cfg.get("speaker")
        cameras.append(Camera(
            index=int(cam_cfg["index"]),
            speaker_id=speaker_id,
        ))

    _progress("Generating cuts...")
    cuts = generate_cuts(speakers, cameras, cut_config, duration)

    # Zero-crossing snap — nudge cut boundaries to nearest audio zero crossing
    if snap_zero_crossing:
        _progress("Snapping cut boundaries to zero crossings...")
        before = len(cuts)
        cuts = _snap_cuts_to_zero_crossings(
            cuts, config["speakers"], duration, window_sec=0.05)
        _progress(f"  Snapped {before} cuts (±50ms window)")

    silence_removals = []
    if min_silence_sec > 0:
        cuts, silence_removals = find_silence_removals(
            cuts=cuts,
            cameras=cameras,
            speakers=speakers,
            min_silence_sec=min_silence_sec,
            resolution=resolution,
            duration=duration,
            allow_wide_bridge=(cut_config.max_shot_sec > 0
                               and cut_config.wide_frequency > 0),
        )
        if silence_removals:
            total_removed = sum(r["end"] - r["start"] for r in silence_removals)
            _progress(
                f"Silence removal: {len(silence_removals)} gap(s) → "
                f"{total_removed:.1f}s removed "
                f"(new duration ≈ {duration - total_removed:.1f}s)"
            )
        else:
            _progress("Silence removal: no gaps long enough to remove")

    # Chapter markers — detect continuous host-camera segments from the cut list
    chapter_points: list[dict] = []
    chapter_debug  = ""
    if host_speaker_id:
        chapter_points = _find_chapter_points(
            speakers, host_speaker_id, chapter_min_sec, resolution)
        chapter_debug = (f"host_id={host_speaker_id!r} "
                         f"min_sec={chapter_min_sec} "
                         f"-> {len(chapter_points)} point(s)")

    result = {
        "status":            "ok",
        "duration":          round(duration, 3),
        "cuts":              cuts_to_dict(cuts),   # may include synthetic switches
        "silence_removals":  silence_removals,
        "chapter_points":    chapter_points,
        "chapter_debug":     chapter_debug,
    }

    out_path = str(Path(config_path).with_suffix("")) + "_result.json"
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(result, f, indent=2)

    result["output_path"] = out_path
    return result


if __name__ == "__main__":
    if len(sys.argv) < 2:
        _fail("Usage: analyzer.exe <config.json>")

    config_path = sys.argv[1]

    if not os.path.exists(config_path):
        _fail(f"Config file not found: {config_path}")

    try:
        result = run(config_path)
        print(json.dumps(result))
    except Exception as e:
        import traceback
        _fail(str(e), traceback.format_exc())
