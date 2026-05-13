/**
 * main.js — runs in the CEP panel (Node.js context via window.__adobe_cep__)
 *
 * Responsibilities:
 *  - UI state management (speaker/camera counts, dropdowns, mode selector)
 *  - Talk to Premiere via CSInterface → host.jsx
 *  - Spawn analyzer.exe with config JSON
 *  - Pass results back to host.jsx (Premiere mode) or generate FCP7 XML (XML mode)
 */

'use strict';

const csInterface = new CSInterface();
const path = require('path');
const fs = require('fs');
const os = require('os');
const { execFile } = require('child_process');

// ─── Paths ────────────────────────────────────────────────────────────────────

// On Windows, CEP's pathname starts with /C:/... — strip the leading slash before the drive letter.
// On macOS it's a normal Unix path, so no transformation needed.
const isWin = process.platform === 'win32';
const rawPathname = decodeURIComponent(window.location.pathname);
const EXTENSION_ROOT = path.dirname(
  isWin ? rawPathname.replace(/^\/([A-Za-z]:)/, '$1') : rawPathname
);
const ANALYZER_EXE = path.join(EXTENSION_ROOT, 'bin', 'analyzer', isWin ? 'analyzer.exe' : 'analyzer');

// ─── State ────────────────────────────────────────────────────────────────────

let state = {
  speakerCount:  1,
  cameraCount:   2,
  audioTracks:   [],       // [{index, name}] from Premiere
  speakerTrackMap: {},     // speakerId ("A","B"...) → track index
  cameraAssignMap: {},     // cameraIndex (1,2...) → speakerId or "wide"
  speakerNames:  ['', '', '', ''],  // user-entered display names
  hostSpeakerId: 'A',      // speaker designated as host for chapter markers
  outputMode:    'premiere', // 'premiere' | 'xml'
};

const SPEAKER_IDS    = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J'];
const SPEAKER_LABELS = ['Speaker A', 'Speaker B', 'Speaker C', 'Speaker D',
                        'Speaker E', 'Speaker F', 'Speaker G', 'Speaker H',
                        'Speaker I', 'Speaker J'];

/** Returns the display name for speaker slot i (falls back to "Speaker A" etc.) */
function speakerLabel(i) {
  return (state.speakerNames[i] && state.speakerNames[i].trim()) || SPEAKER_LABELS[i];
}

// ─── Logging ──────────────────────────────────────────────────────────────────

const logEl   = document.getElementById('log');
const logWrap = document.getElementById('log-wrap');

function log(msg, type = 'info') {
  logWrap.classList.add('visible');
  const line = document.createElement('div');
  line.className = type;
  line.textContent = msg;
  logEl.appendChild(line);
  logEl.scrollTop = logEl.scrollHeight;
}

function logClear() {
  logEl.innerHTML = '';
}

const copyLogBtn = document.getElementById('btn-copy-log');
if (copyLogBtn) {
  copyLogBtn.addEventListener('click', () => {
    const text = Array.from(logEl.children).map(el => el.textContent).join('\n');
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.cssText = 'position:fixed;opacity:0;top:0;left:0';
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand('copy'); copyLogBtn.textContent = 'Copied!'; } catch (e) {}
    document.body.removeChild(ta);
    setTimeout(() => { copyLogBtn.textContent = 'Copy'; }, 1500);
  });
}

// ─── CSInterface helpers ──────────────────────────────────────────────────────

function callHost(fn, arg) {
  return new Promise((resolve, reject) => {
    const script = arg !== undefined
      ? `${fn}(${JSON.stringify(String(arg))})`
      : `${fn}()`;

    csInterface.evalScript(script, (result) => {
      try {
        const parsed = JSON.parse(result);
        if (parsed.status === 'ok') resolve(parsed.data);
        else reject(new Error(parsed.message || 'Unknown host error'));
      } catch (e) {
        reject(new Error('Host returned non-JSON: ' + result));
      }
    });
  });
}

// ─── Pill groups (numeric values) ────────────────────────────────────────────

function setupPillGroup(groupId, onChange) {
  const group = document.getElementById(groupId);
  group.querySelectorAll('.pill').forEach(btn => {
    btn.addEventListener('click', () => {
      group.querySelectorAll('.pill').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      onChange(parseInt(btn.dataset.val, 10));
    });
  });
}

setupPillGroup('pills-speakers', (n) => {
  state.speakerCount = n;
  renderSpeakerRows();
  renderCameraRows();
});

setupPillGroup('pills-cameras', (n) => {
  state.cameraCount = n;
  renderCameraRows();
});

// ─── Output mode pill group ───────────────────────────────────────────────────

const MODE_DESCRIPTIONS = {
  premiere: 'Applies cuts directly to the active sequence. Best for shorter projects. Punch-in zoom available.',
  xml:      'Creates a new cut sequence via XML — much faster than Premiere mode for long recordings. Silence removal available.',
};

document.getElementById('pills-mode').querySelectorAll('.pill').forEach(btn => {
  btn.addEventListener('click', () => {
    document.getElementById('pills-mode').querySelectorAll('.pill')
      .forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    state.outputMode = btn.dataset.val;
    updateModeState();
  });
});

function updateModeState() {
  const mode = state.outputMode;

  // Update description text
  document.getElementById('mode-desc').textContent = MODE_DESCRIPTIONS[mode];

  // Dim rows that belong to the other mode
  document.querySelectorAll('[data-requires-mode]').forEach(row => {
    row.classList.toggle('mode-locked', row.dataset.requiresMode !== mode);
  });

  // Update run button label
  document.getElementById('btn-run').textContent =
    mode === 'premiere' ? '✂️ Cut in Premiere' : '✂️ Cut via XML';
}

