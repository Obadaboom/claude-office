// Retro 8-bit sound effects using Web Audio API
let ctx: AudioContext | null = null
let masterVolume = 0.5  // 0–1

// 2i: made (or woken) only by a page click. Before the first one every sound is skipped: nothing queues for later.
if (typeof window !== 'undefined') window.addEventListener('pointerdown', () => { (ctx ??= new AudioContext()).resume().catch(() => {}) }, true)

function beep(freq: number, duration: number, type: OscillatorType = 'square', vol = 0.08) {
  if (masterVolume === 0 || !ctx) return
  const c = ctx
  const osc = c.createOscillator()
  const gain = c.createGain()
  osc.type = type
  osc.frequency.value = freq
  gain.gain.value = vol * masterVolume
  gain.gain.exponentialRampToValueAtTime(0.001, c.currentTime + duration)
  osc.connect(gain)
  gain.connect(c.destination)
  osc.start()
  osc.stop(c.currentTime + duration)
}

export function playNotification() {
  beep(880, 0.1, 'sine', 0.06)
  setTimeout(() => beep(1100, 0.15, 'sine', 0.06), 120)
}

/** A person's own pitch (Hz, 300–800), fixed by their id so each one sounds a bit different */
export function pitchOf(id: string) {
  let h = 0
  for (const ch of id) h = (h * 31 + ch.charCodeAt(0)) >>> 0
  return 300 + (h % 500)
}

/** You click a person: one short soft blip */
export function playPerson(pitch: number) {
  beep(pitch, 0.12, 'triangle', 0.1)
}

/** You asked that person's session something: a quick rising "on it" */
export function playOnIt(pitch: number) {
  beep(pitch, 0.1, 'triangle', 0.1)
  setTimeout(() => beep(pitch * 1.25, 0.14, 'triangle', 0.1), 110)
}

export function playCoffee() {
  if (masterVolume === 0) return
  for (let i = 0; i < 5; i++) {
    setTimeout(() => beep(150 + Math.random() * 100, 0.08, 'sawtooth', 0.02), i * 100)
  }
}

export function playBell() {
  if (masterVolume === 0) return
  // Bright metallic ding-ding
  beep(1400, 0.2, 'sine', 0.08)
  setTimeout(() => beep(1800, 0.15, 'sine', 0.06), 150)
  setTimeout(() => beep(1400, 0.1, 'sine', 0.04), 350)
}

// ---------------------------------------------------------------------------
// Volume control (0–1)
// ---------------------------------------------------------------------------
let preMuteVolume = 0.5  // restored when unmuting

export function setVolume(v: number) {
  masterVolume = Math.max(0, Math.min(1, v))
  if (masterVolume > 0) preMuteVolume = masterVolume
}
export function getVolume() { return masterVolume }
export function toggleMute() {
  if (masterVolume > 0) {
    preMuteVolume = masterVolume
    masterVolume = 0
  } else {
    masterVolume = preMuteVolume > 0 ? preMuteVolume : 0.5
  }
  return masterVolume === 0
}
