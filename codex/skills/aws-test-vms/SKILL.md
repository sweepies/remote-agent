---
name: aws-test-vms
description: Mint short-lived AWS credentials via the fnox aws lease and manage ephemeral test VMs on the tailnet. Use when you need AWS access to launch a test VM, SSH into it, or tear one down.
---

# AWS test VMs

Short-lived AWS access for launching ephemeral test VMs. The credential
chain is tsiam JWT (5 min) -> Pocket ID OIDC (10 min, federated
client_credentials) -> STS AssumeRoleWithWebIdentity. You never handle the
intermediate tokens; the fnox lease does it.

## Mint credentials

```bash
eval "$(fnox -c /home/agent/fnox.toml -P aws lease create aws --format env)"
```

This exports `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`,
`AWS_SESSION_TOKEN`, `AWS_REGION`. The lease lives in the `aws` fnox
profile (NOT the default profile), so it never runs at boot; mint it only
when you need it. The fnox daemon caches the lease for 1h, then re-mints
on the next call. `--format env` is the eval-able format (`shell` prints a
human table). Never run `fnox -P aws exec` for ordinary commands; the
profile exists only for the lease.

## Launch a VM

Hard constraints (the IAM policy rejects anything else):

- region `us-west-2`
- AMI `ami-08205bb9c49ce7df5` (Ubuntu 24.04 + tailscaled, joins the tailnet
  on first boot)
- every resource tagged `provisioned-by=remote-agent`

```bash
VM_KEY="$(fnox -c /home/agent/fnox.toml exec -- sh -c 'printf %s "$TAILSCALE_VM_AUTHKEY"')"
aws ec2 run-instances --region us-west-2 \
  --image-id ami-08205bb9c49ce7df5 \
  --instance-type t3.micro \
  --user-data "TS_AUTHKEY=${VM_KEY}" \
  --tag-specifications \
    'ResourceType=instance,Tags=[{Key=provisioned-by,Value=remote-agent}]' \
    'ResourceType=volume,Tags=[{Key=provisioned-by,Value=remote-agent}]' \
  --query 'Instances[0].InstanceId' --output text
```

No key pair or open SSH port needed: the VM joins the tailnet as
`test-vm-<instance-id>` with `tag:remote-agent` (ephemeral), and Tailscale
SSH is allowed `tag:remote-agent` -> `tag:remote-agent`. Never bake the
Tailscale key into an image or commit it; it is injected at launch via
user data only.

## SSH

```bash
ssh ubuntu@test-vm-<instance-id>
```

Wait ~1-2 min after launch for the tailnet join (cloud-init runs
`tailscale up` on first boot). If the node is not up yet, `tailscale
status` on this box will not list it.

## Terminate

Always terminate test VMs when done; they cost money while running.

```bash
aws ec2 terminate-instances --region us-west-2 --instance-ids <instance-id>
```

The VM is ephemeral, so its tailnet node disappears on its own. Verify
with `tailscale status` that `test-vm-<instance-id>` is gone.

## Rules

- Never provision more than asked; no fleet, no unattended VMs.
- Never launch outside `us-west-2`, never use a different AMI, never skip
  the `provisioned-by=remote-agent` tag. The IAM policy will reject it.
- The lease credentials expire on their own; there is nothing to revoke.
