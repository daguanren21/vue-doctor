import type { StaticValue } from './types.js'

interface Expression {
  type?: string
  value?: unknown
  operator?: string
  argument?: unknown
  expression?: unknown
  elements?: unknown[]
  properties?: Array<{
    type?: string
    kind?: string
    computed?: boolean
    method?: boolean
    key?: { type?: string; name?: string; value?: unknown }
    value?: unknown
  }>
}

/** Read literal syntax only. Never execute project expressions or resolve identifiers. */
export function resolveStaticValue(node: unknown, depth = 0): StaticValue | undefined {
  if (!node || typeof node !== 'object' || depth > 64) return undefined
  const expression = node as Expression
  if (expression.type === 'Literal') {
    const value = expression.value
    if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
    return typeof value === 'number' && Number.isFinite(value) ? value : undefined
  }
  if (expression.type === 'UnaryExpression' && ['+', '-'].includes(expression.operator ?? '')) {
    const value = resolveStaticValue(expression.argument, depth + 1)
    return typeof value === 'number' ? (expression.operator === '-' ? -value : value) : undefined
  }
  if (['TSAsExpression', 'TSSatisfiesExpression', 'TSNonNullExpression'].includes(expression.type ?? '')) {
    return resolveStaticValue(expression.expression, depth + 1)
  }
  if (expression.type === 'ArrayExpression') {
    const values: StaticValue[] = []
    for (const element of expression.elements ?? []) {
      const value = resolveStaticValue(element, depth + 1)
      if (value === undefined) return undefined
      values.push(value)
    }
    return values
  }
  if (expression.type === 'ObjectExpression') {
    const values: Record<string, StaticValue> = Object.create(null)
    for (const property of expression.properties ?? []) {
      if (property.type !== 'Property' || property.kind !== 'init' || property.computed || property.method) return undefined
      const key = property.key?.type === 'Identifier' ? property.key.name : property.key?.value
      if (typeof key !== 'string' && typeof key !== 'number') return undefined
      // Object literal __proto__ changes the prototype rather than defining a normal property.
      if (key === '__proto__') return undefined
      const value = resolveStaticValue(property.value, depth + 1)
      if (value === undefined) return undefined
      values[key] = value
    }
    return values
  }
  return undefined
}
