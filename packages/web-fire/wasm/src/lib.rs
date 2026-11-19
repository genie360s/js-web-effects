//! Fire: combustion coupled to a buoyant, incompressible airflow.
//!
//! A flame is not a texture that flickers. It is a chemical reaction that
//! releases heat, heat that makes air less dense, and less dense air that
//! rises and drags the reaction along with it. Every one of those links is
//! solved here, on a collocated 2D grid, in SI units:
//!
//!   a hot surface pyrolyses: solid fuel --> combustible vapour, endothermic
//!   the vapour is carried off by the flow and burns where it meets oxygen:
//!     vapour + oxygen --(Arrhenius in the gas temperature)--> heat + soot
//!   rho ~ 1/T, so the hot gas rises (Boussinesq)
//!   the air is incompressible, so the rise entrains fresh air from the sides
//!   the flame radiates back down and keeps the surface pyrolysing
//!
//! The vapour matters. An earlier version burned the solid where it stood and
//! went out every time, for a reason worth keeping: buoyancy empties the cell
//! over a burning surface in about a millisecond, so all the heat released
//! there is gone before it can do anything. Releasing vapour instead lets the
//! reaction happen all the way up the plume, which is where a real diffusion
//! flame is, and the flame is then tall and hot enough to keep its own fuel
//! coming.
//!
//! That loop is why the flame flickers on its own at a few hertz, why it leans
//! and stretches in wind, why a starved fire goes sooty and dark, and why the
//! bottom of a flame is thin and blue while the top is fat and yellow. None of
//! those are authored.
//!
//! Plain `cdylib` — no wasm-bindgen. Scalars and linear memory are all a
//! numeric kernel needs to cross the boundary.
//!
//! Copyright (c) 2026 Alex Mkwizu <alexgmkwizu@gmail.com> — MIT.

use core::ptr::addr_of_mut;

/// Largest grid on either axis. 1024^2 cells is ~90 MB of state; past that a
/// browser tab is not the right place for the simulation.
pub const MAX_DIM: u32 = 1024;
/// Sparks in flight at once. They are cosmetic, so the budget is fixed and the
/// spawner simply gives up when it is full rather than growing.
pub const MAX_EMBERS: usize = 768;
/// Floats per ember in the output buffer: x, y (cells), temperature, life 0..1.
pub const EMBER_STRIDE: usize = 4;
/// Explicit diffusion is unstable past 0.25 of a cell per step; the coefficient
/// is clamped to this rather than the step being subdivided, because radiative
/// conductivity at flame temperature would otherwise cost more sub-steps than
/// the rest of the solver put together.
const MAX_DIFFUSION: f32 = 0.22;
/// Below this there is no measurable Arrhenius rate, and `exp` is not free.
const COLD_GATE_K: f32 = 420.0;
/// Temperature ceiling. An adiabatic hydrocarbon flame tops out near 2300 K;
/// the cap is above that and exists only so one bad frame cannot poison the
/// grid forever.
const MAX_TEMP_K: f32 = 4000.0;
/// Surfaces do not reach flame temperature. Glowing char sits near 1200 K and
/// paper is gone long before 2000 K; this is a guard rail, not a target.
const MAX_SOLID_K: f32 = 2200.0;

// --- tunables ---------------------------------------------------------------
// One flat f32 array, so the host can write any of them at any time through a
// view onto linear memory. `src/sim/params.js` holds the same list, in the same
// order, with the same defaults; `wasm/test.mjs` asserts the two agree.

pub const P_AMBIENT: usize = 0;
pub const P_PYRO_ACTIVATION: usize = 1;
pub const P_PYRO_RATE: usize = 2;
pub const P_SURFACE_HEAT: usize = 3;
pub const P_BURN_ACTIVATION: usize = 4;
pub const P_BURN_RATE: usize = 5;
pub const P_HEAT_RELEASE: usize = 6;
pub const P_SOOT_YIELD: usize = 7;
pub const P_OXY_USE: usize = 8;
pub const P_OXY_REFRESH: usize = 9;
pub const P_OXY_DIFFUSE: usize = 10;
pub const P_VAPOUR_DECAY: usize = 11;
pub const P_GAS_CONDUCT: usize = 12;
pub const P_GAS_COOL: usize = 13;
pub const P_GAS_RADIATE: usize = 14;
pub const P_SOLID_CONDUCT: usize = 15;
pub const P_SOLID_RADIATE_K: usize = 16;
pub const P_SOLID_COOL: usize = 17;
pub const P_SOLID_RADIATE: usize = 18;
pub const P_COUPLE_SOLID: usize = 19;
pub const P_COUPLE_GAS: usize = 20;
pub const P_FLAME_FEEDBACK: usize = 41;
pub const P_FLAME_REACH: usize = 42;
pub const P_FLAME_TEMP: usize = 43;
pub const P_FUEL_SUPPLY: usize = 44;
pub const P_BUOYANCY: usize = 21;
pub const P_GRAVITY: usize = 22;
pub const P_SOOT_WEIGHT: usize = 23;
pub const P_WIND_X: usize = 24;
pub const P_WIND_Y: usize = 25;
pub const P_WIND_COUPLE: usize = 26;
pub const P_GUST: usize = 27;
pub const P_GUST_HZ: usize = 28;
pub const P_TURBULENCE: usize = 29;
pub const P_DRAG: usize = 30;
pub const P_SOOT_DECAY: usize = 31;
pub const P_FUEL_DENSITY: usize = 32;
pub const P_CHAR_RATE: usize = 33;
pub const P_EMBER_RATE: usize = 34;
pub const P_EMBER_LIFE: usize = 35;
pub const P_EMBER_DRAG: usize = 36;
pub const P_PRESSURE_ITERS: usize = 37;
pub const P_CFL: usize = 38;
pub const P_MAX_SUBSTEPS: usize = 39;
pub const P_SPREAD: usize = 40;
pub const PARAM_COUNT: usize = 45;

/// Defaults describe a sheet of paper burning in still room air.
pub const DEFAULTS: [f32; PARAM_COUNT] = [
    293.0,   // ambient air, K (20 C)
    2600.0,  // pyrolysis activation temperature, K
    8.0,     // pyrolysis pre-exponential, 1/s
    1450.0,  // net K the surface gains per unit of fuel it gives off
    6000.0,  // gas-phase combustion activation temperature, K
    2.0e4,   // gas-phase combustion pre-exponential, 1/s
    50000.0, // K the gas gains per unit of vapour burned
    8.0,     // soot produced per unit of vapour burned
    25.0,    // cells-worth of oxygen consumed per unit of vapour burned
    1.00,    // 1/s at which fresh air replaces what was consumed
    0.004,   // oxygen diffusivity, m^2/s
    0.60,    // unburned vapour turning into cold smoke, 1/s
    4.0e-5,  // thermal diffusivity of the gas, m^2/s
    0.55,    // gas losses to unresolved mixing, 1/s
    6.0e-11, // gas radiative cooling, K^-3 s^-1
    8.0e-7,  // conduction along the burning surface, m^2/s
    2.0e-6,  // radiative conductivity of the surface at 1000 K, m^2/s
    0.80,    // surface losses to the room, 1/s
    3.0e-10, // surface radiative cooling, K^-3 s^-1
    0.30,    // 1/s of plain convection between the surface and the gas on it
    3.00,    // 1/s the surface heats the gas over it
    1.0,     // buoyancy multiplier on g (T - Ta) / Ta
    9.81,    // gravity, m/s^2
    2.4,     // downward acceleration per unit of soot, m/s^2
    0.0,     // wind x, m/s
    0.0,     // wind y, m/s
    0.7,     // 1/s at which the air relaxes onto the far-field wind
    0.35,    // gust amplitude, as a fraction of the wind
    0.5,     // gust frequency, Hz
    12.0,    // vorticity confinement
    0.05,    // viscous damping, 1/s
    0.45,    // soot dispersal, 1/s
    1.0,     // multiplier on the fuel the content provides
    1.1,     // char produced per unit of fuel
    1.6,     // embers per burning cell per second
    1.5,     // ember lifetime, s
    2.2,     // how hard an ember is dragged by the air, 1/s
    8.0,     // pressure iterations
    2.0,     // advection CFL target, cells per sub-step
    3.0,     // hard cap on sub-steps per frame
    1.0,     // flame spread multiplier on the surface radiative conductivity
    800.0,   // K/s the flame radiates into the surface, per unit of emission
    4.0,     // how far that radiation reaches: passes at 1, 2, 4, ... cells
    2200.0,  // adiabatic flame temperature, K: the hottest burning can get
    0.0,     // 1/s that spent fuel is replaced: 0 is a sheet of paper
];

#[derive(Clone, Copy, Default)]
struct Ember {
    x: f32,
    y: f32,
    vx: f32,
    vy: f32,
    temp: f32,
    life: f32,
}

