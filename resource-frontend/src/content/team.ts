/**
 * The About page's roster, partner organisations and data citations.
 *
 * ## Why this file exists
 *
 * All of it used to be ONE 3310x2437 PNG (`team.png`, 4.9MB) that the legacy
 * About page rendered with a single `<img>`. Names, affiliations, dataset
 * citations and their DOIs were pixels. That meant: unreadable to a screen
 * reader, unsearchable, unselectable, untranslatable, blurred on zoom, the
 * DOI links unclickable, and a typo in anyone's name needing the whole sheet
 * re-exported. The sixteen portraits were cut out of that sheet into
 * `public/team/`; everything that was TEXT in it lives here as text.
 *
 * ## Provenance, and what still needs checking
 *
 * The names and the first two citations are transcribed from a screenshot of
 * the DEPLOYED legacy site, which is newer than any source that was in this
 * repository -- on the version we had, they existed only inside the bitmap.
 * A human needs to confirm spellings, current affiliations, and whether the
 * roster is still accurate.
 */

export interface TeamMember {
  name: string
  /** Filename under `public/team/`. */
  photo: string
}

export interface Organisation {
  name: string
  /** Filename under `public/logos/`, or undefined for a group with no mark of
   * its own (the BBRG's only badge on the legacy sheet was a render of the
   * breast mesh, which is an illustration rather than a logo). */
  logo?: string
  /**
   * Display width, in `rem`.
   *
   * Presentation in the content layer, deliberately. These three marks have
   * wildly different proportions -- a compact 201x120 ribbon, an 811x120
   * wordmark, a 587x120 lockup -- so any single CSS rule makes two of them
   * wrong: matched heights leave the ribbon a stamp beside a banner, matched
   * widths make the ribbon tower over the other two. The legacy app solved it
   * the same way and for the same reason (`w-20` / `w-32` / `w-48` in
   * frontend/components/about/Logo.vue); optical balance is a property of the
   * artwork, and the artwork is what lives here.
   */
  logoWidth?: number
  members: TeamMember[]
}

const member = (name: string): TeamMember => ({
  name,
  photo: `${name.toLowerCase().replace(/[^a-z]+/g, '-')}.webp`,
})

export const organisations: Organisation[] = [
  {
    name: 'Breast Cancer Foundation NZ',
    logo: 'breast-cancer-foundation-nz.webp',
    // The legacy app's own ratios (Logo.vue: w-20 / w-32 / w-48).
    logoWidth: 5,
    members: ['Suzanne Bull', 'Natalie James'].map(member),
  },
  {
    name: 'Iwi United Engaged',
    logo: 'iwi-united-engaged.webp',
    logoWidth: 8,
    members: ['Kika Faagatu', 'Misty Edmonds'].map(member),
  },
  {
    /**
     * ONE group, not two.
     *
     * The legacy sheet laid these twelve people out as two separate rows,
     * each against its own badge -- the University lockup above, the group's
     * breast-mesh render below -- which reads as two organisations and was
     * transcribed that way at first. They are all members of the Breast
     * Biomechanics Research Group at the Auckland Bioengineering Institute;
     * the two rows were a layout decision on a sheet that had no room for
     * twelve portraits across.
     */
    name: 'Auckland Bioengineering Institute — Breast Biomechanics Research Group',
    logo: 'auckland-bioengineering-institute.webp',
    logoWidth: 12,
    members: [
      'Linkun Gao',
      'Jiali Xu',
      'Prasad Babarenda Gamage',
      'Martyn Nash',
      'Poul Nielsen',
      'Gonzalo Maso Talou',
      'Chinchien Lin',
      'Xinyue Zhong',
      'Matthew French',
      'John Pan',
      'Robin Laven',
      'Max Dang Vu',
    ].map(member),
  },
]

export interface Citation {
  /** What this source provided, in this app's own words. */
  used: string
  /** The full reference, minus the DOI. */
  reference: string
  doi: string
}

export const citations: Citation[] = [
  {
    used: 'MRI and 3D mammography images',
    reference:
      'Comstock, C. E., Gatsonis, C., Newstead, G. M., Snyder, B. S., Gareen, I. F., '
      + 'Bergin, J. T., Rahbar, H., Sung, J. S., Jacobs, C., Harvey, J. A., '
      + 'Nicholson, M. H., Ward, R. C., Holt, J., Prather, A., Miller, K. D., '
      + 'Schnall, M. D., & Kuhl, C. K. (2023). Abbreviated Breast MRI and Digital '
      + 'Tomosynthesis Mammography in Screening Women With Dense Breasts (EA1141) '
      + '(Version 1) [dataset]. The Cancer Imaging Archive.',
    doi: 'https://doi.org/10.7937/2BAS-HR33',
  },
  {
    used: 'Ultrasound images',
    reference:
      'Pawłowska, A., Ćwierz-Pieńkowska, A., Domalik, A., Jaguś, D., Kasprzak, P., '
      + 'Matkowski, R., Fura, Ł., Nowicki, A., & Żołek, N. (2024). A Curated '
      + 'Benchmark Dataset for Ultrasound Based Breast Lesion Analysis '
      + '(Breast-Lesions-USG) (Version 1) [dataset]. The Cancer Imaging Archive.',
    doi: 'https://doi.org/10.7937/9WKK-Q141',
  },
  {
    used: '3D breast model',
    reference:
      'Heidi Schlehlein (2022). 3D Reference Organ for Breast (mammary gland), '
      + 'Female left, v1.0.',
    doi: 'https://doi.org/10.48539/HBM989.SNHP.535',
  },
]

/** The legacy app's feedback form (frontend/components/about/AboutUs.vue). */
export const FEEDBACK_FORM_URL
  = 'https://docs.google.com/forms/d/e/1FAIpQLScsab93B7uPg389gxCNfCSgG4sMNIFk_mxDFTFF_-UC2TcSJQ/viewform?usp=sf_link'
