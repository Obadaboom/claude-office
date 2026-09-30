import React, { useEffect, useRef, useState, useCallback } from 'react'
import { ROLE_TO_CHAR, SERVER_URL } from '../config'
import { castOf, getSpriteDir, useTheme, toggleTheme, getTheme, themedDisplayName, castKey } from '../theme'

export function getAvatarSrc(role: string, agentId?: string): string {
  // Why: a line about an agent carries its id, so the avatar is that agent's cast member.
  // Read-only: chat history never deals a cast member; unknown -> the role's own sprite.
  const cast = castOf(castKey(agentId, role)) ?? castOf(role)
  return cast ? `${getSpriteDir()}/${cast}-front-right.png` : `/sprites/characters/${ROLE_TO_CHAR[role] ?? 'employee-3'}-front-right.png`
}

// Proactive message detection: agent announcements about starting/completing work
const PROACTIVE_PATTERN = /\b(starting|started|done|finished|completed|ready|working on|picking up|taking over)\b/i

export interface TypingUser {
  name: string
  role: string
  agentId?: string
}

export interface ChatMessage {
  id: number
  sender: string
  /** Agent the line is about, when known — avatar and name follow its cast */
  agentId?: string
  senderSprite: string
  senderColor: string
  text: string
  channel: string
  timestamp: string
  isSystem?: boolean
  /** Office flavour line (2f): canned banter, styled as an aside */
  aside?: boolean
  reactions?: string[]
}

/** 2q: a clicked hint chip fills the input (then focus) or runs like typing it + Enter */
export const chipAction = (cmd: string): { fill: string } | { run: string } =>
  cmd === '/new' ? { fill: '/new ' } : cmd === '@name' ? { fill: '@' } : { run: cmd }

const EMOJI_PICKER = ['👍', '👎', '😊', '🎉', '😡', '🔥', '💯']

interface SlackChatProps {
  messages: ChatMessage[]
  muted: boolean
  volume: number
  onToggleMute: () => void
  onVolumeChange: (v: number) => void
  onSendMessage?: (text: string) => void
  onReaction?: (messageId: number, reactions: string[]) => void
  /** 2o: `/dundies` — today's awards, client only */
  onDundies?: () => void
  dayPhase: string
  /** Who is typing — shows animated dots below the message list, with the face their next line will have */
  typingUser?: TypingUser | null
  /** ID of the last message seen by the assistant — renders a tiny seen avatar */
  lastSeenId?: number | null
}

