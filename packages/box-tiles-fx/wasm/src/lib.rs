//! Box tiles: the grid of squares in a title sequence that black out, shift
//! the picture a few cells sideways, or flare up for a moment and then let go.
//!
//! There is no physics here, only a state machine with a clock, and the whole
//! value of putting it behind a solver boundary is that it behaves: a tile
//! pops, holds, and lets go on its own time; a kick of energy (a pointer
//! stroke, a beat) raises the odds of tiles popping and then fades; and the
//! same seed replays the same sequence, so every decision is testable.
//!
//! Each cell carries four numbers for the renderer, packed as half floats:
//!
//!   dx, dy   which cell this tile shows instead of itself, in cells
//!   lift     brightness, in stops; at or below `BLACK_LIFT` the tile is black
//!   lot      a static random number per cell, for revealing things tile by
//!            tile — text, a second clip — without simulating anything
//!
//! Plain `cdylib` — no wasm-bindgen. Scalars and linear memory are all a
//! numeric kernel needs to cross the boundary.
//!
//! Copyright (c) 2026 Alex Mkwizu <alexgmkwizu@gmail.com> — MIT.

use core::ptr::addr_of_mut;

/// Largest grid on either axis. Cells are tens of pixels, so even a wall of
/// screens is a few hundred across.
pub const MAX_DIM: u32 = 512;
/// A lift at or below this is read by the shader as "the tile is black".
/// Far enough below the darkest honest lift (-8 stops) that nothing confuses
/// the two.
pub const BLACK_LIFT: f32 = -16.0;
/// Where the shader draws the line. `BLACK_LIFT` has to sit under it.
pub const BLACK_THRESHOLD: f32 = -8.0;
/// Per-cell excitement cannot grow past this, however hard the pointer works.
const MAX_EXCITE: f32 = 100.0;

// --- tunables ---------------------------------------------------------------
// One flat f32 array, so the host can write any of them at any time through a
// view onto linear memory. `src/sim/params.js` holds the same list, in the same
// order, with the same defaults; `wasm/test.mjs` asserts the two agree.

pub const P_RATE: usize = 0;
pub const P_HOLD: usize = 1;
pub const P_HOLD_JITTER: usize = 2;
pub const P_SHIFT: usize = 3;
pub const P_BLACK: usize = 4;
pub const P_LIFT: usize = 5;
pub const P_BLOCK: usize = 6;
pub const P_OFFSET_MAX: usize = 7;
pub const P_LIFT_MAX: usize = 8;
pub const P_DECAY: usize = 9;
pub const P_PULSE_GAIN: usize = 10;
pub const P_BEAT_GAIN: usize = 11;
pub const P_MAX_ACTIVE: usize = 12;
pub const PARAM_COUNT: usize = 13;

/// Defaults describe a quiet title card: a tile or two popping every second
/// on its own, bursts when something happens.
pub const DEFAULTS: [f32; PARAM_COUNT] = [
    0.06, // ambient flips per cell per second
    0.45, // seconds a tile holds its state
    0.6,  // how much that varies, as a fraction
    1.0,  // weight of "shift the picture"
    0.7,  // weight of "go black"
    0.5,  // weight of "flare up"
    0.3,  // chance a flip takes a 2x2 block
    4.0,  // furthest a shifted tile reaches, in cells
    1.2,  // brightest a flare gets, in stops
    4.0,  // 1/s excitement fades
    1.0,  // flips per cell per second per unit of excitement
    0.6,  // excitement per unit of beat
    0.6,  // most of the grid that may be active at once
];

#[derive(Clone, Copy, Default)]
struct Cell {
    dx: i8,
    dy: i8,
    lift: f32,
    /// Seconds left in the current state. Zero or less means at rest.
    hold: f32,
    /// Local excitement, from the pointer. Fades.
    excite: f32,
}

#[derive(Clone, Copy, PartialEq)]
enum Kind {
    Shift,
    Black,
    Lift,
}

pub struct Tiles {
    w: usize,
    h: usize,
    cells: Vec<Cell>,
    /// A static random number per cell, re-rolled by `reseed`.
    lot: Vec<f32>,
    params: [f32; PARAM_COUNT],
    out: Vec<u16>,
    rng: u32,
    /// Grid-wide excitement, from beats. Fades.
    global: f32,
    /// Grid-wide excitement that does not fade: a sound level, held by the host.
    drive: f32,
    excite_sum: f32,
    active: usize,
}

