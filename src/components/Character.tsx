import React, { useRef } from 'react'
import { Agent, AgentState } from '../types'
import { ROLE_TO_CHAR } from '../config'
import { getSpritePath, useTheme } from '../theme'
import type { SeatDraw } from '../agentManager'

export { ROLE_TO_CHAR }

interface CharacterProps {
  agent: Agent
  /** Override z-index (for agents sitting behind desks) */
  zIndex?: number
  /** Seated draw (2h, Michael in his chair): hip line on the seat, nothing drawn below it */
  seat?: SeatDraw
  onClick?: () => void
}

// Movement direction → sprite variant. front = facing the camera. front-left faces
// down-right and rear-left faces up-right on screen (checked per pose).
type SpriteDirection = 'front-left' | 'front-right' | 'rear-left' | 'rear-right'

export function getDirectionFromDelta(dx: number, dy: number): SpriteDirection {
  if (dy >= 0) return dx >= 0 ? 'front-left' : 'front-right' // down-right / down-left
  return dx >= 0 ? 'rear-left' : 'rear-right'                  // up-right / up-left
}

function getCharBase(role: string): string {
  return ROLE_TO_CHAR[role] ?? 'employee-3'
}

// Anim class when standing still ('walking' comes from actual movement, see isMoving)
function getAnimState(state: AgentState): string {
  switch (state) {
    case 'working':             return 'working'
    case 'talking-to-manager':  return 'talking'
    case 'coffee-break':        return 'coffee'
    default:                    return 'idle'
  }
}

const Character: React.FC<CharacterProps> = ({ agent, zIndex, seat, onClick }) => {
  const prevPosRef = useRef({ x: agent.position.x, y: agent.position.y })
  const directionRef = useRef<SpriteDirection>(agent.spriteFacing ?? 'front-right')

  // Moving = still has somewhere to go (any state: new hire, back to desk, break, leaving)
  const isMoving = (agent.pathQueue?.length ?? 0) > 0 ||
    agent.position.x !== agent.targetPosition.x || agent.position.y !== agent.targetPosition.y

  // Calculate movement direction when walking
  const dx = agent.position.x - prevPosRef.current.x
  const dy = agent.position.y - prevPosRef.current.y

  if (isMoving && (Math.abs(dx) > 0.005 || Math.abs(dy) > 0.005)) {
    directionRef.current = getDirectionFromDelta(dx, dy)
  } else if (!isMoving && agent.spriteFacing) {
    // At a spot — use the spot's facing direction
    directionRef.current = agent.spriteFacing
  }
  prevPosRef.current = { x: agent.position.x, y: agent.position.y }

  const animState = isMoving ? 'walking' : getAnimState(agent.state)
  const charBase = getCharBase(agent.role)
  const theme = useTheme() // Why: re-render on theme toggle so sprite path updates
  const spriteSrc = getSpritePath(agent.id, agent.role, charBase, directionRef.current)
  void theme

  return (
    <div
      data-agent-id={agent.id}
      className={`character-wrapper state-${animState}${seat ? ' seated' : ''}`}
      style={{
        left: `${seat ? seat.x : agent.position.x}%`,
        top: `${seat ? seat.y : agent.position.y}%`,
        transform: `translate(-50%, -${seat ? seat.hip * 100 : 100}%)`,
        zIndex: zIndex ?? Math.round(agent.position.y * 10), // painter order by feet-y
      }}
    >
      <div className="char-body-group">
        {!seat && <div className="char-shadow" />}
        <img
          src={spriteSrc}
          alt={agent.name}
          className="char-sprite"
          style={{
            height: agent.id.startsWith('boss-') ? 85 : 78,
            width: 'auto',
            filter: `drop-shadow(0 0 1px ${agent.color}) drop-shadow(0 0 0.5px #000)`,
            animationDelay: `${(agent.id.charCodeAt(0) * 0.37) % 3}s`,
            clipPath: seat ? `inset(0 0 ${Math.round((1 - seat.hip) * 100)}% 0)` : undefined,
            pointerEvents: 'auto',
            cursor: 'pointer',
          }}
          draggable={false}
          onClick={onClick}
        />
      </div>
    </div>
  )
}

export default Character
