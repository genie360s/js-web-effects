//! Granular sand height field.
//!
//! A stick dragged through beach sand does three things: it cuts a groove, it
//! piles the displaced grains up along the sides of that groove, and the piles
//! slump until no slope is steeper than the sand's angle of repose. This models
//! exactly those three, on a height field, with the work restricted to a dirty
//! rectangle so an idle page costs nothing.
//!
//! Copyright (c) 2026 Alex Mkwizu <alexgmkwizu@gmail.com> — MIT.

use std::os::raw::c_void;

/// Index into `Sand::info`, mirrored by the JS side as a `Uint32Array` view.
const INFO_DIRTY_X0: usize = 0;
const INFO_DIRTY_Y0: usize = 1;
const INFO_DIRTY_X1: usize = 2;
const INFO_DIRTY_Y1: usize = 3;
const INFO_ACTIVE: usize = 4;
const INFO_LEN: usize = 5;

/// Largest grid we will allocate on either axis (1024^2 cells = 12 MB of state).
const MAX_DIM: i32 = 1024;
/// Height change below which a cell counts as settled.
const SETTLE_EPS: f32 = 1e-4;
/// Fraction of the excess slope moved per relaxation pass. Above ~0.25 the
/// explicit scheme oscillates, since a cell can over-give to four neighbours.
const TOPPLE_RATE: f32 = 0.2;
/// Outer radius of the berm (the ridge of displaced sand) as a multiple of the
/// stroke radius.
const BERM_SPAN: f32 = 2.1;
/// How far below the resting surface a single stroke may cut, as a multiple of
/// its depth. Without this, dragging back and forth digs a bottomless trench.
const CUT_FLOOR: f32 = 1.7;
/// A stick thinner than this cannot be resolved by the grid, so it is carved at
/// this width and proportionally shallower instead of vanishing between cells.
const MIN_STROKE_RADIUS: f32 = 0.75;
/// How much of the rim a fast stroke throws forward instead of sideways.
const BOW_BIAS: f32 = 0.85;
/// Drift a stroke leaves behind, in cells per second per unit of push.
///
/// This is a tail, not a throw: colour is carried for roughly GAIN/decay cells
/// after the stick has gone, so a large gain flings the stirring far away from
/// anything the stick actually touched.
const DRIFT_GAIN: f32 = 8.0;
/// Fraction of the stick's own travel that the sand under it is carried along.
const DRAG_REACH: f32 = 0.42;
/// Cell-scale roughness in the cut, so a mark crumbles rather than being cast.
const GRAIN_JITTER: f32 = 0.22;
/// Fixed so the roughness is a property of the beach, not of the moment: the
/// same cell must crumble the same way every time it is crossed.
const GRAIN_SEED: u32 = 0x9e37_79b9;
/// Drift below this is snapped to zero. Exponential decay only ever approaches
/// it, and a field that never reaches rest never stops drawing.
const DRIFT_EPS: f32 = 0.02;

pub struct Sand {
    w: i32,
    h: i32,
    /// Surface displacement from flat, in grid cells.
    height: Vec<f32>,
    /// Scratch accumulator for the toppling pass.
    delta: Vec<f32>,
    /// 0..1 "freshly turned" mask: darker, wetter, less packed sand.
    disturb: Vec<f32>,
    /// Where the sand was last pushed, two interleaved cells-per-second
    /// components. This is what carries colour when the sand is stirred.
    drift: Vec<f32>,
    /// Interleaved half-float RGBA texels for the GPU:
    /// R=height, G=disturb, B=drift x, A=drift y.
    texels: Vec<u16>,
    info: [u32; INFO_LEN],
    dirty: Rect,
    repose: f32,
    recovery: f32,
    disturb_decay: f32,
    drift_decay: f32,
    drag: f32,
    topple_passes: u32,
}

#[derive(Clone, Copy)]
struct Rect {
    x0: i32,
    y0: i32,
    x1: i32,
    y1: i32,
}

impl Rect {
    const EMPTY: Rect = Rect { x0: i32::MAX, y0: i32::MAX, x1: i32::MIN, y1: i32::MIN };

    fn is_empty(&self) -> bool {
        self.x0 >= self.x1 || self.y0 >= self.y1
    }

    fn union(&mut self, x0: i32, y0: i32, x1: i32, y1: i32) {
        if x0 >= x1 || y0 >= y1 {
            return;
        }
        self.x0 = self.x0.min(x0);
        self.y0 = self.y0.min(y0);
        self.x1 = self.x1.max(x1);
        self.y1 = self.y1.max(y1);
    }

    /// Grow by `n` cells on every side, clamped to the grid.
    fn grow(&self, n: i32, w: i32, h: i32) -> Rect {
        if self.is_empty() {
            return *self;
        }
        Rect {
            x0: (self.x0 - n).max(0),
            y0: (self.y0 - n).max(0),
            x1: (self.x1 + n).min(w),
            y1: (self.y1 + n).min(h),
        }
    }
}

