import React, { useState, useEffect, useCallback, useRef, useMemo, lazy, Suspense } from 'react'
import './styles/office.css'
import './styles/rooms.css'
import SlackChat, { ChatMessage, TypingUser } from './components/SlackChat'
import Character from './components/Character'
import SessionPanel from './components/SessionPanel'
import FurnitureRenderer from './components/FurnitureRenderer'
import { Agent, OfficeEvent, SessionView, AGENT_CONFIGS } from './types'
import { getCurrentPhase, getPhaseLabel, lightFor, type DayPhase } from './daylight'
import { ROOMS } from './rooms'
import { useAgentSocket } from './hooks/useAgentSocket'
import * as sfx from './sounds'
import {
  stepToward,
  redirect,
  floorHulls,
  feetZ,
  walkerZ,
  seatedAtDesk,
  seatDraw,
  DESK_DRESSING,
  SEAT_Z,
  WALK_SPEED,
  chatKey,
  createRegulars,
  createBoss,
  applySession,
  staleSessions,
  speakerOf,
  personOf,
  arrive,
  BOSS_ID,
} from './agentManager'
import { BOSS_ROLE, SERVER_URL } from './config'
import { getInteraction, ARRIVAL_WATCH_MS } from './interactions'
import BoardPanel from './components/BoardPanel'
import { boardFor, BoardId } from './boards'
import { useTheme, getRoomImage, releaseRole, castKey, getTheme, themedDisplayName, pinCast, slugToName } from './theme'
import {
  CONVOS, pickConvo, convoDelay, jobLine, michaelLine, between, pick, ready, isErrorResult, mentionOf, wordReply, dundiesDue, dundieLines, dayOf,
  WIN_LINES, BLAME_LINES, WATCH_LINES, WAIT_LINES, MENTION_LINES, PRANKS, type ConvoLine,
} from './chatter'

// ---------------------------------------------------------------------------
// Placement helper — loaded via ?helper query param
// ---------------------------------------------------------------------------
const PlacementHelper = lazy(() => import('./components/PlacementHelper'))
const params = new URLSearchParams(window.location.search)
const isHelperMode = params.has('helper')
// Why: allow ?theme=office to preload Clauder Fablin mode
import { setTheme as _setTheme } from './theme'
if (params.get('theme') === 'office') { _setTheme('office') }

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function timeNow(): string {
  return new Date().toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })
}

let nextMsgId = 1
function makeMsgId() { return nextMsgId++ }

// Room spots for main office
const MAIN_ROOM = ROOMS['main-office']
const ENTRY = MAIN_ROOM.entryPoint           // door position (%)

// Agent that is walking toward door to leave has this as targetPosition
const DOOR_TARGET = { x: ENTRY.x, y: ENTRY.y }

// Waypoints for the main office
const MAIN_WAYPOINTS = MAIN_ROOM.waypoints ?? []

// 2h: Michael sits in the boss's desk chair (seatDraw); its back, cut from the room art (art-src execChairRear), covers his back
const BOSS_HOME = MAIN_ROOM.agentSpots.find(s => s.id === 'boss-home')!
const CHAIR_BACK = 'polygon(10.38% 72.99%, 11.67% 72.71%, 12.92% 74.33%, 12.92% 76.45%, 14.67% 76.45%, 14.83% 78.13%, 14.83% 80.5%, 10.38% 80.5%)'

/** Send a walker somewhere (boss clicks): see redirect() */
const walkTo = (a: Agent, target: { x: number; y: number }) => redirect(a, target, MAIN_WAYPOINTS)

// Chat fallback sender for a line about no known character
const CLAUDE_ROLE = 'assistant'

// How close (in %-units) an agent must be to their target before we consider
// them "arrived"
const ARRIVAL_THRESHOLD = 0.3


