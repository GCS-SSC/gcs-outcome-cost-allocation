import { describe, expect, it } from 'vitest'
import { moneyFromMinorUnits } from '@gcs-ssc/extensions/money'
import {
  databaseAggregateMoneyValue,
  databaseMoneyValue,
  databaseScale4Value,
  parseDatabaseAggregateMoney,
  parseDatabaseMoney,
  parseDatabaseScale4
} from '../../server/numeric'

describe('Outcome allocation integer minor-unit persistence', () => {
  it.each(['JPY', 'USD', 'KWD', 'CLF', 'MGA'])('preserves minor units and owning currency for %s', currency => {
    const value = parseDatabaseMoney('12345', currency)
    expect(value).toEqual(moneyFromMinorUnits('12345', currency))
    const expression = databaseMoneyValue(value).toOperationNode()
    expect(JSON.stringify(expression)).toContain('12345')
    expect(JSON.stringify(expression)).not.toContain('19, 2')
  })

  it('rejects decimal storage values, number inputs and negative allocation money', () => {
    for (const value of ['0.1', '1.001', '1.0', '-1', 1, null]) {
      expect(() => parseDatabaseMoney(value, 'KWD')).toThrow()
    }
    expect(() => databaseMoneyValue(moneyFromMinorUnits('-1', 'USD'))).toThrow()
    expect(() => parseDatabaseMoney('100000000000000000000000000000000000000', 'JPY')).toThrow()
  })

  it('retains derived funding aggregates beyond the individual persisted-row envelope', () => {
    const amount = '100000000000000000000000000000000000000'
    const value = parseDatabaseAggregateMoney(amount, 'KWD')
    expect(value.amount).toBe(amount)
    expect(() => databaseAggregateMoneyValue(value)).not.toThrow()
    expect(() => databaseMoneyValue(value)).toThrow()
  })

  it('keeps exact four-place percentages separate from minor-unit amounts', () => {
    expect(parseDatabaseScale4('0.0001')).toBe('0.0001')
    expect(parseDatabaseScale4('25.0000')).toBe('25')
    expect(() => databaseScale4Value('100')).not.toThrow()
    for (const value of ['0.00001', '100.0001', '-1', 25, null]) {
      expect(() => parseDatabaseScale4(value)).toThrow()
    }
  })
})
