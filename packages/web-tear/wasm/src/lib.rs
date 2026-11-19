// Cloth sim for web-tear, compiled to wasm32 and driven from a worker.
//
// Same model as the JS version it replaces: verlet nodes on a grid, structural
// links plus shear diagonals, links that die when strained past what paper
// takes, weight that fades with distance from a tear, and sleeping so only
// disturbed paper costs anything. Compiling it lets us run a mesh fine enough
// that a rip reads as torn paper instead of as the grid it is made of.
//
// No bindgen: exports are plain C ABI and JS reads the buffers straight out of
// linear memory.

// Every number the material is made of lives here rather than in constants, so
// it can be tuned from JavaScript at runtime (see `set_param`). The defaults
// are the tuned values; the comments say what each one is for.
#[derive(Clone, Copy)]
pub struct Params {
    pub gravity: f32,        // px/s^2, carried by paper that has come free
    pub drag: f32,           // velocity kept per step: waves carry, then die
    pub stiffness: f32,      // structural links: stretch under load, recover
    pub shear: f32,          // diagonals: stop the grid shearing to a fishnet
    pub bend: f32,           // every-other-node: smooth waves, not sharp creases
    pub bounce: f32,         // over-relaxation: how springy the recovery is
    pub iterations: u32,
    pub tear_base: f32,      // outright snap; damage is the usual route
    pub yield_strain: f32,   // where a link starts taking damage
    pub damage_rate: f32,    // damage per step per unit of excess strain
    pub damage_spread: f32,  // head start handed to a fresh crack tip
    pub propagate_ease: f32, // a tip yields at this fraction of whole paper
    pub nucleate: f32,       // starting a tear costs this much more than extending
    pub load_to_advance: f32,// a crack only advances while actually loaded
    pub break_budget: u32,   // links that may let go in one step
    pub anchor: f32,         // edges are tacked to home, not nailed
    pub anchor_mass: f32,
    pub grip_follow: f32,    // the grip is a spring: lag is how hard you pull
    pub grip_support: f32,   // paper does not fail inside your fingers
    pub drape_px: f32,       // how far weight reaches around a tear
    pub wake_strain: f32,    // a link stretched this much wakes what it pulls on
    pub sleep_v2: f32,       // below this squared speed a node is "still"
    pub sleep_steps: u32,
    pub drop_at: f32,        // once this little of the page is left, it lets go
}

// The tuned defaults, in one place: both the live PARAMS and Default read it.
const DEFAULTS: Params = Params {
    gravity: 520.0,
    drag: 0.994,
    stiffness: 0.85,
    shear: 0.35,
    bend: 0.09,
    bounce: 1.15,
    iterations: 5,
    tear_base: 3.0,
    yield_strain: 2.20,
    damage_rate: 0.5,
    damage_spread: 0.6,
    propagate_ease: 0.75,
    nucleate: 1.5,
    load_to_advance: 0.9,
    break_budget: 10,
    anchor: 0.22,
    anchor_mass: 0.18,
    grip_follow: 0.22,
    grip_support: 9.0,
    drape_px: 110.0,
    wake_strain: 1.06,
    sleep_v2: 0.012,
    sleep_steps: 30,
    drop_at: 0.3,
};

impl Default for Params {
    fn default() -> Self {
        DEFAULTS
    }
}


static mut PARAMS: Params = DEFAULTS;

#[allow(static_mut_refs)]
#[inline(always)]
fn p() -> &'static Params {
    unsafe { &PARAMS }
}

const FIXED_DT: f32 = 1.0 / 120.0;
const MAX_SUBSTEPS: u32 = 2; // small, frequent updates beat big catch-up ones
const CX: usize = 24; // coverage grid, for "how much screen does this cover"
const CY: usize = 14;

struct Rng(u32);

impl Rng {
    fn next(&mut self) -> f32 {
        // xorshift32, so a sheet is reproducible from its seed
        let mut x = self.0;
        x ^= x << 13;
        x ^= x >> 17;
        x ^= x << 5;
        self.0 = x;
        (x >> 8) as f32 / 16_777_216.0
    }
}

struct Grip {
    ids: Vec<u32>,
    offx: Vec<f32>,
    offy: Vec<f32>,
    w: Vec<f32>,
    tx: f32,
    ty: f32,
    x0: f32,
    y0: f32,
    lift: f32,
    alive: bool,
}

pub struct Cloth {
    cols: usize,
    rows: usize,
    n: usize,
    width: f32,
    height: f32,
    dx: f32,
    dy: f32,

    px: Vec<f32>, py: Vec<f32>, pz: Vec<f32>,
    ox: Vec<f32>, oy: Vec<f32>, oz: Vec<f32>,
    home_x: Vec<f32>, home_y: Vec<f32>,
    pinned: Vec<u8>,
    loose: Vec<u8>,
    spreading: Vec<u8>,
    hold: Vec<f32>,
    still: Vec<u8>,
    biased: Vec<u8>,
    edge: Vec<f32>,
    weight: Vec<f32>,
    attached: Vec<u8>, // still connected to the anchored page, vs a free scrap
    stack: Vec<u32>,   // scratch for the flood fill

    alive_h: Vec<u8>, alive_v: Vec<u8>,
    damage_h: Vec<f32>, damage_v: Vec<f32>,
    rest_h: Vec<f32>, rest_v: Vec<f32>,
    rest_d1: Vec<f32>, rest_d2: Vec<f32>,
    rest_b1: Vec<f32>, rest_b2: Vec<f32>, // k <-> k+2 across and down

    // what the GPU reads: x,y,z, nx,ny,nz, edge per node
    packed: Vec<f32>,
    uv: Vec<f32>,
    indices: Vec<u32>,
    index_count: u32,
    indices_changed: bool,

    cover: Vec<u8>,
    covered: u32,

    quads_total: u32,
    quads_alive: u32,
    dropped: bool, // the page has let go of its edges and is falling
    topology_dirty: bool, // a link died, so the index buffer really did change
    tearable: bool, // some pages only ever crease: pull all you like
    grips: Vec<Grip>,
    // (failure pressure, link, horizontal) gathered on the last solver pass
    candidates: Vec<(f32, u32, bool)>,
    dirty: bool,
    acc: f32,
    frames: u32,
    sweep: bool,
    loose_count: u32,
    cell: f32, // the smaller grid step, for turning drape_px into a per-cell fade
    rng: Rng,
}

