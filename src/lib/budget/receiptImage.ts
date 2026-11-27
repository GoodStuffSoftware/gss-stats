// Receipt photo prep, run in the browser before anything is sent (receipt photo upload plan, sections 3 and 4): decode the
// picked file with its orientation applied, draw it onto a canvas no larger than 1568 px on the long edge, and re-encode as
// JPEG. Re-encoding drops every EXIF, GPS and camera tag, so none of it leaves the device. Images only (no PDF).

/** Longest edge sent, in pixels: the size the vision API scales to anyway. */
export const MAX_EDGE = 1568
/** The server refuses bodies over this many bytes. */
export const MAX_UPLOAD_BYTES = 2_000_000
/** A picked file larger than this is refused before it is decoded. */
export const MAX_INPUT_BYTES = 25 * 1024 * 1024

const START_QUALITY = 0.85
const MIN_QUALITY = 0.4
const QUALITY_STEP = 0.1

export const READ_ERROR = "Can't read this image type; take a photo or save it as JPEG"
export const TOO_BIG_INPUT = 'That file is too large (over 25 MB). Choose a smaller photo.'
export const TOO_BIG_OUTPUT = 'The photo is still too large after shrinking. Try a closer photo of the receipt.'

export class ReceiptImageError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ReceiptImageError'
  }
}

function toBlob(canvas: HTMLCanvasElement, quality: number): Promise<Blob | null> {
  return new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', quality))
}

/** The scaled size for a source of w by h: long edge at most MAX_EDGE, never enlarged, at least 1 px. */
export function scaledSize(w: number, h: number): { width: number; height: number } {
  const long = Math.max(w, h)
  const k = long > MAX_EDGE ? MAX_EDGE / long : 1
  return { width: Math.max(1, Math.round(w * k)), height: Math.max(1, Math.round(h * k)) }
}

/**
 * Turns a picked image file into a JPEG blob of at most MAX_UPLOAD_BYTES. Throws ReceiptImageError (plain words in
 * `message`) for a file over 25 MB, one the browser cannot decode, or one that stays too big at the lowest quality.
 */
export async function prepareReceiptImage(file: Blob): Promise<Blob> {
  if (file.size > MAX_INPUT_BYTES) throw new ReceiptImageError(TOO_BIG_INPUT)
  let bitmap: ImageBitmap
  try {
    bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' })
  } catch {
    throw new ReceiptImageError(READ_ERROR)
  }
  try {
    const { width, height } = scaledSize(bitmap.width, bitmap.height)
    const canvas = document.createElement('canvas')
    canvas.width = width
    canvas.height = height
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new ReceiptImageError(READ_ERROR)
    // JPEG has no alpha: paint white first so a transparent PNG does not turn black.
    ctx.fillStyle = '#fff'
    ctx.fillRect(0, 0, width, height)
    ctx.drawImage(bitmap, 0, 0, width, height)
    for (let q = START_QUALITY; q >= MIN_QUALITY - 1e-9; q -= QUALITY_STEP) {
      const blob = await toBlob(canvas, q)
      if (!blob) throw new ReceiptImageError(READ_ERROR)
      if (blob.size <= MAX_UPLOAD_BYTES) return blob
    }
    throw new ReceiptImageError(TOO_BIG_OUTPUT)
  } finally {
    bitmap.close?.()
  }
}
