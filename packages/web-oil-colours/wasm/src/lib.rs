//! Wet oil paint core.
//!
//! Plain `cdylib` — no wasm-bindgen. Everything crosses the boundary as scalars
//! or through linear memory, which is all a numeric solver needs.
//!
//! The one thing that makes paint read as paint rather than as a smudged photo
//! is that pigment mixes *subtractively*: blue and yellow give green, not grey.
//! So colour is not stored as RGB here. Each cell carries Kubelka-Munk
//! absorption/scattering ratios (K/S) per channel, scaled by how much paint sits
//! there. The KM mixture law says a blend's K/S is the concentration-weighted
//! mean of its parts' — which is exactly what advecting `mass` and `mass * K/S`
//! as separate conserved quantities computes. Mixing is not a step in this
//! solver; it is what transport does when colour is stored this way.
//!
//! Motion is the thin-film (lubrication) limit of Stokes flow: oil paint at a
//! millimetre scale has a Reynolds number near zero, so there is no inertia to
//! integrate. Velocity is a balance struck fresh each step between what the
//! brush drags along and where thickness wants to level out.

use core::ptr::addr_of_mut;

/// Per-step velocity retention. Paint keeps creeping for a moment after the
/// cursor has gone, then stops — it does not coast like water.
const DRAG_DECAY: f32 = 0.86;
/// How hard a thick ridge pushes itself flat. This is the lubrication term; it
/// is what raises a bow wave in front of a stroke and lets it slump afterwards.
const LEVEL: f32 = 46.0;
/// Yield stress, as a thickness gradient per cell. Oil paint is a Bingham
/// plastic: below a threshold shear it does not creep at all. That is the only
/// reason impasto peaks stay standing overnight instead of slumping into a
/// puddle, and here it is also what lets the canvas reach a true rest — with
/// pure lubrication every slope keeps flowing forever and nothing can idle.
const YIELD: f32 = 0.15;
/// Below this flow speed (cells/second) the canvas is declared at rest and
/// velocity is snapped to zero. Creep that slow — under a tenth of a pixel a
/// second — is invisible, and without the snap the yield surface is approached
/// asymptotically, so the simulation would never stop and never idle.
const V_REST: f32 = 0.35;
/// Viscous coupling between neighbouring cells, per step. Oil is sticky: a cell
/// that moves drags its neighbours with it, which is why a stroke is wider than
/// the brush that made it.
const VISCOSITY: f32 = 0.22;
/// Pigment migration across a wet boundary, per second. Kept low deliberately:
/// most of the blending in wet-into-wet oil is mechanical, done by the brush
/// dragging one colour through another, and diffusion fast enough to be the
/// main event also erases the bristle marks within a second.
const BLEED: f32 = 2.2;
/// Paint is incompressible enough that a cell cannot hold arbitrarily much.
const MAX_MASS: f32 = 3.2;
/// Speed above which the brush no longer drags any harder. Without this a
/// flicked cursor injects a velocity the advection step cannot resolve and the
/// stroke tears into stripes.
const MAX_SPEED: f32 = 900.0;
/// Bristles across the brush's width. Deliberately few: the grid can only carry
/// a feature two cells wide, and a comb finer than about four cells is smoothed
/// away by advection within a second of being laid. Seven coarse furrows
/// survive and read as a brush; fifteen fine ones read as a smooth ribbon.
const BRISTLES: f32 = 7.0;
/// A brush is an edge, not a dot. Its footprint is this fraction as long along
/// the stroke as it is wide across it, which is what makes a mark that has a
/// direction instead of a round blot.
const BRUSH_LENGTH: f32 = 0.34;
/// The thinnest a `relief` pass will lay paint, as a fraction of `amount`.
/// Without a floor the shadows are not laid at all and read as bare canvas
/// rather than as thin dark paint.
const RELIEF_FLOOR: f32 = 0.3;
/// Reflectance is clamped before inverting to K/S: pure 0 or 1 are infinities.
const R_MIN: f32 = 0.006;
const R_MAX: f32 = 0.994;

