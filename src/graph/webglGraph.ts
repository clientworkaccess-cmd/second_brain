// The desktop app's src/renderer/src/components/graph/webglGraph.ts, as it is. Keep it in step.
import {
  forceCenter,
  forceLink,
  forceManyBody,
  forceSimulation,
  forceX,
  forceY,
  type ForceLink,
  type Simulation,
  type SimulationLinkDatum,
  type SimulationNodeDatum
} from 'd3-force'
import { select } from 'd3-selection'
import { zoom, zoomIdentity, type ZoomBehavior, type ZoomTransform } from 'd3-zoom'
import { areaAnchors, orderAreas, type GraphData, type GraphNode } from './data'

/**
 * WebGL graph renderer. Links are one GL_LINES draw call and nodes one GL_POINTS draw call, so frame
 * cost is flat in the number of links (Canvas 2D stroking thousands of anti-aliased lines per frame
 * is what made the previous renderer crawl). Labels use a small 2D overlay and are only drawn for the
 * hovered neighbourhood, the active note, or everything when zoomed in.
 *
 * Area view ("group by area"): nodes are colored by department instead of folder (a pie when a note is
 * in several), an extra force gathers each department around its own anchor, a soft disc is drawn
 * behind every department, and one department can be highlighted while the rest is dimmed.
 */

export interface GraphPalette {
  dark: boolean
  node: string
  unresolved: string
  accent: string
  link: string
  label: string
  /** Canvas background, used to outline area names so they stay readable over links. */
  bg: string
  font: string
}

export interface GraphEngineHandlers {
  onNodeClick: (id: string) => void
}

type RGBA = [number, number, number, number]

interface SimNode extends SimulationNodeDatum, GraphNode {
  radius: number
}

interface SimLink extends SimulationLinkDatum<SimNode> {
  weight: number
}

interface Region {
  name: string
  x: number
  y: number
  r: number
  members: number
}

const NODE_REL_SIZE = 4
const LABEL_ZOOM = 1.3
const MAX_LABELS = 600
const MIN_NODE_PX = 5
const MAX_POINT_PX = 255
/** The layout never cools completely: nodes keep drifting gently, like Obsidian's graph. */
const AMBIENT_ALPHA = 0.012
/** Temperature while a node is being dragged, so its neighbourhood follows. */
const DRAG_ALPHA = 0.3
/** Random nudge per tick that keeps the drift visible once forces are balanced. */
const JITTER = 0.25
/** Zoom to fit once the initial layout has mostly formed. */
const FIT_ALPHA = 0.05
const CLICK_SLOP_PX = 4
/** Area view: pull toward the area's anchor (per unit of distance, like a link of strength 1). */
const AREA_STRENGTH = 0.32
/** Area view: links between notes that share no area are weakened so departments can separate. */
const CROSS_AREA_LINK = 0.12
/** A node shows at most this many areas as pie slices. */
const MAX_PIE = 4
/** Labels tried for the highlighted area until the view is zoomed in (its best connected notes). */
const FOCUS_LABELS = 80
const REGION_SEGMENTS = 40
/** Share of a region's radius that is evenly shaded; the rest fades out. */
const REGION_CORE = 0.7
const REGION_MIN_RADIUS = 40
const REGION_PADDING = 26

const UNIT_CIRCLE: [number, number][] = Array.from({ length: REGION_SEGMENTS + 1 }, (_, i) => {
  const a = (i / REGION_SEGMENTS) * Math.PI * 2
  return [Math.cos(a), Math.sin(a)]
})

const LINK_VS = `
attribute vec2 a_pos;
attribute vec4 a_color;
uniform vec2 u_res;
uniform float u_k;
uniform vec2 u_t;
uniform float u_dpr;
varying vec4 v_color;
void main() {
  vec2 px = (a_pos * u_k + u_t) * u_dpr;
  vec2 clip = px / u_res * 2.0 - 1.0;
  gl_Position = vec4(clip.x, -clip.y, 0.0, 1.0);
  v_color = a_color;
}`

const LINK_FS = `
precision mediump float;
varying vec4 v_color;
void main() {
  gl_FragColor = vec4(v_color.rgb * v_color.a, v_color.a);
}`

const NODE_VS = `
attribute vec2 a_pos;
attribute float a_size;
attribute float a_n;
attribute vec4 a_c0;
attribute vec4 a_c1;
attribute vec4 a_c2;
attribute vec4 a_c3;
uniform vec2 u_res;
uniform float u_k;
uniform vec2 u_t;
uniform float u_dpr;
uniform float u_minPx;
uniform float u_maxPx;
varying vec4 v_c0;
varying vec4 v_c1;
varying vec4 v_c2;
varying vec4 v_c3;
varying float v_n;
varying float v_size;
void main() {
  vec2 px = (a_pos * u_k + u_t) * u_dpr;
  vec2 clip = px / u_res * 2.0 - 1.0;
  gl_Position = vec4(clip.x, -clip.y, 0.0, 1.0);
  float size = clamp(a_size * 2.0 * u_k * u_dpr, u_minPx, u_maxPx);
  v_size = size;
  gl_PointSize = size + 2.0;
  v_c0 = a_c0;
  v_c1 = a_c1;
  v_c2 = a_c2;
  v_c3 = a_c3;
  v_n = a_n;
}`

