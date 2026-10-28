import { describe, expect, test } from 'vitest'
import { analyzeSourceText } from './index.js'

function props(script: string, expression = 'rules', template = '') {
  return analyzeSourceText('/fixture.vue', `<script setup lang="ts">${script}</script><template>${template || `<ElForm :rules="${expression}" />`}</template>`, { resolveConstants: true }).components.flatMap((component) => component.props)
}

describe('opt-in static lexical evidence', () => {
  test('custom directive constants are opt-in and respect template shadowing and mutation', () => {
    const source = `<script setup>const permissions = ['users:add']</script><template>
      <Button v-hasPermi="permissions" />
      <div v-for="permissions in rows"><Button v-hasPermi="permissions" /></div>
    </template>`
    expect(analyzeSourceText('/fixture.vue', source).components[0]?.directives[0]).not.toHaveProperty('staticEvidence')
    const result = analyzeSourceText('/fixture.vue', source, { resolveConstants: true })
    expect(result.components[0]?.directives[0]?.staticEvidence?.value).toEqual(['users:add'])
    expect(result.components[1]?.directives[0]?.staticEvidence).toEqual({ complete: false })
    const mutated = `<script setup>const permissions = ['users:add']; permissions.push(runtime)</script><template><Button v-hasPermi="permissions" /></template>`
    expect(analyzeSourceText('/fixture.vue', mutated, { resolveConstants: true }).components[0]?.directives[0]?.staticEvidence).toEqual({ complete: false })
  })

  test('retains a trigger beside an unknown imported validator without claiming a complete value', () => {
    const [prop] = props("import { validate } from './runtime'; const rules = { name: [{ trigger: 'blur', validator: validate }] }")
    expect(prop?.staticValue).toBeUndefined()
    expect(prop?.staticEvidence).toMatchObject({ complete: false, properties: { name: { complete: false, elements: [
      { complete: false, properties: { trigger: { complete: true, value: 'blur' }, validator: { complete: false } } }
    ] } } })
  })

  test('preserves partial form rules beside mutable same-name state through nested layouts', () => {
    const source = `<script setup>
      import { validateName } from './validator'
      const rules = { name: [{ required: true, trigger: 'change' }, { validator: validateName }] }
      let name = ''
    </script><template>
      <ElForm :rules="rules"><section><ElFormItem prop="name"><ElTooltip>
        <ElInput v-model="name" />
      </ElTooltip></ElFormItem></section></ElForm>
    </template>`
    const result = analyzeSourceText('/fixture.vue', source, { resolveConstants: true, includeNativeElements: true })
    const form = result.components.find((component) => component.tag === 'ElForm')
    expect(form?.props[0]?.staticValue).toBeUndefined()
    expect(form?.props[0]?.staticEvidence).toMatchObject({ complete: false, properties: { name: {
      complete: false,
      elements: [
        { complete: true, value: { required: true, trigger: 'change' } },
        { complete: false, properties: { validator: { complete: false } } }
      ]
    } } })
  })

  test('noncomputed member names are not dependencies of their lexical namesakes', () => {
    const [prop] = props("const config = { name: [{ trigger: 'change' }] }; const rules = config.name; let name = ''",
      'rules', '<ElForm :rules="rules"><ElInput v-model="name" /></ElForm>')
    expect(prop?.staticValue).toEqual([{ trigger: 'change' }])
  })

  test.each([
    'const other = {}; other.name = []',
    'send({ name: runtime })',
    'function receive({ name: local }) {}',
    'const { name: local } = runtime'
  ])('non-reference names do not invalidate known aliases: %s', (usage) => {
    const [prop] = props(`const name = { trigger: 'change' }; const rules = { field: [name] }; ${usage}`)
    expect(prop?.staticValue).toEqual({ field: [{ trigger: 'change' }] })
  })

  test.each([
    "const name = { trigger: 'change' }; const rules = { name }",
    "let name = 'field'; const rules = { [name]: runtime, field: [{ trigger: 'change' }] }",
    "let name = 'field'; const config = { field: [{ trigger: 'change' }] }; const rules = config[name]"
  ])('computed keys and shorthand values retain genuine state dependencies: %s', (script) => {
    const [prop] = props(script, 'rules', '<ElForm :rules="rules"><ElInput v-model="name" /></ElForm>')
    expect(prop?.staticEvidence).toEqual({ complete: false })
  })

  test.each([
    '{ const { field: name } = runtime }',
    'function receive({ field: name }) {}',
    'function receive(local = name) { mutate(local) }',
    'function receive({ [name]: local }) {}',
    'const { [name]: local } = runtime',
    'const { field: local = name } = runtime',
    '({ field: name } = runtime)',
    'send({ [name]: runtime })'
  ])('real destructuring, default, assignment and computed references remain conservative: %s', (usage) => {
    const [prop] = props(`const name = { trigger: 'change' }; const rules = { field: [name] }; ${usage}`)
    expect(prop?.staticEvidence).toEqual({ complete: false })
  })

  test('resolves ordered const aliases and member access but not forward references or runtime imports', () => {
    expect(props("const trigger = 'blur'; const rule = { trigger }; const rules = [rule]")[0]?.staticValue).toEqual([{ trigger: 'blur' }])
    expect(props("const config = { trigger: 'change' }", 'config.trigger')[0]?.staticValue).toBe('change')
    expect(props("const rules = later; const later = ['blur']")[0]?.staticValue).toBeUndefined()
    expect(props("import rules from './rules'")[0]?.staticEvidence).toEqual({ complete: false })
  })

  test('array property access only resolves canonical indices', () => {
    expect(props("const rules = ['blur', 'change']", "rules['1']")[0]?.staticValue).toBe('change')
    expect(props("const rules = ['blur', 'change']", "rules['01']")[0]?.staticValue).toBeUndefined()
    expect(props("const rules = ['blur', 'change']", "rules['-0']")[0]?.staticValue).toBeUndefined()
  })

  test.each([
    "rules.name = []",
    "rules[key] = []",
    "delete rules.name",
    "rules.name.push({ trigger: 'change' })",
    "mutate(rules)",
    "const alias = rules; alias.name = []",
    "const alias = rules.name; alias.push({ trigger: 'change' })",
    "let alias = rules; alias.name = []",
    "const { name } = rules; name.push({ trigger: 'change' })",
    "function change() { rules.name = [] }",
    "const external = {}; external.rules = rules",
    "function expose() { return rules }",
    "const expose = () => rules; mutate(expose)",
    "const expose = () => ({ rules }); mutate(expose)"
  ])('invalidates mutation or escape: %s', (mutation) => {
    const [prop] = props(`const rules = { name: [{ trigger: 'blur' }] }; ${mutation}`)
    expect(prop?.staticEvidence).toEqual({ complete: false })
    expect(prop?.staticValue).toBeUndefined()
  })

  test.each([
    "for (rules.trigger of ['change']) {}",
    "for (rules.trigger in { change: true }) {}",
    "for ([rules.trigger] of [['change']]) {}",
    "for ({ trigger: rules.trigger } of [{ trigger: 'change' }]) {}",
    "for ({ ...rules.trigger } of [{ change: true }]) {}",
    "const alias = rules; for (alias.trigger of ['change']) {}",
    "let alias = rules; for (alias in { change: true }) {}"
  ])('invalidates assignment-form loop targets and their aliases: %s', (loop) => {
    const [prop] = props(`const rules = { trigger: 'blur' }; ${loop}`)
    expect(prop?.staticValue).toBeUndefined()
    expect(prop?.staticEvidence).toEqual({ complete: false })
  })

  test.each([
    "for (const trigger of ['change']) {}",
    "for (let trigger in { change: true }) {}",
    "for (const [trigger] of [['change']]) {}",
    "for (const { trigger } of [{ trigger: 'change' }]) {}",
    "let other; for (other of ['change']) {}"
  ])('preserves unrelated constants around declaration-form loops: %s', (loop) => {
    expect(props(`const rules = { trigger: 'blur' }; ${loop}`)[0]?.staticValue)
      .toEqual({ trigger: 'blur' })
  })

  test.each([
    "let rule; for (rule of [rules]) { rule.trigger = 'change' }",
    "for (const rule of [rules]) { rule.trigger = 'change' }",
    "for (let rule of [rules]) { rule.trigger = 'change' }",
    "for (var rule of [rules]) { rule.trigger = 'change' }",
    "let rule; for (rule of [rules]) {} rule.trigger = 'change'",
    "const entries = [rules]; for (const rule of entries) { rule.trigger = 'change' }",
    "for (const [rule] of [[rules]]) { rule.trigger = 'change' }",
    "let rule; for ([rule] of [[rules]]) { rule.trigger = 'change' }",
    "for (const { value: rule } of [{ value: rules }]) { rule.trigger = 'change' }",
    "let rule; for ({ value: rule } of [{ value: rules }]) { rule.trigger = 'change' }",
    "for (const group of [[rules]]) { for (const rule of group) { rule.trigger = 'change' } }",
    "for (const rule of [rules]) { const alias = rule; alias.trigger = 'change' }",
    "for (const rule of [rules]) { let alias; alias = rule; mutate(alias) }",
    "for (const rule of [rules]) { mutate(rule) }",
    "for (const rule of [rules]) { delete rule.trigger }",
    "for (const rule of [rules]) { rule.count++ }",
    "for (const rule of [rules]) { external.rule = rule }",
    "const holder = {}; for (holder.rule of [rules]) {}",
    "function expose() { for (const rule of [rules]) { return rule } }",
    "for (const rule of [rules]) { callbacks.push(() => { rule.trigger = 'change' }) }"
  ])('invalidates iteration-source objects only after alias mutation or escape: %s', (loop) => {
    const [prop] = props(`const rules = { trigger: 'blur' }; ${loop}`)
    expect(prop?.staticValue).toBeUndefined()
    expect(prop?.staticEvidence).toEqual({ complete: false })
  })

  test.each([
    "for (const rule of [rules]) { rule.trigger }",
    "for (var rule of [rules]) { rule.trigger }",
    "let rule; for (rule of [rules]) { const trigger = rule.trigger }",
    "let rule; for (rule of [rules]) {} rule = { trigger: 'change' }",
    "for (let rule of [rules]) { rule = { trigger: 'change' } }",
    "for (const { trigger } of [rules]) { trigger }",
    "for (const rule of [rules]) { const alias = rule; alias.trigger }",
    "for (const rule of [rules]) { function inspect(rule) { mutate(rule) } }",
    "for (const rule of [rules]) { { const rule = {}; mutate(rule) } }",
    "let rule = other; for (const rule of [rules]) { rule.trigger } mutate(rule)",
    "for (const key in rules) { consume(key) }",
    "for (const rule of [other]) { rule.trigger = 'change' }",
    "let rule; for (rule of [other]) { rule.trigger = 'change' }"
  ])('preserves nonmutating and unrelated iteration-source objects: %s', (loop) => {
    expect(props(`const rules = { trigger: 'blur' }; ${loop}`)[0]?.staticValue)
      .toEqual({ trigger: 'blur' })
  })

  test.each([
    '<ElForm :rules="rules" @click="rule.trigger = next" />',
    '<ElForm :rules="rules" @click="mutate(rule)" />',
    '<ElForm :rules="rules"><ElInput v-model="rule.trigger" /></ElForm>'
  ])('invalidates retained iteration aliases mutated by template handlers: %s', (template) => {
    const [prop] = props("const rules = { trigger: 'blur' }; let rule; for (rule of [rules]) {}", 'rules', template)
    expect(prop?.staticValue).toBeUndefined()
    expect(prop?.staticEvidence).toEqual({ complete: false })
  })

  test.each([
    "for (this.rules.trigger of ['change']) {}",
    "for (this.rules.trigger in { change: true }) {}",
    "for ([this.rules.trigger] of [['change']]) {}",
    "for ({ trigger: this.rules.trigger } of [{ trigger: 'change' }]) {}",
    "for (this.alias.trigger of ['change']) {}"
  ])('invalidates Options API loop writes and shared returned aliases: %s', (loop) => {
    const source = `<script>export default {
      data() { const shared = { trigger: 'blur' }; return { rules: shared, alias: shared, stable: 7 } },
      methods: { change() { ${loop} } }
    }</script><template><ElForm :rules="rules" :stable="stable" /></template>`
    const result = analyzeSourceText('/fixture.vue', source, { resolveConstants: true })
    expect(result.components[0]?.props[0]?.staticValue).toBeUndefined()
    expect(result.components[0]?.props[0]?.staticEvidence).toEqual({ complete: false })
    expect(result.components[0]?.props[1]?.staticValue).toBe(7)
  })

  test.each([
    "for (const rule of [this.rules]) { rule.trigger = 'change' }",
    "let rule; for (rule of [this.rules]) { rule.trigger = 'change' }",
    "for (var rule of [this.rules]) {} rule.trigger = 'change'",
    "for (const [rule] of [[this.rules]]) { rule.trigger = 'change' }",
    "let rule; for ({ value: rule } of [{ value: this.rules }]) { rule.trigger = 'change' }",
    "for (const rule of [this['rules']]) { rule.trigger = 'change' }",
    "for (const group of [[this.rules]]) { for (const rule of group) { rule.trigger = 'change' } }",
    "for (const rule of [this.rules]) { const alias = rule; alias.trigger = 'change' }",
    "for (const rule of [this.rules]) { mutate(rule) }",
    "for (const rule of [this.rules]) { external.rule = rule }",
    "const holder = {}; for (holder.rule of [this.rules]) {}",
    "for (const rule of [this.rules]) { return rule }"
  ])('invalidates Options instance sources mutated or escaped through iteration aliases: %s', (loop) => {
    const source = `<script>export default {
      data() { return { rules: { trigger: 'blur' }, stable: 7 } },
      methods: { change() { ${loop} } }
    }</script><template><ElForm :rules="rules" :stable="stable" /></template>`
    const result = analyzeSourceText('/fixture.vue', source, { resolveConstants: true })
    expect(result.components[0]?.props[0]?.staticValue).toBeUndefined()
    expect(result.components[0]?.props[0]?.staticEvidence).toEqual({ complete: false })
    expect(result.components[0]?.props[1]?.staticValue).toBe(7)
  })

  test.each([
    "for (const rule of [this.rules]) { rule.trigger }",
    "let rule; for (rule of [this.rules]) { const trigger = rule.trigger }",
    "for (let rule of [this.rules]) { rule = {} }",
    "for (const rule of [this.rules]) { const alias = rule; alias.trigger }",
    "for (const rule of [this.rules]) { function inspect(rule) { mutate(rule) } }",
    "for (const rule of [this.rules]) { { const rule = {}; mutate(rule) } }",
    "for (const key in this.rules) { consume(key) }",
    "for (const rule of [other]) { rule.trigger = 'change' }"
  ])('preserves Options instance evidence around nonmutating and unrelated loops: %s', (loop) => {
    const source = `<script>export default {
      data() { return { rules: { trigger: 'blur' }, stable: 7 } },
      methods: { inspect() { ${loop} } }
    }</script><template><ElForm :rules="rules" :stable="stable" /></template>`
    const result = analyzeSourceText('/fixture.vue', source, { resolveConstants: true })
    expect(result.components[0]?.props[0]?.staticValue).toEqual({ trigger: 'blur' })
    expect(result.components[0]?.props[1]?.staticValue).toBe(7)
  })

  test('invalidates shared Options objects through an iterated sibling field', () => {
    const source = `<script>export default {
      data() { const shared = { trigger: 'blur' }; return { rules: shared, alias: shared, stable: 7 } },
      methods: { change() { for (const rule of [this.alias]) { rule.trigger = 'change' } } }
    }</script><template><ElForm :rules="rules" :stable="stable" /></template>`
    const result = analyzeSourceText('/fixture.vue', source, { resolveConstants: true })
    expect(result.components[0]?.props[0]?.staticEvidence).toEqual({ complete: false })
    expect(result.components[0]?.props[1]?.staticValue).toBe(7)
  })

  test('does not resolve template loop/slot shadows or event-mutated constants', () => {
    const loop = props("const rules = 'blur'", 'rules', '<div v-for="rules in rows"><ElForm :rules="rules" /></div>')
    expect(loop[0]?.staticValue).toBeUndefined()
    const slot = props("const rules = 'blur'", 'rules', '<Container v-slot="{ rules }"><ElForm :rules="rules" /></Container>')
    expect(slot[0]?.staticValue).toBeUndefined()
    expect(props("const rules = { trigger: 'blur' }", 'rules', '<ElForm :rules="rules" @click="rules.trigger = next" />')[0]?.staticValue).toBeUndefined()
  })

  test('unknown spreads and computed keys erase earlier certainty, later explicit fields survive', () => {
    const [overridden] = props("const rules = { trigger: 'blur', ...runtime }")
    expect(overridden?.staticEvidence?.properties?.trigger).toBeUndefined()
    const [explicit] = props("const rules = { ...runtime, trigger: 'blur', validator }")
    expect(explicit?.staticEvidence?.properties?.trigger?.value).toBe('blur')
    expect(explicit?.staticValue).toBeUndefined()
    expect(props("const rules = { trigger: 'blur', [key]: value }")[0]?.staticEvidence?.properties?.trigger).toBeUndefined()
    expect(props("const rules = ['blur', ...runtime, 'change']")[0]?.staticEvidence).toEqual({ complete: false, elements: [{ complete: true, value: 'blur' }] })
  })

  test('normal script module bindings are not exposed as template constants', () => {
    const result = analyzeSourceText('/fixture.vue', `<script>const rules = ['blur']; export default {}</script><template><ElForm :rules="rules" /></template>`, { resolveConstants: true })
    expect(result.components[0]?.props[0]?.staticValue).toBeUndefined()
  })

  test('Vue 2 data keeps a known trigger beside an unknown validator through local return bindings', () => {
    const source = `<script>
      import validate from './runtime'
      export default {
        data() {
          const trigger = 'change'
          const rules = { name: [{ trigger, validator: validate }] }
          return { rules }
        }
      }
    </script><template><ElForm :rules="rules" /></template>`
    const [prop] = analyzeSourceText('/fixture.vue', source, { resolveConstants: true }).components[0]?.props ?? []
    expect(prop?.staticValue).toBeUndefined()
    expect(prop?.staticEvidence?.properties?.name?.elements?.[0]?.properties).toEqual({
      trigger: { complete: true, value: 'change' }, validator: { complete: false }
    })
  })

  test.each([
    "this.rules.name = []",
    "this.rules.name.push({ trigger: 'blur' })",
    "this[key] = []",
    "mutate(this.rules)",
    "const alias = this.rules; alias.name = []",
    "const vm = this; vm.rules.name = []",
    "return this.rules"
  ])('Vue 2 instance mutation/escape invalidates data evidence: %s', (mutation) => {
    const source = `<script>export default {
      data() { return { rules: { name: [{ trigger: 'change', validator }] } } },
      methods: { change() { ${mutation} } }
    }</script><template><ElForm :rules="rules" /></template>`
    expect(analyzeSourceText('/fixture.vue', source, { resolveConstants: true }).components[0]?.props[0]?.staticEvidence).toEqual({ complete: false })
  })

  test('supports arrow data and imported defineComponent setup without exposing unrelated module bindings', () => {
    const source = `<script>
      import { defineComponent as component } from 'vue'
      const hidden = 'module-only'
      const trigger = 'change'
      export default component({
        setup() {
          const rules = { name: [{ trigger, validator }] }
          return { rules }
        }
      })
    </script><template><ElForm :rules="rules" :label="hidden" /></template>`
    const component = analyzeSourceText('/fixture.vue', source, { resolveConstants: true }).components[0]
    expect(component?.props[0]?.staticEvidence?.properties?.name?.elements?.[0]?.properties?.trigger?.value).toBe('change')
    expect(component?.props[1]?.staticValue).toBeUndefined()
    const arrow = analyzeSourceText('/fixture.vue', `<script>export default { data: () => ({ count: 20 }) }</script><template><Field :count="count" /></template>`, { resolveConstants: true })
    expect(arrow.components[0]?.props[0]?.staticValue).toBe(20)
    const returnedAlias = analyzeSourceText('/fixture.vue', `<script>const initial = { count: 20 }; export default { data: () => initial }</script><template><Field :count="count" /></template>`, { resolveConstants: true })
    expect(returnedAlias.components[0]?.props[0]?.staticValue).toBe(20)
  })

  test('Options API unknown overrides, conditional returns and shared aliases remain conservative', () => {
    for (const factory of [
      "data() { if (runtime) return { rules: ['change'] }; return { rules: ['blur'] } }",
      "data() { return { rules: ['change'], ...runtime } }",
      "setup() { const rules = ['change']; function mutate() { rules.push('blur') }; return { rules, mutate } }"
    ]) {
      const source = `<script>export default { ${factory} }</script><template><ElForm :rules="rules" /></template>`
      expect(analyzeSourceText('/fixture.vue', source, { resolveConstants: true }).components[0]?.props[0]?.staticValue).toBeUndefined()
    }
    const aliased = `<script>export default {
      data() { const shared = { trigger: 'change' }; return { rules: shared, alias: shared } },
      methods: { change() { this.alias.trigger = 'blur' } }
    }</script><template><ElForm :rules="rules" /></template>`
    expect(analyzeSourceText('/fixture.vue', aliased, { resolveConstants: true }).components[0]?.props[0]?.staticEvidence).toEqual({ complete: false })
  })

  test('template writes invalidate sibling fields that share an Options API object', () => {
    const source = `<script>export default {
      data() { const shared = { trigger: 'change' }; return { rules: shared, alias: shared } }
    }</script><template><ElForm :rules="rules" @click="alias.trigger = next" /></template>`
    expect(analyzeSourceText('/fixture.vue', source, { resolveConstants: true }).components[0]?.props[0]?.staticEvidence).toEqual({ complete: false })
  })

  test('leaves default analysis unchanged and records native elements only when requested', () => {
    const source = `<script setup>const limit = 20</script><template><ElForm><section><ElFormItem><input :maxlength="limit" /></ElFormItem></section></ElForm></template>`
    const ordinary = analyzeSourceText('/fixture.vue', source)
    expect(ordinary.components.map((component) => component.tag)).toEqual(['ElForm', 'ElFormItem'])
    const expanded = analyzeSourceText('/fixture.vue', source, { includeNativeElements: true, resolveConstants: true })
    expect(expanded.components.map((component) => component.tag)).toEqual(['ElForm', 'section', 'ElFormItem', 'input'])
    expect(expanded.components[2]?.parent).toEqual(expanded.components[0]?.loc)
    expect(expanded.components[3]?.parent).toEqual(expanded.components[2]?.loc)
    expect(expanded.components[3]?.props[0]?.staticValue).toBe(20)
    expect(analyzeSourceText('/fixture.vue', '<script setup>const limit = 20</script><template><Field :limit="limit" /></template>').components[0]?.props[0]).not.toHaveProperty('staticEvidence')
  })
})
