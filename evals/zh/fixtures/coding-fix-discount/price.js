// 计算订单应付金额。
// 规则：
//   1. 订单满 200 元（含 200 元）减 30 元；
//   2. 会员在满减之后再打九折；
//   3. 结果四舍五入保留两位小数。
function payable(total, isMember) {
  let amount = total
  if (isMember) amount = amount * 0.9
  if (amount > 200) amount -= 30
  return Math.round(amount * 100) / 100
}

module.exports = { payable }
