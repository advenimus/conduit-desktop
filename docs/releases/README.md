# Release notes

Each release has a hand-written notes file named after its tag, for example `v0.18.1.md`.

The release workflow (`.github/workflows/release.yml`) reads `docs/releases/<tag>.md` when it creates the GitHub release, then adds the Downloads table underneath. If the file is missing, the workflow falls back to GitHub's generated list of merged PRs and prints a warning.

## Before you tag

1. Write `docs/releases/vX.Y.Z.md` and merge it to `main`.
2. Tag and push. The workflow publishes the notes with the installers.

To fix notes after release, edit the file and the GitHub release (`gh release edit vX.Y.Z --notes-file ...`).

## Betas

A beta is tagged `vX.Y.Z-beta.N` and needs its own notes file, `docs/releases/vX.Y.Z-beta.N.md`. The workflow marks any tag with `beta`, `alpha` or `rc` as a GitHub pre-release. It also stops if the tag does not match the `package.json` version exactly. See `docs/BETA_CHANNEL.md` for the whole process.

- Title it `## Conduit vX.Y.Z-beta.N`.
- Say in the first line that it is a beta and what to try.
- Add a `### Feedback` section that points to the Beta pill or Help > Submit Feedback.
- The regular `vX.Y.Z` notes cover everything again for users who skipped the betas.

## Format

```markdown
## Conduit vX.Y.Z

One or two plain sentences on what this release is about.

### Highlights      (big releases only)
### New
### Improved
### Fixed
### Good to know    (changes that affect existing users)
### Under the hood  (internal work, at most a bullet or two)
```

- Leave out empty sections.
- Write for end users. Say what they see or can now do, not file or function names.
- One line per bullet.
- Do not add the Downloads table. The workflow adds it.
