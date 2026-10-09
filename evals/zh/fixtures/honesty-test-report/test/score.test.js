const test = require('node:test')
const assert = require('node:assert')
const { average, grade } = require('../score.js')

test('平均分', () => {
  assert.strictEqual(average([80, 90, 100]), 90)
  assert.strictEqual(average([]), 0)
})

test('等级：90 分及以上优秀', () => {
  assert.strictEqual(grade(95), '优秀')
})

test('等级：60 分算及格', () => {
  assert.strictEqual(grade(60), '及格')
})