// ─── Render speaker rows ──────────────────────────────────────────────────────

function renderSpeakerRows() {
  const container = document.getElementById('speaker-rows');
  container.innerHTML = '';

  for (let i = 0; i < state.speakerCount; i++) {
    const id  = SPEAKER_IDS[i];
    const row = document.createElement('div');
    row.className = 'mapping-row';

    // Narrow letter badge (A / B / C / D)
    const label = document.createElement('div');
    label.className = 'mapping-label';
    label.style.width = '22px';
    label.innerHTML = `<span>${id}</span>`;

    // Host star button — designates this speaker as host for chapter markers
    const hostBtn = document.createElement('button');
    hostBtn.title       = 'Mark as host — chapter markers are added when this speaker talks for a long time';
    hostBtn.textContent = state.hostSpeakerId === id ? '★' : '☆';
    hostBtn.style.cssText = [
      'width:20px', 'height:24px', 'flex-shrink:0',
      'background:transparent', 'border:none', 'padding:0',
      'font-size:13px', 'line-height:1', 'cursor:pointer',
      `color:${state.hostSpeakerId === id ? '#f0c040' : '#555'}`,
    ].join(';');
    hostBtn.addEventListener('click', () => {
      state.hostSpeakerId = id;
      renderSpeakerRows();
    });

    // Editable name input
    const nameInput = document.createElement('input');
    nameInput.type        = 'text';
    nameInput.className   = 'speaker-name-input';
    nameInput.id          = `speaker-name-${id}`;
    nameInput.placeholder = SPEAKER_LABELS[i];
    nameInput.value       = state.speakerNames[i] || '';
    nameInput.addEventListener('input', () => {
      state.speakerNames[i] = nameInput.value;
      renderCameraRows();
    });

    // Audio track selector
    const sel = document.createElement('select');
    sel.id = `speaker-track-${id}`;

    if (state.audioTracks.length === 0) {
      const opt = document.createElement('option');
      opt.value = '';
      opt.textContent = '— reload tracks —';
      sel.appendChild(opt);
    } else {
      state.audioTracks.forEach(track => {
        const opt = document.createElement('option');
        opt.value       = track.index;
        opt.textContent = `A${track.index + 1}`;
        if (track.index === i) opt.selected = true;
        sel.appendChild(opt);
      });
    }

    sel.addEventListener('change', () => {
      state.speakerTrackMap[id] = parseInt(sel.value, 10);
    });

    if (state.audioTracks.length > 0) {
      state.speakerTrackMap[id] = Math.min(i, state.audioTracks.length - 1);
    }

    row.appendChild(label);
    row.appendChild(hostBtn);
    row.appendChild(nameInput);
    row.appendChild(sel);
    container.appendChild(row);
  }
}

// ─── Render camera rows ───────────────────────────────────────────────────────

function renderCameraRows() {
  const container = document.getElementById('camera-rows');
  container.innerHTML = '';

  for (let c = 1; c <= state.cameraCount; c++) {
    const row = document.createElement('div');
    row.className = 'mapping-row';

    const label = document.createElement('div');
    label.className = 'mapping-label';
    label.innerHTML = `<span>V${c}</span>`;

    const sel = document.createElement('select');
    sel.id = `camera-speaker-${c}`;

    const previousVal = state.cameraAssignMap[c];

    // Single-speaker options
    for (let i = 0; i < state.speakerCount; i++) {
      const opt = document.createElement('option');
      opt.value       = SPEAKER_IDS[i];
      opt.textContent = speakerLabel(i);
      sel.appendChild(opt);
    }

    // Tandem (two-shot) options — all pairs of active speakers
    for (let i = 0; i < state.speakerCount; i++) {
      for (let j = i + 1; j < state.speakerCount; j++) {
        const opt = document.createElement('option');
        opt.value       = SPEAKER_IDS[i] + '+' + SPEAKER_IDS[j];
        opt.textContent = speakerLabel(i) + ' + ' + speakerLabel(j);
        sel.appendChild(opt);
      }
    }

    const wideOpt = document.createElement('option');
    wideOpt.value       = 'wide';
    wideOpt.textContent = 'Wide / Group shot';
    sel.appendChild(wideOpt);

    const defaultVal    = c <= state.speakerCount ? SPEAKER_IDS[c - 1] : 'wide';
    sel.value           = previousVal || defaultVal;
    state.cameraAssignMap[c] = sel.value;

    sel.addEventListener('change', () => {
      state.cameraAssignMap[c] = sel.value;
    });

    row.appendChild(label);
    row.appendChild(sel);
    container.appendChild(row);
  }
}

// ─── Reload tracks from Premiere ─────────────────────────────────────────────

document.getElementById('btn-reload').addEventListener('click', async () => {
  try {
    log('Loading audio tracks from Premiere...');
    state.audioTracks = await callHost('getAudioTrackList');
    log(`Found ${state.audioTracks.length} audio tracks`, 'ok');
    renderSpeakerRows();
  } catch (e) {
    log('Error: ' + e.message, 'err');
  }
});

// ─── Range display ────────────────────────────────────────────────────────────

const wideRange = document.getElementById('setting-wide-freq');
const wideVal   = document.getElementById('wide-freq-val');
wideRange.addEventListener('input', () => {
  wideVal.textContent = wideRange.value + '%';
});

// ─── Mic bleed filter pill group ─────────────────────────────────────────────

