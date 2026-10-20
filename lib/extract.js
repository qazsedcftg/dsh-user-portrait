/**
 * Extraction engine: fold a session log into per-turn transcripts, run the two
 * background model jobs (turn digest, portrait synthesis), and merge their
 * results into durable records.
 *
 * @module dsh-user-portrait/extract
 */

import {
  AUTO_ENTRY_TEXT_LIMIT,
  clampCharLimit,
  clampConfidence,
  DEFAULT_ENTRY_CAP,
  DIMENSIONS,
  DIMENSION_IDS,
  ENTRY_TEXT_LIMIT,
  entryId,
  evidenceKey,
  groupOfDimension,
  INITIAL_ASSISTANT_CONFIDENCE,
  INITIAL_USER_CONFIDENCE,
  normalizeStatement,
  OVERFLOW_MERGE_THRESHOLD,
  resolveDimensionId,
  STATEMENTS,
} from './schema.js';
import { maskAndClip, maskSecrets } from './redact.js';
import { parseJsonReply, sessionDigestPrompt, synthesisPrompt, turnDigestPrompt } from './prompts.js';

/** Content-block types that carry text the user actually wrote. */
const TEXT_BLOCK = 'text';

/**
 * Concatenate the text blocks of one message.
 * @param message - a message with a `content` array.
 * @returns the joined text.
 */
export function messageText(message) {
  const content = message?.content;
  if (!Array.isArray(content)) return '';
  const parts = [];
  for (const block of content) {
    if (block !== null && typeof block === 'object' && block.type === TEXT_BLOCK && typeof block.text === 'string') {
      parts.push(block.text);
    }
  }
  return parts.join('\n');
}

/**
 * Report whether one `user/message` event is human-authored rather than
 * plugin-injected context.
 * @param event - a `user/message` session event.
 * @returns true when the user typed it.
 */
export function isHumanMessage(event) {
  const kind = event?.data?.source?.kind;
  return kind === 'user' || kind === undefined;
}

/**
 * Fold a linear session event list into per-turn transcripts.
 *
 * A turn is the unit the agent loop already records, so this needs no extra
 * bookkeeping: user text is everything between `turn/start` and `turn/end`.
 *
 * @param events - session events in ascending sequence order.
 * @returns turn transcripts, oldest first.
 */
export function foldTurns(events) {
  const turns = [];
  let current = undefined;
  for (const event of events) {
    if (event === null || typeof event !== 'object') continue;
    if (event.type === 'turn/start') {
      current = {
        turn: event.data?.turn ?? turns.length + 1,
        startedAt: event.time,
        endedAt: undefined,
        endReason: undefined,
        userTexts: [],
        assistantTexts: [],
        toolNames: [],
        interrupted: false,
      };
      turns.push(current);
      continue;
    }
    if (current === undefined) continue;
    if (event.type === 'user/message') {
      if (isHumanMessage(event)) {
        const text = messageText(event.data);
        if (text.trim() !== '') current.userTexts.push(text);
      }
      continue;
    }
    if (event.type === 'assistant/message') {
      const text = messageText(event.data?.message);
      if (text.trim() !== '') current.assistantTexts.push(text);
      if (event.data?.interrupted === true) current.interrupted = true;
      continue;
    }
    if (event.type === 'tool/call') {
      const toolName = event.data?.name;
      if (typeof toolName === 'string' && !current.toolNames.includes(toolName)) current.toolNames.push(toolName);
      continue;
    }
    if (event.type === 'turn/end' && event.data?.turn === current.turn) {
      current.endedAt = event.time;
      current.endReason = event.data?.reason?.kind ?? 'unknown';
      current = undefined;
    }
  }
  return turns;
}

/**
 * Decide whether a folded turn is worth a background model call.
 * @param turn - a folded turn transcript.
 * @returns true when the turn carries human input or a usable answer.
 */
export function isDigestible(turn) {
  return turn.userTexts.length > 0 || turn.assistantTexts.length > 0;
}

/**
 * Build the digest request for one turn, with masking and clipping applied.
 * @param request - session identity, header info, and the folded turn.
 * @param limits - character budgets for one turn's material.
 * @returns the prompt text.
 */
export function buildTurnPrompt(request, limits) {
  const { sessionId, cwd, turn } = request;
  const userMessages = turn.userTexts.map((text) => maskAndClip(text, limits.perUserMessage));
  const assistantJoined = turn.assistantTexts.join('\n\n');
  return turnDigestPrompt({
    sessionId,
    turn: turn.turn,
    cwd,
    userMessages,
    assistantText: maskAndClip(assistantJoined, limits.perAssistantTurn),
    toolNames: turn.toolNames,
  });
}

/**
 * Normalize one model-produced turn digest.
 * @param raw - parsed model output.
 * @param turn - the folded turn it describes.
 * @returns a digest row ready for durable storage.
 */
export function normalizeTurnDigest(raw, turn, options = {}) {
  const textLimit = clampCharLimit(options.textLimit, AUTO_ENTRY_TEXT_LIMIT);
  const value = raw !== null && typeof raw === 'object' ? raw : {};
  const strings = (input, limit) => {
    if (!Array.isArray(input)) return [];
    return input
      .filter((item) => typeof item === 'string' && item.trim() !== '')
      .map((item) => maskSecrets(item.trim()).slice(0, 200))
      .slice(0, limit);
  };
  const evidence = [];
  // Every conclusion that claims the user's words as its basis must be traceable
  // back to something the user actually typed. The model is good at paraphrasing
  // the assistant's own explanation back as "the user said", so the basis is
  // verified here instead of trusted: no quote, or a quote that is not in the
  // turn's user text, means the conclusion is a MODEL inference, not the user's
  // words — and it is relabelled and re-clamped accordingly.
  const userText = userTextOf(turn);
  if (Array.isArray(value.evidence)) {
    for (const candidate of value.evidence) {
      if (candidate === null || typeof candidate !== 'object') continue;
      const dimension = resolveDimensionId(candidate.dimension);
      if (dimension === undefined) continue;
      if (typeof candidate.text !== 'string' || candidate.text.trim() === '') continue;
      // Fail closed: only an explicit `user` claim counts as claiming the user's
      // words. A missing marker is treated as a model inference — otherwise
      // silence would silently become "the user said this".
      const claimed = candidate.statement === 'user' ? 'user' : 'assistant';
      const source = typeof candidate.source === 'string' ? maskSecrets(candidate.source.trim()).slice(0, 200) : '';
      // `user` is only granted when the quote provably comes from the user's turn.
      const statement = claimed === 'user' && isTraceableToUser(source, userText) ? 'user' : 'assistant';
      const text = maskSecrets(candidate.text.trim()).slice(0, textLimit);
      // The statement decides the confidence, not the model: an inference drawn
      // from the assistant's own words cannot claim more than the policy allows,
      // and an `assistant` claim about a technical dimension never starts above
      // `low` (reading an explanation is not knowing a technology).
      const proposed = typeof candidate.confidence === 'string' ? candidate.confidence : undefined;
      // A missing confidence opens at the level its basis earns: the user's own
      // words start at medium, an inference from the assistant at low.
      const start = statement === 'assistant' ? INITIAL_ASSISTANT_CONFIDENCE : INITIAL_USER_CONFIDENCE;
      evidence.push({
        dimension,
        statement,
        // When the claim was demoted, its evidence is by definition the model's
        // own text, so an inflated confidence from the reply must not survive.
        confidence: clampConfidence(
          normalizeConfidence(claimed === statement ? proposed : INITIAL_ASSISTANT_CONFIDENCE, start),
          statement,
          groupOfDimension(dimension),
        ),
        text,
        source,
      });
    }
  }
  const corrections = [];
  if (Array.isArray(value.corrections)) {
    for (const candidate of value.corrections) {
      if (candidate === null || typeof candidate !== 'object') continue;
      if (typeof candidate.text !== 'string' || candidate.text.trim() === '') continue;
      const text = maskSecrets(candidate.text.trim()).slice(0, 200);
      // A correction is the model's SUMMARY of something the user objected to, so
      // it will never be verbatim. It is grounded instead: the best-matching user
      // line must share a meaningful run with it. When it does, that line becomes
      // the recorded quote; when nothing in the turn supports it, the correction is
      // a model invention and is demoted.
      const quote = bestUserQuote(text, userLinesOf(turn));
      corrections.push({
        kind: typeof candidate.kind === 'string' ? candidate.kind.slice(0, 20) : '偏好',
        text,
        basis: quote === undefined ? 'assistant' : 'user',
        source: quote ?? '',
      });
    }
  }
  return {
    turn: turn.turn,
    at: turn.endedAt ?? turn.startedAt ?? Date.now(),
    userAsk: typeof value.userAsk === 'string' ? maskSecrets(value.userAsk.trim()).slice(0, 300) : '',
    userKeyPoints: strings(value.userKeyPoints, 6),
    assistantSummary:
      typeof value.assistantSummary === 'string' ? maskSecrets(value.assistantSummary.trim()).slice(0, 500) : '',
    outcome: typeof value.outcome === 'string' ? value.outcome.slice(0, 20) : '',
    corrections: corrections.slice(0, 6),
    evidence: evidence.slice(0, 6),
  };
}

