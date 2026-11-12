// Extracted mechanically from the original app's data (frontend/plugins/data.js);
// this file is now the source of truth for the medical copy.
//
// These paragraphs are clinical copy. They contain invisible characters
// (zero-width spaces, double spaces) that retyping would silently drop:
// change a paragraph in place, never retype or reflow one.

export const anatomyText = {
  "normal": "This is an interactive model of the normal breast. This healthy tissue is made up of fibrous glandular tissue (lobules, ducts and ligaments) and normal fatty tissue. Breast tissue also includes lymph nodes, a lymph drainage system and the muscular chest wall. The breast produces milk from the lobules, which travels via the ducts to the nipple when breastfeeding. The lobules, ducts and nipple structures are  highlighted in this model.",
  "density_1": "Breast density has four grades, A – D.​ Low density (A) are made up of mostly non dense tissue. Fibrous and glandular tissue makes up less than 25 % of the breast. About 1 in 10 women are grade A.",
  "density_2": "Breast density has four grades, A – D.​ <b>Breast density (B)</b> is  where the breast is mostly made up of fatty tissue but there are areas of scattered dense tissue. 25 to 50 % of the breast is made up of fibrous and glandular tissue. About 4 in 10 women have this",
  "density_3": "Breast density has four grades, A – D.​ <b>Breast density (C)</b> is where there is a mix of fibro glandular and fatty tissue.  51 to 75 % of the breast is made up of fibrous and glandular tissue. Breasts are sometimes described as moderate  density. About 4 in 10 women have this.",
  "density_4": "Breast density has four grades, A – D​. <b>Breast density (D)</b> is extremely dense breast tissue.  75% or more of the breast is made up of fibrous and glandular tissue. About 1 in 10 women has this.",
  "benign_cyst": "Breast cysts are fluid filled sacs. You may have a single cyst or several different sized cysts. Cysts may appear naturally as the breast alters with age or changes  in the oestrogen levels. D Although you can develop breast cysts at any age, they’re most common in women over 35.",
  "benign_fibroadenoma": "Fibroadenomas are found in the breast lobule, which is the part of the breast that produces milk.  Fibroadenomas occurs when tissues in the lobule overgrows and becomes hard. Fibroadenomas are common and thought to be related to the female hormone oestrogen. Hormone levels are higher when we are young, pregnant, breast feeding or taking hormone replacement. Although they can appear at any age, they are more likely when aged 15-40 years.",
  "benign_calcifications": "Breast calcifications are tiny deposits of calcium in the breast tissue they do not cause symptoms but can be seen as white spots on a mammogram . They most commonly occur in women over 50 years of age. The majority are not usually visible on an ultrasound scan. Calcifications that are clearly benign don't require any further investigation or treatment. Sometimes the presence of breast calcifications can indicate cancer but, in most cases, they are totally harmless.",
  "cancer_dcis": "The earliest form of breast cancer is known as DCIS (ductal carcinoma in situ).  DCIS is also called stage 0 breast cancer. ​A diagnosis of DCIS means that cancer cells have formed inside the walls of the ducts but haven’t invaded the surrounding tissue.  DCIS is sometimes called pre-invasive, non-invasive, or intraductal carcinoma.",
  "cancer_lobular": "Invasive lobular carcinoma is a cancer that has spread from the breast lobules into surrounding tissue. It is the second most common type of breast cancer, occurring in 8-10% of all cases. It may be multifocal (found in more than one place in the breast) and is sometimes found in both breasts.",
  "cancer_ductal": "Ductal cancer is the most common type of breast cancer, occurring in approximately 80% of cases and can occur in men as well as women. It arises in the cells lining the breast ducts and invades through the duct wall into surrounding breast tissue.",
} as const

