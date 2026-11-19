import type { AllowedComponentProps, ComponentCustomProps, VNode, VNodeProps } from 'vue'

/** A Vue component: what a template can pass it, what a ref to it exposes, and its slots. */
type Sfc<Props, Exposed = {}, Slots = {}> = new () => Exposed & {
  $props: Props & VNodeProps & AllowedComponentProps & ComponentCustomProps
  $slots: Slots
}
type DefaultSlot = { default?: () => VNode[] }

export type QualityTier = 'low' | 'medium' | 'high' | 'ultra'

export interface WaterStats {
  fps: number
  tier: QualityTier
  auto: boolean
  /** The simulation grid, as "w×h". */
  grid: string
  cells: number
  idle: boolean
}

export interface WaterSurfaceProps {
  breeze?: number
  quality?: 'auto' | QualityTier
  seed?: number
  /** Depth of the submerged interface layer, in half-screen-height units. 0 is off. */
  uiDepth?: number
  /** How deep the pond reads. Drives refraction offset and absorption. */
  waterDepth?: number
  /** Whether pressing the surface drops a stone. */
  dropOnPress?: boolean
  /** Say nothing while the pond starts, or if it cannot: no "waking the pond" line. */
  silent?: boolean
  onStats?: (stats: WaterStats) => void
  onReady?: () => void
}

export interface WaterSurfaceExposed {
  /** Disturb the water at a point in CSS pixels. */
  splash(clientX: number, clientY: number, options?: { radius?: number; strength?: number }): void
  /** Publish the whole submerged interface layer; null clears it. */
  setUiLayer(source: TexImageSource | null): void
  /** Replace one rectangle of it. */
  setUiRegion(image: TexImageSource, x: number, y: number): void
}

export declare const WaterSurface: Sfc<WaterSurfaceProps, WaterSurfaceExposed>
