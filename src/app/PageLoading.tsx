/** Shown while a page downloads (usually a moment); see lazyPage.ts. */
export function PageLoading() {
  return (
    <section className="page-stack page-loading" aria-busy="true">
      <p className="muted">Loading…</p>
    </section>
  )
}
