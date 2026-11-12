# Manual accessibility pass

Everything here is what `test-browser/a11y.spec.ts` and the rest of the
Playwright suite **cannot** settle. Anything on this list that becomes
automatable belongs in a spec instead — a checklist item is a promise
someone will remember, and the branch has already shipped defects that were
ticks nobody ran.

Run before a release. Automated cover to date: axe reports 0 serious/
critical on 5 pages; 468 unit tests; 23 browser tests.

## Keyboard

- [ ] Tab order at one-up: skip link → sidebar toggle → panel toggle →
      wordmark → content toggle → About → sidebar links → panel tabs →
      stage → that stage's control bar
- [ ] Tab order at three-up: the three panels come in visual order, each
      followed by its own control bar
- [ ] Stage focused: arrow keys orbit
- [ ] Stage focused: `+` / `-` zoom
- [ ] Stage focused: `[` / `]` step slices
- [ ] Panel tab focused: ← / → move between slots
- [ ] Drawer open below xl: Esc closes it, focus returns to the toggle
- [ ] Focus never escapes the open drawer while tabbing
- [ ] Every focus ring is visible: 2px brand, 2px offset
- [ ] The stage's own ring is visible against a bright model AND a black
      MRI slice — it is an inset double shadow, not an outline
- [ ] Fullscreen from a panel's control bar can be left again from inside
      fullscreen (the button goes with the panel)

## Screen reader (NVDA / VoiceOver)

- [ ] Each stage announces "{Panel}: {Modality} viewer" — three distinct
      names at three-up, not three identical ones
- [ ] The slice readout announces the SETTLED number, once per scrub, not
      once per frame
- [ ] Sidebar current item announces as current page
- [ ] Panel tab current item announces as current step
- [ ] The 3D/2D control announces its pressed state
- [ ] Loading announces once and stops; it does not repeat while a 50MB
      volume downloads

## Visual

- [ ] DevTools → Rendering → Achromatopsia: the three sidebar groups are
      still distinguishable (they carry icons as well as colour)
- [ ] Same filter: the focused panel is still identifiable at three-up
      (border + ring + shadow, not colour alone)
- [ ] Browser zoom 200%: nothing clipped, no horizontal scroll
- [ ] Windows high-contrast mode: the app is still usable
- [ ] Keyboard only, no mouse: open a case → switch panel → toggle 2D/3D →
      step slices → reset view

## Motion

- [ ] `prefers-reduced-motion: reduce`: the density crossfade completes
      instantly rather than over 800ms
- [ ] Same setting: panel and drawer transitions resolve with no
      intermediate frames
- [ ] Every feature still works under that setting — instant, not absent

## Touch

- [ ] 375px: every control is at least 44×44px
- [ ] iPad: dragging the slice plane scrubs; dragging empty space orbits
- [ ] iPad: the page itself does not scroll while orbiting the stage

## Content

- [ ] Medical copy is character-for-character the legacy app's (unit tests
      assert this, but re-read one case against the old build if it is
      still available)
