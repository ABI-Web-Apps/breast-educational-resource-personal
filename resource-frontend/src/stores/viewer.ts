import { defineStore } from 'pinia'
import type { ModalityId, PanelId } from '@/content/types'
import { ref } from 'vue'

/** Camera pose snapshot, keyed by `${caseSlug}:${modalityId}`. */
export interface CameraSnapshot {
  position: [number, number, number]
  up: [number, number, number]
  target: [number, number, number]
}

export const useViewerStore = defineStore('viewer', () => {
  const caseSlug = ref('the-breast')
  const modalityId = ref<ModalityId>('anatomy')

  // Panel presence state -- tracks the user's explicit intent only; CSS
  // decides what that intent actually renders as at a given width (see
  // DefaultLayout.vue, design doc §10.1-10.3).
  //
  // sidebarOpen (case navigation drawer, below xl only):
  //   - md..xl (tablet, §10.2): a drawer sliding in from the left.
  //   - <md (phone, §10.3): a drawer dropping down from the top.
  //   - xl+: no consumer. This used to also gate xl+'s panel-collapse, on
  //     the reasoning that every consumer was max-xl:-scoped so the field
  //     was provably inert there -- true when it was written, but false the
  //     moment §10.1's desktop collapse gained a consumer of its own here,
  //     which is exactly how a desktop visitor ended up with no sidebar on
  //     first paint (round 3's regression). One field cannot have two
  //     correct defaults for two tiers with opposite "normal" states, so
  //     desktop collapse now has its own field below. Do not add an xl+
  //     consumer to this one again.
  //   Defaults closed: below xl this is a full-screen drawer + dimming
  //   scrim, so a narrow-viewport visitor's first paint must be the case
  //   they came for, not a drawer already covering it.
  //
  // sidebarExpanded (case navigation panel, xl+ only):
  //   - xl+ (desktop, §10.1): the sidebar is resident; this toggles it
  //     between its normal 240px width and fully collapsed (0px), one half
  //     of the "collapse both panels for projection" feature.
  //   - Below xl: no consumer -- the drawer's presence is sidebarOpen's job.
  //   Defaults expanded: §10.1 shows the sidebar resident by default, only
  //   collapsed on demand, so a desktop visitor's first paint has case
  //   navigation exactly as before this field existed.
  //
  // contentOpen (case content -- ModalityText, prev/next):
  //   - xl+ only: toggles the content column between its normal 400px
  //     width and fully collapsed (0px), the other half of the "collapse
  //     both panels for projection" feature.
  //   - Below xl this has no consumer: tablet's bottom sheet peek/expand
  //     state is deliberately its own local, non-persisted ref in
  //     DefaultLayout.vue (see `sheetExpanded`), not this field -- a bottom sheet
  //     always partially shows regardless of open/closed, which doesn't
  //     map cleanly onto contentOpen's xl+ "fully present or fully gone"
  //     meaning, and forcing one field to mean both would make whichever
  //     default (true) fires on tablet's first paint either always-peeking
  //     (fine) or always-expanded-to-half-screen (obstructs the stage,
  //     the exact first-paint mistake sidebarOpen's default already fixed
  //     once). Phone has no content-collapse concept at all -- the copy is
  //     just inline in the single column.
  //   Defaults open: this is the desktop-only "expanded by default, collapse
  //     on demand" panel the design doc describes, so xl+ visitors see it
  //     exactly as before this field had any consumer. contentOpen never
  //     had sidebarOpen's bug because it never had a second, below-xl
  //     consumer needing the opposite default -- sidebarExpanded exists
  //     specifically because sidebarOpen did.
  /**
   * The slot the reader last chose, remembered across case navigation.
   *
   * Without this, every case page opens on its first slot (anatomy),
   * because that is what the URL falls back to -- so a reader comparing the
   * MRI across four density grades had to re-pick MRI on each one. The
   * human asked for it directly: once a panel has been clicked, remember
   * it even across a page change, and highlight the same one on the way
   * back.
   *
   * Deliberately a SLOT, not a modality: `benign-cyst` is the only case
   * with a 2D ultrasound, so remembering `ultrasound` would mean every
   * other case fell back anyway. A slot exists on every case.
   *
   * Not persisted beyond the session. It is a reading position, not a
   * setting, and a stale one restored days later would be more surprising
   * than helpful.
   */
  const preferredPanel = ref<PanelId>('anatomy')

  const sidebarOpen = ref(false)
  const sidebarExpanded = ref(true)
  const contentOpen = ref(true)

  const cameraSnapshots = ref<Record<string, CameraSnapshot>>({})

  function snapshotKey(slug = caseSlug.value, id = modalityId.value) {
    return `${slug}:${id}`
  }

  function saveCamera(snapshot: CameraSnapshot, key = snapshotKey()) {
    cameraSnapshots.value[key] = snapshot
  }

  function loadCamera(key = snapshotKey()): CameraSnapshot | undefined {
    return cameraSnapshots.value[key]
  }

  return {
    caseSlug,
    preferredPanel,
    modalityId,
    sidebarOpen,
    sidebarExpanded,
    contentOpen,
    cameraSnapshots,
    snapshotKey,
    saveCamera,
    loadCamera,
  }
})
