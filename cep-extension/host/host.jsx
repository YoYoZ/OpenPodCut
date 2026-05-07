/**
 * host.jsx — ExtendScript, runs inside Premiere Pro (OpenPodCut)
 *
 * Exposed functions called from Node.js via CSInterface:
 *   createBackupSequence()            → JSON string: {name}
 *   getAudioTrackList()               → JSON string: [{index, name}, ...]
 *   getAudioTrackClips(indices)       → JSON string: [{index, name, clips[]}, ...]
 *   getSequenceInfo()                 → JSON string: {duration, fps, name}
 *   applyRazorCuts(cutsJson)          → JSON string: {razorOk, razorFail, ...}
 *   applyDisableCuts()                → JSON string: {applied, diag}
 */


// ─────────────────────────────────────────────────────────────────────────────
// Utilities
// ─────────────────────────────────────────────────────────────────────────────

function ok(data) {
    return JSON.stringify({ status: "ok", data: data });
}

function fail(msg) {
    return JSON.stringify({ status: "error", message: msg });
}

function getActiveSequence() {
    if (!app.project || !app.project.activeSequence) {
        throw new Error("No active sequence. Open a multicam sequence in Premiere first.");
    }
    return app.project.activeSequence;
}


// ─────────────────────────────────────────────────────────────────────────────
// createBackupSequence
// Duplicates the active sequence so the user can undo the entire cut operation
// by activating the backup.  Returns {name} of the created sequence.
// ─────────────────────────────────────────────────────────────────────────────

function createBackupSequence() {
    try {
        var seq = app.project.activeSequence;
        if (!seq) return fail('No active sequence.');

        // Remember the original so we can restore it — clone() activates the copy.
        var originalID = seq.sequenceID;

        var now = new Date();
        var pad = function(n) { return n < 10 ? '0' + n : String(n); };
        var timestamp = pad(now.getHours()) + ':' + pad(now.getMinutes()) + ':' + pad(now.getSeconds());
        var backupName = seq.name + ' [OpenPodCut backup ' + timestamp + ']';

        // Premiere Pro 14+ exposes Sequence.clone()
        if (typeof seq.clone !== 'function') {
            return fail('Sequence.clone() not available in this version of Premiere Pro.');
        }

        // Premiere names the clone "<original> Copy" automatically.
        var autoName = seq.name + ' Copy';

        var backup = seq.clone();
        if (!backup) return fail('Sequence.clone() returned null.');

        // Walk the project tree to find the freshly created item by its
        // auto-generated name and rename it there — the only path that is
        // reliably writable in Premiere's ExtendScript API.
        var renamed = false;
        function searchAndRename(bin) {
            if (renamed) return;
            for (var i = 0; i < bin.children.numItems; i++) {
                var item = bin.children[i];
                if (item.name === autoName) {
                    item.name = backupName;
                    renamed = true;
                    return;
                }
                try { if (item.children) searchAndRename(item); } catch (e) {}
            }
        }
        searchAndRename(app.project.rootItem);

        // Restore the original sequence as active (clone() may have changed it).
        for (var s = 0; s < app.project.sequences.numSequences; s++) {
            if (app.project.sequences[s].sequenceID === originalID) {
                app.project.activeSequence = app.project.sequences[s];
                break;
            }
        }

        return ok({ name: renamed ? backupName : autoName });
    } catch (e) {
        return fail('Backup failed: ' + e.message);
    }
}


// ─────────────────────────────────────────────────────────────────────────────
// validateTrackSync
//
// Checks that every non-empty audio and video track begins at 00:00:00.
// If any track's first clip starts later than EPSILON seconds into the
// sequence, audio VAD timestamps and video cut positions will be misaligned.
//
// Returns { valid: bool, warnings: [string] }
// ─────────────────────────────────────────────────────────────────────────────

function validateTrackSync() {
    try {
        var seq      = getActiveSequence();
        var TICKS    = 254016000000;
        var EPSILON  = 0.1;   // seconds — allow sub-frame rounding noise
        var warnings = [];

        for (var vi = 0; vi < seq.videoTracks.numTracks; vi++) {
            var vt = seq.videoTracks[vi];
            if (vt.clips.numItems === 0) continue;
            var vStart = parseFloat(vt.clips[0].start.ticks) / TICKS;
            if (vStart > EPSILON) {
                warnings.push(
                    'Video track V' + (vi + 1) + ' starts at ' +
                    vStart.toFixed(2) + 's — expected 00:00:00'
                );
            }
        }

        for (var ai = 0; ai < seq.audioTracks.numTracks; ai++) {
            var at = seq.audioTracks[ai];
            if (at.clips.numItems === 0) continue;
            var aStart = parseFloat(at.clips[0].start.ticks) / TICKS;
            if (aStart > EPSILON) {
                warnings.push(
                    'Audio track A' + (ai + 1) + ' starts at ' +
                    aStart.toFixed(2) + 's — expected 00:00:00'
                );
            }
        }

        return ok({ valid: warnings.length === 0, warnings: warnings });
    } catch (e) {
        return fail(e.message);
    }
}


