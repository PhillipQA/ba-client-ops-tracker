/**
 * The app's version. APP_VERSION changes by hand for a new release (v2.0). APP_BUILD counts the pull requests merged
 * into main since then: the "Build number" workflow raises it by one after each merge (.github/workflows/
 * build-number.yml), so v2.0 is followed by v2.0 · B01, B02… A pull request that changes this file sets the version
 * itself and is not counted.
 */
export const APP_VERSION = '2.0'
export const APP_BUILD = 99

const build = APP_BUILD > 0 ? `B${String(APP_BUILD).padStart(2, '0')}` : ''
/** For people: "2.0" or "2.0 · B01". */
export const APP_LABEL = build ? `${APP_VERSION} · ${build}` : APP_VERSION
/** For headers and logs (plain characters only): "2.0" or "2.0-B01". */
export const APP_RELEASE = build ? `${APP_VERSION}-${build}` : APP_VERSION