export const mammogramText = {
  "normal": "A screening mammogram is an x-ray of the breasts. It is used to detect breast cancer when it is small before any signs or symptoms can be seen. Normally two views are taken on a screening mammogram, one from the side and one from above. Breast tomosynthesis or 3D mammography is a newer technology which creates a three-dimensional picture on a computer. This uses more radiation than a standard 2D mammogram but may give a clearer picture.​",
  "density_1": "Grade A low density breast tissue can be seen clearly on mammogram.​",
  "density_2": "Grade B Breast can be seen clearly on Mammogram​​",
  "density_3": "Mammograms are used routinely to see any changes in dense breasts. 3D may be recommended to give a clear view.",
  "density_4": "It may be difficult to see any of the breast structures or issues  such as breast cancer through the opaque (dense white) breast tissue. Your doctor or radiologist will use other imaging tools such as ultrasound or MRI to make sure they have a clear view of the whole breast.",
  "benign_cyst": "Ultrasound will confirm whether the lump is solid or cystic (fluid-filled) and this should be performed before any cyst is drained. Sometimes the ultrasound will not show the typical appearance of simple breast cysts, and a needle biopsy may be necessary to make sure they are breast cysts.",
  "benign_fibroadenoma": "Fibroadenomas usually present as a lump, or a change detected on ultrasound/mammogram.​",
  "benign_calcifications": "When calcifications are detected on a mammogram, radiologists examine them closely to assess their size, shape, pattern and distribution. This enables them to distinguish benign calcifications from those which might suggest the presence of cancer or pre-cancer.​ Calcifications that are labelled 'indeterminate' need further investigation to exclude cancer. This might involve extra magnified mammography views or in some cases a biopsy.​",
  "cancer_dcis": "DCIS is commonly seen on a 2D mammogram but depending on the location of the cancer and surrounding tissue a 3D Mammogram or Ultrasound may help to define the dimension of the DCIS more accurately.",
  "cancer_lobular": "Lobular cancer may be visible on mammogram but additional imaging such as 3D mammogram, US and MRI may be required depending on size and location of the cancer.",
  "cancer_ductal": "A 2D diagnostic mammogram  can be very effective in identifying ductal cancer.​ 3D tomosynthesis takes multiple pictures from many angles to construct a three-dimensional image of the breast and can improve the rate of cancer detection and reduce unnecessary biopsies. ",
} as const

export const mriText = {
  "normal": "MRI (magnetic resonance imaging) of the breast uses a powerful magnet, radio waves and a computer to produce detailed images of the breast.  MRI is mostly used as a supplementary tool in breast cancer detection, after mammography and ultrasound. It may be recommended in addition to mammography for screening women who are at high risk of breast cancer due to family history, known gene mutation or breast density; but is not generally used in regular breast screening.​​",
  "density_1": "MRIs are not commonly needed to visualize low density breast tissue but may be used for other purposes like staging breast cancer​.​",
  "density_2": "MRIs are not commonly needed to visualize low density breast tissue but may be used for other purposes like staging breast cancer​",
  "density_3": "MRI may occasionally be used to provide additional views of the breast if an area of concern cannot be seen through the dense tissue. You can see that the MRI image here shows an unobstructed image that is not captured in the mammogram.​​",
  "density_4": "It is  likely that an MRI will be ordered if you have any concerns such as breast lumps or areas of concerns that cant be seen on Mammogram.​​",
  "benign_cyst": "MRI is not commonly used in the assessment of cysts.​",
  "benign_fibroadenoma": "You do not normally require an MRI to see a fibroadenoma- this will show up on a mammogram.",
  "benign_calcifications": "MRIs are not required to see calcification in the breast tissue but may be used to investigate any breast changes that are unclear.",
  "cancer_dcis": "MRI is useful for visualising DCIS in very dense breasts or in in young women.​",
  "cancer_lobular": "Magnetic Resonance Imaging may be used to evaluate the true size and extent of cancers which are not well seen on mammograms, and particularly with lobular cancer, to ensure the cancer is confined to just one breast.",
  "cancer_ductal": "MRI is  useful in the evaluation of dense breasts in young women; lesions that can be felt but are not seen on other imaging; or when breast cancer cells have been found in underarm lymph nodes, but no tumour can be seen in the breast on other imaging. It can also add important information regarding lesions seen on a mammogram.",
} as const

export const lesionSliceIndex = {
  "normal": 0,
  "density_1": 0,
  "density_2": 0,
  "density_3": 0,
  "density_4": 0,
  "benign_cyst": 58,
  "benign_fibroadenoma": 68,
  "benign_calcifications": 0,
  "cancer_dcis": 90,
  "cancer_lobular": 80,
  "cancer_ductal": 27,
} as const