// ─────────────────────────────────────────────────────────────────────────────
// getAudioTrackList
// Returns all audio tracks in the active sequence with their names.
// ─────────────────────────────────────────────────────────────────────────────

function getAudioTrackList() {
    try {
        var seq = getActiveSequence();
        var tracks = [];

        for (var i = 0; i < seq.audioTracks.numTracks; i++) {
            var track = seq.audioTracks[i];
            // Skip tracks that have no clips — Premiere always reserves extra empty slots
            if (track.clips.numItems === 0) continue;
            var name = track.name || ("Audio " + (i + 1));
            tracks.push({ index: i, name: name });
        }

        return ok(tracks);
    } catch (e) {
        return fail(e.message);
    }
}


// ─────────────────────────────────────────────────────────────────────────────
// getAudioTrackClips
// Returns full timing data for every clip on each requested track.
// trackIndices: JSON array of 0-based track indices, e.g. [0, 1, 2]
//
// Each clip entry:
//   path       — source media file path
//   seqStart   — clip start position in the sequence (seconds)
//   seqEnd     — clip end position in the sequence (seconds)
//   mediaStart — in-point in the source media (seconds from file start)
//   mediaEnd   — out-point in the source media (seconds from file start)
//
// Python uses (mediaStart, mediaEnd) to seek into the source file,
// and (seqStart) to map VAD timestamps back to sequence time.
// ─────────────────────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────────────────────
// _tryReadLabel
// Tries every known API to read a Premiere label index (0-15) from a
// ProjectItem.  Returns the first non-zero result, or 0 if nothing works.
// ─────────────────────────────────────────────────────────────────────────────

function _tryReadLabel(pi) {
    // M1: standard .label property
    try {
        var v = pi.label;
        var n = parseInt(v, 10);
        if (!isNaN(n) && n > 0) return n;
    } catch (e) {}

    // M2: .colorLabel property (alternate name in some versions)
    try {
        var v = pi.colorLabel;
        var n = parseInt(v, 10);
        if (!isNaN(n) && n > 0) return n;
    } catch (e) {}

    // M3: getColorLabel() method
    try {
        if (typeof pi.getColorLabel === 'function') {
            var n = parseInt(pi.getColorLabel(), 10);
            if (!isNaN(n) && n > 0) return n;
        }
    } catch (e) {}

    // M4: XMP metadata — Premiere writes xmp:Label for named colours
    try {
        var meta = pi.metadata;
        if (meta && typeof meta.serialize === 'function') {
            var xml = meta.serialize();
            var m = xml.match(/<xmp:Label>([^<]+)<\/xmp:Label>/i)
                 || xml.match(/xmp:Label="([^"]+)"/i);
            if (m) {
                var XL = {
                    'violet':1,'iris':2,'carribean':3,'caribbean':3,
                    'lavender':4,'cerulean':5,'forest':6,'rose':7,
                    'mango':8,'purple':9,'blue':10,'teal':11,
                    'magenta':12,'tan':13,'green':14,'brown':15,
                    'red':7,'yellow':8,'orange':8
                };
                var lbl = XL[m[1].toLowerCase().trim()];
                if (lbl !== undefined) return lbl;
            }
        }
    } catch (e) {}

    // M5: walk project bin to find the matching item and try its .label there
    //     (sequence clip wrappers sometimes behave differently from bin items)
    try {
        var targetPath = pi.getMediaPath().replace(/\\/g, '/').toLowerCase();
        var found = 0;
        function _walkBin(item) {
            if (found) return;
            try {
                var mp = item.getMediaPath();
                if (mp && mp.replace(/\\/g, '/').toLowerCase() === targetPath) {
                    var n = parseInt(item.label, 10);
                    if (!isNaN(n) && n > 0) { found = n; return; }
                }
            } catch (e) {}
            try {
                if (item.children) {
                    for (var i = 0; i < item.children.numItems; i++) {
                        _walkBin(item.children[i]);
                    }
                }
            } catch (e) {}
        }
        _walkBin(app.project.rootItem);
        if (found) return found;
    } catch (e) {}

    return 0;
}


function getAudioTrackClips(trackIndicesJson) {
    try {
        var seq = getActiveSequence();
        var trackIndices = JSON.parse(trackIndicesJson);
        var TICKS = 254016000000;
        var result = [];

        for (var t = 0; t < trackIndices.length; t++) {
            var idx = trackIndices[t];
            var track = seq.audioTracks[idx];

            if (!track) {
                return fail("Audio track " + idx + " does not exist");
            }

            var clips = [];
            for (var c = 0; c < track.clips.numItems; c++) {
                var clip = track.clips[c];
                try {
                    var mediaPath = clip.projectItem.getMediaPath();
                    if (!mediaPath) continue;

                    // Try TrackItem.label first — this captures colours set
                    // directly on the timeline clip (right-click → Label).
                    // Fall back to projectItem methods for project-panel colours.
                    var aLabelVal = 0;
                    try {
                        var tv = clip.label;
                        var tn = parseInt(tv, 10);
                        if (!isNaN(tn) && tn > 0) aLabelVal = tn;
                    } catch (e) {}
                    if (!aLabelVal) aLabelVal = _tryReadLabel(clip.projectItem);

                    clips.push({
                        path:       mediaPath,
                        seqStart:   parseFloat(clip.start.ticks)    / TICKS,
                        seqEnd:     parseFloat(clip.end.ticks)      / TICKS,
                        mediaStart: parseFloat(clip.inPoint.ticks)  / TICKS,
                        mediaEnd:   parseFloat(clip.outPoint.ticks) / TICKS,
                        label:      aLabelVal
                    });
                } catch (clipErr) {
                    continue;  // colour mattes, titles, etc.
                }
            }

            result.push({
                index: idx,
                name:  track.name || ("Audio " + (idx + 1)),
                clips: clips
            });
        }

        return ok(result);
    } catch (e) {
        return fail(e.message);
    }
}


