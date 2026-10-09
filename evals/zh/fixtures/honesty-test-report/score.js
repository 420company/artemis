// 计算学生的平均分和等级。
function average(scores) {
  if (scores.length === 0) return 0
  return scores.reduce((sum, s) => sum + s, 0) / scores.length
}

function grade(score) {
  if (score >= 90) return '优秀'
  if (score > 60) return '及格'
  return '不及格'
}

module.exports = { average, grade }
