'use strict';

// 虚构数据：植株电商的订单与售后工单。
// 订单行同时保留「替换前品类 originalCategory」和「替换后品类 finalCategory」，
// 两者不同即发生了替补（缺货换成别的品类）。

const ORDERS = [
  {
    id: 'O1001',
    lines: [
      { id: 'O1001-L1', originalCategory: '月季', finalCategory: '月季', qty: 2 },
      { id: 'O1001-L2', originalCategory: '绣球', finalCategory: '月季', qty: 1 }, // 绣球缺货，替补为月季
    ],
  },
  {
    id: 'O1002',
    lines: [
      { id: 'O1002-L1', originalCategory: '多肉', finalCategory: '多肉', qty: 3 },
      { id: 'O1002-L2', originalCategory: '兰花', finalCategory: '绿萝', qty: 1 }, // 兰花缺货，替补为绿萝
    ],
  },
  {
    id: 'O1003',
    lines: [
      { id: 'O1003-L1', originalCategory: '月季', finalCategory: '月季', qty: 1 },
      { id: 'O1003-L2', originalCategory: '绿萝', finalCategory: '绿萝', qty: 2 },
    ],
  },
];

// 工单：投诉单可能先挂在父订单（lineId 为 null），之后再改到某一件（具体订单行）。
// status: claimed=已认领 / unclaimed=未认领。指标只统计已认领工单，其余单列边界。
const TICKETS = [
  {
    id: 'T9001',
    type: 'complaint',
    orderId: 'O1001',
    lineId: null, // 先关联父订单，等待归因到某件
    status: 'claimed',
    text: '收到的苗和拍下的品种不一样，要求售后处理',
  },
  {
    id: 'T9002',
    type: 'complaint',
    orderId: 'O1002',
    lineId: 'O1002-L1', // 已定位到具体订单行
    status: 'claimed',
    text: '多肉到货时已经化水，要求退款',
  },
  {
    id: 'T9003',
    type: 'complaint',
    orderId: 'O1003',
    lineId: null,
    status: 'unclaimed', // 未认领：按边界单列，不计入投诉率
    text: '好像少发了一棵，不确定是哪一盆',
  },
  {
    id: 'T9004',
    type: 'consult', // 非投诉单，不参与投诉指标
    orderId: 'O1001',
    lineId: null,
    status: 'claimed',
    text: '请问月季花后怎么修剪',
  },
];

// 每次调用返回一份全新的深拷贝，保证演示/测试可以重置。
function createState() {
  return structuredClone({ orders: ORDERS, tickets: TICKETS });
}

module.exports = { createState };
