"""
VAD wrapper around silero-vad 6.x

Key design: all speakers are analyzed TOGETHER in analyze_all_speakers(),
not independently. This enables cross-channel dominance filtering which
suppresses mic bleed — the root cause of cut misalignment in multi-mic
podcast setups.

Algorithm per frame (50 ms resolution):
  1. Silero VAD probability > threshold  →  candidate speech
  2. RMS dBFS for each channel at that frame
  3. A candidate frame is only kept as ACTIVE if this channel is within
     dominance_db dB of the loudest channel at that moment.

Result: bleed from a neighbouring mic (typically 10–20 dB quieter than
the direct signal) is automatically rejected without needing manual thresholds.

Supports pure audio (WAV/FLAC/AIFF via soundfile) and video containers
(MP4/MXF via torchaudio fallback).
"""

import sys
import numpy as np


def _progress(msg: str):
    print(msg, file=sys.stderr, flush=True)


# ─── Short-segment removal ────────────────────────────────────────────────────

def _remove_short_activity(arr: np.ndarray, min_frames: int) -> np.ndarray:
    """
    Remove isolated runs of True that are shorter than min_frames.
    Used to suppress "hmm", breathing artefacts, and desk thumps that
    silero would otherwise detect as speech.
    """
    if min_frames <= 1 or not arr.any():
        return arr
    result = arr.copy()
    padded = np.concatenate([[False], arr, [False]])
    diff   = np.diff(padded.astype(np.int8))
    starts = np.where(diff == 1)[0]    # indices of rising edges
    ends   = np.where(diff == -1)[0]   # indices of falling edges
    for s, e in zip(starts, ends):
        if (e - s) < min_frames:
            result[s:e] = False
    return result


# ─── Model loading ────────────────────────────────────────────────────────────

def load_model():
    from silero_vad import load_silero_vad
    return load_silero_vad()


# ─── Low-level audio I/O ─────────────────────────────────────────────────────

def _read_audio_16k_segment(audio_path: str,
                             start_sec: float = 0.0,
                             end_sec: float | None = None):
    """
    Load a time slice at 16 kHz mono float32.
    Falls back from soundfile (audio files) → torchaudio (video containers).
    """
    import torch
    import torchaudio.functional as F_audio

    try:
        import soundfile as sf
        info = sf.info(audio_path)
        sr = info.samplerate
        start_frame = int(start_sec * sr)
        stop_frame  = int(end_sec * sr) if end_sec is not None else None
        data, _ = sf.read(audio_path, start=start_frame, stop=stop_frame,
                          dtype="float32", always_2d=True)
        wav = torch.from_numpy(
            data.mean(axis=1) if data.shape[1] > 1 else data[:, 0])
        if sr != 16000:
            wav = F_audio.resample(wav, sr, 16000)
        return wav
    except Exception:
        pass

    try:
        import torchaudio
        # torchaudio.info() may be absent in some bundled builds — fall back to
        # loading a single frame just to discover the sample rate.
        try:
            sr = torchaudio.info(audio_path).sample_rate
        except AttributeError:
            _, sr = torchaudio.load(audio_path, num_frames=1)
        frame_offset = int(start_sec * sr)
        num_frames   = int((end_sec - start_sec) * sr) if end_sec is not None else -1
        wav, _ = torchaudio.load(audio_path,
                                 frame_offset=frame_offset,
                                 num_frames=num_frames)
        wav = wav.mean(dim=0) if wav.shape[0] > 1 else wav[0]
        if sr != 16000:
            wav = F_audio.resample(wav, sr, 16000)
        return wav
    except Exception as e:
        raise RuntimeError(f"Cannot read audio from '{audio_path}': {e}")


# ─── Per-frame dB helper ──────────────────────────────────────────────────────