const App: React.FC = () => {
  // All hooks must be at the top — before any conditional returns.
  const theme = useTheme() // Why: re-render rooms + agents when /the-office toggles
  const [agents, setAgents] = useState<Agent[]>(() => [createBoss(), ...createRegulars(MAIN_ROOM.agentSpots)])
  // Session panel (2d): the clicked character's; a second click closes it; gone once it walks out (a comeback needs a new click)
  const [panelId, setPanelId] = useState<string | null>(null)
  const panelAgent = agents.find(a => a.id === panelId && a.state !== 'completed')
  useEffect(() => { if (panelId && !panelAgent) setPanelId(null) }, [panelId, panelAgent])
  const closePanel = useCallback(() => setPanelId(null), [])

  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [chatTypingUser, setChatTypingUser] = useState<TypingUser | null>(null)
  const [lastSeenId, setLastSeenId] = useState<number | null>(null)
  const [muted, setMuted] = useState(false)
  const [dayPhase, setDayPhase] = useState<DayPhase>(getCurrentPhase())
  const [dayNightMode, setDayNightMode] = useState<'auto' | 'day' | 'night'>('auto')

  // Track interactive furniture state (coffee on/off, filing open/closed)
  const [furnitureStates, setFurnitureStates] = useState<Record<string, string>>({})

  // Rendered room size: sprites have fixed px sizes, so desk floor hulls (in room %) follow it
  const roomRef = useRef<HTMLDivElement>(null)
  const [roomPx, setRoomPx] = useState({ w: 754, h: 563 })
  useEffect(() => {
    const el = roomRef.current
    if (!el) return
    const ro = new ResizeObserver(() => el.clientWidth && setRoomPx({ w: el.clientWidth, h: el.clientHeight }))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  const hulls = useMemo(() => floorHulls(MAIN_ROOM.furniture, roomPx), [roomPx])

  // Boss interaction cooldowns
  const interactionCooldowns = useRef<Map<string, number>>(new Map())
  // Latest boss click: a newer one replaces the target (the older watcher and walk-back stand down)
  const bossClick = useRef(0)
  const [board, setBoard] = useState<BoardId | null>(null)
  const closeBoard = useCallback(() => setBoard(null), [])

  const handleFurnitureClick = useCallback((itemId: string) => {
    if (boardFor(itemId)) { setBoard(boardFor(itemId)); setPanelId(null) } // one panel at a time
    const interaction = getInteraction(itemId)
    if (!interaction) return

    // Check cooldown
    const now = Date.now()
    const lastUsed = interactionCooldowns.current.get(itemId) ?? 0
    if (now - lastUsed < interaction.cooldown) return
    interactionCooldowns.current.set(itemId, now)
    const click = ++bossClick.current
    const michael = agentsRef.current.find(a => a.id === BOSS_ID)
    if (michael && getTheme() === 'office') say(michael, michaelLine(itemId))

    // Walk boss to the item
    const target = interaction.walkTo
    setAgents(prev => prev.map(a => a.id !== BOSS_ID ? a : walkTo(a, target)))

    // Arrival watcher — ends when the boss reaches the target (sound, furniture) or a newer click replaces it
    const checkArrival = setInterval(() => {
      const boss = agentsRef.current.find(a => a.id === BOSS_ID)
      if (!boss || click !== bossClick.current) { clearInterval(checkArrival); return }
      const dist = Math.sqrt((boss.position.x - target.x) ** 2 + (boss.position.y - target.y) ** 2)
      if (dist < 2) {
        clearInterval(checkArrival)

        // Play sound if specified
        if (interaction.sound === 'bell') sfx.playBell()
        else if (interaction.sound === 'notification') sfx.playNotification()
        else if (interaction.sound === 'coffee') sfx.playCoffee()

        // Furniture state change
        if (interaction.furnitureState) {
          const fs = interaction.furnitureState
          setFurnitureStates(prev => ({ ...prev, [fs.id]: fs.state }))
          if (fs.revertAfter) {
            setTimeout(() => {
              setFurnitureStates(prev => {
                const next = { ...prev }
                delete next[fs.id]
                return next
              })
            }, fs.revertAfter)
          }
        }

        // Walk boss back home (boss-home, by his office) after effect, unless a newer click sent him on
        setTimeout(() => {
          if (click !== bossClick.current) return
          setAgents(prev => prev.map(a => a.id !== BOSS_ID ? a : walkTo(a, a.deskPosition)))
        }, interaction.duration + 500)
      }
    }, 200)

    // Safety net only: well above the longest route
    setTimeout(() => clearInterval(checkArrival), ARRIVAL_WATCH_MS)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // We store agents in a ref as well so animation callbacks can read them
  // without needing to be re-created every render.
  const agentsRef = useRef<Agent[]>([])
  agentsRef.current = agents

  const recentChatKeysRef = useRef<Set<string>>(new Set())
  const typingTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // ---------------------------------------------------------------------------
  // Slack chat helpers
  // ---------------------------------------------------------------------------

  const addMsg = useCallback((
    sender: string,
    role: string,
    color: string,
    text: string,
    isSystem = false,
    agentId?: string,
    aside = false,
  ) => {
    setMessages(prev => [...prev.slice(-50), {
      id: makeMsgId(),
      sender,
      agentId,
      senderSprite: role,
      senderColor: color,
      text,
      channel: 'office-general',
      timestamp: timeNow(),
      isSystem,
      aside,
      reactions: undefined,
    }])
  }, [])

  // ---------------------------------------------------------------------------
  // Flavour (2f, office theme): canned in-character aside lines, chat text only
  // ---------------------------------------------------------------------------

  const flavourTimers = useRef(new Set<ReturnType<typeof setTimeout>>())
  const later = (fn: () => void, ms: number) => {
    const t = setTimeout(() => { flavourTimers.current.delete(t); fn() }, ms)
    flavourTimers.current.add(t)
  }
  const nameOf = (a: Agent) => themedDisplayName(castKey(a.id, a.role), a.name)
  const say = (a: Agent, text: string) =>
    addMsg(nameOf(a), a.role, (AGENT_CONFIGS[a.role] ?? AGENT_CONFIGS['default']).color, text, false, a.id, true)
  /** `a` types from `delay` for ~1.5 s, then says the line. */
  const typeThenSay = (a: Agent, text: string, delay: number) => {
    later(() => setChatTypingUser({ name: nameOf(a), role: a.role, agentId: a.id }), delay)
    later(() => { setChatTypingUser(null); say(a, text) }, delay + 1500)
  }
  // Last job comment per character: one per 60 s (a workflow spawning 8 agents = one comment)
  const lastComment = useRef(new Map<string, number>())
  /** A cast slug's speaker: Michael or a regular on the floor, else that cast member's own face (2o) */
  const castAgent = (slug: string): Agent => agentsRef.current.find(a => a.id === (slug === 'michael-scott' ? BOSS_ID : `regular-${slug}`))
    ?? (pinCast(`cast-${slug}`, slug), { id: `cast-${slug}`, role: 'default', name: slugToName(slug) } as Agent)
  /** Lines one after another, typing dots before each; returns the total ms */
  const playLines = (lines: ConvoLine[]) => {
    let t = 0
    for (const l of lines) { typeThenSay(castAgent(l.slug), l.text, t); t += 1500 + between(2000, 4000) }
    return t
  }
  // 2o: real-event lines share one 60 s gate; word replies 30 s per trigger; started jobs Stanley watches
  const gates = useRef(new Map<string, number>())
  const wordLast = useRef(new Map<string, number>())
  const watch = useRef(new Map<string, { start: number; name: string }>())
  const eventLine = (pool: ConvoLine[], name = '', delay = between(1500, 3000)) => {
    const l = pick(pool)
    typeThenSay(castAgent(l.slug), l.text.replace('{name}', name), delay)
  }
  const lastDundies = useRef<string | null>(null)
  const dundies = () => fetch(`${SERVER_URL}/dundies`).then(r => r.json())
    .then(({ jobs }) => { playLines(dundieLines(jobs).map(text => ({ slug: 'michael-scott', text }))) })

  // Convos: every CONVO_GAP_MS the cast has a 2-3 line exchange; none while the tab is hidden
  useEffect(() => {
    if (theme !== 'office') return
    let last = -1
    const next = () => later(() => {
      if (document.hidden) return next()
      last = pickConvo(last)
      later(next, playLines(CONVOS[last]))
    }, convoDelay())
    next()
    // 2o, every 60 s: a job running 10+ min → Stanley (once per job); from 17:00 → the Dundies (once a day)
    const tick = () => {
      const now = Date.now()
      const late = [...watch.current].find(([, w]) => now - w.start >= 600_000)
      if (late && ready(gates.current, 'event', 60_000, now)) { watch.current.delete(late[0]); eventLine(WATCH_LINES, late[1].name, 0) }
      let saved: string | null = null
      try { saved = localStorage.getItem('agent-office-dundies') } catch {}
      if (!dundiesDue(now, lastDundies.current ?? saved)) return
      lastDundies.current = dayOf(now)
      dundies().then(() => { try { localStorage.setItem('agent-office-dundies', dayOf(now)) } catch {} })
        .catch(() => { lastDundies.current = saved })
    }
    tick()
    const every = setInterval(tick, 60_000)
    const timers = flavourTimers.current
    return () => { clearInterval(every); timers.forEach(clearTimeout); timers.clear() }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [theme])

  // Day/night (2p): the real clock, rechecked once a minute
  useEffect(() => {
    const t = setInterval(() => setDayPhase(getCurrentPhase()), 60_000)
    return () => clearInterval(t)
  }, [])

  // ---------------------------------------------------------------------------
  // WebSocket event handler
  // ---------------------------------------------------------------------------

  const handleEvent = useCallback((event: OfficeEvent) => {
    if (event.type === 'session_changed' && event.prompt) sfx.playOnIt(sfx.pitchOf(personOf(event as SessionView)))
    if (event.type === 'agent_completed' && event.agentId) watch.current.delete(event.agentId)
    // 2o: a person starts waiting on you → Pam says so (the shared 60 s event gate)
    if (event.type === 'session_changed' && event.state === 'waiting' && getTheme() === 'office') {
      const id = personOf(event as SessionView)
      if (agentsRef.current.find(a => a.id === id)?.sessionState !== 'waiting' && ready(gates.current, 'event', 60_000, Date.now())) {
        later(() => { const p = agentsRef.current.find(a => a.id === id); if (p) eventLine(WAIT_LINES, nameOf(p), 0) }, 1500)
      }
    }
    setAgents(prev => {
      switch (event.type) {
        // ── A live session (2c): its regular or overflow walker follows it. Agents get no person (chat only).
        case 'session_changed':
          return applySession(prev, event as SessionView)

        // ── Typing indicator ─────────────────────────────────────────────
        case 'chat_typing': {
          if (typingTimeoutRef.current) clearTimeout(typingTimeoutRef.current)
          setChatTypingUser({ name: (event as any).sender ?? '', role: 'assistant' })
          typingTimeoutRef.current = setTimeout(() => setChatTypingUser(null), 10000)
          return prev
        }

        // ── Emoji reactions on a message ──────────────────────────────────
        case 'chat_reaction': {
          const { messageId, reactions } = event as any
          if (messageId && reactions) {
            setMessages(prev => prev.map(m =>
              m.id === messageId ? { ...m, reactions } : m
            ))
          }
          return prev
        }

        // ── Read receipt ──────────────────────────────────────────────────
        case 'chat_seen': {
          setLastSeenId((event as any).messageId ?? null)
          return prev
        }

        // ── Chat message from server (Claude replying via an agent) ──────
        case 'chat_message': {
          const sender = event.sender ?? 'Agent'
          const text = event.text ?? ''

          // Clear typing indicator when Claude sends a real message
          setChatTypingUser(null)

          // Skip messages from the boss — those are added locally by onSendMessage
          const bossCfg = AGENT_CONFIGS[BOSS_ROLE] ?? AGENT_CONFIGS['default']
          if (sender === bossCfg.title || sender.toLowerCase() === bossCfg.title.toLowerCase()) {
            return prev
          }

          // Deduplicate by server message id (a StrictMode re-run sees the same event)
          const dedupKey = chatKey({ ...(event as any), text })
          if (recentChatKeysRef.current.has(dedupKey)) {
            return prev
          }
          recentChatKeysRef.current.add(dedupKey)
          // Keep the set from growing unbounded
          if (recentChatKeysRef.current.size > 50) {
            const first = recentChatKeysRef.current.values().next().value
            if (first !== undefined) recentChatKeysRef.current.delete(first)
          }

          const role = (event as any).role as string | undefined
          const about = speakerOf(prev, event)
          let msgSender: string, msgRole: string, msgColor: string

          // A line of a session → its character; a known role → its title; else Claude
          if (about) {
            const cfg = AGENT_CONFIGS[about.role] ?? AGENT_CONFIGS['default']
            msgSender = about.name; msgRole = about.role; msgColor = cfg.color
          } else if (role && AGENT_CONFIGS[role] && sender.toLowerCase() !== 'claude') {
            const cfg = AGENT_CONFIGS[role]
            msgSender = cfg.title; msgRole = role; msgColor = cfg.color
          } else {
            const claudeCfg = AGENT_CONFIGS[CLAUDE_ROLE] ?? AGENT_CONFIGS['default']
            msgSender = claudeCfg.title; msgRole = CLAUDE_ROLE; msgColor = claudeCfg.color
          }
          // Use setTimeout to escape the setAgents updater before calling addMsg
          setTimeout(() => addMsg(msgSender, msgRole, msgColor, text, false, about?.id), 0)
          // A character gets a job → one in-character comment (runs once: past the dedup above)
          if (about && text.startsWith('started') && getTheme() === 'office' && Date.now() - (lastComment.current.get(about.id) ?? -Infinity) >= 60_000) {
            lastComment.current.set(about.id, Date.now())
            typeThenSay(about, jobLine(about.id.replace('regular-', '')), between(1500, 3000))
          }
          // 2o: real-event lines, after the real one
          if (event.agentId && text.startsWith('started')) watch.current.set(event.agentId, { start: Date.now(), name: about ? nameOf(about) : sender })
          if (text.startsWith('✅ finished')) {
            if (event.agentId) watch.current.delete(event.agentId)
            if (getTheme() === 'office' && ready(gates.current, 'event', 60_000, Date.now())) eventLine(isErrorResult(text.replace(/^✅ finished:?/, '')) ? BLAME_LINES : WIN_LINES)
          }
          return prev
        }

        default:
          return prev
      }
    })
  }, [])

  // ---------------------------------------------------------------------------
  // WebSocket connection
  // ---------------------------------------------------------------------------

  // (Re)connect snapshot — reconnect, laptop wake, office restart: sessions the
  // server no longer has end quietly (regulars freed, walkers out). Boss and regulars always stay.
  const syncSnapshot = useCallback((ids: string[]) => {
    for (const id of staleSessions(agentsRef.current, new Set(ids))) handleEvent({ type: 'session_changed', sessionId: id, state: 'back', seat: null })
  }, [handleEvent])
  useAgentSocket({ onEvent: handleEvent, onSnapshot: syncSnapshot })

  // ---------------------------------------------------------------------------
  // Animation loop — moves agents toward their targets each frame
  // ---------------------------------------------------------------------------

  useEffect(() => {
    let rafId: number
    let lastTime = performance.now()

    function tick(now: number) {
      // rAF's frame time can precede the mount time: a negative dt would step
      // backwards (and 0/0 = NaN on a zero-length leg), freezing the agent.
      const dt = Math.max(0, Math.min((now - lastTime) / 16.67, 3))
      lastTime = now

      const prev = agentsRef.current
      if (prev.length === 0) {
        rafId = requestAnimationFrame(tick)
        return
      }

      let changed = false
      // Meta and cast changes apply only if this frame's result is kept (see setAgents below)
      const commits: (() => void)[] = []

      const next = prev.map(agent => {
        const speed = WALK_SPEED * dt

        // Walk toward the first waypoint in the queue, or directly to the
        // final targetPosition if the queue is empty.
        const queue = agent.pathQueue ?? []
        const immediateTarget = queue.length > 0 ? queue[0] : agent.targetPosition

        const { position, arrived } = stepToward(
          agent.position,
          immediateTarget,
          speed,
        )

        // Always update position (even if not arrived — this is the walking animation)
        const moved = position.x !== agent.position.x || position.y !== agent.position.y
        let updated: Agent = moved
          ? (changed = true, { ...agent, position })
          : agent

        if (arrived) {
          // If there are more waypoints in the queue, pop the first one and
          // keep walking — don't trigger "arrived at final destination" yet.
          if (queue.length > 0) {
            const newQueue = queue.slice(1)
            updated = { ...agent, position, pathQueue: newQueue }
            changed = true
          } else {
            // Queue is empty — agent has reached (or is walking directly to)
            // their final targetPosition.
            const isAtDoor = (
              Math.abs(agent.targetPosition.x - DOOR_TARGET.x) < ARRIVAL_THRESHOLD &&
              Math.abs(agent.targetPosition.y - DOOR_TARGET.y) < ARRIVAL_THRESHOLD
            )

            if (agent.state === 'new-hire' || agent.state === 'walking-to-desk') {
              updated = arrive(agent, position) // desk: typing while busy; a wait spot or click target: stands idle
              changed = true
            } else if (agent.state === 'completed' && isAtDoor) {
              updated = { ...agent, position }
              changed = true
            } else {
              if (
                Math.abs(position.x - agent.position.x) > 0.01 ||
                Math.abs(position.y - agent.position.y) > 0.01
              ) {
                updated = { ...agent, position }
                changed = true
              }
            }
          }
        } else {
          // Still walking
          if (
            Math.abs(position.x - agent.position.x) > 0.001 ||
            Math.abs(position.y - agent.position.y) > 0.001
          ) {
            updated = { ...agent, position }
            changed = true
          }
        }

        return updated
      })

      // Prune completed agents at the door (never prune the boss)
      const pruned = next.filter(a => {
        if (a.id === BOSS_ID) return true
        if (a.state === 'completed') {
          const atDoor = (
            Math.abs(a.position.x - DOOR_TARGET.x) < ARRIVAL_THRESHOLD * 2 &&
            Math.abs(a.position.y - DOOR_TARGET.y) < ARRIVAL_THRESHOLD * 2
          )
          if (atDoor) {
            commits.push(() => releaseRole(castKey(a.id, a.role))) // cast member free for the next walker
            return false
          }
        }
        return true
      })

      if (changed || pruned.length !== next.length) {
        // An event may have updated agents since the last render — keep it and
        // redo movement next frame instead of overwriting it with stale data.
        // Side effects follow only a kept frame (idempotent: StrictMode runs updaters twice).
        setAgents(cur => {
          if (cur !== prev) return cur
          commits.forEach(c => c())
          return pruned
        })
      }

      rafId = requestAnimationFrame(tick)
    }

    rafId = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(rafId)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // ---------------------------------------------------------------------------
  // Misc handlers
  // ---------------------------------------------------------------------------

  // Effective day phase (respects manual override)
  const effectivePhase: DayPhase = dayNightMode === 'auto' ? dayPhase
    : dayNightMode === 'day' ? 'morning' : 'night'
  const light = lightFor(effectivePhase)
  const nightOp = light.op

  // Depth: a seated character draws at its spot z (else as a walker); walkers go over / under it (walkerZ)
  const seatedZ = (a: Agent) => {
    const z = MAIN_ROOM.agentSpots.find(s => s.id === a.assignedSpotId)?.zIndex
    return z ? z * 10 : walkerZ(a.position, hulls, SEAT_Z, roomPx) // resting on overflow: same z as a walker there
  }
  const seatedNow = [...SEAT_Z, ...agents.filter(seatedAtDesk).map(a => ({ ...a.position, z: seatedZ(a) }))]

  const [volume, setVolume] = useState(sfx.getVolume())

  const handleToggleMute = useCallback(() => {
    const nowMuted = sfx.toggleMute()
    setMuted(nowMuted)
    setVolume(sfx.getVolume())
  }, [])

  const handleVolumeChange = useCallback((v: number) => {
    sfx.setVolume(v)
    setVolume(v)
    setMuted(v === 0)
  }, [])

  // ---------------------------------------------------------------------------
  // Render — helper mode renders PlacementHelper in place of the full app
  // ---------------------------------------------------------------------------

  if (isHelperMode) {
    return (
      <Suspense fallback={<div style={{ color: '#666', padding: 20 }}>Loading helper...</div>}>
        <PlacementHelper />
      </Suspense>
    )
  }

  return (
    <div className="app-wrapper">
      <div className="title-bar">
        <div className="title-bar-dot" style={{ background: '#ff5f57' }} />
        <div className="title-bar-dot" style={{ background: '#febc2e' }} />
        <div className="title-bar-dot" style={{ background: '#28c840' }} />
        {theme === 'office'
          ? <span className="title-bar-text" style={{ fontFamily: "'American Typewriter', serif", textTransform: 'none', letterSpacing: 0, fontSize: 12 }}>Clauder Fablin · Scranton</span>
          : <span className="title-bar-text">CLAUDE CODE — AGENT OFFICE</span>}
        <button
          className="title-bar-daynight"
          onClick={() => setDayNightMode(prev =>
            prev === 'auto' ? 'day' : prev === 'day' ? 'night' : 'auto'
          )}
          title={`Mode: ${dayNightMode}`}
        >
          {dayNightMode === 'auto' ? 'AUTO' : dayNightMode === 'day' ? 'DAY' : 'NIGHT'}
        </button>
        <span className="title-bar-phase">{getPhaseLabel(effectivePhase)}</span>
      </div>

      <div className="app-body">
      <div className="office-view">
        <div
          ref={roomRef}
          className="room-container"
          style={{
            aspectRatio: '4800/3584',
            width: '100%',
            maxHeight: '100%',
            position: 'relative',
          }}
        >
          {/* Room backgrounds — both rendered, night crossfades via opacity. Theme swaps source art. */}
          <div
            key={`day-${theme}`}
            className="room-background"
            style={{ backgroundImage: `url(${getRoomImage('day')})` }}
          />
          <div
            key={`night-${theme}`}
            className="room-background room-background-night"
            style={{ backgroundImage: `url(${getRoomImage('night')})`, opacity: nightOp }}
          />
          {theme === 'office' && (['day', 'night'] as const).map(phase => (
            <div
              key={`chair-${phase}`}
              className={`room-background${phase === 'night' ? ' room-background-night' : ''}`}
              style={{
                backgroundImage: `url(${getRoomImage(phase)})`,
                clipPath: CHAIR_BACK,
                zIndex: feetZ(BOSS_HOME.x, BOSS_HOME.y, hulls) + 1,
                opacity: phase === 'night' ? nightOp : 1,
                pointerEvents: 'none',
              }}
            />
          ))}

          {/* Furniture — apply interactive state overrides */}
          <FurnitureRenderer onItemClick={handleFurnitureClick} items={[...MAIN_ROOM.furniture.map(item => {
            // 2p: office theme sits everyone at sit-down desks (same size + footprint as the standing desks)
            if (theme === 'office' && item.sprite.startsWith('desk-standing-')) return { ...item, sprite: item.sprite.replace('desk-standing-', 'desk-office-') }
            const stateOverride = furnitureStates[item.id]
            if (!stateOverride) return item
            // Swap sprite based on state
            if (item.id === 'coffee' && stateOverride === 'on') {
              return { ...item, sprite: 'coffee-on' }
            }
            if (item.id === 'filing-1' && stateOverride === 'open') {
              return { ...item, sprite: 'filing-open' }
            }
            if (item.id === 'printer-1' && stateOverride === 'broken') {
              return { ...item, sprite: 'printer-broken' }
            }
            return item
          }), ...(theme === 'office' ? DESK_DRESSING : [])]} />

          {/* Agents */}
          {agents.map(agent => {
            // Seated: spot z (else feet z); walkers: over / under the seated people they overlap (walkerZ)
            return (
              <Character
                key={agent.id}
                agent={agent}
                zIndex={seatedAtDesk(agent) ? seatedZ(agent) : walkerZ(agent.position, hulls, seatedNow, roomPx)}
                seat={theme === 'office' ? seatDraw(agent) : undefined}
                onClick={() => { if (panelId !== agent.id) sfx.playPerson(sfx.pitchOf(agent.id)); setBoard(null); setPanelId(p => (p === agent.id ? null : agent.id)) }}
              />
            )
          })}

          {board && <BoardPanel key={board} board={board} onClose={closeBoard} />}
          {panelAgent && <SessionPanel key={panelAgent.id} agent={panelAgent} onClose={closePanel}
            onPrank={theme === 'office' && panelAgent.id === 'regular-jim-halpert'
              ? k => { sfx.playPerson(sfx.pitchOf('regular-dwight-schrute')); playLines(PRANKS[k]) } : undefined} />}

          {/* Day/night overlay */}
          <div className={`day-overlay ${light.overlay}`} />
        </div>
      </div>

      <SlackChat
        messages={messages}
        muted={muted}
        volume={volume}
        onToggleMute={handleToggleMute}
        onVolumeChange={handleVolumeChange}
        onSendMessage={(text) => {
          const bossCfg = AGENT_CONFIGS[BOSS_ROLE] ?? AGENT_CONFIGS['default']
          addMsg(bossCfg.title, BOSS_ROLE, bossCfg.color, text)
          // Send to server so Claude can read it
          fetch(`${SERVER_URL}/chat`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ sender: bossCfg.title, text }),
          }).catch(() => {})
          // 2o: an @mention answers (and is the only reply), else a word trigger may; local only
          if (getTheme() !== 'office') return
          const m = mentionOf(text)
          const w = m ? undefined : wordReply(text, wordLast.current, Date.now())
          if (m || w) typeThenSay(castAgent(m ?? w!.slug), pick(m ? MENTION_LINES[m] : w!.lines), between(800, 1500))
        }}
        onDundies={() => { if (getTheme() === 'office') dundies().catch(() => {}) }}
        dayPhase={effectivePhase}
        typingUser={chatTypingUser}
        lastSeenId={lastSeenId}
        onReaction={(messageId, reactions) => {
          setMessages(prev => prev.map(m =>
            m.id === messageId ? { ...m, reactions } : m
          ))
        }}
      />
      </div>
    </div>
  )
}

export default App
