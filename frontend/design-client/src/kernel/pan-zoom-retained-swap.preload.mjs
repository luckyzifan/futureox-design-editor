// Lets the retained-swap decision test import the real presenter predicate
// without installing the React application. The predicate never calls React.
import { registerHooks } from 'node:module'

const stub = 'data:text/javascript,' + encodeURIComponent(
  'export function useSyncExternalStore(_subscribe, getSnapshot, getServerSnapshot){return (getServerSnapshot??getSnapshot)()}\nexport default {}\n',
)

registerHooks({
  resolve(specifier, context, next) {
    if (specifier === 'react') return { url: stub, shortCircuit: true }
    return next(specifier, context)
  },
})