def _compute_db_array(wav_np: np.ndarray,
                      sample_rate: int = 16000,
                      resolution: float = 0.05) -> np.ndarray:
    """
    Compute RMS dBFS per time frame (vectorised).
    Silent / zero frames return -80 dB.
    """
    frame_samples = int(resolution * sample_rate)
    n_frames = int(np.ceil(len(wav_np) / frame_samples))

    # Pad to fill complete frames
    padded = np.zeros(n_frames * frame_samples, dtype=np.float32)
    padded[:len(wav_np)] = wav_np

    frames = padded.reshape(n_frames, frame_samples)
    rms    = np.sqrt(np.mean(frames ** 2, axis=1))
    db     = np.where(rms > 1e-8, 20.0 * np.log10(rms), -80.0)
    return db.astype(np.float32)


# ─── Per-clip analysis (VAD + dB) ─────────────────────────────────────────────

def _analyze_clips(clips: list[dict],
                   model,
                   vad_threshold: float,
                   min_speech_ms: int,
                   min_silence_ms: int,
                   resolution: float,
                   seq_duration: float) -> tuple[list, np.ndarray]:
    """
    Run VAD and compute per-frame dB for a single speaker's clip list.

    Returns:
        vad_segments — list of (start_sec, end_sec) in sequence time
        db_array     — float32 array of length ceil(seq_duration / resolution)
    """
    from silero_vad import get_speech_timestamps

    SAMPLE_RATE = 16000
    n_frames  = int(np.ceil(seq_duration / resolution))
    db_array  = np.full(n_frames, -80.0, dtype=np.float32)
    all_segs: list[tuple[float, float]] = []

    for clip in clips:
        wav = _read_audio_16k_segment(
            clip["path"], clip["media_start"], clip["media_end"])
        if len(wav) == 0:
            continue

        wav_np = wav.numpy()

        # ── VAD ──────────────────────────────────────────────────────────────
        timestamps = get_speech_timestamps(
            wav, model,
            threshold=vad_threshold,
            min_speech_duration_ms=min_speech_ms,
            min_silence_duration_ms=min_silence_ms,
            return_seconds=True,
        )
        seq_offset = clip["seq_start"]
        for t in timestamps:
            all_segs.append((seq_offset + t["start"],
                             seq_offset + t["end"]))

        # ── dB per frame, placed at correct sequence position ─────────────────
        clip_db          = _compute_db_array(wav_np, SAMPLE_RATE, resolution)
        clip_start_frame = int(clip["seq_start"] / resolution)
        end_frame        = min(clip_start_frame + len(clip_db), n_frames)
        take             = end_frame - clip_start_frame
        db_array[clip_start_frame:end_frame] = clip_db[:take]

    return all_segs, db_array


# ─── Main entry point ─────────────────────────────────────────────────────────

