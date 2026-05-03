"""
Cut generation logic.

Input:  per-speaker boolean activity arrays + camera mapping config
Output: list of {start, end, camera_index} dicts

Algorithm summary
─────────────────
• Cuts happen at natural speech boundaries only — never mid-speech.

• min_shot_sec is a POST-cut cooldown, not a pre-cut hold.
  We cut to the new speaker immediately when they start talking, then
  block further cuts for min_shot_sec to prevent rapid ping-pong.

• Wide shots are inserted probabilistically, never on a fixed grid.
  Every ~max_shot_sec seconds (jittered ±40%) the algorithm rolls against
  wide_frequency.  On success the wide-shot state machine fires:
    1. Wait for the next silence  →  cut to wide
    2. Stay wide through the next speech segment
    3. When that speech ends (silence again)  →  arm exit
    4. When the next speaker starts  →  cut to their camera

• Simultaneous speech on ≥2 channels → switch to wide if available.
"""

import numpy as np
import random
from dataclasses import dataclass


@dataclass
class Speaker:
    id: str                  # "A", "B", "C"…
    activity: np.ndarray     # bool array


@dataclass
class Camera:
    index: int               # 1-based, matches multicam track index in Premiere
    speaker_id: str | None   # None = wide/group shot


@dataclass
class CutConfig:
    min_shot_sec:    float = 2.0    # post-cut cooldown (blocks rapid re-cuts)
    max_shot_sec:    float = 8.0    # mean interval between wide-shot roll checks (0 = never)
    wide_frequency:  float = 0.15   # probability per roll that a wide shot is inserted
    resolution:      float = 0.05   # seconds per activity-array frame
    cut_delay_sec:   float = 0.0    # shift every cut point forward by this many seconds


@dataclass
class Cut:
    start: float
    end:   float
    camera_index: int


