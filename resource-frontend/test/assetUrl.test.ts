import { describe, expect, it } from 'vitest'
import { assetUrl, resolveAssetBase } from '../src/composables/assetUrl'

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