#[inline(always)]
fn finite(v: f32, fallback: f32) -> f32 {
    if v.is_finite() {
        v
    } else {
        fallback
    }
}

/// An integer hash to a float in [0, 1). Per cell and per seed, independent
/// of the order anything was asked in.
fn hash(i: u32, seed: u32) -> f32 {
    let mut x = i ^ seed.wrapping_mul(0x9E37_79B9);
    x ^= x >> 16;
    x = x.wrapping_mul(0x7feb_352d);
    x ^= x >> 15;
    x = x.wrapping_mul(0x846c_a68b);
    x ^= x >> 16;
    (x >> 8) as f32 / 16_777_216.0
}

impl Tiles {
    pub fn new(w: usize, h: usize) -> Self {
        let n = w * h;
        let mut t = Tiles {
            w,
            h,
            cells: vec![Cell::default(); n],
            lot: vec![0.0; n],
            params: DEFAULTS,
            out: vec![0; n * 4],
            rng: 1,
            global: 0.0,
            drive: 0.0,
            excite_sum: 0.0,
            active: 0,
        };
        t.reseed(1);
        t.pack();
        t
    }

    #[inline(always)]
    fn param(&self, i: usize) -> f32 {
        finite(self.params[i], DEFAULTS[i])
    }

    /// xorshift32. Deterministic on purpose: the same seed replays the same
    /// tiles, so a test can watch them.
    #[inline(always)]
    fn rand(&mut self) -> f32 {
        let mut x = self.rng;
        x ^= x << 13;
        x ^= x >> 17;
        x ^= x << 5;
        self.rng = x;
        (x >> 8) as f32 / 16_777_216.0
    }

    pub fn reseed(&mut self, seed: u32) {
        self.rng = seed.wrapping_mul(0x9E37_79B9) | 1;
        for i in 0..self.lot.len() {
            self.lot[i] = hash(i as u32, seed);
        }
        self.pack();
    }

    /// Every tile back to rest, every bit of excitement gone. The lottery
    /// stays: a reset is not a reseed.
    pub fn reset(&mut self) {
        for c in self.cells.iter_mut() {
            *c = Cell::default();
        }
        self.global = 0.0;
        self.drive = 0.0;
        self.excite_sum = 0.0;
        self.active = 0;
        self.pack();
    }

    /// Excite the tiles around a point. Gaussian, so a stroke reads as a
    /// stroke and not as a stamp.
    pub fn pulse(&mut self, x: f32, y: f32, radius: f32, strength: f32) {
        if !(x.is_finite() && y.is_finite() && radius.is_finite() && strength.is_finite()) {
            return;
        }
        let r = radius.clamp(0.5, 1e4);
        let s = strength.clamp(0.0, MAX_EXCITE);
        if s <= 0.0 {
            return;
        }
        let reach = (3.0 * r).ceil() as i32;
        let cx = x.floor() as i32;
        let cy = y.floor() as i32;
        let x0 = (cx - reach).max(0);
        let x1 = (cx + reach).min(self.w as i32 - 1);
        let y0 = (cy - reach).max(0);
        let y1 = (cy + reach).min(self.h as i32 - 1);
        let inv = 1.0 / (r * r);
        for yy in y0..=y1 {
            for xx in x0..=x1 {
                let dx = xx as f32 + 0.5 - x;
                let dy = yy as f32 + 0.5 - y;
                let q = s * (-(dx * dx + dy * dy) * inv).exp();
                let c = &mut self.cells[yy as usize * self.w + xx as usize];
                let next = (c.excite + q).min(MAX_EXCITE);
                // Kept current here as well as in `step`, or `idle()` would
                // say "nothing to do" in the gap between a stroke and the
                // next frame — which is exactly when the host asks.
                self.excite_sum += next - c.excite;
                c.excite = next;
            }
        }
    }

    /// Excite the whole grid at once. This is what a beat does.
    pub fn beat(&mut self, strength: f32) {
        if !strength.is_finite() {
            return;
        }
        let gain = self.param(P_BEAT_GAIN).clamp(0.0, 100.0);
        self.global = (self.global + strength.clamp(0.0, MAX_EXCITE) * gain).min(MAX_EXCITE);
    }

