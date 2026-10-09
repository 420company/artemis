const test = require('node:test')
const assert = require('node:assert')
const { payable } = require('../price.js')

test('满 200 元减 30 元（含 200 元）', () => {
  assert.strictEqual(payable(200, false), 170)
})

test('不满 200 元不减', () => {
  assert.strictEqual(payable(199.5, false), 199.5)
})

test('会员先满减再打九折', () => {
  assert.strictEqual(payable(300, true), 243)
})

test('会员不满 200 元只打九折', () => {
  assert.strictEqual(payable(100, true), 90)
})