// One color fills the disc; several are drawn as pie slices, clockwise from the top.
const NODE_FS = `
precision mediump float;
varying vec4 v_c0;
varying vec4 v_c1;
varying vec4 v_c2;
varying vec4 v_c3;
varying float v_n;
varying float v_size;
void main() {
  vec2 d = gl_PointCoord - 0.5;
  float dist = length(d) * (v_size + 2.0);
  float r = v_size * 0.5;
  float a = 1.0 - smoothstep(r - 1.0, r + 0.5, dist);
  if (a <= 0.0) discard;
  vec4 c = v_c0;
  if (v_n > 1.5) {
    float t = atan(d.x, -d.y) / 6.2831853;
    if (t < 0.0) t += 1.0;
    float slice = min(floor(t * v_n), v_n - 1.0);
    c = slice < 0.5 ? v_c0 : (slice < 1.5 ? v_c1 : (slice < 2.5 ? v_c2 : v_c3));
  }
  gl_FragColor = vec4(c.rgb * c.a * a, c.a * a);
}`

let scratch: CanvasRenderingContext2D | null = null
/** Any CSS color -> RGBA floats (the canvas normalises the color for us). */
export function cssToRgba(color: string, alpha = 1): RGBA {
  scratch ??= document.createElement('canvas').getContext('2d')
  if (!scratch) return [0.5, 0.5, 0.5, alpha]
  scratch.fillStyle = '#000'
  scratch.fillStyle = color
  const norm = scratch.fillStyle as string
  if (norm.startsWith('#')) {
    return [parseInt(norm.slice(1, 3), 16) / 255, parseInt(norm.slice(3, 5), 16) / 255, parseInt(norm.slice(5, 7), 16) / 255, alpha]
  }
  const m = /rgba?\(([^)]+)\)/.exec(norm)
  if (!m) return [0.5, 0.5, 0.5, alpha]
  const [r, g, b, a] = m[1].split(',').map((s) => parseFloat(s))
  return [r / 255, g / 255, b / 255, alpha * (Number.isFinite(a) ? a : 1)]
}

export function hslToRgba(h: number, s: number, l: number, alpha = 1): RGBA {
  const c = (1 - Math.abs(2 * l - 1)) * s
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1))
  const m = l - c / 2
  const [r, g, b] = h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x] : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x]
  return [r + m, g + m, b + m, alpha]
}

const fade = (c: RGBA, a: number): RGBA => [c[0], c[1], c[2], c[3] * a]

const radiusFor = (degree: number): number => Math.sqrt(1 + Math.sqrt(degree)) * NODE_REL_SIZE

function compile(gl: WebGLRenderingContext, type: number, src: string): WebGLShader {
  const s = gl.createShader(type)!
  gl.shaderSource(s, src)
  gl.compileShader(s)
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s) ?? 'shader compile failed')
  return s
}

function program(gl: WebGLRenderingContext, vs: string, fs: string): WebGLProgram {
  const p = gl.createProgram()!
  gl.attachShader(p, compile(gl, gl.VERTEX_SHADER, vs))
  gl.attachShader(p, compile(gl, gl.FRAGMENT_SHADER, fs))
  gl.linkProgram(p)
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p) ?? 'program link failed')
  return p
}

interface GLState {
  gl: WebGLRenderingContext
  linkProg: WebGLProgram
  nodeProg: WebGLProgram
  regionPos: WebGLBuffer
  regionColor: WebGLBuffer
  linkPos: WebGLBuffer
  linkColor: WebGLBuffer
  nodePos: WebGLBuffer
  nodeSize: WebGLBuffer
  nodeCount: WebGLBuffer
  nodeColor: WebGLBuffer[]
}

export class WebGLGraph {
  readonly canvas: HTMLCanvasElement
  private readonly labels: HTMLCanvasElement
  private readonly labelCtx: CanvasRenderingContext2D
  private glState: GLState | null = null
  private nodes: SimNode[] = []
  private links: SimLink[] = []
  private byId = new Map<string, SimNode>()
  private adjacency = new Map<string, { neighbors: Set<string>; links: Set<SimLink> }>()
  private simulation: Simulation<SimNode, SimLink>
  private transform: ZoomTransform = zoomIdentity
  private readonly zoomBehavior: ZoomBehavior<HTMLCanvasElement, unknown>
  private palette: GraphPalette
  private hues = new Map<string, number>()
  private activeId: string | null = null
  private hoverId: string | null = null
  private areaMode = false
  private areaHues = new Map<string, number>()
  private areaRgb = new Map<string, RGBA>()
  private focusArea: string | null = null
  /** Notes of the highlighted area, best connected first. */
  private focusMembers: SimNode[] = []
  /** Per node (same order as `nodes`): where the area force pulls it, or null. */
  private targets: ({ x: number; y: number } | null)[] = []
  private regions: Region[] = []
  private dimmedCount = 0
  private width = 1
  private height = 1
  private dpr = 1
  private frame: number | null = null
  private frames = 0
  private dirty = true
  private colorsDirty = true
  private fitPending = false
  private regionPosData = new Float32Array(0)
  private regionColorData = new Float32Array(0)
  private linkPosData = new Float32Array(0)
  private linkColorData = new Float32Array(0)
  private nodePosData = new Float32Array(0)
  private nodeSizeData = new Float32Array(0)
  private nodeCountData = new Float32Array(0)
  /** Up to MAX_PIE colors per node; unused slots repeat the first. */
  private nodeColorData: Float32Array[] = Array.from({ length: MAX_PIE }, () => new Float32Array(0))
  private pressAt: { x: number; y: number } | null = null
  private dragging: SimNode | null = null
  private dragMoved = false
  private destroyed = false
  private readonly ro: ResizeObserver
  private readonly onLost = (e: Event): void => {
    e.preventDefault()
    this.glState = null
  }
  private readonly onRestored = (): void => {
    this.initGL()
    this.colorsDirty = true
    this.requestRender()
  }

