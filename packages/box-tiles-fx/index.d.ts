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
export interface TileDefaults {
  /** How big a tile is, in CSS pixels. */
  cell: number
  /** The same seed replays the same tiles. */
  seed: number
  /** A fixed tier, or null to let the governor decide. */
  quality: QualityTier | null
  interactive: boolean
  /** Radius of what a stroke excites, in CSS pixels. */
  pointer: number
  pointerGain: number
  clickGain: number
  lineColor: string
  lineAlpha: number
  lineWidth: number
  lineGlow: number
  /** 'content' draws the grid only over layers; 'surface' over the whole box. */
  gridMask: 'content' | 'surface'
  shadows: string
  highlights: string
  grade: number
  exposure: number
  vignette: number
  reveal: number
  revealSoft: number
  sweep: number
  tiles: boolean
}

/** The solver's tunables. */
export interface TileParams {
  rate: number
  hold: number
  holdJitter: number
  shift: number
  black: number
  lift: number
  block: number
  offsetMax: number
  liftMax: number
  decay: number
  pulseGain: number
  beatGain: number
  maxActive: number
}

export type TileOptions = Partial<TileDefaults & TileParams>

export interface TileLayerOptions {
  /** How much of the layer has been revealed, 0..1, tile by tile. */
  reveal?: number
  revealSoft?: number
  /** 0 reveals by lottery, 1 wipes left to right. */
  sweep?: number
  /** False draws the layer flat, untouched by the tiles. */
  tiles?: boolean
  /** Re-upload a canvas each frame. */
  live?: boolean
  capture?: Capture
}

/** A point to excite the tiles around: on the page, or already in grid cells. */
export type TileSpot = ({ clientX: number; clientY: number } | { cells: { x: number; y: number } }) & {
  radius?: number
  strength?: number
}

export interface TilesEngine {
  readonly canvas: HTMLCanvasElement
  readonly params: TileDefaults
  readonly physics: TileParams
  addLayer(el: HTMLElement, options?: TileLayerOptions): LayerHandle<TileLayerOptions>
  pulse(spot: TileSpot): void
  /** Excite the whole grid at once. Strength is roughly 0..1. */
  beat(strength?: number): void
  /** A steady level of excitement that does not fade; 0 lets go. */
  drive(level?: number): void
  reseed(seed: number): void
  readonly quality: { tier: QualityTier; auto: boolean; fps: number }
  /** Tiles active right now. */
  readonly active: number
  readonly grid: { w: number; h: number; across: number; down: number; px: number }
  /** Pin a tier, or pass null to hand control back to the governor. */
  setQuality(tier: QualityTier | null): void
  setParams(patch: TileOptions): void
  /** Every tile back to rest. */
  reset(): void
  destroy(): void
}

export declare const DEFAULTS: TileDefaults

export declare function createTiles(
  container: HTMLElement,
  options?: TileOptions & { wasm?: string | URL; worker?: string | URL | (() => Worker) },
): Promise<TilesEngine>

export interface TileSurfaceProps {
  options?: TileOptions
  /** Pin the canvas over the whole page (the default), or fill its own box. */
  fullscreen?: boolean
  onReady?: (engine: TilesEngine) => void
  onError?: (error: unknown) => void
  /** The quality tier changed; `reason` is 'manual', 'auto', 'slow' or 'headroom'. */
  onQuality?: (quality: { tier: QualityTier; reason: string; auto: boolean }) => void
}

export declare const TileSurface: Sfc<
  TileSurfaceProps,
  Pick<TilesEngine, 'reset' | 'pulse' | 'beat' | 'drive' | 'reseed' | 'setParams' | 'setQuality'> & {
    engine: TilesEngine | null
  },
  DefaultSlot
>

export interface TileLayerProps extends TileLayerOptions {
  disabled?: boolean
}

export declare const TileLayer: Sfc<TileLayerProps, { update(): void }, DefaultSlot>

export interface OnsetDetectorOptions {
  /** Frames of memory. */
  window?: number
  /** How far above the mean counts. */
  threshold?: number
  /** Energy below which nothing is a beat. */
  floor?: number
  minGapMs?: number
}

export interface OnsetDetector {
  feed(energy: number, now: number): { beat: boolean; strength: number; level: number }
  reset(): void
}

export declare function createOnsetDetector(options?: OnsetDetectorOptions): OnsetDetector

export interface AudioHandle {
  context: AudioContext
  analyser: AnalyserNode
  onsets: OnsetDetector
  /** Call from a user gesture; browsers keep audio silent until one. */
  resume(): Promise<void>
  detach(): void
}

/** Let a sound source knock the grid: beats become `beat()`, the level becomes `drive()`. */
export declare function attachAudio(
  engine: Pick<TilesEngine, 'beat' | 'drive'>,
  source: HTMLMediaElement | MediaStream,
  options?: { band?: [number, number]; drive?: number; gain?: number; detector?: OnsetDetectorOptions },
): AudioHandle
