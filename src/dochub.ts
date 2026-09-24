export type DocHubSigner = { name: string; email?: string; label?: string; id?: string; status?: string; viewedAt?: string; signedAt?: string; removed?: boolean; roleId?: string }
export type DocHubDocument = { id: string; kind: string; title: string; taskId?: string; clientId?: string; projectId?: string; status: string; documentUrl?: string; documentId?: string; signRequestId?: string; error?: string; setupNote?: string; createdAt: string; createdBy?: string; createdByName?: string; updatedAt?: string; checkedAt?: string; followUpDate?: string; signers: DocHubSigner[]; events: { id: string; message: string; createdAt: string }[] }
export type DocHubLink = { id: string; title: string; status: string; signed: number; total: number; documentUrl: string }
export type GeneratedDocument = { fileData: string; fileName: string; mimeType: string }
export const docHubLabels: Record<string,string> = {UPLOAD_FAILED:'Upload needs retry',UPLOADING:'Uploading',IMPORTING:'Converting to PDF',UPLOADED:'Preparing recipients',PREPARING:'Unsent draft · setup required',SETUP_REQUIRED:'Unsent · setup required',READY_TO_REVIEW:'Unsent · ready for review',SENT:'Awaiting signatures',VIEWED:'Viewed · awaiting signatures',PARTIALLY_SIGNED:'Partially signed',DONE:'Done',COMPLETE:'Complete',COMPLETED:'Signature complete',REJECTED:'Rejected',VOID:'Void',VOIDED:'Voided',EXPIRED:'Expired',BOUNCE:'Email delivery failed',ERROR:'Signing error',UNKNOWN:'Status unavailable',REVIEW_REQUIRED:'Import needs review',IMPORT_FAILED:'Import failed'}
export const isArchivedDocHubStatus = (status: string) => ['DONE','COMPLETE','COMPLETED','VOID','VOIDED'].includes(String(status || '').toUpperCase())
export async function dochubRequest(url:string,method='GET',body?:unknown) {
  const response=await fetch(url,{method,credentials:'same-origin',headers:{'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)})
  const data=await response.json().catch(()=>({}))
  if(!response.ok)throw new Error(data.error || 'DocHub request failed. Please retry.')
  return data
}
export function validateSigners(signers:DocHubSigner[]) {
  const active=signers.filter(s=>s.name.trim() || s.email?.trim())
  if(!active.length || active.some(s=>!s.name.trim() || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s.email?.trim() || '')))throw new Error('Add a name and valid email for every signatory before preparing in DocHub. Leave unused signatories blank.')
  if(new Set(active.map(s=>s.email!.trim().toLowerCase())).size!==active.length)throw new Error('Use one signatory per email address.')
}
