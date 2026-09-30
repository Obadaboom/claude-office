// ===== ROOM DEFINITIONS =====
// Each room is an empty shell with positions for furniture placement
// Furniture items are placed on a grid within each room

export type RoomId =
  | 'main-office'
  | 'manager-office'
  | 'ceo-office'
  | 'meeting-room'
  | 'kitchen'
  | 'server-room'
  | 'lobby'
  | 'nap-room'
  | 'rooftop'
  | 'gym'
  | 'parking'

export interface Waypoint {
  id: string
  x: number  // percentage
  y: number
  connections: string[]  // ids of connected waypoints
}

export interface FurnitureItem {
  id: string
  type: string        // e.g. 'desk-dual', 'chair-aeron', 'plant-monstera'
  sprite: string      // sprite sheet + frame reference
  x: number           // percentage position within room (0-100)
  y: number
  zIndex?: number
  state?: string      // e.g. 'empty', 'occupied', 'brewing'
  interactive?: boolean
  label?: string
}

export type SpriteFacing = 'front-left' | 'front-right' | 'rear-left' | 'rear-right'

export interface RoomConnection {
  toRoom: RoomId
  position: { x: number; y: number }  // door/exit position in current room (%)
  label?: string
  exitFacing?: SpriteFacing   // agent direction when leaving through this door
  entryFacing?: SpriteFacing  // agent direction when arriving through this door
}

export interface AgentSpot {
  id: string
  type: 'desk' | 'meeting-seat' | 'lounge' | 'standing' | 'water' | 'coffee' | 'filing' | 'printer' | 'door' | 'overflow'
  x: number
  y: number
  facing?: 'up' | 'down' | 'left' | 'right'
  spriteFacing?: SpriteFacing  // which direction the agent faces when at this spot
  zIndex?: number  // explicit z-index override (for agents behind desks)
  desk?: string    // 2p: the furniture id of the desk this spot sits at
}

export interface Room {
  id: RoomId
  name: string
  description: string
  background: {
    day: string       // path to empty room background
    night: string
  }
  width: number       // room dimensions in px (rendered)
  height: number
  furniture: FurnitureItem[]
  connections: RoomConnection[]
  agentSpots: AgentSpot[]       // where agents can sit/stand/work
  entryPoint: { x: number; y: number }  // where agents appear when entering
  walkableArea?: { x: number; y: number }[]  // polygon defining where agents can walk
  ambience?: string   // ambient sound loop
  waypoints?: Waypoint[]  // named walkable nodes for pathfinding
}

// ===== ROOM DEFINITIONS =====

