/** chatter.ts — Office flavour lines for chat only (2f, 2o). Canned, $0; real started/finished lines stay unique. */

import { REGULARS, slugToName } from './theme'

type Rand = () => number
export const pick = <T>(pool: readonly T[], rand: Rand = Math.random): T => pool[Math.floor(rand() * pool.length)]

/** The one knob: gap between cast exchanges (ms). */
export const CONVO_GAP_MS: [number, number] = [60_000, 120_000]

export interface ConvoLine { slug: string; text: string }
const c = (...lines: [string, string][]): ConvoLine[] => lines.map(([slug, text]) => ({ slug, text }))

export const CONVOS: ConvoLine[][] = [
  c(['jim-halpert', 'Bears. Beets. Battlestar Galactica.'], ['dwight-schrute', 'Identity theft is not a joke, Jim! Millions of families suffer every year!'], ['jim-halpert', 'MICHAEL!']),
  c(['jim-halpert', 'Question. What kind of bear is best?'], ['dwight-schrute', "That's a ridiculous question."], ['jim-halpert', 'False. Black bear.']),
  c(['pam-beesly', 'Someone put a stapler in Jell-O again.'], ['dwight-schrute', 'JIM!'], ['jim-halpert', '(looks at camera)']),
  c(['jim-halpert', '(restarts his computer)'], ['dwight-schrute', '(holds out his hand for a mint)'], ['dwight-schrute', 'Why did I just do that?']),
  c(['dwight-schrute', 'A fax from Future Dwight. The coffee is poisoned!'], ['stanley-hudson', 'Did you just slap the cup out of my hand?']),
  c(['dwight-schrute', 'As assistant regional manager, I—'], ['michael-scott', 'Assistant TO the regional manager, Dwight.']),
  c(['andy-bernard', 'Parkour!'], ['dwight-schrute', 'Parkour!'], ['michael-scott', 'PARKOUR!']),
  c(['oscar-martinez', 'This merge is way harder than it needs to be.'], ['michael-scott', "That's what she said."]),
  c(['michael-scott', "I'm not superstitious, but I am a little stitious."], ['oscar-martinez', "That's... not a word, Michael."]),
  c(['michael-scott', 'I declare... BANKRUPTCY!'], ['oscar-martinez', "You can't just say the word, Michael."]),
  c(['michael-scott', 'Would I rather be feared or loved? Easy. Both.'], ['jim-halpert', 'Solid plan.']),
  c(['michael-scott', "Sometimes I start a sentence and I don't even know where it's going."], ['pam-beesly', 'We know.']),
  c(['michael-scott', "Anyone want Chili's?"], ['pam-beesly', "I feel God in this Chili's tonight."], ['stanley-hudson', 'No.']),
  c(['michael-scott', 'Stanley, are you upset with me?'], ['stanley-hudson', 'Did I stutter?']),
  c(['kevin-malone', 'Pretzel Day!'], ['stanley-hudson', 'Best day of the year. Move.']),
  c(['kevin-malone', 'Why waste time say lot word when few word do trick?'], ['oscar-martinez', 'Kevin, please.'], ['kevin-malone', 'Me think no.']),
  c(['kevin-malone', 'Brought my famous chili today.'], ['oscar-martinez', "Please don't carry it by yourself."], ['kevin-malone', 'Too late.']),
  c(['andy-bernard', "I'm always thinking one step ahead. Like a carpenter that makes stairs."], ['jim-halpert', '(looks at camera)']),
  c(['andy-bernard', 'I went to Cornell. Ever heard of it?'], ['stanley-hudson', 'Every day. Every single day.']),
  c(['pam-beesly', 'My grandma sent me cookies.'], ['angela-martin', 'Lucky. Some of us have to be our own grandmothers.']),
  c(['dwight-schrute', 'Surprise fire drill in five minutes.'], ['angela-martin', 'Absolutely not. My cats are still recovering.']),
  c(['creed-bratton', "Just pretend like we're talking until the cameras leave."], ['pam-beesly', '...Okay.']),
  c(['creed-bratton', 'Nobody steals from Creed Bratton and gets away with it.'], ['pam-beesly', 'Nobody took anything, Creed.']),
  c(['pam-beesly', "Any New Year's resolutions, Meredith?"], ['meredith-palmer', 'I gave up drinking. During the week.']),
  c(['michael-scott', 'Phyllis, you look nice today.'], ['phyllis-vance', 'Close your mouth, sweetie. You look like a trout.']),
  c(['phyllis-vance', 'Bob Vance says hi.'], ['jim-halpert', 'Bob Vance, Vance Refrigeration.']),
  c(['michael-scott', "I'm Prison Mike. The worst thing about prison was the Dementors."], ['pam-beesly', "That's Harry Potter, Michael."]),
]

