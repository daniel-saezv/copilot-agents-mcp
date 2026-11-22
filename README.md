# copilot-agents-mcp

Servidor MCP local para lanzar agentes de GitHub Copilot en la nube, consultar su estado, leer los modelos de Copilot y, de forma experimental, redirigir una tarea.

No se despliega. Se ejecuta en tu máquina con stdio o, si lo pides, con HTTP en `127.0.0.1`.

## Requisitos

- Node.js 22.18 o posterior (en Windows también).
- Un token de GitHub con el permiso «Agent tasks: read and write» en los repositorios donde lances tareas. Hace falta para lanzar, leer una tarea y listar los modelos. No hace falta para listar las herramientas.

## Cómo preparar el entorno

```bash
bash scripts/setup
```

## Ejecutarlo

```bash
npx -y github:daniel-saezv/copilot-agents-mcp
```

Eso abre el servidor por stdio. Para HTTP:

```bash
npx -y github:daniel-saezv/copilot-agents-mcp --http --port 3333
```

El proceso escucha solo en `127.0.0.1`. La ruta es `/mcp`. También acepta `/mcp/readonly`, `/mcp/x/{toolset}` y las cabeceras `X-MCP-Toolsets`, `X-MCP-Tools`, `X-MCP-Exclude-Tools`, `X-MCP-Readonly` y `X-MCP-Features`.

El vigilante es otro proceso. `create_agent_task` lo arranca desacoplado. También puedes lanzarlo tú:

```bash
npx -y github:daniel-saezv/copilot-agents-mcp watch
```

Consulta cada tarea hasta `completed`, `failed`, `timed_out`, `cancelled` o `idle`. Guarda el estado en un archivo local y, al volver a arrancar, retoma las que no han terminado. Avisa una sola vez cuando un turno llega a un estado final. Tras `steer_agent_task`, vigila el turno nuevo y puede avisar otra vez.

## Configurarlo en un cliente MCP

El token vive en el entorno del proceso, no en los argumentos ni en un archivo.

Stdio:

```json
{
  "mcpServers": {
    "copilot-agents": {
      "command": "npx",
      "args": ["-y", "github:daniel-saezv/copilot-agents-mcp"],
      "env": {
        "GITHUB_PERSONAL_ACCESS_TOKEN": "github_pat_…",
        "COPILOT_AGENTS_NOTIFY_URL": "https://ejemplo.invalid/aviso"
      }
    }
  }
}
```

HTTP: arranca el proceso con el token en el entorno y apunta el cliente a `http://127.0.0.1:3333/mcp`. El cliente no envía el token de GitHub.

## Herramientas

Por defecto están `copilot_tasks` y `copilot_models`. Los toolsets `copilot_automations` y `copilot_agent_merge` piden `--features=agent_automations` y `--features=agent_merge`. En esta versión no tienen herramientas.

<!-- START AUTOMATED TOOLS -->
| Herramienta | Toolset | Solo lectura | Descripción |
| --- | --- | --- | --- |
| `create_agent_task` | copilot_tasks | no | Lanza una tarea del agente de Copilot en la nube. El modelo se envía tal cual. Si ese modelo ya se vio rechazado, no llama a la API y lista los modelos vistos aceptados. |
| `get_agent_task` | copilot_tasks | sí | Lee una vez el estado de una tarea del agente de Copilot. |
| `steer_agent_task` | copilot_tasks | no | [Experimental] Endpoints internos no documentados de GitHub que pueden cambiar sin aviso. Cada steer consume créditos. El agente aplica la instrucción después de terminar la herramienta que esté ejecutando. Envía una instrucción a una tarea con pull request abierta. |
| `abort_agent_task` | copilot_tasks | no | [Experimental] Endpoints internos no documentados de GitHub que pueden cambiar sin aviso. Cada steer consume créditos. El agente aplica la instrucción después de terminar la herramienta que esté ejecutando. Aborta una tarea. |
| `get_agent_task_events` | copilot_tasks | sí | [Experimental] Endpoints internos no documentados de GitHub que pueden cambiar sin aviso. Cada steer consume créditos. El agente aplica la instrucción después de terminar la herramienta que esté ejecutando. Lee una página de eventos de una tarea. |
| `list_copilot_models` | copilot_models | sí | Lee /agents/swe/models y devuelve id, nombre, vendor, preview, el precio por tokens o el multiplier, y la promo si existe. |
<!-- END AUTOMATED TOOLS -->