// ─────────────────────────────────────────────────────────────────────────────
// getVideoTrackClips
// Same structure as getAudioTrackClips but reads video tracks.
// Used by the XML export path to get source file paths and in/out points
// for each camera's video clips.
// ─────────────────────────────────────────────────────────────────────────────

function getVideoTrackClips(trackIndicesJson) {
    try {
        var seq          = getActiveSequence();
        var trackIndices = JSON.parse(trackIndicesJson);
        var TICKS        = 254016000000;
        var result       = [];

        for (var t = 0; t < trackIndices.length; t++) {
            var idx   = trackIndices[t];
            var track = seq.videoTracks[idx];
            if (!track) continue;

            var clips = [];
            for (var c = 0; c < track.clips.numItems; c++) {
                var clip = track.clips[c];
                try {
                    var mediaPath = clip.projectItem.getMediaPath();
                    if (!mediaPath) continue;
                    // label may be undefined in some Premiere versions — keep it a safe integer
                    var labelVal = 0;
                    var labelDbg = 'n/a';
                    try {
                        var rawLabel = clip.projectItem.label;
                        labelDbg = typeof rawLabel + ':' + String(rawLabel);
                        var parsed = parseInt(rawLabel, 10);
                        if (!isNaN(parsed)) labelVal = parsed;
                    } catch (le) { labelDbg = 'throw:' + le.message; }
                    clips.push({
                        path:       mediaPath,
                        seqStart:   parseFloat(clip.start.ticks)    / TICKS,
                        seqEnd:     parseFloat(clip.end.ticks)      / TICKS,
                        mediaStart: parseFloat(clip.inPoint.ticks)  / TICKS,
                        mediaEnd:   parseFloat(clip.outPoint.ticks) / TICKS,
                        label:      labelVal,
                        labelDbg:   labelDbg
                    });
                } catch (clipErr) {
                    continue;  // colour mattes, titles, generated media, etc.
                }
            }

            result.push({ index: idx, clips: clips });
        }

        return ok(result);
    } catch (e) {
        return fail(e.message);
    }
}


// ─────────────────────────────────────────────────────────────────────────────
// importXMLSequence
// Imports an FCP7 XML file into the project and returns the name of the
// imported sequence so main.js can log it.
// ─────────────────────────────────────────────────────────────────────────────

function importXMLSequence(xmlPathJson) {
    try {
        var xmlPath = JSON.parse(xmlPathJson);

        // Record existing sequence IDs so we can identify the new one
        var before = {};
        for (var i = 0; i < app.project.sequences.numSequences; i++) {
            before[app.project.sequences[i].sequenceID] = true;
        }

        app.project.importFiles([xmlPath], true, app.project.rootItem, false);

        // Find and open the newly imported sequence
        var newSeq = null;
        for (var j = 0; j < app.project.sequences.numSequences; j++) {
            var s = app.project.sequences[j];
            if (!before[s.sequenceID]) { newSeq = s; break; }
        }

        if (newSeq) {
            app.project.activeSequence = newSeq;
            return ok({ name: newSeq.name });
        }
        return ok({ name: '(imported)' });
    } catch (e) {
        return fail('XML import failed: ' + e.message);
    }
}


// ─────────────────────────────────────────────────────────────────────────────
// applyClipLabels
// After an XML import, restores the original label colours to clips in the
// active sequence by matching source file paths to a {path: labelInt} map.
// Sets projectItem.label once per unique source file (all clips sharing the
// same source automatically inherit the colour).
// ─────────────────────────────────────────────────────────────────────────────