const SlackChat: React.FC<SlackChatProps> = ({ messages, muted, volume, onToggleMute, onVolumeChange, onSendMessage, onReaction, onDundies, dayPhase, typingUser, lastSeenId }) => {
  const theme = useTheme()
  void theme // Why: subscribe so avatars re-render when /the-office toggles
  const bodyRef = useRef<HTMLDivElement>(null)
  const [inputText, setInputText] = useState('')
  const [showSlashHint, setShowSlashHint] = useState(false)
  const [emojiPickerMsgId, setEmojiPickerMsgId] = useState<number | null>(null)
  const pickerRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  // Close emoji picker on click outside
  useEffect(() => {
    if (emojiPickerMsgId === null) return
    const handler = (e: MouseEvent) => {
      if (pickerRef.current && !pickerRef.current.contains(e.target as Node)) {
        setEmojiPickerMsgId(null)
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [emojiPickerMsgId])

  const handleReaction = useCallback((msg: ChatMessage, emoji: string) => {
    const existing = msg.reactions || []
    const updated = existing.includes(emoji)
      ? existing.filter(r => r !== emoji)
      : [...existing, emoji]
    onReaction?.(msg.id, updated)
    setEmojiPickerMsgId(null)
  }, [onReaction])

  useEffect(() => {
    if (bodyRef.current) {
      bodyRef.current.scrollTo({ top: bodyRef.current.scrollHeight, behavior: 'smooth' })
    }
  }, [messages, typingUser])

  const run = (trimmed: string) => {
    // Client-side slash commands — not sent to backend
    if (trimmed === '/the-office' || trimmed === '/theoffice') {
      toggleTheme()
      const nowOn = getTheme() === 'office'
      onSendMessage?.(nowOn ? '🧻 Clauder Fablin mode: ON. Identity theft is not a joke.' : '🔁 Office theme: OFF')
    } else if (trimmed === '/dundies') {
      onDundies?.() // 2o: no chat line, nothing sent
    } else if (/^\/new(\s|$)/.test(trimmed)) {
      // 2n: a new app session in your home folder, prompt pre-filled; no chat line, nothing sent to Claude
      fetch(`${SERVER_URL}/sessions/new`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ q: trimmed.slice(4).trim() }) }).catch(() => {})
    } else {
      onSendMessage?.(trimmed)
    }
    setInputText('')
    setShowSlashHint(false)
  }

  const clickChip = (cmd: string) => {
    const a = chipAction(cmd)
    if ('run' in a) return run(a.run)
    setInputText(a.fill)
    setShowSlashHint(false)
    inputRef.current?.focus()
  }

  const displayed = messages.slice(-12)
  const onlineCount = new Set(messages.slice(-20).filter(m => !m.isSystem).map(m => m.sender)).size

  return (
    <div className="slack-panel">
      <div className="slack-header">
        <div className="slack-channel-icon">#</div>
        <span className="slack-channel-name">office-general</span>
        <div className="slack-header-right">
          <div className="slack-online-dot" />
          <span className="slack-online-count">{onlineCount}</span>
          <button className="slack-mute-btn" onClick={onToggleMute}>
            {muted ? '🔇' : volume < 0.4 ? '🔈' : '🔊'}
          </button>
          <input
            type="range"
            min="0"
            max="100"
            value={Math.round(volume * 100)}
            onChange={e => onVolumeChange(Number(e.target.value) / 100)}
            className="slack-volume-slider"
            title={`Volume: ${Math.round(volume * 100)}%`}
          />
        </div>
      </div>

      <div className="slack-body" ref={bodyRef}>
        {displayed.map((msg) => {
          const isProactive = !msg.isSystem && PROACTIVE_PATTERN.test(msg.text)
          return (
            <React.Fragment key={msg.id}>
              <div
                className={`slack-msg${msg.isSystem ? ' slack-msg-system' : ''}${isProactive ? ' slack-msg-proactive' : ''}`}
                onDoubleClick={() => !msg.isSystem && setEmojiPickerMsgId(prev => prev === msg.id ? null : msg.id)}
              >
                {!msg.isSystem && (
                  <div className="slack-avatar" style={{ border: `2px solid ${msg.senderColor}`, boxShadow: `0 0 6px ${msg.senderColor}40` }}>
                    <img
                      src={getAvatarSrc(msg.senderSprite, msg.agentId)}
                      alt={msg.sender}
                      className="slack-avatar-img"
                      onError={(e) => {
                        (e.target as HTMLImageElement).style.display = 'none'
                      }}
                    />
                    <div
                      className="slack-avatar-fallback"
                      style={{ background: msg.senderColor }}
                    />
                  </div>
                )}
                <div className="slack-msg-content">
                  {!msg.isSystem && (
                    <div className="slack-msg-header">
                      <span className="slack-sender" style={{ color: msg.senderColor }}>
                        {themedDisplayName(castKey(msg.agentId, msg.senderSprite), msg.sender)}
                      </span>
                      <span className="slack-time">{msg.timestamp}</span>
                    </div>
                  )}
                  <div className={`slack-msg-text${msg.isSystem ? ' slack-system-text' : ''}${msg.aside ? ' slack-msg-aside' : ''}`}>
                    {msg.text}
                  </div>
                  {msg.reactions && msg.reactions.length > 0 && (
                    <div className="slack-reactions">
                      {msg.reactions.map((r, i) => (
                        <span
                          key={i}
                          className="slack-reaction"
                          onClick={() => handleReaction(msg, r)}
                          title="Click to remove"
                        >{r}</span>
                      ))}
                    </div>
                  )}
                  {emojiPickerMsgId === msg.id && (
                    <div className="slack-emoji-picker" ref={pickerRef}>
                      {EMOJI_PICKER.map(emoji => (
                        <button
                          key={emoji}
                          className={`slack-emoji-btn${msg.reactions?.includes(emoji) ? ' active' : ''}`}
                          onClick={() => handleReaction(msg, emoji)}
                        >{emoji}</button>
                      ))}
                    </div>
                  )}
                </div>
              </div>
              {lastSeenId != null && msg.id === lastSeenId && (
                <div className="slack-seen-row">
                  <span className="slack-seen-label">Seen</span>
                  <img src={getAvatarSrc('assistant')} className="slack-seen-avatar" alt="seen" />
                </div>
              )}
            </React.Fragment>
          )
        })}
        {typingUser && (
          <div className="slack-msg slack-typing-row">
            <div className="slack-avatar" style={{ border: '2px solid #cc785c', boxShadow: '0 0 6px #cc785c40' }}>
              <img src={getAvatarSrc(typingUser.role, typingUser.agentId)} alt="typing" className="slack-avatar-img" />
            </div>
            <div className="slack-msg-content">
              <div className="slack-typing-label">{typingUser.name} is typing</div>
              <div className="slack-typing-dots"><span/><span/><span/></div>
            </div>
          </div>
        )}
      </div>

      <div className="slack-input-wrap">
        {showSlashHint && (
          <div className="slack-slash-hint">
            {['/new', '/the-office', ...(getTheme() === 'office' ? ['/dundies', '@name'] : [])].map(cmd => (
              // mousedown + preventDefault: the input keeps focus, so its blur never hides the chips mid-click
              <span key={cmd} className="slack-slash-cmd" onMouseDown={e => { e.preventDefault(); clickChip(cmd) }}>{cmd}</span>
            ))}
          </div>
        )}
        <div className="slack-input-bar">
          <input
            ref={inputRef}
            type="text"
            className="slack-input-field"
            placeholder="Message #office-general"
            value={inputText}
            onChange={e => {
              const val = e.target.value
              setInputText(val)
              setShowSlashHint(val === '/' || (val === '@' && getTheme() === 'office'))
            }}
            onKeyDown={e => {
              if (e.key === 'Escape') {
                setShowSlashHint(false)
                return
              }
              if (e.key === 'Enter' && inputText.trim()) run(inputText.trim())
            }}
            onBlur={() => setTimeout(() => setShowSlashHint(false), 150)}
          />
        </div>
      </div>
    </div>
  )
}

export default SlackChat