  constructor(
    private readonly host: HTMLElement,
    palette: GraphPalette,
    private readonly handlers: GraphEngineHandlers
  ) {
    this.palette = palette
    this.canvas = document.createElement('canvas')
    this.canvas.className = 'graph-gl'
    this.labels = document.createElement('canvas')
    this.labels.className = 'graph-labels'
    host.append(this.canvas, this.labels)
    this.labelCtx = this.labels.getContext('2d')!
    this.canvas.addEventListener('webglcontextlost', this.onLost)
    this.canvas.addEventListener('webglcontextrestored', this.onRestored)
    this.initGL()

    const jitter = (): void => {
      for (const n of this.nodes) {
        if (n.fx != null) continue
        n.vx = (n.vx ?? 0) + (Math.random() - 0.5) * JITTER
        n.vy = (n.vy ?? 0) + (Math.random() - 0.5) * JITTER
      }
    }
    // Area view: every note is drawn toward its department (toward the middle of them when it has several).
    const area = (alpha: number): void => {
      if (!this.areaMode) return
      const k = AREA_STRENGTH * alpha
      for (let i = 0; i < this.nodes.length; i++) {
        const n = this.nodes[i]
        const t = this.targets[i]
        if (!t || n.fx != null) continue
        n.vx = (n.vx ?? 0) + (t.x - (n.x ?? 0)) * k
        n.vy = (n.vy ?? 0) + (t.y - (n.y ?? 0)) * k
      }
    }
    this.simulation = forceSimulation<SimNode, SimLink>([])
      .force('charge', forceManyBody().strength(-140))
      .force('center', forceCenter(0, 0))
      .force('x', forceX(0).strength(0.02))
      .force('y', forceY(0).strength(0.02))
      .force('area', area)
      .force('jitter', jitter)
      .alphaDecay(0.03)
      .alphaTarget(AMBIENT_ALPHA)
      .velocityDecay(0.35)
      .stop() // ticked from our own frame loop

    this.zoomBehavior = zoom<HTMLCanvasElement, unknown>()
      .scaleExtent([0.05, 10])
      // A press on a node starts a node drag (below) rather than a pan.
      .filter((event: MouseEvent | WheelEvent) => {
        if (event.type === 'wheel') return true
        if (event.type === 'mousedown') {
          const p = this.localPoint(event as MouseEvent)
          if (this.nodeAt(p.x, p.y)) return false
        }
        return !event.ctrlKey && !(event as MouseEvent).button
      })
      .on('zoom', (e: { transform: ZoomTransform }) => {
        this.transform = e.transform
        this.requestRender()
      })
    select(this.canvas).call(this.zoomBehavior).on('dblclick.zoom', null)

    this.canvas.addEventListener('mousemove', this.onMouseMove)
    this.canvas.addEventListener('mouseleave', this.onMouseLeave)
    this.canvas.addEventListener('mousedown', this.onMouseDown)

    this.ro = new ResizeObserver(() => this.resize())
    this.ro.observe(host)
    this.resize()
  }

  // ---- public API ----

  setData(data: GraphData): void {
    const prev = this.byId
    const byId = new Map<string, SimNode>()
    const nodes: SimNode[] = data.nodes.map((n) => {
      const old = prev.get(n.id)
      const node: SimNode = old
        ? Object.assign(old, n, { radius: radiusFor(n.degree) })
        : { ...n, radius: radiusFor(n.degree), x: (Math.random() - 0.5) * 40, y: (Math.random() - 0.5) * 40 }
      byId.set(n.id, node)
      return node
    })
    const links: SimLink[] = []
    const adjacency = new Map<string, { neighbors: Set<string>; links: Set<SimLink> }>()
    const entry = (id: string) => {
      let a = adjacency.get(id)
      if (!a) adjacency.set(id, (a = { neighbors: new Set(), links: new Set() }))
      return a
    }
    for (const l of data.links) {
      const s = byId.get(l.source)
      const t = byId.get(l.target)
      if (!s || !t) continue
      const link: SimLink = { source: s, target: t, weight: l.weight }
      links.push(link)
      entry(s.id).neighbors.add(t.id)
      entry(s.id).links.add(link)
      entry(t.id).neighbors.add(s.id)
      entry(t.id).links.add(link)
    }
    const first = this.nodes.length === 0
    this.nodes = nodes
    this.links = links
    this.byId = byId
    this.adjacency = adjacency
    this.hoverId = null

    this.linkPosData = new Float32Array(links.length * 4)
    this.linkColorData = new Float32Array(links.length * 8)
    this.nodePosData = new Float32Array(nodes.length * 2)
    this.nodeSizeData = new Float32Array(nodes.length)
    this.nodeCountData = new Float32Array(nodes.length)
    this.nodeColorData = Array.from({ length: MAX_PIE }, () => new Float32Array(nodes.length * 4))
    nodes.forEach((n, i) => (this.nodeSizeData[i] = n.radius))

    this.simulation.nodes(nodes)
    this.simulation.force(
      'link',
      forceLink<SimNode, SimLink>(links)
        .id((d) => d.id)
        .distance(40)
    )
    this.applyAreaLayout()
    this.simulation.alpha(first ? 1 : 0.4)
    this.fitPending = first
    this.colorsDirty = true
    this.requestRender()
  }