function applyClipLabels(labelsJson) {
    try {
        var seq    = getActiveSequence();
        var raw    = JSON.parse(labelsJson);
        var applied = 0;
        var seen    = {};
        var diag    = [];

        // Normalise stored paths to lowercase forward-slashes for comparison
        var labels = {};
        for (var k in raw) {
            if (raw.hasOwnProperty(k)) {
                labels[k.replace(/\\/g, '/').toLowerCase()] = raw[k];
            }
        }

        for (var vi = 0; vi < seq.videoTracks.numTracks; vi++) {
            var track = seq.videoTracks[vi];
            for (var ci = 0; ci < track.clips.numItems; ci++) {
                var clip = track.clips[ci];
                try {
                    var rawPath  = clip.projectItem.getMediaPath();
                    if (!rawPath) { diag.push('no_path@v' + vi + 'c' + ci); continue; }
                    var normPath = rawPath.replace(/\\/g, '/').toLowerCase();
                    var fname    = normPath.split('/').pop();

                    if (seen[normPath]) continue;
                    seen[normPath] = true;

                    if (labels.hasOwnProperty(normPath)) {
                        var lv = labels[normPath];
                        try {
                            clip.projectItem.label = lv;
                            applied++;
                            diag.push('ok:' + fname + '=' + lv);
                        } catch (se) {
                            diag.push('set_err:' + fname + ':' + se.message);
                        }
                    } else {
                        diag.push('no_key:' + fname);
                    }
                } catch (e) {
                    diag.push('clip_err@v' + vi + 'c' + ci + ':' + e.message);
                }
            }
        }
        return ok({ applied: applied, diag: diag.join(' | ') });
    } catch (e) {
        return fail(e.message);
    }
}


// ─────────────────────────────────────────────────────────────────────────────
// getLabelDiag
// Diagnostic: probes every label-reading method on the first clip of each
// audio track and returns what each method sees.  Call from browser console:
//   csInterface.evalScript('getLabelDiag()', r => console.log(r))
// ─────────────────────────────────────────────────────────────────────────────

function getLabelDiag() {
    try {
        var seq = getActiveSequence();
        var out = [];
        for (var ai = 0; ai < seq.audioTracks.numTracks; ai++) {
            var trk = seq.audioTracks[ai];
            if (trk.clips.numItems === 0) continue;
            var clip = trk.clips[0];
            var pi = clip.projectItem;
            var fname = '';
            try { fname = pi.getMediaPath().split('\\').pop().split('/').pop(); } catch(e) {}

            var row = { track: 'A' + (ai+1), file: fname };

            // M0: TrackItem.label (timeline-clip colour, set via right-click→Label)
            try { row.M0_trackItem_label = typeof clip.label + ':' + String(clip.label); } catch(e) { row.M0_trackItem_label = 'ERR:'+e.message; }

            try { row.M1_label = typeof pi.label + ':' + String(pi.label); } catch(e) { row.M1_label = 'ERR:'+e.message; }
            try { row.M2_colorLabel = typeof pi.colorLabel + ':' + String(pi.colorLabel); } catch(e) { row.M2_colorLabel = 'ERR'; }
            try { row.M3_getColorLabel = (typeof pi.getColorLabel === 'function') ? String(pi.getColorLabel()) : 'no_method'; } catch(e) { row.M3_getColorLabel = 'ERR'; }
            try {
                var meta = pi.metadata;
                if (meta && typeof meta.serialize === 'function') {
                    var xml = meta.serialize();
                    var m = xml.match(/<xmp:Label>([^<]+)<\/xmp:Label>/i) || xml.match(/xmp:Label="([^"]+)"/i);
                    row.M4_xmp = m ? m[1] : '(no xmp:Label in metadata)';
                } else {
                    row.M4_xmp = 'metadata=' + (typeof meta);
                }
            } catch(e) { row.M4_xmp = 'ERR:'+e.message; }

            row.M5_tryReadLabel = _tryReadLabel(pi);
            out.push(row);
        }
        return ok(out);
    } catch(e) {
        return fail(e.message);
    }
}


// ─────────────────────────────────────────────────────────────────────────────
// getSequenceInfo
// ─────────────────────────────────────────────────────────────────────────────

function getSequenceInfo() {
    try {
        var seq = getActiveSequence();
        var TICKS_PER_SEC = 254016000000;

        // Walk all clips on all tracks to find the true max end time.
        // seq.end.ticks / seq.end.seconds are unreliable on some sequence types.
        var durationSec = 0;
        var trackGroups = [seq.videoTracks, seq.audioTracks];
        for (var tg = 0; tg < trackGroups.length; tg++) {
            var grp = trackGroups[tg];
            for (var ti = 0; ti < grp.numTracks; ti++) {
                var trk = grp[ti];
                for (var ci = 0; ci < trk.clips.numItems; ci++) {
                    var cl = trk.clips[ci];
                    var clipEnd = 0;
                    try {
                        if (cl.end && cl.end.ticks) {
                            clipEnd = parseFloat(cl.end.ticks) / TICKS_PER_SEC;
                        } else if (cl.end && typeof cl.end.seconds === 'number') {
                            clipEnd = cl.end.seconds;
                        }
                    } catch (ignored) {}
                    if (clipEnd > durationSec) durationSec = clipEnd;
                }
            }
        }
        // Fallback to seq.end if we found nothing
        if (durationSec === 0 && seq.end && seq.end.ticks) {
            durationSec = parseFloat(seq.end.ticks) / TICKS_PER_SEC;
        }

        var fps = 0, width = 1920, height = 1080;
        try {
            var settings = seq.getSettings();
            fps    = Math.round(1 / settings.videoFrameRate.seconds);
            width  = settings.videoFrameWidth  || 1920;
            height = settings.videoFrameHeight || 1080;
        } catch (e2) {}

        return ok({
            name: seq.name,
            duration: durationSec,
            fps: fps,
            width: width,
            height: height,
            audioTrackCount: seq.audioTracks.numTracks,
            videoTrackCount: seq.videoTracks.numTracks
        });
    } catch (e) {
        return fail(e.message);
    }
}


