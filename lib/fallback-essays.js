'use strict';

/**
 * Offline essay library for Pacer.
 *
 * Used whenever llama-server is unreachable, too slow, or returns something we
 * cannot use. Two mechanisms:
 *   1. Canned essays on common cheerful topics (keyword matched against the
 *      requested topic).
 *   2. buildTopicEssay(): a template-driven essay that interpolates whatever
 *      topic was asked for, so an arbitrary request never comes back generic.
 */

const TARGET_WORDS = 300;
const DEFAULT_WORDS = TARGET_WORDS;
/** Bounds for a requested essay length, shared by the API and the UI. */
const MIN_WORDS = 50;
const MAX_WORDS = 5000;

/** Sentences used to pad a short essay up to the target length. */
const FILLER_SENTENCES = [
  'And honestly, that is more than enough reason to smile today.',
  'The best part is that none of it requires permission, money, or a special occasion.',
  'It simply asks for a little attention, which is the cheapest gift any of us own.',
  'Small pleasures like these tend to compound quietly in the background of a life.',
  'They rarely announce themselves, but they are almost always available.',
  'All it takes is noticing, and noticing is a habit anyone can practice.',
  'There is a kindness in that, and kindness has a way of travelling outward.',
  'You might find yourself recommending it to a friend before the week is over.',
  'The world could use more of this, and the supply is fortunately unlimited.',
  'So it is worth keeping close, even on the busiest of days.',
  'Give it five unhurried minutes and see what happens to your mood.',
  'Chances are good that you will want to come back for more tomorrow.'
];

/**
 * Interchangeable sentence variants, grouped by the idea they express.
 * Each group takes the topic and returns one grammatical sentence, so a long
 * essay can be assembled by rotating groups *and* variants — which keeps a
 * 1200-word offline essay from reading like the same paragraph on repeat.
 *
 * IMPORTANT: the topic is never the grammatical subject. It only ever appears
 * after a preposition or as the object of a verb, so an arbitrary topic phrase
 * ("otters", "quantum computing", "the ocean") can never break subject-verb
 * agreement.
 */