pub struct Fire {
    w: usize,
    h: usize,
    /// Metres per cell. Every constant above is SI, so this is what gives the
    /// flame a physical size: halve it and the same fire burns twice as fast
    /// relative to the screen.
    dx: f32,
    /// Gas temperature, K. This one is carried by the flow.
    temp: Vec<f32>,
    /// Surface temperature of whatever is burning, K.
    ///
    /// A flame is a two-phase problem and collapsing it into one temperature
    /// is why a first attempt at this went out every time: the gas over the
    /// fuel is blown upward several cells a frame, so the reaction has nothing
    /// hot left to sit on. The solid does not move. It is what pyrolyses, what
    /// carries the flame sideways across a page, and what is still glowing
    /// along the burnt edge after the flame above it has gone.
    solid: Vec<f32>,
    /// Combustible mass still in the surface, 0..1 of what the content gave.
    fuel: Vec<f32>,
    /// Fuel that has been driven off as gas and not yet burned. Advected.
    vap: Vec<f32>,
    /// What the content provides, before anything has burned.
    seed: Vec<f32>,
    /// Soot: the smoke, and the thing that actually glows yellow.
    soot: Vec<f32>,
    /// Oxygen, 1 = fresh air.
    oxy: Vec<f32>,
    /// Velocity, m/s, collocated at cell centres. +y is down the screen.
    vx: Vec<f32>,
    vy: Vec<f32>,
    /// Scratch for the semi-Lagrangian passes and the diffusion passes.
    tmp_a: Vec<f32>,
    tmp_b: Vec<f32>,
    /// Scratch for the four advected scalars, interleaved so one traversal
    /// writes all of them.
    scalars_out: Vec<f32>,
    /// Pressure and its right-hand side.
    p: Vec<f32>,
    div: Vec<f32>,
    /// Vorticity, kept between passes so confinement can read the gradient.
    curl: Vec<f32>,
    /// Irreversible burn damage, 0..1. This is what blackens and then eats
    /// through whatever is burning.
    charred: Vec<f32>,
    /// Gas-phase reaction rate this step, in vapour per second. The flame.
    react: Vec<f32>,
    /// Staging for the fuel map the host uploads.
    fuel_in: Vec<u8>,
    /// Interleaved half floats, four per cell: gas heat above ambient in kK,
    /// soot, char, surface heat above ambient in kK.
    out: Vec<u16>,
    embers: Vec<Ember>,
    ember_out: Vec<f32>,
    live_embers: usize,
    params: [f32; PARAM_COUNT],
    t: f32,
    rng: u32,
}

static mut STATE: Option<Fire> = None;

#[inline(always)]
#[allow(static_mut_refs)]
fn st() -> &'static mut Fire {
    unsafe { (*addr_of_mut!(STATE)).as_mut().unwrap() }
}

#[inline(always)]
fn idx(w: usize, x: usize, y: usize) -> usize {
    y * w + x
}

#[inline(always)]
fn finite(v: f32, fallback: f32) -> f32 {
    if v.is_finite() {
        v
    } else {
        fallback
    }
}

impl Fire {
    pub fn new(w: usize, h: usize, cell_metres: f32) -> Fire {
        let n = w * h;
        let dx = if cell_metres.is_finite() && cell_metres > 1e-6 {
            cell_metres
        } else {
            0.005
        };
        let ambient = DEFAULTS[P_AMBIENT];
        Fire {
            w,
            h,
            dx,
            temp: vec![ambient; n],
            solid: vec![ambient; n],
            fuel: vec![0.0; n],
            vap: vec![0.0; n],
            seed: vec![0.0; n],
            soot: vec![0.0; n],
            oxy: vec![1.0; n],
            vx: vec![0.0; n],
            vy: vec![0.0; n],
            tmp_a: vec![0.0; n],
            tmp_b: vec![0.0; n],
            scalars_out: vec![0.0; n * 4],
            p: vec![0.0; n],
            div: vec![0.0; n],
            curl: vec![0.0; n],
            charred: vec![0.0; n],
            react: vec![0.0; n],
            fuel_in: vec![0u8; n],
            out: vec![0u16; n * 4],
            embers: vec![Ember::default(); MAX_EMBERS],
            ember_out: vec![0.0; MAX_EMBERS * EMBER_STRIDE],
            live_embers: 0,
            params: DEFAULTS,
            t: 0.0,
            rng: 0x2545_f491,
        }
    }

    #[inline(always)]
    fn param(&self, i: usize) -> f32 {
        self.params[i]
    }

    #[inline(always)]
    fn ambient(&self) -> f32 {
        // `finite` first: f32::clamp propagates NaN rather than clamping it,
        // and this value seeds every other temperature in the solver.
        finite(self.param(P_AMBIENT), DEFAULTS[P_AMBIENT]).clamp(1.0, 2000.0)
    }

    /// xorshift32. Deterministic on purpose: the same session replays the same
    /// sparks, so a test can measure them.
    #[inline(always)]
    fn rand(&mut self) -> f32 {
        let mut x = self.rng;
        x ^= x << 13;
        x ^= x >> 17;
        x ^= x << 5;
        self.rng = x;
        (x >> 8) as f32 / 16_777_216.0
    }

    /// Replace the fuel map from the staging buffer. Whatever has already
    /// charred stays burned: re-uploading the page because someone typed into
    /// it must not resurrect the part of it that is already ash.
    pub fn commit_fuel(&mut self) {
        let density = finite(self.param(P_FUEL_DENSITY), 1.0).clamp(0.0, 8.0);
        for i in 0..self.fuel.len() {
            let s = (self.fuel_in[i] as f32 / 255.0) * density;
            self.seed[i] = s;
            self.fuel[i] = s * (1.0 - self.charred[i]).max(0.0);
        }
    }

    /// Fuel everywhere, for a scene with no content in it.
    pub fn fill_fuel(&mut self, amount: f32) {
        let a = finite(amount, 0.0).clamp(0.0, 8.0);
        for i in 0..self.fuel.len() {
            self.seed[i] = a;
            self.fuel[i] = a * (1.0 - self.charred[i]).max(0.0);
        }
    }

    /// A match held to the surface: heat, and the soot a real flame front
    /// carries with it. Negative heat is a wet cloth.
    pub fn ignite(&mut self, x: f32, y: f32, radius: f32, heat: f32) {
        if !x.is_finite() || !y.is_finite() || !radius.is_finite() || !heat.is_finite() {
            return;
        }
        let r = radius.clamp(0.5, MAX_DIM as f32);
        let inv_r2 = 1.0 / (r * r);
        let ambient = self.ambient();
        let (x0, x1, y0, y1) = self.span(x, y, r);
        for yy in y0..y1 {
            let dy = yy as f32 - y;
            for xx in x0..x1 {
                let dx = xx as f32 - x;
                let d2 = (dx * dx + dy * dy) * inv_r2;
                if d2 >= 1.0 {
                    continue;
                }
                // cos^2-ish falloff: no hard rim, so the flame front that grows
                // out of it is round rather than square.
                let f = (1.0 - d2) * (1.0 - d2);
                let i = idx(self.w, xx, yy);
                // A match touches the paper, not only the air above it.
                self.temp[i] = (self.temp[i] + heat * f).clamp(ambient * 0.5, MAX_TEMP_K);
                self.solid[i] = (self.solid[i] + heat * f).clamp(ambient * 0.5, MAX_SOLID_K);
                if heat > 0.0 {
                    self.soot[i] += 0.02 * f;
                }
            }
        }
    }

    /// Fanning the flames: push the air itself. This is a body force, not a
    /// displacement, so the pressure solve still gets to have its say.
    pub fn blow(&mut self, x: f32, y: f32, radius: f32, vx: f32, vy: f32) {
        if !x.is_finite() || !y.is_finite() || !radius.is_finite() {
            return;
        }
        if !vx.is_finite() || !vy.is_finite() {
            return;
        }
        let r = radius.clamp(0.5, MAX_DIM as f32);
        let inv_r2 = 1.0 / (r * r);
        let (vx, vy) = (vx.clamp(-60.0, 60.0), vy.clamp(-60.0, 60.0));
        let (x0, x1, y0, y1) = self.span(x, y, r);
        for yy in y0..y1 {
            let dy = yy as f32 - y;
            for xx in x0..x1 {
                let ddx = xx as f32 - x;
                let d2 = (ddx * ddx + dy * dy) * inv_r2;
                if d2 >= 1.0 {
                    continue;
                }
                let f = (1.0 - d2) * (1.0 - d2);
                let i = idx(self.w, xx, yy);
                self.vx[i] += vx * f;
                self.vy[i] += vy * f;
            }
        }
    }

    /// Clamped cell range covering a disc, as `[x0, x1) x [y0, y1)`.
    fn span(&self, x: f32, y: f32, r: f32) -> (usize, usize, usize, usize) {
        let lo = |v: f32| v.floor().max(0.0) as usize;
        let hi = |v: f32, n: usize| ((v.ceil() as i64 + 1).clamp(0, n as i64)) as usize;
        let x0 = lo(x - r).min(self.w);
        let y0 = lo(y - r).min(self.h);
        (x0, hi(x + r, self.w).max(x0), y0, hi(y + r, self.h).max(y0))
    }

    // --- the step ------------------------------------------------------------

    /// Advance by `dt` seconds, sub-stepping so advection never outruns the
    /// CFL target. Returns the number of sub-steps taken.
    pub fn step(&mut self, dt: f32) -> u32 {
        let dt = finite(dt, 0.0).clamp(0.0, 0.25);
        if dt <= 0.0 {
            self.pack();
            return 0;
        }
        let subs = self.substeps(dt);
        self.t += dt;
        self.pyrolyse(dt);
        self.burn(dt);
        self.radiate(dt);
        self.exchange(dt);
        self.cool(dt);
        self.conduct(dt);
        let h = dt / subs as f32;
        for _ in 0..subs {
            self.transport(h);
        }
        self.move_embers(dt);
        self.pack();
        subs
    }

    /// How many sub-steps this frame needs. Semi-Lagrangian advection is stable
    /// at any step, but a back-trace of twenty cells smears the flame into a
    /// smudge, and the pressure solve cannot keep up with it either.
    fn substeps(&self, dt: f32) -> u32 {
        let cfl = finite(self.param(P_CFL), 2.0).clamp(0.25, 16.0);
        let cap = finite(self.param(P_MAX_SUBSTEPS), 3.0).clamp(1.0, 8.0) as u32;
        let mut peak = 0.0f32;
        // Every 5th cell: the peak velocity lives in a plume many cells wide,
        // so a sparse scan finds it, and this runs before every frame.
        let mut i = 0;
        while i < self.vx.len() {
            peak = peak.max(self.vx[i].abs()).max(self.vy[i].abs());
            i += 5;
        }
        let travel = peak * dt / self.dx;
        (travel / cfl).ceil().max(1.0).min(cap as f32) as u32
    }

