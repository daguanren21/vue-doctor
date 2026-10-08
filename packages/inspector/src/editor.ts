import { access, realpath, stat } from 'node:fs/promises'
import { constants as fsConstants } from 'node:fs'
import { extname, isAbsolute, relative, resolve, sep } from 'node:path'
import type { InspectorEditor } from './protocol.js'

const inspectorSourceExtensions: Record<string, true> = {
  '.cjs': true,
  '.css': true,
  '.cts': true,
  '.htm': true,
  '.html': true,
  '.js': true,
  '.jsx': true,
  '.mjs': true,
  '.mts': true,
  '.sass': true,
  '.scss': true,
  '.ts': true,
  '.tsx': true,
  '.vue': true
}
const maxInspectorSourceFileBytes = 512_000

export type EditorName = InspectorEditor

export class EditorOpenError extends Error {
  readonly status: number
  readonly code:
    | 'missing-file'
    | 'outside-root'
    | 'unsupported-file'
    | 'oversized-file'
    | 'missing-editor'
    | 'invalid-request'
    | 'launch-failed'

  constructor(
    message: string,
    options: {
      status: number
      code: EditorOpenError['code']
    }
  ) {
    super(message)
    this.name = 'EditorOpenError'
    this.status = options.status
    this.code = options.code
  }
}

export function getEditorCommand(
  platform: NodeJS.Platform,
  editor: EditorName,
  file: string,
  line = 1,
  column = 1
) {
  const location = `${file}:${line}:${column}`
  if (editor === 'vscode') return { command: 'code', args: ['--goto', location] }
  if (editor === 'cursor') return { command: 'cursor', args: ['--goto', location] }
  if (editor === 'webstorm') return { command: platform === 'win32' ? 'webstorm64.exe' : 'webstorm', args: ['--line', String(line), file] }
  throw new EditorOpenError(`Unsupported editor: ${String(editor)}.`, {
    status: 400,
    code: 'invalid-request'
  })
}

export async function assertSourceFileExists(file: string): Promise<void> {
  try {
    await access(file, fsConstants.F_OK)
  } catch {
    throw new EditorOpenError(`Source file does not exist: ${file}`, {
      status: 404,
      code: 'missing-file'
    })
  }
}

export async function resolveSourceFileWithinRoot(root: string, file: string): Promise<string> {
  const requested = isAbsolute(file) ? file : resolve(root, file)
  await assertSourceFileExists(requested)

  const [resolvedRoot, resolvedFile] = await Promise.all([
    realpath(root),
    realpath(requested)
  ])
  const pathFromRoot = relative(resolvedRoot, resolvedFile)
  if (
    pathFromRoot === '..'
    || pathFromRoot.startsWith(`..${sep}`)
    || isAbsolute(pathFromRoot)
  ) {
    throw new EditorOpenError('Source file is outside the project root.', {
      status: 403,
      code: 'outside-root'
    })
  }
  if (!inspectorSourceExtensions[extname(resolvedFile).toLowerCase()]) {
    throw new EditorOpenError('Inspector can only open supported source files.', {
      status: 403,
      code: 'unsupported-file'
    })
  }
  const fileStats = await stat(resolvedFile)
  if (!fileStats.isFile()) {
    throw new EditorOpenError('Inspector source path is not a file.', {
      status: 400,
      code: 'invalid-request'
    })
  }
  if (fileStats.size > maxInspectorSourceFileBytes) {
    throw new EditorOpenError('Inspector source file is too large.', {
      status: 413,
      code: 'oversized-file'
    })
  }
  return resolvedFile
}

export function editorDisplayName(editor: EditorName): string {
  if (editor === 'vscode') return 'VS Code'
  if (editor === 'cursor') return 'Cursor'
  return 'WebStorm'
}

export function formatEditorLaunchError(
  editor: EditorName,
  command: string,
  cause: unknown
): EditorOpenError {
  const err = cause as NodeJS.ErrnoException | Error | undefined
  const errno = err && 'code' in err ? err.code : undefined
  if (errno === 'ENOENT') {
    return new EditorOpenError(
      `${editorDisplayName(editor)} CLI was not found (${command}). Install the editor shell command or choose another editor.`,
      { status: 502, code: 'missing-editor' }
    )
  }
  const detail = err instanceof Error ? err.message : String(cause)
  return new EditorOpenError(
    `Failed to launch ${editorDisplayName(editor)}: ${detail}`,
    { status: 502, code: 'launch-failed' }
  )
}
