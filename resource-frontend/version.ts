import { readFileSync } from 'node:fs'

/**
 * The app's version, read from package.json at build time.
 *
 * One source of truth: nuxt.config.ts injects the return value into
 * runtimeConfig.public.appVersion, so bumping package.json is the only
 * edit a release needs.
 *
 * Takes a filesystem path rather than deriving one from `import.meta.url`:
 * Vitest does not give that a `file:` scheme, which would make this
 * untestable. The caller resolves the path.
 */
export function readAppVersion(pkgPath: string): string {
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as { version?: string }
  if (!pkg.version) throw new Error(`No "version" field in ${pkgPath}`)
  return pkg.version
}
