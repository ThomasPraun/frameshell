# Contributing to Frameshell

Thanks for your interest. Frameshell is pre-alpha: the [specification](docs/SPEC.md) is settled and implementation is starting. The most useful contributions right now are issues that challenge the spec with concrete use cases.

## Before you start

- Read [`docs/SPEC.md`](docs/SPEC.md). Its decisions are settled. To change one, open an issue explaining the problem first; accepted changes are recorded as ADRs in `docs/adr/`.
- Check open issues. Pick one without an assignee and comment before starting large work.
- Domain terms are defined in `GLOSSARY.md` (created as terms get settled). Use them in code, issues and PRs.

## Pull requests

- One logical change per PR. Link the issue it resolves.
- Tests first for core logic (schema, operations, ffmpeg compiler).
- Public members carry TSDoc comments that explain why, contract and edge cases.
- User-visible changes add an entry under `## [Unreleased]` in [`CHANGELOG.md`](CHANGELOG.md).
- English for code, comments, docs and UI strings. UI strings go through i18n.

## Developer Certificate of Origin (DCO)

Frameshell uses the [Developer Certificate of Origin 1.1](https://developercertificate.org/) instead of a CLA. By signing off a commit you certify that you wrote the change or otherwise have the right to submit it under the project's [Apache 2.0 license](LICENSE).

Sign off every commit:

```sh
git commit -s -m "feat(core): add clip split operation"
```

This appends a line with your real name and email:

```
Signed-off-by: Jane Doe <jane@example.com>
```

Forgot? Amend the last commit with `git commit --amend -s --no-edit`, or sign off a whole branch with `git rebase --signoff main`. PRs with unsigned commits cannot be merged.

## Plugins

Plugins live in their own repositories. Tag the repo with the GitHub topic `frameshell-plugin` to get it indexed. The plugin API is described in [`docs/SPEC.md` §8](docs/SPEC.md#8-plugin-system).

## Security

Please do not report security issues in public issues. Use [GitHub private vulnerability reporting](https://github.com/ThomasPraun/frameshell/security/advisories/new) instead.

## License

By contributing, you agree that your contributions are licensed under the [Apache License 2.0](LICENSE).