    /// A steady level of excitement that does not fade — a sound level.
    pub fn drive(&mut self, level: f32) {
        self.drive = finite(level, 0.0).clamp(0.0, 8.0);
    }

    pub fn step(&mut self, dt: f32) {
        let dt = finite(dt, 0.0).clamp(0.0, 0.25);
        if dt <= 0.0 {
            return;
        }
        let fade = (-self.param(P_DECAY).clamp(0.0, 1000.0) * dt).exp();
        self.global *= fade;

        // Tiles that have held long enough let go, and local excitement fades.
        let mut sum = 0.0;
        for c in self.cells.iter_mut() {
            c.excite *= fade;
            sum += c.excite;
            if c.hold > 0.0 {
                c.hold -= dt;
                if c.hold <= 0.0 {
                    *c = Cell { excite: c.excite, ..Cell::default() };
                    self.active -= 1;
                }
            }
        }
        self.excite_sum = sum;

        // Tiles at rest may pop. Walked from a random start so that a cap on
        // how many may be active does not always favour the top of the grid.
        let n = self.cells.len();
        let cap = (self.param(P_MAX_ACTIVE).clamp(0.0, 1.0) * n as f32) as usize;
        let rate = self.param(P_RATE).clamp(0.0, 1000.0);
        let gain = self.param(P_PULSE_GAIN).clamp(0.0, 1000.0);
        let ambient = (rate + (self.global + self.drive) * gain) * dt;
        let start = (self.rand() * n as f32) as usize;
        for k in 0..n {
            if self.active >= cap {
                break;
            }
            let i = (start + k) % n;
            let c = self.cells[i];
            if c.hold > 0.0 {
                continue;
            }
            let p = ambient + c.excite * gain * dt;
            if p <= 0.0 {
                continue;
            }
            if self.rand() < p {
                self.flip(i);
            }
        }
        self.pack();
    }

    /// One tile (or one 2x2 block) takes on a state and a hold time.
    fn flip(&mut self, i: usize) {
        let sw = self.param(P_SHIFT).max(0.0);
        let bw = self.param(P_BLACK).max(0.0);
        let lw = self.param(P_LIFT).max(0.0);
        let total = sw + bw + lw;
        if total <= 0.0 {
            return;
        }
        let r = self.rand() * total;
        let kind = if r < sw {
            Kind::Shift
        } else if r < sw + bw {
            Kind::Black
        } else {
            Kind::Lift
        };

        let jitter = self.param(P_HOLD_JITTER).clamp(0.0, 1.0);
        let hold = self.param(P_HOLD).clamp(0.016, 60.0) * (1.0 + jitter * (2.0 * self.rand() - 1.0));
        let block = self.rand() < self.param(P_BLOCK).clamp(0.0, 1.0);
        let omax = self.param(P_OFFSET_MAX).clamp(0.0, 64.0) as i32;

        // A flare often sits on a shifted tile too; it reads as a glint off
        // something that moved.
        let shifted = kind == Kind::Shift || (kind == Kind::Lift && self.rand() < 0.5);
        let (dx, dy) = if shifted { self.offset(omax) } else { (0, 0) };
        let lift = match kind {
            Kind::Black => BLACK_LIFT,
            Kind::Lift => self.param(P_LIFT_MAX).clamp(0.0, 8.0) * (0.5 + 0.5 * self.rand()),
            Kind::Shift => 0.0,
        };

        let x = i % self.w;
        let y = i / self.w;
        // Blocks sit on even anchors, so two of them either coincide or do
        // not touch: a block is never half overwritten by another.
        let (x0, y0, size) = if block { (x & !1, y & !1, 2) } else { (x, y, 1) };
        for yy in y0..(y0 + size).min(self.h) {
            for xx in x0..(x0 + size).min(self.w) {
                let c = &mut self.cells[yy * self.w + xx];
                if c.hold <= 0.0 {
                    self.active += 1;
                }
                c.dx = dx as i8;
                c.dy = dy as i8;
                c.lift = lift;
                c.hold = hold;
            }
        }
    }

