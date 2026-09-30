import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { readFileSync, mkdtempSync, writeFileSync, mkdirSync } from 'fs'
import { spawnSync, spawn, ChildProcess } from 'child_process'
import WebSocket from 'ws'
import { tmpdir } from 'os'
import { join } from 'path'
import { ROOMS, Waypoint } from './rooms'
import { findWaypointPath, planPath, redirect, floorHulls, feetZ, walkerZ, seatedAtDesk, WALK_SPEED, chatKey, stepToward,
  createRegulars, createBoss, applySession, staleSessions, speakerOf, arrive, WAIT_SPOTS, personOf, BOSS_ID, seatDraw, BOSS_SEAT, SEATS, DESK_DRESSING, SEAT_Z } from './agentManager'
import { pitchOf } from './sounds'
import { getInteraction, ARRIVAL_WATCH_MS } from './interactions'
import { Agent, SessionView } from './types'
import { getDirectionFromDelta } from './components/Character'
import { stateWords, caption, elapsed } from './components/SessionPanel'
import { lightFor } from './daylight'
import { setTheme, getSpritePath, releaseRole, castKey, getActiveCastSlugs, themedDisplayName, REGULARS } from './theme'
import { getAvatarSrc } from './components/SlackChat'
import { ASSETS } from './assets'

const ROOT = join(__dirname, '..')
const room = ROOMS['main-office']
const WP = room.waypoints ?? []
const byId = new Map(WP.map(w => [w.id, w]))

// ---------------------------------------------------------------------------
// Furniture floor hulls (% of room) at the app window's fixed room size
// (1056x682 window -> 754x563 px room). Desk hull = the floor between the
// outer ends of both T-feet, foot tips included.
// ---------------------------------------------------------------------------
const ROOM_PX = { w: 754, h: 563 }
const hulls = floorHulls(room.furniture, ROOM_PX)
type Pt = { x: number; y: number }
const px = (p: Pt) => ({ x: p.x / 100 * ROOM_PX.w, y: p.y / 100 * ROOM_PX.h })

function inPoly(p: Pt, poly: Pt[]) {
  let inside = false
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i], b = poly[j]
    if ((a.y > p.y) !== (b.y > p.y) && p.x < (b.x - a.x) * (p.y - a.y) / (b.y - a.y) + a.x) inside = !inside
  }
  return inside
}
function segDist(p: Pt, a: Pt, b: Pt) {
  const dx = b.x - a.x, dy = b.y - a.y
  const t = dx || dy ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / (dx * dx + dy * dy))) : 0
  return Math.hypot(p.x - a.x - t * dx, p.y - a.y - t * dy)
}
// Hulls the segment p-q comes within 1 px of (or crosses)
function tooClose(p: Pt, q: Pt): string[] {
  const P = px(p), Q = px(q)
  return hulls.filter(h => {
    const poly = h.poly.map(px)
    if (inPoly(P, poly) || inPoly(Q, poly)) return true
    return poly.some((a, i) => near(P, Q, a, poly[(i + 1) % poly.length]))
  }).map(h => h.id)
}
const cross = (u: Pt, v: Pt, w: Pt) => (v.x - u.x) * (w.y - u.y) - (v.y - u.y) * (w.x - u.x)
// Segments P-Q and a-b (px) cross or come within 1 px
const near = (P: Pt, Q: Pt, a: Pt, b: Pt) => (cross(P, Q, a) * cross(P, Q, b) < 0 && cross(a, b, P) * cross(a, b, Q) < 0) ||
  Math.min(segDist(a, P, Q), segDist(b, P, Q), segDist(P, a, b), segDist(Q, a, b)) < 1

// 2h: the free floor (room.walkableArea). A segment p-q stays on it, >= 1 px from its edge.
const FLOOR = (room.walkableArea ?? []).map(px)
const onFloor = (p: Pt) => inPoly(px(p), FLOOR) && FLOOR.every((a, i) => segDist(px(p), a, FLOOR[(i + 1) % FLOOR.length]) >= 1)
const offFloor = (p: Pt, q: Pt) => !onFloor(p) || !onFloor(q) || FLOOR.some((a, i) => near(px(p), px(q), a, FLOOR[(i + 1) % FLOOR.length]))
// The right-wall counter's front base on the art (1200x896 px: 873,492 -> 1042,568)
const counterFrontY = (x: number) => 54.91 + (x - 72.75) * (63.39 - 54.91) / (86.83 - 72.75)
// Seated regulars: feet, drawn z (spot z, else feet z), and a 29x12 px footprint centred on the feet
const SEATED = createRegulars(room.agentSpots).map(a => {
  const s = room.agentSpots.find(s => s.id === a.assignedSpotId)!
  return { id: a.id, x: s.x, y: s.y, z: s.zIndex ? s.zIndex * 10 : feetZ(s.x, s.y, hulls) }
})
const footGap = (p: Pt, s: Pt) => { const P = px(p), S = px(s); return Math.hypot(Math.max(0, Math.abs(P.x - S.x) - 14.5), Math.max(0, Math.abs(P.y - S.y) - 6)) }
const onSomeone = (p: Pt) => SEATED.filter(s => footGap(p, s) < 1).map(s => s.id)

// The walker's sprite box (office cast: 78 px tall, ~29 px wide) and a desk's
// front/back edge at x: wrong layer = in front of the desk but drawn behind it, or the reverse.
const CHAR = { w: 29 / ROOM_PX.w * 100, h: 78 / ROOM_PX.h * 100 }
// Beside an end tip: the two edges meeting at that tip, extended (feet below both = in front, above both = behind).
function edgesAt(poly: Pt[], x: number): [number, number] {
  const byX = [...poly].sort((a, b) => a.x - b.x)
  const lines: [Pt, Pt][] = poly.map((a, i) => [a, poly[(i + 1) % poly.length]] as [Pt, Pt]).filter(([a, b]) => a.x !== b.x)
  const tip = x < byX[0].x ? byX[0] : x > byX[byX.length - 1].x ? byX[byX.length - 1] : null
  const ys = lines
    .filter(([a, b]) => tip ? a === tip || b === tip : x >= Math.min(a.x, b.x) && x <= Math.max(a.x, b.x))
    .map(([a, b]) => a.y + (b.y - a.y) * (x - a.x) / (b.x - a.x))
  return [Math.min(...ys), Math.max(...ys)]
}
// Drawn as the app draws a walker (walkerZ); seated = who sits while it walks
function wrongLayer(p: Pt, seated: { x: number; y: number; z: number }[] = SEATED): string[] {
  const z = walkerZ(p, hulls, seated, ROOM_PX)
  return hulls.filter(h => h.desk).filter(h => {
    const left = h.x - h.w / 2, top = h.y - h.h
    if (p.x + CHAR.w / 2 < left || p.x - CHAR.w / 2 > left + h.w || p.y < top || p.y - CHAR.h > h.y) return false
    const [back, front] = edgesAt(h.poly, p.x)
    const drawnFront = z >= h.z // characters come after furniture in the DOM
    return (p.y > front && !drawnFront) || (p.y < back && drawnFront)
  }).map(h => `${h.id}@${p.x.toFixed(2)},${p.y.toFixed(2)} z${z}`)
}
// Every point the walker's feet pass on a polyline, every 0.02 %-units
function* along(pts: Pt[]) {
  for (let i = 0; i + 1 < pts.length; i++) {
    const a = pts[i], b = pts[i + 1]
    const n = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / 0.02))
    for (let k = 0; k <= n; k++) yield { x: a.x + (b.x - a.x) * k / n, y: a.y + (b.y - a.y) * k / n }
  }
}
// What the app walks: from -> planned waypoints -> target
const walked = (from: Pt, to: Pt) => [from, ...planPath(from, to, WP), to]
const crossesBox = tooClose

const REQUIRED = room.agentSpots.filter(s =>
  ['desk', 'filing', 'coffee', 'water', 'printer', 'overflow', 'standing'].includes(s.type))