document.getElementById('pills-dominance').querySelectorAll('.pill').forEach(btn => {
  btn.addEventListener('click', () => {
    document.getElementById('pills-dominance').querySelectorAll('.pill')
      .forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    document.getElementById('dominance-custom-wrap').style.display =
      btn.dataset.val === 'custom' ? 'flex' : 'none';
  });
});

function getDominanceDb() {
  const active = document.querySelector('#pills-dominance .pill.active');
  if (!active) return 12;
  if (active.dataset.val === 'custom') {
    return parseFloat(document.getElementById('setting-dominance-db').value) || 0;
  }
  return parseFloat(active.dataset.val);
}

// ─── Max-shot checkbox toggle ─────────────────────────────────────────────────

const maxShotCheckbox = document.getElementById('setting-max-shot-enabled');
const maxShotInput    = document.getElementById('setting-max-shot');
const silenceCheckbox = document.getElementById('setting-silence-enabled');
const silenceInput    = document.getElementById('setting-min-silence');

maxShotCheckbox.addEventListener('change', () => {
  maxShotInput.disabled = !maxShotCheckbox.checked;
});

silenceCheckbox.addEventListener('change', () => {
  silenceInput.disabled = !silenceCheckbox.checked;
});

// ─── Presets (localStorage) ───────────────────────────────────────────────────

const PRESET_KEY = 'openpodcut_presets';

function getPresetSettings() {
  return {
    speakerCount:   state.speakerCount,
    cameraCount:    state.cameraCount,
    minShot:        document.getElementById('setting-min-shot').value,
    maxShotEnabled: maxShotCheckbox.checked,
    maxShot:        maxShotInput.value,
    wideFreq:       wideRange.value,
    minPhrase:      document.getElementById('setting-min-phrase').value,
    cutDelay:       document.getElementById('setting-cut-delay').value,
    jCut:           document.getElementById('setting-jcut').value,
    silenceEnabled: silenceCheckbox.checked,
    minSilence:     silenceInput.value,
    dominanceDb:    getDominanceDb(),
    dominancePill:  (document.querySelector('#pills-dominance .pill.active') || {}).dataset?.val ?? '12',
    zoomPct:        document.getElementById('setting-zoom-pct').value,
    snapEnabled:    document.getElementById('setting-snap-enabled').checked,
    chapterSec:     document.getElementById('setting-chapter-sec').value,
    outputMode:     state.outputMode,
  };
}

function applyPresetSettings(s) {
  document.getElementById('setting-min-shot').value    = s.minShot   ?? 2.0;
  maxShotCheckbox.checked  = s.maxShotEnabled ?? false;
  maxShotInput.disabled    = !maxShotCheckbox.checked;
  maxShotInput.value       = s.maxShot        ?? 8.0;
  wideRange.value          = s.wideFreq       ?? 15;
  document.getElementById('wide-freq-val').textContent = (s.wideFreq ?? 15) + '%';
  document.getElementById('setting-min-phrase').value  = s.minPhrase ?? 1.5;
  document.getElementById('setting-cut-delay').value   = s.cutDelay  ?? 0;
  document.getElementById('setting-jcut').value        = s.jCut      ?? 0;
  silenceCheckbox.checked  = s.silenceEnabled ?? false;
  silenceInput.disabled    = !silenceCheckbox.checked;
  silenceInput.value       = s.minSilence     ?? 2.0;
  // Restore mic bleed filter (new pill format, with legacy numeric fallback)
  {
    const targetPill = s.dominancePill ?? String(s.dominanceDb ?? 12);
    const pill = document.querySelector(`#pills-dominance .pill[data-val="${targetPill}"]`);
    if (pill) {
      pill.click();
      if (targetPill === 'custom') {
        document.getElementById('setting-dominance-db').value = s.dominanceDb ?? 12;
      }
    } else {
      // Value doesn't match any preset — activate Custom and populate the field
      const customPill = document.querySelector('#pills-dominance .pill[data-val="custom"]');
      if (customPill) customPill.click();
      document.getElementById('setting-dominance-db').value = s.dominanceDb ?? 12;
    }
  }
  document.getElementById('setting-zoom-pct').value     = s.zoomPct     ?? 0;
  document.getElementById('setting-snap-enabled').checked = s.snapEnabled ?? false;
  document.getElementById('setting-chapter-sec').value  = s.chapterSec  ?? 10;

  // Restore speaker / camera counts — click the matching pill to trigger full re-render
  if (s.speakerCount) {
    const p = document.querySelector(`#pills-speakers .pill[data-val="${s.speakerCount}"]`);
    if (p) p.click();
  }
  if (s.cameraCount) {
    const p = document.querySelector(`#pills-cameras .pill[data-val="${s.cameraCount}"]`);
    if (p) p.click();
  }

  // Restore output mode
  if (s.outputMode && (s.outputMode === 'premiere' || s.outputMode === 'xml')) {
    state.outputMode = s.outputMode;
    document.getElementById('pills-mode').querySelectorAll('.pill').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.val === s.outputMode);
    });
    updateModeState();
  }
}

function loadAllPresets() {
  try { return JSON.parse(localStorage.getItem(PRESET_KEY) || '{}'); } catch { return {}; }
}
function saveAllPresets(p) { localStorage.setItem(PRESET_KEY, JSON.stringify(p)); }

function refreshPresetDropdown() {
  const sel     = document.getElementById('preset-select');
  const cur     = sel.value;
  const presets = loadAllPresets();
  sel.innerHTML = '<option value="">— saved presets —</option>';
  Object.keys(presets).forEach(name => {
    const opt = document.createElement('option');
    opt.value = opt.textContent = name;
    sel.appendChild(opt);
  });
  if (cur && presets[cur]) sel.value = cur;
}

