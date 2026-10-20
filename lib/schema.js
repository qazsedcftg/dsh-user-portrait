/**
 * Data shapes of the user portrait: profile document, evidence ledger, turn
 * digests, and session digests. No I/O lives here so both the Host plugin and
 * the review panel can share the same vocabulary.
 *
 * Two groups organize the catalog for humans: `daily` (how the person lives and
 * talks) and `tech` (how the person works). Similar technical dimensions were
 * merged, so every stored id below is the ONLY id new evidence may carry; the
 * ids of the first shipped catalog survive in {@link LEGACY_DIMENSION_MAP} so an
 * already-written profile folds into the merged dimensions instead of losing
 * rows.
 *
 * @module dsh-user-portrait/schema
 */

/** Bumped when stored field names or fold semantics change. */
export const PROFILE_VERSION = 3;

/**
 * Text caps, in characters.
 *
 * The limit is user-adjustable (`entryCap.charLimit`) and covers **both** the
 * model's conclusions and hand-written ones. The constants below are the defaults
 * and the sanity bounds: anything outside the bounds is clamped, never rejected.
 */
export const AUTO_ENTRY_TEXT_LIMIT = 50;

/** Legacy ceiling for hand-written conclusions; the adjustable limit now wins. */
export const ENTRY_TEXT_LIMIT = 80;

/** Smallest and largest accepted per-conclusion character limit. */
export const CHAR_LIMIT_MIN = 1;
export const CHAR_LIMIT_MAX = 500;

/**
 * Coerce one configured character limit into the accepted range.
 * @param value - candidate limit.
 * @param fallback - used when the value is not a positive number.
 * @returns a whole number between {@link CHAR_LIMIT_MIN} and {@link CHAR_LIMIT_MAX}.
 */
export function clampCharLimit(value, fallback = AUTO_ENTRY_TEXT_LIMIT) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(CHAR_LIMIT_MAX, Math.max(CHAR_LIMIT_MIN, Math.floor(number)));
}

/**
 * Default conclusion caps, stored per profile in `state.json`.
 *
 * `total` is the whole-portrait budget (manual entries excluded); `group` splits
 * the same idea between the daily and technical groups. Both are user-settable.
 */
export const DEFAULT_ENTRY_CAP = Object.freeze({ mode: 'total', total: 50, daily: 20, tech: 30, charLimit: AUTO_ENTRY_TEXT_LIMIT });

/** Similarity floor for folding an over-cap conclusion into an existing one. */
export const OVERFLOW_MERGE_THRESHOLD = 0.5;

/**
 * The two display groups, in declaration order. Groups are presentation only:
 * nothing is stored per group, so adding one needs no migration.
 */
export const DIMENSION_GROUPS = [
  {
    id: 'daily',
    label: '日常画像',
    hint: '性格、爱好、生活背景与当前状态 —— 只有你亲口说过的才会进来，所以这里条目少、置信度偏低是正常的',
  },
  {
    id: 'tech',
    label: '技术画像',
    hint: '能力与技术栈、工作方式、风险边界与敏感点',
  },
];

/** Valid group ids, in declaration order. */
export const DIMENSION_GROUP_IDS = DIMENSION_GROUPS.map((group) => group.id);

/**
 * The nine portrait dimensions — five daily, four technical. Each id is stored
 * next to every entry, so ids stay stable and are never renamed once shipped.
 */
