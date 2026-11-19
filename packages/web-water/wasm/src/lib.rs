//! Water surface core: damped wave equation on a height field, plus a drift
//! (advection) field so fast pointer motion carries the surface with it.
//!
//! Plain `cdylib` — no wasm-bindgen. Everything crosses the boundary as scalars
//! or through linear memory, which is all a numeric solver needs.

use core::ptr::addr_of_mut;

/// Wave speed term: (c*dt/dx)^2. Stability for the 9-point stencil needs
/// ALPHA <= ~0.5; 0.36 keeps ripples fast but leaves headroom.
const ALPHA: f32 = 0.36;
/// Per-step energy retention of the wave. Pond water is not a bathtub: ripples
/// live for seconds, not minutes.
const WAVE_DAMP: f32 = 0.9965;
/// Drift field decay per step and how far it spreads.
const FLOW_DECAY: f32 = 0.978;
const FLOW_DIFFUSE: f32 = 0.16;
/// How fast stirred silt settles back out, per step.
const FOAM_DECAY: f32 = 0.975;
/// Width of the absorbing border, in cells, as a fraction of the short side.
const EDGE_FRACTION: f32 = 0.07;
/// Below this (cells/s) a moving point just makes ripples, not a wake. A finger
/// trailed slowly through a pond does not leave a V behind it.
const WAKE_MIN_SPEED: f32 = 220.0;

struct State {
    w: usize,
    h: usize,
    /// Cell aspect (cell_height / cell_width) so a non-square grid still makes
    /// round ripples.
    aspect: f32,
    /// height, current and previous step
    cur: Vec<f32>,
    prev: Vec<f32>,
    /// drift velocity field, in cells per second
    fu: Vec<f32>,
    fv: Vec<f32>,
    /// scratch for advection and diffusion
    tmp_a: Vec<f32>,
    tmp_b: Vec<f32>,
    /// surface agitation: silt stirred up off the bed, not white foam
    foam: Vec<f32>,
    /// absorbing-border multiplier, precomputed per cell
    edge: Vec<f32>,
    /// interleaved half-float output: [height, foam] per cell
    out: Vec<u16>,
    /// running clock, drives the ambient breeze
    t: f32,
    /// ambient wavelet strength, 0 = dead calm
    breeze: f32,
}

static mut STATE: Option<State> = None;

#[inline(always)]
#[allow(static_mut_refs)]
fn st() -> &'static mut State {
    unsafe { (*addr_of_mut!(STATE)).as_mut().unwrap() }
}

#[inline(always)]
fn idx(w: usize, x: usize, y: usize) -> usize {
    y * w + x
}

/// Allocate (or reallocate) the grid. `cell_aspect` is cell height / cell width.
#[no_mangle]
pub extern "C" fn init(w: u32, h: u32, cell_aspect: f32) {
    let (w, h) = (w as usize, h as usize);
    let n = w * h;
    let short = w.min(h) as f32;
    let band = (short * EDGE_FRACTION).max(4.0);

    let mut edge = vec![1.0f32; n];
    for y in 0..h {
        for x in 0..w {
            let dx = (x as f32).min((w - 1 - x) as f32);
            let dy = (y as f32).min((h - 1 - y) as f32);
            let d = dx.min(dy);
            // Smooth ramp to a strong sink at the very border, so waves leave
            // the view instead of bouncing off an invisible glass wall.
            let t = (d / band).clamp(0.0, 1.0);
            let s = t * t * (3.0 - 2.0 * t);
            edge[idx(w, x, y)] = 0.86 + 0.14 * s;
        }
    }

    unsafe {
        STATE = Some(State {
            w,
            h,
            aspect: cell_aspect,
            cur: vec![0.0; n],
            prev: vec![0.0; n],
            fu: vec![0.0; n],
            fv: vec![0.0; n],
            tmp_a: vec![0.0; n],
            tmp_b: vec![0.0; n],
            foam: vec![0.0; n],
            edge,
            out: vec![0u16; n * 2],
            t: 0.0,
            breeze: 1.0,
        });
    }
}