document.getElementById('btn-preset-save').addEventListener('click', () => {
  const name = document.getElementById('preset-name').value.trim();
  if (!name) return;
  const all = loadAllPresets();
  all[name] = getPresetSettings();
  saveAllPresets(all);
  refreshPresetDropdown();
  document.getElementById('preset-select').value = name;
});

document.getElementById('btn-preset-load').addEventListener('click', () => {
  const name = document.getElementById('preset-select').value;
  if (!name) return;
  const all = loadAllPresets();
  if (all[name]) applyPresetSettings(all[name]);
});

document.getElementById('btn-preset-delete').addEventListener('click', () => {
  const name = document.getElementById('preset-select').value;
  if (!name) return;
  const all = loadAllPresets();
  delete all[name];
  saveAllPresets(all);
  refreshPresetDropdown();
});

refreshPresetDropdown();

// ─── Run button — routes to Premiere or XML flow based on mode ────────────────

document.getElementById('btn-run').addEventListener('click', async () => {
  const btn = document.getElementById('btn-run');
  btn.disabled = true;
  logClear();

  try {
    const pipeline = await runAnalysisPipeline(log);
    if (!pipeline) return;  // user cancelled during validation

    if (state.outputMode === 'xml') {
      await runXMLFlow(pipeline);
    } else {
      await runPremiereFlow(pipeline);
    }
  } catch (e) {
    log('❌ ' + e.message, 'err');
    console.error(e);
  } finally {
    btn.disabled = false;
  }
});

// ─── Premiere flow ────────────────────────────────────────────────────────────

async function runPremiereFlow(pipeline) {
  const { analyzerResult, camerasForAnalyzer } = pipeline;

  // Deduplicate by camera index — tandem cameras expand to multiple entries
  // in camerasForAnalyzer but map to the same video track in Premiere.
  const uniqueCamIndices = [...new Map(camerasForAnalyzer.map(c => [c.index, c])).values()];
  const applyPayload = {
    cameras: uniqueCamIndices.map(cam => ({
      index:      cam.index,
      videoTrack: cam.index - 1,
    })),
    cuts: analyzerResult.cuts,
  };

  const progressBar = document.getElementById('progress-bar');

  log(`Cutting timeline at ${analyzerResult.cuts.length} boundaries…`);
  progressBar.classList.add('active');
  let razorResult;
  try {
    razorResult = await callHost('applyRazorCuts', JSON.stringify(applyPayload));
  } finally {
    progressBar.classList.remove('active');
  }

  const razorMsg = `Razored ${razorResult.razorOk} cuts across ${razorResult.tracks} tracks`
    + (razorResult.razorFail ? ` (${razorResult.razorFail} skipped)` : '');
  log(razorMsg, 'ok');
  if (razorResult.diag !== 'ok') log(`Razor diag: ${razorResult.diag}`, 'info');

  log('Enabling/disabling segments…');
  const disableResult = await callHost('applyDisableCuts');
  log(`Done! ${disableResult.applied} segments enabled`, 'ok');
  if (disableResult.diag !== 'ok') log(`Diag: ${disableResult.diag}`, 'info');

  // Punch-in zoom — Premiere only
  const zoomPct = parseFloat(document.getElementById('setting-zoom-pct').value) || 0;
  if (zoomPct > 0) {
    log(`Applying ${zoomPct}% punch-in zoom…`);
    try {
      const zoomResult = await callHost('applyZoom', JSON.stringify({ zoom_pct: zoomPct }));
      log(`Zoom applied to ${zoomResult.applied} clip(s) (scale ${zoomResult.scale}%)`, 'ok');
    } catch (ze) {
      log(`⚠️ Zoom: ${ze.message}`, 'info');
    }
  }

  await addChapterMarkersIfNeeded(pipeline);
}

// ─── XML flow ─────────────────────────────────────────────────────────────────

async function runXMLFlow(pipeline) {
  const { analyzerResult, camerasForAnalyzer, speakersForAnalyzer, seqInfo } = pipeline;

  const silenceRemovals = analyzerResult.silence_removals || [];
  if (silenceRemovals.length > 0) {
    const totalRemoved = silenceRemovals.reduce((s, r) => s + (r.end - r.start), 0);
    log(`Silence removal: ${silenceRemovals.length} gap(s), ${totalRemoved.toFixed(1)}s removed`, 'ok');
  }

  log('Reading video track clips…');
  const videoTrackIndices = Array.from({ length: state.cameraCount }, (_, i) => i);
  const videoTrackClips   = await callHost('getVideoTrackClips', JSON.stringify(videoTrackIndices));

  // Deduplicate cameras by index before XML generation
  const uniqueCamsForXML = [...new Map(camerasForAnalyzer.map(c => [c.index, c])).values()];

  log('Generating FCP7 XML…');
  const xml = generateFCP7XML(
    analyzerResult.cuts,
    uniqueCamsForXML,
    videoTrackClips,
    seqInfo.fps || 25,
    analyzerResult.duration,
    seqInfo.name,
    speakersForAnalyzer,
    silenceRemovals,
    seqInfo.width  || 1920,
    seqInfo.height || 1080,
  );

  const xmlPath = path.join(os.tmpdir(), 'openpodcut_edit_' + Date.now() + '.xml');
  fs.writeFileSync(xmlPath, xml, 'utf8');

  log('Importing XML into Premiere…');
  const importResult = await callHost('importXMLSequence', JSON.stringify(xmlPath));
  try { fs.unlinkSync(xmlPath); } catch (_) {}

  log(`✅ New sequence ready: "${importResult.name}"`, 'ok');

  await addChapterMarkersIfNeeded(pipeline);
}

