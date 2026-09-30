import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { inflateSync } from 'zlib'
import { join } from 'path'
import { ROOMS } from './rooms'
import { ASSETS } from './assets'
import { DESK_DRESSING, SEATS, SEAT_Z, WAIT_SPOTS, floorHulls, walkerZ } from './agentManager'

// Alpha of an 8-bit RGBA, non-interlaced PNG (every office sprite), stdlib only.
function alpha(file: string) {
  const b = readFileSync(file), w = b.readUInt32BE(16), h = b.readUInt32BE(20), idat: Buffer[] = []
  for (let o = 8; o < b.length; o += 12 + b.readUInt32BE(o)) if (b.toString('ascii', o + 4, o + 8) === 'IDAT') idat.push(b.subarray(o + 8, o + 8 + b.readUInt32BE(o)))
  const raw = inflateSync(Buffer.concat(idat)), row = w * 4, px = Buffer.alloc(row * h), zero = Buffer.alloc(row)
  for (let y = 0; y < h; y++) {
    const f = raw[y * (row + 1)], src = raw.subarray(y * (row + 1) + 1), cur = px.subarray(y * row), up = y ? px.subarray((y - 1) * row) : zero
    for (let i = 0; i < row; i++) {
      const a = i >= 4 ? cur[i - 4] : 0, u = up[i], c = i >= 4 ? up[i - 4] : 0, p = a + u - c
      const paeth = Math.abs(p - a) <= Math.abs(p - u) && Math.abs(p - a) <= Math.abs(p - c) ? a : Math.abs(p - u) <= Math.abs(p - c) ? u : c
      cur[i] = src[i] + [0, a, u, (a + u) >> 1, paeth][f]
    }
  }
  return { w, h, at: (x: number, y: number) => px[y * row + x * 4 + 3] }
}

