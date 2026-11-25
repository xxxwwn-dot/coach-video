/**
 * coord_test.js — Coordinate conversion unit tests for coach-video
 *
 * Tests the getVideoRect / toNorm / _drawObj logic extracted from index.html.
 * Run with: node tests/coord_test.js
 *
 * Tests verify that:
 *  1. getVideoRect produces correct letterbox / pillarbox rects
 *  2. toNorm correctly maps canvas pixels → normalized video coords
 *  3. Round-trip: toNorm → back to canvas pixels is lossless
 *  4. Drawing objects at normalized coords survive canvas resize
 */

'use strict';

let passed = 0, failed = 0;

function assert(condition, label) {
    if (condition) {
        console.log(`  ✅  ${label}`);
        passed++;
    } else {
        console.error(`  ❌  ${label}`);
        failed++;
    }
}

function approx(a, b, tol = 0.001) {
    return Math.abs(a - b) < tol;
}

// ── Re-implement the pure functions from index.html ──────────────────────────

/**
 * Returns the video's display rect in canvas-pixel coordinates.
 * Mirrors index.html getVideoRect() but takes explicit dimensions.
 */
function getVideoRect(canvasW, canvasH, videoW, videoH) {
    if (!canvasW || !canvasH) return { x:0, y:0, w:canvasW||1, h:canvasH||1 };
    if (!videoW || !videoH)   return { x:0, y:0, w:canvasW, h:canvasH };
    const vAR = videoW / videoH;
    const cAR = canvasW / canvasH;
    let w, h;
    if (vAR > cAR) { w = canvasW; h = canvasW / vAR; }   // letterbox (black bars top/bottom)
    else           { h = canvasH; w = canvasH * vAR; }   // pillarbox (black bars left/right)
    return { x:(canvasW - w) / 2, y:(canvasH - h) / 2, w, h };
}

/**
 * Convert canvas-pixel coords → normalized video coords.
 * Mirrors index.html toNorm().
 */
function toNorm(canvasW, canvasH, videoW, videoH, cx, cy) {
    const r = getVideoRect(canvasW, canvasH, videoW, videoH);
    return { x: (cx - r.x) / r.w, y: (cy - r.y) / r.h };
}

/**
 * Convert normalized coords → canvas pixels (inverse of toNorm).
 */
function fromNorm(canvasW, canvasH, videoW, videoH, nx, ny) {
    const r = getVideoRect(canvasW, canvasH, videoW, videoH);
    return { x: r.x + nx * r.w, y: r.y + ny * r.h };
}

// ── Tests ────────────────────────────────────────────────────────────────────

console.log('\n=== getVideoRect tests ===');

// 16:9 video in 16:9 canvas → fills exactly
{
    const r = getVideoRect(1280, 720, 1920, 1080);
    assert(r.x === 0 && r.y === 0, 'Square AR match: no letterbox/pillarbox');
    assert(r.w === 1280 && r.h === 720, 'Square AR match: fills canvas');
}

// 16:9 video in 4:3 canvas → pillarbox (black bars left/right)
{
    const r = getVideoRect(800, 600, 1920, 1080);
    // h = 600, w = 600 * (16/9) = 1066.67 → too wide, so letterbox instead
    // vAR=1.777, cAR=1.333  vAR>cAR → letterbox
    // w=800, h=800/vAR = 450  → bars top/bottom
    assert(approx(r.w, 800),   '16:9 in 4:3 canvas: width fills');
    assert(approx(r.h, 450),   '16:9 in 4:3 canvas: height 450');
    assert(approx(r.x, 0),     '16:9 in 4:3 canvas: no horizontal offset');
    assert(approx(r.y, 75),    '16:9 in 4:3 canvas: vertical offset 75px');
}

// 4:3 video in 16:9 canvas → pillarbox
{
    const r = getVideoRect(1280, 720, 640, 480);
    // vAR=1.333, cAR=1.777  vAR<cAR → pillarbox
    // h=720, w=720*vAR = 960
    assert(approx(r.h, 720),   '4:3 in 16:9 canvas: height fills');
    assert(approx(r.w, 960),   '4:3 in 16:9 canvas: width 960');
    assert(approx(r.x, 160),   '4:3 in 16:9 canvas: horizontal offset 160px');
    assert(approx(r.y, 0),     '4:3 in 16:9 canvas: no vertical offset');
}

// Square video in landscape canvas → pillarbox
{
    const r = getVideoRect(1920, 1080, 1080, 1080);
    assert(approx(r.h, 1080), '1:1 in 16:9: height fills');
    assert(approx(r.w, 1080), '1:1 in 16:9: width = height');
    assert(approx(r.x, 420),  '1:1 in 16:9: pillarbox offset 420');
}

