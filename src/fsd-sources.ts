import PizZip from 'pizzip'
import pdfWorkerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url'
const LIMIT = 120000
export async function readFsdSource(file: File, progress: (message: string) => void): Promise<string> {
  if (!file.size || file.size > 10 * 1024 * 1024) throw new Error(`${file.name}: use a nonempty file up to 10 MB.`)
  const ext = file.name.split('.').pop()?.toLowerCase()
  let text = ''
  if (['txt','md','csv','json'].includes(ext || '')) text = await file.text()
  else if (ext === 'docx') {
    const zip = new PizZip(await file.arrayBuffer())
    const part = zip.file('word/document.xml')
    if (!part) throw new Error(`${file.name}: invalid Word document.`)
    const content = part.asText()
    if (content.length > 5000000) throw new Error(`${file.name}: document is too large to extract.`)
    const xml = new DOMParser().parseFromString(content,'application/xml')
    if (xml.querySelector('parsererror')) throw new Error(`${file.name}: damaged Word document.`)
    text = Array.from(xml.getElementsByTagName('w:p')).map(p => Array.from(p.getElementsByTagName('w:t')).map(t => t.textContent || '').join('')).join('\n')
  } else if (ext === 'pdf') {
    const pdfjs = await import('pdfjs-dist')
    pdfjs.GlobalWorkerOptions.workerSrc = pdfWorkerUrl
    const pdf = await pdfjs.getDocument({ data: new Uint8Array(await file.arrayBuffer()) }).promise
    let worker: Awaited<ReturnType<typeof import('tesseract.js')['createWorker']>> | undefined
    try {
      if (pdf.numPages > 80) throw new Error(`${file.name}: split PDFs longer than 80 pages before uploading.`)
      const pages: string[] = []
      for (let pageNo = 1; pageNo <= pdf.numPages; pageNo++) {
        progress(`Reading ${file.name}: page ${pageNo} of ${pdf.numPages}…`)
        const page = await pdf.getPage(pageNo), content = await page.getTextContent()
        let pageText = content.items.map(item => 'str' in item ? item.str + (item.hasEOL?'\n':' ') : '').join('')
        if (pageText.trim().length < 20) {
          progress(`Reading scanned page ${pageNo} of ${pdf.numPages} with OCR…`)
          if (!worker) { const { createWorker } = await import('tesseract.js'); worker = await createWorker('eng') }
          const initial = page.getViewport({ scale: 1 }), scale = Math.min(1.6, 1800 / Math.max(initial.width,initial.height))
          const viewport = page.getViewport({ scale }), canvas = document.createElement('canvas')
          canvas.width = Math.ceil(viewport.width); canvas.height = Math.ceil(viewport.height)
          await page.render({ canvas, canvasContext: canvas.getContext('2d')!, viewport }).promise
          pageText = (await worker.recognize(canvas)).data.text
          canvas.width = 0; canvas.height = 0
        }
        if (!pageText.trim()) pageText = '[No readable text on this page; review the original page for diagrams or other requirements.]'
        pages.push(`[Page ${pageNo}]\n${pageText}`)
        if (pages.reduce((n,p)=>n+p.length,0)>LIMIT) throw new Error(`${file.name}: extracted text exceeds 120,000 characters. Split the document.`)
        page.cleanup()
      }
      text = pages.join('\n\n')
    } finally { await worker?.terminate(); await pdf.destroy() }
  } else throw new Error(`${file.name}: use PDF, DOCX, TXT, MD, CSV or JSON. Convert older DOC files to DOCX first.`)
  text = text.replace(/\r\n?/g,'\n').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g,'').trim()
  if (!text || text.length > LIMIT) throw new Error(`${file.name}: no readable text, or text exceeds 120,000 characters.`)
  return text
}
