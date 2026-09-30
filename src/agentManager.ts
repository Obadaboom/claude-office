/**
 * agentManager.ts
 *
 * Agent lifecycle helpers for the Agent Office visualiser.
 *
 * Lifecycle (2c, per session):
 *   11 regulars sit at their desks all day. session_changed binds a live session to
 *   REGULARS[seat] (typing while busy, else idle); past 11 sessions an overflow walker
 *   walks in from the door, and out on `back`. Agents get no person (chat only).
 *   Nothing moves on its own: only overflow walkers and the boss on a click.
 *
 * Movement:
 *   Positions are percentages (0-100) of the room. Agents walk straight lines
 *   between waypoints of the room's aisle graph (rooms.ts), which keeps them off
 *   desks and plants. Sprite direction: see Character.tsx getDirectionFromDelta.
 */

import { Agent, AgentState, Position, SessionView } from './types'
import { AgentSpot, FurnitureItem, Waypoint } from './rooms'
import { ASSETS } from './assets'

// ---------------------------------------------------------------------------
// Spot assignment
// ---------------------------------------------------------------------------

/**
 * First free desk; once desks are full, the least-used overflow spot, so
 * nobody is dropped. ponytail: past 8 overflow agents share spots.
 */
export function assignSpot(
  agents: Agent[],
  spots: AgentSpot[],
): AgentSpot | null {
  const taken = agents.map(a => a.assignedSpotId)
  const desk = spots.find(s => s.type === 'desk' && !taken.includes(s.id))
  if (desk) return desk
  const uses = (s: AgentSpot) => taken.filter(id => id === s.id).length
  return spots.filter(s => s.type === 'overflow')
    .reduce<AgentSpot | null>((best, s) => (!best || uses(s) < uses(best) ? s : best), null)
}

// ---------------------------------------------------------------------------
// Movement / direction
// ---------------------------------------------------------------------------

/**
 * Move an agent one step toward its targetPosition.
 *
 * @param position      Current position
 * @param targetPosition Where we want to go
 * @param speed         Maximum distance to move this frame (in %-units)
 * @returns             New position and whether we have arrived
 */
export function stepToward(
  position: Position,
  targetPosition: Position,
  speed: number,
): { position: Position; arrived: boolean } {
  const dx = targetPosition.x - position.x
  const dy = targetPosition.y - position.y
  const dist = Math.sqrt(dx * dx + dy * dy)

  if (dist <= speed) {
    return { position: { ...targetPosition }, arrived: true }
  }

  return {
    position: {
      x: position.x + (dx / dist) * speed,
      y: position.y + (dy / dist) * speed,
    },
    arrived: false,
  }
}

// ---------------------------------------------------------------------------
// Waypoint pathfinding
// ---------------------------------------------------------------------------

/**
 * Find the nearest waypoint to a given (x, y) position.
 */
function nearestWaypoint(x: number, y: number, waypoints: Waypoint[]): Waypoint {
  let best = waypoints[0]
  let bestDist = Infinity
  for (const wp of waypoints) {
    const dx = wp.x - x
    const dy = wp.y - y
    const d = dx * dx + dy * dy
    if (d < bestDist) {
      bestDist = d
      best = wp
    }
  }
  return best
}

/**
 * BFS through the waypoint graph (fewest hops) from startId to endId.
 * Edges are two-way: data lists each edge once. Returns null if no path.
 */
function bfsWaypoints(startId: string, endId: string, waypoints: Waypoint[]): string[] | null {
  const adj = new Map<string, string[]>(waypoints.map(w => [w.id, []]))
  for (const w of waypoints) for (const c of w.connections) {
    adj.get(w.id)?.push(c)
    adj.get(c)?.push(w.id)
  }
  const prev = new Map<string, string | null>([[startId, null]])
  const queue = [startId]
  while (queue.length > 0) {
    const id = queue.shift()!
    if (id === endId) {
      const path: string[] = []
      for (let at: string | null = id; at !== null; at = prev.get(at)!) path.unshift(at)
      return path
    }
    for (const n of adj.get(id) ?? []) if (!prev.has(n)) { prev.set(n, id); queue.push(n) }
  }
  return null
}

