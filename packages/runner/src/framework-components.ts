import { resolveVueVersion, type PackageResolution, type ProjectContext } from '@daguanren21/vue-doctor-core'
import type { VueComponentUsage } from '@daguanren21/vue-doctor-source'

const builtinExports: Record<string, true> = {
  Transition: true, TransitionGroup: true, KeepAlive: true, Teleport: true, Suspense: true
}
const reservedTags: Record<string, true> = {
  ...builtinExports,
  transition: true, 'transition-group': true, 'keep-alive': true, teleport: true, suspense: true
}

/** Framework-owned template work is not a third-party component-library contract. */
export function isFrameworkComponentUsage(
  usage: VueComponentUsage,
  projectContext: ProjectContext | undefined
): boolean {
  const inventory = projectContext?.packages.find((item) => item.targetFiles.includes(usage.file))?.inventory
  if (!inventory || !isVue3(inventory.vue)) return false

  // Vue 3 resolves these exact compiler-reserved tags before setup bindings and
  // registrations. A static `is="vue:Other"` redirect precedes that resolution.
  const redirect = usage.props.find((prop) => prop.name === 'is' && prop.kind === 'static' && prop.value?.startsWith('vue:'))?.value?.slice(4)
  if (redirect !== undefined) return Object.hasOwn(reservedTags, redirect)
  if (Object.hasOwn(reservedTags, usage.tag)) return true

  const origin = usage.origin
  if (origin?.kind !== 'direct-import' || !origin.templateBinding || !origin.package
    || origin.package.subpath || !Object.hasOwn(builtinExports, origin.importedName ?? '')) return false
  const importedPackage = origin.package.packageName
  const identity = inventory.packages[importedPackage]
    ?? Object.values(inventory.packages).find((item) => item.importRoots.includes(importedPackage))
  return isVue3(identity) && identity.importRoots.includes(importedPackage)
}

function isVue3(identity: PackageResolution | undefined): identity is PackageResolution {
  return identity?.canonicalName === 'vue'
    && resolveVueVersion(identity.installedVersion ?? identity.declaredVersion)?.major === 3
}