/// Studio palette, sRGB. Real pigment names because the mixing behaviour is
/// what the names actually mean — ivory black swallows titanium white because
/// its K/S really is two orders of magnitude larger.
const PALETTE: [[f32; 3]; 10] = [
    [0.961, 0.957, 0.933], // titanium white
    [0.988, 0.761, 0.078], // cadmium yellow
    [0.871, 0.188, 0.125], // cadmium red
    [0.549, 0.078, 0.173], // alizarin crimson
    [0.125, 0.173, 0.549], // ultramarine
    [0.094, 0.486, 0.698], // cerulean
    [0.047, 0.431, 0.361], // viridian
    [0.776, 0.557, 0.157], // yellow ochre
    [0.337, 0.204, 0.141], // burnt umber
    [0.102, 0.094, 0.102], // ivory black
];

struct State {
    w: usize,
    h: usize,
    /// Paint volume per cell. 0 is bare canvas, 1 is an ordinary covering layer.
    mass: Vec<f32>,
    /// Pigment load: mass * K/S, one field per channel. Advecting this rather
    /// than a colour is what makes the mixing subtractive.
    kr: Vec<f32>,
    kg: Vec<f32>,
    kb: Vec<f32>,
    /// Flow velocity, in cells per second.
    vx: Vec<f32>,
    vy: Vec<f32>,
    /// Destination buffers; every pass writes here and swaps.
    s_mass: Vec<f32>,
    s_kr: Vec<f32>,
    s_kg: Vec<f32>,
    s_kb: Vec<f32>,
    /// Interleaved half-float output: [R, G, B, mass] per cell. R/G/B are linear
    /// reflectance, so the renderer can light them without undoing a gamma.
    out: Vec<u16>,
    /// Scratch the host fills with RGBA8 before calling `stamp`.
    incoming: Vec<u8>,
    /// Scales bleed and levelling together: 0 is paint gone tacky, 1 is fresh
    /// out of the tube.
    wetness: f32,
}

static mut STATE: Option<State> = None;

#[inline(always)]
#[allow(static_mut_refs)]
fn st() -> &'static mut State {
    unsafe { (*addr_of_mut!(STATE)).as_mut().unwrap() }
}

// --- Kubelka-Munk -----------------------------------------------------------

/// Reflectance of an opaque layer -> its absorption/scattering ratio.
#[inline]
fn ks_of(r: f32) -> f32 {
    let r = r.clamp(R_MIN, R_MAX);
    (1.0 - r) * (1.0 - r) / (2.0 * r)
}

/// ...and back again. The positive root of the KM reflectance relation.
#[inline]
fn r_of(ks: f32) -> f32 {
    let ks = ks.max(0.0);
    1.0 + ks - (ks * ks + 2.0 * ks).sqrt()
}

#[inline]
fn srgb_to_linear(c: f32) -> f32 {
    if c <= 0.04045 {
        c / 12.92
    } else {
        ((c + 0.055) / 1.055).powf(2.4)
    }
}

/// f32 -> IEEE half. Values here are clamped reflectances and thicknesses, so
/// subnormals flush to zero and anything huge saturates rather than becoming a
/// NaN the GPU would smear across the canvas.
#[inline]
fn half(x: f32) -> u16 {
    let bits = x.to_bits();
    let sign = ((bits >> 16) & 0x8000) as u16;
    let exp = ((bits >> 23) & 0xff) as i32 - 127 + 15;
    let mant = ((bits >> 13) & 0x3ff) as u16;
    if exp <= 0 {
        sign
    } else if exp >= 31 {
        sign | 0x7bff
    } else {
        sign | ((exp as u16) << 10) | mant
    }
}

// --- lifecycle --------------------------------------------------------------

/// Allocate a grid and lay the opening palette on it.
#[no_mangle]
pub extern "C" fn init(w: u32, h: u32, seed: u32) {
    let (w, h) = (w.max(8) as usize, h.max(8) as usize);
    let n = w * h;
    unsafe {
        STATE = Some(State {
            w,
            h,
            mass: vec![0.0; n],
            kr: vec![0.0; n],
            kg: vec![0.0; n],
            kb: vec![0.0; n],
            vx: vec![0.0; n],
            vy: vec![0.0; n],
            s_mass: vec![0.0; n],
            s_kr: vec![0.0; n],
            s_kg: vec![0.0; n],
            s_kb: vec![0.0; n],
            out: vec![0; n * 4],
            incoming: vec![0; n * 4],
            wetness: 1.0,
        });
    }
    reseed(seed);
}

#[no_mangle]
pub extern "C" fn out_ptr() -> *const u16 {
    st().out.as_ptr()
}

#[no_mangle]
pub extern "C" fn out_len() -> usize {
    st().out.len()
}