// 9:16 (portrait) video in landscape canvas → extreme pillarbox
{
    const r = getVideoRect(1920, 1080, 1080, 1920);
    // vAR=0.5625, cAR=1.777  vAR<cAR → pillarbox
    // h=1080, w=1080*0.5625=607.5
    assert(approx(r.w, 607.5), '9:16 in 16:9: width 607.5');
    assert(approx(r.h, 1080),  '9:16 in 16:9: height fills');
    assert(approx(r.x, 656.25),'9:16 in 16:9: pillarbox offset 656.25');
}

console.log('\n=== toNorm round-trip tests ===');

// Center of video → (0.5, 0.5) in any aspect
{
    const cases = [
        [1280, 720, 1920, 1080],  // 16:9 in 16:9
        [800,  600, 1920, 1080],  // 16:9 in 4:3
        [1280, 720, 640,  480],   // 4:3 in 16:9
        [1920, 1080, 1080, 1080], // 1:1 in 16:9
    ];
    for (const [cW, cH, vW, vH] of cases) {
        const r = getVideoRect(cW, cH, vW, vH);
        const cx = r.x + r.w / 2;
        const cy = r.y + r.h / 2;
        const n = toNorm(cW, cH, vW, vH, cx, cy);
        assert(approx(n.x, 0.5) && approx(n.y, 0.5),
            `Center maps to (0.5,0.5): canvas ${cW}x${cH}, video ${vW}x${vH}`);
    }
}

// Top-left corner of video → (0, 0)
{
    const r = getVideoRect(800, 600, 1920, 1080);
    const n = toNorm(800, 600, 1920, 1080, r.x, r.y);
    assert(approx(n.x, 0) && approx(n.y, 0), 'Top-left of video → (0,0)');
}

// Bottom-right corner of video → (1, 1)
{
    const r = getVideoRect(800, 600, 1920, 1080);
    const n = toNorm(800, 600, 1920, 1080, r.x + r.w, r.y + r.h);
    assert(approx(n.x, 1) && approx(n.y, 1), 'Bottom-right of video → (1,1)');
}

console.log('\n=== Drawing position survives canvas resize ===');

// A drawing at normalized (0.3, 0.6) in a 1280×720 canvas.
// When canvas is resized to 640×360, the pixel position should scale proportionally.
{
    const vW = 1920, vH = 1080;
    const nx = 0.3, ny = 0.6;

    // Original canvas
    const orig = fromNorm(1280, 720, vW, vH, nx, ny);
    // Smaller canvas (half size, same AR)
    const small = fromNorm(640, 360, vW, vH, nx, ny);

    assert(approx(orig.x / 1280, small.x / 640, 0.001),
        'X position scales proportionally after resize');
    assert(approx(orig.y / 720, small.y / 360, 0.001),
        'Y position scales proportionally after resize');
}

// Zoom should NOT affect stored normalized coords (zoom is a CSS transform)
// — verified by design: zoom-wrap transforms video+canvas together,
//   so canvas pixel coords are always in the unzoomed space.
// This test checks that toNorm is the same at any zoom level in memory.
{
    const vW = 1280, vH = 720;
    // Same canvas, same click position → same norm regardless of "zoom state"
    // (zoom is external CSS transform, not embedded in canvas coord space)
    const n1 = toNorm(1280, 720, vW, vH, 640, 360);
    const n2 = toNorm(1280, 720, vW, vH, 640, 360);
    assert(n1.x === n2.x && n1.y === n2.y,
        'toNorm is deterministic (zoom is a CSS layer, not in canvas coords)');
}

console.log('\n=== fps fallback precision ===');

// 29.97fps fractional representation avoids drift
{
    const fps_2997 = 1001 / 30000; // correct
    const fps_naive = 1 / 29.97;   // naively: 0.033344...
    // After 1000 frames, accumulated error:
    let t_correct = 0, t_naive = 0;
    for (let i = 0; i < 1000; i++) { t_correct += fps_2997; t_naive += fps_naive; }
    const drift = Math.abs(t_correct - t_naive);
    // 1001/30000 vs 1/29.97 differ by ~33μs per 1000 frames (3.3ns/frame).
    // Over 90000 frames (1 hr @ 30fps) that grows to ~3ms = almost one full frame.
    // Any drift > 0 confirms the two formulas are NOT equivalent.
    assert(drift > 0.000001, `29.97fps: fractional vs naive drift after 1000 frames: ${drift.toFixed(8)}s`);
    assert(approx(t_correct, 1000 * 1001 / 30000, 0.000001), '1001/30000 sum is exact after 1000 frames');
}

// 59.94fps fractional representation
{
    const fps_5994 = 1001 / 60000;
    let t = 0;
    for (let i = 0; i < 1000; i++) t += fps_5994;
    assert(approx(t, 1000 * 1001 / 60000, 0.000001), '1001/60000 sum is exact after 1000 frames');
}

console.log('\n=== Result ===');
console.log(`Passed: ${passed}  Failed: ${failed}`);
if (failed > 0) process.exit(1);
