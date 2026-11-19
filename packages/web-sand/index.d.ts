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

/** What `addLayer` hands back. */
export interface LayerHandle<Options> {
  /** Read the element again. */
  update(): void
  setOptions(options: Options): void
  destroy(): void
}

/** Every option, with its default in `DEFAULTS`. */
export interface SandDefaults {
  /** Cells along the longest axis. */
  grid: number
  maxDpr: number
  /** Scale the grid and textures down on weak devices. */
  auto: boolean
  interactive: boolean
  /** The stick's tip, in CSS pixels. */
  radius: number
  /** How deep it presses, in grid cells. */
  depth: number
  dwell: number
  dwellCap: number
  /** Steepest stable slope, cells per cell. */
  repose: number
  recovery: number
  disturbDecay: number
  driftDecay: number
  drag: number
  passes: number
  rippleScale: number
  rippleAmp: number
  dunes: number
  heightScale: number
  reliefAmp: number
  reliefScale: number | null
  sparkle: number
  exposure: number
  light: [number, number, number]
  sandLight: string
  sandDark: string
  sandDamp: string
  // the rest are per layer, and a layer can override them
  displace: number
  warp: number
  shade: number
  stain: number
  bury: number
  pickup: number
  pigment: number
  spread: number
  scrape: number
}

export type SandOptions = Partial<SandDefaults>

export interface SandLayerOptions {
  /** Pixels of slide down the slope. */
  displace?: number
  /** Pixels of resting ripple bend. */
  warp?: number
  /** Sand lighting on the content. */
  shade?: number
  /** Turned sand discolouring it. */
  stain?: number
  /** Piled height that hides it. */
  bury?: number
  /** Colour the stick lifts off it. */
  scrape?: number
  /** Re-upload a canvas each frame. */
  live?: boolean
  capture?: Capture
}

export interface SandEngine {
  readonly canvas: HTMLCanvasElement
  readonly params: SandDefaults
  addLayer(el: HTMLElement, options?: SandLayerOptions): LayerHandle<SandLayerOptions>
  reset(): void
  setParams(patch: SandOptions): void
  destroy(): void
}

export declare const DEFAULTS: SandDefaults

export declare function createSand(
  container: HTMLElement,
  /** `wasm` is a URL or the module's bytes, to serve it from somewhere else. */
  options?: SandOptions & { wasm?: string | ArrayBuffer | ArrayBufferView },
): Promise<SandEngine>

export interface SandSurfaceProps {
  options?: SandOptions
  /** Pin the canvas over the whole page (the default), or fill its own box. */
  fullscreen?: boolean
  onReady?: (engine: SandEngine) => void
  onError?: (error: unknown) => void
}

export declare const SandSurface: Sfc<
  SandSurfaceProps,
  Pick<SandEngine, 'reset' | 'setParams'> & { engine: SandEngine | null },
  DefaultSlot
>

export interface SandDistortProps extends SandLayerOptions {
  disabled?: boolean
}

export declare const SandDistort: Sfc<SandDistortProps, { update(): void }, DefaultSlot>