describe('waypoint graph', () => {
  it('has 8 overflow spots on the front floor', () => {
    const over = room.agentSpots.filter(s => s.type === 'overflow')
    expect(over).toHaveLength(8)
    for (const s of over) {
      expect(s.x).toBeGreaterThanOrEqual(36); expect(s.x).toBeLessThanOrEqual(44)
      expect(s.y).toBeGreaterThanOrEqual(77); expect(s.y).toBeLessThanOrEqual(84)
    }
  })

  it('2r: overflow spots stand clear of the aisles (>= 10.5 px from every W-a-* edge) and off every seat (>= 40 px), Pam included', () => {
    const aisle = WP.filter(w => w.id.startsWith('W-a-')).flatMap(w => w.connections.map(c => [w, byId.get(c)!]))
    for (const s of room.agentSpots.filter(s => s.type === 'overflow')) {
      for (const [a, b] of aisle) expect(segDist(px(s), px(a), px(b)), `${s.id} vs ${a.id}-${b.id}`).toBeGreaterThanOrEqual(10.5)
      for (const t of room.agentSpots.filter(t => t.desk)) expect(Math.hypot(px(s).x - px(t).x, px(s).y - px(t).y), `${s.id} vs ${t.id}`).toBeGreaterThanOrEqual(40)
    }
  })

  it('every edge points at a real node and is walkable both ways', () => {
    for (const w of WP) for (const c of w.connections) {
      const o = byId.get(c)!
      expect(o, `${w.id} -> ${c}`).toBeTruthy()
      expect(findWaypointPath(w.x, w.y, o.x, o.y, WP)).toEqual([{ x: w.x, y: w.y }, { x: o.x, y: o.y }])
      expect(findWaypointPath(o.x, o.y, w.x, w.y, WP)).toEqual([{ x: o.x, y: o.y }, { x: w.x, y: w.y }])
    }
  })

  it('no edge or spot link comes within 1 px of a furniture floor hull (foot tips included)', () => {
    const bad: string[] = []
    for (const w of WP) for (const c of w.connections) {
      const hits = crossesBox(w, byId.get(c)!)
      if (hits.length) bad.push(`${w.id}->${c} x ${hits.join(',')}`)
    }
    expect(bad).toEqual([])
  })

  it('every spot is a dead-end waypoint, clear of furniture, linked to one aisle node', () => {
    for (const s of REQUIRED) {
      const w = WP.find(w => Math.abs(w.x - s.x) < 0.01 && Math.abs(w.y - s.y) < 0.01)
      expect(w, `waypoint at ${s.id}`).toBeTruthy()
      expect(w!.connections, `${s.id} links`).toHaveLength(1)
      expect(crossesBox(s, s), `${s.id} inside or next to furniture`).toEqual([])
      expect(crossesBox(s, byId.get(w!.connections[0])!), `${s.id} link`).toEqual([])
    }
  })

  it('every required spot is reachable from W-door', () => {
    const adj = new Map(WP.map(w => [w.id, [] as string[]]))
    for (const w of WP) for (const c of w.connections) { adj.get(w.id)!.push(c); adj.get(c)!.push(w.id) }
    const seen = new Set(['W-door'])
    const q = ['W-door']
    while (q.length) for (const c of adj.get(q.shift()!)!) if (!seen.has(c)) { seen.add(c); q.push(c) }
    for (const s of REQUIRED) {
      const w = WP.find(w => Math.abs(w.x - s.x) < 0.01 && Math.abs(w.y - s.y) < 0.01)!
      expect(seen.has(w.id), s.id).toBe(true)
    }
  })

  it('findWaypointPath is deterministic and ends on the spot', () => {
    const door = room.entryPoint
    for (const s of REQUIRED) {
      const a = findWaypointPath(door.x, door.y, s.x, s.y, WP)
      const b = findWaypointPath(door.x, door.y, s.x, s.y, WP)
      expect(a).toEqual(b)
      expect(a[a.length - 1]).toEqual({ x: s.x, y: s.y })
    }
  })

  // Everywhere a walker goes: door, every spot, office-event targets, boss click targets
  const EVENT_TARGETS = [{ x: 67.5, y: 48.9 }, { x: 46, y: 64 }, { x: 73.5, y: 56.7 }, { x: 83.8, y: 63 }]
  const BOSS_TARGETS = ['whiteboard', ...room.furniture.map(f => f.id)].map(id => getInteraction(id)?.walkTo).filter((t): t is Pt => !!t)
  const PLACES: Pt[] = [room.entryPoint, ...REQUIRED, ...EVENT_TARGETS, ...BOSS_TARGETS]

  it('every route between any two places stays clear of furniture (boss click targets included)', () => {
    const bad = new Set<string>()
    for (const a of PLACES) for (const b of PLACES) {
      if (a === b) continue
      const pts = walked(a, b)
      for (let i = 0; i + 1 < pts.length; i++) {
        const hits = tooClose(pts[i], pts[i + 1])
        if (hits.length) bad.add(`(${pts[i].x},${pts[i].y})->(${pts[i + 1].x},${pts[i + 1].y}) x ${hits.join(',')}`)
      }
    }
    expect([...bad]).toEqual([])
  })

  it('the boss reaches every click target well before its arrival watcher gives up', () => {
    // Walk time at 60 fps (WALK_SPEED per frame) from anywhere he stands; 2x slack for slow or dropped frames
    const secs = (a: Pt, b: Pt) => walked(a, b).reduce((s, p, i, pts) => i ? s + Math.hypot(p.x - pts[i - 1].x, p.y - pts[i - 1].y) : 0, 0) / (WALK_SPEED * 60)
    const slow = PLACES.flatMap(a => BOSS_TARGETS.filter(b => a !== b && 2 * secs(a, b) * 1000 > ARRIVAL_WATCH_MS)
      .map(b => `${(a as any).id ?? `${a.x},${a.y}`} -> ${b.x},${b.y}: ${secs(a, b).toFixed(1)} s`))
    expect(slow).toEqual([])
  })

  it("The boss's office: Michael's home is the desk chair; every route between the office and the room goes through the door gap; desk click = the chair", () => {
    const visitor = room.agentSpots.find(s => s.id === 'boss-visitor')!
    const chair = room.agentSpots.find(s => s.id === 'boss-home')!
    expect(visitor).toBeTruthy()
    expect(room.agentSpots.find(s => s.id === 'boss-door-wait')?.type).toBe('standing')
    expect({ x: chair.x, y: chair.y, facing: chair.spriteFacing }).toEqual({ x: 12.5, y: 80, facing: 'rear-left' }) // up-right: his desk
    const gap = (pts: Pt[]) => pts.some(p => p.x === 28.6 && p.y === 78.2)
    const inOffice = (p: Pt) => [visitor, chair].some(o => p.x === o.x && p.y === o.y)
    expect(gap(walked(room.entryPoint, visitor))).toBe(true)
    expect(PLACES.filter(p => !inOffice(p) && !gap(walked(p, visitor))).map(p => `${p.x},${p.y}`)).toEqual([])
    expect(PLACES.filter(p => !inOffice(p) && !gap(walked(chair, p))).map(p => `${p.x},${p.y}`)).toEqual([])
    expect(PLACES.filter(p => !inOffice(p) && !gap(walked(p, chair))).map(p => `${p.x},${p.y}`)).toEqual([])
    expect(getInteraction('boss-desk')?.walkTo).toEqual({ x: chair.x, y: chair.y })
    expect(room.furniture.some(f => f.id === 'boss-desk' && f.interactive)).toBe(true)
  })

  it('the boss stands right under the whiteboard (both board ids), on the floor in front of the counter', () => {
    const k = getInteraction('kanban-board')!.walkTo, w = getInteraction('whiteboard')!.walkTo
    expect(k).toEqual(w)
    expect(k.y).toBeGreaterThan(counterFrontY(k.x))
    expect(Math.abs(k.x - 80)).toBeLessThanOrEqual(7)
  })

  it('a walker is never drawn on the wrong side of a desk, on any route', () => {
    const bad = new Set<string>()
    for (const a of PLACES) for (const b of PLACES) {
      if (a === b) continue
      // App.tsx walks everyone against every desk seat (SEAT_Z), empty or taken, so the seat it walks to or from counts too
      for (const p of along(walked(a, b))) for (const w of wrongLayer(p, SEAT_Z)) bad.add(w.replace(/@.*/, '') + ` (${(a as any).id ?? `${a.x},${a.y}`} -> ${(b as any).id ?? `${b.x},${b.y}`})`)
    }
    expect([...bad]).toEqual([])
  }, 20_000) // CPU-bound (~5-6 s): the 5 s default times out under load

  it('a walker beside a desk end, in front of it, is drawn over it (spot-6 aisle, spot-7/8 approaches)', () => {
    const z = (id: string) => hulls.find(h => h.id === id)!.z
    expect(feetZ(34.27, 55.14, hulls)).toBeGreaterThan(z('desk-1c'))
    expect(feetZ(67.86, 75.88, hulls)).toBeGreaterThan(z('desk-3b'))
    expect(feetZ(72, 71, hulls)).toBeGreaterThan(z('desk-3d'))
    expect(feetZ(33.3, 49.5, hulls)).toBeLessThan(z('desk-1c')) // above-left of the tip stays behind
  })

  it('a walker redirected mid-walk heads on to a point it reaches in a clear line', () => {
    // e.g. a new hire between W-a-left-mid and W-a-back-left (to spot-6) when a standup starts
    const bad = new Set<string>()
    for (const s of REQUIRED) {
      const full = walked(room.entryPoint, s)
      for (let i = 1; i < full.length; i++) for (let f = 0.1; f < 1; f += 0.1) {
        const pos = { x: full[i - 1].x + (full[i].x - full[i - 1].x) * f, y: full[i - 1].y + (full[i].y - full[i - 1].y) * f }
        const a = { id: 'agent-x', state: 'new-hire', position: pos, targetPosition: s, pathQueue: full.slice(i, -1) } as unknown as Agent
        for (const t of EVENT_TARGETS) {
          const pts = [pos, ...redirect(a, t, WP).pathQueue!, t]
          for (let k = 0; k + 1 < pts.length; k++) {
            const hits = tooClose(pts[k], pts[k + 1])
            if (hits.length) bad.add(`${s.id} leg ${i} -> ${t.x},${t.y}: (${pts[k].x},${pts[k].y})->(${pts[k + 1].x},${pts[k + 1].y}) x ${hits}`)
          }
        }
      }
    }
    expect([...bad]).toEqual([])
  })

  it('an office event never pulls back an agent on its way out', () => {
    const a = { id: 'agent-x', state: 'completed', position: { x: 50, y: 60 }, targetPosition: room.entryPoint, pathQueue: [] } as unknown as Agent
    expect(redirect(a, { x: 46, y: 64 }, WP)).toBe(a)
  })

  it('spot z applies only to an agent seated at its desk, not to a walker whose path just emptied on its spot', () => {
    const desk = { x: 40, y: 60 }
    const at = (state: string, pathQueue: unknown[] = []) =>
      ({ id: 'agent-x', state, position: { ...desk }, deskPosition: desk, targetPosition: { x: 46, y: 64 }, pathQueue }) as unknown as Agent
    // standup / boss click: the redirect's only waypoint was the walker's own spot, popped on the first tick
    for (const s of ['walking-to-desk', 'new-hire', 'coffee-break', 'completed']) expect(seatedAtDesk(at(s)), s).toBe(false)
    expect(seatedAtDesk(at('working', [desk]))).toBe(false)
    expect(seatedAtDesk(at('working'))).toBe(true)
    expect(seatedAtDesk(at('idle'))).toBe(true)
  })

  it('one-way edges in data are made two-way at load', () => {
    const wps: Waypoint[] = [
      { id: 'a', x: 0, y: 0, connections: ['b'] },
      { id: 'b', x: 10, y: 0, connections: [] },
    ]
    expect(findWaypointPath(10, 0, 0, 0, wps)).toEqual([{ x: 10, y: 0 }, { x: 0, y: 0 }])
  })
})

// ---------------------------------------------------------------------------
// Hook: python3 hooks/agent-tracker.py maps Claude Code events to office events
// ---------------------------------------------------------------------------
function py(payload: unknown): unknown {
  const r = spawnSync('python3', [join(ROOT, 'hooks/agent-tracker.py')], { input: JSON.stringify(payload) })
  const out = r.stdout.toString().trim()
  return out ? JSON.parse(out) : null
}