/// Pointer to the interleaved half-float [height, foam] output.
#[no_mangle]
pub extern "C" fn out_ptr() -> *const u16 {
    st().out.as_ptr()
}

#[no_mangle]
pub extern "C" fn out_len() -> u32 {
    st().out.len() as u32
}

/// Ambient wavelet amount. 0 stills the pond, 1 is a light breeze.
#[no_mangle]
pub extern "C" fn set_breeze(v: f32) {
    st().breeze = v.clamp(0.0, 2.0);
}

/// Add a soft radial impulse. `amount` displaces the surface, `silt` clouds it.
/// Cell aspect is honoured so the footprint is round on screen, not on the grid.
#[inline]
fn deposit(s: &mut State, x: f32, y: f32, radius: f32, amount: f32, silt: f32) {
    let (w, h) = (s.w, s.h);
    let r = radius.max(0.8);
    let inv_r2 = 1.0 / (r * r);
    let ry = r / s.aspect.max(0.0001);

    let x0 = (x - r).floor().max(0.0) as usize;
    let x1 = ((x + r).ceil() as i64).min(w as i64 - 1).max(0) as usize;
    let y0 = (y - ry).floor().max(0.0) as usize;
    let y1 = ((y + ry).ceil() as i64).min(h as i64 - 1).max(0) as usize;
    if x1 < x0 || y1 < y0 {
        return;
    }

    for yy in y0..=y1 {
        let dy = (yy as f32 - y) * s.aspect;
        for xx in x0..=x1 {
            let dx = xx as f32 - x;
            let d2 = (dx * dx + dy * dy) * inv_r2;
            if d2 >= 1.0 {
                continue;
            }
            // cos^2 falloff: no hard edge, so no ringing on the rim.
            let f = 1.0 - d2;
            let f = f * f;
            let i = idx(w, xx, yy);
            s.cur[i] += amount * f;
            if silt > 0.0 {
                s.foam[i] = (s.foam[i] + silt * f).min(1.0);
            }
        }
    }
}

/// A gentle touch: press a dimple into the surface. It rebounds into a clean
/// concentric ripple because only `cur` moves, leaving `prev` as the memory of
/// a flat surface.
#[no_mangle]
pub extern "C" fn touch(x: f32, y: f32, radius: f32, strength: f32) {
    let s = st();
    deposit(s, x, y, radius, -strength, 0.02 * strength.abs());
}

