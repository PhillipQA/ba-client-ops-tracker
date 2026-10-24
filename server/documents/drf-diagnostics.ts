import { randomUUID } from 'node:crypto'

export const drfStages = ['cor_upload', 'cor_local', 'cor_ai', 'template_render', 'download', 'dochub'] as const
export type DrfStage = (typeof drfStages)[number]
export function isDrfStage(value: unknown): value is DrfStage {
  return drfStages.includes(value as DrfStage)
}

/** Keep a useful error summary without storing source documents or provider credentials. */
export function safeDrfMessage(value: unknown) {
  const raw = value instanceof Error ? value.message : typeof value === 'string' ? value : 'DRF operation failed.'
  return (raw.split(/[\r\n]/, 1)[0] || 'DRF operation failed.')
    .replace(/\bBearer\s+\S+/gi, 'Bearer [redacted]')
    .replace(/\b(?:sk|key|token|secret)-[A-Za-z0-9_-]{8,}\b/gi, '[redacted]')
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, '[email redacted]')
    .replace(/https?:\/\/\S+/gi, '[URL redacted]')
    .replace(/\b\d{9,}\b/g, '[number redacted]')
    .slice(0, 700)
}

type Identity = { tenantId: string; userId: string }
type Context = {
  fileType?: string
  fileBytes?: number
  extractionMode?: string
  templateType?: string
  provider?: string
  httpStatus?: number
}
export async function recordDrfError(
  db: any,
  actor: Identity,
  stage: DrfStage,
  source: 'browser' | 'server',
  error: unknown,
  context: Context = {},
) {
  if (!db) return null
  const id = randomUUID()
  const safeContext = {
    ...(typeof context.fileType === 'string'
      ? { fileType: context.fileType.replace(/[^a-z0-9/+.-]/gi, '').slice(0, 60) }
      : {}),
    ...(typeof context.fileBytes === 'number' && Number.isFinite(context.fileBytes)
      ? { fileBytes: Math.max(0, Math.min(Math.trunc(context.fileBytes), 20_000_000)) }
      : {}),
    ...(context.extractionMode === 'ai' || context.extractionMode === 'local'
      ? { extractionMode: context.extractionMode }
      : {}),
    ...(typeof context.templateType === 'string'
      ? { templateType: context.templateType.replace(/[^a-z0-9]/gi, '').slice(0, 16) }
      : {}),
    ...(typeof context.provider === 'string'
      ? { provider: context.provider.replace(/[^a-z0-9 ]/gi, '').slice(0, 32) }
      : {}),
    ...(typeof context.httpStatus === 'number' && context.httpStatus >= 400 && context.httpStatus <= 599
      ? { httpStatus: Math.trunc(context.httpStatus) }
      : {}),
  }
  try {
    const { error: writeError } = await db
      .from('drf_error_logs')
      .insert({
        id,
        tenant_id: actor.tenantId,
        user_id: actor.userId,
        stage,
        source,
        message: safeDrfMessage(error),
        error_code: typeof (error as any)?.code === 'string' ? String((error as any).code).slice(0, 80) : null,
        context: safeContext,
      })
    if (writeError) throw writeError
    return id
  } catch (writeError) {
    console.warn('DRF diagnostic could not be saved:', (writeError as any)?.code || 'database unavailable')
    return null
  }
}
