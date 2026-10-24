import PizZip from 'pizzip'
import {
  isFsdFeatureSection,
  FSD_NOTICE,
  fsdReference,
  type FsdDetails,
  type FsdPreview,
  type FsdBlock,
} from '../../src/features/documents/fsd-model'
const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main'
const R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
const xml = (v: string) =>
  v.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;')
function run(value: string, bold = false, size?: number) {
  return `<w:r><w:rPr>${bold ? '<w:b/>' : ''}${size ? `<w:sz w:val="${size}"/>` : ''}</w:rPr>${value
    .split('\n')
    .map((s, i) => `${i ? '<w:br/>' : ''}<w:t xml:space="preserve">${xml(s)}</w:t>`)
    .join('')}</w:r>`
}
function p(value: string, style = '', pageBreak = false) {
  return `<w:p><w:pPr>${style ? `<w:pStyle w:val="${style}"/>` : ''}${pageBreak ? '<w:pageBreakBefore/>' : ''}<w:spacing w:after="140"/></w:pPr>${run(value)}</w:p>`
}
function table(headers: string[], rows: string[][], process = false, plain = false) {
  const widths =
    headers.length === 2
      ? process
        ? [2500, 6860]
        : [4680, 4680]
      : headers.length === 6
        ? [1800, 900, 1050, 950, 1450, 3210]
        : headers.length === 5
          ? [1800, 1100, 1100, 3800, 1560]
          : headers.length === 4
            ? [1100, 1600, 2200, 4460]
            : headers.length === 3
              ? [1100, 3800, 4460]
              : headers.map(() => Math.floor(9360 / headers.length))
  const row = (cells: string[], heading = false) =>
    `<w:tr>${heading ? '<w:trPr><w:tblHeader/></w:trPr>' : ''}${cells.map((cell, i) => `<w:tc><w:tcPr><w:tcW w:w="${widths[i]}" w:type="dxa"/>${!plain && (heading || (process && i === 0)) ? '<w:shd w:fill="FCE5CD"/>' : ''}<w:vAlign w:val="top"/></w:tcPr><w:p><w:pPr><w:spacing w:before="40" w:after="60"/></w:pPr>${run(cell, heading, 20)}</w:p></w:tc>`).join('')}</w:tr>`
  return `<w:tbl><w:tblPr><w:tblW w:w="9360" w:type="dxa"/><w:tblLayout w:type="fixed"/><w:tblBorders>${['top', 'left', 'bottom', 'right', 'insideH', 'insideV'].map(side => `<w:${side} w:val="${plain ? 'nil' : 'single'}" w:sz="4" w:color="888888"/>`).join('')}</w:tblBorders><w:tblCellMar><w:top w:w="80" w:type="dxa"/><w:left w:w="80" w:type="dxa"/><w:bottom w:w="80" w:type="dxa"/><w:right w:w="80" w:type="dxa"/></w:tblCellMar></w:tblPr><w:tblGrid>${widths.map(width => `<w:gridCol w:w="${width}"/>`).join('')}</w:tblGrid>${row(headers, true)}${rows.map(cells => row(cells)).join('')}</w:tbl>${p('')}`
}
function block(b: FsdBlock) {
  return b.type === 'table'
    ? table(b.headers, b.rows, b.headers.length === 2)
    : b.text
        .split('\n\n')
        .map(s => p(s, /^5\.[1-4]\.\d+[. ]/.test(s) && s.length < 150 ? 'Heading3' : ''))
        .join('')
}
function drawing() {
  return `<w:r><w:drawing><wp:inline xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" distT="0" distB="0" distL="0" distR="0"><wp:extent cx="1250000" cy="454545"/><wp:docPr id="1" name="iRipple logo"/><a:graphic xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:nvPicPr><pic:cNvPr id="1" name="iRipple"/><pic:cNvPicPr/></pic:nvPicPr><pic:blipFill><a:blip r:embed="logo"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill><pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="1250000" cy="454545"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r>`
}
export function renderFsdDocx(
  d: FsdDetails,
  preview: Pick<FsdPreview, 'sections' | 'gaps' | 'conflicts'>,
  logo: Buffer,
  template?: Buffer,
  inputCoverage: { name: string; status: string; reason: string }[] = [],
) {
  const reference = fsdReference(d)
  const sign = (name: string, title: string) =>
    `\n\n________________________  __________\n${name || 'Name'}                                      (Date)\n${title || 'Position'}`
  let body = p(d.product, 'Title') + p(d.feature, 'Title') + p('Agreed and Approved by:')
  body += table(
    ['IRIPPLE, INC:', `${d.client}:`],
    [
      [sign(d.irippleBA, 'Business Analyst'), sign(d.clientName1, d.clientTitle1)],
      [sign(d.iripplePM, 'Project Manager'), sign(d.clientName2, d.clientTitle2)],
    ],
    false,
    true,
  )
  body +=
    p('PROPRIETARY DATA NOTICE', 'Title', true) +
    FSD_NOTICE.split('\n\n')
      .map(v => p(v))
      .join('')
  body += p('Table of Contents', 'Title', true)
  body +=
    '<w:p><w:r><w:fldChar w:fldCharType="begin" w:dirty="true"/></w:r><w:r><w:instrText xml:space="preserve"> TOC \\o &quot;1-3&quot; \\h \\z \\u </w:instrText></w:r><w:r><w:fldChar w:fldCharType="separate"/></w:r></w:p>'
  body += preview.sections.map(s => p(s.title)).join('')
  body += '<w:p><w:r><w:fldChar w:fldCharType="end"/></w:r></w:p>'
  const firstSoftwareSectionId = preview.sections.find(section => isFsdFeatureSection(section.id))?.id
  for (const section of preview.sections) {
    if (section.id === 'summary') body += p('1. Introduction', 'Heading1', true)
    if (section.id === firstSoftwareSectionId) body += p('5. Software Features', 'Heading1', true)
    if (section.id === 'assumptions') body += p('VI. Assumptions and Limitations', 'Heading1', true)
    const isSub =
      isFsdFeatureSection(section.id) ||
      ['summary', 'scope', 'audience', 'acceptance', 'assumptions', 'limitations'].includes(section.id)
    body += p(
      section.title,
      isSub ? 'Heading2' : 'Heading1',
      ['report', 'lynexus', 'pos'].includes(section.id) && section.blocks.some(b => b.type === 'table'),
    )
    body += section.blocks.map(block).join('')
  }
  if (inputCoverage.length)
    body +=
      p('Input Coverage', 'Heading1', true) +
      table(
        ['Document / Source', 'Status', 'Details'],
        inputCoverage.map(s => [s.name, s.status, s.reason]),
      )
  if (preview.gaps.length || preview.conflicts.length) {
    body += p('Review Items — Pending Confirmation', 'Heading1', true)
    if (preview.gaps.length)
      body += p('Missing information', 'Heading2') + preview.gaps.map((v, i) => p(`${i + 1}. ${v}`)).join('')
    if (preview.conflicts.length)
      body += p('Conflicting sources', 'Heading2') + preview.conflicts.map((v, i) => p(`${i + 1}. ${v}`)).join('')
  }
  if (template) {
    const zip = new PizZip(template)
    const documentFile = zip.file('word/document.xml')
    if (!documentFile) throw new Error('The FSD template is missing word/document.xml.')
    const documentXml = documentFile.asText()
    const markerParagraph = /<w:p(?=[ >])(?:(?!<\/w:p>)[\s\S])*?\{\{FSD_BODY\}\}(?:(?!<\/w:p>)[\s\S])*?<\/w:p>/
    if (!markerParagraph.test(documentXml))
      throw new Error('The FSD template must contain the {{FSD_BODY}} marker in its own paragraph.')
    zip.file('word/document.xml', documentXml.replace(markerParagraph, body))
    const replacements: Record<string, string> = {
      '{{FSD_REFERENCE}}': reference,
      '{{FSD_PRODUCT}}': d.product,
      '{{FSD_FEATURE}}': d.feature,
      '{{FSD_CLIENT}}': d.client,
    }
    for (const file of zip.file(/^word\/.*\.xml$/)) {
      let content = file.asText()
      let changed = false
      for (const [marker, value] of Object.entries(replacements)) {
        if (!content.includes(marker)) continue
        content = content.split(marker).join(xml(value))
        changed = true
      }
      if (changed) zip.file(file.name, content)
    }
    return zip.generate({ type: 'nodebuffer', compression: 'DEFLATE' })
  }
  body +=
    '<w:sectPr><w:headerReference w:type="default" r:id="header"/><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="1900" w:right="1440" w:bottom="1080" w:left="1440" w:header="720" w:footer="720"/></w:sectPr>'
  const header = `<w:hdr xmlns:w="${W}" xmlns:r="${R}"><w:tbl><w:tblPr><w:tblW w:w="9360" w:type="dxa"/><w:tblBorders>${['top', 'left', 'bottom', 'right', 'insideV'].map(s => `<w:${s} w:val="single" w:sz="4"/>`).join('')}</w:tblBorders></w:tblPr><w:tblGrid><w:gridCol w:w="2160"/><w:gridCol w:w="4000"/><w:gridCol w:w="3200"/></w:tblGrid><w:tr><w:tc><w:tcPr><w:tcW w:w="2160" w:type="dxa"/><w:vAlign w:val="center"/></w:tcPr><w:p>${drawing()}</w:p></w:tc><w:tc><w:tcPr><w:tcW w:w="4000" w:type="dxa"/><w:vAlign w:val="center"/></w:tcPr><w:p><w:pPr><w:jc w:val="center"/></w:pPr>${run('FEATURE SPECIFICATION\nDOCUMENT', true, 25)}</w:p></w:tc><w:tc><w:tcPr><w:tcW w:w="3200" w:type="dxa"/></w:tcPr><w:p>${run('Document Version:\n' + reference, true, 16)}</w:p><w:p>${run('Page No: ', false, 16)}<w:fldSimple w:instr="PAGE"/>${run(' of ', false, 16)}<w:fldSimple w:instr="NUMPAGES"/></w:p></w:tc></w:tr></w:tbl>${p('')}</w:hdr>`
  const zip = new PizZip()
  zip.file(
    '[Content_Types].xml',
    `<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="png" ContentType="image/png"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/><Override PartName="/word/settings.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.settings+xml"/><Override PartName="/word/header1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.header+xml"/></Types>`,
  )
  const rel = (id: string, type: string, target: string) =>
    `<Relationship Id="${id}" Type="${R}/${type}" Target="${target}"/>`
  const rels = (v: string) =>
    `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${v}</Relationships>`
  zip.file('_rels/.rels', rels(rel('document', 'officeDocument', 'word/document.xml')))
  zip.file(
    'word/document.xml',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="${W}" xmlns:r="${R}"><w:body>${body}</w:body></w:document>`,
  )
  zip.file(
    'word/_rels/document.xml.rels',
    rels(
      rel('header', 'header', 'header1.xml') +
        rel('styles', 'styles', 'styles.xml') +
        rel('settings', 'settings', 'settings.xml'),
    ),
  )
  zip.file('word/header1.xml', header)
  zip.file('word/_rels/header1.xml.rels', rels(rel('logo', 'image', 'media/fsd-logo.png')))
  zip.file('word/media/fsd-logo.png', logo)
  zip.file('word/settings.xml', `<w:settings xmlns:w="${W}"><w:updateFields w:val="true"/></w:settings>`)
  zip.file(
    'word/styles.xml',
    `<w:styles xmlns:w="${W}"><w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Arial" w:hAnsi="Arial"/><w:sz w:val="22"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:after="140" w:line="276" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults><w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style><w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/><w:basedOn w:val="Normal"/><w:pPr><w:jc w:val="center"/><w:spacing w:before="400" w:after="300"/><w:keepNext/></w:pPr><w:rPr><w:b/><w:sz w:val="30"/></w:rPr></w:style>${[1, 2, 3].map(n => `<w:style w:type="paragraph" w:styleId="Heading${n}"><w:name w:val="heading ${n}"/><w:basedOn w:val="Normal"/><w:pPr><w:keepNext/><w:spacing w:before="260" w:after="140"/><w:outlineLvl w:val="${n - 1}"/></w:pPr><w:rPr><w:b/><w:sz w:val="${n === 1 ? 28 : 24}"/></w:rPr></w:style>`).join('')}</w:styles>`,
  )
  return zip.generate({ type: 'nodebuffer', compression: 'DEFLATE' })
}