/// One frame of the wake behind a point driven through the surface — the V a
/// boat leaves, with the divergent arms, the transverse crests between them,
/// and the churned trail down the middle.
///
/// The geometry here is imposed rather than emergent, and that is a deliberate
/// call. A moving point in this height field *would* raise its own cone, but
/// the field is non-dispersive: waves cross it at about 36 cells a second while
/// a flicked cursor covers several thousand, so the cone the solver produces on
/// its own is under a degree wide — a straight scar, not a wake. Reaching a
/// visible angle honestly would need the wave speed ten times higher, which
/// costs ten sub-steps a frame. So the angle is set instead: wide at a crawl,
/// tightening onto 19.5 degrees, which is the real deep-water Kelvin half-angle
/// and the one every photograph of a boat shows.
///
/// `px`/`py` are in cells; `nx`/`ny` are a unit heading in screen space;
/// `speed` is in cells per second; `advance` is how far the point has moved
/// since the last deposit; `gain` sets how pronounced the wake is.
///
/// The deposit is normalised by `advance / reach`, not by the timestep. The
/// whole V is re-laid every frame, so a point that is barely moving would
/// otherwise paint the same water sixty times a second and pile up a ridge —
/// which is exactly what a slow drag did before this. Scaled by distance
/// travelled, each patch of water receives about the same total however fast
/// the point crosses it, and a point standing still leaves nothing.
#[no_mangle]
pub extern "C" fn wake(px: f32, py: f32, nx: f32, ny: f32, speed: f32, advance: f32, gain: f32) {
    let s = st();
    if speed < WAKE_MIN_SPEED || advance <= 0.0 || gain <= 0.0 {
        return;
    }
    let long = s.w.max(s.h) as f32;
    // 0 at the speed a wake first forms, 1 once it is fully developed.
    let f = ((speed - WAKE_MIN_SPEED) / 1000.0).clamp(0.0, 1.0);

    let theta = 0.60 - 0.26 * f; // 34.4deg at a crawl -> 19.5deg at speed
    let tan_t = theta.tan();
    let reach = long * (0.05 + 0.30 * f);
    let lambda = long * (0.022 + 0.055 * f);
    // Strength rises with speed as well: just over the threshold the wake is a
    // faint crease, not a full V.
    let amount = gain * (advance / reach).min(0.5) * (0.3 + 0.7 * f);
    let inv_aspect = 1.0 / s.aspect.max(0.0001);

    // Heading, and the lateral direction, both in screen space.
    let (ux, uy) = (nx, ny);
    let (vx, vy) = (-ny, nx);
    let r_arm = (long * 0.011).max(1.6);

    // Displace by a screen-space offset from the apex, in cells.
    macro_rules! at {
        ($ox:expr, $oy:expr) => {
            (px + $ox, py + $oy * inv_aspect)
        };
    }

    // --- the divergent arms: the two lines of the V ------------------------
    let arm_amp = amount * (0.4 + 0.6 * f);
    const ARM_STEPS: usize = 24;
    for k in 1..=ARM_STEPS {
        let t = k as f32 / ARM_STEPS as f32;
        let d = reach * t;
        let env = (1.0 - t) * (1.0 - t) + 0.10;
        let lat = d * tan_t;
        for side in [-1.0f32, 1.0] {
            let (x, y) = at!(-ux * d + vx * lat * side, -uy * d + vy * lat * side);
            deposit(s, x, y, r_arm, arm_amp * env, 0.0);
        }
    }

    // --- the transverse crests, arcs stacked inside the V ------------------
    // They trail further back at the edges than on the centreline, which is the
    // curve that makes the pattern read as a wake and not as hatching.
    let crest_amp = amount * 0.55 * f;
    if crest_amp > 0.0 {
        let crests = ((reach / lambda).floor() as usize).min(6);
        for j in 1..=crests {
            let d0 = j as f32 * lambda;
            let env = (1.0 - d0 / reach).max(0.0);
            const PTS: usize = 11;
            for q in 0..PTS {
                let u = (q as f32 / (PTS - 1) as f32) * 2.0 - 1.0;
                let d = d0 * (1.0 + 0.35 * u * u);
                let lat = u * d0 * tan_t;
                let (x, y) = at!(-ux * d + vx * lat, -uy * d + vy * lat);
                deposit(s, x, y, r_arm * 1.4, crest_amp * env * (1.0 - 0.4 * u.abs()), 0.0);
            }
        }
    }

    // --- the churned trail straight behind --------------------------------
    const WASH_STEPS: usize = 14;
    for k in 1..=WASH_STEPS {
        let t = k as f32 / WASH_STEPS as f32;
        let d = reach * 0.45 * t;
        let fade = 1.0 - t;
        let (x, y) = at!(-ux * d, -uy * d);
        deposit(s, x, y, r_arm * 2.0, -amount * 0.18 * fade, amount * 3.4 * f * fade);
    }
}

