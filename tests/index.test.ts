import { describe, expect, it } from 'bun:test'
import { hello } from '../src/index'

describe('hello', () => {
  it('returns greeting with default name', () => {
    expect(hello()).toBe('Hello, krpc!')
  })

  it('returns greeting with custom name', () => {
    expect(hello('Bun')).toBe('Hello, Bun!')
  })
})
