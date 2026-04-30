# Artemis Release Guide

This is the release path for publishing Artemis to GitHub and npm.

## Current Targets

- GitHub repository: `https://github.com/420company/artemis`
- Default branch: `main`
- npm package: `artemis-code`
- CLI binary: `artemis` from `dist/cli.js`

## Preflight

Run the full local release check:

```bash
npm run release:check
```

This runs typecheck, lint, all smoke tests, build, and `npm pack --dry-run`.
Do not publish if this command fails.

## Version

Update `package.json` and `package-lock.json` together:

```bash
npm version patch --no-git-tag-version
```

Use `minor` or `major` instead of `patch` when the release warrants it.

## GitHub

Commit the release and tag it:

```bash
git status --short
git add package.json package-lock.json src docs README.md
git commit -m "Release x.y.z"
git tag vx.y.z
npm run release:git
```

Confirm CI passes on GitHub before publishing to npm.

## npm

Confirm the npm identity and target version:

```bash
npm whoami
npm view artemis-code version
```

Publish:

```bash
npm run release:npm
```

Verify the registry:

```bash
npm view artemis-code version dist-tags bin
```

## Post-Publish Smoke Test

Install the published package in a clean shell:

```bash
npm install -g artemis-code@latest
artemis --version
artemis --help
```

The reported version should match the Git tag and npm version.