const STRIDE: usize = 7;

impl Cloth {
    fn new(width: f32, height: f32, spacing: f32, seed: u32) -> Cloth {
        let cols = (4usize).max((width / spacing).round() as usize + 1);
        let rows = (4usize).max((height / spacing).round() as usize + 1);
        let n = cols * rows;
        let dx = width / (cols - 1) as f32;
        let dy = height / (rows - 1) as f32;
        let max_quads = (cols - 1) * (rows - 1);

        let mut c = Cloth {
            cols, rows, n, width, height, dx, dy,
            px: vec![0.0; n], py: vec![0.0; n], pz: vec![0.0; n],
            ox: vec![0.0; n], oy: vec![0.0; n], oz: vec![0.0; n],
            home_x: vec![0.0; n], home_y: vec![0.0; n],
            pinned: vec![0; n],
            loose: vec![0; n],
            spreading: vec![0; n],
            hold: vec![0.0; n],
            still: vec![0; n],
            biased: vec![0; n],
            edge: vec![0.0; n],
            weight: vec![0.0; n],
            attached: vec![1; n],
            stack: Vec::new(),
            alive_h: vec![0; n], alive_v: vec![0; n],
            damage_h: vec![0.0; n], damage_v: vec![0.0; n],
            rest_h: vec![0.0; n], rest_v: vec![0.0; n],
            rest_d1: vec![0.0; n], rest_d2: vec![0.0; n],
            rest_b1: vec![0.0; n], rest_b2: vec![0.0; n],
            packed: vec![0.0; n * STRIDE],
            uv: vec![0.0; n * 2],
            indices: vec![0; max_quads * 6],
            index_count: 0,
            indices_changed: true,
            cover: vec![0; CX * CY],
            covered: ((CX - 2) * (CY - 2)) as u32,
            quads_total: ((cols - 1) * (rows - 1)) as u32,
            quads_alive: ((cols - 1) * (rows - 1)) as u32,
            dropped: false,
            topology_dirty: true,
            tearable: true,
            grips: Vec::new(),
            candidates: Vec::new(),
            dirty: true,
            acc: 0.0,
            frames: 0,
            sweep: false,
            loose_count: 0,
            cell: dx.min(dy),
            rng: Rng(seed | 1),
        };

        for j in 0..rows {
            for i in 0..cols {
                let k = i + j * cols;
                let border = i == 0 || j == 0 || i == cols - 1 || j == rows - 1;
                // jitter the interior so tear edges wander off the grid lines;
                // the outer border stays exact so the page fills the viewport
                let jx = if border { 0.0 } else { (c.rng.next() - 0.5) * dx * 0.25 };
                let jy = if border { 0.0 } else { (c.rng.next() - 0.5) * dy * 0.25 };
                let x = i as f32 * dx + jx;
                let y = j as f32 * dy + jy;
                c.px[k] = x; c.ox[k] = x; c.home_x[k] = x;
                c.py[k] = y; c.oy[k] = y; c.home_y[k] = y;
                c.pinned[k] = border as u8;
                c.uv[k * 2] = x / width;
                c.uv[k * 2 + 1] = y / height;
            }
        }
        for j in 0..rows {
            for i in 0..cols {
                let k = i + j * cols;
                if i < cols - 1 {
                    c.alive_h[k] = 1;
                    c.rest_h[k] = dist2d(c.px[k + 1] - c.px[k], c.py[k + 1] - c.py[k]);
                }
                if j < rows - 1 {
                    c.alive_v[k] = 1;
                    c.rest_v[k] = dist2d(c.px[k + cols] - c.px[k], c.py[k + cols] - c.py[k]);
                }
                if i < cols - 1 && j < rows - 1 {
                    c.rest_d1[k] = dist2d(c.px[k + cols + 1] - c.px[k], c.py[k + cols + 1] - c.py[k]);
                    c.rest_d2[k] = dist2d(c.px[k + cols] - c.px[k + 1], c.py[k + cols] - c.py[k + 1]);
                }
                if i + 2 < cols {
                    c.rest_b1[k] = dist2d(c.px[k + 2] - c.px[k], c.py[k + 2] - c.py[k]);
                }
                if j + 2 < rows {
                    c.rest_b2[k] = dist2d(c.px[k + 2 * cols] - c.px[k], c.py[k + 2 * cols] - c.py[k]);
                }
            }
        }
        c.rebuild_indices();
        c.pack(true);
        c
    }

    fn wake(&mut self, k: usize) {
        self.still[k] = 0;
        if self.loose[k] != 0 {
            return;
        }
        self.loose[k] = 1;
        self.loose_count += 1;
        // A flat sheet has no reason to buckle one way or the other, so nudge it
        // out of plane once. Only once: re-nudging on every wake pumps in energy
        // and the sheet never settles.
        if self.biased[k] == 0 {
            self.biased[k] = 1;
            self.pz[k] += (wobble(k) - 0.5) * 0.4;
        }
    }

    fn kill(&mut self, k: usize, horizontal: bool) {
        let (arr_alive, b) = if horizontal {
            (self.alive_h[k], k + 1)
        } else {
            (self.alive_v[k], k + self.cols)
        };
        if arr_alive == 0 {
            return;
        }
        if horizontal { self.alive_h[k] = 0 } else { self.alive_v[k] = 0 }
        self.dirty = true;
        self.topology_dirty = true;
        // hand damage to the links meeting at the new crack tip
        let cols = self.cols;
        let column = k % cols;
        let hurt_h = |idx: usize, arr: &mut Vec<f32>| {
            if idx < arr.len() { arr[idx] += p().damage_spread }
        };
        hurt_h(k, &mut self.damage_v);
        hurt_h(b, &mut self.damage_h);
        hurt_h(b, &mut self.damage_v);
        if column > 0 { hurt_h(k - 1, &mut self.damage_h) } // column, not k: k - 1 wraps rows
        if k >= cols { hurt_h(k - cols, &mut self.damage_v) }
        self.wake(k);
        self.wake(b);
        self.oz[k] = self.pz[k] - wobble(k) * 2.0; // the freed edge springs up
        self.oz[b] = self.pz[b] - wobble(b) * 2.0;
    }