describe('2r: no seated person is covered by another desk', () => {
  const room = ROOMS['main-office']
  const ROOM_PX = { w: 754, h: 563 }, CSS = { x: 100 / ROOM_PX.w, y: 100 / ROOM_PX.h }
  // What the office theme draws (App.tsx): sit-down desks + their dressing, plants, printer, ...
  const DRAWN = [...room.furniture.map(f => ({ ...f, sprite: f.sprite.replace('desk-standing-', 'desk-office-') })), ...DESK_DRESSING]
    .filter(f => ASSETS[f.sprite])
  const SEATED = room.agentSpots.filter(s => s.desk)

  it('every seated person (11 regulars incl. Pam) is at most 1% covered by any other sprite drawn above them', () => {
    expect(SEATED).toHaveLength(11)
    const bad: string[] = []
    for (const s of SEATED) {
      const slug = Object.keys(SEATS).find(k => SEATS[k] === s.id)!
      const own = new Set([s.desk, `chair-${s.id}`, `chair-back-${s.id}`, `prop-${slug}`])
      // Seated sprite box (seatDraw + Character): 29 css wide, hips 7.5 css above the spot, top 0.66 x 78 css above the hips
      const bottom = s.y - 7.5 * CSS.y, top = bottom - 0.66 * 78 * CSS.y, half = 14.5 * CSS.x, z = s.zIndex! * 10
      let worst = { id: '', area: 0 }
      for (const f of DRAWN) {
        if (own.has(f.id) || (f.zIndex ?? Math.round(f.y * 10)) <= z) continue
        const a = ASSETS[f.sprite], m = alpha(join(__dirname, '../public', a.path))
        const x0 = f.x - a.width / 2 * CSS.x, y0 = f.y - a.height * CSS.y
        let n = 0
        for (let y = 0; y < m.h; y++) {
          const ry = y0 + (y + 0.5) / m.h * a.height * CSS.y
          if (ry <= top || ry >= bottom) continue
          for (let x = 0; x < m.w; x++) if (Math.abs(x0 + (x + 0.5) / m.w * a.width * CSS.x - s.x) < half && m.at(x, y) > 128) n++
        }
        const area = n * (a.width / m.w) * (a.height / m.h) // css px²
        if (area > worst.area) worst = { id: f.id, area }
      }
      if (worst.area > 0.01 * 29 * 0.66 * 78) bad.push(`${s.id} under ${worst.id}: ${worst.area.toFixed(0)} css px²`)
    }
    expect(bad).toEqual([])
  })

  it("nobody waiting at Michael's door or standing on overflow is more than 1% covered by a sprite drawn over them, seats empty or taken", () => {
    const hulls = floorHulls(room.furniture, ROOM_PX)
    // App.tsx: walkers go over / under every desk seat (SEAT_Z), sitter or not, so an empty chair (spot z - 1) can't cover a walker in front of it
    expect(readFileSync(join(__dirname, 'App.tsx'), 'utf8')).toMatch(/seatedNow = \[\.\.\.SEAT_Z,/)
    // ... and a walker resting on its overflow spot (no spot z) draws the same way, not at bare feet z (Dwight's chair hid a head, prover 2026-09-30)
    expect(readFileSync(join(__dirname, 'App.tsx'), 'utf8')).toMatch(/return z \? z \* 10 : walkerZ\(a\.position, hulls, SEAT_Z, roomPx\)/)
    const bad: string[] = []
    for (const s of room.agentSpots.filter(s => s.id.startsWith('boss-wait') || s.id === 'boss-door-wait' || s.type === 'overflow')) {
      // Standing sprite box (Character): 29 css wide, 78 css tall, feet on the spot
      const top = s.y - 78 * CSS.y, half = 14.5 * CSS.x, z = walkerZ(s, hulls, SEAT_Z, ROOM_PX)
      for (const f of DRAWN) {
        if ((f.zIndex ?? Math.round(f.y * 10)) <= z) continue
        const a = ASSETS[f.sprite], m = alpha(join(__dirname, '../public', a.path))
        const x0 = f.x - a.width / 2 * CSS.x, y0 = f.y - a.height * CSS.y
        let n = 0
        for (let y = 0; y < m.h; y++) {
          const ry = y0 + (y + 0.5) / m.h * a.height * CSS.y
          if (ry <= top || ry >= s.y) continue
          for (let x = 0; x < m.w; x++) if (Math.abs(x0 + (x + 0.5) / m.w * a.width * CSS.x - s.x) < half && m.at(x, y) > 128) n++
        }
        const area = n * (a.width / m.w) * (a.height / m.h)
        if (area > 0.01 * 29 * 78) bad.push(`${s.id} under ${f.id}: ${(area / (29 * 78) * 100).toFixed(1)}%`)
      }
    }
    expect(bad).toEqual([])
  })

  it("2r fix 3: the door queue is not covered at all (strict prover rule): 0 px of any sprite drawn over a waiting person's box", () => {
    const hulls = floorHulls(room.furniture, ROOM_PX)
    const bad: string[] = []
    for (const s of WAIT_SPOTS) {
      const top = s.y - 78 * CSS.y, half = 14.5 * CSS.x, z = walkerZ(s, hulls, SEAT_Z, ROOM_PX)
      for (const f of DRAWN) {
        if ((f.zIndex ?? Math.round(f.y * 10)) <= z) continue
        const a = ASSETS[f.sprite], m = alpha(join(__dirname, '../public', a.path))
        const x0 = f.x - a.width / 2 * CSS.x, y0 = f.y - a.height * CSS.y
        let n = 0
        for (let y = 0; y < m.h; y++) {
          const ry = y0 + (y + 0.5) / m.h * a.height * CSS.y
          if (ry <= top || ry >= s.y) continue
          for (let x = 0; x < m.w; x++) if (Math.abs(x0 + (x + 0.5) / m.w * a.width * CSS.x - s.x) < half && m.at(x, y) > 128) n++
        }
        if (n) bad.push(`${s.id} under ${f.id}: ${n} px`)
      }
    }
    expect(bad).toEqual([])
  })

  it("nobody waiting at Michael's door or standing on overflow hides a seated person or stands behind one: at most 1% of any sitter overlaps the standing sprite", () => {
    const bad: string[] = []
    const sitters = SEATED.map(s => {
      const slug = Object.keys(SEATS).find(k => SEATS[k] === s.id)!
      const m = alpha(join(__dirname, `../public/sprites/office/characters/${slug}-${s.spriteFacing}.png`))
      // Seated draw (seatDraw + Character): 78 css tall, hips 7.5 css above the spot, only the top 66% drawn
      const w = m.w / m.h * 78, top = s.y - 7.5 * CSS.y - 0.66 * 78 * CSS.y, pts: { x: number; y: number }[] = []
      for (let y = 0; y < m.h * 0.66; y++) for (let x = 0; x < m.w; x++)
        if (m.at(x, y) > 128) pts.push({ x: s.x + ((x + 0.5) / m.w - 0.5) * w * CSS.x, y: top + (y + 0.5) / m.h * 78 * CSS.y })
      return { id: s.id, pts }
    })
    for (const s of room.agentSpots.filter(s => s.id.startsWith('boss-wait') || s.id === 'boss-door-wait' || s.type === 'overflow')) {
      const top = s.y - 78 * CSS.y, half = 14.5 * CSS.x
      for (const q of sitters) {
        const n = q.pts.filter(p => Math.abs(p.x - s.x) < half && p.y > top && p.y < s.y).length
        if (n > 0.01 * q.pts.length) bad.push(`${s.id} over ${q.id}: ${(n / q.pts.length * 100).toFixed(1)}%`)
      }
    }
    expect(bad).toEqual([])
  })

  it("Pam's reception is the show's square counter on the front floor where the owner's arrow points (~51, 88): Pam inside it, facing the camera", () => {
    const pam = room.agentSpots.find(s => s.id === 'spot-reception')!
    const desk = room.furniture.find(f => f.id === pam.desk)!
    expect(desk.sprite).toBe('desk-standing-reception')
    expect(ASSETS['desk-office-reception'], 'counter sprite').toBeTruthy()
    expect(pam.spriteFacing).toBe('front-right') // same way as round 2 (down-left, toward the camera)
    const a = ASSETS['desk-office-reception'], w = a.width * CSS.x, h = a.height * CSS.y
    const ARROW = { x: 51, y: 88 }
    expect(Math.abs(ARROW.x - desk.x)).toBeLessThan(w / 2) // the counter stands on the arrow spot
    expect(ARROW.y).toBeLessThan(desk.y); expect(ARROW.y).toBeGreaterThan(desk.y - h)
    // Pam sits inside the counter: in its sprite box, behind its front hull, drawn under it (the raised ledge hides her below the chest)
    expect(Math.abs(pam.x - desk.x)).toBeLessThan(w / 2)
    expect(pam.y).toBeLessThan(desk.y); expect(pam.y).toBeGreaterThan(desk.y - h)
    const hull = floorHulls([desk], ROOM_PX)[0]
    expect(hull.desk).toBe(true)
    expect(pam.y).toBeLessThan(Math.max(...hull.poly.map(p => p.y)))
    expect(pam.zIndex! * 10).toBeLessThan(desk.zIndex ?? Math.round(desk.y * 10))
  })
})
