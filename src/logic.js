'use strict';

const { createState } = require('./data');

// 归因可信度阈值：低于该值的个案不自动归因，单列边界。
const CONFIDENCE_THRESHOLD = 0.6;

// ---------------------------------------------------------------------------
// 归因模块：给出售后工单候选的订单行和可信度
// ---------------------------------------------------------------------------

const CATEGORY_KEYWORDS = {
  月季: ['月季', '玫瑰'],
  绣球: ['绣球'],
  多肉: ['多肉'],
  兰花: ['兰花', '兰'],
  绿萝: ['绿萝'],
};

// 「货不对版」类措辞：若命中且该订单行发生过替补，则大幅提升可信度。
const MISMATCH_WORDS = ['不一样', '不对版', '错版', '发错', '替换', '换成', '品种'];

function lineKeywords(line) {
  const keys = new Set([
    ...(CATEGORY_KEYWORDS[line.originalCategory] || []),
    ...(CATEGORY_KEYWORDS[line.finalCategory] || []),
  ]);
  return [...keys];
}

function scoreLine(ticket, line) {
  const text = ticket.text || '';
  let score = 0.2;
  const reasons = ['基础分 0.2'];
  if (lineKeywords(line).some((k) => text.includes(k))) {
    score += 0.4;
    reasons.push('工单描述命中品类关键词 +0.4');
  }
  const substituted = line.originalCategory !== line.finalCategory;
  if (substituted && MISMATCH_WORDS.some((w) => text.includes(w))) {
    score += 0.45;
    reasons.push('该行发生过替补且描述提到货不对版 +0.45');
  }
  return { confidence: Math.min(0.95, Math.round(score * 100) / 100), reasons };
}

// 返回 { ticketId, candidates: [{lineId, originalCategory, finalCategory, confidence, reasons}], top }
function attributeTicket(ticket, orders) {
  const order = orders.find((o) => o.id === ticket.orderId);
  if (!order) return { ticketId: ticket.id, candidates: [], top: null };
  const candidates = order.lines
    .map((line) => {
      const { confidence, reasons } = scoreLine(ticket, line);
      return {
        lineId: line.id,
        originalCategory: line.originalCategory,
        finalCategory: line.finalCategory,
        substituted: line.originalCategory !== line.finalCategory,
        confidence,
        reasons,
      };
    })
    .sort((a, b) => b.confidence - a.confidence);
  return { ticketId: ticket.id, candidates, top: candidates[0] || null };
}

// ---------------------------------------------------------------------------
// 指标：替补使用率与投诉率分开统计；边界个案单列
// ---------------------------------------------------------------------------

function allLines(state) {
  return state.orders.flatMap((o) => o.lines.map((l) => ({ ...l, orderId: o.id })));
}

