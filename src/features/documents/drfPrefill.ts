/**
 * DRF fields the BA assistant drafts from an email. It is only ever a draft: the person reviews every field in the DRF
 * form before generating. Shared by the server (which cleans what the model returns) and the form (which fills it in).
 */
export type DrfPosRow = { computerName: string; serialNo: string; brand: string; model: string }
export type DrfPrefill = {
  businessName?: string
  tradeName?: string
  tin?: string
  address?: string
  branchName?: string
  goLiveDate?: string
  contractNumber?: string
  notes?: string
  posRows?: DrfPosRow[]
}

const TEXT_FIELDS = [
  ['businessName', 200],
  ['tradeName', 200],
  ['tin', 40],
  ['address', 400],
  ['branchName', 200],
  ['goLiveDate', 40],
  ['contractNumber', 80],
  ['notes', 1000],
] as const
const MAX_POS_ROWS = 17
const line = (value: unknown, length: number) =>
  typeof value === 'string' || typeof value === 'number' ? `${value}`.replace(/\s+/g, ' ').trim().slice(0, length) : ''

/** Only the known fields, as short plain text; empty ones are left out. Anything else the model sent is dropped. */
export function cleanDrfPrefill(raw: unknown): DrfPrefill {
  if (!raw || typeof raw !== 'object') return {}
  const source = raw as Record<string, unknown>
  const result: DrfPrefill = {}
  for (const [field, length] of TEXT_FIELDS) {
    const value = line(source[field], length)
    if (value) result[field] = value
  }
  const rows = (Array.isArray(source.posRows) ? source.posRows : [])
    .map((row: any) => ({
      computerName: line(row?.computerName, 120),
      serialNo: line(row?.serialNo, 120),
      brand: line(row?.brand, 120),
      model: line(row?.model, 120),
    }))
    .filter((row: DrfPosRow) => row.computerName || row.serialNo || row.brand || row.model)
  if (rows.length) result.posRows = rows.slice(0, MAX_POS_ROWS)
  return result
}

/** How many fields a draft filled, counting each POS row once. */
export const drfPrefillCount = (draft: DrfPrefill) =>
  Object.keys(draft).filter(key => key !== 'posRows').length + (draft.posRows?.length || 0)