`create_agent_task` recibe `repo` (`owner/name`), `prompt`, `model` y, si quieres, `base_ref`, `head_ref`, `custom_agent` y `create_pull_request`. El modelo se envía tal cual: no hay una lista en el código. La API responde 201 y puede rechazar el modelo después. Si ya se vio ese rechazo, la herramienta corta con `isError` y lista los modelos vistos aceptados. Si el rechazo llega más tarde, el mismo error queda en el estado y en el aviso.

`get_agent_task` hace una sola lectura. `list_copilot_models` pide a GraphQL (`viewer.copilotEndpoints.api`) la base de la API de Copilot y, en cada llamada, lee `{api}/agents/swe/models`. No guarda caché ni mezcla tareas. La respuesta cita esa URL y `fetched_at`. Si GraphQL o el GET no responden 200, o el formato no cuadra, devuelve un error y no inventa modelos. Los precios salen tal cual, con `batch_size`. `token_prices` es obligatorio salvo que el modelo traiga `billing.multiplier`. `policy` es opcional: si no viene, la salida pone `policy.state` a `null`; si viene, `state` es un string.

## Experimental: redirección de tareas

`steer_agent_task`, `abort_agent_task` y `get_agent_task_events` llaman a endpoints internos de GitHub. No están documentados y pueden cambiar sin aviso.

`steer_agent_task` lee la tarea y comprueba su pull request con `GET /repos/{owner}/{repo}/pulls/{number}`. Si la tarea no tiene pull request, responde `task_has_no_pull_request` y no envía la instrucción. Si la pull request no está abierta, responde `task_pull_request_not_open` y tampoco la envía.