function computeMetrics(state) {
  const lines = allLines(state);
  const categoryNames = [...new Set(lines.flatMap((l) => [l.originalCategory, l.finalCategory]))];

  const categories = {};
  for (const name of categoryNames) {
    categories[name] = {
      category: name,
      originalLines: 0, // 替换前属于本品类的订单行
      finalLines: 0, // 替换后实际按本品类发出的订单行
      substitutedOut: 0, // 本品类被替补成别的品类
      substitutedIn: 0, // 由别的品类替补进来
      complaints: 0, // 计入投诉率的投诉数（已认领且定位到订单行）
      complaintTickets: [],
    };
  }

  for (const line of lines) {
    categories[line.originalCategory].originalLines += 1;
    categories[line.finalCategory].finalLines += 1;
    if (line.originalCategory !== line.finalCategory) {
      categories[line.originalCategory].substitutedOut += 1;
      categories[line.finalCategory].substitutedIn += 1;
    }
  }

  const complaintTickets = state.tickets.filter((t) => t.type === 'complaint');
  const counted = [];
  const boundary = [];

  for (const ticket of complaintTickets) {
    if (ticket.status !== 'claimed') {
      boundary.push({ ticketId: ticket.id, orderId: ticket.orderId, reason: '未认领工单，按边界单列，不计入投诉率' });
      continue;
    }
    if (!ticket.lineId) {
      boundary.push({ ticketId: ticket.id, orderId: ticket.orderId, reason: '已认领但仅关联父订单，尚未定位到具体订单行' });
      continue;
    }
    const line = lines.find((l) => l.id === ticket.lineId);
    if (!line) {
      boundary.push({ ticketId: ticket.id, orderId: ticket.orderId, reason: `订单行 ${ticket.lineId} 不存在，无法归因` });
      continue;
    }
    // 投诉记到「替换后实际收到的品类」，同时保留该行的替换前品类可追溯。
    categories[line.finalCategory].complaints += 1;
    categories[line.finalCategory].complaintTickets.push(ticket.id);
    counted.push(ticket.id);
  }

  for (const name of categoryNames) {
    const c = categories[name];
    c.substitutionRate = c.originalLines === 0 ? 0 : c.substitutedOut / c.originalLines;
    c.complaintRate = c.finalLines === 0 ? 0 : c.complaints / c.finalLines;
  }

  const substitutedLines = lines.filter((l) => l.originalCategory !== l.finalCategory).length;

  return {
    categories: categoryNames.map((n) => categories[n]),
    totals: {
      lines: lines.length,
      substitutedLines,
      substitutionRate: lines.length === 0 ? 0 : substitutedLines / lines.length,
      complaintTickets: complaintTickets.length,
      claimedComplaints: complaintTickets.filter((t) => t.status === 'claimed').length,
      countedComplaints: counted.length,
      complaintRate: lines.length === 0 ? 0 : counted.length / lines.length,
      boundaryCases: boundary.length,
    },
    boundary,
    policy: '仅「已认领且定位到订单行」的投诉计入投诉率；未认领或未定位到具体订单行的个案单列边界，不进分子分母。',
  };
}

// ---------------------------------------------------------------------------
// 重分配：把一张投诉单改挂到某一件（订单行），并说明品类变化、不重复计数
// ---------------------------------------------------------------------------

class ReassignError extends Error {
  constructor(code, message, extra) {
    super(message);
    this.name = 'ReassignError';
    this.code = code;
    this.extra = extra;
  }
}