    fn stirring(&self, k: usize) -> bool {
        if self.loose[k] == 0 {
            return false;
        }
        let vx = self.px[k] - self.ox[k];
        let vy = self.py[k] - self.oy[k];
        let vz = self.pz[k] - self.oz[k];
        vx * vx + vy * vy + vz * vz > p().sleep_v2
    }

    // Movement spreads one ring of nodes per step along surviving links, so the
    // sheet comes alive outward from the disturbance. Waking only from
    // neighbours that are actually moving is what lets the wave pass by and the
    // paper behind it settle again.
    fn spread(&mut self) {
        let cols = self.cols;
        let n = self.n;
        let mut grew = false;
        for k in 0..n {
            if self.loose[k] != 0 {
                continue;
            }
            let i = k % cols;
            let near = (i > 0 && self.alive_h[k - 1] != 0 && self.stirring(k - 1))
                || (i < cols - 1 && self.alive_h[k] != 0 && self.stirring(k + 1))
                || (k >= cols && self.alive_v[k - cols] != 0 && self.stirring(k - cols))
                || (k + cols < n && self.alive_v[k] != 0 && self.stirring(k + cols));
            if near {
                self.spreading[k] = 1;
                grew = true;
            }
        }
        if !grew {
            return;
        }
        for k in 0..n {
            if self.spreading[k] != 0 {
                self.spreading[k] = 0;
                self.wake(k);
            }
        }
    }

    fn apply_grips(&mut self) {
        for k in 0..self.n {
            self.hold[k] = 0.0;
        }
        let mut woken: Vec<u32> = Vec::new();
        for g in self.grips.iter() {
            if !g.alive {
                continue;
            }
            for idx in 0..g.ids.len() {
                let k = g.ids[idx] as usize;
                let f = g.w[idx] * p().grip_follow;
                self.px[k] += (g.tx + g.offx[idx] - self.px[k]) * f;
                self.py[k] += (g.ty + g.offy[idx] - self.py[k]) * f;
                // A gentle lift only: imposing the peel as a hard z offset put a
                // 2.5x strain spike on the ring around your fingers and tore the
                // paper before you had pulled at all. The curl comes from the
                // bending links and the pull itself.
                self.pz[k] += (g.lift * g.w[idx] - self.pz[k]) * f * 0.12;
                if f > self.hold[k] {
                    self.hold[k] = f;
                }
                woken.push(k as u32);
            }
        }
        for k in woken {
            self.wake(k as usize);
        }
    }

    // How readily a node yields when a link pulls on it. Sleeping paper never
    // moves; an edge node is tacked down; a node in your grip is heavy but not
    // immovable, so the strain of a pull spreads into the sheet instead of
    // guillotining the piece you are holding.
    #[inline(always)]
    fn inv_mass(&self, k: usize) -> f32 {
        unsafe {
            if *self.loose.get_unchecked(k) == 0 {
                return 0.0;
            }
            if *self.pinned.get_unchecked(k) != 0 {
                return p().anchor_mass;
            }
        }
        1.0
    }

    // The hot loop of the whole app: every link, every iteration, every step.
    // Indices here are all derived from the grid and cannot go out of range, so
    // the bounds checks are pure overhead.
    // Eight arguments, and clippy is right that it is a lot - but this is the
    // hot loop and every one of them is read per link, per iteration, per step.
    #[allow(clippy::too_many_arguments)]
    #[inline(always)]
    fn solve(&mut self, a: usize, b: usize, rest: f32, stiff: f32, tear_key: i32, horizontal: bool, judge: bool) {
        unsafe {
            let ax = *self.px.get_unchecked(a);
            let ay = *self.py.get_unchecked(a);
            let az = *self.pz.get_unchecked(a);
            let mut ex = *self.px.get_unchecked(b) - ax;
            let mut ey = *self.py.get_unchecked(b) - ay;
            let mut ez = *self.pz.get_unchecked(b) - az;
            let d2 = ex * ex + ey * ey + ez * ez;
            let d = if d2 > 1e-12 { d2.sqrt() } else { 1e-6 };
            let strain = d / rest;

            // Load travels: a strained link wakes its sleeping end, and the next
            // iteration solves the pair properly now that both can move.
            if strain > p().wake_strain {
                let mut woke = false;
                if *self.loose.get_unchecked(a) == 0 { self.wake(a); woke = true }
                if *self.loose.get_unchecked(b) == 0 { self.wake(b); woke = true }
                if woke {
                    return;
                }
            }

            if judge && tear_key >= 0 && self.tearable {
                let key = tear_key as usize;
                // Paper does not fail inside your fingers: what you hold is
                // supported, so the crack starts just outside the grip.
                let tol = 1.0
                    + p().grip_support * self.hold.get_unchecked(a).max(*self.hold.get_unchecked(b));
                let at_tear = *self.edge.get_unchecked(a) > 0.5 || *self.edge.get_unchecked(b) > 0.5;
                let yield_here = if at_tear { p().yield_strain * p().propagate_ease } else { p().yield_strain };
                if strain > yield_here * tol {
                    let hurt = (strain - yield_here * tol) * p().damage_rate;
                    if horizontal {
                        *self.damage_h.get_unchecked_mut(key) += hurt;
                    } else {
                        *self.damage_v.get_unchecked_mut(key) += hurt;
                    }
                }
                let damage = if horizontal {
                    *self.damage_h.get_unchecked(key)
                } else {
                    *self.damage_v.get_unchecked(key)
                };
                // How close this link is to letting go. Nothing is torn here -
                // the step picks the worst few.
                let pressure = (strain / (p().tear_base * tol)).max(damage / tol);
                let need = if at_tear { 1.0 } else { p().nucleate };
                // Damage is permanent, but a crack only advances while the paper
                // is actually being pulled: otherwise every link that was ever
                // damaged keeps failing and the tear runs to the bottom alone.
                let loaded = strain > yield_here * tol * p().load_to_advance;
                if loaded && pressure >= need {
                    self.candidates.push((pressure / need, key as u32, horizontal));
                }
            }

            let wa = self.inv_mass(a);
            let wb = self.inv_mass(b);
            let sum = wa + wb;
            if sum == 0.0 {
                return;
            }
            let diff = ((d - rest) / d) * stiff;
            ex *= diff;
            ey *= diff;
            ez *= diff;
            if wa > 0.0 {
                let f = wa / sum;
                *self.px.get_unchecked_mut(a) = ax + ex * f;
                *self.py.get_unchecked_mut(a) = ay + ey * f;
                *self.pz.get_unchecked_mut(a) = az + ez * f;
            }
            if wb > 0.0 {
                let f = wb / sum;
                *self.px.get_unchecked_mut(b) -= ex * f;
                *self.py.get_unchecked_mut(b) -= ey * f;
                *self.pz.get_unchecked_mut(b) -= ez * f;
            }
        }
    }

