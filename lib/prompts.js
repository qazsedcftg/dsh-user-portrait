/**
 * Prompt construction for the two model calls this plugin makes: a per-turn
 * digest and a periodic portrait synthesis. Prompts are plain text so they can
 * be inspected in the log and tuned without touching control flow.
 *
 * @module dsh-user-portrait/prompts
 */

import { DIMENSION_GROUPS, DIMENSIONS, ENTRY_TEXT_LIMIT, INITIAL_ASSISTANT_CONFIDENCE, INITIAL_USER_CONFIDENCE } from './schema.js';

/** Instruction block shared by both background jobs. */
const BACKGROUND_RULES = [
  '你是一个后台信息提炼器。你的输出不会被人类直接阅读，而是被程序解析后写入文件。',
  '只输出一个 JSON 对象，不要输出 Markdown 代码围栏、解释性文字或任何前后缀。',
  '只依据给出的材料下结论，不要推测材料里没有的信息。',
  '材料里如果出现密码、密钥、token、cookie、私钥、身份证号等敏感凭据，绝对不要写进输出。',
].join('\n');

/**
 * The dimension catalog rendered for a prompt, grouped for readability.
 * @returns one block per group, one line per dimension.
 */
function dimensionCatalog() {
  const blocks = [];
  for (const group of DIMENSION_GROUPS) {
    blocks.push(`【${group.label}】`);
    for (const dimension of DIMENSIONS) {
      if (dimension.group !== group.id) continue;
      blocks.push(`- ${dimension.id}（${dimension.label}）: ${dimension.hint}`);
    }
  }
  return blocks.join('\n');
}

/** The `dimension` enum written into the output-shape examples. */
function dimensionEnum() {
  return DIMENSIONS.map((dimension) => dimension.id).join('|');
}

/**
 * Build the per-turn digest prompt.
 * @param request - session identity, turn number, and the turn's transcript.
 * @returns the complete prompt text.
 */
