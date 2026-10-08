import { describe, expect, test } from 'vitest'
import { parseVueSource } from './sfc.js'
import {
  collectScriptBindingFacts,
  isUnboundIdentifier,
  resolveImportedBinding,
  resolveLexicalBinding
} from './bindings.js'

type Node = {
  type?: string
  name?: string
  range?: [number, number]
  [key: string]: unknown
}

describe('script binding facts', () => {
  test('resolves named aliases and namespace imports', () => {
    const program = parseProgram(`
import { ref as vueRef } from 'vue'
import * as Vue from 'vue'
vueRef(0)
Vue.watch(() => {})
`)
    const facts = collectScriptBindingFacts(program)
    const vueRef = findIdentifier(program, 'vueRef', 1)
    const namespace = findIdentifier(program, 'Vue', 1)

    expect(resolveImportedBinding(facts, vueRef)).toMatchObject({
      source: 'vue',
      imported: 'ref'
    })
    expect(resolveImportedBinding(facts, namespace)).toMatchObject({
      source: 'vue',
      imported: '*'
    })
    expect(JSON.parse(JSON.stringify(facts))).toEqual(facts)
  })

  test('uses parameters and block locals to shadow module imports', () => {
    const program = parseProgram(`
import { ref } from 'vue'
ref(0)
function example(ref) { ref(1) }
if (true) { const ref = localFactory; ref(2) }
ref(3)
`)
    const facts = collectScriptBindingFacts(program)
    const references = findIdentifiers(program, 'ref')

    expect(resolveImportedBinding(facts, references[2])).toMatchObject({ imported: 'ref' })
    expect(resolveLexicalBinding(facts, references[4])).toMatchObject({ kind: 'parameter' })
    expect(resolveImportedBinding(facts, references[4])).toBeUndefined()
    expect(resolveLexicalBinding(facts, references[6])).toMatchObject({ kind: 'variable' })
    expect(resolveImportedBinding(facts, references[6])).toBeUndefined()
    expect(resolveImportedBinding(facts, references[7])).toMatchObject({ imported: 'ref' })
  })

  test('distinguishes unbound identifiers from other-library imports and locals', () => {
    const program = parseProgram(`
import { ref } from 'other-library'
ref()
defineProps()
function nested(defineProps) { defineProps() }
`)
    const facts = collectScriptBindingFacts(program)
    const ref = findIdentifier(program, 'ref', 1)
    const macros = findIdentifiers(program, 'defineProps')

    expect(resolveImportedBinding(facts, ref)).toMatchObject({ source: 'other-library' })
    expect(isUnboundIdentifier(facts, macros[0])).toBe(true)
    expect(isUnboundIdentifier(facts, macros[2])).toBe(false)
  })

  test('creates inner class bindings for heritage, bodies, and static blocks', () => {
    const program = parseProgram(`
class Decl extends Decl {
  method() { return Decl }
  static { Decl }
}
const Expr = class Inner extends Inner {
  method() { return Inner }
  static { Inner }
}
Decl
typeof Inner
`)
    const facts = collectScriptBindingFacts(program)
    const declarations = findIdentifiers(program, 'Decl')
    const expressions = findIdentifiers(program, 'Inner')
    const innerDeclaration = resolveLexicalBinding(facts, declarations[0])
    const outerDeclaration = resolveLexicalBinding(facts, declarations[4])
    const innerExpression = resolveLexicalBinding(facts, expressions[0])

    expect(innerDeclaration).toMatchObject({ kind: 'class', name: 'Decl' })
    expect(declarations.slice(1, 4).map((node) => resolveLexicalBinding(facts, node)))
      .toEqual([innerDeclaration, innerDeclaration, innerDeclaration])
    expect(outerDeclaration).toMatchObject({ kind: 'class', name: 'Decl' })
    expect(outerDeclaration).not.toBe(innerDeclaration)
    expect(expressions.slice(1, 4).map((node) => resolveLexicalBinding(facts, node)))
      .toEqual([innerExpression, innerExpression, innerExpression])
    expect(resolveLexicalBinding(facts, expressions[4])).toBeUndefined()
  })

  test('registers TypeScript enum and namespace value bindings', () => {
    const program = parseProgram(`
function enumScope() {
  enum value { A }
  return value + 1
}
function enumMemberScope() {
  enum Example { value = 1, B = value + 1 }
  return Example
}
function namespaceScope() {
  namespace value { export const n = 1 }
  return value + 1
}
`)
    const facts = collectScriptBindingFacts(program)
    const bindings = findIdentifiers(program, 'value')
      .map((node) => resolveLexicalBinding(facts, node))
      .filter((binding) => binding !== undefined)

    expect(bindings).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'enum', name: 'value' }),
      expect.objectContaining({ kind: 'namespace', name: 'value' })
    ]))
    expect(bindings.filter((binding) => binding.kind === 'enum')).toHaveLength(4)
  })
})

function parseProgram(source: string): Node {
  const parsed = parseVueSource(`<script setup lang="ts">${source}</script>`, 'Fixture.vue')
  return parsed.scriptPrograms[0] as Node
}

function findIdentifier(root: Node, name: string, occurrence: number): Node {
  const matches = findIdentifiers(root, name)
  const match = matches[occurrence]
  if (!match) throw new Error(`Missing ${name} occurrence ${occurrence}`)
  return match
}

function findIdentifiers(root: Node, name: string): Node[] {
  const matches: Node[] = []
  const visit = (value: unknown): void => {
    if (!value || typeof value !== 'object') return
    if (Array.isArray(value)) {
      value.forEach(visit)
      return
    }
    const node = value as Node
    if (node.type === 'Identifier' && node.name === name) matches.push(node)
    for (const [key, child] of Object.entries(node)) {
      if (!['parent', 'loc', 'range'].includes(key)) visit(child)
    }
  }
  visit(root)
  return matches
}