    /// Chemistry, radiation and diffusion once per frame; transport as many
    /// times as the flow needs.
    ///
    /// This is ordinary operator splitting, and it is what makes the solver
    /// affordable. The reaction and the heat exchange are rate-limited and
    /// smooth, so they do not care whether the frame was cut into three: they
    /// are integrated once with the whole timestep. Advection and the
    /// pressure solve do care — a plume moving five metres a second crosses
    /// ten cells in a frame — so only those are repeated, and only as often
    /// as the CFL condition demands.
    fn transport(&mut self, dt: f32) {
        self.forces(dt);
        self.confine(dt);
        self.advect_velocity(dt);
        self.project();
        self.advect_scalars(dt);
        self.open_boundary();
    }

    /// The surface gives off combustible vapour once it is hot enough.
    ///
    /// The heat term is a lumped one and worth being plain about. Driving
    /// vapour out of a solid absorbs heat; oxidising the char left behind
    /// releases considerably more, at the same place and the same time. That
    /// is the whole reason a sheet of paper has a glowing orange edge rather
    /// than a cold black one, and modelling the two separately would need a
    /// char mass field that nothing else here would read. What is left is the
    /// net: exothermic, and braked by the T^4 in `cool`, which is what sets
    /// the temperature the burning edge settles at.
    fn pyrolyse(&mut self, dt: f32) {
        let ta = finite(self.param(P_PYRO_ACTIVATION), 2600.0).clamp(100.0, 80_000.0);
        let rate = finite(self.param(P_PYRO_RATE), 8.0).clamp(0.0, 1e6);
        let exotherm = finite(self.param(P_SURFACE_HEAT), 1450.0).clamp(0.0, 40_000.0);
        let char_rate = finite(self.param(P_CHAR_RATE), 1.1).clamp(0.0, 8.0);

        // Fuel coming back is what separates a burner from a sheet of paper.
        // A gas ring burns on a surface for as long as you like without
        // consuming it, because what is burning was never the surface: the
        // fuel arrives from somewhere else, as fast as the flame takes it.
        // At a supply of zero this is exactly the old behaviour, so a page of
        // paper is the default and a burner is a number.
        //
        // It has to run before the loop below and not inside it: that loop
        // skips cells with no fuel left, which are precisely the ones with
        // something to replace.
        let supply = (finite(self.param(P_FUEL_SUPPLY), 0.0).clamp(0.0, 200.0) * dt).min(1.0);
        if supply > 0.0 {
            for i in 0..self.fuel.len() {
                let full = self.seed[i];
                if full > 0.0 {
                    self.fuel[i] += (full - self.fuel[i]) * supply;
                }
            }
        }

        for i in 0..self.fuel.len() {
            let f = self.fuel[i];
            let ts = self.solid[i];
            if f <= 1e-5 || ts < COLD_GATE_K {
                continue;
            }
            let k = rate * (-ta / ts).exp();
            let given = (k * f * dt).min(f);
            if given <= 1e-7 {
                continue;
            }
            self.fuel[i] = f - given;
            self.vap[i] += given;
            self.charred[i] = (self.charred[i] + given * char_rate).min(1.0);
            self.solid[i] = (ts + given * exotherm).min(MAX_SOLID_K);
        }
    }

    /// Radiation from the flame onto whatever is under and around it.
    ///
    /// This is the link that closes the loop, and it cannot be a local term:
    /// the flame sits a few cells above the surface that is feeding it, and
    /// the gas actually touching that surface is the cold air being entrained
    /// into the base of the plume. So the sooty flame's emission is smeared
    /// over a few cells — the diffusion approximation to radiative transfer —
    /// and what lands on the surface is what keeps it pyrolysing.
    ///
    /// Soot is the emitter. A clean blue flame radiates very little, which is
    /// why a spirit burner will not set light to the table and a candle will.
    fn radiate(&mut self, dt: f32) {
        let gain = finite(self.param(P_FLAME_FEEDBACK), 800.0).clamp(0.0, 1e6);
        if gain <= 0.0 {
            return;
        }
        let reach = finite(self.param(P_FLAME_REACH), 4.0).clamp(0.0, 7.0) as usize;
        let ambient = self.ambient();
        for i in 0..self.temp.len() {
            let e = ((self.temp[i] - ambient).max(0.0) * 0.001).min(8.0);
            let e2 = e * e;
            self.tmp_a[i] = e2 * e2 * self.soot[i].min(2.0);
        }
        for pass in 0..reach {
            blur3(self.w, self.h, 1 << pass, &mut self.tmp_a, &mut self.tmp_b);
        }
        let k = gain * dt;
        for i in 0..self.solid.len() {
            if self.seed[i] <= 0.0 {
                continue;
            }
            self.solid[i] = (self.solid[i] + k * self.tmp_a[i]).min(MAX_SOLID_K);
        }
    }

    /// The flame itself: vapour meeting oxygen in gas hot enough to light it.
    /// Where it is not hot enough the vapour simply drifts away and turns into
    /// the pale smoke that comes off something smouldering.
    ///
    /// The stoichiometry is what makes this a diffusion flame rather than a
    /// bonfire. A cell of paper carries far more fuel than a cell of air can
    /// oxidise — on these units, about twenty-five cells of air per cell of
    /// paper — so the reaction is almost never limited by how fast the fuel
    /// comes off. It is limited by how fast air reaches it. Get that ratio
    /// wrong and the flame is a tepid 100 K smudge: one cell of fuel spread
    /// its heat over a hundred cells of plume because nothing said it could
    /// not burn there.
    fn burn(&mut self, dt: f32) {
        let ta = finite(self.param(P_BURN_ACTIVATION), 6000.0).clamp(100.0, 80_000.0);
        let rate = finite(self.param(P_BURN_RATE), 2.0e4).clamp(0.0, 1e8);
        let release = finite(self.param(P_HEAT_RELEASE), 50_000.0).clamp(0.0, 1e6);
        let soot_yield = finite(self.param(P_SOOT_YIELD), 8.0).clamp(0.0, 200.0);
        let oxy_use = finite(self.param(P_OXY_USE), 25.0).clamp(1e-3, 400.0);
        let fade = (finite(self.param(P_VAPOUR_DECAY), 0.6).clamp(0.0, 60.0) * dt).min(1.0);
        let flame_max = finite(self.param(P_FLAME_TEMP), 2200.0).clamp(400.0, MAX_TEMP_K);
        let ember_rate = finite(self.param(P_EMBER_RATE), 1.6).clamp(0.0, 200.0);
        let ember_life = finite(self.param(P_EMBER_LIFE), 1.5).clamp(0.05, 20.0);
        let spawn_chance = ember_rate * dt;

        for i in 0..self.vap.len() {
            let v = self.vap[i];
            if v <= 1e-6 {
                self.react[i] = 0.0;
                continue;
            }
            // The reaction sheet stands on the surface the vapour is coming
            // off, and that sheet is a fraction of a millimetre thick — far
            // below anything this grid can resolve. Letting the hot surface
            // stand in for the gas temperature where the two meet is how the
            // flame gets anchored instead of being blown off the moment the
            // plume gets going; above the surface it is the gas alone, as it
            // should be.
            let tg = self.temp[i];
            let t_react = tg.max(self.solid[i]);
            let o = self.oxy[i];
            if t_react < COLD_GATE_K || o <= 1e-4 {
                self.react[i] = 0.0;
                // Vapour that never found a flame condenses into pale smoke.
                self.vap[i] = v * (1.0 - fade);
                self.soot[i] += v * fade * 0.35;
                continue;
            }
            let k = rate * (-ta / t_react).exp();
            // Nothing burns past its adiabatic flame temperature. Beyond that
            // point the products themselves are carrying all the energy the
            // fuel had, and burning more would need more air, which dilutes
            // by as much as it adds. Vapour that cannot burn here stays
            // vapour and goes up to burn where there is room for it — which
            // is exactly what makes a rich fire's flame tall.
            let headroom = ((flame_max - tg) / release).max(0.0);
            let burn = (k * v * o * dt).min(v).min(o / oxy_use).min(headroom);
            if burn <= 1e-8 {
                self.react[i] = 0.0;
                self.vap[i] = v * (1.0 - fade);
                self.soot[i] += v * fade * 0.35;
                continue;
            }
            self.vap[i] = (v - burn) * (1.0 - fade);
            self.oxy[i] = o - burn * oxy_use;
            self.temp[i] = (tg + burn * release).min(MAX_TEMP_K);
            self.soot[i] += burn * soot_yield;
            self.react[i] = burn / dt;

            if spawn_chance > 0.0 && self.rand() < spawn_chance {
                let x = i % self.w;
                let y = i / self.w;
                let jitter = (self.rand() - 0.5, self.rand() - 0.5);
                let temp = self.temp[i];
                self.spawn_ember(x as f32 + jitter.0, y as f32 + jitter.1, temp, ember_life);
            }
        }
    }

    fn spawn_ember(&mut self, x: f32, y: f32, temp: f32, life: f32) {
        if self.live_embers >= MAX_EMBERS {
            return;
        }
        let spread = self.rand() * 0.6 - 0.3;
        self.embers[self.live_embers] = Ember {
            x,
            y,
            vx: spread,
            vy: -0.4 - self.rand() * 0.8,
            temp,
            life,
        };
        self.live_embers += 1;
    }