impl Sand {
    fn new(w: i32, h: i32) -> Sand {
        let cells = (w * h) as usize;
        Sand {
            w,
            h,
            height: vec![0.0; cells],
            delta: vec![0.0; cells],
            disturb: vec![0.0; cells],
            drift: vec![0.0; cells * 2],
            texels: vec![0; cells * 4],
            info: [0; INFO_LEN],
            dirty: Rect::EMPTY,
            repose: 0.62,
            recovery: 0.0,
            disturb_decay: 0.4,
            drift_decay: 5.0,
            drag: 0.6,
            topple_passes: 2,
        }
    }

    #[inline]
    fn idx(&self, x: i32, y: i32) -> usize {
        (y * self.w + x) as usize
    }

    /// Cut a capsule-shaped groove between two points and pile what came out of
    /// it along the rim. Coordinates are in grid cells.
    ///
    /// `push` is how hard the stick is travelling, 0..1. It does not change how
    /// much sand moves — that is `depth` — but where it goes: a fast stroke
    /// throws the spoil forward into a bow wave instead of evenly to both
    /// sides, and leaves drift behind it, which is what stirs colour through
    /// the sand.
    // Mirrors the flat C ABI the JavaScript side calls; grouping these into a
    // struct would only move the argument list across the boundary.
    #[allow(clippy::too_many_arguments)]
    fn stroke(&mut self, x0: f32, y0: f32, x1: f32, y1: f32, radius: f32, depth: f32, push: f32) {
        if !radius.is_finite() || radius <= 0.0 || !depth.is_finite() {
            return;
        }
        if !x0.is_finite() || !y0.is_finite() || !x1.is_finite() || !y1.is_finite() {
            return;
        }
        let push = clamp_finite(push, 0.0, 1.0);

        // A stick finer than the grid is carved at the finest width the grid
        // can hold, and shallower in proportion, so thin marks stay thin
        // instead of disappearing between cell centres.
        let radius = radius.min(MAX_DIM as f32);
        let carve_radius = radius.max(MIN_STROKE_RADIUS);
        let thinning = (radius / carve_radius).min(1.0);
        let depth = depth * thinning * thinning;

        let (mut dir_x, mut dir_y) = (x1 - x0, y1 - y0);
        let travel = (dir_x * dir_x + dir_y * dir_y).sqrt();
        if travel > 1e-4 {
            dir_x /= travel;
            dir_y /= travel;
        } else {
            dir_x = 0.0;
            dir_y = 0.0;
        }

        let outer = carve_radius * BERM_SPAN;
        let bx0 = (x0.min(x1) - outer).floor().max(0.0) as i32;
        let by0 = (y0.min(y1) - outer).floor().max(0.0) as i32;
        let bx1 = ((x0.max(x1) + outer).ceil() as i32 + 1).min(self.w);
        let by1 = ((y0.max(y1) + outer).ceil() as i32 + 1).min(self.h);
        if bx0 >= bx1 || by0 >= by1 {
            return;
        }

        let band = Rect { x0: bx0, y0: by0, x1: bx1, y1: by1 };
        if push > 0.0 && travel > 1e-3 {
            self.haul(band, (x0, y0), (x1, y1), carve_radius, outer,
                      (dir_x, dir_y), travel, push);
        }

        let floor_h = -depth * CUT_FLOOR;
        let drift = push * DRIFT_GAIN;
        let mut removed = 0.0f32;
        let mut weight_sum = 0.0f32;

        // Pass 1: carve inside the capsule, measure the rim we can deposit on.
        for y in by0..by1 {
            for x in bx0..bx1 {
                let (d, nx, ny) = seg_delta(x as f32 + 0.5, y as f32 + 0.5, x0, y0, x1, y1);
                let i = self.idx(x, y);
                if d < carve_radius {
                    let t = d / carve_radius;
                    // Circular cross-section: a round stick leaves a round
                    // groove, with a crumbling edge rather than a cast one.
                    let profile = (1.0 - t * t).max(0.0).sqrt()
                        * (1.0 - GRAIN_JITTER * grain_at(x, y, 0));
                    let target = (self.height[i] - depth * profile).max(floor_h);
                    if target < self.height[i] {
                        removed += self.height[i] - target;
                        self.height[i] = target;
                    }
                    self.disturb[i] = 1.0;
                    self.drift[i * 2] = dir_x * drift;
                    self.drift[i * 2 + 1] = dir_y * drift;
                } else if d < outer {
                    let f = (d - carve_radius) / (outer - carve_radius);
                    // Sand thrown by a moving stick lands ahead of it, not evenly
                    // around it, so the rim leans into the direction of travel.
                    let lean = 1.0 + BOW_BIAS * push * (nx * dir_x + ny * dir_y);
                    let w = (1.0 - f) * (1.0 - f) * lean.max(0.0)
                        * (1.0 - GRAIN_JITTER * grain_at(x, y, 17));
                    weight_sum += w;
                    self.disturb[i] = self.disturb[i].max(1.0 - f);
                    let carry = drift * (1.0 - f) * 0.7;
                    self.drift[i * 2] = self.drift[i * 2] * 0.5 + dir_x * carry;
                    self.drift[i * 2 + 1] = self.drift[i * 2 + 1] * 0.5 + dir_y * carry;
                }
            }
        }

        // Pass 2: give every removed grain back to the rim. Sand is conserved;
        // that conservation is what makes the berms read as real.
        if removed > 0.0 && weight_sum > 0.0 {
            let scale = removed / weight_sum;
            for y in by0..by1 {
                for x in bx0..bx1 {
                    let (d, nx, ny) = seg_delta(x as f32 + 0.5, y as f32 + 0.5, x0, y0, x1, y1);
                    if d >= carve_radius && d < outer {
                        let f = (d - carve_radius) / (outer - carve_radius);
                        let lean = 1.0 + BOW_BIAS * push * (nx * dir_x + ny * dir_y);
                        let w = (1.0 - f) * (1.0 - f) * lean.max(0.0)
                            * (1.0 - GRAIN_JITTER * grain_at(x, y, 17));
                        let i = self.idx(x, y);
                        self.height[i] += w * scale;
                    }
                }
            }
        }

        self.dirty.union(bx0, by0, bx1, by1);
        self.info[INFO_ACTIVE] = 1;
    }