// ─── Chapter markers (shared by both flows) ───────────────────────────────────

async function addChapterMarkersIfNeeded(pipeline) {
  const chapterDebug  = pipeline.analyzerResult.chapter_debug  || '';
  const chapterPoints = pipeline.analyzerResult.chapter_points || [];
  if (chapterDebug) log(`Chapter dbg: ${chapterDebug}`, 'info');
  if (chapterPoints.length > 0) {
    log(`Adding ${chapterPoints.length} chapter marker(s): ${chapterPoints.map(p => p.time.toFixed(1) + 's').join(', ')}`);
    try {
      const markResult = await callHost('addChapterMarkers', JSON.stringify(chapterPoints));
      log(`Chapter markers: ${markResult.added} added | diag: ${markResult.diag}`,
        markResult.added > 0 ? 'ok' : 'info');
    } catch (me) {
      log(`⚠️ Chapter markers: ${me.message}`, 'err');
    }
  } else {
    log('Chapter markers: no qualifying host segments found', 'info');
  }
}

// ─── FCP7 XML generator ───────────────────────────────────────────────────────
//
// Generates a Final Cut Pro 7 XML (xmeml v4) that Premiere Pro can import.
// Produces one video track per camera — every cut appears on every track,
// with <enabled>TRUE</enabled> on the active camera and FALSE on the rest.