describe('2h: Michael at his desk; click targets on free floor, clear of seated people', () => {
  const chair = room.agentSpots.find(s => s.id === 'boss-home')!
  const IDS = ['whiteboard', ...room.furniture.map(f => f.id)].filter(id => getInteraction(id))
  const TARGETS = IDS.map(id => getInteraction(id)!.walkTo)
  const EVENT_TARGETS = [{ x: 67.5, y: 48.9 }, { x: 46, y: 64 }, { x: 73.5, y: 56.7 }, { x: 83.8, y: 63 }]
  const PLACES: Pt[] = [room.entryPoint, ...REQUIRED, ...EVENT_TARGETS, ...TARGETS]
  const secs = (a: Pt, b: Pt) => walked(a, b).reduce((s, p, i, pts) => i ? s + Math.hypot(p.x - pts[i - 1].x, p.y - pts[i - 1].y) : 0, 0) / (WALK_SPEED * 60)
  // Every boss walk: chair -> target, target -> chair, target -> target
  const BOSS_WALKS = [...TARGETS.flatMap(t => [walked(chair, t), walked(t, chair)]), ...TARGETS.flatMap(a => TARGETS.filter(b => b !== a).map(b => walked(a, b)))]

  it.each(IDS)('%s: on free floor, clear of furniture and seated people, right layer, reached in time', id => {
    const t = getInteraction(id)!.walkTo
    expect(onFloor(t), 'on the free floor, >= 1 px from its edge').toBe(true)
    expect(tooClose(t, t), 'furniture').toEqual([])
    expect(onSomeone(t), 'seated people').toEqual([])
    expect(wrongLayer(t)).toEqual([])
    expect(secs(chair, t) * 1000).toBeLessThan(ARRIVAL_WATCH_MS / 2)
    if (['tv-monitor', 'kanban-board', 'whiteboard', 'coffee', 'printer-1'].includes(id)) expect(t.y, 'below the counter front').toBeGreaterThan(counterFrontY(t.x))
  })

  it('every route between any two places stays on the free floor (chair and click targets included)', () => {
    const bad = new Set<string>()
    for (const a of PLACES) for (const b of PLACES) {
      if (a === b) continue
      const pts = walked(a, b)
      for (let i = 0; i + 1 < pts.length; i++) if (offFloor(pts[i], pts[i + 1])) bad.add(`(${pts[i].x},${pts[i].y})->(${pts[i + 1].x},${pts[i + 1].y})`)
    }
    expect([...bad]).toEqual([])
  })

  it('bug 3: the boss never walks over a seated person (chair <-> every target, target -> target)', () => {
    const bad = new Set<string>()
    for (const w of BOSS_WALKS) for (const p of along(w)) for (const s of onSomeone(p)) bad.add(`${s} (${w[0].x},${w[0].y} -> ${w[w.length - 1].x},${w[w.length - 1].y})`)
    expect([...bad]).toEqual([])
  })

  it('depth: where the boss overlaps a seated person he is drawn over them exactly when his feet are in front', () => {
    const bad = new Set<string>()
    for (const w of BOSS_WALKS) for (const p of along(w)) {
      const z = walkerZ(p, hulls, SEATED, ROOM_PX)
      for (const s of SEATED) {
        if (Math.abs(p.x - s.x) >= CHAR.w || Math.abs(p.y - s.y) >= CHAR.h) continue
        if ((z > s.z) !== (p.y > s.y)) bad.add(`${s.id} @${p.x.toFixed(1)},${p.y.toFixed(1)} z${z} vs ${s.z}`)
      }
    }
    expect([...bad]).toEqual([])
    const z = (id: string) => SEATED.find(s => s.id === id)!.z
    expect(walkerZ({ x: 37.9, y: 72 }, hulls, SEATED, ROOM_PX)).toBeGreaterThan(z('regular-dwight-schrute')) // 2p: spot-2
    expect(walkerZ({ x: 26, y: 74 }, hulls, SEATED, ROOM_PX)).toBeGreaterThan(z('regular-andy-bernard')) // 2p: spot-1
    expect(walkerZ({ x: 40, y: 41 }, hulls, SEATED, ROOM_PX)).toBeLessThan(z('regular-stanley-hudson')) // 2p: spot-6
    expect(walkerZ({ x: 90, y: 70 }, hulls, SEATED, ROOM_PX)).toBe(feetZ(90, 70, hulls)) // nobody near: feet z
  })

  it('seated draw: Michael only in his chair (2p: regulars at their desks, see 2p); hips on the seat, head + shoulders above the chair back, nothing below the seat', () => {
    const boss = createBoss()
    expect(seatDraw(boss)).toBe(BOSS_SEAT)
    // Not seated: walking, mid-walk, standing anywhere else, and every other character
    const going = redirect(boss, { x: 16, y: 66 }, WP)
    expect(seatDraw(going)).toBeUndefined()
    expect(seatDraw({ ...going, position: { x: 14, y: 79 } })).toBeUndefined()
    expect(seatDraw({ ...boss, position: { x: 16, y: 66 }, targetPosition: { x: 16, y: 66 }, state: 'idle' })).toBeUndefined()
    expect(seatDraw({ ...boss, state: 'walking-to-desk' })).toBeUndefined()
    for (const a of createRegulars(room.agentSpots)) { expect(seatedAtDesk(a), a.id).toBe(true); expect(seatDraw(a), a.id).not.toBe(BOSS_SEAT) }
    // Geometry at the 754x563 room: the chair back polygon from App (room %)
    const app = readFileSync(join(ROOT, 'src/App.tsx'), 'utf8')
    const poly = [...app.match(/const CHAIR_BACK = 'polygon\(([^)]*)\)'/)![1].matchAll(/([\d.]+)% ([\d.]+)%/g)].map(m => ({ x: +m[1], y: +m[2] }))
    const top = Math.min(...poly.map(p => p.y)), bottom = Math.max(...poly.map(p => p.y))
    const H = 85 / ROOM_PX.h * 100 // his sprite height in room %
    const head = BOSS_SEAT.y - BOSS_SEAT.hip * H
    const shoulders = head + (170 / 524) * H // shoulder row of the 524 px rear-left sprite
    expect(shoulders, 'shoulders above the chair back').toBeLessThan(top)
    expect(BOSS_SEAT.y, 'hips below the chair back top').toBeGreaterThan(top + 3)
    expect(BOSS_SEAT.y, 'cut line above the chair base').toBeLessThan(bottom)
    expect(BOSS_SEAT.hip, 'cut at the jacket hem: legs never drawn').toBeLessThanOrEqual(345 / 524)
    expect(inPoly(BOSS_SEAT, poly), 'seat anchor on the chair').toBe(true)
    expect(Math.abs(BOSS_SEAT.x - chair.x)).toBeLessThan(1)
    // Wiring: office theme only (the chair is office art); the sprite is cut below the hips and loses its floor shadow
    expect(app).toMatch(/seat=\{theme === 'office' \? seatDraw\(agent\) : undefined\}/)
    const ch = readFileSync(join(ROOT, 'src/components/Character.tsx'), 'utf8')
    expect(ch).toMatch(/clipPath: seat \? `inset\(0 0 \$\{Math\.round\(\(1 - seat\.hip\) \* 100\)\}% 0\)` : undefined/)
    expect(ch).toMatch(/\{!seat && <div className="char-shadow" \/>\}/)
  })

  it('App: walkers use walkerZ; the chair back is drawn over Michael, office theme only, day + night', () => {
    const app = readFileSync(join(ROOT, 'src/App.tsx'), 'utf8')
    expect(app).toMatch(/walkerZ\(agent\.position, hulls, seatedNow, roomPx\)/)
    expect(app).toMatch(/theme === 'office' && \(\['day', 'night'\] as const\)\.map/)
    expect(app).toMatch(/clipPath: CHAIR_BACK/)
    expect(app).toMatch(/zIndex: feetZ\(BOSS_HOME\.x, BOSS_HOME\.y, hulls\) \+ 1/)
    expect(feetZ(chair.x, chair.y, hulls)).toBe(createBoss().position.y * 10) // his seated z = feet z (no spot z)
    expect(chair.zIndex).toBeUndefined()
  })
})

describe('hook mapping', () => {
  it('SubagentStart -> agent_spawned with agent-<agent_id>', () => {
    const ev = py({ hook_event_name: 'SubagentStart', agent_id: 'abc', agent_type: 'Explore' }) as any
    expect(ev.type).toBe('agent_spawned')
    expect(ev.agent.id).toBe('agent-abc')
    expect(ev.agent.role).toBe('Explore')
  })
  it('SubagentStop -> agent_completed with the same id', () => {
    const ev = py({ hook_event_name: 'SubagentStop', agent_id: 'abc', agent_type: 'Explore' }) as any
    expect(ev.type).toBe('agent_completed')
    expect(ev.agentId).toBe('agent-abc')
  })
  it('PreToolUse(Read) with agent_id -> agent_working for that agent', () => {
    const ev = py({ hook_event_name: 'PreToolUse', tool_name: 'Read', agent_id: 'abc', agent_type: 'Explore', tool_input: { file_path: '/x/y.ts' } }) as any
    expect(ev.type).toBe('agent_working')
    expect(ev.agentId).toBe('agent-abc')
  })
  it('PreToolUse without agent_id -> Jim (assistant-claude)', () => {
    const ev = py({ hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: { file_path: '/x/y.ts' } }) as any
    expect(ev.type).toBe('agent_working')
    expect(ev.agentId).toBe('assistant-claude')
  })
  it('Agent PostToolUse -> nothing', () => {
    expect(py({ hook_event_name: 'PostToolUse', tool_name: 'Agent', tool_use_id: 't1', tool_response: 'started' })).toBeNull()
  })
  it('any other tool event inside a subagent -> agent_seen heartbeat', () => {
    for (const p of [
      { hook_event_name: 'PreToolUse', tool_name: 'WebFetch', agent_id: 'abc', agent_type: 'Explore' },
      { hook_event_name: 'PostToolUse', tool_name: 'WebFetch', agent_id: 'abc', agent_type: 'Explore' },
    ]) expect(py(p)).toEqual({ type: 'agent_seen', agentId: 'agent-abc', role: 'Explore', name: 'Explorer' })
    expect(py({ hook_event_name: 'PostToolUse', tool_name: 'WebFetch' })).toBeNull() // main session: nothing
    expect((py({ hook_event_name: 'PreToolUse', tool_name: 'mcp__srv__t', agent_id: 'abc' }) as any).agentId).toBe('agent-abc')
  })
  it('Agent PreToolUse -> agent_pending', () => {
    const ev = py({ hook_event_name: 'PreToolUse', tool_name: 'Agent', tool_use_id: 't1', tool_input: { description: 'map the code', subagent_type: 'Explore' } }) as any
    expect(ev).toEqual({ type: 'agent_pending', role: 'Explore', task: 'map the code' })
  })
})

describe('hook safety', () => {
  const home = mkdtempSync(join(tmpdir(), 'office-hook-'))
  mkdirSync(join(home, '.agent-office'))
  writeFileSync(join(home, '.agent-office', 'auth-token'), 'test-token')
  const fixtures: string[] = [
    ...[
      { hook_event_name: 'SubagentStart', agent_id: 'a1', agent_type: 'Explore' },
      { hook_event_name: 'SubagentStop', agent_id: 'a1', agent_type: 'Explore' },
      { hook_event_name: 'PreToolUse', tool_name: 'Agent', tool_input: { description: 'x', subagent_type: 'Explore' } },
      { hook_event_name: 'PostToolUse', tool_name: 'Agent', tool_response: { output: 'ok' } },
      { hook_event_name: 'PreToolUse', tool_name: 'Read', agent_id: 'a1', tool_input: { file_path: '/a' } },
      { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { description: 'ls' } },
      { hook_event_name: 'PreToolUse', tool_name: 'mcp__srv__tool', tool_input: {} },
      { hook_event_name: 'PostToolUse', tool_name: 'WebFetch', agent_id: 'a1' },
      { hook_event_name: 'PostToolUse', tool_name: 'mcp__srv__tool' },
      { hook_event_name: 'SessionStart' },
      { hook_event_name: 'Stop', session_id: 's1', stop_hook_active: false }, // never a decision: no output
      {},
    ].map(p => JSON.stringify(p)),
    '{not json',
    '',
  ]
  it.each(fixtures)('exits 0, silent, <1 s: %s', (input) => {
    const t0 = Date.now()
    const r = spawnSync('bash', [join(ROOT, 'hooks/agent-tracker.sh')], {
      input,
      env: { ...process.env, HOME: home, AGENT_OFFICE_URL: 'http://127.0.0.1:9' }, // server down
    })
    expect(Date.now() - t0).toBeLessThan(1000)
    expect(r.status).toBe(0)
    expect(r.stdout.toString()).toBe('')
    expect(r.stderr.toString()).toBe('')
  })
})

describe('facing', () => {
  // On screen: front-left faces down-right, rear-left faces up-right (and mirrored)
  it('the sprite faces travel in all 4 diagonals', () => {
    expect(getDirectionFromDelta(1, 1)).toBe('front-left')
    expect(getDirectionFromDelta(-1, 1)).toBe('front-right')
    expect(getDirectionFromDelta(1, -1)).toBe('rear-left')
    expect(getDirectionFromDelta(-1, -1)).toBe('rear-right')
  })
})