/// Where the host writes an image for `stamp`. RGBA8, at most one grid's worth.
#[no_mangle]
pub extern "C" fn in_ptr() -> *mut u8 {
    st().incoming.as_mut_ptr()
}

#[no_mangle]
pub extern "C" fn in_len() -> usize {
    st().incoming.len()
}

#[no_mangle]
pub extern "C" fn set_wetness(v: f32) {
    st().wetness = v.clamp(0.0, 1.5);
}

/// Mean flow speed. The worker idles the whole simulation below a threshold.
#[no_mangle]
pub extern "C" fn energy() -> f32 {
    let s = st();
    let mut acc = 0.0f32;
    for i in 0..s.vx.len() {
        acc += s.vx[i].abs() + s.vy[i].abs();
    }
    acc / s.vx.len() as f32
}

// --- opening state ----------------------------------------------------------

/// Deterministic value noise, so the same seed always lays the same palette.
#[inline]
fn hash2(x: i32, y: i32, seed: u32) -> f32 {
    let mut n = (x as u32).wrapping_mul(0x9e37_79b9) ^ (y as u32).wrapping_mul(0x85eb_ca6b) ^ seed;
    n ^= n >> 15;
    n = n.wrapping_mul(0x2545_f491);
    n ^= n >> 13;
    (n & 0xff_ffff) as f32 / 16_777_215.0
}

fn noise(x: f32, y: f32, seed: u32) -> f32 {
    let (xi, yi) = (x.floor(), y.floor());
    let (fx, fy) = (x - xi, y - yi);
    let (sx, sy) = (fx * fx * (3.0 - 2.0 * fx), fy * fy * (3.0 - 2.0 * fy));
    let (xi, yi) = (xi as i32, yi as i32);
    let a = hash2(xi, yi, seed);
    let b = hash2(xi + 1, yi, seed);
    let c = hash2(xi, yi + 1, seed);
    let d = hash2(xi + 1, yi + 1, seed);
    (a + (b - a) * sx) + ((c + (d - c) * sx) - (a + (b - a) * sx)) * sy
}

/// Lay the canvas out again: a ground coat, then blobs of palette colour large
/// enough that a single cursor stroke crosses two or three of them.
#[no_mangle]
pub extern "C" fn reseed(seed: u32) {
    let s = st();
    let (w, h) = (s.w, s.h);
    let short = w.min(h) as f32;

    // Ground: a thin, warm, uneven imprimatura — a stain on the linen, not a
    // layer of paint. It has to stay thin: under Kubelka-Munk every dab laid on
    // top mixes with it by mass, so a heavy ground would mute the whole palette
    // into mud before the cursor ever touched it.
    let ground = [
        srgb_to_linear(0.478),
        srgb_to_linear(0.416),
        srgb_to_linear(0.353),
    ];
    let g_ks = [ks_of(ground[0]), ks_of(ground[1]), ks_of(ground[2])];

    for y in 0..h {
        for x in 0..w {
            let i = y * w + x;
            let n = noise(x as f32 * 0.035, y as f32 * 0.035, seed ^ 0x51ed);
            let m = 0.24 + 0.14 * n;
            s.mass[i] = m;
            s.kr[i] = m * g_ks[0];
            s.kg[i] = m * g_ks[1];
            s.kb[i] = m * g_ks[2];
            s.vx[i] = 0.0;
            s.vy[i] = 0.0;
        }
    }

    // 22 dabs. Each is an ellipse with a soft edge and a little noise pushed
    // through its falloff, so the boundaries are ragged the way a loaded brush
    // leaves them rather than airbrush-smooth.
    for b in 0..20u32 {
        let r0 = hash2(b as i32, 11, seed);
        let r1 = hash2(b as i32, 23, seed);
        let r2 = hash2(b as i32, 37, seed);
        let r3 = hash2(b as i32, 53, seed);
        let r4 = hash2(b as i32, 71, seed);
        let r5 = hash2(b as i32, 97, seed);

        let cx = r0 * w as f32;
        let cy = r1 * h as f32;
        let rx = short * (0.12 + 0.18 * r2);
        let ry = short * (0.12 + 0.18 * r3);
        let angle = r4 * core::f32::consts::TAU;
        let (sa, ca) = (angle.sin(), angle.cos());
        let pigment = PALETTE[(r5 * PALETTE.len() as f32) as usize % PALETTE.len()];
        let p_ks = [
            ks_of(srgb_to_linear(pigment[0])),
            ks_of(srgb_to_linear(pigment[1])),
            ks_of(srgb_to_linear(pigment[2])),
        ];

        let x0 = (cx - rx - ry).max(0.0) as usize;
        let x1 = ((cx + rx + ry) as usize + 1).min(w);
        let y0 = (cy - rx - ry).max(0.0) as usize;
        let y1 = ((cy + rx + ry) as usize + 1).min(h);

        for y in y0..y1 {
            for x in x0..x1 {
                let dx = x as f32 - cx;
                let dy = y as f32 - cy;
                let u = (dx * ca + dy * sa) / rx;
                let v = (-dx * sa + dy * ca) / ry;
                let d = (u * u + v * v).sqrt()
                    + 0.22 * (noise(x as f32 * 0.06, y as f32 * 0.06, seed ^ b) - 0.5);
                if d >= 1.0 {
                    continue;
                }
                let t = 1.0 - d;
                let f = t * t * (3.0 - 2.0 * t);
                let i = y * w + x;
                // Loading the brush: adding paint, not replacing it, so dabs
                // that overlap already carry a mixture at their seam.
                let add = f * (0.85 + 0.55 * noise(x as f32 * 0.09, y as f32 * 0.09, seed ^ 0x2a));
                s.mass[i] = (s.mass[i] + add).min(MAX_MASS);
                s.kr[i] += add * p_ks[0];
                s.kg[i] += add * p_ks[1];
                s.kb[i] += add * p_ks[2];
            }
        }
    }
    encode();
}

