import { sql, type Expression, type RawBuilder } from 'kysely'

const NUMERIC_19_2_PATTERN = /^(?:0|[1-9]\d*)\.\d{2}$/
const NUMERIC_19_4_PATTERN = /^(?:0|[1-9]\d*)\.\d{4}$/

const assertNumeric = (value: string, pattern: RegExp, maximumIntegralDigits: number): void => {
  if (!pattern.test(value) || value.slice(0, value.indexOf('.')).length > maximumIntegralDigits) {
    throw new RangeError('Decimal value exceeds its PostgreSQL numeric range or scale.')
  }
}

/** Casts a PostgreSQL NUMERIC expression to text before the host driver can coerce it. */
export const databaseNumericText = (expression: Expression<unknown>): RawBuilder<string> =>
  sql<string>`CAST(${expression} AS text)`

/** Writes canonical nonnegative money through an explicit numeric(19,2) cast. */
export const databaseMoneyValue = (value: string): RawBuilder<string> => {
  assertNumeric(value, NUMERIC_19_2_PATTERN, 17)
  return sql<string>`CAST(${value} AS numeric(19, 2))`
}

/** Writes a canonical nonnegative allocation value through an explicit numeric(19,4) cast. */
export const databaseScale4Value = (value: string): RawBuilder<string> => {
  assertNumeric(value, NUMERIC_19_4_PATTERN, 15)
  return sql<string>`CAST(${value} AS numeric(19, 4))`
}

/** Validates text selected from a nonnegative numeric(19,2) money column. */
export const parseDatabaseMoney = (value: unknown): string => {
  if (typeof value !== 'string') throw new TypeError('Database money must be selected as text.')
  assertNumeric(value, NUMERIC_19_2_PATTERN, 17)
  return value
}

/** Validates an exact nonnegative scale-two aggregate without imposing a persisted-row range. */
export const parseDatabaseAggregateMoney = (value: unknown): string => {
  if (typeof value !== 'string' || !NUMERIC_19_2_PATTERN.test(value)) {
    throw new TypeError('Database money aggregate must be canonical scale-two text.')
  }
  return value
}

/** Writes an exact nonnegative scale-two aggregate to unconstrained NUMERIC. */
export const databaseAggregateMoneyValue = (value: string): RawBuilder<string> => {
  if (!NUMERIC_19_2_PATTERN.test(value)) throw new TypeError('Money aggregate must be canonical scale-two text.')
  return sql<string>`CAST(${value} AS numeric)`
}

/** Validates text selected from a nonnegative numeric(19,4) allocation column. */
export const parseDatabaseScale4 = (value: unknown): string => {
  if (typeof value !== 'string') throw new TypeError('Database allocation value must be selected as text.')
  assertNumeric(value, NUMERIC_19_4_PATTERN, 15)
  return value
}