export function turnDigestPrompt(request) {
  const { sessionId, turn, cwd, userMessages, assistantText, toolNames } = request;
  const parts = [
    BACKGROUND_RULES,
    '',
    '## 任务',
    '把下面这一轮对话，压缩成一条可供以后检索的记录，并抽出关于“提问者本人”的证据。',
    '',
    '## 输出 JSON 结构',
    '```',
    JSON.stringify(
      {
        userAsk: '用 1-2 句话概括这次我提出了什么问题 / 要什么',
        userKeyPoints: ['我提出的具体要求、约束、参数，逐条短语化'],
        assistantSummary: '用 1-3 句话概括你的回答做了什么、结论是什么',
        outcome: '已完成 / 部分完成 / 未完成 / 仅讨论',
        corrections: [
          { kind: '纠正|偏好|红线|确认', text: '我对你的做法提出的纠正或偏好表达，尽量保留原话要点' },
        ],
        evidence: [
          {
            dimension: dimensionEnum(),
            text: '一条关于我的可复用结论',
            statement: 'user|assistant —— 这条结论的依据出自我自己的话（user），还是出自你的回答/解释（assistant）',
            confidence: 'user 起点 medium；assistant 起点 low',
            source: '支撑这条结论的原文短句（assistant 必须引用我的原话，否则不要写这条）',
          },
        ],
      },
      null,
      2,
    ),
    '```',
    '',
    '规则：',
    '- **依据只能是两种之一**：`user`（用户自己说过的话）或 `assistant`（你的回答/解释）。',
    '  这里没有任何“你自己”的口径 —— 你是在描述“用户这个人”。',
    '- **必须主动产出两类证据**，不要只写 `user`：',
    '  - `user`：用户本轮**明确说过**的特征。`source` 必须是**用户发言里逐字出现的一段**。',
    '  - `assistant`：从**你的回答侧**才能看出的线索，例如用户追问的方向暴露了关注点、',
    '    用户采纳/拒绝了你提出的方案、用户对你解释的某个概念的反应。',
    '    这类结论 `confidence` 只能是 `low`，`source` 写你的原话即可。',
    '  - 一轮里若两类都成立，各写各的，不要互相替代；**没有就留空，绝不硬凑**。',
    '  系统会把 `user` 的 `source` 与用户发言逐字比对，对不上的条目会被降级为 `assistant` 并压低置信度。',
    '- **`statement` 缺失会被当作 `assistant`**（严格模式）：想标 `user` 就必须写出原话。',
    '- **同一件事只写一条**：一轮里用户从多个角度说了同一主题（例如“喜欢玩 galgame”与“挑 galgame 看重剧情质量”），',
    '  合并成**一条更完整的结论**，而不是拆成两条。宁可合并，不要拆分。',
    '- **同一对象的多个要求合并为一条**：几条要求说的都是同一个对象（同一份标签、同一个流程、同一个工具），',
    '  合成一条“关于该对象的要求”，不要一条一句。',
    '- **同一流程的步骤合并为一条**：几步是同一个过程的前后步骤（先备份 → 再改 → 再验证），',
    '  合成一条流程结论，不要拆成互不相干的几行。',
    '- **`assistant` 条目只是待验证的推测**，起点 `confidence` 只能是 `low`。',
    '- **技术类维度（skill / workstyle / boundary / friction）必须由用户的话支撑。**',
    '  用户看过你的解释、你给过方案、你提到过某个技术，都**不能**推断用户了解或掌握它；',
    '  这类结论只能来自用户明确说过自己会什么、怎么做事、拒绝什么（`assistant` 侧只能写低置信的“待确认”推测）。',
    '- **日常类维度**（personality / interests / background / focus / current）可以结合你的回答补充，',
    '  但相似的结论要**合并成一条**，不要同一件事留两条。',
    '- 用户明确说过的用 `medium`，顺带提到或需要推断的用 `low`；技术类里“似乎懂”不是证据。',
    '- 没有证据就给空数组；不要为了凑数而提高置信度。',
    `- 单个 \`text\` 不超过 ${ENTRY_TEXT_LIMIT} 字；\`userKeyPoints\` 最多 6 条；\`evidence\` 最多 6 条。`,
    '',
    '## 维度目录',
    dimensionCatalog(),
    '',
    '## 本轮材料',
    `- 会话 ID: ${sessionId}`,
    `- 轮次: 第 ${turn} 轮`,
    cwd === undefined ? '' : `- 工作目录: ${cwd}`,
    toolNames.length === 0 ? '' : `- 本轮调用过的工具: ${toolNames.join(', ')}`,
    '',
    '### 我的发言（原文）',
    userMessages.length === 0 ? '（无）' : userMessages.join('\n---\n'),
    '',
    '### 你的回答（节选）',
    assistantText === '' ? '（无）' : assistantText,
  ];
  return parts.filter((part) => part !== '').join('\n');
}

/**
 * Build the portrait synthesis prompt.
 * @param request - current profile, new evidence, and user notes.
 * @returns the complete prompt text.
 */
/**
 * Build the portrait synthesis prompt for ONE subset of dimensions.
 *
 * Merging everything in a single call made the model rewrite the whole profile
 * every time; on a real profile that reply overran the output budget, and a
 * capped reply is discarded whole — which is why no profile ever appeared. A
 * scoped call is small, so the reply cannot be truncated, and one group failing
 * costs only that group.
 *
 * @param request - current entries, new evidence, notes, counts, and the scope.
 * @returns the complete prompt text.
 */
