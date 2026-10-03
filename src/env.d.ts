// Lets plain `tsc` (npm run typecheck:scripts, which only covers scripts/) resolve
// .vue imports. `npm run typecheck` uses vue-tsc, which type-checks .vue files too.
declare module '*.vue' {
  import type { DefineComponent } from 'vue'
  const component: DefineComponent<object, object, any>
  export default component
}

// Side-effect-only CSS imports (e.g. `import './style.css'` in main.ts).
declare module '*.css'

// `?raw` imports (a test reads a component source file as text).
declare module '*?raw' {
  const content: string
  export default content
}