/**
 * Concatenate a turn's human messages into one haystack.
 * @param turn - a folded turn (may be partial).
 * @returns the normalized user text, or an empty string.
 */
function userTextOf(turn) {
  const texts = Array.isArray(turn?.userTexts) ? turn.userTexts : [];
  return normalizeForCompare(texts.join('\n'));
}

/**
 * The turn's human messages, raw and trimmed.
 * @param turn - a folded turn (may be partial).
 * @returns the user's lines.
 */
function userLinesOf(turn) {
  const texts = Array.isArray(turn?.userTexts) ? turn.userTexts : [];
  return texts.map((text) => String(text ?? '').trim()).filter((text) => text !== '');
}

/**
 * The user line that best supports a summary, when any does.
 *
 * A correction or a paraphrase will never be a verbatim quote, so support is
 * measured as the longest run of characters the two share. Four characters is a
 * low bar deliberately: it accepts "倾向用 PowerShell 而不是 node" against "最好用
 * PowerShell 而不是 node", while still rejecting a summary of something that was
 * never said.
 *
 * @param summary - the model's summary.
 * @param userLines - the turn's user messages.
 * @returns the supporting user line, or undefined when nothing supports it.
 */
function bestUserQuote(summary, userLines) {
  const needle = normalizeForCompare(summary);
  if (needle === '') return undefined;
  let best;
  let bestRun = 0;
  for (const line of userLines) {
    const run = longestCommonRun(needle, normalizeForCompare(line));
    if (run > bestRun) {
      bestRun = run;
      best = line;
    }
  }
  return bestRun >= 4 ? best : undefined;
}

/**
 * Report whether a claim's wording can be found in the user's own turn text.
 *
 * Two tolerances, because the model quotes rather than copies:
 * - the quote appears verbatim in the user's text, or
 * - at least 80% of the quote's character bigrams appear in it (a trimmed or
 *   lightly reworded quote).
 *
 * An empty quote is never traceable: claiming the user's words without pointing
 * at any of them is exactly the failure this check exists to stop.
 *
 * @param quote - the quote the model offered as evidence.
 * @param normalizedUserText - the turn's user text, normalized.
 * @returns true only when the quote is actually the user's.
 */
function isTraceableToUser(quote, normalizedUserText) {
  const needle = normalizeForCompare(quote);
  if (needle === '' || normalizedUserText === '') return false;
  if (normalizedUserText.includes(needle)) return true;
  if (needle.length < 4) return false;
  const haystack = new Set();
  for (let index = 0; index < normalizedUserText.length - 1; index += 1) {
    haystack.add(normalizedUserText.slice(index, index + 2));
  }
  let covered = 0;
  let total = 0;
  for (let index = 0; index < needle.length - 1; index += 1) {
    total += 1;
    if (haystack.has(needle.slice(index, index + 2))) covered += 1;
  }
  return total > 0 && covered / total >= 0.8;
}

/**
 * Whether one evidence row is the basis of a profile entry.
 *
 * The synthesis rewrites entry text, so the match is a containment check in either
 * direction, plus the row's own quote.
 *
 * @param row - the evidence row.
 * @param entryText - the entry's text.
 * @returns true when this row is the one the entry came from.
 */
export function rowSupportsEntry(row, entryText) {
  const entry = normalizeForCompare(entryText);
  if (entry === '') return false;
  const text = normalizeForCompare(row?.text);
  if (text !== '' && (entry.includes(text) || text.includes(entry))) return true;
  const quote = normalizeForCompare(row?.source);
  return quote !== '' && entry.includes(quote);
}

/**
 * Re-derive the basis of evidence rows written before the marker existed.
 *
 * Those rows carry no `statement`, and treating "no marker" as "the user's words"
 * is what made a whole profile read as `user`: 90 of 114 rows on this machine had
 * no marker, and 93 of 119 profile sources pointed at them. The declaration is
 * replaced by evidence — the row's own quote is looked up in the user's turn text:
 *
 * - the quote is in the user's text → `user` (and the quote is kept as `source`),
 * - the quote is missing or not in the text → `assistant`,
 * - the session or turn cannot be read → `assistant` (fail closed; an
 *   unverifiable claim is not the user's words).
 *
 * @param rows - ledger rows.
 * @param turnIndex - `sessionId#turn` to `{ normalized, lines }`.
 * @returns the rewritten rows plus counts.
 */
export function classifyEvidenceBasis(rows, turnIndex) {
  const rewritten = [];
  const stats = { total: 0, user: 0, assistant: 0, rewritten: 0, remaining: 0 };
  for (const row of Array.isArray(rows) ? rows : []) {
    stats.total += 1;
    const existing = row?.statement;
    if (existing === 'user' || existing === 'assistant' || existing === 'mixed') {
      rewritten.push(row);
      continue;
    }
    const entry = turnIndex instanceof Map ? turnIndex.get(`${row.sessionId ?? ''}#${row.turn ?? ''}`) : undefined;
    if (entry === undefined) {
      // The transcript for this row is not available. Do NOT guess: leaving the row
      // unmarked means it can never grant the user's basis (see
      // `statementForCandidate`), and a transient read failure cannot rewrite the
      // ledger into a wrong answer.
      stats.remaining += 1;
      rewritten.push(row);
      continue;
    }
    let statement;
    let source = typeof row.source === 'string' ? row.source : '';
    if (row.kind === 'preference') {
      // A correction is a summary of something the user objected to: anchor it to
      // the closest user line, exactly like a freshly digested correction.
      const quote = bestUserQuote(String(row.text ?? ''), entry.lines);
      statement = quote === undefined ? 'assistant' : 'user';
      if (quote !== undefined && source === '') source = quote;
    } else {
      statement = isTraceableToUser(source, entry.normalized) ? 'user' : 'assistant';
    }
    if (statement === 'user') stats.user += 1;
    else stats.assistant += 1;
    stats.rewritten += 1;
    rewritten.push({ ...row, statement, source });
  }
  return { rows: rewritten, stats };
}