    // A diagonal exists only while its quad still has a way around it, so shear
    // needs no state of its own and vanishes exactly when the paper is cut.
    #[inline(always)]
    fn quad_intact(&self, k: usize) -> bool {
        (self.alive_h[k] != 0 && self.alive_v[k + 1] != 0)
            || (self.alive_v[k] != 0 && self.alive_h[k + self.cols] != 0)
    }

    // One fixed step: move, be pulled on, be solved, let go where it must,
    // and go quiet where it has stopped.
    fn step(&mut self, dt: f32) {
        if self.loose_count == 0 {
            return;
        }
        self.spread();
        let cfg = *p();
        self.integrate(&cfg, dt);
        self.apply_grips();
        self.solve_constraints(&cfg);
        self.apply_breaks(&cfg);
        self.settle(&cfg);
    }

    // Verlet integration, plus the springs that hold the edges near home.
    fn integrate(&mut self, cfg: &Params, dt: f32) {
        let g = cfg.gravity * dt * dt;
        for k in 0..self.n {
            if self.loose[k] == 0 {
                continue;
            }
            let x = self.px[k];
            let y = self.py[k];
            let z = self.pz[k];
            self.px[k] = x + (x - self.ox[k]) * cfg.drag;
            self.py[k] = y + (y - self.oy[k]) * cfg.drag + g * self.weight[k];
            self.pz[k] = z + (z - self.oz[k]) * cfg.drag;
            self.ox[k] = x;
            self.oy[k] = y;
            self.oz[k] = z;
            if self.pinned[k] != 0 {
                self.px[k] += (self.home_x[k] - self.px[k]) * cfg.anchor;
                self.py[k] += (self.home_y[k] - self.py[k]) * cfg.anchor;
                self.pz[k] -= self.pz[k] * cfg.anchor;
            }
        }
    }

    // Gauss-Seidel passes over every link: structural, shear and bending.
    fn solve_constraints(&mut self, cfg: &Params) {
        // Over-relaxing the structural pass is what gives the sheet its snap:
        // it overshoots slightly on the way back to rest instead of creeping.
        let structural = (cfg.stiffness * cfg.bounce).min(1.95);

        // Alternating sweep direction: corrections from the tacked edges reach
        // the far side in half the passes. Flipping once per step rather than
        // per iteration avoids a two-cycle jitter that keeps the sheet awake.
        self.sweep = !self.sweep;
        let cols = self.cols;
        let rows = self.rows;
        for it in 0..cfg.iterations {
            let judge = it == cfg.iterations - 1; // strain is most settled on the last pass
            // Bending is soft; solving it every other pass is indistinguishable
            // and it is the most expensive constraint in the sheet.
            let do_bend = it % 2 == 0;
            let down = self.sweep;
            for s in 0..rows {
                let j = if down { s } else { rows - 1 - s };
                let row = j * cols;
                for t in 0..cols {
                    let i = if down { t } else { cols - 1 - t };
                    let k = row + i;
                    let has_right = i < cols - 1;
                    let has_down = j < rows - 1;
                    // a link with both ends asleep cannot move anything, and two
                    // byte loads are far cheaper than the square root in solve
                    if has_right
                        && self.alive_h[k] != 0
                        && (self.loose[k] != 0 || self.loose[k + 1] != 0)
                    {
                        self.solve(k, k + 1, self.rest_h[k], structural, k as i32, true, judge);
                    }
                    if has_down
                        && self.alive_v[k] != 0
                        && (self.loose[k] != 0 || self.loose[k + cols] != 0)
                    {
                        self.solve(k, k + cols, self.rest_v[k], structural, k as i32, false, judge);
                    }
                    if has_right
                        && has_down
                        && (self.loose[k] != 0
                            || self.loose[k + 1] != 0
                            || self.loose[k + cols] != 0
                            || self.loose[k + cols + 1] != 0)
                        && self.quad_intact(k)
                    {
                        self.solve(k, k + cols + 1, self.rest_d1[k], cfg.shear, -1, false, false);
                        self.solve(k + 1, k + cols, self.rest_d2[k], cfg.shear, -1, false, false);
                    }
                    // Bending: a link exists while the paper between its ends
                    // does, so it dies with the tear and needs no state.
                    if do_bend
                        && i + 2 < cols
                        && self.alive_h[k] != 0
                        && self.alive_h[k + 1] != 0
                        && (self.loose[k] != 0 || self.loose[k + 2] != 0)
                    {
                        self.solve(k, k + 2, self.rest_b1[k], cfg.bend, -1, false, false);
                    }
                    if do_bend
                        && j + 2 < rows
                        && self.alive_v[k] != 0
                        && self.alive_v[k + cols] != 0
                        && (self.loose[k] != 0 || self.loose[k + 2 * cols] != 0)
                    {
                        self.solve(k, k + 2 * cols, self.rest_b2[k], cfg.bend, -1, false, false);
                    }
                }
            }
        }

    }

    // Only the worst-loaded few links may let go in any one step.
    fn apply_breaks(&mut self, cfg: &Params) {
        // The paper gives where it is worst loaded, and only so fast: a crack
        // that runs on from the last break, never a whole band at once.
        if !self.candidates.is_empty() {
            self.candidates
                .sort_unstable_by(|a, b| b.0.partial_cmp(&a.0).unwrap_or(std::cmp::Ordering::Equal));
            let budget = cfg.break_budget.min(self.candidates.len() as u32);
            for i in 0..budget as usize {
                let (_, key, horizontal) = self.candidates[i];
                self.kill(key as usize, horizontal);
            }
            self.candidates.clear();
        }

    }

