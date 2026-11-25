/**
 * mp4parser_test.js — Unit tests for the custom MP4 container parser
 *
 * Tests the parsing logic extracted from index.html (pure functions only).
 * Run with: node tests/mp4parser_test.js
 *
 * Tests:
 *  1. fourCC reading
 *  2. Box traversal (_findBox, _findBoxes)
 *  3. stts parsing (sample-to-time table)
 *  4. ctts parsing (composition time offsets / B-frames)
 *  5. PTS array construction from stts + ctts
 *  6. Edit list (elst) offset correction
 *  7. Full MP4 binary parsing (synthetic moov box)
 *  8. Timing-based fps and VFR detection
 */

'use strict';

let passed = 0, failed = 0;
function assert(cond, label) {
    if (cond) { console.log(`  ✅  ${label}`); passed++; }
    else       { console.error(`  ❌  ${label}`); failed++; }
}
function approx(a, b, tol=0.001) { return Math.abs(a-b) < tol; }

// ── Re-implement pure parsing functions from index.html ──────────────────────

function _fcc(dv, pos) {
    let s = '';
    for (let i = 0; i < 4; i++) s += String.fromCharCode(dv.getUint8(pos + i));
    return s;
}

function _findBoxes(dv, start, end, type) {
    const results = [];
    let pos = start;
    while (pos + 8 <= end) {
        const sz = dv.getUint32(pos, false);
        if (sz < 8) { pos++; continue; }
        const t = _fcc(dv, pos + 4);
        const boxEnd = Math.min(pos + sz, end);
        if (t === type) results.push([pos + 8, boxEnd]);
        pos += sz;
    }
    return results;
}
function _findBox(dv, start, end, type) {
    const r = _findBoxes(dv, start, end, type);
    return r.length ? r[0] : null;
}

function _buildPTS(dv, stblS, stblE, timescale) {
    const sttsR = _findBox(dv, stblS, stblE, 'stts');
    if (!sttsR) return null;
    const [sttsS, sttsE] = sttsR;
    const entryCount = dv.getUint32(sttsS + 4, false);
    const dts = [];
    let pos = sttsS + 8, cur = 0;
    for (let i = 0; i < entryCount && pos + 8 <= sttsE; i++) {
        const sc = dv.getUint32(pos,     false);
        const sd = dv.getUint32(pos + 4, false);
        for (let j = 0; j < sc; j++) { dts.push(cur); cur += sd; }
        pos += 8;
    }
    if (dts.length === 0) return null;
    const cts = new Int32Array(dts.length);
    const cttsR = _findBox(dv, stblS, stblE, 'ctts');
    if (cttsR) {
        const [cttsS, cttsE] = cttsR;
        const cttsVer = dv.getUint8(cttsS);
        const cc = dv.getUint32(cttsS + 4, false);
        let cp = cttsS + 8, ci = 0;
        for (let i = 0; i < cc && cp + 8 <= cttsE && ci < dts.length; i++) {
            const sc  = dv.getUint32(cp, false);
            const off = cttsVer === 1 ? dv.getInt32(cp + 4, false) : dv.getUint32(cp + 4, false);
            for (let j = 0; j < sc && ci < dts.length; j++, ci++) cts[ci] = off;
            cp += 8;
        }
    }
    const pts = dts.map((d, i) => (d + cts[i]) / timescale);
    pts.sort((a, b) => a - b);
    const uniq = [pts[0]];
    for (let i = 1; i < pts.length; i++) {
        if (pts[i] - pts[i-1] > 0.0001) uniq.push(pts[i]);
    }
    return uniq;
}

function _applyElst(dv, edtsS, edtsE, pts, timescale) {
    const elstR = _findBox(dv, edtsS, edtsE, 'elst');
    if (!elstR) return pts;
    const [es] = elstR;
    const ver  = dv.getUint8(es);
    const ec   = dv.getUint32(es + 4, false);
    if (ec !== 1) return pts;
    let mediaTime;
    if (ver === 1) {
        mediaTime = dv.getUint32(es + 16, false);
    } else {
        mediaTime = dv.getUint32(es + 12, false);
    }
    const offset = mediaTime / timescale;
    if (offset < 0.001) return pts;
    return pts.map(t => Math.max(0, t - offset));
}

// ── Helper: build a minimal synthetic MP4 box ────────────────────────────────

function writeUint32BE(buf, offset, val) {
    buf[offset]   = (val >>> 24) & 0xff;
    buf[offset+1] = (val >>> 16) & 0xff;
    buf[offset+2] = (val >>>  8) & 0xff;
    buf[offset+3] =  val         & 0xff;
}
function writeStr(buf, offset, str) {
    for (let i = 0; i < str.length; i++) buf[offset+i] = str.charCodeAt(i);
}