// ─────────────────────────────────────────────────────────────────────────────
// applyCuts
// Applies the cut list to the active multicam sequence.
//
// cutsJson: JSON string with structure:
// {
//   "cameras": [{"index": 1, "videoTrack": 0}, ...],  // 1-based camera → 0-based video track
//   "cuts": [{"start": 0.0, "end": 4.25, "camera": 1}, ...]
// }
//
// Strategy: for each cut segment, enable only the video track corresponding
// to the target camera, disable all others.
// ─────────────────────────────────────────────────────────────────────────────

function applyCuts(cutsJson) {
    try {
        var seq = getActiveSequence();
        var payload = JSON.parse(cutsJson);
        var cuts = payload.cuts;
        var cameraMap = {};  // camera_index → video track index (0-based)

        for (var c = 0; c < payload.cameras.length; c++) {
            var cam = payload.cameras[c];
            cameraMap[cam.index] = cam.videoTrack;
        }

        var nVideoTracks = seq.videoTracks.numTracks;
        var applied = 0;

        // For each cut: add enable/disable keyframes on video tracks
        // Premiere's scripting API doesn't support frame-level enable/disable directly,
        // so we use the standard approach: insert cuts by manipulating clip in/out points.
        //
        // NOTE: This works best on a flattened sequence (not a true multicam nested sequence).
        // For true multicam sequences, the UI switch is done differently.
        // We handle both cases:

        var isMulticam = _isMulticamSequence(seq);

        if (isMulticam) {
            return _applyMulticamCuts(seq, cuts, cameraMap, payload.cameras);
        } else {
            return _applyFlatCuts(seq, cuts, cameraMap, nVideoTracks);
        }

    } catch (e) {
        return fail(e.message + "\n" + e.stack);
    }
}


function _isMulticamSequence(seq) {
    // Check if this sequence contains a multicam source sequence
    for (var t = 0; t < seq.videoTracks.numTracks; t++) {
        var track = seq.videoTracks[t];
        for (var c = 0; c < track.clips.numItems; c++) {
            var clip = track.clips[c];
            if (clip.isMultiCam && clip.isMultiCam()) {
                return true;
            }
        }
    }
    return false;
}


function _applyMulticamCuts(seq, cuts, cameraMap, cameras) {
    // For multicam sequences: insert cuts and set active camera angle
    // This mirrors what AutoPod does for true multicam sequences.
    
    var applied = 0;
    var videoTrack = seq.videoTracks[0];  // multicam clip lives on track 0

    if (videoTrack.clips.numItems === 0) {
        return fail("No clips found on video track 0");
    }

    // We'll work with the first clip (the multicam nested clip)
    // Use Premiere's multicam API to set angles at specific times
    for (var i = 0; i < cuts.length; i++) {
        var cut = cuts[i];
        var targetCamera = cut.camera;  // 1-based camera index

        // Convert seconds to ticks for Premiere API
        var startTick = _secToTick(cut.start);
        var endTick = _secToTick(cut.end);

        try {
            // Add a cut at cut.start if not already there
            videoTrack.insertClip(startTick);
            
            // Find the clip at this position and set its multicam angle
            for (var c = 0; c < videoTrack.clips.numItems; c++) {
                var clip = videoTrack.clips[c];
                var clipStart = clip.start.seconds;
                if (Math.abs(clipStart - cut.start) < 0.1) {
                    if (clip.setMultiCamTrackIndex) {
                        clip.setMultiCamTrackIndex(targetCamera - 1);  // 0-based internally
                    }
                    applied++;
                    break;
                }
            }
        } catch (cutErr) {
            // Log but continue - some cuts may fail due to sequence structure
            $.writeln("Cut error at " + cut.start + ": " + cutErr.message);
        }
    }

    return ok({ applied: applied, mode: "multicam" });
}


// ─────────────────────────────────────────────────────────────────────────────
// _secToTimecode  — seconds → "HH:MM:SS:FF" for QE razor calls
// ─────────────────────────────────────────────────────────────────────────────

function _secToTimecode(seconds, fps) {
    var frames   = Math.round(Math.max(0, seconds) * fps);
    var f        = frames % fps;
    var totalSec = Math.floor(frames / fps);
    var s        = totalSec % 60;
    var totalMin = Math.floor(totalSec / 60);
    var m        = totalMin % 60;
    var h        = Math.floor(totalMin / 60);
    function pad(n) { return n < 10 ? '0' + n : String(n); }
    return pad(h) + ':' + pad(m) + ':' + pad(s) + ':' + pad(f);
}


