import React from 'react'
import { Plus, Trash2 } from 'lucide-react'
import { fsdFeatureCode, nextFsdFeatureId } from './fsd-features'
import type { FsdFeature } from './fsd-model'

export default function FsdFeatureFields({ features, client, reservedIds, onChange }: { features: FsdFeature[]; client: string; reservedIds: string[]; onChange: (features: FsdFeature[]) => void }) {
  return <div className="fsd-custom-features">
    <p>Add the features covered by this FSD. Each name becomes its own report heading and retains the process, scenario and specification tables.</p>
    {features.map((feature, index) => <div className="fsd-feature-entry" key={feature.id}>
      <label>Feature Name {index + 1} *<input aria-label={`Feature Name ${index + 1}`} value={feature.name} maxLength={120} placeholder="e.g. Metabase Report" onChange={event => onChange(features.map(f => f.id === feature.id ? { ...f, name: event.target.value } : f))}/><small>Report: 5.{index + 1} {feature.name.trim() || 'Feature name'} · Process code: {fsdFeatureCode(client, index)}</small></label>
      <button type="button" className="secondary" aria-label={`Remove feature ${index + 1}`} disabled={features.length === 1} onClick={() => onChange(features.filter(f => f.id !== feature.id))}><Trash2 size={14}/>Remove</button>
    </div>)}
    <button type="button" className="secondary" disabled={features.length >= 20} onClick={() => onChange([...features, { id: nextFsdFeatureId(features, reservedIds), name: '' }])}><Plus size={14}/>Add feature</button>
    <small>All listed features are included. Remove a feature to leave it out; reassign any source mapped to a removed feature. Up to 20 features.</small>
  </div>
}