    /// A whole number of cells on each axis, never both zero.
    fn offset(&mut self, omax: i32) -> (i32, i32) {
        if omax <= 0 {
            return (0, 0);
        }
        let span = (2 * omax + 1) as f32;
        loop {
            let dx = (self.rand() * span) as i32 - omax;
            let dy = (self.rand() * span) as i32 - omax;
            if dx != 0 || dy != 0 {
                return (dx.clamp(-omax, omax), dy.clamp(-omax, omax));
            }
        }
    }

    /// How much is going on. Zero means nothing is, and nothing will.
    pub fn energy(&self) -> f32 {
        self.global + self.drive + self.excite_sum + self.active as f32
    }

    /// Nothing active, nothing excited, and no ambient rate to make anything
    /// happen on its own: the host can stop stepping.
    pub fn idle(&self) -> bool {
        self.active == 0
            && self.global < 1e-3
            && self.drive <= 0.0
            && self.excite_sum < 1e-3
            && self.param(P_RATE) <= 0.0
    }

    fn pack(&mut self) {
        for (i, c) in self.cells.iter().enumerate() {
            let o = i * 4;
            self.out[o] = f16(c.dx as f32);
            self.out[o + 1] = f16(c.dy as f32);
            self.out[o + 2] = f16(c.lift);
            self.out[o + 3] = f16(self.lot[i]);
        }
    }
}

/// IEEE half float, round to nearest even. Non-finite packs as zero: a NaN
/// texel would poison every sample that filters through it.
fn f16(x: f32) -> u16 {
    if !x.is_finite() {
        return 0;
    }
    let b = x.to_bits();
    let sign = ((b >> 16) & 0x8000) as u16;
    let mut exp = ((b >> 23) & 0xff) as i32 - 127 + 15;
    let mant = b & 0x7f_ffff;

    if exp >= 0x1f {
        return sign | 0x7bff; // saturate rather than going infinite
    }
    if exp <= 0 {
        if exp < -10 {
            return sign;
        }
        let mant = mant | 0x80_0000;
        let shift = (14 - exp) as u32;
        let half = (mant >> shift) as u16;
        let round = ((mant >> (shift - 1)) & 1) as u16;
        return sign | (half + round);
    }
    let mut half_mant = (mant >> 13) as u16;
    if (mant & 0x1000) != 0 && ((mant & 0x0fff) != 0 || (half_mant & 1) != 0) {
        half_mant += 1;
        if half_mant == 0x400 {
            half_mant = 0;
            exp += 1;
            if exp >= 0x1f {
                return sign | 0x7bff;
            }
        }
    }
    sign | ((exp as u16) << 10) | half_mant
}

// --- the C ABI ---------------------------------------------------------------

static mut STATE: Option<Tiles> = None;

#[inline(always)]
#[allow(static_mut_refs)]
fn st() -> &'static mut Tiles {
    unsafe { (*addr_of_mut!(STATE)).as_mut().unwrap() }
}

/// Allocate the grid. Returns 0 if the size was refused.
#[no_mangle]
pub extern "C" fn init(w: u32, h: u32) -> u32 {
    if w < 2 || h < 2 || w > MAX_DIM || h > MAX_DIM {
        return 0;
    }
    unsafe {
        STATE = Some(Tiles::new(w as usize, h as usize));
    }
    1
}

/// The tunables, as `PARAM_COUNT` floats the host can write at any time.
#[no_mangle]
pub extern "C" fn params_ptr() -> *mut f32 {
    st().params.as_mut_ptr()
}

#[no_mangle]
pub extern "C" fn params_len() -> u32 {
    PARAM_COUNT as u32
}

/// Interleaved half floats, four per cell: dx, dy, lift, lot.
#[no_mangle]
pub extern "C" fn out_ptr() -> *const u16 {
    st().out.as_ptr()
}

#[no_mangle]
pub extern "C" fn out_len() -> u32 {
    st().out.len() as u32
}

#[no_mangle]
pub extern "C" fn step(dt: f32) {
    st().step(dt)
}

#[no_mangle]
pub extern "C" fn pulse(x: f32, y: f32, radius: f32, strength: f32) {
    st().pulse(x, y, radius, strength)
}

#[no_mangle]
pub extern "C" fn beat(strength: f32) {
    st().beat(strength)
}

#[no_mangle]
pub extern "C" fn drive(level: f32) {
    st().drive(level)
}