    /// Spread `amount` over the four cells around a point, so nothing is lost
    /// to rounding. Off-grid shares land on the edge rather than vanishing.
    #[inline]
    fn scatter(&mut self, tx: f32, ty: f32, amount: f32) {
        let fx = tx.floor();
        let fy = ty.floor();
        let ax = tx - fx;
        let ay = ty - fy;
        let bx = fx as i32;
        let by = fy as i32;
        let corners = [
            (0, 0, (1.0 - ax) * (1.0 - ay)),
            (1, 0, ax * (1.0 - ay)),
            (0, 1, (1.0 - ax) * ay),
            (1, 1, ax * ay),
        ];
        for (dx, dy, w) in corners {
            if w <= 0.0 {
                continue;
            }
            let cx = (bx + dx).clamp(0, self.w - 1);
            let cy = (by + dy).clamp(0, self.h - 1);
            let i = self.idx(cx, cy);
            self.delta[i] += amount * w;
        }
    }

    /// Carry the sand that is already there along with the stick.
    ///
    /// Without this a stroke only ever adds a groove, and whatever was written
    /// in the sand beforehand stays crisp on either side of it. Pulling a stick
    /// through sand drags the surface with it, which is what wrecks the marks
    /// it crosses. Sand is moved, never created: every cell gives a share away
    /// and the four cells it lands between take exactly that much back.
    #[allow(clippy::too_many_arguments)]
    fn haul(&mut self, b: Rect, a: (f32, f32), z: (f32, f32), radius: f32, outer: f32,
            dir: (f32, f32), travel: f32, push: f32) {
        let grab = self.drag * push;
        if grab <= 0.0 {
            return;
        }
        let shift = (travel * DRAG_REACH).min(radius * 1.5);
        // Sand is carried up to `shift` past the band it was picked up in, and
        // spread over the four cells it lands between, so the scratch has to be
        // cleared and applied over that wider area or the overhang is lost.
        let wide = b.grow(shift.ceil() as i32 + 1, self.w, self.h);
        for y in wide.y0..wide.y1 {
            for x in wide.x0..wide.x1 {
                let i = self.idx(x, y);
                self.delta[i] = 0.0;
            }
        }
        for y in b.y0..b.y1 {
            for x in b.x0..b.x1 {
                let (d, _, _) = seg_delta(x as f32 + 0.5, y as f32 + 0.5, a.0, a.1, z.0, z.1);
                if d >= outer {
                    continue;
                }
                // Everything in the stick's path travels with it; sand out at
                // the rim only slides.
                let grip = if d < radius {
                    1.0
                } else {
                    1.0 - (d - radius) / (outer - radius)
                };
                let i = self.idx(x, y);
                let tx = x as f32 + dir.0 * shift;
                let ty = y as f32 + dir.1 * shift;
                let moved = self.height[i] * grip * grab;
                if moved == 0.0 {
                    continue;
                }
                self.delta[i] -= moved;
                self.scatter(tx, ty, moved);
            }
        }
        for y in wide.y0..wide.y1 {
            for x in wide.x0..wide.x1 {
                let i = self.idx(x, y);
                self.height[i] += self.delta[i];
                self.delta[i] = 0.0;
            }
        }
        self.dirty.union(wide.x0, wide.y0, wide.x1, wide.y1);
    }

    /// Slump every slope steeper than the angle of repose. Moves sand between
    /// neighbours through `delta` so the result does not depend on scan order.
    fn topple(&mut self, area: Rect) -> f32 {
        let mut peak = 0.0f32;
        for _ in 0..self.topple_passes {
            for y in area.y0..area.y1 {
                for x in area.x0..area.x1 {
                    let i = self.idx(x, y);
                    self.delta[i] = 0.0;
                }
            }
            for y in area.y0..area.y1 {
                for x in area.x0..area.x1 {
                    let i = self.idx(x, y);
                    let hi = self.height[i];
                    // Four-neighbour stencil; the diagonals are covered over
                    // successive passes and cost 2x for little visual gain.
                    if x + 1 < area.x1 {
                        self.flow(i, i + 1, hi);
                    }
                    if x > area.x0 {
                        self.flow(i, i - 1, hi);
                    }
                    if y + 1 < area.y1 {
                        self.flow(i, i + self.w as usize, hi);
                    }
                    if y > area.y0 {
                        self.flow(i, i - self.w as usize, hi);
                    }
                }
            }
            for y in area.y0..area.y1 {
                for x in area.x0..area.x1 {
                    let i = self.idx(x, y);
                    let d = self.delta[i];
                    if d != 0.0 {
                        self.height[i] += d;
                        peak = peak.max(d.abs());
                        self.disturb[i] = self.disturb[i].max((d.abs() * 6.0).min(0.7));
                    }
                }
            }
        }
        peak
    }

