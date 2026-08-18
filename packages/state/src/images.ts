/**
 * 图片附件的纯 node 逻辑：读文件、定 mediaType、量尺寸、按 `imageLimits` 投影自查。
 *
 * 背景（docs/gap-shapes.md §八）：dsh **没有上传接口**——`session.prompt` 的
 * `content` 数组直接塞 `{type:'image', mediaType, data}`（base64），host 收下字节
 * 自己转成持久引用；`imageLimits` 投影是给客户端**提交前**拒超限用的。
 *
 * 本包不许 import ink/react，但必须能在 node:test 里裸跑——读文件用 node:fs，
 * 这是纯 node 代码，正是它该在的地方（章程：别放 tui）。
 */
import { readFile } from 'node:fs/promises'
import { basename, extname, resolve } from 'node:path'
import { homedir } from 'node:os'

/** 上游 v1 附件路径接受的四种栅格格式（`@deepseek-ai/dsh-attachment`）。 */
export type ImageMediaType = 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif'

/** 一张待发的图：base64 字节 + 提交前自查要的元数据。 */
export interface ImageDraft {
  /** 展示名（basename，上游会把路径信息剥掉，我们只存 basename）。 */
  readonly name: string
  readonly mediaType: ImageMediaType
  /** base64 编码的字节（`session.prompt` 的 `data` 字段原样要这个）。 */
  readonly data: string
  /** 未编码的字节数（限额按这个算，不是 base64 长度）。 */
  readonly bytes: number
  /** 嗅探出的像素宽；嗅不出来就不设（像素限额交由 host 裁决）。 */
  readonly width?: number
  readonly height?: number
}

/** `imageLimits` 投影的形状（`ImageAttachmentLimits`，常量在 host 启动时定死）。 */
export interface ImageLimits {
  readonly maxImageBytes: number
  readonly maxImagesPerMessage: number
  readonly maxMessageImageBytes: number
  readonly maxImagePixels: number
  readonly mediaTypes: readonly string[]
}

const EXT_TO_MEDIA: Record<string, ImageMediaType> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
}

/** 按扩展名定 mediaType；不支持的扩展返回 undefined。 */
export function mediaTypeForPath(path: string): ImageMediaType | undefined {
  return EXT_TO_MEDIA[extname(path).toLowerCase()]
}

/**
 * 嗅探图片像素尺寸（四种格式各一段最小解析，不引依赖）。
 * 嗅不出来（损坏、截断、没见过的变体）返回 undefined——
 * 像素限额因此跳过本地检查，交给 host 的权威校验回答。
 */
export function sniffImageDimensions(
  buf: Uint8Array,
  mediaType: ImageMediaType,
): { width: number; height: number } | undefined {
  const u32be = (o: number): number =>
    ((buf[o] ?? 0) << 24) | ((buf[o + 1] ?? 0) << 16) | ((buf[o + 2] ?? 0) << 8) | (buf[o + 3] ?? 0)
  const u16le = (o: number): number => (buf[o] ?? 0) | ((buf[o + 1] ?? 0) << 8)
  const u16be = (o: number): number => ((buf[o] ?? 0) << 8) | (buf[o + 1] ?? 0)

  if (mediaType === 'image/png') {
    // 8 字节签名 + IHDR 长度/类型（8 字节）后就是 width/height（big-endian）。
    if (buf.length < 24 || buf[0] !== 0x89 || buf[1] !== 0x50) return undefined
    const width = u32be(16)
    const height = u32be(20)
    return width > 0 && height > 0 ? { width, height } : undefined
  }
  if (mediaType === 'image/gif') {
    // GIF87a/89a：6 字节头后 logical screen descriptor，宽/高 little-endian。
    if (buf.length < 10 || buf[0] !== 0x47 || buf[1] !== 0x49) return undefined
    const width = u16le(6)
    const height = u16le(8)
    return width > 0 && height > 0 ? { width, height } : undefined
  }
  if (mediaType === 'image/jpeg') {
    // 扫 marker 找 SOF0-SOF15（去掉 DHT/DAC/RST）：`FF Cn` 后第 3-6 字节是高/宽。
    if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) return undefined
    let o = 2
    while (o + 9 <= buf.length) {
      if (buf[o] !== 0xff) return undefined
      const marker = buf[o + 1] ?? 0
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        const height = u16be(o + 5)
        const width = u16be(o + 7)
        return width > 0 && height > 0 ? { width, height } : undefined
      }
      const len = u16be(o + 2)
      if (len < 2) return undefined
      o += 2 + len
    }
    return undefined
  }
  // image/webp：RIFF 头后 VP8/VP8L/VP8X 三种布局。
  if (
    buf.length < 30 ||
    buf[0] !== 0x52 || buf[1] !== 0x49 || buf[2] !== 0x46 || buf[3] !== 0x46 || // RIFF
    buf[8] !== 0x57 || buf[9] !== 0x45 || buf[10] !== 0x42 || buf[11] !== 0x50 // WEBP
  ) {
    return undefined
  }
  const fourcc = String.fromCharCode(buf[12] ?? 0, buf[13] ?? 0, buf[14] ?? 0, buf[15] ?? 0)
  if (fourcc === 'VP8 ') {
    // lossy：帧头里 26 字节起是宽/高（14 位，little-endian）。
    const width = u16le(26) & 0x3fff
    const height = u16le(28) & 0x3fff
    return width > 0 && height > 0 ? { width, height } : undefined
  }
  if (fourcc === 'VP8L') {
    // lossless：21 字节起 4 个字节打包 14 位宽/高。
    const b0 = buf[21] ?? 0
    const b1 = buf[22] ?? 0
    const b2 = buf[23] ?? 0
    const b3 = buf[24] ?? 0
    const width = 1 + (((b1 & 0x3f) << 8) | b0)
    const height = 1 + (((b3 & 0x0f) << 10) | (b2 << 2) | ((b1 & 0xc0) >> 6))
    return { width, height }
  }
  if (fourcc === 'VP8X') {
    // extended：24 字节起 3 字节宽减一、3 字节高减一（little-endian）。
    const width = 1 + ((buf[24] ?? 0) | ((buf[25] ?? 0) << 8) | ((buf[26] ?? 0) << 16))
    const height = 1 + ((buf[27] ?? 0) | ((buf[28] ?? 0) << 8) | ((buf[29] ?? 0) << 16))
    return { width, height }
  }
  return undefined
}