export const DIMENSIONS = [
  {
    id: 'personality',
    group: 'daily',
    label: '性格与沟通',
    hint: '性格倾向、对待反馈的态度、期望的回复详略与结构、语气与术语密度',
  },
  {
    id: 'interests',
    group: 'daily',
    label: '兴趣与爱好',
    hint: '长期兴趣、业余投入、持续关注的话题与内容品类',
  },
  {
    id: 'background',
    group: 'daily',
    label: '生活与身份',
    hint: '身份与专业背景、作息与时间安排、生活层面的固定约束',
  },
  {
    id: 'focus',
    group: 'daily',
    label: '当前在做',
    hint: '正在推进的项目、阶段目标、近期关注点（有明确时效，过时可废弃）',
  },
  {
    id: 'current',
    group: 'daily',
    label: '近期状态',
    hint: '近段时间的处境与情绪：忙闲节奏、压力来源、正在等待或纠结的事（短期结论，会自然过期）',
  },
  {
    id: 'skill',
    group: 'tech',
    label: '能力与技术栈',
    hint: '熟练的语言/框架/平台、擅长的任务类型、专业与行业背景、常用工具与编辑器偏好',
  },
  {
    id: 'workstyle',
    group: 'tech',
    label: '工作方式',
    hint: '节奏与粒度、计划性与验证习惯；正确性/效率/可维护性/隐私/成本的优先级；不确定时如何收敛',
  },
  {
    id: 'boundary',
    group: 'tech',
    label: '风险边界',
    hint: '不接受的做法、红线、必须先确认的事项、授权尺度',
  },
  {
    id: 'friction',
    group: 'tech',
    label: '敏感点',
    hint: '反复纠正的点、易被误解之处、明确表达过不满的行为',
  },
];

/** Valid dimension ids, in declaration order. */
export const DIMENSION_IDS = DIMENSIONS.map((dimension) => dimension.id);

/**
 * The first shipped catalog, folded into the nine dimensions above. Keys are
 * retired ids, values the id that now owns their entries.
 */
export const LEGACY_DIMENSION_MAP = Object.freeze({
  ability: 'skill',
  tech: 'skill',
  domain: 'skill',
  tooling: 'skill',
  values: 'workstyle',
  decision: 'workstyle',
  communication: 'personality',
});

/** Retired dimension ids, in the order the first catalog declared them. */
export const LEGACY_DIMENSION_IDS = Object.freeze([
  'ability',
  'tech',
  'domain',
  'tooling',
  'workstyle',
  'values',
  'decision',
  'boundary',
  'friction',
  'communication',
]);

const DIMENSION_ID_SET = new Set(DIMENSION_IDS);
const LEGACY_DIMENSION_ID_SET = new Set(LEGACY_DIMENSION_IDS);

/**
 * Report whether an arbitrary value is one of the nine dimension ids.
 * @param value - candidate id.
 * @returns true when the value names a current dimension.
 */
export function isDimensionId(value) {
  return typeof value === 'string' && DIMENSION_ID_SET.has(value);
}

/**
 * Report whether an arbitrary value is a retired dimension id.
 * @param value - candidate id.
 * @returns true when the value names a dimension of the first catalog.
 */
export function isLegacyDimensionId(value) {
  return typeof value === 'string' && LEGACY_DIMENSION_ID_SET.has(value);
}

/**
 * Resolve a dimension id of either catalog to the id that owns it today.
 * @param value - a current or retired dimension id.
 * @returns the current id, or undefined when the value names no dimension.
 */
export function resolveDimensionId(value) {
  if (isDimensionId(value)) return value;
  if (isLegacyDimensionId(value)) return LEGACY_DIMENSION_MAP[value] ?? value;
  return undefined;
}

/**
 * Look one dimension up by id, accepting retired ids too.
 * @param value - a current or retired dimension id.
 * @returns the dimension descriptor, or undefined.
 */
export function dimensionById(value) {
  const id = resolveDimensionId(value);
  return DIMENSIONS.find((dimension) => dimension.id === id);
}

/** Confidence levels accepted on a portrait entry, strongest first. */
export const CONFIDENCES = ['high', 'medium', 'low'];

/** Entry lifecycle states: `active` counts, `superseded`/`retired` stay as history. */
export const STATUSES = ['active', 'superseded', 'retired'];

/**
 * Who said the thing an entry rests on.
 *
 * `user` — the user's own words. `assistant` — inferred from something the
 * assistant said (an explanation, a proposal, a summary the user read). The
 * distinction is the whole point of the extraction policy: what the user asked
 * for is evidence about the user, while what the assistant wrote is not.
 *
 * `mixed` is never claimed by the model: it is what a merge produces when one
 * conclusion was built from BOTH bases. Keeping it as its own state is what lets
 * the panel say "用户的话 & 模型应答" instead of silently dropping half the
 * provenance.
 */
