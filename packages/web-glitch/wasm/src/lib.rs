//! Glitch: a picture that arrives in blocks.
//!
//! The grid is cut into rectangles of 1, 2, 4 or 8 cells by a quadtree that
//! goes fine wherever the subject's edge runs and stays coarse inside it and
//! outside it. Each rectangle has a place in a queue: the subject arrives
//! first, spreading outward from a handful of seeds, and the background last.
//! `progress` is how far down that queue the picture has got.
//!
//! On top of that there is a small state machine. A block that has arrived
//! may misbehave for a moment — drop out, go to coarse pixels, show the
//! picture from a few cells sideways — and a *burst* flicks the whole subject
//! through a fixed sequence of other renderings (dots, grey mosaic, a white
//! mask with hairlines, fragments of the picture) before letting go.
//!
//! Nothing here touches pixels. The host says where the subject is, one byte
//! per cell; the solver answers with four bytes per cell for the shader:
//!
//!   kind    what to draw there (`KIND_*`)
//!   shape   block level in the low two bits, `FLAG_OUTLINE` above them
//!   0       spare
//!   lot     a random byte, the same for every cell of a block
//!
//! and one byte per cell of glow, already blurred.
//!
//! Plain `cdylib` — no wasm-bindgen. Scalars and linear memory are all a
//! numeric kernel needs to cross the boundary.
//!
//! Copyright (c) 2026 Alex Mkwizu <alexgmkwizu@gmail.com> — MIT.

use core::ptr::addr_of_mut;

/// Largest grid on either axis.
pub const MAX_DIM: u32 = 512;
/// Blocks are at most `1 << TOP_LEVEL` cells on a side.
const TOP_LEVEL: u8 = 3;
/// The subject has all arrived by this much progress; the rest is background.
pub const SUBJECT_SHARE: f32 = 0.85;
/// Per-cell excitement cannot grow past this, however hard the pointer works.
const MAX_EXCITE: f32 = 4.0;

pub const KIND_OFF: u8 = 0;
pub const KIND_IMAGE: u8 = 1;
pub const KIND_PIXEL: u8 = 2;
pub const KIND_SHIFT: u8 = 3;
pub const KIND_GREY: u8 = 4;
pub const KIND_WHITE: u8 = 5;
pub const KIND_DOT: u8 = 6;
pub const KIND_ASCII: u8 = 7;
pub const KIND_HLINE: u8 = 8;
pub const KIND_VLINE: u8 = 9;
pub const KIND_CROSS: u8 = 10;
pub const KIND_LABEL: u8 = 11;
pub const FLAG_OUTLINE: u8 = 4;

pub const MODE_IMAGE: u8 = 0;
pub const MODE_DOTS: u8 = 1;
pub const MODE_MOSAIC: u8 = 2;
pub const MODE_MASK: u8 = 3;
pub const MODE_ASCII: u8 = 4;
/// What a burst flicks through, in order, over and over until it lets go.
const SEQUENCE: [u8; 4] = [MODE_DOTS, MODE_MOSAIC, MODE_MASK, MODE_IMAGE];

// --- tunables ---------------------------------------------------------------
// One flat f32 array, so the host can write any of them at any time through a
// view onto linear memory. `src/sim/params.js` holds the same list, in the same
// order, with the same defaults; `wasm/test.mjs` asserts the two agree.

pub const P_SPEED: usize = 0;
pub const P_GLITCH: usize = 1;
pub const P_HOLD: usize = 2;
pub const P_BURST_RATE: usize = 3;
pub const P_BURST_LENGTH: usize = 4;
pub const P_SWITCH: usize = 5;
pub const P_HOLE: usize = 6;
pub const P_PIXEL: usize = 7;
pub const P_SHIFT: usize = 8;
pub const P_LABELS: usize = 9;
pub const P_GLOW: usize = 10;
pub const P_GLOW_DECAY: usize = 11;
pub const P_THRESHOLD: usize = 12;
pub const P_SPLIT: usize = 13;
pub const P_DOTS: usize = 14;
pub const P_STYLE: usize = 15;
pub const P_DECAY: usize = 16;
pub const P_EXCITE_GAIN: usize = 17;
pub const PARAM_COUNT: usize = 18;