def analyze_all_speakers(
    speakers_config: list[dict],
    model,
    resolution:      float = 0.05,
    vad_threshold:   float = 0.45,
    min_speech_ms:   int   = 250,
    min_silence_ms:  int   = 300,
    dominance_db:    float = 12.0,
    min_phrase_sec:  float = 1.5,
) -> tuple[list[dict], float]:
    """
    Analyze all speakers together with cross-channel dominance filtering.

    speakers_config — list of {"id": str, "clips": [...]} dicts
    dominance_db    — a channel's VAD activity is suppressed when it is more
                      than this many dB below the loudest channel at that frame.
                      Typical mic bleed is 12–20 dB below direct signal,
                      so the default of 12 dB rejects most bleed.

    Returns:
        speakers — list of {"id": str, "activity": np.ndarray (bool)}
        seq_duration — total sequence duration in seconds
    """
    # Determine full sequence duration across all speakers
    seq_duration = max(
        max(c["seq_end"] for c in spk["clips"])
        for spk in speakers_config
    )
    n_frames = int(np.ceil(seq_duration / resolution))

    # ── Pass 1: VAD + dB per speaker ─────────────────────────────────────────
    raw: list[dict] = []
    for spk in speakers_config:
        n_clips   = len(spk["clips"])
        total_sec = sum(c["seq_end"] - c["seq_start"] for c in spk["clips"])
        _progress(f"  VAD: {spk['id']} — {n_clips} clip(s), {total_sec:.1f}s in sequence")

        vad_segs, db_arr = _analyze_clips(
            spk["clips"], model,
            vad_threshold, min_speech_ms, min_silence_ms,
            resolution, seq_duration,
        )
        raw.append({"id": spk["id"], "vad_segments": vad_segs, "db_array": db_arr})

    # ── Pass 2: build raw VAD activity arrays ─────────────────────────────────
    activity: list[np.ndarray] = []
    for spk in raw:
        arr = np.zeros(n_frames, dtype=bool)
        for start, end in spk["vad_segments"]:
            i0 = int(start / resolution)
            i1 = min(int(np.ceil(end / resolution)), n_frames)
            arr[i0:i1] = True
        activity.append(arr)

    # ── Pass 3: dominance filter (floor-normalised) ───────────────────────────
    # Problem with raw dBFS comparison: if one mic is consistently louder
    # (hot mic, loud room) its floor already sits above another mic's speech
    # peaks — causing phantom cuts TO the hot mic AND suppressing the quieter
    # speaker's real speech.
    #
    # Fix: measure each channel's rise above its OWN noise floor (20th-pct of
    # its dB array).  A hot mic that's uniformly loud contributes ≈ 0 dB of
    # "elevation"; a mic whose owner just started speaking shows a large spike.
    # Only that spike matters for dominance.
    if len(raw) > 1:
        db_matrix   = np.stack([s["db_array"] for s in raw])   # (n_spk, n_frames)

        # Per-channel noise floor: 20th-percentile of that channel's dB values.
        # Using 20th-pct rather than min avoids being dragged down by a handful
        # of -80 dB padding frames.
        noise_floor = np.percentile(db_matrix, 20, axis=1, keepdims=True)   # (n_spk, 1)
        elevation   = db_matrix - noise_floor                                # (n_spk, n_frames)

        # At each frame, which channel has risen most above its own floor?
        max_elev = elevation.max(axis=0)                                     # (n_frames,)

        for i in range(len(raw)):
            # Keep VAD only where this channel is within dominance_db of the
            # most-elevated channel at that moment.
            is_dominant  = elevation[i] >= (max_elev - dominance_db)
            activity[i]  = activity[i] & is_dominant

        _progress(f"  Dominance filter applied ({dominance_db} dB margin, floor-normalised)")

    # ── Pass 4: minimum phrase duration filter ────────────────────────────────
    # Removes short bursts (single words, "hmm", breath artefacts) that
    # passed VAD but are too brief to warrant a camera cut.
    # Distinct from min_shot_sec — this filters the speech signal itself,
    # not the camera hold time.
    min_phrase_frames = int(min_phrase_sec / resolution)
    if min_phrase_frames > 1:
        for i in range(len(raw)):
            before = activity[i].sum()
            activity[i] = _remove_short_activity(activity[i], min_phrase_frames)
            removed = before - activity[i].sum()
            if removed > 0:
                _progress(f"  Short-phrase filter ({min_phrase_sec}s): removed "
                          f"{removed * resolution:.1f}s of activity from {raw[i]['id']}")

    return [
        {"id": raw[i]["id"], "activity": activity[i]}
        for i in range(len(raw))
    ], seq_duration


# ─── Activity array (kept for any legacy callers) ─────────────────────────────

def build_activity_array(
    segments: list[tuple[float, float]],
    duration: float,
    resolution: float = 0.05,
) -> np.ndarray:
    n = int(np.ceil(duration / resolution))
    arr = np.zeros(n, dtype=bool)
    for start, end in segments:
        i_start = int(start / resolution)
        i_end   = min(int(np.ceil(end / resolution)), n)
        arr[i_start:i_end] = True
    return arr
