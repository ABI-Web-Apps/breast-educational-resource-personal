import { getCase } from '@/content/cases'

/**
 * The key App.vue's `<KeepAlive>` uses to decide when the case page -- and with it
 * the three `CopperStage` instances, their renderers and their scene
 * caches -- is reused rather than rebuilt.
 *
 * ## One key for every case
 *
 * It is a constant. Every case page reuses one component instance, so a
 * navigation from `benign-cyst` to `cancer-dcis` keeps three live
 * renderers and everything decoded into them.
 *
 * This is client feedback item 5, "The 3d views (images and models) no
 * longer cache and reload each time (slows interaction)". Per-slug keys
 * meant leaving a case ran `useCopperStage`'s `onScopeDispose`, which
 * destroys the WebGLRenderer and every scene in it -- so returning
 * re-downloaded and re-decoded 10-53MB. The legacy app built its three
 * renderers at module scope and never tore them down; this is the same
 * lifetime, expressed through the page key.
 *
 * What bounds memory now is `sceneBudget.ts`, not the page key. Before,
 * teardown was doing that job by accident, badly: it freed everything on
 * every navigation whether or not there was any pressure to.
 *
 * ## Why the 404 rule is not in the page
 *
 * With the key pinned, CasePage's setup does not re-run on navigation, so a
 * setup-time check would only ever fire on the first case page of a
 * session. The route table (navigation/routes.ts) resolves EVERY
 * navigation regardless of instance reuse, which is why the 404 behaviour
 * survives this. Do not move it into the page.
 *
 * Every non-case route keys on its own path (App.vue).
 */
const CASE_PAGE_KEY = 'case'

export function casePageKey(slug: string | undefined): string | undefined {
  if (typeof slug !== 'string') return undefined
  return getCase(slug) ? CASE_PAGE_KEY : undefined
}
