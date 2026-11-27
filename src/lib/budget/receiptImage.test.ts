// @vitest-environment happy-dom
// Receipt photo prep with a stubbed createImageBitmap and canvas: scaling, orientation option, JPEG output, quality
// step-down over 2 MB, the 25 MB input refusal and the undecodable-file message. No image files: bytes are built here.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MAX_EDGE, MAX_INPUT_BYTES, MAX_UPLOAD_BYTES, prepareReceiptImage, READ_ERROR, ReceiptImageError, scaledSize, TOO_BIG_INPUT, TOO_BIG_OUTPUT } from './receiptImage'

const bitmapMock = vi.fn()
const drawImage = vi.fn()
const toBlobMock = vi.fn()
let canvas: { width: number; height: number } | null = null

function stubCanvas(sizeFor: (q: number) => number) {
  toBlobMock.mockImplementation((cb: (b: Blob | null) => void, type: string, q: number) => cb(new Blob([new Uint8Array(sizeFor(q))], { type })))
  vi.spyOn(document, 'createElement').mockImplementation(((tag: string) => {
    if (tag !== 'canvas') throw new Error('unexpected element')
    const c = { width: 0, height: 0, getContext: () => ({ fillRect: vi.fn(), drawImage, fillStyle: '' }), toBlob: toBlobMock }
    canvas = c
    return c as unknown as HTMLCanvasElement
  }) as typeof document.createElement)
}

beforeEach(() => {
  canvas = null
  bitmapMock.mockReset()
  drawImage.mockReset()
  toBlobMock.mockReset()
  bitmapMock.mockResolvedValue({ width: 4000, height: 3000, close: vi.fn() })
  vi.stubGlobal('createImageBitmap', bitmapMock)
})
afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

const file = (n = 10) => new Blob([new Uint8Array(n)], { type: 'image/heic' })

describe('scaledSize', () => {
  it('limits the long edge to 1568 and keeps the ratio', () => {
    expect(scaledSize(4000, 3000)).toEqual({ width: MAX_EDGE, height: 1176 })
    expect(scaledSize(3000, 4000)).toEqual({ width: 1176, height: MAX_EDGE })
  })
  it('never enlarges a small image', () => {
    expect(scaledSize(800, 600)).toEqual({ width: 800, height: 600 })
  })
})

describe('prepareReceiptImage', () => {
  it('decodes with the orientation applied, draws scaled, and encodes JPEG at 0.85', async () => {
    stubCanvas(() => 100_000)
    const out = await prepareReceiptImage(file())
    expect(bitmapMock).toHaveBeenCalledWith(expect.anything(), { imageOrientation: 'from-image' })
    expect(canvas).toMatchObject({ width: 1568, height: 1176 })
    expect(drawImage).toHaveBeenCalledWith(expect.anything(), 0, 0, 1568, 1176)
    expect(toBlobMock).toHaveBeenCalledTimes(1)
    expect(toBlobMock.mock.calls[0][1]).toBe('image/jpeg')
    expect(toBlobMock.mock.calls[0][2]).toBe(0.85)
    expect(out.type).toBe('image/jpeg')
    expect(out.size).toBe(100_000)
  })

  it('steps the quality down while the result is over 2 MB', async () => {
    stubCanvas((q) => (q > 0.7 ? MAX_UPLOAD_BYTES + 1 : 500_000))
    const out = await prepareReceiptImage(file())
    expect(out.size).toBe(500_000)
    const qs = toBlobMock.mock.calls.map((c) => c[2] as number)
    expect(qs[0]).toBe(0.85)
    expect(qs.length).toBeGreaterThan(1)
    expect(qs[qs.length - 1]).toBeLessThanOrEqual(0.7)
  })

  it('refuses when even the lowest quality is over 2 MB', async () => {
    stubCanvas(() => MAX_UPLOAD_BYTES + 1)
    await expect(prepareReceiptImage(file())).rejects.toMatchObject({ message: TOO_BIG_OUTPUT })
  })

  it('refuses a file over 25 MB before decoding it', async () => {
    stubCanvas(() => 1)
    const big = { size: MAX_INPUT_BYTES + 1 } as Blob
    await expect(prepareReceiptImage(big)).rejects.toMatchObject({ message: TOO_BIG_INPUT })
    expect(bitmapMock).not.toHaveBeenCalled()
  })

  it('says to take a photo or save as JPEG when the browser cannot decode the file', async () => {
    stubCanvas(() => 1)
    bitmapMock.mockRejectedValue(new DOMException('bad', 'InvalidStateError'))
    const err = await prepareReceiptImage(file()).catch((e) => e)
    expect(err).toBeInstanceOf(ReceiptImageError)
    expect(err.message).toBe(READ_ERROR)
    expect(READ_ERROR).toBe("Can't read this image type; take a photo or save it as JPEG")
  })
})