pub const DEFAULTS: [f32; PARAM_COUNT] = [
    0.7,  // progress per second: a reveal takes 1/speed seconds
    0.04, // share of arrived blocks misbehaving at rest
    0.16, // seconds a block keeps its misbehaviour
    0.1,  // bursts per second, on its own
    0.6,  // seconds a burst lasts
    0.09, // seconds a burst holds each rendering
    1.0,  // weight of "drop out"
    1.0,  // weight of "coarse pixels"
    0.6,  // weight of "the picture from a few cells sideways"
    0.2,  // share of the blocks beside the subject that carry a number
    1.0,  // flash as a block arrives
    3.0,  // 1/s the flash fades
    0.12, // how much subject a cell needs to count as subject
    0.45, // chance a block that is all subject, or all background, subdivides
    0.5,  // share of subject cells that get a dot, in the dot rendering
    0.0,  // resting rendering: 0 image, 1 dots, 2 mosaic, 3 mask, 4 ascii
    3.0,  // 1/s pointer excitement fades
    0.5,  // misbehaviour per unit of excitement
];

#[inline(always)]
fn finite(v: f32, fallback: f32) -> f32 {
    if v.is_finite() {
        v
    } else {
        fallback
    }
}

#[inline(always)]
fn mix(mut x: u32) -> u32 {
    x ^= x >> 16;
    x = x.wrapping_mul(0x7feb_352d);
    x ^= x >> 15;
    x = x.wrapping_mul(0x846c_a68b);
    x ^= x >> 16;
    x
}

/// Three integers to one, independent of the order anything was asked in.
#[inline(always)]
fn mix3(a: u32, b: u32, c: u32) -> u32 {
    mix(mix(mix(a).wrapping_add(b)).wrapping_add(c))
}

/// A hash as a float in [0, 1).
#[inline(always)]
fn unit(x: u32) -> f32 {
    (x >> 8) as f32 / 16_777_216.0
}

pub struct Glitch {
    w: usize,
    h: usize,
    pub params: [f32; PARAM_COUNT],
    seed: u32,
    rng: u32,
    /// How much subject is in each cell, 0..255. The host writes this.
    pub presence: Vec<u8>,
    // --- the layout: fixed until the subject or the seed changes
    level: Vec<u8>,
    /// 1 where the cell's block holds any subject at all.
    cover: Vec<u8>,
    /// Index of the top-left cell of the cell's block.
    origin: Vec<u32>,
    /// A hash per block, shared by its cells.
    block: Vec<u32>,
    /// Where in the queue the cell's block arrives, 0..1.
    order: Vec<f32>,
    // --- what moves
    on: Vec<u8>,
    /// 1 as a block arrives, fading: the flash, and how unsettled it still is.
    fresh: Vec<f32>,
    excite: Vec<f32>,
    scratch: Vec<f32>,
    blur: Vec<f32>,
    pub out: Vec<u8>,
    pub glow: Vec<u8>,
    progress: f32,
    target: f32,
    time: f32,
    burst_left: f32,
    burst_age: f32,
    restless: bool,
}

impl Glitch {
    pub fn new(w: usize, h: usize) -> Self {
        let n = w * h;
        let mut g = Glitch {
            w,
            h,
            params: DEFAULTS,
            seed: 1,
            rng: 0x9E37_79B9,
            // Until the host says otherwise, everything is subject.
            presence: vec![255; n],
            level: vec![0; n],
            cover: vec![0; n],
            origin: vec![0; n],
            block: vec![0; n],
            order: vec![0.0; n],
            on: vec![0; n],
            fresh: vec![0.0; n],
            excite: vec![0.0; n],
            scratch: vec![0.0; n],
            blur: vec![0.0; n],
            out: vec![0; n * 4],
            glow: vec![0; n],
            progress: 0.0,
            target: 0.0,
            time: 0.0,
            burst_left: 0.0,
            burst_age: 0.0,
            restless: false,
        };
        g.layout();
        g
    }

    #[inline(always)]
    fn param(&self, i: usize) -> f32 {
        finite(self.params[i], DEFAULTS[i])
    }

    fn rand(&mut self) -> f32 {
        self.rng ^= self.rng << 13;
        self.rng ^= self.rng >> 17;
        self.rng ^= self.rng << 5;
        unit(self.rng)
    }

