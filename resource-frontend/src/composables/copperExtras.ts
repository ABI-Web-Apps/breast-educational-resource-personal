/**
 * The functions this app contributed back to copper3d, re-exported from the
 * package so the rest of the app names them in one place.
 *
 * They lived in `app/composables` until copper3d 3.8.0/3.9.0 shipped them, and
 * for a while this file was 20 hand-written wrappers over a shimmed dynamic
 * import -- a static re-export used to throw at module scope. See
 * `copper3dModule.ts` for why that is no longer true.
 */

export type {
  AxisGatedControls,
  ExposureVolume,
  FadeTarget,
  FitBounds,
  GestureAxes,
  Pose,
  SceneBudget,
} from 'copper3d'

export {
  addVolumeBoundingBox,
  beginGesture,
  collectFadeTargets,
  createSceneBudget,
  DEFAULT_TARGET_GREY,
  defaultBudgetBytes,
  disposeMaterial,
  disposeObject3D,
  disposeScene,
  easeInOutCubic,
  exposureExponent,
  fitDistance,
  fitView,
  installFastSliceRepaint,
  interpolateFlightPose,
  isGestureActive,
  isPanEnabled,
  isRotateEnabled,
  orbitStepPose,
  orbitSwingAngle,
  poseDistance,
  removeSceneFromMap,
  restoreFade,
  rotateAroundAxis,
  setCameraPose,
  setDracoDecoderPath,
  setFade,
  setPanEnabled,
  setRotateEnabled,
  VOLUME_BOUNDS_NAME,
  viewPointToPose,
  zoomPose,
} from 'copper3d'
