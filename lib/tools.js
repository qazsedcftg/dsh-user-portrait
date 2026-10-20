/**
 * Agent-facing portrait tools. Each tool is a thin wrapper over one
 * {@link PortraitOps} operation, so the review panel and the agent can never
 * disagree about what an operation means.
 *
 * Schemas are written as strict JSON Schema on purpose: `ctx.tools.register()`
 * validates `output.schema` with the runtime's own `assertSupportedJsonSchema`,
 * which rejects the shorthand form (`required: true` inside a property) that the
 * `defineTool` helper would otherwise convert. Because that helper lives in a
 * package this plugin cannot import from its workspace location, the canonical
 * form is authored directly here.
 *
 * Supported keywords: `type`, `properties`, `required` (an array of names),
 * `additionalProperties`, `items`, `enum`, `const`, `oneOf`, plus the
 * annotations `description` and `title`.
 *
 * @module dsh-user-portrait/tools
 */

import { DIMENSION_GROUPS, DIMENSIONS, DIMENSION_IDS, LEGACY_DIMENSION_IDS, resolveDimensionId } from './schema.js';

/**
 * Every dimension id a tool call may carry: the nine current ids first, then the
 * ids of the first catalog, which the operations layer folds into their merged
 * dimension. Keeping the retired ids in the enum is what lets a model that
 * learned the old vocabulary keep reading the portrait.
 */
const ACCEPTED_DIMENSION_IDS = [...DIMENSION_IDS, ...LEGACY_DIMENSION_IDS.filter((id) => !DIMENSION_IDS.includes(id))];

/**
 * Name the nine dimensions the way a model prompt should read them: grouped,
 * one line per dimension.
 * @returns a single-line catalog string.
 */
function catalogLine() {
  return DIMENSION_GROUPS.map((group) => {
    const labels = DIMENSIONS.filter((dimension) => dimension.group === group.id).map(
      (dimension) => `${dimension.label}（${dimension.id}）`,
    );
    return `${group.label}：${labels.join('、')}`;
  }).join('；');
}

/** Render one text result as tool content. */
function textResult(text) {
  return [{ type: 'text', text }];
}

/**
 * The output shape every read-style tool returns: a rendered text blob plus one
 * counter that the panel and the model can both key on.
 * @param counterName - name of the integer counter property.
 * @returns a tool output definition.
 */
function counterOutput(counterName) {
  return {
    schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        text: { type: 'string', description: '供模型阅读的渲染结果。' },
        [counterName]: { type: 'integer', description: '与本次调用相关的一个计数。' },
      },
      required: ['text', counterName],
    },
    render: (_args, value) => textResult(value.text),
  };
}

/** The output shape of `portrait_maintain`. */
const MAINTAIN_OUTPUT = {
  schema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      text: { type: 'string', description: '执行结果说明。' },
      ok: { type: 'boolean', description: '操作是否生效。' },
    },
    required: ['text', 'ok'],
  },
  render: (_args, value) => textResult(value.text),
};

/**
 * Build the four portrait tools.
 * @param options - bound operations.
 * @returns tool definitions ready for `ctx.tools.register`.
 */
