/** 题包素材的类型与字节契约；schema、离线编译和运行物化共用，不引入存储或节点运行时。 */
export const EVAL_IMAGE_MIME_TYPES = ['image/png', 'image/jpeg', 'image/webp'] as const
export const EVAL_ASSET_MIME_TYPES = [...EVAL_IMAGE_MIME_TYPES, 'audio/wav'] as const
export type EvalAssetMimeType = (typeof EVAL_ASSET_MIME_TYPES)[number]

export function evalAssetMimeForPath(file: string): EvalAssetMimeType {
  switch (file.slice(file.lastIndexOf('.')).toLowerCase()) {
    case '.png': return 'image/png'
    case '.jpg':
    case '.jpeg': return 'image/jpeg'
    case '.webp': return 'image/webp'
    case '.wav': return 'audio/wav'
    default: throw new Error(`Unsupported eval asset extension: ${file}`)
  }
}

/** 原始音频只走上传节点的 config.files；audio 输出由产品现有派生器产生。 */
export function evalAssetBindingError(asset: { nodeId: string; mimeType: string; portId?: string }, nodeType: string): string | undefined {
  if (asset.mimeType === 'audio/wav') {
    if (nodeType !== 'audio-upload' || asset.portId !== undefined) return 'audio/wav must bind audio-upload config.files without portId'
  } else if (nodeType === 'audio-upload' || (asset.portId === undefined && nodeType !== 'image-upload')) {
    return `reference asset 的 nodeId "${asset.nodeId}" 必须指向 image-upload（要绑到已生成的图像产物请给出 portId）`
  }
  return undefined
}

const tagAt = (bytes: Uint8Array, offset: number, text: string): boolean =>
  [...text].every((character, index) => bytes[offset + index] === character.charCodeAt(0))

export function isWaveBytes(bytes: Uint8Array): boolean {
  return tagAt(bytes, 0, 'RIFF') && tagAt(bytes, 8, 'WAVE')
}

/** 严格接受完整 RIFF/WAVE 整数 PCM；不转码、不修复头部，不把压缩格式伪装为 PCM。 */
function assertPcmWave(bytes: Uint8Array, label: string): void {
  const fail = (): never => { throw new Error(`Invalid PCM WAV bytes: ${label}`) }
  if (bytes.length < 44 || !isWaveBytes(bytes)) fail()
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  if (view.getUint32(4, true) + 8 !== bytes.length) fail()
  let blockAlign: number | undefined
  let dataSize: number | undefined
  let offset = 12
  while (offset < bytes.length) {
    if (offset + 8 > bytes.length) fail()
    const size = view.getUint32(offset + 4, true)
    const start = offset + 8
    const end = start + size
    if (end + (size % 2) > bytes.length) fail()
    if (tagAt(bytes, offset, 'fmt ')) {
      if (blockAlign !== undefined || (size !== 16 && size !== 18)) fail()
      if (view.getUint16(start, true) !== 1 || (size === 18 && view.getUint16(start + 16, true) !== 0)) fail()
      const channels = view.getUint16(start + 2, true)
      const sampleRate = view.getUint32(start + 4, true)
      const byteRate = view.getUint32(start + 8, true)
      const bits = view.getUint16(start + 14, true)
      blockAlign = view.getUint16(start + 12, true)
      if (!channels || !sampleRate || ![8, 16, 24, 32].includes(bits)
        || blockAlign !== channels * bits / 8 || byteRate !== sampleRate * blockAlign) fail()
    } else if (tagAt(bytes, offset, 'data')) {
      if (blockAlign === undefined || dataSize !== undefined || !size || size % blockAlign !== 0) fail()
      dataSize = size
    }
    offset = end + (size % 2)
  }
  if (blockAlign === undefined || dataSize === undefined) fail()
}

/** 校验 MIME 对应的真实字节；WebP 和 WAV 都用 RIFF，必须检查其子类型。 */
export function assertEvalAssetBytes(bytes: Uint8Array, mimeType: string, label: string): void {
  if (mimeType === 'audio/wav') return assertPcmWave(bytes, label)
  const matches = mimeType === 'image/png'
    ? [137, 80, 78, 71, 13, 10, 26, 10].every((byte, index) => bytes[index] === byte)
    : mimeType === 'image/jpeg'
      ? bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255
      : mimeType === 'image/webp' && tagAt(bytes, 0, 'RIFF') && tagAt(bytes, 8, 'WEBP')
  if (!matches) throw new Error(`Eval asset bytes/MIME mismatch (${mimeType}): ${label}`)
}