/**
 * Re-derive profile entries' basis from their (rewritten) sources.
 *
 * An entry is `user` only when every source that backs it is the user's own words;
 * `mixed` when both bases appear; `assistant` when nothing verifiable backs it.
 * Confidence is re-clamped to what the new basis allows, so a claim that was
 * `high` on an unverified basis cannot keep that value.
 *
 * Hand-written entries are left alone: the user typed those in the panel.
 *
 * @param profile - the profile document.
 * @param rows - the rewritten ledger.
 * @returns the repaired profile plus counts.
 */
export function repairProfileBasis(profile, rows) {
  // Entry sources name a session and turn, but a turn can hold several evidence
  // rows with different bases. Group them, then pick the row that matches the
  // entry's own text; when nothing matches, the whole turn counts.
  const byTurn = new Map();
  for (const row of Array.isArray(rows) ? rows : []) {
    const key = `${row.sessionId ?? ''}#${row.turn ?? ''}`;
    const bucket = byTurn.get(key);
    if (bucket === undefined) byTurn.set(key, [row]);
    else bucket.push(row);
  }
  const stats = { user: 0, assistant: 0, mixed: 0, changed: 0 };
  const dimensions = {};
  for (const id of DIMENSION_IDS) {
    const list = profile.dimensions?.[id] ?? [];
    dimensions[id] = list.map((entry) => {
      if (entry.manual === true) {
        stats.user += 1;
        return { ...entry, statement: 'user' };
      }
      const rowsForEntry = [];
      for (const source of entry.sources ?? []) {
        const bucket = byTurn.get(`${source?.sessionId ?? ''}#${source?.turn ?? ''}`) ?? [];
        const matched = bucket.filter((row) => rowSupportsEntry(row, entry.text));
        rowsForEntry.push(...(matched.length > 0 ? matched : bucket));
      }
      let statement;
      if (rowsForEntry.length === 0) statement = 'assistant';
      else {
        // `user` must be DECLARED by the evidence, not merely "not assistant":
        // an unmarked (legacy, or unreadable) row is not proof of the user's words.
        const anyUser = rowsForEntry.some((row) => row.statement === 'user');
        const anyAssistant = rowsForEntry.some((row) => row.statement === 'assistant');
        statement = anyUser && anyAssistant ? 'mixed' : anyUser ? 'user' : 'assistant';
      }
      stats[statement] += 1;
      if (statement !== entry.statement) stats.changed += 1;
      return {
        ...entry,
        statement,
        confidence: clampConfidence(entry.confidence, statement, groupOfDimension(id), entry.manual === true),
      };
    });
  }
  return { profile: { ...profile, dimensions }, stats };
}

/**
 * Build the synthesis request from the live profile and fresh evidence.
 * @param profile - current profile document.
 * @param rows - fresh evidence rows.
 * @returns the prompt text.
 */
/**
 * Build the synthesis request for a SCOPE of dimensions.
 *
 * Only the scoped dimensions appear in the prompt and in the evidence list, so
 * one call stays small enough that its reply cannot be truncated by the output
 * budget. The caller merges each reply into the same profile in turn.
 *
 * @param profile - current profile document.
 * @param rows - fresh evidence rows (already limited to this scope).
 * @param scope - the dimensions this call owns.
 * @returns the prompt text.
 */