    #[inline]
    fn flow(&mut self, i: usize, j: usize, hi: f32) {
        let excess = hi - self.height[j] - self.repose;
        if excess > 0.0 {
            let moved = excess * TOPPLE_RATE;
            self.delta[i] -= moved;
            self.delta[j] += moved;
        }
    }

    fn step(&mut self, dt: f32) -> u32 {
        if self.dirty.is_empty() {
            self.info[INFO_ACTIVE] = 0;
            return 0;
        }
        let dt = clamp_finite(dt, 0.0, 0.1);
        // Sand slumps into cells just outside the disturbed area, so the
        // working rect has to lead the change by a cell.
        let area = self.dirty.grow(1, self.w, self.h);
        self.dirty = area;

        let mut peak = self.topple(area);

        // Wind and gravity slowly erase what was drawn, and turned-over sand
        // dries back to the colour of the rest of the beach.
        let fade = clamp_finite(1.0 - self.recovery * dt, 0.0, 1.0);
        let dry = self.disturb_decay * dt;
        let slow = clamp_finite(1.0 - self.drift_decay * dt, 0.0, 1.0);
        let mut max_disturb = 0.0f32;
        let mut stirring = false;
        let mut healing = false;
        // Where anything is still moving. Without this the rect only ever grows
        // and a single stroke ends up re-uploading the whole grid every frame.
        let mut live = Rect::EMPTY;
        for y in area.y0..area.y1 {
            for x in area.x0..area.x1 {
                let i = self.idx(x, y);
                let before = self.height[i];
                self.height[i] = before * fade;
                let moved = (self.height[i] - before).abs();
                peak = peak.max(moved);
                let d = (self.disturb[i] - dry).max(0.0);
                self.disturb[i] = d;
                max_disturb = max_disturb.max(d);
                // Wind keeps working long after the slumping has stopped, and
                // only over sand that is still standing proud of the beach.
                if self.recovery > 0.0 && self.height[i].abs() > SETTLE_EPS {
                    healing = true;
                    live.union(x, y, x + 1, y + 1);
                }
                if moved > SETTLE_EPS || d > 0.0 || self.delta[i] != 0.0 {
                    live.union(x, y, x + 1, y + 1);
                }
                // Drift is what the renderer smears colour along, so the field
                // has to stay awake until it has died away.
                let vx = self.drift[i * 2] * slow;
                let vy = self.drift[i * 2 + 1] * slow;
                if vx.abs() + vy.abs() < DRIFT_EPS {
                    self.drift[i * 2] = 0.0;
                    self.drift[i * 2 + 1] = 0.0;
                } else {
                    self.drift[i * 2] = vx;
                    self.drift[i * 2 + 1] = vy;
                    stirring = true;
                    live.union(x, y, x + 1, y + 1);
                }
            }
        }

        self.pack(area);
        self.info[INFO_DIRTY_X0] = area.x0 as u32;
        self.info[INFO_DIRTY_Y0] = area.y0 as u32;
        self.info[INFO_DIRTY_X1] = area.x1 as u32;
        self.info[INFO_DIRTY_Y1] = area.y1 as u32;

        // Once nothing moves, nothing is drying, nothing is drifting and the
        // wind has nothing left to flatten, stop: the texture already holds the
        // final state, so there is nothing left to upload or draw.
        if peak < SETTLE_EPS && max_disturb <= 0.0 && !stirring && !healing {
            self.dirty = Rect::EMPTY;
            self.info[INFO_ACTIVE] = 0;
        } else {
            // Follow the moving sand rather than the high-water mark of it.
            self.dirty = live.grow(1, self.w, self.h);
            self.info[INFO_ACTIVE] = 1;
        }
        1
    }

    fn pack(&mut self, area: Rect) {
        for y in area.y0..area.y1 {
            for x in area.x0..area.x1 {
                let i = self.idx(x, y);
                self.texels[i * 4] = f32_to_f16(self.height[i]);
                self.texels[i * 4 + 1] = f32_to_f16(self.disturb[i]);
                self.texels[i * 4 + 2] = f32_to_f16(self.drift[i * 2]);
                self.texels[i * 4 + 3] = f32_to_f16(self.drift[i * 2 + 1]);
            }
        }
    }

    fn reset(&mut self) {
        self.height.iter_mut().for_each(|v| *v = 0.0);
        self.disturb.iter_mut().for_each(|v| *v = 0.0);
        self.drift.iter_mut().for_each(|v| *v = 0.0);
        self.texels.iter_mut().for_each(|v| *v = 0);
        self.dirty = Rect { x0: 0, y0: 0, x1: self.w, y1: self.h };
        self.info[INFO_ACTIVE] = 1;
    }