const TOPIC_SENTENCE_GROUPS = [
  [
    (t) => `There is something genuinely wonderful about ${t}, and it deserves a moment of cheerful attention.`,
    (t) => `Few things lift an ordinary day quite like ${t}, and that is worth saying out loud.`,
    (t) => `For anyone who has not yet made time for ${t}, there is a pleasant surprise waiting.`
  ],
  [
    (t) => `Part of the charm of ${t} is how generously it welcomes beginners.`,
    (t) => `Nothing about ${t} demands perfection or a special occasion.`,
    (t) => `You can come to ${t} knowing nothing at all and still leave happier than you arrived.`
  ],
  [
    (t) => `Spending time with ${t} is a reliable way to slow the clock down.`,
    (t) => `With ${t}, an hour can feel unhurried and well spent.`,
    (t) => `The pace of ${t} is its own small rebellion against a hurried world.`
  ],
  [
    (t) => `There is a lovely social side to ${t}.`,
    (t) => `Talking about ${t} is the easiest way to start a conversation with a stranger.`,
    (t) => `People who love ${t} will happily discuss it for hours, and their enthusiasm is contagious.`
  ],
  [
    (t) => `The world of ${t} rewards practice in the friendliest possible way.`,
    (t) => `Every attempt at ${t} teaches you something, and progress arrives sooner than you expect.`,
    (t) => `With ${t}, mistakes stop feeling like failures and start feeling like part of the fun.`
  ],
  [
    (t) => `With ${t}, the small details turn out to be the best part.`,
    (t) => `It is the little things about ${t} that stay with you longest.`,
    (t) => `The quiet particulars of ${t} are easy to miss and well worth hunting for.`
  ],
  [
    (t) => `Even thinking about ${t} can lift an ordinary Tuesday.`,
    (t) => `Just the anticipation of ${t} is enough to improve a mood.`,
    (t) => `There is always something to look forward to where ${t} is concerned.`
  ],
  [
    (t) => `What makes ${t} so durable is that it keeps giving at every level.`,
    (t) => `The beauty of ${t} is that newcomers find welcome, experts find depth, and everyone in between finds a good time.`,
    (t) => `The range of ${t} is the mark of something worth keeping around for decades.`
  ],
  [
    (t) => `If you have been meaning to make more room for ${t}, consider this your gentle permission.`,
    (t) => `There is no single correct season, budget, or skill level required for ${t}.`,
    (t) => `Nobody is grading your first attempt at ${t}, and that is precisely the point.`
  ],
  [
    (t) => `Best of all, the joy of ${t} tends to be shared.`,
    (t) => `The moment you enjoy ${t}, you want someone else to enjoy it too.`,
    (t) => `Pleasure like ${t} has a way of doubling when it is handed to somebody else.`
  ],
  [
    (t) => `One of the kindest things about ${t} is how little it demands.`,
    (t) => `A spare ten minutes works just as well as a whole afternoon where ${t} is concerned.`,
    (t) => `You rarely need equipment, permission, or a plan to enjoy ${t}.`
  ],
  [
    (t) => `A good dose of ${t} is one of the most reliable mood-lifters there is.`,
    (t) => `Even a few minutes of ${t} changes the shape of a day.`,
    (t) => `When everything feels like a lot, a little ${t} helps put things back in proportion.`
  ],
  [
    (t) => `Time spent with ${t} has a way of attaching itself to memories.`,
    (t) => `Years from now, some small moment of ${t} will still be easy to recall.`,
    (t) => `Moments of ${t} tend to be the ones that keep turning up in conversation later.`
  ],
  [
    (t) => `There is patience built into ${t}, and patience is a rare and useful thing.`,
    (t) => `Nothing about ${t} can be rushed, which is exactly what makes it restful.`,
    (t) => `The unhurried nature of ${t} is a large part of its charm.`
  ],
  [
    (t) => `So it is worth keeping ${t} close, even on the busiest of days.`,
    (t) => `Give ${t} a few unhurried minutes and see what happens to your mood.`,
    (t) => `Few investments pay back as reliably as a little time with ${t}.`
  ]
];

/**
 * Deterministic 32-bit FNV-1a hash. Keeps the same topic producing the same
 * essay, which makes the offline path predictable and testable.
 */