/// Scrape the canvas back to bare linen: no paint, no pigment, no flow.
///
/// What is left is not white — it is nothing, and the renderer shows the weave
/// of the canvas itself. Anything laid on it afterwards is the only paint
/// there is, which is the point: a component on an empty canvas has nothing to
/// mix with but itself and whatever the cursor drags it into.
#[no_mangle]
pub extern "C" fn clear() {
    let s = st();
    s.mass.fill(0.0);
    s.kr.fill(0.0);
    s.kg.fill(0.0);
    s.kb.fill(0.0);
    s.vx.fill(0.0);
    s.vy.fill(0.0);
    encode();
}

// --- brush ------------------------------------------------------------------

/// Spacing between stamps along a segment, as a fraction of the brush radius.
const STAMP_SPACING: f32 = 0.35;
/// Most stamps of one segment that can land on a single cell: a cell stays
/// inside the footprint for a stretch of 2 * radius, and stamps are laid every
/// STAMP_SPACING * radius along the path.
const STAMPS_PER_CELL: f32 = 2.0 / STAMP_SPACING;

/// Number of stamps needed to lay a continuous segment at this radius.
#[inline]
fn stamps(len: f32, radius: f32) -> usize {
    ((len / (radius * STAMP_SPACING)).ceil() as usize).clamp(1, 96)
}

/// Walk the cells under one brush stamp, handing each its weight.
///
/// The footprint is an ellipse laid across the direction of travel and combed
/// into bristles. The bristle a cell belongs to is indexed by how far across
/// the stroke it sits, never by where it is on the canvas — so as the brush
/// advances, every cell down a given streak draws the same bristle and gets the
/// same load. That is the whole trick: it turns what would be per-stamp noise
/// into the continuous ribbed furrows a loaded brush actually leaves, and it
/// keeps them attached to the brush through a curve.
#[derive(Clone, Copy)]
struct Stamp {
    /// Centre, in cells.
    cx: f32,
    cy: f32,
    /// Unit heading: the direction the brush is travelling.
    dx: f32,
    dy: f32,
    /// Half-width, across the stroke, in cells.
    radius: f32,
    /// Picks the bristle loads; constant for one stroke.
    seed: u32,
}