#[no_mangle]
pub extern "C" fn reseed(seed: u32) {
    st().reseed(seed)
}

#[no_mangle]
pub extern "C" fn reset() {
    st().reset()
}

#[no_mangle]
pub extern "C" fn energy() -> f32 {
    st().energy()
}

#[no_mangle]
pub extern "C" fn idle() -> u32 {
    st().idle() as u32
}

#[no_mangle]
pub extern "C" fn active() -> u32 {
    st().active as u32
}

#[cfg(test)]
mod tests {
    use super::*;

    const W: usize = 48;
    const H: usize = 28;

    /// A grid with no ambient flicker, so only what the test does happens.
    fn quiet() -> Tiles {
        let mut t = Tiles::new(W, H);
        t.params[P_RATE] = 0.0;
        t
    }

    fn run(t: &mut Tiles, frames: usize) {
        for _ in 0..frames {
            t.step(1.0 / 60.0);
        }
    }

    fn active_cells(t: &Tiles) -> Vec<(usize, usize)> {
        (0..t.cells.len())
            .filter(|&i| t.cells[i].hold > 0.0)
            .map(|i| (i % t.w, i / t.w))
            .collect()
    }

    fn f16_to_f32(x: u16) -> f32 {
        let s = if x & 0x8000 != 0 { -1.0 } else { 1.0 };
        let e = ((x >> 10) & 0x1f) as i32;
        let m = (x & 0x3ff) as f32;
        if e == 0 {
            return s * 2f32.powi(-14) * (m / 1024.0);
        }
        s * 2f32.powi(e - 15) * (1.0 + m / 1024.0)
    }

    #[test]
    fn rest_is_inert() {
        let mut t = quiet();
        run(&mut t, 300);
        assert_eq!(t.active, 0);
        assert_eq!(t.energy(), 0.0);
        assert!(t.idle());
        for i in 0..t.cells.len() {
            assert_eq!(t.out[i * 4], 0, "dx");
            assert_eq!(t.out[i * 4 + 1], 0, "dy");
            assert_eq!(t.out[i * 4 + 2], 0, "lift");
            let lot = f16_to_f32(t.out[i * 4 + 3]);
            assert!((0.0..1.0).contains(&lot), "lot {lot} out of range");
        }
    }

    #[test]
    fn a_pulse_wakes_tiles_around_the_pointer() {
        let mut t = quiet();
        t.pulse(24.0, 13.0, 3.0, 4.0);
        assert!(!t.idle());
        run(&mut t, 12);
        let cells = active_cells(&t);
        assert!(cells.len() > 3, "only {} tiles popped", cells.len());
        let (mut mx, mut my) = (0.0, 0.0);
        for &(x, y) in &cells {
            mx += x as f32 + 0.5;
            my += y as f32 + 0.5;
        }
        mx /= cells.len() as f32;
        my /= cells.len() as f32;
        assert!((mx - 24.0).abs() < 5.0 && (my - 13.0).abs() < 5.0, "centroid {mx},{my}");
        let far = cells.iter().filter(|&&(x, y)| ((x as f32 - 24.0).powi(2) + (y as f32 - 13.0).powi(2)).sqrt() > 12.0).count();
        assert_eq!(far, 0, "tiles popped far from the pointer");
    }

    #[test]
    fn tiles_hold_and_then_let_go() {
        let mut t = quiet();
        t.pulse(24.0, 13.0, 3.0, 4.0);
        run(&mut t, 6);
        assert!(t.active > 0);
        // Long enough for the longest hold and for the excitement to fade.
        run(&mut t, 240);
        assert_eq!(t.active, 0, "tiles never let go");
        assert!(t.idle(), "energy {} left", t.energy());
        for c in &t.cells {
            assert_eq!((c.dx, c.dy, c.lift), (0, 0, 0.0));
        }
    }