function hashString(input) {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

/** Count whitespace-separated words. */
function countWords(text) {
  if (typeof text !== 'string') return 0;
  const trimmed = text.trim();
  if (!trimmed) return 0;
  return trimmed.split(/\s+/).length;
}

/** Capitalise the first letter without touching the rest of the string. */
function capitalise(text) {
  if (!text) return text;
  return text.charAt(0).toUpperCase() + text.slice(1);
}

// Shorter alias used inside the sentence templates above.
const cap = capitalise;

/** Split prose into sentences, keeping terminal punctuation attached. */
function splitSentences(text) {
  const matches = String(text).match(/[^.!?]+[.!?]+["')\]]*|[^.!?]+$/g);
  return (matches || []).map((s) => s.trim()).filter(Boolean);
}

/**
 * Coerce an essay to roughly `target` words.
 *
 * Trimming always happens (a 394-word llama response is too long for the
 * pacer). Padding only happens for offline essays, where an exact length is
 * more important than the model's own ending.
 */
function normalizeLength(text, target = TARGET_WORDS, options = {}) {
  const extend = options.extend === true;
  const band = options.band === undefined ? 10 : options.band;
  const lower = Math.max(1, target - band);
  const upper = target + band;

  let sentences = splitSentences(text);
  if (sentences.length === 0) sentences = [String(text || '').trim()].filter(Boolean);
  if (sentences.length === 0) return '';

  // Trim from the end until we are inside the band.
  while (sentences.length > 1 && countWords(sentences.join(' ')) > upper) {
    sentences.pop();
  }

  if (extend) {
    // Deterministic rotation so the same topic pads with the same sentences.
    const offset = hashString(text.slice(0, 64));
    let cursor = 0;
    while (countWords(sentences.join(' ')) < lower && cursor < FILLER_SENTENCES.length * 2) {
      const sentence = FILLER_SENTENCES[(offset + cursor) % FILLER_SENTENCES.length];
      sentences.push(sentence);
      cursor += 1;
    }
  }

  let result = sentences.join(' ').trim();

  // Hard guard: a single runaway sentence can still exceed the band.
  const words = result.split(/\s+/);
  if (words.length > upper) {
    result = `${words.slice(0, upper).join(' ').replace(/[,;:'"]+$/, '')}.`;
  }

  return result;
}

/**
 * Grow a piece of prose to a target length by appending topic-aware sentences,
 * then generic filler for the remainder. Used when the caller asks for a longer
 * essay than the source material provides.
 */
function growToTarget(baseText, topic, target) {
  const label = String(topic || '').trim() || 'the little joys of everyday life';
  const seed = hashString(label.toLowerCase());

  let text = String(baseText);
  if (countWords(text) >= target - 10) return text;

  const sentences = composeSentences(label, seed, target - countWords(text));
  // Drop the first sentence when it would repeat the closing line of the base text.
  return `${text}\n\n${chunkParagraphs(sentences)}`;
}

/**
 * Rotate through the sentence groups to build `needed` words of fresh prose.
 * Group order and variant choice both shift per round, so a long passage keeps
 * changing without any randomness (the same topic always yields the same text).
 */
function composeSentences(topic, seed, needed) {
  const sentences = [];
  const groups = TOPIC_SENTENCE_GROUPS;

  for (let round = 0; round < 64; round += 1) {
    for (let g = 0; g < groups.length; g += 1) {
      const group = groups[(seed + round + g) % groups.length];
      const variant = group[(seed + round * 3 + g * 5) % group.length];
      sentences.push(variant(topic));
      if (countWords(sentences.join(' ')) >= needed) return sentences;
    }
  }

  return sentences;
}

/** Join sentences into readable paragraphs of three. */
function chunkParagraphs(sentences, perParagraph = 3) {
  const paragraphs = [];
  for (let i = 0; i < sentences.length; i += perParagraph) {
    paragraphs.push(sentences.slice(i, i + perParagraph).join(' '));
  }
  return paragraphs.join('\n\n');
}

/**
 * Build a cheerful essay around an arbitrary topic at any requested length.
 * Deterministic for a given topic and target.
 */
function buildTopicEssay(topic, target = DEFAULT_WORDS) {
  const cleaned = String(topic || '').trim() || 'the little joys of everyday life';
  const seed = hashString(cleaned.toLowerCase());

  const sentences = composeSentences(cleaned, seed, target + 30);
  // Generic filler adds variety between the topic sentences.
  const interleaved = [];
  sentences.forEach((sentence, index) => {
    interleaved.push(sentence);
    if (index > 0 && index % 5 === 0) {
      interleaved.push(FILLER_SENTENCES[(seed + index) % FILLER_SENTENCES.length]);
    }
  });

  return normalizeLength(chunkParagraphs(interleaved), target, { extend: true });
}

/**
 * Canned essays, each already near 300 words. `keywords` drives topic matching.
 */
const CANNED_ESSAYS = [
  {
    topic: 'slow mornings',
    keywords: ['morning', 'mornings', 'sunrise', 'dawn', 'breakfast', 'waking', 'wake', 'sunlight'],
    text:
      'There is a particular magic to the first hour of the day, before the world wakes up and starts asking things of you. ' +
      'The light arrives sideways and soft, turning ordinary objects into something worth noticing. ' +
      'A kettle begins to murmur on the stove, and the whole kitchen fills with the promise of warmth. ' +
      'Nothing has gone wrong yet. Nothing is urgent. For a little while, time belongs entirely to you.\n\n' +
      'A slow morning is not laziness; it is a small act of generosity toward yourself. ' +
      'You pour something warm, you open a window, and you let the cool air remind you that you are awake and here. ' +
      'Maybe you read a page or two. Maybe you simply sit and listen to the birds, who seem to have no doubts at all about how to begin a day. ' +
      'Their confidence is thoroughly contagious.\n\n' +
      'There is a gentleness in doing things at human speed. ' +
      'You notice the grain of the wooden table, the way steam curls and disappears, the small creak of the floorboards as the house stretches awake. ' +
      'These details are always there, but a hurried morning erases them while a slow one keeps them safe.\n\n' +
      'And when you finally step out into the day, you carry something quieter with you, a steadiness that no amount of rushing can manufacture. ' +
      'The messages will still be waiting. The list will still be waiting. ' +
      'But the calm you collected in that first hour makes all of it easier to hold.\n\n' +
      'So tomorrow, if the morning allows, give yourself the gift of a few unhurried minutes. ' +
      'Make the coffee a little slower than usual. Watch the light travel across the floor. ' +
      'Begin gently, and let the rest of the day take its cue from you.'
  },
  {
    topic: 'the ocean',
    keywords: ['ocean', 'oceans', 'sea', 'beach', 'wave', 'waves', 'tide', 'coast', 'coastal', 'sailing', 'marine'],
    text:
      'Stand at the edge of the ocean and something in you immediately gets the message. ' +
      'The water keeps arriving, patient and unhurried, as if it has all the time in the world and intends to use it. ' +
      'The sound is enormous and yet strangely calming, a reminder that not everything needs your opinion.\n\n' +
      'Every wave is a small lesson in persistence. ' +
      'It gathers itself far out where you cannot see, travels a great distance, and then spends itself entirely on the sand without complaint. ' +
      'Then it does the same thing again, and again, and somehow it never becomes boring.\n\n' +
      'The ocean is generous with its surprises. ' +
      'A shell you have never seen, a bird diving with absolute confidence, the particular blue that only shows up when the sun is at the right angle. ' +
      'There is always one more thing to notice, which is exactly the kind of abundance that makes a day feel well spent.\n\n' +
      'It is also a magnificent cure for taking yourself too seriously. ' +
      'Standing beside something that big, your worries shrink to a more honest size. ' +
      'The tide comes in, the tide goes out, and you are permitted to simply watch.\n\n' +
      'So keep a little of the ocean with you when you leave. ' +
      'Remember the patience of it, the persistence, and the cheerful way it keeps showing up. ' +
      'It is a very good way to be.\n\n' +
      'You do not have to live near the coast to keep the lesson with you. ' +
      'Visit whenever you can, and when you cannot, remember that some things are far too big to hurry. ' +
      'The ocean has been practising that for a very long time, and it makes the whole thing look effortless.'
  },
  {
    topic: 'kindness',
    keywords: ['kindness', 'kind', 'generosity', 'generous', 'compassion', 'helping', 'help', 'friendship', 'friend', 'community', 'care'],
    text:
      'Kindness is the most underrated form of power available to anyone, anywhere, at any moment. ' +
      'It costs almost nothing, requires no appointment, and yet it reliably changes the shape of a day. ' +
      'A small kindness lands with a weight that nobody expects, including the person who offered it.\n\n' +
      'What makes kindness remarkable is how portable it is. ' +
      'You can carry it into a queue, a meeting, a kitchen, a queue again. ' +
      'It does not need good weather, a promotion, or a perfect mood. ' +
      'It only needs a decision, made quickly and often.\n\n' +
      'There is also a beautiful selfishness to kindness that nobody talks about. ' +
      'The giver gets the better deal. ' +
      'You walk away lighter, and the lightness lasts longer than the moment did. ' +
      'Researchers keep confirming this, but anyone who has ever helped a stranger carry something heavy already knew.\n\n' +
      'Kindness is contagious in the best possible way. ' +
      'Someone sees it happen and files it away as a possibility, then uses it later on somebody else entirely. ' +
      'The chain rarely gets traced, and that is precisely its charm.\n\n' +
      'So be generous with it. ' +
      'Say the encouraging thing out loud instead of merely thinking it. ' +
      'Give the benefit of the doubt freely, because it is almost always the cheaper and kinder explanation. ' +
      'The world is a much friendlier place when generosity is the default setting.\n\n' +
      'And it costs you almost nothing to be the reason somebody\'s afternoon improves. ' +
      'Hold the door, learn the name, offer the benefit of the doubt, and let the small things stay small. ' +
      'Do it often enough and generosity stops being an effort and quietly becomes who you are.'
  },
  {
    topic: 'coffee',
    keywords: ['coffee', 'espresso', 'latte', 'cafe', 'cafes', 'brew', 'brewing', 'bean', 'beans', 'tea', 'barista'],
    text:
      'Coffee is a small ceremony disguised as an ordinary habit, and the disguise is part of the pleasure. ' +
      'The smell arrives before the taste does, promising that the day is officially beginning. ' +
      'Few things in life are so reliably good at announcing themselves.\n\n' +
      'The whole process rewards attention. ' +
      'Beans get ground, water gets hot, and something ordinary becomes something worth anticipating. ' +
      'You can complicate it as much as you like, or you can keep it simple and still get a wonderful result. ' +
      'That flexibility is a rare and generous quality.\n\n' +
      'Coffee is also a social instrument of remarkable precision. ' +
      'It is the easiest excuse in the world for sitting down with someone you like. ' +
      'Entire friendships, business ideas, and apologies have been built on the foundation of two warm cups and an hour of unhurried conversation.\n\n' +
      'There is a genuinely joyful first sip in every cup, and it is worth noticing rather than rushing past. ' +
      'The warmth, the bitterness, the little jolt of clarity afterwards, all of it is available for the price of a few minutes. ' +
      'Small luxuries like this are how ordinary days become good ones.\n\n' +
      'So make the cup properly. ' +
      'Sit down for it, if the schedule allows. ' +
      'Let it be a pause rather than an afterthought, and let the rest of the morning take its shape from that.\n\n' +
      'Make the cup properly and sit down for it whenever the schedule allows. ' +
      'Let the first sip be a genuine pause, not an afterthought. ' +
      'A ritual this small and this reliable is a very good way to begin anything.'
  },
  {
    topic: 'walking',
    keywords: ['walking', 'walk', 'walks', 'stroll', 'strolling', 'hike', 'hiking', 'trail', 'steps', 'walking', 'ramble'],
    text:
      'A walk is the simplest possible way to change your mind, and it works almost every single time. ' +
      'You step outside, you start moving, and within a few minutes the day feels more manageable. ' +
      'No equipment, no membership, no plan required.\n\n' +
      'The magic is partly in the pace. ' +
      'Walking is too slow to be efficient and too fast to be idle, which lands it in a lovely middle ground where thoughts can breathe. ' +
      'Problems that seemed enormous indoors often shrink to a workable size by the second street.\n\n' +
      'It is also an excellent way to notice where you live. ' +
      'There is always a garden you have never admired, a doorway worth a second look, a cat with strong opinions about the pavement. ' +
      'Familiar routes keep revealing things, which is a genuinely delightful trick.\n\n' +
      'And it is social in the easiest way imaginable. ' +
      'Walking beside someone removes the pressure of eye contact and the awkwardness of sitting still. ' +
      'Conversations go further, and silences stop being uncomfortable and start being companionable.\n\n' +
      'The best part is that a walk is never wasted, even a short one. ' +
      'Ten minutes counts. ' +
      'Loop the block, let your shoulders drop, and come back with a clearer head and a slightly better mood. ' +
      'That is an extraordinary return on such a small investment.\n\n' +
      'You do not need a plan, a destination, or even a reason. ' +
      'Ten minutes around the block counts, and a walk is never wasted. ' +
      'Loop the pavement, let your shoulders drop, and come back with a clearer head and an unreasonable amount of credit for leaving the house.'
  },
  {
    topic: 'music',
    keywords: ['music', 'song', 'songs', 'melody', 'melodies', 'guitar', 'piano', 'singing', 'sing', 'instrument', 'band', 'concert', 'dancing'],
    text:
      'Music is the only art form that asks you to move before you have decided to, and that is a wonderful thing. ' +
      'A good song arrives in the room and reorganises your mood without a single word of explanation. ' +
      'It is instant, generous, and completely free at the point of use.\n\n' +
      'There is something remarkable about the way a melody can carry a memory. ' +
      'Three notes are enough to return you to a particular summer, a particular kitchen, a particular friend. ' +
      'Nothing else in the world has that kind of time-travel built in.\n\n' +
      'Making music is even better than hearing it, and the barrier to entry is far lower than most people believe. ' +
      'Four chords will get you through an astonishing number of songs. ' +
      'Singing badly in the car counts as practice. ' +
      'Nobody is grading you, and the audience of one is delighted to have you there.\n\n' +
      'Music is also the most portable happiness ever invented. ' +
      'It fits in a pocket. ' +
      'It waits patiently for the right moment, and then it delivers exactly what was needed. ' +
      'On a difficult day, that reliability is worth more than it costs.\n\n' +
      'So turn it up a little. ' +
      'Learn the song you have been humming for years. ' +
      'Dance in the kitchen while dinner is on, because the floor is fine and nobody is watching.\n\n' +
      'Turn it up a little louder than strictly necessary. ' +
      'Learn the song you have been humming for years, badly and cheerfully. ' +
      'Sing along in the car, because joy like that is far too good to postpone.'
  },
  {
    topic: 'gardens',
    keywords: ['garden', 'gardens', 'gardening', 'plant', 'plants', 'flower', 'flowers', 'seed', 'seeds', 'growing', 'vegetables', 'soil', 'herbs'],
    text:
      'A garden is a long, cheerful negotiation with the weather, and losing gracefully is part of the sport. ' +
      'You plant something small and optimistic, then wait to see what happens. ' +
      'The answer arrives slowly, and it is almost always better than you expected.\n\n' +
      'The great joy of growing things is how honest the feedback is. ' +
      'Plants make their opinions perfectly clear. ' +
      'Too much water, not enough sun, and they tell you immediately, without a hint of diplomacy. ' +
      'There is something refreshing about a hobby with no ambiguity whatsoever.\n\n' +
      'Gardens also reward patience in a way that modern life rarely does. ' +
      'Nothing can be rushed, accelerated, or optimised. ' +
      'You simply do the small daily things well and let time do the rest of the work. ' +
      'That is a genuinely useful thing to learn.\n\n' +
      'And then there is the harvest, which tastes like an achievement. ' +
      'A tomato that you grew yourself is objectively better than one you bought, and no amount of scientific reasoning will change anyone\'s mind about this. ' +
      'The pride is part of the flavour.\n\n' +
      'Best of all, a garden makes a place feel like yours. ' +
      'Even a few pots on a windowsill will do it. ' +
      'Start with something forgiving, water it kindly, and enjoy the slow green reward.\n\n' +
      'A garden makes any place feel like yours, even a few pots on a windowsill. ' +
      'Say good morning to it, and enjoy the slow green reward. ' +
      'Nothing can be rushed, and that is a genuinely useful thing to be reminded of.'
  },
  {
    topic: 'the night sky',
    keywords: ['stars', 'star', 'sky', 'night', 'astronomy', 'moon', 'cosmos', 'cosmic', 'space', 'universe', 'galaxy', 'telescope'],
    text:
      'Look up on a clear night and the universe politely introduces itself. ' +
      'Thousands of stars, most of them far older than anything you have ever touched, appear perfectly content to simply shine. ' +
      'It is the cheapest spectacle in existence and arguably the best.\n\n' +
      'There is a particular pleasure in remembering that the light is old. ' +
      'Some of it left home before anyone had thought of a telescope. ' +
      'You are looking directly at the past, which is a genuinely astonishing thing to do on a Tuesday evening.\n\n' +
      'The night sky is also a wonderful corrective for a self-important day. ' +
      'Standing beneath something that large, the day\'s frustrations settle into a more honest size. ' +
      'Perspective like that is hard to buy and easy to find.\n\n' +
      'And it is gloriously accessible. ' +
      'You do not need equipment, a subscription, or permission. ' +
      'A dark corner, a clear evening, and a few unhurried minutes are the whole list. ' +
      'Bonus points for a blanket and someone to nudge when you find something good.\n\n' +
      'So step outside before bed and give it a proper look. ' +
      'Find one star and follow it for a while. ' +
      'The sky has been waiting all day to show you something lovely, and it is far too generous to keep it waiting.\n\n' +
      'Step outside before bed and give the whole thing a proper look. ' +
      'Find one bright star and follow it for a while, then find another, and then lose count entirely. ' +
      'It costs nothing, works every night, and never once asks for anything in return.'
  }
];

/** Words too generic to be useful when matching a topic to a canned essay. */
const STOPWORDS = new Set([
  'a', 'an', 'the', 'and', 'or', 'but', 'of', 'to', 'in', 'on', 'for', 'with', 'about', 'into', 'over',
  'is', 'are', 'was', 'were', 'be', 'being', 'been', 'it', 'its', 'this', 'that', 'these', 'those',
  'i', 'me', 'my', 'we', 'our', 'you', 'your', 'he', 'she', 'they', 'them', 'how', 'why', 'what',
  'when', 'where', 'which', 'who', 'whom', 'as', 'at', 'by', 'from', 'up', 'out', 'do', 'does', 'did',
  'can', 'could', 'should', 'would', 'will', 'just', 'very', 'really', 'some', 'any', 'all', 'more',
  'most', 'much', 'many', 'own', 'same', 'so', 'than', 'too', 'also', 'not', 'no', 'yes'
]);

/** Reduce a topic string to meaningful lowercase tokens. */
function tokenize(topic) {
  return String(topic || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s'-]/g, ' ')
    .split(/[\s-]+/)
    .map((token) => token.replace(/^'+|'+$/g, ''))
    .filter((token) => token.length > 2 && !STOPWORDS.has(token));
}

/**
 * Find the canned essay that best matches a topic.
 * Returns null when nothing meaningfully overlaps.
 */
function matchCannedEssay(topic) {
  const tokens = tokenize(topic);
  if (tokens.length === 0) return null;

  let best = null;
  let bestScore = 0;

  for (const essay of CANNED_ESSAYS) {
    let score = 0;
    for (const token of tokens) {
      const hit = essay.keywords.some((keyword) => {
        if (keyword === token) return true;
        // Tolerate simple plurals: "otter"/"otters", "star"/"stars".
        if (keyword.length > 3 && token.length > 3) {
          return keyword.startsWith(token) || token.startsWith(keyword);
        }
        return false;
      });
      if (hit) score += 1;
    }
    if (score > bestScore) {
      bestScore = score;
      best = essay;
    }
  }

  return bestScore > 0 ? best : null;
}

/**
 * Produce an offline essay for a topic at a requested length.
 *
 * @returns {{ text: string, topic: string, matched: 'canned'|'template'|'random' }}
 */
function offlineEssay(topic, target = DEFAULT_WORDS) {
  const requested = typeof topic === 'string' ? topic.trim() : '';

  if (!requested) {
    // No topic supplied: hand back a canned essay and report its own topic.
    const index = Math.floor(Math.random() * CANNED_ESSAYS.length);
    const essay = CANNED_ESSAYS[index];
    return {
      text: normalizeLength(growToTarget(essay.text, essay.topic, target), target, { extend: true }),
      topic: essay.topic,
      matched: 'random'
    };
  }

  const canned = matchCannedEssay(requested);
  if (canned) {
    return {
      text: normalizeLength(growToTarget(canned.text, requested, target), target, { extend: true }),
      topic: requested,
      matched: 'canned'
    };
  }

  return {
    text: buildTopicEssay(requested, target),
    topic: requested,
    matched: 'template'
  };
}

module.exports = {
  TARGET_WORDS,
  DEFAULT_WORDS,
  MIN_WORDS,
  MAX_WORDS,
  CANNED_ESSAYS,
  FILLER_SENTENCES,
  countWords,
  normalizeLength,
  growToTarget,
  buildTopicEssay,
  matchCannedEssay,
  offlineEssay,
  tokenize,
  hashString
};
