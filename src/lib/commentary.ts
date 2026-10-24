/**
 * Watcher commentary — a ~50-entry Gen Z quip pool (single source of
 * commentary voice; COPY in copy.ts stays the source for error/result
 * copy). randomQuip is deterministic-testable via an injectable rng.
 */

const QUIPS: readonly string[] = [
  'the vibes are immaculate rn',
  'ok that one goes kinda hard',
  'who gave them the aux?? oh wait',
  'this is giving main character energy',
  'no because this slaps actually',
  'the timeline is TIMELINING',
  'skill issue fr',
  'certified banger alert 🚨',
  'not me obsessing over a release date',
  'this playlist ate and left no crumbs',
  'bro really said "trust me" with that slot',
  'the anchor song could never',
  'we are SO back',
  'chronological order? in this economy?',
  'someone is cooking and it is not the host',
  'the delulu is strong with this line',
  'he’s a poet, she’s a poet, that track is OLD',
  'waiting for the drop like it’s 2016',
  'this is my roman empire fr',
  'year? yes. correct slot? we will see',
  'I can hear this one through the phone',
  'throwing it back to whenever this dropped',
  'the algorithm could never make this playlist',
  'that placement was giving unjust',
  'no crumbs. none. clean line.',
  'the girls that get it, get it',
  'living vicariously through this deck rn',
  'someone call spotify, we found their worst nightmare',
  'this beat is doing numbers in my heart',
  'ratio? nah this is a whole timestamp',
  'the suspense is NOT subtle',
  'we do a little archaeology 🦴',
  'certified time traveler behavior',
  'that was a history lesson no cap',
  'it’s giving museum but make it music',
  'one song closer to the W',
  'not the host judging everyone’s memory',
  'the year? unknown. the vibe? undeniable.',
  'bro placed that with their whole chest',
  'the precision??? on this app???',
  'we stay winning (some of us)',
  'this line is a whole documentary',
  'do NOT drop it in the wrong slot',
  'your music taste is showing 💀',
  'brb crying over release dates',
  'the deck never misses ok',
  'everyone’s a critic at 2am',
  'that slot choice was bold ngl',
  'may the decade be ever in your favor',
  'this hits different when you know the year',
] as const;

/** Deterministic-testable rng (defaults to Math.random). */
export function randomQuip(rng: () => number = Math.random): string {
  const i = Math.floor(rng() * QUIPS.length) % QUIPS.length;
  return QUIPS[(i + QUIPS.length) % QUIPS.length];
}

/** Pool size — exported so tests can assert ~50 entries. */
export const QUIP_COUNT = QUIPS.length;