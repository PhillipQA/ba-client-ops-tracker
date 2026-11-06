// Loaded before every test file (see the test scripts in package.json):
// - TypeScript and JSX compile the way the app builds them (tsconfig.test.json: JSX without importing React), so tests
//   can render screens;
// - stylesheets imported by screens are empty modules, since Node cannot load CSS.
import { register } from 'node:module'

process.env.TSX_TSCONFIG_PATH ||= new URL('../../tsconfig.test.json', import.meta.url).pathname
await import('tsx')

register(
  `data:text/javascript,${encodeURIComponent(`
    export async function load(url, context, next) {
      if (/\\.css(\\?.*)?$/.test(url)) return { format: 'module', source: 'export default {}', shortCircuit: true }
      return next(url, context)
    }
  `)}`,
)
