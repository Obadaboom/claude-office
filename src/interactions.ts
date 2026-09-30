/**
 * interactions.ts — Boss interaction definitions for clickable furniture
 *
 * Each interaction defines what happens when the boss clicks a furniture item:
 * - walkTo: position to walk to (near the item)
 * - duration: how long the boss stays there (ms)
 * - furnitureState: optional state change for the furniture item
 * - cooldown: minimum ms between interactions with this item
 */

export interface Interaction {
  walkTo: { x: number; y: number }
  duration: number
  furnitureState?: { id: string; state: string; revertAfter?: number }
  cooldown: number
  sound?: string
}

/** A boss click's arrival watcher gives up after this: a safety net only, well above the longest route (~21 s) */
export const ARRIVAL_WATCH_MS = 60_000

/** Floor in front of the right-wall counter, right under the whiteboard */
const BOARD_SPOT = { x: 76.83, y: 59.18 }

export function getInteraction(furnitureId: string): Interaction | null {
  switch (furnitureId) {
    // Plants — water them
    case 'plant-1':
      return { walkTo: { x: 86.74, y: 66.96 }, duration: 3000, cooldown: 30000 }
    case 'plant-2':
      return { walkTo: { x: 46.44, y: 39.92 }, duration: 3000, cooldown: 30000 }
    case 'plant-3':
      return { walkTo: { x: 32, y: 73.6 }, duration: 3000, cooldown: 30000 }
    case 'plant-4':
      return { walkTo: { x: 85.25, y: 66.04 }, duration: 3000, cooldown: 30000 }
    case 'plant-5':
      return { walkTo: { x: 58, y: 81 }, duration: 3000, cooldown: 30000 }

    // Coffee machine
    case 'coffee':
      return {
        walkTo: { x: 73.31, y: 56.74 },
        duration: 4000,
        furnitureState: { id: 'coffee', state: 'on', revertAfter: 10000 },
        cooldown: 15000,
        sound: 'coffee',
      }

    // Filing cabinet
    case 'filing-1':
      return {
        walkTo: { x: 47, y: 58 },
        duration: 3000,
        furnitureState: { id: 'filing-1', state: 'open', revertAfter: 8000 },
        cooldown: 10000,
      }

    // Printer
    case 'printer-1':
      return {
        walkTo: { x: 79.85, y: 61.32 },
        duration: 3000,
        cooldown: 15000,
      }

    // Whiteboard / kanban board — use the board area
    case 'whiteboard':
      return {
        walkTo: BOARD_SPOT,
        duration: 4000,
        cooldown: 20000,
      }

    // Background hotspots
    case 'fire-extinguisher':
      return { walkTo: { x: 16, y: 66 }, duration: 3000, cooldown: 30000 }

    case 'water-cooler':
      return { walkTo: { x: 53, y: 47 }, duration: 3000, cooldown: 10000 }

    case 'bell':
      return { walkTo: { x: 63, y: 46 }, duration: 2000, cooldown: 20000, sound: 'bell' }

    case 'kanban-board':
      return { walkTo: BOARD_SPOT, duration: 4000, cooldown: 15000 }

    case 'ship-it-poster':
      return { walkTo: { x: 16, y: 55 }, duration: 3000, cooldown: 30000 }

    case 'tv-monitor':
      return { walkTo: { x: 83.86, y: 64.07 }, duration: 3000, cooldown: 15000 }

    // The boss's desk (decisions inbox): Michael already sits there, so no walk
    case 'boss-desk':
      return { walkTo: { x: 12.5, y: 80 }, duration: 3000, cooldown: 15000 }

    default:
      return null
  }
}