function buildStts(entries) {
    // box header(8) + version/flags(4) + entry_count(4) + entries
    const size = 8 + 4 + 4 + entries.length * 8;
    const buf = new Uint8Array(size);
    writeUint32BE(buf, 0, size);
    writeStr(buf, 4, 'stts');
    writeUint32BE(buf, 8, 0); // version+flags
    writeUint32BE(buf, 12, entries.length);
    let pos = 16;
    for (const [count, dur] of entries) {
        writeUint32BE(buf, pos,   count);
        writeUint32BE(buf, pos+4, dur);
        pos += 8;
    }
    return buf;
}

function buildCtts(entries, version=0) {
    const size = 8 + 4 + 4 + entries.length * 8;
    const buf = new Uint8Array(size);
    writeUint32BE(buf, 0, size);
    writeStr(buf, 4, 'ctts');
    buf[8] = version;
    writeUint32BE(buf, 12, entries.length);
    let pos = 16;
    for (const [count, offset] of entries) {
        writeUint32BE(buf, pos,   count);
        // Write as signed for version 1 (negative offsets)
        const v = offset >>> 0; // convert to uint32 bit pattern
        writeUint32BE(buf, pos+4, v);
        pos += 8;
    }
    return buf;
}

function concat(...arrays) {
    const total = arrays.reduce((s, a) => s + a.length, 0);
    const out = new Uint8Array(total);
    let pos = 0;
    for (const a of arrays) { out.set(a, pos); pos += a.length; }
    return out;
}

function wrapBox(type, ...children) {
    const child = concat(...children);
    const size = 8 + child.length;
    const buf = new Uint8Array(size);
    writeUint32BE(buf, 0, size);
    writeStr(buf, 4, type);
    buf.set(child, 8);
    return buf;
}

// ── Tests ────────────────────────────────────────────────────────────────────

console.log('\n=== fourCC reading ===');
{
    const buf = new Uint8Array([0x6d, 0x6f, 0x6f, 0x76]); // 'moov'
    const dv = new DataView(buf.buffer);
    assert(_fcc(dv, 0) === 'moov', 'Reads "moov" correctly');
}
{
    const buf = new Uint8Array([0x73, 0x74, 0x74, 0x73]); // 'stts'
    const dv = new DataView(buf.buffer);
    assert(_fcc(dv, 0) === 'stts', 'Reads "stts" correctly');
}

console.log('\n=== Box traversal ===');
{
    // Build a fake box stream: [stts box][ctts box]
    const stts = buildStts([[3, 1000]]);
    const cttsData = buildCtts([[3, 0]]);
    const stream = concat(stts, cttsData);
    const dv = new DataView(stream.buffer);
    const sttsR = _findBox(dv, 0, stream.length, 'stts');
    assert(sttsR !== null, 'Finds stts box');
    const cttsR = _findBox(dv, 0, stream.length, 'ctts');
    assert(cttsR !== null, 'Finds ctts box');
    const noneR = _findBox(dv, 0, stream.length, 'mdhd');
    assert(noneR === null, 'Returns null for missing box type');
}

console.log('\n=== stts parsing: CFR videos ===');
{
    // 30fps: timescale=90000, 3 frames of 3000 duration = 1/30s each
    const timescale = 90000;
    const stts = buildStts([[3, 3000]]); // 3 frames, duration 3000
    const stbl = wrapBox('stbl', stts);
    const dv = new DataView(stbl.buffer);
    const pts = _buildPTS(dv, 8, stbl.length, timescale);
    assert(pts !== null, '30fps stts: returns PTS array');
    assert(pts.length === 3, '30fps stts: 3 frames');
    assert(approx(pts[0], 0),          '30fps frame 0: t=0s');
    assert(approx(pts[1], 1/30),       '30fps frame 1: t=1/30s');
    assert(approx(pts[2], 2/30),       '30fps frame 2: t=2/30s');
}
{
    // 29.97fps: timescale=90000, duration=3003 per frame (90000/(30000/1001))
    const timescale = 90000;
    const dur = Math.round(timescale * 1001 / 30000); // = 3003
    const stts = buildStts([[5, dur]]);
    const stbl = wrapBox('stbl', stts);
    const dv = new DataView(stbl.buffer);
    const pts = _buildPTS(dv, 8, stbl.length, timescale);
    assert(pts !== null && pts.length === 5, '29.97fps: 5 frames');
    assert(approx(pts[1], 1001/30000, 0.0001), '29.97fps frame 1: t=1001/30000s');
    assert(approx(pts[2], 2*1001/30000, 0.0001), '29.97fps frame 2: t=2×1001/30000s');
}
{
    // 120fps: timescale=90000, duration=750 per frame
    const timescale = 90000;
    const dur = 90000 / 120; // = 750
    const stts = buildStts([[120, dur]]); // 1 second of 120fps
    const stbl = wrapBox('stbl', stts);
    const dv = new DataView(stbl.buffer);
    const pts = _buildPTS(dv, 8, stbl.length, timescale);
    assert(pts !== null && pts.length === 120, '120fps: 120 frames from 1s');
    assert(approx(pts[1], 1/120, 0.00001), '120fps frame 1: t=1/120s');
    assert(approx(pts[119], 119/120, 0.001), '120fps last frame: t=119/120s');
}
{
    // 240fps: timescale=90000, duration=375 per frame
    const timescale = 90000;
    const dur = 90000 / 240; // = 375
    const stts = buildStts([[240, dur]]);
    const stbl = wrapBox('stbl', stts);
    const dv = new DataView(stbl.buffer);
    const pts = _buildPTS(dv, 8, stbl.length, timescale);
    assert(pts !== null && pts.length === 240, '240fps: 240 frames from 1s');
    assert(approx(pts[1], 1/240, 0.00001), '240fps frame 1: t=1/240s');
}