/** A character gets a job: one short comment. Keyed by regular slug; `default` for overflow walkers. */
export const JOB_LINES: Record<string, string[]> = {
  'dwight-schrute': ['Assistant to the regional manager, reporting.', 'Fact: I am faster than 80% of all snakes. On it.', 'Would an idiot do this? No. So I will.', 'Question. Why is this not done yet?'],
  'jim-halpert': ['On it. (looks at camera)', 'Sure. Big Tuna is on the case.', 'Question: what kind of bug is best?'],
  'pam-beesly': ['Clauder Fablin, this is Pam. On it.', "I'll take it. Adding it to the sketchbook.", 'Got it, one sec.'],
  'kevin-malone': ['Kevin do job. Job good.', 'Few word. On it.', 'I just want to lie on the beach and eat hot dogs. But fine.'],
  'angela-martin': ["Fine. But I'm doing it properly.", 'On it. No one touch my files.', 'Sprinkles would have done this faster.'],
  'oscar-martinez': ['Actually, let me do it right.', 'On it. Somebody has to be the adult here.', 'Numbers check out. On it.'],
  'stanley-hudson': ["Fine. But I'm leaving at five.", 'Did I stutter? On it.', 'Is it pretzel day? No? Fine.'],
  'phyllis-vance': ["On it, dear. Bob Vance would be proud.", 'Close your mouth, sweetie. I got it.', 'Knitting can wait.'],
  'andy-bernard': ['Nard Dog is ON it!', 'One step ahead. Like a carpenter that makes stairs.', 'Cornell prepared me for this.'],
  'creed-bratton': ['Sure. What is this company again?', "On it. Don't ask how.", 'I sprout mung beans on a damp paper towel. Also, on it.'],
  'meredith-palmer': ['On it. Then happy hour.', 'Sure thing. Is it Friday?', 'Got it. Back in a sec.'],
  default: ['On it. Paper, paper, paper.', 'Reporting to Scranton branch.', 'Punching in, Clauder Fablin style.'],
}

/** Michael on a furniture click. Keyed by getInteraction id; `default` for anything else. */
export const MICHAEL_LINES: Record<string, string[]> = {
  'plant-1': ['Watering the monstera. Stay green, little guy.'],
  'plant-2': ['Hydration station for the snake plant.'],
  'plant-3': ['Grow, baby, grow. Money tree!'],
  'plant-4': ['Keeping the office green. World\'s best plant boss.'],
  'plant-5': ['This one is thriving. Like me.'],
  coffee: ['Brewing a fresh pot. Who else needs coffee?', 'Coffee time! Fueling up.'],
  'filing-1': ['Where did I put that doc...', 'Looking for the Q4 report.'],
  'printer-1': ["Please don't jam. Please don't jam.", 'Who even prints anymore? Me. I do.'],
  whiteboard: ['Updating the board. Sprint looks good.', 'Adding a post-it. Genius at work.'],
  'fire-extinguisher': ['Safety first. Still in date, nice.', 'Hope we never need this. Dwight, no.', 'Everybody stay calm! STAY CALM!'],
  'water-cooler': ['Water break. Angela says water only.', 'Hydration check, people.'],
  bell: ['Ding ding! Attention everyone!', 'All hands! Conference room, five minutes.'],
  'kanban-board': ['Who left this ticket in review?', 'Moving tickets. Very managerial.'],
  'ship-it-poster': ['Ship it! That poster never gets old.', "Let's gooo."],
  'tv-monitor': ['Checking the dashboard. All systems green.', 'Uptime looking solid.'],
  'boss-desk': ['Checking the big boss inbox.', 'Anything need a decision? I am great at decisions.'],
  default: ["That's what she said.", 'Well, well, well. How the turntables...', 'I am Beyoncé, always.'],
}

