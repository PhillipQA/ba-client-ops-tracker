import { useEffect, useState } from 'react'

type Config={platformEnabled:boolean;configured:boolean;enabled:boolean;encryptionReady:boolean;clientId:string;redirectUri:string;expectedRedirectUri:string}
async function request(url:string,method='GET',data?:unknown){
  const response=await fetch(url,{method,credentials:'same-origin',headers:{'Content-Type':'application/json'},body:data===undefined?undefined:JSON.stringify(data)})
  const body=await response.json().catch(()=>({}))
  if(!response.ok)throw new Error(body.error || 'Gmail settings request failed.')
  return body
}
export function GmailAccountSettings(){
  const [config,setConfig]=useState<Config|null>(null),[clientId,setClientId]=useState(''),[secret,setSecret]=useState(''),[oauthJson,setOauthJson]=useState(''),[filename,setFilename]=useState('')
  const [enabled,setEnabled]=useState(true),[busy,setBusy]=useState(false),[message,setMessage]=useState('')
  const load=async()=>{const data=await request('/api/account/gmail') as Config;setConfig(data);setEnabled(data.configured?data.enabled:true)}
  useEffect(()=>{void load().catch(e=>setMessage(e.message))},[])
  const upload=async(file?:File)=>{if(!file)return;try{if(file.size>32768)throw new Error();const parsed=JSON.parse(await file.text());if(!parsed.web?.client_id || !parsed.web?.client_secret)throw new Error();setOauthJson(JSON.stringify({web:{client_id:parsed.web.client_id,client_secret:parsed.web.client_secret}}));setFilename(file.name);setClientId('');setSecret('');setMessage('')}catch{setOauthJson('');setFilename('');setMessage('Choose a Google Web application OAuth JSON file under 32 KB.')}}
  const save=async(remove=false)=>{
    const replacing=Boolean(oauthJson || clientId || secret)
    if((remove || (config?.configured && replacing)) && !window.confirm(remove?'Remove this account’s Gmail OAuth credentials? Users will need to reconnect if you configure Gmail again.':'Replace this account’s Gmail OAuth credentials? Connected users will need to reconnect.'))return
    setBusy(true);setMessage('')
    try{await request('/api/account/gmail',remove?'DELETE':'PUT',remove?{}:{enabled,...(replacing?{oauthJson:oauthJson || undefined,clientId,clientSecret:secret}: {})});setOauthJson('');setFilename('');setClientId('');setSecret('');await load();setMessage(remove?'Account Gmail credentials removed.':'Account Gmail configuration saved. Users can connect from Communications Hub.')}
    catch(e){setMessage(e instanceof Error?e.message:'Could not save Gmail settings.')}finally{setBusy(false)}
  }
  return <section className="panel account-integration-card calendar-card">
    <div className="panel-heading"><div><h2>Gmail — account setup</h2><p>Use this account’s Google OAuth Web client. Each user authorizes their own mailbox in Communications Hub.</p></div></div>
    {config && <><p>Internal Admin: {config.platformEnabled?'Enabled':'Disabled'} · Credentials: {config.configured?'Saved':'Not configured'}</p>
      {!config.encryptionReady && <p role="alert">Configure the existing integration master key before saving credentials.</p>}
      <label>Authorized redirect URI — add this exact address in Google Cloud<input readOnly value={config.expectedRedirectUri} onFocus={e=>e.target.select()} /></label>
      {config.redirectUri && config.redirectUri!==config.expectedRedirectUri && <p role="alert">The saved callback uses an older app address. Update the Google OAuth client and replace these credentials.</p>}
      {config.clientId && <p className="calendar-break">Saved Client ID: {config.clientId}</p>}
      <div className="integration-form"><label>Google OAuth JSON (Web application)<input type="file" accept=".json,application/json" disabled={busy || !config.platformEnabled} onChange={e=>{void upload(e.target.files?.[0]);e.target.value=''}} /><small>{filename?`${filename} selected; click Save to store it.`:'The JSON is held only until you click Save.'}</small></label>
      <details><summary>Or enter Client ID and Client Secret</summary><label>Client ID<input value={clientId} autoComplete="off" disabled={busy || Boolean(oauthJson)} onChange={e=>setClientId(e.target.value)} /></label><label>Client Secret<input value={secret} type="password" autoComplete="new-password" disabled={busy || Boolean(oauthJson)} onChange={e=>setSecret(e.target.value)} /></label><small>Leave both blank to keep saved credentials.</small></details>
      <label className="checkbox-label"><input type="checkbox" checked={enabled} disabled={busy} onChange={e=>setEnabled(e.target.checked)} /> Enable Gmail for this account</label></div>
      <div className="integration-actions"><button className="primary" disabled={busy || !config.platformEnabled || !config.encryptionReady} onClick={()=>void save()}>{busy?'Saving…':'Save Gmail settings'}</button><button className="secondary" disabled={busy || !config.configured} onClick={()=>void save(true)}>Remove account credentials</button></div>
      <small>Enable Gmail API in this Google Cloud project. Add the Gmail read-only and email identity scopes. User mailboxes remain private to their iRipple users.</small>
    </>}
    {message && <p role="status" className="settings-message">{message}</p>}
  </section>
}
export function GmailPlatformControl({organizationId}:{organizationId:string}){
  const [data,setData]=useState<{enabled:boolean;configured:boolean}|null>(null),[busy,setBusy]=useState(false),[message,setMessage]=useState('')
  const url=`/api/internal-admin/organizations/${encodeURIComponent(organizationId)}/gmail`
  useEffect(()=>{let alive=true;setData(null);setMessage('');void request(url).then(result=>{if(alive)setData(result)}).catch(e=>{if(alive)setMessage(e.message)});return()=>{alive=false}},[url])
  const toggle=async()=>{if(!data)return;setBusy(true);setMessage('');try{await request(url,'PUT',{enabled:!data.enabled});setData({...data,enabled:!data.enabled})}catch(e){setMessage((e as Error).message)}finally{setBusy(false)}}
  return <div className="internal-admin-detail-section"><strong>Gmail integration</strong><p>Allow this account to configure its own Google OAuth client.</p>{data && <><label className="checkbox-label"><input type="checkbox" checked={data.enabled} disabled={busy} onChange={()=>void toggle()} /> Allow Gmail</label><small>Account credentials: {data.configured?'Configured':'Not configured'}. User mailboxes stay private.</small></>}{message && <p role="alert">{message}</p>}</div>
}
