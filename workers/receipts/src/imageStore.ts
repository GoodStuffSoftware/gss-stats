// Receipt photo upload: where the stripped JPEG lives (plan section 1). One interface, two backings chosen by whichever
// binding is present: a private R2 bucket (RECEIPT_IMAGES, preferred) or a KV namespace (RECEIPT_IMAGES_KV, fallback;
// per-key expirationTtl = RECEIPTS_IMAGE_KEEP_DAYS). Neither bound = uploads answer 503. Keys are opaque ('img/<id>.jpg').
// No custom metadata, never a log line here.

export interface ImageStore {
  put(key: string, bytes: Uint8Array): Promise<void>
  get(key: string): Promise<Uint8Array | null>
  delete(key: string): Promise<void>
}

export interface ImageStoreEnv {
  RECEIPT_IMAGES?: R2Bucket
  RECEIPT_IMAGES_KV?: KVNamespace
  RECEIPTS_IMAGE_KEEP_DAYS?: string
}

export const DEFAULT_KEEP_DAYS = 90
/** KV's smallest expirationTtl is 60 s. */
const KV_MIN_TTL = 60

export function keepDays(v: string | undefined): number {
  const n = Number(v)
  return v !== undefined && v.trim() !== '' && Number.isFinite(n) && n >= 1 ? Math.floor(n) : DEFAULT_KEEP_DAYS
}

export function r2ImageStore(bucket: R2Bucket): ImageStore {
  return {
    async put(key, bytes) { await bucket.put(key, bytes, { httpMetadata: { contentType: 'image/jpeg' } }) },
    async get(key) {
      const o = await bucket.get(key)
      return o ? new Uint8Array(await o.arrayBuffer()) : null
    },
    async delete(key) { await bucket.delete(key) },
  }
}

export function kvImageStore(kv: KVNamespace, days: number): ImageStore {
  const ttl = Math.max(KV_MIN_TTL, days * 86_400)
  return {
    async put(key, bytes) { await kv.put(key, bytes, { expirationTtl: ttl }) },
    async get(key) {
      const b = await kv.get(key, 'arrayBuffer')
      return b ? new Uint8Array(b) : null
    },
    async delete(key) { await kv.delete(key) },
  }
}

/** R2 wins when both are bound; null when neither is. */
export function selectImageStore(env: ImageStoreEnv): ImageStore | null {
  if (env.RECEIPT_IMAGES) return r2ImageStore(env.RECEIPT_IMAGES)
  if (env.RECEIPT_IMAGES_KV) return kvImageStore(env.RECEIPT_IMAGES_KV, keepDays(env.RECEIPTS_IMAGE_KEEP_DAYS))
  return null
}
