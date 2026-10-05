// Vitest stand-in for the `cloudflare:workers` runtime module (aliased in vite.config.ts). Just
// enough shape for LiveHub and Notify to be constructed with a fake ctx/env in a Node test.

export class DurableObject<Env = unknown> {
  ctx: unknown
  env: Env
  constructor(ctx: unknown, env: Env) {
    this.ctx = ctx
    this.env = env
  }
}

export class WorkerEntrypoint<Env = unknown> {
  ctx: unknown
  env: Env
  constructor(ctx: unknown, env: Env) {
    this.ctx = ctx
    this.env = env
  }
}