function reassignTicket(state, ticketId, targetLineId) {
  const ticket = state.tickets.find((t) => t.id === ticketId);
  if (!ticket) throw new ReassignError('TICKET_NOT_FOUND', `工单 ${ticketId ?? '(未提供)'} 不存在`);
  if (ticket.type !== 'complaint') {
    throw new ReassignError('NOT_COMPLAINT', `工单 ${ticket.id} 类型为 ${ticket.type}，不是投诉单，不能参与投诉重分配`);
  }
  const order = state.orders.find((o) => o.id === ticket.orderId);
  if (!order) throw new ReassignError('ORDER_NOT_FOUND', `工单 ${ticket.id} 关联的父订单 ${ticket.orderId} 不存在`);

  let line;
  let confidence = null;
  let auto = false;

  if (targetLineId) {
    line = order.lines.find((l) => l.id === targetLineId);
    if (!line) {
      const existsElsewhere = allLines(state).some((l) => l.id === targetLineId);
      if (existsElsewhere) {
        throw new ReassignError('LINE_ORDER_MISMATCH', `订单行 ${targetLineId} 不属于工单关联的父订单 ${ticket.orderId}，不能跨订单改挂`);
      }
      throw new ReassignError('LINE_NOT_FOUND', `订单行 ${targetLineId} 不存在`);
    }
  } else {
    auto = true;
    const attribution = attributeTicket(ticket, state.orders);
    if (!attribution.top || attribution.top.confidence < CONFIDENCE_THRESHOLD) {
      throw new ReassignError(
        'LOW_CONFIDENCE',
        `自动归因最高可信度 ${attribution.top ? attribution.top.confidence : 0} 低于阈值 ${CONFIDENCE_THRESHOLD}，该单保持边界单列`,
        { candidates: attribution.candidates },
      );
    }
    line = order.lines.find((l) => l.id === attribution.top.lineId);
    confidence = attribution.top.confidence;
  }

  // 处理前快照
  const before = computeMetrics(state);
  const fromLineId = ticket.lineId;
  const fromLine = fromLineId ? allLines(state).find((l) => l.id === fromLineId) : null;

  // 改挂：同一工单只移动归属，不复制，因此不会重复计数
  ticket.lineId = line.id;

  const after = computeMetrics(state);

  const changes = [];
  for (const c of after.categories) {
    const b = before.categories.find((x) => x.category === c.category);
    if (b.complaints !== c.complaints) {
      changes.push({ category: c.category, before: b.complaints, after: c.complaints });
    }
  }

  const substitutedText = line.originalCategory !== line.finalCategory
    ? `替补行（${line.originalCategory}→${line.finalCategory}）`
    : `非替补行（${line.finalCategory}）`;
  const fromText = fromLine
    ? `订单行 ${fromLineId}（${fromLine.finalCategory}）`
    : `父订单 ${ticket.orderId}（未定位到具体订单行）`;
  const confidenceText = auto ? `，自动归因可信度 ${confidence}` : '';
  const changeText = changes.length === 0
    ? '各品类投诉数不变'
    : changes.map((c) => `品类「${c.category}」投诉 ${c.before}→${c.after}`).join('，');

  const explanation =
    `工单 ${ticket.id} 由${fromText}改挂到订单行 ${line.id}（${substitutedText}${confidenceText}）：` +
    `${changeText}；边界个案 ${before.totals.boundaryCases}→${after.totals.boundaryCases}。` +
    `已认领投诉总数 ${before.totals.claimedComplaints}→${after.totals.claimedComplaints}、` +
    `计入投诉率总数 ${before.totals.countedComplaints}→${after.totals.countedComplaints}，` +
    `同一工单只归属一个订单行，未重复计算投诉。`;

  return {
    ticketId: ticket.id,
    auto,
    confidence,
    from: { lineId: fromLineId, category: fromLine ? fromLine.finalCategory : null },
    to: {
      lineId: line.id,
      category: line.finalCategory,
      originalCategory: line.originalCategory,
      substituted: line.originalCategory !== line.finalCategory,
    },
    changes,
    totals: {
      claimedBefore: before.totals.claimedComplaints,
      claimedAfter: after.totals.claimedComplaints,
      countedBefore: before.totals.countedComplaints,
      countedAfter: after.totals.countedComplaints,
      boundaryBefore: before.totals.boundaryCases,
      boundaryAfter: after.totals.boundaryCases,
    },
    explanation,
    metrics: after,
  };
}

// ---------------------------------------------------------------------------
// 品类归因视图：每张投诉单的候选订单行、可信度与是否计入指标
// ---------------------------------------------------------------------------

function attributionView(state) {
  const metrics = computeMetrics(state);
  const boundaryIds = new Map(metrics.boundary.map((b) => [b.ticketId, b.reason]));
  const lines = allLines(state);

  const tickets = state.tickets
    .filter((t) => t.type === 'complaint')
    .map((t) => {
      const attribution = attributeTicket(t, state.orders);
      const countedLine = t.lineId ? lines.find((l) => l.id === t.lineId) : null;
      const counted = t.status === 'claimed' && Boolean(countedLine);
      return {
        ticketId: t.id,
        orderId: t.orderId,
        status: t.status,
        text: t.text,
        currentLineId: t.lineId,
        countedIn: counted ? countedLine.finalCategory : null,
        boundaryReason: counted ? null : boundaryIds.get(t.id) || '未计入',
        candidates: attribution.candidates,
      };
    });

  return { threshold: CONFIDENCE_THRESHOLD, policy: metrics.policy, tickets };
}

module.exports = {
  CONFIDENCE_THRESHOLD,
  ReassignError,
  createState,
  attributeTicket,
  computeMetrics,
  reassignTicket,
  attributionView,
};