/**
 * Waypoint positions to walk through from (fromX, fromY) to (toX, toY):
 * nearest waypoint to the start, then the graph route to the waypoint nearest
 * the target. The caller walks on to targetPosition when the queue is empty.
 */
export function findWaypointPath(
  fromX: number,
  fromY: number,
  toX: number,
  toY: number,
  waypoints: Waypoint[],
): { x: number; y: number }[] {
  if (waypoints.length === 0) return []

  const startWp = nearestWaypoint(fromX, fromY, waypoints)
  const endWp   = nearestWaypoint(toX, toY, waypoints)

  const ids = bfsWaypoints(startWp.id, endWp.id, waypoints)
  if (!ids) return [{ x: startWp.x, y: startWp.y }]

  const byId = new Map<string, Waypoint>(waypoints.map(w => [w.id, w]))
  return ids.map(id => {
    const wp = byId.get(id)!
    return { x: wp.x, y: wp.y }
  })
}

/** Waypoints to walk from -> to. The leg to the target itself is walked as the final approach. */
export function planPath(from: Position, to: Position, waypoints: Waypoint[]): Position[] {
  const path = findWaypointPath(from.x, from.y, to.x, to.y, waypoints)
  const last = path[path.length - 1]
  if (last && last.x === to.x && last.y === to.y) path.pop()
  return path
}

/**
 * Send a walker somewhere new (boss clicks). A leaving agent is
 * never pulled back. The new path starts where the walker is heading next,
 * a point it reaches in a clear line, not at the nearest node across a desk.
 */
export function redirect(a: Agent, target: Position, waypoints: Waypoint[]): Agent {
  if (a.state === 'completed') return a
  return {
    ...a,
    state: 'walking-to-desk',
    targetPosition: { ...target },
    pathQueue: planPath(a.pathQueue?.[0] ?? a.targetPosition, target, waypoints),
  }
}

const WALKING: ReadonlySet<AgentState> = new Set<AgentState>(['new-hire', 'walking-to-desk', 'walking-to-manager', 'coffee-break', 'completed'])

/** Seated at its desk (spot z applies): not walking, nothing queued, on the desk point. */
export function seatedAtDesk(a: Agent): boolean {
  return !WALKING.has(a.state) && !a.pathQueue?.length &&
    a.position.x === a.deskPosition.x && a.position.y === a.deskPosition.y
}

// ---------------------------------------------------------------------------
// Floor hulls + isometric depth
// ---------------------------------------------------------------------------

// The floor under each piece, as fractions of its sprite box. Desk = between
// the outer ends of both T-feet (foot tips included); mirrored for right desks.
const DESK_HULL: [number, number][] = [[0.02, 0.84], [0.64, 0.60], [0.97, 0.75], [0.36, 0.99]]
const box = (a: number, b: number, c: number, d: number): [number, number][] => [[a, b], [c, b], [c, d], [a, d]]
const HULLS: Record<string, [number, number][]> = {
  'filing-cabinet': box(0.1, 0.75, 0.9, 0.99),
  'coffee-machine': box(0.15, 0.7, 0.85, 0.97),
  'plant-monstera': box(0.3, 0.8, 0.7, 0.98),
  'plant-snake': box(0.3, 0.8, 0.7, 0.98),
  'plant-money': box(0.3, 0.8, 0.7, 0.98),
  'printer': box(0.2, 0.65, 0.8, 0.95),
  // 2r: Pam's counter in front of her seat (front run + both raised sides), art kit reception.py
  'desk-standing-reception': [[0.276, 0.582], [0.022, 0.715], [0.545, 0.976], [0.798, 0.843]],
}

export interface FloorHull { id: string; desk: boolean; x: number; y: number; w: number; h: number; z: number; poly: Position[]; reach: [number, number] }

// Half a walker sprite's width (px): feet this far beside a sprite box still overlap it.
const WALKER_HALF_W = 16