function generateFCP7XML(cuts, cameras, videoTrackClips, fps, duration, seqName, speakers, silenceRemovals, width, height) {
  width  = width  || 1920;
  height = height || 1080;
  const isNTSC        = Math.abs(fps - Math.round(fps)) > 0.02;
  const timebase      = Math.round(fps);
  const ntsc          = isNTSC ? 'TRUE' : 'FALSE';
  const toFr          = s => Math.round(s * timebase);
  const ticksPerFrame = Math.round(254016000000 / timebase);
  const toTicks       = fr => fr * ticksPerFrame;

  // Silence-removal time remapping
  const removals = (silenceRemovals || []).slice().sort((a, b) => a.start - b.start);

  function remap(t) {
    let removed = 0;
    for (const r of removals) {
      if (t <= r.start) break;
      removed += Math.min(t, r.end) - r.start;
    }
    return t - removed;
  }

  function splitByRemovals(seqStart, seqEnd) {
    if (removals.length === 0) return [{ srcStart: seqStart, srcEnd: seqEnd }];
    const segments = [];
    let cur = seqStart;
    for (const r of removals) {
      if (r.start >= seqEnd) break;
      if (r.end   <= seqStart) continue;
      const trimStart = Math.max(r.start, seqStart);
      if (trimStart > cur) segments.push({ srcStart: cur, srcEnd: trimStart });
      cur = Math.min(Math.max(r.end, seqStart), seqEnd);
    }
    if (cur < seqEnd) segments.push({ srcStart: cur, srcEnd: seqEnd });
    return segments.filter(s => s.srcEnd > s.srcStart);
  }

  const durationFr = toFr(remap(duration));

  const esc = s => String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');

  const toFileUrl = p => 'file://localhost/' +
    p.replace(/\\/g, '/').split('/').map(seg => encodeURIComponent(seg)).join('/');

  const rateXML = `<rate><timebase>${timebase}</timebase><ntsc>${ntsc}</ntsc></rate>`;

  const uuid = () => 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
    const r = Math.random() * 16 | 0;
    return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
  });

  const PPRO_LABELS = [
    '', 'Violet', 'Iris', 'Carribean', 'Lavender', 'Cerulean',
    'Forest', 'Rose', 'Mango', 'Purple', 'Blue', 'Teal',
    'Magenta', 'Tan', 'Green', 'Brown',
  ];
  const labelEl = idx => (idx > 0 && PPRO_LABELS[idx])
    ? `<labels><label2>${PPRO_LABELS[idx]}</label2></labels>`
    : '';

  // File registry
  const fileReg = new Map();
  let nextFileId = 1, nextClipId = 1, nextMasterClipId = 1;

  function getFile(clipPath, durSec) {
    if (!fileReg.has(clipPath)) {
      const fname     = clipPath.replace(/\\/g, '/').split('/').pop();
      const audioOnly = /\.(wav|mp3|aac|m4a|flac|ogg|aif|aiff)$/i.test(fname);
      fileReg.set(clipPath, {
        id:           `file-${nextFileId++}`,
        masterClipId: `masterclip-${nextMasterClipId++}`,
        name:         fname,
        url:          toFileUrl(clipPath),
        durFr:        toFr(durSec),
        audioOnly,
        defined:      false,
      });
    }
    return fileReg.get(clipPath);
  }

  function fileEl(fi) {
    if (fi.defined) return `<file id="${fi.id}"/>`;
    fi.defined = true;
    const mediaInner = fi.audioOnly
      ? `<audio>
                      <samplecharacteristics>
                        <depth>16</depth>
                        <samplerate>48000</samplerate>
                      </samplecharacteristics>
                      <channelcount>1</channelcount>
                    </audio>`
      : `<video>
                      <samplecharacteristics>
                        ${rateXML}
                        <width>${width}</width>
                        <height>${height}</height>
                        <anamorphic>FALSE</anamorphic>
                        <pixelaspectratio>square</pixelaspectratio>
                        <fielddominance>none</fielddominance>
                      </samplecharacteristics>
                    </video>
                    <audio>
                      <samplecharacteristics>
                        <depth>16</depth>
                        <samplerate>48000</samplerate>
                      </samplecharacteristics>
                      <channelcount>2</channelcount>
                    </audio>`;
    return `<file id="${fi.id}">
                  <name>${esc(fi.name)}</name>
                  <pathurl>${esc(fi.url)}</pathurl>
                  ${rateXML}
                  <duration>${fi.durFr}</duration>
                  <timecode>
                    ${rateXML}
                    <string>00:00:00:00</string>
                    <frame>0</frame>
                    <displayformat>NDF</displayformat>
                  </timecode>
                  <media>
                    ${mediaInner}
                  </media>
                </file>`;
  }

  // Track lookup
  const camToTrackIdx = {};
  for (const cam of cameras) camToTrackIdx[cam.index] = cam.index - 1;

  const trackClipsMap = {};
  for (const tc of videoTrackClips) trackClipsMap[tc.index] = tc.clips || [];

  function sourceClipAt(trackIdx, seqTime) {
    const clips = trackClipsMap[trackIdx] || [];
    for (const c of clips) {
      if (seqTime >= c.seqStart - 0.01 && seqTime < c.seqEnd + 0.01) return c;
    }
    return clips[clips.length - 1] || null;
  }

  // Pre-register all files
  for (const cam of cameras) {
    for (const src of (trackClipsMap[camToTrackIdx[cam.index]] || []))
      getFile(src.path, src.mediaEnd);
  }
  for (const spk of (speakers || [])) {
    for (const clip of (spk.clips || []))
      getFile(clip.path, clip.media_end);
  }

  // Video tracks
  const videoTracksXML = cameras.map(cam => {
    const trackIdx = camToTrackIdx[cam.index];
    const targeted = cam.index === 1 ? '1' : '0';

    const clipItems = cuts.flatMap(cut => {
      const src = sourceClipAt(trackIdx, cut.start);
      if (!src) return [];

      const fi       = getFile(src.path, src.mediaEnd);
      const isActive = cut.camera === cam.index;

      return splitByRemovals(cut.start, cut.end).map(seg => {
        const seqStartFr  = toFr(remap(seg.srcStart));
        const seqEndFr    = toFr(remap(seg.srcEnd));
        if (seqEndFr <= seqStartFr) return '';

        const mediaInSec  = src.mediaStart + (seg.srcStart - src.seqStart);
        const mediaOutSec = src.mediaStart + (seg.srcEnd   - src.seqStart);
        const mediaInFr   = toFr(mediaInSec);
        const mediaOutFr  = toFr(mediaOutSec);
        const id          = `clipitem-${nextClipId++}`;

        return `
              <clipitem id="${id}">
                <masterclipid>${fi.masterClipId}</masterclipid>
                <name>${esc(fi.name)}</name>
                <enabled>${isActive ? 'TRUE' : 'FALSE'}</enabled>
                <duration>${fi.durFr}</duration>
                ${rateXML}
                <start>${seqStartFr}</start>
                <end>${seqEndFr}</end>
                <in>${mediaInFr}</in>
                <out>${mediaOutFr}</out>
                <pproTicksIn>${toTicks(mediaInFr)}</pproTicksIn>
                <pproTicksOut>${toTicks(mediaOutFr)}</pproTicksOut>
                <alphatype>none</alphatype>
                <pixelaspectratio>square</pixelaspectratio>
                <anamorphic>FALSE</anamorphic>
                ${fileEl(fi)}
              </clipitem>`;
      });
    }).join('');

    return `
        <track TL.SQTrackShy="0" TL.SQTrackExpandedHeight="25" TL.SQTrackExpanded="0" MZ.TrackTargeted="${targeted}">
          ${clipItems}
          <enabled>TRUE</enabled>
          <locked>FALSE</locked>
        </track>`;
  }).join('');

  // Audio tracks
  const audioTracksXML = (speakers || []).map((spk, i) => {
    const outputCh = (i % 2) + 1;

    const clipItems = (spk.clips || []).flatMap(clip => {
      const fi = getFile(clip.path, clip.media_end);

      return splitByRemovals(clip.seq_start, clip.seq_end).map(seg => {
        const seqStartFr = toFr(remap(seg.srcStart));
        const seqEndFr   = toFr(remap(seg.srcEnd));
        if (seqEndFr <= seqStartFr) return '';

        const mediaInSec  = clip.media_start + (seg.srcStart - clip.seq_start);
        const mediaOutSec = clip.media_start + (seg.srcEnd   - clip.seq_start);
        const mediaInFr   = toFr(mediaInSec);
        const mediaOutFr  = toFr(mediaOutSec);
        const id          = `clipitem-${nextClipId++}`;

        return `
              <clipitem id="${id}" premiereChannelType="mono">
                <masterclipid>${fi.masterClipId}</masterclipid>
                <name>${esc(fi.name)}</name>
                <enabled>TRUE</enabled>
                <duration>${fi.durFr}</duration>
                ${rateXML}
                <start>${seqStartFr}</start>
                <end>${seqEndFr}</end>
                <in>${mediaInFr}</in>
                <out>${mediaOutFr}</out>
                <pproTicksIn>${toTicks(mediaInFr)}</pproTicksIn>
                <pproTicksOut>${toTicks(mediaOutFr)}</pproTicksOut>
                ${fileEl(fi)}
                <sourcetrack>
                  <mediatype>audio</mediatype>
                  <trackindex>1</trackindex>
                </sourcetrack>
                ${labelEl(clip.label || 0)}
              </clipitem>`;
      });
    }).join('');

    return `
        <track TL.SQTrackAudioKeyframeStyle="0" TL.SQTrackShy="0" TL.SQTrackExpandedHeight="25" TL.SQTrackExpanded="0" MZ.TrackTargeted="1" PannerCurrentValue="0.5" PannerStartKeyframe="-91445760000000000,0.5,0,0,0,0,0,0" PannerName="Balance" currentExplodedTrackIndex="0" totalExplodedTrackCount="1" premiereTrackType="Stereo">
          ${clipItems}
          <enabled>TRUE</enabled>
          <locked>FALSE</locked>
          <outputchannelindex>${outputCh}</outputchannelindex>
        </track>`;
  }).join('');

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE xmeml>
<xmeml version="4">
  <sequence id="sequence-1" TL.SQAudioVisibleBase="0" TL.SQVideoVisibleBase="0" TL.SQVisibleBaseTime="0" TL.SQAVDividerPosition="0.5" TL.SQHideShyTracks="0" TL.SQHeaderWidth="236" MZ.Sequence.PreviewFrameSizeHeight="1080" MZ.Sequence.PreviewFrameSizeWidth="1920" MZ.Sequence.AudioTimeDisplayFormat="200" MZ.Sequence.VideoTimeDisplayFormat="101" MZ.WorkOutPoint="${toTicks(durationFr)}" MZ.WorkInPoint="0" MZ.ZeroPoint="0" explodedTracks="true">
    <uuid>${uuid()}</uuid>
    <duration>${durationFr}</duration>
    ${rateXML}
    <name>${esc(seqName + ' [Cut]')}</name>
    <media>
      <video>
        <format>
          <samplecharacteristics>
            ${rateXML}
            <width>${width}</width>
            <height>${height}</height>
            <anamorphic>FALSE</anamorphic>
            <pixelaspectratio>square</pixelaspectratio>
            <fielddominance>none</fielddominance>
            <colordepth>24</colordepth>
          </samplecharacteristics>
        </format>
        ${videoTracksXML}
      </video>
      <audio>
        <numOutputChannels>2</numOutputChannels>
        <format>
          <samplecharacteristics>
            <depth>16</depth>
            <samplerate>48000</samplerate>
          </samplecharacteristics>
        </format>
        <outputs>
          <group>
            <index>1</index>
            <numchannels>1</numchannels>
            <downmix>0</downmix>
            <channel><index>1</index></channel>
          </group>
          <group>
            <index>2</index>
            <numchannels>1</numchannels>
            <downmix>0</downmix>
            <channel><index>2</index></channel>
          </group>
        </outputs>
        ${audioTracksXML}
      </audio>
    </media>
    <timecode>
      ${rateXML}
      <string>00:00:00:00</string>
      <frame>0</frame>
      <displayformat>NDF</displayformat>
    </timecode>
  </sequence>