/// A dragged stroke between two points: lays down a bow wave and a trough, and
/// injects drift velocity so the whole surface is pulled along. This is what
/// makes a fast flick read as "something moved through the water".
#[no_mangle]
pub extern "C" fn stroke(
    x0: f32,
    y0: f32,
    x1: f32,
    y1: f32,
    radius: f32,
    strength: f32,
    speed: f32,
) {
    let s = st();
    let (w, h) = (s.w, s.h);
    let dx = x1 - x0;
    let dy = (y1 - y0) * s.aspect;
    let len = (dx * dx + dy * dy).sqrt();

    // Direction of travel, used for the bow/trough asymmetry and the drift push.
    let (nx, ny) = if len > 1e-4 {
        (dx / len, dy / len)
    } else {
        (0.0, 0.0)
    };

    // Stamp densely enough that a fast flick is a continuous wake, not beads.
    let steps = (len / (radius * 0.35).max(0.5)).ceil().max(1.0) as usize;
    let steps = steps.min(256);
    let inv = 1.0 / steps as f32;

    // Fast strokes dig a deeper trough and throw more foam. Full wake at about
    // 800 cells/s — a flick, not a stroll.
    let wake = (speed * 0.0012).clamp(0.0, 1.6);
    let push = speed * 0.14;

    for k in 0..=steps {
        let t = k as f32 * inv;
        let px = x0 + (x1 - x0) * t;
        let py = y0 + (y1 - y0) * t;

        let r = radius.max(1.0);
        let inv_r2 = 1.0 / (r * r);
        let ry = r / s.aspect.max(0.0001);
        let bx0 = (px - r).floor().max(0.0) as usize;
        let bx1 = ((px + r).ceil() as i64).min(w as i64 - 1).max(0) as usize;
        let by0 = (py - ry).floor().max(0.0) as usize;
        let by1 = ((py + ry).ceil() as i64).min(h as i64 - 1).max(0) as usize;

        for yy in by0..=by1 {
            let ddy = (yy as f32 - py) * s.aspect;
            for xx in bx0..=bx1 {
                let ddx = xx as f32 - px;
                let d2 = (ddx * ddx + ddy * ddy) * inv_r2;
                if d2 >= 1.0 {
                    continue;
                }
                let f = 1.0 - d2;
                let f = f * f;
                let i = idx(w, xx, yy);

                // Project onto the direction of travel: water piles up ahead of
                // the pointer and is hollowed out behind it.
                let along = (ddx * nx + ddy * ny) / r;
                let bow = along * (1.0 + wake);

                s.cur[i] += strength * f * (bow - 0.35 * wake);

                s.fu[i] += push * f * nx * inv;
                s.fv[i] += push * f * ny * inv / s.aspect.max(0.0001);
                // Quadratic in wake: a slow drag repeated over the same water
                // must not accumulate into foam it never earned.
                s.foam[i] = (s.foam[i] + 0.5 * f * wake * wake * inv).min(1.0);
            }
        }
    }
}

/// Advance the simulation. `dt` is seconds; `steps` sub-steps of fixed size.
#[no_mangle]
pub extern "C" fn step(dt: f32, steps: u32) {
    let s = st();
    for _ in 0..steps {
        s.t += dt;
        advect(s, dt);
        relax_flow(s);
        integrate(s);
        decay_foam(s);
    }
    pack(s);
}

/// Carry the surface along the drift field (semi-Lagrangian backtrace).
/// `cur` and `prev` move together so the wave's velocity survives the transport.
fn advect(s: &mut State, dt: f32) {
    let (w, h) = (s.w, s.h);

    for y in 0..h {
        for x in 0..w {
            let i = idx(w, x, y);
            let u = s.fu[i];
            let v = s.fv[i];
            if u * u + v * v < 1e-6 {
                s.tmp_a[i] = s.cur[i];
                s.tmp_b[i] = s.prev[i];
                continue;
            }
            let sx = (x as f32 - u * dt).clamp(0.0, (w - 1) as f32);
            let sy = (y as f32 - v * dt).clamp(0.0, (h - 1) as f32);
            s.tmp_a[i] = bilinear(&s.cur, w, h, sx, sy);
            s.tmp_b[i] = bilinear(&s.prev, w, h, sx, sy);
        }
    }
    core::mem::swap(&mut s.cur, &mut s.tmp_a);
    core::mem::swap(&mut s.prev, &mut s.tmp_b);
}