/** Floor hulls in room % for a room rendered at roomPx (sprites have fixed px sizes). */
export function floorHulls(furniture: FurnitureItem[], roomPx: { w: number; h: number }): FloorHull[] {
  return furniture.flatMap(f => {
    const desk = f.type === 'desk-standing'
    const frac = HULLS[f.sprite] ?? (desk ? DESK_HULL.map(([x, y]) => [f.sprite.includes('right') ? 1 - x : x, y]) : HULLS[f.type])
    const asset = ASSETS[f.sprite]
    if (!frac || !asset) return []
    const w = asset.width / roomPx.w * 100, h = asset.height / roomPx.h * 100
    const x0 = f.x - w / 2, y0 = f.y - h, pad = WALKER_HALF_W / roomPx.w * 100
    return [{ id: f.id, desk, x: f.x, y: f.y, w, h, z: f.zIndex ?? Math.round(f.y * 10),
      poly: frac.map(([fx, fy]) => ({ x: x0 + fx * w, y: y0 + fy * h })), reach: [x0 - pad, x0 + w + pad] as [number, number] }]
  })
}

/**
 * Back and front edge y of a hull at x. Beside an end tip, the two edges that
 * meet at that tip, extended.
 */
export function edgesAt(poly: Position[], x: number): [number, number] {
  const xs = poly.map(p => p.x), lo = Math.min(...xs), hi = Math.max(...xs)
  const tip = x < lo ? lo : x > hi ? hi : null
  const ys: number[] = []
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[j], b = poly[i]
    if (a.x === b.x) continue
    if (tip === null ? x >= Math.min(a.x, b.x) && x <= Math.max(a.x, b.x) : a.x === tip || b.x === tip)
      ys.push(a.y + (b.y - a.y) * (x - a.x) / (b.x - a.x))
  }
  return [Math.min(...ys), Math.max(...ys)]
}

/**
 * Painter z for feet at (x, y): feet-y, except a walker in front of a desk's
 * front edge (at its x, extended beside the ends) is drawn over that desk even
 * while its feet are still above the desk's bottom corner.
 */
export function feetZ(x: number, y: number, hulls: FloorHull[]): number {
  return Math.max(Math.round(y * 10), deskFloor(x, y, hulls))
}

/** Just over every desk the feet at (x, y) are in front of (its front edge at x, extended beside the ends) */
function deskFloor(x: number, y: number, hulls: FloorHull[]): number {
  let z = -Infinity
  for (const h of hulls) if (h.desk && x >= h.reach[0] && x <= h.reach[1] && y > edgesAt(h.poly, x)[1]) z = Math.max(z, h.z + 1)
  return z
}

// A character's sprite box (px): cast sprites are ~29 wide, the boss 85 tall
const CHAR_PX = { w: 29, h: 85 }

/**
 * Painter z for a walker (anyone not seated): feetZ, then over each seated
 * character its sprite overlaps when its feet are in front, under it otherwise.
 * Seated characters draw at spot z, which feet-y order alone gets wrong.
 * ponytail: where no z satisfies both, a desk the walker is in front of wins over a seated person behind it.
 */
export function walkerZ(p: Position, hulls: FloorHull[], seated: { x: number; y: number; z: number }[], roomPx: { w: number; h: number }): number {
  let z = feetZ(p.x, p.y, hulls)
  const w = CHAR_PX.w / roomPx.w * 100, h = CHAR_PX.h / roomPx.h * 100
  for (const s of seated) {
    if (Math.abs(p.x - s.x) >= w || Math.abs(p.y - s.y) >= h) continue
    z = p.y > s.y ? Math.max(z, s.z + 1) : Math.min(z, s.z - 1)
  }
  return Math.max(z, deskFloor(p.x, p.y, hulls))
}

/** Walking speed in %-units per frame at 60fps */
export const WALK_SPEED = 0.16

/** Chat dedup key: the server row id. Parallel agents post identical text in the same ms. */
export function chatKey(e: { id?: unknown; agentId?: string; timestamp?: number; text?: string }): string {
  return e.id != null ? `id:${e.id}` : `${e.agentId ?? ''}:${e.timestamp ?? 0}:${e.text ?? ''}`
}

// ---------------------------------------------------------------------------
// Agent creation helper
// ---------------------------------------------------------------------------

import { AGENT_CONFIGS } from './types'
import { ROOMS } from './rooms'
import { REGULARS, pinCast, slugToName } from './theme'
import { BOSS_ROLE, BOSS_NAME } from './config'