describe('cast', () => {
  it('a departed agent keeps its face in chat history without holding a slot', () => {
    setTheme('office')
    const face = getSpritePath('agent-gone', 'debugger', 'employee-3', 'front-right')
    const name = themedDisplayName('agent-gone', 'Agent')
    const slug = face.split('/').pop()!.replace('-front-right.png', '')
    releaseRole(castKey('agent-gone', 'debugger'))
    const live = getActiveCastSlugs()
    expect(live.has(slug)).toBe(false)
    expect(getSpritePath('agent-gone', 'debugger', 'employee-3', 'front-right')).toBe(face)
    expect(themedDisplayName('agent-gone', 'Agent')).toBe(name)
    expect(getActiveCastSlugs()).toEqual(live) // no slot re-dealt for history lines
  })
})

describe('chat lookups', () => {
  it('never take cast slots: after a theme switch and old chat, new agents still get unique cast', () => {
    setTheme('default')
    setTheme('office')
    for (let i = 0; i < 40; i++) { // chat history about agents that left before the switch
      getAvatarSrc('debugger', `agent-old${i}`)
      themedDisplayName(castKey(`agent-old${i}`, 'debugger'), 'Old')
    }
    getAvatarSrc('test-engineer') // a line with no id
    expect(getActiveCastSlugs().size).toBe(0)
    const faces = Array.from({ length: 15 }, (_, i) => getSpritePath(`agent-new${i}`, 'debugger', 'employee-3', 'front-right'))
    expect(new Set(faces).size).toBe(15) // every non-regular cast member (2c: regulars, Jim and Michael are never dealt)
    expect(getAvatarSrc('debugger', 'agent-new3')).toBe(faces[3]) // a line about a live agent shows its face
  })
})

// ---------------------------------------------------------------------------
// Server: a real node server/index.js on a spare port with HOME=<scratch>
// ---------------------------------------------------------------------------
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

function office(PORT: number, env: Record<string, string> = {}) {
  const home = mkdtempSync(join(tmpdir(), 'office-srv-'))
  let srv: ChildProcess
  let token = ''
  const post = (ev: object) => fetch(`http://127.0.0.1:${PORT}/event`, {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: JSON.stringify(ev),
  })
  const listen = () => new Promise<{ ws: WebSocket; msgs: any[] }>(res => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`)
    const msgs: any[] = []
    ws.on('message', d => msgs.push(JSON.parse(d.toString())))
    ws.on('open', () => res({ ws, msgs }))
  })
  beforeAll(async () => {
    srv = spawn('node', [join(ROOT, 'server/index.js')], { env: { ...process.env, HOME: home, AGENT_OFFICE_PORT: String(PORT), ...env }, stdio: 'ignore' })
    for (let i = 0; i < 40; i++) {
      try { if ((await fetch(`http://127.0.0.1:${PORT}/health`)).ok) break } catch {}
      await sleep(100)
    }
    token = readFileSync(join(home, '.agent-office', 'auth-token'), 'utf8').trim()
  })
  afterAll(() => { srv?.kill() })
  const health = async () => (await (await fetch(`http://127.0.0.1:${PORT}/health`)).json())
  return { post, listen, health, home }
}

describe('server', () => {
  const { post, listen, health } = office(3591)

  it('sends agent_spawned before its "started:" chat line', async () => {
    const { ws, msgs } = await listen()
    await post({ type: 'agent_pending', role: 'debugger', task: 'Fix login bug' })
    await post({ type: 'agent_spawned', agent: { id: 'agent-r1', role: 'debugger' } })
    await sleep(200)
    ws.close()
    const types = msgs.filter(m => m.agentId === 'agent-r1' || m.agent?.id === 'agent-r1').map(m => m.type)
    expect(types).toEqual(['agent_spawned', 'chat_message'])
    expect(msgs.find(m => m.agentId === 'agent-r1' && m.type === 'chat_message').text).toBe('started: Fix login bug')
  })

  it("started: / finished lines carry the agent's sessionId (2c), also for a quietly re-spawned agent", async () => {
    const { ws, msgs } = await listen()
    await post({ type: 'agent_spawned', agent: { id: 'agent-cs1', role: 'debugger' }, sessionId: 'sA' })
    await post({ type: 'agent_completed', agentId: 'agent-cs1', result: 'ok', sessionId: 'sA' })
    await post({ type: 'agent_working', agentId: 'agent-cs2', status: 'reading', sessionId: 'sB' })
    await post({ type: 'agent_completed', agentId: 'agent-cs2', sessionId: 'sB' })
    await sleep(200)
    ws.close()
    const lines = msgs.filter(m => m.type === 'chat_message').map(m => [m.agentId, m.sessionId, m.text])
    expect(lines).toEqual([['agent-cs1', 'sA', 'started'], ['agent-cs1', 'sA', '✅ finished: ok'], ['agent-cs2', 'sB', '✅ finished']])
  })

  it('an unknown agent_id is spawned once, before its working event', async () => {
    const { ws, msgs } = await listen()
    await post({ type: 'agent_working', agentId: 'agent-u1', status: 'reading' })
    await post({ type: 'agent_working', agentId: 'agent-u1', status: 'reading' })
    await sleep(200)
    ws.close()
    const types = msgs.filter(m => m.agentId === 'agent-u1' || m.agent?.id === 'agent-u1').map(m => m.type)
    expect(types).toEqual(['agent_spawned', 'agent_working', 'agent_working'])
  })

  it('a completed agent is not in the snapshot during its exit grace', async () => {
    await post({ type: 'agent_spawned', agent: { id: 'agent-g1', role: 'debugger' } })
    await post({ type: 'agent_completed', agentId: 'agent-g1' })
    const { ws, msgs } = await listen()
    await sleep(200)
    ws.close()
    const snap = msgs.find(m => m.type === 'snapshot')
    expect(snap.activeAgents.map((a: any) => a.id)).not.toContain('agent-g1')
    expect(snap.activeAgents.map((a: any) => a.id)).toContain('agent-r1')
    expect((await health()).agents).toBeGreaterThan(0) // still in grace
  })
})

describe('stale sweep', () => {
  // Sweep checks every STALE/2 = 300 ms: a silent agent goes by ~0.9 s
  const { post, listen, health } = office(3592, { AGENT_OFFICE_STALE_MS: '600' })
  const about = (msgs: any[], id: string) => msgs.filter(m => m.agentId === id || m.agent?.id === id).map(m => m.type)

  it('a swept agent that speaks again comes back; only SubagentStop is final', async () => {
    const { ws, msgs } = await listen()
    await post({ type: 'agent_spawned', agent: { id: 'agent-long', role: 'Explore' } })
    await sleep(1500)
    expect(about(msgs, 'agent-long')).toEqual(['agent_spawned', 'chat_message', 'agent_completed'])
    expect(msgs.filter(m => m.type === 'chat_message' && m.agentId === 'agent-long').map(m => m.text)).toEqual(['started']) // the sweep leaves quietly
    expect((await health()).agents).toBe(0) // swept = gone at once, no exit grace to block a return
    await post({ type: 'agent_working', agentId: 'agent-long', role: 'Explore', status: 'reading a.ts' })
    await sleep(100)
    expect(about(msgs, 'agent-long').slice(3)).toEqual(['agent_spawned', 'agent_working'])
    await post({ type: 'agent_completed', agentId: 'agent-long' })
    await post({ type: 'agent_working', agentId: 'agent-long', status: 'x' })
    await sleep(100)
    ws.close()
    expect(about(msgs, 'agent-long').filter(t => t === 'agent_spawned')).toHaveLength(2) // no ghost after the real stop
  })

  it('any tool event with its id keeps a working agent off the sweep', async () => {
    const { ws, msgs } = await listen()
    await post({ type: 'agent_spawned', agent: { id: 'agent-hb', role: 'Explore' } })
    for (let i = 0; i < 8; i++) {
      await post(i % 2 ? { type: 'agent_seen', agentId: 'agent-hb' } : { type: 'agent_working', agentId: 'agent-hb', status: i ? '' : 'reading a.ts' })
      await sleep(250)
    }
    ws.close()
    expect(about(msgs, 'agent-hb')).not.toContain('agent_completed')
    expect(msgs.some(m => m.type === 'agent_seen')).toBe(false) // heartbeats stay server-side
  })
})

describe('step age cap', () => {
  // Open steps older than AGENT_OFFICE_STEP_MS (10 min live, 500 ms here) drop out of the bubble
  const { post, listen } = office(3594, { AGENT_OFFICE_STEP_MS: '500' })

  it('a step older than 10 min no longer shows once the newer step closes (Jim and subagents)', async () => {
    const { ws, msgs } = await listen()
    const ids = ['assistant-claude', 'agent-c1']
    for (const agentId of ids) await post({ type: 'agent_working', agentId, status: 'reading old.md', stepId: 'old', sessionId: 'dead' }) // never closed
    await sleep(700)
    for (const agentId of ids) {
      await post({ type: 'agent_working', agentId, status: 'Run the build', stepId: 'new', sessionId: 'S' })
      await post({ type: 'agent_working', agentId, status: '', stepId: 'new', sessionId: 'S' })
    }
    await sleep(100)
    ws.close()
    for (const agentId of ids)
      expect(msgs.filter(m => m.type === 'agent_working' && m.agentId === agentId).map(m => m.status)).toEqual(['reading old.md', 'Run the build', ''])
  })
})

