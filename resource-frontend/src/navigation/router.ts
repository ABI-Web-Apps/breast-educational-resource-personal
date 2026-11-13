import type { ComputedRef, InjectionKey, Plugin, ShallowRef } from 'vue'
import { computed, inject, nextTick, provide, shallowRef } from 'vue'
import { normalisePath, resolveFinal } from './routes'
import type { PageRoute } from './routes'

/**
 * Navigation without vue-router.
 *
 * The portal mounts every plugin as its own Vue app inside a page that the
 * PORTAL's router owns, so this app cannot install a router of its own: a
 * second router would fight the portal's for the address bar. What the app
 * needs from a router is small -- a current page, a way to change it, and
 * links -- and that is all this is.
 *
 * Two modes, chosen once at creation:
 *
 *   history: true   (standalone build)  the address bar is the source of
 *                   truth, exactly as it was under Nuxt: deep links,
 *                   reload, back/forward all work.
 *   history: false  (plugin build)      navigation is in memory only. The
 *                   portal's URL never changes and the browser's Back
 *                   button stays the portal's own "leave the plugin".
 */

export interface AppRouter {
  /** The page on screen. */
  route: Readonly<ShallowRef<PageRoute>>
  /** Resolves when the new route is current (not yet rendered -- the
   *  callers that need the DOM wait a tick themselves, as they did with
   *  vue-router). */
  navigateTo: (path: string, options?: { replace?: boolean }) => Promise<void>
  /** What an `<a href>` should carry for an in-app path. */
  href: (path: string) => string
  /** Starts listening to back/forward. Standalone only; a no-op otherwise. */
  start: () => void
  stop: () => void
}

export interface RouterOptions {
  history: boolean
  /** The deployment base, e.g. `/` or `/breast-educational-resource/`. */
  base: string
  /** Where a memory router starts. Ignored with `history`. */
  initialPath?: string
}

const ROUTER: InjectionKey<AppRouter> = Symbol('app-router')
const PAGE_ROUTE: InjectionKey<ComputedRef<PageRoute>> = Symbol('page-route')

function trimBase(base: string): string {
  return base.replace(/\/+$/, '')
}

export function createAppRouter(options: RouterOptions): AppRouter {
  const base = trimBase(options.base)

  function locationPath(): string {
    const { pathname, search, hash } = window.location
    const inApp = base && pathname.startsWith(base) ? pathname.slice(base.length) : pathname
    return `${inApp || '/'}${search}${hash}`
  }

  function href(path: string): string {
    return options.history ? `${base}${normalisePath(path)}` : normalisePath(path)
  }

  const initial = resolveFinal(options.history ? locationPath() : (options.initialPath ?? '/'))
  const route = shallowRef<PageRoute>(initial.route)
  if (options.history && initial.redirected) {
    window.history.replaceState(window.history.state, '', href(initial.route.path))
  }

  /**
   * Scroll handling, matching Nuxt's default `scrollBehavior`: a new page
   * starts at the top, Back/Forward returns to where the reader was, and a
   * navigation that keeps the same path leaves the scroll alone.
   */
  let scrollKey = 0
  const savedScroll = new Map<number, { x: number, y: number }>()

  function settleScroll(to: { x: number, y: number } | undefined) {
    if (!options.history) return
    void nextTick(() => requestAnimationFrame(() => {
      window.scrollTo(to?.x ?? 0, to?.y ?? 0)
    }))
  }

  async function navigateTo(path: string, opts: { replace?: boolean } = {}) {
    const { route: next } = resolveFinal(path)
    // vue-router treats a navigation to the current location as a no-op:
    // no history entry, no route change, no scroll. So does this.
    if (next.path === route.value.path) return
    if (options.history) {
      const url = href(next.path)
      if (opts.replace) {
        window.history.replaceState({ ...window.history.state, scrollKey }, '', url)
      }
      else {
        savedScroll.set(scrollKey, { x: window.scrollX, y: window.scrollY })
        scrollKey += 1
        window.history.pushState({ scrollKey }, '', url)
      }
    }
    route.value = next
    settleScroll(undefined)
  }

  function onPopState(event: PopStateEvent) {
    const { route: next, redirected } = resolveFinal(locationPath())
    if (redirected) window.history.replaceState(event.state, '', href(next.path))
    const from = route.value
    savedScroll.set(scrollKey, { x: window.scrollX, y: window.scrollY })
    scrollKey = typeof event.state?.scrollKey === 'number' ? event.state.scrollKey : 0
    route.value = next
    if (next.path !== from.path) settleScroll(savedScroll.get(scrollKey))
  }

  let listening = false
  function start() {
    if (!options.history || listening) return
    listening = true
    if ('scrollRestoration' in window.history) window.history.scrollRestoration = 'manual'
    window.history.replaceState({ ...window.history.state, scrollKey }, '')
    window.addEventListener('popstate', onPopState)
  }
  function stop() {
    if (!listening) return
    listening = false
    window.removeEventListener('popstate', onPopState)
  }

  return { route, navigateTo, href, start, stop }
}

export function provideAppRouter(router: AppRouter) {
  provide(ROUTER, router)
}

/** The same, as an app-level plugin -- for mounting a component on its own. */
export function appRouterPlugin(router: AppRouter): Plugin {
  return { install: app => { app.provide(ROUTER, router) } }
}

export function useAppRouter(): AppRouter {
  const router = inject(ROUTER, null)
  if (!router) throw new Error('useAppRouter() called outside the app shell')
  return router
}

/**
 * Gives a page's subtree the route that page was rendered for.
 *
 * Pages are kept alive (see App.vue), so a hidden case page is still
 * reactive while /about is on screen. Reading the LIVE route there would
 * hand it `/about`, which names no case -- so each page publishes its own
 * route, frozen while it is hidden. This is what Nuxt's `RouteProvider`
 * did for `useRoute()` inside a page.
 */
export function providePageRoute(route: ComputedRef<PageRoute>) {
  provide(PAGE_ROUTE, route)
}

export function usePageRoute(): ComputedRef<PageRoute> {
  const pageRoute = inject(PAGE_ROUTE, null)
  if (pageRoute) return pageRoute
  const router = useAppRouter()
  return computed(() => router.route.value)
}

/**
 * The route of the enclosing page when there is one, else the live route,
 * else null. For chrome (the sidebar) that renders inside a page but is also
 * mounted on its own, where there is no router to ask.
 */
export function useOptionalPageRoute(): ComputedRef<PageRoute> | null {
  const pageRoute = inject(PAGE_ROUTE, null)
  if (pageRoute) return pageRoute
  const router = inject(ROUTER, null)
  return router ? computed(() => router.route.value) : null
}
