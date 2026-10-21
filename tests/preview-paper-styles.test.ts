import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const read = (name: string) => readFileSync(new URL(`../src/${name}`, import.meta.url), 'utf8')

// The FSD and BRD previews are white pages that stand for the Word documents. In a dark interface mode the generic
// rules for headings, tables and inputs would otherwise put light text on them.
test('interface-mode rules that exclude the FSD paper also exclude the BRD paper', () => {
  const css = read('appearance.css')
  const exclusions = css.match(/:not\(:where\([^)]*\.fsd-paper[^)]*\)\)/g) ?? []
  assert.ok(exclusions.length >= 6, 'expected the existing paper exclusions')
  for (const exclusion of exclusions) assert.match(exclusion, /\.brd-paper/, exclusion)
})

test('both papers set their own light tokens, whatever the workspace theme', () => {
  const fsd = read('fsd.css')
  assert.match(fsd, /\.fsd-paper,\s*\.brd-paper\s*\{[^}]*color-scheme:light[^}]*--fsd-heading:#17191d[^}]*--fsd-surface:#fff/s)
  assert.match(read('appearance.css'), /data-interface-mode\] :is\(\.fsd-paper, \.brd-paper\)\s*\{[^}]*--fsd-heading: #17191d/s)
})

test('paper tables and text outrank the generic dark and wallpaper rules', () => {
  const brd = read('brd.css'), fsd = read('fsd.css')
  for (const rule of ['.brd-paper th{', '.brd-paper td{', '.brd-paper :is(h2,h3,h4,p,li,td,span,small,label,strong){']) assert.ok(brd.includes(`.app-shell .fsd-creator ${rule}`), rule)
  assert.ok(fsd.includes('.app-shell .fsd-creator .fsd-paper th {background:#fce5cd;color:#222;}'))
  assert.ok(fsd.includes('.fsd-warning :is(p,ul,li,strong,small,span) {color:inherit!important;}'))
})
