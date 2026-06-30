# Maintainer Release Notes

This repository is published from the official `focuxdot` GitHub account. This
account is only for the public Provider Node repository; the private
`/Users/fou/dev/openrouter` monorepo must keep its original
`brucephaner/openrouter` remote and Git identity.

Public repository:

```bash
git@github.com:focuxdot/wokey-provider-node.git
```

On the maintainer machine, use the dedicated SSH key for pushes:

```bash
GIT_SSH_COMMAND="ssh -i ~/.ssh/github_focuxdot_account -o IdentitiesOnly=yes" git push -u origin main
```

The same restriction can be stored as local Git config inside this repository:

```bash
git config --local core.sshCommand "ssh -i ~/.ssh/github_focuxdot_account -o IdentitiesOnly=yes"
```

Do not publish this repository from the private monorepo remote or a personal
GitHub identity.