export const STATEMENTS = ['user', 'assistant', 'mixed'];

/** The confidence a `user` statement starts at. */
export const INITIAL_USER_CONFIDENCE = 'medium';

/** The confidence an `assistant` statement starts at. */
export const INITIAL_ASSISTANT_CONFIDENCE = 'low';

/**
 * How high an entry resting on ANY model inference may ever climb, by group.
 *
 * A conversational aside can be good evidence about someone's interests, so the
 * daily group lets it reach `medium` once the user's own words back it. A
 * technical claim is different: reading an explanation is not the same as
 * knowing the technology, so those stay at `low` until the user says otherwise
 * (or edits the entry by hand).
 *
 * `mixed` is clamped the same way as `assistant`: part of that conclusion is
 * inference, so it cannot borrow the confidence the user's own words earned.
 */
const ASSISTANT_CEILING = { daily: 'medium', tech: 'low' };

/**
 * Report whether a statement involves model inference.
 * @param statement - a statement marker.
 * @returns true for `assistant` and `mixed`.
 */
export function restsOnInference(statement) {
  return statement === 'assistant' || statement === 'mixed';
}

/**
 * The strongest confidence an entry of this statement and group may carry.
 * @param statement - `user`, `assistant`, or `mixed`.
 * @param group - dimension group id (`daily` / `tech`).
 * @returns one of {@link CONFIDENCES}.
 */
export function confidenceCeiling(statement, group) {
  if (!restsOnInference(statement)) return 'high';
  return ASSISTANT_CEILING[group] ?? 'low';
}

/**
 * Clamp a confidence to what its statement and group allow.
 *
 * The ceiling is about what the MODEL may claim. A confidence the user set by hand
 * is their own judgement, so it is returned untouched: manual adjustments are never
 * limited by the basis. This is why `manual` is checked here rather than at each
 * call site — every load goes through `normalizeProfile`, and re-clamping there is
 * exactly what used to undo a manual promotion.
 *
 * @param confidence - proposed confidence.
 * @param statement - `user`, `assistant`, or `mixed`.
 * @param group - dimension group id.
 * @param manual - true when the user set this confidence (or the whole entry).
 * @returns the allowed confidence.
 */
export function clampConfidence(confidence, statement, group, manual = false) {
  const order = ['high', 'medium', 'low'];
  const value = order.includes(confidence) ? confidence : INITIAL_ASSISTANT_CONFIDENCE;
  if (manual === true) return value;
  const ceiling = confidenceCeiling(statement, group);
  return order.indexOf(value) < order.indexOf(ceiling) ? ceiling : value;
}

/**
 * The group a dimension belongs to.
 * @param dimensionId - current or retired dimension id.
 * @returns the group id, or undefined.
 */
export function groupOfDimension(dimensionId) {
  return dimensionById(dimensionId)?.group;
}

/**
 * Normalize an entry's statement marker.
 * @param value - candidate value.
 * @returns `user`, `assistant`, or `mixed`.
 */
export function normalizeStatement(value) {
  if (value === 'assistant') return 'assistant';
  if (value === 'mixed') return 'mixed';
  return 'user';
}

/** Create an empty profile document at the given clock reading. */
export function createProfile(now = Date.now()) {
  const dimensions = {};
  for (const id of DIMENSION_IDS) dimensions[id] = [];
  return {
    version: PROFILE_VERSION,
    updatedAt: now,
    synthesizedTurns: 0,
    lastSynthesisAt: 0,
    dimensions,
    notes: [],
  };
}

/**
 * Coerce a parsed document into the current shape without discarding unknown
 * fields, so a hand-edited file keeps working after an upgrade.
 *
 * Retired dimension buckets are folded into their merged dimension here, which
 * makes the upgrade idempotent: a second pass finds nothing left to move.
 *
 * @param value - parsed JSON of unknown provenance.
 * @returns a usable profile document.
 */