describe('sounds', () => {
  // Owner's rule (2i): sound only when you click (bell, coffee, a person) or ask a session ("on it")
  const app = readFileSync(join(ROOT, 'src/App.tsx'), 'utf8')
  const sounds = readFileSync(join(ROOT, 'src/sounds.ts'), 'utf8')
  it("only your clicks and prompts play a sound", () => {
    expect(app.match(/sfx\.play\w+/g)).toEqual(['sfx.playBell', 'sfx.playNotification', 'sfx.playCoffee', 'sfx.playOnIt', 'sfx.playPerson', 'sfx.playPerson'])
    // 2o: the one extra, Dwight's click when you pick a prank in Jim's panel
    expect(app).toMatch(/k => \{ sfx\.playPerson\(sfx\.pitchOf\('regular-dwight-schrute'\)\); playLines\(PRANKS\[k\]\) \}/)
    // "on it" only on the server's prompt flag, in that session's person's pitch
    expect(app).toMatch(/if \(event\.type === 'session_changed' && event\.prompt\) sfx\.playOnIt\(sfx\.pitchOf\(personOf\(event as SessionView\)\)\)/)
    // a person: in the character click, on open only (never the closing second click)
    expect(app).toMatch(/onClick=\{\(\) => \{ if \(panelId !== agent\.id\) sfx\.playPerson\(sfx\.pitchOf\(agent\.id\)\);/)
  })

  it('the AudioContext is made only on a page pointerdown: before any click nothing plays or queues', () => {
    expect(sounds.match(/new AudioContext/g)).toHaveLength(1)
    expect(sounds).toMatch(/addEventListener\('pointerdown', \(\) => \{ \(ctx \?\?= new AudioContext\(\)\)/)
    expect(sounds).toMatch(/if \(masterVolume === 0 \|\| !ctx\) return/)
  })

  it("a session's person: its regular's seat, else its walker; pitch fixed per person, different between people", () => {
    expect(personOf({ sessionId: 'x', seat: 1 } as SessionView)).toBe('regular-jim-halpert')
    expect(personOf({ sessionId: 'x', seat: null } as SessionView)).toBe('session-x')
    const ids = [BOSS_ID, ...REGULARS.map(s => `regular-${s}`), 'session-a', 'session-b']
    expect(ids.map(pitchOf)).toEqual(ids.map(pitchOf))
    expect(new Set(ids.map(pitchOf)).size).toBe(ids.length)
    for (const p of ids.map(pitchOf)) expect(p).toBeGreaterThanOrEqual(300), expect(p).toBeLessThan(800)
  })
})

// ---------------------------------------------------------------------------
// Row 2a2: the office shows only real things
// ---------------------------------------------------------------------------
describe('real only: hook', () => {
  it('a step starts on PreToolUse with readable text, never a Bash command or an MCP server id', () => {
    const bash = py({ hook_event_name: 'PreToolUse', tool_name: 'Bash', agent_id: 'abc', agent_type: 'Explore', tool_input: { command: 'rm -rf /tmp/x && npm run build', description: 'Run the build' } }) as any
    expect(bash).toMatchObject({ type: 'agent_working', agentId: 'agent-abc', status: 'Run the build' })
    expect((py({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'rm -rf /tmp/x' } }) as any).status).toBe('running a command')
    expect((py({ hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: { file_path: '/a/b/STATUS.md' } }) as any).status).toBe('reading STATUS.md')
    const mcp = py({ hook_event_name: 'PreToolUse', tool_name: 'mcp__109c69bd-10a6-448a-b64b-7234dd18ad2f__ZohoMail_SearchEmails', tool_input: {} }) as any
    expect(mcp).toMatchObject({ type: 'agent_working', agentId: 'assistant-claude', status: 'ZohoMail SearchEmails' })
  })

  it('a step ends on PostToolUse and PostToolUseFailure (subagent and main session)', () => {
    for (const hook_event_name of ['PostToolUse', 'PostToolUseFailure'])
      for (const tool_name of ['Read', 'Write', 'Edit', 'Bash', 'Grep', 'Glob', 'Skill', 'mcp__srv__tool']) {
        expect(py({ hook_event_name, tool_name, agent_id: 'abc', agent_type: 'Explore' }), `${hook_event_name} ${tool_name}`)
          .toMatchObject({ type: 'agent_working', agentId: 'agent-abc', status: '' })
        expect(py({ hook_event_name, tool_name }), `main ${hook_event_name} ${tool_name}`)
          .toMatchObject({ type: 'agent_working', agentId: 'assistant-claude', status: '' })
      }
  })

  it('SubagentStop result: last_assistant_message, else only the LAST assistant entry (never earlier narration)', () => {
    const stop = (extra: object) => (py({ hook_event_name: 'SubagentStop', agent_id: 'abc', agent_type: 'Explore', ...extra }) as any).result
    expect(stop({ last_assistant_message: '\n  Fixed   the login\tbug.  \nDetails follow' })).toBe('Fixed the login bug.')
    expect(stop({ last_assistant_message: 'x'.repeat(300) })).toHaveLength(100)
    const tr = join(mkdtempSync(join(tmpdir(), 'office-tr-')), 'agent.jsonl')
    const final = (last: object) => {
      writeFileSync(tr, [
        { type: 'user', message: { role: 'user', content: 'go' } },
        { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'Let me check the ports.' }] } },
        { type: 'assistant', message: { role: 'assistant', content: [last] } },
        { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] } },
        'not json',
      ].map(l => typeof l === 'string' ? l : JSON.stringify(l)).join('\n') + '\n')
      return stop({ last_assistant_message: ' \n', agent_transcript_path: tr })
    }
    const out = (input: object) => final({ type: 'tool_use', id: 't1', name: 'StructuredOutput', input })
    expect(final({ type: 'text', text: '\nFound   3 callers.\nMore' })).toBe('Found 3 callers.')
    expect(out({ summary: 'Approved:  no blockers.\nDetails', result: 'x', verdict: 'approve' })).toBe('Approved: no blockers.')
    expect(out({ result: 'Row built,\ttests green\nmore', ok: true })).toBe('Row built, tests green')
    expect(out({ verdict: 'approve', blockers: [], fixes: ['a', 'b'], notes: { a: 1 }, ok: true })).toBe('verdict: approve, blockers: 0, fixes: 2, ok: true')
    expect(out({ verdict: 'x'.repeat(300) })).toHaveLength(100)
    expect(final({ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'lsof -i :3334' } })).toBe('')
    expect(stop({ last_assistant_message: '', agent_transcript_path: join(tr, '..', 'missing.jsonl') })).toBe('')
    expect(stop({})).toBe('')
  })

  it('an Agent call with no description invents no job', () => {
    expect((py({ hook_event_name: 'PreToolUse', tool_name: 'Agent', tool_input: { subagent_type: 'Explore', prompt: 'You are the fixer. Read the plan' } }) as any).task).toBe('')
  })
})

describe('real only: replayed hook payloads', () => {
  const { listen, home } = office(3593)
  const hook = (payload: object) => spawnSync('bash', [join(ROOT, 'hooks/agent-tracker.sh')], {
    input: JSON.stringify(payload), env: { ...process.env, HOME: home, AGENT_OFFICE_URL: 'http://127.0.0.1:3593' },
  })

  const replay = async (payloads: object[]) => {
    for (const p of payloads) {
      const r = hook(p)
      expect(r.status).toBe(0)
      expect(r.stdout.toString()).toBe('')
      await sleep(150) // the hook posts in the background
    }
    await sleep(200)
  }
  const bubbles = (msgs: any[], id: string) => msgs.filter(m => m.type === 'agent_working' && m.agentId === id).map(m => m.status)

  it('one start line with the job and one finish line with the real result per agent; bubbles follow real steps', async () => {
    const { ws, msgs } = await listen()
    const steps: object[] = [
      { hook_event_name: 'PreToolUse', tool_name: 'Agent', tool_input: { description: 'Map the hook code', subagent_type: 'Explore' } },
      { hook_event_name: 'SubagentStart', agent_id: 'r1', agent_type: 'Explore' },
      { hook_event_name: 'PreToolUse', tool_name: 'Bash', agent_id: 'r1', agent_type: 'Explore', tool_input: { command: 'rm -rf /tmp/secret', description: 'Run the build' } },
      { hook_event_name: 'PostToolUse', tool_name: 'Bash', agent_id: 'r1', agent_type: 'Explore' },
      { hook_event_name: 'PreToolUse', tool_name: 'Read', agent_id: 'r1', agent_type: 'Explore', tool_input: { file_path: '/x/STATUS.md' } },
      { hook_event_name: 'PostToolUseFailure', tool_name: 'Read', agent_id: 'r1', agent_type: 'Explore' },
      { hook_event_name: 'SubagentStop', agent_id: 'r1', agent_type: 'Explore', last_assistant_message: 'Hooks live in hooks/.\nMore detail' },
      { hook_event_name: 'SubagentStart', agent_id: 'r2', agent_type: 'general-purpose' },
      { hook_event_name: 'SubagentStop', agent_id: 'r2', agent_type: 'general-purpose' },
    ]
    await replay(steps)
    ws.close()
    const lines = (id: string) => msgs.filter(m => m.type === 'chat_message' && m.agentId === id).map(m => m.text)
    expect(lines('agent-r1')).toEqual(['started: Map the hook code', '✅ finished: Hooks live in hooks/.'])
    expect(lines('agent-r2')).toEqual(['started', '✅ finished'])
    expect(msgs.filter(m => m.type === 'agent_working' && m.agentId === 'agent-r1').map(m => m.status))
      .toEqual(['Run the build', '', 'reading STATUS.md', ''])
    expect(JSON.stringify(msgs)).not.toMatch(/rm -rf|done: done/)
  })

  it('parallel steps: a Post closes only its own step, bubble = the latest still open; a fresh page gets it in the snapshot', async () => {
    const { ws, msgs } = await listen()
    const sub = { agent_id: 'p1', agent_type: 'Explore', session_id: 'S' }
    await replay([
      { hook_event_name: 'SubagentStart', ...sub },
      { hook_event_name: 'PreToolUse', tool_name: 'Read', tool_use_id: 't1', tool_input: { file_path: '/x/a.md' }, ...sub },
      { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_use_id: 't2', tool_input: { description: 'Run the build' }, ...sub },
      { hook_event_name: 'PostToolUse', tool_name: 'Read', tool_use_id: 't1', ...sub },
      { hook_event_name: 'PreToolUse', tool_name: 'Grep', tool_use_id: 't3', tool_input: { pattern: 'todo' }, ...sub },
      { hook_event_name: 'PostToolUseFailure', tool_name: 'Grep', tool_use_id: 't3', ...sub },
      { hook_event_name: 'PreToolUse', tool_name: 'Read', tool_use_id: 'j1', session_id: 'S', tool_input: { file_path: '/x/STATUS.md' } },
    ])
    ws.close()
    expect(bubbles(msgs, 'agent-p1')).toEqual(['reading a.md', 'Run the build', 'Run the build', "searching for 'todo'", 'Run the build'])
    const page = await listen() // a page opened (or reloaded) now
    await sleep(200)
    page.ws.close()
    expect(page.msgs.find(m => m.type === 'snapshot').bubbles).toMatchObject({ 'agent-p1': 'Run the build', 'assistant-claude': 'reading STATUS.md' })
    await replay([{ hook_event_name: 'PostToolUse', tool_name: 'Read', tool_use_id: 'j1', session_id: 'S' }])
  })

  it("the main session's Stop clears only that session's Jim steps", async () => {
    const { ws, msgs } = await listen()
    await replay([
      { hook_event_name: 'PreToolUse', tool_name: 'Read', tool_use_id: 'a1', session_id: 'A', tool_input: { file_path: '/x/a.md' } },
      { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_use_id: 'b1', session_id: 'B', tool_input: { description: 'Run the build' } },
      { hook_event_name: 'Stop', session_id: 'B', stop_hook_active: false }, // B's turn ended with b1 still open
      { hook_event_name: 'Stop', session_id: 'A', stop_hook_active: false },
    ])
    ws.close()
    expect(bubbles(msgs, 'assistant-claude')).toEqual(['reading a.md', 'Run the build', 'reading a.md', ''])
  })
})