export function createAgent(partial: {
  id: string
  name: string
  role: string
  task?: string
  spot: AgentSpot
}): Agent {
  const cfg = AGENT_CONFIGS[partial.role] ?? AGENT_CONFIGS['default']
  const entry = ROOMS['main-office'].entryPoint

  return {
    id: partial.id,
    name: partial.name,
    type: 'subagent',
    role: partial.role,
    state: 'new-hire',
    position: { x: entry.x, y: entry.y },
    targetPosition: { x: partial.spot.x, y: partial.spot.y },
    deskPosition: { x: partial.spot.x, y: partial.spot.y },
    room: 'main-office',
    assignedRoom: 'main-office',
    assignedSpotId: partial.spot.id,
    spriteFacing: partial.spot.spriteFacing,
    task: partial.task,
    statusText: '',
    color: cfg.color,
    emoji: cfg.emoji,
    hiredAt: Date.now(),
  }
}

// ---------------------------------------------------------------------------
// Fixed team (2c): 11 regulars seated all day; one per live session (its server seat)
// ---------------------------------------------------------------------------

const MAIN = ROOMS['main-office']
export const BOSS_ID = `boss-${BOSS_NAME.toLowerCase()}`
const regularId = (slug: string) => `regular-${slug}`
/** 2p: the show's seating. Jim (rear, faces the camera) faces Dwight across 2a/2b, Andy beside them; Stanley faces Phyllis; accounting pod 7-9. */
export const SEATS: Record<string, string> = {
  'jim-halpert': 'spot-3', 'dwight-schrute': 'spot-2', 'andy-bernard': 'spot-1', 'stanley-hudson': 'spot-6', 'phyllis-vance': 'spot-5',
  'creed-bratton': 'spot-4', 'kevin-malone': 'spot-7', 'angela-martin': 'spot-8', 'oscar-martinez': 'spot-9',
  'meredith-palmer': 'spot-10', 'pam-beesly': 'spot-reception',
}

// 2p: sit-down desk dressing, per desk variant, in css px from the desk anchor (art kit furn2p.py).
// ponytail: css px -> room % at the app's fixed 754x563 room (1056x682 window); sprites are fixed px sizes.
const CSS = { x: 100 / 754, y: 100 / 563 }
const CHAIR_OF: Record<string, string> = { 'left-front': 'rear-left', 'right-front': 'rear-right', 'left-rear': 'front-right', 'right-rear': 'front-left', reception: 'front-left' }
// Prop floor on the desk top, clear of the monitor and the sitter: front desks past the keyboard toward the phone, rear desks at the phone end
const PROP_AT: Record<string, [number, number]> = { 'left-front': [-7.6, -37.2], 'right-front': [7.6, -37.2], 'left-rear': [-36.4, -43.3], 'right-rear': [36.4, -43.3], reception: [-31.09, -52.97] }
const PROPS: Record<string, string> = {
  'pam-beesly': 'candy-jar', 'dwight-schrute': 'bobblehead', 'kevin-malone': 'mms-jar', 'stanley-hudson': 'crossword',
  'angela-martin': 'cat-frame', 'phyllis-vance': 'knitting', 'jim-halpert': 'stapler-jello', 'andy-bernard': 'cornell-pennant',
}

/**
 * 2p (office theme): chair per desk spot, chair back over a front-desk sitter, one prop per owner. z from the spot:
 * rear desk = chair < sitter < desk; front desk = desk < chair < sitter < back; prop = its desk + 1.
 */
export const DESK_DRESSING: FurnitureItem[] = MAIN.agentSpots.filter(s => s.desk).flatMap(s => {
  const desk = MAIN.furniture.find(f => f.id === s.desk)!
  const v = desk.sprite.replace('desk-standing-', ''), z = s.zIndex! * 10
  const chair = { id: `chair-${s.id}`, type: 'office-chair', sprite: `office-chair-${CHAIR_OF[v]}`, x: s.x, y: s.y + 12.2 * CSS.y, zIndex: z - 1 }
  const slug = Object.keys(SEATS).find(k => SEATS[k] === s.id)!
  const prop = PROPS[slug]
  return [
    chair,
    ...(v.endsWith('front') ? [{ ...chair, id: `chair-back-${s.id}`, type: 'office-chair-back', sprite: `office-chair-back-${CHAIR_OF[v]}`, zIndex: z + 1 }] : []),
    ...(prop ? [{ id: `prop-${slug}`, type: 'desk-prop', sprite: `prop-${prop}`, x: desk.x + PROP_AT[v][0] * CSS.x, y: desk.y + PROP_AT[v][1] * CSS.y,
      zIndex: (desk.zIndex ?? Math.round(desk.y * 10)) + 1 }] : []),
  ]
})