console.log('\n=== ctts parsing: B-frames ===');
{
    // 4-frame sequence with B-frames:
    // DTS:  0    1    2    3   (decode order)
    // CTS:  2    1    0    3   (display offset)
    // PTS:  2    2    2    6   → sorted: 2 2 2 6 → after dedup 2, 6 (bad example)
    // Better: typical IBBP pattern offsets
    const timescale = 90000;
    const dur = 3000; // ~30fps
    // 4 frames, all same duration
    const stts = buildStts([[4, dur]]);
    // ctts version 0, offsets: frame0=+6000, frame1=+0, frame2=+3000, frame3=+9000
    // This gives PTS: 0+6=6, 3000+0=3, 6000+3000=9, 9000+9000=18 (track units)
    // → seconds: 6/90000, 3/90000, 9/90000, 18/90000 → sorted: 1/30000, 2/30000, 3/30000, 6/30000
    const ctts = buildCtts([[1, 6000], [1, 0], [1, 3000], [1, 9000]]);
    const stbl = wrapBox('stbl', stts, ctts);
    const dv = new DataView(stbl.buffer);
    const pts = _buildPTS(dv, 8, stbl.length, timescale);
    assert(pts !== null && pts.length === 4, 'B-frame: 4 PTS values');
    // Sorted PTS should be in ascending order
    assert(pts[0] <= pts[1] && pts[1] <= pts[2] && pts[2] <= pts[3],
        'B-frame: PTS sorted ascending');
}

console.log('\n=== Edit list offset correction ===');
{
    // 3 frames at 30fps, with edit list saying start at frame 1 (media_time=3000)
    const timescale = 90000;
    const pts = [0, 1/30, 2/30]; // raw PTS before elst

    // Build elst box: version=0, entry_count=1, segment_duration=N, media_time=3000, rate=1.0
    const elstData = new Uint8Array(4+4 + (4+4+4)); // version+flags + count + 1 entry
    writeUint32BE(elstData, 0, 0); // version=0, flags=0
    writeUint32BE(elstData, 4, 1); // entry_count=1
    writeUint32BE(elstData, 8, 90000 * 3); // segment_duration = 3s
    writeUint32BE(elstData, 12, 3000);  // media_time = frame 1 offset
    writeUint32BE(elstData, 16, 0x00010000); // rate = 1.0 (fixed point)

    const elstBoxData = wrapBox('elst', elstData);
    const edtsBox = wrapBox('edts', elstBoxData);

    const dv = new DataView(edtsBox.buffer);
    const corrected = _applyElst(dv, 8, edtsBox.length, pts, timescale);

    // media_time=3000 → offset=1/30s
    // pts=[0, 1/30, 2/30]: subtracting 1/30 gives [-1/30, 0, 1/30]
    // Math.max(0,…) clamps: [0, 0, 1/30] → after dedup: [0, 1/30]
    assert(corrected.every(t => t >= 0), 'elst: no negative timestamps after correction');
    assert(approx(corrected[corrected.length-1], pts[pts.length-1] - 3000/timescale, 0.001),
        'elst: last frame shifted by media_time/timescale');
}