#[inline]
fn footprint(w: usize, h: usize, s: Stamp, mut visit: impl FnMut(usize, f32)) {
    let Stamp {
        cx,
        cy,
        dx,
        dy,
        radius,
        seed,
    } = s;
    let half = (radius * BRUSH_LENGTH).max(1.0);
    let reach = radius.max(half) + 1.0;
    let lo_x = (cx - reach).max(0.0) as usize;
    let hi_x = ((cx + reach).max(0.0) as usize + 1).min(w);
    let lo_y = (cy - reach).max(0.0) as usize;
    let hi_y = ((cy + reach).max(0.0) as usize + 1).min(h);
    let spacing = (radius * 2.0 / BRISTLES).max(1.4);

    for y in lo_y..hi_y {
        for x in lo_x..hi_x {
            let ex = x as f32 - cx;
            let ey = y as f32 - cy;
            let u = -ex * dy + ey * dx; // across the stroke
            let v = ex * dx + ey * dy; // along it
            let nu = u / radius;
            let nv = v / half;
            let d = (nu * nu + nv * nv).sqrt();
            if d >= 1.0 {
                continue;
            }
            let t = 1.0 - d;
            let mut g = t * t * (3.0 - 2.0 * t);

            // The comb: each bristle carries its own load, and stands proud of
            // the gap beside it.
            let sc = u / spacing;
            let b = sc.floor();
            let frac = sc - b;
            let ridge = 1.0 - (2.0 * frac - 1.0) * (2.0 * frac - 1.0);
            let load = 0.16 + 0.84 * hash2(b as i32, 0, seed);
            g *= load * (0.3 + 0.7 * ridge);
            if g > 0.0 {
                visit(y * w + x, g);
            }
        }
    }
}

/// A unit heading, falling back to the +x axis when the caller has none yet.
#[inline]
fn heading(dx: f32, dy: f32) -> (f32, f32) {
    let l = (dx * dx + dy * dy).sqrt();
    if l > 1e-4 {
        (dx / l, dy / l)
    } else {
        (1.0, 0.0)
    }
}

/// Drag paint along a segment. `(ux, uy)` is the cursor's velocity in cells per
/// second; cells under the brush relax toward it rather than accumulating it,
/// which is the no-slip condition a real bristle imposes and also the reason a
/// slow scrub does not build up into an explosion.
#[no_mangle]
pub extern "C" fn smear(
    x0: f32,
    y0: f32,
    x1: f32,
    y1: f32,
    ux: f32,
    uy: f32,
    hx: f32,
    hy: f32,
    radius: f32,
    grip: f32,
    seed: u32,
) {
    let s = st();
    let (w, h) = (s.w, s.h);
    let radius = radius.max(1.5);
    let (dx, dy) = heading(hx, hy);

    let speed = (ux * ux + uy * uy).sqrt();
    let (ux, uy) = if speed > MAX_SPEED {
        (ux * MAX_SPEED / speed, uy * MAX_SPEED / speed)
    } else {
        (ux, uy)
    };

    let len = ((x1 - x0).powi(2) + (y1 - y0).powi(2)).sqrt();
    let n = stamps(len, radius);
    // Each stamp pulls a cell part of the way to the cursor's velocity, and the
    // pass as a whole has to converge on it however the pointer was sampled.
    // So one segment is worth the share of a full pass it actually covers —
    // a cell is under the brush for 2 * radius of travel — split between the
    // stamps of this segment that reach that cell. Normalising by the segment's
    // own stamp count instead would make a flick, which arrives as one long
    // segment, grip in inverse proportion to its length: the harder you swipe,
    // the less paint would move.
    // Each stamp closes the same fraction of the remaining gap, so their effect
    // compounds: k stamps of strength f leave (1-f)^k of the gap. Inverting
    // that gives the per-stamp strength for which a whole pass lands on `grip`
    // however it was cut up. A cell is under the brush for 2 * radius of
    // travel, so one segment is worth `share` of a pass, delivered by `reach`
    // of its stamps — hence k = reach / share for the pass as a whole.
    let share = (len / (2.0 * radius)).clamp(1e-3, 1.0);
    let reach = (n as f32).min(STAMPS_PER_CELL);
    let grip = 1.0 - (1.0 - grip.clamp(0.0, 1.0)).powf(share / reach);

    for k in 0..n {
        let t = (k as f32 + 0.5) / n as f32;
        let cx = x0 + (x1 - x0) * t;
        let cy = y0 + (y1 - y0) * t;
        footprint(
            w,
            h,
            Stamp {
                cx,
                cy,
                dx,
                dy,
                radius,
                seed,
            },
            |i, g| {
                let f = g * grip;
                s.vx[i] += (ux - s.vx[i]) * f;
                s.vy[i] += (uy - s.vy[i]) * f;
            },
        );
    }
}