export function buildSynthesisPrompt(profile, rows, scope) {
  const dimensions = Array.isArray(scope) && scope.length > 0 ? scope : DIMENSIONS;
  const profileLines = [];
  let entries = 0;
  let total = 0;
  for (const dimension of dimensions) {
    const list = profile.dimensions?.[dimension.id] ?? [];
    total += list.length;
    const active = list.filter((entry) => entry.status === 'active');
    entries += active.length;
    profileLines.push(`### ${dimension.id}（${dimension.label}）`);
    if (list.length === 0) {
      profileLines.push('（空）');
      continue;
    }
    for (const entry of list) {
      const sources = (entry.sources ?? [])
        .slice(0, 4)
        .map((source) => `${source.sessionId}${source.turn === undefined ? '' : `#T${source.turn}`}`)
        .join(' ');
      profileLines.push(
        `- [${entry.status}/${entry.confidence}] ${entry.text}${sources === '' ? '' : ` <${sources}>`}${entry.note === undefined ? '' : ` (${entry.note})`}`,
      );
    }
  }
  const evidenceLines = rows.map(
    (row) => `- [${row.dimension}/${row.confidence}] ${row.text} <${row.sessionId ?? '-'}${row.turn === undefined ? '' : `#T${row.turn}`}>${row.source === undefined || row.source === '' ? '' : ` 原文: ${row.source}`}`,
  );
  const notesText = (profile.notes ?? []).map((note) => `- ${note.text}`).join('\n');
  return synthesisPrompt({
    profileText: profileLines.join('\n'),
    evidenceText: evidenceLines.join('\n'),
    notesText,
    counts: { entries, total, fresh: rows.length },
    scope: dimensions,
  });
}

/**
 * Merge two statements about the same thing into one sentence.
 * @param left - the text kept so far.
 * @param right - the new text.
 * @returns the combined text, within the entry budget.
 */
function combineText(left, right, limit = AUTO_ENTRY_TEXT_LIMIT) {
  const cap = clampCharLimit(limit, AUTO_ENTRY_TEXT_LIMIT);
  const a = String(left ?? '').trim().replace(/[。；;\s]+$/u, '');
  const b = String(right ?? '').trim();
  if (a === '' || a.includes(b)) return a === '' ? b.slice(0, cap) : a.slice(0, cap);
  if (b.includes(a)) return b.slice(0, cap);
  const joined = `${a}，${b}`;
  if (joined.length <= cap) return joined;
  // Too long to join whole. Keep the existing conclusion intact and append as much
  // of the new one as still fits, so a merge is not silently a discard: the new
  // statement's opening is usually its distinguishing part.
  const room = cap - a.length - 1;
  if (room >= 6) return `${a}；${b.slice(0, room)}`.slice(0, cap);
  // Nothing useful fits after `a`: keep whichever side carries more text, trimmed.
  const longer = a.length >= b.length ? a : b;
  return longer.slice(0, cap);
}

/**
 * Whether two statements are close enough to be ONE conclusion.
 *
 * The model tends to split one topic into rows — "喜欢玩 galgame" and
 * "挑选 galgame 时看重剧情质量" were stored as two entries even though the second
 * is only a refinement of the first. Exact-text dedup cannot see that, so this
 * compares character bigrams and a shared distinctive term.
 *
 * Kept conservative on purpose: merging two genuinely different conclusions
 * loses information, which is worse than one extra row.
 *
 * @param left - one entry's text.
 * @param right - another entry's text.
 * @returns true when they should be one entry.
 */
export function isSameConclusion(left, right) {
  const a = normalizeForCompare(left);
  const b = normalizeForCompare(right);
  if (a === '' || b === '') return false;
  if (a === b || a.includes(b) || b.includes(a)) return true;
  if (diceBigrams(a, b) >= 0.55) return true;
  // One shared proper noun means both statements are about the same subject:
  // "喜欢玩 galgame" and "挑 galgame 看重剧情质量" are one conclusion about
  // galgame, not two conclusions. Near-miss forms count too ("galgame" vs
  // "galgames"), which is why one term containing the other also matches when the
  // shorter side is distinctive enough. Categories and generic words are not Latin
  // terms, so unrelated Chinese statements never match this way.
  const shared = [...new Set(latinTerms(a))].some((term) =>
    latinTerms(b).some((other) => term === other || (term.length >= 5 && other.includes(term)) || (other.length >= 5 && term.includes(other))),
  );
  if (shared) return true;
  // Same object, several requirements: "要求把 VNDB 标签分开分级" and "要求把 2DFan
  // 标签分开分级" are one rule about one thing, and listing them twice is noise.
  // The shared run is measured on the text with the requirement words removed, so
  // two unrelated requirements ("不要用 iframe" / "不要用 node") do not collapse
  // into each other just because they share a verb.
  const bareA = stripMarkers(a);
  const bareB = stripMarkers(b);
  const run = longestCommonRun(bareA, bareB);
  if (isRequirement(a) && isRequirement(b) && run >= 3) return true;
  // One flow, split into steps: "先备份再改" and "改完要验证" describe one process,
  // so they belong to one conclusion rather than two disconnected rows.
  if (isFlowStep(a) && isFlowStep(b) && run >= 3) return true;
  return false;
}

/**
 * How related two conclusions are, as a 0–1 number.
 *
 * `isSameConclusion` answers yes/no; the cap rule needs a rank ("fold into the
 * MOST related one") and a threshold (0.5). The mapping is chosen so that
 * everything `isSameConclusion` accepts scores at least 0.5:
 *
 * - identical / containment → 0.8
 * - one shared proper noun → 0.6
 * - same-object requirements or same-flow steps (≥3 shared chars) → 0.55
 * - otherwise the character-bigram Dice coefficient
 *
 * @param left - one conclusion's text.
 * @param right - another conclusion's text.
 * @returns a relatedness score between 0 and 1.
 */
export function similarityScore(left, right) {
  const a = normalizeForCompare(left);
  const b = normalizeForCompare(right);
  if (a === '' || b === '') return 0;
  if (a === b) return 1;
  if (a.includes(b) || b.includes(a)) return 0.8;
  let score = diceBigrams(a, b);
  const shared = [...new Set(latinTerms(a))].some((term) =>
    latinTerms(b).some((other) => term === other || (term.length >= 5 && other.includes(term)) || (other.length >= 5 && term.includes(other))),
  );
  if (shared) score = Math.max(score, 0.6);
  const run = longestCommonRun(stripMarkers(a), stripMarkers(b));
  if ((isRequirement(a) && isRequirement(b)) || (isFlowStep(a) && isFlowStep(b))) {
    if (run >= 3) score = Math.max(score, 0.55);
  }
  return Math.min(1, score);
}

/**
 * Keep the portrait inside its conclusion budget.
 *
 * Manual conclusions are the user's own writing, so they neither count toward the
 * cap nor get merged away. An overflow conclusion is folded into the most related
 * conclusion of the SAME dimension when that relation reaches
 * {@link OVERFLOW_MERGE_THRESHOLD}; otherwise it is dropped and reported so the
 * panel can ask the user to trim the portrait first.
 *
 * @param profile - the merged profile.
 * @param caps - `{ mode, total, daily, tech }` from the state file.
 * @returns the capped profile plus what happened.
 */
export function enforceEntryCaps(profile, caps) {
  const limits = normalizeEntryCap(caps);
  const buckets = () => {
    const counts = { all: 0, daily: 0, tech: 0 };
    for (const dimension of DIMENSIONS) {
      const group = dimension.group;
      for (const entry of profile.dimensions?.[dimension.id] ?? []) {
        if (entry.status !== 'active' || entry.manual === true) continue;
        counts.all += 1;
        counts[group] += 1;
      }
    }
    return counts;
  };
  const over = (counts, group) =>
    limits.mode === 'group'
      ? counts[group] > limits[group]
      : // The unified budget is read as "at least the two groups added up": setting
        // one mode narrower than the other must not lower the ceiling.
        counts.all > Math.max(limits.total, limits.daily + limits.tech);

  const merged = [];
  const dropped = [];
  let guard = 0;
  // Each pass removes exactly one entry, so this terminates; the guard is only a
  // backstop against a bug turning it into a spin.
  while (guard < 500) {
    guard += 1;
    const counts = buckets();
    const group = limits.mode === 'group' ? (over(counts, 'daily') ? 'daily' : over(counts, 'tech') ? 'tech' : undefined) : over(counts, 'all') ? 'all' : undefined;
    if (group === undefined) break;

    // Newest first: the conclusion the synthesis just produced is the one that has
    // to earn its place.
    const candidates = [];
    for (const dimension of DIMENSIONS) {
      if (group !== 'all' && dimension.group !== group) continue;
      for (const entry of profile.dimensions?.[dimension.id] ?? []) {
        if (entry.status !== 'active' || entry.manual === true) continue;
        candidates.push({ dimension, entry });
      }
    }
    if (candidates.length === 0) break;
    candidates.sort((left, right) => (right.entry.lastConfirmedAt ?? 0) - (left.entry.lastConfirmedAt ?? 0));
    const victim = candidates[0];
    const list = profile.dimensions[victim.dimension.id];
    const siblings = list.filter((entry) => entry !== victim.entry && entry.status === 'active' && entry.manual !== true);
    let best;
    let bestScore = 0;
    for (const sibling of siblings) {
      const score = similarityScore(victim.entry.text, sibling.text);
      if (score > bestScore) {
        bestScore = score;
        best = sibling;
      }
    }
    if (best !== undefined && bestScore >= OVERFLOW_MERGE_THRESHOLD) {
      const statement = mergeStatement(best.statement, victim.entry.statement);
      const groupId = groupOfDimension(victim.dimension.id);
      best.text = combineText(best.text, victim.entry.text, limits.charLimit);
      best.statement = statement;
      best.confidence = clampConfidence(
        strongestConfidence(best.confidence, victim.entry.confidence),
        statement,
        groupId,
      );
      best.sources = mergeSources(best.sources, victim.entry.sources);
      best.lastConfirmedAt = Math.max(best.lastConfirmedAt ?? 0, victim.entry.lastConfirmedAt ?? 0);
      best.id = entryId(victim.dimension.id, best);
      list.splice(list.indexOf(victim.entry), 1);
      merged.push({ dimension: victim.dimension.id, text: victim.entry.text, into: best.text, score: Number(bestScore.toFixed(2)) });
      continue;
    }
    list.splice(list.indexOf(victim.entry), 1);
    dropped.push({ dimension: victim.dimension.id, group: victim.dimension.group, text: victim.entry.text, bestScore: Number(bestScore.toFixed(2)) });
  }
  return { profile, merged, dropped, limits, counts: buckets() };
}

/**
 * Coerce a stored cap document into the shape the rules expect.
 * @param value - raw `state.entryCap`.
 * @returns a complete cap document.
 */
export function normalizeEntryCap(value) {
  const source = value !== null && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const count = (input, fallback) => {
    const number = Number(input);
    return Number.isFinite(number) && number >= 0 ? Math.floor(number) : fallback;
  };
  const total = count(source.total, DEFAULT_ENTRY_CAP.total);
  const daily = count(source.daily, DEFAULT_ENTRY_CAP.daily);
  const tech = count(source.tech, DEFAULT_ENTRY_CAP.tech);
  return {
    mode: source.mode === 'group' ? 'group' : 'total',
    total,
    daily,
    tech,
    // The number that really applies: the larger of the unified total and the two
    // groups added together.
    effective: Math.max(total, daily + tech),
    // One shared character limit for every conclusion, model-written or typed.
    charLimit: clampCharLimit(source.charLimit, DEFAULT_ENTRY_CAP.charLimit),
  };
}

/**
 * The source-identity of one turn: `sessionId#turn`.
 *
 * This is the robust half of the blacklist: a text key stops matching as soon as the
 * model rewords an evidence line on a later re-digest, while the turn key keeps the
 * whole turn out of extraction no matter how the wording changes.
 *
 * @param value - an evidence row or a profile source reference.
 * @returns the turn key.
 */
export function turnKey(value) {
  return `${value?.sessionId ?? '-'}#${value?.turn ?? '-'}`;
}

/**
 * Whether one evidence row is silenced.
 * @param row - the evidence row.
 * @param blacklist - `{ keys, turns }` sets.
 * @returns true when the row must not be used.
 */
export function isBlacklisted(row, blacklist) {
  const keys = blacklist?.keys;
  const turns = blacklist?.turns;
  if (keys instanceof Set && keys.has(evidenceKey(row))) return true;
  if (turns instanceof Set && turns.has(turnKey(row))) return true;
  return false;
}

/**
 * Drop evidence rows the user has blacklisted.
 *
 * A physically deleted conclusion takes its own evidence with it; blacklisting the
 * exact rows keeps a later re-digest of the same session from bringing them back,
 * and the turn set covers the rows a re-digest rewords.
 *
 * @param rows - evidence rows.
 * @param keys - blacklisted evidence keys (or the whole `{ keys, turns }` document).
 * @param turns - blacklisted turn keys.
 * @returns the rows that may still be used.
 */
export function filterBlacklisted(rows, keys, turns) {
  const list = Array.isArray(rows) ? rows : [];
  if (keys !== null && typeof keys === 'object' && !(keys instanceof Set)) {
    return filterBlacklisted(list, keys.keys, keys.turns);
  }
  const keySet = keys instanceof Set ? keys : new Set();
  const turnSet = turns instanceof Set ? turns : new Set();
  if (keySet.size === 0 && turnSet.size === 0) return list;
  return list.filter((row) => !isBlacklisted(row, { keys: keySet, turns: turnSet }));
}

/**
 * The evidence a synthesis run may use.
 *
 * Two filters, both required: only `dimension` / `preference` rows are evidence at
 * all, and rows the blacklist silences must never reach the model. A retired
 * conclusion's evidence still sits in the ledger, so filtering only when rows are
 * appended would let it keep shaping new conclusions.
 *
 * @param rows - the evidence ledger.
 * @param keys - blacklisted evidence keys.
 * @param turns - blacklisted turn keys.
 * @returns the rows a synthesis call may see.
 */
export function selectSynthesisSource(rows, keys, turns) {
  const usable = (Array.isArray(rows) ? rows : []).filter((row) => row.kind === 'dimension' || row.kind === 'preference');
  return filterBlacklisted(usable, keys, turns);
}

/**
 * Plan a timeline compaction.
 *
 * Rules (agreed with the user):
 *
 * - Rows are grouped by their source: one session + one turn ("覆盖来源相同").
 * - A turn cited by ANY conclusion (active or not) is protected, so restoring a
 *   retired conclusion still has its evidence.
 * - Turns nobody cites are removed entirely: noise the portrait never used.
 * - A protected turn keeps at most `perTurn` rows, preferring the rows that actually
 *   back a conclusion, then the newest.
 *
 * Nothing is written here: the caller previews the counts, then executes.
 *
 * @param profile - the portrait.
 * @param rows - the evidence ledger.
 * @param perTurn - rows kept per protected turn.
 * @returns `{ keep, remove, stats }`.
 */
export function planTimelineCompaction(profile, rows, perTurn = 2) {
  const list = Array.isArray(rows) ? rows : [];
  const groups = new Map();
  for (const row of list) {
    const key = `${row.sessionId ?? '-'}#${row.turn ?? '-'}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }
  const cited = new Set();
  const backing = [];
  for (const id of DIMENSION_IDS) {
    for (const entry of profile?.dimensions?.[id] ?? []) {
      for (const source of entry.sources ?? []) cited.add(`${source.sessionId ?? '-'}#${source.turn ?? '-'}`);
      if (typeof entry.text === 'string' && entry.text !== '') backing.push(entry.text);
    }
  }
  const limit = Math.max(1, Math.floor(Number(perTurn) || 2));
  const keep = [];
  const remove = [];
  let protectedTurns = 0;
  let removedTurns = 0;
  for (const [key, group] of groups) {
    if (!cited.has(key)) {
      remove.push(...group);
      removedTurns += 1;
      continue;
    }
    protectedTurns += 1;
    // Keep what a conclusion is actually made of, then the freshest leftovers.
    const ranked = group.slice().sort((left, right) => {
      const leftBacked = backing.some((text) => rowSupportsEntry(left, text)) ? 1 : 0;
      const rightBacked = backing.some((text) => rowSupportsEntry(right, text)) ? 1 : 0;
      if (leftBacked !== rightBacked) return rightBacked - leftBacked;
      return (right.at ?? 0) - (left.at ?? 0);
    });
    keep.push(...ranked.slice(0, limit));
    remove.push(...ranked.slice(limit));
  }
  return {
    keep,
    remove,
    stats: {
      rows: list.length,
      turns: groups.size,
      protectedTurns,
      removedTurns,
      keptRows: keep.length,
      removedRows: remove.length,
      perTurn: limit,
    },
  };
}