/** Every desk seat at its spot z, sitter or not: an empty chair draws at that z too, so a walker goes over / under it the same way. */
export const SEAT_Z = MAIN.agentSpots.filter(s => s.desk).map(s => ({ x: s.x, y: s.y, z: s.zIndex! * 10 }))

function seated(id: string, name: string, role: string, spot: AgentSpot | { x: number; y: number; id?: string; spriteFacing?: AgentSpot['spriteFacing'] }, task?: string): Agent {
  const cfg = AGENT_CONFIGS[role] ?? AGENT_CONFIGS['default']
  return {
    id, name, type: 'subagent', role, state: 'idle',
    position: { x: spot.x, y: spot.y }, targetPosition: { x: spot.x, y: spot.y }, deskPosition: { x: spot.x, y: spot.y },
    room: 'main-office', assignedRoom: 'main-office', assignedSpotId: spot.id, spriteFacing: spot.spriteFacing,
    task, statusText: '', color: cfg.color, emoji: cfg.emoji, hiredAt: Date.now(), pathQueue: [],
  }
}

/** The 11 regulars, at their seats from load. */
export function createRegulars(spots: AgentSpot[]): Agent[] {
  const at = (id: string) => spots.find(s => s.id === id)!
  return REGULARS.map(slug => {
    pinCast(regularId(slug), slug)
    return seated(regularId(slug), slugToName(slug), 'default', at(SEATS[slug]))
  })
}

/** Michael: always in the room, in his desk chair; a boss click walks him there and back (never busy: sits still). */
export function createBoss(): Agent {
  const home = MAIN.agentSpots.find(s => s.id === 'boss-home')!
  return { ...seated(BOSS_ID, AGENT_CONFIGS[BOSS_ROLE]?.title ?? 'Boss', BOSS_ROLE, home, 'Running the show'), busy: false }
}

/**
 * 2h: how Michael draws while he sits in his chair: his hip line (hip = fraction of the sprite from its top) on the
 * seat at (x, y) room %, the sprite cut below it; the chair back (App) covers his back below the shoulders.
 * 2p: a regular seated at its desk spot the same way: hip line 7.5 css above the spot (drawn 19 css lower, cut below 66%).
 */
export const BOSS_SEAT = { x: 12.3, y: 76.8, hip: 0.65 }
export type SeatDraw = typeof BOSS_SEAT
export function seatDraw(a: Agent): SeatDraw | undefined {
  if (!seatedAtDesk(a)) return undefined
  if (a.id === BOSS_ID) return a.assignedSpotId === 'boss-home' ? BOSS_SEAT : undefined
  const s = MAIN.agentSpots.find(s => s.id === a.assignedSpotId)
  return s?.desk ? { x: s.x, y: s.y - 7.5 * CSS.y, hip: 0.66 } : undefined
}

const same = (p: Position, q: Position) => p.x === q.x && p.y === q.y
const walk = (a: Agent, to: { x: number; y: number; spriteFacing?: AgentSpot['spriteFacing'] }): Agent =>
  ({ ...redirect(a, { x: to.x, y: to.y }, MAIN.waypoints ?? []), spriteFacing: to.spriteFacing })
const home = (a: Agent) => ({ ...a.deskPosition, spriteFacing: MAIN.agentSpots.find(s => s.id === a.assignedSpotId)?.spriteFacing })

/** 2e: the boss's door queue, the door first, then up the front aisle */
export const WAIT_SPOTS = ['boss-door-wait', 'boss-wait-2', 'boss-wait-3', 'boss-wait-4'].map(id => MAIN.agentSpots.find(s => s.id === id)!)
const waitSpotOf = (a: Agent) => WAIT_SPOTS.find(s => same(s, a.targetPosition))