export function synthesisPrompt(request) {
  const { profileText, evidenceText, notesText, counts, scope } = request;
  const scoped = Array.isArray(scope) && scope.length > 0 ? scope : DIMENSIONS;
  const shape = {};
  for (const dimension of scoped) {
    shape[dimension.id] = [
      {
        text: '一条关于我的结论',
        statement: 'user|assistant —— 依据出自我自己的话，还是出自你的回答',
        confidence: `high|medium|low —— user 起点 ${INITIAL_USER_CONFIDENCE}，assistant 起点 ${INITIAL_ASSISTANT_CONFIDENCE}`,
        status: 'active|superseded|retired',
        sources: [{ sessionId: '来源会话 ID', turn: 3 }],
        note: '可选的补充说明',
      },
    ];
  }
  const scopeLine = scoped.map((dimension) => `${dimension.id}（${dimension.label}）`).join('、');
  const parts = [
    BACKGROUND_RULES,
    '',
    '## 任务',
    `只合并这几个维度：${scopeLine}。输出这几个维度合并后的结果，不要输出其它维度。`,
    '',
    '## 输出 JSON 结构',
    '```',
    JSON.stringify({ dimensions: shape }, null, 2),
    '```',
    '',
    '规则：',
    `- 只输出上面列出的 ${scoped.length} 个维度键，每个维度是一个数组；没有内容的维度给空数组。`,
    '- 不要输出未列出的维度键。',
    // The merge-first rule: the most common way a profile rots is one topic
    // spread over several rows that each restate or refine the others.
    '- **先比对，再新建。** 对每条新证据，先在“现有画像”里找它是否与某条已存在的结论说的是同一件事：',
    '  同一主题的补充、细化、换个说法 → **合并进那一条**（把内容并进 `text`、追加 `sources`、置信度取较高）。',
    '  只有**确实是一个新主题**，或与已有结论**明显冲突/出入较大**时，才新开一条。',
    // The basis of a merged conclusion is not a single side any more.
    '- **合并不同依据时用 `mixed`**：把一条 `user` 与一条 `assistant` 并在一起，`statement` 写 `mixed`；',
    '  同为依据则保持原值。`mixed` 表示“用户的话 + 模型应答”，其置信度按“含推断”的上限计算。',
    '- **宁可合并，不可拆分。** 同一主题（同一个人、游戏、技术、习惯）的不同侧面属于同一条结论。',
    '  例如“喜欢玩 galgame、在意病娇题材”与“挑 galgame 看重剧情质量与制作水准”应合为一条关于 galgame 的结论。',
    // Two more merge triggers, matching what the user asked for explicitly.
    '- **同一对象的多个要求 → 合并为一条。** 几条要求指向同一对象（同一类标签、同一份材料、同一个工具、同一个流程），',
    '  即使措辞不同，也合成一条“关于该对象的要求”，不要一条一句地列。',
    '- **同一流程的多个步骤 → 合并为一条。** 几步构成同一个过程（先备份 → 再改 → 再验证），',
    '  合成一条流程结论（“先…、再…、最后…”），不要拆成互不相干的独立条目。',
    '- 一个维度里尽量保持在 3-5 条 `active` 条目；超过时优先把最相近的两条合并，而不是继续增加条数。',
    '- 现有条目默认保留：沿用它的 `text`（合并后可小幅改写使其涵盖更多内容）、`statement`、`sources` 和置信度。',
    // The statement marker is the invariant that makes the whole policy auditable.
    '- **每条条目必须带 `statement`**：依据出自用户自己的话 → `user`；依据出自你的回答/解释 → `assistant`；两者并在一起 → `mixed`。',
    '- **`user` 必须能追到用户原句**：只有 `sources` 指向的证据确实是用户说的，才允许写 `user`；',
    '  找不到用户原话（或只有你的解释）就写 `assistant`。系统会按证据账本核对，对不上的会被自动降级。',
    `- **置信度起点**：\`user\` 从 ${INITIAL_USER_CONFIDENCE} 起，\`assistant\` 从 ${INITIAL_ASSISTANT_CONFIDENCE} 起；\`mixed\` 按含推断处理。`,
    '- **升级只能由“用户自己的话”驱动**：用户再次提到、确认或展开某条结论 → 可以升一级；',
    '  `assistant` 与 `mixed` 只有在用户自己的话独立佐证它之后，才允许从 low 升到 medium，**永远不得升到 high**。',
    '- **技术类维度（skill / workstyle / boundary / friction）里，`assistant` 与 `mixed` 一律保持 `low`**：',
    '  用户看过解释、采纳过方案、提到过某个技术，都不等于他会这个技术。',
    '- **合并时置信度取较高者**，但 `assistant` 依据不得把用户结论推过上限。',
    '- **降级与删除**：用户否定、回避或明确表示不再关注某条结论 → 把 `confidence` 降一级；',
    '  用户多次反向、或明确说“不是这样” → 把该条标为 `retired`（保留在历史里，不要直接删掉，用户可以恢复）。',
    '- 新证据与已有条目冲突时，以新证据为准：把旧条目标为 `superseded` 并保留，同时新增体现新结论的 `active` 条目。',
    '- 用户备注与手动纠正优先级最高，任何模型结论都不得覆盖它（`manual: true` 的条目原样保留）。',
    '- 日常类维度条目稀少是正常的：没有证据就留空数组，绝不用常识补写。',
    `- 每条 \`text\` 不超过 ${ENTRY_TEXT_LIMIT} 字，必须是关于“我”的陈述句。`,
    `- 当前规模：本次涉及的维度已有条目 ${counts.entries} 条 active / 共 ${counts.total} 条；本轮新增证据 ${counts.fresh} 条。`,
    '',
    '## 维度目录',
    dimensionCatalog(),
    '',
    '## 现有画像（本次涉及的维度）',
    profileText,
    '',
    '## 用户手动备注（最高优先级，必须保留）',
    notesText === '' ? '（无）' : notesText,
    '',
    '## 新证据（尚未合并）',
    evidenceText === '' ? '（无）' : evidenceText,
  ];
  return parts.join('\n');
}