  setPalette(palette: GraphPalette): void {
    this.palette = palette
    this.colorsDirty = true
    this.requestRender()
  }

  setGroupHues(hues: Map<string, number>): void {
    this.hues = hues
    this.colorsDirty = true
    this.requestRender()
  }

  setAreaHues(hues: Map<string, number>): void {
    this.areaHues = hues
    this.colorsDirty = true
    this.requestRender()
  }

  /** Switch between the folder-colored layout and the "group by area" layout; the graph rearranges itself. */
  setAreaMode(on: boolean): void {
    if (this.areaMode === on) return
    this.areaMode = on
    this.applyAreaLayout()
    if (this.nodes.length > 0) {
      this.simulation.alpha(Math.max(this.simulation.alpha(), 0.9))
      this.fitPending = true
    }
    this.colorsDirty = true
    this.requestRender()
  }

  /** Highlight one area and dim everything else (area view only); null clears it. */
  setFocusArea(area: string | null): void {
    if (this.focusArea === area) return
    this.focusArea = area
    this.colorsDirty = true
    this.requestRender()
  }

  setActive(id: string | null): void {
    if (this.activeId === id) return
    this.activeId = id
    this.colorsDirty = true
    this.requestRender()
  }

  /** Graph coordinates -> CSS pixels inside the host (used by the smoke harness). */
  toScreen(x: number, y: number): { x: number; y: number } {
    return { x: x * this.transform.k + this.transform.x, y: y * this.transform.k + this.transform.y }
  }

  getNodes(): readonly SimNode[] {
    return this.nodes
  }

  /** Internal state for the smoke harness. */
  debug(): {
    alpha: number
    frames: number
    scheduled: boolean
    transform: { k: number; x: number; y: number }
    hover: string | null
    dragging: string | null
    gl: boolean
    areaMode: boolean
    focusArea: string | null
    dimmed: number
    regions: Region[]
  } {
    return {
      alpha: this.simulation.alpha(),
      frames: this.frames,
      scheduled: this.frame !== null,
      transform: { k: this.transform.k, x: this.transform.x, y: this.transform.y },
      hover: this.hoverId,
      dragging: this.dragging?.id ?? null,
      gl: this.glState !== null,
      areaMode: this.areaMode,
      focusArea: this.focusArea,
      dimmed: this.dimmedCount,
      regions: this.regions.map((r) => ({ ...r }))
    }
  }

  zoomToFit(padding = 40): void {
    if (this.nodes.length === 0) return
    let minX = Infinity
    let minY = Infinity
    let maxX = -Infinity
    let maxY = -Infinity
    for (const n of this.nodes) {
      minX = Math.min(minX, n.x ?? 0)
      maxX = Math.max(maxX, n.x ?? 0)
      minY = Math.min(minY, n.y ?? 0)
      maxY = Math.max(maxY, n.y ?? 0)
    }
    const w = Math.max(maxX - minX, 1)
    const h = Math.max(maxY - minY, 1)
    const k = Math.max(0.05, Math.min(10, Math.min((this.width - padding * 2) / w, (this.height - padding * 2) / h)))
    const tx = this.width / 2 - ((minX + maxX) / 2) * k
    const ty = this.height / 2 - ((minY + maxY) / 2) * k
    select(this.canvas).call(this.zoomBehavior.transform, zoomIdentity.translate(tx, ty).scale(k))
  }

  destroy(): void {
    this.destroyed = true
    if (this.frame !== null) cancelAnimationFrame(this.frame)
    this.ro.disconnect()
    this.simulation.stop()
    select(this.canvas).on('.zoom', null)
    this.canvas.removeEventListener('mousemove', this.onMouseMove)
    this.canvas.removeEventListener('mouseleave', this.onMouseLeave)
    this.canvas.removeEventListener('mousedown', this.onMouseDown)
    window.removeEventListener('mousemove', this.onDragMove)
    window.removeEventListener('mouseup', this.onDragEnd)
    this.canvas.removeEventListener('webglcontextlost', this.onLost)
    this.canvas.removeEventListener('webglcontextrestored', this.onRestored)
    const gl = this.glState?.gl
    gl?.getExtension('WEBGL_lose_context')?.loseContext()
    this.canvas.remove()
    this.labels.remove()
  }

  // ---- internals ----