    // Paper that has come to rest leaves the simulation; paper that has left
    // the stage comes apart.
    fn settle(&mut self, cfg: &Params) {
        let cols = self.cols;
        // Paper that has come to rest stops being simulated.
        for k in 0..self.n {
            if self.loose[k] == 0 || self.hold[k] > 0.0 {
                continue;
            }
            let vx = self.px[k] - self.ox[k];
            let vy = self.py[k] - self.oy[k];
            let vz = self.pz[k] - self.oz[k];
            if vx * vx + vy * vy + vz * vz < cfg.sleep_v2 {
                self.still[k] += 1;
                if self.still[k] as u32 > cfg.sleep_steps {
                    self.loose[k] = 0;
                    self.loose_count -= 1;
                    self.ox[k] = self.px[k];
                    self.oy[k] = self.py[k];
                    self.oz[k] = self.pz[k];
                }
            } else {
                self.still[k] = 0;
            }
        }

        // Shreds that leave the stage disintegrate so they stop costing
        // anything. A sheet that never tears has nothing to lose here, and
        // dragging its paper past the floor must not quietly cut it.
        if !self.tearable {
            return;
        }
        let floor = self.height + 500.0;
        for k in 0..self.n {
            if self.loose[k] == 0 || self.py[k] <= floor {
                continue;
            }
            let i = k % cols;
            if i < cols - 1 && self.alive_h[k] != 0 { self.kill(k, true) }
            if self.alive_v[k] != 0 { self.kill(k, false) }
            if i > 0 && self.alive_h[k - 1] != 0 { self.kill(k - 1, true) }
            if k >= cols && self.alive_v[k - cols] != 0 { self.kill(k - cols, false) }
            // Nothing is attached to it any more and it is far below the stage:
            // retire it. Left awake it would fall for ever at terminal speed,
            // which is well above the sleep threshold, so the sheet could never
            // go quiet again and the worker would spin at full rate on nothing.
            let orphan = (i >= cols - 1 || self.alive_h[k] == 0)
                && (i == 0 || self.alive_h[k - 1] == 0)
                && self.alive_v[k] == 0
                && (k < cols || self.alive_v[k - cols] == 0);
            if orphan {
                self.loose[k] = 0;
                self.loose_count -= 1;
                self.ox[k] = self.px[k];
                self.oy[k] = self.py[k];
                self.oz[k] = self.pz[k];
            }
        }
    }

    #[inline(always)]
    fn quad_alive(&self, i: usize, j: usize) -> bool {
        if i + 1 >= self.cols || j + 1 >= self.rows {
            return false;
        }
        let k = i + j * self.cols;
        self.alive_h[k] != 0
            && self.alive_h[k + self.cols] != 0
            && self.alive_v[k] != 0
            && self.alive_v[k + 1] != 0
    }

    fn rebuild_indices(&mut self) {
        let cols = self.cols;
        let rows = self.rows;
        for k in 0..self.n {
            let i = k % cols;
            let j = k / cols;
            let open = (i < cols - 1 && self.alive_h[k] == 0)
                || (i > 0 && self.alive_h[k - 1] == 0)
                || (j < rows - 1 && self.alive_v[k] == 0)
                || (j > 0 && self.alive_v[k - cols] == 0);
            self.edge[k] = if open { 1.0 } else { 0.0 };
            // A page that has let go is all free paper: keep its full weight,
            // or the next rebuild takes gravity away and it stalls mid-fall.
            self.weight[k] = if self.dropped { 1.0 } else { self.edge[k] };
        }
        if self.dropped {
            return self.finish_rebuild();
        }
        // Ramp the edge value a couple of cells inward so the shader has a band
        // to carve, not a single ring: that is the difference between a fringe
        // that looks like fibre and one that looks like the mesh.
        for _ in 0..2 {
            for k in 0..self.n {
                let i = k % cols;
                let mut e = self.edge[k];
                if i > 0 && self.alive_h[k - 1] != 0 { e = e.max(self.edge[k - 1] - 0.45) }
                if i < cols - 1 && self.alive_h[k] != 0 { e = e.max(self.edge[k + 1] - 0.45) }
                if k >= cols && self.alive_v[k - cols] != 0 { e = e.max(self.edge[k - cols] - 0.45) }
                if k + cols < self.n && self.alive_v[k] != 0 { e = e.max(self.edge[k + cols] - 0.45) }
                self.edge[k] = e;
            }
        }
        self.spread_weight();
        self.finish_rebuild();
    }

    fn spread_weight(&mut self) {
        let cols = self.cols;
        // two sweeps carry weight outwards from every torn edge
        // read live: drape_px is a tunable, and baking it in at construction
        // made it the one parameter that quietly did nothing
        let falloff = (self.cell / p().drape_px).clamp(0.01, 0.5);
        for k in 0..self.n {
            let i = k % cols;
            let mut w = self.weight[k];
            if i > 0 && self.alive_h[k - 1] != 0 {
                w = w.max(self.weight[k - 1] - falloff);
            }
            if k >= cols && self.alive_v[k - cols] != 0 {
                w = w.max(self.weight[k - cols] - falloff);
            }
            self.weight[k] = w;
        }
        for k in (0..self.n).rev() {
            let i = k % cols;
            let mut w = self.weight[k];
            if i < cols - 1 && self.alive_h[k] != 0 {
                w = w.max(self.weight[k + 1] - falloff);
            }
            if k + cols < self.n && self.alive_v[k] != 0 {
                w = w.max(self.weight[k + cols] - falloff);
            }
            self.weight[k] = w;
        }
    }