    /// Heat crossing between the flame and the surface it is standing on.
    ///
    /// Plain convection only: the flame's own heat reaches the surface by
    /// radiation, in `radiate`, because it is never in the same cell. The gas
    /// touching a burning surface is the cold air being entrained into the
    /// base of the plume, so a large coefficient here does not light the page,
    /// it puts it out — which is what an earlier version did.
    ///
    /// The two directions differ by the heat each side can hold. A thin layer
    /// of air warms almost instantly against a hot surface; the same air
    /// barely moves the surface back.
    fn exchange(&mut self, dt: f32) {
        let to_solid = (finite(self.param(P_COUPLE_SOLID), 0.3).clamp(0.0, 200.0) * dt).min(0.5);
        let to_gas = (finite(self.param(P_COUPLE_GAS), 3.0).clamp(0.0, 200.0) * dt).min(0.5);
        if to_solid <= 0.0 && to_gas <= 0.0 {
            return;
        }
        for i in 0..self.temp.len() {
            // Only where there is something to exchange heat with: bare air
            // has no surface in it.
            if self.seed[i] <= 0.0 {
                continue;
            }
            let (tg, ts) = (self.temp[i], self.solid[i]);
            let gap = tg - ts;
            self.solid[i] = (ts + gap * to_solid).clamp(0.0, MAX_SOLID_K);
            self.temp[i] = (tg - gap * to_gas).clamp(0.0, MAX_TEMP_K);
        }
    }

    /// Convective and radiative losses. The radiative term goes as T^4, which
    /// is stiff enough at flame temperature to overshoot straight past ambient
    /// in one step, so the total loss is capped at most of the way there.
    fn cool(&mut self, dt: f32) {
        let ambient = self.ambient();
        let conv = finite(self.param(P_GAS_COOL), 0.55).clamp(0.0, 200.0);
        let rad = finite(self.param(P_GAS_RADIATE), 6.0e-11).clamp(0.0, 1e-6);
        let solid_cool = finite(self.param(P_SOLID_COOL), 0.8).clamp(0.0, 200.0);
        let solid_rad = finite(self.param(P_SOLID_RADIATE), 3.0e-10).clamp(0.0, 1e-5);
        let amb4 = ambient * ambient * ambient * ambient;
        let soot_decay = finite(self.param(P_SOOT_DECAY), 0.45).clamp(0.0, 60.0);
        let keep_soot = (1.0 - soot_decay * dt).clamp(0.0, 1.0);
        let refresh = finite(self.param(P_OXY_REFRESH), 1.0).clamp(0.0, 60.0);
        let regain = (refresh * dt).clamp(0.0, 1.0);

        for i in 0..self.temp.len() {
            let t = self.temp[i];
            let excess = t - ambient;
            if excess > 0.0 {
                let t2 = t * t;
                let loss = (rad * (t2 * t2 - amb4) + conv * excess) * dt;
                self.temp[i] = t - loss.clamp(0.0, excess * 0.9);
            } else if excess < 0.0 {
                self.temp[i] = t - (conv * excess * dt).clamp(excess * 0.9, 0.0);
            }
            // The surface loses heat to the room it is sitting in. Unlike the
            // gas it cannot be carried away, so this is its only way down.
            let ts = self.solid[i];
            let s_excess = ts - ambient;
            if s_excess > 0.0 {
                // Glowing char loses most of its heat by radiating it, and
                // that T^4 is also what stops the runaway: pyrolysis climbs
                // with exp(-Ta/T), radiation climbs faster, and where the two
                // cross is the temperature the burning surface settles at.
                let t2 = ts * ts;
                let loss = (solid_rad * (t2 * t2 - amb4) + solid_cool * s_excess) * dt;
                self.solid[i] = ts - loss.clamp(0.0, s_excess * 0.9);
            } else {
                self.solid[i] = ambient;
            }
            self.soot[i] *= keep_soot;
            let o = self.oxy[i];
            self.oxy[i] = o + (1.0 - o) * regain;
        }
    }

    /// Conduction, plus radiative transfer in the Rosseland approximation,
    /// where radiation between neighbouring parcels behaves as a conductivity
    /// that grows with T^3. That term is what carries a flame front sideways
    /// across a sheet: molecular conduction in air alone is far too slow.
    fn conduct(&mut self, dt: f32) {
        let gas_k = finite(self.param(P_GAS_CONDUCT), 4.0e-5).clamp(0.0, 1.0);
        let solid_k = finite(self.param(P_SOLID_CONDUCT), 8.0e-7).clamp(0.0, 1.0);
        let rad_k = finite(self.param(P_SOLID_RADIATE_K), 2.0e-6).clamp(0.0, 1.0);
        let spread = finite(self.param(P_SPREAD), 1.0).clamp(0.0, 8.0);
        let oxy_d = finite(self.param(P_OXY_DIFFUSE), 0.004).clamp(0.0, 1.0);
        let scale = dt / (self.dx * self.dx);
        let ambient = self.ambient();

        let d = (gas_k * scale).min(MAX_DIFFUSION);
        if d > 1e-9 {
            laplace(self.w, self.h, d, ambient, &self.temp, &mut self.tmp_a);
            core::mem::swap(&mut self.temp, &mut self.tmp_a);
        }
        let od = (oxy_d * scale).min(MAX_DIFFUSION);
        if od > 1e-9 {
            laplace(self.w, self.h, od, 1.0, &self.oxy, &mut self.tmp_a);
            core::mem::swap(&mut self.oxy, &mut self.tmp_a);
        }

        // Radiative conductivity is evaluated at the hottest point on the
        // surface rather than per cell. A coefficient that varies from cell to
        // cell makes the explicit stencil asymmetric — heat then flows uphill
        // along the gradient of the coefficient — and what the term is here
        // for is the distance it reaches, which the peak sets.
        let mut peak = 0.0f32;
        for &t in self.solid.iter() {
            peak = peak.max(t);
        }
        let ratio = (peak / 1000.0).max(0.0);
        let sk = ((solid_k + rad_k * spread * ratio * ratio * ratio) * scale).min(MAX_DIFFUSION);
        if sk > 1e-9 {
            masked_laplace(self.w, self.h, sk, &self.seed, &self.solid, &mut self.tmp_a);
            core::mem::swap(&mut self.solid, &mut self.tmp_a);
        }
    }

    /// Buoyancy, the weight of the soot, the far-field wind and its gusts.
    fn forces(&mut self, dt: f32) {
        let ambient = self.ambient();
        let g = finite(self.param(P_GRAVITY), 9.81).clamp(-100.0, 100.0);
        let buoy = finite(self.param(P_BUOYANCY), 1.0).clamp(0.0, 20.0) * g / ambient;
        let soot_w = finite(self.param(P_SOOT_WEIGHT), 2.4).clamp(0.0, 200.0);
        let couple = finite(self.param(P_WIND_COUPLE), 0.7).clamp(0.0, 60.0);
        let drag = finite(self.param(P_DRAG), 0.05).clamp(0.0, 60.0);
        let gust = finite(self.param(P_GUST), 0.35).clamp(0.0, 4.0);
        let gust_hz = finite(self.param(P_GUST_HZ), 0.5).clamp(0.0, 40.0);
        let wind_x = finite(self.param(P_WIND_X), 0.0).clamp(-100.0, 100.0);
        let wind_y = finite(self.param(P_WIND_Y), 0.0).clamp(-100.0, 100.0);

        // Two incommensurate sines: a single one is a metronome, and a flame
        // leaning in time with a metronome reads as an animation.
        let phase = self.t * gust_hz * core::f32::consts::TAU;
        let g1 = phase.sin();
        let g2 = (phase * 0.37 + 1.7).sin();
        let gust_now = 1.0 + gust * (0.62 * g1 + 0.38 * g2);
        let wx = wind_x * gust_now;
        let wy = wind_y * gust_now;

        let relax = (couple * dt).clamp(0.0, 1.0);
        let keep = (1.0 - drag * dt).clamp(0.0, 1.0);

        for i in 0..self.vx.len() {
            let lift = buoy * (self.temp[i] - ambient) - soot_w * self.soot[i];
            let mut vx = self.vx[i];
            let mut vy = self.vy[i] - lift * dt;
            vx += (wx - vx) * relax;
            vy += (wy - vy) * relax;
            self.vx[i] = vx * keep;
            self.vy[i] = vy * keep;
        }
    }

    /// Vorticity confinement (Fedkiw et al.). Semi-Lagrangian advection is
    /// heavily dissipative and eats exactly the small eddies that make a plume
    /// look like fire rather than like a lava lamp; this pushes energy back
    /// into the vorticity that survived, which is why the flame curls.
    fn confine(&mut self, dt: f32) {
        let eps = finite(self.param(P_TURBULENCE), 12.0).clamp(0.0, 60.0);
        if eps <= 0.0 {
            return;
        }
        let (w, h) = (self.w, self.h);
        if w < 3 || h < 3 {
            return;
        }
        let inv2dx = 0.5 / self.dx;
        for y in 1..h - 1 {
            for x in 1..w - 1 {
                let i = idx(w, x, y);
                self.curl[i] = (self.vy[i + 1] - self.vy[i - 1]) * inv2dx
                    - (self.vx[i + w] - self.vx[i - w]) * inv2dx;
            }
        }
        // The confinement force is proportional to the cell size, so a finer
        // grid does not silently turn into a windier scene.
        let strength = eps * dt * self.dx;
        for y in 2..h - 2 {
            for x in 2..w - 2 {
                let i = idx(w, x, y);
                let gx = (self.curl[i + 1].abs() - self.curl[i - 1].abs()) * inv2dx;
                let gy = (self.curl[i + w].abs() - self.curl[i - w].abs()) * inv2dx;
                let len = (gx * gx + gy * gy).sqrt();
                if len < 1e-6 {
                    continue;
                }
                let (nx, ny) = (gx / len, gy / len);
                let c = self.curl[i];
                self.vx[i] += strength * ny * c;
                self.vy[i] -= strength * nx * c;
            }
        }
    }