/** Next convo index, never `last` (-1 = none yet). */
export function pickConvo(last: number, rand: Rand = Math.random): number {
  if (last < 0) return Math.floor(rand() * CONVOS.length)
  const i = Math.floor(rand() * (CONVOS.length - 1))
  return i >= last ? i + 1 : i
}

export const jobLine = (slug: string, rand: Rand = Math.random) => pick(JOB_LINES[slug] ?? JOB_LINES.default, rand)
export const michaelLine = (itemId: string, rand: Rand = Math.random) => pick(MICHAEL_LINES[itemId] ?? MICHAEL_LINES.default, rand)
/** Random ms in [min, max]: flavour timing only (movement stays real). */
export const between = (min: number, max: number, rand: Rand = Math.random) => min + rand() * (max - min)
export const convoDelay = (rand: Rand = Math.random) => between(...CONVO_GAP_MS, rand)

// ---------------------------------------------------------------------------
// 2o: chat you can play with. `{name}` = the real person the line is about.
// ---------------------------------------------------------------------------

/** A real finish that went fine */
export const WIN_LINES: ConvoLine[] = c(
  ['michael-scott', 'I declare... SHIPPED!'],
  ['michael-scott', 'Another one out the door. World\'s best boss, confirmed.'],
  ['kevin-malone', 'Job done. Me celebrate with M&Ms.'],
  ['andy-bernard', 'Nailed it! Rit dit dit di doo!'],
)
/** A real finish whose result reads like an error */
export const BLAME_LINES: ConvoLine[] = c(['dwight-schrute', 'JIM!'], ['dwight-schrute', 'JIM! I know this was you.'])
/** A real job still running after 10 min */
export const WATCH_LINES: ConvoLine[] = c(
  ['stanley-hudson', '(checks watch) {name} has been at it ten minutes. I leave at five.'],
  ['stanley-hudson', '{name} is still going? Some of us have crosswords.'],
)
/** A real session starts waiting on you */
export const WAIT_LINES: ConvoLine[] = c(
  ['pam-beesly', '{name} is waiting for you.'],
  ['pam-beesly', 'Heads up, {name} needs you. I can take a message.'],
)

