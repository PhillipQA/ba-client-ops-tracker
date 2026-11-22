/** A JSON request to the settings API (kept apart from the Settings page so callers don't download the page). */
export async function settingsRequest(url: string, method = 'GET', data?: unknown) {
  const response = await fetch(url, {
    method,
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: data === undefined ? undefined : JSON.stringify(data),
  })
  const result = await response.json()
  if (!response.ok) throw new Error(result.error || 'Settings request failed.')
  return result
}
