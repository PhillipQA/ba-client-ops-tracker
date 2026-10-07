import { FSD_MODULES, isCustomFsdFeature, type FsdFeature, type FsdModule } from '../../src/fsd-model'
import { IntegrationError } from '../integrations/tenant-integrations'

export function validateFsdScope(body: any, allowUnnamed = false): { modules: FsdModule[]; features?: FsdFeature[] } {
  if (body?.features !== undefined) {
    if (!Array.isArray(body.features) || !body.features.length || body.features.length > 20) throw new IntegrationError('Add 1 to 20 custom features in Scope & section mapping.')
    const features: FsdFeature[] = body.features.map((feature: any, i: number) => {
      if (typeof feature?.id !== 'string' || !isCustomFsdFeature(feature.id) || typeof feature.name !== 'string' || feature.name.length > 120 || /[\u0000-\u001f]/.test(feature.name)) throw new IntegrationError(`Invalid feature ${i + 1}. Use a name up to 120 characters.`)
      if (!allowUnnamed && !feature.name.trim()) throw new IntegrationError(`Enter Feature Name for feature ${i + 1} in Scope & section mapping.`)
      return { id: feature.id, name: feature.name.trim() }
    })
    const names = features.map(f => f.name.toLowerCase()).filter(Boolean)
    if (new Set(features.map(f => f.id)).size !== features.length || new Set(names).size !== names.length) throw new IntegrationError('Each custom feature must have a unique name and ID.')
    return { features, modules: features.map(f => f.id) }
  }
  const modules = body?.modules as FsdModule[]
  if (!Array.isArray(modules) || modules.some(m => !FSD_MODULES.includes(m as typeof FSD_MODULES[number])) || new Set(modules).size !== modules.length) throw new IntegrationError('Invalid module selection.')
  return { modules }
}
