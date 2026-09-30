/** theme.ts — Office TV theme pack (characters, rooms, names) */

import { useSyncExternalStore } from 'react'

export type ThemeName = 'default' | 'office'

// Why: 27 Office characters — shuffle-dealt to roles. Sprites live at
// /sprites/office/characters/{slug}-{front|rear}-{left|right}.png
const OFFICE_CHARACTERS = [
  'andy-bernard', 'angela-martin', 'bob-vance', 'carol-stills',
  'creed-bratton', 'darryl-philbin', 'david-wallace', 'dwight-schrute',
  'erin-hannon', 'gabe-lewis', 'holly-flax', 'jan-levinson',
  'jim-halpert', 'karen-filippelli', 'kelly-kapoor', 'kevin-malone',
  'meredith-palmer', 'michael-scott', 'nellie-bertram', 'oscar-martinez',
  'pam-beesly', 'phyllis-vance', 'robert-california', 'roy-anderson',
  'ryan-howard', 'stanley-hudson', 'toby-flenderson',
] as const

// Fixed casting by role — same character used for Slack avatar AND room sprite
const FIXED_ROLE_CASTING: Record<string, string> = {
  boss: 'michael-scott',
  assistant: 'jim-halpert',
}

/** Fixed team (2c): REGULARS[seat] shows the live session with that server seat. Never dealt by the random pool; Michael = boss. */
export const REGULARS = [
  'dwight-schrute', 'jim-halpert', 'pam-beesly', 'kevin-malone', 'angela-martin', 'oscar-martinez',
  'stanley-hudson', 'phyllis-vance', 'andy-bernard', 'creed-bratton', 'meredith-palmer',
] as const

// Cast key -> fixed slug: the regulars' own ids. Survives theme switches.
const pins: Record<string, string> = {}
export function pinCast(key: string, slug: string) { pins[key] = slug }
export const pinnedCast = (key: string): string | undefined => pins[key]

interface ThemeState {
  name: ThemeName
  // Cast key → Office character slug. The key is the agent id (one cast member
  // per agent), or the role for the fixed boss/assistant — see castKey().
  cast: Record<string, string>
  // Cast of agents that left: their chat history keeps its face without holding a slot
  retired: Record<string, string>
}

/** Cast key: boss and assistant are fixed by role; everyone else by agent id. */
export function castKey(agentId: string | undefined, role: string): string {
  return FIXED_ROLE_CASTING[role] || !agentId ? role : agentId
}

let state: ThemeState = loadInitial()
const listeners = new Set<() => void>()

function loadInitial(): ThemeState {
  try {
    const saved = localStorage.getItem('agent-office-theme')
    if (saved === 'office') {
      return { name: 'office', cast: {}, retired: {} }
    }
  } catch {}
  return { name: 'default', cast: {}, retired: {} }
}

function persist() {
  try { localStorage.setItem('agent-office-theme', state.name) } catch {}
}

function emit() { listeners.forEach(l => l()) }

// Randomness picks looks only: which cast member an agent gets
function pick<T>(arr: T[]): T { return arr[Math.floor(Math.random() * arr.length)] }

export function getTheme(): ThemeName { return state.name }

export function setTheme(name: ThemeName) {
  if (state.name === name) return
  state = { name, cast: {}, retired: {} }
  persist()
  emit()
}

export function toggleTheme() {
  setTheme(state.name === 'office' ? 'default' : 'office')
}

export function subscribeTheme(fn: () => void): () => void {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

export function useTheme(): ThemeName {
  return useSyncExternalStore(
    (cb) => subscribeTheme(cb),
    () => state.name,
    () => 'default',
  )
}

function dealt(): Set<string> { return new Set(Object.values(state.cast)) }

/** Assign (or return existing) Office character for a cast key (see castKey). Same for SlackChat & Character. */
export function getCharacterBaseForRole(role: string, defaultBase: string): string {
  if (state.name !== 'office') return defaultBase
  if (state.cast[role]) return state.cast[role]
  if (state.retired[role]) return state.retired[role]
  if (pins[role]) return pins[role]

  // Fixed casting wins
  const fixed = FIXED_ROLE_CASTING[role]
  if (fixed) {
    state.cast[role] = fixed
    return fixed
  }

  // Pick from remaining — exclude already-dealt + reserved-fixed-not-yet-used
  const used = dealt()
  const reservedNotYetUsed = new Set(
    Object.values(FIXED_ROLE_CASTING).filter(c => !used.has(c))
  )
  const pool = OFFICE_CHARACTERS.filter(c => !used.has(c) && !reservedNotYetUsed.has(c) && !(REGULARS as readonly string[]).includes(c))
  // Fallback when all 22 are dealt: reuse an existing non-fixed cast slug.
  // Why: prevents duplicating boss (Michael) or assistant (Jim) on screen when chat roles overflow.
  const fixedSet = new Set(Object.values(FIXED_ROLE_CASTING))
  const nonFixedUsed = [...used].filter(c => !fixedSet.has(c))
  const chosen = pool.length > 0
    ? pick(pool as string[])
    : (nonFixedUsed.length > 0 ? pick(nonFixedUsed) : OFFICE_CHARACTERS[2]) // Why: [2] is not Michael/Jim
  state.cast[role] = chosen
  return chosen
}

export function getSpriteDir(): string {
  return state.name === 'office' ? '/sprites/office/characters' : '/sprites/characters'
}

/** Sprite for an agent: one cast member per agent id (boss/assistant fixed by role). */
export function getSpritePath(agentId: string | undefined, role: string, defaultBase: string, direction: string): string {
  const base = getCharacterBaseForRole(castKey(agentId, role), defaultBase)
  return `${getSpriteDir()}/${base}-${direction}.png`
}

export function getRoomImage(phase: 'day' | 'night'): string {
  if (state.name === 'office') {
    return phase === 'night' ? '/rooms/office-night-dm.png' : '/rooms/office-day-dm.png'
  }
  return phase === 'night' ? '/rooms/office-night.png' : '/rooms/office-day.png'
}

/** Human-readable display name for a slug (e.g. "michael-scott" → "Michael Scott") */
export function slugToName(slug: string): string {
  return slug.split('-').map(p => p[0].toUpperCase() + p.slice(1)).join(' ')
}

/** Read-only cast lookup for chat lines (history can be about agents long gone): never deals a member. */
export function castOf(key: string): string | undefined {
  return state.name === 'office' ? state.cast[key] ?? state.retired[key] ?? pins[key] ?? FIXED_ROLE_CASTING[key] : undefined
}

/** Sender display name: the cast Office character when known (key = castKey), else the fallback. */
export function themedDisplayName(key: string, fallback: string): string {
  const cast = castOf(key)
  return cast ? slugToName(cast) : fallback
}

/** Release a role's cast slot so another role can use that character later. */
export function releaseRole(role: string) {
  const slug = state.cast[role]
  if (!slug) return
  state.retired[role] = slug
  delete state.cast[role]
  emit()
}

/** Return the set of character slugs currently on-screen (dealt to some role). */
export function getActiveCastSlugs(): Set<string> {
  return new Set(Object.values(state.cast))
}
