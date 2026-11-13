import { describe, expect, it } from 'vitest'
import { absoluteUrl, assetUrl, resolveAssetBase } from '../src/composables/assetUrl'

describe('assetUrl', () => {
  it('joins a same-origin base with a relative path', () => {
    expect(assetUrl('density-1/middle/m3d.nrrd', '/modelView/'))
      .toBe('/modelView/density-1/middle/m3d.nrrd')
  })

  it('tolerates a base without a trailing slash', () => {
    expect(assetUrl('density-1/left/density25.glb', '/modelView'))
      .toBe('/modelView/density-1/left/density25.glb')
  })

  it('tolerates a path with a leading slash', () => {
    expect(assetUrl('/density-1/middle/m_view.json', '/modelView/'))
      .toBe('/modelView/density-1/middle/m_view.json')
  })

  it('supports an absolute CDN base', () => {
    expect(assetUrl('cancer-dcis/right/mri.nrrd', 'https://cdn.example.org/te-uma/'))
      .toBe('https://cdn.example.org/te-uma/cancer-dcis/right/mri.nrrd')
  })

  it('does not collapse a double slash inside the path itself', () => {
    expect(assetUrl('a//b.nrrd', '/modelView/')).toBe('/modelView/a//b.nrrd')
  })

  it('throws on an empty path rather than returning the bare base', () => {
    expect(() => assetUrl('', '/modelView/')).toThrow(/empty/i)
  })
})

describe('resolveAssetBase', () => {
  // Review fix #3: a GitHub Pages subpath deploy (NUXT_APP_BASE_URL) must
  // prefix a root-relative assetBase, or every asset request 404s.
  it('is a no-op at the site root (the default app.baseURL)', () => {
    expect(resolveAssetBase('/modelView/', '/')).toBe('/modelView/')
  })

  it('prefixes a root-relative base with a subpath deploy\'s app.baseURL', () => {
    expect(resolveAssetBase('/modelView/', '/te-uma/')).toBe('/te-uma/modelView/')
  })

  it('tolerates baseURL and assetBase slash variations', () => {
    expect(resolveAssetBase('/modelView', '/te-uma')).toBe('/te-uma/modelView')
    expect(resolveAssetBase('modelView/', '/te-uma/')).toBe('/te-uma/modelView/')
  })

  it('never prefixes an absolute (CDN/object storage) base', () => {
    expect(resolveAssetBase('https://cdn.example.org/te-uma/', '/te-uma/'))
      .toBe('https://cdn.example.org/te-uma/')
  })

  it('is a no-op when app.baseURL is empty', () => {
    expect(resolveAssetBase('/modelView/', '')).toBe('/modelView/')
  })
})

/**
 * copper3d 4.1's `loadNrrd` fetches inside a Web Worker started from a
 * `blob:` URL. A worker resolves `fetch` against its own URL, and nothing
 * relative can be parsed against `blob:` -- so the standalone and plugin
 * builds' root-relative `/api/...` URLs failed before any request went out,
 * while `yarn dev`'s absolute `http://localhost:8082/api/...` worked.
 */
describe('absoluteUrl', () => {
  const page = 'https://portal.example.org/plugin/ber/my-mri'

  it('resolves a root-relative URL against the page origin', () => {
    expect(absoluteUrl('/api/modelView/density-1/right/mri.nrrd', page))
      .toBe('https://portal.example.org/api/modelView/density-1/right/mri.nrrd')
  })

  it('keeps a plugin route prefix', () => {
    expect(absoluteUrl('/plugin/ber/api/patients/a-1/sub-1/mri', page))
      .toBe('https://portal.example.org/plugin/ber/api/patients/a-1/sub-1/mri')
  })

  it('resolves a path-relative URL against the page\'s folder', () => {
    expect(absoluteUrl('modelView/a.nrrd', 'https://host.example.org/te-uma/density-a/mri'))
      .toBe('https://host.example.org/te-uma/density-a/modelView/a.nrrd')
  })

  it('returns an absolute URL unchanged', () => {
    expect(absoluteUrl('http://localhost:8082/api/modelView/a.nrrd', page))
      .toBe('http://localhost:8082/api/modelView/a.nrrd')
  })

  it('produces a URL a blob: base cannot break', () => {
    const resolved = absoluteUrl('/api/x.nrrd', page)
    expect(new URL(resolved, 'blob:https://portal.example.org/0b1c').href).toBe(resolved)
  })
})