    // Everything the rebuild does that does not depend on weight: attachment,
    // coverage and the index buffer.
    fn finish_rebuild(&mut self) {
        let cols = self.cols;
        let rows = self.rows;
        // Flood from the anchored edges: whatever this does not reach has been
        // torn off the page and is a free scrap.
        for a in self.attached.iter_mut() {
            *a = 0;
        }
        self.stack.clear();
        for k in 0..self.n {
            if self.pinned[k] != 0 {
                self.attached[k] = 1;
                self.stack.push(k as u32);
            }
        }
        while let Some(k) = self.stack.pop() {
            let k = k as usize;
            let i = k % cols;
            if i < cols - 1 && self.alive_h[k] != 0 && self.attached[k + 1] == 0 {
                self.attached[k + 1] = 1;
                self.stack.push((k + 1) as u32);
            }
            if i > 0 && self.alive_h[k - 1] != 0 && self.attached[k - 1] == 0 {
                self.attached[k - 1] = 1;
                self.stack.push((k - 1) as u32);
            }
            if k + cols < self.n && self.alive_v[k] != 0 && self.attached[k + cols] == 0 {
                self.attached[k + cols] = 1;
                self.stack.push((k + cols) as u32);
            }
            if k >= cols && self.alive_v[k - cols] != 0 && self.attached[k - cols] == 0 {
                self.attached[k - cols] = 1;
                self.stack.push((k - cols) as u32);
            }
        }

        for c in self.cover.iter_mut() {
            *c = 0;
        }
        let mut c = 0usize;
        let mut alive = 0u32;
        for j in 0..rows - 1 {
            for i in 0..cols - 1 {
                let k = i + j * cols;
                if !self.quad_alive(i, j) {
                    continue;
                }
                alive += 1;
                // Drop stubs: a scrap hanging on by one corner reads as a stray
                // pixel, never as paper. It stays in the simulation, it just
                // stops being drawn.
                let mut neighbours = 0;
                if i > 0 && self.quad_alive(i - 1, j) { neighbours += 1 }
                if self.quad_alive(i + 1, j) { neighbours += 1 }
                if j > 0 && self.quad_alive(i, j - 1) { neighbours += 1 }
                if self.quad_alive(i, j + 1) { neighbours += 1 }
                if neighbours < 2 {
                    continue;
                }
                let cx = (self.px[k] * CX as f32 / self.width) as i32;
                let cy = (self.py[k] * CY as f32 / self.height) as i32;
                if cx >= 0 && cx < CX as i32 && cy >= 0 && cy < CY as i32 {
                    self.cover[cy as usize * CX + cx as usize] = 1;
                }
                // counter-clockwise in NDC, so the printed side is the front face
                self.indices[c] = k as u32;
                self.indices[c + 1] = (k + cols) as u32;
                self.indices[c + 2] = (k + 1) as u32;
                self.indices[c + 3] = (k + 1) as u32;
                self.indices[c + 4] = (k + cols) as u32;
                self.indices[c + 5] = (k + cols + 1) as u32;
                c += 6;
            }
        }
        self.index_count = c as u32;
        self.quads_alive = alive;
        let mut covered = 0u32;
        for cy in 1..CY - 1 {
            for cx in 1..CX - 1 {
                covered += self.cover[cy * CX + cx] as u32;
            }
        }
        self.covered = covered;
        self.dirty = false;
        if self.topology_dirty {
            self.indices_changed = true;
            self.topology_dirty = false;
        }
    }

    // Smooth per-vertex normals from the surviving neighbours. Screen-space
    // derivatives would shade every triangle flat, which is what makes a torn
    // sheet look like folded cardboard instead of paper.
    fn pack(&mut self, all: bool) {
        let cols = self.cols;
        let rows = self.rows;
        for k in 0..self.n {
            // Sleeping paper has not moved, so its packed vertex still stands.
            // Only a tear changes an edge value, and that asks for a full pass.
            if !all && self.loose[k] == 0 {
                continue;
            }
            let i = k % cols;
            let j = k / cols;
            let (mut lx, mut ly, mut lz) = (self.px[k], self.py[k], self.pz[k]);
            let (mut rx, mut ry, mut rz) = (lx, ly, lz);
            if i > 0 && self.alive_h[k - 1] != 0 {
                lx = self.px[k - 1]; ly = self.py[k - 1]; lz = self.pz[k - 1];
            }
            if i < cols - 1 && self.alive_h[k] != 0 {
                rx = self.px[k + 1]; ry = self.py[k + 1]; rz = self.pz[k + 1];
            }
            let (mut ux, mut uy, mut uz) = (self.px[k], self.py[k], self.pz[k]);
            let (mut dxp, mut dyp, mut dzp) = (ux, uy, uz);
            if j > 0 && self.alive_v[k - cols] != 0 {
                ux = self.px[k - cols]; uy = self.py[k - cols]; uz = self.pz[k - cols];
            }
            if j < rows - 1 && self.alive_v[k] != 0 {
                dxp = self.px[k + cols]; dyp = self.py[k + cols]; dzp = self.pz[k + cols];
            }
            let ax = rx - lx; let ay = ry - ly; let az = rz - lz;
            let bx = dxp - ux; let by = dyp - uy; let bz = dzp - uz;
            let mut nx = ay * bz - az * by;
            let mut ny = az * bx - ax * bz;
            let mut nz = ax * by - ay * bx;
            let len = (nx * nx + ny * ny + nz * nz).sqrt();
            if len > 1e-9 {
                nx /= len; ny /= len; nz /= len;
            } else {
                nx = 0.0; ny = 0.0; nz = 1.0;
            }
            let o = k * STRIDE;
            self.packed[o] = self.px[k];
            self.packed[o + 1] = self.py[k];
            self.packed[o + 2] = self.pz[k];
            self.packed[o + 3] = nx;
            self.packed[o + 4] = ny;
            self.packed[o + 5] = nz;
            self.packed[o + 6] = self.edge[k];
        }
    }

    // Once there is barely any page left covering the screen, the last shreds
    // let go of the edges and the whole thing drops: hanging tatters read as a
    // bug, not a page. Screen coverage, not surviving quads, is what "barely
    // any left" means to someone looking at it.
    fn maybe_drop(&mut self) {
        if self.dropped || !self.tearable || self.quads_total == 0 {
            return;
        }
        let inner = ((CX - 2) * (CY - 2)) as f32;
        if self.covered as f32 / inner >= p().drop_at {
            return;
        }
        self.dropped = true;
        for k in 0..self.n {
            self.pinned[k] = 0;
            self.weight[k] = 1.0; // it is all free paper now
        }
        for k in 0..self.n {
            self.wake(k);
        }
    }

    fn update(&mut self, dt: f32) {
        self.acc = (self.acc + dt).min(FIXED_DT * MAX_SUBSTEPS as f32);
        while self.acc >= FIXED_DT {
            self.step(FIXED_DT);
            self.acc -= FIXED_DT;
        }
        self.frames += 1;
        // the visible count drifts as the sheet sags, so refresh it periodically
        let rebuilt = self.dirty || (self.loose_count > 0 && self.frames.is_multiple_of(12));
        if rebuilt {
            self.rebuild_indices();
            self.maybe_drop();
        }
        if self.loose_count > 0 || rebuilt {
            self.pack(rebuilt);
        }
    }

    fn grab(&mut self, x: f32, y: f32, radius: f32) -> i32 {
        // First try paper that is still part of the page: that is what lets a
        // long drag keep tearing instead of ending up holding a loose scrap.
        let handle = self.grab_pass(x, y, radius, true);
        if handle >= 0 {
            return handle;
        }
        self.grab_pass(x, y, radius, false)
    }