export const ROOMS: Record<RoomId, Room> = {
  'main-office': {
    id: 'main-office',
    name: 'Main Office',
    description: 'Open plan workspace where agents code, debug, and ship',
    background: {
      day: '/rooms/office-day.png',
      night: '/rooms/office-night.png',
    },
    width: 800,
    height: 600,
    furniture: [
      // Desk cluster - back
      { id: 'desk-1a', type: 'desk-standing', sprite: 'desk-standing-left-rear', x: 42.4, y: 50.4 },
      { id: 'desk-1b', type: 'desk-standing', sprite: 'desk-standing-left-front', x: 46.7, y: 53 },
      { id: 'desk-1c', type: 'desk-standing', sprite: 'desk-standing-right-front', x: 39.9, y: 55.2 },
      // Desk cluster - front left
      { id: 'desk-2a', type: 'desk-standing', sprite: 'desk-standing-left-rear', x: 31.4, y: 64.8 },
      { id: 'desk-2b', type: 'desk-standing', sprite: 'desk-standing-left-front', x: 35.4, y: 67.5 },
      { id: 'desk-2c', type: 'desk-standing', sprite: 'desk-standing-right-front', x: 27.9, y: 70 },
      // Desk cluster - right
      { id: 'desk-3a', type: 'desk-standing', sprite: 'desk-standing-left-rear', x: 59, y: 73.7 },
      { id: 'desk-3b', type: 'desk-standing', sprite: 'desk-standing-left-front', x: 62.6, y: 76 },
      { id: 'desk-3c', type: 'desk-standing', sprite: 'desk-standing-right-front', x: 55.4, y: 78.7 },
      { id: 'desk-3d', type: 'desk-standing', sprite: 'desk-standing-right-rear', x: 66.6, y: 71.1 },
      // Reception (Pam), 2r: the show's square counter on the front floor, in front of the accounting pod (the owner's arrow, 2026-09-30).
      // Counter z over Pam (960) over Kevin's chair back (951); she sits inside, open back toward the W-a-front aisle.
      { id: 'desk-reception', type: 'desk-standing', sprite: 'desk-standing-reception', x: 50.5, y: 90.5, zIndex: 970 },
      // Coffee machine on counter
      { id: 'coffee', type: 'coffee-machine', sprite: 'coffee-off', x: 78.5, y: 50.2, interactive: true, state: 'off', label: 'Coffee Machine' },
      // Filing cabinet
      { id: 'filing-1', type: 'filing-cabinet', sprite: 'filing-closed', x: 45, y: 56.5, state: 'closed', label: 'Filing Cabinet' },
      // Plants
      { id: 'plant-1', type: 'plant-monstera', sprite: 'plant-monstera', x: 91.9, y: 64.7 },
      { id: 'plant-2', type: 'plant-snake', sprite: 'plant-snake', x: 43.2, y: 37.9 },
      { id: 'plant-3', type: 'plant-money', sprite: 'plant-money', x: 32, y: 71.2 },
      { id: 'plant-4', type: 'plant-money', sprite: 'plant-money', x: 89.2, y: 65.7 },
      { id: 'plant-5', type: 'plant-monstera', sprite: 'plant-monstera', x: 60.2, y: 80.4 },
      // Printer (swaps between working/broken on printer jam event)
      { id: 'printer-1', type: 'printer', sprite: 'printer-working', x: 85.4, y: 56.8, state: 'working', label: 'Printer' },
      // Background hotspots — baked into the room image, no sprite, just clickable zones
      { id: 'fire-extinguisher', type: 'hotspot', sprite: 'hotspot', x: 8, y: 60, interactive: true, label: 'Fire Extinguisher' },
      { id: 'water-cooler', type: 'hotspot', sprite: 'hotspot', x: 53, y: 45, interactive: true, label: 'Water Cooler' },
      { id: 'bell', type: 'hotspot', sprite: 'hotspot', x: 63, y: 39, interactive: true, label: 'Bell' },
      { id: 'kanban-board', type: 'hotspot', sprite: 'hotspot', x: 80, y: 37, interactive: true, label: 'Whiteboard' },
      { id: 'ship-it-poster', type: 'hotspot', sprite: 'hotspot', x: 8, y: 45, interactive: true, label: 'Marketing' },
      { id: 'tv-monitor', type: 'hotspot', sprite: 'hotspot', x: 90, y: 42, interactive: true, label: 'Shipping board' },
      { id: 'boss-desk', type: 'hotspot', sprite: 'hotspot', x: 17, y: 73, interactive: true, label: 'Decisions' },
    ],
    connections: [
      { toRoom: 'manager-office', position: { x: 67.5, y: 48.9 }, label: "Manager's Office", exitFacing: 'rear-right', entryFacing: 'front-right' },
    ],
    agentSpots: [
      // Desk spots (2p): the sitter's floor point = desk anchor + variant offset (css px, art kit furn2p.py):
      // left-front +18.2,-13.3; right-front -18.2,-13.3; left-rear -20.9,-34.6; right-rear +20.9,-34.6.
      // Facing = toward the desk's monitor (getDirectionFromDelta). Front desks: sitter in front (z over the desk);
      // rear desks: sitter behind (z under it).
      // Front-left cluster: desks at y ~65-70
      { id: 'spot-1', type: 'desk', desk: 'desk-2c', x: 25.49, y: 67.64, facing: 'down', spriteFacing: 'rear-left', zIndex: 85 },
      { id: 'spot-2', type: 'desk', desk: 'desk-2b', x: 37.81, y: 65.14, facing: 'down', spriteFacing: 'rear-right', zIndex: 85 },
      { id: 'spot-3', type: 'desk', desk: 'desk-2a', x: 28.63, y: 58.65, facing: 'down', spriteFacing: 'front-left', zIndex: 40 },
      // Back cluster: desks at y ~50-55
      { id: 'spot-4', type: 'desk', desk: 'desk-1c', x: 37.49, y: 52.84, facing: 'down', spriteFacing: 'rear-left', zIndex: 58 },
      { id: 'spot-5', type: 'desk', desk: 'desk-1b', x: 49.11, y: 50.64, facing: 'down', spriteFacing: 'rear-right', zIndex: 70 },
      { id: 'spot-6', type: 'desk', desk: 'desk-1a', x: 39.63, y: 44.25, facing: 'down', spriteFacing: 'front-left', zIndex: 30 },
      // Right cluster: desks at y ~72-79
      { id: 'spot-7', type: 'desk', desk: 'desk-3c', x: 52.99, y: 76.34, facing: 'down', spriteFacing: 'rear-left', zIndex: 95 },
      { id: 'spot-8', type: 'desk', desk: 'desk-3b', x: 65.01, y: 73.64, facing: 'down', spriteFacing: 'rear-right', zIndex: 95 },
      { id: 'spot-9', type: 'desk', desk: 'desk-3a', x: 56.23, y: 67.55, facing: 'down', spriteFacing: 'front-left', zIndex: 55 },
      { id: 'spot-10', type: 'desk', desk: 'desk-3d', x: 69.37, y: 64.95, facing: 'down', spriteFacing: 'front-right', zIndex: 55 },
      { id: 'spot-reception', type: 'desk', desk: 'desk-reception', x: 52.01, y: 85.52, facing: 'down', spriteFacing: 'front-right', zIndex: 96 },
      // Activity spots
      { id: 'spot-coffee-1', type: 'coffee', x: 73.5, y: 56.7, facing: 'down', spriteFacing: 'rear-left' },
      { id: 'spot-coffee-2', type: 'coffee', x: 76.2, y: 58.4, facing: 'down', spriteFacing: 'front-right' },
      { id: 'spot-water-1', type: 'water', x: 53.3, y: 46.6, facing: 'down', spriteFacing: 'rear-left' },
      { id: 'spot-water-2', type: 'water', x: 56, y: 47.7, facing: 'down', spriteFacing: 'front-right' },
      { id: 'spot-filing', type: 'filing', x: 47.8, y: 57.6, facing: 'down', spriteFacing: 'front-right', zIndex: 70 },
      { id: 'spot-printer', type: 'printer', x: 81, y: 63, facing: 'down', spriteFacing: 'rear-left' },
      // Overflow: standing spots on the open front floor once all desks are taken (2r: beside Michael's office, the floor Pam left; off the aisles, clear of her counter)
      { id: 'over-1', type: 'overflow', x: 37.5, y: 78, spriteFacing: 'front-left' },
      { id: 'over-2', type: 'overflow', x: 40.5, y: 78, spriteFacing: 'front-left' },
      { id: 'over-3', type: 'overflow', x: 43.5, y: 78, spriteFacing: 'front-right' },
      { id: 'over-4', type: 'overflow', x: 36.5, y: 80.5, spriteFacing: 'front-left' },
      { id: 'over-5', type: 'overflow', x: 39.5, y: 80.5, spriteFacing: 'front-left' },
      { id: 'over-6', type: 'overflow', x: 42.5, y: 80.5, spriteFacing: 'front-right' },
      { id: 'over-7', type: 'overflow', x: 38.5, y: 83, spriteFacing: 'front-left' },
      { id: 'over-8', type: 'overflow', x: 41.5, y: 83, spriteFacing: 'front-right' },
      { id: 'spot-door-2', type: 'door', x: 64, y: 46.6, facing: 'down', spriteFacing: 'rear-right' },
      { id: 'spot-door-3', type: 'door', x: 69.9, y: 50.8, facing: 'down', spriteFacing: 'front-right' },
      // The boss's office (front-left bump-out): the boss visits his desk; 2e sessions wait outside the door gap
      { id: 'boss-visitor',   type: 'standing', x: 21.5, y: 81.1, spriteFacing: 'rear-left' },
      // 2e: waiting sessions queue here, first at the door, then up the front aisle, all facing the door gap
      { id: 'boss-door-wait', type: 'standing', x: 31,   y: 76.5, spriteFacing: 'front-right' },
      { id: 'boss-wait-2',    type: 'standing', x: 34,   y: 71.5, spriteFacing: 'front-right' }, // 2r: left of Dwight (the 2e spots 34.5,75.4 / 38,74.4 hide him)
      { id: 'boss-wait-3',    type: 'standing', x: 45,   y: 71,   spriteFacing: 'front-right' }, // 2r: the aisle in front of Dwight stays empty
      { id: 'boss-wait-4',    type: 'standing', x: 47.5,   y: 73,   spriteFacing: 'front-right' }, // 2r fix 3: 0.5% left, clear of Kevin's desk-3c (prover: 6 px of Jim's hand at 48)
      // 2h: Michael sits in the boss's desk chair (front-left office), facing his desk + monitor (up-right on screen =
      // the 'rear-left' sprite, see getDirectionFromDelta); he leaves only on a click, via the door gap
      { id: 'boss-home', type: 'standing', x: 12.5, y: 80, spriteFacing: 'rear-left' },
    ],
    entryPoint: { x: 67.5, y: 48.9 },
    // 2h: the free floor on today's art (room floor minus the water cooler and the right-wall
    // counter, plus the boss's office through its door gap minus his desk, credenza, chairs and plants).
    // Measured with the art kit's floor map (art-src iso.js); click targets and routes stay on it.
    walkableArea: [
      { x: 46.7, y: 33.67 },
      { x: 58.35, y: 40.83 },
      { x: 52.96, y: 44.5 },
      { x: 58.68, y: 48.01 },
      { x: 64.05, y: 44.33 },
      { x: 76.45, y: 51.95 },
      { x: 72.18, y: 54.92 },
      { x: 86.74, y: 63.87 },
      { x: 90.98, y: 60.88 },
      { x: 95.54, y: 63.68 },
      { x: 53.83, y: 93.25 },
      { x: 31.33, y: 79.3 },
      { x: 21.88, y: 85.51 },
      { x: 19.24, y: 84.99 },
      { x: 17.74, y: 86.03 },
      { x: 5.79, y: 78.6 },
      { x: 9.45, y: 76.11 },
      { x: 18.34, y: 81.62 },
      { x: 24.99, y: 77.05 },
      { x: 27.28, y: 76.79 },
      { x: 4.02, y: 62.37 },
    ],
    // Aisle nodes (W-a-*) carry all transit. Each spot waypoint is a dead-end
    // tied to one aisle node by a line clear of desks and plants (movement.test.ts).
    // Edges are listed once; findWaypointPath treats them as two-way.
    waypoints: [
      { id: 'W-door',          x: 67.5, y: 48.9, connections: ['W-a-door'] },
      { id: 'W-a-door',        x: 66,   y: 52.5, connections: ['W-a-water', 'W-a-right'] },
      { id: 'W-a-water',       x: 58,   y: 51,   connections: ['W-a-back-top'] },
      // 2h: the lane between Phyllis and Oscar, clear of Oscar's sprite (a walker there can't be both over Phyllis and under Oscar)
      { id: 'W-a-back-top',    x: 51.15, y: 52.2, connections: ['W-a-back'] },
      { id: 'W-a-back',        x: 51.15, y: 57,  connections: ['W-a-center'] },
      { id: 'W-a-center',      x: 46,   y: 64,   connections: ['W-a-mid', 'W-a-left-mid'] },
      { id: 'W-a-left-mid',    x: 34.5, y: 56.5, connections: ['W-a-back-left'] }, // 2p: west via W-a-back-left, behind Jim (spot-3)
      { id: 'W-a-back-left',   x: 33.3, y: 49.5,  connections: ['W-a-left'] },
      { id: 'W-a-left',        x: 22,   y: 58,   connections: ['W-a-left-front'] },
      { id: 'W-a-left-front',  x: 21,   y: 70,   connections: ['W-a-front-dwight'] },
      { id: 'W-a-front-dwight', x: 24,  y: 73.8, connections: ['W-a-front-left'] }, // 2h: pass in front of Dwight, not over him
      { id: 'W-a-front-left',  x: 36,   y: 74,   connections: ['W-a-mid'] },
      { id: 'W-a-mid',         x: 45,   y: 73,   connections: ['W-a-front'] },
      { id: 'W-a-front',       x: 50,   y: 81,   connections: ['W-a-front-mid'] },
      { id: 'W-a-front-mid',   x: 61,   y: 83,   connections: ['W-a-front-right'] },
      { id: 'W-a-front-right', x: 71,   y: 76,   connections: ['W-a-right'] },
      { id: 'W-a-right',       x: 74,   y: 61,   connections: [] },
      // Spots (dead-ends)
      { id: 'W-spot-1',   x: 25.49, y: 67.64,   connections: ['W-a-left-front'] },
      { id: 'W-spot-2',   x: 37.81, y: 65.14, connections: ['W-a-front-left'] },
      { id: 'W-spot-3',   x: 28.63, y: 58.65, connections: ['W-a-left'] },
      { id: 'W-spot-4',   x: 37.49, y: 52.84, connections: ['W-a-left-mid'] },
      { id: 'W-spot-5',   x: 49.11, y: 50.64, connections: ['W-a-back'] },
      { id: 'W-spot-6',   x: 39.63, y: 44.25, connections: ['W-a-back-left'] },
      { id: 'W-spot-7',   x: 52.99, y: 76.34, connections: ['W-a-front'] },
      { id: 'W-spot-8',   x: 65.01, y: 73.64, connections: ['W-a-front-right'] },
      { id: 'W-spot-9',   x: 56.23, y: 67.55, connections: ['W-a-center'] },
      { id: 'W-spot-10',  x: 69.37, y: 64.95, connections: ['W-a-right'] },
      { id: 'W-reception', x: 52.01, y: 85.52, connections: ['W-a-front'] },
      { id: 'W-coffee-1', x: 73.5, y: 56.7, connections: ['W-a-door'] },
      { id: 'W-coffee-2', x: 76.2, y: 58.4, connections: ['W-a-right'] },
      { id: 'W-water-1',  x: 53.3, y: 46.6, connections: ['W-a-water'] },
      { id: 'W-water-2',  x: 56,   y: 47.7, connections: ['W-a-water'] },
      { id: 'W-filing',   x: 47.8, y: 57.6, connections: ['W-a-back'] },
      { id: 'W-printer',  x: 81,   y: 63,   connections: ['W-a-right'] },
      { id: 'W-over-1', x: 37.5, y: 78, connections: ['W-a-mid'] },
      { id: 'W-over-2', x: 40.5, y: 78, connections: ['W-a-mid'] },
      { id: 'W-over-3', x: 43.5, y: 78, connections: ['W-a-mid'] },
      { id: 'W-over-4', x: 36.5, y: 80.5, connections: ['W-a-mid'] },
      { id: 'W-over-5', x: 39.5, y: 80.5, connections: ['W-a-mid'] },
      { id: 'W-over-6', x: 42.5, y: 80.5, connections: ['W-a-mid'] },
      { id: 'W-over-7', x: 38.5, y: 83, connections: ['W-a-mid'] },
      { id: 'W-over-8', x: 41.5, y: 83, connections: ['W-a-mid'] },
      // The boss's office: in only through the door gap
      { id: 'W-a-boss-door',   x: 28.6, y: 78.2, connections: ['W-a-front-left'] },
      { id: 'W-a-boss-in',     x: 26.1, y: 80,   connections: ['W-a-boss-door'] },
      { id: 'W-boss-visitor',  x: 21.5, y: 81.1, connections: ['W-a-boss-in'] },
      { id: 'W-boss-door-wait', x: 31,  y: 76.5, connections: ['W-a-front-left'] },
      { id: 'W-boss-wait-2',   x: 34,   y: 71.5, connections: ['W-a-front-left'] },
      { id: 'W-boss-wait-3',   x: 45,   y: 71,   connections: ['W-a-mid'] },
      { id: 'W-boss-wait-4',   x: 47.5,   y: 73,   connections: ['W-a-mid'] },
      { id: 'W-a-boss-front',  x: 19.04, y: 83.47, connections: ['W-a-boss-in'] }, // in front of his desk, clear of it
      { id: 'W-boss-home',       x: 12.5, y: 80,   connections: ['W-a-boss-front'] },
      // Back wall, behind the back desks (plant-2), clear of Creed
      { id: 'W-a-back-wall',    x: 47.26, y: 43.22, connections: ['W-a-water'] },
    ],
  },

  'manager-office': {
    id: 'manager-office',
    name: "Manager's Office",
    description: 'Where the manager briefs agents and reviews work. Connected to main Claude terminal.',
    background: {
      day: '/rooms/ceo-office.png',
      night: '/rooms/ceo-office.png',
    },
    width: 600,
    height: 450,
    furniture: [],
    connections: [
      { toRoom: 'main-office', position: { x: 50, y: 95 }, label: 'Main Office' },
    ],
    agentSpots: [
      { id: 'mgr-spot', type: 'desk', x: 50, y: 40, facing: 'down' },
      { id: 'visitor-1', type: 'standing', x: 35, y: 65, facing: 'up' },
      { id: 'visitor-2', type: 'standing', x: 65, y: 65, facing: 'up' },
    ],
    entryPoint: { x: 50, y: 90 },
  },

  'ceo-office': {
    id: 'ceo-office',
    name: 'CEO Office',
    description: 'Corner office with city views. Bloomberg terminal and whiskey shelf.',
    background: {
      day: '/rooms/ceo-office.png',
      night: '/rooms/ceo-office.png',
    },
    width: 600,
    height: 450,
    furniture: [
    ],
    connections: [
      { toRoom: 'main-office', position: { x: 50, y: 95 }, label: 'Main Office' },
    ],
    agentSpots: [
      { id: 'ceo-spot', type: 'desk', x: 50, y: 45, facing: 'down' },
    ],
    entryPoint: { x: 50, y: 90 },
  },

  'meeting-room': {
    id: 'meeting-room',
    name: 'Meeting Room',
    description: 'Glass-walled room for standups, planning, and heated architecture debates.',
    background: {
      day: '/rooms/meeting-room.png',
      night: '/rooms/meeting-room.png',
    },
    width: 600,
    height: 450,
    furniture: [
    ],
    connections: [
      { toRoom: 'main-office', position: { x: 95, y: 50 }, label: 'Main Office' },
    ],
    agentSpots: [
      { id: 'seat-1', type: 'meeting-seat', x: 30, y: 40, facing: 'right' },
      { id: 'seat-2', type: 'meeting-seat', x: 30, y: 55, facing: 'right' },
      { id: 'seat-3', type: 'meeting-seat', x: 70, y: 40, facing: 'left' },
      { id: 'seat-4', type: 'meeting-seat', x: 70, y: 55, facing: 'left' },
      { id: 'presenter', type: 'standing', x: 50, y: 25, facing: 'down' },
    ],
    entryPoint: { x: 90, y: 50 },
  },

  'kitchen': {
    id: 'kitchen',
    name: 'Kitchen',
    description: 'Espresso machine, kombucha on tap, and a fridge full of La Croix.',
    background: {
      day: '/rooms/kitchen-cafeteria.png',
      night: '/rooms/kitchen-cafeteria.png',
    },
    width: 600,
    height: 450,
    furniture: [
    ],
    connections: [
      { toRoom: 'main-office', position: { x: 5, y: 50 }, label: 'Main Office' },
      { toRoom: 'rooftop', position: { x: 50, y: 5 }, label: 'Rooftop' },
    ],
    agentSpots: [
      { id: 'coffee-spot', type: 'standing', x: 30, y: 35, facing: 'up' },
      { id: 'lunch-1', type: 'meeting-seat', x: 35, y: 65, facing: 'right' },
      { id: 'lunch-2', type: 'meeting-seat', x: 65, y: 65, facing: 'left' },
      { id: 'snack-spot', type: 'standing', x: 15, y: 35, facing: 'up' },
    ],
    entryPoint: { x: 10, y: 50 },
  },

  'server-room': {
    id: 'server-room',
    name: 'Server Room',
    description: 'Cold. Loud. Blinking lights. Where deployments happen.',
    background: {
      day: '/rooms/server-room.png',
      night: '/rooms/server-room.png',
    },
    width: 500,
    height: 400,
    furniture: [
    ],
    connections: [
      { toRoom: 'main-office', position: { x: 50, y: 95 }, label: 'Main Office' },
    ],
    agentSpots: [
      { id: 'server-spot-1', type: 'standing', x: 35, y: 60, facing: 'up' },
      { id: 'server-spot-2', type: 'standing', x: 65, y: 60, facing: 'up' },
    ],
    entryPoint: { x: 50, y: 90 },
    ambience: 'server-hum',
  },

  'lobby': {
    id: 'lobby',
    name: 'Lobby',
    description: 'Where new hires arrive. Swag wall. Pile of Amazon packages.',
    background: {
      day: '/rooms/lobby-reception.png',
      night: '/rooms/lobby-reception.png',
    },
    width: 600,
    height: 450,
    furniture: [
    ],
    connections: [
      { toRoom: 'main-office', position: { x: 50, y: 5 }, label: 'Main Office' },
      { toRoom: 'parking', position: { x: 50, y: 95 }, label: 'Parking' },
    ],
    agentSpots: [
      { id: 'reception-spot', type: 'desk', x: 50, y: 40, facing: 'down' },
      { id: 'waiting-1', type: 'lounge', x: 25, y: 70, facing: 'right' },
      { id: 'waiting-2', type: 'lounge', x: 35, y: 70, facing: 'right' },
    ],
    entryPoint: { x: 50, y: 90 },
  },

  'nap-room': {
    id: 'nap-room',
    name: 'Wellness Room',
    description: 'Sleep pods, meditation cushions, and a Himalayan salt lamp.',
    background: {
      day: '/rooms/nap-wellness-room.png',
      night: '/rooms/nap-wellness-room.png',
    },
    width: 500,
    height: 400,
    furniture: [
    ],
    connections: [
      { toRoom: 'main-office', position: { x: 50, y: 95 }, label: 'Main Office' },
    ],
    agentSpots: [
      { id: 'nap-1', type: 'lounge', x: 25, y: 40, facing: 'down' },
      { id: 'nap-2', type: 'lounge', x: 50, y: 40, facing: 'down' },
      { id: 'nap-3', type: 'lounge', x: 75, y: 40, facing: 'down' },
    ],
    entryPoint: { x: 50, y: 90 },
  },

  'rooftop': {
    id: 'rooftop',
    name: 'Rooftop Terrace',
    description: 'Friday drinks, BBQ, and pretending to have work-life balance.',
    background: {
      day: '/rooms/rooftop-terrace.png',
      night: '/rooms/rooftop-terrace.png',
    },
    width: 700,
    height: 500,
    furniture: [
    ],
    connections: [
      { toRoom: 'kitchen', position: { x: 50, y: 95 }, label: 'Kitchen' },
    ],
    agentSpots: [
      { id: 'roof-1', type: 'lounge', x: 25, y: 50, facing: 'down' },
      { id: 'roof-2', type: 'lounge', x: 65, y: 50, facing: 'down' },
      { id: 'roof-3', type: 'lounge', x: 40, y: 75, facing: 'right' },
    ],
    entryPoint: { x: 50, y: 90 },
  },

  'gym': {
    id: 'gym',
    name: 'Gym',
    description: 'A Peloton, some dumbbells, and a mirror for flexing your PRs.',
    background: {
      day: '/rooms/gym-fitness-room.png',
      night: '/rooms/gym-fitness-room.png',
    },
    width: 500,
    height: 400,
    furniture: [
    ],
    connections: [
      { toRoom: 'main-office', position: { x: 50, y: 95 }, label: 'Main Office' },
    ],
    agentSpots: [
      { id: 'gym-1', type: 'standing', x: 25, y: 45, facing: 'down' },
      { id: 'gym-2', type: 'standing', x: 75, y: 45, facing: 'down' },
    ],
    entryPoint: { x: 50, y: 90 },
  },

  'parking': {
    id: 'parking',
    name: 'Parking Garage',
    description: 'Teslas, e-scooters, and reserved spots nobody respects.',
    background: {
      day: '/rooms/parking-garage.png',
      night: '/rooms/parking-garage.png',
    },
    width: 700,
    height: 500,
    furniture: [
    ],
    connections: [
      { toRoom: 'lobby', position: { x: 50, y: 5 }, label: 'Lobby' },
    ],
    agentSpots: [],
    entryPoint: { x: 50, y: 10 },
  },
}

