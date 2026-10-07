import { request as httpsRequest } from 'node:https'
import { lookup } from 'node:dns/promises'
import { isIP } from 'node:net'
import { IntegrationError } from './tenant-integrations'

export class GitlabError extends IntegrationError {
  constructor(message: string, status: number, public retryAfterSeconds?: number) { super(message,status) }
}
export function gitlabBaseUrl(value: unknown) {
  if(typeof value!=='string' || value.length>500)throw new IntegrationError('Enter your GitLab HTTPS website URL.')
  let url: URL
  try{url=new URL(value)}catch{throw new IntegrationError('Enter your GitLab HTTPS website URL.')}
  if(url.protocol!=='https:' || url.username || url.password || url.search || url.hash || isIP(url.hostname.replace(/^\[|\]$/g,'')) || !url.hostname.includes('.') || /(?:^|\.)(?:localhost|local|internal)$/.test(url.hostname) || url.pathname.includes('%') || !/^\/(?:[a-z0-9_.-]+\/?)*$/i.test(url.pathname) || url.pathname.includes('/api/v4'))throw new IntegrationError('Use your GitLab HTTPS website URL, such as https://gitlab.com or https://gitlab.company.com, without /api/v4.')
  return url.origin+url.pathname.replace(/\/+$/,'')
}
export function gitlabRepositoryName(value: unknown) {
  if(typeof value!=='string' || value.length>200 || !/^[a-z0-9_.-]+(?:\/[a-z0-9_.-]+)+$/i.test(value) || value.split('/').some(p=>/^\.+$/.test(p)))throw new IntegrationError('Enter a GitLab project as group/project or group/subgroup/project.')
  return value
}
export function gitlabRepoPath(repository: string){return `/projects/${encodeURIComponent(gitlabRepositoryName(repository))}`}
export function gitlabPublicAddress(address: string){
  if(isIP(address)===4){const [a,b,c]=address.split('.').map(Number);return !(a===0 || a===10 || a===127 || a>=224 || a===169 && b===254 || a===172 && b>=16 && b<=31 || a===192 && (b===168 || b===0 || b===2) || a===100 && b>=64 && b<=127 || a===198 && (b===18 || b===19 || b===51 && c===100) || a===203 && b===0 && c===113)}
  // Global unicast only; reject mapped/local/link-local/multicast and documentation IPv6.
  return isIP(address)===6 && /^[23][0-9a-f]{3}:/i.test(address) && !/^2001:db8:/i.test(address)
}
type Transport = (url: URL, token: string) => Promise<Response>
/** TLS retains the hostname; lookup validates and pins the address for this connection. No redirects. */
const gitlabHttps: Transport = async(url,token)=>new Promise((resolve,reject)=>{
  const req=httpsRequest(url,{method:'GET',agent:false,headers:{'PRIVATE-TOKEN':token,Accept:'application/json','User-Agent':'BA-Client-Ops-Tracker'},lookup:((hostname:string,options:any,callback:any)=>{
    void lookup(hostname,{all:true}).then(addresses=>{
      if(!addresses.length || addresses.some(a=>!gitlabPublicAddress(a.address))){callback(new Error('GitLab address is not publicly reachable.'));return}
      if(options?.all)callback(null,addresses);else callback(null,addresses[0].address,addresses[0].family)
    }).catch(error=>callback(error))
  }) as any},res=>{
    const chunks:Buffer[]=[];let size=0
    res.on('data',(chunk:Buffer)=>{size+=chunk.length;if(size>8*1024*1024){req.destroy(new Error('GitLab response too large.'));return}chunks.push(chunk)})
    res.on('error',reject)
    res.on('end',()=>{try{const headers=new Headers();for(const [k,v] of Object.entries(res.headers))if(v!==undefined)headers.set(k,Array.isArray(v)?v.join(','):v);resolve(new Response([204,205,304].includes(res.statusCode || 0)?null:Buffer.concat(chunks),{status:res.statusCode || 502,headers}))}catch(error){reject(error)}})
  })
  const timer=setTimeout(()=>req.destroy(new Error('GitLab request timeout.')),15000)
  req.on('error',reject);req.on('close',()=>clearTimeout(timer));req.end()
})
export async function gitlabRequest(token:string,path:string,baseUrl:string,transport:Transport=gitlabHttps){
  const base=gitlabBaseUrl(baseUrl)
  if(!path.startsWith('/') || path.startsWith('//') || /[\r\n#]/.test(path))throw new IntegrationError('Invalid GitLab request.')
  let response:Response
  try{response=await transport(new URL(`${base}/api/v4${path}`),token)}catch{throw new GitlabError('Could not reach GitLab. Check the website URL and server network access; saved tickets are still available.',502)}
  if(!response.ok){
    if(response.status===429){const seconds=Number(response.headers.get('retry-after')) || 60;throw new GitlabError('GitLab has temporarily limited requests. Sync will resume after the limit resets.',429,Math.max(60,Math.min(86400,seconds)))}
    if(response.status===401)throw new GitlabError('GitLab token expired or was revoked. Replace your personal token in My GitLab settings.',409)
    if(response.status===403)throw new GitlabError('GitLab denied access. Check the read_api token scope and project membership.',403)
    if(response.status===404)throw new GitlabError('GitLab project or ticket is unavailable to your token. Check selected projects and access.',404)
    throw new GitlabError('GitLab could not complete the request. Check the instance URL and retry shortly.',502)
  }
  try{return await response.json()}catch{throw new GitlabError('GitLab returned an unreadable response. Check the instance URL.',502)}
}
export function gitlabIdentity(value:any){
  if(!Number.isSafeInteger(value?.id) || value.id<1 || typeof value.username!=='string' || !/^[a-z0-9_.-]{1,100}$/i.test(value.username))throw new IntegrationError('Could not identify the account for this GitLab token.',502)
  return {id:value.id as number,login:value.username as string}
}
export function gitlabIssue(value:any,repository:string,login:string,baseUrl:string){
  if(value?.issue_type && !['issue','incident','task','test_case'].includes(value.issue_type))return null
  if(!Number.isSafeInteger(value?.id) || value.id<1 || !Number.isSafeInteger(value.iid) || value.iid<1 || !['opened','closed'].includes(value.state) || typeof value.title!=='string' || typeof value.author?.username!=='string' || ![value.created_at,value.updated_at].every(date=>typeof date==='string' && Number.isFinite(Date.parse(date))))throw new IntegrationError('GitLab returned an invalid ticket. Retry sync.',502)
  const assignees:string[]=(Array.isArray(value.assignees)?value.assignees:value.assignee?[value.assignee]:[]).map((a:any)=>String(a?.username || '')).filter(Boolean)
  return {gitlab_id:value.id as number,number:value.iid as number,repository,title:value.title.slice(0,500),body:String(value.description || '').slice(0,60000),html_url:`${gitlabBaseUrl(baseUrl)}/${gitlabRepositoryName(repository)}/-/issues/${value.iid}`,state:(value.state==='opened'?'open':'closed') as 'open'|'closed',state_reason:null,creator:value.author.username as string,assignees,labels:(Array.isArray(value.labels)?value.labels:[]).map(String).filter(Boolean).slice(0,100),milestone:String(value.milestone?.title || '').slice(0,300),comments_count:Math.max(0,Math.min(1000000,Number(value.user_notes_count)||0)),created_at:value.created_at as string,updated_at:value.updated_at as string,created_by_me:value.author.username.toLowerCase()===login.toLowerCase(),assigned_to_me:assignees.some(a=>a.toLowerCase()===login.toLowerCase()),available:true}
}