export function normalizeProfile(value) {
  const base = createProfile();
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return base;
  const profile = { ...base, ...value };
  profile.version = PROFILE_VERSION;
  if (!Number.isFinite(profile.updatedAt)) profile.updatedAt = Date.now();
  if (!Number.isFinite(profile.synthesizedTurns)) profile.synthesizedTurns = 0;
  if (!Number.isFinite(profile.lastSynthesisAt)) profile.lastSynthesisAt = 0;
  const stored = profile.dimensions !== null && typeof profile.dimensions === 'object' ? profile.dimensions : {};
  const dimensions = {};
  for (const id of DIMENSION_IDS) {
    const group = groupOfDimension(id);
    dimensions[id] = (Array.isArray(stored[id]) ? stored[id].filter(isUsableEntry) : []).map((entry) => {
      // Documents written before the statement marker existed treat every entry
      // as the user's own (that was the contract then), and confidences are
      // re-clamped so an upgraded file cannot keep a value its statement no
      // longer earns. A positional id left behind by an older build is replaced
      // with the text-derived one, so what is stored and what the panel receives
      // always agree.
      const statement = normalizeStatement(entry.statement);
      return {
        ...entry,
        statement,
        confidence: clampConfidence(entry.confidence, statement, group, entry.manual === true),
        id: entryId(id, entry),
      };
    });
  }
  // Fold every retired bucket into the dimension that merged it, then drop
  // entries whose text already exists there (a merge can produce duplicates).
  const seen = new Map(DIMENSION_IDS.map((id) => [id, new Set(dimensions[id].map(entryKey))]));
  for (const legacyId of LEGACY_DIMENSION_IDS) {
    const retired = stored[legacyId];
    if (!Array.isArray(retired)) continue;
    const target = LEGACY_DIMENSION_MAP[legacyId];
    if (target === undefined) continue;
    const already = seen.get(target);
    const group = groupOfDimension(target);
    for (const entry of retired.filter(isUsableEntry)) {
      const key = entryKey(entry);
      if (already.has(key)) continue;
      already.add(key);
      const statement = normalizeStatement(entry.statement);
      dimensions[target].push({
        ...entry,
        statement,
        confidence: clampConfidence(entry.confidence, statement, group, entry.manual === true),
        id: entryId(target, entry),
      });
    }
  }
  profile.dimensions = dimensions;
  profile.notes = Array.isArray(profile.notes) ? profile.notes.filter(isUsableNote) : [];
  return profile;
}

function isUsableEntry(entry) {
  return entry !== null && typeof entry === 'object' && typeof entry.text === 'string' && entry.text.trim() !== '';
}

function isUsableNote(note) {
  return note !== null && typeof note === 'object' && typeof note.text === 'string' && note.text.trim() !== '';
}

/** The dedup key of one entry, on its normalized text. */
function entryKey(entry) {
  return String(entry.text).trim();
}

/**
 * Build a deterministic key for deduplicating evidence rows.
 * @param row - evidence fields to key on.
 * @returns a stable short key.
 */
export function evidenceKey(row) {
  return [row.kind, row.dimension ?? '-', row.sessionId ?? '-', row.turn ?? '-', row.text]
    .join('\u0000')
    .slice(0, 400);
}

/**
 * A stable identifier for one entry's text.
 *
 * The panel used to address entries by their array position
 * (`dimension:index:firstSeenAt`). Background synthesis merges entries every few
 * turns, which shifts those positions, so a row the panel had rendered could no
 * longer be found by the id it was holding — the user saw
 * "没有找到 id 为 … 的条目" when retiring an entry. The text is what actually
 * identifies a conclusion, so the id is derived from it instead.
 *
 * @param text - the entry's text.
 * @returns a short, stable fingerprint.
 */
export function textFingerprint(text) {
  const value = String(text ?? '').trim();
  // FNV-1a: tiny, dependency-free, and stable across processes.
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(36).padStart(7, '0');
}

/**
 * The id the panel and the tools use to address one entry.
 * @param dimensionId - the owning dimension.
 * @param entry - the entry.
 * @returns a stable id.
 */
export function entryId(dimensionId, entry) {
  return `${dimensionId}:${textFingerprint(entry?.text)}`;
}


