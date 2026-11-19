import type { AllowedComponentProps, ComponentCustomProps, VNode, VNodeProps } from 'vue'

/** A Vue component: what a template can pass it, what a ref to it exposes, and its slots. */
type Sfc<Props, Exposed = {}, Slots = {}> = new () => Exposed & {
  $props: Props & VNodeProps & AllowedComponentProps & ComponentCustomProps
  $slots: Slots
}
type DefaultSlot = { default?: () => VNode[] }

/** A photograph or a video composited into a page, so it tears with the paper. Positions are CSS pixels. */
export interface TearMedia {
  kind: 'image' | 'video'
  src: string
  x: number
  y: number
  w: number
  h: number
  radius?: number
  /** Put it under the page's own markup rather than over it. */
  behind?: boolean
}

/** A control that stays live DOM on top of its page until the page is torn away. */
export interface TearWidget {
  id: string
  kind: 'button' | 'toggle'
  label: string
  x: number
  y: number
  w: number
  h: number
  /** A toggle's starting state. */
  on?: boolean
}

/**
 * One page of cloth. `w` and `h` are the stage in CSS pixels and `s` is a
 * scale factor (1 at a short side of 820) for sizing type.
 */
export interface TearLayer {
  name: string
  css: string
  html: (w: number, h: number, s: number) => string
  media?: (w: number, h: number, s: number) => TearMedia[]
  components?: (w: number, h: number, s: number) => TearWidget[]
  /** False for a page that cannot be torn. */
  tearable?: boolean
  /** A colour painted under the page's media. */
  backdrop?: string
}

export interface TearableClothProps {
  /** The pages, front to back. */
  layers: TearLayer[]
  /** The colour behind every sheet. */
  floor?: string
  /** How many tearable pages still stand, and the name of the front one. */
  onSheets?: (sheets: { remaining: number; total: number; name: string }) => void
  onFirsttear?: () => void
  /** A widget was pressed; the payload is its id. */
  onActivate?: (id: string) => void
}

export declare const TearableCloth: Sfc<TearableClothProps, { /** Hang every page again. */ reset(): void }>
