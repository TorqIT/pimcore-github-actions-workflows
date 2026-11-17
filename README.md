This repository contains several [reusable GitHub Actions workflows](https://docs.github.com/en/actions/using-workflows/reusing-workflows) that can be referenced when developing Pimcore projects.

## Usage

The above link should provide the necessary information for using these workflows within your project, but generally you can call a workflow like this:

```yaml
jobs:
  call-reusable-workflow:
    uses: TorqIT/pimcore-github-actions-workflows/.github/workflows/workflow-file.yml@sha
    # If the reusable workflow requires inputs:
    with:
      input1: value
      input2: value
    # If the reusable workflow requires secrets:
    secrets:
      secret1: value
      secret2: value
```

where `workflow-file.yml` refers to the actual workflow file you wish to use, and `sha` refers to a commit SHA, tag (e.g. `v7`) or branch name (e.g. `main`). This repository uses a semantic versioning scheme, so referring to a major tag (e.g. `v7`) will allow you to automatically get fixes/non-breaking improvements.

### Environment variables

At present, reusable workflows can access [GitHub Environment](https://docs.github.com/en/actions/deployment/targeting-different-environments/using-environments-for-deployment) variables (i.e. the `vars` context). However, they cannot yet access GitHub Environment secrets directly, so these need to be passed by the caller as demonstrated above.

### Self-hosted runners

All workflows contain an optional `RUNNER` input that will accept the name of a self-hosted runner. If this parameter is not provided, an `ubuntu-24.04` GitHub runner will be used.

## Ignoring vulnerabilities

The `ci-docker.yml` workflow fails when its scans find fixable HIGH or CRITICAL vulnerabilities, and posts the findings as a PR comment. Fixing (upgrading) is always preferred. When a finding does not affect your project, record an exception with a reason in the project repository, as below. When the scan fails, the PR comment includes a ready-to-paste snippet for the advisory it found.

### npm (`.nsprc`)

npm dependencies are audited with [better-npm-audit](https://github.com/jeemok/better-npm-audit), so exceptions go in a `.nsprc` file next to each `package-lock.json`. Keys can be a GHSA ID, CVE, numeric advisory ID or advisory URL:

```json
{
  "GHSA-xvch-5gv4-984h": {
    "active": true,
    "notes": "Why this does not affect us",
    "expiry": "2027-02-15"
  }
}
```

An exception stops applying after its `expiry`, so the build fails again until it is fixed or reviewed. Only production dependencies are scanned. See the [better-npm-audit docs](https://github.com/jeemok/better-npm-audit#managing-exceptions-with-nsprc) for all options, including YAML.

### Composer (`composer.json`)

Composer's own audit is used, so exceptions go in `config.audit.ignore` in the project's `composer.json` (under `PIMCORE_ROOT`), keyed by CVE or advisory ID:

```json
"config": {
  "audit": {
    "ignore": {
      "CVE-2026-12345": "Why this does not affect us (review by 2027-02-15)"
    }
  }
}
```

Composer exceptions do not expire, so include a review date in the reason.

### Docker images (`.trivyignore.yaml`)

Images are scanned with [Trivy](https://trivy.dev). Exceptions go in a `.trivyignore.yaml`, and the workflow only reads it when you pass its path as `TRIVYIGNORE_PATH`:

```yaml
vulnerabilities:
  - id: CVE-2026-12345
    statement: Why this does not affect us
    expired_at: 2027-02-15
```

```yaml
jobs:
  ci:
    uses: TorqIT/pimcore-github-actions-workflows/.github/workflows/ci-docker.yml@v7
    with:
      TRIVYIGNORE_PATH: ./.trivyignore.yaml
```

An exception stops applying after `expired_at`. See the [Trivy docs](https://trivy.dev/latest/docs/configuration/filtering/#trivyignoreyaml) for matching by path or package instead of ID.