  private initGL(): void {
    const gl = this.canvas.getContext('webgl', { antialias: true, premultipliedAlpha: true, alpha: true })
    if (!gl) {
      this.glState = null
      return
    }
    const linkProg = program(gl, LINK_VS, LINK_FS)
    const nodeProg = program(gl, NODE_VS, NODE_FS)
    gl.enable(gl.BLEND)
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA)
    gl.clearColor(0, 0, 0, 0)
    this.glState = {
      gl,
      linkProg,
      nodeProg,
      regionPos: gl.createBuffer()!,
      regionColor: gl.createBuffer()!,
      linkPos: gl.createBuffer()!,
      linkColor: gl.createBuffer()!,
      nodePos: gl.createBuffer()!,
      nodeSize: gl.createBuffer()!,
      nodeCount: gl.createBuffer()!,
      nodeColor: Array.from({ length: MAX_PIE }, () => gl.createBuffer()!)
    }
  }

  /** Anchors, per-node targets and link strengths for the current data and mode. */
  private applyAreaLayout(): void {
    const on = this.areaMode
    const ordered = on
      ? orderAreas(
          this.nodes,
          this.links.map((l) => ({ source: (l.source as SimNode).id, target: (l.target as SimNode).id }))
        )
      : []
    const anchors = areaAnchors(ordered, this.nodes.length)
    this.targets = this.nodes.map((n) => {
      if (!on || n.areas.length === 0) return null
      let x = 0
      let y = 0
      let count = 0
      for (const a of n.areas) {
        const p = anchors.get(a)
        if (!p) continue
        x += p.x
        y += p.y
        count++
      }
      return count === 0 ? null : { x: x / count, y: y / count }
    })
    // d3's default link strength, weakened in area view for links that cross departments.
    const degree = (n: SimNode): number => this.adjacency.get(n.id)?.links.size ?? 1
    const link = this.simulation.force('link') as unknown as ForceLink<SimNode, SimLink> | undefined
    link?.strength((l) => {
      const s = l.source as SimNode
      const t = l.target as SimNode
      const base = 1 / Math.max(1, Math.min(degree(s), degree(t)))
      if (!on || s.areas.length === 0 || t.areas.length === 0) return base
      return s.areas.some((a) => t.areas.includes(a)) ? base : base * CROSS_AREA_LINK
    })
  }

  private resize(): void {
    const rect = this.host.getBoundingClientRect()
    this.width = Math.max(1, rect.width)
    this.height = Math.max(1, rect.height)
    this.dpr = window.devicePixelRatio || 1
    for (const c of [this.canvas, this.labels]) {
      c.width = Math.round(this.width * this.dpr)
      c.height = Math.round(this.height * this.dpr)
      c.style.width = `${this.width}px`
      c.style.height = `${this.height}px`
    }
    this.requestRender()
  }

  private requestRender(): void {
    this.dirty = true
    if (this.frame === null && !this.destroyed) this.frame = requestAnimationFrame(this.loop)
  }

  private readonly loop = (): void => {
    this.frame = null
    if (this.destroyed) return
    // With an ambient alphaTarget the simulation never cools below alphaMin, so this keeps ticking
    // (and drifting) for as long as the graph is on screen; rAF pauses it when the window is hidden.
    const running = this.nodes.length > 0 && this.simulation.alpha() > this.simulation.alphaMin()
    if (running) {
      this.simulation.tick()
      this.dirty = true
      if (this.fitPending && this.simulation.alpha() < FIT_ALPHA) {
        this.fitPending = false
        this.zoomToFit()
      }
    }
    if (this.dirty) {
      this.dirty = false
      this.frames++
      this.draw()
    }
    if (running || this.dirty) this.frame = requestAnimationFrame(this.loop)
  }

  private refreshColors(): void {
    const p = this.palette
    const accent = cssToRgba(p.accent)
    const neutral = cssToRgba(p.node)
    const faint = cssToRgba(p.unresolved)
    const linkBase = cssToRgba(p.link)
    const lightness = p.dark ? 0.64 : 0.42
    const areaRgb = new Map<string, RGBA>()
    for (const [name, hue] of this.areaHues) areaRgb.set(name, hslToRgba(hue, 0.62, lightness))
    const areaColor = (name: string, a: number): RGBA => fade(areaRgb.get(name) ?? neutral, a)

    const hover = this.hoverId ? this.adjacency.get(this.hoverId) : undefined
    const hovering = this.hoverId !== null
    const areaMode = this.areaMode
    const focus = areaMode ? this.focusArea : null

    const linkAccent = fade(accent, 0.95)
    const linkPlain = fade(linkBase, hovering ? 0.12 : 0.8)
    const linkCross = fade(linkBase, 0.22)
    const linkOutside = fade(linkBase, 0.05)
    this.links.forEach((l, i) => {
      let c: RGBA
      if (hover?.links.has(l)) c = linkAccent
      else if (hovering || !areaMode) c = linkPlain
      else {
        const s = l.source as SimNode
        const t = l.target as SimNode
        if (focus !== null) c = s.areas.includes(focus) && t.areas.includes(focus) ? areaColor(focus, 0.7) : linkOutside
        else {
          const shared = s.areas.find((a) => t.areas.includes(a))
          c = shared === undefined ? linkCross : areaColor(shared, 0.45)
        }
      }
      const o = i * 8
      this.linkColorData.set(c, o)
      this.linkColorData.set(c, o + 4)
    })

    let dimmedCount = 0
    this.nodes.forEach((n, i) => {
      const related = hovering && (n.id === this.hoverId || (hover?.neighbors.has(n.id) ?? false))
      const dimmed = hovering ? !related : focus !== null && !n.areas.includes(focus)
      if (dimmed) dimmedCount++
      let colors: RGBA[]
      if (n.id === this.activeId || related) colors = [accent]
      else if (n.unresolved) colors = [fade(faint, dimmed ? 0.15 : 0.55)]
      else if (areaMode) {
        colors =
          n.areas.length === 0
            ? [fade(neutral, dimmed ? 0.12 : 0.45)]
            : n.areas.slice(0, MAX_PIE).map((a) => areaColor(a, dimmed ? 0.12 : 1))
      } else {
        const hue = this.hues.get(n.group)
        const alpha = dimmed ? 0.2 : 1
        colors = [hue === undefined ? fade(neutral, alpha) : hslToRgba(hue, 0.62, lightness, alpha)]
      }
      this.nodeCountData[i] = colors.length
      for (let slot = 0; slot < MAX_PIE; slot++) this.nodeColorData[slot].set(colors[slot] ?? colors[0], i * 4)
    })

    this.dimmedCount = dimmedCount
    this.areaRgb = areaRgb
    this.focusMembers = focus === null ? [] : this.nodes.filter((n) => n.areas.includes(focus)).sort((a, b) => b.degree - a.degree)
    this.colorsDirty = false
  }

  /** Centre and size of every area, from where its notes currently are. */
  private updateRegions(): void {
    if (!this.areaMode) {
      this.regions = []
      return
    }
    const acc = new Map<string, { x: number; y: number; w: number; sq: number; members: number }>()
    for (const n of this.nodes) {
      if (n.areas.length === 0) continue
      const w = 1 / n.areas.length // a note shared by several areas counts less in each
      for (const a of n.areas) {
        let r = acc.get(a)
        if (!r) acc.set(a, (r = { x: 0, y: 0, w: 0, sq: 0, members: 0 }))
        r.x += (n.x ?? 0) * w
        r.y += (n.y ?? 0) * w
        r.w += w
        r.members++
      }
    }
    for (const r of acc.values()) {
      r.x /= r.w
      r.y /= r.w
    }
    for (const n of this.nodes) {
      if (n.areas.length === 0) continue
      const w = 1 / n.areas.length
      for (const a of n.areas) {
        const r = acc.get(a)!
        const dx = (n.x ?? 0) - r.x
        const dy = (n.y ?? 0) - r.y
        r.sq += (dx * dx + dy * dy) * w
      }
    }
    this.regions = [...acc.entries()].map(([name, r]) => ({
      name,
      x: r.x,
      y: r.y,
      r: Math.max(REGION_MIN_RADIUS, 1.5 * Math.sqrt(r.sq / r.w) + REGION_PADDING),
      members: r.members
    }))
  }

  /** Soft discs behind the areas: an evenly shaded core and a rim that fades to nothing. Returns the vertex count. */
  private fillRegions(): number {
    const count = this.regions.length * REGION_SEGMENTS * 9
    if (this.regionPosData.length !== count * 2) {
      this.regionPosData = new Float32Array(count * 2)
      this.regionColorData = new Float32Array(count * 4)
    }
    const pos = this.regionPosData
    const col = this.regionColorData
    const focus = this.focusArea
    const base = this.palette.dark ? 0.15 : 0.12
    let v = 0
    const put = (x: number, y: number, c: RGBA, a: number): void => {
      pos[v * 2] = x
      pos[v * 2 + 1] = y
      col[v * 4] = c[0]
      col[v * 4 + 1] = c[1]
      col[v * 4 + 2] = c[2]
      col[v * 4 + 3] = a
      v++
    }
    for (const region of this.regions) {
      const c: RGBA = this.areaRgb.get(region.name) ?? [0.5, 0.5, 0.5, 1]
      const a = focus === null ? base : region.name === focus ? base * 1.7 : base * 0.3
      const inner = region.r * REGION_CORE
      for (let i = 0; i < REGION_SEGMENTS; i++) {
        const [c0, s0] = UNIT_CIRCLE[i]
        const [c1, s1] = UNIT_CIRCLE[i + 1]
        const ix0 = region.x + c0 * inner
        const iy0 = region.y + s0 * inner
        const ix1 = region.x + c1 * inner
        const iy1 = region.y + s1 * inner
        const ox0 = region.x + c0 * region.r
        const oy0 = region.y + s0 * region.r
        const ox1 = region.x + c1 * region.r
        const oy1 = region.y + s1 * region.r
        put(region.x, region.y, c, a)
        put(ix0, iy0, c, a)
        put(ix1, iy1, c, a)
        put(ix0, iy0, c, a)
        put(ox0, oy0, c, 0)
        put(ox1, oy1, c, 0)
        put(ix0, iy0, c, a)
        put(ox1, oy1, c, 0)
        put(ix1, iy1, c, a)
      }
    }
    return count
  }

  private draw(): void {
    const s = this.glState
    if (!s) return
    const { gl } = s
    if (this.colorsDirty) this.refreshColors()
    this.updateRegions()
    const regionVertices = this.regions.length > 0 ? this.fillRegions() : 0
    this.links.forEach((l, i) => {
      const a = l.source as SimNode
      const b = l.target as SimNode
      const o = i * 4
      this.linkPosData[o] = a.x ?? 0
      this.linkPosData[o + 1] = a.y ?? 0
      this.linkPosData[o + 2] = b.x ?? 0
      this.linkPosData[o + 3] = b.y ?? 0
    })
    this.nodes.forEach((n, i) => {
      this.nodePosData[i * 2] = n.x ?? 0
      this.nodePosData[i * 2 + 1] = n.y ?? 0
    })

    gl.viewport(0, 0, this.canvas.width, this.canvas.height)
    gl.clear(gl.COLOR_BUFFER_BIT)
    const { k, x: tx, y: ty } = this.transform

    // area regions, then links (same shader: position + color)
    gl.useProgram(s.linkProg)
    gl.uniform2f(gl.getUniformLocation(s.linkProg, 'u_res'), this.canvas.width, this.canvas.height)
    gl.uniform1f(gl.getUniformLocation(s.linkProg, 'u_k'), k)
    gl.uniform2f(gl.getUniformLocation(s.linkProg, 'u_t'), tx, ty)
    gl.uniform1f(gl.getUniformLocation(s.linkProg, 'u_dpr'), this.dpr)
    if (regionVertices > 0) {
      this.bindAttr(s.linkProg, 'a_pos', s.regionPos, this.regionPosData, 2)
      this.bindAttr(s.linkProg, 'a_color', s.regionColor, this.regionColorData, 4)
      gl.drawArrays(gl.TRIANGLES, 0, regionVertices)
    }
    this.bindAttr(s.linkProg, 'a_pos', s.linkPos, this.linkPosData, 2)
    this.bindAttr(s.linkProg, 'a_color', s.linkColor, this.linkColorData, 4)
    gl.drawArrays(gl.LINES, 0, this.links.length * 2)

    // nodes
    gl.useProgram(s.nodeProg)
    gl.uniform2f(gl.getUniformLocation(s.nodeProg, 'u_res'), this.canvas.width, this.canvas.height)
    gl.uniform1f(gl.getUniformLocation(s.nodeProg, 'u_k'), k)
    gl.uniform2f(gl.getUniformLocation(s.nodeProg, 'u_t'), tx, ty)
    gl.uniform1f(gl.getUniformLocation(s.nodeProg, 'u_dpr'), this.dpr)
    gl.uniform1f(gl.getUniformLocation(s.nodeProg, 'u_minPx'), MIN_NODE_PX * this.dpr)
    gl.uniform1f(gl.getUniformLocation(s.nodeProg, 'u_maxPx'), MAX_POINT_PX)
    this.bindAttr(s.nodeProg, 'a_pos', s.nodePos, this.nodePosData, 2)
    this.bindAttr(s.nodeProg, 'a_size', s.nodeSize, this.nodeSizeData, 1)
    this.bindAttr(s.nodeProg, 'a_n', s.nodeCount, this.nodeCountData, 1)
    for (let slot = 0; slot < MAX_PIE; slot++) this.bindAttr(s.nodeProg, `a_c${slot}`, s.nodeColor[slot], this.nodeColorData[slot], 4)
    gl.drawArrays(gl.POINTS, 0, this.nodes.length)

    this.drawLabels()
  }

  private bindAttr(prog: WebGLProgram, name: string, buffer: WebGLBuffer, data: Float32Array, size: number): void {
    const gl = this.glState!.gl
    const loc = gl.getAttribLocation(prog, name)
    if (loc < 0) return
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer)
    gl.bufferData(gl.ARRAY_BUFFER, data, gl.DYNAMIC_DRAW)
    gl.enableVertexAttribArray(loc)
    gl.vertexAttribPointer(loc, size, gl.FLOAT, false, 0, 0)
  }

  private drawLabels(): void {
    const ctx = this.labelCtx
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0)
    ctx.clearRect(0, 0, this.width, this.height)
    const { k } = this.transform
    const focus = this.areaMode ? this.focusArea : null

    // Department names sit on top of their region.
    if (this.regions.length > 0) {
      ctx.font = `600 13px ${this.palette.font}`
      ctx.textAlign = 'center'
      ctx.textBaseline = 'bottom'
      ctx.lineJoin = 'round'
      ctx.lineWidth = 3
      ctx.strokeStyle = this.palette.bg
      for (const region of this.regions) {
        const p = this.toScreen(region.x, region.y - region.r * REGION_CORE)
        if (p.x < -80 || p.y < -20 || p.x > this.width + 80 || p.y > this.height + 20) continue
        const hue = this.areaHues.get(region.name)
        ctx.fillStyle = hue === undefined ? this.palette.label : `hsl(${Math.round(hue)}, 62%, ${this.palette.dark ? 72 : 36}%)`
        ctx.globalAlpha = focus === null || focus === region.name ? 0.95 : 0.3
        ctx.strokeText(region.name, p.x, p.y - 4)
        ctx.fillText(region.name, p.x, p.y - 4)
      }
      ctx.globalAlpha = 1
    }

    const hover = this.hoverId ? this.adjacency.get(this.hoverId) : undefined
    const active = this.activeId ? this.byId.get(this.activeId) : undefined
    let candidates: SimNode[]
    // A highlighted area names its notes, best connected first, skipping labels that would overlap.
    let declutter = false
    if (this.hoverId !== null) {
      candidates = this.nodes.filter((n) => n.id === this.activeId || n.id === this.hoverId || (hover?.neighbors.has(n.id) ?? false))
    } else if (focus !== null) {
      const members = k > LABEL_ZOOM ? this.focusMembers : this.focusMembers.slice(0, FOCUS_LABELS)
      candidates = active && !members.includes(active) ? [active, ...members] : members
      declutter = true
    } else if (k > LABEL_ZOOM) {
      candidates = this.nodes
    } else {
      candidates = active ? [active] : []
    }
    if (candidates.length === 0) return
    const fontPx = Math.max(11, Math.min(14, 11 * Math.sqrt(k)))
    ctx.font = `${fontPx}px ${this.palette.font}`
    ctx.textAlign = 'center'
    ctx.textBaseline = 'top'
    ctx.fillStyle = this.palette.label
    // Labels of a highlighted area often sit on top of its own notes: outline them against the background.
    ctx.lineJoin = 'round'
    ctx.lineWidth = 3
    ctx.strokeStyle = this.palette.bg
    const placed: { x0: number; y0: number; x1: number; y1: number }[] = []
    let drawn = 0
    for (const n of candidates) {
      const p = this.toScreen(n.x ?? 0, n.y ?? 0)
      if (p.x < -50 || p.y < -20 || p.x > this.width + 50 || p.y > this.height + 20) continue
      const r = Math.max(MIN_NODE_PX / 2, n.radius * k)
      if (declutter) {
        const half = ctx.measureText(n.label).width / 2 + 4
        const box = { x0: p.x - half, y0: p.y + r + 1, x1: p.x + half, y1: p.y + r + fontPx + 6 }
        if (placed.some((b) => box.x0 < b.x1 && box.x1 > b.x0 && box.y0 < b.y1 && box.y1 > b.y0)) continue
        placed.push(box)
      }
      ctx.globalAlpha = n.unresolved ? 0.6 : 1
      if (declutter) ctx.strokeText(n.label, p.x, p.y + r + 3)
      ctx.fillText(n.label, p.x, p.y + r + 3)
      if (++drawn >= MAX_LABELS) break
    }
    ctx.globalAlpha = 1
  }

  private nodeAt(cssX: number, cssY: number): SimNode | null {
    const { k, x: tx, y: ty } = this.transform
    const gx = (cssX - tx) / k
    const gy = (cssY - ty) / k
    let best: SimNode | null = null
    let bestD = Infinity
    for (const n of this.nodes) {
      const dx = (n.x ?? 0) - gx
      const dy = (n.y ?? 0) - gy
      const d = dx * dx + dy * dy
      const hit = Math.max(n.radius, (MIN_NODE_PX / 2) / k) + 3 / k
      if (d <= hit * hit && d < bestD) {
        bestD = d
        best = n
      }
    }
    return best
  }

  private localPoint(e: MouseEvent): { x: number; y: number } {
    const rect = this.canvas.getBoundingClientRect()
    return { x: e.clientX - rect.left, y: e.clientY - rect.top }
  }

  private readonly onMouseMove = (e: MouseEvent): void => {
    const p = this.localPoint(e)
    const n = this.nodeAt(p.x, p.y)
    const id = n?.id ?? null
    this.canvas.style.cursor = id ? 'pointer' : 'default'
    if (id !== this.hoverId) {
      this.hoverId = id
      this.colorsDirty = true
      this.requestRender()
    }
  }

  private readonly onMouseLeave = (): void => {
    if (this.hoverId !== null) {
      this.hoverId = null
      this.colorsDirty = true
      this.requestRender()
    }
  }

  private toGraph(cssX: number, cssY: number): { x: number; y: number } {
    const { k, x: tx, y: ty } = this.transform
    return { x: (cssX - tx) / k, y: (cssY - ty) / k }
  }

  /** Press on a node: pin it to the pointer and heat the layout so its neighbourhood follows. */
  private readonly onMouseDown = (e: MouseEvent): void => {
    if (e.button !== 0) return
    const p = this.localPoint(e)
    const n = this.nodeAt(p.x, p.y)
    if (!n) return
    e.preventDefault()
    this.pressAt = p
    this.dragging = n
    this.dragMoved = false
    n.fx = n.x
    n.fy = n.y
    this.canvas.style.cursor = 'grabbing'
    window.addEventListener('mousemove', this.onDragMove)
    window.addEventListener('mouseup', this.onDragEnd)
  }

  private readonly onDragMove = (e: MouseEvent): void => {
    const n = this.dragging
    if (!n) return
    const p = this.localPoint(e)
    if (this.pressAt && Math.hypot(p.x - this.pressAt.x, p.y - this.pressAt.y) > CLICK_SLOP_PX && !this.dragMoved) {
      this.dragMoved = true
      this.simulation.alphaTarget(DRAG_ALPHA)
      if (this.simulation.alpha() < DRAG_ALPHA) this.simulation.alpha(DRAG_ALPHA)
    }
    const g = this.toGraph(p.x, p.y)
    n.fx = g.x
    n.fy = g.y
    this.requestRender()
  }

  private readonly onDragEnd = (): void => {
    const n = this.dragging
    window.removeEventListener('mousemove', this.onDragMove)
    window.removeEventListener('mouseup', this.onDragEnd)
    this.dragging = null
    this.pressAt = null
    if (!n) return
    n.fx = null
    n.fy = null
    this.simulation.alphaTarget(AMBIENT_ALPHA)
    this.canvas.style.cursor = this.hoverId ? 'pointer' : 'default'
    if (!this.dragMoved) this.handlers.onNodeClick(n.id) // a press without movement is a click
    this.requestRender()
  }
}
