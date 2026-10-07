# Local plugin tarballs are copied into the project

`frameshell plugin install` also takes a local tarball made by `npm pack` (#54), so official plugins install before they are on npm and branch builds can be tried. A tarball from outside the project is copied to `<project>/vendor/<file>` and pinned project-relative as `file:vendor/<file>#sha256=<digest>`. An absolute pin would work only on the machine that installed it; a clone of the project would carry a pin it cannot resolve. The digest makes trust cover the exact bytes: a tarball that changed after pinning is never installed. A `vendor/` file is never overwritten: a new build with the same file name is copied to `vendor/<stem>-<digest>.tgz` and replaces its package's pin, so a failed install leaves the old pin working (#125). The old copy stays until the user deletes it.

## Considered options

- **Pin the absolute path.** No copy, but not portable across clones or machines.
- **Refuse outside tarballs.** Portable, but makes the user copy by hand for no gain.
- **Remote tarball URLs.** Refused: a URL's bytes can change under the pin, and npm or git sources cover remote installs.