    fn grab_pass(&mut self, x: f32, y: f32, radius: f32, want_attached: bool) -> i32 {
        let r2 = radius * radius;
        let cols = self.cols;
        let rows = self.rows;
        let mut g = Grip {
            ids: Vec::new(), offx: Vec::new(), offy: Vec::new(), w: Vec::new(),
            tx: x, ty: y, x0: x, y0: y, lift: 0.0, alive: true,
        };
        for k in 0..self.n {
            let ddx = self.px[k] - x;
            let ddy = self.py[k] - y;
            let d2 = ddx * ddx + ddy * ddy;
            if d2 > r2 {
                continue;
            }
            let i = k % cols;
            let j = k / cols;
            let attached = (i < cols - 1 && self.alive_h[k] != 0)
                || (i > 0 && self.alive_h[k - 1] != 0)
                || (j < rows - 1 && self.alive_v[k] != 0)
                || (j > 0 && self.alive_v[k - cols] != 0);
            if !attached {
                continue; // no grabbing at thin air
            }
            if want_attached && self.attached[k] == 0 {
                continue;
            }
            g.ids.push(k as u32);
            g.offx.push(ddx);
            g.offy.push(ddy);
            g.w.push(0.2 + 0.8 * (1.0 - d2.sqrt() / radius));
        }
        if g.ids.is_empty() {
            return -1;
        }
        for k in g.ids.iter() {
            let k = *k as usize;
            self.wake(k); // the sim skips sleeping sheets
        }
        // reuse a dead slot so handles stay small and stable
        if let Some(slot) = self.grips.iter().position(|x| !x.alive) {
            self.grips[slot] = g;
            slot as i32
        } else {
            self.grips.push(g);
            (self.grips.len() - 1) as i32
        }
    }

    fn move_grip(&mut self, handle: usize, x: f32, y: f32) {
        if let Some(g) = self.grips.get_mut(handle) {
            if !g.alive {
                return;
            }
            g.tx = x;
            g.ty = y;
            // pulling away from where you took hold peels the paper off the page
            let d = dist2d(x - g.x0, y - g.y0);
            g.lift = (d * 0.10).min(26.0);
        }
    }

    fn release(&mut self, handle: usize) {
        if let Some(g) = self.grips.get_mut(handle) {
            g.alive = false;
            g.ids.clear();
            g.offx.clear();
            g.offy.clear();
            g.w.clear();
        }
    }

    // Is there still material around this point? Asked in the sheet's own
    // undeformed grid space, which is exactly where tears were recorded.
    fn has_material(&self, x: f32, y: f32, r: f32) -> bool {
        let i0 = (((x - r) / self.dx).floor()).max(0.0) as usize;
        let i1 = (((x + r) / self.dx).ceil()).max(0.0).min((self.cols - 2) as f32) as usize;
        let j0 = (((y - r) / self.dy).floor()).max(0.0) as usize;
        let j1 = (((y + r) / self.dy).ceil()).max(0.0).min((self.rows - 2) as f32) as usize;
        if i0 > i1 || j0 > j1 {
            return false;
        }
        for j in j0..=j1 {
            for i in i0..=i1 {
                let k = i + j * self.cols;
                if self.alive_h[k] != 0 && self.alive_v[k] != 0 {
                    return true;
                }
            }
        }
        false
    }
}

// Fixed per-node wobble: enough to break the symmetry of a dead-flat sheet,
// identical on every run so the same gesture gives the same tear.
#[inline(always)]
fn wobble(k: usize) -> f32 {
    let h = (k as u32).wrapping_mul(2_654_435_761) ^ 0x9e37_79b9;
    ((h >> 8) & 0xffff) as f32 / 65_536.0
}

#[inline(always)]
fn dist2d(a: f32, b: f32) -> f32 {
    (a * a + b * b).sqrt()
}

// ---- exports -------------------------------------------------------------

static mut SHEETS: Option<Vec<Cloth>> = None;

#[allow(static_mut_refs)]
fn sheets() -> &'static mut Vec<Cloth> {
    unsafe {
        if SHEETS.is_none() {
            SHEETS = Some(Vec::new());
        }
        SHEETS.as_mut().unwrap()
    }
}

#[no_mangle]
pub extern "C" fn clear_all() {
    sheets().clear();
}

#[no_mangle]
pub extern "C" fn create(width: f32, height: f32, spacing: f32, seed: u32) -> u32 {
    let s = sheets();
    s.push(Cloth::new(width, height, spacing, seed));
    (s.len() - 1) as u32
}

macro_rules! sheet {
    ($id:expr) => {
        match sheets().get_mut($id as usize) {
            Some(c) => c,
            None => return Default::default(),
        }
    };
}

#[no_mangle]
pub extern "C" fn update(id: u32, dt: f32) {
    let c = match sheets().get_mut(id as usize) { Some(c) => c, None => return };
    c.update(dt);
}

#[no_mangle]
pub extern "C" fn packed_ptr(id: u32) -> u32 {
    let c = sheet!(id);
    c.packed.as_ptr() as u32
}

#[no_mangle]
pub extern "C" fn packed_len(id: u32) -> u32 {
    let c = sheet!(id);
    c.packed.len() as u32
}

#[no_mangle]
pub extern "C" fn uv_ptr(id: u32) -> u32 {
    let c = sheet!(id);
    c.uv.as_ptr() as u32
}

#[no_mangle]
pub extern "C" fn uv_len(id: u32) -> u32 {
    let c = sheet!(id);
    c.uv.len() as u32
}

#[no_mangle]
pub extern "C" fn index_ptr(id: u32) -> u32 {
    let c = sheet!(id);
    c.indices.as_ptr() as u32
}

#[no_mangle]
pub extern "C" fn index_count(id: u32) -> u32 {
    let c = sheet!(id);
    c.index_count
}

#[no_mangle]
pub extern "C" fn index_capacity(id: u32) -> u32 {
    let c = sheet!(id);
    c.indices.len() as u32
}

#[no_mangle]
pub extern "C" fn indices_changed(id: u32) -> u32 {
    let c = sheet!(id);
    c.indices_changed as u32
}

#[no_mangle]
pub extern "C" fn indices_uploaded(id: u32) {
    let c = match sheets().get_mut(id as usize) { Some(c) => c, None => return };
    c.indices_changed = false;
}