/// Lay new paint along a segment. `amount` is already scaled by the frame's dt
/// by the caller, so holding still loads the canvas at a rate, not per event.
#[no_mangle]
pub extern "C" fn deposit(
    x0: f32,
    y0: f32,
    x1: f32,
    y1: f32,
    hx: f32,
    hy: f32,
    radius: f32,
    r: f32,
    g: f32,
    b: f32,
    amount: f32,
    seed: u32,
) {
    let s = st();
    let (w, h) = (s.w, s.h);
    let radius = radius.max(1.5);
    let (dx, dy) = heading(hx, hy);
    let p_ks = [
        ks_of(srgb_to_linear(r)),
        ks_of(srgb_to_linear(g)),
        ks_of(srgb_to_linear(b)),
    ];

    let n = stamps(((x1 - x0).powi(2) + (y1 - y0).powi(2)).sqrt(), radius);
    let amount = amount / n as f32;

    for k in 0..n {
        let t = (k as f32 + 0.5) / n as f32;
        let cx = x0 + (x1 - x0) * t;
        let cy = y0 + (y1 - y0) * t;
        footprint(
            w,
            h,
            Stamp {
                cx,
                cy,
                dx,
                dy,
                radius,
                seed,
            },
            |i, g| {
                let add = g * amount;
                let m = s.mass[i];
                // A cell can only hold so much. Whatever will not fit is not
                // refused — a loaded brush pressed into thick wet paint pushes
                // the old colour aside and takes its place. So the overflow is
                // spent displacing pigment instead of adding volume, which is
                // also the only reason painting on a full canvas does anything.
                let gain = add.min((MAX_MASS - m).max(0.0));
                let displaced = add - gain;
                let keep = if m > 1e-6 {
                    ((m - displaced) / m).clamp(0.0, 1.0)
                } else {
                    0.0
                };
                let laid = gain + displaced;
                s.mass[i] = m + gain;
                s.kr[i] = s.kr[i] * keep + laid * p_ks[0];
                s.kg[i] = s.kg[i] * keep + laid * p_ks[1];
                s.kb[i] = s.kb[i] * keep + laid * p_ks[2];
            },
        );
    }
}

/// Lay an RGBA8 image into the paint, one pixel to one cell, at grid rect
/// `(x, y, w, h)`. The image's alpha is how much paint that pixel is worth.
///
/// This is how a user interface gets made of the stuff: a component's surface
/// is deposited into the pigment field itself rather than composited over it,
/// so from this point on it is paint like any other — the cursor drags it, it
/// mixes subtractively with whatever it is dragged into, it bleeds at its own
/// edges, and its thickness catches the light. Nothing downstream needs to know
/// a control was ever involved.
///
/// `relief` decides how much of the paint's thickness follows the picture's
/// own lightness, 0 for none and 1 for all of it. A photograph laid at a single
/// thickness has no impasto for the light to catch and comes out looking like a
/// photograph; a painter puts the paint on thickest in the lights, and doing
/// the same here is what gives it a surface. It costs nothing in colour:
/// reflectance comes from K/S divided by mass, so scaling both leaves the hue
/// exactly where it was and moves only the height.
///
/// The image's first row is its top; the grid's first row is its bottom, so the
/// rows are read in reverse.
#[no_mangle]
pub extern "C" fn stamp(x: i32, y: i32, w: u32, h: u32, amount: f32, relief: f32) {
    let s = st();
    let (gw, gh) = (s.w as i32, s.h as i32);
    let (w, h) = (w as i32, h as i32);

    for row in 0..h {
        let gy = y + (h - 1 - row);
        if gy < 0 || gy >= gh {
            continue;
        }
        for col in 0..w {
            let gx = x + col;
            if gx < 0 || gx >= gw {
                continue;
            }
            let src = ((row * w + col) * 4) as usize;
            if src + 3 >= s.incoming.len() {
                continue;
            }
            let a = f32::from(s.incoming[src + 3]) / 255.0;
            if a <= 0.004 {
                continue;
            }
            let srgb = [
                f32::from(s.incoming[src]) / 255.0,
                f32::from(s.incoming[src + 1]) / 255.0,
                f32::from(s.incoming[src + 2]) / 255.0,
            ];
            let p_ks = [
                ks_of(srgb_to_linear(srgb[0])),
                ks_of(srgb_to_linear(srgb[1])),
                ks_of(srgb_to_linear(srgb[2])),
            ];
            // Perceived lightness, from the gamma-encoded values, not linear
            // luminance: linear puts a mid grey at 0.22, so at full relief the
            // mid-tones would be laid at a fifth of the paint and the shadows
            // at almost none.
            let light = 0.2126 * srgb[0] + 0.7152 * srgb[1] + 0.0722 * srgb[2];

            let i = (gy * gw + gx) as usize;
            let relief = relief.clamp(0.0, 1.0);
            let thickness = (1.0 - relief * (1.0 - light)).max(RELIEF_FLOOR);
            let add = a * amount * thickness;
            let m = s.mass[i];
            // Same rule as the brush: what will not fit displaces what is there
            // rather than being refused.
            let gain = add.min((MAX_MASS - m).max(0.0));
            let displaced = add - gain;
            let keep = if m > 1e-6 {
                ((m - displaced) / m).clamp(0.0, 1.0)
            } else {
                0.0
            };
            let laid = gain + displaced;
            s.mass[i] = m + gain;
            s.kr[i] = s.kr[i] * keep + laid * p_ks[0];
            s.kg[i] = s.kg[i] * keep + laid * p_ks[1];
            s.kb[i] = s.kb[i] * keep + laid * p_ks[2];
        }
    }
    encode();
}