/** @mention replies: every cast member with a sprite, in their show persona */
export const MENTION_LINES: Record<string, string[]> = {
  'michael-scott': ["You rang? World's best boss, at your service.", "That's what she said. Wait, what did you say?", 'Boom. Roasted.'],
  'dwight-schrute': ['Question. Why are you addressing me?', 'Fact: I am always listening.', 'Speak. I have beets to harvest.'],
  'jim-halpert': ['(looks at camera)', "Hey. What's up?", 'Sure, sounds good. (it does not)'],
  'pam-beesly': ['Clauder Fablin, this is Pam.', 'Hi! Want me to draw you something?', "I'm on it. Also, Jim says hi."],
  'kevin-malone': ['Me here. What need?', 'Is this about the chili? Not my fault.', "Why say lot word when few word do trick? Hi."],
  'angela-martin': ["I'm busy. With the cats.", "Don't @ me unless it's important.", 'Fine. What.'],
  'oscar-martinez': ['Actually, let me explain.', "I'm going to need you to be more specific.", 'Numbers are fine. What else?'],
  'stanley-hudson': ['Did I stutter?', "I'm doing my crossword.", "Unless it's pretzel day, no."],
  'phyllis-vance': ['Hello, sweetie.', "Bob Vance says hi.", "Close your mouth, dear. I'm listening."],
  'andy-bernard': ['Nard Dog here! What up?', 'Did I mention I went to Cornell?', 'Rit dit dit di doo!'],
  'creed-bratton': ['Who are you again?', "I've been involved in a number of cults. What do you need?", 'Sure. Cash only.'],
  'meredith-palmer': ['Is it happy hour yet?', 'What? I was on break.', 'Sure, hon. After lunch.'],
  'ryan-howard': ["I'm kind of a big deal now. What?", 'Did you see my WUPHF.com pitch?', 'Just got back from the business school.'],
  'toby-flenderson': ['Hi. HR has a form for that.', 'Sorry. I know. Sorry.', 'I just came to say hi. Okay, bye.'],
  'kelly-kapoor': ['OMG hi! Did you see what Ryan posted?', "I talk a lot, so I've learned to tune myself out.", 'Wait, is this gossip?'],
  'darryl-philbin': ['Warehouse is fine. What you need?', "Don't make me come up there.", 'Hey. I got a minute.'],
  'erin-hannon': ['Hi! This is Erin at reception.', "I'm so happy you messaged me!", 'Is that a question? I love questions.'],
  'gabe-lewis': ['Gabe Lewis, Sabre. How can I help?', 'Just checking in. Corporately.', "I'm here. Tall and ready."],
  'holly-flax': ['Hi! HR, but the fun kind.', 'Aww, you remembered me.', 'Want to do a Yoda voice with me?'],
  'jan-levinson': ['This better be good.', "I'm here. Keep it short.", "I have a candle business to run."],
  'karen-filippelli': ['Hey. Stamford is still better.', "What's up?", 'Sure. What do you need?'],
  'nellie-bertram': ["Darling! You rang?", "I'm very much in charge here now.", 'Lovely. What is it?'],
  'robert-california': ['Everything is sex. Except this. What is it?', 'I am the Lizard King.', 'Speak. I am listening intently.'],
  'roy-anderson': ["Hey. What's up, man?", 'Warehouse is slow today.', 'Sure. After my shift.'],
  'bob-vance': ['Bob Vance, Vance Refrigeration.', 'Bob Vance here. Need a fridge?', 'Phyllis says hi.'],
  'carol-stills': ['Hi. Carol, from the realty.', "Is this about Michael? It's always about Michael.", 'Sure, happy to help.'],
  'david-wallace': ['David Wallace, corporate. What can I do?', 'Suck It. The vacuum, I mean.', 'Keep it brief, please.'],
}

/** Word replies to your own line, first match wins; one entry = one 30 s cooldown */
export const WORD_REPLIES: { re: RegExp; slug: string; lines: string[] }[] = [
  { re: /\b(hard|long|big|huge)\b/i, slug: 'michael-scott', lines: ["That's what she said."] },
  { re: /\bpretzels?\b/i, slug: 'stanley-hudson', lines: ['Did someone say pretzel?', "It's pretzel day? Move."] },
  { re: /\bchili\b/i, slug: 'kevin-malone', lines: ['Chili. Me famous for chili.', 'The trick is undercook the onions.'] },
  { re: /\b(bears?|beets?)\b/i, slug: 'dwight-schrute', lines: ['Bears. Beets. Battlestar Galactica.', 'Fact: bears eat beets.'] },
  { re: /\b(staplers?|jell-?o)\b/i, slug: 'dwight-schrute', lines: ['JIM!'] },
  { re: /\b(cats?|party)\b/i, slug: 'angela-martin', lines: ['The Party Planning Committee will decide that.', 'My cats would never.'] },
  { re: /\bcornell\b/i, slug: 'andy-bernard', lines: ['Did someone say Cornell? I went there.', 'Go Big Red!'] },
  { re: /\bbob vance\b/i, slug: 'phyllis-vance', lines: ['Bob Vance, Vance Refrigeration.', 'Bob is picking me up at five.'] },
  { re: /\bhappy hour\b/i, slug: 'meredith-palmer', lines: ["I'm in.", 'First round is on Creed.'] },
  { re: /\bprison\b/i, slug: 'michael-scott', lines: ["I'm Prison Mike. The worst thing about prison was the Dementors."] },
]

