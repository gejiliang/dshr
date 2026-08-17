/**
 * 图片附件的纯逻辑测试：mediaType 判定、四种格式的尺寸嗅探、
 * `imageLimits` 提交前自查、读本地文件成 draft。全部离线，不碰 host。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  checkImageLimits,
  imageLimitsFromProjection,
  mediaTypeForPath,
  readImageDraft,
  sniffImageDimensions,
  type ImageDraft,
  type ImageLimits,
} from '@dshr/state'

/** 1×1 PNG 的最小头（签名 + IHDR 的宽高字段，后面不需要真数据——只嗅尺寸）。 */
function pngHeader(width: number, height: number): Uint8Array {
  const buf = new Uint8Array(24)
  buf.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0)
  const view = new DataView(buf.buffer)
  view.setUint32(16, width)
  view.setUint32(20, height)
  return buf
}

function gifHeader(width: number, height: number): Uint8Array {
  const buf = new Uint8Array(10)
  buf.set([0x47, 0x49, 0x46, 0x38, 0x39, 0x61], 0) // GIF89a
  const view = new DataView(buf.buffer)
  view.setUint16(6, width, true)
  view.setUint16(8, height, true)
  return buf
}

function jpegHeader(width: number, height: number): Uint8Array {
  // FF D8（SOI）+ FF C0（SOF0）+ 长度 + 精度 + 高 + 宽
  const buf = new Uint8Array(11)
  buf.set([0xff, 0xd8, 0xff, 0xc0], 0)
  const view = new DataView(buf.buffer)
  view.setUint16(4, 9) // segment length
  buf[6] = 8 // precision
  view.setUint16(7, height)
  view.setUint16(9, width)
  return buf
}

function webpVp8xHeader(width: number, height: number): Uint8Array {
  const buf = new Uint8Array(30)
  buf.set([0x52, 0x49, 0x46, 0x46], 0) // RIFF
  buf.set([0x57, 0x45, 0x42, 0x50], 8) // WEBP
  buf.set([0x56, 0x50, 0x38, 0x58], 12) // VP8X
  const w = width - 1
  const hgt = height - 1
  buf[24] = w & 0xff
  buf[25] = (w >> 8) & 0xff
  buf[26] = (w >> 16) & 0xff
  buf[27] = hgt & 0xff
  buf[28] = (hgt >> 8) & 0xff
  buf[29] = (hgt >> 16) & 0xff
  return buf
}

const LIMITS: ImageLimits = {
  maxImageBytes: 1024,
  maxImagesPerMessage: 2,
  maxMessageImageBytes: 1500,
  maxImagePixels: 100_000,
  mediaTypes: ['image/png', 'image/jpeg', 'image/webp', 'image/gif'],
}

const draft = (over: Partial<ImageDraft>): ImageDraft => ({
  name: 'a.png',
  mediaType: 'image/png',
  data: '',
  bytes: 100,
  ...over,
})

test('mediaTypeForPath：四种扩展，大小写不敏感；别的返回 undefined', () => {
  assert.equal(mediaTypeForPath('/tmp/a.png'), 'image/png')
  assert.equal(mediaTypeForPath('b.JPG'), 'image/jpeg')
  assert.equal(mediaTypeForPath('c.jpeg'), 'image/jpeg')
  assert.equal(mediaTypeForPath('d.webp'), 'image/webp')
  assert.equal(mediaTypeForPath('e.gif'), 'image/gif')
  assert.equal(mediaTypeForPath('f.txt'), undefined)
  assert.equal(mediaTypeForPath('g'), undefined)
})

test('sniffImageDimensions：png / gif / jpeg / webp(vp8x) 都量得出来', () => {
  assert.deepEqual(sniffImageDimensions(pngHeader(640, 480), 'image/png'), { width: 640, height: 480 })
  assert.deepEqual(sniffImageDimensions(gifHeader(320, 200), 'image/gif'), { width: 320, height: 200 })
  assert.deepEqual(sniffImageDimensions(jpegHeader(1024, 768), 'image/jpeg'), { width: 1024, height: 768 })
  assert.deepEqual(sniffImageDimensions(webpVp8xHeader(50, 40), 'image/webp'), { width: 50, height: 40 })
})

test('sniffImageDimensions：垃圾输入不炸，返回 undefined（像素限额交给 host）', () => {
  assert.equal(sniffImageDimensions(new Uint8Array([1, 2, 3]), 'image/png'), undefined)
  assert.equal(sniffImageDimensions(new Uint8Array(0), 'image/jpeg'), undefined)
  assert.equal(sniffImageDimensions(pngHeader(0, 0), 'image/png'), undefined)
})

test('imageLimitsFromProjection：形状不对或缺省都返回 undefined（跳过自查）', () => {
  assert.equal(imageLimitsFromProjection(undefined), undefined)
  assert.equal(imageLimitsFromProjection(null), undefined)
  assert.equal(imageLimitsFromProjection({ maxImageBytes: 1 }), undefined)
  assert.equal(imageLimitsFromProjection({ ...LIMITS, mediaTypes: 'image/png' }), undefined)
  assert.deepEqual(imageLimitsFromProjection(LIMITS), LIMITS)
})

test('checkImageLimits：条数 / 单图字节 / 总量 / 像素 / 类型，逐条挡', () => {
  // 通过
  assert.equal(checkImageLimits([draft({}), draft({ bytes: 1024 })], LIMITS), undefined)
  // 条数
  assert.match(checkImageLimits([draft({}), draft({}), draft({})], LIMITS) ?? '', /Too many images: 3 attached.*at most 2/)
  // 单图字节
  assert.match(checkImageLimits([draft({ bytes: 1025 })], LIMITS) ?? '', /Image too large: a\.png/)
  // 总量
  assert.match(checkImageLimits([draft({ bytes: 900 }), draft({ bytes: 900 })], LIMITS) ?? '', /too large together/)
  // 像素
  assert.match(
    checkImageLimits([draft({ width: 500, height: 500 })], LIMITS) ?? '',
    /too many pixels: a\.png is 500×500/,
  )
  // 类型不在允许集
  assert.match(
    checkImageLimits([draft({ mediaType: 'image/gif' })], { ...LIMITS, mediaTypes: ['image/png'] }) ?? '',
    /Unsupported image type/,
  )
  // 像素嗅不出来（无 width/height）不因此拒
  assert.equal(checkImageLimits([draft({})], { ...LIMITS, maxImagePixels: 1 }), undefined)
})

test('readImageDraft：读真文件，base64 + 尺寸 + basename；坏路径与坏扩展都可读地拒', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'dshr-images-'))
  t.after(() => rm(dir, { recursive: true, force: true }))

  const png = pngHeader(7, 5)
  await writeFile(join(dir, 'pic.png'), png)
  const draftResult = await readImageDraft(join(dir, 'pic.png'))
  assert.equal(draftResult.name, 'pic.png')
  assert.equal(draftResult.mediaType, 'image/png')
  assert.equal(draftResult.bytes, png.byteLength)
  assert.deepEqual({ width: draftResult.width, height: draftResult.height }, { width: 7, height: 5 })
  assert.equal(Buffer.from(draftResult.data, 'base64').byteLength, png.byteLength)

  await assert.rejects(() => readImageDraft(join(dir, 'notes.txt')), /Unsupported image file/)
  await assert.rejects(() => readImageDraft(join(dir, 'missing.png')), /Cannot read image file/)
})