describe('real only: office', () => {
  const src = (f: string) => readFileSync(join(ROOT, f), 'utf8')
  const files = (spawnSync('git', ['ls-files', 'src', 'server'], { cwd: ROOT }).stdout.toString().trim().split('\n'))
    .filter(f => /\.(ts|tsx|js)$/.test(f) && !f.endsWith('.test.ts'))

  it('randomness only picks looks: cast members (theme.ts), click-sound pitch (sounds.ts), chat flavour lines + timing (chatter.ts, 2f)', () => {
    expect(files.filter(f => src(f).includes('Math.random')).sort()).toEqual(['src/chatter.ts', 'src/sounds.ts', 'src/theme.ts'])
  })

  it('no ?sim / ?video modes, random events, props, cats or effect bubbles', () => {
    const all = files.map(src).join('\n')
    expect(all).not.toMatch(/isSimMode|isVideoMode|video-mode|OFFICE_SIM|SIM_CHATTER|pickEvent|RANDOM_EVENTS|OFFICE_EVENTS|DRAMA_CONVERSATIONS/)
    expect(all).not.toMatch(/OFFICE_PROPS_BY_SLUG|getOfficePropForRole|getAngelaCat|angela-cat|EffectBubble|getEffect|sprites\/effects|office\/cats/)
    expect(all).not.toMatch(/clocked in|workMessage|coffeeMessage|waterMessage|bossReplies/)
  })

  it('no leftovers: whitespace-only lines in interactions.ts, sim/video/mcp_call/mcp_done in TEST_PLAN.md', () => {
    expect(src('src/interactions.ts')).not.toMatch(/^[ \t]+$/m)
    expect(src('TEST_PLAN.md')).not.toMatch(/\?sim|sim mode|video|mcp_call|mcp_done/i)
  })

  it('no head bubble anywhere: the session panel takes over the click (2d)', () => {
    const all = spawnSync('git', ['ls-files', 'src'], { cwd: ROOT }).stdout.toString().trim().split('\n')
      .filter(f => !f.endsWith('.test.ts')).map(f => { try { return readFileSync(join(ROOT, f), 'utf8') } catch { return '' } }).join('\n')
    expect(all).not.toMatch(/speech-bubble|toggleBubble|openBubble|stepBubble|bubbleOpen|STEP_BACKSTOP/)
  })

  it('session panel states in plain words', () => {
    expect(stateWords('working')).toBe('Working')
    expect(stateWords('idle')).toBe('Idle')
    expect(stateWords('waiting', 'turn_ended')).toBe('Waiting on you: turn ended')
    expect(stateWords('waiting', 'needs_input')).toBe('Needs your OK')
  })

  it('session panel: busy with agents still running reads Working, not Idle (2k)', () => {
    expect(stateWords('idle', undefined, false, 0)).toBe('Idle')
    expect(stateWords('working', undefined, true, 0)).toBe('Working')
    expect(stateWords('idle', undefined, true, 1)).toBe('Working · 1 agent')
    expect(stateWords('idle', undefined, true, 3)).toBe('Working · 3 agents')
    expect(stateWords('idle', undefined, true, 0)).toBe('Working')
    expect(stateWords('waiting', 'turn_ended', true, 1)).toBe('Waiting on you: turn ended')
    expect(stateWords('waiting', 'needs_input', true, 2)).toBe('Needs your OK')
  })

  it('parallel agents with the same text in the same ms keep both chat lines (key = server id)', () => {
    const ts = 1790737507873
    const one = { id: 71, agentId: 'agent-a', timestamp: ts, text: 'started' }
    const two = { id: 72, agentId: 'agent-b', timestamp: ts, text: 'started' }
    expect(chatKey(one)).not.toBe(chatKey(two))
    expect(chatKey({ ...one })).toBe(chatKey(one)) // same event re-run (StrictMode) still dedups
    expect(chatKey({ agentId: 'agent-a', timestamp: ts, text: 'started' }))
      .not.toBe(chatKey({ agentId: 'agent-b', timestamp: ts, text: 'started' }))
  })

  it('walks 2x faster (WALK_SPEED 0.16): door -> farthest desk is half the old time', () => {
    expect(WALK_SPEED).toBe(0.16)
    const secs = (s: Pt) => walked(room.entryPoint, s).reduce((t, p, i, pts) => i ? t + Math.hypot(p.x - pts[i - 1].x, p.y - pts[i - 1].y) : 0, 0) / (WALK_SPEED * 60)
    const far = Math.max(...room.agentSpots.filter(s => s.type === 'desk').map(secs))
    console.log(`door -> farthest desk: ${far.toFixed(1)} s`)
    expect(far).toBeGreaterThan(3) // 7.1 s at 60 fps (was 14.2 s at 0.08)
    expect(far).toBeLessThan(8)
  })
})