    fn advect_velocity(&mut self, dt: f32) {
        let s = dt / self.dx;
        let (w, h) = (self.w, self.h);
        let (vx, vy) = (&self.vx, &self.vy);
        let (dst_x, dst_y) = (&mut self.tmp_a, &mut self.tmp_b);
        trace(w, h, s, vx, vy, |i, sx, sy| {
            let (maxx, maxy) = ((w - 1) as f32, (h - 1) as f32);
            match (sx, sy) {
                (Some(sx), Some(sy)) => {
                    dst_x[i] = bilinear(vx, w, sx, sy, maxx, maxy);
                    dst_y[i] = bilinear(vy, w, sx, sy, maxx, maxy);
                }
                _ => {
                    // Air arriving from outside the canvas is still air.
                    dst_x[i] = 0.0;
                    dst_y[i] = 0.0;
                }
            }
        });
        core::mem::swap(&mut self.vx, &mut self.tmp_a);
        core::mem::swap(&mut self.vy, &mut self.tmp_b);
    }

    /// Gas temperature, soot, oxygen and unburned vapour all ride the air.
    /// Fuel and char do not: they are the page, and the page does not blow
    /// away.
    ///
    /// All four travel in one traversal. They share a back-trace, and working
    /// out where a cell came from — and whether that is still on the canvas —
    /// costs more than the four interpolations put together.
    fn advect_scalars(&mut self, dt: f32) {
        let s = dt / self.dx;
        let (w, h) = (self.w, self.h);
        let ambient = self.ambient();
        let (vx, vy) = (&self.vx, &self.vy);
        let (temp, soot, oxy, vap) = (&self.temp, &self.soot, &self.oxy, &self.vap);
        let out = &mut self.scalars_out;
        trace(w, h, s, vx, vy, |i, sx, sy| {
            let o = i * 4;
            match (sx, sy) {
                (Some(sx), Some(sy)) => {
                    let (maxx, maxy) = ((w - 1) as f32, (h - 1) as f32);
                    out[o] = bilinear(temp, w, sx, sy, maxx, maxy);
                    out[o + 1] = bilinear(soot, w, sx, sy, maxx, maxy);
                    out[o + 2] = bilinear(oxy, w, sx, sy, maxx, maxy);
                    out[o + 3] = bilinear(vap, w, sx, sy, maxx, maxy);
                }
                _ => {
                    // From outside the canvas, which is the room: clean, cold
                    // and full of oxygen. Clamping to the edge cell instead
                    // would build a wall of whatever happened to be there.
                    out[o] = ambient;
                    out[o + 1] = 0.0;
                    out[o + 2] = 1.0;
                    out[o + 3] = 0.0;
                }
            }
        });
        for i in 0..self.temp.len() {
            let o = i * 4;
            self.temp[i] = self.scalars_out[o];
            self.soot[i] = self.scalars_out[o + 1];
            self.oxy[i] = self.scalars_out[o + 2];
            self.vap[i] = self.scalars_out[o + 3];
        }
    }

    /// Make the flow divergence-free. This is the step that turns a rising
    /// plume into a fire: incompressible air cannot go up the middle without
    /// something coming in from the sides, and what comes in from the sides is
    /// the oxygen that keeps the base of the flame alight.
    fn project(&mut self) {
        let (w, h) = (self.w, self.h);
        if w < 3 || h < 3 {
            return;
        }
        let iters = finite(self.param(P_PRESSURE_ITERS), 8.0).clamp(0.0, 200.0) as usize;
        let half_dx = 0.5 * self.dx;
        for y in 1..h - 1 {
            for x in 1..w - 1 {
                let i = idx(w, x, y);
                self.div[i] = -half_dx
                    * (self.vx[i + 1] - self.vx[i - 1] + self.vy[i + w] - self.vy[i - w]);
                self.p[i] = 0.0;
            }
        }
        // Red-black successive over-relaxation. Plain Gauss-Seidel creeps
        // toward the answer from one side, so it always undershoots;
        // over-relaxing by nearly two takes the step it was going to take
        // anyway and then takes it again. On a grid this size that is worth
        // something like an order of magnitude in sweeps, and a sweep of the
        // pressure solve is the most expensive thing in the frame.
        // Over-relaxing all the way to the asymptotically optimal factor only
        // pays off over dozens of sweeps; over eight it rings, and a ringing
        // pressure field shows up as a flame that judders. Measured against
        // the burn this is the best of it.
        let omega = 1.4f32;
        for _ in 0..iters {
            for parity in 0..2 {
                for y in 1..h - 1 {
                    let mut x = 1 + ((y + parity) & 1);
                    while x < w - 1 {
                        let i = idx(w, x, y);
                        let target = (self.div[i]
                            + self.p[i - 1]
                            + self.p[i + 1]
                            + self.p[i - w]
                            + self.p[i + w])
                            * 0.25;
                        self.p[i] += omega * (target - self.p[i]);
                        x += 2;
                    }
                }
            }
        }
        let inv2dx = 0.5 / self.dx;
        for y in 1..h - 1 {
            for x in 1..w - 1 {
                let i = idx(w, x, y);
                self.vx[i] -= (self.p[i + 1] - self.p[i - 1]) * inv2dx;
                self.vy[i] -= (self.p[i + w] - self.p[i - w]) * inv2dx;
            }
        }
    }

    /// Open boundary. Air flowing in brings the room with it — ambient
    /// temperature, fresh oxygen, no soot. Air flowing out just leaves, so the
    /// edge takes the value of the cell behind it and the plume is not cut off
    /// by a cold wall at the top of the screen.
    fn open_boundary(&mut self) {
        let (w, h) = (self.w, self.h);
        if w < 2 || h < 2 {
            return;
        }
        let ambient = self.ambient();
        for x in 0..w {
            self.edge(idx(w, x, 0), idx(w, x, 1), self.vy[idx(w, x, 0)] > 0.0, ambient);
            let b = idx(w, x, h - 1);
            self.edge(b, idx(w, x, h - 2), self.vy[b] < 0.0, ambient);
        }
        for y in 0..h {
            self.edge(idx(w, 0, y), idx(w, 1, y), self.vx[idx(w, 0, y)] > 0.0, ambient);
            let r = idx(w, w - 1, y);
            self.edge(r, idx(w, w - 2, y), self.vx[r] < 0.0, ambient);
        }
    }

    #[inline]
    fn edge(&mut self, i: usize, inside: usize, inflow: bool, ambient: f32) {
        if inflow {
            self.temp[i] = ambient;
            self.soot[i] = 0.0;
            self.vap[i] = 0.0;
            self.oxy[i] = 1.0;
        } else {
            self.temp[i] = self.temp[inside];
            self.soot[i] = self.soot[inside];
            self.vap[i] = self.vap[inside];
            self.oxy[i] = self.oxy[inside];
            self.vx[i] = self.vx[inside];
            self.vy[i] = self.vy[inside];
        }
    }

    /// Sparks. They are carried by the air but not perfectly: an ember has
    /// mass, so it lags the gas that threw it and keeps going once the gas has
    /// turned. That lag is the whole reason they read as embers.
    fn move_embers(&mut self, dt: f32) {
        if self.live_embers == 0 {
            return;
        }
        let ambient = self.ambient();
        let g = finite(self.param(P_GRAVITY), 9.81).clamp(-100.0, 100.0);
        let buoy = finite(self.param(P_BUOYANCY), 1.0).clamp(0.0, 20.0) * g / ambient;
        let drag = finite(self.param(P_EMBER_DRAG), 2.2).clamp(0.0, 60.0);
        let relax = (drag * dt).clamp(0.0, 1.0);
        let cool = (1.0 - 0.55 * dt).clamp(0.0, 1.0);
        let (w, h) = (self.w as f32, self.h as f32);
        let inv_dx = 1.0 / self.dx;

        let mut n = 0;
        for k in 0..self.live_embers {
            let mut e = self.embers[k];
            e.life -= dt;
            if e.life <= 0.0 {
                continue;
            }
            let (gx, gy) = self.velocity_at(e.x, e.y);
            // An ember is a glowing particle of char: buoyant while it is hot,
            // and falling once it is not.
            let lift = buoy * (e.temp - ambient) * 0.35 - g * 0.12;
            e.vx += (gx - e.vx) * relax;
            e.vy += (gy - e.vy) * relax - lift * dt;
            e.x += e.vx * dt * inv_dx;
            e.y += e.vy * dt * inv_dx;
            e.temp = ambient + (e.temp - ambient) * cool;
            if e.x < 0.0 || e.y < 0.0 || e.x >= w || e.y >= h || e.temp < ambient + 60.0 {
                continue;
            }
            self.embers[n] = e;
            n += 1;
        }
        self.live_embers = n;
    }

    #[inline]
    fn velocity_at(&self, x: f32, y: f32) -> (f32, f32) {
        let xi = (x as usize).min(self.w - 1);
        let yi = (y as usize).min(self.h - 1);
        let i = idx(self.w, xi, yi);
        (self.vx[i], self.vy[i])
    }

    /// Interleave the four channels the renderer reads as half floats: half the
    /// bandwidth of f32, and WebGL2 filters RGBA16F natively, so the shader
    /// gets a smooth field for free.
    fn pack(&mut self) {
        let ambient = self.ambient();
        for i in 0..self.temp.len() {
            let heat = ((self.temp[i] - ambient) * 0.001).max(0.0);
            self.out[i * 4] = f16(heat);
            self.out[i * 4 + 1] = f16(self.soot[i].clamp(0.0, 64.0));
            self.out[i * 4 + 2] = f16(self.charred[i]);
            let glow = ((self.solid[i] - ambient) * 0.001).max(0.0);
            self.out[i * 4 + 3] = f16(glow);
        }
        for k in 0..self.live_embers {
            let e = self.embers[k];
            let o = k * EMBER_STRIDE;
            self.ember_out[o] = e.x;
            self.ember_out[o + 1] = e.y;
            self.ember_out[o + 2] = e.temp;
            self.ember_out[o + 3] = e.life;
        }
    }