    /// Total sand in the field — constant except for wind recovery. Used by the
    /// conservation test.
    #[must_use]
    pub fn mass(&self) -> f32 {
        self.height.iter().sum()
    }
}

/// `f32::clamp` propagates NaN, and one NaN in the field spreads to every cell
/// it touches. Every value crossing the JS boundary goes through here instead.
#[inline]
fn clamp_finite(v: f32, lo: f32, hi: f32) -> f32 {
    if v.is_finite() {
        v.clamp(lo, hi)
    } else {
        lo
    }
}

/// Stable per-cell roughness in 0..1. Sand does not cut like butter: the edge
/// of a mark crumbles at grain scale, and the same cell always crumbles alike.
#[inline]
fn grain_at(x: i32, y: i32, salt: u32) -> f32 {
    let mut h = (x as u32)
        .wrapping_mul(0x27d4_eb2d)
        ^ (y as u32).wrapping_mul(0x1656_67b1)
        ^ GRAIN_SEED.wrapping_add(salt);
    h ^= h >> 15;
    h = h.wrapping_mul(0x85eb_ca6b);
    h ^= h >> 13;
    (h & 0xffff) as f32 / 65535.0
}

/// Distance from a point to a segment, plus the unit vector pointing from the
/// segment out to that point — which is the direction the rim sits in.
#[inline]
fn seg_delta(px: f32, py: f32, ax: f32, ay: f32, bx: f32, by: f32) -> (f32, f32, f32) {
    let vx = bx - ax;
    let vy = by - ay;
    let len2 = vx * vx + vy * vy;
    let t = if len2 > 1e-12 {
        (((px - ax) * vx + (py - ay) * vy) / len2).clamp(0.0, 1.0)
    } else {
        0.0
    };
    let dx = px - (ax + t * vx);
    let dy = py - (ay + t * vy);
    let d = (dx * dx + dy * dy).sqrt();
    if d > 1e-6 {
        (d, dx / d, dy / d)
    } else {
        (d, 0.0, 0.0)
    }
}

/// IEEE-754 binary32 to binary16, round-to-nearest, subnormals flushed to zero.
/// Our values live in roughly -4..4, where f16 resolves ~5e-4 — far finer than
/// the shading can show, at half the upload bandwidth of f32.
#[inline]
fn f32_to_f16(v: f32) -> u16 {
    if !v.is_finite() {
        return if v.is_nan() { 0x7e00 } else if v > 0.0 { 0x7c00 } else { 0xfc00 };
    }
    let bits = v.to_bits();
    let sign = ((bits >> 16) & 0x8000) as u16;
    // Bias the dropped mantissa bits so the shift rounds instead of truncating.
    let rounded = bits.wrapping_add(0x0000_1000);
    let exp = ((rounded >> 23) & 0xff) as i32 - 127 + 15;
    if exp >= 31 {
        return sign | 0x7c00;
    }
    if exp <= 0 {
        return sign;
    }
    sign | ((exp as u16) << 10) | (((rounded >> 13) & 0x03ff) as u16)
}

// --- C ABI: the surface JavaScript talks to. Every pointer coming back across
// this boundary is untrusted, so each entry point checks it. ---

/// Allocate a grid. Returns null for out-of-range dimensions.
#[no_mangle]
pub extern "C" fn sand_create(w: i32, h: i32) -> *mut c_void {
    if w < 2 || h < 2 || w > MAX_DIM || h > MAX_DIM {
        return std::ptr::null_mut();
    }
    Box::into_raw(Box::new(Sand::new(w, h))).cast::<c_void>()
}

/// # Safety
/// `p` must be a pointer returned by `sand_create` and not yet destroyed.
#[no_mangle]
pub unsafe extern "C" fn sand_destroy(p: *mut c_void) {
    if !p.is_null() {
        drop(Box::from_raw(p.cast::<Sand>()));
    }
}

/// # Safety
/// `p` must be a live pointer from `sand_create`.
#[no_mangle]
pub unsafe extern "C" fn sand_texels(p: *mut c_void) -> *const u16 {
    match p.cast::<Sand>().as_ref() {
        Some(s) => s.texels.as_ptr(),
        None => std::ptr::null(),
    }
}

/// Pointer to `[dirty_x0, dirty_y0, dirty_x1, dirty_y1, active]`.
///
/// # Safety
/// `p` must be a live pointer from `sand_create`.
#[no_mangle]
pub unsafe extern "C" fn sand_info(p: *mut c_void) -> *const u32 {
    match p.cast::<Sand>().as_ref() {
        Some(s) => s.info.as_ptr(),
        None => std::ptr::null(),
    }
}

/// # Safety
/// `p` must be a live pointer from `sand_create`.
#[no_mangle]
#[allow(clippy::too_many_arguments)]
pub unsafe extern "C" fn sand_stroke(
    p: *mut c_void,
    x0: f32,
    y0: f32,
    x1: f32,
    y1: f32,
    radius: f32,
    depth: f32,
    push: f32,
) {
    if let Some(s) = p.cast::<Sand>().as_mut() {
        s.stroke(x0, y0, x1, y1, radius, depth, push);
    }
}