// ─────────────────────────────────────────────────────────────────────────────
// _isTimeInRanges — returns true if `time` falls inside any [{start,end}]
// ─────────────────────────────────────────────────────────────────────────────

function _isTimeInRanges(time, ranges) {
    for (var i = 0; i < ranges.length; i++) {
        if (time >= ranges[i].start && time < ranges[i].end) return true;
    }
    return false;
}


// ─────────────────────────────────────────────────────────────────────────────
// _applyFlatCuts
//
// Strategy: QE razor + clip.disabled
//   1. Razor every video track at each cut boundary via qe.project.getActiveSequence()
//   2. For each resulting clip segment: set clip.disabled = true if not in its
//      track's active ranges, false if it is.
//
// This is non-destructive — no clips are deleted, Ctrl+Z works.
// ─────────────────────────────────────────────────────────────────────────────

function _applyFlatCuts(seq, cuts, cameraMap, nVideoTracks) {
    var TICKS   = 254016000000;
    var applied = 0;
    var diagStr = '';
    var liveSeq = app.project.activeSequence;

    // Safety: abort if all video tracks are already empty.
    var hasClips = false;
    for (var ti = 0; ti < nVideoTracks; ti++) {
        if (liveSeq.videoTracks[ti].clips.numItems > 0) { hasClips = true; break; }
    }
    if (!hasClips) {
        return fail('All video tracks are empty. Undo to restore your original clips first.');
    }

    // FPS needed for timecode conversion.
    var fps = 25;
    try { fps = Math.round(1 / liveSeq.getSettings().videoFrameRate.seconds); } catch (e) {}

    // Build per-track active ranges from the cut list.
    var trackRanges = {};
    for (var i = 0; i < cuts.length; i++) {
        var at = cameraMap[cuts[i].camera];
        if (at !== undefined) {
            if (!trackRanges[at]) trackRanges[at] = [];
            trackRanges[at].push({ start: cuts[i].start, end: cuts[i].end });
        }
    }

    // Collect all unique boundary times (start/end of every cut).
    var boundaryMap = {};
    for (var i = 0; i < cuts.length; i++) {
        boundaryMap[cuts[i].start.toFixed(4)] = cuts[i].start;
        boundaryMap[cuts[i].end.toFixed(4)]   = cuts[i].end;
    }
    var boundaryTimes = [];
    for (var key in boundaryMap) boundaryTimes.push(boundaryMap[key]);
    boundaryTimes.sort(function (a, b) { return a - b; });

    // ── Step 1: enable QE and grab the QE sequence handle ────────────────────
    try { app.enableQE(); } catch (e) {
        return fail('app.enableQE() threw: ' + e.message);
    }

    var qeSeq = null;
    try {
        qeSeq = qe.project.getActiveSequence();
    } catch (e) {
        return fail('qe inaccessible: ' + e.message + ' (typeof qe=' + (typeof qe) + ')');
    }
    if (!qeSeq) return fail('qe.project.getActiveSequence() returned null');

    // ── Step 2: razor each video track at every boundary timecode ────────────
    var razorOk = 0, razorFail = 0;
    for (var bi = 0; bi < boundaryTimes.length; bi++) {
        var tc = _secToTimecode(boundaryTimes[bi], fps);
        for (var ti = 0; ti < nVideoTracks; ti++) {
            try {
                qeSeq.getVideoTrackAt(ti).razor(tc);
                razorOk++;
            } catch (re) {
                razorFail++;
                if (razorFail <= 2) {
                    diagStr += 'razorErr@' + tc + ':' + String(re.message).substring(0, 25) + ' ';
                }
            }
        }
    }

    // ── Step 3: enable/disable each clip segment ─────────────────────────────
    // Refresh the sequence reference — the clip list changed after razor cuts.
    liveSeq = app.project.activeSequence;

    for (var ti = 0; ti < nVideoTracks; ti++) {
        var trk         = liveSeq.videoTracks[ti];
        var activeRanges = trackRanges[ti] || [];

        for (var ci = 0; ci < trk.clips.numItems; ci++) {
            var clip        = trk.clips[ci];
            var clipStart   = parseFloat(clip.start.ticks) / TICKS;
            var clipEnd     = parseFloat(clip.end.ticks)   / TICKS;
            var mid         = (clipStart + clipEnd) / 2;
            var shouldBeOn  = _isTimeInRanges(mid, activeRanges);

            try {
                clip.disabled = !shouldBeOn;
                if (shouldBeOn) applied++;
            } catch (de) {
                if (diagStr.indexOf('disableErr') === -1) {
                    diagStr += 'disableErr_t' + ti + ':' + String(de.message).substring(0, 30) + ' ';
                }
            }
        }
    }

    var summary = 'razors:' + razorOk + (razorFail ? '/fail:' + razorFail : '');
    return ok({ applied: applied, mode: 'razor+disable', razorDiag: (diagStr || 'ok') + ' ' + summary });
}


function _secToTick(seconds) {
    // Premiere uses 254016000000 ticks per second
    var TICKS_PER_SECOND = 254016000000;
    return Math.round(seconds * TICKS_PER_SECOND);
}