    fn threshold(&self) -> u8 {
        (self.param(P_THRESHOLD).clamp(0.0, 0.99) * 255.0) as u8
    }

    pub fn reseed(&mut self, seed: u32) {
        self.seed = seed;
        self.rng = mix(seed) | 1;
        self.layout();
    }

    /// Cut the grid into blocks and queue them. Call after writing `presence`.
    pub fn layout(&mut self) {
        let (w, h) = (self.w, self.h);
        let thr = self.threshold();

        // A summed-area table of "is subject", so any rectangle is four reads.
        let sw = w + 1;
        let mut sat = vec![0u32; sw * (h + 1)];
        for y in 0..h {
            let mut row = 0u32;
            for x in 0..w {
                row += (self.presence[y * w + x] > thr) as u32;
                sat[(y + 1) * sw + x + 1] = sat[y * sw + x + 1] + row;
            }
        }
        let count = |x0: usize, y0: usize, x1: usize, y1: usize| {
            sat[y1 * sw + x1] + sat[y0 * sw + x0] - sat[y0 * sw + x1] - sat[y1 * sw + x0]
        };
        let subject = count(0, 0, w, h) as usize;

        // The quadtree. A block the subject's edge runs through always splits,
        // so the silhouette is drawn in small blocks; one that is all subject
        // or all background splits by lottery, less often the smaller it is.
        let split = self.param(P_SPLIT).clamp(0.0, 1.0);
        let top = 1usize << TOP_LEVEL;
        let mut stack: Vec<(usize, usize, u8)> = Vec::new();
        for y in (0..h).step_by(top) {
            for x in (0..w).step_by(top) {
                stack.push((x, y, TOP_LEVEL));
            }
        }
        while let Some((x, y, lvl)) = stack.pop() {
            if x >= w || y >= h {
                continue;
            }
            let size = 1usize << lvl;
            let (x1, y1) = ((x + size).min(w), (y + size).min(h));
            let n = count(x, y, x1, y1) as usize;
            let mixed = n > 0 && n < (x1 - x) * (y1 - y);
            let id = mix3(x as u32 | (y as u32) << 12, lvl as u32, self.seed);
            let lot = unit(mix(id ^ 0x5b17));
            let divide = lvl > 0
                && if mixed {
                    lvl >= 2 || lot < 0.5
                } else {
                    lot < split * [0.0, 0.6, 1.0, 1.3][lvl as usize]
                };
            if divide {
                let half = size / 2;
                for (dx, dy) in [(0, 0), (half, 0), (0, half), (half, half)] {
                    stack.push((x + dx, y + dy, lvl - 1));
                }
                continue;
            }
            for yy in y..y1 {
                for xx in x..x1 {
                    let i = yy * w + xx;
                    self.level[i] = lvl;
                    self.cover[i] = (n > 0) as u8;
                    self.origin[i] = (y * w + x) as u32;
                    self.block[i] = id;
                }
            }
        }

        // The queue. Distance through the subject from a few seeds, so the
        // picture grows along its own shape instead of raining in at random.
        const FAR: f32 = f32::MAX;
        let mut dist = core::mem::take(&mut self.scratch);
        dist.fill(FAR);
        let mut queue: Vec<u32> = Vec::new();
        let chance = (subject / 300).max(3) as f32 / subject.max(1) as f32;
        let mut first = None;
        for i in 0..w * h {
            if self.presence[i] <= thr {
                continue;
            }
            first.get_or_insert(i);
            if unit(mix3(i as u32, 0x5eed, self.seed)) < chance {
                dist[i] = 0.0;
                queue.push(i as u32);
            }
        }
        if let (true, Some(i)) = (queue.is_empty(), first) {
            dist[i] = 0.0;
            queue.push(i as u32);
        }
        let mut head = 0;
        let mut reach = 1.0f32;
        while head < queue.len() {
            let i = queue[head] as usize;
            head += 1;
            let (x, y, d) = (i % w, i / w, dist[i] + 1.0);
            let mut visit = |j: usize| {
                if self.presence[j] > thr && dist[j] == FAR {
                    dist[j] = d;
                    reach = reach.max(d);
                    queue.push(j as u32);
                }
            };
            if x > 0 {
                visit(i - 1)
            }
            if x + 1 < w {
                visit(i + 1)
            }
            if y > 0 {
                visit(i - w)
            }
            if y + 1 < h {
                visit(i + w)
            }
        }
        // A block arrives when the nearest of its cells would.
        let mut best = vec![FAR; w * h];
        for i in 0..w * h {
            if self.presence[i] <= thr {
                continue;
            }
            // An island no seed could walk to gets a place of its own.
            if dist[i] == FAR {
                dist[i] = unit(mix3(i as u32, 0x151e, self.seed)) * reach;
            }
            let o = self.origin[i] as usize;
            best[o] = best[o].min(dist[i]);
        }
        for i in 0..w * h {
            let lot = unit(mix(self.block[i] ^ 0x0b10c));
            self.order[i] = if self.cover[i] != 0 {
                (best[self.origin[i] as usize] / reach * 0.7 + lot * 0.3) * SUBJECT_SHARE
            } else {
                SUBJECT_SHARE + lot * (1.0 - SUBJECT_SHARE)
            };
        }
        self.scratch = dist;
    }