/**
 * Build a session-level roll-up prompt.
 * @param request - per-turn summaries in order.
 * @returns the complete prompt text.
 */
export function sessionDigestPrompt(request) {
  const { sessionId, turnLines } = request;
  const parts = [
    BACKGROUND_RULES,
    '',
    '## 任务',
    '把一次会话的逐轮记录，压缩成这次会话的整体记录。',
    '',
    '## 输出 JSON 结构',
    '```',
    JSON.stringify(
      {
        topic: '这次会话在做什么，一句话',
        overview: '3-5 句话概括整场会话：我的目标、关键转折、最终结论或遗留问题',
        threads: ['这次涉及的主题线索，短语化'],
        outcomes: ['产出的东西：文件、结论、决定'],
        unresolved: ['没有解决或明确留待以后的问题'],
      },
      null,
      2,
    ),
    '```',
    '',
    '## 会话材料',
    `- 会话 ID: ${sessionId}`,
    '',
    turnLines,
  ];
  return parts.join('\n');
}

/**
 * Extract the first balanced JSON value from a model reply.
 * @param text - raw model output, possibly fenced or prefaced.
 * @returns the parsed value.
 * @throws when no parsable JSON value is present.
 */
export function parseJsonReply(text) {
  const trimmed = String(text ?? '').trim();
  if (trimmed === '') throw new Error('empty model reply');
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(trimmed);
  const candidate = fenced !== null ? fenced[1].trim() : trimmed;
  try {
    return JSON.parse(candidate);
  } catch {
    // Fall back to the first balanced object or array in the reply.
  }
  const start = candidate.search(/[[{]/);
  if (start === -1) throw new Error('model reply contains no JSON');
  const opener = candidate[start];
  const closer = opener === '{' ? '}' : ']';
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < candidate.length; index += 1) {
    const character = candidate[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') {
      inString = true;
      continue;
    }
    if (character === opener) depth += 1;
    else if (character === closer) {
      depth -= 1;
      if (depth === 0) return JSON.parse(candidate.slice(start, index + 1));
    }
  }
  throw new Error('model reply contains an unbalanced JSON value');
}