def generate_cuts(
    speakers: list[Speaker],
    cameras:  list[Camera],
    config:   CutConfig,
    duration: float,
) -> list[Cut]:
    """
    Generate a camera cut list that respects natural speech boundaries.
    """
    res        = config.resolution
    n_frames   = int(np.ceil(duration / res))
    min_frames = int(config.min_shot_sec / res)

    # Base roll interval in frames (max_shot_sec = 0 disables wide shots)
    roll_base = int(config.max_shot_sec / res) if config.max_shot_sec > 0 else 0

    # ── Activity lookup ───────────────────────────────────────────────────────
    activity: dict[str, np.ndarray] = {}
    for spk in speakers:
        arr = spk.activity
        if len(arr) < n_frames:
            arr = np.concatenate([arr, np.zeros(n_frames - len(arr), dtype=bool)])
        activity[spk.id] = arr[:n_frames]

    # ── Camera lookup helpers ─────────────────────────────────────────────────
    speaker_cameras: dict[str, list[Camera]] = {}
    wide_cameras:    list[Camera]            = []

    for cam in cameras:
        if cam.speaker_id is None:
            wide_cameras.append(cam)
        else:
            speaker_cameras.setdefault(cam.speaker_id, []).append(cam)

    wide_indices    = {c.index for c in wide_cameras}
    fallback_camera = cameras[0] if cameras else Camera(index=1, speaker_id=None)

    # Track which speakers are assigned to each camera index so we can prefer
    # dedicated cameras (sole-speaker) over shared/tandem cameras when picking.
    index_speakers: dict[int, set] = {}
    for spk_id, cams in speaker_cameras.items():
        for c in cams:
            index_speakers.setdefault(c.index, set()).add(spk_id)

    def pick_for_speaker(spk_id: str) -> Camera | None:
        cams = speaker_cameras.get(spk_id)
        if not cams:
            return None
        dedicated = [c for c in cams if len(index_speakers.get(c.index, set())) == 1]
        return dedicated[0] if dedicated else cams[0]

    def pick_wide() -> Camera:
        return wide_cameras[0] if wide_cameras else fallback_camera

    rng = random.Random(42)

    def next_roll_delay() -> int:
        """Randomised frame count until next wide-shot roll (±40% jitter)."""
        jitter = max(1, int(roll_base * 0.4))
        return roll_base + rng.randint(-jitter, jitter)

    # ── Main loop state ───────────────────────────────────────────────────────
    cuts:          list[Cut] = []
    current_cam:   Camera    = pick_wide()
    current_start: float     = 0.0
    cool_down:     int       = 0

    # Wide-shot state machine
    can_do_wide      = (bool(wide_cameras)
                        and config.wide_frequency > 0
                        and roll_base > 0)
    wide_pending       = False   # roll succeeded; fire at next silence
    in_wide            = False   # currently showing wide shot
    wide_had_speech    = False   # has speech occurred since we entered wide?
    wide_entry_frame   = 0       # frame when we entered the wide shot
    wide_silence_frames = 0      # consecutive silence frames (micro-pause filter)
    wide_roll_timer    = next_roll_delay() if can_do_wide else 0

    for f in range(n_frames):
        active   = [spk.id for spk in speakers if activity[spk.id][f]]
        n_active = len(active)
        if cool_down > 0:
            cool_down -= 1

        # ── Wide-shot roll timer ──────────────────────────────────────────────
        # Ticks only when we're not already in a wide shot or pending one.
        # On expiry: roll dice.  Whether we win or lose, reset the timer
        # with a fresh random delay so the next opportunity is unpredictable.
        if can_do_wide and not in_wide and not wide_pending:
            wide_roll_timer -= 1
            if wide_roll_timer <= 0:
                if (current_cam.index not in wide_indices
                        and rng.random() < config.wide_frequency):
                    wide_pending = True
                wide_roll_timer = next_roll_delay()

        # ── Determine desired camera this frame ───────────────────────────────
        # Track consecutive silence frames for micro-pause filtering.
        # Speech frames reset the counter; silence frames accumulate it.
        if n_active > 0:
            wide_silence_frames = 0

        if n_active == 0:
            wide_silence_frames += 1
            if in_wide:
                wide_elapsed = f - wide_entry_frame
                # Require at least 5 consecutive silence frames (~0.25s) before
                # exiting wide — this filters out micro-pauses within speech that
                # the VAD sometimes misclassifies as silence.
                real_silence = wide_silence_frames >= 5
                if real_silence and (wide_had_speech or wide_elapsed >= min_frames):
                    # Real silence after speech (or timeout) → arm exit so the
                    # next speaker triggers the cut to their camera.
                    in_wide          = False
                    wide_had_speech  = False
                    wide_roll_timer  = next_roll_delay()  # fresh timer after exit
                    cool_down        = 0                  # allow immediate exit cut
                # Hold (whether still officially in_wide or just armed-to-exit)
                desired = current_cam

            elif wide_pending:
                # Roll succeeded and we hit a silence — enter wide now.
                desired           = pick_wide()
                in_wide           = True
                wide_pending      = False
                wide_entry_frame  = f

            else:
                desired = current_cam   # regular silence hold

        elif n_active == 1:
            if in_wide:
                # Stay wide while the speech segment plays out.
                wide_had_speech = True
                desired = current_cam
            else:
                spk_cam = pick_for_speaker(active[0])
                desired  = spk_cam if spk_cam else current_cam

        else:
            # Simultaneous speech from ≥2 speakers
            if in_wide:
                wide_had_speech = True
                desired = current_cam
            else:
                # Find cameras that cover ALL active speakers simultaneously
                # (intersection of each speaker's camera-index set).  A tandem
                # camera assigned to both A and B will appear in this intersection;
                # a dedicated solo camera will not.
                cam_sets = [
                    {c.index for c in (speaker_cameras.get(sid) or [])}
                    for sid in active
                ]
                shared_indices: set[int] = set(cam_sets[0]) if cam_sets else set()
                for s in cam_sets[1:]:
                    shared_indices &= s

                if shared_indices:
                    # Prefer staying on the current camera if it's already a shared one.
                    if current_cam.index in shared_indices:
                        desired = current_cam
                    else:
                        idx = min(shared_indices)
                        desired = next((c for c in cameras if c.index == idx), current_cam)
                else:
                    desired = pick_wide() if wide_cameras else current_cam

        # ── Commit cut when desired changes and cooldown elapsed ──────────────
        if desired.index != current_cam.index and cool_down == 0:
            t = round(f * res, 3)
            cuts.append(Cut(
                start=round(current_start, 3),
                end=t,
                camera_index=current_cam.index,
            ))
            current_cam   = desired
            current_start = t
            cool_down     = min_frames

    # ── Final segment ─────────────────────────────────────────────────────────
    cuts.append(Cut(
        start=round(current_start, 3),
        end=round(duration, 3),
        camera_index=current_cam.index,
    ))

    # Drop zero-duration artefacts
    cuts = [c for c in cuts if c.end > c.start]

    # ── Apply cut offset (delay / J-cut) ─────────────────────────────────────
    # Shifts every internal cut boundary by cut_delay_sec seconds.
    # Positive → delay cut (stay on outgoing speaker longer).
    # Negative → J-cut   (show incoming speaker before they speak).
    # The first and last boundary are never shifted (sequence edges).
    if config.cut_delay_sec != 0 and len(cuts) > 1:
        d = config.cut_delay_sec
        adjusted = []
        for i, cut in enumerate(cuts):
            new_start = round(cut.start + d, 3) if i > 0             else cut.start
            new_end   = round(cut.end   + d, 3) if i < len(cuts) - 1 else cut.end
            new_start = max(0.0,     min(new_start, duration))
            new_end   = max(0.0,     min(new_end,   duration))
            if new_end > new_start:
                adjusted.append(Cut(start=new_start, end=new_end,
                                    camera_index=cut.camera_index))
        cuts = adjusted

    return cuts


