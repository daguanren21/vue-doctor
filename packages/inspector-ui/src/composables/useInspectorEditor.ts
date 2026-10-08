import { ref } from 'vue'
import { isInspectorEditor, type InspectorEditor } from '@vue-doctor/inspector-protocol'
export type EditorName = InspectorEditor

type StorageLike = Pick<Storage, 'getItem' | 'setItem'>
type Fetcher = typeof fetch

export interface InspectorEditorOptions {
  storage?: StorageLike
  fetcher?: Fetcher
}

export function useInspectorEditor(endpoint = 'api/open', options: InspectorEditorOptions = {}) {
  const storage = options.storage ?? (typeof localStorage === 'undefined' ? undefined : localStorage)
  const fetcher = options.fetcher ?? fetch
  const saved = storage?.getItem('vue-doctor:editor')
  const editor = ref<EditorName>(isInspectorEditor(saved) ? saved : 'vscode')
  const error = ref<string>()
  const opening = ref(false)

  function setEditor(value: EditorName) {
    editor.value = value
    storage?.setItem('vue-doctor:editor', value)
  }

  async function openFile(file: string, line?: number, column?: number): Promise<boolean> {
    error.value = undefined
    opening.value = true
    try {
      const response = await fetcher(endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          editor: editor.value,
          file,
          ...(line === undefined ? {} : { line }),
          ...(column === undefined ? {} : { column })
        })
      })
      if (!response.ok) {
        let message = defaultEditorError(response.status, editor.value)
        try {
          const payload = await response.json() as { error?: string }
          if (payload.error?.trim()) message = payload.error.trim()
        } catch {
          // Keep status-based fallback when host returns no JSON body.
        }
        error.value = message
        return false
      }
      return true
    } catch (cause) {
      error.value = cause instanceof Error ? cause.message : String(cause)
      return false
    } finally {
      opening.value = false
    }
  }

  return { editor, error, opening, setEditor, openFile }
}

function defaultEditorError(status: number, selected: EditorName): string {
  if (status === 404) {
    return 'Source file does not exist, or the open-editor endpoint was not found.'
  }
  if (status === 502 || status === 500) {
    return `${selected} could not be launched. The editor CLI may be missing from PATH.`
  }
  if (status === 400) {
    return 'Invalid open-editor request.'
  }
  return `Editor request failed (${status}).`
}
