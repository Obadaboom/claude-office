/**
 * useAgentSocket — React hook for the Agent Office WebSocket connection.
 *
 * Connects to ws://localhost:3334/ws, receives real-time agent events from the
 * Claude Code hook pipeline, and exposes them to the React tree.
 *
 * Features:
 *  - Auto-reconnect with exponential back-off (capped at 30 s)
 *  - Returns events as they arrive via onEvent callback style AND as a state array
 *  - Exposes `connected` boolean and `mcpServers` roster
 *  - Marks itself offline when the server is unavailable
 */

import { useEffect, useRef, useState, useCallback } from 'react'
import { OfficeEvent, SessionView } from '../types'
import { SERVER_URL, WS_URL } from '../config'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AgentSocketOptions {
  /** Called for every incoming event. Stable reference recommended (useCallback). */
  onEvent?: (event: OfficeEvent) => void
  /** Called with the live session ids the server has, on every (re)connect snapshot */
  onSnapshot?: (ids: string[]) => void
  /** WebSocket URL — defaults to ws://localhost:3334/ws */
  url?: string
}

export interface AgentSocketResult {
  /** Whether the WebSocket is currently open */
  connected: boolean
  /** MCP server names discovered by the server (from ~/.claude/settings.json) */
  mcpServers: string[]
  /** Last N events received (capped at 50) */
  events: OfficeEvent[]
  /** True if the server has never been reachable since mount */
  offline: boolean
}

// ---------------------------------------------------------------------------
// Server snapshot message (sent on first connect)
// ---------------------------------------------------------------------------

interface SnapshotMessage {
  type: 'snapshot'
  /** Live sessions (2c): each one replays as session_changed */
  sessions?: SessionView[]
  mcpServers: string[]
  timestamp: number
}

type ServerMessage = OfficeEvent | SnapshotMessage

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const ROSTER_URL     = `${SERVER_URL}/roster`
const MAX_EVENTS     = 50
const BACKOFF_INITIAL = 500   // ms
const BACKOFF_MAX    = 30_000 // ms
const BACKOFF_FACTOR = 2

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export function useAgentSocket(options: AgentSocketOptions = {}): AgentSocketResult {
  const {
    onEvent,
    url     = WS_URL,
  } = options

  const [connected, setConnected]   = useState(false)
  const [mcpServers, setMcpServers] = useState<string[]>([])
  const [events, setEvents]         = useState<OfficeEvent[]>([])
  const [offline, setOffline]       = useState(false)

  // Refs so reconnect logic can read latest values without re-creating effects
  const wsRef          = useRef<WebSocket | null>(null)
  const retryCountRef  = useRef(0)
  const retryTimerRef  = useRef<ReturnType<typeof setTimeout> | null>(null)
  const mountedRef     = useRef(true)
  const onEventRef     = useRef(onEvent)
  const onSnapshotRef  = useRef(options.onSnapshot)

  useEffect(() => { onEventRef.current = onEvent }, [onEvent])
  useEffect(() => { onSnapshotRef.current = options.onSnapshot }, [options.onSnapshot])

  // ---------------------------------------------------------------------------
  // Roster fetch (runs once on mount; refreshes after reconnect)
  // ---------------------------------------------------------------------------
  const fetchRoster = useCallback(async () => {
    try {
      const res = await fetch(ROSTER_URL, { signal: AbortSignal.timeout(2000) })
      if (!res.ok) return
      const data = await res.json()
      if (mountedRef.current && Array.isArray(data.mcpServers)) {
        setMcpServers(data.mcpServers)
      }
    } catch {
      // Server not reachable — roster will come via snapshot message
    }
  }, [])

  // ---------------------------------------------------------------------------
  // Push an event into the local events array and call the onEvent callback
  // ---------------------------------------------------------------------------
  const pushEvent = useCallback((event: OfficeEvent) => {
    setEvents(prev => [...prev.slice(-(MAX_EVENTS - 1)), event])
    onEventRef.current?.(event)
  }, [])

  // ---------------------------------------------------------------------------
  // Process a raw message from the WebSocket
  // ---------------------------------------------------------------------------
  const handleMessage = useCallback((raw: string) => {
    let msg: ServerMessage
    try {
      msg = JSON.parse(raw)
    } catch {
      return
    }

    // Board file changed: BoardPanel listens on window, no second socket
    if ((msg as { type: string }).type === 'boards_changed') return void window.dispatchEvent(new CustomEvent('boards_changed', { detail: (msg as { board?: string }).board }))

    if (msg.type === 'snapshot') {
      const snap = msg as SnapshotMessage
      if (snap.mcpServers?.length) {
        setMcpServers(snap.mcpServers)
      }
      // Sessions already live: agents get no person (2c), so only sessions replay
      for (const v of snap.sessions ?? []) pushEvent({ type: 'session_changed', ...v })
      onSnapshotRef.current?.((snap.sessions ?? []).map(v => v.sessionId))
      return
    }

    // Regular office event
    pushEvent(msg as OfficeEvent)
  }, [pushEvent])

  // ---------------------------------------------------------------------------
  // Connect / reconnect logic
  // ---------------------------------------------------------------------------
  const connect = useCallback(() => {
    if (!mountedRef.current) return

    // Clean up any existing socket
    if (wsRef.current) {
      wsRef.current.onopen    = null
      wsRef.current.onmessage = null
      wsRef.current.onclose   = null
      wsRef.current.onerror   = null
      try { wsRef.current.close() } catch { /* ignore */ }
      wsRef.current = null
    }

    let ws: WebSocket
    try {
      ws = new WebSocket(url)
    } catch {
      // WebSocket constructor itself threw — schedule retry
      scheduleReconnect()
      return
    }

    wsRef.current = ws

    ws.onopen = () => {
      if (!mountedRef.current) return
      retryCountRef.current = 0
      setConnected(true)
      setOffline(false)
      fetchRoster()
    }

    ws.onmessage = (evt) => {
      if (!mountedRef.current) return
      handleMessage(evt.data)
    }

    ws.onclose = () => {
      if (!mountedRef.current) return
      setConnected(false)
      scheduleReconnect()
    }

    ws.onerror = () => {
      // onerror is always followed by onclose — let onclose handle retry
      if (retryCountRef.current === 0) {
        // First failure: mark as offline
        setOffline(true)
      }
    }
  }, [url, fetchRoster, handleMessage])

  const scheduleReconnect = useCallback(() => {
    if (!mountedRef.current) return

    if (retryTimerRef.current) {
      clearTimeout(retryTimerRef.current)
    }

    const delay = Math.min(
      BACKOFF_INITIAL * Math.pow(BACKOFF_FACTOR, retryCountRef.current),
      BACKOFF_MAX
    )
    retryCountRef.current += 1

    retryTimerRef.current = setTimeout(() => {
      if (mountedRef.current) connect()
    }, delay)
  }, [connect])

  // ---------------------------------------------------------------------------
  // Mount / unmount
  // ---------------------------------------------------------------------------
  useEffect(() => {
    mountedRef.current = true
    connect()

    return () => {
      mountedRef.current = false

      if (retryTimerRef.current) {
        clearTimeout(retryTimerRef.current)
        retryTimerRef.current = null
      }

      if (wsRef.current) {
        wsRef.current.onopen    = null
        wsRef.current.onmessage = null
        wsRef.current.onclose   = null
        wsRef.current.onerror   = null
        try { wsRef.current.close() } catch { /* ignore */ }
        wsRef.current = null
      }
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return { connected, mcpServers, events, offline }
}