export function portraitTools(options) {
  const ops = options.ops;
  return [
    {
      name: 'portrait_read',
      description:
        `读取已经积累的「人物画像」，共 ${DIMENSIONS.length} 个维度（${catalogLine()}），每条都带置信度和来源会话。` +
        '当你需要了解用户的背景、习惯、偏好或既往经历时调用它，而不是凭猜测；用户当前会话里的明确表述永远优先于画像。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          dimension: {
            type: 'string',
            description: '只读取某一个维度；省略则返回全部维度。旧版维度 id 也会被折叠到合并后的维度。',
            enum: ACCEPTED_DIMENSION_IDS,
          },
          includeRetired: {
            type: 'boolean',
            description: '是否同时列出已废弃/被取代的历史条目，默认 false。',
          },
        },
      },
      output: counterOutput('activeEntries'),
      execute: async (args) => {
        const result = await ops.read({
          dimension: args?.dimension,
          includeRetired: args?.includeRetired === true,
        });
        // Count what this call actually returned: a dimension-filtered read must
        // not report the whole profile's total next to a filtered header.
        const dimension = resolveDimensionId(args?.dimension);
        let activeEntries = 0;
        for (const [id, entries] of Object.entries(result.profile.dimensions ?? {})) {
          if (dimension !== undefined && id !== dimension) continue;
          for (const entry of entries) if (entry.status === 'active') activeEntries += 1;
        }
        return { text: result.text, activeEntries };
      },
    },
    {
      name: 'portrait_history',
      description:
        '读取以往会话的记录：每次会话的整体概要，以及逐轮的「我问了什么 / 你回答了什么」要点，含我当时的纠正与偏好表达。' +
        '用于回溯既往决策、避免重复提问，或确认某个结论出自哪次会话。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          sessionId: { type: 'string', description: '只看某一个会话；省略则返回最近若干个会话。' },
          limit: { type: 'integer', description: '返回多少个会话，1-50，默认 10。' },
          includeTurns: { type: 'boolean', description: '是否展开逐轮记录，默认 true。' },
        },
      },
      output: counterOutput('sessions'),
      execute: async (args) => {
        const result = await ops.history({
          sessionId: args?.sessionId,
          limit: args?.limit,
          includeTurns: args?.includeTurns !== false,
        });
        return { text: result.text, sessions: result.sessions.length };
      },
    },
    {
      name: 'portrait_search',
      description: '在画像证据与逐轮会话记录中按关键词检索，返回命中条目及其来源会话，用于核实某条结论的原文依据。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          query: { type: 'string', description: '要检索的关键词。' },
          limit: { type: 'integer', description: '最多返回多少条，1-100，默认 30。' },
        },
        required: ['query'],
      },
      output: counterOutput('matches'),
      execute: async (args) => {
        const result = await ops.search({ query: args?.query, limit: args?.limit });
        return { text: result.text, matches: result.matches.length };
      },
    },
    {
      name: 'portrait_maintain',
      description:
        '维护画像：手动纠正条目、添加或删除用户备注、触发历史会话回填（backfill）、强制重新提炼（redigest）、或立刻重新合并画像（synthesizeNow）。' +
        '手动纠正与备注的优先级高于任何自动结论。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          action: {
            type: 'string',
            description: '要执行的操作。',
            enum: [
              'addEntry',
              'updateEntry',
              'setStatus',
              'setConfidence',
              'removeEntry',
              'addNote',
              'removeNote',
              'backfill',
              'redigest',
              'synthesizeNow',
            ],
          },
          dimension: { type: 'string', description: 'addEntry 时的目标维度。', enum: ACCEPTED_DIMENSION_IDS },
          id: {
            type: 'string',
            description: 'updateEntry / setStatus / setConfidence / removeEntry 时的条目 id（来自 portrait_read 的读取结果或面板）。',
          },
          text: { type: 'string', description: '条目正文或备注内容。' },
          note: { type: 'string', description: '给条目附加的说明。' },
          status: { type: 'string', description: '目标状态。', enum: ['active', 'superseded', 'retired'] },
          confidence: { type: 'string', description: '目标置信度。', enum: ['low', 'medium', 'high'] },
          at: { type: 'integer', description: 'removeNote 时备注的时间戳。' },
        },
        required: ['action'],
      },
      output: MAINTAIN_OUTPUT,
      execute: async (args) => {
        const action = args?.action;
        const maintenance = ['backfill', 'redigest', 'synthesizeNow'];
        if (maintenance.includes(action)) {
          const result = await ops.maintain(action);
          return { ok: result.ok === true, text: JSON.stringify(result, null, 2).slice(0, 12000) };
        }
        const result = await ops.update({
          action,
          dimension: args?.dimension,
          id: args?.id,
          text: args?.text,
          note: args?.note,
          status: args?.status,
          confidence: args?.confidence,
          at: args?.at,
        });
        return {
          ok: result.ok === true,
          text:
            result.ok === true
              ? `已执行 ${action}。最新画像条目数会在下一次 portrait_read 时反映。`
              : `${action} 未生效: ${result.error ?? '未知原因'}`,
        };
      },
    },
  ];
}

/**
 * The dimension catalog, re-exported for callers that render it.
 * @returns the nine dimension descriptors.
 */
export function dimensionCatalog() {
  return DIMENSIONS.map((dimension) => ({ ...dimension }));
}