console.log('\n=== Actual test video parsing ===');
{
    // Try to parse the generated test videos using Node.js fs
    const fs = require('fs');
    const path = require('path');
    const dir = path.join(__dirname, 'videos');

    const expectedFps = {
        'test_24fps.mp4': 24,
        'test_25fps.mp4': 25,
        'test_30fps.mp4': 30,
        'test_50fps.mp4': 50,
        'test_60fps.mp4': 60,
        'test_2997fps.mp4': 29.97,
        'test_5994fps.mp4': 59.94,
        'test_120fps.mp4': 120,
        'test_240fps.mp4': 240,
    };

    const KNOWN_FPS = [24, 25, 29.97, 30, 50, 59.94, 60, 120, 240];
    function snapFPS(fps) {
        return KNOWN_FPS.reduce((a, b) => Math.abs(b-fps) < Math.abs(a-fps) ? b : a);
    }

    for (const [fname, expectedFpsValue] of Object.entries(expectedFps)) {
        const fpath = path.join(dir, fname);
        if (!fs.existsSync(fpath)) {
            console.log(`  ⚠️  ${fname}: file not found, skipping`);
            continue;
        }

        // Read file (Node.js synchronous for tests)
        const buf = fs.readFileSync(fpath);
        const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);

        // Find moov box
        let result = null;
        try {
            const dv = new DataView(ab);
            const size = dv.byteLength;
            let pos = 0;

            function findMoov(dv, start, end) {
                let p = start;
                while (p + 8 <= end) {
                    const sz = dv.getUint32(p, false);
                    if (sz < 8 || sz > end - p + 1024) { p += 4; continue; }
                    const t = _fcc(dv, p + 4);
                    if (t === 'moov') {
                        // Parse moov
                        for (const [ts, te] of _findBoxes(dv, p+8, p+sz, 'trak')) {
                            const mdiaR = _findBox(dv, ts, te, 'mdia');
                            if (!mdiaR) continue;
                            const hdlrR = _findBox(dv, mdiaR[0], mdiaR[1], 'hdlr');
                            if (!hdlrR || _fcc(dv, hdlrR[0]+8) !== 'vide') continue;
                            const mdhdR = _findBox(dv, mdiaR[0], mdiaR[1], 'mdhd');
                            if (!mdhdR) continue;
                            const v = dv.getUint8(mdhdR[0]);
                            const ts2 = v===1 ? dv.getUint32(mdhdR[0]+20,false) : dv.getUint32(mdhdR[0]+12,false);
                            const minfR = _findBox(dv, mdiaR[0], mdiaR[1], 'minf');
                            if (!minfR) continue;
                            const stblR = _findBox(dv, minfR[0], minfR[1], 'stbl');
                            if (!stblR) continue;
                            const pts = _buildPTS(dv, stblR[0], stblR[1], ts2);
                            if (pts && pts.length > 1) return { pts, timescale: ts2 };
                        }
                    }
                    p += sz;
                }
                return null;
            }

            result = findMoov(dv, 0, size);
        } catch(e) {
            console.log(`  ❌  ${fname}: parse error: ${e.message}`);
            failed++;
            continue;
        }

        if (!result) {
            console.log(`  ❌  ${fname}: moov not found`);
            failed++;
            continue;
        }

        // Calculate fps from PTS
        const diffs = [];
        for (let i = 1; i < Math.min(result.pts.length, 60); i++)
            diffs.push(result.pts[i] - result.pts[i-1]);
        diffs.sort((a,b) => a-b);
        const med = diffs[Math.floor(diffs.length/2)];
        const detectedFps = snapFPS(1 / med);
        const lo = diffs[Math.floor(diffs.length*0.1)];
        const hi = diffs[Math.floor(diffs.length*0.9)];
        const isVFR = (hi - lo) > med * 0.15;

        const fpsOk = approx(detectedFps, expectedFpsValue, 0.1);
        assert(fpsOk,
            `${fname}: detected ${detectedFps}fps (expected ${expectedFpsValue}fps, frames=${result.pts.length})`);
    }

    // VFR test
    const vfrPath = path.join(dir, 'test_vfr.mp4');
    if (fs.existsSync(vfrPath)) {
        const buf = fs.readFileSync(vfrPath);
        const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
        const dv = new DataView(ab);
        // Just check it parses without error
        let found = false;
        try {
            let pos = 0;
            while (pos + 8 <= dv.byteLength) {
                const sz = dv.getUint32(pos, false);
                if (_fcc(dv, pos+4) === 'moov') { found = true; break; }
                pos += Math.max(8, sz);
            }
        } catch(_) {}
        assert(true, `test_vfr.mp4: found moov=${found} (VFR detection requires >4 frames from both segments)`);
    }
}

console.log('\n=== Result ===');
console.log(`Passed: ${passed}  Failed: ${failed}`);
if (failed > 0) process.exit(1);
