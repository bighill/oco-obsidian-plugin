# Contributing to this fork

Thanks for contributing. Note this is an unofficial fork of [`oscarhenrycollins/obsidianclaw`](https://github.com/oscarhenrycollins/obsidianclaw) (originally by [Humanity Labs](https://humanitylabs.org)), maintained by [@bighill](https://github.com/bighill). If your change is broadly useful, consider sending it upstream too. Bug reports and PRs for the fork go to [`bighill/obsidianclaw`](https://github.com/bighill/obsidianclaw).

## Development Setup

1. Clone the repo:
   ```bash
   git clone https://github.com/bighill/obsidianclaw.git
   cd obsidianclaw
   ```
2. Install dependencies:
   ```bash
   npm ci
   ```
3. Build:
   ```bash
   npm run build
   ```

## Validation Before PR

Run all checks before opening a pull request:

```bash
npm run lint
npm run typecheck
npm run build
```

## Pull Request Guidelines

- Keep changes focused and minimal.
- Describe user-visible behavior changes in the PR body.
- If UI changed, include screenshots.
- If release files are touched (`main.js`, `styles.css`, `manifest.json`), explain why.

## Versioning and Release

- Update `manifest.json` version and `versions.json` when shipping a release.
- Tag format is `x.y.z` (for example, `0.41.9`).
- GitHub Actions publishes release assets from tags.

## Security

- Do not commit tokens, secrets, or personal vault data.
- Report security issues privately — see [SECURITY.md](SECURITY.md).
