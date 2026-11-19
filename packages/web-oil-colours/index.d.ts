import type { AllowedComponentProps, ComponentCustomProps, VNode, VNodeProps } from 'vue'

/** A Vue component: what a template can pass it, what a ref to it exposes, and its slots. */
type Sfc<Props, Exposed = {}, Slots = {}> = new () => Exposed & {
  $props: Props & VNodeProps & AllowedComponentProps & ComponentCustomProps
  $slots: Slots
}
type DefaultSlot = { default?: () => VNode[] }

export type QualityTier = 'low' | 'medium' | 'high' | 'ultra'

import type { ObjectDirective } from 'vue'

/** sRGB, each channel 0..1. */
export type Rgb = [number, number, number]

export interface OilStats {
  fps: number
  tier: QualityTier
  auto: boolean
  /** The simulation grid, as "w×h". */
  grid: string
  cells: number
  idle: boolean
}

/** A rectangle in CSS pixels. */
export interface OilRect {
  x: number
  y: number
  w: number
  h: number
}

export interface OilCanvasProps {
  quality?: 'auto' | QualityTier
  /** 0 is paint gone tacky, 1 is straight out of the tube. */
  wetness?: number
  /** Brush radius as a fraction of the canvas's short side. */
  brushSize?: number
  /** The loaded colour, or null for a clean brush that only moves what is there. */
  color?: Rgb | null
  seed?: number
  /** Start on bare linen instead of a seeded painting. */
  bare?: boolean
  onStats?: (stats: OilStats) => void
  /** The canvas was scraped and laid again: on a resize or a new seed. */
  onReset?: () => void
  onReady?: () => void
}

export interface OilCanvasExposed {
  /** Lay a whole picture into the paint: an image, a video frame, a canvas. False if it could not be laid yet. */
  paintFrame(
    source: HTMLImageElement | HTMLVideoElement | HTMLCanvasElement | ImageBitmap,
    amount?: number,
    relief?: number,
  ): boolean
  /** Scrape the canvas back to bare linen. */
  clear(): void
  /**
   * Lay something into the paint. `rect` is relative to the canvas; `draw`
   * fills a canvas of that size with the surface to deposit, where alpha is
   * how much paint each pixel is worth.
   */
  stamp(
    rect: OilRect,
    draw: (
      ctx: CanvasRenderingContext2D,
      width: number,
      height: number,
      where: OilRect,
      at: { x: number; y: number },
    ) => void,
    amount?: number,
  ): boolean
}

export declare const OilCanvas: Sfc<OilCanvasProps, OilCanvasExposed>

export interface OilSurfaceProps extends Omit<OilCanvasProps, 'onReset' | 'onReady'> {
  /** Paint thickness a fully opaque pixel of a component is worth. */
  amount?: number
}

/** A canvas of paint with ordinary elements laid into it: anything inside marked with `v-oil`. */
export declare const OilSurface: Sfc<OilSurfaceProps, { /** Lay everything again. */ relay(): void }, DefaultSlot>

export interface OilCardProps {
  title?: string
  subtitle?: string
  /** A palette name, or 'ground' for a scumbled neutral. */
  pigment?: string
}

export declare const OilCard: Sfc<OilCardProps, {}, DefaultSlot & { footer?: () => VNode[] }>

/** `v-oil="'cadmium red'"`, `v-oil="{ pigment: 'ultramarine', pad: 6 }"`, or bare `v-oil`. */
export declare const vOil: ObjectDirective<HTMLElement, string | { pigment?: string; pad?: number | string } | undefined>

export interface Pigment {
  name: string
  rgb: Rgb
}

/** The studio palette: the same ten pigments the core lays down. */
export declare const PALETTE: Pigment[]
