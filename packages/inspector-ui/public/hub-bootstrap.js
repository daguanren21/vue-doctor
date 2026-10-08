/** Open the standalone Doctor entry before its virtual view tabs are announced. */
export default function openDoctorWorkspace(context) {
  if (context.clientType !== 'standalone') return
  const anchor = context.docks.entries.find(entry => entry.id === 'vue-doctor')
  const windowRef = globalThis.window
  if (anchor && windowRef) {
    const frameOrigin = new URL(anchor.url, windowRef.location.href).origin
    const onReady = (event) => {
      const message = event.data
      const frame = context.docks.getStateById('vue-doctor')?.domElements.iframe
      if (event.origin !== frameOrigin || !frame || event.source !== frame.contentWindow
        || message?.channel !== 'devframe:frame-nav' || message.v !== 1
        || message.frameId !== 'vue-doctor' || message.from !== 'frame'
        || (message.type !== 'ready' && message.type !== 'manifest')) return
      const views = ['findings', 'coverage', 'rules', 'audit']
      if (!Array.isArray(message.tabs) || !views.every(id => message.tabs.some(tab => tab?.id === id))) return
      setTimeout(() => {
        // Let the Hub process the manifest before hiding its launch entry.
        if (!views.every(id => context.docks.entries.some(entry => entry.id === `vue-doctor:${id}`))) return
        const currentAnchor = context.docks.entries.find(entry => entry.id === 'vue-doctor')
        if (currentAnchor && currentAnchor.visibility !== 'false') {
          context.docks.register({ ...currentAnchor, visibility: 'false' })
        }
        windowRef.removeEventListener('message', onReady)
      }, 0)
    }
    windowRef.addEventListener('message', onReady)
  }
  // Activation itself waits for this script; defer until its setup has returned.
  setTimeout(() => {
    const selected = context.docks.selectedId
    const available = selected && context.docks.entries.some(entry => entry.id === selected)
    if (!available) {
      void context.docks.switchEntry('vue-doctor').catch(() => {})
    }
  }, 0)
}