// ===== ROOM NAVIGATION =====
// Find path between rooms using BFS
export function findRoomPath(from: RoomId, to: RoomId): RoomId[] {
  if (from === to) return [from]

  const visited = new Set<RoomId>()
  const queue: { room: RoomId; path: RoomId[] }[] = [{ room: from, path: [from] }]
  visited.add(from)

  while (queue.length > 0) {
    const { room, path } = queue.shift()!
    const connections = ROOMS[room].connections

    for (const conn of connections) {
      if (conn.toRoom === to) return [...path, to]
      if (!visited.has(conn.toRoom)) {
        visited.add(conn.toRoom)
        queue.push({ room: conn.toRoom, path: [...path, conn.toRoom] })
      }
    }
  }

  return [from] // no path found, stay put
}

// Get all rooms connected to a given room
export function getConnectedRooms(roomId: RoomId): RoomId[] {
  return ROOMS[roomId].connections.map(c => c.toRoom)
}

// Get a free agent spot in a room
export function getFreeSpot(
  roomId: RoomId,
  occupiedSpotIds: Set<string>,
  type?: AgentSpot['type'],
): AgentSpot | null {
  const room = ROOMS[roomId]
  const spots = type
    ? room.agentSpots.filter(s => s.type === type)
    : room.agentSpots

  for (const spot of spots) {
    if (!occupiedSpotIds.has(spot.id)) return spot
  }
  return null
}
