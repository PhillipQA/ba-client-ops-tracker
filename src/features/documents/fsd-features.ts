import { fsdModuleSection, type FsdDraft, type FsdFeature, type FsdFeatureId } from './fsd-model'

export function nextFsdFeatureId(features: readonly FsdFeature[], reservedIds: readonly string[] = []): FsdFeatureId {
  const used = [...features.map(f => f.id), ...reservedIds]
  let number = Math.max(0, ...used.map(id => Number(id.match(/^feature-(\d+)$/)?.[1]) || 0)) + 1
  while (used.includes(`feature-${String(number).padStart(3, '0')}`)) number++
  return `feature-${String(number).padStart(3, '0')}`
}

export function fsdFeatureCode(client: string, index: number) {
  return `${
    client
      .replace(/[^a-z0-9]/gi, '')
      .toUpperCase()
      .slice(0, 20) || 'CLIENT'
  }-FEATURE-${String(index + 1).padStart(2, '0')}`
}

/** Open saved drafts in the custom-feature UI without losing uploads or text. */
export function migrateFsdFeatures(draft: FsdDraft): FsdDraft {
  if (Array.isArray(draft.features)) return { ...draft, modules: draft.features.map(f => f.id) }
  const features: FsdFeature[] = [{ id: 'feature-001', name: draft.details.feature.trim() }]
  const active = new Set<string>(draft.modules.map(fsdModuleSection))
  const guidance = Object.entries(draft.mapping)
    .filter(([id, value]) => active.has(id) && value.trim())
    .map(([, value]) => value)
    .join('\n')
    .slice(0, 2000)
  return {
    ...draft,
    features,
    modules: features.map(f => f.id),
    sources: draft.sources.map(s => ({
      ...s,
      target: active.has(s.target) ? features[0].id : s.target,
      analysis: undefined,
      analysisError: undefined,
    })),
    mapping: { ...draft.mapping, ...(guidance ? { [features[0].id]: guidance } : {}) },
    revision: draft.revision + 1,
    preview: null,
    previewRevision: -1,
    reviewed: false,
  }
}
