// The parts of the rejected VS Code clone that must never appear in the app (docs/VISUAL_REDESIGN.md
// L-20 and Appendix B). Rule G2 of the restyle suite fails when any of these matches. This is the only
// file of the harness that names them.

export const CLONE_SELECTORS = Object.freeze([
  '[data-cv-titlebar]',
  '[data-cv-activitybar]',
  '[data-cv-statusbar]',
  '[data-cv-command-center]',
  '[data-cv-card]',
  '[data-cv-editor-card]',
  '.cv-card',
  '.cv-workbench',
  '[data-cv-window]',
  '[data-cv-layout]',
  '[data-cv-app-menu]',
  '[data-cv-caption]',
  '[data-cv-activity]',
  '[data-cv-status]',
]);