def cuts_to_dict(cuts: list[Cut]) -> list[dict]:
    return [
        {"start": c.start, "end": c.end, "camera": c.camera_index}
        for c in cuts
    ]


def find_silence_removals(
    cuts:             list[Cut],
    cameras:          list[Camera],
    speakers:         list[Speaker],
    min_silence_sec:  float,
    resolution:       float,
    duration:         float,
    snap_tolerance:   float = 0.5,
    allow_wide_bridge: bool = True,
) -> tuple[list[Cut], list[dict]]:
    """
    Find ALL silence gaps >= min_silence_sec and return them as removal ranges.
    Also modifies the cuts list to insert synthetic camera switches where needed
    so that every removal point is a camera switch (no same-camera jump cuts).

    Strategy per gap:
      1. A camera-cut falls INSIDE the gap → both sides already differ. ✓
      2. A camera-cut is within snap_tolerance of a gap edge → snap to include it. ✓
      3. No cut available → insert a synthetic cut at gap_end that switches to
         the wide-shot camera (or any camera ≠ current), so the edit goes
         CamA → Wide instead of CamA → CamA.

    Returns (modified_cuts, removals).
    """
    if min_silence_sec <= 0:
        return cuts, []

    n_frames   = int(np.ceil(duration / resolution))
    min_frames = max(1, int(min_silence_sec / resolution))

    # ── Combined activity (any speaker active = True) ─────────────────────────
    combined = np.zeros(n_frames, dtype=bool)
    for spk in speakers:
        arr = spk.activity
        if len(arr) < n_frames:
            arr = np.concatenate([arr, np.zeros(n_frames - len(arr), dtype=bool)])
        combined |= arr[:n_frames]

    # ── Collect all silence gaps ───────────────────────────────────────────────
    gaps: list[tuple[float, float]] = []
    in_sil    = False
    sil_start = 0
    for f in range(n_frames):
        if not combined[f]:
            if not in_sil:
                sil_start = f
                in_sil    = True
        else:
            if in_sil:
                in_sil = False
                if f - sil_start >= min_frames:
                    gaps.append((round(sil_start * resolution, 4),
                                 round(f            * resolution, 4)))
    if in_sil and n_frames - sil_start >= min_frames:
        gaps.append((round(sil_start * resolution, 4), round(duration, 4)))

    if not gaps:
        return cuts, []

    # ── Per-speaker activity lookup (needed for smart bridge) ─────────────────
    spk_activity: dict[str, np.ndarray] = {}
    for spk in speakers:
        arr = spk.activity
        if len(arr) < n_frames:
            arr = np.concatenate([arr, np.zeros(n_frames - len(arr), dtype=bool)])
        spk_activity[spk.id] = arr[:n_frames]

    # ── Helpers ───────────────────────────────────────────────────────────────
    working_cuts: list[Cut] = list(cuts)

    def cut_boundaries() -> list[float]:
        return sorted({round(c.end, 4) for c in working_cuts[:-1]})

    def camera_at(t: float) -> int:
        """Camera index active at source time t (uses working_cuts)."""
        for c in working_cuts:
            if c.start <= t < c.end:
                return c.camera_index
        return working_cuts[-1].camera_index

    wide_indices = {c.index for c in cameras if c.speaker_id is None}
    all_indices  = [c.index for c in cameras]

    def best_camera_for(gap_end: float, current: int) -> int | None:
        """
        Which camera should play from gap_end onwards?

        - Collect ALL speakers at the first non-silent frame at/after gap_end.
        - 2+ simultaneous: already on wide → None (stay); on speaker cam → wide (if
          allow_wide_bridge), else None.
        - 1 speaker: their cam; None if already on it.
        - 0 speakers: None.
        - Never returns a wide index when current is already wide.
        """
        start_f = max(0, int(round(gap_end / resolution)))

        active_ids: list[str] = []
        for fi in range(start_f, n_frames):
            for spk in speakers:
                if spk_activity[spk.id][fi]:
                    active_ids.append(spk.id)
            if active_ids:
                break

        if not active_ids:
            return None

        if len(active_ids) >= 2:
            if current in wide_indices:
                return None          # already on wide, best place for multi-speaker
            if allow_wide_bridge:
                for idx in all_indices:
                    if idx in wide_indices:
                        return idx
            return None

        spk_id = active_ids[0]
        for cam in cameras:
            if cam.speaker_id == spk_id:
                return cam.index if cam.index != current else None
        return None

    def insert_cut_at(t: float, new_cam: int):
        """
        Insert a camera switch to new_cam at time t.
        Handles both:
          • t strictly inside a cut  → split it
          • t at a cut's start time  → reassign that cut's camera
        """
        nonlocal working_cuts
        result = []
        for cut in working_cuts:
            if cut.camera_index == new_cam:
                result.append(cut)
                continue
            # Case A: t is strictly inside this cut
            if cut.start < t < cut.end:
                result.append(Cut(cut.start, t, cut.camera_index))
                result.append(Cut(t,          cut.end, new_cam))
            # Case B: this cut starts exactly at t → reassign its camera
            elif abs(cut.start - t) < 1e-6:
                result.append(Cut(cut.start, cut.end, new_cam))
            else:
                result.append(cut)
        working_cuts = result

    # ── Process each gap ──────────────────────────────────────────────────────
    # Unified logic:
    #   1. Determine snapped removal range (using existing cut boundaries).
    #   2. Check camera before and after the range.
    #   3. If same camera: try to insert a bridge at snapped_e.
    #   4. If still same camera AND it's the wide cam → SKIP removal
    #      (better to keep the silence than create a wide→wide jump cut).
    #   5. Otherwise commit the removal.
    removals: list[dict] = []

    for gap_s, gap_e in gaps:
        bnd = cut_boundaries()

        # ── Step 1: find snapped range ────────────────────────────────────────
        inside = [t for t in bnd if gap_s < t < gap_e]
        if inside:
            snapped_s, snapped_e = gap_s, gap_e
        else:
            pre  = max((t for t in bnd if t <= gap_s and gap_s - t <= snap_tolerance),
                       default=None)
            post = min((t for t in bnd if t >= gap_e and t - gap_e <= snap_tolerance),
                       default=None)
            snapped_s = max(0.0,      pre  if pre  is not None else gap_s)
            snapped_e = min(duration, post if post is not None else gap_e)

        # ── Step 2: cameras on each side of the removal ───────────────────────
        cam_before = camera_at(max(0.0, snapped_s - resolution))
        cam_after  = camera_at(snapped_e)

        # ── Step 3: same camera → try to insert a bridge ─────────────────────
        if cam_before == cam_after:
            bridge = best_camera_for(snapped_e, cam_before)
            if bridge is not None:
                insert_cut_at(snapped_e, bridge)
                cam_after = camera_at(snapped_e)  # recheck after insertion

        # ── Step 4: still same camera on the wide track → skip removal ───────
        if cam_before == cam_after and cam_before in wide_indices:
            continue   # keeping the silence is better than a wide→wide jump cut

        # ── Step 5: commit ────────────────────────────────────────────────────
        removals.append({"start": round(snapped_s, 4), "end": round(snapped_e, 4)})

    # ── Sort and merge overlapping removals ────────────────────────────────────
    removals.sort(key=lambda r: r["start"])
    merged: list[dict] = []
    for r in removals:
        if merged and r["start"] <= merged[-1]["end"]:
            merged[-1]["end"] = max(merged[-1]["end"], r["end"])
        else:
            merged.append(dict(r))

    return working_cuts, merged