describe('fixed team, one regular per session (2c)', () => {
  const SEATS: Record<string, string> = {
    'regular-jim-halpert': 'spot-3', 'regular-dwight-schrute': 'spot-2', 'regular-andy-bernard': 'spot-1', 'regular-stanley-hudson': 'spot-6',
    'regular-phyllis-vance': 'spot-5', 'regular-creed-bratton': 'spot-4', 'regular-kevin-malone': 'spot-7', 'regular-angela-martin': 'spot-8',
    'regular-oscar-martinez': 'spot-9', 'regular-meredith-palmer': 'spot-10', 'regular-pam-beesly': 'spot-reception',
  }
  const ORDER = ['dwight-schrute', 'jim-halpert', 'pam-beesly', 'kevin-malone', 'angela-martin', 'oscar-martinez', 'stanley-hudson', 'phyllis-vance', 'andy-bernard', 'creed-bratton', 'meredith-palmer']
  const view = (sessionId: string, seat: number | null, busy = true, currentStep = '', state = busy ? 'working' : 'idle'): SessionView =>
    ({ sessionId, state, seat, busy, runningAgents: 0, currentStep })
  const back = (sessionId: string, seat: number | null): SessionView => ({ ...view(sessionId, seat, false), state: 'back' })
  const start = () => [createBoss(), ...createRegulars(room.agentSpots)]
  const find = (agents: Agent[], id: string) => agents.find(a => a.id === id)!
  const NEVER_DEALT = [...ORDER, 'michael-scott']
  const app = () => readFileSync(join(ROOT, 'src/App.tsx'), 'utf8')

  it('11 regulars at their seats from load (Jim at spot-3 facing Dwight at spot-2, Pam at reception), none walking; Michael drawn at boss-home; no assistant-claude', () => {
    setTheme('office')
    const regs = createRegulars(room.agentSpots)
    expect(regs.map(a => a.id).sort()).toEqual(Object.keys(SEATS).sort())
    for (const a of regs) {
      const s = room.agentSpots.find(s => s.id === SEATS[a.id])!
      expect(a.position, a.id).toEqual({ x: s.x, y: s.y })
      expect(a.pathQueue ?? [], a.id).toEqual([])
      expect(seatedAtDesk(a), a.id).toBe(true)
      expect(a.state, a.id).toBe('idle')
    }
    expect([...REGULARS]).toEqual(ORDER)
    for (const s of ORDER) expect(getSpritePath(`regular-${s}`, 'default', 'employee-3', 'front-right')).toContain(`/${s}-front-right.png`)
    const home = room.agentSpots.find(s => s.id === 'boss-home')!
    const boss = createBoss()
    expect(boss.position).toEqual({ x: home.x, y: home.y })
    expect(boss.position).toEqual({ x: 12.5, y: 80 }) // 2h: his desk chair
    // Faces his desk + monitor, up-right on screen: that is the 'rear-left' sprite (sheet names are his left/right)
    const desk = room.furniture.find(f => f.id === 'boss-desk')!
    expect(desk.x > home.x && desk.y < home.y).toBe(true)
    expect(boss.spriteFacing).toBe(getDirectionFromDelta(desk.x - home.x, desk.y - home.y))
    expect(boss.spriteFacing).toBe('rear-left')
    expect(getSpritePath(BOSS_ID, 'boss', 'employee-3', boss.spriteFacing!)).toContain('/michael-scott-rear-left.png')
    expect(seatDraw(boss)).toBe(BOSS_SEAT) // drawn seated from load
    expect(boss.position).not.toEqual(room.entryPoint)
    expect(boss.pathQueue ?? []).toEqual([])
    expect(boss.state).toBe('idle')
    expect(seatedAtDesk(boss)).toBe(true) // standing still at home, not walking
    expect(app()).toMatch(/\{agents\.map\(agent => \{/) // everyone drawn, Michael included
    expect(app()).not.toMatch(/drawn/)
    expect(REQUIRED.some(s => s.id === 'spot-reception')).toBe(true)
    expect(REQUIRED.some(s => s.id === 'boss-home')).toBe(true)
    expect(start().some(a => a.id === 'assistant-claude' || a.role === 'assistant')).toBe(false)
  })

  it('a boss click walk (every click target) ends back in his chair, idle, seated, facing his desk (up-right); a desk click walks nowhere', () => {
    const home = room.agentSpots.find(s => s.id === 'boss-home')!
    // What App does per frame (stepToward along the queue; arrival at deskPosition follows busy)
    const walk = (a: Agent): Agent => {
      for (let i = 0; i < 100_000; i++) {
        const q = a.pathQueue ?? []
        const { position, arrived } = stepToward(a.position, q[0] ?? a.targetPosition, WALK_SPEED)
        a = { ...a, position, pathQueue: arrived && q.length ? q.slice(1) : q }
        if (arrived && !q.length) {
          const atDesk = a.targetPosition.x === a.deskPosition.x && a.targetPosition.y === a.deskPosition.y
          return atDesk ? { ...a, state: a.busy === false ? 'idle' : 'working' } : a
        }
      }
      throw new Error('never arrived')
    }
    const ids = ['whiteboard', ...room.furniture.map(f => f.id)].filter(id => getInteraction(id))
    expect(ids.length).toBeGreaterThan(15)
    for (const id of ids) {
      const target = getInteraction(id)!.walkTo
      const going = redirect(createBoss(), target, WP)
      if (going.pathQueue?.length) expect(seatDraw(going), id).toBeUndefined() // up and walking: full sprite
      const there = walk(going)
      expect(there.position, id).toEqual(target)
      if (id !== 'boss-desk') expect(seatDraw(there), id).toBeUndefined() // standing at the item
      const back = walk(redirect(there, there.deskPosition, WP))
      expect(back.position, id).toEqual({ x: home.x, y: home.y })
      expect(back.state, id).toBe('idle')
      expect(seatedAtDesk(back), id).toBe(true)
      expect(back.spriteFacing, id).toBe('rear-left')
      expect(seatDraw(back), id).toBe(BOSS_SEAT)
    }
    const desk = redirect(createBoss(), getInteraction('boss-desk')!.walkTo, WP)
    expect(desk.pathQueue).toEqual([])
    expect(desk.position).toEqual({ x: home.x, y: home.y })
    expect(app()).toMatch(/walkTo\(a, a\.deskPosition\)/) // App's walk-back target
  })

  it('2n: the session title rides on its regular (sessionTitle); back clears it', () => {
    let agents = applySession(start(), { ...view('A', 1), title: 'Row 2h', appId: 'local_x' })
    expect(find(agents, 'regular-jim-halpert').sessionTitle).toBe('Row 2h')
    agents = applySession(agents, { ...view('A', 1), title: 'Row 2h renamed' })
    expect(find(agents, 'regular-jim-halpert').sessionTitle).toBe('Row 2h renamed')
    agents = applySession(agents, back('A', 1))
    expect(find(agents, 'regular-jim-halpert').sessionTitle).toBeUndefined()
  })
  it('session_changed seat 1 busy → Jim works at his desk (no walk) with the current step; not busy → idle, no text; back → unbound, same seat', () => {
    const before = start()
    let agents = applySession(before, view('A', 1, true, 'reading STATUS.md'))
    expect(agents).toHaveLength(before.length)
    let jim = find(agents, 'regular-jim-halpert')
    expect(jim).toMatchObject({ session: 'A', state: 'working', statusText: 'reading STATUS.md' })
    expect(jim.position).toEqual(find(before, jim.id).position)
    expect(seatedAtDesk(jim)).toBe(true)
    expect(agents.filter(a => a.session)).toHaveLength(1)
    agents = applySession(agents, view('A', 1, true, 'running the build'))
    expect(find(agents, jim.id).statusText).toBe('running the build')
    agents = applySession(agents, view('A', 1, false))
    expect(find(agents, jim.id)).toMatchObject({ session: 'A', state: 'idle', statusText: '' })
    agents = applySession(agents, back('A', 1))
    jim = find(agents, jim.id)
    expect(jim.session).toBeUndefined()
    expect(jim).toMatchObject({ state: 'idle', statusText: '' })
    expect(jim.position).toEqual(find(before, jim.id).position)
    expect(seatedAtDesk(jim)).toBe(true)
    // seat n → REGULARS[n]
    for (let n = 0; n < 11; n++) expect(applySession(start(), view(`S${n}`, n)).find(a => a.session === `S${n}`)!.id).toBe(`regular-${ORDER[n]}`)
  })

  it('seat null → a cast walker (never a regular, Jim or Michael) walks in from the door to overflow, follows busy, walks out on back', () => {
    setTheme('default'); setTheme('office')
    let agents = applySession(start(), view('L', null, true, 'reading a.md'))
    const w = agents.find(a => a.session === 'L')!
    expect(w.id).toBe('session-L')
    expect(w.state).toBe('new-hire')
    expect(w.position).toEqual(room.entryPoint)
    expect(room.agentSpots.find(s => s.id === w.assignedSpotId)!.type).toBe('overflow')
    expect(w.pathQueue!.length).toBeGreaterThan(0)
    expect(w.statusText).toBe('reading a.md')
    expect(agents.filter(a => a.session)).toHaveLength(1) // no regular bound
    const slug = getSpritePath(w.id, w.role, 'employee-3', 'front-right').split('/').pop()!.replace('-front-right.png', '')
    expect(NEVER_DEALT).not.toContain(slug)
    agents = applySession(agents, view('L', null, false))
    expect(find(agents, w.id)).toMatchObject({ state: 'new-hire', statusText: '', busy: false }) // still walking in
    const seatedW = { ...find(agents, w.id), state: 'working' as const, position: w.targetPosition, pathQueue: [] }
    agents = agents.map(a => a.id === w.id ? seatedW : a)
    expect(find(applySession(agents, view('L', null, false)), w.id).state).toBe('idle')
    expect(find(applySession(agents, view('L', null, true)), w.id).state).toBe('working')
    expect(arrive({ ...seatedW, busy: true }, seatedW.position).state).toBe('working') // arrival at its spot follows busy
    expect(arrive(seatedW, seatedW.position).state).toBe('idle')
    const out = find(applySession(agents, back('L', null)), w.id)
    expect(out.state).toBe('completed')
    expect(out.statusText).toBe('')
    expect(out.targetPosition).toEqual(room.entryPoint)
  })

  it('agent_spawned / agent_working / agent_completed add, move or change no character; a snapshot without session X frees X', () => {
    const src = app()
    expect(src).not.toMatch(/case 'agent_spawned'|case 'agent_working'|case 'agent_completed'|spawnJob|finishJob|resolveJob|staleIds/)
    expect(src).toMatch(/case 'session_changed':\s*return applySession\(prev, event/)
    let agents = applySession(applySession(applySession(start(), view('A', 0)), view('B', 1)), view('L', null))
    const stale = staleSessions(agents, new Set(['B']))
    expect(stale.sort()).toEqual(['A', 'L'])
    for (const id of stale) agents = applySession(agents, back(id, null))
    expect(agents.filter(a => a.session && a.state !== 'completed').map(a => a.id)).toEqual(['regular-jim-halpert'])
    expect(find(agents, 'regular-dwight-schrute').session).toBeUndefined()
    expect(find(agents, 'session-L').state).toBe('completed')
    expect(staleSessions(agents, new Set(['B']))).toEqual([])
  })

  it("a chat line with a sessionId is sent by that session's character; else today's fallback", () => {
    const agents = applySession(start(), view('A', 1))
    expect(speakerOf(agents, { sessionId: 'A', agentId: 'agent-x' })!.id).toBe('regular-jim-halpert')
    expect(speakerOf(agents, { sessionId: 'nope', agentId: 'agent-x' })).toBeUndefined()
    expect(speakerOf(agents, { agentId: 'regular-pam-beesly' })!.id).toBe('regular-pam-beesly')
    expect(speakerOf(agents, {})).toBeUndefined()
    expect(app()).toMatch(/speakerOf\(prev, event/)
  })
})

describe('2e walk: waiting sessions queue at the boss\'s door', () => {
  const view = (sessionId: string, seat: number | null, state: string, busy = state === 'working'): SessionView =>
    ({ sessionId, state, seat, busy, runningAgents: 0, currentStep: '' })
  const start = () => [createBoss(), ...createRegulars(room.agentSpots)]
  const find = (agents: Agent[], id: string) => agents.find(a => a.id === id)!
  const spot = (id: string) => { const s = room.agentSpots.find(s => s.id === id)!; return { x: s.x, y: s.y } }
  const JIM = 'regular-jim-halpert'
  // Walk until the path empties, then arrive (the App tick loop in one go)
  const land = (a: Agent) => arrive({ ...a, pathQueue: [] }, a.targetPosition)
  const landAll = (agents: Agent[]) => agents.map(a => a.pathQueue?.length || a.position.x !== a.targetPosition.x || a.position.y !== a.targetPosition.y ? land(a) : a)

  it('4 wait spots: boss-door-wait first, standing, facing his door, clear of the overflow floor', () => {
    expect(WAIT_SPOTS.map(s => s.id)).toEqual(['boss-door-wait', 'boss-wait-2', 'boss-wait-3', 'boss-wait-4'])
    for (const s of WAIT_SPOTS) {
      expect(s.type, s.id).toBe('standing')
      expect(s.x >= 36 && s.x <= 44 && s.y >= 77 && s.y <= 84, `${s.id} on the overflow floor`).toBe(false)
      expect(s.spriteFacing, s.id).toBe(getDirectionFromDelta(28.6 - s.x, 78.2 - s.y)) // toward the door gap
    }
  })

  it('waiting on seat 1 → Jim walks to boss-door-wait; the next waiter gets another spot; past 4 they share the last; nobody types', () => {
    let agents = applySession(start(), view('A', 1, 'waiting'))
    const jim = find(agents, JIM)
    expect(jim.targetPosition).toEqual(spot('boss-door-wait'))
    expect(jim.pathQueue!.length).toBeGreaterThan(0)
    expect(jim).toMatchObject({ session: 'A', sessionState: 'waiting' })
    agents = applySession(agents, view('B', 0, 'waiting', true)) // waiting with an agent running: still no typing
    const dwight = find(agents, 'regular-dwight-schrute')
    expect(dwight.targetPosition).toEqual(spot('boss-wait-2'))
    agents = applySession(agents, view('C', 2, 'waiting'))
    agents = applySession(agents, view('D', 3, 'waiting'))
    agents = applySession(agents, view('E', 4, 'waiting'))
    agents = applySession(agents, view('L', null, 'waiting')) // an overflow walker queues too
    const waiters = ['A', 'B', 'C', 'D', 'E', 'L'].map(id => agents.find(a => a.session === id)!)
    expect(waiters.map(a => WAIT_SPOTS.find(s => s.x === a.targetPosition.x && s.y === a.targetPosition.y)?.id))
      .toEqual(['boss-door-wait', 'boss-wait-2', 'boss-wait-3', 'boss-wait-4', 'boss-wait-4', 'boss-wait-4'])
    agents = landAll(agents)
    agents = applySession(agents, view('B', 0, 'waiting', true)) // a repeat event keeps the spot
    for (const a of agents.filter(a => a.sessionState === 'waiting')) expect(a.state, a.id).not.toBe('working')
    expect(find(agents, 'regular-dwight-schrute').targetPosition).toEqual(spot('boss-wait-2'))
  })

  it('arrival at a wait spot ends the walk: standing idle there, facing the door, not seated', () => {
    const jim = land(find(applySession(start(), view('A', 1, 'waiting', true)), JIM))
    expect(jim.state).toBe('idle')
    expect(jim.position).toEqual(spot('boss-door-wait'))
    expect(jim.spriteFacing).toBe(WAIT_SPOTS[0].spriteFacing)
    expect(seatedAtDesk(jim)).toBe(false)
  })

  it('waiting → working / idle: back to the desk, typing only when busy; back on a regular at the door: to its desk, idle, unbound', () => {
    const desk = spot('spot-3')
    const facing = room.agentSpots.find(s => s.id === 'spot-3')!.spriteFacing
    const atDoor = landAll(applySession(start(), view('A', 1, 'waiting')))
    for (const [state, busy, want] of [['working', true, 'working'], ['idle', false, 'idle']] as const) {
      const jim = find(applySession(atDoor, view('A', 1, state, busy)), JIM)
      expect(jim.targetPosition, state).toEqual(desk)
      expect(jim.spriteFacing, state).toBe(facing)
      expect(jim.state, state).toBe('walking-to-desk')
      const home = land(jim)
      expect(home.state, state).toBe(want)
      expect(seatedAtDesk(home), state).toBe(true)
    }
    const gone = find(applySession(atDoor, { ...view('A', 1, 'back'), busy: false }), JIM)
    expect(gone.session).toBeUndefined()
    expect(gone.targetPosition).toEqual(desk)
    const home = land(gone)
    expect(home.state).toBe('idle')
    expect(seatedAtDesk(home)).toBe(true)
  })

  it('back on a waiting overflow walker walks it out the door', () => {
    const agents = landAll(applySession(start(), view('L', null, 'waiting')))
    expect(find(agents, 'session-L').position).toEqual(spot('boss-door-wait'))
    const out = find(applySession(agents, view('L', null, 'back')), 'session-L')
    expect(out.state).toBe('completed')
    expect(out.targetPosition).toEqual(room.entryPoint)
  })
})

// ---------------------------------------------------------------------------
// Row 2p-wire: everyone sits at a sit-down desk, facing its own PC
// ---------------------------------------------------------------------------
describe('2p: seated at sit-down desks, each facing its own PC', () => {
  const CSS = { x: 100 / ROOM_PX.w, y: 100 / ROOM_PX.h } // 1 css px in room %
  type V = 'left-front' | 'right-front' | 'left-rear' | 'right-rear' | 'reception'
  // From the desk anchor, css px (art kit furn2p.py): the sitter's floor point and the monitor's floor point
  const SITTER: Record<V, [number, number]> = { 'left-front': [18.2, -13.3], 'right-front': [-18.2, -13.3], 'left-rear': [-20.9, -34.6], 'right-rear': [20.9, -34.6], reception: [11.38, -28.04] }
  const MONITOR: Record<V, [number, number]> = { 'left-front': [-4.25, -24.2], 'right-front': [4.25, -24.2], 'left-rear': [4.9, -21.1], 'right-rear': [-4.9, -21.1], reception: [-25.93, -27.28] }
  const CAST: Record<V, string> = { 'left-front': 'rear-right', 'right-front': 'rear-left', 'left-rear': 'front-left', 'right-rear': 'front-right', reception: 'front-right' }
  const CHAIR: Record<V, string> = { 'left-front': 'rear-left', 'right-front': 'rear-right', 'left-rear': 'front-right', 'right-rear': 'front-left', reception: 'front-left' }
  const DESKS = room.agentSpots.filter(s => s.type === 'desk')
  const deskOf = (s: typeof DESKS[number]) => room.furniture.find(f => f.id === s.desk)!
  const variant = (s: typeof DESKS[number]) => deskOf(s).sprite.replace('desk-standing-', '') as V
  const deskZ = (s: typeof DESKS[number]) => { const f = deskOf(s); return f.zIndex ?? Math.round(f.y * 10) }
  const sitterZ = (s: typeof DESKS[number]) => s.zIndex! * 10
  const front = (s: typeof DESKS[number]) => variant(s).endsWith('front')
  const land = (a: Agent) => arrive({ ...a, pathQueue: [] }, a.targetPosition)

  it('SEATS: Jim faces Dwight, Andy beside them, Stanley faces Phyllis, accounting 7-9, Creed 4, Meredith 10, Pam at reception', () => {
    expect(SEATS).toEqual({
      'jim-halpert': 'spot-3', 'dwight-schrute': 'spot-2', 'andy-bernard': 'spot-1', 'stanley-hudson': 'spot-6', 'phyllis-vance': 'spot-5',
      'creed-bratton': 'spot-4', 'kevin-malone': 'spot-7', 'angela-martin': 'spot-8', 'oscar-martinez': 'spot-9',
      'meredith-palmer': 'spot-10', 'pam-beesly': 'spot-reception',
    })
  })

  it('each desk spot is its desk\'s sitter point, facing the monitor; its waypoint moves with it', () => {
    expect(DESKS).toHaveLength(11)
    for (const s of DESKS) {
      const f = deskOf(s), v = variant(s)
      expect(f, `${s.id} desk`).toBeTruthy()
      expect(Math.abs(s.x - (f.x + SITTER[v][0] * CSS.x)), `${s.id} x`).toBeLessThanOrEqual(0.05)
      expect(Math.abs(s.y - (f.y + SITTER[v][1] * CSS.y)), `${s.id} y`).toBeLessThanOrEqual(0.05)
      const mon = { x: f.x + MONITOR[v][0] * CSS.x, y: f.y + MONITOR[v][1] * CSS.y }
      expect(s.spriteFacing, s.id).toBe(getDirectionFromDelta(mon.x - s.x, mon.y - s.y))
      expect(s.spriteFacing, s.id).toBe(CAST[v])
      const w = byId.get(s.id === 'spot-reception' ? 'W-reception' : `W-${s.id}`)!
      expect({ x: w.x, y: w.y }, `W-${s.id}`).toEqual({ x: s.x, y: s.y })
      expect(s.zIndex, `${s.id} z`).toBeTruthy()
    }
  })

  it('desk dressing: chair per desk (kit sprite), backs on front desks only, 8 props at their owners\' desks, z from the spot', () => {
    const chairs = DESK_DRESSING.filter(d => d.type === 'office-chair')
    const backs = DESK_DRESSING.filter(d => d.type === 'office-chair-back')
    const props = DESK_DRESSING.filter(d => d.type === 'desk-prop')
    expect(chairs).toHaveLength(11)
    expect(backs).toHaveLength(DESKS.filter(front).length)
    expect(backs).toHaveLength(6) // 2r: Pam inside her counter (no chair back)
    expect(props).toHaveLength(8)
    for (const d of DESK_DRESSING) expect(ASSETS[d.sprite], d.sprite).toBeTruthy()
    for (const s of DESKS) {
      const v = variant(s), z = sitterZ(s)
      const chair = chairs.find(c => c.id === `chair-${s.id}`)!
      expect(chair.sprite, s.id).toBe(`office-chair-${CHAIR[v]}`)
      expect(chair.x).toBe(s.x)
      expect(Math.abs(chair.y - (s.y + 12.2 * CSS.y))).toBeLessThan(0.01)
      expect(chair.zIndex, s.id).toBe(z - 1)
      const back = backs.find(c => c.id === `chair-back-${s.id}`)
      if (front(s)) {
        expect(deskZ(s), `${s.id} desk < chair`).toBeLessThan(chair.zIndex!)
        expect(back?.sprite, s.id).toBe(`office-chair-back-${CHAIR[v]}`)
        expect(back!.zIndex, s.id).toBe(z + 1)
        expect({ x: back!.x, y: back!.y }).toEqual({ x: chair.x, y: chair.y })
      } else {
        expect(back, s.id).toBeUndefined()
        expect(z, `${s.id} sitter < desk`).toBeLessThan(deskZ(s))
      }
    }
    const OWNERS: Record<string, string> = { 'pam-beesly': 'candy-jar', 'dwight-schrute': 'bobblehead', 'kevin-malone': 'mms-jar', 'stanley-hudson': 'crossword',
      'angela-martin': 'cat-frame', 'phyllis-vance': 'knitting', 'jim-halpert': 'stapler-jello', 'andy-bernard': 'cornell-pennant' }
    for (const [slug, prop] of Object.entries(OWNERS)) {
      const s = DESKS.find(s => s.id === SEATS[slug])!, f = deskOf(s), a = ASSETS[f.sprite]
      const p = props.find(p => p.sprite === `prop-${prop}`)!
      expect(p, prop).toBeTruthy()
      expect(p.zIndex, prop).toBe(deskZ(s) + 1)
      // on the desk top (inside the desk sprite, above its floor), clear of the sitter's body column
      expect(Math.abs(p.x - f.x), prop).toBeLessThan(a.width / 2 * CSS.x)
      expect(p.y, prop).toBeLessThan(f.y - 20 * CSS.y)
      expect(p.y, prop).toBeGreaterThan(f.y - a.height * CSS.y)
      expect(Math.abs(p.x - s.x), `${prop} clear of ${slug}`).toBeGreaterThan(10 * CSS.x)
    }
  })

  it('seatDraw: every regular seated at its desk (hip 0.66, hip line 7.5 css above the spot); walking, at the door or overflow: none; Michael unchanged', () => {
    const regs = createRegulars(room.agentSpots)
    for (const a of regs) {
      const s = room.agentSpots.find(s => s.id === a.assignedSpotId)!
      const d = seatDraw(a)!
      expect(d, a.id).toBeTruthy()
      expect(d.x).toBe(s.x)
      expect(Math.abs(d.y - (s.y - 7.5 * CSS.y))).toBeLessThan(0.01)
      expect(d.hip).toBe(0.66)
      expect(seatDraw(redirect(a, { x: 46, y: 64 }, WP)), `${a.id} walking`).toBeUndefined()
    }
    const view = (sessionId: string, seat: number | null, state: string): SessionView => ({ sessionId, state, seat, busy: state === 'working', runningAgents: 0, currentStep: '' })
    const jim = land(applySession(regs, view('A', 1, 'waiting')).find(a => a.id === 'regular-jim-halpert')!)
    expect(jim.position).toEqual({ x: WAIT_SPOTS[0].x, y: WAIT_SPOTS[0].y })
    expect(seatDraw(jim)).toBeUndefined()
    const walker = land(applySession(regs, view('W', null, 'working')).find(a => a.id === 'session-W')!)
    expect(seatedAtDesk(walker)).toBe(true)
    expect(seatDraw(walker)).toBeUndefined()
    expect(seatDraw(createBoss())).toBe(BOSS_SEAT)
    expect(BOSS_SEAT).toEqual({ x: 12.3, y: 76.8, hip: 0.65 })
  })

  it('App (office theme): sit-down desks swap in, dressing drawn, title bar "Clauder Fablin · Scranton" in American Typewriter, old company name gone', () => {
    const app = readFileSync(join(ROOT, 'src/App.tsx'), 'utf8')
    for (const v of Object.keys(SITTER)) {
      expect(ASSETS[`desk-office-${v}`], v).toBeTruthy()
      expect([ASSETS[`desk-office-${v}`].width, ASSETS[`desk-office-${v}`].height]).toEqual([ASSETS[`desk-standing-${v}`].width, ASSETS[`desk-standing-${v}`].height])
    }
    expect(app).toMatch(/desk-standing-/)
    expect(app).toMatch(/desk-office-/)
    expect(app).toMatch(/DESK_DRESSING/)
    expect(app).toMatch(/Clauder Fablin · Scranton/)
    for (const f of ['src/App.tsx', 'src/chatter.ts', 'src/components/SlackChat.tsx']) expect(readFileSync(join(ROOT, f), 'utf8'), f).not.toMatch(/[d]under|[m]ifflin/i)
    expect(app).toMatch(/'American Typewriter', serif/)
  })

  it('panel caption: first name only for the regulars and Michael (office theme); anyone else, or the default theme, name only', () => {
    setTheme('office')
    const regs = createRegulars(room.agentSpots)
    const by = (slug: string) => regs.find(a => a.id === `regular-${slug}`)!
    expect(caption(by('jim-halpert'))).toBe('Jim')
    expect(caption(by('dwight-schrute'))).toBe('Dwight')
    expect(caption(by('pam-beesly'))).toBe('Pam')
    for (const s of ['andy-bernard', 'stanley-hudson', 'phyllis-vance', 'kevin-malone', 'oscar-martinez', 'angela-martin', 'creed-bratton', 'meredith-palmer']) expect(caption(by(s))).toBe(by(s).name.split(' ')[0])
    expect(caption(createBoss())).toBe('Michael')
    const walker = applySession(regs, { sessionId: 'W', state: 'working', seat: null, busy: true, runningAgents: 0, currentStep: '' }).find(a => a.id === 'session-W')!
    expect(caption(walker)).toBe(walker.name)
    setTheme('default')
    expect(caption(by('dwight-schrute'))).toBe(by('dwight-schrute').name)
    expect(caption(createBoss())).toBe(createBoss().name)
    setTheme('office')
  })

  it('light: the real clock; night = night art + night tint, every other phase flat day light; no 10-minute demo cycle', () => {
    expect(lightFor('night')).toEqual({ op: 1, overlay: 'night' })
    for (const p of ['dawn', 'morning', 'afternoon', 'evening', 'dusk'] as const) expect(lightFor(p), p).toEqual({ op: 0, overlay: '' })
    const app = readFileSync(join(ROOT, 'src/App.tsx'), 'utf8')
    expect(app).not.toMatch(/CYCLE_MS|10 min|setNightOpacity|nightOpacity/)
    expect(app).toMatch(/lightFor\(/)
    expect(app).toMatch(/setDayPhase\(getCurrentPhase\(\)\)/)
    expect(app).toMatch(/60_000/)
  })
})

describe('2s phase elapsed', () => {
  it('seconds under a minute, else m + s, never negative', () => {
    expect(elapsed(213_400)).toBe('3m 33s')
    expect(elapsed(5_999)).toBe('5s')
    expect(elapsed(60_000)).toBe('1m 0s')
    expect(elapsed(-50)).toBe('0s')
  })
})