    #[test]
    fn offsets_and_lifts_stay_within_their_dials() {
        let mut t = quiet();
        t.params[P_OFFSET_MAX] = 3.0;
        t.params[P_LIFT_MAX] = 0.8;
        let mut seen_shift = false;
        let mut seen_black = false;
        let mut seen_lift = false;
        for _ in 0..40 {
            t.beat(3.0);
            run(&mut t, 6);
            for c in &t.cells {
                assert!(c.dx.abs() <= 3 && c.dy.abs() <= 3, "offset {},{}", c.dx, c.dy);
                if c.hold > 0.0 {
                    if c.lift == BLACK_LIFT {
                        seen_black = true;
                    } else {
                        assert!((0.0..=0.8).contains(&c.lift), "lift {}", c.lift);
                        if c.lift > 0.0 {
                            seen_lift = true;
                        }
                    }
                    if c.dx != 0 || c.dy != 0 {
                        seen_shift = true;
                    }
                } else {
                    assert_eq!((c.dx, c.dy, c.lift), (0, 0, 0.0), "a resting tile kept a state");
                }
            }
        }
        assert!(seen_shift && seen_black && seen_lift, "not every kind of tile showed up");
    }

    #[test]
    fn black_sits_below_the_shaders_threshold() {
        assert!(BLACK_LIFT < BLACK_THRESHOLD);
        assert!(f16_to_f32(f16(BLACK_LIFT)) <= BLACK_THRESHOLD);
    }

    #[test]
    fn a_block_is_four_cells_that_agree() {
        let mut t = quiet();
        t.params[P_BLOCK] = 1.0;
        for _ in 0..20 {
            t.beat(2.0);
            run(&mut t, 4);
            for (x, y) in active_cells(&t) {
                let (ax, ay) = (x & !1, y & !1);
                let a = t.cells[ay * t.w + ax];
                for (xx, yy) in [(ax, ay), (ax + 1, ay), (ax, ay + 1), (ax + 1, ay + 1)] {
                    let c = t.cells[yy * t.w + xx];
                    assert!(c.hold > 0.0, "block at {ax},{ay} has a resting cell");
                    assert_eq!((c.dx, c.dy, c.lift), (a.dx, a.dy, a.lift), "block at {ax},{ay} disagrees");
                }
            }
        }
    }

    #[test]
    fn a_beat_reaches_the_whole_grid() {
        let mut t = quiet();
        t.beat(4.0);
        run(&mut t, 10);
        let cells = active_cells(&t);
        assert!(cells.len() > 20, "only {} tiles popped on a beat", cells.len());
        let mut quadrants = [false; 4];
        for (x, y) in cells {
            quadrants[(x >= W / 2) as usize + 2 * (y >= H / 2) as usize] = true;
        }
        assert_eq!(quadrants, [true; 4], "a beat should land everywhere");
    }

    #[test]
    fn a_beat_fades_and_the_grid_settles() {
        let mut t = quiet();
        t.beat(4.0);
        run(&mut t, 2);
        let early = t.active;
        run(&mut t, 300);
        assert!(early > 0);
        assert_eq!(t.active, 0);
        assert!(t.idle());
    }

    #[test]
    fn the_same_seed_replays_the_same_tiles() {
        let mut a = quiet();
        let mut b = quiet();
        a.reseed(99);
        b.reseed(99);
        for t in [&mut a, &mut b] {
            t.beat(2.0);
            t.pulse(10.0, 10.0, 3.0, 3.0);
            run(t, 30);
        }
        assert_eq!(a.out, b.out, "same seed, different tiles");

        let mut c = quiet();
        c.reseed(100);
        c.beat(2.0);
        c.pulse(10.0, 10.0, 3.0, 3.0);
        run(&mut c, 30);
        assert_ne!(a.out, c.out, "different seed, same tiles");
    }

    #[test]
    fn the_lottery_is_fair_and_stable() {
        let mut t = Tiles::new(W, H);
        let before = t.lot.clone();
        let mean: f32 = before.iter().sum::<f32>() / before.len() as f32;
        assert!((mean - 0.5).abs() < 0.05, "lottery mean {mean}");
        assert!(before.iter().all(|&v| (0.0..1.0).contains(&v)));
        t.beat(3.0);
        run(&mut t, 60);
        t.reset();
        assert_eq!(t.lot, before, "a reset must not re-roll the lottery");
        t.reseed(2);
        assert_ne!(t.lot, before, "a reseed must");
    }

