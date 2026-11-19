import type { AllowedComponentProps, ComponentCustomProps, VNode, VNodeProps } from 'vue'

/** A Vue component: what a template can pass it, what a ref to it exposes, and its slots. */
type Sfc<Props, Exposed = {}, Slots = {}> = new () => Exposed & {
  $props: Props & VNodeProps & AllowedComponentProps & ComponentCustomProps
  $slots: Slots
}
type DefaultSlot = { default?: () => VNode[] }

export type QualityTier = 'low' | 'medium' | 'high' | 'ultra'

/** Your own rasteriser for DOM content, in place of the built-in one. */
export type Capture = (
  el: HTMLElement,
  dpr: number,
  size: { width: number; height: number },
) => TexImageSource | null | Promise<TexImageSource | null>

/** What `addLayer` hands back. */
export interface LayerHandle<Options> {
  /** Read the element again. */
  update(): void
  setOptions(options: Options): void
  destroy(): void
}

/** The engine's own options, with their defaults in `DEFAULTS`. */
export interface FireDefaults {
  /** How tall the viewport is, in metres: the size of fire you are looking at. */
  scene: number
  /** A fixed tier, or null to let the governor decide. */
  quality: QualityTier | null
  interactive: boolean
  /** Radius of what the pointer lights, in CSS pixels. */
  torch: number
  /** How hot the pointer is, in K above ambient. */
  torchHeat: number
  fanSpeed: number
  fan: number
  exposure: number
  haze: number
  scorch: number
  burn: number
  glow: number
  sootEmit: number
  blue: number
  smoke: number
  smokeCool: string
  smokeWarm: string
  emberSize: number
  fuel: number
}

/** The solver's tunables, by name. All numbers. */
export type FireParamName =
  | 'ambient' | 'pyrolysisActivation' | 'pyrolysisRate' | 'surfaceHeat' | 'burnActivation' | 'burnRate'
  | 'heatRelease' | 'sootYield' | 'oxygenUse' | 'oxygenRefresh' | 'oxygenDiffuse' | 'vapourDecay'
  | 'gasConduct' | 'gasCool' | 'gasRadiate' | 'surfaceConduct' | 'surfaceRadiateK' | 'surfaceCool'
  | 'surfaceRadiate' | 'coupleSurface' | 'coupleGas' | 'buoyancy' | 'gravity' | 'sootWeight'
  | 'windX' | 'windY' | 'windCouple' | 'gust' | 'gustHz' | 'turbulence' | 'drag' | 'sootDecay'
  | 'fuelDensity' | 'charRate' | 'emberRate' | 'emberLife' | 'emberDrag' | 'pressureIterations'
  | 'cfl' | 'maxSubsteps' | 'spread' | 'flameFeedback' | 'flameReach' | 'flameTemp' | 'fuelSupply'

export type FireParams = Record<FireParamName, number>

export type FireOptions = Partial<FireDefaults & FireParams>

export interface FireLayerOptions {
  /** How combustible, 0 = fireproof. */
  fuel?: number
  /** Pixels of refraction through hot air. */
  haze?: number
  /** How dark the char goes. */
  scorch?: number
  /** Damage at which it is gone. */
  burn?: number
  /** Brightness of the burning edge. */
  glow?: number
  /** Fuel, but never drawn. */
  invisible?: boolean
  /** Re-upload a canvas each frame. */
  live?: boolean
  capture?: Capture
}

/** Where to hold the match: on the page, or already in grid cells. */
export type FireSpot = ({ clientX: number; clientY: number } | { cells: { x: number; y: number } }) & {
  radius?: number
  heat?: number
}

export interface FireEngine {
  readonly canvas: HTMLCanvasElement
  readonly params: FireDefaults
  readonly physics: FireParams
  addLayer(el: HTMLElement, options?: FireLayerOptions): LayerHandle<FireLayerOptions>
  /** Hold a match to the page. */
  ignite(spot: FireSpot): void
  readonly quality: { tier: QualityTier; auto: boolean; fps: number }
  /** Pin a tier, or pass null to hand control back to the governor. */
  setQuality(tier: QualityTier | null): void
  setParams(patch: FireOptions): void
  /** Put it out and put the page back. */
  reset(): void
  destroy(): void
}

export declare const DEFAULTS: FireDefaults

export declare function createFire(
  container: HTMLElement,
  options?: FireOptions & { wasm?: string | URL; worker?: string | URL | (() => Worker) },
): Promise<FireEngine>

export interface FireSurfaceProps {
  options?: FireOptions
  /** Pin the canvas over the whole page (the default), or fill its own box. */
  fullscreen?: boolean
  onReady?: (engine: FireEngine) => void
  onError?: (error: unknown) => void
  /** The quality tier changed; `reason` is 'manual', 'auto', 'slow' or 'headroom'. */
  onQuality?: (quality: { tier: QualityTier; reason: string; auto: boolean }) => void
}

export declare const FireSurface: Sfc<
  FireSurfaceProps,
  Pick<FireEngine, 'reset' | 'ignite' | 'setParams' | 'setQuality'> & { engine: FireEngine | null },
  DefaultSlot
>

export interface FireLayerProps extends FireLayerOptions {
  disabled?: boolean
}

export declare const FireLayer: Sfc<FireLayerProps, { update(): void }, DefaultSlot>
