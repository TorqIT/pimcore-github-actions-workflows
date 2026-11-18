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

## Vulnerability scanning

`ci-docker.yml` scans with [Trivy](https://trivy.dev/): the project's lockfiles (`composer.lock`, `package-lock.json`, …, production dependencies only) and each built image (OS packages and installed libraries). It fails on fixable HIGH and CRITICAL vulnerabilities and, with `POST_SCAN_RESULTS_TO_PR`, posts the results to the PR.

### Ignoring vulnerabilities

If a vulnerability does not affect a project, add it to the project's `.trivyignore.yaml` and pass `TRIVYIGNORE_PATH: ./.trivyignore.yaml` to the CI workflow:

```yaml
vulnerabilities:
  - id: CVE-2026-12345
    statement: Why this does not affect us
    expired_at: 2027-03-01
```

The exception stops applying after `expired_at`. This one file covers Composer, npm and image findings, replacing `.nsprc` files and Composer's `config.audit.ignore`, which are no longer read.

## Dependency-Track

The deploy workflows (`deploy-to-azure-container-apps.yml` and `deploy-to-vm-docker-compose.yml`) can upload a CycloneDX SBOM of everything they deploy to [Dependency-Track](https://dependencytrack.org/), which then monitors it for newly published vulnerabilities. SBOMs are generated with Trivy for each built image and for each npm `package-lock.json` in the project, and are also kept as a workflow artifact.

To enable it, set these GitHub variables (organization-wide or per repository/environment) and pass the secret:

| Name | Type | Description |
|------|------|-------------|
| `DEPENDENCY_TRACK_URL` | Variable | Base URL of the Dependency-Track instance. Uploads only run when this is set. |
| `DEPENDENCY_TRACK_PROJECT` | Variable | Name of the project's parent project in Dependency-Track. Defaults to the repository name. |
| `DEPENDENCY_TRACK_PARENT_VERSION` | Variable | Version of that parent project, if it has one. |
| `DEPENDENCY_TRACK_API_KEY` | Secret | API key of a Dependency-Track team with the `BOM_UPLOAD` and `PROJECT_CREATION_UPLOAD` permissions. |

The parent project must already exist; create it as a collection project. Each SBOM goes into a child project named `<parent>-<name>` (e.g. `acme-php`, `acme-supervisord`, or `acme-frontend` for `frontend/package-lock.json`), whose version and tag are the deployed `ENVIRONMENT`. Each deploy replaces that environment's previous SBOM. Built images carry the standard `org.opencontainers.image.revision` and `org.opencontainers.image.source` labels, which Trivy includes in the SBOM, tying it to the commit it was built from.

A failed upload is reported as a warning and does not fail the deployment.