#[inline(always)]
fn bilinear(a: &[f32], w: usize, h: usize, x: f32, y: f32) -> f32 {
    let x0 = x.floor() as usize;
    let y0 = y.floor() as usize;
    let x1 = (x0 + 1).min(w - 1);
    let y1 = (y0 + 1).min(h - 1);
    let fx = x - x0 as f32;
    let fy = y - y0 as f32;
    let a00 = a[idx(w, x0, y0)];
    let a10 = a[idx(w, x1, y0)];
    let a01 = a[idx(w, x0, y1)];
    let a11 = a[idx(w, x1, y1)];
    let top = a00 + (a10 - a00) * fx;
    let bot = a01 + (a11 - a01) * fx;
    top + (bot - top) * fy
}

/// Spread and bleed off the drift field.
// ponytail: no pressure projection — the field is only a transport hint for the
// surface, not a fluid we ever see directly. Add a Jacobi solve here if swirls
// ever need to close into real eddies.
fn relax_flow(s: &mut State) {
    let (w, h) = (s.w, s.h);
    diffuse_decay(&mut s.fu, &mut s.tmp_a, w, h);
    diffuse_decay(&mut s.fv, &mut s.tmp_b, w, h);
}

fn diffuse_decay(field: &mut [f32], tmp: &mut [f32], w: usize, h: usize) {
    let k = FLOW_DIFFUSE * 0.25;
    for y in 0..h {
        let ym = y.saturating_sub(1);
        let yp = (y + 1).min(h - 1);
        for x in 0..w {
            let xm = x.saturating_sub(1);
            let xp = (x + 1).min(w - 1);
            let c = field[idx(w, x, y)];
            let n = field[idx(w, xm, y)]
                + field[idx(w, xp, y)]
                + field[idx(w, x, ym)]
                + field[idx(w, x, yp)];
            tmp[idx(w, x, y)] = (c + k * (n - 4.0 * c)) * FLOW_DECAY;
        }
    }
    field.copy_from_slice(tmp);
}

/// One step of the damped wave equation, written in velocity form so damping
/// acts on the surface's motion rather than its displacement.
fn integrate(s: &mut State) {
    let (w, h) = (s.w, s.h);
    // Split the loop so the interior never touches a bounds clamp.
    for y in 0..h {
        let ym = y.saturating_sub(1);
        let yp = (y + 1).min(h - 1);
        let row = y * w;
        let row_m = ym * w;
        let row_p = yp * w;
        for x in 0..w {
            let xm = x.saturating_sub(1);
            let xp = (x + 1).min(w - 1);
            let c = s.cur[row + x];

            // 9-point isotropic Laplacian: the 5-point one makes ripples that
            // visibly square off along the grid axes.
            let orth = s.cur[row + xm] + s.cur[row + xp] + s.cur[row_m + x] + s.cur[row_p + x];
            let diag = s.cur[row_m + xm]
                + s.cur[row_m + xp]
                + s.cur[row_p + xm]
                + s.cur[row_p + xp];
            let lap = (2.0 / 3.0) * orth + (1.0 / 6.0) * diag - (10.0 / 3.0) * c;

            let vel = (c - s.prev[row + x]) * WAVE_DAMP;
            let e = s.edge[row + x];
            // The clamp only ever engages under absurd input (a flick faster
            // than the pointer can physically travel); it keeps one bad frame
            // from becoming a permanently ringing grid.
            let next = ((c + vel + ALPHA * lap) * e).clamp(-4.0, 4.0);

            // Steep slopes agitate the surface; that's where foam belongs.
            s.foam[row + x] = (s.foam[row + x] + (lap.abs() * 0.012).min(0.012)).min(1.0);
            s.prev[row + x] = next;
        }
    }
    // `prev` was written with the new state; make it current.
    core::mem::swap(&mut s.cur, &mut s.prev);
}

fn decay_foam(s: &mut State) {
    for f in s.foam.iter_mut() {
        *f *= FOAM_DECAY;
    }
}