#[no_mangle]
pub extern "C" fn coverage(id: u32) -> f32 {
    let c = sheet!(id);
    c.covered as f32 / ((CX - 2) * (CY - 2)) as f32
}

#[no_mangle]
pub extern "C" fn awake(id: u32) -> u32 {
    let c = sheet!(id);
    c.loose_count
}

#[no_mangle]
pub extern "C" fn node_count(id: u32) -> u32 {
    let c = sheet!(id);
    c.n as u32
}

#[no_mangle]
pub extern "C" fn moving(id: u32) -> u32 {
    let c = sheet!(id);
    (c.loose_count > 0) as u32
}

#[no_mangle]
pub extern "C" fn grab(id: u32, x: f32, y: f32, radius: f32) -> i32 {
    let c = match sheets().get_mut(id as usize) { Some(c) => c, None => return -1 };
    c.grab(x, y, radius)
}

#[no_mangle]
pub extern "C" fn move_grip(id: u32, handle: u32, x: f32, y: f32) {
    let c = match sheets().get_mut(id as usize) { Some(c) => c, None => return };
    c.move_grip(handle as usize, x, y);
}

#[no_mangle]
pub extern "C" fn release(id: u32, handle: u32) {
    let c = match sheets().get_mut(id as usize) { Some(c) => c, None => return };
    c.release(handle as usize);
}

// Debug: the worst strain any surviving structural link is under right now.
#[no_mangle]
pub extern "C" fn peak_strain(id: u32) -> f32 {
    let c = sheet!(id);
    let mut peak = 1.0f32;
    for k in 0..c.n {
        let i = k % c.cols;
        let j = k / c.cols;
        if i < c.cols - 1 && c.alive_h[k] != 0 {
            let d = ((c.px[k + 1] - c.px[k]).powi(2)
                + (c.py[k + 1] - c.py[k]).powi(2)
                + (c.pz[k + 1] - c.pz[k]).powi(2))
            .sqrt();
            peak = peak.max(d / c.rest_h[k]);
        }
        if j < c.rows - 1 && c.alive_v[k] != 0 {
            let d = ((c.px[k + c.cols] - c.px[k]).powi(2)
                + (c.py[k + c.cols] - c.py[k]).powi(2)
                + (c.pz[k + c.cols] - c.pz[k]).powi(2))
            .sqrt();
            peak = peak.max(d / c.rest_v[k]);
        }
    }
    peak
}

// A sheet that only creases. Everything else about it still works: it stretches,
// folds, drapes and springs back, it just never gives.
#[no_mangle]
pub extern "C" fn set_tearable(id: u32, on: u32) {
    let c = match sheets().get_mut(id as usize) { Some(c) => c, None => return };
    c.tearable = on != 0;
}

// Is this grip still holding paper that belongs to the page?
#[no_mangle]
pub extern "C" fn grip_attached(id: u32, handle: u32) -> u32 {
    let c = sheet!(id);
    match c.grips.get(handle as usize) {
        Some(g) if g.alive => {
            for k in g.ids.iter() {
                if c.attached[*k as usize] != 0 {
                    return 1;
                }
            }
            0
        }
        _ => 0,
    }
}

// --- tunables, so JavaScript can play with the material ------------------
// The index order is mirrored by PARAM_NAMES in src/sim.js.
#[no_mangle]
pub extern "C" fn set_param(index: u32, value: f32) {
    // wasm32 here is single threaded and JS only reaches this through exports,
    // so there is no other live reference to take.
    #[allow(static_mut_refs)]
    unsafe {
        let q = &mut PARAMS;
        match index {
            0 => q.gravity = value,
            1 => q.drag = value,
            2 => q.stiffness = value,
            3 => q.shear = value,
            4 => q.bend = value,
            5 => q.bounce = value,
            6 => q.iterations = (value as u32).clamp(1, 20),
            7 => q.tear_base = value,
            8 => q.yield_strain = value,
            9 => q.damage_rate = value,
            10 => q.damage_spread = value,
            11 => q.propagate_ease = value,
            12 => q.nucleate = value,
            13 => q.load_to_advance = value,
            14 => q.break_budget = (value as u32).clamp(1, 4096),
            15 => q.anchor = value,
            16 => q.anchor_mass = value,
            17 => q.grip_follow = value,
            18 => q.grip_support = value,
            19 => q.drape_px = value,
            20 => q.wake_strain = value,
            21 => q.sleep_v2 = value,
            22 => q.sleep_steps = (value as u32).clamp(1, 254), // still[] is a u8
            23 => q.drop_at = value,
            _ => {}
        }
    }
}

#[no_mangle]
pub extern "C" fn get_param(index: u32) -> f32 {
    let q = p();
    match index {
        0 => q.gravity,
        1 => q.drag,
        2 => q.stiffness,
        3 => q.shear,
        4 => q.bend,
        5 => q.bounce,
        6 => q.iterations as f32,
        7 => q.tear_base,
        8 => q.yield_strain,
        9 => q.damage_rate,
        10 => q.damage_spread,
        11 => q.propagate_ease,
        12 => q.nucleate,
        13 => q.load_to_advance,
        14 => q.break_budget as f32,
        15 => q.anchor,
        16 => q.anchor_mass,
        17 => q.grip_follow,
        18 => q.grip_support,
        19 => q.drape_px,
        20 => q.wake_strain,
        21 => q.sleep_v2,
        22 => q.sleep_steps as f32,
        23 => q.drop_at,
        _ => 0.0,
    }
}

#[no_mangle]
pub extern "C" fn reset_params() {
    unsafe { PARAMS = Params::default() }
}

// Has this sheet let go of its edges and started falling?
#[no_mangle]
pub extern "C" fn dropped(id: u32) -> u32 {
    let c = sheet!(id);
    c.dropped as u32
}

// What fraction of the sheet's paper is still there at all.
#[no_mangle]
pub extern "C" fn intact(id: u32) -> f32 {
    let c = sheet!(id);
    if c.quads_total == 0 { 0.0 } else { c.quads_alive as f32 / c.quads_total as f32 }
}

#[no_mangle]
pub extern "C" fn has_material(id: u32, x: f32, y: f32, r: f32) -> u32 {
    let c = sheet!(id);
    c.has_material(x, y, r) as u32
}
