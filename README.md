# OpenPodCut

A free, open-source Adobe Premiere Pro extension that automatically cuts multicam podcast recordings based on speaker activity — no subscription required.

If it saves you time, [☕ buy me a coffee](https://base.monobank.ua/4QTZuQ2Q8UfjJF) — it keeps the project going.

---

## What it does

OpenPodCut watches the audio on each speaker's track, detects when they're talking, and builds a cut list that keeps the camera on whoever is speaking. It can also:

- Insert wide/group shots at natural pauses (probabilistic, not on a fixed grid)
- Remove dead silence between sentences to tighten pacing
- Add chapter markers wherever the host speaks for an extended stretch
- Apply L-cuts and J-cuts to soften hard edits
- Handle tandem shots — one camera covering two speakers simultaneously
- Two "all-wide" modes when every camera sees everyone: **Random** (periodic switching) and **Reaction** (hold on speech, cut on the pause)
- Survive camera recording gaps — if a camera was restarted mid-shoot, it automatically holds another angle over the missing footage
- Output cuts directly into the active sequence **or** export an FCP7 XML for faster processing on long recordings

---

## Requirements

- Adobe Premiere Pro 2019 or later (CC 13.0+)
- Windows 10 / 11 or macOS (Apple Silicon / Intel)
- ~300 MB free disk space (PyTorch is bundled in the analyzer)
- No Python runtime needed after installation

---

## Installation

### Option A — Pre-built release (recommended)

1. Download the latest `podcast-cutter.zip` from [Releases](../../releases).
2. Unzip and run `install\install.bat` — this copies the extension to Premiere's extensions folder.
3. Run `install\enable_debug_mode.bat` **as Administrator** — this lets Premiere load unsigned extensions.
4. Restart Premiere Pro.
5. Open the panel: **Window → Extensions → OpenPodCut**.

### Option B — Build from source

**Prerequisites:** Python 3.10+, pip

```bat
cd analyzer
pip install -r requirements.txt
build.bat
```

`build.bat` compiles `analyzer.py` into a self-contained `analyzer.exe` (~300 MB with PyTorch bundled), copies it into the extension folder, and then deploys the whole extension to Premiere's AppData folder automatically.

After the build, follow steps 3–5 from Option A.

---

## Usage

1. Open a multicam sequence in Premiere Pro.
2. Open the panel (**Window → Extensions → OpenPodCut**).
3. Set the number of speakers and cameras.
4. Map each **speaker** to the audio track that carries their microphone.
5. Assign each **camera** to the speaker it shows (or mark it as a wide/group shot).
6. Adjust settings (or load a preset).
7. Choose output mode — **✂️ Premiere** for direct cutting, **✂️ XML** for faster export.
8. Click **Cut in Premiere** / **Cut via XML**.

### Tandem cameras

If one camera covers two speakers (e.g. a two-shot of A and B), assign that camera to both speakers using the `A + B` option in the camera dropdown. The algorithm will cut to it automatically when both are talking at once.

---

## Settings reference

### Cuts

| Setting | Default | Description |
|---|---|---|
| Min shot duration | 2 s | Post-cut cooldown — blocks another cut for this long after switching cameras. Prevents rapid ping-pong. |
| L-cut — linger | 0 s | Stay on the outgoing speaker this many seconds past the cut point before switching. |
| J-cut — lead in | 0 s | Show the incoming speaker this many seconds before they start talking. |

### Wide shot

| Setting | Default | Description |
|---|---|---|
| Wide shots | Some | How often the edit breaks to a wide/group shot: **Off / Rare / Some / Often / Custom**. Custom exposes the raw roll interval (*Check every*) and per-check probability (*Chance per check*). |
| All-wide style | Random | Only applies when *every* camera is set to Wide/Group shot. **Random** — switch cameras periodically during speech. **Reaction** — hold the shot while anyone talks, cut to another camera on a pause. |

### Detection

| Setting | Default | Description |
|---|---|---|
| Min phrase duration | 1.5 s | Ignore speech bursts shorter than this (filters out "hmm", breaths, mic clicks). |
| Mic bleed filter | Medium | Cross-channel dominance filter that suppresses microphone bleed: **Off / Subtle / Medium / Lav / Custom**. Lower dB = more aggressive; **Lav** (5 dB) is tuned for lavalier mics with tight bleed. |

### Cleanup

| Setting | Default | Description |
|---|---|---|
| Snap cuts to zero crossing | off | Nudge each cut ±50 ms to the nearest audio zero-crossing to reduce pops. |
| Remove silences | off | *(XML mode only)* Ripple-remove stretches where everyone is silent longer than the threshold (default 2 s). |

### Finishing

| Setting | Default | Description |
|---|---|---|
| Punch-in zoom | 0% | *(Premiere mode only)* Scale enabled clips up by this percentage to punch in and mask cuts. 0 = off. |
| Chapter if host speaks ≥ | 10 s | Add a sequence marker whenever the host (★) speaks continuously for at least this long. |

---

## How it works

```
Premiere Pro sequence
        │
        │  ExtendScript (host.jsx)
        │  reads audio file paths + timecodes for each track
        ▼
   analyzer.exe  ◄── JSON config (speakers, cameras, settings)
        │
        ├─ vad.py   — Silero-VAD on each audio file
        │             cross-channel dominance filter removes mic bleed
        │
        └─ cuts.py  — state machine builds cut list
                      • cut at natural speech boundaries only
                      • probabilistic wide-shot insertion
                      • L-cut / J-cut offset support
                      • tandem camera intersection logic
                      • silence removal (XML mode)
        │
        │  JSON result (cuts + silence removals + chapter points)
        ▼
   main.js routes to:
        ├─ Premiere mode → ExtendScript applies razor cuts directly
        └─ XML mode      → FCP7 XML written to disk, imported into Premiere
```

### Cross-channel dominance filtering

Each speaker's audio track is analysed independently. For every 50ms frame, OpenPodCut compares each channel's volume against its own noise floor (20th-percentile baseline). A speaker is considered silent if their signal is more than 12 dB below the loudest active channel — this suppresses microphone bleed without any manual tuning.

### Wide shot state machine

The wide-shot timer ticks down in the background. When it expires the algorithm rolls a dice against `wide_frequency`. On success it waits for the next natural silence, cuts to the wide camera, stays wide through the next speech segment, then exits back to individual cameras when that segment ends. The timer resets with ±40% random jitter each cycle so wide shots never fall on a predictable grid.

---

## Project structure

```
podcast-cutter/
├── analyzer/               Python source for analyzer.exe
│   ├── analyzer.py         Entry point — orchestrates VAD + cut generation
│   ├── vad.py              Silero-VAD wrapper + dominance filter
│   ├── cuts.py             Cut generation state machine
│   ├── requirements.txt
│   └── build.bat           PyInstaller build + auto-deploy script
│
├── cep-extension/          The actual Premiere extension
│   ├── index.html          Panel UI
│   ├── main.js             Node.js logic (spawns analyzer, routes results)
│   ├── CSInterface.js      Adobe CEP library
│   ├── host/host.jsx       ExtendScript — reads tracks, applies cuts
│   ├── CSXS/manifest.xml   CEP registration (Premiere 2019+)
│   └── bin/analyzer/       Built analyzer.exe (created by build.bat)
│
└── install/
    ├── install.bat         Copies extension to Premiere's extensions folder
    └── enable_debug_mode.bat  Enables unsigned CEP extensions (run as Admin)
```

---

## Building a release

```bat
cd analyzer
build.bat
```

The script:
1. Runs `pip install` from `requirements.txt`
2. Compiles `analyzer.exe` via PyInstaller (`--onedir` bundle)
3. Deploys `bin/analyzer/` to `cep-extension/bin/analyzer/`
4. Copies updated `index.html`, `main.js`, and `host.jsx` to Premiere's AppData folder

To produce a distributable zip, package the `cep-extension/` folder together with the `install/` scripts.

---

## Contributing

Issues and pull requests are welcome. A few notes:

- Python logic lives in `analyzer/` — changes require a full `build.bat` rebuild since the `.py` source files are not read at runtime (PyInstaller bundles everything into the exe).
- The CEP frontend (`index.html`, `main.js`, `host.jsx`) can be edited and tested without a rebuild — just reload the panel in Premiere.
- To reload the panel without restarting Premiere: close and reopen it from **Window → Extensions**, or use the CEP debugger at `http://localhost:7777`.

---

## License

GNU General Public License v3.0 — see [LICENSE](LICENSE).

You are free to use, modify, and distribute this software for any purpose (including commercial video work). If you distribute a modified version of OpenPodCut, you must release the source under the same GPL v3 license. You may not take this code, close-source it, and sell it as a proprietary product.
