import { describe, expect, test } from 'vitest'
import { parseVueSource } from '@vue-doctor/source'
import { diagnoseVueSource } from './index.js'

function diagnose(source: string, file = '/project/src/App.vue') {
  return diagnoseVueSource({ file, parsed: parseVueSource(source, file), source })
}

function diagnoseForVue(source: string, vueVersion: string) {
  const file = '/project/src/App.vue'
  return diagnoseVueSource({ file, parsed: parseVueSource(source, file), source, vueVersion })
}

function diagnoseWithoutVueVersion(source: string) {
  const file = '/project/src/App.vue'
  return diagnoseVueSource({
    file,
    parsed: parseVueSource(source, file),
    source,
    assumeLatestVueVersion: false
  })
}

describe('Vue core diagnostics', () => {
  test('does not emit version-dependent diagnostics when Vue version evidence is unavailable', () => {
    const diagnostics = diagnoseWithoutVueVersion(`<script setup>
import { computed, ref, watch } from 'vue'
const count = ref(0)
watch(count, () => count.value++, { once: true })
watch(count, async () => { await fetch('/value'); count.value = 2 }, { once: true })
const doubled = computed(() => count.value * 2)
doubled.value = 4
</script><template><div /></template>`)
    const codes = diagnostics.map((diagnostic) => diagnostic.code)

    expect(codes).not.toContain('vue-watch-self-mutation')
    expect(codes).not.toContain('vue-watch-async-stale-write')
    expect(codes).toContain('vue-computed-readonly-write')
  })

  test('reports v-html as a security error (vite-doctor restrict-v-html)', () => {
    expect(diagnose('<template><article v-html="content" /></template>')).toEqual([
      expect.objectContaining({ code: 'vue-security-restrict-v-html', severity: 'error' })
    ])
  })

  test('emits one-based source columns for report locations', () => {
    const [diagnostic] = diagnose('<template>\n  <article v-html="content" />\n</template>')

    expect(diagnostic?.evidence[0]).toMatchObject({ line: 2, column: 3 })
  })

  test('reports v-if and v-for on the same element', () => {
    expect(diagnose('<template><li v-for="item in items" v-if="item.active">{{ item.name }}</li></template>')).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'vue-template-v-if-for', severity: 'warning' }),
      expect.objectContaining({ code: 'vue-template-v-for-key', severity: 'warning' })
    ]))
  })

  test('reports a missing key on a v-for element', () => {
    expect(diagnose('<template><li v-for="item in items">{{ item.name }}</li></template>')).toEqual([
      expect.objectContaining({ code: 'vue-template-v-for-key', severity: 'warning' })
    ])
  })

  test('reports direct prop mutation in Options API methods', () => {
    expect(diagnose(`<script>
export default {
  props: { count: Number },
  methods: { increment() { this.count += 1 } }
}
</script><template><div /></template>`)).toEqual([
      expect.objectContaining({ code: 'vue-prop-mutated', severity: 'error' })
    ])
  })

  test('does not treat plain class field writes as Options API prop mutation', () => {
    expect(diagnose(`<script setup>
class RuleConfig {
  constructor(params = {}) {
    this.id = params?.id || null
    this.ruleFieldId = params?.ruleFieldId || null
  }
}
const form = ref({ ruleGroup: [[new RuleConfig()]] })
</script><template><div /></template>`)).toEqual([])
  })

  test('does not report safe templates or unrelated state writes', () => {
    expect(diagnose(`<script setup>const state = { count: 0 }</script>
<template><li v-for="item in items" :key="item.id">{{ item.name }}</li></template>`)).toEqual([])
  })

  test('reports script setup prop mutation and template scope shadowing', () => {
    const diagnostics = diagnose(`<script setup lang="ts">
const props = defineProps<{ user: string }>()
const user = 'outer'
props.user = 'changed'
</script>
<template><div v-for="user in users" :key="user">{{ user }}</div></template>`)

    expect(diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'vue-prop-mutated', severity: 'error' }),
      expect.objectContaining({ code: 'vue-template-shadow' })
    ]))
  })

  test('does not treat nested script locals as template-visible bindings', () => {
    expect(diagnose(`<script setup>
function prepare() { const item = 'local'; return item }
</script>
<template><div v-for="item in items" :key="item">{{ item }}</div></template>`)).toEqual([])
  })

  test('reports setup(props) destructure as non-reactive', () => {
    expect(diagnose(`<script>
export default {
  props: { count: Number },
  setup(props) {
    const { count } = props
    return { count }
  }
}
</script><template><div /></template>`)).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'vue-setup-props-destructure', severity: 'error' })
    ]))
  })

  test('reports ref used as arithmetic operand without .value', () => {
    expect(diagnose(`<script setup>
import { ref } from 'vue'
const count = ref(0)
const next = count + 1
</script><template><div /></template>`)).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'vue-ref-as-operand', severity: 'error' })
    ]))
  })

  test('reports watch on destructured defineProps without getter', () => {
    expect(diagnose(`<script setup lang="ts">
import { watch } from 'vue'
const { count } = defineProps<{ count: number }>()
watch(count, () => {})
</script><template><div /></template>`)).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'vue-defineprops-watch-getter', severity: 'error' })
    ]))
  })

  test('reports watcher side effects without cleanup', () => {
    expect(diagnose(`<script setup>
import { watch } from 'vue'
const open = true
watch(() => open, () => {
  window.addEventListener('resize', () => {})
})
</script><template><div /></template>`)).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'vue-watch-require-cleanup', severity: 'warning' })
    ]))
  })

  test('matches watcher cleanup callbacks by lexical binding identity', () => {
    const shadowed = diagnose(`<script setup>
import { watch } from 'vue'
const open = true
watch(() => open, (_value, _oldValue, onCleanup) => {
  function nested(onCleanup) { onCleanup(() => {}) }
  nested(() => {})
  window.addEventListener('resize', () => {})
})
</script><template><div /></template>`)
    const registered = diagnose(`<script setup>
import { watch } from 'vue'
const open = true
watch(() => open, (_value, _oldValue, onCleanup) => {
  const handler = () => {}
  window.addEventListener('resize', handler)
  onCleanup(() => window.removeEventListener('resize', handler))
})
</script><template><div /></template>`)

    expect(shadowed.map((diagnostic) => diagnostic.code)).toContain(
      'vue-watch-require-cleanup'
    )
    expect(registered.map((diagnostic) => diagnostic.code)).not.toContain(
      'vue-watch-require-cleanup'
    )
  })

  test('reports watcher-synchronized derived refs that should be computed', () => {
    expect(diagnose(`<script setup>
import { computed, ref, watch } from 'vue'
const first = ref('Ada')
const last = ref('Lovelace')
const fullName = ref('')
watch([first, last], () => {
  fullName.value = first.value + ' ' + last.value
})
</script><template><div>{{ fullName }}</div></template>`)).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'vue-watch-derived-state', severity: 'warning' })
    ]))
  })

  test('does not call multi-step watcher effects derived state', () => {
    const diagnostics = diagnose(`<script setup>
import { ref, watch } from 'vue'
const id = ref('1')
const result = ref(null)
watch(id, async () => {
  const response = await fetch('/api/' + id.value)
  result.value = await response.json()
})
</script><template><div /></template>`)

    expect(diagnostics.map((diagnostic) => diagnostic.code)).not.toContain('vue-watch-derived-state')
  })

  test('does not recommend readonly computed state for a v-model target', () => {
    const diagnostics = diagnose(`<script setup>
import { ref, watch } from 'vue'
const source = ref('')
const local = ref('')
watch(source, () => {
  local.value = source.value
})
</script><template><input v-model="local" /></template>`)

    expect(diagnostics.map((diagnostic) => diagnostic.code)).not.toContain('vue-watch-derived-state')
  })

  test('does not recommend readonly computed state for a Vue 2 .sync target', () => {
    const diagnostics = diagnoseForVue(`<script setup>
import { ref, watch } from 'vue'
const source = ref(false)
const visible = ref(false)
watch(source, () => {
  visible.value = source.value
})
</script><template><Dialog :visible.sync="visible" /></template>`, '2.7.16')

    expect(diagnostics.map((diagnostic) => diagnostic.code)).not.toContain('vue-watch-derived-state')
  })

  test('reports a reactive object property passed directly to watch', () => {
    const diagnostics = diagnose(`<script setup>
import { reactive, watch } from 'vue'
const state = reactive({ count: 0 })
watch(state.count, () => {})
</script><template><div /></template>`)

    expect(diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'vue-watch-reactive-property', severity: 'error' })
    ]))
  })


  test('reports ref.value and props properties passed directly to watch', () => {
    const diagnostics = diagnose(`<script setup>
import { ref, watch } from 'vue'
const props = defineProps({ open: Boolean })
const count = ref(0)
watch(count.value, () => {})
watch(props.open, () => {})
</script><template><div /></template>`)
    const matches = diagnostics.filter((diagnostic) => (
      diagnostic.code === 'vue-watch-reactive-property'
    ))

    expect(matches).toHaveLength(2)
    expect(matches.map((diagnostic) => diagnostic.message)).toEqual(expect.arrayContaining([
      expect.stringContaining('watch(count.value'),
      expect.stringContaining('watch(props.open')
    ]))
  })
  test('reports non-reactive values inside a watch source array', () => {
    const diagnostics = diagnose(`<script setup>
import { reactive, ref, watch } from 'vue'
const state = reactive({ count: 0 })
const page = ref(1)
watch([state.count, page.value], () => {})
</script><template><div /></template>`)

    expect(diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: 'vue-watch-reactive-property',
        message: expect.stringContaining('state.count, page.value')
      })
    ]))
  })

  test('accepts a getter for a reactive object property watch source', () => {
    const diagnostics = diagnose(`<script setup>
import { reactive, watch } from 'vue'
const state = reactive({ count: 0 })
watch(() => state.count, () => {})
</script><template><div /></template>`)

    expect(diagnostics.map((diagnostic) => diagnostic.code)).not.toContain(
      'vue-watch-reactive-property'
    )
  })

  test('reports a watcher that unconditionally mutates its own ref source', () => {
    const diagnostics = diagnose(`<script setup>
import { ref, watch } from 'vue'
const count = ref(0)
watch(count, () => count.value++)
</script><template><div /></template>`)

    expect(diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'vue-watch-self-mutation', severity: 'warning' })
    ]))
  })

  test('accepts guarded and once-only writes to a watched ref', () => {
    const diagnostics = diagnose(`<script setup>
import { ref, watch } from 'vue'
const count = ref(0)
watch(count, (value) => {
  if (value < 10) count.value++
})
watch(count, () => count.value++, { once: true })
</script><template><div /></template>`)

    expect(diagnostics.map((diagnostic) => diagnostic.code)).not.toContain(
      'vue-watch-self-mutation'
    )
  })

  test('reports an async watcher that writes stale state after await', () => {
    const diagnostics = diagnose(`<script setup>
import { ref, watch } from 'vue'
const query = ref('')
const results = ref([])
watch(query, async () => {
  const response = await fetch('/api/search?q=' + query.value)
  results.value = await response.json()
})
</script><template><div /></template>`)

    expect(diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'vue-watch-async-stale-write', severity: 'warning' })
    ]))
  })

  test('accepts async watcher invalidation through onCleanup', () => {
    const diagnostics = diagnose(`<script setup>
import { ref, watch } from 'vue'
const query = ref('')
const results = ref([])
watch(query, async (_value, _oldValue, onCleanup) => {
  const controller = new AbortController()
  onCleanup(() => controller.abort())
  const response = await fetch('/api/search', { signal: controller.signal })
  results.value = await response.json()
})
</script><template><div /></template>`)

    expect(diagnostics.map((diagnostic) => diagnostic.code)).not.toContain(
      'vue-watch-async-stale-write'
    )
  })

  test('does not treat a shadowed watcher cleanup parameter as invalidation', () => {
    const diagnostics = diagnose(`<script setup>
import { ref, watch } from 'vue'
const query = ref('')
const results = ref([])
watch(query, async (_value, _oldValue, onCleanup) => {
  function nested(onCleanup) { onCleanup(() => {}) }
  nested(() => {})
  const response = await fetch('/api/search?q=' + query.value)
  results.value = await response.json()
})
</script><template><div /></template>`)

    expect(diagnostics.map((diagnostic) => diagnostic.code)).toContain(
      'vue-watch-async-stale-write'
    )
  })

  test('does not report a one-way initialized flag after async work', () => {
    const diagnostics = diagnose(`<script setup>
import { ref, watch } from 'vue'
const query = ref('')
const initialized = ref(false)
watch(query, async () => {
  await fetch('/api/initialize')
  initialized.value = true
})
</script><template><div /></template>`)

    expect(diagnostics.map((diagnostic) => diagnostic.code)).not.toContain(
      'vue-watch-async-stale-write'
    )
  })

  test('does not treat nextTick scheduling as stale async work', () => {
    const diagnostics = diagnose(`<script setup>
import { nextTick, ref, watch } from 'vue'
const source = ref(false)
const height = ref(0)
watch(source, async () => {
  await nextTick()
  height.value = document.body.offsetHeight
})
</script><template><div /></template>`)

    expect(diagnostics.map((diagnostic) => diagnostic.code)).not.toContain(
      'vue-watch-async-stale-write'
    )
  })

  test('reports nested shallowRef mutations without triggerRef', () => {
    const diagnostics = diagnose(`<script setup>
import { shallowRef } from 'vue'
const state = shallowRef({ count: 0 })
state.value.count++
</script><template><div /></template>`)

    expect(diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'vue-shallow-ref-nested-mutation', severity: 'warning' })
    ]))
  })

  test('accepts intentional shallowRef mutation followed by triggerRef', () => {
    const diagnostics = diagnose(`<script setup>
import { shallowRef, triggerRef } from 'vue'
const state = shallowRef({ items: [] })
state.value.items.push('item')
triggerRef(state)
</script><template><div /></template>`)

    expect(diagnostics.map((diagnostic) => diagnostic.code)).not.toContain(
      'vue-shallow-ref-nested-mutation'
    )
  })

  test('reports reassignment of a reactive proxy binding', () => {
    const diagnostics = diagnose(`<script setup>
import { reactive } from 'vue'
let state = reactive({ count: 0 })
state = reactive({ count: 1 })
</script><template><div /></template>`)

    expect(diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'vue-reactive-reassignment', severity: 'warning' })
    ]))
  })

  test('accepts root property mutation on reactive state', () => {
    const diagnostics = diagnose(`<script setup>
import { reactive } from 'vue'
const state = reactive({ count: 0 })
state.count++
</script><template><div /></template>`)

    expect(diagnostics.map((diagnostic) => diagnostic.code)).not.toContain(
      'vue-reactive-reassignment'
    )
  })

  test('accepts Object.assign when it preserves the same reactive proxy', () => {
    const diagnostics = diagnose(`<script setup>
import { reactive } from 'vue'
let state = reactive({ count: 0 })
state = Object.assign(state, { count: 1 })
</script><template><div /></template>`)

    expect(diagnostics.map((diagnostic) => diagnostic.code)).not.toContain(
      'vue-reactive-reassignment'
    )
  })

  test('reports mutations through deep readonly and shallowReadonly roots', () => {
    const diagnostics = diagnose(`<script setup>
import { readonly, shallowReadonly } from 'vue'
const deep = readonly({ nested: { count: 0 } })
const shallow = shallowReadonly({ enabled: true, nested: { count: 0 } })
deep.nested.count++
shallow.enabled = false
shallow.nested.count++
</script><template><div /></template>`)
    const matches = diagnostics.filter((diagnostic) => (
      diagnostic.code === 'vue-readonly-mutation'
    ))

    expect(matches).toHaveLength(2)
    expect(matches.map((diagnostic) => diagnostic.message)).toEqual(expect.arrayContaining([
      expect.stringContaining('"deep"'),
      expect.stringContaining('"shallow"')
    ]))
  })

  test('reports nested shallowReactive mutation but accepts root replacement', () => {
    const diagnostics = diagnose(`<script setup>
import { shallowReactive } from 'vue'
const state = shallowReactive({ nested: { count: 0 } })
state.nested.count++
state.nested = { count: 1 }
</script><template><div /></template>`)

    expect(diagnostics.filter((diagnostic) => (
      diagnostic.code === 'vue-shallow-reactive-nested-mutation'
    ))).toHaveLength(1)
  })

  test('reports a detached effectScope that is run but never stopped', () => {
    const diagnostics = diagnose(`<script setup>
import { effectScope, watchEffect } from 'vue'
const scope = effectScope(true)
scope.run(() => watchEffect(() => {}))
</script><template><div /></template>`)

    expect(diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: 'vue-detached-effect-scope-require-stop',
        severity: 'warning'
      })
    ]))
  })

  test('accepts stopped, returned, and attached effect scopes', () => {
    const diagnostics = diagnose(`<script setup>
import { effectScope } from 'vue'
const attached = effectScope()
attached.run(() => {})
const stopped = effectScope(true)
stopped.run(() => {})
stopped.stop()
function createOwnedScope() {
  const owned = effectScope(true)
  owned.run(() => {})
  return owned
}
</script><template><div /></template>`)

    expect(diagnostics.map((diagnostic) => diagnostic.code)).not.toContain(
      'vue-detached-effect-scope-require-stop'
    )
  })

  test('reports an incomplete customRef tracking contract', () => {
    const diagnostics = diagnose(`<script setup>
import { customRef } from 'vue'
const value = customRef((_track, trigger) => ({
  get: () => 'value',
  set: () => trigger()
}))
</script><template><div /></template>`)

    expect(diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'vue-custom-ref-incomplete-contract' })
    ]))
  })

  test('accepts a complete customRef tracking contract', () => {
    const diagnostics = diagnose(`<script setup>
import { customRef } from 'vue'
let current = ''
const value = customRef((track, trigger) => ({
  get() {
    track()
    return current
  },
  set(next) {
    current = next
    trigger()
  }
}))
</script><template><div /></template>`)

    expect(diagnostics.map((diagnostic) => diagnostic.code)).not.toContain(
      'vue-custom-ref-incomplete-contract'
    )
  })

  test('reports toRefs called with a plain object literal', () => {
    const diagnostics = diagnose(`<script setup>
import { toRefs } from 'vue'
const fields = toRefs({ count: 0 })
</script><template><div /></template>`)

    expect(diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'vue-to-refs-plain-object', severity: 'error' })
    ]))
  })

  test('accepts toRefs called with a reactive object', () => {
    const diagnostics = diagnose(`<script setup>
import { reactive, toRefs } from 'vue'
const state = reactive({ count: 0 })
const fields = toRefs(state)
</script><template><div /></template>`)

    expect(diagnostics.map((diagnostic) => diagnostic.code)).not.toContain(
      'vue-to-refs-plain-object'
    )
  })

  test('reports long-lived resources at the creation line', () => {
    const diagnostics = diagnose(`<script setup>
setInterval(() => {}, 1000)
</script><template><div /></template>`)
    expect(diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: 'vue-lifecycle-require-cleanup',
        severity: 'warning',
        evidence: [expect.objectContaining({ line: 2 })]
      })
    ]))
  })

  test('does not report lifecycle cleanup when onUnmounted is present', () => {
    expect(diagnose(`<script setup>
import { onUnmounted } from 'vue'
const id = setInterval(() => {}, 1000)
onUnmounted(() => clearInterval(id))
</script><template><div /></template>`)).toEqual([])
  })

  test('accepts Vue 2 Options API resource cleanup', () => {
    expect(diagnose(`<script>
export default {
  mounted() {
    window.addEventListener('scroll', this.onScroll)
  },
  beforeDestroy() {
    window.removeEventListener('scroll', this.onScroll)
  }
}
</script><template><div /></template>`)).toEqual([])
  })

  test('pairs listener cleanup through a stable target alias', () => {
    const diagnostics = diagnose(`<script>
export default {
  mounted() {
    const element = this.$refs.panel
    this.panel = element
    element.addEventListener('scroll', this.onScroll)
  },
  beforeDestroy() {
    this.panel.removeEventListener('scroll', this.onScroll)
  }
}
</script><template><div ref="panel" /></template>`)

    expect(diagnostics.map((diagnostic) => diagnostic.code)).not.toContain(
      'vue-lifecycle-require-cleanup'
    )
  })

  test('recognizes Vue 2 hook event teardown declared before observer creation', () => {
    const diagnostics = diagnose(`<script>
export default {
  mounted() {
    this.$once('hook:beforeDestroy', () => {
      this.observer.disconnect()
    })
    this.observe()
  },
  methods: {
    observe() {
      this.observer = new IntersectionObserver(() => {})
    }
  }
}
</script><template><div /></template>`)

    expect(diagnostics.map((diagnostic) => diagnostic.code)).not.toContain(
      'vue-lifecycle-require-cleanup'
    )
  })

  test('does not treat dynamic cleanup helper names as resource creation', () => {
    expect(diagnose(`<script>
export default {
  mounted() {
    this.handleScroll('addEventListener')
  },
  beforeDestroy() {
    this.handleScroll('removeEventListener')
  },
  methods: {
    handleScroll(event) {
      const element = document.querySelector('.app-main')
      element[event]('scroll', this.onScroll)
    }
  }
}
</script><template><div /></template>`)).toEqual([])
  })

  test('reports each long-lived resource that lacks its own cleanup', () => {
    const diagnostics = diagnose(`<script setup>
import { onUnmounted } from 'vue'
const first = setInterval(() => {}, 1000)
setInterval(() => {}, 2000)
onUnmounted(() => clearInterval(first))
</script><template><div /></template>`)

    expect(diagnostics.filter(
      (diagnostic) => diagnostic.code === 'vue-lifecycle-require-cleanup'
    )).toEqual([
      expect.objectContaining({ evidence: [expect.objectContaining({ line: 4 })] })
    ])
  })

  test('does not treat an empty cleanup hook as resource cleanup', () => {
    const diagnostics = diagnose(`<script setup>
import { onUnmounted } from 'vue'
setInterval(() => {}, 1000)
onUnmounted(() => {})
</script><template><div /></template>`)

    expect(diagnostics.map((diagnostic) => diagnostic.code)).toContain(
      'vue-lifecycle-require-cleanup'
    )
  })

  test('does not pair unrelated close or listener cleanup calls', () => {
    const diagnostics = diagnose(`<script setup>
const socket = new WebSocket('/events')
dialog.close()
window.addEventListener('scroll', onScroll)
window.removeEventListener('resize', onScroll)
</script><template><div /></template>`)

    expect(diagnostics.filter(
      (diagnostic) => diagnostic.code === 'vue-lifecycle-require-cleanup'
    )).toHaveLength(2)
  })

  test('does not let a reassigned owner clean an earlier interval', () => {
    const diagnostics = diagnose(`<script setup>
let id
id = setInterval(() => {}, 1000)
id = setInterval(() => {}, 2000)
clearInterval(id)
</script><template><div /></template>`)

    expect(diagnostics.filter(
      (diagnostic) => diagnostic.code === 'vue-lifecycle-require-cleanup'
    )).toHaveLength(1)
  })

  test('does not keep mutable target aliases after reassignment', () => {
    const diagnostics = diagnose(`<script setup>
let target = first
target.addEventListener('scroll', onScroll)
target = second
second.removeEventListener('scroll', onScroll)
</script><template><div /></template>`)

    expect(diagnostics.filter(
      (diagnostic) => diagnostic.code === 'vue-lifecycle-require-cleanup'
    )).toHaveLength(1)
  })

  test('accepts a long-lived resource returned to an owner', () => {
    expect(diagnose(`<script setup>
function createObserver() {
  const observer = new ResizeObserver(() => {})
  return observer
}
</script><template><div /></template>`).map(
      (diagnostic) => diagnostic.code
    )).not.toContain('vue-lifecycle-require-cleanup')
  })

  test('reports DOM-reading watchers without flush post', () => {
    expect(diagnose(`<script setup>
import { watch, ref } from 'vue'
const open = ref(false)
watch(open, () => {
  document.querySelector('#panel')?.getBoundingClientRect()
})
</script><template><div /></template>`)).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'vue-watch-require-post-flush', severity: 'warning' })
    ]))
  })

  test('reports async watchEffect dependency reads after await', () => {
    expect(diagnose(`<script setup>
import { watchEffect, ref } from 'vue'
const count = ref(0)
watchEffect(async () => {
  await Promise.resolve()
  console.log(count.value)
})
</script><template><div /></template>`)).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'vue-watch-effect-await-read', severity: 'warning' })
    ]))
  })

  test('reports reactive mutation inside onUpdated', () => {
    expect(diagnose(`<script setup>
import { onUpdated, ref } from 'vue'
const count = ref(0)
onUpdated(() => { count.value += 1 })
</script><template><div /></template>`)).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'vue-lifecycle-no-mutation-in-onupdated', severity: 'error' })
    ]))
  })

  test('reports classic template ref that can use useTemplateRef', () => {
    expect(diagnose(`<script setup>
import { ref } from 'vue'
const input = ref(null)
</script>
<template><input ref="input" /></template>`)).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'vue-prefer-use-template-ref', severity: 'info' })
    ]))
  })

  test('reports prefer defineModel for paired prop and update event', () => {
    expect(diagnose(`<script setup>
const props = defineProps({ modelValue: String })
const emit = defineEmits(['update:modelValue'])
</script><template><div /></template>`)).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'vue-prefer-define-model', severity: 'warning' })
    ]))
  })

  test('reports browser APIs in SSR-signaled setup paths', () => {
    expect(diagnose(`<script setup>
import { createSSRApp } from 'vue'
const width = window.innerWidth
</script><template><div /></template>`)).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'vue-ssr-no-browser-api-in-setup', severity: 'error' })
    ]))
  })

  test('keeps SSR detection for namespace calls that use the program fallback', () => {
    expect(diagnose(`<script setup>
import * as Vue from 'vue'
Vue.createSSRApp({})
const width = window.innerWidth
</script><template><div /></template>`)).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'vue-ssr-no-browser-api-in-setup', severity: 'error' })
    ]))
  })

  test('does not report browser APIs in plain SPA setup without SSR signals', () => {
    expect(diagnose(`<script setup>
const width = window.innerWidth
</script><template><div /></template>`).filter((item) => item.code === 'vue-ssr-no-browser-api-in-setup')).toEqual([])
  })

  test('checks file-level SSR signals once instead of rescanning the program for every node', () => {
    const file = '/project/src/LargeForm.vue'
    const declarations = Array.from(
      { length: 100 },
      (_, index) => `const field${index} = ${index}`
    ).join('\n')
    const source = `<script setup>\n${declarations}\nconst width = window.innerWidth\n</script>`
    const parsed = parseVueSource(source, file)
    const program = parsed.scriptPrograms[0] as object | undefined
    if (!program) throw new Error('Expected a script program')
    let programEnumerations = 0
    parsed.scriptPrograms[0] = new Proxy(program, {
      ownKeys(target) {
        programEnumerations += 1
        return Reflect.ownKeys(target)
      }
    })

    const diagnostics = diagnoseVueSource({
      file,
      parsed,
      source,
      vueVersion: '2.7.16'
    })

    expect(diagnostics.filter((item) => item.code.startsWith('vue-ssr-'))).toEqual([])
    expect(programEnumerations).toBeLessThan(30)
  })

  test('does not report browser APIs inside client lifecycle callbacks', () => {
    const diagnostics = diagnose(`<script setup>
import { createSSRApp, onMounted, onUnmounted } from 'vue'
onMounted(() => window.innerWidth)
onUnmounted(() => {
  localStorage.removeItem('draft')
})
</script><template><div /></template>`)

    expect(diagnostics.filter((item) => (
      item.code === 'vue-ssr-no-browser-api-in-setup'
    ))).toEqual([])
  })

  test('reports native buttons without explicit type', () => {
    expect(diagnose('<template><button @click="save">Save</button></template>')).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'vue-html-button-has-type', severity: 'warning' })
    ]))
  })

  test('reports onWatcherCleanup after await in watcher callbacks', () => {
    expect(diagnose(`<script setup>
import { watch, onWatcherCleanup } from 'vue'
const open = true
watch(() => open, async () => {
  await Promise.resolve()
  onWatcherCleanup(() => {})
})
</script><template><div /></template>`)).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'vue-onwatcher-cleanup-after-await', severity: 'error' })
    ]))
  })

  test('reports random values in SSR-signaled setup paths', () => {
    expect(diagnose(`<script setup>
import { createSSRApp } from 'vue'
const n = Math.random()
</script><template><div /></template>`)).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'vue-ssr-no-random-or-local-time-render', severity: 'warning' })
    ]))
  })

  test('reports v-model on prop bindings', () => {
    expect(diagnose(`<script setup>
const props = defineProps({ name: String })
</script>
<template><input v-model="props.name" /></template>`)).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'vue-model-on-prop', severity: 'error' })
    ]))
  })

  test('reports v-model on v-for scope variables', () => {
    expect(diagnose(`<script setup>
const items = [{ name: 'a' }]
</script>
<template>
  <div v-for="item in items" :key="item.name">
    <input v-model="item" />
  </div>
</template>`)).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'vue-model-on-scope-var', severity: 'error' })
    ]))
  })

  test('reports template v-for key placed on children', () => {
    expect(diagnose(`<template>
  <template v-for="item in items">
    <div :key="item.id">{{ item.name }}</div>
  </template>
</template>`)).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'vue-template-v-for-key-placement', severity: 'error' })
    ]))
  })

  test('reports duplicate keys across v-if and v-else branches', () => {
    expect(diagnose(`<template>
  <div v-if="ok" :key="same">a</div>
  <div v-else :key="same">b</div>
</template>`)).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'vue-if-else-duplicate-key', severity: 'error' })
    ]))
  })

  test('reports mutation of destructured defineProps locals', () => {
    expect(diagnose(`<script setup>
const { count } = defineProps({ count: Number })
count = 1
</script><template><div /></template>`)).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'vue-prop-mutated', severity: 'error' })
    ]))
  })

  test('reports removed .sync and .native modifiers', () => {
    const diagnostics = diagnose(`<template>
  <input v-bind:title.sync="title" />
  <Comp @click.native="onClick" />
</template>`)
    expect(diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'vue-v-bind-sync-removed', severity: 'error' }),
      expect.objectContaining({ code: 'vue-v-on-native-removed', severity: 'error' })
    ]))
  })

  test('reports removed filters in interpolations', () => {
    expect(diagnose('<template><div>{{ msg | upper }}</div></template>')).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'vue-filters-removed', severity: 'error' })
    ]))
  })

  test('keeps Vue 2.7 template syntax and common diagnostics version-correct', () => {
    const diagnostics = diagnoseForVue(`<template>
  <article v-html="content">{{ msg | upper }}</article>
  <input v-bind:title.sync="title" />
  <Comp @click.native="onClick" />
  <template v-for="item in items"><div :key="item.id">{{ item.name }}</div></template>
</template>`, '2.7.16')
    const codes = diagnostics.map((diagnostic) => diagnostic.code)

    expect(codes).toContain('vue-security-restrict-v-html')
    expect(codes).not.toContain('vue-filters-removed')
    expect(codes).not.toContain('vue-v-bind-sync-removed')
    expect(codes).not.toContain('vue-v-on-native-removed')
    expect(codes).not.toContain('vue-template-v-for-key-placement')
  })

  test('enables Vue 3.4 and 3.5 APIs only at their introduction versions', () => {
    const source = `<script setup>
import { ref } from 'vue'
const props = defineProps({ modelValue: String })
const emit = defineEmits(['update:modelValue'])
const input = ref(null)
</script><template><input ref="input" /></template>`

    const vue33 = diagnoseForVue(source, '3.3.13').map((diagnostic) => diagnostic.code)
    const vue34 = diagnoseForVue(source, '3.4.38').map((diagnostic) => diagnostic.code)
    const vue35 = diagnoseForVue(source, '3.5.39').map((diagnostic) => diagnostic.code)

    expect(vue33).not.toContain('vue-prefer-define-model')
    expect(vue34).toContain('vue-prefer-define-model')
    expect(vue34).not.toContain('vue-prefer-use-template-ref')
    expect(vue35).toContain('vue-prefer-use-template-ref')
  })

  test('reports KeepAlive with multiple children', () => {
    expect(diagnose('<template><KeepAlive><A /><B /></KeepAlive></template>')).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'vue-keepalive-single-child', severity: 'error' })
    ]))
  })

  test('reports NaN keys', () => {
    expect(diagnose('<template><div :key="NaN">x</div></template>')).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'vue-invalid-key-nan', severity: 'error' })
    ]))
  })

  test('reports async setup without suspense', () => {
    expect(diagnose(`<script>
export default {
  async setup() {
    await Promise.resolve()
    return {}
  }
}
</script><template><div /></template>`)).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'vue-async-setup-without-suspense', severity: 'warning' })
    ]))
  })

  test('reports duplicate named slots', () => {
    expect(diagnose(`<template>
  <Comp>
    <template #default>a</template>
    <template #default>b</template>
  </Comp>
</template>`)).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'vue-slot-duplicate-name', severity: 'error' })
    ]))
  })
  test('reports mixed component and template slot usage', () => {
    expect(diagnose(`<template>
  <Comp v-slot="scope">
    <template #header>h</template>
    {{ scope }}
  </Comp>
</template>`)).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'vue-slot-mixed-usage', severity: 'error' })
    ]))
  })

  test('reports deprecated @vnode-* hooks', () => {
    expect(diagnose(`<template>
  <div @vnode-mounted="onMountedHook">a</div>
</template>`)).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'vue-vnode-hook-prefix', severity: 'error' })
    ]))
  })

  test('reports useModel with undeclared prop name', () => {
    expect(diagnose(`<script setup>
import { useModel } from 'vue'
const props = defineProps({ modelValue: String })
const missing = useModel(props, 'missing')
</script><template><div /></template>`)).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'vue-usemodel-undeclared-prop', severity: 'error' })
    ]))
  })

  test('reports useModel without required arguments', () => {
    expect(diagnose(`<script setup>
import { useModel } from 'vue'
const m = useModel()
</script><template><div /></template>`)).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'vue-usemodel-missing-prop', severity: 'error' })
    ]))
  })

  test('reports v-else without adjacent v-if', () => {
    expect(diagnose('<template><div v-else>no if</div></template>')).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'vue-else-without-if', severity: 'error' })
    ]))
  })

  test('reports missing v-if and v-for expressions', () => {
    const diagnostics = diagnose('<template><div v-if /><div v-for /></template>')
    expect(diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'vue-if-missing-expression', severity: 'error' }),
      expect.objectContaining({ code: 'vue-for-missing-expression', severity: 'error' })
    ]))
  })

  test('reports bare data-allow-mismatch without reason', () => {
    expect(diagnose('<template><span data-allow-mismatch>x</span></template>')).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'vue-data-allow-mismatch-surgical', severity: 'warning' })
    ]))
  })

  test('does not report data-allow-mismatch when reason comment exists', () => {
    expect(diagnose(`<template>
  <!-- allow-mismatch-reason: clock tick -->
  <span data-allow-mismatch>x</span>
</template>`).filter((item) => item.code === 'vue-data-allow-mismatch-surgical')).toEqual([])
  })
  test('gates watch once and numeric deep options by Vue minor version', () => {
    const source = `<script setup>
import { ref, watch } from 'vue'
const count = ref(0)
watch(count, () => {}, { once: true, deep: 2 })
</script><template><div /></template>`
    expect(diagnoseForVue(source, '3.3.13').map((diagnostic) => diagnostic.code)).toEqual(expect.arrayContaining([
      'vue-watch-once-unsupported',
      'vue-watch-numeric-deep-unsupported'
    ]))
    expect(diagnoseForVue(source, '3.4.38').map((diagnostic) => diagnostic.code)).not.toContain(
      'vue-watch-once-unsupported'
    )
    expect(diagnoseForVue(source, '3.5.33').map((diagnostic) => diagnostic.code)).not.toEqual(expect.arrayContaining([
      'vue-watch-once-unsupported',
      'vue-watch-numeric-deep-unsupported'
    ]))
  })

  test('reports Vue 2.7 reactive and readonly targets unsupported by its runtime', () => {
    const diagnostics = diagnoseForVue(`<script setup>
import { reactive, readonly } from 'vue'
const list = reactive([])
const cache = reactive(new Map())
const frozen = readonly(Object.freeze({ count: 0 }))
</script><template><div /></template>`, '2.7.16')
    expect(diagnostics.map((diagnostic) => diagnostic.code)).toEqual(expect.arrayContaining([
      'vue2-reactive-root-unsupported',
      'vue2-readonly-target-unsupported'
    ]))
    expect(diagnoseForVue(`<script setup>
import { reactive, readonly } from 'vue'
const list = reactive([])
const cache = readonly(new Map())
</script><template><div /></template>`, '3.5.33').map((diagnostic) => diagnostic.code)).not.toEqual(
      expect.arrayContaining(['vue2-reactive-root-unsupported', 'vue2-readonly-target-unsupported'])
    )
  })

  test('reports writes to readonly computed and useTemplateRef bindings', () => {
    const diagnostics = diagnoseForVue(`<script setup>
import { computed, ref, useTemplateRef } from 'vue'
const source = ref(1)
const total = computed(() => source.value * 2)
const input = useTemplateRef('input')
total.value = 4
input.value = null
</script><template><input ref="input" /></template>`, '3.5.33')
    expect(diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'vue-computed-readonly-write', severity: 'error' }),
      expect.objectContaining({ code: 'vue-use-template-ref-mutation', severity: 'error' })
    ]))
    expect(diagnoseForVue(`<script setup>
import { computed, ref } from 'vue'
const source = ref(1)
const total = computed({ get: () => source.value, set: value => { source.value = value } })
total.value = 4
</script><template><div /></template>`, '3.5.33').map((diagnostic) => diagnostic.code)).not.toContain(
      'vue-computed-readonly-write'
    )
  })

  test('reports stopped effect scope reuse and versioned pause methods', () => {
    const stopped = diagnoseForVue(`<script setup>
import { effectScope } from 'vue'
const scope = effectScope()
scope.stop()
scope.run(() => {})
</script><template><div /></template>`, '3.5.33')
    expect(stopped).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'vue-effect-scope-inactive-run', severity: 'error' })
    ]))
    const oldRuntime = diagnoseForVue(`<script setup>
import { effectScope, watchEffect } from 'vue'
const scope = effectScope()
const handle = watchEffect(() => {})
scope.pause()
handle.resume()
</script><template><div /></template>`, '3.4.38')
    expect(oldRuntime.map((diagnostic) => diagnostic.code)).toEqual(expect.arrayContaining([
      'vue-effect-scope-pause-resume-unsupported',
      'vue-watch-handle-pause-resume-unsupported'
    ]))
  })

  test('validates async component loaders and Vue 2 suspensible options', () => {
    const invalid = diagnoseForVue(`<script setup>
import { defineAsyncComponent } from 'vue'
const A = defineAsyncComponent(import('./A.vue'))
const B = defineAsyncComponent({ loadingComponent: A })
</script><template><div /></template>`, '3.5.33')
    expect(invalid.filter((diagnostic) => diagnostic.code === 'vue-async-component-invalid-loader')).toHaveLength(2)
    const vue2 = diagnoseForVue(`<script setup>
import { defineAsyncComponent } from 'vue'
const A = defineAsyncComponent({ loader: () => import('./A.vue'), suspensible: true })
</script><template><div /></template>`, '2.7.16')
    expect(vue2).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'vue2-async-component-suspensible' })
    ]))
  })

  test('validates Vue 3.5 useTemplateRef keys', () => {
    const diagnostics = diagnoseForVue(`<script setup>
import { useTemplateRef } from 'vue'
const first = useTemplateRef('input')
const duplicate = useTemplateRef('input')
const missing = useTemplateRef('missing')
</script><template><input ref="input" /></template>`, '3.5.33')
    expect(diagnostics.map((diagnostic) => diagnostic.code)).toEqual(expect.arrayContaining([
      'vue-use-template-ref-duplicate',
      'vue-use-template-ref-missing'
    ]))
    expect(diagnoseForVue(`<script setup>
import { useTemplateRef } from 'vue'
const missing = useTemplateRef('missing')
</script><template><div /></template>`, '3.4.38').map((diagnostic) => diagnostic.code)).not.toContain(
      'vue-use-template-ref-missing'
    )
  })

  test('reports deterministic Vue 3 app API misuse', () => {
    const diagnostics = diagnoseForVue(`<script setup>
import { createApp } from 'vue'
const plugin = { install() {} }
const app = createApp({}, 1)
app.unmount()
app.mount('#app')
app.mount('#other')
app.use(plugin)
app.use(plugin)
app.component('Panel', {})
app.component('Panel', {})
app.config = {}
app.onUnmount(true)
</script><template><div /></template>`, '3.5.33')
    const appDiagnostics = diagnostics.filter((diagnostic) => diagnostic.code === 'vue-app-api-misuse')
    expect(appDiagnostics).toHaveLength(7)
    expect(new Set(appDiagnostics.map((diagnostic) => diagnostic.severity))).toEqual(
      new Set(['error', 'warning'])
    )
  })

  test('reports provide from mounted lifecycle callbacks', () => {
    const diagnostics = diagnoseForVue(`<script setup>
import { onMounted, provide } from 'vue'
onMounted(() => provide('key', 'value'))
</script><template><div /></template>`, '3.5.33')
    expect(diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'vue-provide-after-setup', severity: 'error' })
    ]))
  })

  test('reports Vue 2 invalid triggerRef targets and async setup', () => {
    const diagnostics = diagnoseForVue(`<script>
import { reactive, triggerRef } from 'vue'
const state = reactive({ count: 0 })
triggerRef(state)
export default {
  async setup() {
    return { state }
  }
}
</script><template><div /></template>`, '2.7.16')
    expect(diagnostics.map((diagnostic) => diagnostic.code)).toEqual(expect.arrayContaining([
      'vue2-trigger-ref-invalid-target',
      'vue2-async-setup-unsupported'
    ]))
    expect(diagnostics.map((diagnostic) => diagnostic.code)).not.toContain(
      'vue-async-setup-without-suspense'
    )
  })
  test('reports customRef trigger calls from getters', () => {
    const diagnostics = diagnose(`<script setup>
import { customRef } from 'vue'
const value = customRef((track, trigger) => ({
  get() {
    track()
    trigger()
    return 1
  },
  set() {
    trigger()
  }
}))
</script><template><div /></template>`)
    expect(diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'vue-custom-ref-trigger-in-get', severity: 'warning' })
    ]))
    expect(diagnostics.map((diagnostic) => diagnostic.code)).not.toContain(
      'vue-custom-ref-incomplete-contract'
    )
  })
  test('reports invalid Vue 2 set/delete targets and array keys', () => {
    const diagnostics = diagnoseForVue(`<script setup>
import { set, del } from 'vue'
set([], 'name', 1)
del(null, 'value')
const editor = { mode: { set() {} } }
editor.mode.set('readonly')
</script><template><div /></template>`, '2.7.16')
    expect(diagnostics.filter(
      (diagnostic) => diagnostic.code === 'vue2-observer-set-delete-invalid-target'
    )).toHaveLength(2)
    expect(diagnoseForVue(`<script setup>
import { set } from 'vue'
set([], 0, 'value')
</script><template><div /></template>`, '2.7.16').map((diagnostic) => diagnostic.code)).not.toContain(
      'vue2-observer-set-delete-invalid-target'
    )
  })

  test('validates setup context expose calls', () => {
    const diagnostics = diagnoseForVue(`<script>
export default {
  setup(_props, { expose }) {
    expose({ focus() {} })
    expose(true)
    return {}
  }
}
</script><template><div /></template>`, '3.5.33')
    const exposeDiagnostics = diagnostics.filter(
      (diagnostic) => diagnostic.code === 'vue-setup-context-expose-misuse'
    )
    expect(exposeDiagnostics).toHaveLength(2)
    expect(new Set(exposeDiagnostics.map((diagnostic) => diagnostic.severity))).toEqual(
      new Set(['error', 'warning'])
    )
  })

  test('validates Vue 3 injection key and factory flag types', () => {
    const diagnostics = diagnoseForVue(`<script setup>
import { inject, provide } from 'vue'
provide(1, 'value')
inject()
inject('key', () => 'value', 'factory')
</script><template><div /></template>`, '3.5.33')
    expect(diagnostics.filter(
      (diagnostic) => diagnostic.code === 'vue-injection-key-invalid'
    )).toHaveLength(3)
  })

  test('reports toRaw references that escape through return values', () => {
    const diagnostics = diagnose(`<script setup>
import { reactive, toRaw } from 'vue'
const state = reactive({ count: 0 })
function exposeRaw() {
  const raw = toRaw(state)
  return raw
}
const same = toRaw(state) === state
</script><template><div /></template>`)
    expect(diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'vue-to-raw-long-lived', severity: 'warning' })
    ]))
    expect(diagnostics.filter(
      (diagnostic) => diagnostic.code === 'vue-to-raw-long-lived'
    )).toHaveLength(1)
  })
  test('reports duplicate provide keys within one setup scope', () => {
    const diagnostics = diagnoseForVue(`<script setup>
import { provide } from 'vue'
provide('theme', 'dark')
provide('theme', 'light')
</script><template><div /></template>`, '3.5.33')
    expect(diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'vue-duplicate-provide-key', severity: 'warning' })
    ]))
  })

  test('reports setup and asset resolution APIs at regular script module scope', () => {
    const diagnostics = diagnoseForVue(`<script>
import { onMounted, resolveComponent } from 'vue'
onMounted(() => {})
const Panel = resolveComponent('Panel')
export default {
  setup() {
    onMounted(() => {})
    return { Panel }
  }
}
</script><template><div /></template>`, '3.5.33')
    expect(diagnostics.filter(
      (diagnostic) => diagnostic.code === 'vue-setup-api-outside-context'
    )).toHaveLength(1)
    expect(diagnostics.filter(
      (diagnostic) => diagnostic.code === 'vue-asset-resolution-outside-context'
    )).toHaveLength(1)
  })
  test('reports isShallow branches that are statically false', () => {
    const diagnostics = diagnoseForVue(`<script setup>
import { isShallow, reactive, shallowReactive } from 'vue'
const deep = reactive({ count: 0 })
const shallow = shallowReactive({ count: 0 })
if (isShallow(deep)) console.log('never')
if (isShallow(shallow)) console.log('possible')
</script><template><div /></template>`, '3.5.33')
    expect(diagnostics.filter(
      (diagnostic) => diagnostic.code === 'vue-is-shallow-static-false'
    )).toHaveLength(1)
  })
  test('reports watchEffect options that are never supported', () => {
    const diagnostics = diagnoseForVue(`<script setup>
import { watchEffect } from 'vue'
watchEffect(() => {}, { deep: true, immediate: true, once: true })
</script><template><div /></template>`, '3.5.33')
    expect(diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'vue-watch-effect-options-invalid', severity: 'warning' })
    ]))
  })

  test('reports APIs introduced after the target Vue version', () => {
    const vue33 = diagnoseForVue(`<script setup>
import { onWatcherCleanup, useId, useTemplateRef } from 'vue'
defineModel()
onWatcherCleanup(() => {})
useId()
useTemplateRef('input')
</script><template><input ref="input" /></template>`, '3.3.13')
    expect(vue33.filter(
      (diagnostic) => diagnostic.code === 'vue-api-version-unsupported'
    )).toHaveLength(4)
    expect(diagnoseForVue(`<script setup>
import { onWatcherCleanup, useId, useTemplateRef } from 'vue'
onWatcherCleanup(() => {})
useId()
useTemplateRef('input')
</script><template><input ref="input" /></template>`, '3.5.33').map(
      (diagnostic) => diagnostic.code
    )).not.toContain('vue-api-version-unsupported')
  })

  test('gates app methods introduced in later Vue 3 minors', () => {
    const diagnostics = diagnoseForVue(`<script setup>
import { createApp } from 'vue'
const app = createApp({})
app.runWithContext(() => {})
app.onUnmount(() => {})
</script><template><div /></template>`, '3.2.47')
    expect(diagnostics.filter(
      (diagnostic) => diagnostic.code === 'vue-app-api-version-unsupported'
    )).toHaveLength(2)
  })

  test('reports additional unsupported Vue 2 reactive constructors', () => {
    const diagnostics = diagnoseForVue(`<script setup>
import { reactive, readonly } from 'vue'
reactive(new Date())
readonly(new RegExp('x'))
</script><template><div /></template>`, '2.7.16')
    expect(diagnostics.map((diagnostic) => diagnostic.code)).toEqual(expect.arrayContaining([
      'vue2-reactive-root-unsupported',
      'vue2-readonly-target-unsupported'
    ]))
  })
  test('reports mutating methods on readonly arrays but not shallow nested arrays', () => {
    const diagnostics = diagnose(`<script setup>
import { readonly, shallowReadonly } from 'vue'
const deep = readonly([])
const shallow = shallowReadonly({ list: [] })
deep.push(1)
shallow.list.push(1)
</script><template><div /></template>`)
    expect(diagnostics.filter(
      (diagnostic) => diagnostic.code === 'vue-readonly-mutation'
    )).toHaveLength(1)
  })
  test('accepts null app root props and mutually exclusive provide branches', () => {
    const diagnostics = diagnoseForVue(`<script setup>
import { createApp, provide } from 'vue'
createApp({}, null)
if (Math.random() > 0.5) {
  provide('theme', 'dark')
} else {
  provide('theme', 'light')
}
</script><template><div /></template>`, '3.5.33')
    expect(diagnostics.map((diagnostic) => diagnostic.code)).not.toEqual(expect.arrayContaining([
      'vue-app-api-misuse',
      'vue-duplicate-provide-key'
    ]))
  })

  test('does not confuse a shadowed variable with an escaping toRaw binding', () => {
    const diagnostics = diagnose(`<script setup>
import { reactive, toRaw } from 'vue'
const state = reactive({ count: 0 })
const raw = toRaw(state)
function identity(raw) {
  return raw
}
identity(state)
</script><template><div /></template>`)
    expect(diagnostics.map((diagnostic) => diagnostic.code)).not.toContain(
      'vue-to-raw-long-lived'
    )
  })
  test('does not guess version incompatibilities when Vue version is unknown', () => {
    const file = '/project/src/App.vue'
    const source = `<script setup>
import { effectScope, ref, useTemplateRef, watch } from 'vue'
const count = ref(0)
watch(count, () => {}, { once: true, deep: 2 })
defineModel()
useTemplateRef('input')
const scope = effectScope()
scope.pause()
</script><template><input ref="input" /></template>`
    const diagnostics = diagnoseVueSource({
      file,
      parsed: parseVueSource(source, file),
      source,
      assumeLatestVueVersion: false
    })
    expect(diagnostics.map((diagnostic) => diagnostic.code)).not.toEqual(expect.arrayContaining([
      'vue-api-version-unsupported',
      'vue-effect-scope-pause-resume-unsupported',
      'vue-watch-numeric-deep-unsupported',
      'vue-watch-once-unsupported'
    ]))
  })

  test('does not apply Vue 3 minor compatibility rules to a future major', () => {
    const diagnostics = diagnoseForVue(`<script setup>
import { effectScope, ref, watch } from 'vue'
const count = ref(0)
watch(count, () => {}, { once: true, deep: 2 })
defineModel()
const scope = effectScope()
scope.pause()
</script><template><div /></template>`, '4.0.0')
    expect(diagnostics.map((diagnostic) => diagnostic.code)).not.toEqual(expect.arrayContaining([
      'vue-api-version-unsupported',
      'vue-effect-scope-pause-resume-unsupported',
      'vue-watch-numeric-deep-unsupported',
      'vue-watch-once-unsupported'
    ]))
  })

  test('recognizes aliased and namespace Vue imports across reactive call sites', () => {
    const aliasCodes = diagnose(`<script setup>
import { onUpdated as afterUpdate, ref as makeRef, watch as observe } from 'vue'
const count = makeRef(0)
observe(count.value, () => {})
afterUpdate(() => { count.value += 1 })
</script><template><div /></template>`).map((diagnostic) => diagnostic.code)
    const namespaceCodes = diagnose(`<script setup>
import * as Vue from 'vue'
const count = Vue.ref(0)
Vue.watch(count.value, () => {})
</script><template><div /></template>`).map((diagnostic) => diagnostic.code)

    expect(aliasCodes).toContain('vue-watch-reactive-property')
    expect(aliasCodes).toContain('vue-lifecycle-no-mutation-in-onupdated')
    expect(namespaceCodes).toContain('vue-watch-reactive-property')
  })

  test('ignores same-named local, parameter, other-library, and object methods', () => {
    const diagnostics = diagnose(`<script setup>
import { ref, watch, createApp } from 'vue'
import { ref as otherRef } from 'other-library'
function local(ref, watch, createApp) {
  const count = ref(0)
  watch(count.value, () => {})
  const app = createApp({})
  app.unmount()
  return count + 1
}
{
  const ref = (value) => value
  const count = ref(0)
  count + 1
}
const foreign = otherRef(0)
foreign + 1
const helpers = { ref: (value) => value }
const plain = helpers.ref(0)
plain + 1
</script><template><div /></template>`)

    expect(diagnostics.map((diagnostic) => diagnostic.code)).not.toEqual(expect.arrayContaining([
      'vue-app-api-misuse',
      'vue-ref-as-operand',
      'vue-watch-reactive-property'
    ]))
  })

  test('tracks createApp receivers by lexical binding identity', () => {
    const diagnostics = diagnoseForVue(`<script setup>
import { createApp as boot } from 'vue'
const app = boot({})
function nested(app) {
  app.unmount()
}
app.unmount()
</script><template><div /></template>`, '3.5.33')

    expect(diagnostics.filter((diagnostic) => diagnostic.code === 'vue-app-api-misuse')).toHaveLength(1)
  })

  test('treats compiler macros as unshadowed script-setup bindings only', () => {
    const regular = diagnose(`<script>
const props = defineProps({ count: Number })
props.count = 1
</script><template><div /></template>`)
    const shadowed = diagnose(`<script setup>
function defineProps() { return { count: 0 } }
const props = defineProps()
props.count = 1
</script><template><div /></template>`)
    const compilerMacro = diagnose(`<script setup>
const props = defineProps({ count: Number })
props.count = 1
</script><template><div /></template>`)

    expect(regular.map((diagnostic) => diagnostic.code)).not.toContain('vue-prop-mutated')
    expect(shadowed.map((diagnostic) => diagnostic.code)).not.toContain('vue-prop-mutated')
    expect(compilerMacro.map((diagnostic) => diagnostic.code)).toContain('vue-prop-mutated')
  })

  test('tracks defineProps results by lexical binding identity', () => {
    const objectDiagnostics = diagnose(`<script setup>
import { watch } from 'vue'
const props = defineProps({ foo: Number })
function parameterScope(props) {
  props.foo = 1
  watch(props.foo, () => {})
}
{
  const props = { foo: 0 }
  props.foo = 1
  watch(props.foo, () => {})
}
props.foo = 1
watch(props.foo, () => {})
</script><template><div /></template>`)
    const destructuredDiagnostics = diagnose(`<script setup>
import { watch } from 'vue'
const { foo: localFoo } = defineProps({ foo: Number })
function parameterScope(localFoo) {
  localFoo++
  watch(localFoo, () => {})
}
{
  let localFoo = 0
  localFoo++
  watch(localFoo, () => {})
}
localFoo++
watch(localFoo, () => {})
</script><template><div /></template>`)
    const wrappedObjectDiagnostics = diagnose(`<script setup lang="ts">
const props = withDefaults(defineProps<{ foo?: number }>(), { foo: 0 })
props.foo = 1
</script><template><div /></template>`)
    const wrappedDestructuredDiagnostics = diagnose(`<script setup lang="ts">
import { watch } from 'vue'
const { foo } = withDefaults(defineProps<{ foo?: number }>(), { foo: 0 })
foo++
watch(foo, () => {})
</script><template><div /></template>`)
    const shadowedWrapperDiagnostics = diagnose(`<script setup>
function withDefaults(value) { return value }
const props = withDefaults(defineProps({ foo: Number }), { foo: 0 })
props.foo = 1
</script><template><div /></template>`)
    const shadowedInnerDiagnostics = diagnose(`<script setup>
function defineProps() { return { foo: 0 } }
const props = withDefaults(defineProps(), { foo: 0 })
props.foo = 1
</script><template><div /></template>`)

    expect(objectDiagnostics.filter(
      (diagnostic) => diagnostic.code === 'vue-prop-mutated'
    )).toHaveLength(1)
    expect(objectDiagnostics.filter(
      (diagnostic) => diagnostic.code === 'vue-watch-reactive-property'
    )).toHaveLength(1)
    expect(destructuredDiagnostics.filter(
      (diagnostic) => diagnostic.code === 'vue-prop-mutated'
    )).toHaveLength(1)
    expect(destructuredDiagnostics.filter(
      (diagnostic) => diagnostic.code === 'vue-defineprops-watch-getter'
    )).toHaveLength(1)
    expect(wrappedObjectDiagnostics.filter(
      (diagnostic) => diagnostic.code === 'vue-prop-mutated'
    )).toHaveLength(1)
    expect(wrappedDestructuredDiagnostics.filter(
      (diagnostic) => diagnostic.code === 'vue-prop-mutated'
    )).toHaveLength(1)
    expect(wrappedDestructuredDiagnostics.filter(
      (diagnostic) => diagnostic.code === 'vue-defineprops-watch-getter'
    )).toHaveLength(1)
    expect(shadowedWrapperDiagnostics.map((diagnostic) => diagnostic.code)).not.toContain(
      'vue-prop-mutated'
    )
    expect(shadowedInnerDiagnostics.map((diagnostic) => diagnostic.code)).not.toContain(
      'vue-prop-mutated'
    )
  })

  test('uses auto-imported Vue APIs only with explicit evidence', () => {
    const file = '/project/src/App.vue'
    const source = `<script setup>
const count = ref(0)
count + 1
</script><template><div /></template>`
    const parsed = parseVueSource(source, file)
    const withoutEvidence = diagnoseVueSource({ file, parsed, source })
    const withEvidence = diagnoseVueSource({
      file,
      parsed,
      source,
      autoImports: [{ local: 'ref', imported: 'ref' }]
    })

    expect(withoutEvidence.map((diagnostic) => diagnostic.code)).not.toContain('vue-ref-as-operand')
    expect(withEvidence.map((diagnostic) => diagnostic.code)).toContain('vue-ref-as-operand')
  })

  test('keeps shadowed JavaScript globals separate from framework bindings', () => {
    const diagnostics = diagnose(`<script setup>
const setInterval = (callback) => callback()
setInterval(() => {}, 1000)
</script><template><div /></template>`)

    expect(diagnostics.map((diagnostic) => diagnostic.code)).not.toContain(
      'vue-lifecycle-require-cleanup'
    )
  })

  test('uses Vue binding identity for SSR lifecycle boundaries', () => {
    const aliased = diagnose(`<script setup>
import { createSSRApp, onMounted as afterMount } from 'vue'
createSSRApp({})
afterMount(() => window.innerWidth)
</script><template><div /></template>`)
    const shadowed = diagnose(`<script setup>
import { createSSRApp } from 'vue'
createSSRApp({})
function onMounted(callback) { callback() }
onMounted(() => window.innerWidth)
</script><template><div /></template>`)

    expect(aliased.map((diagnostic) => diagnostic.code)).not.toContain(
      'vue-ssr-no-browser-api-in-setup'
    )
    expect(shadowed.map((diagnostic) => diagnostic.code)).toContain(
      'vue-ssr-no-browser-api-in-setup'
    )
  })

  test('recognizes watcher aliases when cleanup is registered after await', () => {
    const diagnostics = diagnose(`<script setup>
import { onWatcherCleanup as cleanup, ref, watch as observe } from 'vue'
const source = ref('')
observe(source, async () => {
  await fetch('/api')
  cleanup(() => {})
})
</script><template><div /></template>`)

    expect(diagnostics.map((diagnostic) => diagnostic.code)).toContain(
      'vue-onwatcher-cleanup-after-await'
    )
  })

  test('does not leak Vue-produced binding identities into shadowing parameters or blocks', () => {
    const diagnostics = diagnoseForVue(`<script setup>
import {
  computed,
  createApp,
  effectScope,
  reactive,
  readonly,
  ref,
  shallowReactive,
  shallowReadonly,
  shallowRef,
  watch
} from 'vue'
const count = ref(0)
const state = reactive({ nested: { value: 0 } })
const locked = readonly({ nested: { value: 0 } })
const shallowState = shallowReactive({ nested: { value: 0 } })
const shallowLocked = shallowReadonly({ nested: { value: 0 } })
const shallow = shallowRef({ nested: { value: 0 } })
const derived = computed(() => count.value)
const handle = watch(count, () => {})
const scope = effectScope()
const app = createApp({})
function nested(count, state, locked, shallowState, shallowLocked, shallow, derived, handle, scope, app) {
  count + 1
  state = {}
  locked.nested.value = 1
  shallowState.nested.value = 1
  shallowLocked.value = 1
  shallow.value.nested.value = 1
  derived.value = 1
  handle.pause()
  scope.stop()
  scope.run(() => {})
  app.unmount()
}
{
  const count = 1
  count + 1
}
</script><template><div /></template>`, '3.4.38')
    const codes = diagnostics.map((diagnostic) => diagnostic.code)

    expect(codes).not.toEqual(expect.arrayContaining([
      'vue-app-api-misuse',
      'vue-computed-readonly-write',
      'vue-effect-scope-inactive-run',
      'vue-reactive-reassignment',
      'vue-readonly-mutation',
      'vue-ref-as-operand',
      'vue-shallow-reactive-nested-mutation',
      'vue-shallow-ref-nested-mutation',
      'vue-watch-handle-pause-resume-unsupported'
    ]))
  })

  test('does not leak outer ref identity into class, enum, or namespace declarations', () => {
    const diagnostics = diagnose(`<script setup lang="ts">
import { ref } from 'vue'
const value = ref(0)
const Expression = class value extends value {
  method() { return value + 1 }
  static { value + 1 }
}
class value extends value {
  method() { return value + 1 }
  static { value + 1 }
}
function enumScope() {
  enum Example { value = 1, B = value + 1 }
  enum value { A }
  return value + 1
}
function namespaceScope() {
  namespace value { export const n = 1 }
  return value + 1
}
value + 1
</script><template><div /></template>`)
    const refDiagnostics = diagnostics.filter(
      (diagnostic) => diagnostic.code === 'vue-ref-as-operand'
    )

    expect(refDiagnostics).toHaveLength(1)
    expect(refDiagnostics[0]?.evidence[0]?.line).toBe(21)
  })

  test('does not report shadowed browser globals in SSR-signaled setup code', () => {
    const diagnostics = diagnose(`<script setup>
import { createSSRApp } from 'vue'
const window = { innerWidth: 100 }
function read(document) {
  return window.innerWidth + document.body.clientWidth
}
</script><template><div /></template>`)

    expect(diagnostics.map((diagnostic) => diagnostic.code)).not.toContain(
      'vue-ssr-no-browser-api-in-setup'
    )
  })

  test('ignores browser-global spellings used only as object keys and member names', () => {
    const diagnostics = diagnose(`<script setup>
import { createSSRApp } from 'vue'
createSSRApp({})
const settings = { window: 1, document() { return 1 } }
settings.window
settings.document()
</script><template><div /></template>`)

    expect(diagnostics.map((diagnostic) => diagnostic.code)).not.toContain(
      'vue-ssr-no-browser-api-in-setup'
    )
  })

  test('keeps shorthand, computed, and globalThis browser-global accesses as value references', () => {
    const diagnostics = diagnose(`<script setup>
import { createSSRApp } from 'vue'
createSSRApp({})
const shorthand = { window }
const computedMember = shorthand[window]
const computedKey = { [window]: 1 }
const width = globalThis.window.innerWidth
const body = globalThis['document'].body
</script><template><div /></template>`)

    expect(diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: 'vue-ssr-no-browser-api-in-setup',
        message: expect.stringMatching(/^window /)
      }),
      expect.objectContaining({
        code: 'vue-ssr-no-browser-api-in-setup',
        message: expect.stringMatching(/^document /)
      })
    ]))
  })

  test('does not treat shadowed browser constructors as long-lived global resources', () => {
    const diagnostics = diagnose(`<script setup>
class WebSocket {}
const IntersectionObserver = class {}
new WebSocket('/events')
new IntersectionObserver(() => {})
function create(ResizeObserver) {
  return new ResizeObserver(() => {})
}
</script><template><div /></template>`)

    expect(diagnostics.map((diagnostic) => diagnostic.code)).not.toContain(
      'vue-lifecycle-require-cleanup'
    )
  })

  test('recognizes browser constructors accessed through globalThis', () => {
    const diagnostics = diagnose(`<script setup>
new globalThis.WebSocket('/events')
</script><template><div /></template>`)

    expect(diagnostics.map((diagnostic) => diagnostic.code)).toContain(
      'vue-lifecycle-require-cleanup'
    )
  })

  test('recognizes Vue 2 static APIs on the default Vue import', () => {
    const diagnostics = diagnoseForVue(`<script>
import Vue from 'vue'
Vue.set([], 'not-an-index', 1)
Vue.delete(1, 'key')
</script><template><div /></template>`, '2.7.16')

    expect(diagnostics.filter(
      (diagnostic) => diagnostic.code === 'vue2-observer-set-delete-invalid-target'
    )).toHaveLength(2)
  })
})
