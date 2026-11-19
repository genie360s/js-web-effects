import type { AllowedComponentProps, ComponentCustomProps, VNode, VNodeProps } from 'vue'

/** A Vue component: what a template can pass it, what a ref to it exposes, and its slots. */
type Sfc<Props, Exposed = {}, Slots = {}> = new () => Exposed & {
  $props: Props & VNodeProps & AllowedComponentProps & ComponentCustomProps
  $slots: Slots
}
type DefaultSlot = { default?: () => VNode[] }

/** Your own rasteriser for DOM content, in place of the built-in one. */
export type Capture = (
  el: HTMLElement,
  dpr: number,
  size: { width: number; height: number },
) => TexImageSource | null | Promise<TexImageSource | null>

export type GlitchStyle = 'image' | 'dots' | 'mosaic' | 'mask' | 'ascii'

/** The engine's own options, with their defaults in `DEFAULTS`. */
export interface GlitchDefaults {
  /** The smallest block, in CSS pixels. Blocks are 1, 2, 4 or 8 of these. */
  cell: number
  /** The same seed cuts the same blocks and replays the same sequence. */
  seed: number
  /** Whether the picture should be there. It arrives, and leaves, at `speed`. */
  visible: boolean
  /** How the subject is found: 'auto', 'alpha', 'none', or a hex colour to key out. */
  key: 'auto' | 'alpha' | 'none' | (string & {})
  /** How far from the key colour still counts as background, 0..1. */
  tolerance: number
  /** Leave a keyed background out for good. */
  cutout: boolean
  capture: Capture | null
  interactive: boolean
  /** Radius of what a stroke unsettles, in CSS pixels. */
  pointer: number
  pointerGain: number
  /** Strength of the burst a click sets off; 0 for none. */
  clickBurst: number
  ink: string
  glowColor: string
}

/** The solver's tunables. */
export interface GlitchParams {
  /** Progress per second: a reveal takes 1/speed seconds. */
  speed: number
  /** Share of arrived blocks misbehaving at rest; 0 is a still picture. */
  glitch: number
  hold: number
  burstRate: number
  burstLength: number
  switch: number
  hole: number
  pixel: number
  shift: number
  labels: number
  glow: number
  glowDecay: number
  threshold: number
  split: number
  dots: number
  /** The resting rendering, by name or by its index in `STYLES`. */
  style: GlitchStyle | number
  decay: number
  exciteGain: number
}

export type GlitchOptions = Partial<GlitchDefaults & GlitchParams>

export interface GlitchEngine {
  readonly canvas: HTMLCanvasElement
  readonly params: GlitchDefaults
  readonly physics: GlitchParams
  /** Unsettle the blocks around a point on the page. */
  pulse(spot: { clientX: number; clientY: number; radius?: number; strength?: number }): void
  /** Flick through the sequence. Strength scales how long it lasts. */
  burst(strength?: number): void
  /** Bring the picture in, all of it or part of it. */
  reveal(amount?: number): void
  hide(): void
  /** How much of the picture is there right now, 0..1. */
  readonly progress: number
  readonly grid: { w: number; h: number; across: number; down: number }
  /** Re-cut the blocks and restart the sequence. */
  reseed(seed: number): void
  /** Read the element again. */
  update(): Promise<void>
  setParams(patch: GlitchOptions): void
  destroy(): void
}

export declare const DEFAULTS: GlitchDefaults
export declare const STYLES: GlitchStyle[]

/** `wasm` is a URL, to serve the module from somewhere else. */
export declare function createGlitch(
  element: HTMLElement,
  options?: GlitchOptions & { wasm?: string | URL },
): Promise<GlitchEngine>

export interface GlitchSurfaceProps {
  options?: GlitchOptions
  /** Whether the content should be there. */
  visible?: boolean
  onReady?: (engine: GlitchEngine) => void
  onError?: (error: unknown) => void
}

export declare const GlitchSurface: Sfc<
  GlitchSurfaceProps,
  Pick<GlitchEngine, 'reveal' | 'hide' | 'burst' | 'pulse' | 'reseed' | 'update' | 'setParams'> & {
    engine: GlitchEngine | null
  },
  DefaultSlot
>
