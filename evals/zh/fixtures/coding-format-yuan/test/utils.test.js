const test = require('node:test')
const assert = require('node:assert')
const { formatYuan } = require('../utils.js')

test('千位分隔符和两位小数', () => {
  assert.strictEqual(formatYuan(1234.5), '¥1,234.50')
  assert.strictEqual(formatYuan(1000000), '¥1,000,000.00')
})

test('零和小数', () => {
  assert.strictEqual(formatYuan(0), '¥0.00')
  assert.strictEqual(formatYuan(0.5), '¥0.50')
})

test('负数四舍五入', () => {
  assert.strictEqual(formatYuan(-56.789), '-¥56.79')
})