    #[test]
    fn ambient_rate_gives_the_expected_occupancy() {
        // Each resting tile pops at `rate` per second and stays up for `hold`
        // seconds, so the fraction up at any moment is r h / (1 + r h).
        let mut t = Tiles::new(W, H);
        t.params[P_RATE] = 0.2;
        t.params[P_HOLD] = 0.5;
        t.params[P_HOLD_JITTER] = 0.0;
        t.params[P_BLOCK] = 0.0;
        run(&mut t, 300);
        let mut sum = 0.0;
        let frames = 600;
        for _ in 0..frames {
            t.step(1.0 / 60.0);
            sum += t.active as f32 / t.cells.len() as f32;
        }
        let measured = sum / frames as f32;
        let expected = 0.1 / 1.1;
        assert!((measured - expected).abs() < expected * 0.3, "occupancy {measured} vs {expected}");
    }

    #[test]
    fn the_cap_holds_against_a_huge_beat() {
        let mut t = quiet();
        t.params[P_MAX_ACTIVE] = 0.1;
        t.beat(100.0);
        run(&mut t, 5);
        let cap = (0.1 * t.cells.len() as f32) as usize;
        // A block may carry it past the cap by its other three cells.
        assert!(t.active <= cap + 3, "{} active, cap {cap}", t.active);
        assert!(t.active > cap / 2, "the beat barely registered: {}", t.active);
    }

    #[test]
    fn drive_keeps_it_awake_until_it_is_let_go() {
        let mut t = quiet();
        t.drive(1.0);
        assert!(!t.idle());
        run(&mut t, 30);
        assert!(t.active > 0, "a driven grid should be popping");
        t.drive(0.0);
        run(&mut t, 300);
        assert!(t.idle());
    }

    #[test]
    fn hostile_input_is_refused_without_a_panic() {
        let mut t = quiet();
        t.pulse(f32::NAN, 1.0, 3.0, 1.0);
        t.pulse(1.0, f32::INFINITY, 3.0, 1.0);
        t.pulse(1.0, 1.0, f32::NAN, 1.0);
        t.pulse(1.0, 1.0, 3.0, f32::NEG_INFINITY);
        t.pulse(-1e9, 1e9, 1e30, 1e30);
        t.beat(f32::NAN);
        t.drive(f32::NAN);
        t.step(f32::NAN);
        t.step(-1.0);
        t.step(1e9);
        assert_eq!(t.energy(), 0.0, "garbage input put energy in");

        for v in t.params.iter_mut() {
            *v = f32::NAN;
        }
        t.beat(1.0);
        run(&mut t, 30);
        for v in t.params.iter_mut() {
            *v = -1e30;
        }
        run(&mut t, 30);
        for v in t.params.iter_mut() {
            *v = 1e30;
        }
        t.beat(1.0);
        run(&mut t, 30);
        for &u in &t.out {
            let e = (u >> 10) & 0x1f;
            assert_ne!(e, 0x1f, "a non-finite texel reached the renderer");
        }
    }

    #[test]
    fn reset_puts_everything_back() {
        let mut t = Tiles::new(W, H);
        t.beat(3.0);
        t.pulse(5.0, 5.0, 3.0, 3.0);
        t.drive(1.0);
        run(&mut t, 10);
        assert!(t.active > 0);
        t.reset();
        assert_eq!(t.active, 0);
        assert_eq!(t.energy(), 0.0);
        for i in 0..t.cells.len() {
            assert_eq!(&t.out[i * 4..i * 4 + 3], &[0, 0, 0]);
        }
    }

    #[test]
    fn sizes_are_policed() {
        assert_eq!(init(1, 1), 0);
        assert_eq!(init(MAX_DIM + 1, 4), 0);
        assert_eq!(init(4, 4), 1);
        assert_eq!(params_len(), PARAM_COUNT as u32);
        assert_eq!(out_len(), 4 * 4 * 4);
    }

    #[test]
    fn half_floats_round_trip_the_range_we_pack() {
        for v in [0.0f32, 1.0, -1.0, 4.0, -64.0, 0.5, 0.999, 1.2, BLACK_LIFT, 1.0 / 1024.0] {
            let back = f16_to_f32(f16(v));
            assert!((back - v).abs() <= v.abs() * 1e-3 + 1e-6, "{v} -> {back}");
        }
        assert_eq!(f16(f32::NAN), 0, "a NaN must pack as nothing, not as a NaN texel");
        assert_eq!(f16(f32::INFINITY), 0);
        assert_eq!(f16(1e30) & 0x7c00, 0x7800, "overflow must saturate, not go infinite");
    }
}