Cada steer consume créditos. Copilot aplica la instrucción cuando termina la herramienta que está ejecutando. La guía oficial está en [gestionar y seguir agentes](https://docs.github.com/en/copilot/how-tos/copilot-on-github/use-copilot-agents/manage-and-track-agents).

`steer_agent_task` recibe `task_id` y `content`. `abort_agent_task` recibe `task_id`. `get_agent_task_events` recibe `task_id`, `page` y `per_page`.

Tras un steer aceptado, el vigilante guarda `session_count` y la marca del steer, y vuelve a vigilar esa tarea. Detecta el turno nuevo si aparece otra sesión o si la tarea vuelve a un estado que no es final. Avisa una vez cuando ese turno llega a un estado final. `idle` cuenta como final. El cuerpo del aviso es el de la sección siguiente, con `session_id`. Un reinicio no repite un aviso ya enviado.

## Aviso al terminar

El aviso es una notificación del sistema (toast de Windows, `osascript` en macOS, `notify-send` en Linux) y, si configuras la URL, un POST JSON.

Variables:

- `COPILOT_AGENTS_NOTIFY_URL`: URL del POST. Si no está, no hay POST.
- `COPILOT_AGENTS_NOTIFY_AUTHORIZATION`: valor de la cabecera `Authorization`. Si no está, el POST no lleva esa cabecera.
- `COPILOT_AGENTS_STATE_PATH`: archivo de estado. Por defecto, `~/.copilot-agents-mcp/state.json`.
- `COPILOT_AGENTS_POLL_INTERVAL_MS`: pausa entre lecturas. Por defecto, 15000.
- `COPILOT_AGENTS_LOG`: si está, el vigilante añade su error estándar a ese archivo.

El POST lleva `Content-Type: application/json` y este cuerpo:

```json
{
  "task_id": "0ad0914d-889f-4221-bdae-42074c1ab62e",
  "repo": "octocat/hello-world",
  "state": "completed",
  "requested_model": "grok-4.7",
  "resolved_model": "sweagent-capi:grok-4.7",
  "pull_request": {
    "id": 42,
    "number": 7,
    "html_url": "https://github.com/octocat/hello-world/pull/7"
  },
  "branch": { "head_ref": "copilot/demo", "base_ref": "main" },
  "artifacts": [
    { "type": "pull", "id": 42 },
    { "type": "branch", "head_ref": "copilot/demo", "base_ref": "main" }
  ],
  "error": null,
  "usage": { "type": "ai_credits", "amount": 344355000, "amount_human": 0.344355 },
  "created_at": "2026-11-22T00:00:00Z",
  "updated_at": "2026-11-22T00:01:00Z",
  "completed_at": "2026-11-22T00:05:00Z",
  "session_id": "session-1"
}
```

`resolved_model` es `sessions[].model` tal como lo devuelve la API, o `null`. `branch` sale de `artifacts`. `pull_request.id` es el id interno del artefacto, no el número de la pull request. `number` y `html_url` salen del artefacto si vienen. Si no, se piden con `GET /repos/{owner}/{repo}/pulls?head={owner}:{head_ref}&state=all` y se usa la entrada con esa id. `head_ref` es el del artefacto de rama o, si no hay, el de la sesión. Si no se pueden resolver, `number` y `html_url` van a `null` y el motivo se añade a `COPILOT_AGENTS_LOG`. El aviso se envía igual.

`error` es `null` o el texto del fallo. Si el modelo no está disponible, incluye los modelos vistos aceptados. `usage.amount` es el valor crudo. Con `ai_credits`, la API lo da en nano unidades y `amount_human` es `amount / 1e9`: `344355000` sale como `0.344355`. Con `premium_requests`, `amount_human` es el mismo número. `session_id` es la sesión de ese turno, o `null` si la tarea aún no trae sesión.

Si `notify-send`, `osascript` o el toast de Windows no arranca, el vigilante escribe el motivo en `COPILOT_AGENTS_LOG` (por ejemplo `ENOENT notify-send`) y sigue con el POST.

## Repetir un aviso

El vigilante avisa una vez. `notified_at` guarda ese momento. Para repetir el aviso de una tarea ya terminada, sin lanzar otra:

1. Espera a que el vigilante haya salido. Si la tarea ya se avisó, ese proceso ya no está.
2. Copia el archivo de estado y pon `notified_at` en `null` para esa tarea. Deja `state` como está.
3. Arranca `watch` con `COPILOT_AGENTS_STATE_PATH` apuntando a la copia.

Hace falta el token. El vigilante no vuelve a leer la tarea de agente. Recalcula `amount_human` desde `usage.amount` y, si faltan `number` o `html_url`, llama a la API de pull requests.

```bash
mkdir -p "$HOME/reaviso"
cp "${COPILOT_AGENTS_STATE_PATH:-$HOME/.copilot-agents-mcp/state.json}" "$HOME/reaviso/state.json"
node --input-type=module -e 'import { readFileSync, writeFileSync } from "node:fs"; const path = `${process.env.HOME}/reaviso/state.json`; const state = JSON.parse(readFileSync(path, "utf8")); state.tasks[process.argv[1]].notified_at = null; writeFileSync(path, `${JSON.stringify(state, null, 2)}\n`);' -- ID-DE-LA-TAREA
GITHUB_PERSONAL_ACCESS_TOKEN=github_pat_… \
COPILOT_AGENTS_STATE_PATH="$HOME/reaviso/state.json" \
COPILOT_AGENTS_NOTIFY_URL=http://127.0.0.1:9/aviso \
COPILOT_AGENTS_LOG="$HOME/reaviso/watch.log" \
npx -y github:daniel-saezv/copilot-agents-mcp watch
```

Sustituye `ID-DE-LA-TAREA` y la URL del POST. El proceso sale cuando ha enviado el aviso.

## Variables del token

`GITHUB_PERSONAL_ACCESS_TOKEN` es la que se usa. Si no está, se aceptan `GH_TOKEN` y, en último lugar, `GITHUB_TOKEN`. El token no se escribe en archivos, logs ni fixtures.

Otras variables del servidor, iguales que en el MCP oficial: `GITHUB_TOOLSETS`, `GITHUB_TOOLS`, `GITHUB_EXCLUDE_TOOLS` y `GITHUB_READ_ONLY`.

## Desarrollo

```bash
bash scripts/setup
npm test
npm run typecheck
npm run lint
npm run build
```

`npm run build` genera `dist/`. `prepare` lo hace al instalar desde GitHub, porque Node no ejecuta TypeScript dentro de `node_modules`.

Las reglas para agentes están en `AGENTS.md`.

## Licencia

[MIT](LICENSE).

La referencia comunitaria [fvegiard/copilot-cloud-agent-mcp](https://github.com/fvegiard/copilot-cloud-agent-mcp) es MIT y no se copia código suyo. Los fixtures de la API de tareas vienen de [github/rest-api-description](https://github.com/github/rest-api-description) (MIT).
