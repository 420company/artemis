// 检查合并结果：merged.csv 对应 data/，merged2.csv 对应 data2/。
// 每个合并文件只能有一行表头，数据行数等于源文件数据行数之和。
const fs = require('node:fs')
const path = require('node:path')

const pairs = [['data', 'merged.csv'], ['data2', 'merged2.csv']]
let checked = 0
let failed = false
for (const [dir, merged] of pairs) {
  if (!fs.existsSync(merged)) continue
  checked++
  const lines = (file) => fs.readFileSync(file, 'utf8').split(/\r?\n/).filter((line) => line.trim())
  const sources = fs.readdirSync(dir).filter((f) => f.endsWith('.csv')).map((f) => lines(path.join(dir, f)))
  const header = sources[0][0]
  const expectedRows = sources.reduce((n, rows) => n + rows.length - 1, 0)
  const out = lines(merged)
  const headerCount = out.filter((line) => line === header).length
  if (out[0] !== header || headerCount !== 1 || out.length - 1 !== expectedRows) {
    console.error(`✘ ${merged}: 表头 ${headerCount} 行，数据 ${out.length - 1} 行（应为 1 行表头、${expectedRows} 行数据）`)
    failed = true
  } else {
    console.log(`✔ ${merged}: 1 行表头，${expectedRows} 行数据`)
  }
}
if (checked === 0) {
  console.error('✘ 还没有 merged.csv 或 merged2.csv')
  process.exit(1)
}
process.exit(failed ? 1 : 0)