// --- solver -----------------------------------------------------------------

/// Velocity for the coming step: level out thickness, spread the brush's pull
/// to neighbours, then bleed off what the medium's stickiness eats.
fn relax(dt: f32) {
    let s = st();
    let (w, h) = (s.w, s.h);
    let level = LEVEL * s.wetness * dt;

    for y in 0..h {
        for x in 0..w {
            let i = y * w + x;
            // Thickness gradient. Central difference, clamped at the border so
            // paint neither leaks off the canvas nor piles against it.
            let xm = if x > 0 { i - 1 } else { i };
            let xp = if x + 1 < w { i + 1 } else { i };
            let ym = if y > 0 { i - w } else { i };
            let yp = if y + 1 < h { i + w } else { i };
            let gx = (s.mass[xp] - s.mass[xm]) * 0.5;
            let gy = (s.mass[yp] - s.mass[ym]) * 0.5;
            let g = (gx * gx + gy * gy).sqrt();
            if g > YIELD {
                // Only the stress above the yield point drives flow.
                let f = level * (g - YIELD) / g;
                s.vx[i] -= f * gx;
                s.vy[i] -= f * gy;
            }
        }
    }

    // Viscous smoothing, in place. Gauss-Seidel rather than Jacobi: it needs no
    // second buffer, and the half-cell asymmetry it introduces is far below
    // what a viewer could see in a field this diffuse.
    // ponytail: in-place sweep; swap for a Jacobi pass with scratch if the
    // directional bias ever shows up in a stroke.
    let visc = VISCOSITY;
    for y in 0..h {
        for x in 0..w {
            let i = y * w + x;
            let xm = if x > 0 { i - 1 } else { i };
            let xp = if x + 1 < w { i + 1 } else { i };
            let ym = if y > 0 { i - w } else { i };
            let yp = if y + 1 < h { i + w } else { i };
            let ax = (s.vx[xm] + s.vx[xp] + s.vx[ym] + s.vx[yp]) * 0.25;
            let ay = (s.vy[xm] + s.vy[xp] + s.vy[ym] + s.vy[yp]) * 0.25;
            s.vx[i] += (ax - s.vx[i]) * visc;
            s.vy[i] += (ay - s.vy[i]) * visc;
        }
    }

    // No inertia to carry over, so decay is a plain per-step retention raised to
    // however much of a step actually elapsed.
    let decay = DRAG_DECAY.powf(dt * 60.0);
    for i in 0..s.vx.len() {
        let (x, y) = (s.vx[i] * decay, s.vy[i] * decay);
        let rest = x.abs() + y.abs() < V_REST;
        s.vx[i] = if rest { 0.0 } else { x };
        s.vy[i] = if rest { 0.0 } else { y };
    }

    // The canvas edge is a wall: paint stops there, it does not flow off.
    for x in 0..w {
        s.vy[x] = s.vy[x].max(0.0);
        let i = (h - 1) * w + x;
        s.vy[i] = s.vy[i].min(0.0);
    }
    for y in 0..h {
        let i = y * w;
        s.vx[i] = s.vx[i].max(0.0);
        let i = y * w + w - 1;
        s.vx[i] = s.vx[i].min(0.0);
    }
}