/// Interleave height and foam as half floats: half the bandwidth of f32, and
/// WebGL2 filters RG16F natively so the shader gets smooth normals for free.
///
/// The breeze is added here rather than integrated. Driving the wave equation
/// with a steady periodic force feeds energy into whichever modes happen to
/// resonate with it, and the surface climbs without bound; as a term laid over
/// the solved height it is exactly as strong as it says it is, forever.
fn pack(s: &mut State) {
    let (w, h) = (s.w, s.h);

    if s.breeze <= 0.0 {
        for i in 0..s.cur.len() {
            s.out[i * 2] = f16(s.cur[i]);
            s.out[i * 2 + 1] = f16(s.foam[i]);
        }
        return;
    }

    // Two crossed trains, long enough to read as wind chop rather than noise.
    // sin(kx*x + ky*y + wt) is split into per-column and per-row factors, so a
    // travelling wave costs two multiplies per cell instead of a sine.
    const K1: (f32, f32, f32, f32) = (0.075, 0.049, 1.15, 0.030);
    const K2: (f32, f32, f32, f32) = (-0.051, 0.094, -0.93, 0.022);
    let t = s.t;

    for x in 0..w {
        let fx = x as f32;
        s.tmp_a[x] = (K1.0 * fx).sin();
        s.tmp_a[w + x] = (K1.0 * fx).cos();
        s.tmp_b[x] = (K2.0 * fx).sin();
        s.tmp_b[w + x] = (K2.0 * fx).cos();
    }

    let a1 = K1.3 * s.breeze;
    let a2 = K2.3 * s.breeze;
    for y in 0..h {
        let fy = y as f32;
        let b1 = K1.1 * fy + K1.2 * t;
        let b2 = K2.1 * fy + K2.2 * t;
        let (s1, c1) = (b1.sin() * a1, b1.cos() * a1);
        let (s2, c2) = (b2.sin() * a2, b2.cos() * a2);
        let row = y * w;
        for x in 0..w {
            let i = row + x;
            let chop = s.tmp_a[x] * c1 + s.tmp_a[w + x] * s1
                     + s.tmp_b[x] * c2 + s.tmp_b[w + x] * s2;
            s.out[i * 2] = f16(s.cur[i] + chop);
            s.out[i * 2 + 1] = f16(s.foam[i]);
        }
    }
}

/// Total surface energy, so the host can idle down a pond nobody is touching.
#[no_mangle]
pub extern "C" fn energy() -> f32 {
    let s = st();
    let mut acc = 0.0f32;
    // Sampling every 7th cell is plenty for an idle threshold and keeps this
    // off the per-frame profile.
    let mut i = 0;
    while i < s.cur.len() {
        acc += s.cur[i].abs() + s.foam[i];
        i += 7;
    }
    acc * 7.0 / s.cur.len() as f32
}

/// Flatten everything — used on resize, where stale state would smear.
#[no_mangle]
pub extern "C" fn clear() {
    let s = st();
    s.cur.fill(0.0);
    s.prev.fill(0.0);
    s.fu.fill(0.0);
    s.fv.fill(0.0);
    s.foam.fill(0.0);
}

/// f32 -> IEEE half, with round-to-nearest-even.
#[inline(always)]
fn f16(x: f32) -> u16 {
    let b = x.to_bits();
    let sign = ((b >> 16) & 0x8000) as u16;
    let mut exp = ((b >> 23) & 0xff) as i32 - 127 + 15;
    let mant = b & 0x7f_ffff;

    if exp >= 0x1f {
        // Overflow or inf/nan -> inf, keeping the sign.
        return sign | 0x7c00;
    }
    if exp <= 0 {
        if exp < -10 {
            return sign;
        }
        // Subnormal half.
        let mant = mant | 0x80_0000;
        let shift = (14 - exp) as u32;
        let half = (mant >> shift) as u16;
        let round = ((mant >> (shift - 1)) & 1) as u16;
        return sign | (half + round);
    }
    let mut half_mant = (mant >> 13) as u16;
    // Round to nearest even.
    if (mant & 0x1000) != 0 && ((mant & 0x0fff) != 0 || (half_mant & 1) != 0) {
        half_mant += 1;
        if half_mant == 0x400 {
            half_mant = 0;
            exp += 1;
            if exp >= 0x1f {
                return sign | 0x7c00;
            }
        }
    }
    sign | ((exp as u16) << 10) | half_mant
}
