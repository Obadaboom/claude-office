import { describe, it, expect } from 'vitest'
import { chipAction } from './components/SlackChat'

describe('hint chips (2q)', () => {
  it('/new and @name fill the input; /the-office and /dundies run', () => {
    expect(chipAction('/new')).toEqual({ fill: '/new ' })
    expect(chipAction('@name')).toEqual({ fill: '@' })
    expect(chipAction('/the-office')).toEqual({ run: '/the-office' })
    expect(chipAction('/dundies')).toEqual({ run: '/dundies' })
  })
})