    /// How much of the picture should be there, 0..1. It gets there at `speed`.
    pub fn set_target(&mut self, target: f32) {
        self.target = finite(target, self.target).clamp(0.0, 1.0);
    }

    /// The same, at once: no reveal, no flash.
    pub fn set_progress(&mut self, progress: f32) {
        self.set_target(progress);
        self.progress = self.target;
        for i in 0..self.on.len() {
            self.on[i] = (self.progress > 0.0 && self.order[i] <= self.progress) as u8;
            self.fresh[i] = 0.0;
        }
    }

    pub fn progress(&self) -> f32 {
        self.progress
    }

    /// Flick through the sequence. Strength scales how long it lasts.
    pub fn burst(&mut self, strength: f32) {
        if !strength.is_finite() || strength <= 0.0 || (self.progress <= 0.0 && self.target <= 0.0) {
            return;
        }
        self.burst_left = self.param(P_BURST_LENGTH).max(0.0) * strength.min(8.0);
        self.burst_age = 0.0;
    }

    /// Unsettle the blocks around a point, in cells.
    pub fn pulse(&mut self, x: f32, y: f32, radius: f32, strength: f32) {
        if !(x.is_finite() && y.is_finite() && radius.is_finite() && strength.is_finite()) {
            return;
        }
        let r = radius.clamp(0.5, 1e4);
        let s = strength.clamp(0.0, MAX_EXCITE);
        if s <= 0.0 {
            return;
        }
        let reach = (2.0 * r).ceil() as i32;
        let (cx, cy) = (x.floor() as i32, y.floor() as i32);
        let inv = 1.0 / (r * r);
        for yy in (cy - reach).max(0)..=(cy + reach).min(self.h as i32 - 1) {
            for xx in (cx - reach).max(0)..=(cx + reach).min(self.w as i32 - 1) {
                let (dx, dy) = (xx as f32 + 0.5 - x, yy as f32 + 0.5 - y);
                let e = &mut self.excite[yy as usize * self.w + xx as usize];
                *e = (*e + s * (-(dx * dx + dy * dy) * inv).exp()).min(MAX_EXCITE);
            }
        }
        self.restless = true;
    }

    pub fn step(&mut self, dt: f32) {
        let dt = finite(dt, 0.0).clamp(0.0, 0.1);
        self.time += dt;

        let gap = self.target - self.progress;
        let stride = self.param(P_SPEED).max(0.0) * dt;
        self.progress = if gap.abs() <= stride {
            self.target
        } else {
            self.progress + stride * gap.signum()
        };

        let shown = self.progress > 0.0 || self.target > 0.0;
        if !shown {
            self.burst_left = 0.0;
        } else if self.burst_left > 0.0 {
            self.burst_left -= dt;
            self.burst_age += dt;
        } else if self.rand() < self.param(P_BURST_RATE).max(0.0) * dt {
            self.burst(1.0);
        }
        let bursting = self.burst_left > 0.0;
        let style = self.param(P_STYLE).clamp(0.0, 4.0) as u8;
        let hold = self.param(P_HOLD).max(0.02);
        let (mode, flick) = if bursting {
            let slot = (self.burst_age / self.param(P_SWITCH).max(0.02)) as usize;
            (SEQUENCE[slot % SEQUENCE.len()], slot as u32 + 1000)
        } else {
            (style, (self.time / (hold * 3.0)) as u32)
        };

        let fade = (-self.param(P_GLOW_DECAY).max(0.0) * dt).exp();
        let calm = (-self.param(P_DECAY).max(0.0) * dt).exp();
        let mut restless = false;
        for i in 0..self.fresh.len() {
            self.fresh[i] *= fade;
            self.excite[i] *= calm;
            restless |= self.fresh[i] > 0.01 || self.excite[i] > 0.01;
        }
        self.restless = restless;
        self.pack(mode, bursting, flick);
    }