/// Advance by `dt` seconds. Returns 1 if the texel buffer changed.
///
/// # Safety
/// `p` must be a live pointer from `sand_create`.
#[no_mangle]
pub unsafe extern "C" fn sand_step(p: *mut c_void, dt: f32) -> u32 {
    match p.cast::<Sand>().as_mut() {
        Some(s) => s.step(dt),
        None => 0,
    }
}

/// # Safety
/// `p` must be a live pointer from `sand_create`.
#[no_mangle]
pub unsafe extern "C" fn sand_reset(p: *mut c_void) {
    if let Some(s) = p.cast::<Sand>().as_mut() {
        s.reset();
    }
}

/// Mark the whole grid for re-packing without disturbing it. The GPU texture
/// is lost when the WebGL context is lost; this is how it gets refilled.
///
/// # Safety
/// `p` must be a live pointer from `sand_create`.
#[no_mangle]
pub unsafe extern "C" fn sand_repack(p: *mut c_void) {
    if let Some(s) = p.cast::<Sand>().as_mut() {
        s.dirty = Rect { x0: 0, y0: 0, x1: s.w, y1: s.h };
        s.info[INFO_ACTIVE] = 1;
    }
}

/// Tunables. `repose` is the steepest height difference allowed between
/// neighbouring cells, `recovery` how fast wind flattens marks (per second),
/// `disturb_decay` how fast turned sand dries, `drift_decay` how fast the
/// stirring dies away, `drag` how much of the sand under the stick travels
/// with it, `passes` the slump iterations per frame.
///
/// # Safety
/// `p` must be a live pointer from `sand_create`.
#[no_mangle]
#[allow(clippy::too_many_arguments)]
pub unsafe extern "C" fn sand_set_params(
    p: *mut c_void,
    repose: f32,
    recovery: f32,
    disturb_decay: f32,
    drift_decay: f32,
    drag: f32,
    passes: u32,
) {
    if let Some(s) = p.cast::<Sand>().as_mut() {
        s.repose = clamp_finite(repose, 0.02, 8.0);
        s.recovery = clamp_finite(recovery, 0.0, 10.0);
        s.disturb_decay = clamp_finite(disturb_decay, 0.0, 10.0);
        s.drift_decay = clamp_finite(drift_decay, 0.05, 20.0);
        s.drag = clamp_finite(drag, 0.0, 1.0);
        s.topple_passes = passes.clamp(1, 8);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn drive(s: &mut Sand, frames: usize) {
        for _ in 0..frames {
            s.step(1.0 / 60.0);
        }
    }

    #[test]
    fn stroke_conserves_sand_and_settles() {
        let mut s = Sand::new(96, 96);
        s.recovery = 0.0; // isolate the transport from the wind term
        s.stroke(20.0, 48.0, 76.0, 48.0, 5.0, 1.0, 0.0);
        let after_cut = s.mass();
        assert!(after_cut.abs() < 1e-2, "carving must not create sand: {after_cut}");

        drive(&mut s, 600);
        assert!(s.mass().abs() < 1e-2, "slumping must not create sand: {}", s.mass());
        assert!(s.height.iter().all(|v| v.is_finite()), "field went non-finite");
        assert_eq!(s.info[INFO_ACTIVE], 0, "field should reach rest");

        // The groove is still a groove, with rims standing above the flat.
        assert!(s.height[s.idx(48, 48)] < -0.2, "groove vanished");
        assert!(s.height[s.idx(48, 41)] > 0.02, "no berm beside the groove");
    }

    #[test]
    fn repose_is_respected_after_settling() {
        let mut s = Sand::new(64, 64);
        s.recovery = 0.0;
        s.stroke(32.0, 32.0, 32.0, 32.0, 6.0, 3.0, 0.0);
        drive(&mut s, 1200);
        for y in 1..63 {
            for x in 1..63 {
                let d = s.height[s.idx(x, y)] - s.height[s.idx(x + 1, y)];
                assert!(d <= s.repose + 1e-2, "slope {d} exceeds repose at {x},{y}");
            }
        }
    }

    #[test]
    fn wind_recovery_returns_the_beach_to_flat() {
        let mut s = Sand::new(48, 48);
        s.recovery = 2.0; // off by default; this is what turning it on does
        s.stroke(10.0, 24.0, 38.0, 24.0, 4.0, 1.0, 0.0);
        drive(&mut s, 900);
        assert!(s.height.iter().all(|v| v.abs() < 0.02), "marks never faded");
    }

    #[test]
    fn repack_refills_the_texture_without_losing_the_drawing() {
        let mut s = Sand::new(64, 64);
        s.stroke(10.0, 32.0, 54.0, 32.0, 4.0, 1.0, 0.0);
        while s.info[INFO_ACTIVE] == 1 {
            s.step(1.0 / 60.0);
        }
        let carved = s.height[s.idx(32, 32)];
        s.texels.iter_mut().for_each(|v| *v = 0); // simulate a lost GPU texture
        unsafe { sand_repack(std::ptr::from_mut(&mut s).cast::<c_void>()) };
        s.step(1.0 / 60.0);
        assert_ne!(s.texels[(32 * 64 + 32) * 4], 0, "texture was not refilled");
        assert!((s.height[s.idx(32, 32)] - carved).abs() < 0.05, "repack disturbed the field");
    }

    #[test]
    fn a_fast_stroke_throws_its_spoil_forward() {
        // Where the piled sand ends up: centred on the cut when the stick is
        // barely moving, banked ahead of it when it is travelling.
        let pile_centre = |push: f32| {
            let mut s = Sand::new(96, 96);
            s.recovery = 0.0;
            s.stroke(40.0, 48.0, 56.0, 48.0, 4.0, 1.0, push);
            let (mut mass, mut moment) = (0.0f32, 0.0f32);
            for y in 0..96 {
                for x in 0..96 {
                    let h = s.height[s.idx(x, y)].max(0.0);
                    mass += h;
                    moment += h * x as f32;
                }
            }
            moment / mass.max(1e-6)
        };

        let still = pile_centre(0.0);
        let fast = pile_centre(1.0);
        assert!((still - 48.0).abs() < 1.0, "a still stick should pile evenly around the cut, got {still}");
        assert!(fast > still + 1.5, "a fast stroke must bank sand ahead: {fast} vs {still}");
    }

    #[test]
    fn a_stroke_drags_what_was_already_written_in_the_sand() {
        // A ridge lying across the stick's path. Pulling through it has to take
        // it along, not simply cut a clean notch and leave the rest crisp.
        let ridge_centre = |drag: f32| {
            let mut s = Sand::new(96, 96);
            s.recovery = 0.0;
            s.drag = drag;
            for y in 40..56 {
                for x in 46..50 {
                    let i = s.idx(x, y);
                    s.height[i] = 1.0;
                }
            }
            let before: f32 = (0..96).map(|x| s.height[s.idx(x, 48)].max(0.0)).sum();
            s.stroke(30.0, 48.0, 62.0, 48.0, 5.0, 0.2, 1.0);
            let (mut mass, mut moment) = (0.0f32, 0.0f32);
            for y in 40..56 {
                for x in 0..96 {
                    let h = s.height[s.idx(x, y)].max(0.0);
                    mass += h;
                    moment += h * x as f32;
                }
            }
            (moment / mass.max(1e-6), before)
        };

        let (held, _) = ridge_centre(0.0);
        let (hauled, _) = ridge_centre(1.0);
        assert!(hauled > held + 1.0, "the mark was not dragged along: {hauled} vs {held}");
    }

    #[test]
    fn hauling_moves_sand_without_making_any() {
        let mut s = Sand::new(96, 96);
        s.recovery = 0.0;
        s.drag = 1.0;
        for y in 40..56 {
            for x in 46..50 {
                let i = s.idx(x, y);
                s.height[i] = 1.0;
            }
        }
        let before = s.mass();
        for _ in 0..12 {
            s.stroke(30.0, 48.0, 62.0, 48.0, 5.0, 0.0, 1.0);
        }
        assert!((s.mass() - before).abs() < 1e-2, "hauling changed the total: {} -> {}", before, s.mass());
        assert!(s.height.iter().all(|v| v.is_finite()));
    }

    #[test]
    fn a_stroke_leaves_drift_that_dies_away() {
        let mut s = Sand::new(64, 64);
        s.recovery = 0.0;
        s.stroke(10.0, 32.0, 50.0, 32.0, 4.0, 1.0, 1.0);
        let i = s.idx(30, 32);
        assert!(s.drift[i * 2] > 1.0, "a rightward stroke must drift rightwards");
        assert!(s.drift[i * 2 + 1].abs() < 1e-3, "and not sideways");
        for _ in 0..600 {
            s.step(1.0 / 60.0);
        }
        assert!(s.drift[i * 2].abs() < 0.05, "drift must settle: {}", s.drift[i * 2]);
        assert_eq!(s.info[INFO_ACTIVE], 0, "drift must not keep the field awake forever");
    }

    #[test]
    fn a_stick_finer_than_the_grid_still_marks_it() {
        let mut s = Sand::new(64, 64);
        s.recovery = 0.0;
        s.stroke(10.0, 32.0, 50.0, 32.0, 0.15, 1.0, 0.0);
        let cut = s.height[s.idx(30, 32)];
        assert!(cut < -0.005, "a hair-thin stick left nothing at all: {cut}");
        assert!(cut > -0.2, "and it must be far shallower than a full-width one: {cut}");
    }

    #[test]
    fn the_working_rect_follows_the_sand_instead_of_only_growing() {
        let mut s = Sand::new(192, 108);
        s.stroke(80.0, 54.0, 110.0, 54.0, 4.0, 1.0, 0.4);
        let cells = (s.w * s.h) as f32;
        let mut widest = 0.0f32;
        let mut frames = 0;
        while s.info[INFO_ACTIVE] == 1 && frames < 4000 {
            s.step(1.0 / 60.0);
            let r = s.dirty;
            if !r.is_empty() {
                widest = widest.max(((r.x1 - r.x0) * (r.y1 - r.y0)) as f32 / cells);
            }
            frames += 1;
        }
        assert!(frames < 4000, "field never settled");
        assert!(widest < 0.35, "the rect swallowed {:.0}% of the grid", widest * 100.0);
    }

    #[test]
    fn a_slow_wind_still_gets_all_the_way_back_to_flat() {
        // The fade per frame falls below the settle threshold long before the
        // sand is level, so healing has to be what keeps the field awake.
        let mut s = Sand::new(64, 64);
        s.recovery = 0.05;
        s.stroke(12.0, 32.0, 52.0, 32.0, 4.0, 1.0, 0.0);
        let mut frames = 0;
        while s.info[INFO_ACTIVE] == 1 && frames < 60_000 {
            s.step(1.0 / 60.0);
            frames += 1;
        }
        assert!(frames < 60_000, "the beach never finished healing");
        let deepest = s.height.iter().copied().fold(0.0f32, |a, b| a.max(b.abs()));
        assert!(deepest <= SETTLE_EPS * 2.0, "wind left {deepest} behind");
    }

    #[test]
    fn rubbing_one_spot_stays_in_that_spot() {
        // Rubbing back and forth must not march a wave of sand off across the
        // field: sand pushed past the stick can never be pulled back, so any
        // per-pass leak accumulates without limit.
        let mut s = Sand::new(256, 128);
        s.recovery = 0.0;
        let (left, right, mid) = (60.0f32, 140.0f32, 64.0f32);
        let mut prev: Option<(f32, f32)> = None;
        for pass in 0..40 {
            for i in 0..=12 {
                let t = i as f32 / 12.0;
                let x = if pass % 2 == 0 { left + t * (right - left) } else { right - t * (right - left) };
                let y = mid + (t * 5.0 + pass as f32).sin() * 3.0;
                if let Some((px, py)) = prev {
                    let travel = ((x - px).powi(2) + (y - py).powi(2)).sqrt();
                    s.stroke(px, py, x, y, 1.5, 0.85, (travel / 4.3).min(1.0));
                }
                prev = Some((x, y));
            }
            for _ in 0..3 {
                s.step(1.0 / 60.0);
            }
        }
        let mut frames = 0;
        while s.info[INFO_ACTIVE] == 1 && frames < 8000 {
            s.step(1.0 / 60.0);
            frames += 1;
        }

        // How far beyond the rubbed span any sand still stands proud.
        let mut spread = 0.0f32;
        for y in 0..s.h {
            for x in 0..s.w {
                if s.height[s.idx(x, y)].abs() < 0.05 {
                    continue;
                }
                let fx = x as f32;
                let past = (left - 1.5 - fx).max(0.0).max(fx - (right + 1.5));
                spread = spread.max(past);
            }
        }
        assert!(spread < 12.0, "rubbing threw sand {spread:.0} cells past the stick");
    }

    #[test]
    fn hostile_input_is_rejected_without_panicking() {
        assert!(sand_create(1, 64).is_null());
        assert!(sand_create(64, MAX_DIM + 1).is_null());
        unsafe {
            sand_destroy(std::ptr::null_mut());
            sand_stroke(std::ptr::null_mut(), 0.0, 0.0, 1.0, 1.0, 1.0, 1.0, 1.0);
            sand_set_params(std::ptr::null_mut(), 1.0, 1.0, 1.0, 1.0, 1.0, 1);
            assert_eq!(sand_step(std::ptr::null_mut(), 0.016), 0);
            assert!(sand_texels(std::ptr::null_mut()).is_null());
        }
        let mut s = Sand::new(32, 32);
        s.stroke(f32::NAN, 0.0, 1.0, 1.0, 2.0, 1.0, 0.5);
        s.stroke(0.0, 0.0, 1.0, 1.0, f32::INFINITY, 1.0, f32::NAN);
        s.stroke(-1e9, -1e9, 1e9, 1e9, 2.0, 1.0, 1e9);
        s.stroke(0.0, 0.0, 8.0, 8.0, 2.0, 1.0, 0.3);
        s.step(f32::NAN);
        s.step(f32::INFINITY);
        unsafe { sand_set_params(std::ptr::from_mut(&mut s).cast::<c_void>(), f32::NAN, f32::NAN, f32::NAN, f32::NAN, f32::NAN, 0) };
        s.step(0.016);
        assert!(s.height.iter().all(|v| v.is_finite()), "NaN leaked into the field");
    }

    #[test]
    fn half_float_round_trips_the_range_we_use() {
        for v in [0.0f32, 1.0, -1.0, 0.5, -0.25, 3.75, 1e-9, -2.5] {
            let back = f16_to_f32(f32_to_f16(v));
            assert!((back - v).abs() < 1e-3, "{v} -> {back}");
        }
        assert_eq!(f32_to_f16(f32::NAN) & 0x7e00, 0x7e00);
        assert_eq!(f32_to_f16(f32::INFINITY), 0x7c00);
    }

    fn f16_to_f32(x: u16) -> f32 {
        let sign = (x as u32 & 0x8000) << 16;
        let exp = ((x >> 10) & 0x1f) as i32;
        let mant = (x & 0x03ff) as u32;
        if exp == 0 {
            return f32::from_bits(sign);
        }
        f32::from_bits(sign | (((exp - 15 + 127) as u32) << 23) | (mant << 13))
    }
}