/**
 * Evidence keys that belong to one conclusion.
 *
 * "Belongs to" is the same containment test the purge path uses, so a retired
 * conclusion and a permanently deleted one select the same rows.
 *
 * @param entry - the conclusion.
 * @param rows - the evidence ledger.
 * @returns the matching keys.
 */
export function keysBackedByEntry(entry, rows) {
  const list = Array.isArray(rows) ? rows : [];
  const keys = [];
  for (const row of list) if (rowSupportsEntry(row, entry?.text)) keys.push(evidenceKey(row));
  return keys;
}

/**
 * The blacklist a profile implies, given what is already pinned there.
 *
 * Four sets, two layers each:
 *
 * - **pinned** (`pinnedKeys` / `pinnedTurns`) — written when a conclusion is deleted
 *   for good or a timeline compaction drops rows. Nothing brings those back.
 * - **derived** — computed from the profile on every reconcile: a conclusion that is
 *   NOT active (retired / superseded) silences its own rows and its own turns, so
 *   restoring it removes them again automatically.
 *
 * Exemptions, both about not hurting someone else's evidence:
 *
 * - a row that also supports an active conclusion is never silenced;
 * - a turn cited by an active conclusion is never silenced as a turn.
 *
 * The turn half is what keeps a re-digest from resurrecting deleted evidence: a
 * re-digest rewords rows (new text key) but cannot change the turn it came from.
 *
 * @param profile - the portrait.
 * @param rows - the evidence ledger.
 * @param pinnedKeys - keys that must stay blacklisted regardless of profile state.
 * @param pinnedTurns - turn keys that must stay blacklisted regardless of state.
 * @returns `{ keys, turns, pinnedKeys, pinnedTurns }`.
 */