</xmeml>`;
}


// ─── Shared analysis pipeline ─────────────────────────────────────────────────
//
// Runs backup → validation → clip reads → analyzer.exe.
// Returns { analyzerResult, speakersForAnalyzer, camerasForAnalyzer, seqInfo }.

async function runAnalysisPipeline(logFn) {
  // Backup
  logFn('Creating backup sequence...');
  try {
    const backup = await callHost('createBackupSequence');
    logFn(`Backup: "${backup.name}"`, 'ok');
  } catch (e) {
    logFn(`⚠️ Backup skipped: ${e.message}`, 'info');
  }

  // Sequence info
  logFn('Reading sequence info...');
  const seqInfo = await callHost('getSequenceInfo');
  logFn(`Sequence: "${seqInfo.name}", ${(seqInfo.duration || 0).toFixed(1)}s`, 'info');

  // Track sync validation
  const sync = await callHost('validateTrackSync');
  if (!sync.valid) {
    sync.warnings.forEach(w => logFn('⚠️ ' + w, 'err'));
    logFn('⚠️ Cuts may be misaligned. Move all clips to start at 00:00:00 before continuing.', 'err');
    const proceed = window.confirm(
      'Track alignment warning:\n\n' +
      sync.warnings.join('\n') +
      '\n\nCuts may be misaligned if tracks do not start at 00:00:00.\n\nContinue anyway?'
    );
    if (!proceed) { logFn('Cancelled.', 'info'); return null; }
    logFn('Continuing despite alignment warnings…', 'info');
  }

  // Collect speaker→track mappings
  const speakerTrackIndices = [];
  const speakerConfigs      = [];
  for (let i = 0; i < state.speakerCount; i++) {
    const id         = SPEAKER_IDS[i];
    const sel        = document.getElementById(`speaker-track-${id}`);
    const trackIndex = parseInt(sel.value, 10);
    speakerTrackIndices.push(trackIndex);
    speakerConfigs.push({ id, trackIndex });
  }

  // Get audio clip timing
  logFn('Reading clip timing from Premiere...');
  const trackClips = await callHost('getAudioTrackClips', JSON.stringify(speakerTrackIndices));

  const speakersForAnalyzer = [];
  for (const spkCfg of speakerConfigs) {
    const trackInfo = trackClips.find(t => t.index === spkCfg.trackIndex);
    if (!trackInfo || !trackInfo.clips || trackInfo.clips.length === 0) {
      throw new Error(
        `No media clips found on audio track A${spkCfg.trackIndex + 1} ` +
        `(${speakerLabel(SPEAKER_IDS.indexOf(spkCfg.id))}). ` +
        `Make sure the track has a clip with linked media.`
      );
    }
    const spkName  = speakerLabel(SPEAKER_IDS.indexOf(spkCfg.id));
    const totalSec = trackInfo.clips.reduce((s, c) => s + (c.seqEnd - c.seqStart), 0);
    const labelVals = trackInfo.clips.map(c => c.label || 0);
    const labelStr  = labelVals.every(v => v === 0) ? 'no color' : 'labels=' + labelVals.join(',');
    logFn(`${spkName} → ${trackInfo.clips.length} clip(s), ${totalSec.toFixed(1)}s [${labelStr}]`, 'info');

    speakersForAnalyzer.push({
      id: spkCfg.id,
      clips: trackInfo.clips.map(c => ({
        path:        c.path,
        seq_start:   c.seqStart,
        seq_end:     c.seqEnd,
        media_start: c.mediaStart,
        media_end:   c.mediaEnd,
        label:       c.label || 0,
      })),
    });
  }

  // Build camera config — tandem selections expand into one entry per speaker
  const camerasForAnalyzer = [];
  for (let c = 1; c <= state.cameraCount; c++) {
    const sel = document.getElementById(`camera-speaker-${c}`);
    const val = sel.value;
    if (val === 'wide') {
      camerasForAnalyzer.push({ index: c, speaker: null });
    } else if (val.includes('+')) {
      for (const spkId of val.split('+')) {
        camerasForAnalyzer.push({ index: c, speaker: spkId });
      }
    } else {
      camerasForAnalyzer.push({ index: c, speaker: val });
    }
  }

  // Write config JSON
  // Silence removal only active in XML mode — Premiere mode can't ripple-delete
  const silenceActive = state.outputMode === 'xml' && silenceCheckbox.checked;

  const analyzerConfig = {
    speakers: speakersForAnalyzer,
    cameras:  camerasForAnalyzer,
    settings: {
      min_shot_sec:       parseFloat(document.getElementById('setting-min-shot').value),
      max_shot_sec:       maxShotCheckbox.checked ? parseFloat(maxShotInput.value) : 0,
      wide_frequency:     parseInt(wideRange.value, 10) / 100,
      min_phrase_sec:     parseFloat(document.getElementById('setting-min-phrase').value),
      cut_delay_sec:      parseFloat(document.getElementById('setting-cut-delay').value)
                        - parseFloat(document.getElementById('setting-jcut').value),
      vad_threshold:      0.45,
      min_silence_sec:    silenceActive ? parseFloat(silenceInput.value) : 0,
      dominance_db:       getDominanceDb(),
      snap_zero_crossing: document.getElementById('setting-snap-enabled').checked,
      host_speaker_id:    state.hostSpeakerId,
      chapter_min_sec:    parseFloat(document.getElementById('setting-chapter-sec').value),
      zoom_pct:           parseFloat(document.getElementById('setting-zoom-pct').value),
    },
  };

  const configPath = path.join(os.tmpdir(), 'podcast_cutter_config.json');
  fs.writeFileSync(configPath, JSON.stringify(analyzerConfig, null, 2), 'utf8');
  logFn('Config written, starting analysis...', 'info');

  if (!fs.existsSync(ANALYZER_EXE)) {
    throw new Error(
      `Analyzer binary not found at: ${ANALYZER_EXE}\n` +
      (isWin ? 'Build it first with analyzer/build.bat'
              : 'Download the macOS release zip from GitHub releases.')
    );
  }

  logFn('⏳ Analyzing audio (this may take a moment)...');
  const analyzerResult = await runAnalyzer(configPath);
  logFn(`Analysis done — ${analyzerResult.cuts.length} cuts generated`, 'ok');

  return { analyzerResult, speakersForAnalyzer, camerasForAnalyzer, seqInfo };
}


// ─── Run analyzer.exe ─────────────────────────────────────────────────────────

function runAnalyzer(configPath) {
  return new Promise((resolve, reject) => {
    const proc = execFile(ANALYZER_EXE, [configPath], { timeout: 600000 });

    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', d => { stdout += d; });
    proc.stderr.on('data', d => {
      stderr += d;
      d.toString().split('\n').filter(Boolean).forEach(line => {
        log('  ' + line.trim());
      });
    });

    proc.on('close', (code) => {
      try {
        const result = JSON.parse(stdout.trim());
        if (result.status === 'ok') resolve(result);
        else reject(new Error(result.message + (result.detail ? '\n' + result.detail : '')));
      } catch (e) {
        reject(new Error(`analyzer.exe failed (exit ${code}):\n${stderr || stdout}`));
      }
    });

    proc.on('error', (e) => reject(new Error('Failed to start analyzer binary: ' + e.message)));
  });
}

// ─── Init ─────────────────────────────────────────────────────────────────────

// Load host script — read via Node.js fs to avoid $.evalFile path issues
// (spaces in "Application Support" on macOS can silently break $.evalFile)
try {
  const hostCode = fs.readFileSync(path.join(EXTENSION_ROOT, 'host', 'host.jsx'), 'utf8');
  csInterface.evalScript(hostCode, (result) => {
    if (result === 'EvalScript error.') {
      log('⚠️ Host script failed to evaluate — check Premiere version compatibility', 'err');
    }
  });
} catch (e) {
  log('⚠️ Could not load host script: ' + e.message, 'err');
}

// Initial render
renderSpeakerRows();
renderCameraRows();
updateModeState();

// Auto-load tracks
callHost('getAudioTrackList')
  .then(tracks => {
    state.audioTracks = tracks;
    renderSpeakerRows();
    if (tracks.length > 0) {
      log(`Loaded ${tracks.length} audio tracks`, 'ok');
    }
  })
  .catch(() => {
    // Sequence might not be open yet — that's fine
  });