/** First wait spot nobody else holds. ponytail: past 4 waiters they share the last spot; more floor if queues grow. */
function freeWaitSpot(agents: Agent[], self: string): AgentSpot {
  const taken = agents.filter(a => a.id !== self && a.state !== 'completed').map(waitSpotOf)
  return WAIT_SPOTS.find(s => !taken.includes(s)) ?? WAIT_SPOTS[WAIT_SPOTS.length - 1]
}

/** The walk's end (path empty, on target): at its own desk it types while busy; anywhere else it stands idle. */
export function arrive(a: Agent, position: Position): Agent {
  return { ...a, position, state: same(a.targetPosition, a.deskPosition) && a.busy !== false ? 'working' : 'idle' }
}

/** A character lets its session go: a regular goes back to its desk (idle, no text), a walker walks out. */
function release(a: Agent): Agent {
  if (a.id.startsWith('regular-')) {
    const free: Agent = { ...a, session: undefined, sessionState: undefined, sessionTitle: undefined, busy: false, statusText: '' }
    return same(a.targetPosition, a.deskPosition) ? { ...free, state: WALKING.has(a.state) ? a.state : 'idle' } : walk(free, home(a))
  }
  const door = MAIN.entryPoint
  return {
    ...a, state: 'completed', busy: false, statusText: '', targetPosition: { ...door },
    pathQueue: planPath(a.pathQueue?.[0] ?? a.targetPosition, door, MAIN.waypoints ?? []), // on from where it is heading
  }
}

/** A character shows its session: waiting → queue at the boss's door (never typing); else at its desk, typing while busy. */
function follow(a: Agent, v: SessionView, agents: Agent[]): Agent {
  const b: Agent = { ...a, session: v.sessionId, busy: v.busy, statusText: v.currentStep, sessionState: v.state, sessionReason: v.reason, runningAgents: v.runningAgents, sessionTitle: v.title }
  const settled = (state: Agent['state']) => ({ ...b, state: WALKING.has(a.state) ? a.state : state })
  if (v.state === 'waiting') return waitSpotOf(a) ? settled('idle') : walk(b, freeWaitSpot(agents, a.id))
  return same(a.targetPosition, a.deskPosition) ? settled(v.busy ? 'working' : 'idle') : walk(b, home(a))
}

/**
 * session_changed: seat n → REGULARS[n]; seat null → a cast walker `session-<id>`
 * walks in to an overflow spot. See follow(); `back` frees the regular or walks the walker out.
 */
/** Who stands for a session: the regular at its seat, else its overflow walker */
export const personOf = (v: SessionView) => v.seat != null ? regularId(REGULARS[v.seat]) : `session-${v.sessionId}`

export function applySession(prev: Agent[], v: SessionView): Agent[] {
  const walkerId = `session-${v.sessionId}`
  const target = v.state === 'back' ? null : personOf(v)
  let next = prev.map(a => a.session === v.sessionId && a.id !== target && a.state !== 'completed' ? release(a) : a)
  if (!target) return next
  const at = next.find(a => a.id === target && a.state !== 'completed')
  if (at) return next.map(a => a !== at ? a : follow(a, v, next))
  next = next.filter(a => a.id !== walkerId) // one on its way out comes back
  const spot = assignSpot(next, MAIN.agentSpots)
  if (!spot) return next
  const a = createAgent({ id: walkerId, name: 'Agent', role: 'default', spot })
  return [...next, follow({ ...a, pathQueue: planPath(a.position, a.targetPosition, MAIN.waypoints ?? []) }, v, next)]
}

/** Reconnect snapshot: sessions shown here that the server no longer has. */
export function staleSessions(agents: Agent[], live: Set<string>): string[] {
  return [...new Set(agents.flatMap(a => a.session && a.state !== 'completed' && !live.has(a.session) ? [a.session] : []))]
}

/** Who says a chat line: its session's character, else the agent it names. */
export function speakerOf(agents: Agent[], e: { sessionId?: string; agentId?: string }): Agent | undefined {
  return (e.sessionId && agents.find(a => a.session === e.sessionId)) || (e.agentId && agents.find(a => a.id === e.agentId)) || undefined
}