    /// One number for "is anything still happening", so the host can stop
    /// drawing a scene that has burned out. Sampled, because it runs every
    /// frame and an exact answer is worth nothing here.
    pub fn energy(&self) -> f32 {
        let ambient = self.ambient();
        let mut acc = 0.0f32;
        let mut i = 0;
        let mut n = 0.0f32;
        while i < self.temp.len() {
            acc += (self.temp[i] - ambient).max(0.0) * 0.001
                + (self.solid[i] - ambient).max(0.0) * 0.001
                + self.soot[i]
                + self.react[i];
            n += 1.0;
            i += 7;
        }
        if self.live_embers > 0 {
            acc += 1.0;
        }
        acc / n.max(1.0)
    }

    /// Put the fire out and the page back, keeping the fuel the content gave.
    pub fn reset(&mut self) {
        let ambient = self.ambient();
        self.temp.fill(ambient);
        self.solid.fill(ambient);
        self.soot.fill(0.0);
        self.vap.fill(0.0);
        self.oxy.fill(1.0);
        self.vx.fill(0.0);
        self.vy.fill(0.0);
        self.charred.fill(0.0);
        self.react.fill(0.0);
        self.p.fill(0.0);
        self.curl.fill(0.0);
        self.live_embers = 0;
        self.fuel.copy_from_slice(&self.seed);
        self.pack();
    }

}

/// One explicit diffusion pass. Cells outside the grid are treated as holding
/// `outside`, which is ambient for temperature and fresh air for oxygen — the
/// room is bigger than the canvas.
fn laplace(w: usize, h: usize, d: f32, outside: f32, src: &[f32], dst: &mut [f32]) {
    for y in 0..h {
        let up = if y > 0 { Some((y - 1) * w) } else { None };
        let down = if y + 1 < h { Some((y + 1) * w) } else { None };
        let row = y * w;
        for x in 0..w {
            let c = src[row + x];
            let l = if x > 0 { src[row + x - 1] } else { outside };
            let r = if x + 1 < w { src[row + x + 1] } else { outside };
            let u = up.map_or(outside, |o| src[o + x]);
            let dn = down.map_or(outside, |o| src[o + x]);
            dst[row + x] = c + d * (l + r + u + dn - 4.0 * c);
        }
    }
}

/// One separable 1-2-1 blur in place, with its taps `step` cells apart.
///
/// Doubling the step on each pass is the a-trous trick: four passes at steps
/// 1, 2, 4, 8 reach about six cells for the price of four, where four plain
/// passes reach one and a bit. Radiation from a flame carries as far as the
/// flame is tall, so the reach is the whole point of the term.
fn blur3(w: usize, h: usize, step: usize, field: &mut [f32], scratch: &mut [f32]) {
    for y in 0..h {
        let row = y * w;
        for x in 0..w {
            let c = field[row + x];
            let l = if x >= step { field[row + x - step] } else { c };
            let r = if x + step < w { field[row + x + step] } else { c };
            scratch[row + x] = (l + 2.0 * c + r) * 0.25;
        }
    }
    let span = step * w;
    for y in 0..h {
        let row = y * w;
        let up = if y >= step { row - span } else { row };
        let down = if y + step < h { row + span } else { row };
        for x in 0..w {
            field[row + x] = (scratch[up + x] + 2.0 * scratch[row + x] + scratch[down + x]) * 0.25;
        }
    }
}

/// Diffusion restricted to cells that hold material, with no flux across the
/// boundary of it. This is how the surface conducts: heat runs along a sheet
/// of paper and stops at the edge of it, which is what makes a gap in the fuel
/// an actual fire break rather than a slight delay.
fn masked_laplace(w: usize, h: usize, d: f32, mask: &[f32], src: &[f32], dst: &mut [f32]) {
    for y in 0..h {
        let row = y * w;
        for x in 0..w {
            let i = row + x;
            if mask[i] <= 0.0 {
                dst[i] = src[i];
                continue;
            }
            let c = src[i];
            let mut flux = 0.0;
            if x > 0 && mask[i - 1] > 0.0 {
                flux += src[i - 1] - c;
            }
            if x + 1 < w && mask[i + 1] > 0.0 {
                flux += src[i + 1] - c;
            }
            if y > 0 && mask[i - w] > 0.0 {
                flux += src[i - w] - c;
            }
            if y + 1 < h && mask[i + w] > 0.0 {
                flux += src[i + w] - c;
            }
            dst[i] = c + d * flux;
        }
    }
}

/// Semi-Lagrangian back-trace: for each cell, work out where its contents
/// were one step ago and hand that position to `take`. `None` means the trace
/// left the canvas, and what is out there is the room.
///
// ponytail: first order, so it is diffusive. Vorticity confinement is what
// pays that back; swap in BFECC here if the smoke ever needs to hold an edge.
#[inline]
fn trace<F: FnMut(usize, Option<f32>, Option<f32>)>(
    w: usize,
    h: usize,
    scale: f32,
    vx: &[f32],
    vy: &[f32],
    mut take: F,
) {
    let maxx = (w - 1) as f32;
    let maxy = (h - 1) as f32;
    for y in 0..h {
        let row = y * w;
        let fy = y as f32;
        for x in 0..w {
            let i = row + x;
            let sx = x as f32 - vx[i] * scale;
            let sy = fy - vy[i] * scale;
            if sx < 0.0 || sy < 0.0 || sx > maxx || sy > maxy {
                take(i, None, None);
            } else {
                take(i, Some(sx), Some(sy));
            }
        }
    }
}

#[inline(always)]
fn bilinear(a: &[f32], w: usize, x: f32, y: f32, maxx: f32, maxy: f32) -> f32 {
    let x0f = x.floor();
    let y0f = y.floor();
    let fx = x - x0f;
    let fy = y - y0f;
    let x0 = x0f as usize;
    let y0 = y0f as usize;
    let x1 = if x0f < maxx { x0 + 1 } else { x0 };
    let y1 = if y0f < maxy { y0 + 1 } else { y0 };
    let r0 = y0 * w;
    let r1 = y1 * w;
    let top = a[r0 + x0] + (a[r0 + x1] - a[r0 + x0]) * fx;
    let bot = a[r1 + x0] + (a[r1 + x1] - a[r1 + x0]) * fx;
    top + (bot - top) * fy
}

/// f32 -> IEEE half, round-to-nearest-even. Non-finite input is packed as zero:
/// an infinity here would poison every texel the shader filters it into.
#[inline(always)]
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