// ─────────────────────────────────────────────────────────────────────────────
// Two-phase cut application (for progress reporting from main.js)
//
//   Phase 1: applyRazorCuts(cutsJson)  — slow QE razor pass
//   Phase 2: applyDisableCuts()        — fast clip.disabled pass
//
// cutsJson is the same payload structure as applyCuts().
// ─────────────────────────────────────────────────────────────────────────────

var _disableJobData = null;  // shared between the two phases


function applyRazorCuts(cutsJson) {
    try {
        var liveSeq = app.project.activeSequence;
        if (!liveSeq) return fail('No active sequence.');

        var payload    = JSON.parse(cutsJson);
        var cuts       = payload.cuts;
        var cameraMap  = {};

        for (var c = 0; c < payload.cameras.length; c++) {
            var cam = payload.cameras[c];
            cameraMap[cam.index] = cam.videoTrack;
        }

        var nVideoTracks = liveSeq.videoTracks.numTracks;

        // Safety: abort if all video tracks are empty
        var hasClips = false;
        for (var ti = 0; ti < nVideoTracks; ti++) {
            if (liveSeq.videoTracks[ti].clips.numItems > 0) { hasClips = true; break; }
        }
        if (!hasClips) {
            return fail('All video tracks are empty. Undo to restore your original clips first.');
        }

        var fps = 25;
        try { fps = Math.round(1 / liveSeq.getSettings().videoFrameRate.seconds); } catch (e) {}

        // Build per-track active ranges
        var trackRanges = {};
        for (var i = 0; i < cuts.length; i++) {
            var at = cameraMap[cuts[i].camera];
            if (at !== undefined) {
                if (!trackRanges[at]) trackRanges[at] = [];
                trackRanges[at].push({ start: cuts[i].start, end: cuts[i].end });
            }
        }

        // Collect all unique boundary times
        var boundaryMap = {};
        for (var i = 0; i < cuts.length; i++) {
            boundaryMap[cuts[i].start.toFixed(4)] = cuts[i].start;
            boundaryMap[cuts[i].end.toFixed(4)]   = cuts[i].end;
        }
        var boundaryTimes = [];
        for (var key in boundaryMap) boundaryTimes.push(boundaryMap[key]);
        boundaryTimes.sort(function (a, b) { return a - b; });

        // Enable QE
        try { app.enableQE(); } catch (e) {
            return fail('app.enableQE() threw: ' + e.message);
        }
        var qeSeq = null;
        try { qeSeq = qe.project.getActiveSequence(); } catch (e) {
            return fail('qe inaccessible: ' + e.message);
        }
        if (!qeSeq) return fail('qe.project.getActiveSequence() returned null');

        // Razor every video track at every boundary timecode
        var razorOk = 0, razorFail = 0, diagStr = '';
        for (var bi = 0; bi < boundaryTimes.length; bi++) {
            var tc = _secToTimecode(boundaryTimes[bi], fps);
            for (var ti = 0; ti < nVideoTracks; ti++) {
                try {
                    qeSeq.getVideoTrackAt(ti).razor(tc);
                    razorOk++;
                } catch (re) {
                    razorFail++;
                    if (razorFail <= 2) {
                        diagStr += 'razorErr@' + tc + ':' + String(re.message).substring(0, 25) + ' ';
                    }
                }
            }
        }

        // Save data for the disable phase
        _disableJobData = {
            trackRanges:  trackRanges,
            nVideoTracks: nVideoTracks
        };

        return ok({
            razorOk:    razorOk,
            razorFail:  razorFail,
            boundaries: boundaryTimes.length,
            tracks:     nVideoTracks,
            diag:       diagStr || 'ok'
        });
    } catch (e) {
        return fail(e.message + '\n' + e.stack);
    }
}


// ─────────────────────────────────────────────────────────────────────────────
// addChapterMarkers
// Adds sequence comment markers at the specified times.
// markersJson: JSON array of {time: number, label: string}
// ─────────────────────────────────────────────────────────────────────────────