    fn pack(&mut self, mode: u8, bursting: bool, flick: u32) {
        let (w, h) = (self.w, self.h);
        let thr = self.threshold();
        let shown = self.progress > 0.0;
        for i in 0..w * h {
            let now = shown && self.order[i] <= self.progress;
            if now != (self.on[i] != 0) {
                self.on[i] = now as u8;
                // arriving flashes; leaving leaves an afterglow
                self.fresh[i] = if now { 1.0 } else { 0.5 };
                self.restless = true;
            }
        }

        let hold = self.param(P_HOLD).max(0.02);
        let glitch = self.param(P_GLITCH).clamp(0.0, 1.0);
        let gain = self.param(P_EXCITE_GAIN).max(0.0);
        let (hole, pixel, shift) = (
            self.param(P_HOLE).max(0.0),
            self.param(P_PIXEL).max(0.0),
            self.param(P_SHIFT).max(0.0),
        );
        let total = hole + pixel + shift;
        let labels = self.param(P_LABELS).clamp(0.0, 1.0);
        let dots = self.param(P_DOTS).clamp(0.0, 1.0);
        let glow = self.param(P_GLOW).clamp(0.0, 4.0);

        for y in 0..h {
            for x in 0..w {
                let i = y * w + x;
                let o = self.origin[i] as usize;
                let id = self.block[i];
                let lvl = self.level[i];
                let present = self.presence[i] > thr;
                let covered = self.cover[i] != 0;
                // Outside a burst, only what has arrived is drawn. A burst
                // shows the whole subject, arrived or not.
                let there = bursting || self.on[i] != 0;
                let cell = mix3(i as u32, 0xce11, self.seed);
                let (mut kind, mut shape, mut lot) = (KIND_OFF, 0u8, cell as u8);

                match mode {
                    MODE_IMAGE if self.on[i] != 0 => {
                        kind = KIND_IMAGE;
                        shape = lvl;
                        lot = id as u8;
                        // Each block re-rolls on its own clock, so they do
                        // not all change on the same frame.
                        let slot = (self.time / hold + unit(mix(id ^ 0x51))) as u32 ^ (bursting as u32 * flick);
                        let unsettled = self.fresh[o];
                        let mut odds = glitch + gain * self.excite[o] + 0.35 * unsettled;
                        if bursting {
                            odds += 0.45;
                        }
                        if total > 0.0 && unit(mix3(id, slot, 2)) < odds {
                            let pick = unit(mix3(id, slot, 3)) * total;
                            lot = mix3(id, slot, 4) as u8;
                            if pick < hole {
                                kind = KIND_OFF;
                            } else {
                                kind = if pick < hole + pixel { KIND_PIXEL } else { KIND_SHIFT };
                                shape |= FLAG_OUTLINE;
                            }
                        } else if unsettled > 0.3 && unit(mix(id ^ 0x0071)) < 0.5 {
                            shape |= FLAG_OUTLINE;
                        }
                    }
                    // A number beside a block that has arrived, in the
                    // background that has not.
                    MODE_IMAGE if shown && lvl == 1 && !covered && o % w > 0 => {
                        let beside = o - 1;
                        if self.on[beside] != 0
                            && self.cover[beside] != 0
                            && unit(mix(id ^ 0x1abe1)) < labels
                        {
                            kind = KIND_LABEL;
                            shape = 1;
                            lot = id as u8;
                        }
                    }
                    MODE_DOTS if present && there => {
                        let r = unit(cell);
                        if r < dots * 0.04 {
                            kind = KIND_WHITE;
                        } else if r < dots {
                            kind = KIND_DOT;
                        }
                    }
                    MODE_MOSAIC if covered && there && unit(mix3(id, flick, 12)) < 0.75 => {
                        kind = KIND_GREY;
                        shape = lvl;
                        lot = mix3(id, flick, 14) as u8;
                    }
                    MODE_MASK if there => {
                        if covered && lvl <= 1 && unit(mix3(id, flick, 13)) < 0.3 {
                            kind = KIND_WHITE;
                            shape = lvl;
                        } else if present {
                            // hairlines run four cells, along a row or a column
                            let across = unit(mix3((x >> 2) as u32 | (y as u32) << 12, flick, 15)) < 0.07;
                            let down = unit(mix3(x as u32 | ((y >> 2) as u32) << 12, flick, 16)) < 0.07;
                            kind = match (across, down) {
                                (true, true) => KIND_CROSS,
                                (true, false) => KIND_HLINE,
                                (false, true) => KIND_VLINE,
                                _ => KIND_OFF,
                            };
                        }
                    }
                    MODE_ASCII if present && there => kind = KIND_ASCII,
                    _ => {}
                }

                let px = &mut self.out[i * 4..i * 4 + 4];
                px[0] = kind;
                px[1] = shape;
                px[2] = 0;
                px[3] = lot;
                let lit = if kind == KIND_WHITE && mode == MODE_MASK { 0.5 } else { 0.0 };
                self.scratch[i] = ((self.fresh[i] + lit) * glow).min(1.5);
            }
        }

        // Two passes of a 1-2-1 kernel each way: wide enough to read as a
        // bloom at a cell's scale, and it is a few thousand cells.
        for _ in 0..2 {
            for y in 0..h {
                for x in 0..w {
                    let i = y * w + x;
                    let (l, r) = (self.scratch[i - (x > 0) as usize], self.scratch[i + (x + 1 < w) as usize]);
                    self.blur[i] = (l + 2.0 * self.scratch[i] + r) * 0.25;
                }
            }
            for y in 0..h {
                for x in 0..w {
                    let i = y * w + x;
                    let (u, d) = (self.blur[i - (y > 0) as usize * w], self.blur[i + (y + 1 < h) as usize * w]);
                    self.scratch[i] = (u + 2.0 * self.blur[i] + d) * 0.25;
                }
            }
        }
        for i in 0..w * h {
            self.glow[i] = (self.scratch[i] * 255.0).min(255.0) as u8;
        }
    }