export function blacklistForProfile(profile, rows, pinnedKeys = [], pinnedTurns = []) {
  const keySet = new Set((Array.isArray(pinnedKeys) ? pinnedKeys : []).filter((key) => typeof key === 'string'));
  const turnSet = new Set((Array.isArray(pinnedTurns) ? pinnedTurns : []).filter((key) => typeof key === 'string'));
  const activeKeys = new Set();
  const activeTurns = new Set();
  const inactiveKeys = new Set();
  const inactiveTurns = new Set();
  for (const id of DIMENSION_IDS) {
    for (const entry of profile?.dimensions?.[id] ?? []) {
      const isActive = entry?.status === 'active';
      for (const source of entry?.sources ?? []) {
        (isActive ? activeTurns : inactiveTurns).add(turnKey(source));
      }
      for (const key of keysBackedByEntry(entry, rows)) {
        (isActive ? activeKeys : inactiveKeys).add(key);
      }
    }
  }
  for (const key of inactiveKeys) if (!activeKeys.has(key)) keySet.add(key);
  for (const turn of inactiveTurns) if (!activeTurns.has(turn)) turnSet.add(turn);
  return {
    keys: [...keySet].sort(),
    turns: [...turnSet].sort(),
    pinnedKeys: [...new Set(Array.isArray(pinnedKeys) ? pinnedKeys : [])].sort(),
    pinnedTurns: [...new Set(Array.isArray(pinnedTurns) ? pinnedTurns : [])].sort(),
  };
}

/**
 * The effective blacklist a profile implies, as `{ keys, turns }`.
 * @param profile - the portrait.
 * @param rows - the evidence ledger.
 * @param pinnedKeys - pinned row keys.
 * @param pinnedTurns - pinned turn keys.
 * @returns `{ keys, turns }` with both halves merged.
 */
export function blacklistKeysForProfile(profile, rows, pinnedKeys = [], pinnedTurns = []) {
  const document = blacklistForProfile(profile, rows, pinnedKeys, pinnedTurns);
  return document.keys;
}

/**
 * Words that mark a statement as a requirement/preference, not a fact.
 *
 * Kept as plain arrays and compiled per use: a `/g` regex used with `.test()` is
 * stateful (`lastIndex` carries between calls), which silently makes consecutive
 * checks alternate between true and false.
 */
const REQUIREMENT_WORDS = ['要求', '必须', '务务必', '不要', '别', '应该', '需要', '优先', '避免', '禁止', '只能', '务必', '偏好', '倾向', '希望', '尽量', '不准', '不能'];

/** Words that mark a statement as a step of a process. */
const FLOW_WORDS = ['先', '首先', '然后', '接着', '之后', '随后', '最后', '再', '步骤', '流程', '顺序', '一开始', '其次'];

const REQUIREMENT_RE = new RegExp(REQUIREMENT_WORDS.join('|'), 'u');
const FLOW_RE = new RegExp(FLOW_WORDS.join('|'), 'u');

/**
 * Whether a statement is a requirement about how something should be.
 * @param normalized - normalized text.
 * @returns true when it reads as a requirement.
 */
function isRequirement(normalized) {
  return REQUIREMENT_RE.test(normalized);
}

/**
 * Whether a statement is a step in a process.
 * @param normalized - normalized text.
 * @returns true when it reads as a step.
 */
function isFlowStep(normalized) {
  return FLOW_RE.test(normalized);
}

/**
 * Remove requirement/flow words, leaving what the statement is actually about.
 * @param normalized - normalized text.
 * @returns the text without those markers.
 */
function stripMarkers(normalized) {
  return String(normalized)
    .replace(new RegExp(REQUIREMENT_WORDS.join('|'), 'gu'), '')
    .replace(new RegExp(FLOW_WORDS.join('|'), 'gu'), '');
}

/**
 * Length of the longest run of characters two strings share.
 * @param left - one string.
 * @param right - the other.
 * @returns the longest common substring length.
 */
function longestCommonRun(left, right) {
  if (left === '' || right === '') return 0;
  let best = 0;
  // Classic dynamic programming over the shorter axis; these strings are short, so
  // a full table is cheaper than an index and far easier to reason about.
  const rows = left.length + 1;
  const columns = right.length + 1;
  const table = new Uint16Array(rows * columns);
  for (let i = 1; i < rows; i += 1) {
    for (let j = 1; j < columns; j += 1) {
      if (left[i - 1] !== right[j - 1]) continue;
      const value = table[(i - 1) * columns + (j - 1)] + 1;
      table[i * columns + j] = value;
      if (value > best) best = value;
    }
  }
  return best;
}

