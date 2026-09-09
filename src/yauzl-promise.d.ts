declare module 'yauzl-promise' {
  import type { Readable } from 'node:stream'

  export interface Entry {
    filename: string
    uncompressedSize: number
    externalFileAttributes: number
    isEncrypted(): boolean
    openReadStream(options?: { validateCrc32?: boolean }): Promise<Readable>
  }

  export interface Zip extends AsyncIterable<Entry> {
    close(): Promise<void>
  }

  export function open(path: string, options?: {
    strictFilenames?: boolean
    validateEntrySizes?: boolean
    validateFilenames?: boolean
    supportMacArchive?: boolean
  }): Promise<Zip>
}
