# Permissions

Grant the credential access only to repositories where you create or manage agent tasks.

## GitHub App permissions

| Permission | Access | Used by |
| --- | --- | --- |
| Agent tasks | Read and write | Create, read, abort, steer, and list task events. The models endpoint uses the same token. |
| Contents | Read and write | `steer_agent_task` and `abort_agent_task` through GitHub's internal steer endpoint. |
| Pull requests | Read | Read an open pull request and resolve its number and URL. |
| Metadata | Read | Required for all GitHub App API access. |

Install the app with **Only select repositories**. Organization owners must install it for the organization. If the organization uses SAML SSO, authorize the app before using its repositories.

## Personal access token permissions

The fine-grained PAT needs **Agent tasks: read and write** for the target repositories. `steer_agent_task` and `abort_agent_task` also need repository content write access.

## Missing permissions

The server reports a missing permission from `X-Accepted-GitHub-Permissions` when GitHub supplies it. Other known errors include:

- `repository_write_access_required`: missing Contents: write.
- `Resource not accessible by integration`: the permission required by that API call.
- GitHub App 404: the server names the repository and links to the app installation page.

The steer and abort tools call an undocumented internal GitHub endpoint. GitHub can change that endpoint without notice.