/** Jim's panel: pick one, a 2-3 line scene plays */
export const PRANKS: Record<string, ConvoLine[]> = {
  'Jell-O': c(['dwight-schrute', 'My stapler is in Jell-O. AGAIN.'], ['jim-halpert', '(looks at camera)'], ['dwight-schrute', 'JIM!']),
  Altoid: c(['jim-halpert', '(restarts his computer)'], ['dwight-schrute', '(holds out his hand for a mint)'], ['dwight-schrute', 'Why did I just do that?']),
  'vending machine': c(['dwight-schrute', 'Why is my stuff in the vending machine?'], ['jim-halpert', 'Try B-7. That is your pens.']),
  'Future Dwight fax': c(['dwight-schrute', 'A fax from Future Dwight. The coffee is poisoned!'], ['stanley-hudson', 'Did you just slap the cup out of my hand?']),
}

export const DUNDIE_JOKES = [
  'Whitest Sneakers', "Don't Go In There After Me", 'Spicy Curry', 'Fine Work', 'Busiest Beaver',
  'Tightest Ass', 'Best Dundie Host', 'Longest Engagement', 'Hottest in the Office', 'Kind of a Big Deal',
]

/** True (and marks `key`) when `ms` has passed since it last fired */
export function ready(last: Map<string, number>, key: string, ms: number, now: number) {
  if (now - (last.get(key) ?? -Infinity) < ms) return false
  last.set(key, now)
  return true
}

// ponytail: word heuristic (SubagentStop carries no error flag); a real exit code would beat it
export const isErrorResult = (result: string) =>
  /\b(errors?|fail(ed|s|ures?)?|crash(ed|es)?|exception)\b/i.test(result.replace(/\b(0|no|zero)\s+(errors?|fail(ed|s|ures?)?)\b/gi, ''))

const FIRST_NAMES = Object.keys(MENTION_LINES).map(slug => [slug.split('-')[0], slug] as const)
/** The cast slug of the first `@firstname` with a sprite, else undefined */
export function mentionOf(text: string) {
  for (const [, name] of text.matchAll(/(?<!\w)@([a-z]+)\b/gi)) {
    const hit = FIRST_NAMES.find(([first]) => first === name.toLowerCase())
    if (hit) return hit[1]
  }
}

/** First ready word trigger in list order (marks its cooldown), else undefined */
export const wordReply = (text: string, last: Map<string, number>, now: number) =>
  WORD_REPLIES.find((w, i) => w.re.test(text) && ready(last, `word-${i}`, 30_000, now))

/** Local date key (Dundies once a day) */
export const dayOf = (now: number) => new Date(now).toDateString()
export const dundiesDue = (now: number, lastDate: string | null) => new Date(now).getHours() >= 17 && lastDate !== dayOf(now)

/** Michael's Dundies from today's real finishes ({seat, ms}); null seats are skipped */
export function dundieLines(jobs: { seat: number | null; ms: number }[], rand: Rand = Math.random): string[] {
  const named = jobs.filter(j => j.seat != null && REGULARS[j.seat]).map(j => ({ name: slugToName(REGULARS[j.seat!]), ms: j.ms }))
  if (!named.length) return ['No Dundies today. Nobody shipped a thing. Not even Toby.']
  const counts = new Map<string, number>()
  for (const j of named) counts.set(j.name, (counts.get(j.name) ?? 0) + 1)
  const [top, n] = [...counts].reduce((a, b) => (b[1] > a[1] ? b : a))
  const long = named.reduce((a, b) => (b.ms > a.ms ? b : a))
  return [
    `The Dundie for Most Jobs goes to... ${top}! ${n} today.`,
    `Longest Job Dundie: ${long.name}, ${Math.max(1, Math.round(long.ms / 60_000))} min. Worth it.`,
    `And the ${pick(DUNDIE_JOKES, rand)} Dundie goes to... ${slugToName(pick(REGULARS, rand))}!`,
  ]
}
