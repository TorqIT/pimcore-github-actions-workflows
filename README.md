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