/// Semi-Lagrangian transport of paint and pigment. Backward tracing is
/// unconditionally stable, and the smearing it is usually criticised for is
/// here a feature: it is the blending along a stroke.
fn advect(dt: f32) {
    let s = st();
    let State {
        w,
        h,
        mass,
        kr,
        kg,
        kb,
        vx,
        vy,
        s_mass,
        s_kr,
        s_kg,
        s_kb,
        ..
    } = s;
    let (w, h) = (*w, *h);
    let fw = (w - 1) as f32;
    let fh = (h - 1) as f32;

    for y in 0..h {
        for x in 0..w {
            let i = y * w + x;
            let px = (x as f32 - vx[i] * dt).clamp(0.0, fw);
            let py = (y as f32 - vy[i] * dt).clamp(0.0, fh);
            let x0 = px as usize;
            let y0 = py as usize;
            let x1 = (x0 + 1).min(w - 1);
            let y1 = (y0 + 1).min(h - 1);
            let tx = px - x0 as f32;
            let ty = py - y0 as f32;
            let (a, b) = (y0 * w + x0, y0 * w + x1);
            let (c, d) = (y1 * w + x0, y1 * w + x1);
            let w00 = (1.0 - tx) * (1.0 - ty);
            let w10 = tx * (1.0 - ty);
            let w01 = (1.0 - tx) * ty;
            let w11 = tx * ty;

            s_mass[i] =
                (mass[a] * w00 + mass[b] * w10 + mass[c] * w01 + mass[d] * w11).min(MAX_MASS);
            s_kr[i] = kr[a] * w00 + kr[b] * w10 + kr[c] * w01 + kr[d] * w11;
            s_kg[i] = kg[a] * w00 + kg[b] * w10 + kg[c] * w01 + kg[d] * w11;
            s_kb[i] = kb[a] * w00 + kb[b] * w10 + kb[c] * w01 + kb[d] * w11;
        }
    }
    core::mem::swap(mass, s_mass);
    core::mem::swap(kr, s_kr);
    core::mem::swap(kg, s_kg);
    core::mem::swap(kb, s_kb);
}

/// Bleed: pigment migrating through the binder across a wet seam. Only the
/// pigment fields diffuse — the oil film itself stays where the brush left it,
/// so a bled edge softens in colour without losing its impasto ridge.
fn bleed(dt: f32) {
    let s = st();
    let State {
        w,
        h,
        kr,
        kg,
        kb,
        s_kr,
        s_kg,
        s_kb,
        wetness,
        ..
    } = s;
    let (w, h) = (*w, *h);
    let rate = (BLEED * *wetness * dt).clamp(0.0, 0.25);
    if rate <= 0.0 {
        return;
    }

    for y in 0..h {
        for x in 0..w {
            let i = y * w + x;
            let xm = if x > 0 { i - 1 } else { i };
            let xp = if x + 1 < w { i + 1 } else { i };
            let ym = if y > 0 { i - w } else { i };
            let yp = if y + 1 < h { i + w } else { i };
            s_kr[i] = kr[i] + ((kr[xm] + kr[xp] + kr[ym] + kr[yp]) * 0.25 - kr[i]) * rate;
            s_kg[i] = kg[i] + ((kg[xm] + kg[xp] + kg[ym] + kg[yp]) * 0.25 - kg[i]) * rate;
            s_kb[i] = kb[i] + ((kb[xm] + kb[xp] + kb[ym] + kb[yp]) * 0.25 - kb[i]) * rate;
        }
    }
    core::mem::swap(kr, s_kr);
    core::mem::swap(kg, s_kg);
    core::mem::swap(kb, s_kb);
}

/// Pigment load back to linear reflectance, packed for the GPU.
fn encode() {
    let s = st();
    for i in 0..s.mass.len() {
        let m = s.mass[i].max(1e-4);
        let o = i * 4;
        s.out[o] = half(r_of(s.kr[i] / m));
        s.out[o + 1] = half(r_of(s.kg[i] / m));
        s.out[o + 2] = half(r_of(s.kb[i] / m));
        s.out[o + 3] = half(s.mass[i]);
    }
}

/// Advance `steps` fixed steps of `dt` seconds and re-encode once at the end.
#[no_mangle]
pub extern "C" fn step(dt: f32, steps: u32) {
    let dt = dt.clamp(0.0, 1.0 / 20.0);
    for _ in 0..steps {
        relax(dt);
        advect(dt);
        bleed(dt);
    }
    encode();
}