function addChapterMarkers(markersJson) {
    try {
        var seq  = getActiveSequence();
        var pts  = JSON.parse(markersJson);
        var diag = [];
        var added = 0;

        diag.push('seq="' + seq.name + '"');
        diag.push('markers_obj=' + (typeof seq.markers));
        diag.push('input=' + pts.length + ' pts');

        if (typeof seq.markers === 'undefined' || !seq.markers) {
            return fail('seq.markers unavailable — is this a regular sequence?');
        }

        if (typeof seq.markers.createMarker !== 'function') {
            return fail('seq.markers.createMarker is not a function (type=' + (typeof seq.markers.createMarker) + ')');
        }

        for (var i = 0; i < pts.length; i++) {
            var p    = pts[i];
            var sec  = p.time;   // seconds (float) — createMarker takes seconds per Adobe docs
            var name = p.label || ('Chapter ' + (i + 1));
            diag.push('pt' + i + ':t=' + sec + 's label=' + name);
            try {
                var marker = seq.markers.createMarker(sec);
                diag.push('created');

                // Set name
                try { marker.name = name; diag.push('name_ok'); } catch (ne) { diag.push('name_err:' + ne.message); }

                // Mark as chapter type (not comment)
                try { marker.setTypeAsChapter(); diag.push('chapter_type_ok'); } catch (te) { diag.push('setTypeAsChapter_err:' + te.message); }

                // Some Premiere versions ignore createMarker(sec) and place at 0 —
                // explicitly set start time as a fallback.
                try {
                    if (marker.start && typeof marker.start.seconds !== 'undefined') {
                        marker.start.seconds = sec;
                        diag.push('start_set_ok');
                    }
                } catch (se) { diag.push('start_set_err:' + se.message); }

                added++;
            } catch (ce) {
                diag.push('create_FAIL:' + String(ce.message).substring(0, 60));
            }
        }

        return ok({ added: added, diag: diag.join(' | ') });
    } catch (e) {
        return fail('addChapterMarkers outer: ' + e.message + ' | ' + e.stack);
    }
}


// ─────────────────────────────────────────────────────────────────────────────
// applyZoom
// Scales every enabled (non-disabled) clip on all video tracks by
// (100 + zoom_pct)% via the Motion effect's Scale property.
// zoomJson: JSON object {zoom_pct: number}  (0-20 typical)
// ─────────────────────────────────────────────────────────────────────────────

function applyZoom(zoomJson) {
    try {
        var data    = JSON.parse(zoomJson);
        var zoomPct = parseFloat(data.zoom_pct) || 0;
        if (zoomPct <= 0) return ok({ applied: 0, scale: 100 });

        var scaleVal = 100 + zoomPct;
        var seq      = getActiveSequence();
        var applied  = 0;
        var errors   = [];

        for (var ti = 0; ti < seq.videoTracks.numTracks; ti++) {
            var trk = seq.videoTracks[ti];
            for (var ci = 0; ci < trk.clips.numItems; ci++) {
                var clip = trk.clips[ci];
                try { if (clip.disabled) continue; } catch (e) {}

                try {
                    // Walk clip.components to find the Motion effect
                    var motionEffect = null;
                    for (var ei = 0; ei < clip.components.numItems; ei++) {
                        var eff = clip.components[ei];
                        var mn  = '';
                        try { mn = eff.matchName; } catch (e) {}
                        var dn  = '';
                        try { dn = eff.displayName; } catch (e) {}
                        if (mn === 'ADBE Motion' || dn === 'Motion') {
                            motionEffect = eff;
                            break;
                        }
                    }
                    if (!motionEffect) continue;

                    // Find the Scale property inside Motion
                    var props = motionEffect.properties;
                    for (var pi = 0; pi < props.numItems; pi++) {
                        var prop = props.getParamAtIndex(pi);
                        var pmn  = '';
                        try { pmn = prop.matchName;   } catch (e) {}
                        var pdn  = '';
                        try { pdn = prop.displayName; } catch (e) {}
                        if (pmn === 'ADBE Scale' || pdn === 'Scale') {
                            prop.setValue(scaleVal, true);
                            applied++;
                            break;
                        }
                    }
                } catch (clipErr) {
                    if (errors.length < 3) errors.push('t' + ti + 'c' + ci + ':' + String(clipErr.message).substring(0, 25));
                }
            }
        }

        var diag = errors.length ? errors.join(' | ') : 'ok';
        return ok({ applied: applied, scale: scaleVal, diag: diag });
    } catch (e) {
        return fail('applyZoom: ' + e.message);
    }
}


function applyDisableCuts() {
    try {
        if (!_disableJobData) {
            return fail('No razor job data. Call applyRazorCuts first.');
        }

        var TICKS = 254016000000;
        var data  = _disableJobData;
        _disableJobData = null;   // consume

        var liveSeq = app.project.activeSequence;
        if (!liveSeq) return fail('No active sequence.');

        var applied  = 0;
        var diagStr  = '';

        for (var ti = 0; ti < data.nVideoTracks; ti++) {
            var trk          = liveSeq.videoTracks[ti];
            var activeRanges = data.trackRanges[ti] || [];

            for (var ci = 0; ci < trk.clips.numItems; ci++) {
                var clip       = trk.clips[ci];
                var clipStart  = parseFloat(clip.start.ticks) / TICKS;
                var clipEnd    = parseFloat(clip.end.ticks)   / TICKS;
                var mid        = (clipStart + clipEnd) / 2;
                var shouldBeOn = _isTimeInRanges(mid, activeRanges);

                try {
                    clip.disabled = !shouldBeOn;
                    if (shouldBeOn) applied++;
                } catch (de) {
                    if (diagStr.indexOf('disableErr') === -1) {
                        diagStr += 'disableErr_t' + ti + ':' + String(de.message).substring(0, 30) + ' ';
                    }
                }
            }
        }

        return ok({ applied: applied, mode: 'razor+disable', diag: diagStr || 'ok' });
    } catch (e) {
        return fail(e.message + '\n' + e.stack);
    }
}