/**
 * 把 `imageLimits` 投影的 unknown 值收成结构化限额。
 * 投影键缺省 = 这台部署没装附件服务（上游注释：跳过自查，让 host 回答），
 * 形状不符视同缺省——都不报错，返回 undefined。
 */
export function imageLimitsFromProjection(value: unknown): ImageLimits | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const v = value as Record<string, unknown>
  const nums = ['maxImageBytes', 'maxImagesPerMessage', 'maxMessageImageBytes', 'maxImagePixels'] as const
  for (const key of nums) {
    if (typeof v[key] !== 'number' || !Number.isFinite(v[key])) return undefined
  }
  if (!Array.isArray(v.mediaTypes) || !v.mediaTypes.every((m) => typeof m === 'string')) return undefined
  return {
    maxImageBytes: v.maxImageBytes as number,
    maxImagesPerMessage: v.maxImagesPerMessage as number,
    maxMessageImageBytes: v.maxMessageImageBytes as number,
    maxImagePixels: v.maxImagePixels as number,
    mediaTypes: v.mediaTypes as string[],
  }
}

/**
 * 提交前自查。返回一条可读的拒绝原因；通过则返回 undefined。
 * 聚合检查（条数、总量）在发送前对**整组**跑；单图检查（字节、像素、类型）
 * 挂图时与发送前各跑一次——挂的时候拒得越早，用户越不用猜。
 */
export function checkImageLimits(
  drafts: readonly ImageDraft[],
  limits: ImageLimits,
): string | undefined {
  if (drafts.length > limits.maxImagesPerMessage) {
    return `Too many images: ${drafts.length} attached, this deployment allows at most ${limits.maxImagesPerMessage} per message`
  }
  let total = 0
  for (const draft of drafts) {
    if (!limits.mediaTypes.includes(draft.mediaType)) {
      return `Unsupported image type: ${draft.name} is ${draft.mediaType}, allowed: ${limits.mediaTypes.join(', ')}`
    }
    if (draft.bytes > limits.maxImageBytes) {
      return `Image too large: ${draft.name} is ${formatBytes(draft.bytes)}, limit is ${formatBytes(limits.maxImageBytes)}`
    }
    if (draft.width !== undefined && draft.height !== undefined) {
      const pixels = draft.width * draft.height
      if (pixels > limits.maxImagePixels) {
        return `Image has too many pixels: ${draft.name} is ${draft.width}×${draft.height}, limit is ${limits.maxImagePixels}px`
      }
    }
    total += draft.bytes
  }
  if (total > limits.maxMessageImageBytes) {
    return `Images too large together: ${formatBytes(total)} across ${drafts.length} image(s), per-message limit is ${formatBytes(limits.maxMessageImageBytes)}`
  }
  return undefined
}

/** 读本地文件成 ImageDraft。失败（不存在、目录、不支持的扩展）throw 可读信息。 */
export async function readImageDraft(path: string): Promise<ImageDraft> {
  const expanded = path.startsWith('~/') ? resolve(homedir(), path.slice(2)) : resolve(path)
  const mediaType = mediaTypeForPath(expanded)
  if (mediaType === undefined) {
    throw new Error(`Unsupported image file: ${path} (png / jpeg / webp / gif only)`)
  }
  let buf: Buffer
  try {
    buf = await readFile(expanded)
  } catch {
    throw new Error(`Cannot read image file: ${path}`)
  }
  const dims = sniffImageDimensions(buf, mediaType)
  return {
    name: basename(expanded),
    mediaType,
    data: buf.toString('base64'),
    bytes: buf.byteLength,
    ...(dims !== undefined ? { width: dims.width, height: dims.height } : {}),
  }
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}