    /// True when another step would draw the same frame.
    pub fn idle(&self) -> bool {
        if self.progress != self.target || self.burst_left > 0.0 || self.restless {
            return false;
        }
        if self.progress <= 0.0 {
            return true;
        }
        let style = self.param(P_STYLE).clamp(0.0, 4.0) as u8;
        let still = style == MODE_DOTS || style == MODE_ASCII || (style == MODE_IMAGE && self.param(P_GLITCH) <= 0.0);
        still && self.param(P_BURST_RATE) <= 0.0
    }
}

// --- the C ABI ---------------------------------------------------------------

static mut STATE: Option<Glitch> = None;

#[inline(always)]
#[allow(static_mut_refs)]
fn st() -> &'static mut Glitch {
    unsafe { (*addr_of_mut!(STATE)).as_mut().unwrap() }
}

/// Allocate the grid. Returns 0 if the size was refused.
#[no_mangle]
pub extern "C" fn init(w: u32, h: u32) -> u32 {
    if w < 2 || h < 2 || w > MAX_DIM || h > MAX_DIM {
        return 0;
    }
    unsafe {
        STATE = Some(Glitch::new(w as usize, h as usize));
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

/// One byte per cell for the host to fill in: how much subject is there.
#[no_mangle]
pub extern "C" fn presence_ptr() -> *mut u8 {
    st().presence.as_mut_ptr()
}

/// Four bytes per cell: kind, shape, 0, lot.
#[no_mangle]
pub extern "C" fn out_ptr() -> *const u8 {
    st().out.as_ptr()
}

/// One byte per cell of glow.
#[no_mangle]
pub extern "C" fn glow_ptr() -> *const u8 {
    st().glow.as_ptr()
}

#[no_mangle]
pub extern "C" fn layout() {
    st().layout()
}

#[no_mangle]
pub extern "C" fn step(dt: f32) {
    st().step(dt)
}

#[no_mangle]
pub extern "C" fn set_target(target: f32) {
    st().set_target(target)
}

#[no_mangle]
pub extern "C" fn set_progress(progress: f32) {
    st().set_progress(progress)
}

#[no_mangle]
pub extern "C" fn progress() -> f32 {
    st().progress()
}

#[no_mangle]
pub extern "C" fn burst(strength: f32) {
    st().burst(strength)
}

#[no_mangle]
pub extern "C" fn pulse(x: f32, y: f32, radius: f32, strength: f32) {
    st().pulse(x, y, radius, strength)
}

#[no_mangle]
pub extern "C" fn reseed(seed: u32) {
    st().reseed(seed)
}

#[no_mangle]
pub extern "C" fn idle() -> u32 {
    st().idle() as u32
}

#[cfg(test)]
mod tests {
    use super::*;

    const W: usize = 40;
    const H: usize = 30;

    /// A disc of subject in the middle of an empty grid, with nothing random
    /// left switched on.
    fn disc() -> Glitch {
        let mut g = Glitch::new(W, H);
        for y in 0..H {
            for x in 0..W {
                let (dx, dy) = (x as f32 - 20.0, y as f32 - 15.0);
                g.presence[y * W + x] = if dx * dx + dy * dy < 100.0 { 255 } else { 0 };
            }
        }
        g.params[P_GLITCH] = 0.0;
        g.params[P_BURST_RATE] = 0.0;
        g.layout();
        g
    }

    fn run(g: &mut Glitch, seconds: f32) {
        for _ in 0..(seconds * 30.0) as usize {
            g.step(1.0 / 30.0);
        }
    }

    fn kinds(g: &Glitch) -> Vec<u8> {
        g.out.chunks(4).map(|px| px[0]).collect()
    }

    #[test]
    fn hidden_draws_nothing_and_sleeps() {
        let mut g = disc();
        run(&mut g, 1.0);
        assert!(kinds(&g).iter().all(|&k| k == KIND_OFF));
        assert!(g.glow.iter().all(|&v| v == 0));
        assert!(g.idle());
        g.burst(1.0);
        assert!(g.idle(), "a burst with nothing shown has nothing to flick");
    }

    #[test]
    fn a_reveal_ends_with_the_whole_picture_and_settles() {
        let mut g = disc();
        g.set_target(1.0);
        assert!(!g.idle());
        run(&mut g, 6.0);
        assert_eq!(g.progress(), 1.0);
        assert!(kinds(&g).iter().all(|&k| k == KIND_IMAGE));
        assert!(g.idle());
    }

    #[test]
    fn the_subject_arrives_before_the_background() {
        let mut g = disc();
        g.set_progress(SUBJECT_SHARE - 0.001);
        g.step(0.0);
        for (i, k) in kinds(&g).into_iter().enumerate() {
            let arrived = k == KIND_IMAGE || k == KIND_PIXEL || k == KIND_SHIFT;
            if g.presence[i] > 0 {
                assert!(arrived || k == KIND_OFF, "subject cell {i} drew kind {k}");
            } else if g.cover[i] == 0 {
                assert!(!arrived, "background cell {i} arrived early");
            }
        }
        let subject = (0..W * H).filter(|&i| g.presence[i] > 0).count();
        let on = (0..W * H).filter(|&i| g.presence[i] > 0 && g.on[i] != 0).count();
        assert_eq!(on, subject, "every subject cell is in by SUBJECT_SHARE");
    }

    #[test]
    fn the_cells_of_a_block_agree() {
        let mut g = disc();
        g.params[P_GLITCH] = 0.5;
        g.set_progress(1.0);
        run(&mut g, 0.5);
        let mut big = 0;
        for i in 0..W * H {
            let o = g.origin[i] as usize;
            assert_eq!(g.out[i * 4..i * 4 + 4], g.out[o * 4..o * 4 + 4], "cell {i} and its block disagree");
            big += (g.level[i] >= 2) as usize;
        }
        assert!(big > 0, "the quadtree left no block bigger than two cells");
        assert!(kinds(&g).iter().any(|&k| k == KIND_PIXEL || k == KIND_SHIFT));
    }

    #[test]
    fn the_edge_is_cut_fine() {
        let g = disc();
        for i in 0..W * H {
            let size = 1usize << g.level[i];
            let (ox, oy) = (g.origin[i] as usize % W, g.origin[i] as usize / W);
            let cells = (oy..(oy + size).min(H)).flat_map(|y| (ox..(ox + size).min(W)).map(move |x| y * W + x));
            let inside = cells.filter(|&j| g.presence[j] > 0).count();
            let area = ((ox + size).min(W) - ox) * ((oy + size).min(H) - oy);
            if inside > 0 && inside < area {
                assert!(g.level[i] <= 1, "a block of {size} straddles the edge");
            }
        }
    }

    #[test]
    fn a_burst_flicks_through_the_sequence_and_lets_go() {
        let mut g = disc();
        g.set_progress(1.0);
        g.burst(1.0);
        let mut seen = [false; 12];
        for _ in 0..30 {
            g.step(1.0 / 30.0);
            for k in kinds(&g) {
                seen[k as usize] = true;
            }
        }
        for k in [KIND_DOT, KIND_GREY, KIND_WHITE, KIND_IMAGE] {
            assert!(seen[k as usize], "the burst never drew kind {k}");
        }
        run(&mut g, 3.0);
        assert!(kinds(&g).iter().all(|&k| k == KIND_IMAGE));
        assert!(g.idle());
    }

    #[test]
    fn a_pulse_unsettles_blocks_near_it_and_fades() {
        let mut g = disc();
        g.set_progress(1.0);
        g.step(1.0 / 30.0);
        assert!(g.idle());
        g.pulse(20.0, 15.0, 4.0, 4.0);
        assert!(!g.idle());
        g.step(1.0 / 30.0);
        let odd: Vec<usize> = (0..W * H).filter(|&i| g.out[i * 4] != KIND_IMAGE).collect();
        assert!(!odd.is_empty(), "nothing misbehaved under the pointer");
        for i in odd {
            let (dx, dy) = ((i % W) as f32 - 20.0, (i / W) as f32 - 15.0);
            assert!(dx.hypot(dy) < 18.0, "cell {i} misbehaved far from the pointer");
        }
        run(&mut g, 4.0);
        assert!(g.idle());
    }

    #[test]
    fn arriving_flashes() {
        let mut g = disc();
        g.set_target(1.0);
        run(&mut g, 0.4);
        assert!(g.glow.iter().any(|&v| v > 40), "no glow at the reveal front");
        g.params[P_GLOW] = 0.0;
        g.step(1.0 / 30.0);
        assert!(g.glow.iter().all(|&v| v == 0));
    }

    #[test]
    fn the_same_seed_replays_the_same_frames() {
        let film = |seed| {
            let mut g = disc();
            g.params[P_GLITCH] = 0.3;
            g.params[P_BURST_RATE] = 1.0;
            g.reseed(seed);
            g.set_target(1.0);
            let mut frames = Vec::new();
            for _ in 0..60 {
                g.step(1.0 / 30.0);
                frames.extend_from_slice(&g.out);
            }
            frames
        };
        assert_eq!(film(7), film(7));
        assert_ne!(film(7), film(8));
    }

    #[test]
    fn each_resting_style_draws_its_own_kind() {
        for (style, kind) in [(MODE_DOTS, KIND_DOT), (MODE_MOSAIC, KIND_GREY), (MODE_MASK, KIND_WHITE), (MODE_ASCII, KIND_ASCII)] {
            let mut g = disc();
            g.params[P_STYLE] = style as f32;
            g.set_progress(1.0);
            g.step(1.0 / 30.0);
            let drawn = kinds(&g);
            assert!(drawn.contains(&kind), "style {style} drew no kind {kind}");
            assert!(!drawn.contains(&KIND_IMAGE), "style {style} drew the picture");
        }
    }

    #[test]
    fn hostile_input_is_refused_without_a_panic() {
        let mut g = disc();
        g.params = [f32::NAN; PARAM_COUNT];
        g.set_target(f32::NAN);
        g.set_target(9.0);
        g.pulse(f32::INFINITY, 0.0, 1.0, 1.0);
        g.pulse(-50.0, 900.0, 1e9, 1e9);
        g.burst(f32::NAN);
        g.burst(1e9);
        g.step(f32::NAN);
        g.step(-1.0);
        g.step(1e9);
        g.presence.fill(0);
        g.layout();
        run(&mut g, 2.0);
        assert!(g.progress().is_finite());
        assert!(g.out.chunks(4).all(|px| px[0] <= KIND_LABEL));
    }
}
