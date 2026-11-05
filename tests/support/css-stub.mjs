// Tests import screens, and screens import their stylesheets. Node cannot load CSS, so in tests a stylesheet is an
// empty module. Without this, any test file that renders a screen fails before its first test runs.
import { register } from 'node:module'

register(
  `data:text/javascript,${encodeURIComponent(`
    export async function load(url, context, next) {
      if (/\\.css(\\?.*)?$/.test(url)) return { format: 'module', source: 'export default {}', shortCircuit: true }
      return next(url, context)
    }
  `)}`,
)
