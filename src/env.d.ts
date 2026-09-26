// Lets `tsc --noEmit` (npm run typecheck) resolve .vue imports. It does not
// type-check the .vue files themselves; that would need vue-tsc.
declare module '*.vue' {
  import type { DefineComponent } from 'vue'
  const component: DefineComponent<object, object, any>
  export default component
}