/** Strip punctuation and case so two phrasings compare equal. */
function normalizeForCompare(text) {
  return String(text ?? '')
    .toLowerCase()
    .replace(/[\s，。、；：！？,.;:!?“”"'（）()《》〈〉【】\[\]—\-…·|/\\]+/gu, '');
}

/** Latin/digit runs of at least four characters, treated as distinctive terms. */
function latinTerms(normalized) {
  return [...String(normalized).matchAll(/[a-z0-9]{4,}/g)].map((match) => match[0]);
}

/** Sørensen–Dice coefficient over character bigrams. */
function diceBigrams(a, b) {
  if (a.length < 2 || b.length < 2) return a === b ? 1 : 0;
  const grams = new Map();
  for (let index = 0; index < a.length - 1; index += 1) {
    const gram = a.slice(index, index + 2);
    grams.set(gram, (grams.get(gram) ?? 0) + 1);
  }
  let overlap = 0;
  for (let index = 0; index < b.length - 1; index += 1) {
    const gram = b.slice(index, index + 2);
    const count = grams.get(gram) ?? 0;
    if (count > 0) {
      grams.set(gram, count - 1);
      overlap += 1;
    }
  }
  return (2 * overlap) / (a.length - 1 + (b.length - 1));
}

/**
 * Merge one model-produced portrait over the previous document.
 *
 * The model returns only `dimensions`; identity, counters, and user notes are
 * owned by the plugin so a malformed reply can never lose them.
 *
 * @param previous - the profile before synthesis.
 * @param raw - parsed model output.
 * @param now - clock reading for this merge.
 * @param options - optional `sourceIndex` used to fill in a source's time and excerpt.
 * @returns the merged profile document plus a merge report.
 */
export function mergeSynthesis(previous, raw, now = Date.now(), options = {}) {
  const sourceIndex = options.sourceIndex;
  // The adjustable text budget applies to merged candidates too.
  const mergeLimit = clampCharLimit(options.textLimit, AUTO_ENTRY_TEXT_LIMIT);
  const incoming = raw !== null && typeof raw === 'object' && raw.dimensions !== null && typeof raw.dimensions === 'object'
    ? raw.dimensions
    : undefined;
  if (incoming === undefined) return { profile: previous, report: { accepted: false, reason: 'no dimensions object' } };

  // A scoped reply carries only its own dimensions. Dimensions it did not receive
  // are untouched — carrying them forward is what makes the merge incremental,
  // and it keeps the reply small enough that the output budget cannot truncate
  // it (which used to discard the whole synthesis).
  const dimensions = {};
  let accepted = 0;
  let rejected = 0;
  let combined = 0;
  for (const id of DIMENSION_IDS) {
    const previousEntries = previous.dimensions?.[id] ?? [];
    if (!Object.hasOwn(incoming, id)) {
      dimensions[id] = previousEntries;
      continue;
    }
    const candidates = Array.isArray(incoming[id]) ? incoming[id] : [];
    const previousByText = new Map(previousEntries.map((entry) => [entry.text, entry]));
    const merged = [];
    const seen = new Set();
    /**
     * Fold a candidate into an entry that already exists in this dimension.
     *
     * Two things end up here: a rephrasing of a stored conclusion (text differs,
     * meaning does not), and a second statement about the same topic inside ONE
     * reply — the model tends to emit "玩 galgame" and "挑 galgame 看重剧情质量"
     * as two rows even when they are one conclusion. Merging is preferred over
     * creating a row, which is the whole point of this pass.
     */
    const absorb = (target, candidate, text) => {
      const statement = mergeStatement(target.statement, candidate.statement);
      const group = groupOfDimension(id);
      const manual = target.manual === true || candidate.manual === true;
      const proposed = strongestConfidence(candidate.confidence, target.confidence);
      target.text = combineText(target.text, text, options.textLimit);
      target.statement = statement;
      // An `assistant` inference does not lift a `user` conclusion's confidence
      // past its group ceiling, so the strongest value is taken first and then
      // clamped by the merged statement.
      target.confidence = manual ? normalizeConfidence(proposed) : clampConfidence(normalizeConfidence(proposed), statement, group);
      target.status = normalizeStatus(candidate.status, target.status);
      target.sources = enrichSources(mergeSources(target.sources, candidate.sources), sourceIndex);
      if (typeof candidate.note === 'string' && candidate.note.trim() !== '') {
        target.note = maskSecrets(candidate.note.trim()).slice(0, 200);
      }
      target.lastConfirmedAt = now;
      target.id = entryId(id, target);
      if (manual) target.manual = true;
      combined += 1;
      accepted += 1;
    };
    for (const candidate of candidates) {
      if (candidate === null || typeof candidate !== 'object') {
        rejected += 1;
        continue;
      }
      const text = typeof candidate.text === 'string' ? maskSecrets(candidate.text.trim()).slice(0, mergeLimit) : '';
      if (text === '' || seen.has(text)) {
        rejected += 1;
        continue;
      }
      seen.add(text);
      // The basis must be provable, not merely declared: an entry that claims the
      // user's words has to point at a source passage that the digest itself
      // verified as the user's. A hand-written entry is exempt — the user typed it
      // in the panel, so there is no quote to trace.
      if (candidate.manual !== true) {
        candidate.statement = statementForCandidate(candidate, sourceIndex);
      }
      // Where does this statement belong? Two places are checked before a new row
      // is created, which is the whole point of the merge-first rule:
      //  1. a conclusion already built in THIS reply (the model emitted the same
      //     topic twice), and
      //  2. a conclusion already in the profile, rephrased or refined.
      const target =
        merged.find((entry) => isSameConclusion(entry.text, text)) ??
        previousEntries.find((entry) => isSameConclusion(entry.text, text));
      if (target !== undefined) {
        // A target found in `previousEntries` is NOT in `merged` yet: without this
        // the absorbed conclusion would be mutated but never emitted, and the whole
        // entry would vanish from the profile. Seed it into the result set first,
        // and mark its text as seen so an identical candidate later in the reply
        // cannot produce a second row.
        const targetText = target.text;
        if (!merged.includes(target)) {
          merged.push(target);
          seen.add(targetText);
        }
        absorb(target, candidate, text);
        previousByText.delete(targetText);
        continue;
      }
      const existing = previousByText.get(text);
      // The model echoes only session + turn, so the source's time and excerpt
      // are filled in from the evidence ledger. Keeping the excerpt out of the
      // reply is deliberate: it keeps the reply inside the output budget, and the
      // ledger is the authority on it anyway.
      const sources = enrichSources(mergeSources(existing?.sources, candidate.sources), sourceIndex);
      const status = normalizeStatus(candidate.status, existing?.status);
      // The statement is a claim about the evidence, resolved the same way a
      // duplicate is: if ANY basis is the user's own words, that outranks an
      // inference from the assistant, because the user is the authority on
      // themselves. This is also what implements "merge similar entries, the
      // user's own wording wins".
      const statement = mergeStatement(existing?.statement, candidate.statement);
      const group = groupOfDimension(id);
      const manual = existing?.manual === true || candidate.manual === true;
      merged.push({
        text,
        statement,
        // Confidence is clamped by the statement and the group, so the model can
        // neither promote an inference past its ceiling nor record a technical
        // claim it only read about above `low`. A hand-edited entry keeps the
        // user's own choice.
        confidence: manual
          ? normalizeConfidence(candidate.confidence ?? existing?.confidence)
          : clampConfidence(normalizeConfidence(candidate.confidence ?? existing?.confidence), statement, group),
        status,
        sources,
        note: typeof candidate.note === 'string' ? maskSecrets(candidate.note.trim()).slice(0, 200) : existing?.note,
        firstSeenAt: existing?.firstSeenAt ?? now,
        lastConfirmedAt: now,
        ...(manual ? { manual: true } : {}),
      });
      accepted += 1;
      previousByText.delete(text);
    }
    // Anything the model dropped WITHIN a dimension it did receive stays as
    // history rather than silently vanishing.
    for (const leftover of previousByText.values()) {
      merged.push({ ...leftover, status: leftover.status === 'active' ? 'superseded' : leftover.status });
      rejected += 1;
    }
    dimensions[id] = merged;
  }
  return {
    profile: { ...previous, dimensions, updatedAt: now },
    report: {
      accepted: true,
      acceptedEntries: accepted,
      preservedEntries: rejected,
      // How many statements were folded into an existing conclusion instead of
      // becoming their own row.
      combinedEntries: combined,
      scoped: Object.keys(incoming).length,
    },
  };
}

/**
 * The stronger of two confidence values.
 *
 * Merging two statements about one thing must not weaken the conclusion: a
 * `medium` refinement of a `high` observation stays `high`.
 *
 * @param left - one confidence.
 * @param right - the other confidence.
 * @returns the stronger value, defaulting to `medium` when neither is set.
 */
function strongestConfidence(left, right) {
  const rank = { high: 3, medium: 2, low: 1 };
  const a = rank[left] ?? 0;
  const b = rank[right] ?? 0;
  if (a === 0 && b === 0) return 'medium';
  return a >= b ? left : right;
}

/**
 * Resolve the basis an incoming entry is actually entitled to.
 *
 * `user` claims are checked against the evidence ledger: at least one of the
 * entry's sources must resolve to a passage the digest verified as the user's own
 * words. Without that, the claim is a model inference however it is labelled, and
 * it is demoted (and re-clamped) as such.
 *
 * `mixed` is treated the same way — a conclusion can only rest partly on the
 * user's words if it actually points at some of them. `mixed` is otherwise
 * produced by the merge itself (see {@link mergeStatement}), not by the model.
 *
 * A legacy evidence row written before the marker existed counts as the user's,
 * matching how stored entries are normalized.
 *
 * @param candidate - the model-produced entry.
 * @param sourceIndex - `sessionId#turn` to evidence row, when available.
 * @returns the verified statement marker.
 */
function statementForCandidate(candidate, sourceIndex) {
  const claimed = normalizeStatement(candidate.statement);
  if (claimed === 'assistant') return 'assistant';
  // Without a ledger index there is nothing to check against (unit callers); the
  // digest-time verification is then the only gate, so the label is kept.
  if (sourceIndex === undefined || typeof sourceIndex?.get !== 'function') return claimed;
  const sources = Array.isArray(candidate.sources) ? candidate.sources : [];
  for (const source of sources) {
    const row = sourceIndex.get(`${source?.sessionId ?? ''}#${source?.turn ?? ''}`);
    if (row === undefined) continue;
    // Only an explicit `user` row proves the user's words. An unmarked row (legacy
    // data whose transcript could not be re-read) proves nothing.
    if (row.statement === 'user') return claimed;
  }
  return 'assistant';
}

/**
 * Merge two statement markers.
 *
 * When a conclusion was built from the user's words AND from the model's own
 * inference, the result is `mixed` — not `user`. Labelling it `user` would erase
 * the fact that part of it is an inference, which is exactly what the confidence
 * ceiling exists to prevent.
 *
 * `undefined` stays "no opinion": defaulting it to `user` here would let a
 * brand-new `assistant` entry be relabelled as the user's own words, which is the
 * bypass this policy exists to prevent.
 *
 * @param existing - the stored statement, if any.
 * @param incoming - the proposed statement, if any.
 * @returns `user`, `assistant`, or `mixed`.
 */
function mergeStatement(existing, incoming) {
  const a = STATEMENTS.includes(existing) ? existing : undefined;
  const b = STATEMENTS.includes(incoming) ? incoming : undefined;
  if (a === undefined && b === undefined) return 'user';
  if (a === undefined) return b;
  if (b === undefined) return a;
  if (a === b) return a;
  // Both bases are represented in the merged conclusion.
  return 'mixed';
}

/**
 * Build a lookup from `sessionId#turn` to the ledger row behind it.
 *
 * @param rows - evidence rows from the ledger.
 * @returns a map keyed by session and turn.
 */
export function sourceIndexOf(rows) {
  const index = new Map();
  for (const row of Array.isArray(rows) ? rows : []) {
    const key = `${row.sessionId ?? ''}#${row.turn ?? ''}`;
    const previous = index.get(key);
    // Keep the row that actually carries an excerpt.
    if (previous === undefined || (previous.source ?? '') === '') index.set(key, row);
  }
  return index;
}

/**
 * Fill in what a source reference is missing — its time and its excerpt.
 * @param sources - merged source references.
 * @param index - the ledger index from {@link sourceIndexOf}, when available.
 * @returns sources carrying `at` and `text` where the ledger knows them.
 */
function enrichSources(sources, index) {
  if (index === undefined || typeof index?.get !== 'function') return sources;
  return sources.map((source) => {
    const row = index.get(`${source.sessionId ?? ''}#${source.turn ?? ''}`);
    if (row === undefined) return source;
    return {
      ...source,
      at: source.at ?? row.at,
      text: source.text ?? row.source,
    };
  });
}

/**
 * Merge source references, de-duplicated and capped.
 * @param existing - sources already recorded.
 * @param incoming - sources proposed by the model. * @returns the merged source list.
 */
function mergeSources(existing, incoming) {
  const merged = [];
  const seen = new Set();
  const push = (source) => {
    if (source === null || typeof source !== 'object') return;
    const sessionId = typeof source.sessionId === 'string' ? source.sessionId.slice(0, 120) : '';
    if (sessionId === '') return;
    const turn = Number.isFinite(source.turn) ? Number(source.turn) : undefined;
    const key = `${sessionId}#${turn ?? '-'}`;
    if (seen.has(key)) return;
    seen.add(key);
    merged.push(turn === undefined ? { sessionId } : { sessionId, turn });
  };
  for (const source of existing ?? []) push(source);
  for (const source of incoming ?? []) push(source);
  return merged.slice(-12);
}

/**
 * Normalize a confidence value.
 * @param value - candidate value.
 * @param fallback - value used when the candidate is unusable.
 * @returns one of `high`, `medium`, `low`.
 */
export function normalizeConfidence(value, fallback = 'medium') {
  const text = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (text === 'high' || text === '中高' || text === '高') return 'high';
  if (text === 'low' || text === '低') return 'low';
  if (text === 'medium' || text === '中') return 'medium';
  return fallback;
}

/**
 * Normalize an entry lifecycle status.
 * @param value - candidate value.
 * @param fallback - value used when the candidate is unusable.
 * @returns one of `active`, `superseded`, `retired`.
 */
function normalizeStatus(value, fallback = 'active') {
  const text = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (text === 'active' || text === 'superseded' || text === 'retired') return text;
  return fallback;
}

/**
 * Build the session roll-up prompt from recorded turn rows.
 * @param sessionId - session identity.
 * @param turns - recorded turn rows.
 * @returns the prompt text.
 */
export function buildSessionPrompt(sessionId, turns) {
  const turnLines = turns
    .map((turn) => {
      const points = (turn.userKeyPoints ?? []).map((point) => `    · ${point}`).join('\n');
      return [
        `- 第 ${turn.turn} 轮`,
        `  我问: ${turn.userAsk ?? ''}`,
        points,
        `  你答: ${turn.assistantSummary ?? ''}`,
        (turn.corrections ?? []).length === 0
          ? ''
          : `  纠正: ${turn.corrections.map((item) => item.text).join(' / ')}`,
      ]
        .filter((line) => line !== '')
        .join('\n');
    })
    .join('\n');
  return sessionDigestPrompt({ sessionId, turnLines });
}

/**
 * Normalize one model-produced session roll-up.
 * @param raw - parsed model output.
 * @returns the normalized roll-up fields.
 */
export function normalizeSessionRollup(raw) {
  const value = raw !== null && typeof raw === 'object' ? raw : {};
  const list = (input, limit) =>
    Array.isArray(input)
      ? input.filter((item) => typeof item === 'string' && item.trim() !== '').map((item) => maskSecrets(item.trim()).slice(0, 200)).slice(0, limit)
      : [];
  return {
    topic: typeof value.topic === 'string' ? maskSecrets(value.topic.trim()).slice(0, 300) : '',
    overview: typeof value.overview === 'string' ? maskSecrets(value.overview.trim()).slice(0, 1200) : '',
    threads: list(value.threads, 10),
    outcomes: list(value.outcomes, 10),
    unresolved: list(value.unresolved, 10),
  };
}

/**
 * Parse a model reply into JSON, reporting the failure instead of throwing.
 * @param text - raw model output.
 * @returns the parsed value, or undefined when parsing failed.
 */
export function safeParse(text) {
  try {
    return parseJsonReply(text);
  } catch {
    return undefined;
  }
}

/**
 * Build a session roll-up from the recorded turn digests alone.
 *
 * This is deterministic and free, so a session record always carries a topic and
 * an overview; the model-written roll-up replaces it later when one is produced.
 *
 * @param turns - recorded turn digest rows in turn order.
 * @returns a roll-up object marked as derived.
 */
export function buildDerivedRollup(turns) {
  const list = Array.isArray(turns) ? turns.filter((turn) => turn !== null && typeof turn === 'object') : [];
  if (list.length === 0) {
    return { topic: '', overview: '', threads: [], outcomes: [], unresolved: [], source: 'derived' };
  }
  const parts = [];
  for (const turn of list.slice(-5)) {
    const asked = typeof turn.userAsk === 'string' ? turn.userAsk.trim() : '';
    const answered = typeof turn.assistantSummary === 'string' ? turn.assistantSummary.trim() : '';
    if (asked !== '') parts.push(`问：${asked}`);
    if (answered !== '') parts.push(`答：${answered}`);
  }
  const threads = [];
  for (const turn of list) {
    for (const point of turn.userKeyPoints ?? []) {
      const text = typeof point === 'string' ? point.trim() : '';
      if (text !== '' && !threads.includes(text)) threads.push(text);
    }
  }
  const outcomes = [];
  for (const turn of list) {
    const value = typeof turn.outcome === 'string' ? turn.outcome.trim() : '';
    if (value !== '' && !outcomes.includes(value)) outcomes.push(value);
  }
  return {
    topic: (typeof list[0].userAsk === 'string' ? list[0].userAsk.trim() : '').slice(0, 160),
    overview: parts.join(' ').slice(0, 1200),
    threads: threads.slice(0, 10),
    outcomes: outcomes.slice(0, 10),
    unresolved: [],
    source: 'derived',
  };
}