/// Allocate the grid. `cell_metres` is how much of the world one cell covers,
/// which is what ties the SI constants above to the size of the canvas.
/// Returns 0 if the size was refused.
#[no_mangle]
pub extern "C" fn init(w: u32, h: u32, cell_metres: f32) -> u32 {
    if w < 8 || h < 8 || w > MAX_DIM || h > MAX_DIM {
        return 0;
    }
    unsafe {
        STATE = Some(Fire::new(w as usize, h as usize, cell_metres));
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

/// Staging buffer for the fuel map: `w * h` bytes, one per cell, 255 meaning
/// "as combustible as the material gets".
#[no_mangle]
pub extern "C" fn fuel_in_ptr() -> *mut u8 {
    st().fuel_in.as_mut_ptr()
}

#[no_mangle]
pub extern "C" fn commit_fuel() {
    st().commit_fuel();
}

#[no_mangle]
pub extern "C" fn fill_fuel(amount: f32) {
    st().fill_fuel(amount);
}

/// Interleaved half floats, four per cell: heat above ambient in kK, soot,
/// char, and the combustion rate.
#[no_mangle]
pub extern "C" fn out_ptr() -> *const u16 {
    st().out.as_ptr()
}

#[no_mangle]
pub extern "C" fn out_len() -> u32 {
    st().out.len() as u32
}

/// Live embers, four floats each: x, y (cells), temperature (K), life (s).
#[no_mangle]
pub extern "C" fn ember_ptr() -> *const f32 {
    st().ember_out.as_ptr()
}

#[no_mangle]
pub extern "C" fn ember_count() -> u32 {
    st().live_embers as u32
}

#[no_mangle]
pub extern "C" fn ignite(x: f32, y: f32, radius: f32, heat: f32) {
    st().ignite(x, y, radius, heat);
}

#[no_mangle]
pub extern "C" fn blow(x: f32, y: f32, radius: f32, vx: f32, vy: f32) {
    st().blow(x, y, radius, vx, vy);
}

/// Advance by `dt` seconds. Returns the number of sub-steps taken, which is
/// what the host watches to know the grid is outrunning the frame budget.
#[no_mangle]
pub extern "C" fn step(dt: f32) -> u32 {
    st().step(dt)
}

#[no_mangle]
pub extern "C" fn energy() -> f32 {
    st().energy()
}

#[no_mangle]
pub extern "C" fn reset() {
    st().reset();
}

#[cfg(test)]
mod tests {
    use super::*;

    const AMBIENT: f32 = DEFAULTS[P_AMBIENT];
    /// The demo scale: a scene about a metre tall.
    const SCENE_M: f32 = 1.2;

    /// A grid completely covered in fuel, at the scale the pages run at.
    fn sheet(w: usize, h: usize) -> Fire {
        let mut f = Fire::new(w, h, SCENE_M / h as f32);
        f.fill_fuel(1.0);
        f
    }

    /// A match held to the surface, hot enough and long enough to take.
    fn light(f: &mut Fire, x: f32, y: f32) {
        f.ignite(x, y, 6.0, 1500.0);
    }

    fn run(f: &mut Fire, frames: usize) {
        for _ in 0..frames {
            f.step(1.0 / 60.0);
        }
    }

    fn burning(f: &Fire) -> f32 {
        f.react.iter().sum()
    }

    fn charred(f: &Fire) -> f32 {
        f.charred.iter().sum()
    }

    /// Centre of mass of the heat in the gas, in cells. y grows downward.
    fn heat_centroid(f: &Fire) -> (f32, f32) {
        let (mut mx, mut my, mut m) = (0.0f32, 0.0f32, 0.0f32);
        for y in 0..f.h {
            for x in 0..f.w {
                let q = (f.temp[idx(f.w, x, y)] - AMBIENT).max(0.0);
                mx += x as f32 * q;
                my += y as f32 * q;
                m += q;
            }
        }
        (mx / m.max(1e-6), my / m.max(1e-6))
    }

    fn finite_everywhere(f: &Fire) {
        let fields: [(&str, &Vec<f32>); 9] = [
            ("gas", &f.temp),
            ("surface", &f.solid),
            ("fuel", &f.fuel),
            ("vapour", &f.vap),
            ("soot", &f.soot),
            ("oxygen", &f.oxy),
            ("vx", &f.vx),
            ("vy", &f.vy),
            ("char", &f.charred),
        ];
        for (name, field) in fields {
            assert!(field.iter().all(|v| v.is_finite()), "{name} went non-finite");
        }
    }

    #[test]
    fn cold_fuel_does_not_light_itself() {
        let mut f = sheet(64, 64);
        let before: f32 = f.fuel.iter().sum();
        run(&mut f, 900);
        assert_eq!(charred(&f), 0.0, "the page caught fire on its own");
        assert_eq!(f.fuel.iter().sum::<f32>(), before, "fuel went somewhere");
        assert_eq!(f.energy(), 0.0, "an untouched page is not at rest");
    }

    #[test]
    fn a_match_lights_it_and_the_flame_sustains_itself() {
        let mut f = sheet(96, 128);
        light(&mut f, 48.0, 100.0);
        run(&mut f, 120);
        // Two seconds in, the only heat ever added is long gone up the plume.
        // Anything still burning is the fire feeding itself.
        assert!(burning(&f) > 5.0, "the fire went out: {}", burning(&f));
        assert!(charred(&f) > 40.0, "barely anything burned: {}", charred(&f));
        let peak = f.temp.iter().copied().fold(0.0f32, f32::max);
        assert!(
            (1000.0..=MAX_TEMP_K).contains(&peak),
            "a flame should be hot but not absurd: {peak} K"
        );
        finite_everywhere(&f);
    }

    #[test]
    fn ignition_is_a_threshold_not_a_fade() {
        let after = |heat: f32| {
            let mut f = sheet(64, 96);
            f.ignite(32.0, 72.0, 6.0, heat);
            run(&mut f, 120);
            charred(&f)
        };
        let warm = after(200.0);
        let lit = after(1500.0);
        assert!(warm < 0.5, "a warm touch should not light paper: {warm}");
        assert!(lit > 40.0, "a match should: {lit}");
    }

    #[test]
    fn fire_climbs_faster_than_it_creeps_down() {
        // The single most recognisable thing fire does, and it is scripted
        // nowhere: the plume preheats what is above it, and nothing at all
        // preheats what is below.
        let mut f = sheet(96, 128);
        light(&mut f, 48.0, 64.0);
        run(&mut f, 150);

        let burnt_rows = |rows: std::ops::Range<usize>| {
            rows.filter(|y| (0..f.w).any(|x| f.charred[idx(f.w, x, *y)] > 0.05))
                .count()
        };
        let up = burnt_rows(0..64);
        let down = burnt_rows(65..128);
        assert!(up > 8, "the flame never climbed: {up} rows");
        assert!(
            up > down * 2,
            "it spread down as readily as up: {up} rows up, {down} down"
        );
    }

    #[test]
    fn the_plume_rises() {
        let mut f = sheet(96, 128);
        light(&mut f, 48.0, 110.0);
        run(&mut f, 30);
        let (_, y0) = heat_centroid(&f);
        run(&mut f, 60);
        let (_, y1) = heat_centroid(&f);
        assert!(y1 < y0 - 4.0, "hot gas must rise: y {y0:.1} -> {y1:.1}");
    }

    #[test]
    fn wind_leans_the_flame_downwind() {
        let lean = |wind: f32| {
            let mut f = sheet(160, 96);
            f.params[P_WIND_X] = wind;
            f.params[P_GUST] = 0.0; // measure the lean, not the weather
            light(&mut f, 80.0, 80.0);
            run(&mut f, 90);
            heat_centroid(&f).0
        };
        let still = lean(0.0);
        let breezy = lean(2.0);
        let gale = lean(6.0);
        assert!((still - 80.0).abs() < 6.0, "a still flame should stand up: {still:.1}");
        assert!(breezy > still + 3.0, "a breeze must tilt it: {still:.1} -> {breezy:.1}");
        assert!(gale > breezy + 3.0, "and a gale further: {breezy:.1} -> {gale:.1}");
    }

    #[test]
    fn pyrolysis_accounts_for_every_bit_of_fuel_it_takes() {
        let mut f = sheet(80, 96);
        let rate = f.param(P_CHAR_RATE);
        light(&mut f, 40.0, 80.0);
        run(&mut f, 180);
        let mut touched = 0;
        for i in 0..f.fuel.len() {
            assert!(f.fuel[i] >= 0.0, "fuel went negative at {i}");
            assert!((0.0..=1.0).contains(&f.charred[i]), "char left 0..1 at {i}");
            if f.charred[i] >= 1.0 {
                continue; // saturated, so the books no longer balance by design
            }
            let spent = f.seed[i] - f.fuel[i];
            assert!(
                (f.charred[i] - spent * rate).abs() < 1e-3,
                "char and fuel disagree at {i}: {} vs {}",
                f.charred[i],
                spent * rate
            );
            if spent > 0.0 {
                touched += 1;
            }
        }
        assert!(touched > 50, "not enough of the sheet burned to prove anything");
    }

    #[test]
    fn suffocation_puts_it_out() {
        // Same match, same fuel. The only difference is whether fresh air can
        // get to the flame, and a diffusion flame is limited by exactly that.
        let charred_with = |refresh: f32, diffuse: f32| {
            let mut f = sheet(96, 128);
            f.params[P_OXY_REFRESH] = refresh;
            f.params[P_OXY_DIFFUSE] = diffuse;
            light(&mut f, 48.0, 100.0);
            run(&mut f, 150);
            charred(&f)
        };
        let open = charred_with(DEFAULTS[P_OXY_REFRESH], DEFAULTS[P_OXY_DIFFUSE]);
        let sealed = charred_with(0.0, 0.0);
        assert!(open > 40.0, "the control fire did not get going: {open}");
        assert!(
            sealed < open * 0.5,
            "a sealed fire burned as well as an open one: {sealed} vs {open}"
        );
    }

    #[test]
    fn a_gap_with_no_fuel_stops_it() {
        let (w, h) = (200usize, 64usize);
        let mut f = sheet(w, h);
        for y in 0..h {
            for x in 110..150 {
                f.seed[idx(w, x, y)] = 0.0;
                f.fuel[idx(w, x, y)] = 0.0;
            }
        }
        light(&mut f, 40.0, 40.0);
        run(&mut f, 600);
        let burnt = |mut range: std::ops::Range<usize>| {
            range.any(|x| (0..h).any(|y| f.charred[idx(w, x, y)] > 0.05))
        };
        assert!(burnt(70..108), "the fire never reached the fire break");
        assert!(!burnt(152..w), "the fire jumped a fuel break");
    }

    #[test]
    fn a_burner_keeps_burning_and_never_damages_what_it_burns_on() {
        // The other half of the model: fuel arriving as fast as the flame
        // takes it, and no damage recorded. A gas ring, not a sheet of paper.
        let mut f = sheet(96, 128);
        f.params[P_FUEL_SUPPLY] = 8.0;
        f.params[P_CHAR_RATE] = 0.0;
        light(&mut f, 48.0, 118.0);
        run(&mut f, 120);
        let early = burning(&f);
        assert!(early > 1.0, "the burner never lit: {early}");

        // Half a minute later it is still going, which a page of paper this
        // size could not manage for two seconds.
        run(&mut f, 1800);
        let late = burning(&f);
        assert!(late > early * 0.25, "the burner went out: {early} -> {late}");
        assert_eq!(charred(&f), 0.0, "a burner damaged the thing it stood on");
        assert!(
            f.fuel.iter().all(|v| *v > 0.5),
            "the supply did not keep up with the flame"
        );
        // And it is still a fire, not a runaway.
        let peak = f.temp.iter().copied().fold(0.0f32, f32::max);
        assert!(peak < DEFAULTS[P_FLAME_TEMP] + 1.0, "the burner ran away to {peak} K");
        finite_everywhere(&f);
    }

    #[test]
    fn turning_the_supply_off_lets_it_burn_out_again() {
        let mut f = sheet(96, 128);
        f.params[P_FUEL_SUPPLY] = 8.0;
        light(&mut f, 48.0, 118.0);
        run(&mut f, 120);
        assert!(burning(&f) > 1.0);
        f.params[P_FUEL_SUPPLY] = 0.0;
        run(&mut f, 1800);
        assert_eq!(burning(&f), 0.0, "it kept burning after the gas was turned off");
    }

    #[test]
    fn it_burns_out_and_goes_quiet() {
        let mut f = sheet(96, 128);
        // A patch of fuel with bare air around it: enough to burn, not enough
        // to keep going.
        f.fill_fuel(0.0);
        for y in 90..104 {
            for x in 40..56 {
                f.seed[idx(96, x, y)] = 1.0;
                f.fuel[idx(96, x, y)] = 1.0;
            }
        }
        light(&mut f, 48.0, 100.0);
        run(&mut f, 60);
        let peak = f.energy();
        assert!(peak > 1e-3, "it never got going: {peak}");
        run(&mut f, 1800);
        assert_eq!(burning(&f), 0.0, "still burning with nothing left to burn");
        assert!(f.energy() < peak * 0.01, "it never went out: {peak} -> {}", f.energy());
        assert!(
            f.temp.iter().all(|t| *t < AMBIENT + 20.0),
            "the room never cooled down"
        );
    }

    #[test]
    fn the_flow_is_left_nearly_divergence_free() {
        let mut f = sheet(96, 128);
        light(&mut f, 48.0, 100.0);
        run(&mut f, 90);
        let mut worst = 0.0f32;
        for y in 2..126 {
            for x in 2..94 {
                let i = idx(96, x, y);
                let d = (f.vx[i + 1] - f.vx[i - 1] + f.vy[i + 96] - f.vy[i - 96]) * 0.5 / f.dx;
                worst = worst.max(d.abs());
            }
        }
        let peak = f
            .vx
            .iter()
            .zip(f.vy.iter())
            .fold(0.0f32, |a, (u, v)| a.max(u.hypot(*v)));
        assert!(peak > 0.5, "nothing was moving, so this proves nothing");
        // Measured against the speeds actually present. A strict zero needs a
        // direct solve; sixteen sweeps is what a frame can afford.
        assert!(
            worst < peak / f.dx * 0.5,
            "projection left {worst:.0} 1/s of divergence against {peak:.2} m/s"
        );
    }

    #[test]
    fn vorticity_confinement_adds_curl_without_adding_wind() {
        // Measured on a bare thermal, with no fuel anywhere and so no
        // combustion: every run then puts exactly the same energy into the
        // flow and the only difference between them is the term under test.
        // Measured on a fire instead, the number moves because the fire
        // itself got bigger or smaller, which proves nothing about curl.
        let measure = |eps: f32| {
            let mut f = Fire::new(96, 128, SCENE_M / 128.0);
            f.params[P_TURBULENCE] = eps;
            f.params[P_GUST] = 0.0;
            f.ignite(48.0, 110.0, 8.0, 1200.0);
            run(&mut f, 75);
            let mut enstrophy = 0.0f32;
            let mut energy = 0.0f32;
            for y in 1..127 {
                for x in 1..95 {
                    let i = idx(96, x, y);
                    let c = (f.vy[i + 1] - f.vy[i - 1]) - (f.vx[i + 96] - f.vx[i - 96]);
                    enstrophy += c * c;
                    energy += f.vx[i] * f.vx[i] + f.vy[i] * f.vy[i];
                }
            }
            // Curl per unit of flow, so a livelier thermal cannot pass for a
            // curlier one.
            (enstrophy / energy.max(1e-9), heat_centroid(&f).0)
        };
        let (calm, drift_calm) = measure(0.0);
        let (curly, drift_curly) = measure(24.0);
        assert!(calm > 0.0, "nothing was moving, so this proves nothing");
        assert!(
            curly > calm * 1.15,
            "confinement added no curl: {calm:.3} -> {curly:.3} per unit of flow"
        );
        // It must add rotation, not a push: a confined thermal still goes up.
        assert!(
            (drift_curly - drift_calm).abs() < 6.0,
            "confinement blew the thermal sideways: {drift_calm:.1} -> {drift_curly:.1}"
        );
    }

    #[test]
    fn embers_are_thrown_by_a_fire_and_by_nothing_else() {
        let mut f = sheet(96, 128);
        run(&mut f, 60);
        assert_eq!(f.live_embers, 0, "sparks with no fire");

        light(&mut f, 48.0, 110.0);
        run(&mut f, 90);
        assert!(f.live_embers > 0, "a burning fire threw no sparks");
        assert!(f.live_embers <= MAX_EMBERS, "the ember budget was exceeded");
        for k in 0..f.live_embers {
            let e = f.embers[k];
            assert!(e.x >= 0.0 && e.x < 96.0 && e.y >= 0.0 && e.y < 128.0, "a spark left the grid");
            assert!(e.temp > AMBIENT, "a cold spark is soot, not an ember");
        }

        // They are mortal, so nothing accumulates over a long burn.
        f.params[P_EMBER_RATE] = 0.0;
        run(&mut f, 900);
        assert_eq!(f.live_embers, 0, "embers never died");
    }

    #[test]
    fn reset_returns_the_page_and_keeps_the_fuel() {
        let mut f = sheet(96, 128);
        light(&mut f, 48.0, 100.0);
        run(&mut f, 120);
        assert!(charred(&f) > 1.0);
        f.reset();
        assert_eq!(charred(&f), 0.0, "char survived a reset");
        assert!(f.temp.iter().all(|t| *t == AMBIENT), "heat survived a reset");
        assert!(f.fuel.iter().all(|v| *v == 1.0), "fuel did not come back");
        assert_eq!(f.live_embers, 0, "sparks survived a reset");
        assert_eq!(f.energy(), 0.0);
    }

    #[test]
    fn recommitting_the_fuel_map_does_not_unburn_anything() {
        let mut f = Fire::new(96, 128, SCENE_M / 128.0);
        f.fuel_in.fill(255);
        f.commit_fuel();
        light(&mut f, 48.0, 100.0);
        run(&mut f, 180);
        let burnt: Vec<usize> = (0..f.charred.len()).filter(|i| f.charred[*i] > 0.8).collect();
        assert!(burnt.len() > 20, "not enough of it burned: {} cells", burnt.len());
        // The page re-rendered, because someone typed into it.
        f.commit_fuel();
        for i in burnt {
            let left = f.fuel[i];
            assert!(left < 0.2, "ash came back as paper at {i}: {left}");
            assert!(
                (left - (1.0 - f.charred[i])).abs() < 1e-4,
                "fuel does not match the damage at {i}"
            );
        }
    }

    #[test]
    fn the_substep_count_follows_the_flow_and_respects_its_cap() {
        let mut f = sheet(96, 128);
        assert_eq!(f.step(1.0 / 60.0), 1, "still air needs one sub-step");
        light(&mut f, 48.0, 110.0);
        run(&mut f, 90);
        let cap = DEFAULTS[P_MAX_SUBSTEPS] as u32;
        let subs = f.step(1.0 / 60.0);
        assert!(subs > 1, "a running plume should be asking for sub-steps");
        assert!(subs <= cap, "sub-steps left the cap: {subs}");
        assert!(f.step(0.5) <= cap, "a stalled frame ignored the cap");
        finite_everywhere(&f);
    }

    #[test]
    fn blowing_on_it_moves_the_flame() {
        let mut f = sheet(128, 128);
        light(&mut f, 64.0, 110.0);
        run(&mut f, 45);
        let before = heat_centroid(&f).0;
        for _ in 0..45 {
            f.blow(30.0, 100.0, 14.0, 5.0, 0.0);
            f.step(1.0 / 60.0);
        }
        let after = heat_centroid(&f).0;
        assert!(after > before + 2.0, "blowing on it did nothing: {before:.1} -> {after:.1}");
    }

    #[test]
    fn hostile_input_is_refused_without_panicking() {
        assert_eq!(init(4, 64, 0.01), 0);
        assert_eq!(init(64, MAX_DIM + 1, 0.01), 0);

        let mut f = Fire::new(32, 32, f32::NAN); // a bad cell size falls back
        assert!(f.dx.is_finite() && f.dx > 0.0);
        f.fill_fuel(f32::INFINITY);
        f.ignite(f32::NAN, 0.0, 4.0, 900.0);
        f.ignite(0.0, 0.0, f32::INFINITY, f32::NAN);
        f.ignite(-1e9, -1e9, 1e9, 1e9);
        f.blow(1e9, 1e9, 1e9, f32::NAN, 1e9);
        f.params = [f32::NAN; PARAM_COUNT];
        f.step(f32::NAN);
        f.step(1.0 / 60.0);
        f.params = [f32::INFINITY; PARAM_COUNT];
        f.step(1.0 / 60.0);
        f.params = [-1e30; PARAM_COUNT];
        f.step(1.0 / 60.0);
        f.params = DEFAULTS;
        f.step(1.0 / 60.0);
        finite_everywhere(&f);
        assert!(
            f.out.iter().all(|v| (v & 0x7c00) != 0x7c00),
            "a non-finite texel reached the renderer"
        );
    }

    #[test]
    fn a_grid_of_any_shape_is_handled() {
        for (w, h) in [(8, 8), (8, 200), (200, 8), (97, 31)] {
            let mut f = Fire::new(w, h, SCENE_M / h as f32);
            f.fill_fuel(1.0);
            f.ignite(w as f32 * 0.5, h as f32 * 0.7, 3.0, 1500.0);
            run(&mut f, 60);
            finite_everywhere(&f);
        }
    }

    #[test]
    fn half_floats_round_trip_the_range_we_pack() {
        for v in [0.0f32, 0.001, 0.5, 1.0, 2.5, 64.0, 1e-9] {
            let back = f16_to_f32(f16(v));
            assert!((back - v).abs() <= v.abs() * 1e-3 + 1e-6, "{v} -> {back}");
        }
        assert_eq!(f16(f32::NAN), 0);
        assert_eq!(f16(f32::INFINITY), 0);
        assert_eq!(f16(1e30), 0x7bff, "overflow must saturate, not go infinite");
    }

    fn f16_to_f32(x: u16) -> f32 {
        let sign = ((x as u32) & 0x8000) << 16;
        let exp = ((x >> 10) & 0x1f) as i32;
        let mant = (x & 0x03ff) as u32;
        if exp == 0 {
            return f32::from_bits(sign) + (mant as f32) * 2.0f32.powi(-24);
        }
        f32::from_bits(sign | (((exp - 15 + 127) as u32) << 23) | (mant << 13))
    }
}
