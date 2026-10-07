import React, { useState } from 'react'
import GithubHub, { type Props } from './GithubHub'
export default function GitProviderHub(props: Props) {
  const preferenceKey=`work-hub-git-provider:${props.currentUser.organizationId || ''}:${props.currentUser.id}`
  const [provider,setProvider]=useState<'github'|'gitlab'>(()=>{try{return localStorage.getItem(preferenceKey)==='gitlab'?'gitlab':'github'}catch{return 'github'}})
  return <div><div className="github-provider-bar"><label>Ticket provider<select value={provider} onChange={e=>{const value=e.target.value==='gitlab'?'gitlab':'github';setProvider(value);try{localStorage.setItem(preferenceKey,value)}catch{/* Provider selection works without browser storage. */}}}><option value="github">GitHub</option><option value="gitlab">GitLab</option></select></label><p>Each provider has its own personal connection, selected projects and saved tickets.</p></div><GithubHub key={provider} {...props} provider={provider}/></div>
}
