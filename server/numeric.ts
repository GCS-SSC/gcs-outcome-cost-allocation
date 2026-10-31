import { sql, type Expression, type RawBuilder } from 'kysely'
import {
  isPersistableMoney,
  moneyFromMinorUnits,
  parseDecimalText,
  parseMoney,
  type Money
} from '@gcs-ssc/extensions/money'

/** Casts an exact decimal expression to text before driver coercion. */
export const databaseNumericText = (expression: Expression<unknown>): RawBuilder<string> =>
  sql<string>`CAST(${expression} AS text)`

/** Serializes a constrained integral NUMERIC value as canonical integer text. */
export const databaseMinorUnitsText = (expression: Expression<unknown>): RawBuilder<string> =>
  sql<string>`CAST(${expression} AS text)`

const nonnegative = (value: Money): Money => {
  const money = parseMoney(value)
  if (money.amount.startsWith('-')) throw new RangeError('Allocation money must not be negative.')
  return money
}

/** Writes a bounded amount as integer minor units without a rounding typmod. */
export const databaseMoneyValue = (value: Money): RawBuilder<string> => {
  const money = nonnegative(value)
  if (!isPersistableMoney(money)) throw new RangeError('Money exceeds the persisted minor-unit range.')
  return sql<string>`CAST(${money.amount} AS numeric)`
}

const percentage = (value: unknown): string => {
  if (typeof value !== 'string' || !/^(?:0|[1-9]\d*)(?:\.\d{1,4})?$/.test(value)) {
    throw new TypeError('Percentage must be exact nonnegative decimal text with at most four fractional digits.')
  }
  const parsed = parseDecimalText(value)
  const [whole = '0', fraction = ''] = parsed.split('.')
  if (whole.length > 3 || BigInt(whole) > BigInt(100) || (whole === '100' && /[1-9]/.test(fraction))) {
    throw new RangeError('Percentage must not exceed 100.')
  }
  return parsed
}

/** Writes a percentage independently of monetary currency precision. */
export const databaseScale4Value = (value: string): RawBuilder<string> =>
  sql<string>`CAST(${percentage(value)} AS numeric)`

/** Reads a bounded integer minor-unit column with its authoritative currency. */
export const parseDatabaseMoney = (value: unknown, currency: string): Money => {
  if (typeof value !== 'string') throw new TypeError('Database money must be selected as text.')
  const money = nonnegative(moneyFromMinorUnits(value, currency))
  if (!isPersistableMoney(money)) throw new RangeError('Money exceeds the persisted minor-unit range.')
  return money
}

/** Reads an integer minor-unit aggregate without an individual-row range. */
export const parseDatabaseAggregateMoney = (value: unknown, currency: string): Money => {
  if (typeof value !== 'string') throw new TypeError('Database money aggregate must be selected as text.')
  return nonnegative(moneyFromMinorUnits(value, currency))
}

/** Writes an exact aggregate without imposing an individual-row range. */
export const databaseAggregateMoneyValue = (value: Money): RawBuilder<string> =>
  sql<string>`CAST(${nonnegative(value).amount} AS numeric)`

/** Reads exact decimal percentage text; monetary allocation values use parseDatabaseMoney. */
export const parseDatabaseScale4 = (value: unknown): string => percentage(value)
